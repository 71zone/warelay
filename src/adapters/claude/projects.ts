import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { Logger, Project } from '../../core/contracts.js';
import type { CatalogRun } from '../browseros/session.js';
import { normalizeProjectUrl } from './references.js';

/**
 * Page script (BrowserOS evaluateInPage on https://claude.ai/projects) that reads the project cards and scrolls the list to its end so Claude loads its next page.
 * DOM facts (observed live): each project is one `a[href="/project/<uuid>"]` whose text is the project name (inside a tooltip span); the page fetches them
 * 30 at a time (`projects_v2?limit=30&offset=...`), and scrolls inside `[data-testid="pane-scroller"]`. Labels are localized, so only hrefs and test ids are used.
 */
export const claudeProjectsScript = String.raw`() => {
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const scroller = document.querySelector('[data-testid="pane-scroller"]');
  const projects = [];
  for (const link of document.querySelectorAll('a[href^="/project/"]')) {
    const match = /^\/project\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i.exec(link.getAttribute('href') || '');
    if (match) projects.push({ id: match[1], name: clean(link.textContent) });
  }
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  return {
    path: location.pathname,
    loginRequired: /^\/(login|logout|signup|magic-link|oauth)/.test(location.pathname) || !!document.querySelector('input[type="email"]'),
    challenge: /just a moment|verify you are human/i.test(document.title || '') || !!document.querySelector('#challenge-form,iframe[src*="challenges.cloudflare.com"]'),
    ready: !!scroller && location.pathname === '/projects',
    busy: scroller ? scroller.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-testid*="skeleton"]').length : 0,
    projects,
  };
}`;

const probeSchema = z.object({
  path: z.string(),
  loginRequired: z.boolean(),
  challenge: z.boolean(),
  ready: z.boolean(),
  busy: z.number(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
});
const evaluated = z.object({ value: z.unknown() });

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Canonicalizes project rows into the sorted, unique catalog; throws on rows it cannot name or address rather than dropping them. */
export function mergeProjects(rows: { id: string; name: string }[]): Project[] {
  const byRef = new Map<string, Project>();
  for (const row of rows) {
    const name = row.name.replace(/\s+/g, ' ').trim();
    let ref: string;
    try { ref = normalizeProjectUrl(`https://claude.ai/project/${row.id}`); }
    catch { throw new Error(`Claude's project list contains an entry with an unrecognised id (${JSON.stringify(row.id)}). Update wabgpt before choosing a project.`); }
    if (!name) throw new Error("Claude's project list contains a project without a readable name. Update wabgpt before choosing a project.");
    if (!byRef.has(ref)) byRef.set(ref, { name, ref });
  }
  return [...byRef.values()].sort((a, b) => collator.compare(a.name, b.name) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

const READY_TIMEOUT_MS = 45_000;
const POLL_MS = 750;
/** Projects Claude loads per request; a list this long may continue, so it only counts as complete after scrolling stops adding projects. */
const PAGE_SIZE = 30;
// A first read after navigation can precede Claude's own fetch, so an answer is accepted only once successive reads agree.
const STABLE_READS = 3;
const STABLE_READS_LONG = 5;
const STABLE_READS_EMPTY = 6;

const signedOut = 'Claude is signed out in BrowserOS. Sign in there, then refresh the project list.';
const challenged = 'Claude is showing a verification challenge in BrowserOS. Complete it there, then refresh the project list.';

/**
 * Reads the full project catalog through an already-open Claude tab (page id in the BrowserOS session behind `run`).
 * Resolves only for a complete, positively identified list; every login, challenge, unreadable or not-ready state throws. Each read scrolls the list to its end, so
 * a catalog longer than Claude's page size is only accepted once further reads stop finding new projects. The tab is navigated to /projects, so the caller owns it exclusively.
 * `signal` cancels every request and poll wait; cancellation rejects with the signal's reason or an AbortError.
 */
export async function readProjectCatalog(run: CatalogRun, pageId: number, _warn: Logger, signal?: AbortSignal): Promise<Project[]> {
  await run(`await browser.page(${pageId}).goto('https://claude.ai/projects');return true;`, signal);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let previous = '';
  let stable = 0;
  let last: z.infer<typeof probeSchema> | null = null;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    last = probeSchema.parse(evaluated.parse(await run(`return await browser.page(${pageId}).evaluateInPage(${claudeProjectsScript});`, signal)).value);
    if (last.loginRequired) throw new Error(signedOut);
    if (last.challenge) throw new Error(challenged);
    const signature = JSON.stringify(last.projects);
    stable = last.ready && last.busy === 0 && signature === previous ? stable + 1 : 0;
    previous = signature;
    const needed = last.projects.length === 0 ? STABLE_READS_EMPTY : last.projects.length >= PAGE_SIZE ? STABLE_READS_LONG : STABLE_READS;
    if (last.ready && stable + 1 >= needed) return mergeProjects(last.projects);
    await setTimeout(POLL_MS, undefined, { signal });
  }
  if (last && !last.ready) throw new Error(`Claude's Projects page did not load in BrowserOS (it is on ${last.path}). Check the page and refresh the project list.`);
  throw new Error("Claude's project list did not finish loading in time. Refresh the project list.");
}
