import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { proto } from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import type { IncomingMessage } from '../src/core/contracts.js';
import { createDirectorySaver } from '../src/adapters/whatsapp/autosave.js';
import { createLinkState } from '../src/adapters/whatsapp/connection.js';
import { Directory } from '../src/adapters/whatsapp/directory.js';
import { createInbound } from '../src/adapters/whatsapp/inbound.js';
import { createDirectoryIngest } from '../src/adapters/whatsapp/ingestion.js';
import { MAX_UNANSWERED_MESSAGES, createUnansweredRecovery, selectUnanswered } from '../src/adapters/whatsapp/unanswered.js';
import { createMediaStore } from '../src/infrastructure/media.js';

const PN = '14155551234@s.whatsapp.net';
const NOW = 1_700_100_000;
const HOUR = 3600;

const incoming = (id: string, at: number, body = `body ${id}`): WAMessage => ({ key: { id, remoteJid: PN, fromMe: false }, message: { conversation: body }, messageTimestamp: at }) as WAMessage;
const own = (id: string, at: number): WAMessage => ({ key: { id, remoteJid: PN, fromMe: true }, message: { conversation: `reply ${id}` }, messageTimestamp: at }) as WAMessage;
const ids = (messages: WAMessage[]): (string | null | undefined)[] => messages.map(message => message.key.id);
const none = (): boolean => false;

test('unanswered: messages after the newest reply, oldest first; a manual reply from the phone answers earlier ones', () => {
  const history = [
    incoming('old', NOW - 5 * HOUR), own('manual-reply', NOW - 4 * HOUR),
    incoming('b', NOW - 2 * HOUR), incoming('a', NOW - 3 * HOUR), incoming('c', NOW - HOUR),
  ];
  assert.deepEqual(ids(selectUnanswered(history, { now: NOW, isDelivered: none })), ['a', 'b', 'c']);
  assert.deepEqual(ids(selectUnanswered([...history, own('later', NOW - 30 * 60)], { now: NOW, isDelivered: none })), []);
});

test('unanswered: ignores reactions and protocol traffic as replies, old messages, unsupported types and repeats', () => {
  const reaction = { key: { id: 'r', remoteJid: PN, fromMe: true }, message: { reactionMessage: { text: '👍' } }, messageTimestamp: NOW - 60 } as WAMessage;
  const video = { key: { id: 'v', remoteJid: PN, fromMe: false }, message: { videoMessage: {} }, messageTimestamp: NOW - 50 } as WAMessage;
  const history = [incoming('ancient', NOW - 25 * HOUR), incoming('fresh', NOW - HOUR), incoming('fresh', NOW - HOUR), reaction, video];
  assert.deepEqual(ids(selectUnanswered(history, { now: NOW, isDelivered: none })), ['fresh']);
});

test('unanswered: journaled messages are skipped, and a journaled newest message means the group was already handled', () => {
  const history = [incoming('a', NOW - 3 * HOUR), incoming('b', NOW - 2 * HOUR), incoming('c', NOW - HOUR)];
  assert.deepEqual(ids(selectUnanswered(history, { now: NOW, isDelivered: id => id === 'a' })), ['b', 'c']);
  assert.deepEqual(ids(selectUnanswered(history, { now: NOW, isDelivered: id => id === 'c' })), []);
});

test('unanswered: never more than the newest 10', () => {
  const history = Array.from({ length: 15 }, (_, index) => incoming(`m${index}`, NOW - 20 * 60 + index * 10));
  const picked = selectUnanswered(history, { now: NOW, isDelivered: none });
  assert.equal(picked.length, MAX_UNANSWERED_MESSAGES);
  assert.deepEqual(ids(picked), history.slice(5).map(message => message.key.id));
});

interface Harness {
  received: IncomingMessage[];
  logs: string[];
  requests: { count: number; jid: string | null | undefined }[];
  ev: EventEmitter;
  run(options: { reply: ((requestId: string) => void) | 'silent'; lastMessageAt?: number }): Promise<void>;
}

async function withHarness(check: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wa-unanswered-'));
  try {
    const directory = new Directory(root);
    const saver = createDirectorySaver(directory, () => {}, undefined);
    const ingest = createDirectoryIngest(directory, { onIdentity: () => {}, changed: saver.schedule });
    const link = createLinkState();
    const ev = new EventEmitter();
    const requests: Harness['requests'] = [];
    let respond: ((requestId: string) => void) | 'silent' = 'silent';
    const socket = {
      ev,
      readMessages: async () => {},
      fetchMessageHistory: async (count: number, key: { remoteJid?: string | null }) => {
        requests.push({ count, jid: key.remoteJid });
        if (respond !== 'silent') { const answer = respond; setImmediate(() => answer('REQ1')); }
        return 'REQ1';
      },
    } as unknown as WASocket;
    link.socket = socket;
    link.open = true;
    const received: IncomingMessage[] = [];
    const logs: string[] = [];
    const logger = (line: string): void => { logs.push(line); };
    const inbound = createInbound({ directory, ingest, saver, link, logger, media: createMediaStore(join(root, 'media')), onMessage: message => received.push(message) });
    const recovery = createUnansweredRecovery({
      link, logger, directory, ingest, targets: () => [{ id: PN, name: 'Alice' }], isDelivered: () => false, forward: inbound.forwardRecovered,
      timing: { settleMs: 0, historyTimeoutMs: 60, now: () => NOW },
    });
    await check({
      received, logs, requests, ev,
      async run({ reply, lastMessageAt }) {
        respond = reply;
        if (lastMessageAt !== undefined) directory.chats.set(PN, { jid: PN, name: 'Alice', lastMessageAt, unread: 0, archived: false });
        await recovery.run(socket, new AbortController().signal);
        await inbound.drain();
      },
    });
    await saver.flush();
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('recovery: the phone answers, the unanswered messages go out as ONE prompt, and the log says what happened', async () => {
  await withHarness(async harness => {
    const phone = [incoming('first', NOW - 3 * HOUR, 'one'), own('mine', NOW - 2 * HOUR), incoming('q', NOW - HOUR, 'two'), incoming('r', NOW - 600, 'three')];
    await harness.run({
      lastMessageAt: NOW - HOUR,
      reply: id => harness.ev.emit('messaging-history.set', { chats: [], contacts: [], messages: phone, syncType: proto.HistorySync.HistorySyncType.ON_DEMAND, peerDataRequestSessionId: id }),
    });
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0]?.jid, PN);
    assert.equal(harness.received.length, 1);
    assert.equal(harness.received[0]?.id, 'r');
    assert.equal(harness.received[0]?.text, 'two\n\nthree');
    assert.deepEqual(harness.logs.filter(line => !line.startsWith('  ')), [
      'Checking Alice for unanswered messages…',
      'History for Alice: 4 messages from the phone, 2 unanswered, forwarding as one prompt.',
    ]);
  });
});

test('recovery: a phone that never answers is logged and nothing is forwarded', async () => {
  await withHarness(async harness => {
    await harness.run({ reply: 'silent' });
    assert.equal(harness.received.length, 0);
    assert.deepEqual(harness.logs, [
      'Checking Alice for unanswered messages…',
      'The phone did not return history for Alice (timed out); unanswered messages there cannot be checked.',
    ]);
  });
});

test('recovery: a chat quiet for over 24 hours is not even queried', async () => {
  await withHarness(async harness => {
    await harness.run({ reply: 'silent', lastMessageAt: NOW - 30 * HOUR });
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.logs.length, 1);
    assert.match(harness.logs[0] ?? '', /^Skipping Alice/);
  });
});
