import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { parseHTML } from 'linkedom';
import { resolveBlocks, type AssetContext } from '../src/adapters/chatgpt/assets.js';
import { chatgptExtractionScript, extraction, type Extraction } from '../src/adapters/chatgpt/extract.js';
import { MAX_REPLY_SHOTS, MAX_SHOT_SLICES, SHOT_RESULT_CHARS, captureScript, captureShot } from '../src/adapters/chatgpt/shots.js';
import { createMediaStore } from '../src/infrastructure/media.js';

// Markup follows what ChatGPT's renderer produced for the STAR interview reply: a bordered card whose rows are a letter and a titled description with
// dividers between them, and a table inside a "table" widget frame.
const dil = (component: string, inner: string, attributes = ''): string => `<div data-d-component="${component}"${attributes}>${inner}</div>`;
const text = (value: string): string => `<p data-d-component="text">${value}</p>`;
const cardRow = (letter: string, title: string, body: string): string => dil('row', `${dil('box', `<h1 data-d-component="title"><strong>${letter}</strong></h1>`)}${dil('box', `<p data-d-component="text"><span data-d-component="text"><strong>${title}</strong></span></p><p data-d-component="text">${body}</p>`)}`);
const card = (rows: string[]): string => dil('box', rows.join(dil('divider', '')), ' data-d-direction="col" data-d-has-border=""');
const star = (count: number): string => card(['S', 'T', 'A', 'R'].slice(0, count).map(letter => cardRow(letter, `${letter} title — 10%`, `${letter} body: what happened and why it matters.`)));
const cell = (tag: 'th' | 'td', value: string): string => `<${tag} data-d-component="table-cell">${text(value)}</${tag}>`;
const table = (header: string[], rows: string[][]): string => `<div data-d-component="table"><div><table><tbody><tr data-d-component="table-row">${header.map(value => cell('th', value)).join('')}</tr>${rows.map(row => `<tr data-d-component="table-row">${row.map(value => cell('td', value)).join('')}</tr>`).join('')}</tbody></table></div></div>`;
const turn = (reply: string): string => `<main><section data-content-search-turn-key="turn-1"><div><h4 data-conversation-role="user">You said</h4><div data-chatgpt-search-message-ids="user-1">Question</div></div><div data-talvt-turn-state="complete"><div data-chatgpt-search-message-ids="assistant-1"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-response-body="assistant-1"><div data-markdown-text-style="assistant-message"><div data-dil-response="" data-d-direction="col">${reply}</div></div></div></div><button aria-label="Copy">Copy</button></div></section></main>`;

function extract(reply: string): { result: Extraction; document: Document } {
  const { document } = parseHTML(turn(reply));
  const value: unknown = runInNewContext(`(${chatgptExtractionScript})(null)`, { document, location: { href: 'https://chatgpt.com/c/existing' }, URL });
  return { result: extraction.parse(value), document };
}

test('a card of four rows is read as a headerless table, stamped for a screenshot and listed as a card', () => {
  const { result, document } = extract(`${text('Intro')}${star(4)}${text('Outro')}`);
  assert.deepEqual(result.blocks, [
    { type: 'markdown', text: 'Intro' },
    {
      type: 'table',
      header: [],
      rows: [
        ['S', 'S title — 10%\nS body: what happened and why it matters.'],
        ['T', 'T title — 10%\nT body: what happened and why it matters.'],
        ['A', 'A title — 10%\nA body: what happened and why it matters.'],
        ['R', 'R title — 10%\nR body: what happened and why it matters.'],
      ],
    },
    { type: 'markdown', text: 'Outro' },
  ]);
  assert.deepEqual(result.shots, [{ id: 1, kind: 'card', block: 1 }]);
  const stamped = document.querySelector('[data-wab-shot="1"]');
  assert.equal(stamped?.getAttribute('data-d-component'), 'box');
  assert.ok(stamped?.hasAttribute('data-d-has-border'));
});

test('a real table is stamped on the table element itself and listed with the index of its block', () => {
  const header = ['Typical TL answer', 'Stronger Senior TL answer'];
  const rows = [['"I coached the underperforming agents."', '"I analyzed performance patterns before deciding."'], ['"I escalated the issue to QA."', '"I collaborated with QA on the root cause."']];
  const { result, document } = extract(`${text('Before')}${table(header, rows)}${text('Between')}${table(['k', 'v'], [['a', '1']])}`);
  assert.deepEqual(result.blocks.map(block => block.type), ['markdown', 'table', 'markdown', 'table']);
  assert.deepEqual(result.blocks[1], { type: 'table', header, rows });
  assert.deepEqual(result.shots, [{ id: 1, kind: 'table', block: 1 }, { id: 2, kind: 'table', block: 3 }]);
  assert.equal(document.querySelector('[data-wab-shot="1"]')?.tagName, 'TABLE');
  assert.equal(document.querySelector('[data-wab-shot="2"]')?.tagName, 'TABLE');
});

