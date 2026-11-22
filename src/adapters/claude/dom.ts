import { usageLimitSource } from '../../core/usage-limit.js';

/**
 * Source of the pattern the page scripts use to recognise a Claude usage-limit notice: the shared English patterns, Claude's generic "limit reached" headlines
 * ("Usage limit reached", "5-hour limit reached", "Weekly limit reached", "<model> limit reached", "Monthly spend limit reached", "Out of free messages until ...")
 * and the Vietnamese catalog of an account whose interface language is Vietnamese ("Đã đạt giới hạn sử dụng", "Bạn đã đạt đến giới hạn hằng tuần",
 * "Đã hết tin nhắn miễn phí cho đến ...", "Giới hạn 5 giờ của bạn sẽ được đặt lại ..."). Claude localizes every label, so wording is the only signal for this one.
 * "Sắp đạt giới hạn" / "Gần đạt giới hạn" (approaching) and "Dự kiến đạt giới hạn" (projected) are warnings, not limits.
 */
export const claudeLimitSource = String.raw`${usageLimitSource}|\blimit reached\b|(?<!(?:sắp|gần|kiến) )đạt(?: đến)? giới hạn|hết tin nhắn miễn phí|giới hạn[^.\n]{0,40}đặt lại`;

/** Page-script prelude: a Claude user turn id is the uuid at the end of the `id` of its `[data-testid="user-message"]` (`_r_6o_<uuid>`); the reply's `data-turn-key` starts with it. */
const TURN_ID = String.raw`/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i`;

/**
 * Page-script prelude shared by the inspection, extraction and reveal scripts: finds the newest user turn, or the turn of `targetUserId`, and binds `list`
 * (the transcript), `userId`, `row` (the turn's transcript row), and `assistant` (its `[data-testid="assistant-message"]`, null while there is none).
 * Claude renders the transcript as sibling rows (`[data-testid="transcript-row"]`, human then assistant) and keeps mounted only the rows near the viewport
 * (it virtualizes the rest), so a turn far from the viewport can be absent: revealLatestTurnScript brings it back. An assistant message is matched to its
 * user turn by its `data-turn-key` (`<user uuid>-hub-reply`), falling back to the next row.
 */
export const locateTurn = String.raw`
  const list = Array.from(document.querySelectorAll('[data-testid="transcript-list"]')).at(-1) || document;
  const uuidOf = (node) => (${TURN_ID}.exec(node.id || '') || [])[0] || null;
  const users = Array.from(list.querySelectorAll('[data-testid="user-message"]'));
  const user = targetUserId ? users.find(node => uuidOf(node) === targetUserId) : users.at(-1);
  const userId = user ? uuidOf(user) : null;
  const row = user ? user.closest('[data-testid="transcript-row"]') : null;
  let assistant = userId ? Array.from(list.querySelectorAll('[data-testid="assistant-message"]')).find(node => (node.getAttribute('data-turn-key') || '').startsWith(userId)) || null : null;
  if (!assistant && row) {
    for (let sibling = row.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      if (sibling.matches('[data-testid="transcript-row"]')) { assistant = sibling.querySelector('[data-testid="assistant-message"]'); break; }
    }
  }
`;

/**
 * Page script (BrowserOS evaluateInPage) that reads the newest turn, or the turn of `targetUserId`, from Claude's conversation DOM. It runs every second
 * while a reply generates, so it stays light. DOM facts (observed live):
 * - The reply's prose is every `[data-perf-reply-text]` inside the assistant message; the message's own text starts with a screen-reader heading
 *   ("Claude responded: ..."), so its innerText is not used.
 * - `data-is-streaming` on the assistant message is "true" while it generates and "false" once finished; the composer shows `chat-input-stop` instead of the
 *   send button during a generation. The message actions toolbar exists even while streaming, so it is only a fallback.
 * - Notices live in the composer area (`hub-composer-notices`, dock groups and cards), as alerts/status regions, and as `message-warning` banners under a reply.
 *   Labels are localized (the account's language), so only test ids, attributes and roles are used for structure.
 *
 * `limit` is the text of a usage-limit notice (see claudeLimitSource). Notices inside the transcript are only read for the turn being waited on
 * (`targetUserId`): an older turn's banner can outlive the limit it reported. Text about the conversation's length is not a usage limit. A limit notice is not
 * an `error`.
 */
