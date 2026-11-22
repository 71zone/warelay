import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/core/bridge.js';
import { AllProvidersLimitedError, NotSentError, UsageLimitError, type AssistantAdapter, type AssistantReferencePolicy, type IncomingMessage, type ProviderRefs, type Turn } from '../src/core/contracts.js';
import { createFallbackAssistant } from '../src/core/fallback.js';
import { HANDOFF_MAX_CHARS, handoffPrompt } from '../src/core/handoff.js';
import { slotOf, type RoutingState } from '../src/core/state.js';
import { chatgptReferences } from '../src/adapters/chatgpt/references.js';
import { fakeAdapter, fakeChannel, loadState, providerNames, withDirectory } from './support/core-fixtures.js';

const claudeReferences: AssistantReferencePolicy = {
  normalizeProject: ref => ref,
  normalizeConversation: ref => { if (!/^https:\/\/claude\.ai\/chat\/[\w-]+$/.test(ref)) throw new Error('Not a Claude chat.'); return ref; },
};
const references = { chatgpt: chatgptReferences, claude: claudeReferences };
const alice = { id: '11111111111@s.whatsapp.net', name: 'Alice' };
const minute = 60_000;
const incoming = (id: string, text = `Question ${id}`): IncomingMessage => ({ id, contact: alice, text, attachments: [], acknowledge: async () => {} });

interface Call { provider: string; text: string; conversationRef: string | null }
/** A provider that answers `Answer <n> from <id>`; `script` may throw before or after acceptance. */
function provider(id: string, calls: Call[], script: (call: Call, accepted: () => Promise<void>) => Promise<void> = async () => {}): AssistantAdapter {
  let chats = 0;
  return fakeAdapter({
    id, references: references[id as 'chatgpt'],
    reply: async input => {
      const call = { provider: id, text: input.text, conversationRef: input.conversationRef };
      calls.push(call);
      await script(call, async () => { await input.onSubmitted(); });
      const ref = input.conversationRef ?? (id === 'chatgpt' ? `https://chatgpt.com/c/c${++chats}` : `https://claude.ai/chat/k${++chats}`);
      await input.onConversation(ref); await input.onSubmitted();
      return { conversationRef: ref, text: `Answer from ${id}` };
    },
  });
}

async function fixture(run: (store: RoutingState, time: { now: number }) => Promise<void>): Promise<void> {
  const time = { now: 1_000 * minute };
  await withDirectory(async directory => {
    const store = await loadState(directory, () => time.now, references);
    await store.enable(alice);
    await store.setSettings({ providers: ['chatgpt', 'claude'], retriesBeforeFallback: 1, options: {} });
    await run(store, time);
  }, 'warelay-fallback-');
}
const routerOf = (store: RoutingState, adapters: AssistantAdapter[], time: { now: number }, logs: string[] = []) =>
  createFallbackAssistant({ adapters, port: store, logger: text => logs.push(text), now: () => time.now, pause: async () => {} });
const refsOf = (store: RoutingState): Record<string, ProviderRefs> => store.route(alice.id)!.refs;
const send = (store: RoutingState, assistant: ReturnType<typeof routerOf>, text: string, history: Turn[] = []) => assistant.reply({
  refs: refsOf(store), history, text, attachments: [], onProvider: () => {}, onSubmitted: async () => {},
  onConversation: (provider, ref) => store.conversation(alice.id, provider, ref),
});

test('a usage limit before acceptance moves the same message to the next provider until the reset time, then the first is used again', async () => {
  await fixture(async (store, time) => {
    const calls: Call[] = [];
    const resetAt = time.now + 90 * minute;
    let limited = true;
    const assistant = routerOf(store, [provider('chatgpt', calls, async () => { if (limited) throw new UsageLimitError('chatgpt', resetAt, 'limit'); }), provider('claude', calls)], time);
    assert.equal((await send(store, assistant, 'hello')).provider, 'claude');
    assert.deepEqual(calls.map(call => [call.provider, call.text]), [['chatgpt', 'hello'], ['claude', 'hello']]);
    assert.equal(store.limitedUntil('chatgpt'), resetAt);
    assert.equal((await send(store, assistant, 'again')).provider, 'claude');
    assert.equal(calls.length, 3, 'the limited provider is not tried again before its reset');
    limited = false; time.now = resetAt + 1;
    assert.equal((await send(store, assistant, 'later')).provider, 'chatgpt');
  });
});

test('a limit hit after the prompt was accepted fails that reply but sends later messages to the next provider; the prompt is never resent', async () => {
  await fixture(async (store, time) => {
    const calls: Call[] = [];
    const assistant = routerOf(store, [provider('chatgpt', calls, async (_call, accepted) => { await accepted(); throw new UsageLimitError('chatgpt', null, 'limit mid-reply'); }), provider('claude', calls)], time);
    await assert.rejects(send(store, assistant, 'one'), UsageLimitError);
    assert.deepEqual(calls.map(call => call.provider), ['chatgpt']);
    assert.equal(store.limitedUntil('chatgpt'), time.now + 30 * minute, 'no reset shown: the default cooldown applies');
    assert.equal((await send(store, assistant, 'two')).provider, 'claude');
  });
});

test('a send that provably did not leave is retried, then the next provider takes over; the last provider is never abandoned', async () => {
  await fixture(async (store, time) => {
    const calls: Call[] = [];
    const down = (id: string) => provider(id, calls, async () => { throw new NotSentError('composer missing'); });
    const assistant = routerOf(store, [down('chatgpt'), provider('claude', calls)], time);
    assert.equal((await send(store, assistant, 'hi')).provider, 'claude');
    assert.deepEqual(calls.map(call => call.provider), ['chatgpt', 'chatgpt', 'claude'], 'one retry configured');
    const alone = routerOf(store, [down('chatgpt'), down('claude')], { now: time.now + 31 * minute });
    await assert.rejects(send(store, alone, 'hi'), NotSentError);
  });
});