test('a bordered box of fewer than three rows stays prose and is not stamped', () => {
  const { result, document } = extract(`${text('Intro')}${star(2)}${text('Outro')}`);
  assert.deepEqual(result.blocks.map(block => block.type), ['markdown']);
  assert.deepEqual(result.shots, []);
  assert.equal(document.querySelector('[data-wab-shot]'), null);
});

test('a reply without tables lists no shots', () => {
  assert.deepEqual(extract(text('Just prose')).result.shots, []);
});

// --- captureScript: run in the BrowserOS sandbox, here against a fake page that answers the two in-page scripts and the CDP call ---

interface Measure { width: number; height: number; cuts: number[]; clipped: boolean; viewportWidth: number; viewportHeight: number }
interface Place { offset: number; height: number; top: number }
interface Capture { clip: { x: number; y: number; width: number; height: number; scale: number }; format: string; captureBeyondViewport: boolean }

const measure = (overrides: Partial<Measure> = {}): Measure => ({ width: 700, height: 400, cuts: [100, 200, 300, 400], clipped: false, viewportWidth: 1200, viewportHeight: 1000, ...overrides });
const everyHundred = (height: number): number[] => Array.from({ length: height / 100 }, (_, index) => (index + 1) * 100);

const outcome = z.object({ images: z.array(z.string()).optional(), error: z.string().optional() });

async function capture(world: { measured: Measure | { error: string }; place?: (place: Place) => unknown; png?: (capture: Capture) => string }): Promise<{ value: z.infer<typeof outcome>; placed: Place[]; captured: Capture[] }> {
  const placed: Place[] = [];
  const captured: Capture[] = [];
  const browser = {
    page: () => ({
      evaluateInPage: async (_script: unknown, argument: unknown) => {
        if (typeof argument === 'number') return { value: world.measured };
        const place = argument as Place;
        placed.push({ ...place });
        return { value: world.place?.(place) ?? { x: 100, y: place.top + 1000, width: 700 } };
      },
      cdp: async (method: string, params: string) => {
        assert.equal(method, 'Page.captureScreenshot');
        const request = JSON.parse(params) as Capture;
        captured.push(request);
        return { data: world.png?.(request) ?? 'UE5H' };
      },
    }),
  };
  const value = outcome.parse(await runInNewContext(`(async () => {${captureScript(7, 3)}})()`, { browser, JSON, Math }));
  return { value, placed, captured };
}

test('an element that fits the room is captured whole as one PNG at double density with padding, without growing past the viewport', async () => {
  const { value, placed, captured } = await capture({ measured: measure() });
  assert.deepEqual(value, { images: ['UE5H'] });
  assert.deepEqual(placed, [{ id: 3, offset: 0, height: 400, top: 80 }]);
  assert.deepEqual(captured, [{ format: 'png', captureBeyondViewport: false, clip: { x: 92, y: 1072, width: 716, height: 416, scale: 2 } }]);
});

test('a tall element is cut at row boundaries into slices that each fit between the header and the composer, in order', async () => {
  const { value, placed, captured } = await capture({ measured: measure({ height: 1000, cuts: everyHundred(1000), viewportHeight: 700 }) });
  assert.equal(value.images?.length, 3);
  assert.deepEqual(placed.map(place => [place.offset, place.height]), [[0, 400], [400, 400], [800, 200]]);
  assert.deepEqual(captured.map(request => [request.clip.height]), [[408], [400], [208]]);
  assert.ok(captured.every(request => request.clip.height <= 700 - 72 - 200));
});

test('a row taller than the room, a table needing more than four slices and a clipped or tiny tab are refused with a reason', async () => {
  assert.match((await capture({ measured: measure({ height: 1000, cuts: [500, 1000], viewportHeight: 700 }) })).value.error ?? '', /row of the table is taller/);
  const tall = await capture({ measured: measure({ height: 3000, cuts: everyHundred(3000), viewportHeight: 700 }) });
  assert.match(tall.value.error ?? '', new RegExp(`more than ${MAX_SHOT_SLICES} pictures`));
  assert.deepEqual(tall.captured, []);
  assert.match((await capture({ measured: measure({ clipped: true }) })).value.error ?? '', /wider than the room/);
  assert.match((await capture({ measured: measure({ viewportHeight: 300 }) })).value.error ?? '', /too short/);
  assert.deepEqual((await capture({ measured: { error: 'The table is no longer on the page.' } })).value, { error: 'The table is no longer on the page.' });
});

