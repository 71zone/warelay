import { normalizeMessageContent, proto } from "@whiskeysockets/baileys";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Contact, Logger } from "../../core/contracts.js";
import type { LinkState } from "./connection.js";
import type { Directory } from "./directory.js";
import type { DirectoryIngest } from "./ingestion.js";
import { describeError, extractImage, extractText, messageSeconds } from "./protocol.js";

/** Incoming messages older than this are never recovered. */
export const MAX_UNANSWERED_AGE_SECONDS = 24 * 60 * 60;
/** Most unanswered messages forwarded per chat, as one combined prompt. */
export const MAX_UNANSWERED_MESSAGES = 10;
/** Messages asked of the phone per chat; own replies take slots too. */
const HISTORY_REQUEST_COUNT = 20;

export interface UnansweredOptions {
  /** Current Unix second. */
  now: number;
  /** True when the delivery journal already holds this message ID. */
  isDelivered: (messageId: string) => boolean;
  maxAgeSeconds?: number;
  maxMessages?: number;
}

/** A message the user or the bridge wrote in the chat: a real message, not a reaction, edit/revoke or other protocol traffic. */
function isAnswer(message: WAMessage): boolean {
  if (!message.key.fromMe) return false;
  const content = normalizeMessageContent(message.message);
  return Boolean(content) && !content?.protocolMessage && !content?.reactionMessage;
}

/**
 * The incoming messages of one chat nobody has answered, oldest first. Unanswered means newer than the newest message written in
 * that chat by this account (the bridge or a manual reply from the phone) and sent within the last 24 hours. It does not depend
 * on read state: the user may have read the message on the phone. Messages the journal already holds and types the bridge does
 * not forward (anything but text and photos) are left out; only the newest 10 are kept. When the newest candidate is already in the
 * journal (an earlier recovery swept the group into one prompt that then failed, and failed messages are never replayed) the
 * result is empty, so older members of that group are not sent on their own.
 */
export function selectUnanswered(messages: readonly WAMessage[], options: UnansweredOptions): WAMessage[] {
  const { now, isDelivered, maxAgeSeconds = MAX_UNANSWERED_AGE_SECONDS, maxMessages = MAX_UNANSWERED_MESSAGES } = options;
  let answeredAt = 0;
  for (const message of messages) {
    const sentAt = messageSeconds(message);
    if (sentAt !== undefined && isAnswer(message)) answeredAt = Math.max(answeredAt, sentAt);
  }
  const floor = Math.max(answeredAt, now - maxAgeSeconds);
  const seen = new Set<string>();
  const candidates: { message: WAMessage; sentAt: number; id: string }[] = [];
  for (const message of messages) {
    const { id, fromMe } = message.key;
    const sentAt = messageSeconds(message);
    if (fromMe || !id || sentAt === undefined || sentAt <= floor || seen.has(id)) continue;
    if (extractText(message) === undefined && extractImage(message) === undefined) continue;
    seen.add(id);
    candidates.push({ message, sentAt, id });
  }
  candidates.sort((a, b) => a.sentAt - b.sentAt);
  const newest = candidates.at(-1);
  if (!newest || isDelivered(newest.id)) return [];
  return candidates.filter(entry => !isDelivered(entry.id)).slice(-maxMessages).map(entry => entry.message);
}

export interface RecoveryTiming {
  /** Wait after the link opens, so WhatsApp's own offline backlog and sync finish first. */
  settleMs: number;
  /** How long the phone gets to answer one history request. */
  historyTimeoutMs: number;
  /** Unix seconds; tests pin it. */
  now: () => number;
}

const DEFAULT_TIMING: RecoveryTiming = { settleMs: 5000, historyTimeoutMs: 20_000, now: () => Math.floor(Date.now() / 1000) };

export interface UnansweredRecoveryOptions {
  link: LinkState;
  logger: Logger;
  directory: Directory;
  ingest: DirectoryIngest;
  /** Contacts whose chats are checked: the enabled routes, or none while forwarding is not active. */
  targets: () => Contact[];
  /** True when the delivery journal already holds `<contactId>:<messageId>`. */
  isDelivered: (contactId: string, messageId: string) => boolean;
  /** Hands the messages to the bridge as ONE combined prompt, without the time cutoff; resolves with how many it combined (0 when none could be forwarded). */
  forward: (messages: WAMessage[]) => Promise<number>;
  timing?: Partial<RecoveryTiming>;
}

export interface UnansweredRecovery {
  /** Checks every target chat once, serially. Never throws; stops early when `signal` aborts. */
  run(socket: WASocket, signal: AbortSignal): Promise<void>;
}

