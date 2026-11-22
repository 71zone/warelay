import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeReferences, destinationPathPattern, isConversationPage, isDestination, normalizeConversationUrl, normalizeProjectUrl } from '../src/adapters/claude/references.js';

const id = '9172d8d3-38bc-4ebb-ac0b-4cbf03705a69';
const project = `https://claude.ai/project/${id}`;
const chat = `https://claude.ai/chat/${id}`;

test('project and conversation URLs canonicalize to the bare uuid path', () => {
  for (const value of [project, `${project}/`, `${project}?x=1#y`, ` ${project} `, `https://claude.ai/project/${id.toUpperCase()}`]) assert.equal(normalizeProjectUrl(value), project, value);
  for (const value of [chat, `${chat}/`, `${chat}?x=1#y`, `https://claude.ai/chat/${id.toUpperCase()}`]) assert.equal(normalizeConversationUrl(value, null), chat, value);
});

test('other hosts, schemes, credentials, ports and paths are rejected', () => {
  for (const value of [
    '', 'not a url', `/project/${id}`, `http://claude.ai/project/${id}`, `https://claude.ai.evil.example/project/${id}`, `https://www.claude.ai/project/${id}`,
    `https://user@claude.ai/project/${id}`, `https://claude.ai:444/project/${id}`, 'https://claude.ai/', 'https://claude.ai/new', 'https://claude.ai/project/abc', `https://claude.ai/project/${id}0`,
    `https://claude.ai/project/${id}/chat`, `https://claude.ai/chat/${id}`, `https://claude.ai/project/${id}\n/x`,
  ]) assert.throws(() => normalizeProjectUrl(value), Error, JSON.stringify(value));
  for (const value of ['', `https://claude.ai/chat/abc`, project, 'https://claude.ai/new', `https://chatgpt.com/c/${id}`, `https://claude.ai/chat/${id}/x`]) assert.throws(() => normalizeConversationUrl(value, null), Error, JSON.stringify(value));
});

test('a chat inside a project is the same /chat/<uuid> URL; only a malformed project is rejected', () => {
  assert.equal(normalizeConversationUrl(chat, project), chat);
  assert.throws(() => normalizeConversationUrl(chat, 'https://claude.ai/project/nope'), Error);
  assert.equal(claudeReferences.normalizeConversation(chat, null), chat);
  assert.equal(claudeReferences.normalizeProject(project), project);
});

test('destinations are the saved chat, the project page, or the new-chat page', () => {
  assert.equal(destinationPathPattern({ conversationUrl: chat, projectUrl: null }), `^/chat/${id}/?$`);
  assert.equal(destinationPathPattern({ conversationUrl: null, projectUrl: project }), `^/project/${id}/?$`);
  assert.equal(destinationPathPattern({ conversationUrl: null, projectUrl: null }), '^/new/?$');
  assert.ok(isDestination(chat, { conversationUrl: chat, projectUrl: null }));
  assert.ok(isDestination(`${chat}?x=1`, { conversationUrl: chat, projectUrl: project }));
  assert.ok(isDestination(project, { conversationUrl: null, projectUrl: project }));
  assert.ok(isDestination('https://claude.ai/new', { conversationUrl: null, projectUrl: null }));
  assert.ok(!isDestination('https://claude.ai/new', { conversationUrl: null, projectUrl: project }));
  assert.ok(!isDestination(project, { conversationUrl: null, projectUrl: null }));
  assert.ok(!isDestination(`https://claude.ai/chat/${id.replace('9', '8')}`, { conversationUrl: chat, projectUrl: null }));
  assert.ok(!isDestination(`https://evil.example/chat/${id}`, { conversationUrl: chat, projectUrl: null }));
  assert.ok(isConversationPage(chat) && !isConversationPage(project) && !isConversationPage('https://claude.ai/new') && !isConversationPage('nope'));
});
