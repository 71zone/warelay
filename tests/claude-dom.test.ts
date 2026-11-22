import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { claudeInspectionScript, composerAttachmentsScript } from '../src/adapters/claude/dom.js';
import { claudeExtractionScript } from '../src/adapters/claude/extract.js';
import { extraction } from '../src/adapters/browseros/extraction.js';
import { isUsageLimitText } from '../src/core/usage-limit.js';

// Markup follows what claude.ai rendered when this was written (Vietnamese interface, so every label is localized and only test ids and attributes are read).
const inspected = z.object({ url: z.string(), userId: z.string().nullable(), assistantId: z.string().nullable(), text: z.string(), complete: z.boolean(), busy: z.boolean(), error: z.string().nullable(), limit: z.string().nullable(), media: z.boolean() });
const uuid = (n: number): string => `186de4ff-fe4b-4d60-a656-1ae0da44bf6${n}`;

interface Turn { n: number; reply?: string; streaming?: boolean; warning?: string; question?: string }
const turn = ({ n, reply = '<p dir="ltr">Answer</p>', streaming = false, warning = '', question = 'Question' }: Turn): string =>
  `<div data-testid="transcript-row" data-perf-row="human"><div id="_r_c5_"><div id="_r_c3_${uuid(n)}" data-testid="user-message"><p>${question}</p></div></div></div>`
  + `<div data-testid="transcript-row" data-perf-row="assistant"><div data-testid="assistant-message" data-turn-key="${uuid(n)}-hub-reply" data-is-streaming="${streaming}"><h3 data-find-omitted="">Claude đã phản hồi: Answer</h3><div data-cds="Prose"><div data-perf-reply-text="" data-hang-face="serif"><div dir="ltr">${reply}</div></div></div>${warning}<div data-testid="message-actions" role="toolbar"></div></div></div>`;
const page = (turns: Turn[], { notices = '', stop = false }: { notices?: string; stop?: boolean } = {}): string =>
  `<div data-testid="transcript-list">${turns.map(turn).join('')}</div><div data-testid="hub-composer-notices"><div role="status">${notices}</div></div><div data-testid="chat-input" contenteditable="true"></div>${stop ? '<button data-testid="chat-input-stop"></button>' : '<button data-testid="chat-input-send"></button>'}`;

function run(html: string, script: string, target: string | null = null): unknown {
  const { document } = parseHTML(html);
  return runInNewContext(`(${script})(${JSON.stringify(target)})`, { document, location: { href: 'https://claude.ai/chat/x' }, URL });
}
const inspect = (html: string, target: string | null = null) => inspected.parse(run(html, claudeInspectionScript, target));

test('the newest turn is read: its reply is matched through the turn key and a finished stream reads as complete', () => {
  const read = inspect(page([{ n: 1, reply: '<p>Old</p>' }, { n: 2, reply: '<p dir="ltr">New <strong>answer</strong></p>' }]));
  assert.equal(read.userId, uuid(2));
  assert.equal(read.assistantId, `${uuid(2)}-hub-reply`);
  assert.equal(read.text, 'New answer');
  assert.equal(read.complete, true);
  assert.equal(read.busy, false);
  assert.deepEqual([read.error, read.limit], [null, null]);
});

test('a streaming reply, or a visible stop button, is busy and never complete; the reply text ignores the screen-reader heading and icon glyphs', () => {
  const streaming = inspect(page([{ n: 1, reply: '<p>Par</p><div role="group"><button>\ue056</button><div>python</div><pre><code>x</code></pre></div>', streaming: true }]));
  assert.equal(streaming.busy, true);
  assert.equal(streaming.complete, false);
  assert.ok(!streaming.text.includes('\ue056') && !streaming.text.includes('Claude đã'));
  const stopping = inspect(page([{ n: 1 }], { stop: true }));
  assert.deepEqual([stopping.busy, stopping.complete], [true, false]);
});

test('the turn of a given user message is selected, and an unmounted one reads as absent', () => {
  const turns = [{ n: 1, reply: '<p>One</p>' }, { n: 2, reply: '<p>Two</p>' }];
  assert.equal(inspect(page(turns), uuid(1)).text, 'One');
  const missing = inspect(page(turns), uuid(7));
  assert.deepEqual([missing.userId, missing.assistantId, missing.text, missing.complete], [null, null, '', false]);
});

test('usage-limit notices are found in the composer area in English and Vietnamese, but warnings and ordinary banners are not limits', () => {
  for (const notice of ['Usage limit reached · Resets 3:45 PM', "You've hit your 5-hour limit", 'Out of free messages until 3 PM', 'Đã đạt giới hạn sử dụng', 'Bạn đã đạt đến giới hạn sử dụng. Giới hạn này sẽ đặt lại vào 15:45.', 'Đã hết tin nhắn miễn phí cho đến 15:45']) {
    assert.equal(inspect(page([{ n: 1 }], { notices: `<div data-cds="Banner">${notice}</div>` })).limit, notice, notice);
  }
  for (const notice of ['Sắp đạt giới hạn sử dụng', 'Gần đạt giới hạn', 'Nâng cấp để tăng giới hạn sử dụng', 'Cuộc trò chuyện này đã đạt đến giới hạn độ dài.', 'This conversation reached its length limit.', 'Tự động hiện là chế độ mặc định.']) {
    assert.equal(inspect(page([{ n: 1 }], { notices: `<div data-cds="Banner">${notice}</div>` })).limit, null, notice);
  }
  assert.ok(isUsageLimitText('Usage limit reached'));
});