test('a page that cannot scroll the slice clear of the header and composer stops the capture before anything is photographed', async () => {
  const run = await capture({ measured: measure(), place: () => ({ error: 'Something is drawn over the table.' }) });
  assert.deepEqual(run.value, { error: 'Something is drawn over the table.' });
  assert.deepEqual(run.captured, []);
});

test('a picture that is too large for the result falls back to normal density, and an element too large for one picture is refused', async () => {
  const heavy = await capture({ measured: measure(), png: request => request.clip.scale === 2 ? 'x'.repeat(1_900_000) : 'small' });
  assert.deepEqual(heavy.value, { images: ['small'] });
  assert.deepEqual(heavy.captured.map(request => request.clip.scale), [2, 1]);
  const hopeless = await capture({ measured: measure(), png: () => 'x'.repeat(1_900_000) });
  assert.match(hopeless.value.error ?? '', /too large/);
  const huge = await capture({ measured: measure({ width: 5000, viewportWidth: 6000 }), place: () => ({ x: 0, y: 100, width: 5000 }) });
  assert.match(huge.value.error ?? '', /too large for one picture/);
});

// --- captureShot and resolveBlocks ---

const png = (payload: string): string => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(payload)]).toString('base64');

interface Page { context: AssetContext; calls: { code: string; maxChars: number | undefined }[]; logs: string[]; directory: string }
async function fakePage(answer: (code: string) => unknown): Promise<Page> {
  const directory = await mkdtemp(join(tmpdir(), 'wabgpt-shots-'));
  const calls: Page['calls'] = [];
  const logs: string[] = [];
  const context: AssetContext = { run: async (code, maxChars) => { calls.push({ code, maxChars }); return answer(code); }, pageId: 7, logger: message => { logs.push(message); }, media: createMediaStore(directory) };
  return { context, calls, logs, directory };
}

test('captureShot stores each PNG slice in the media store with its own name and asks BrowserOS for a larger result', async () => {
  let images = [png('one'), png('two')];
  const page = await fakePage(() => ({ images }));
  try {
    const slices = await captureShot(3, page.context);
    assert.deepEqual(slices.map(slice => [slice.kind, slice.fileName, slice.mimeType]), [['image', 'table-1.png', 'image/png'], ['image', 'table-2.png', 'image/png']]);
    assert.deepEqual(await readFile(slices[1]?.path ?? ''), Buffer.from(png('two'), 'base64'));
    assert.equal(page.calls[0]?.maxChars, SHOT_RESULT_CHARS);
    assert.match(page.calls[0]?.code ?? '', /browser\.page\(7\)/);
    images = [png('x')];
    assert.equal((await captureShot(3, page.context))[0]?.fileName, 'table.png');
  } finally { await rm(page.directory, { recursive: true, force: true }); }
});

test('captureShot reports the page error, rejects bytes that are not a PNG and leaves no file behind', async () => {
  const broken = await fakePage(() => ({ error: 'Something is drawn over the table.' }));
  const notPng = await fakePage(() => ({ images: [png('fine'), Buffer.from('<html>').toString('base64')] }));
  try {
    await assert.rejects(captureShot(3, broken.context), /Something is drawn over the table/);
    await assert.rejects(captureShot(3, notPng.context), /not a PNG/);
    assert.deepEqual(await readdir(notPng.directory, { recursive: true, withFileTypes: true }).then(entries => entries.filter(entry => entry.isFile())), []);
  } finally { await Promise.all([broken, notPng].map(page => rm(page.directory, { recursive: true, force: true }))); }
});

const comparison = { type: 'table' as const, header: ['Typical TL answer', 'Stronger Senior TL answer'], rows: [['"I coached the agents."', '"I analyzed performance patterns before deciding on the intervention."']] };
const small = { type: 'table' as const, header: ['Name', 'Qty'], rows: [['Apple', '3']] };
const cardTable = { type: 'table' as const, header: [], rows: [['S', 'Situation\nWhat?'], ['T', 'Task'], ['A', 'Action']] };
const extractionOf = (blocks: Extraction['blocks'], shots: Extraction['shots'], assets: Extraction['assets'] = []): Extraction => ({ url: 'https://chatgpt.com/c/x', text: '', blocks, assets, shots });

