import { normalizeMessageContent } from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";
import { extractImage, extractText, messageSeconds } from "./protocol.js";

/** Incoming messages of an enabled chat older than this are never forwarded. */
export const MAX_UNANSWERED_AGE_SECONDS = 24 * 60 * 60;
/** Most unanswered messages forwarded per chat, as one combined prompt. */
export const MAX_UNANSWERED_MESSAGES = 10;

export interface UnansweredOptions {
  /** First Unix second whose incoming messages may be forwarded (inclusive). */
  since: number;
  /** True when the message was already handled: in the delivery journal, or forwarded earlier by this process. */
  isDelivered: (messageId: string) => boolean;
  maxMessages?: number;
}

/** A message the user or the bridge wrote in the chat: a real message, not a reaction, edit/revoke or other protocol traffic. */
function isAnswer(message: WAMessage): boolean {
  if (!message.key.fromMe) return false;
  const content = normalizeMessageContent(message.message);
  return Boolean(content) && !content?.protocolMessage && !content?.reactionMessage;
}

/**
 * The incoming messages of one chat in one upsert batch that nobody has answered, oldest first. Unanswered means sent at or after `since` and
 * not older than the newest message written in that chat by this account in the same batch (the bridge, or a reply typed on the phone). Messages
 * already handled and types the bridge does not forward (anything but text and photos) are left out; only the newest 10 are kept. When the
 * newest candidate is already handled (an earlier prompt swept the group into one prompt that then finished or failed, and finished messages are
 * never replayed) the result is empty, so older members of that group are not sent on their own.
 */
export function selectUnanswered(messages: readonly WAMessage[], options: UnansweredOptions): WAMessage[] {
  const { since, isDelivered, maxMessages = MAX_UNANSWERED_MESSAGES } = options;
  let answeredAt = 0;
  for (const message of messages) {
    const sentAt = messageSeconds(message);
    if (sentAt !== undefined && isAnswer(message)) answeredAt = Math.max(answeredAt, sentAt);
  }
  const seen = new Set<string>();
  const candidates: { message: WAMessage; sentAt: number; id: string }[] = [];
  for (const message of messages) {
    const { id, fromMe } = message.key;
    const sentAt = messageSeconds(message);
    if (fromMe || !id || sentAt === undefined || sentAt < since || sentAt < answeredAt || seen.has(id)) continue;
    if (extractText(message) === undefined && extractImage(message) === undefined) continue;
    seen.add(id);
    candidates.push({ message, sentAt, id });
  }
  candidates.sort((a, b) => a.sentAt - b.sentAt);
  const newest = candidates.at(-1);
  if (!newest || isDelivered(newest.id)) return [];
  return candidates.filter(entry => !isDelivered(entry.id)).slice(-maxMessages).map(entry => entry.message);
}
