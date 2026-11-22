import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsModel, cycleOption, moveProvider, positionOf, settingsItems, stepRetries, toSettings, toggleProvider } from '../src/interfaces/tui/assistant-settings-model.js';

const saved = { providers: ['chatgpt', 'claude'], retriesBeforeFallback: 2, options: {} };

test('lists every provider, enabled ones first and numbered in priority order', () => {
  const model = createSettingsModel(saved);
  assert.deepEqual(model.rows.map(row => [row.id, row.enabled]), [['chatgpt', true], ['claude', true], ['gemini', false]]);
  assert.deepEqual(model.rows.map((_, index) => positionOf(model, index)), [1, 2, null]);
});

test('toggling and reordering change the saved priority; the last enabled assistant cannot be switched off', () => {
  const model = createSettingsModel(saved);
  assert.equal(moveProvider(model, 0, 1), 1);
  assert.deepEqual(toSettings(model).providers, ['claude', 'chatgpt']);
  assert.equal(moveProvider(model, 0, -1), 0, 'cannot move past the top');
  assert.ok(toggleProvider(model, 2));
  assert.deepEqual(toSettings(model).providers, ['claude', 'chatgpt', 'gemini']);
  assert.ok(toggleProvider(model, 0));
  assert.ok(toggleProvider(model, 1));
  assert.equal(toggleProvider(model, 2), false, 'one must stay enabled');
  assert.deepEqual(toSettings(model).providers, ['gemini']);
});

test('retries step within bounds and options cycle through their choices; defaults are not stored', () => {
  const model = createSettingsModel(saved);
  for (let i = 0; i < 20; i++) stepRetries(model, 1);
  assert.equal(model.retries, 10);
  for (let i = 0; i < 20; i++) stepRetries(model, -1);
  assert.equal(model.retries, 0);
  assert.ok(!settingsItems(model).some(item => item.kind === 'option'), 'a disabled provider shows no options');
  toggleProvider(model, 2);
  const option = settingsItems(model).find(item => item.kind === 'option');
  assert.ok(option?.kind === 'option');
  cycleOption(model, option.row, option.spec, 1);
  assert.deepEqual(toSettings(model).options, { gemini: { account: '1' } });
  cycleOption(model, option.row, option.spec, -1);
  assert.deepEqual(toSettings(model).options, {}, 'back at the default 0');
  cycleOption(model, option.row, option.spec, -1);
  assert.deepEqual(toSettings(model).options, { gemini: { account: '3' } }, 'wraps around');
});

test('a saved option value outside the choices is kept and cycles in', () => {
  const model = createSettingsModel({ providers: ['gemini'], retriesBeforeFallback: 1, options: { gemini: { account: '7' } } });
  const option = settingsItems(model).find(item => item.kind === 'option');
  assert.ok(option?.kind === 'option');
  assert.deepEqual(toSettings(model).options, { gemini: { account: '7' } });
  cycleOption(model, option.row, option.spec, 1);
  assert.deepEqual(toSettings(model).options, {});
});
