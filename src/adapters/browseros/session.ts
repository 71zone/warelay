import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Logger, Project } from '../../core/contracts.js';
import { SingleFlight } from '../../core/single-flight.js';
import { isExpiredSession, listPagesPrelude, openMcp, reclaimTabGroup, runScript } from './mcp.js';

/** Upper bound for closing the catalog's scratch tab after the read ended or was cancelled. */
const SCRATCH_CLEANUP_MS = 5000;

const pageResult = z.object({ pageId: z.number(), ready: z.boolean(), groupId: z.string() });

/** Runs one BrowserOS script in the catalog's scratch session; `signal` cancels that one request. */
export type CatalogRun = (code: string, signal?: AbortSignal) => Promise<unknown>;

export interface BrowserSessionOptions {
  endpoint: URL;
  logger: Logger;
  /** Display name of the assistant provider, for log and error text. */
  name: string;
  /** The provider's new-conversation page: where the delivery tab starts and what the catalog's scratch tab opens. */
  home: string;
  /** JavaScript expression over the interactive `snapshot` that is true once the page offers the message composer. */
  composerReady: string;
  /** BrowserOS script fragment that waits for `url` to hydrate after `page` was opened or navigated to it; nothing for pages that need no wait. */
  settle: (page: string, url: string) => string;
}

/**
 * One provider's presence in BrowserOS Neo: an MCP client, the app-owned tab group and the one delivery tab in it. A tab group belongs to the MCP session that
 * created it, so after the session expires the group is reclaimed through a fresh one and the held tab is recovered. The project catalog uses its own MCP
 * client and scratch tab and never reads or writes delivery state.
 */
export interface BrowserSession {
  /** Runs one BrowserOS script on the delivery session; `maxChars` raises the size cap of the script's result (default 500000). */
  run(code: string, maxChars?: number): Promise<unknown>;
  /** Runs `script` inside the delivery page (evaluateInPage), passing `argument` when given, and returns its value. */
  evaluate(script: string, argument?: unknown): Promise<unknown>;
  readonly connected: boolean;
  /** Id of the delivery tab, null while none is open. */
  readonly pageId: number | null;
  /** The URL the delivery tab was last put on by this session; null forces the next use to load the page afresh. */
  currentUrl: string | null;
  connect(): Promise<void>;
  ping(): Promise<void>;
  /** Connects and verifies the composer; `busy` reports a message in flight, which makes start only confirm reachability. Throws a readable error when the page is not usable. */
  start(busy: () => boolean): Promise<void>;
  /** Opens the delivery tab on `url`, or navigates the held one when it is elsewhere; throws when the composer does not appear. */
  openPage(url: string): Promise<void>;
  /** Navigates the held delivery tab to `url`. */
  navigate(url: string): Promise<void>;
  /** Reconnects after an expired MCP session and puts the app-owned delivery tab back on `url`. */
  reconnect(url: string): Promise<void>;
  /** Cancels any catalog read, closes the delivery tab and disconnects. */
  stop(): Promise<void>;
  /**
   * Reads a project catalog in a temporary tab of its own MCP client: `read` gets the scratch tab's page id and a runner bound to the scratch session.
   * `signal` cancels every request and wait; cleanup runs on a fresh bounded signal so a hung browser cannot hold the caller.
   */
  readCatalog(read: (run: CatalogRun, pageId: number, signal: AbortSignal) => Promise<Project[]>, signal?: AbortSignal): Promise<Project[]>;
}

