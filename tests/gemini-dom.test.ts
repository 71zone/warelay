import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { composerAttachmentsScript, geminiInspectionScript, identityScript } from '../src/adapters/gemini/dom.js';
import { geminiExtractionScript } from '../src/adapters/gemini/extract.js';
import { extraction } from '../src/adapters/browseros/extraction.js';

// Markup follows what gemini.google.com rendered when this was written: `.conversation-container` turns holding `user-query` and `model-response`, the container id
// and the response only existing once the reply streams, and a stop state on the composer's send button.
const inspected = z.object({ url: z.string(), userId: z.string().nullable(), assistantId: z.string().nullable(), text: z.string(), complete: z.boolean(), busy: z.boolean(), error: z.string().nullable(), limit: z.string().nullable(), media: z.boolean() });

interface Turn { n: number; reply?: string; streaming?: boolean; pending?: boolean; actions?: boolean; disclaimer?: string }
const turn = ({ n, reply = '<p dir="ltr"><span>Answer</span></p>', streaming = false, pending = false, actions = true, disclaimer = '' }: Turn): string => {
  const prompt = `<user-query><div class="query-content" id="user-query-content-${n}"><p>Question</p></div></user-query>`;
  if (pending) return `<div class="conversation-container">${prompt}<pending-request></pending-request><pending-response></pending-response></div>`;
  const id = `00000000000000${String(n).padStart(2, '0')}`;
  return `<div class="conversation-container" id="${id}">${prompt}<model-response><div><h6>Gemini said</h6><message-content id="message-content-id-r_${id}"><div class="markdown" id="model-response-message-contentr_${id}" aria-busy="${streaming}">${reply}</div></message-content>${actions ? '<message-actions><button aria-label="Copy"></button></message-actions>' : ''}</div></model-response><model-response-disclaimers>${disclaimer}</model-response-disclaimers></div>`;
};
const page = (turns: Turn[], { notices = '', stop = false, composerNotice = '' }: { notices?: string; stop?: boolean; composerNotice?: string } = {}): string =>
  `<chat-window><div data-test-id="chat-history-container">${turns.map(turn).join('')}</div></chat-window><div role="status">${notices}</div><input-container>${composerNotice}<input-area-v2><rich-textarea><div class="ql-editor" role="textbox" contenteditable="true">I hit the usage limit</div></rich-textarea><div class="send-button${stop ? ' stop' : ''}"><button aria-label="x"></button></div></input-area-v2></input-container>`;

function run(html: string, script: string, target: string | null = null): unknown {
  const { document } = parseHTML(html);
  return runInNewContext(`(${script})(${JSON.stringify(target)})`, { document, location: { href: 'https://gemini.google.com/u/0/app/x' }, URL });
}
const inspect = (html: string, target: string | null = null) => inspected.parse(run(html, geminiInspectionScript, target));

test('the newest turn is read through its reply, and plain text skips icon ligatures, table footers and the screen-reader label while code keeps its indentation', () => {
  const reply = '<response-element><table-block><table><thead><tr><th><span>A</span></th><th><span>B</span></th></tr></thead><tbody><tr><td><span>1</span></td><td><span>2</span></td></tr></tbody></table><div class="table-footer" hide-from-message-actions=""><gem-icon-button><button><mat-icon>more_horiz</mat-icon></button></gem-icon-button></div></table-block></response-element>'
    + '<response-element><code-block><div class="code-block-decoration"><span>Python</span><button>Copy code</button></div><pre><code data-test-id="code-content">for i in x:\n    print(i)\n</code></pre></code-block></response-element><ul><li><p><span>Point</span></p></li></ul>';
  const read = inspect(page([{ n: 0, reply: '<p>Old</p>' }, { n: 1, reply }]));
  assert.equal(read.userId, 'q1');
  assert.equal(read.assistantId, 'model-response-message-contentr_0000000000000001');
  assert.equal(read.text, 'A\tB\n1\t2\nfor i in x:\n    print(i)\nPoint');
  assert.equal(read.complete, true);
  assert.equal(read.busy, false);
  assert.deepEqual([read.error, read.limit], [null, null]);
});

test('a pending turn has an ordinal but no reply, a streaming reply is busy, and neither is complete; a reply without its action bar is not complete', () => {
  const pending = inspect(page([{ n: 0 }, { n: 1, pending: true }], { stop: true }));
  assert.deepEqual([pending.userId, pending.assistantId, pending.busy, pending.complete, pending.text], ['q1', null, true, false, '']);
  const streaming = inspect(page([{ n: 0, streaming: true, actions: false }]));
  assert.deepEqual([streaming.busy, streaming.complete], [true, false]);
  assert.equal(inspect(page([{ n: 0, actions: false }])).complete, false);
});

test('the turn of a given prompt ordinal is selected, and an unmounted one reads as absent', () => {
  const turns = [{ n: 0, reply: '<p>One</p>' }, { n: 1, reply: '<p>Two</p>' }];
  assert.equal(inspect(page(turns), 'q0').text, 'One');
  const missing = inspect(page(turns), 'q7');
  assert.deepEqual([missing.userId, missing.assistantId, missing.text, missing.complete], [null, null, '', false]);
});

