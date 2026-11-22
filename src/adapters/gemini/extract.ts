import { locateTurn } from './dom.js';

/**
 * Page script (BrowserOS evaluateInPage) that converts the reply of the newest turn, or of `targetUserId`, into display-ordered blocks of the shared
 * extraction shape (see browseros/extraction.ts). Prose becomes Markdown (rebuilt from the DOM, since Gemini's copy output is not reachable), fenced code and
 * tables become their own blocks, and images become `asset` placeholders. Each asset is stamped `data-wab-asset="<id>"` and each table `data-wab-shot="<id>"`
 * (listed in `shots`), so the later byte-transfer and screenshot scripts can find them.
 *
 * DOM facts it relies on (Gemini's renderer, observed live):
 * - The reply is `model-response message-content .markdown`: plain p/h1-h6/ul/ol/li/blockquote/hr children whose text sits in spans, plus `response-element`
 *   wrappers around the two widgets.
 * - A table is `response-element > table-block > .table-block > .table-content > table` (thead with th, tbody with td), followed by a footer with icon buttons.
 * - A code block is `response-element > code-block` whose `.code-block-decoration` header holds the language label ("Python") and the copy and download buttons,
 *   and whose code is `pre > code[data-test-id="code-content"]` (highlight spans inside; the text is the code).
 * Text outside `.markdown` (thinking, sources, disclaimers, the action bar) is deliberately not read.
 */
