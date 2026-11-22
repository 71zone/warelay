import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { NotSentError, UsageLimitError, type AssistantAdapter, type AssistantReferencePolicy, type Attachment, type Logger, type Project, type ProviderId, type ReplyBlock } from '../../core/contracts.js';
import { lostContent } from '../../core/coverage.js';
import { parseResetAt } from '../../core/usage-limit.js';
import { parseLocalMcpEndpoint } from '../../infrastructure/loopback.js';
import type { MediaStore } from '../../infrastructure/media.js';
import { isExpiredSession } from './mcp.js';
import { resolveBlocks } from './assets.js';
import { extraction } from './extraction.js';
import { createBrowserSession, type CatalogRun } from './session.js';

/** The page a prompt is meant for: a saved conversation, a project's new-chat landing, or (both null) the provider's new-conversation page. */
export interface Destination { conversationUrl: string | null; projectUrl: string | null }

/**
 * Everything that differs between assistant providers driven through BrowserOS: where their pages live, how to read and operate them, and how to list projects.
 * The scripts are page-side or BrowserOS-side source strings; the engine below owns the sequencing, the retry and not-sent rules and the waiting.
 */
export interface AssistantDriver {
  id: ProviderId;
  /** Display name for log and error text. */
  name: string;
  /** The new-conversation page, also where the delivery tab starts. Read on every use, so it may follow settings that change at runtime (for example the signed-in account). */
  home(): string;
  references: AssistantReferencePolicy;
  /** JavaScript expression over the interactive `snapshot` that is true once the page offers the message composer. */
  composerReady: string;
  /** BrowserOS script fragment that waits for `url` to hydrate after `page` was opened or navigated to it. */
  settle(page: string, url: string): string;
  /** Pathname regex source a page must satisfy to count as `destination`. */
  destinationPathPattern(destination: Destination): string;
  isDestination(url: string, destination: Destination): boolean;
  /** True when `url` is a conversation page of any scope. */
  isConversationPage(url: string): boolean;
  /**
   * Page script reading the newest turn, or the turn of its argument (a user message id): see {@link inspection}. It runs every second while a reply generates.
   * `limit` is the text of a usage-limit notice the page shows, null otherwise.
   */
  inspectionScript: string;
  /** Page script (async) that scrolls the conversation until the newest turn, or the turn of its argument, is mounted, and returns `{ found }`. */
  revealScript: string;
  /** Page script converting the reply of the newest turn, or of its argument, into an {@link extraction}. */
  extractionScript: string;
  /** Page script returning how many attachments the composer holds and how many of them are still uploading. */
  composerAttachmentsScript: string;
  /** BrowserOS script that puts `files` in the composer of the delivery tab, re-checking that the tab is still on `pathPattern`. It may return before the uploads finish. */
  uploadScript(pageId: number, pathPattern: string, files: string[]): string;
  /**
   * BrowserOS script that fills the composer and sends, re-checking that the tab is still on `pathPattern` and, with `attachments` > 0, that exactly that many
   * finished uploads are in the composer. It returns `{ url }`, the page address after sending.
   */
  submitScript(pageId: number, pathPattern: string, text: string, attachments: number): string;
  /** Optional: why a page that is not the destination is the wrong one (another account, signed out), as the user-readable reason a prompt was not sent; null when there is nothing more specific to say. */
  misplaced?(url: string): string | null;
  /** Optional page script returning who is signed in (an email address) or null, logged once per change before a prompt is sent. Best effort: a failing script never stops a message. */
  identityScript?: string;
  /** Reads the complete project catalog through the scratch tab `pageId` (see BrowserSession.readCatalog). */
  readProjects(run: CatalogRun, pageId: number, warn: Logger, signal: AbortSignal): Promise<Project[]>;
}

const inspection = z.object({ url: z.string(), userId: z.string().nullable(), assistantId: z.string().nullable(), text: z.string(), complete: z.boolean(), busy: z.boolean(), error: z.string().nullable(), limit: z.string().nullable(), media: z.boolean() });
const composerState = z.object({ tiles: z.number(), uploading: z.number(), error: z.string().nullable() });
const revealState = z.object({ found: z.boolean() });
/** A submitted prompt is abandoned only after the provider shows no progress (not generating, text unchanged, or unreachable) for this long. */
const IDLE_LIMIT_MS = 5 * 60_000;
/** Absolute ceiling on one reply, however much progress it shows. */
const MAX_WAIT_MS = 60 * 60_000;
/** The provider must finish uploading the attachments of one prompt within this long, or the prompt is not sent. */
const UPLOAD_LIMIT_MS = 3 * 60_000;
const UPLOAD_POLL_MS = 500;

