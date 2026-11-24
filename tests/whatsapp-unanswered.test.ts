import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import type { IncomingMessage } from '../src/core/contracts.js';
import { createDirectorySaver } from '../src/adapters/whatsapp/autosave.js';
import { createLinkState } from '../src/adapters/whatsapp/connection.js';
import { Directory } from '../src/adapters/whatsapp/directory.js';
import { createInbound } from '../src/adapters/whatsapp/inbound.js';
import { createDirectoryIngest } from '../src/adapters/whatsapp/ingestion.js';
import { MAX_UNANSWERED_MESSAGES, selectUnanswered } from '../src/adapters/whatsapp/unanswered.js';
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
  assert.deepEqual(ids(selectUnanswered(history, { since: NOW - 24 * HOUR, isDelivered: none })), ['a', 'b', 'c']);
  assert.deepEqual(ids(selectUnanswered([...history, own('later', NOW - 30 * 60)], { since: NOW - 24 * HOUR, isDelivered: none })), []);
});

test('unanswered: ignores reactions and protocol traffic as replies, old messages, unsupported types and repeats', () => {
  const reaction = { key: { id: 'r', remoteJid: PN, fromMe: true }, message: { reactionMessage: { text: '👍' } }, messageTimestamp: NOW - 60 } as WAMessage;
  const video = { key: { id: 'v', remoteJid: PN, fromMe: false }, message: { videoMessage: {} }, messageTimestamp: NOW - 50 } as WAMessage;
  const history = [incoming('ancient', NOW - 25 * HOUR), incoming('fresh', NOW - HOUR), incoming('fresh', NOW - HOUR), reaction, video];
  assert.deepEqual(ids(selectUnanswered(history, { since: NOW - 24 * HOUR, isDelivered: none })), ['fresh']);
});

test('unanswered: journaled messages are skipped, and a journaled newest message means the group was already handled', () => {
  const history = [incoming('a', NOW - 3 * HOUR), incoming('b', NOW - 2 * HOUR), incoming('c', NOW - HOUR)];
  assert.deepEqual(ids(selectUnanswered(history, { since: NOW - 24 * HOUR, isDelivered: id => id === 'a' })), ['b', 'c']);
  assert.deepEqual(ids(selectUnanswered(history, { since: NOW - 24 * HOUR, isDelivered: id => id === 'c' })), []);
});

test('unanswered: never more than the newest 10', () => {
  const history = Array.from({ length: 15 }, (_, index) => incoming(`m${index}`, NOW - 20 * 60 + index * 10));
  const picked = selectUnanswered(history, { since: NOW - 24 * HOUR, isDelivered: none });
  assert.equal(picked.length, MAX_UNANSWERED_MESSAGES);
  assert.deepEqual(ids(picked), history.slice(5).map(message => message.key.id));
});

const OTHER = '14155559999@s.whatsapp.net';
const inOther = (id: string, at: number): WAMessage => ({ key: { id, remoteJid: OTHER, fromMe: false }, message: { conversation: `body ${id}` }, messageTimestamp: at }) as WAMessage;

interface Harness {
  received: IncomingMessage[];
  ev: EventEmitter;
  /** Emits one upsert and waits until it has been handled. */
  upsert(type: 'notify' | 'append', messages: WAMessage[]): Promise<void>;
}

/** Inbound as the app wires it after a first start: no liveness watermark, so the link's cutoff is "now". Only PN is an enabled contact. */
async function withHarness(check: (harness: Harness) => Promise<void>, journaled: (id: string) => boolean = none): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wa-unanswered-'));
  try {
    const directory = new Directory(root);
    const saver = createDirectorySaver(directory, () => {}, undefined);
    const ingest = createDirectoryIngest(directory, { onIdentity: () => {}, changed: saver.schedule });
    const link = createLinkState();
    link.socket = { readMessages: async () => {} } as unknown as WASocket;
    link.open = true;
    link.cutoffSeconds = NOW;
    const received: IncomingMessage[] = [];
    const ev = new EventEmitter();
    const inbound = createInbound({
      directory, ingest, saver, link, logger: () => {}, media: createMediaStore(join(root, 'media')), onMessage: message => received.push(message), now: () => NOW,
      forwarding: { isEnabled: contactId => contactId === PN, isDelivered: (_contactId, id) => journaled(id) },
    });
    inbound.attach(ev as unknown as WASocket['ev']);
    await check({ received, ev, async upsert(type, messages) { ev.emit('messages.upsert', { type, messages }); await inbound.drain(); } });
    await saver.flush();
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('an enabled contact\'s message under 24 hours old is accepted with no liveness watermark; another chat\'s old message and anything over 24 hours are not', async () => {
  await withHarness(async harness => {
    await harness.upsert('append', [incoming('missed', NOW - 70 * 60), incoming('ancient', NOW - 25 * HOUR), inOther('history', NOW - 70 * 60)]);
    assert.deepEqual(harness.received.map(message => [message.id, message.contact.id]), [['missed', PN]]);
    await harness.upsert('notify', [inOther('live', NOW)]);
    assert.deepEqual(harness.received.map(message => message.id), ['missed', 'live']);
  });
});

test('a reply typed on the phone in the same batch answers the earlier incoming messages', async () => {
  await withHarness(async harness => {
    await harness.upsert('append', [incoming('before', NOW - 3 * HOUR), own('typed', NOW - 2 * HOUR), incoming('after', NOW - HOUR)]);
    assert.deepEqual(harness.received.map(message => message.id), ['after']);
    await harness.upsert('append', [incoming('earlier', NOW - 5 * HOUR), own('typed-later', NOW - 4 * HOUR)]);
    assert.deepEqual(harness.received.map(message => message.id), ['after']);
  });
});

test('several unanswered messages of one chat in one batch go out as ONE prompt, oldest first, ending at the newest id, capped at 10', async () => {
  await withHarness(async harness => {
    await harness.upsert('append', [incoming('b', NOW - 2 * HOUR, 'two'), incoming('a', NOW - 3 * HOUR, 'one'), inOther('x', NOW - HOUR), incoming('c', NOW - HOUR, 'three')]);
    assert.equal(harness.received.length, 1);
    assert.equal(harness.received[0]?.id, 'c');
    assert.equal(harness.received[0]?.text, 'one\n\ntwo\n\nthree');
    const many = Array.from({ length: 12 }, (_, index) => incoming(`m${index}`, NOW - 20 * 60 + index * 10, `n${index}`));
    await harness.upsert('append', many);
    assert.equal(harness.received[1]?.text.split('\n\n').length, 10);
    assert.equal(harness.received[1]?.id, 'm11');
  });
});

test('a batch whose newest message the journal already holds is not forwarded again', async () => {
  await withHarness(async harness => {
    await harness.upsert('append', [incoming('a', NOW - 2 * HOUR), incoming('b', NOW - HOUR)]);
    assert.equal(harness.received.length, 0);
  }, id => id === 'b');
});
