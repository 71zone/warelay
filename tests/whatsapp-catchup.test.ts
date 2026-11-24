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
import { CATCH_UP_MARGIN_SECONDS, MAX_CATCH_UP_SECONDS, catchUpCutoff, readWatermark, writeWatermark } from '../src/adapters/whatsapp/liveness.js';
import { createMediaStore } from '../src/infrastructure/media.js';

const PN = '14155551234@s.whatsapp.net';
const NOW = 1_700_100_000;

test('cutoff: no watermark keeps the start time, so a new pairing never replays history', () => {
  assert.equal(catchUpCutoff({ now: NOW, watermark: undefined, notBefore: undefined }), NOW);
  assert.equal(catchUpCutoff({ now: NOW, watermark: undefined, notBefore: NOW - 500 }), NOW - 500);
});

test('cutoff: a watermark reaches back to it minus the margin, and notBefore cannot hide that backlog', () => {
  const watermark = NOW - 3600;
  const expected = watermark - CATCH_UP_MARGIN_SECONDS;
  assert.equal(catchUpCutoff({ now: NOW, watermark, notBefore: undefined }), expected);
  assert.equal(catchUpCutoff({ now: NOW, watermark, notBefore: NOW }), expected);
  assert.equal(catchUpCutoff({ now: NOW, watermark, notBefore: watermark - 7200 }), watermark - 7200);
});

test('cutoff: catch-up never reaches back more than 24 hours and ignores a watermark from the future', () => {
  assert.equal(catchUpCutoff({ now: NOW, watermark: NOW - 10 * MAX_CATCH_UP_SECONDS, notBefore: undefined }), NOW - MAX_CATCH_UP_SECONDS);
  assert.equal(catchUpCutoff({ now: NOW, watermark: NOW + 5000, notBefore: undefined }), NOW - CATCH_UP_MARGIN_SECONDS);
});

test('watermark file round-trips and unreadable content counts as no watermark', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wa-liveness-'));
  try {
    assert.equal(readWatermark(dir), undefined);
    writeWatermark(dir, NOW + 0.7);
    assert.equal(readWatermark(dir), NOW);
    writeWatermark(dir, -1);
    assert.equal(readWatermark(dir), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('offline backlog arriving as append is forwarded oldest first once, but only from the cutoff on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wa-catchup-'));
  try {
    const directory = new Directory(root);
    const saver = createDirectorySaver(directory, () => {}, undefined);
    const ingest = createDirectoryIngest(directory, { onIdentity: () => {}, changed: saver.schedule });
    const link = createLinkState();
    link.socket = { readMessages: async () => {} } as unknown as WASocket;
    link.open = true;
    link.cutoffSeconds = NOW - 3600;
    const received: IncomingMessage[] = [];
    const logs: string[] = [];
    const inbound = createInbound({ directory, ingest, saver, link, logger: line => logs.push(line), media: createMediaStore(join(root, 'media')), onMessage: message => received.push(message) });
    const ev = new EventEmitter();
    inbound.attach(ev as unknown as WASocket['ev']);
    const text = (id: string, at: number): WAMessage => ({ key: { id, remoteJid: PN, fromMe: false }, message: { conversation: `body ${id}` }, messageTimestamp: at, pushName: 'Push' }) as WAMessage;

    ev.emit('messages.upsert', { type: 'append', messages: [text('second', NOW - 1800), text('before', NOW - 7200), text('first', NOW - 3000)] });
    ev.emit('messages.upsert', { type: 'append', messages: [text('first', NOW - 3000)] });
    ev.emit('messages.upsert', { type: 'notify', messages: [text('second', NOW - 1800), text('live', NOW)] });
    await inbound.drain();

    assert.deepEqual(received.map(message => message.id), ['first', 'second', 'live']);
    assert.deepEqual(logs, ['Caught up: relayed 2 messages sent while warelay was offline.']);
    await saver.flush();
  } finally { await rm(root, { recursive: true, force: true }); }
});
