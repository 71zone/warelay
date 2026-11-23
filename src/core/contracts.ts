export type Logger = (message: string) => void;
export interface Contact { id: string; name: string }
export interface RecentChat extends Contact { lastMessageAt: number | null; unread: number; archived: boolean }
export interface IdentityAlias { alias: string; canonical: string }
export type AttachmentKind = 'image' | 'video' | 'audio' | 'document';
/** A file on the local disk (inside the MediaStore directory) that travels between the messaging provider and the assistant. */
export interface Attachment { kind: AttachmentKind; path: string; fileName: string; mimeType: string }
/**
 * Provider-neutral content of an assistant reply, in display order. The assistant adapter extracts it from the assistant's UI; the messaging adapter
 * decides how to render each block for its own medium. `markdown` is standard Markdown prose (emphasis, inline code, links, lists, headings, quotes).
 */
export type ReplyBlock =
  | { type: 'markdown'; text: string }
  /** A draft the user is meant to copy and send. `title` is its subject line (email drafts). Delivered as separate messages for the title and the body so each copies cleanly. */
  | { type: 'draft'; title?: string; text: string }
  | { type: 'code'; language: string | null; code: string }
  /**
   * A table or card of rows. `images`, when not empty, are pictures of it as the assistant displayed it, top to bottom (a tall table comes in several);
   * messaging adapters deliver those instead of the header and rows, which remain as the text form for adapters that cannot show images.
   */
  | { type: 'table'; header: string[]; rows: string[][]; images?: Attachment[] }
  /**
   * An interactive card that is not a table (a step strip with icons, a flashcard with buttons). `text` is its readable content without icons, buttons and counters,
   * Markdown lines. `images`, when not empty, are pictures of it as the assistant displayed it; messaging adapters deliver those and nothing else, unless `companion`
   * is set (the picture mostly shows controls, such as a flashcard), in which case `text` follows the pictures as its own copyable message. Without images `text` is delivered alone.
   */
  | { type: 'widget'; text: string; companion: boolean; images?: Attachment[] }
  | { type: 'attachment'; attachment: Attachment };
export interface IncomingMessage {
  id: string;
  contact: Contact;
  /** Message text or media caption; empty when the message is attachments only. */
  text: string;
  /** Downloaded media (for example photos) sent with the message; already saved under the MediaStore directory. */
  attachments: Attachment[];
  /** Marks the message as read in the messaging provider. Closes over provider-owned receipt data only. */
  acknowledge: () => Promise<void>;
}
export interface MessagingAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  contacts(): Contact[];
  chats(): RecentChat[];
  identities(): IdentityAlias[];
  hasSavedSession(): boolean;
  /** Resolves user input (for example a phone number) to a direct contact; throws a user-readable error for unusable input. */
  resolveContact(input: string): Contact;
  /**
   * Delivers a rendered reply as one or more messages, in order. Throws NotSentError only when nothing at all was sent; once any part has
   * gone out, failures are reported as other errors because repeating the call would duplicate that part.
   */
  sendReply(contactId: string, blocks: ReplyBlock[]): Promise<void>;
}
export interface Project { name: string; ref: string }
/** Registry id of an assistant provider (see providers.ts). Providers are interchangeable: nothing in core assumes a fixed set. */
export type ProviderId = string;
/** What one contact holds on one provider. */
export interface ProviderRefs { conversationRef: string | null; projectRef: string | null }
/** One text turn of a contact's recent conversation, kept by the bridge so another provider can continue it. `provider` is the provider that handled it. */
export interface Turn { role: 'user' | 'assistant'; provider: ProviderId; text: string; at: number }
/** Provider-owned validation of opaque references. Core stores the returned canonical strings and never parses them. */
export interface AssistantReferencePolicy {
  normalizeProject(ref: string): string;
  normalizeConversation(ref: string, projectRef: string | null): string;
}
/** One assistant provider driven through the browser. The router (fallback.ts) composes several behind {@link Assistant}. */
export interface AssistantAdapter {
  readonly id: ProviderId;
  readonly references: AssistantReferencePolicy;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Complete, sorted, unique project catalog read independently of delivery; throws instead of returning a partial or falsely empty list.
   * `signal` cancels the read: implementations abort their in-flight transport and waits, finish bounded cleanup of anything they opened, then reject.
   */
  listProjects(signal?: AbortSignal): Promise<Project[]>;
  reply(input: {
    conversationRef: string | null;
    projectRef: string | null;
    text: string;
    /** Files to attach to the prompt (for example photos the contact sent). */
    attachments: Attachment[];
    onConversation: (ref: string) => Promise<void>;
    onSubmitted: () => Promise<void>;
  }): Promise<{ conversationRef: string; text: string; blocks?: ReplyBlock[] }>;
}
/**
 * Thrown by an adapter when it can prove the provider never received the message (not connected, page not ready). Only this error lets
 * the bridge retry on its own: any other failure may have reached the provider, and repeating it could duplicate the message.
 */
export class NotSentError extends Error {}

/**
 * Thrown by an adapter when the provider shows its usage-limit message. `resetAt` is the epoch ms the provider says the limit lifts, null when it names none.
 * Before the prompt was accepted the router moves on to the next provider with the same message; after acceptance the reply fails and only later messages move.
 */
export class UsageLimitError extends Error {
  constructor(readonly provider: ProviderId, readonly resetAt: number | null, message: string) { super(message); }
}
/** Every configured provider is over its limit (or failing), so nothing was sent. `resetAt` is the soonest time one of them is usable again. */
export class AllProvidersLimitedError extends Error {
  constructor(message: string, readonly resetAt: number | null) { super(message); }
}
/** Provider order and fallback behaviour; persisted with the routing state. `providers[0]` is the primary. */
export interface AssistantSettings {
  providers: ProviderId[];
  retriesBeforeFallback: number;
  /** Per-provider options the registry declares (for example an account index), edited with the order and persisted with it. Absent key = provider default. */
  options: Record<ProviderId, ProviderOptions>;
}
export type ProviderOptions = Record<string, string>;
/** What the bridge talks to: the configured providers behind one fallback policy. */
export interface Assistant {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Project catalog of one provider (see {@link AssistantAdapter.listProjects}). */
  listProjects(provider: ProviderId, signal?: AbortSignal): Promise<Project[]>;
  reply(input: {
    /** The contact's references on every provider; a provider missing from the map holds none. */
    refs: Readonly<Record<ProviderId, ProviderRefs>>;
    /** Recent turns of the contact, oldest first, used to continue the conversation on a provider that has not seen them. */
    history: readonly Turn[];
    text: string;
    attachments: Attachment[];
    /** A provider is about to receive the message (first choice or a fallback); its name is what logs and notices should say. */
    onProvider: (provider: ProviderId) => void;
    onConversation: (provider: ProviderId, ref: string) => Promise<void>;
    onSubmitted: (provider: ProviderId) => Promise<void>;
  }): Promise<{ provider: ProviderId; conversationRef: string; text: string; blocks?: ReplyBlock[] }>;
}
