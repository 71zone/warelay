import { downloadMediaMessage, isLidUser, isPnUser, jidNormalizedUser } from "@whiskeysockets/baileys";
import type { BaileysEventMap, WAMessage, WAMessageKey, WASocket } from "@whiskeysockets/baileys";
import { writeFile } from "node:fs/promises";
import { pino } from "pino";
import type { Attachment, IncomingMessage, Logger } from "../../core/contracts.js";
import { MAX_MEDIA_BYTES } from "../../infrastructure/media.js";
import type { MediaStore } from "../../infrastructure/media.js";
import type { DirectorySaver } from "./autosave.js";
import type { LinkState } from "./connection.js";
import type { Directory } from "./directory.js";
import type { DirectoryIngest } from "./ingestion.js";
import { describeError, extractImage, extractText, imageExtension, isOneToOneUserJid, messageSeconds, withQuote } from "./protocol.js";
import type { ImageContent } from "./protocol.js";

/** Message IDs remembered to drop a message WhatsApp delivers twice; the delivery journal covers restarts. */
const MAX_REMEMBERED_IDS = 2000;

export interface Inbound {
  /** Subscribes live message upserts; returns the detach function. */
  attach(ev: WASocket["ev"]): () => void;
  /** Resolves once every message already queued has been handled. */
  drain(): Promise<void>;
  /** Queues the unanswered messages of one chat as a single combined prompt (see handleRecovered); resolves with how many were combined. */
  forwardRecovered(messages: WAMessage[]): Promise<number>;
}

export interface InboundOptions {
  directory: Directory;
  ingest: DirectoryIngest;
  saver: DirectorySaver;
  link: LinkState;
  logger: Logger;
  media: MediaStore;
  onMessage: (message: IncomingMessage) => void;
  /** Fetches and decrypts the bytes of a media message; defaults to Baileys' download through the live socket. */
  download?: (message: WAMessage) => Promise<Buffer>;
}

/**
 * Forwarding policy: only `notify` and `append` upserts (WhatsApp delivers messages queued while this device was offline as
 * `append`) sent at or after the link's cutoff, from direct contacts, with text or a photo and not authored by this account,
 * reach `onMessage`, oldest first, once per message ID per process. Photos are downloaded into the media store first; a photo
 * that cannot be downloaded is dropped with a log line rather than forwarded without its image.
 * Every direct message (including own and historical ones) still refreshes the chat directory.
 */
