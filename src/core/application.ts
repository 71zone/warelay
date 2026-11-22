import { EventEmitter } from 'node:events';
import { Bridge, type ProviderNames } from './bridge.js';
import type { Assistant, AssistantSettings, Contact, IdentityAlias, IncomingMessage, MessagingAdapter, Project, ProviderId, RecentChat } from './contracts.js';
import { providerName, providerOfRef } from './providers.js';
import { SingleFlight } from './single-flight.js';
import { slotOf, type RoutingState, type Route } from './state.js';

export interface ApplicationMetadata extends ProviderNames {
  /** Location of the user's configuration file, shown by frontends. */
  configPath: string;
}

/** One configured assistant, in priority order, with the time it is usable again when a usage limit (or repeated failure) took it out of rotation. */
export interface ProviderView { id: ProviderId; name: string; limitedUntil: number | null }
export interface AssistantView extends AssistantSettings { providerViews: ProviderView[] }

export interface ApplicationSnapshot {
  routes: Route[];
  contacts: Contact[];
  directory: Contact[];
  chats: RecentChat[];
  armed: boolean;
  channelStatus: string;
  assistantStatus: string;
  assistant: AssistantView;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class Application extends EventEmitter<{ change: []; log: [message: string]; qr: [text: string] }> {
  private readonly bridge: Bridge;
  private channelAttempt: Promise<void> | null = null;
  private assistantAttempt: Promise<void> | null = null;
  private resumeAttempt: Promise<void> | null = null;
  private readonly catalogs = new Map<ProviderId, SingleFlight<Project[]>>();
  private closing: Promise<void> | null = null;
  private closed = false;
  private generation = 0;
  private healTimer: NodeJS.Timeout | undefined;
  private channelStatus = 'disconnected';
  private assistantStatus = 'disconnected';

  constructor(readonly metadata: ApplicationMetadata, private readonly store: RoutingState, private readonly channel: MessagingAdapter, private readonly assistant: Assistant) {
    super();
    this.bridge = new Bridge(store, assistant, channel, text => this.log(text), metadata);
  }
  log(text: string): void { this.emit('log', text); this.emit('change'); }
  /** Display name of the assistant(s) in use: the configured providers in priority order. */
  assistantName(): string { return this.store.settings().providers.map(providerName).join(' / '); }
  /** The project a route has on `provider` (the primary by default). */
  projectRef(route: Route | undefined, provider: ProviderId = this.primaryProvider()): string | null { return route ? slotOf(route, provider).projectRef : null; }
  /** The provider new contacts and project picks use: the first configured. */
  primaryProvider(): ProviderId { return this.store.settings().providers[0] ?? ''; }
  receive(incoming: IncomingMessage): void { this.bridge.receive(incoming); }
  async linkIdentity(alias: IdentityAlias): Promise<void> {
    await this.store.linkIdentity(alias);
    this.emit('change');
  }
  setChannelStatus(status: string): void {
    this.channelStatus = status;
    if (status.startsWith('failed:') || status === 'logged-out') this.bridge.disarm();
    this.log(`${this.metadata.channelName}: ${status}`);
  }
  snapshot(): ApplicationSnapshot {
    const routes = this.store.routes();
    const contacts = this.channel.contacts();
    const chats = this.channel.chats();
    const directory = new Map<string, Contact>();
    for (const route of routes) directory.set(route.contactId, { id: route.contactId, name: route.name });
    for (const chat of chats) directory.set(chat.id, { id: chat.id, name: chat.name });
    for (const contact of contacts) directory.set(contact.id, contact);
    return {
      routes, contacts, directory: [...directory.values()].sort((a, b) => a.name.localeCompare(b.name)),
      chats, armed: this.bridge.isArmed(),
      channelStatus: this.channelStatus, assistantStatus: this.assistantStatus,
      assistant: this.assistantView(),
    };
  }
  private assistantView(): AssistantView {
    const settings = this.store.settings();
    return { ...settings, providerViews: settings.providers.map(id => ({ id, name: providerName(id), limitedUntil: this.store.limitedUntil(id) })) };
  }
  /** Chooses the assistants and their order (first = primary) and how often a send that did not leave is retried before the next assistant takes over. */
  async setAssistantSettings(settings: AssistantSettings): Promise<void> {
    await this.store.setSettings(settings);
    this.log(`Assistants: ${this.assistantName()}; ${settings.retriesBeforeFallback} retr${settings.retriesBeforeFallback === 1 ? 'y' : 'ies'} before falling back. Contacts keep their saved conversation on each one.`);
  }
  /**
   * Self-healing watchdog. Forwarding the user asked for (the saved running flag) must not stay off because a dependency blipped: whenever it is
   * disarmed, whether BrowserOS was unreachable at launch, the channel failed, or an unexpected error stopped the bridge, it resumes on its own
   * with backoff from 15s to 5min. Only a logged-out channel is left alone, since it needs a human to scan a QR code. Explicit pause() clears the flag.
   */
  private watch(failures = 0): void {
    if (this.closed) return;
    const delay = Math.min(15_000 * 2 ** failures, 300_000);
    this.healTimer = setTimeout(() => void this.heal(failures), delay);
    this.healTimer.unref();
  }
  private async heal(failures: number): Promise<void> {
    this.healTimer = undefined;
    if (this.closed) return;
    const needed = this.store.isRunning() && !this.bridge.isArmed() && !this.resumeAttempt && this.channelStatus !== 'logged-out' && this.store.routes().some(route => route.enabled);
    if (!needed) return this.watch(0);
    this.log('Forwarding is enabled but stopped. Repairing the connections and resuming on its own.');
    try { await this.resume(); this.watch(0); }
    catch (error) { this.log(`Repair attempt failed: ${message(error)} Trying again automatically.`); this.watch(failures + 1); }
  }
  async restore(): Promise<void> {
    this.watch();
    if (this.store.isRunning() && this.store.routes().some(route => route.enabled)) {
      this.log(`Restoring saved forwarding sessions and their ${this.assistantName()} conversations.`);
      await this.resume();
    } else {
      if (this.channel.hasSavedSession()) this.login();
      this.log('Saved contacts and sessions loaded. Enable a contact to start forwarding.');
    }
  }
  login(): void {
    if (this.closed) return;
    const { channelName } = this.metadata;
    if (this.channelAttempt || this.channelStatus === 'open') {
      this.log(`${channelName} is already ${this.channelStatus === 'open' ? 'connected using your saved login' : 'connecting'}.`);
      return;
    }
    this.channelStatus = 'connecting';
    this.emit('change');
    this.channelAttempt = this.channel.start().catch(error => {
      this.channelStatus = 'failed';
      this.bridge.disarm();
      this.log(`${channelName} connection failed: ${message(error)}`);
    }).finally(() => { this.channelAttempt = null; this.emit('change'); });
  }
  async checkBrowser(): Promise<void> {
    if (this.assistantAttempt) return this.assistantAttempt;
    this.assistantStatus = 'connecting'; this.emit('change');
    this.assistantAttempt = this.assistant.start().then(() => {
      this.assistantStatus = 'connected';
    }).catch(error => { this.assistantStatus = 'failed'; throw error; }).finally(() => {
      this.assistantAttempt = null; this.emit('change');
    });
    return this.assistantAttempt;
  }
  async resume(): Promise<void> {
    if (this.closed) return;
    if (this.resumeAttempt) return this.resumeAttempt;
    if (!this.store.routes().some(route => route.enabled)) throw new Error('Enable a contact for forwarding first.');
    const generation = ++this.generation;
    this.resumeAttempt = (async () => {
      await this.checkBrowser();
      if (this.closed || generation !== this.generation) return;
      await this.store.setRunning(true);
      if (this.closed || generation !== this.generation) return;
      this.login(); this.bridge.arm(); this.log('Forwarding active for enabled sessions.');
    })().finally(() => { this.resumeAttempt = null; this.emit('change'); });
    return this.resumeAttempt;
  }
  async pause(): Promise<void> {
    this.generation++; this.bridge.disarm();
    await this.store.setRunning(false);
    this.log(`All forwarding paused. Saved contacts and ${this.assistantName()} conversation references are unchanged.`);
  }
  async toggle(contact: Contact): Promise<void> {
    await this.setContactEnabled(contact, !this.store.route(contact.id)?.enabled);
  }
  /** Idempotent desired state: repeating a request that already holds changes nothing and does not resume forwarding. */
  async setContactEnabled(contact: Contact, enabled: boolean): Promise<void> {
    const route = this.store.route(contact.id);
    if (enabled) {
      if (route?.enabled) { this.log(`${route.name} is already enabled.`); return; }
      await this.store.enable(contact);
      this.log(`Enabled ${contact.name}. Incoming text will be shared with ${this.assistantName()} and its reply sent back automatically.`);
      await this.resume();
    } else {
      if (!route?.enabled) { this.log(`${contact.name} is already paused.`); return; }
      await this.store.pause(contact.id);
      this.log(`Paused ${route.name}. The ${this.assistantName()} conversation is retained.`);
    }
    this.emit('change');
  }
  /**
   * Resolves a direct contact through the messaging adapter without changing any saved state. The display name keeps the directory
   * priority: channel contacts, then recent chats, then the saved route's name, and only then the resolver's own fallback.
   */
  resolveContact(input: string): Contact {
    const resolved = this.channel.resolveContact(input);
    const id = this.store.canonicalId(resolved.id);
    const known = (list: Contact[]): Contact | undefined => list.find(item => item.id === id || item.id === resolved.id);
    const name = known(this.channel.contacts())?.name ?? known(this.channel.chats())?.name ?? this.store.route(id)?.name ?? resolved.name;
    return { id, name };
  }
  /** Resolves a direct contact, then enables it unless it already is. */
  async addContact(input: string): Promise<Contact> {
    const contact = this.resolveContact(input);
    await this.setContactEnabled(contact, true);
    return contact;
  }
  /**
   * Project picker catalog of one provider (the primary by default). Single-flight per provider; the adapter owns an independent connection, so this never touches the delivery assistant session or the channel.
   * Cancellation is explicit: the shared read has its own controller. A caller's `signal` rejects that caller when it aborts; the read itself is cancelled only
   * once every signalled caller has left (callers without a signal keep it alive) or when the application closes. Cancelling the last interested caller
   * resolves only after the adapter has drained its cleanup.
   */
  listProjects(provider: ProviderId = this.primaryProvider(), signal?: AbortSignal): Promise<Project[]> {
    if (this.closed) return Promise.reject(new Error('wabgpt is closing.'));
    let catalog = this.catalogs.get(provider);
    if (!catalog) this.catalogs.set(provider, catalog = new SingleFlight<Project[]>());
    return catalog.join(async shared => (await this.assistant.listProjects(provider, shared)).map(project => ({ ...project })), signal);
  }
  /** Assigns or clears a project on one provider: the one the reference points at, else `provider`, else the primary. */
  async setProject(contact: Contact, ref: string | null, provider?: ProviderId): Promise<void> {
    const target = provider ?? (ref === null ? undefined : providerOfRef(ref)) ?? this.primaryProvider();
    const assistantName = providerName(target);
    const before = slotOf(this.store.route(contact.id) ?? { refs: {} }, target).projectRef;
    await this.store.setProject(contact, target, ref);
    const route = this.store.route(contact.id);
    const now = route ? slotOf(route, target).projectRef : null;
    const state = route?.enabled ? 'It stays enabled' : 'It stays paused';
    if (now === before) this.log(`${contact.name} already has ${before === null ? `no ${assistantName} project` : `that ${assistantName} project`}; nothing changed. ${state}.`);
    else if (now === null) this.log(`Cleared the ${assistantName} project for ${contact.name}; its saved conversation link was dropped and its next message starts a new conversation. ${state}.`);
    else this.log(`Assigned a ${assistantName} project to ${contact.name}; any earlier conversation link was dropped and its next message starts a new conversation there. ${state}. Use a project with project-only memory.`);
  }
  async setConversationTtl(contact: Contact, minutes: number | null): Promise<void> {
    await this.store.setConversationTtl(contact, minutes);
    const assistantName = this.assistantName();
    this.log(minutes === null ? `${contact.name}'s ${assistantName} conversation will never expire.` : `${contact.name}'s ${assistantName} conversation now expires ${minutes} minute${minutes === 1 ? '' : 's'} after it started, checked at its next message.`);
  }
  /** Single-flight: concurrent callers wait for the same shutdown. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true; this.generation++; this.bridge.disarm();
      clearTimeout(this.healTimer);
      for (const catalog of this.catalogs.values()) catalog.cancel(new Error('wabgpt is closing.'));
      await this.resumeAttempt?.catch(() => undefined);
      await this.assistantAttempt?.catch(() => undefined);
      await Promise.all([...this.catalogs.values()].map(catalog => catalog.drained()));
      await this.bridge.idle();
      await Promise.allSettled([this.channel.stop(), this.assistant.stop()]);
    })();
    return this.closing;
  }
}