export function createBrowserSession(options: BrowserSessionOptions): BrowserSession {
  const { endpoint, logger, name, home, composerReady, settle } = options;
  let client: Client | null = null;
  let runName = '';
  let pageId: number | null = null;
  let groupId: string | null = null;
  let session: string | undefined;
  let currentUrl: string | null = null;
  const catalog = new SingleFlight<Project[]>();

  async function run(code: string, maxChars?: number): Promise<unknown> {
    if (!client) throw new Error('BrowserOS is not connected.');
    const result = await runScript({ client, runName }, code, session, undefined, maxChars);
    session = result.session;
    return result.value;
  }
  async function disconnect(): Promise<void> {
    const previous = client;
    client = null; session = undefined; runName = '';
    await previous?.close().catch(() => undefined);
  }
  async function connect(): Promise<void> {
    if (client) return;
    const opened = await openMcp(endpoint);
    try {
      runName = opened.runName; client = opened.client;
      const listed = await run(`${listPagesPrelude}return await listPages();`);
      if (pageId !== null && groupId) {
        const pages = z.array(z.object({ pageId: z.number(), groupId: z.string().nullable().optional() })).parse(listed);
        if (pages.some(page => page.pageId === pageId && page.groupId === groupId)) {
          await reclaimTabGroup(opened, groupId);
          const held = await run(`${listPagesPrelude}const pages=await listPages();const held=pages.find(page=>page.pageId===${pageId}&&page.groupId===${JSON.stringify(groupId)});for(const page of pages.filter(page=>page.groupId===${JSON.stringify(groupId)}&&page.ownership!=='user'&&page.url==='about:blank'&&!${JSON.stringify(pages.map(page => page.pageId))}.includes(page.pageId)))await browser.page(page.pageId).close();return held?{pageId:held.pageId,url:held.url}:null;`);
          const recovered = z.object({ pageId: z.number(), url: z.string() }).nullable().parse(held);
          pageId = recovered?.pageId ?? null; currentUrl = recovered?.url ?? null;
        } else { pageId = null; groupId = null; currentUrl = null; }
      }
    } catch (error) { await opened.client.close().catch(() => undefined); client = null; throw error; }
  }
  async function openPage(url: string): Promise<void> {
    const value = await run(`${listPagesPrelude}const page=${pageId === null ? `await browser.open(${JSON.stringify(url)})` : `browser.page(${pageId})`};${pageId !== null && currentUrl !== url ? `await page.goto(${JSON.stringify(url)});` : ''}${settle('page', url)}const snapshot=await page.snapshot({mode:'interactive'});const own=(await listPages()).find(item=>item.pageId===page.id);return {pageId:page.id,groupId:own?.groupId,ready:${composerReady}};`);
    const parsed = pageResult.parse(value);
    pageId = parsed.pageId; groupId = parsed.groupId; currentUrl = url;
    if (!parsed.ready) throw new Error(`${name} composer not found. Sign in or complete verification in BrowserOS, then check Browser again.`);
  }
  async function reconnect(url: string): Promise<void> {
    logger(`BrowserOS session expired. Reconnecting and reusing the app-owned ${name} tab.`);
    await disconnect(); await connect(); await openPage(url);
    logger('BrowserOS reconnected.');
  }
  async function ping(): Promise<void> {
    if (!client) throw new Error('BrowserOS is not connected.');
    await client.ping({ timeout: 10000 });
  }

  // `signal` is the catalog's own controller signal. It cancels every request and wait; the cleanup below never uses it (it is already aborted), and instead
  // runs on a fresh bounded signal so a hung browser cannot hold the caller. Closing the independent client in finally also aborts any HTTP exchange the
  // SDK abandoned when a request was cancelled, so no provider work outlives this function.
  async function readCatalog(read: (run: CatalogRun, pageId: number, signal: AbortSignal) => Promise<Project[]>, signal: AbortSignal): Promise<Project[]> {
    const connection = await openMcp(endpoint, signal);
    let handle: string | undefined;
    const call: CatalogRun = async (code, callSignal) => {
      const result = await runScript(connection, code, handle, callSignal);
      handle = result.session;
      return result.value;
    };
    let scratch: number | null = null;
    try {
      scratch = z.number().parse(await call(`const page=await browser.open(${JSON.stringify(home)});return page.id;`, signal));
      return await read(call, scratch, signal);
    } catch (error) {
      throw signal.aborted ? signal.reason : error;
    } finally {
      try { if (scratch !== null) await call(`await browser.page(${scratch}).close();return true;`, AbortSignal.timeout(SCRATCH_CLEANUP_MS)); }
      catch (error) { logger(`Could not close the temporary ${name} tab used for the project list: ${error instanceof Error ? error.message : String(error)}`); }
      await connection.client.close().catch(() => undefined);
    }
  }

  return {
    run,
    evaluate: (script, argument) => run(`const result = await browser.page(${JSON.stringify(pageId)}).evaluateInPage(${script}${argument === undefined ? '' : `,${JSON.stringify(argument)}`}); return result.value;`),
    get connected() { return client !== null; },
    get pageId() { return pageId; },
    get currentUrl() { return currentUrl; },
    set currentUrl(url) { currentUrl = url; },
    connect,
    ping,
    async start(busy): Promise<void> {
      for (let attempt = 0; ; attempt++) {
        try {
          await connect(); await ping();
          if (busy()) { logger(`BrowserOS is reachable. ${name} is processing the current message.`); return; }
          if (pageId === null) await openPage(home);
          else {
            const ready = await run(`const snapshot=await browser.page(${pageId}).snapshot({mode:'interactive'}); return ${composerReady};`);
            if (ready !== true) throw new Error(`${name} composer unavailable. Check sign-in in BrowserOS.`);
          }
          logger(`Connected to BrowserOS Neo; ${name} composer is available.`);
          return;
        } catch (error) {
          if (!isExpiredSession(error) || attempt > 0 || busy()) throw error;
          logger('BrowserOS session expired. Establishing a new MCP connection.');
          await disconnect();
        }
      }
    },
    openPage,
    async navigate(url): Promise<void> {
      await run(`const page=browser.page(${pageId}); await page.goto(${JSON.stringify(url)});${settle('page', url)} return true;`);
      currentUrl = url;
    },
    reconnect,
    async stop(): Promise<void> {
      catalog.cancel(new Error(`${name} adapter stopped.`));
      await catalog.drained();
      if (!client) return;
      try { if (pageId !== null) await run(`await browser.page(${pageId}).close(); return true;`); }
      catch (error) {
        if (!isExpiredSession(error)) throw error;
        await disconnect(); await connect();
        if (pageId !== null) await run(`await browser.page(${pageId}).close(); return true;`);
      } finally { await disconnect(); pageId = null; groupId = null; currentUrl = null; }
    },
    readCatalog(read, signal) { return catalog.join(catalogSignal => readCatalog(read, catalogSignal), signal); },
  };
}