/**
 * An assistant provider through BrowserOS Neo. A conversation or project reference is the provider's canonical URL, so refs map to the pages the tab visits
 * without translation. One delivery tab lives in one app-owned tab group; project listing uses its own MCP client and scratch tab and never touches delivery state.
 */
export function createBrowserAssistant(driver: AssistantDriver, options: { endpoint: string; logger: Logger; media: MediaStore }): AssistantAdapter {
  const { name } = driver;
  const browser = createBrowserSession({ endpoint: parseLocalMcpEndpoint(options.endpoint), logger: options.logger, name, home: driver.home, composerReady: driver.composerReady, settle: driver.settle });
  let working = false;
  let lastRevealFailure = '';
  let lastIdentity: string | null = null;

  async function inspect(targetUserId: string | null = null): Promise<z.infer<typeof inspection>> {
    return inspection.parse(await browser.evaluate(driver.inspectionScript, targetUserId));
  }
  async function composerAttachments(): Promise<z.infer<typeof composerState>> {
    return composerState.parse(await browser.evaluate(driver.composerAttachmentsScript));
  }
  /** Puts `files` in the composer and waits until the provider has finished uploading every one. Nothing is submitted, so any failure here leaves the prompt unsent. */
  async function attach(files: Attachment[], pathPattern: string): Promise<void> {
    const pageId = browser.pageId;
    if (pageId === null) throw new Error(`${name} tab is not open.`);
    try {
      if ((await composerAttachments()).tiles > 0) throw new Error(`The ${name} composer already holds attachments from an earlier attempt; no prompt submitted.`);
      await browser.run(driver.uploadScript(pageId, pathPattern, files.map(file => file.path)));
      const deadline = Date.now() + UPLOAD_LIMIT_MS;
      let steady = 0;
      for (;;) {
        const state = await composerAttachments();
        steady = state.tiles === files.length && state.uploading === 0 ? steady + 1 : 0;
        if (steady >= 2) return;
        if (Date.now() >= deadline) throw new Error(`${name} did not finish uploading ${files.length === 1 ? 'the attachment' : 'the attachments'} (${state.tiles} of ${files.length} present, ${state.uploading} still uploading)${state.error ? `: ${state.error}` : ''}. No prompt submitted.`);
        await setTimeout(UPLOAD_POLL_MS);
      }
    } catch (error) {
      // A failed attempt can leave half-uploaded tiles in the composer, so the next attempt must start from a freshly loaded page.
      browser.currentUrl = null;
      throw error;
    }
  }
  /**
   * Scrolls the conversation to its end so the provider mounts the newest turn, or the turn of `targetUserId`. Providers drop turns that are far from the
   * viewport, including a finished reply in a tab that sits at the top of a long conversation. Best effort: the next inspection reports a real failure.
   */
  async function reveal(targetUserId: string | null): Promise<boolean> {
    if (browser.pageId === null) return false;
    try { return revealState.parse(await browser.evaluate(driver.revealScript, targetUserId)).found; }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== lastRevealFailure) options.logger(`Could not scroll ${name} to its newest message (${reason}).`);
      lastRevealFailure = reason;
      return false;
    }
  }
  /** Display-ordered blocks of the completed reply; any failure to read its structure falls back to the plain text so a finished reply is never lost. */
  async function readBlocks(text: string, targetUserId: string): Promise<ReplyBlock[]> {
    const plain: ReplyBlock[] = text.trim() ? [{ type: 'markdown', text }] : [];
    const pageId = browser.pageId;
    if (pageId === null) return plain;
    try {
      await reveal(targetUserId);
      const value = await browser.evaluate(driver.extractionScript, targetUserId);
      const blocks = await resolveBlocks(extraction.parse(value), { run: browser.run, pageId, media: options.media, logger: options.logger, provider: name });
      if (blocks.length === 0) return plain;
      if (lostContent(blocks, text)) {
        options.logger(`${name}'s reply lost content when its structure was read; delivering its plain text.`);
        return [...plain, ...blocks.filter(block => block.type === 'attachment')];
      }
      return blocks;
    } catch (error) {
      options.logger(`Could not read the structure of ${name}'s reply (${error instanceof Error ? error.message : String(error)}); delivering its plain text.`);
      return plain;
    }
  }
  async function announceIdentity(): Promise<void> {
    if (!driver.identityScript) return;
    try {
      const identity = z.string().nullable().parse(await browser.evaluate(driver.identityScript));
      if (identity && identity !== lastIdentity) options.logger(`${name} is signed in as ${identity}.`);
      lastIdentity = identity;
    } catch { /* best effort */ }
  }
  const limited = (limit: string): UsageLimitError => new UsageLimitError(driver.id, parseResetAt(limit, Date.now()), `${name}: ${limit}`);

  return {
    id: driver.id,
    references: driver.references,
    async start(): Promise<void> {
      await browser.start(() => working);
      if (!working && browser.pageId !== null) await announceIdentity();
    },
    stop: () => browser.stop(),
    listProjects(signal?: AbortSignal): Promise<Project[]> { return browser.readCatalog((run, pageId, catalogSignal) => driver.readProjects(run, pageId, options.logger, catalogSignal), signal); },
    async reply(input): Promise<{ conversationRef: string; text: string; blocks?: ReplyBlock[] }> {
      if (working) throw new Error('Browser adapter is already processing a message.');
      working = true;
      let reconnected = false;
      let submitted = false;
      let acknowledged = false;
      let submittedUserId: string | null = null;
      let saved: string | null = null;
      try {
        if (!browser.connected) throw new Error('Connect BrowserOS first.');
        const projectUrl = input.projectRef === null ? null : driver.references.normalizeProject(input.projectRef);
        const conversationUrl = input.conversationRef === null ? null : driver.references.normalizeConversation(input.conversationRef, projectUrl);
        const destination: Destination = { conversationUrl, projectUrl };
        const pathPattern = driver.destinationPathPattern(destination);
        const target = conversationUrl ?? projectUrl ?? driver.home();
        saved = conversationUrl;
        const failure = conversationUrl
          ? 'Saved conversation did not load. Restore access rather than creating a replacement.'
          : projectUrl ? `The assigned ${name} project did not load (missing, renamed away, or redirected). No prompt submitted.` : `${name} did not open a new conversation page. No prompt submitted.`;
        const remember = async (url: string): Promise<void> => {
          if (!driver.isConversationPage(url)) return;
          let conversation: string;
          try { conversation = driver.references.normalizeConversation(url, projectUrl); }
          catch { throw new Error(`${name} opened a conversation outside the assigned scope.`); }
          if (saved && conversation !== saved) throw new Error(`${name} switched conversations unexpectedly.`);
          if (!saved) { await input.onConversation(conversation); saved = conversation; }
          browser.currentUrl = conversation;
        };
        let attempting = false;
        const submit = async () => {
          attempting = false;
          await browser.ping();
          let navigated = false;
          if (browser.pageId === null) { await browser.openPage(target); navigated = true; }
          else if (!conversationUrl || browser.currentUrl !== target) { await browser.navigate(target); navigated = true; }
          // A freshly loaded long conversation starts at its top, where the newest turn is not mounted: bring it into view so the first read sees the real latest turn.
          if (conversationUrl) await reveal(null);
          let before = await inspect();
          if (!navigated && !driver.isDestination(before.url, destination)) { await browser.navigate(target); before = await inspect(); }
          if (!driver.isDestination(before.url, destination)) throw new Error(driver.misplaced?.(before.url) ?? failure);
          await announceIdentity();
          // Nothing has been typed or clicked yet, so a provider that is already over its limit is a clean "not accepted" for the router to move past.
          if (before.limit) throw limited(before.limit);
          if (before.busy) throw new Error('This conversation is already generating a response.');
          if (before.error) throw new Error(`${name}: ${before.error}`);
          const pageId = browser.pageId;
          if (pageId === null) throw new Error(`${name} tab is not open.`);
          if (input.attachments.length > 0) await attach(input.attachments, pathPattern);
          attempting = true;
          const sent = await browser.run(driver.submitScript(pageId, pathPattern, input.text, input.attachments.length));
          submitted = true;
          await remember(z.object({ url: z.string() }).parse(sent).url);
          return before;
        };
        let before;
        try {
          try { before = await submit(); }
          catch (error) {
            if (!isExpiredSession(error) || submitted) throw error;
            reconnected = true; await browser.reconnect(target); before = await submit();
          }
        } catch (error) {
          // Files staged in the composer would ride along with whatever is sent from this page next, so a failure before submission discards the page state.
          if (input.attachments.length > 0 && !submitted) browser.currentUrl = null;
          // Nothing reached the provider unless the submit click itself was attempted, so the bridge may safely try this same message again.
          if (attempting || submitted || error instanceof NotSentError || error instanceof UsageLimitError) throw error;
          throw new NotSentError(error instanceof Error ? error.message : String(error), { cause: error });
        }
        // Wait for as long as the provider makes progress. A slow answer (long thinking, long generation) is not a failure, and a dropped BrowserOS
        // connection is retried rather than abandoned; only a page that stays silent for IDLE_LIMIT_MS, or the absolute ceiling, gives up.
        const startedAt = Date.now();
        let lastProgress = startedAt;
        let lastText = '';
        let lastFailure: unknown;
        let lastSeen = '';
        let failures = 0;
        let pinned = false;
        while (Date.now() - startedAt < MAX_WAIT_MS) {
          let observed;
          try { observed = await inspect(submittedUserId); failures = 0; }
          catch (error) {
            if (Date.now() - lastProgress >= IDLE_LIMIT_MS) throw error;
            lastFailure = error; failures++;
            if (failures === 1 || failures % 10 === 0) options.logger(`Lost contact with ${name} (${error instanceof Error ? error.message : String(error)}); retrying. The submitted message is not resent.`);
            await setTimeout(Math.min(1000 * failures, 10000));
            try { if ((isExpiredSession(error) || !browser.connected) && saved) await browser.reconnect(saved); } catch (reconnectError) { lastFailure = reconnectError; }
            continue;
          }
          await remember(observed.url);
          if (observed.error) throw new Error(`${name}: ${observed.error}`);
          if (!submittedUserId && observed.userId && observed.userId !== before.userId) submittedUserId = observed.userId;
          const present = submittedUserId !== null && observed.userId === submittedUserId;
          if (saved && present && !acknowledged) {
            acknowledged = true;
            await input.onSubmitted();
          }
          // A reply that arrived in full wins over a limit notice shown beside it: the provider often warns right after the last allowed message.
          if (saved && submittedUserId && present && observed.assistantId && observed.complete && !observed.busy && (observed.text.trim() || observed.media)) return { conversationRef: saved, text: observed.text, blocks: await readBlocks(observed.text, submittedUserId) };
          if (observed.limit) throw limited(observed.limit);
          if (observed.busy || observed.text !== lastText) { lastProgress = Date.now(); lastText = observed.text; }
          if (Date.now() - lastProgress >= IDLE_LIMIT_MS) break;
          // The provider drops a finished turn that is far from the viewport (or leaves an empty shell of it), and the reply can no longer be read. Scroll to the
          // newest turn once the message is on the page so it stays mounted, and again whenever it goes missing. A message that never shows up at all gets
          // one scroll too, since its turn may simply not be mounted yet.
          const hollow = present && observed.complete && !observed.busy && !observed.text.trim() && !observed.media;
          lastSeen = !present ? `the submitted message is not on the ${name} page` : hollow ? 'the reply has no text on the page' : !observed.complete ? `${name} has not marked the reply complete` : '';
          const missing = submittedUserId !== null && (!present || hollow);
          const unseen = submittedUserId === null && Date.now() - startedAt >= 5000;
          if (missing || (!pinned && (submittedUserId !== null || unseen))) {
            pinned = true;
            await reveal(submittedUserId);
            await setTimeout(250);
            continue;
          }
          await setTimeout(1000);
        }
        const reason = lastFailure instanceof Error ? ` Last error: ${lastFailure.message}` : '';
        const seen = lastSeen ? ` Last seen: ${lastSeen}.` : '';
        throw new Error(`${name} response timed out after submission (no progress for ${Math.round(IDLE_LIMIT_MS / 60000)} minutes or over ${Math.round(MAX_WAIT_MS / 60000)} minutes total).${reason}${seen} Inspect the saved conversation; do not resend automatically.`);
      } finally { working = false; }
    },
  };
}