test('a big table gets pictures, a card always does, and a small table is never photographed', async () => {
  const page = await fakePage(() => ({ images: [png('shot')] }));
  try {
    const blocks = await resolveBlocks(extractionOf(
      [{ type: 'markdown', text: 'Intro' }, comparison, small, cardTable],
      [{ id: 1, kind: 'table', block: 1 }, { id: 2, kind: 'table', block: 2 }, { id: 3, kind: 'card', block: 3 }],
    ), page.context);
    assert.deepEqual(blocks.map(block => block.type), ['markdown', 'table', 'table', 'table']);
    assert.deepEqual(blocks.map(block => block.type === 'table' ? block.images?.length ?? 0 : -1), [-1, 1, 0, 1]);
    assert.deepEqual(blocks[1]?.type === 'table' && { header: blocks[1].header, rows: blocks[1].rows }, { header: comparison.header, rows: comparison.rows });
    assert.equal(page.calls.length, 2);
    assert.ok(page.calls[0]?.code.includes('const measured=(await page.evaluateInPage(') && page.calls[0].code.includes(',1)'), 'the first picture is of element 1');
    assert.ok(page.calls[1]?.code.includes(',3)'), 'the second picture is of element 3, the small table in between is skipped');
  } finally { await rm(page.directory, { recursive: true, force: true }); }
});

test('when the picture cannot be taken the table is kept for text delivery and the failure is logged, never thrown', async () => {
  const page = await fakePage(() => ({ error: 'The table is wider than the room ChatGPT gives it.' }));
  try {
    const blocks = await resolveBlocks(extractionOf([comparison, { type: 'markdown', text: 'after' }], [{ id: 1, kind: 'table', block: 0 }]), page.context);
    assert.deepEqual(blocks, [comparison, { type: 'markdown', text: 'after' }]);
    assert.equal(page.logs.length, 1);
    assert.match(page.logs[0] ?? '', /Could not take a picture of a table.*wider than the room.*sent as text/);
  } finally { await rm(page.directory, { recursive: true, force: true }); }
});

test('a failing BrowserOS call is also contained, and the other blocks and assets of the reply survive', async () => {
  const page = await fakePage(code => {
    if (code.includes('captureScreenshot')) throw new Error('BrowserOS session expired');
    if (code.includes('data-wab-asset')) return { size: 3, mime: 'image/png', name: 'chart.png' };
    if (code.includes('arrayBuffer')) return { data: Buffer.from('png').toString('base64') };
    return true;
  });
  try {
    const blocks = await resolveBlocks(extractionOf([comparison, { type: 'asset', id: 1 }], [{ id: 1, kind: 'table', block: 0 }], [{ id: 1, kind: 'image', name: 'chart' }]), page.context);
    assert.deepEqual(blocks[0], comparison);
    assert.equal(blocks[1]?.type, 'attachment');
    assert.match(page.logs[0] ?? '', /BrowserOS session expired/);
  } finally { await rm(page.directory, { recursive: true, force: true }); }
});

test(`only the first ${MAX_REPLY_SHOTS} big tables of a reply are pictured; the rest are delivered as text`, async () => {
  const page = await fakePage(() => ({ images: [png('shot')] }));
  try {
    const tables = Array.from({ length: MAX_REPLY_SHOTS + 1 }, () => comparison);
    const blocks = await resolveBlocks(extractionOf(tables, tables.map((_, index) => ({ id: index + 1, kind: 'table' as const, block: index }))), page.context);
    assert.deepEqual(blocks.map(block => block.type === 'table' && block.images !== undefined), [...Array(MAX_REPLY_SHOTS).fill(true), false]);
    assert.equal(page.calls.length, MAX_REPLY_SHOTS);
    assert.match(page.logs.at(-1) ?? '', /more than \d+ big tables/);
  } finally { await rm(page.directory, { recursive: true, force: true }); }
});

test('shots follow their block when a missing asset placeholder before the table is dropped', async () => {
  const page = await fakePage(() => ({ images: [png('shot')] }));
  try {
    const blocks = await resolveBlocks(extractionOf([{ type: 'asset', id: 9 }, comparison], [{ id: 1, kind: 'table', block: 1 }]), page.context);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.type === 'table' && blocks[0].images?.length, 1);
  } finally { await rm(page.directory, { recursive: true, force: true }); }
});
