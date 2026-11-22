import { usageLimitSource } from '../../core/usage-limit.js';

/**
 * Page-script prelude shared by the inspection, extraction and reveal scripts: finds the newest turn, or the turn of `targetUserId`, and binds `turns`, `turn`
 * (its `.conversation-container`), `userId`, `response` (its `model-response`, null while the reply is still pending), `markdown` (the reply's
 * `message-content .markdown`) and `readableText(node)`.
 * DOM facts (observed live on gemini.google.com):
 * - Each exchange is a `.conversation-container` holding `user-query` and `model-response`. The container's `id` (a 16-character hex id) and the `model-response`
 *   only exist once the reply starts streaming; while the model is still thinking (a minute or more) the container is anonymous and holds `pending-request` /
 *   `pending-response`. A turn is therefore identified by its prompt's ordinal, the `user-query-content-<n>` id on the prompt, which exists from the first moment.
 * - Gemini renders only the newest turns of a long chat and loads older ones when scrolled up.
 * - The reply's screen-reader label ("Gemini said") is outside `message-content`; icon buttons carry ligature text (`more_horiz`), so plain text is rebuilt from the
 *   DOM instead of read from innerText.
 */
export const locateTurn = String.raw`
  const turns = Array.from(document.querySelectorAll('.conversation-container'));
  const ordinalOf = (node) => {
    const prompt = node.querySelector('[id^="user-query-content-"]');
    const match = prompt ? /^user-query-content-(\d+)$/.exec(prompt.id) : null;
    return match ? 'q' + match[1] : null;
  };
  const turn = (targetUserId ? turns.find(node => ordinalOf(node) === targetUserId) : turns.at(-1)) || null;
  const userId = turn ? ordinalOf(turn) : null;
  const response = turn ? turn.querySelector('model-response') : null;
  const markdown = response ? response.querySelector('message-content .markdown') : null;
  const SKIP_TEXT = 'style,script,svg,button,mat-icon,gem-icon,gem-icon-button,[hide-from-message-actions],.code-block-decoration,[aria-hidden="true"],[hidden]';
  const BLOCK_TEXT = /^(p|div|li|ul|ol|h[1-6]|blockquote|pre|table|thead|tbody|tr|hr|br|response-element|table-block|code-block)$/;
  const textOf = (node) => {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1 || node.matches(SKIP_TEXT)) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'pre') return '\n' + node.textContent.replace(/\n+$/, '').replace(/\n/g, '\u0001').replace(/ /g, '\u0002').replace(/\t/g, '\u0003') + '\n';
    const inner = Array.from(node.childNodes).map(textOf).join(tag === 'tr' ? '\t' : '');
    return BLOCK_TEXT.test(tag) ? '\n' + inner + '\n' : inner;
  };
  // Code keeps its own line breaks and indentation: they travel as control characters while the surrounding whitespace is tidied.
  const readableText = (node) => textOf(node).replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').replace(/[\uE000-\uF8FF]/g, '').replace(/\u0001/g, '\n').replace(/\u0002/g, ' ').replace(/\u0003/g, '\t').trim();
`;

/**
 * Page script (BrowserOS evaluateInPage) that reads the newest turn, or the turn of `targetUserId`, from Gemini's conversation DOM. It runs every second while a
 * reply generates, so it stays light.
 * - Generation is on while the composer's send button is in its stop state (`input-area-v2 .send-button.stop`) or the reply's `.markdown` is `aria-busy="true"`.
 *   A finished reply has `message-actions` (thumbs, copy, redo) under it.
 * - `limit` is the text of a usage-limit notice (see usageLimitSource) from alerts, status regions, snackbars, banners, the composer's own area (without its editor
 *   and buttons, so a typed draft never counts) and the disclaimers of the turn being waited on, plus a SHORT reply of that turn. Notices inside the conversation
 *   only count for the turn being waited on, because an older turn's notice can outlive the limit it reported. A limit notice is not an `error`, and a turn
 *   that is itself the notice is not a completed reply.
 */
