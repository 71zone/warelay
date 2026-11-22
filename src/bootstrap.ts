import { join } from 'node:path';
import { createChatGPT } from './adapters/chatgpt/chatgpt.js';
import { createClaude } from './adapters/claude/claude.js';
import { createGemini } from './adapters/gemini/gemini.js';
import { createJsonStatePersistence } from './adapters/storage/json-state.js';
import { createWhatsApp } from './adapters/whatsapp/whatsapp.js';
import { Application } from './core/application.js';
import { createFallbackAssistant } from './core/fallback.js';
import { RoutingState } from './core/state.js';
import type { LoadedConfig } from './infrastructure/config.js';
import { routeConsoleOutput } from './infrastructure/console-output.js';
import { acquireLock } from './infrastructure/lock.js';
import { createMediaStore } from './infrastructure/media.js';

export interface Runtime { application: Application; close(): Promise<void> }

/**
 * The only place concrete providers are wired together. Returns an unstarted
 * Application: nothing connects or sends until the caller restores or logs in.
 */
export async function createApplication(config: LoadedConfig, options: { notBeforeSeconds?: number } = {}): Promise<Application> {
  let application: Application | undefined;
  const logger = (message: string): void => { application?.log(message); };
  const media = createMediaStore(join(config.dataDir, 'media'));
  // Provider options (for example Gemini's account) live in the routing state, which is loaded after the adapters exist: they read it lazily.
  let routing: RoutingState | undefined;
  const optionsOf = (provider: string) => (): Record<string, string> => routing?.settings().options[provider] ?? {};
  const endpoint = config.browserMcpUrl;
  const adapters = [createChatGPT({ endpoint, logger, media }), createClaude({ endpoint, logger, media }), createGemini({ endpoint, logger, media, options: optionsOf('gemini') })];
  const store = routing = await RoutingState.load(createJsonStatePersistence(config.dataDir), Object.fromEntries(adapters.map(adapter => [adapter.id, adapter.references])));
  const assistant = createFallbackAssistant({ adapters, port: store, logger });
  const channel = createWhatsApp({
    authDir: join(config.dataDir, 'whatsapp'), logger, media,
    onMessage: message => application?.receive(message),
    onStatus: status => application?.setChannelStatus(status),
    onUpdate: () => application?.emit('change'),
    onIdentity: alias => { void application?.linkIdentity(alias).catch(error => logger(error instanceof Error ? error.message : String(error))); },
    onQr: payload => application?.emit('qr', payload),
    notBeforeSeconds: options.notBeforeSeconds,
  });
  for (const alias of channel.identities()) await store.linkIdentity(alias);
  application = new Application({ configPath: config.path, channelName: 'WhatsApp' }, store, channel, assistant);
  return application;
}

export interface OpenRuntimeOptions {
  prepare?: (config: LoadedConfig) => Promise<LoadedConfig>;
  /** See WhatsAppOptions.notBeforeSeconds. */
  notBeforeSeconds?: number;
}

/**
 * Takes the data directory's single-writer lock for the runtime's lifetime and routes dependency
 * console output into the application log. An optional `prepare` hook runs after the lock is held and
 * before any provider exists, so first-run setup can choose the browser endpoint without racing another
 * process; it returns the config the Application is built from. If preparation fails or is cancelled the
 * lock is released before the error propagates. close() drains the application, then restores the
 * console and releases the lock; it is safe to call more than once.
 */
export async function openRuntime(config: LoadedConfig, options: OpenRuntimeOptions = {}): Promise<Runtime> {
  process.umask(0o077);
  const release = await acquireLock(config.dataDir);
  let restoreConsole: (() => void) | undefined;
  let application: Application;
  try {
    const prepared = options.prepare ? await options.prepare(config) : config;
    application = await createApplication(prepared, { notBeforeSeconds: options.notBeforeSeconds });
    restoreConsole = routeConsoleOutput(message => application.log(message));
  } catch (error) {
    restoreConsole?.();
    await release();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    application,
    close: () => closing ??= (async () => {
      try { await application.close(); }
      finally { restoreConsole?.(); await release(); }
    })(),
  };
}
