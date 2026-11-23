import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WAMessage } from '@whiskeysockets/baileys';
import { withQuote } from '../src/adapters/whatsapp/protocol.js';

const reply = (quoted: object, text: string): WAMessage => ({ key: { id: 'x' }, message: { extendedTextMessage: { text, contextInfo: { quotedMessage: quoted } } } }) as WAMessage;

test('a quoted reply is forwarded with the message it answers', () => {
  assert.equal(withQuote(reply({ conversation: 'Line one\nLine two' }, 'The OM is focusing more on KPIs'), 'The OM is focusing more on KPIs'),
    'Replying to this earlier message:\n> Line one\n> Line two\n\nThe OM is focusing more on KPIs');
  assert.equal(withQuote(reply({ imageMessage: { mimetype: 'image/png' } }, 'what is this'), 'what is this'), 'Replying to this earlier message:\n> [photo]\n\nwhat is this');
});

test('a message that quotes nothing is unchanged', () => {
  assert.equal(withQuote({ key: { id: 'x' }, message: { conversation: 'hi' } } as WAMessage, 'hi'), 'hi');
});