test('usage-limit notices are found in status regions and the composer area, but the draft in the editor and ordinary notices are not limits', () => {
  for (const notice of ["You've reached your Deep Research limit", 'You can use it again when your limit resets on Nov 28 at 3:45 PM.', "You've hit your limit on Thinking. Try again after 3:45 PM"]) {
    assert.equal(inspect(page([{ n: 0 }], { notices: notice })).limit, notice, notice);
    assert.equal(inspect(page([{ n: 0 }], { composerNotice: `<div>${notice}</div>` })).limit, notice, notice);
  }
  for (const notice of ['Gemini is AI and can make mistakes.', 'Upgrade for higher limits']) assert.equal(inspect(page([{ n: 0 }], { notices: notice, composerNotice: notice })).limit, null, notice);
  const alert = inspect(page([{ n: 0 }], { notices: '<div role="alert">Something went wrong</div>' }));
  assert.deepEqual([alert.limit, alert.error], [null, 'Something went wrong']);
  const limitAlert = inspect(page([{ n: 0 }], { notices: '<div role="alert">Usage limit reached</div>' }));
  assert.deepEqual([limitAlert.limit, limitAlert.error], ['Usage limit reached', null]);
});

test('a turn disclaimer counts only for the turn being waited on, a short reply that states the limit is not a completed reply, and a long one never counts', () => {
  const disclaimer = "You've reached your limit for file uploads. Your limit resets tomorrow.";
  assert.equal(inspect(page([{ n: 0, disclaimer }])).limit, null);
  assert.equal(inspect(page([{ n: 0, disclaimer }]), 'q0').limit, disclaimer);
  assert.equal(inspect(page([{ n: 0, disclaimer }, { n: 1 }]), 'q1').limit, null);
  const notice = "You've reached your limit. Try again in 2 hours.";
  const asReply = inspect(page([{ n: 0, reply: `<p>${notice}</p>` }]), 'q0');
  assert.deepEqual([asReply.limit, asReply.text, asReply.complete], [notice, '', false]);
  assert.equal(inspect(page([{ n: 0, reply: `<p>${notice}</p>` }])).limit, null);
  assert.equal(inspect(page([{ n: 0, reply: `<p>When you reach your usage limit, the quota resets. ${'Details vary by plan. '.repeat(20)}</p>` }]), 'q0').limit, null);
});

const tiles = (...tile: string[]): string => `<uploader-file-preview-container>${tile.join('')}</uploader-file-preview-container>`;

test('the composer script counts attachment tiles and the ones still uploading; the identity script reads the account email whatever the label language', () => {
  const state = (html: string) => z.object({ tiles: z.number(), uploading: z.number(), error: z.string().nullable() }).parse(run(html, composerAttachmentsScript));
  assert.deepEqual(state(''), { tiles: 0, uploading: 0, error: null });
  assert.deepEqual(state(tiles('<uploader-file-preview><mat-progress-spinner></mat-progress-spinner></uploader-file-preview>', '<uploader-file-preview></uploader-file-preview>')), { tiles: 2, uploading: 1, error: null });
  const email = (html: string) => z.string().nullable().parse(run(html, identityScript));
  assert.equal(email('<a aria-label="Google Account: Vân Long  \n(nhvlongg@gmail.com), Google membership"></a>'), 'nhvlongg@gmail.com');
  assert.equal(email('<a aria-label="Tài khoản Google: Long (long@example.com)"></a>'), 'long@example.com');
  assert.equal(email('<a aria-label="Search"></a>'), null);
});

const extract = (reply: string) => extraction.parse(run(page([{ n: 0, reply }]), geminiExtractionScript));

test('prose, lists, quotes and links become Markdown; a table and a code block become their own blocks in order', () => {
  const result = extract([
    '<h2 dir="ltr"><span>Title</span></h2>',
    '<p dir="ltr"><span>Has </span><b>bold</b><span>, </span><i>italic</i>, <code>code</code> and a <a href="https://example.com">link</a>.</p>',
    '<ol><li><p><span>First</span></p><ul><li><p><span>Nested</span></p></li></ul></li><li><p><span>Second</span></p></li></ol>',
    '<div class="horizontal-scroll-wrapper"><div class="table-block-component"><response-element><table-block><div class="table-block"><div class="table-content"><table><thead><tr><th><span>#</span></th><th><span>Item</span></th></tr></thead><tbody><tr><td><span>1</span></td><td><span>Alpha</span></td></tr></tbody></table></div><div class="table-footer" hide-from-message-actions=""><gem-icon-button><button><mat-icon>more_horiz</mat-icon></button></gem-icon-button></div></div></table-block></response-element></div></div>',
    '<response-element><code-block><div class="code-block"><div class="code-block-decoration"><span>Python</span><div class="buttons"><button>Copy code</button></div></div><pre><code data-test-id="code-content">print(1)\n    print(2)\n</code></pre></div></code-block></response-element>',
    '<blockquote><p><span>Quoted</span></p></blockquote><hr><p><span>After</span></p>',
  ].join('\n'));
  assert.deepEqual(result.blocks, [
    { type: 'markdown', text: ['## Title', 'Has **bold**, *italic*, `code` and a [link](https://example.com/).', '1. First\n   - Nested\n2. Second'].join('\n\n') },
    { type: 'table', header: ['#', 'Item'], rows: [['1', 'Alpha']] },
    { type: 'code', language: 'python', code: 'print(1)\n    print(2)' },
    { type: 'markdown', text: ['> Quoted', '---', 'After'].join('\n\n') },
  ]);
  assert.deepEqual(result.shots, [{ id: 1, kind: 'table', block: 1 }]);
  assert.ok(!result.text.includes('more_horiz'));
});

test('a pending or missing turn extracts nothing, and an image of the reply becomes an asset placeholder', () => {
  assert.deepEqual(extraction.parse(run(page([{ n: 0, pending: true }]), geminiExtractionScript)).blocks, []);
  const result = extract('<p>See</p><img alt="Chart" src="https://lh3.googleusercontent.com/abc"><img alt="" src="https://example.com/x.png">');
  assert.deepEqual(result.assets, [{ id: 1, kind: 'image', name: 'Chart' }]);
  assert.deepEqual(result.blocks, [{ type: 'markdown', text: 'See' }, { type: 'asset', id: 1 }]);
});
