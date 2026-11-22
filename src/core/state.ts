import { z } from 'zod';
import type { AssistantReferencePolicy, AssistantSettings, Contact, IdentityAlias, ProviderId, Turn } from './contracts.js';
import { DEFAULT_RETRIES_BEFORE_FALLBACK, LEGACY_PROVIDER, MAX_RETRIES_BEFORE_FALLBACK, providerName, providerOptionSpecs } from './providers.js';

export const DEFAULT_CONVERSATION_TTL_MINUTES = 1440;
const CURRENT_VERSION = 3;
/** Recent turns kept per contact for provider handoff, and the longest text kept per turn. */
const MAX_TURNS = 16;
const MAX_TURN_CHARS = 2000;

const ttlSchema = z.number().int().positive().refine(minutes => Number.isSafeInteger(minutes * 60_000), 'Conversation lifetime is out of range.');
const timestampSchema = z.number().int().nonnegative();
const deliveryStatus = z.enum(['working', 'done', 'failed']);

/** What a contact holds on one provider: its saved conversation (with the time it started), and the project new conversations start in. */
const slotSchema = z.object({ conversationRef: z.string().min(1).nullable(), projectRef: z.string().min(1).nullable(), startedAt: timestampSchema.nullable() });
const routeSchema = z.object({
  contactId: z.string().min(1), name: z.string(), enabled: z.boolean(),
  conversationTtlMinutes: ttlSchema.nullable(), error: z.string().nullable(),
  refs: z.record(z.string().min(1), slotSchema),
});
const deliverySchema = z.object({ key: z.string(), contactId: z.string().min(1), status: deliveryStatus });
const aliasesSchema = z.array(z.object({ alias: z.string().min(1), canonical: z.string().min(1) }));
const turnSchema = z.object({ role: z.enum(['user', 'assistant']), provider: z.string().min(1), text: z.string(), at: timestampSchema });
const settingsSchema = z.object({
  providers: z.array(z.string().min(1)).min(1), retriesBeforeFallback: z.number().int().min(0).max(MAX_RETRIES_BEFORE_FALLBACK),
  options: z.record(z.string().min(1), z.record(z.string().min(1), z.string())).default({}),
});
const stateSchema = z.object({
  version: z.literal(CURRENT_VERSION), running: z.boolean(),
  aliases: aliasesSchema,
  routes: z.array(routeSchema), deliveries: z.array(deliverySchema),
  settings: settingsSchema,
  /** Epoch ms until which a provider is out of rotation (usage limit or repeated failure). */
  limits: z.record(z.string().min(1), timestampSchema),
  /** Text of each contact's last few turns, only so another provider can continue the conversation. Keyed by canonical contact id. */
  turns: z.record(z.string().min(1), z.array(turnSchema)),
});

/** Version 2 held one conversation and project per contact, all on ChatGPT. It is read, never written. */
const stateV2Schema = z.object({
  version: z.literal(2), running: z.boolean(), aliases: aliasesSchema,
  routes: z.array(z.object({
    contactId: z.string().min(1), name: z.string(), enabled: z.boolean(),
    conversationRef: z.string().min(1).nullable(), projectRef: z.string().min(1).nullable(),
    conversationTtlMinutes: ttlSchema.nullable(), conversationStartedAt: timestampSchema.nullable(), error: z.string().nullable(),
  })),
  deliveries: z.array(deliverySchema),
});

/** Version 1 was the WhatsApp/ChatGPT-only shape. It is read, never written. */
const legacyStateSchema = z.object({
  version: z.literal(1), running: z.boolean().default(true),
  aliases: z.array(z.object({ lid: z.string().regex(/^\d+@lid$/), pn: z.string().regex(/^\d+@s\.whatsapp\.net$/) })).default([]),
  routes: z.array(z.object({
    jid: z.string(), name: z.string(), enabled: z.boolean(), conversationUrl: z.string().url().nullable(), error: z.string().nullable(),
    projectUrl: z.string().nullable().default(null),
    conversationTtlMinutes: ttlSchema.nullable().default(DEFAULT_CONVERSATION_TTL_MINUTES),
    conversationStartedAt: timestampSchema.nullable().default(null),
  })),
  deliveries: z.array(z.object({ key: z.string(), jid: z.string(), status: deliveryStatus })),
});

