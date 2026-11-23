import { isJidBroadcast, isJidGroup, isJidStatusBroadcast, isLidUser, isPnUser, normalizeMessageContent } from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function disconnectStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("output" in error)) {
    return undefined;
  }
  const { output } = error;
  if (typeof output !== "object" || output === null || !("statusCode" in output)) {
    return undefined;
  }
  return typeof output.statusCode === "number" ? output.statusCode : undefined;
}

/** Direct (phone or LID) user JIDs only; groups, broadcasts and status are never contacts. */
export function isOneToOneUserJid(jid: string): boolean {
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid)) {
    return false;
  }
  return Boolean(isPnUser(jid) || isLidUser(jid));
}

export function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function messageSeconds(message: WAMessage): number | undefined {
  const raw = message.messageTimestamp;
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const seconds = Number(raw.toString());
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function extractText(message: WAMessage): string | undefined {
  const content = normalizeMessageContent(message.message);
  if (!content) {
    return undefined;
  }
  const text = content.conversation ?? content.extendedTextMessage?.text;
  return text && text.trim() ? text : undefined;
}

export interface ImageContent {
  caption: string;
  mimeType: string;
  /** Size the sender declared, when present; the real download is checked separately. */
  declaredBytes: number | undefined;
}

function declaredSize(value: { toString(): string } | number | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const size = Number(value.toString());
  return Number.isFinite(size) ? size : undefined;
}

/** A photo (image message, or a document whose mime type is an image), including view-once and ephemeral wrappers. */
export function extractImage(message: WAMessage): ImageContent | undefined {
  const content = normalizeMessageContent(message.message);
  if (!content) {
    return undefined;
  }
  const image = content.imageMessage;
  if (image) {
    return { caption: image.caption ?? "", mimeType: image.mimetype || "image/jpeg", declaredBytes: declaredSize(image.fileLength) };
  }
  const document = content.documentMessage;
  if (document?.mimetype?.startsWith("image/")) {
    return { caption: document.caption ?? "", mimeType: document.mimetype, declaredBytes: declaredSize(document.fileLength) };
  }
  return undefined;
}

const IMAGE_EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heif" };

export function imageExtension(mimeType: string): string {
  const known = IMAGE_EXTENSIONS[mimeType.toLowerCase().split(";")[0]?.trim() ?? ""];
  return known ?? "img";
}

/** Longest quoted passage forwarded with a reply; the rest is cut so one long quote cannot swamp the prompt. */
const QUOTE_MAX_CHARS = 2000;

/** The message this one replies to (WhatsApp quote), as plain text; "[photo]" and similar when the quoted message carried no text. */
export function extractQuote(message: WAMessage): string | undefined {
  const content = normalizeMessageContent(message.message);
  if (!content) return undefined;
  const context = content.extendedTextMessage?.contextInfo ?? content.imageMessage?.contextInfo ?? content.documentMessage?.contextInfo ?? undefined;
  const quoted = normalizeMessageContent(context?.quotedMessage);
  if (!quoted) return undefined;
  const text = quoted.conversation ?? quoted.extendedTextMessage?.text ?? quoted.imageMessage?.caption ?? quoted.documentMessage?.caption ?? quoted.videoMessage?.caption;
  const label = quoted.imageMessage ? "[photo]" : quoted.videoMessage ? "[video]" : quoted.audioMessage ? "[voice message]" : quoted.documentMessage ? "[document]" : quoted.stickerMessage ? "[sticker]" : undefined;
  const body = nonEmpty(text) ?? label;
  if (!body) return undefined;
  return body.length > QUOTE_MAX_CHARS ? `${body.slice(0, QUOTE_MAX_CHARS)}…` : body;
}

/** Prepends the quoted message to `text` so the assistant sees what the contact is replying to. */
export function withQuote(message: WAMessage, text: string): string {
  const quote = extractQuote(message);
  if (!quote) return text;
  const quoted = quote.split("\n").map(line => `> ${line}`).join("\n");
  return `Replying to this earlier message:\n${quoted}\n\n${text}`.trimEnd();
}
