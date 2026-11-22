import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { claudeProjectsScript, mergeProjects, readProjectCatalog } from '../src/adapters/claude/projects.js';

const id = (n: number): string => `019ffab2-5e84-7108-850c-${String(n).padStart(12, '0')}`;
const card = (n: number, name: string): string => `<a data-cds="CardLink" data-primary="true" href="/project/${id(n)}"><span><span data-cds="OverflowTooltip">${name}</span></span></a>`;

function probe(html: string, path = '/projects'): { path: string; loginRequired: boolean; ready: boolean; projects: { id: string; name: string }[] } {
  const { document } = parseHTML(html);
  const value = runInNewContext(`(${claudeProjectsScript})()`, { document, location: { pathname: path, href: `https://claude.ai${path}` } }) as { path: string; loginRequired: boolean; ready: boolean; projects: { id: string; name: string }[] };
  return { path: value.path, loginRequired: value.loginRequired, ready: value.ready, projects: Array.from(value.projects, project => ({ id: project.id, name: project.name })) };
}

test('the page script reads one project per card from its /project/<uuid> link and ignores other links', () => {
  const read = probe(`<div data-testid="pane-scroller">${card(1, ' Sankit ')}${card(2, 'Emacs')}<a href="/project/new">New</a><a href="/chat/${id(3)}">Chat</a></div>`);
  assert.deepEqual(read.projects, [{ id: id(1), name: 'Sankit' }, { id: id(2), name: 'Emacs' }]);
  assert.equal(read.ready, true);
  assert.equal(probe('<div></div>').ready, false);
  assert.equal(probe(`<div data-testid="pane-scroller"></div>`, '/login').loginRequired, true);
});

test('the catalog is sorted by name, unique by project and refuses rows it cannot name or address', () => {
  assert.deepEqual(mergeProjects([{ id: id(2), name: 'b one' }, { id: id(1), name: 'A  Two' }, { id: id(2), name: 'again' }]), [
    { name: 'A Two', ref: `https://claude.ai/project/${id(1)}` },
    { name: 'b one', ref: `https://claude.ai/project/${id(2)}` },
  ]);
  assert.throws(() => mergeProjects([{ id: 'nope', name: 'X' }]), /unrecognised id/);
  assert.throws(() => mergeProjects([{ id: id(1), name: '  ' }]), /without a readable name/);
});

interface Read { path?: string; loginRequired?: boolean; challenge?: boolean; ready?: boolean; busy?: number; projects: { id: string; name: string }[] }
/** A BrowserOS run that navigates once and then answers each probe from `reads` (the last one repeats). */
function fakeRun(reads: Read[]): { run: (code: string) => Promise<unknown>; probes: () => number } {
  let index = 0;
  return {
    probes: () => index,
    run: async code => {
      if (code.includes('.goto(')) return true;
      const read = reads[Math.min(index++, reads.length - 1)] as Read;
      return { value: { path: '/projects', loginRequired: false, challenge: false, ready: true, busy: 0, ...read } };
    },
  };
}
const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: id(index + 1), name: `Project ${index + 1}` }));

test('a catalog is returned only after successive reads agree, so a first read taken before Claude fetched is not trusted', async () => {
  const fake = fakeRun([{ projects: [] }, { projects: rows(2) }, { projects: rows(5) }]);
  const projects = await readProjectCatalog(fake.run, 3, () => {});
  assert.equal(projects.length, 5);
  assert.ok(fake.probes() >= 5);
});

test('a catalog that reaches the page size keeps being scrolled until it stops growing', async () => {
  const fake = fakeRun([{ projects: rows(30) }, { projects: rows(30) }, { projects: rows(30) }, { projects: rows(45) }]);
  assert.equal((await readProjectCatalog(fake.run, 3, () => {})).length, 45);
});

test('login, challenge and a page that never becomes ready are errors, not an empty or partial list', async () => {
  await assert.rejects(readProjectCatalog(fakeRun([{ loginRequired: true, projects: [] }]).run, 3, () => {}), /signed out/);
  await assert.rejects(readProjectCatalog(fakeRun([{ challenge: true, projects: [] }]).run, 3, () => {}), /verification challenge/);
  const controller = new AbortController();
  const waiting = readProjectCatalog(fakeRun([{ ready: false, path: '/login', projects: [] }]).run, 3, () => {}, controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
});
