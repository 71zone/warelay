import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { composerReady, submitScript, uploadScript } from '../src/adapters/claude/dom.js';

// The BrowserOS scripts run here against a fake `browser` over a linkedom page. Labels are Vietnamese, as in the account the adapter was built against:
// refs must be matched through the test ids, never through an English name.
const editorLabel = 'Viết câu lệnh gửi Claude';
const sendLabel = 'Gửi tin nhắn';

interface Fixture { url: string; tiles: number; uploading: number; sendDisabled: boolean; sendMissing: boolean; moveOnFill: string | null }
const fixture = (over: Partial<Fixture> = {}): Fixture => ({ url: 'https://claude.ai/chat/9172d8d3-38bc-4ebb-ac0b-4cbf03705a69', tiles: 0, uploading: 0, sendDisabled: false, sendMissing: false, moveOnFill: null, ...over });
const chatPattern = '^/chat/9172d8d3-38bc-4ebb-ac0b-4cbf03705a69/?$';

async function runScript(script: string, state: Fixture): Promise<{ result: unknown; calls: string[] }> {
  const calls: string[] = [];
  const tiles = Array.from({ length: state.tiles }, (_, index) => `<div data-testid="file-thumbnail"${index < state.uploading ? ' aria-busy="true"' : ''}></div>`).join('');
  const { document } = parseHTML(`<div data-testid="chat-input" aria-label="${editorLabel}"></div>${state.sendMissing ? '' : `<button data-testid="chat-input-send" aria-label="${sendLabel}"${state.sendDisabled ? ' disabled' : ''}></button>`}${tiles}<button aria-label="Khác"></button>`);
  const page = {
    snapshot: async () => ({ url: state.url, refs: [{ role: 'button', name: 'Khác', ref: 'other' }, { role: 'textbox', name: editorLabel, ref: 'editor' }, ...(state.sendMissing ? [] : [{ role: 'button', name: sendLabel, ref: 'send' }])] }),
    evaluateInPage: async (fn: (argument: unknown) => unknown, argument?: unknown) => ({ value: fn(argument) }),
    fill: async (ref: string, text: string) => { calls.push(`fill:${ref}:${text}`); if (state.moveOnFill) state.url = state.moveOnFill; },
    click: async (ref: string) => { calls.push(`click:${ref}`); },
    cdp: async (method: string, params: string) => {
      calls.push(`cdp:${method}:${params}`);
      return method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : method === 'DOM.querySelector' ? { nodeId: 7 } : {};
    },
  };
  const result: unknown = await runInNewContext(`(async () => { ${script} })()`, { browser: { page: () => page }, document, JSON, RegExp, Error });
  return { result, calls };
}

test('the composer is ready when the page has a textbox, whatever its localized name', () => {
  const ready = (refs: { role: string; name: string }[]): unknown => runInNewContext(composerReady, { snapshot: { refs } });
  assert.equal(ready([{ role: 'button', name: 'Gửi' }, { role: 'textbox', name: editorLabel }]), true);
  assert.equal(ready([{ role: 'button', name: 'Send' }]), false);
});

test('submit fills the composer and clicks Send, both found through their test ids in a localized page, and reports the new address', async () => {
  const { result, calls } = await runScript(submitScript(5, chatPattern, 'Hello', 0), fixture());
  assert.deepEqual(calls, ['fill:editor:Hello', 'click:send']);
  assert.equal(z.object({ url: z.string() }).parse(result).url, 'https://claude.ai/chat/9172d8d3-38bc-4ebb-ac0b-4cbf03705a69');
});

test('submit never types or clicks when the tab is off its destination, before or after filling', async () => {
  await assert.rejects(runScript(submitScript(5, chatPattern, 'Hello', 0), fixture({ url: 'https://claude.ai/new' })), /left the expected destination/);
  const moved = fixture({ moveOnFill: 'https://claude.ai/chat/00000000-0000-0000-0000-000000000000' });
  await assert.rejects(runScript(submitScript(5, chatPattern, 'Hello', 0), moved), /left the expected destination/);
});

test('submit refuses a missing or disabled Send button and a composer whose attachments are missing or still uploading, without clicking', async () => {
  await assert.rejects(runScript(submitScript(5, chatPattern, 'Hi', 0), fixture({ sendMissing: true })), /Send button unavailable/);
  await assert.rejects(runScript(submitScript(5, chatPattern, 'Hi', 0), fixture({ sendDisabled: true })), /Send button disabled/);
  for (const state of [fixture({ tiles: 1 }), fixture({ tiles: 2, uploading: 1 })]) await assert.rejects(runScript(submitScript(5, chatPattern, 'Hi', 2), state), /Attachments are not ready/);
  const { calls } = await runScript(submitScript(5, chatPattern, '', 1), fixture({ tiles: 1 }));
  assert.deepEqual(calls, ['click:send']);
});

test('upload sets the files on the composer input through the DevTools protocol, only while the tab is on its destination', async () => {
  const { calls } = await runScript(uploadScript(5, chatPattern, ['/tmp/a.png', '/tmp/b b.png']), fixture());
  assert.deepEqual(calls, [
    'cdp:DOM.getDocument:{"depth":0}',
    'cdp:DOM.querySelector:{"nodeId":1,"selector":"input[data-testid=\\"file-upload\\"]"}',
    'cdp:DOM.setFileInputFiles:{"nodeId":7,"files":["/tmp/a.png","/tmp/b b.png"]}',
  ]);
  await assert.rejects(runScript(uploadScript(5, chatPattern, ['/tmp/a.png']), fixture({ url: 'https://claude.ai/new' })), /nothing attached/);
});