test('when every provider is limited the error names the soonest reset and the bridge tells the contact without pausing it', async () => {
  await fixture(async (store, time) => {
    const calls: Call[] = [];
    const limit = (id: string, at: number) => provider(id, calls, async () => { throw new UsageLimitError(id, at, 'limit'); });
    const assistant = routerOf(store, [limit('chatgpt', time.now + 60 * minute), limit('claude', time.now + 20 * minute)], time);
    const error = await send(store, assistant, 'hi').catch((reason: unknown) => reason);
    assert.ok(error instanceof AllProvidersLimitedError);
    assert.equal(error.resetAt, time.now + 20 * minute);
    assert.match(error.message, /ChatGPT and Claude have reached their usage limits/);
    const sent: string[] = [];
    const bridge = new Bridge(store, assistant, fakeChannel({ sendText: async (_id, text) => { sent.push(text); } }), () => {}, providerNames);
    bridge.arm(); bridge.receive(incoming('m1')); await bridge.idle();
    assert.equal(calls.length, 2, 'the bridge did not ask a limited provider again');
    assert.deepEqual(sent, [error.message]);
    assert.equal(store.route(alice.id)?.enabled, true);
  });
});

test('switching providers hands the recent turns over once, and back again with only the turns the first one has not seen', async () => {
  await fixture(async (store, time) => {
    const calls: Call[] = [];
    let chatgptLimited = false;
    const assistant = routerOf(store, [provider('chatgpt', calls, async () => { if (chatgptLimited) throw new UsageLimitError('chatgpt', time.now + 10 * minute, 'limit'); }), provider('claude', calls)], time);
    const bridge = new Bridge(store, assistant, fakeChannel(), () => {}, providerNames);
    bridge.arm();
    bridge.receive(incoming('1', 'First')); await bridge.idle();
    chatgptLimited = true;
    bridge.receive(incoming('2', 'Second')); await bridge.idle();
    assert.equal(calls[1]?.text, 'Second');
    assert.match(calls[2]?.text ?? '', /^Earlier conversation, continue from it[^\n]*\nUser: First\nAssistant: Answer from chatgpt\n\nNew message from the user:\nSecond$/);
    assert.equal(calls[2]?.conversationRef, null, 'Claude starts its own conversation');
    assert.ok(slotOf(store.route(alice.id)!, 'claude').conversationRef?.startsWith('https://claude.ai/chat/'));
    bridge.receive(incoming('3', 'Third')); await bridge.idle();
    assert.equal(calls[3]?.text, 'Third', 'Claude continues its own chat without a transcript');
    chatgptLimited = false; time.now += 11 * minute;
    bridge.receive(incoming('4', 'Fourth')); await bridge.idle();
    const back = calls.at(-1)!;
    assert.equal(back.provider, 'chatgpt');
    assert.ok(back.conversationRef, 'continues its saved conversation');
    assert.match(back.text, /User: Second\nAssistant: Answer from claude\nUser: Third\nAssistant: Answer from claude\n\nNew message from the user:\nFourth$/);
    assert.doesNotMatch(back.text, /First/, 'what ChatGPT already saw is not repeated');
  });
});

test('handoff is bounded, fresh, and absent when no conversation is under way', () => {
  const turn = (at: number, role: Turn['role'], text: string, provider = 'chatgpt'): Turn => ({ role, provider, text, at });
  const now = 10_000_000_000;
  const base = { provider: 'claude', continuing: false, conversations: true, text: 'next', now };
  assert.equal(handoffPrompt({ ...base, history: [turn(now - 1, 'user', 'hi')], conversations: false }), 'next');
  assert.equal(handoffPrompt({ ...base, history: [turn(now - 25 * 60 * minute, 'user', 'old')] }), 'next');
  const many = Array.from({ length: 12 }, (_, index) => turn(now - 100 + index, 'user', `m${index}`));
  const prompt = handoffPrompt({ ...base, history: many });
  assert.ok(!prompt.includes('m3\n') && prompt.includes('m4') && prompt.includes('m11'), 'only the last eight turns');
  const long = handoffPrompt({ ...base, history: [turn(now - 2, 'user', 'x'.repeat(HANDOFF_MAX_CHARS * 2)), turn(now - 1, 'assistant', 'y'.repeat(HANDOFF_MAX_CHARS * 2))] });
  assert.ok(long.length < HANDOFF_MAX_CHARS + 300);
});

test('settings validate providers, retries and per-provider options', async () => {
  await fixture(async store => {
    await assert.rejects(store.setSettings({ providers: [], retriesBeforeFallback: 1, options: {} }), /at least one/);
    await assert.rejects(store.setSettings({ providers: ['bard'], retriesBeforeFallback: 1, options: {} }), /Unknown assistant/);
    await assert.rejects(store.setSettings({ providers: ['claude'], retriesBeforeFallback: 99, options: {} }), /Retries/);
    await assert.rejects(store.setSettings({ providers: ['claude'], retriesBeforeFallback: 1, options: { claude: { account: '1' } } }), /no option "account"/);
    await store.setSettings({ providers: ['claude', 'chatgpt'], retriesBeforeFallback: 0, options: { claude: {} } });
    assert.deepEqual(store.settings(), { providers: ['claude', 'chatgpt'], retriesBeforeFallback: 0, options: {} });
  });
});