export const geminiExtractionScript = String.raw`(targetUserId) => {
  ${locateTurn}
  const result = { url: location.href, text: '', blocks: [], assets: [], shots: [] };
  if (!response) return result;
  const roots = markdown ? [markdown] : [];
  result.text = markdown ? readableText(markdown) : '';
  if (!roots.length) return result;

  const TICK = String.fromCharCode(96);
  const SKIP = '[hidden],[aria-hidden="true"],style,script,svg,button,mat-icon,gem-icon-button,[hide-from-message-actions],[role="status"]';
  const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  const LINES = /^(div|section|article|form|fieldset|label|figure|figcaption|dl|dt|dd|details|summary|header|footer|nav|address)$/;
  const BREAK = String.fromCharCode(1);
  const BREAKS = new RegExp(' *' + BREAK + '[ ' + BREAK + ']*', 'g');
  const BLOCKS = 'p,ul,ol,table,blockquote,hr,' + HEADINGS.join(',') + ',pre,code-block,img';
  const collapse = (text) => text.replace(/\s+/g, ' ');
  const tagOf = (el) => el.tagName.toLowerCase();
  const isCode = (el) => tagOf(el) === 'pre' || tagOf(el) === 'code-block';

  const cleanUrl = (href) => {
    try {
      const url = new URL(href, location.href);
      return /^(https?:|mailto:|tel:)$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  const wrap = (text, mark) => {
    const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    return parts[2] ? parts[1] + mark + parts[2] + mark + parts[3] : text;
  };
  const inline = (node, marks) => {
    if (node.nodeType === 3) return collapse(node.textContent);
    if (node.nodeType !== 1 || node.matches(SKIP)) return '';
    const tag = tagOf(node);
    if (tag === 'br') return '\n';
    if (tag === 'img') return '';
    if (tag === 'input') return node.type === 'checkbox' ? (node.checked ? '[x] ' : '[ ] ') : '';
    if (node.classList.contains('katex')) {
      const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
      return tex ? '$' + tex + '$' : collapse(node.textContent);
    }
    if (tag === 'code') {
      const code = node.textContent;
      const fence = code.includes(TICK) ? TICK + TICK : TICK;
      return code ? fence + code + fence : '';
    }
    const inner = () => Array.from(node.childNodes).map(child => inline(child, marks)).join('');
    if (tag === 'strong' || tag === 'b') return marks ? wrap(inner(), '**') : inner();
    if (tag === 'em' || tag === 'i') return marks ? wrap(inner(), '*') : inner();
    if (tag === 'del' || tag === 's') return marks ? wrap(inner(), '~~') : inner();
    if (tag === 'a') {
      const text = inner().trim();
      const href = cleanUrl(node.getAttribute('href') || '');
      if (!href) return text;
      return text && text !== href ? '[' + text + '](' + href + ')' : href;
    }
    if (LINES.test(tag)) {
      const body = inner();
      return body.trim() ? BREAK + body + BREAK : '';
    }
    return inner();
  };
  const paragraph = (nodes, marks) => nodes.map(node => inline(node, marks)).join('').replace(BREAKS, '\n').replace(/ *\n */g, '\n').trim();
  const plain = (node) => {
    if (node.nodeType === 3) return collapse(node.textContent);
    if (node.nodeType !== 1 || node.matches(SKIP)) return '';
    const inner = Array.from(node.childNodes).map(plain).join('');
    return /^(br|p|li|div)$/.test(tagOf(node)) ? ' ' + inner + ' ' : inner;
  };

  const blocks = [];
  let pending = [];
  let quote = '';
  const addMarkdown = (text) => {
    if (!text.trim()) return;
    pending.push(quote ? text.split('\n').map(line => (quote + line).trimEnd()).join('\n') : text);
  };
  const flush = () => {
    if (pending.length) blocks.push({ type: 'markdown', text: pending.join('\n\n') });
    pending = [];
  };
  const addBlock = (block) => { flush(); blocks.push(block); };

  const codeBlock = (el) => {
    const pre = tagOf(el) === 'pre' ? el : el.querySelector('pre');
    const code = pre.querySelector('code');
    let language = (/language-([\w+#.-]+)/.exec((code && code.className) || '') || [])[1] || null;
    if (!language && el !== pre) language = el.querySelector('.code-block-decoration > span')?.textContent?.trim() || null;
    language = language ? language.toLowerCase() : null;
    if (language && /^(plain ?text|text|txt)$/.test(language)) language = null;
    return { type: 'code', language, code: ((code || pre).textContent || '').replace(/\n+$/, '') };
  };

  const tableBlock = (table) => {
    const rows = Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table)
      .map(row => Array.from(row.children).filter(cell => /^(th|td)$/.test(tagOf(cell))).map(cell => collapse(plain(cell)).trim()))
      .filter(row => row.length > 0);
    if (!rows.length) return null;
    const width = Math.max(...rows.map(row => row.length));
    const padded = rows.map(row => row.concat(Array(width - row.length).fill('')));
    return { type: 'table', header: padded[0], rows: padded.slice(1) };
  };

  let nextShot = 0;
  const addShot = (el, kind) => {
    const id = ++nextShot;
    el.setAttribute('data-wab-shot', String(id));
    result.shots.push({ id, kind, block: blocks.length - 1 });
  };
  let nextAsset = 0;
  const addImage = (img) => {
    const source = img.currentSrc || img.src || '';
    if (!/^(blob:|data:|https:\/\/(?:[a-z0-9-]+\.)*(?:google|googleusercontent|gstatic)\.com\/)/.test(source) || (img.naturalWidth && img.naturalWidth < 48)) return;
    const id = ++nextAsset;
    img.setAttribute('data-wab-asset', String(id));
    result.assets.push({ id, kind: 'image', name: img.getAttribute('alt') || 'image' });
    addBlock({ type: 'asset', id });
  };

  const hasBlock = (el) => !!el.querySelector(BLOCKS);
  const itemsOf = (parent) => {
    const out = [];
    let run = [];
    const endRun = () => {
      if (run.some(node => node.textContent.trim())) out.push({ nodes: run });
      run = [];
    };
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) { run.push(node); continue; }
      if (node.nodeType !== 1 || node.matches(SKIP)) continue;
      if (isCode(node) || node.matches(BLOCKS)) { endRun(); out.push({ el: node }); }
      else if (hasBlock(node)) { endRun(); out.push(...itemsOf(node)); }
      else if (LINES.test(tagOf(node))) { endRun(); run.push(node); endRun(); }
      else run.push(node);
    }
    endRun();
    return out;
  };

  // A list becomes Markdown lines: the marker line, continuation lines, nested lists. A block that cannot live inside Markdown (code, table, image)
  // ends the pending lines, goes out as its own block, and the rest of the list continues in a new Markdown block.
  const addList = (list) => {
    let lines = [];
    const drain = () => { if (lines.length) addMarkdown(lines.join('\n')); lines = []; };
    const walk = (current, depth) => {
      const ordered = tagOf(current) === 'ol';
      let number = parseInt(current.getAttribute('start') || '1', 10) || 1;
      for (const li of Array.from(current.children).filter(child => tagOf(child) === 'li')) {
        const marker = ordered ? number++ + '. ' : '- ';
        const lead = ' '.repeat(depth) + marker.trimEnd();
        const inner = ' '.repeat(depth + marker.length);
        let started = false;
        const begin = () => { if (!started) { lines.push(lead); started = true; } };
        for (const part of itemsOf(li)) {
          const tag = part.el ? tagOf(part.el) : null;
          const text = part.nodes ? paragraph(part.nodes, true) : (tag === 'p' || HEADINGS.includes(tag) ? paragraph(Array.from(part.el.childNodes), tag === 'p') : null);
          if (text !== null) {
            const rows = text.split('\n');
            if (started) lines.push(inner + rows[0]); else { lines.push(' '.repeat(depth) + marker + rows[0]); started = true; }
            for (const row of rows.slice(1)) lines.push(inner + row);
          } else if (tag === 'ul' || tag === 'ol') {
            begin();
            walk(part.el, depth + marker.length);
          } else {
            begin();
            drain();
            emit(part);
          }
        }
        begin();
      }
    };
    walk(list, 0);
    drain();
  };

  const emit = (item) => {
    if (item.nodes) { addMarkdown(paragraph(item.nodes, true)); return; }
    const el = item.el;
    const tag = tagOf(el);
    if (tag === 'img') { addImage(el); return; }
    if (isCode(el)) { const block = codeBlock(el); if (block.code.trim()) addBlock(block); return; }
    if (tag === 'table') { const block = tableBlock(el); if (block) { addBlock(block); addShot(el, 'table'); } return; }
    if (tag === 'hr') addMarkdown('---');
    else if (tag === 'ul' || tag === 'ol') addList(el);
    else if (tag === 'blockquote') {
      const outer = quote;
      quote = outer + '> ';
      for (const part of itemsOf(el)) emit(part);
      quote = outer;
    } else if (HEADINGS.includes(tag)) addMarkdown('#'.repeat(Number(tag.slice(1))) + ' ' + paragraph(Array.from(el.childNodes), false));
    else addMarkdown(paragraph(Array.from(el.childNodes), true));
  };

  for (const root of roots) for (const item of itemsOf(root)) emit(item);
  flush();
  result.blocks = blocks;
  return result;
}`;