export type Route = z.infer<typeof routeSchema>;
export type ProviderSlot = z.infer<typeof slotSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type PersistedState = z.infer<typeof stateSchema>;
/** Storage port. `read` returns the raw stored document or undefined when nothing is stored yet; `write` replaces it atomically. */
export interface StatePersistence {
  read(): Promise<unknown | undefined>;
  write(state: PersistedState): Promise<void>;
}
/** Reference validation per provider id. Every provider that may appear in saved state must be listed. */
export type ProviderReferences = Readonly<Record<ProviderId, AssistantReferencePolicy>>;

const emptySlot = (): ProviderSlot => ({ conversationRef: null, projectRef: null, startedAt: null });
/** The contact's slot on `provider`; an empty one when it holds nothing there. */
export function slotOf(route: Pick<Route, 'refs'>, provider: ProviderId): ProviderSlot { return route.refs[provider] ?? emptySlot(); }
/** True when the contact has a saved conversation on any provider. */
export function hasConversation(route: Pick<Route, 'refs'>): boolean { return Object.values(route.refs).some(slot => slot.conversationRef !== null); }
/** The slot to show for a contact: the first provider in `order` that holds a conversation, else the first provider (the primary) with its empty or project-only slot. */
export function currentSlot(route: Pick<Route, 'refs'>, order: readonly ProviderId[]): { provider: ProviderId; slot: ProviderSlot } {
  const provider = order.find(id => slotOf(route, id).conversationRef !== null) ?? order[0] ?? '';
  return { provider, slot: slotOf(route, provider) };
}
const defaultSettings = (): AssistantSettings => ({ providers: [LEGACY_PROVIDER], retriesBeforeFallback: DEFAULT_RETRIES_BEFORE_FALLBACK, options: {} });