export const geminiInspectionScript = String.raw`(targetUserId) => {
  ${locateTurn}
  const text = markdown ? readableText(markdown) : '';
  const stopping = !!document.querySelector('input-area-v2 .send-button.stop');
  const busy = stopping || (!!markdown && markdown.getAttribute('aria-busy') === 'true');
  const finished = !!markdown && !busy && !!response.querySelector('message-actions');
  const media = !!response && !!response.querySelector('model-response-content img');
  const limitPattern = new RegExp(${JSON.stringify(usageLimitSource)}, 'i');
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const noticeOf = (value) => { const v = clean(value); return v && v.length <= 400 && limitPattern.test(v) ? v : null; };
  const relevant = (node) => {
    if (node.closest('rich-textarea,[role="textbox"]')) return false;
    return !node.closest('.conversation-container') || (!!targetUserId && !!turn && turn.contains(node));
  };
  const textsOf = (selector) => Array.from(document.querySelectorAll(selector)).filter(relevant).map(node => clean(node.textContent)).filter(value => value && value.length <= 400);
  let limit = textsOf('[role="alert"],[role="status"],snack-bar-container,mat-snack-bar-container,simple-snack-bar,chat-app-banners,chat-app-announcement-banners,model-response-disclaimers').map(noticeOf).find(Boolean) || null;
  const composer = document.querySelector('input-container');
  if (!limit && composer) {
    const copy = composer.cloneNode(true);
    for (const node of Array.from(copy.querySelectorAll('rich-textarea,[contenteditable],textarea,input,button,uploader-file-preview-container'))) node.remove();
    limit = noticeOf(copy.textContent);
  }
  const replyIsNotice = !!targetUserId && text.length <= 300 && !!noticeOf(text);
  if (!limit && replyIsNotice) limit = noticeOf(text);
  const error = textsOf('[role="alert"],snack-bar-container,mat-snack-bar-container,simple-snack-bar').find(value => !noticeOf(value)) || null;
  return {url:location.href,userId,assistantId:response ? ((markdown && markdown.id) || turn.id || 'pending') : null,text:replyIsNotice ? '' : text,complete:finished && !replyIsNotice,busy,error,limit,media};
}`;

/**
 * Page script (async) that scrolls the conversation to its end until the newest turn, or the turn of `targetUserId`, is mounted, and returns `{ found }`.
 * Gemini mounts the newest turns first and loads older ones upward, so this is a cheap safety net: it repeats until the scroll height stops changing.
 */
export const revealLatestTurnScript = String.raw`async (targetUserId) => {
  const locate = () => {
    ${locateTurn}
    return { turns, turn };
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
    const { turns } = locate();
    const scroller = scrollerOf(turns.at(-1) || document.body);
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise(resolve => setTimeout(resolve, 150));
    const height = scroller.scrollHeight;
    if (locate().turn && height === settled) return { found: true };
    settled = height;
  }
  return { found: !!locate().turn };
}`;

/**
 * Page script that counts what the composer holds. Each attachment is an `uploader-file-preview` tile; a tile that is still uploading contains a progress
 * indicator (a spinner or progress bar) until the upload completes.
 */
export const composerAttachmentsScript = String.raw`() => {
  const tiles = Array.from(document.querySelectorAll('uploader-file-preview'));
  const alert = Array.from(document.querySelectorAll('[role="alert"]')).map(node => (node.textContent || '').trim()).find(Boolean);
  return {
    tiles: tiles.length,
    uploading: tiles.filter(tile => !!tile.querySelector('[role="progressbar"],mat-progress-spinner,mat-spinner,mat-progress-bar')).length,
    error: alert || null,
  };
}`;

/**
 * Page script returning the email address of the signed-in Google account, or null. The account switcher is a link or button whose aria-label ends in the address
 * in parentheses ("Google Account: Name (name@gmail.com)"); the label text is localized, the address is not, so any aria-label holding one is taken.
 */
export const identityScript = String.raw`() => {
  for (const node of document.querySelectorAll('[aria-label*="@"]')) {
    const match = /[^\s()<>,;:]+@[^\s()<>,;:]+\.[^\s()<>,;:]+/.exec(node.getAttribute('aria-label') || '');
    if (match) return match[0];
  }
  return null;
}`;

/** Waits for the composer to hydrate once Gemini's page loaded. */
export const settleScript = (page: string): string => `try{await ${page}.waitForSelector('input-area-v2 [role="textbox"]',{timeout:15000});}catch{}`;

/** BrowserOS script expression over the interactive `snapshot`: true when the page offers the composer (Gemini's is the page's only textbox; its name is localized). */
export const composerReady = `snapshot.refs.some(ref=>ref.role==='textbox')`;

/** BrowserOS script prelude defining `inside(url)`: true while `url` is a Gemini page whose pathname matches `pathPattern` (a pathname regex source from destinationPathPattern). */
const insideGuard = (pathPattern: string): string => `const inside=(url)=>{const here=/^https:\\/\\/gemini\\.google\\.com(\\/[^?#]*)?(?:[?#].*)?$/.exec(url);return !!here&&new RegExp(${JSON.stringify(pathPattern)}).test(here[1]??'/');};`;

