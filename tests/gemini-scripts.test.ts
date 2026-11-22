import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { composerReady, submitScript, uploadScript } from '../src/adapters/gemini/dom.js';

// The BrowserOS scripts run here against a fake `browser` over a linkedom page. Labels are not English: refs must be matched through the page's structure,
// never through an English name.
const labels = { editor: 'Nhập câu lệnh cho Gemini', send: 'Gửi tin nhắn', plus: 'Tải lên và công cụ', item: 'Tải tệp lên. Tài liệu, dữ liệu, mã' };

interface Fixture { url: string; tiles: number; uploading: number; sendDisabled: boolean; sendMissing: boolean; stopping: boolean; moveOnFill: string | null; menuMissing: boolean }
const fixture = (over: Partial<Fixture> = {}): Fixture => ({ url: 'https://gemini.google.com/u/0/app/e73e4f005037421a', tiles: 0, uploading: 0, sendDisabled: false, sendMissing: false, stopping: false, moveOnFill: null, menuMissing: false, ...over });
const chatPattern = '^/u/0/app/e73e4f005037421a/?$';

async function runScript(script: string, state: Fixture, chooser: unknown = { fileChooserOpen: true }): Promise<{ result: unknown; calls: string[] }> {
  const calls: string[] = [];
  const tiles = Array.from({ length: state.tiles }, (_, index) => `<uploader-file-preview>${index < state.uploading ? '<mat-progress-spinner></mat-progress-spinner>' : ''}</uploader-file-preview>`).join('');
  const { document } = parseHTML(`<input-area-v2><button aria-haspopup="menu" aria-label="${labels.plus}"></button><button aria-haspopup="true" aria-label="Mode picker"></button><div role="textbox" aria-label="${labels.editor}"></div>${state.sendMissing ? '' : `<div class="send-button${state.stopping ? ' stop' : ''}"><button aria-label="${labels.send}"${state.sendDisabled ? ' aria-disabled="true"' : ''}></button></div>`}</input-area-v2>${tiles}<button data-test-id="local-images-files-uploader-button" aria-label="${labels.item}"></button>`);
  const page = {
    snapshot: async () => ({ url: state.url, refs: [
      { role: 'button', name: 'Mode picker', ref: 'mode' }, { role: 'button', name: labels.plus, ref: 'plus' }, { role: 'textbox', name: labels.editor, ref: 'editor' },
      ...(state.sendMissing ? [] : [{ role: 'button', name: labels.send, ref: 'send' }]), ...(state.menuMissing ? [] : [{ role: 'menuitem', name: labels.item, ref: 'item' }]),
    ] }),
    evaluateInPage: async (fn: (argument: unknown) => unknown, argument?: unknown) => ({ value: fn(argument) }),
    waitForSelector: async (selector: string) => { calls.push(`wait:${selector}`); return { matched: true }; },
    fill: async (ref: string, text: string) => { calls.push(`fill:${ref}:${text}`); if (state.moveOnFill) state.url = state.moveOnFill; },
    click: async (ref: string) => { calls.push(`click:${ref}`); return ref === 'item' ? chooser : undefined; },
    upload: async (ref: string | null, files: string[]) => { calls.push(`upload:${ref}:${files.join(',')}`); },
  };
  const result: unknown = await runInNewContext(`(async () => { ${script} })()`, { browser: { page: () => page }, document, JSON, RegExp, Error });
  return { result, calls };
}

test('the composer is ready when the page has a textbox, whatever its localized name', () => {
  const ready = (refs: { role: string; name: string }[]): unknown => runInNewContext(composerReady, { snapshot: { refs } });
  assert.equal(ready([{ role: 'button', name: 'Gửi' }, { role: 'textbox', name: labels.editor }]), true);
  assert.equal(ready([{ role: 'button', name: 'Send' }]), false);
});

test('submit fills the composer and clicks Send, both found by structure in a localized page, and reports the new address', async () => {
  const { result, calls } = await runScript(submitScript(5, chatPattern, 'Hello', 0), fixture());
  assert.deepEqual(calls, ['fill:editor:Hello', 'click:send']);
  assert.equal(z.object({ url: z.string() }).parse(result).url, 'https://gemini.google.com/u/0/app/e73e4f005037421a');
});

test('submit never types or clicks when the tab is off its destination, before or after filling', async () => {
  await assert.rejects(runScript(submitScript(5, chatPattern, 'Hello', 0), fixture({ url: 'https://gemini.google.com/u/1/app' })), /left the expected destination/);
  await assert.rejects(runScript(submitScript(5, chatPattern, 'Hello', 0), fixture({ moveOnFill: 'https://gemini.google.com/u/0/app/0000000000000000' })), /left the expected destination/);
});

test('submit refuses a missing, disabled or stop-state Send button and attachments that are missing or still uploading, without clicking', async () => {
  await assert.rejects(runScript(submitScript(5, chatPattern, 'Hi', 0), fixture({ sendMissing: true })), /Send button unavailable/);
  await assert.rejects(runScript(submitScript(5, chatPattern, 'Hi', 0), fixture({ sendDisabled: true })), /Send button disabled/);
  await assert.rejects(runScript(submitScript(5, chatPattern, 'Hi', 0), fixture({ stopping: true })), /still generating/);
  for (const state of [fixture({ tiles: 1 }), fixture({ tiles: 2, uploading: 1 })]) await assert.rejects(runScript(submitScript(5, chatPattern, 'Hi', 2), state), /Attachments are not ready/);
  const { calls } = await runScript(submitScript(5, chatPattern, '', 1), fixture({ tiles: 1 }));
  assert.deepEqual(calls, ['click:send']);
});

test('upload opens the plus menu, picks the upload entry by its test id and hands the files to the picker, only while the tab is on its destination', async () => {
  const { calls } = await runScript(uploadScript(5, chatPattern, ['/tmp/a.png', '/tmp/b b.png']), fixture());
  assert.deepEqual(calls, ['click:plus', 'wait:[data-test-id="local-images-files-uploader-button"]', 'click:item', 'upload:null:/tmp/a.png,/tmp/b b.png']);
  await assert.rejects(runScript(uploadScript(5, chatPattern, ['/tmp/a.png']), fixture({ url: 'https://gemini.google.com/u/1/app' })), /nothing attached/);
  await assert.rejects(runScript(uploadScript(5, chatPattern, ['/tmp/a.png']), fixture({ menuMissing: true })), /upload option unavailable/);
  await assert.rejects(runScript(uploadScript(5, chatPattern, ['/tmp/a.png']), fixture(), null), /did not open its file picker/);
});