test('a limit banner under a reply counts only for the turn being waited on, a model reply that discusses limits never counts, and a limit alert is not an error', () => {
  const banner = '<div data-testid="message-warning" role="status"><div>Usage limit reached</div></div>';
  assert.equal(inspect(page([{ n: 1, warning: banner }])).limit, null);
  assert.equal(inspect(page([{ n: 1, warning: banner }]), uuid(1)).limit, 'Usage limit reached');
  assert.equal(inspect(page([{ n: 1, warning: banner }, { n: 2 }]), uuid(2)).limit, null);
  assert.equal(inspect(page([{ n: 1, reply: '<p>You reached your usage limit when the quota runs out.</p>' }]), uuid(1)).limit, null);
  const alert = inspect(page([{ n: 1 }], { notices: '<div role="alert">Usage limit reached</div>' }));
  assert.deepEqual([alert.limit, alert.error], ['Usage limit reached', null]);
  const failure = inspect(page([{ n: 1 }], { notices: '<div role="alert">Something went wrong</div>' }));
  assert.deepEqual([failure.limit, failure.error], [null, 'Something went wrong']);
});

const composer = (...tiles: string[]): string => `<div data-cds-composer-attachments-row="">${tiles.join('')}</div>`;
const tile = (name: string, busy: boolean): string => `<div data-testid="file-thumbnail"${busy ? ' aria-busy="true"' : ''}><span role="button"><span>${name}</span></span></div>`;

test('the composer script counts attachment tiles and the ones still uploading', () => {
  const state = (html: string) => z.object({ tiles: z.number(), uploading: z.number(), error: z.string().nullable() }).parse(run(html, composerAttachmentsScript));
  assert.deepEqual(state(''), { tiles: 0, uploading: 0, error: null });
  assert.deepEqual(state(composer(tile('a.png', false), tile('b.png', true))), { tiles: 2, uploading: 1, error: null });
});

const extract = (reply: string) => extraction.parse(run(page([{ n: 1, reply }]), claudeExtractionScript));

test('prose, lists, quotes, links and headings become Markdown; a table and a code block become their own blocks in order', () => {
  const result = extract([
    '<h3 dir="ltr" aria-level="4">Title</h3>',
    '<p dir="ltr">Has <strong>bold</strong>, <em>italic</em>, <code dir="ltr">code</code> and a <a href="https://example.com">link</a>.</p>',
    '<ol dir="ltr"><li>First<ul dir="ltr"><li>Nested</li></ul></li><li>Second</li></ol>',
    '<blockquote dir="ltr"><p dir="ltr">Quoted</p></blockquote><hr>',
    '<table><thead><tr><th scope="col">#</th><th scope="col">Item</th></tr></thead><tbody><tr><td><span dir="ltr">1</span></td><td>Alpha</td></tr></tbody></table>',
    '<div data-not-prose=""><div role="group" aria-label="Mã python" tabindex="0"><div><div><button aria-label="Sao chép" data-testid="code-block-copy">\ue056</button></div></div><div data-find-omitted="">python</div><div><pre><code class="language-python">print(1)\nprint(2)</code></pre></div></div></div>',
    '<p dir="ltr">After</p>',
  ].join('\n'));
  assert.deepEqual(result.blocks, [
    { type: 'markdown', text: ['### Title', 'Has **bold**, *italic*, `code` and a [link](https://example.com/).', '1. First\n   - Nested\n2. Second', '> Quoted', '---'].join('\n\n') },
    { type: 'table', header: ['#', 'Item'], rows: [['1', 'Alpha']] },
    { type: 'code', language: 'python', code: 'print(1)\nprint(2)' },
    { type: 'markdown', text: 'After' },
  ]);
  assert.deepEqual(result.shots, [{ id: 1, kind: 'table', block: 1 }]);
  assert.ok(!result.text.includes('\ue056'));
});

test('a code block without a language class takes the header label, and plain-text labels mean no language', () => {
  const group = (label: string, code: string): string => `<div role="group"><div>${label}</div><pre><code>${code}</code></pre></div>`;
  assert.deepEqual(extract(group('bash', 'ls')).blocks, [{ type: 'code', language: 'bash', code: 'ls' }]);
  assert.deepEqual(extract(group('text', 'plain')).blocks, [{ type: 'code', language: null, code: 'plain' }]);
});

test('an image in the reply becomes an asset placeholder, a tiny icon does not', () => {
  const result = extract('<p>See</p><img alt="Chart" src="blob:https://claude.ai/abc"><img alt="" src="https://example.com/x.png">');
  assert.deepEqual(result.assets, [{ id: 1, kind: 'image', name: 'Chart' }]);
  assert.deepEqual(result.blocks, [{ type: 'markdown', text: 'See' }, { type: 'asset', id: 1 }]);
});
