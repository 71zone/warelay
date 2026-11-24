import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bridge } from '../src/core/bridge.js';
import type { Assistant, IncomingMessage, MessagingAdapter } from '../src/core/contracts.js';
import type { RoutingState } from '../src/core/state.js';
import { fakeAssistant, fakeChannel, loadState, providerNames, withDirectory } from './support/core-fixtures.js';

const alice = { id: '11111111111@s.whatsapp.net', name: 'Alice' };
const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;
const incoming = (id: string, text = `Question ${id}`): IncomingMessage => ({ id, contact: alice, text, attachments: [], acknowledge: async () => {} });
const bridgeOf = (store: RoutingState, assistant: Assistant, channel: MessagingAdapter, logger: (line: string) => void = () => {}): Bridge => new Bridge(store, assistant, channel, logger, providerNames);

/** An assistant that records the prompts it receives and answers each. */
function recorder(prompts: string[], before: () => Promise<void> = async () => {}): Assistant {
  return fakeAssistant({ reply: async input => {
    prompts.push(input.text);
    await before();
    await input.onConversation('https://chatgpt.com/c/convo');
    await input.onSubmitted();
    return { conversationRef: 'https://chatgpt.com/c/convo', text: `Answer ${input.text}` };
  } });
}

async function savedPending(directory: string): Promise<{ messageId: string }[]> {
  return (JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as { pending: { messageId: string }[] }).pending;
}

test('a received message is on disk before its delivery starts and gone once the reply was sent', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory);
    await store.enable(alice);
    const during: string[][] = [];
    const bridge = bridgeOf(store, recorder([], async () => { during.push((await savedPending(directory)).map(entry => entry.messageId)); }), fakeChannel());
    bridge.arm();
    bridge.receive(incoming('m1'));
    bridge.receive(incoming('m2'));
    assert.equal((await store.pendingMessages()).length, 2);
    await bridge.idle();
    assert.deepEqual(during, [['m1', 'm2'], ['m2']]);
    assert.deepEqual(await savedPending(directory), []);
  }, 'warelay-pending-');
});

test('a failed delivery clears its pending entry too, and pausing the contact drops what is still pending', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory);
    await store.enable(alice);
    const failing = fakeAssistant({ reply: async input => { await input.onSubmitted(); throw new Error('Response timed out'); } });
    const bridge = bridgeOf(store, failing, fakeChannel());
    bridge.arm();
    bridge.receive(incoming('m1'));
    await bridge.idle();
    assert.deepEqual(await savedPending(directory), []);
    await store.addPending({ contactId: alice.id, messageId: 'm2', text: 'later', attachments: [] });
    assert.equal((await savedPending(directory)).length, 1);
    await store.pause(alice.id);
    assert.deepEqual(await savedPending(directory), []);
  }, 'warelay-pending-');
});

test('pending messages are replayed once as ONE prompt after a restart, oldest first, and answered', async () => {
  await withDirectory(async directory => {
    let clock = NOW;
    const before = await loadState(directory, () => clock);
    await before.enable(alice);
    await before.addPending({ contactId: alice.id, messageId: 'm1', text: 'first', attachments: [] });
    clock += 60_000;
    await before.addPending({ contactId: alice.id, messageId: 'm2', text: 'second', attachments: [] });
    // The process died here: a new one loads the same file.
    clock += 60_000;
    const store = await loadState(directory, () => clock);
    const prompts: string[] = [];
    const replies: string[] = [];
    const bridge = bridgeOf(store, recorder(prompts), fakeChannel({ sendText: async (_id, text) => { replies.push(text); } }));
    bridge.arm();
    bridge.replay();
    await bridge.idle();
    assert.deepEqual(prompts, ['first\n\nsecond']);
    assert.deepEqual(replies, ['Answer first\n\nsecond']);
    assert.equal(store.hasDelivery(alice.id, 'm2'), true);
    assert.deepEqual(await savedPending(directory), []);
    bridge.replay();
    await bridge.idle();
    assert.equal(prompts.length, 1);
  }, 'warelay-pending-');
});

test('replay skips entries the journal already finished, entries older than 24 hours and entries whose photo vanished', async () => {
  await withDirectory(async directory => {
    const route = { contactId: alice.id, name: 'Alice', enabled: true, conversationTtlMinutes: null, error: null, refs: { chatgpt: { conversationRef: null, projectRef: null, startedAt: null } } };
    const gone = { kind: 'image', path: join(directory, 'media', 'gone.jpg'), fileName: 'gone.jpg', mimeType: 'image/jpeg' };
    const kept = { kind: 'image', path: join(directory, 'media', 'kept.jpg'), fileName: 'kept.jpg', mimeType: 'image/jpeg' };
    await mkdir(join(directory, 'media'), { recursive: true });
    await writeFile(kept.path, 'jpeg');
    await writeFile(join(directory, 'state.json'), JSON.stringify({
      version: 3, running: true, aliases: [], routes: [route], settings: { providers: ['chatgpt'], retriesBeforeFallback: 2, options: {} }, limits: {}, turns: {},
      deliveries: [{ key: `${alice.id}:done`, contactId: alice.id, status: 'done' }],
      pending: [
        { contactId: alice.id, messageId: 'done', text: 'already answered', attachments: [], receivedAt: NOW - 60_000 },
        { contactId: alice.id, messageId: 'old', text: 'a day ago', attachments: [], receivedAt: NOW - 25 * HOUR },
        { contactId: alice.id, messageId: 'vanished', text: 'with photo', attachments: [gone], receivedAt: NOW - 50_000 },
        { contactId: alice.id, messageId: 'fresh', text: 'with kept photo', attachments: [kept], receivedAt: NOW - 40_000 },
      ],
    }));
    const store = await loadState(directory, () => NOW);
    const prompts: string[] = [];
    const logs: string[] = [];
    const bridge = bridgeOf(store, recorder(prompts), fakeChannel(), line => logs.push(line));
    bridge.arm();
    bridge.replay();
    await bridge.idle();
    assert.deepEqual(prompts, ['with kept photo']);
    assert.ok(logs.some(line => line.includes('gone.jpg is no longer on disk')));
    assert.deepEqual(await savedPending(directory), []);
  }, 'warelay-pending-');
});