export function createInbound(options: InboundOptions): Inbound {
  const { directory, ingest, saver, link, logger, media, onMessage } = options;
  const baileysLogger = pino({ level: "warn" }, { write: text => logger(`WhatsApp: ${text.trim()}`) });
  const download = options.download ?? (async (message: WAMessage): Promise<Buffer> => {
    const socket = link.socket;
    if (!socket || !link.open) throw new Error("WhatsApp is not connected");
    return downloadMediaMessage(message, "buffer", {}, { logger: baileysLogger, reuploadRequest: socket.updateMediaMessage });
  });
  let queue: Promise<void> = Promise.resolve();
  const forwarded = new Set<string>();

  async function resolveIncomingJid(message: WAMessage): Promise<string | null> {
    const remote = message.key.remoteJid;
    if (!remote || !isOneToOneUserJid(remote)) return null;
    const normalized = jidNormalizedUser(remote);
    if (!isLidUser(normalized)) return ingest.canonicalJid(normalized);
    const alt = message.key.remoteJidAlt;
    if (alt && isPnUser(alt)) ingest.learnMapping(alt, normalized);
    if (!directory.mappings.has(normalized) && link.socket) {
      try {
        const pn = await link.socket.signalRepository.lidMapping.getPNForLID(normalized);
        if (pn) ingest.learnMapping(pn, normalized);
      } catch (error) {
        logger(`LID lookup failed for ${normalized}: ${describeError(error)}`);
      }
    }
    return ingest.canonicalJid(normalized);
  }

  /** Read receipt for the given messages; the Baileys keys never leave this closure. */
  function receiptFor(keys: (WAMessageKey & { id: string; remoteJid: string })[]): () => Promise<void> {
    const receiptKeys = keys.map(key => ({ ...key, fromMe: false }));
    return async () => {
      if (!link.socket || !link.open) throw new Error("WhatsApp is not connected");
      await link.socket.readMessages(receiptKeys);
    };
  }

  /** Prompt text (with the quote prefix) and downloaded photos of one message; undefined when it must not be forwarded. */
  async function contentOf(message: WAMessage, id: string, contactName: string): Promise<{ text: string; attachments: Attachment[] } | undefined> {
    const image = extractImage(message);
    if (image) {
      const attachments = await downloadPhoto(message, id, contactName, image);
      return attachments && { text: withQuote(message, image.caption), attachments };
    }
    const text = extractText(message);
    return text === undefined ? undefined : { text: withQuote(message, text), attachments: [] };
  }

  function remember(id: string): void {
    forwarded.add(id);
    if (forwarded.size > MAX_REMEMBERED_IDS) forwarded.delete(forwarded.values().next().value ?? id);
  }

  /** Resolves true when the message was handed to `onMessage`. */
  async function handleLiveMessage(message: WAMessage): Promise<boolean> {
    const jid = await resolveIncomingJid(message);
    if (!jid) return false;
    const sentAt = messageSeconds(message);
    const existing = directory.chats.get(jid);
    if (!message.key.fromMe) ingest.upsertRecord(jid, { notify: message.pushName ?? undefined });
    directory.chats.set(jid, {
      jid, name: existing?.name ?? directory.records.get(jid)?.name ?? message.pushName ?? jid,
      lastMessageAt: sentAt ?? existing?.lastMessageAt ?? null,
      unread: existing?.unread ?? 0, archived: existing?.archived ?? false,
    });
    saver.schedule();
    const { id, remoteJid } = message.key;
    if (message.key.fromMe || !id || !remoteJid) return false;
    if (sentAt === undefined || sentAt < link.cutoffSeconds || forwarded.has(id)) return false;
    const contact = ingest.toContact(directory.records.get(jid) ?? { jid });
    const content = await contentOf(message, id, contact.name);
    if (!content) return false;
    remember(id);
    onMessage({ id, contact, ...content, acknowledge: receiptFor([{ ...message.key, id, remoteJid }]) });
    return true;
  }

  /**
   * Hands the unanswered messages of ONE chat to `onMessage` as a single prompt (texts oldest first, photos attached, quote prefixes
   * kept), so recovery never costs more than one assistant turn per chat. The prompt takes the newest message's ID, which is what
   * the delivery journal records. No time cutoff applies: the caller already decided these are unanswered.
   */
  async function handleRecovered(messages: WAMessage[]): Promise<number> {
    const parts: { id: string; key: WAMessageKey & { id: string; remoteJid: string }; text: string; attachments: Attachment[] }[] = [];
    let contact: IncomingMessage["contact"] | undefined;
    for (const message of messages) {
      const { id, remoteJid, fromMe } = message.key;
      if (fromMe || !id || !remoteJid || forwarded.has(id)) continue;
      const jid = await resolveIncomingJid(message);
      if (!jid) continue;
      contact ??= ingest.toContact(directory.records.get(jid) ?? { jid });
      const content = await contentOf(message, id, contact.name);
      if (content) parts.push({ id, key: { ...message.key, id, remoteJid }, ...content });
    }
    const newest = parts.at(-1);
    if (!newest || !contact) return 0;
    for (const part of parts) remember(part.id);
    onMessage({
      id: newest.id, contact,
      text: parts.map(part => part.text).filter(text => text.length > 0).join("\n\n"),
      attachments: parts.flatMap(part => part.attachments),
      acknowledge: receiptFor(parts.map(part => part.key)),
    });
    return parts.length;
  }

  /** Saves the photo under the media store; returns undefined (after logging why) when it must not be forwarded. */
  async function downloadPhoto(message: WAMessage, id: string, contactName: string, image: ImageContent): Promise<Attachment[] | undefined> {
    if (image.declaredBytes !== undefined && image.declaredBytes > MAX_MEDIA_BYTES) {
      logger(`Skipped a photo from ${contactName}: ${image.declaredBytes} bytes exceeds the ${MAX_MEDIA_BYTES} byte limit.`);
      return undefined;
    }
    try {
      const bytes = await download(message);
      if (bytes.length > MAX_MEDIA_BYTES) {
        logger(`Skipped a photo from ${contactName}: ${bytes.length} bytes exceeds the ${MAX_MEDIA_BYTES} byte limit.`);
        return undefined;
      }
      const fileName = `${id}.${imageExtension(image.mimeType)}`;
      const path = await media.allocate(fileName);
      await writeFile(path, bytes);
      return [{ kind: "image", path, fileName, mimeType: image.mimeType }];
    } catch (error) {
      logger(`Could not download the photo from ${contactName}: ${describeError(error)}`);
      return undefined;
    }
  }

  function enqueue(messages: WAMessage[], backlog: boolean): void {
    const ordered = [...messages].sort((a, b) => (messageSeconds(a) ?? 0) - (messageSeconds(b) ?? 0));
    queue = queue.then(async () => {
      let caughtUp = 0;
      for (const message of ordered) {
        try {
          if (await handleLiveMessage(message) && backlog) caughtUp += 1;
        } catch (error) {
          logger(`Failed to handle WhatsApp message ${message.key.id ?? "?"}: ${describeError(error)}`);
        }
      }
      if (caughtUp > 0) logger(`Caught up: relayed ${caughtUp} message${caughtUp === 1 ? "" : "s"} sent while warelay was offline.`);
    });
  }

  return {
    attach(ev): () => void {
      const onUpsert = (upsert: BaileysEventMap["messages.upsert"]): void => {
        if (upsert.type === "append" || upsert.messages.length > 1) logger(`WhatsApp delivered ${upsert.messages.length} ${upsert.type === "append" ? "offline " : ""}message(s).`);
        enqueue(upsert.messages, upsert.type === "append");
      };
      ev.on("messages.upsert", onUpsert);
      return () => { ev.off("messages.upsert", onUpsert); };
    },
    forwardRecovered(messages): Promise<number> {
      const ordered = [...messages].sort((a, b) => (messageSeconds(a) ?? 0) - (messageSeconds(b) ?? 0));
      const done = queue.then(() => handleRecovered(ordered));
      queue = done.then(() => undefined, () => undefined);
      return done;
    },
    async drain(): Promise<void> {
      await queue.catch(() => undefined);
    },
  };
}
