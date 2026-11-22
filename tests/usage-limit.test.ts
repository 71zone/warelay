import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUsageLimitText, parseResetAt } from '../src/core/usage-limit.js';
import { parseProviderOrder } from '../src/core/providers.js';

// Tuesday 2026-11-17 14:20 local time.
const now = new Date(2026, 10, 17, 14, 20).getTime();
const at = (month: number, day: number, hour: number, minute = 0): number => new Date(2026, month, day, hour, minute).getTime();

test('reads relative reset times', () => {
  assert.equal(parseResetAt("You've hit the usage limit. Try again in 2 hours.", now), now + 2 * 3_600_000);
  assert.equal(parseResetAt('Your limit resets in 1 hour 30 minutes', now), now + 90 * 60_000);
  assert.equal(parseResetAt('Try again in 3 days 4 hours', now), now + (3 * 24 + 4) * 3_600_000);
  assert.equal(parseResetAt('Limit reached. Resets in 45 mins', now), now + 45 * 60_000);
});

test('reads clock times: later today, otherwise tomorrow', () => {
  assert.equal(parseResetAt("You've reached the current usage cap for GPT-5. Try again after 3:45 PM.", now), at(10, 17, 15, 45));
  assert.equal(parseResetAt('Your limit will reset at 3pm (America/New_York)', now), at(10, 17, 15));
  assert.equal(parseResetAt('You are out of free messages until 11:00 AM', now), at(10, 18, 11));
  assert.equal(parseResetAt('5-hour limit reached ∙ resets 2am', now), at(10, 18, 2));
  assert.equal(parseResetAt('Usage limit reached. Try again after 18:05', now), at(10, 17, 18, 5));
  assert.equal(parseResetAt('Resets at 12:30 AM', now), at(10, 18, 0, 30));
});

test('reads weekdays and dates', () => {
  assert.equal(parseResetAt('Weekly limit reached · resets Fri 9:00 AM', now), at(10, 20, 9));
  assert.equal(parseResetAt('Your limit resets on Nov 28 at 10am', now), at(10, 28, 10));
  assert.equal(parseResetAt('Try again after January 3, 3:00 PM', now), new Date(2027, 0, 3, 15).getTime());
});

test('returns null when no reset time is shown', () => {
  assert.equal(parseResetAt("You've reached your usage limit.", now), null);
  assert.equal(parseResetAt('You have used 12 of 40 messages. Upgrade to continue.', now), null);
});

test('recognises limit notices and not ordinary replies', () => {
  for (const text of ["You've reached the current usage cap for GPT-5", "You've hit the usage limit.", 'Claude usage limit reached', '5-hour limit reached ∙ resets 3pm',
    'You are out of free messages until 3 PM', "You've reached your Free plan limit for GPT-5. Try again after 11:05 AM", 'Your limit will reset at 3 PM']) assert.ok(isUsageLimitText(text), text);
  for (const text of ['Here is a table of rate limiting strategies', 'The speed limit is 50', 'Sure, try again with a smaller file']) assert.ok(!isUsageLimitText(text), text);
});

test('provider order input', () => {
  assert.deepEqual(parseProviderOrder('claude, chatgpt'), ['claude', 'chatgpt']);
  assert.deepEqual(parseProviderOrder('ChatGPT'), ['chatgpt']);
  assert.deepEqual(parseProviderOrder('chatgpt claude chatgpt'), ['chatgpt', 'claude']);
  assert.throws(() => parseProviderOrder('bard'), /Unknown assistant/);
  assert.throws(() => parseProviderOrder(' '), /at least one/);
});