function describe(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/** Validates a stored document and migrates it to the current version in memory. Never writes. */
function parseStored(raw: unknown): PersistedState {
  const version = typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined;
  try {
    if (version === 1 || version === 2) {
      let old: z.infer<typeof stateV2Schema>;
      if (version === 1) {
        const legacy = legacyStateSchema.parse(raw);
        old = {
          version: 2, running: legacy.running,
          aliases: legacy.aliases.map(({ lid, pn }) => ({ alias: lid, canonical: pn })),
          routes: legacy.routes.map(route => ({
            contactId: route.jid, name: route.name, enabled: route.enabled,
            conversationRef: route.conversationUrl, projectRef: route.projectUrl,
            conversationTtlMinutes: route.conversationTtlMinutes, conversationStartedAt: route.conversationStartedAt, error: route.error,
          })),
          deliveries: legacy.deliveries.map(({ key, jid, status }) => ({ key, contactId: jid, status })),
        };
      } else old = stateV2Schema.parse(raw);
      // Everything saved before providers existed belongs to ChatGPT.
      return stateSchema.parse({
        version: CURRENT_VERSION, running: old.running, aliases: old.aliases,
        routes: old.routes.map(({ conversationRef, projectRef, conversationStartedAt, ...route }) => ({ ...route, refs: { [LEGACY_PROVIDER]: { conversationRef, projectRef, startedAt: conversationStartedAt } } })),
        deliveries: old.deliveries, settings: defaultSettings(), limits: {}, turns: {},
      });
    }
    if (version !== CURRENT_VERSION) throw new Error(`Unsupported saved state version ${String(version)}. This build reads versions 1 to ${CURRENT_VERSION}.`);
    return stateSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(`Saved state is invalid: ${describe(error)}`);
    throw error;
  }
}

function aliasMap(aliases: IdentityAlias[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { alias, canonical } of aliases) {
    if (alias === canonical) throw new Error(`Saved state aliases ${alias} to itself.`);
    if (map.has(alias) && map.get(alias) !== canonical) throw new Error(`Saved state gives ${alias} more than one canonical identity.`);
    map.set(alias, canonical);
  }
  for (const canonical of map.values()) if (map.has(canonical)) throw new Error(`Saved state chains identity aliases through ${canonical}.`);
  return map;
}

export class RoutingState {
  private writes: Promise<void> = Promise.resolve();
  private readonly aliases: Map<string, string>;
  private constructor(private data: PersistedState, private readonly persistence: StatePersistence, private readonly references: ProviderReferences, private readonly now: () => number) {
    this.aliases = aliasMap(data.aliases);
  }

  /**
   * Reads, validates and (for legacy versions) migrates saved state entirely in memory. Nothing is written
   * unless every check passes, so a rejected load leaves the stored document byte-for-byte untouched.
   * `references` lists every provider the saved state may mention; each gets a slot on every route.
   */
  static async load(persistence: StatePersistence, references: ProviderReferences, now: () => number = Date.now): Promise<RoutingState> {
    const raw = await persistence.read();
    const data: PersistedState = raw === undefined
      ? { version: CURRENT_VERSION, running: false, aliases: [], routes: [], deliveries: [], settings: defaultSettings(), limits: {}, turns: {} }
      : parseStored(raw);
    const known = new Set(Object.keys(references));
    const unknown = (provider: string): Error => new Error(`Saved state mentions the assistant "${provider}", which this build does not provide.`);
    for (const provider of [...data.settings.providers, ...Object.keys(data.limits)]) if (!known.has(provider)) throw unknown(provider);
    if (new Set(data.settings.providers).size !== data.settings.providers.length) throw new Error('Saved state lists an assistant more than once.');
    const canonical = aliasMap(data.aliases);
    const projects = new Map<string, string>();
    const conversations = new Map<string, string>();
    const seen = new Set<string>();
    const baseline = now();
    if (!Number.isSafeInteger(baseline) || baseline < 0) throw new Error('Clock returned an unusable timestamp.');
    for (const route of data.routes) {
      if (seen.has(route.contactId)) throw new Error(`Saved state has more than one route for ${route.contactId}.`);
      seen.add(route.contactId);
      const owner = canonical.get(route.contactId) ?? route.contactId;
      for (const provider of Object.keys(route.refs)) if (!known.has(provider)) throw unknown(provider);
      for (const provider of known) {
        const slot = route.refs[provider] ??= emptySlot();
        const policy = references[provider]!;
        if (slot.projectRef !== null) {
          slot.projectRef = policy.normalizeProject(slot.projectRef);
          const key = `${provider}\0${slot.projectRef}`;
          const previous = projects.get(key);
          if (previous !== undefined && previous !== owner) throw new Error(`Saved state assigns one project to more than one contact (${slot.projectRef}). Fix the saved state before starting.`);
          projects.set(key, owner);
        }
        if (slot.conversationRef !== null) {
          try { slot.conversationRef = policy.normalizeConversation(slot.conversationRef, slot.projectRef); }
          catch (error) { throw new Error(`Saved conversation for ${route.name} does not match its saved project: ${error instanceof Error ? error.message : String(error)}`); }
          const key = `${provider}\0${slot.conversationRef}`;
          const previous = conversations.get(key);
          if (previous !== undefined && previous !== owner) throw new Error(`Saved state assigns one conversation to more than one contact (${slot.conversationRef}). Fix the saved state before starting.`);
          conversations.set(key, owner);
          if (slot.startedAt === null) slot.startedAt = baseline;
        }
      }
    }
    for (const delivery of data.deliveries) {
      if (delivery.status !== 'working') continue;
      delivery.status = 'failed';
      const owner = canonical.get(delivery.contactId) ?? delivery.contactId;
      const route = data.routes.find(item => (canonical.get(item.contactId) ?? item.contactId) === owner);
      if (route) { route.enabled = false; route.error = 'Interrupted delivery. Inspect both conversations before enabling again. The message will not be replayed.'; }
    }
    const state = new RoutingState(data, persistence, references, now);
    await state.save();
    return state;
  }

  private copy(route: Route): Route { return { ...route, refs: structuredClone(route.refs) }; }
  routes(): Route[] { return this.data.routes.map(route => this.copy(route)); }
  route(contactId: string): Route | undefined {
    const id = this.canonicalId(contactId);
    const route = this.data.routes.find(item => item.contactId === id);
    return route && this.copy(route);
  }
  isRunning(): boolean { return this.data.running; }
  async setRunning(running: boolean): Promise<void> { this.data.running = running; await this.save(); }
  canonicalId(id: string): string { return this.aliases.get(id) ?? id; }

  /** Provider order and fallback retries. `providers[0]` is the primary. */
  settings(): AssistantSettings { return structuredClone(this.data.settings); }
  async setSettings(settings: AssistantSettings): Promise<void> {
    const providers = settings.providers;
    if (providers.length === 0 || new Set(providers).size !== providers.length) throw new Error('Choose at least one assistant, each at most once.');
    for (const provider of providers) if (!(provider in this.references)) throw new Error(`Unknown assistant "${provider}".`);
    if (!Number.isInteger(settings.retriesBeforeFallback) || settings.retriesBeforeFallback < 0 || settings.retriesBeforeFallback > MAX_RETRIES_BEFORE_FALLBACK) {
      throw new Error(`Retries before fallback must be a whole number from 0 to ${MAX_RETRIES_BEFORE_FALLBACK}.`);
    }
    const options: AssistantSettings['options'] = {};
    for (const [provider, values] of Object.entries(settings.options)) {
      if (!(provider in this.references)) throw new Error(`Unknown assistant "${provider}".`);
      const specs = providerOptionSpecs(provider);
      const kept = Object.entries(values).filter(([, value]) => value.trim() !== '');
      for (const [key, value] of kept) {
        const spec = specs.find(item => item.key === key);
        if (!spec) throw new Error(`${providerName(provider)} has no option "${key}".`);
        if (!new RegExp(`^(?:${spec.pattern})$`).test(value.trim())) throw new Error(`${providerName(provider)} ${key}: ${spec.hint}`);
      }
      if (kept.length > 0) options[provider] = Object.fromEntries(kept.map(([key, value]) => [key, value.trim()]));
    }
    this.data.settings = { providers: [...providers], retriesBeforeFallback: settings.retriesBeforeFallback, options };
    await this.save();
  }
  /** When `provider` is usable again, or null when it is not limited now. */
  limitedUntil(provider: ProviderId): number | null {
    const until = this.data.limits[provider];
    return until !== undefined && until > this.now() ? until : null;
  }
  async markLimited(provider: ProviderId, until: number): Promise<void> {
    if (!(provider in this.references)) throw new Error(`Unknown assistant "${provider}".`);
    this.data.limits[provider] = Math.round(until);
    for (const [other, time] of Object.entries(this.data.limits)) if (time <= this.now()) delete this.data.limits[other];
    await this.save();
  }
  /** The contact's recent turns, oldest first. */
  turns(contactId: string): Turn[] { return (this.data.turns[this.canonicalId(contactId)] ?? []).map(turn => ({ ...turn })); }
  /** Appends one turn (text only, bounded). The log only feeds provider handoff and is dropped when the contact's conversations expire. */
  async recordTurn(contactId: string, turn: Omit<Turn, 'at'>): Promise<void> {
    contactId = this.canonicalId(contactId);
    if (!this.data.routes.some(route => route.contactId === contactId)) throw new Error('Contact has no route.');
    const text = turn.text.length > MAX_TURN_CHARS ? `${turn.text.slice(0, MAX_TURN_CHARS)}…` : turn.text;
    this.data.turns[contactId] = [...(this.data.turns[contactId] ?? []), { ...turn, text, at: this.now() }].slice(-MAX_TURNS);
    await this.save();
  }
  /**
   * Delivery keys are `<contactId>:<messageId>` by convention, but ids are opaque and may contain ':'. The owning contact is therefore
   * always passed explicitly: a key that starts with that exact id gets the canonical id as its prefix; any other key is left as is.
   */
  private ownerKey(key: string, contactId: string): string {
    const prefix = `${contactId}:`;
    return key.startsWith(prefix) ? `${this.canonicalId(contactId)}:${key.slice(prefix.length)}` : key;
  }
  /** Journal identity is (canonical contact, owner-normalized key), so equal raw keys of different contacts never collide. */
  private findDelivery(key: string, contactId: string): Delivery | undefined {
    const identity = JSON.stringify([this.canonicalId(contactId), this.ownerKey(key, contactId)]);
    return this.data.deliveries.find(row => JSON.stringify([this.canonicalId(row.contactId), this.ownerKey(row.key, row.contactId)]) === identity);
  }
  private hasWorkingDelivery(contactId: string): boolean {
    return this.data.deliveries.some(delivery => delivery.status === 'working' && this.canonicalId(delivery.contactId) === contactId);
  }
  private pausedRoute(contact: Contact): Route {
    return {
      contactId: contact.id, name: contact.name, enabled: false, error: null, conversationTtlMinutes: DEFAULT_CONVERSATION_TTL_MINUTES,
      refs: Object.fromEntries(Object.keys(this.references).map(provider => [provider, emptySlot()])),
    };
  }
  private policy(provider: ProviderId): AssistantReferencePolicy {
    const policy = this.references[provider];
    if (!policy) throw new Error(`Unknown assistant "${provider}".`);
    return policy;
  }

  async linkIdentity({ alias, canonical }: IdentityAlias): Promise<void> {
    if (!alias || !canonical || alias === canonical) throw new Error('An identity alias needs two different identities.');
    if (this.aliases.has(canonical)) throw new Error(`${canonical} is itself an alias and cannot be a canonical identity.`);
    for (const target of this.aliases.values()) if (target === alias) throw new Error(`${alias} is already a canonical identity and cannot become an alias.`);
    const source = this.data.routes.find(route => route.contactId === alias);
    const target = this.data.routes.find(route => route.contactId === canonical);
    const providers = Object.keys(this.references);
    if (source && target) {
      for (const provider of providers) {
        const from = slotOf(source, provider);
        const into = slotOf(target, provider);
        if (from.conversationRef && into.conversationRef && from.conversationRef !== into.conversationRef) {
          throw new Error(`Two conversations are configured for the same contact (${alias}, ${canonical}). Neither conversation was discarded; inspect the saved session configuration before merging.`);
        }
        if (from.projectRef && into.projectRef && from.projectRef !== into.projectRef) {
          throw new Error(`Two projects are configured for the same contact (${alias}, ${canonical}). Neither project was discarded; clear one before merging.`);
        }
        const conversation = into.conversationRef ?? from.conversationRef;
        if (conversation) {
          try { this.policy(provider).normalizeConversation(conversation, into.projectRef ?? from.projectRef); }
          catch { throw new Error(`The saved conversation of one of the same contact's routes (${alias}, ${canonical}) does not belong to the other route's project. Neither was discarded; clear the project or conversation before merging.`); }
        }
      }
    }
    const existing = this.data.aliases.find(mapping => mapping.alias === alias);
    let changed = existing?.canonical !== canonical || source !== undefined;
    if (existing) existing.canonical = canonical;
    else this.data.aliases.push({ alias, canonical });
    this.aliases.set(alias, canonical);
    if (source && target) {
      const owner = !hasConversation(target) && hasConversation(source) ? source : target;
      const peer = owner === source ? target : source;
      const ttl = owner.conversationTtlMinutes === DEFAULT_CONVERSATION_TTL_MINUTES ? peer.conversationTtlMinutes : owner.conversationTtlMinutes;
      for (const provider of providers) {
        const from = slotOf(source, provider);
        const into = target.refs[provider] ??= emptySlot();
        if (into.conversationRef) {
          if (from.conversationRef) into.startedAt = [into.startedAt, from.startedAt].reduce<number | null>((earliest, value) => value === null ? earliest : earliest === null ? value : Math.min(earliest, value), null);
        } else { into.conversationRef = from.conversationRef; into.startedAt = from.startedAt; }
        into.projectRef ??= from.projectRef;
      }
      target.conversationTtlMinutes = ttl;
      target.error ??= source.error;
      target.enabled = (target.enabled || source.enabled) && !target.error;
      this.data.routes = this.data.routes.filter(route => route !== source);
    } else if (source) source.contactId = canonical;
    const merged = [...(this.data.turns[alias] ?? []), ...(this.data.turns[canonical] ?? [])];
    delete this.data.turns[alias];
    if (merged.length > 0) this.data.turns[canonical] = merged.sort((a, b) => a.at - b.at).slice(-MAX_TURNS);
    const deliveries = new Map<string, Delivery>();
    const priority = { working: 2, done: 1, failed: 0 };
    for (const delivery of this.data.deliveries) {
      const contactId = this.canonicalId(delivery.contactId);
      const key = this.ownerKey(delivery.key, delivery.contactId);
      const identity = JSON.stringify([contactId, key]);
      if (contactId !== delivery.contactId || key !== delivery.key || deliveries.has(identity)) changed = true;
      const previous = deliveries.get(identity);
      if (!previous || priority[delivery.status] > priority[previous.status]) deliveries.set(identity, { ...delivery, contactId, key });
    }
    this.data.deliveries = [...deliveries.values()];
    if (changed) await this.save();
  }
  async enable(contact: Contact): Promise<void> {
    contact = { ...contact, id: this.canonicalId(contact.id) };
    const existing = this.data.routes.find(route => route.contactId === contact.id);
    if (existing) { existing.enabled = true; existing.error = null; existing.name = contact.name; }
    else this.data.routes.push({ ...this.pausedRoute(contact), enabled: true });
    await this.save();
  }
  async pause(contactId: string, error: string | null = null): Promise<void> {
    contactId = this.canonicalId(contactId);
    const route = this.data.routes.find(item => item.contactId === contactId);
    if (!route) throw new Error('Contact has no route.');
    route.enabled = false; route.error = error;
    await this.save();
  }
  /** Assigns or clears the project on one provider. Creates a paused route for an untouched contact. A changed project drops that provider's local conversation link. */
  async setProject(contact: Contact, provider: ProviderId, ref: string | null): Promise<void> {
    const contactId = this.canonicalId(contact.id);
    const project = ref === null ? null : this.policy(provider).normalizeProject(ref);
    if (this.hasWorkingDelivery(contactId)) throw new Error('A message is being delivered for this contact. Change the project after it finishes.');
    if (project !== null && this.data.routes.some(item => this.canonicalId(item.contactId) !== contactId && slotOf(item, provider).projectRef === project)) throw new Error('Project already belongs to another contact.');
    const route = this.data.routes.find(item => item.contactId === contactId);
    if (!route) {
      const created = this.pausedRoute({ id: contactId, name: contact.name });
      created.refs[provider] = { ...emptySlot(), projectRef: project };
      this.data.routes.push(created);
    } else {
      const slot = route.refs[provider] ??= emptySlot();
      if (slot.projectRef === project) return;
      route.refs[provider] = { conversationRef: null, projectRef: project, startedAt: null };
    }
    await this.save();
  }
  /** Sets the fixed conversation lifetime in minutes, or null to never expire. The lifetime still counts from the existing conversation's birth. */
  async setConversationTtl(contact: Contact, minutes: number | null): Promise<void> {
    const contactId = this.canonicalId(contact.id);
    if (minutes !== null && !(Number.isSafeInteger(minutes) && minutes > 0 && Number.isSafeInteger(minutes * 60_000))) throw new Error('Conversation lifetime must be a positive whole number of minutes.');
    if (this.hasWorkingDelivery(contactId)) throw new Error('A message is being delivered for this contact. Change the lifetime after it finishes.');
    const route = this.data.routes.find(item => item.contactId === contactId);
    if (!route) this.data.routes.push({ ...this.pausedRoute({ id: contactId, name: contact.name }), conversationTtlMinutes: minutes });
    else if (route.conversationTtlMinutes === minutes) return;
    else route.conversationTtlMinutes = minutes;
    await this.save();
  }
  async conversation(contactId: string, provider: ProviderId, ref: string): Promise<void> {
    contactId = this.canonicalId(contactId);
    const route = this.data.routes.find(item => item.contactId === contactId);
    if (!route) throw new Error('Contact has no route.');
    const slot = route.refs[provider] ??= emptySlot();
    const normalized = this.policy(provider).normalizeConversation(ref, slot.projectRef);
    if (this.data.routes.some(item => this.canonicalId(item.contactId) !== contactId && slotOf(item, provider).conversationRef === normalized)) throw new Error('Conversation already belongs to another contact.');
    if (slot.conversationRef === normalized && slot.startedAt !== null) return;
    slot.conversationRef = normalized;
    slot.startedAt = this.now();
    await this.save();
  }
  /**
   * Drops expired conversation links before submission and returns the current route. Fixed lifetime from the first persisted reference; never sliding.
   * Once no provider holds a conversation any more, the recent-turn log is dropped too: the contact starts fresh.
   */
  async refreshConversation(contactId: string): Promise<Route | undefined> {
    contactId = this.canonicalId(contactId);
    const route = this.data.routes.find(item => item.contactId === contactId);
    if (!route) return undefined;
    const ttl = route.conversationTtlMinutes;
    let expired = false;
    for (const slot of Object.values(route.refs)) {
      if (slot.conversationRef !== null && slot.startedAt !== null && ttl !== null && this.now() >= slot.startedAt + ttl * 60_000) {
        slot.conversationRef = null; slot.startedAt = null; expired = true;
      }
    }
    if (expired) {
      if (!hasConversation(route)) delete this.data.turns[contactId];
      await this.save();
    }
    return this.copy(route);
  }
  async claim(key: string, contactId: string): Promise<boolean> {
    if (this.findDelivery(key, contactId)) return false;
    this.data.deliveries.push({ key: this.ownerKey(key, contactId), contactId: this.canonicalId(contactId), status: 'working' });
    await this.save();
    return true;
  }
  async finish(key: string, contactId: string, status: 'done' | 'failed'): Promise<void> {
    const delivery = this.findDelivery(key, contactId);
    if (!delivery) throw new Error('Unknown delivery.');
    delivery.status = status;
    await this.save();
  }
  /** Snapshots synchronously, then writes in call order so a slow earlier write can never overwrite a newer one. */
  private save(): Promise<void> {
    const snapshot = structuredClone(this.data);
    const next = this.writes.then(() => this.persistence.write(snapshot));
    this.writes = next.catch(() => undefined);
    return next;
  }
}
