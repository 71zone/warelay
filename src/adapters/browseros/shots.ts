import { rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Attachment } from '../../core/contracts.js';
import { MAX_MEDIA_BYTES } from '../../infrastructure/media.js';
import type { AssetContext } from './assets.js';

/** Most pictures one table or card may need. A table that needs more is delivered as text (and a CSV) instead. */
export const MAX_SHOT_SLICES = 4;
/** Most tables and cards pictured for one reply; the rest are delivered as text. */
export const MAX_REPLY_SHOTS = 4;
/** Longest side of one picture, in device pixels. */
export const MAX_SHOT_PIXELS = 4000;
/** Largest base64 payload that one capture may bring back through BrowserOS (its result cap is 2000000 characters, see SHOT_RESULT_CHARS). */
const MAX_SHOT_CHARS = 1_800_000;
/** `maxChars` requested for a capture call; the default 500000 is too small for several slices. */
export const SHOT_RESULT_CHARS = 2_000_000;
/** CSS pixels kept free at the top of the viewport (the provider's header) and at the bottom (its composer and disclaimer): a picture never reaches into them. */
const SAFE_TOP = 72;
const SAFE_BOTTOM = 200;
/** CSS pixels of the page background kept around a picture. */
const PADDING = 8;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Page script that scrolls the stamped element (data-wab-shot) into view and reports its size, the offsets of its row boundaries (the only places a tall
 * element may be cut) and whether it is wider than the room it has: an element that a scroll container or the viewport clips sideways would be pictured
 * cut off, so the capture is refused instead.
 */
const measureScript = String.raw`async (id) => {
  const el = document.querySelector('[data-wab-shot="' + id + '"]');
  if (!el) return { error: 'The table is no longer on the page.' };
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  await new Promise(resolve => setTimeout(resolve, 150));
  const box = el.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return { error: 'The table has no visible size.' };
  let clipped = box.left < 0 || box.right > innerWidth + 1;
  for (let parent = el.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
    if (!/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowX)) continue;
    const room = parent.getBoundingClientRect();
    if (box.left < room.left - 2 || box.right > room.right + 2) clipped = true;
  }
  const rows = Array.from(el.matches('table') ? el.rows : el.children);
  const cuts = rows.map(row => Math.round(row.getBoundingClientRect().bottom - box.top)).filter(cut => cut > 0);
  return { width: box.width, height: box.height, cuts, clipped, viewportWidth: innerWidth, viewportHeight: innerHeight };
}`;

/**
 * Page script that scrolls so the part of the element from `offset` to `offset + height` (CSS pixels from its top) sits at `top` in the viewport (as near as
 * the scroll range allows), and returns the clip rectangle of that part in page coordinates. The part must be fully inside the viewport and nothing but the
 * element itself may be drawn over it: nine sample points along its edges and middle (not the corners, which a rounded card leaves empty) are hit-tested, so
 * the provider's floating composer or header never ends up in the picture.
 */
const placeScript = String.raw`async ({ id, offset, height, top }) => {
  const el = document.querySelector('[data-wab-shot="' + id + '"]');
  if (!el) return { error: 'The table is no longer on the page.' };
  let scroller = el.parentElement;
  while (scroller && scroller !== document.body && scroller !== document.documentElement && !(/auto|scroll|overlay/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement;
  const delta = el.getBoundingClientRect().top + offset - top;
  if (scroller && scroller !== document.body && scroller !== document.documentElement) scroller.scrollBy({ top: delta, behavior: 'instant' });
  else window.scrollBy({ top: delta, behavior: 'instant' });
  await new Promise(resolve => setTimeout(resolve, 150));
  const box = el.getBoundingClientRect();
  const first = box.top + offset;
  if (first < 0 || first + height > innerHeight) return { error: 'The table cannot be scrolled fully into view.' };
  const cx = (box.left + box.right) / 2;
  const cy = first + height / 2;
  const across = [box.left + box.width * 0.1, cx, box.left + box.width * 0.9];
  const points = [...across.flatMap(px => [[px, first + 3], [px, first + height - 3]]), [box.left + 3, cy], [box.right - 3, cy], [cx, cy]];
  for (const [px, py] of points) {
    const hit = document.elementFromPoint(px, py);
    if (!hit || !(el === hit || el.contains(hit))) return { error: 'Something is drawn over the table.' };
  }
  return { x: box.left + scrollX, y: first + scrollY, width: box.width };
}`;

