import type { ProviderId } from './contracts.js';

/** One user-editable option of a provider (for example which signed-in account to use). Values are free text the adapter interprets. */
export interface ProviderOptionSpec {
  key: string;
  label: string;
  /** Value used while the option is unset. */
  default: string;
  /** Regular expression source a saved value must match entirely; the settings prompt and the store both reject anything else. */
  pattern: string;
  /** Shown beside the prompt when the value is rejected. */
  hint: string;
  /** The values the settings screen cycles through (a saved value outside the list is kept and shown too). */
  choices: readonly string[];
}
/** A provider the app knows how to drive. Adding one means one entry here and one adapter wired in bootstrap.ts. `options` declares what the settings prompt may ask for. */
export interface ProviderInfo { id: ProviderId; name: string; origin: string; options?: readonly ProviderOptionSpec[] }

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'chatgpt', name: 'ChatGPT', origin: 'https://chatgpt.com' },
  { id: 'claude', name: 'Claude', origin: 'https://claude.ai' },
  {
    id: 'gemini', name: 'Gemini', origin: 'https://gemini.google.com',
    options: [{ key: 'account', label: 'Google account index in gemini.google.com/u/<N>/ (0 = the first signed-in account)', default: '0', pattern: '\\d{1,2}', choices: ['0', '1', '2', '3'], hint: 'Enter the account number: 0, 1, 2 ...' }],
  },
];

/** The saved value of a provider option, or its default. */
export function providerOption(options: Record<string, string> | undefined, id: ProviderId, key: string): string {
  return options?.[key] ?? providerOptionSpecs(id).find(spec => spec.key === key)?.default ?? '';
}
/** The provider every contact used before providers were configurable; saved references without a provider belong to it. */
export const LEGACY_PROVIDER: ProviderId = 'chatgpt';
/** How long a provider that failed without naming a reset time stays out of rotation. */
export const DEFAULT_COOLDOWN_MS = 30 * 60_000;
export const DEFAULT_RETRIES_BEFORE_FALLBACK = 2;
export const MAX_RETRIES_BEFORE_FALLBACK = 10;

export function providerOptionSpecs(id: ProviderId): readonly ProviderOptionSpec[] { return PROVIDERS.find(provider => provider.id === id)?.options ?? []; }
export function providerName(id: ProviderId): string { return PROVIDERS.find(provider => provider.id === id)?.name ?? id; }

/** The provider whose site a saved reference points at, or undefined when it matches none (an opaque reference). */
export function providerOfRef(ref: string): ProviderId | undefined {
  try { const { origin } = new URL(ref.trim()); return PROVIDERS.find(provider => provider.origin === origin)?.id; }
  catch { return undefined; }
}

/** Ordered, de-duplicated provider ids from user text such as "chatgpt, claude"; throws a readable error for an unknown or empty list. */
export function parseProviderOrder(input: string): ProviderId[] {
  const names = input.split(/[\s,>→]+/).map(part => part.trim().toLowerCase()).filter(Boolean);
  const ids = names.map(name => {
    const found = PROVIDERS.find(provider => provider.id === name || provider.name.toLowerCase() === name);
    if (!found) throw new Error(`Unknown assistant "${name}". Choose from: ${PROVIDERS.map(provider => provider.id).join(', ')}.`);
    return found.id;
  });
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new Error(`Enter at least one assistant, first = primary, for example ${PROVIDERS.map(provider => provider.id).join(', ')}.`);
  return unique;
}