export const claudeInspectionScript = String.raw`(targetUserId) => {
  ${locateTurn}
  const replies = assistant ? Array.from(assistant.querySelectorAll('[data-perf-reply-text]')) : [];
  const text = replies.map(node => node.innerText || '').join('\n\n').replace(/[\uE000-\uF8FF]/g, '').trim();
  const media = replies.some(node => !!node.querySelector('img'));
  const stopping = !!document.querySelector('[data-testid="chat-input-stop"]');
  const flag = assistant ? assistant.getAttribute('data-is-streaming') : null;
  const busy = stopping || flag === 'true';
  const complete = !!assistant && !stopping && (flag === 'false' || (flag === null && !!assistant.querySelector('[data-testid="message-actions"]')));
  const limitPattern = new RegExp(${JSON.stringify(claudeLimitSource)}, 'i');
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const relevant = (node) => {
    if (node.closest('[data-perf-reply-text],[data-testid="chat-input"]')) return false;
    return !node.closest('[data-testid="transcript-list"]') || (!!targetUserId && !!assistant && assistant.contains(node));
  };
  const textsOf = (selector) => Array.from(document.querySelectorAll(selector)).filter(relevant).map(node => clean(node.textContent)).filter(value => value && value.length <= 400);
  const isLimit = (value) => limitPattern.test(value) && !/length|độ dài/i.test(value);
  const limit = textsOf('[data-testid="hub-composer-notices"],[data-cds-dock-group],[data-cds-dock-card],[data-testid="message-warning"],[role="alert"],[role="status"]').find(isLimit) || null;
  const error = textsOf('[role="alert"],[data-testid="hub-turn-failure-announcer"],[data-testid="failed-send-status-region"]').find(value => !isLimit(value)) || null;
  return {url:location.href,userId,assistantId:assistant ? (assistant.getAttribute('data-turn-key') || assistant.id || null) : null,text,complete,busy,error,limit,media};
}`;

/**
 * Page script (async) that scrolls the conversation to its end until the newest turn, or the turn of `targetUserId`, is mounted, and returns `{ found }`.
 * Claude mounts only the rows around the viewport, so a tab that was just navigated can lack the turn being generated. Scrolling mounts rows, which changes
 * the scroll height, so it repeats until the height stops changing.
 */
export const revealLatestTurnScript = String.raw`async (targetUserId) => {
  const locate = () => {
    ${locateTurn}
    return { list, user };
  };
  const scrollerOf = (start) => {
    for (let el = start; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const overflow = typeof getComputedStyle === 'function' ? getComputedStyle(el).overflowY : '';
      if (/auto|scroll|overlay/.test(overflow) && el.scrollHeight > el.clientHeight + 1) return el;
    }
    return document.scrollingElement || document.documentElement;
  };
  let settled = -1;
  for (let attempt = 0; attempt < 12; attempt++) {
    const { list } = locate();
    const scroller = scrollerOf(list === document ? document.body : list);
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise(resolve => setTimeout(resolve, 150));
    const height = scroller.scrollHeight;
    if (locate().user && height === settled) return { found: true };
    settled = height;
  }
  return { found: !!locate().user };
}`;

/**
 * Page script that counts what the composer holds. Each attachment is a `[data-testid="file-thumbnail"]` tile in the composer's attachments row; a tile that is
 * still uploading carries `aria-busy="true"` (observed live while a 10 MB image uploaded: the marker disappears when the upload completes). Drafts persist
 * across page loads (restored tiles are marked `data-cds-attachment-restored`), so a stale file from an earlier attempt shows up here too.
 */
export const composerAttachmentsScript = String.raw`() => {
  const tiles = Array.from(document.querySelectorAll('[data-testid="file-thumbnail"]'));
  const alert = Array.from(document.querySelectorAll('[role="alert"]')).map(node => (node.textContent || '').trim()).find(Boolean);
  return {
    tiles: tiles.length,
    uploading: tiles.filter(tile => tile.matches('[aria-busy="true"]') || !!tile.querySelector('[aria-busy="true"],[role="progressbar"]')).length,
    error: alert || null,
  };
}`;

/** Waits for the composer to hydrate once Claude's page loaded. */
export const settleScript = (page: string): string => `try{await ${page}.waitForSelector('[data-testid="chat-input"]',{timeout:15000});}catch{}`;