const failure = z.object({ error: z.string() });
const measured = z.union([failure, z.object({ width: z.number(), height: z.number(), cuts: z.array(z.number()), clipped: z.boolean(), viewportWidth: z.number(), viewportHeight: z.number() })]);
const captured = z.union([failure, z.object({ images: z.array(z.string()) })]);

/**
 * BrowserOS script that pictures element `id` as PNG slices through the page's own compositor (CDP Page.captureScreenshot with a clip), so the picture is what
 * the page drew, in the page's theme. The tab is never raised or focused; only its scroll position changes. An element taller than the room between the page's
 * header and composer is cut at its row boundaries into at most MAX_SHOT_SLICES slices. Resolves to `{ images }` (base64 PNGs, top to bottom) or `{ error }`.
 */
export function captureScript(pageId: number, id: number): string {
  return `const page=browser.page(${pageId});
const SAFE_TOP=${SAFE_TOP},SAFE_BOTTOM=${SAFE_BOTTOM},PADDING=${PADDING},MAX_SLICES=${MAX_SHOT_SLICES},MAX_PIXELS=${MAX_SHOT_PIXELS},MAX_CHARS=${MAX_SHOT_CHARS};
const measured=(await page.evaluateInPage(${measureScript},${id})).value;
if(measured.error) return measured;
if(measured.clipped) return {error:'The table is wider than the room the page gives it.'};
const room=measured.viewportHeight-SAFE_TOP-SAFE_BOTTOM-2*PADDING;
if(room<80) return {error:'The tab is too short to picture a table.'};
const slices=[];
let start=0;
while(start<measured.height-1){
  const end=measured.height-start<=room?measured.height:Math.max(0,...measured.cuts.filter(cut=>cut>start&&cut-start<=room));
  if(end<=start) return {error:'A row of the table is taller than the tab.'};
  slices.push([start,end]);
  start=end;
  if(slices.length>MAX_SLICES) return {error:'The table needs more than '+MAX_SLICES+' pictures.'};
}
const images=[];
let chars=0;
for(let index=0;index<slices.length;index++){
  const [from,to]=slices[index];
  const lead=index===0?PADDING:0,trail=index===slices.length-1?PADDING:0;
  const height=to-from;
  const placed=(await page.evaluateInPage(${placeScript},{id:${id},offset:from,height,top:SAFE_TOP+PADDING})).value;
  if(placed.error) return placed;
  const clip={x:Math.max(0,placed.x-PADDING),y:placed.y-lead,width:placed.width+2*PADDING,height:height+lead+trail};
  let data='';
  for(const scale of [2,1]){
    const fit=Math.min(scale,MAX_PIXELS/clip.width,MAX_PIXELS/clip.height);
    if(fit<1) return {error:'The table is too large for one picture.'};
    data=(await page.cdp('Page.captureScreenshot',JSON.stringify({format:'png',captureBeyondViewport:false,clip:{...clip,scale:fit}}))).data;
    if(chars+data.length<=MAX_CHARS) break;
  }
  chars+=data.length;
  if(chars>MAX_CHARS) return {error:'The picture of the table is too large.'};
  images.push(data);
}
return {images};`;
}

/**
 * Pictures the table or card stamped `data-wab-shot="<id>"` and stores each slice in the media store as a PNG; returns the attachments top to bottom.
 * Throws with a readable reason when the element cannot be pictured; nothing is left on disk then.
 */
export async function captureShot(id: number, context: AssetContext, name = 'table'): Promise<Attachment[]> {
  const result = captured.parse(await context.run(captureScript(context.pageId, id), SHOT_RESULT_CHARS));
  if ('error' in result) throw new Error(result.error);
  const written: string[] = [];
  try {
    const attachments: Attachment[] = [];
    for (const [index, data] of result.images.entries()) {
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('BrowserOS returned something that is not a PNG');
      if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`the picture is ${bytes.length} bytes, over the ${MAX_MEDIA_BYTES} byte limit`);
      const fileName = result.images.length > 1 ? `${name}-${index + 1}.png` : `${name}.png`;
      const path = await context.media.allocate(fileName);
      written.push(path);
      await writeFile(path, bytes, { mode: 0o600 });
      attachments.push({ kind: 'image', path, fileName, mimeType: 'image/png' });
    }
    if (attachments.length === 0) throw new Error('BrowserOS returned no picture');
    return attachments;
  } catch (error) {
    await Promise.all(written.map(path => rm(path, { force: true })));
    throw error;
  }
}
