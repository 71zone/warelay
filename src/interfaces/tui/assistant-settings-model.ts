import type { AssistantSettings, ProviderId, ProviderOptions } from '../../core/contracts.js';
import { MAX_RETRIES_BEFORE_FALLBACK, PROVIDERS, providerOptionSpecs, type ProviderOptionSpec } from '../../core/providers.js';

/** One provider on the assistants screen: every registered provider is listed, enabled or not; the enabled ones, in list order, are the priority order. */
export interface SettingsRow { id: ProviderId; enabled: boolean; options: ProviderOptions }
export interface SettingsModel { rows: SettingsRow[]; retries: number }
/** One selectable line: a provider (toggle, reorder), one of its options (cycle) or the retries (step). */
export type SettingsItem =
  | { kind: 'provider'; row: number }
  | { kind: 'option'; row: number; spec: ProviderOptionSpec }
  | { kind: 'retries' };

/** Starts from the saved settings: enabled providers first in their saved order, then the others in registry order. */
export function createSettingsModel(settings: AssistantSettings): SettingsModel {
  const rest = PROVIDERS.map(provider => provider.id).filter(id => !settings.providers.includes(id));
  return {
    retries: settings.retriesBeforeFallback,
    rows: [...settings.providers, ...rest].map(id => ({ id, enabled: settings.providers.includes(id), options: { ...(settings.options[id] ?? {}) } })),
  };
}

/** The lines the cursor can visit, top to bottom; options of a disabled provider are hidden. */
export function settingsItems(model: SettingsModel): SettingsItem[] {
  const items: SettingsItem[] = [];
  model.rows.forEach((row, index) => {
    items.push({ kind: 'provider', row: index });
    if (row.enabled) for (const spec of providerOptionSpecs(row.id)) items.push({ kind: 'option', row: index, spec });
  });
  items.push({ kind: 'retries' });
  return items;
}

/** 1-based position of an enabled provider in the priority order, null for a disabled one. */
export function positionOf(model: SettingsModel, row: number): number | null {
  const target = model.rows[row];
  if (!target?.enabled) return null;
  return model.rows.slice(0, row + 1).filter(item => item.enabled).length;
}

/** Flips a provider on or off. At least one must stay enabled: switching off the last one returns false and changes nothing. */
export function toggleProvider(model: SettingsModel, row: number): boolean {
  const target = model.rows[row];
  if (!target) return false;
  if (target.enabled && model.rows.filter(item => item.enabled).length === 1) return false;
  target.enabled = !target.enabled;
  return true;
}

/** Moves a provider one place up or down the list (not past either end); returns its new index. */
export function moveProvider(model: SettingsModel, row: number, delta: -1 | 1): number {
  const next = row + delta;
  if (next < 0 || next >= model.rows.length) return row;
  const [moved] = model.rows.splice(row, 1);
  if (moved) model.rows.splice(next, 0, moved);
  return next;
}

export function stepRetries(model: SettingsModel, delta: -1 | 1): void {
  model.retries = Math.max(0, Math.min(MAX_RETRIES_BEFORE_FALLBACK, model.retries + delta));
}

/** The value an option shows: the saved one, else the declared default. */
export function optionValue(row: SettingsRow, spec: ProviderOptionSpec): string { return row.options[spec.key] ?? spec.default; }

/** The values an option cycles through: the declared choices plus a saved value that is not among them. */
export function optionChoices(row: SettingsRow, spec: ProviderOptionSpec): string[] {
  const current = optionValue(row, spec);
  return spec.choices.includes(current) ? [...spec.choices] : [current, ...spec.choices];
}

/** Moves an option to the next or previous choice, wrapping around. */
export function cycleOption(model: SettingsModel, row: number, spec: ProviderOptionSpec, delta: -1 | 1): void {
  const target = model.rows[row];
  if (!target) return;
  const choices = optionChoices(target, spec);
  const next = choices[(choices.indexOf(optionValue(target, spec)) + delta + choices.length) % choices.length] ?? spec.default;
  target.options = { ...target.options, [spec.key]: next };
}

/** The settings to save: enabled providers in list order, and the options of those only (defaults are not stored). */
export function toSettings(model: SettingsModel): AssistantSettings {
  const options: AssistantSettings['options'] = {};
  for (const row of model.rows) {
    if (!row.enabled) continue;
    const kept = Object.fromEntries(Object.entries(row.options).filter(([key, value]) => value !== providerOptionSpecs(row.id).find(spec => spec.key === key)?.default));
    if (Object.keys(kept).length > 0) options[row.id] = kept;
  }
  return { providers: model.rows.filter(row => row.enabled).map(row => row.id), retriesBeforeFallback: model.retries, options };
}