/**
 * WhatsApp does not redeliver a message the user already read on the phone, and this app keeps no message store, so on every
 * connection open the phone is asked for the latest messages of each enabled chat (Baileys on-demand history). The request
 * names an anchor "now" in the chat and the phone answers with the messages before it through `messaging-history.set`.
 */
export function createUnansweredRecovery(options: UnansweredRecoveryOptions): UnansweredRecovery {
  const { link, logger, directory, ingest, targets, isDelivered, forward } = options;
  const timing: RecoveryTiming = { ...DEFAULT_TIMING, ...options.timing };

  /** JIDs the phone may file the chat under: LID aliases first (current WhatsApp keys chats by LID), then the phone number. */
  function chatJids(contactId: string): string[] {
    const aliases = [...directory.mappings].filter(([, pn]) => pn === contactId).map(([lid]) => lid);
    return [...new Set([...aliases, contactId])];
  }

  /** The phone's answer for one chat: its messages (maybe none), or undefined when it did not answer in time or `signal` aborted. */
  async function requestHistory(socket: WASocket, contact: Contact, jid: string, signal: AbortSignal): Promise<WAMessage[] | undefined> {
    const { promise, resolve } = Promise.withResolvers<WAMessage[] | undefined>();
    const wait = new AbortController();
    const stopWaiting = (): void => wait.abort();
    signal.addEventListener("abort", stopWaiting, { once: true });
    let requestId: string | undefined;
    const onHistory = (history: { messages: WAMessage[]; syncType?: proto.HistorySync.HistorySyncType | null; peerDataRequestSessionId?: string | null }): void => {
      const own = history.messages.filter(message => {
        const remote = message.key.remoteJid;
        return remote !== undefined && remote !== null && (remote === jid || ingest.canonicalJid(remote) === contact.id);
      });
      const answersRequest = requestId !== undefined && history.peerDataRequestSessionId === requestId;
      if (answersRequest || (history.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND && own.length > 0)) resolve(own);
    };
    socket.ev.on("messaging-history.set", onHistory);
    try {
      const anchor = { remoteJid: jid, fromMe: false, id: randomBytes(8).toString("hex").toUpperCase() };
      requestId = await socket.fetchMessageHistory(HISTORY_REQUEST_COUNT, anchor, Date.now());
      const timedOut = sleep(timing.historyTimeoutMs, undefined, { signal: wait.signal }).then(() => undefined, () => undefined);
      return await Promise.race([promise, timedOut]);
    } finally {
      socket.ev.off("messaging-history.set", onHistory);
      signal.removeEventListener("abort", stopWaiting);
      wait.abort();
    }
  }

  async function checkChat(socket: WASocket, contact: Contact, signal: AbortSignal): Promise<void> {
    const lastActivity = directory.chats.get(contact.id)?.lastMessageAt ?? null;
    if (lastActivity !== null && lastActivity < timing.now() - MAX_UNANSWERED_AGE_SECONDS) {
      logger(`Skipping ${contact.name}: no activity in the last 24 hours, so nothing there can be unanswered.`);
      return;
    }
    logger(`Checking ${contact.name} for unanswered messages…`);
    let history: WAMessage[] | undefined;
    let answered = false;
    for (const jid of chatJids(contact.id)) {
      const result = await requestHistory(socket, contact, jid, signal);
      if (signal.aborted) return;
      if (result === undefined) continue;
      answered = true;
      if (result.length > 0) { history = result; break; }
    }
    if (!history) {
      logger(answered
        ? `History for ${contact.name}: the phone returned no messages.`
        : `The phone did not return history for ${contact.name} (timed out); unanswered messages there cannot be checked.`);
      return;
    }
    const unanswered = selectUnanswered(history, { now: timing.now(), isDelivered: id => isDelivered(contact.id, id) });
    logger(`History for ${contact.name}: ${history.length} message${history.length === 1 ? "" : "s"} from the phone, ${unanswered.length} unanswered${unanswered.length > 0 ? ", forwarding as one prompt." : "."}`);
    if (unanswered.length > 0) await forward(unanswered);
  }

  return {
    async run(socket, signal): Promise<void> {
      try {
        await sleep(timing.settleMs, undefined, { signal });
        if (link.socket !== socket) return;
        for (const contact of targets()) {
          if (signal.aborted || link.socket !== socket) return;
          try {
            await checkChat(socket, contact, signal);
          } catch (error) {
            if (signal.aborted) return;
            logger(`Could not check ${contact.name} for unanswered messages: ${describeError(error)}`);
          }
        }
      } catch (error) {
        if (!signal.aborted) logger(`Unanswered-message check failed: ${describeError(error)}`);
      }
    },
  };
}