/** BrowserOS script expression over the interactive `snapshot`: true when the page offers the composer (Claude's is the page's only textbox; its name is localized). */
export const composerReady = `snapshot.refs.some(ref=>ref.role==='textbox')`;

/** BrowserOS script prelude defining `inside(url)`: true while `url` is a Claude page whose pathname matches `pathPattern` (a pathname regex source from destinationPathPattern). */
const insideGuard = (pathPattern: string): string => `const inside=(url)=>{const here=/^https:\\/\\/claude\\.ai(\\/[^?#]*)?(?:[?#].*)?$/.exec(url);return !!here&&new RegExp(${JSON.stringify(pathPattern)},'i').test(here[1]??'/');};`;

/**
 * BrowserOS script prelude defining `refOf(snapshot, testid, role)`: the snapshot ref of the `role` element carrying `data-testid`. Claude localizes every
 * accessible name, so the element is found by its test id in the page and matched to the snapshot by that element's aria-label.
 */
const refPrelude = `const refOf=async(snapshot,testid,role)=>{const label=(await page.evaluateInPage((id)=>{const el=document.querySelector('[data-testid="'+id+'"]');return el?el.getAttribute('aria-label'):null;},testid)).value;return label?snapshot.refs.find(ref=>ref.role===role&&ref.name===label):undefined;};`;

/**
 * BrowserOS script that adds local files to the composer by setting them on Claude's hidden file input (`input[data-testid="file-upload"]`) through the
 * DevTools protocol, which is what a file picker would do and needs neither a menu nor the native dialog. It re-checks that the tab is still inside
 * `pathPattern` first, and returns once the input has the files; the upload itself continues in the page, so callers poll composerAttachmentsScript until it settles.
 */
export function uploadScript(pageId: number, pathPattern: string, files: string[]): string {
  return `${insideGuard(pathPattern)}const page=browser.page(${pageId}); const snap=await page.snapshot({mode:'interactive'}); if(!inside(snap.url)) throw new Error('Claude left the expected destination; nothing attached.'); const doc=await page.cdp('DOM.getDocument',JSON.stringify({depth:0})); const input=await page.cdp('DOM.querySelector',JSON.stringify({nodeId:doc.root.nodeId,selector:'input[data-testid="file-upload"]'})); if(!input.nodeId) throw new Error('Claude attachment input unavailable.'); await page.cdp('DOM.setFileInputFiles',JSON.stringify({nodeId:input.nodeId,files:${JSON.stringify(files)}})); return true;`;
}

/**
 * BrowserOS script that fills the composer and presses Send, re-checking before each step that the tab is still inside `pathPattern` so a prompt is never
 * submitted to a page the caller did not choose. With `attachments` > 0 it also requires exactly that many finished uploads in the composer, so a reloaded tab
 * can never send the caption without its files. An empty `text` is not typed (attachments only). A disabled Send button is never clicked.
 */
export function submitScript(pageId: number, pathPattern: string, text: string, attachments: number): string {
  const fill = text ? `await page.fill(editor.ref,${JSON.stringify(text)}); ` : '';
  const staged = attachments > 0 ? `const held=(await page.evaluateInPage(${composerAttachmentsScript})).value; if(held.tiles!==${attachments}||held.uploading>0) throw new Error('Attachments are not ready in the composer; no prompt submitted.'); ` : '';
  return `${insideGuard(pathPattern)}const page=browser.page(${pageId}); ${refPrelude}const snap=await page.snapshot({mode:'interactive'}); if(!inside(snap.url)) throw new Error('Claude left the expected destination; no prompt submitted.'); const editor=await refOf(snap,'chat-input','textbox'); if(!editor) throw new Error('Claude composer unavailable; check login.'); ${fill}const filled=await page.snapshot({mode:'interactive'}); if(!inside(filled.url)) throw new Error('Claude left the expected destination; no prompt submitted.'); ${staged}const send=await refOf(filled,'chat-input-send','button'); if(!send) throw new Error('Send button unavailable; no prompt submitted.'); if((await page.evaluateInPage(()=>!!document.querySelector('[data-testid="chat-input-send"]')?.disabled)).value) throw new Error('Send button disabled; no prompt submitted.'); await page.click(send.ref); return {url:(await page.snapshot({mode:'interactive'})).url};`;
}