/**
 * BrowserOS script prelude defining `refOf(snapshot, selector, role)`: the snapshot ref of the `role` element matching the CSS `selector`. Gemini localizes every
 * accessible name, so the element is found by structure in the page and matched to the snapshot by that element's aria-label.
 */
const refPrelude = `const refOf=async(snapshot,selector,role)=>{const label=(await page.evaluateInPage((sel)=>{const el=document.querySelector(sel);return el?el.getAttribute('aria-label'):null;},selector)).value;return label?snapshot.refs.find(ref=>ref.role===role&&ref.name===label):undefined;};`;

const UPLOAD_ITEM = '[data-test-id="local-images-files-uploader-button"]';

/**
 * BrowserOS script that adds local files to the composer through Gemini's own "Upload & tools" menu (the agent tab intercepts the native picker), re-checking
 * before each step that the tab is still inside `pathPattern`. It returns once the picker received the files; the upload itself continues in the page, so
 * callers poll composerAttachmentsScript until it settles.
 */
export function uploadScript(pageId: number, pathPattern: string, files: string[]): string {
  const stay = `if(!inside(snap.url)) throw new Error('Gemini left the expected destination; nothing attached.');`;
  return `${insideGuard(pathPattern)}const page=browser.page(${pageId}); ${refPrelude}let snap=await page.snapshot({mode:'interactive'}); ${stay} const add=await refOf(snap,'input-area-v2 button[aria-haspopup="menu"]','button'); if(!add) throw new Error('Gemini attachment button unavailable.'); await page.click(add.ref); await page.waitForSelector(${JSON.stringify(UPLOAD_ITEM)},{timeout:5000}); snap=await page.snapshot({mode:'interactive'}); ${stay} const item=await refOf(snap,${JSON.stringify(UPLOAD_ITEM)},'menuitem'); if(!item) throw new Error('Gemini upload option unavailable.'); const chooser=await page.click(item.ref); if(!chooser||!chooser.fileChooserOpen) throw new Error('Gemini did not open its file picker.'); await page.upload(null,${JSON.stringify(files)}); return true;`;
}

/**
 * BrowserOS script that fills the composer and presses Send, re-checking before each step that the tab is still inside `pathPattern` so a prompt is never
 * submitted to a page the caller did not choose. With `attachments` > 0 it also requires exactly that many finished uploads in the composer, so a reloaded tab
 * can never send the caption without its files. An empty `text` is not typed (attachments only). A send button that is disabled or in its stop state (a reply is
 * generating) is never clicked.
 */
export function submitScript(pageId: number, pathPattern: string, text: string, attachments: number): string {
  const fill = text ? `await page.fill(editor.ref,${JSON.stringify(text)}); ` : '';
  const staged = attachments > 0 ? `const held=(await page.evaluateInPage(${composerAttachmentsScript})).value; if(held.tiles!==${attachments}||held.uploading>0) throw new Error('Attachments are not ready in the composer; no prompt submitted.'); ` : '';
  const sendState = `(await page.evaluateInPage(()=>{const send=document.querySelector('input-area-v2 .send-button');const button=send&&send.querySelector('button');return {stopping:!!send&&send.classList.contains('stop'),disabled:!button||button.getAttribute('aria-disabled')==='true'||button.disabled};})).value`;
  return `${insideGuard(pathPattern)}const page=browser.page(${pageId}); ${refPrelude}const snap=await page.snapshot({mode:'interactive'}); if(!inside(snap.url)) throw new Error('Gemini left the expected destination; no prompt submitted.'); const editor=await refOf(snap,'input-area-v2 [role="textbox"]','textbox'); if(!editor) throw new Error('Gemini composer unavailable; check login.'); ${fill}const filled=await page.snapshot({mode:'interactive'}); if(!inside(filled.url)) throw new Error('Gemini left the expected destination; no prompt submitted.'); ${staged}const send=await refOf(filled,'input-area-v2 .send-button button','button'); if(!send) throw new Error('Send button unavailable; no prompt submitted.'); const state=${sendState}; if(state.stopping) throw new Error('Gemini is still generating a reply; no prompt submitted.'); if(state.disabled) throw new Error('Send button disabled; no prompt submitted.'); await page.click(send.ref); return {url:(await page.snapshot({mode:'interactive'})).url};`;
}
