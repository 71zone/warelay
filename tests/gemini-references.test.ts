import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountOf, destinationPathPattern, geminiReferences, isConversationPage, isDestination, misplacedReason, newChatUrl, normalizeConversationUrl } from '../src/adapters/gemini/references.js';

const id = 'e73e4f005037421a';
const chat = `https://gemini.google.com/u/0/app/${id}`;

test('conversation URLs canonicalize to /u/<N>/app/<id> and keep their account', () => {
  for (const value of [chat, `${chat}/`, `${chat}?hl=vi#x`, ` ${chat} `]) assert.equal(normalizeConversationUrl(value, null), chat, value);
  assert.equal(normalizeConversationUrl(`https://gemini.google.com/u/1/app/${id}`, null), `https://gemini.google.com/u/1/app/${id}`);
  assert.equal(normalizeConversationUrl(`https://gemini.google.com/u/01/app/${id}`, null), `https://gemini.google.com/u/1/app/${id}`);
});

test('other hosts, schemes, accounts without an index, new-chat pages and projects are rejected', () => {
  for (const value of [
    '', 'not a url', `/u/0/app/${id}`, `http://gemini.google.com/u/0/app/${id}`, `https://gemini.google.com.evil.example/u/0/app/${id}`, `https://user@gemini.google.com/u/0/app/${id}`,
    `https://gemini.google.com:444/u/0/app/${id}`, `https://gemini.google.com/app/${id}`, 'https://gemini.google.com/u/0/app', 'https://gemini.google.com/u/0/gem/abcdef0123456789', `https://gemini.google.com/u/123/app/${id}`,
    `https://gemini.google.com/u/0/app/${id}/x`, `https://claude.ai/chat/${id}`, `https://gemini.google.com/u/0/app/${id}\n/x`,
  ]) assert.throws(() => normalizeConversationUrl(value, null), Error, JSON.stringify(value));
  assert.throws(() => normalizeConversationUrl(chat, 'https://gemini.google.com/u/0/gem/abc'), /no projects/);
  assert.throws(() => geminiReferences.normalizeProject('https://gemini.google.com/u/0/app'), /no projects/);
});

test('the account of a URL is its /u/<N>/ index, and only a Gemini URL has one', () => {
  assert.equal(accountOf(chat), '0');
  assert.equal(accountOf('https://gemini.google.com/u/12/app'), '12');
  assert.equal(accountOf('https://gemini.google.com/app'), null);
  assert.equal(accountOf('https://accounts.google.com/u/0/app'), null);
  assert.equal(accountOf('nope'), null);
  assert.equal(newChatUrl('0'), 'https://gemini.google.com/u/0/app');
  assert.equal(newChatUrl('03'), 'https://gemini.google.com/u/3/app');
});

test('destinations use the configured account: a saved chat of another account is never the destination', () => {
  assert.equal(destinationPathPattern({ conversationUrl: chat, projectUrl: null }, '0'), `^/u/0/app/${id}/?$`);
  assert.equal(destinationPathPattern({ conversationUrl: null, projectUrl: null }, '1'), '^/u/1/app/?$');
  assert.ok(isDestination(chat, { conversationUrl: chat, projectUrl: null }, '0'));
  assert.ok(isDestination(`${chat}?x=1`, { conversationUrl: chat, projectUrl: null }, '0'));
  assert.ok(isDestination('https://gemini.google.com/u/1/app', { conversationUrl: null, projectUrl: null }, '1'));
  assert.ok(!isDestination('https://gemini.google.com/u/0/app', { conversationUrl: null, projectUrl: null }, '1'));
  assert.ok(!isDestination(chat, { conversationUrl: chat, projectUrl: null }, '1'));
  assert.ok(!isDestination('https://gemini.google.com/u/0/app', { conversationUrl: chat, projectUrl: null }, '0'));
  assert.ok(!isDestination('https://accounts.google.com/u/0/app', { conversationUrl: null, projectUrl: null }, '0'));
  assert.ok(isConversationPage(chat) && isConversationPage(`https://gemini.google.com/u/3/app/${id}`) && !isConversationPage('https://gemini.google.com/u/0/app'));
});

test('a tab on another account or a sign-in page is refused with a readable reason, a tab on the right account has none', () => {
  assert.match(misplacedReason('https://gemini.google.com/u/1/app', '0') ?? '', /opened account \/u\/1 instead of \/u\/0.*No prompt submitted/);
  assert.match(misplacedReason('https://accounts.google.com/v3/signin/identifier', '0') ?? '', /did not open account \/u\/0.*accounts\.google\.com.*No prompt submitted/);
  assert.match(misplacedReason('https://gemini.google.com/app', '0') ?? '', /did not open account \/u\/0/);
  assert.equal(misplacedReason('https://gemini.google.com/u/0/app/abc', '0'), null);
});
