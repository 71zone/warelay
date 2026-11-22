import { setTimeout as sleep } from 'node:timers/promises';
import {
  AllProvidersLimitedError, NotSentError, UsageLimitError,
  type Assistant, type AssistantAdapter, type AssistantSettings, type Logger, type ProviderId,
} from './contracts.js';
import { handoffPrompt } from './handoff.js';
import { DEFAULT_COOLDOWN_MS, providerName } from './providers.js';

/** What the router needs from persisted state: provider order, retries and the per-provider limited-until times. */
export interface RouterPort {
  settings(): AssistantSettings;
  limitedUntil(provider: ProviderId): number | null;
  markLimited(provider: ProviderId, until: number): Promise<void>;
}
export interface RouterOptions {
  adapters: readonly AssistantAdapter[];
  port: RouterPort;
  logger: Logger;
  now?: () => number;
  /** Pause between retries of a send that provably did not leave; injectable for tests. */
  pause?: (ms: number) => Promise<void>;
}

const RETRY_PAUSE_MS = 2000;

function clock(time: number): string {
  const date = new Date(time);
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Message for a contact: which assistants are out and when the soonest is back. */
export function allLimitedMessage(names: string[], resetAt: number | null): string {
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${who} ${names.length === 1 ? 'has' : 'have'} reached ${names.length === 1 ? 'its' : 'their'} usage limit${names.length === 1 ? '' : 's'} or cannot answer right now.${resetAt === null ? '' : ` Try again after ${clock(resetAt)}.`}`;
}

/**
 * Tries the configured providers in order for each message. A provider that reports a usage limit, or keeps failing before it accepted the prompt, is taken out of
 * rotation until its reset time (a default cooldown when it names none) and the same message goes to the next one; once the time has passed the first choice is used again.
 * A prompt a provider accepted is never sent anywhere else. Providers other than the first start only when first needed.
 */
export function createFallbackAssistant(options: RouterOptions): Assistant {
  const { port, logger } = options;
  const now = options.now ?? Date.now;
  const pause = options.pause ?? (async (ms: number) => { await sleep(ms); });
  const adapters = new Map(options.adapters.map(adapter => [adapter.id, adapter]));
  const started = new Set<ProviderId>();

  const configured = (): AssistantAdapter[] => port.settings().providers.flatMap(id => adapters.get(id) ?? []);
  const usable = (): AssistantAdapter[] => configured().filter(adapter => port.limitedUntil(adapter.id) === null);
  const adapterOf = (id: ProviderId): AssistantAdapter => {
    const adapter = adapters.get(id);
    if (!adapter) throw new Error(`Unknown assistant "${id}".`);
    return adapter;
  };
  async function launch(adapter: AssistantAdapter): Promise<void> {
    await adapter.start();
    started.add(adapter.id);
  }
  function allLimited(all: AssistantAdapter[]): AllProvidersLimitedError {
    const times = all.map(adapter => port.limitedUntil(adapter.id)).filter((time): time is number => time !== null);
    const soonest = times.length ? Math.min(...times) : null;
    return new AllProvidersLimitedError(allLimitedMessage(all.map(adapter => providerName(adapter.id)), soonest), soonest);
  }

  return {
    async start(): Promise<void> {
      const all = configured();
      const first = usable()[0] ?? all[0];
      if (!first) throw new Error('No assistant is configured.');
      await launch(first);
      for (const adapter of all) {
        if (adapter === first || !started.has(adapter.id)) continue;
        try { await launch(adapter); } catch (error) { logger(`${providerName(adapter.id)} could not be checked: ${error instanceof Error ? error.message : String(error)}`); }
      }
    },
    async stop(): Promise<void> {
      const results = await Promise.allSettled([...adapters.values()].map(adapter => adapter.stop()));
      started.clear();
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
    listProjects: (provider, signal) => adapterOf(provider).listProjects(signal),
    async reply(input) {
      const all = configured();
      const candidates = usable();
      if (candidates.length === 0) throw allLimited(all);
      for (const [index, adapter] of candidates.entries()) {
        const fallbackLeft = index < candidates.length - 1;
        const name = providerName(adapter.id);
        for (let failures = 0; ;) {
          let accepted = false;
          try {
            if (!started.has(adapter.id)) {
              try { await launch(adapter); }
              catch (error) { throw error instanceof NotSentError ? error : new NotSentError(error instanceof Error ? error.message : String(error), { cause: error }); }
            }
            input.onProvider(adapter.id);
            const refs = input.refs[adapter.id] ?? { conversationRef: null, projectRef: null };
            const text = handoffPrompt({
              provider: adapter.id, history: input.history, continuing: refs.conversationRef !== null, now: now(), text: input.text,
              conversations: Object.values(input.refs).some(held => held.conversationRef !== null),
            });
            const result = await adapter.reply({
              conversationRef: refs.conversationRef, projectRef: refs.projectRef, text, attachments: input.attachments,
              onConversation: ref => input.onConversation(adapter.id, ref),
              onSubmitted: async () => { accepted = true; await input.onSubmitted(adapter.id); },
            });
            return { provider: adapter.id, ...result };
          } catch (error) {
            if (error instanceof UsageLimitError) {
              const until = error.resetAt ?? now() + DEFAULT_COOLDOWN_MS;
              await port.markLimited(adapter.id, until);
              logger(`${name} reached its usage limit${error.resetAt === null ? '' : `; it resets at ${clock(until)}`}. ${accepted ? 'This reply is lost; later messages use the next assistant.' : fallbackLeft ? 'Sending the message to the next assistant.' : ''}`.trim());
              if (accepted) throw error;
              if (fallbackLeft) break;
              throw allLimited(all);
            }
            if (!(error instanceof NotSentError) || accepted || !fallbackLeft) throw error;
            if (++failures <= port.settings().retriesBeforeFallback) {
              logger(`${name} is not ready (${error.message}); trying again before switching (${failures} of ${port.settings().retriesBeforeFallback}). Nothing was sent yet.`);
              await pause(RETRY_PAUSE_MS * 2 ** (failures - 1));
              await adapter.start().then(() => { started.add(adapter.id); }, () => undefined);
              continue;
            }
            await port.markLimited(adapter.id, now() + DEFAULT_COOLDOWN_MS);
            logger(`${name} still is not ready (${error.message}); using the next assistant for ${Math.round(DEFAULT_COOLDOWN_MS / 60_000)} minutes. Nothing was sent to ${name}.`);
            break;
          }
        }
      }
      throw allLimited(all);
    },
  };
}
