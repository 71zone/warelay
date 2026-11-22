import blessed from 'blessed';
import type { Application } from '../../core/application.js';
import { providerName } from '../../core/providers.js';
import { cycleOption, createSettingsModel, moveProvider, optionValue, positionOf, settingsItems, stepRetries, toSettings, toggleProvider, type SettingsModel } from './assistant-settings-model.js';
import type { PickerHooks } from './project-picker.js';
import { errorMessage, fit, plain, wrap } from './text.js';

export interface AssistantSettingsScreen { open(): void; close(): void; isOpen(): boolean; focus(): void; layout(): void }

interface State { model: SettingsModel; cursor: number; notice: string; busy: boolean }

/**
 * Assistant chooser: a checkbox per provider, its priority position, reordering, a stepper for the retries before falling back and a cycler for each provider's own
 * options. Nothing is typed. It only calls Application.setAssistantSettings, once, when the user saves.
 */
export function createAssistantSettings(screen: blessed.Widgets.Screen, application: Application, hooks: PickerHooks, frame: blessed.Widgets.Border): AssistantSettingsScreen {
  const box = blessed.box({ parent: screen, top: 'center', left: 'center', width: 78, height: 20, border: frame, label: ' Assistants ', hidden: true, tags: true, mouse: true, style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } } });
  const body = blessed.box({ parent: box, top: 0, left: 1, width: 74, height: 12, tags: true, style: { bg: 'black' } });
  const footer = blessed.box({ parent: box, top: 13, left: 1, width: 74, height: 5, tags: true, style: { bg: 'black' } });
  let state: State | null = null;
  let innerWidth = 74;

  function render(): void {
    if (!state) return;
    const { model, cursor } = state;
    const items = settingsItems(model);
    const lines = items.map((item, index) => {
      const at = index === cursor;
      let text: string;
      if (item.kind === 'provider') {
        const row = model.rows[item.row]!;
        const position = positionOf(model, item.row);
        const role = position === null ? 'off' : position === 1 ? 'primary' : `fallback ${position - 1}`;
        text = `${row.enabled ? '[x]' : '[ ]'} ${position ?? ' '}. ${providerName(row.id)}${' '.repeat(Math.max(1, 18 - plain(providerName(row.id)).length))}${role}`;
      } else if (item.kind === 'option') {
        const row = model.rows[item.row]!;
        text = `       ${fit(item.spec.label, 52)}  ◀ ${optionValue(row, item.spec)} ▶`;
      } else text = `Retries before falling back  ◀ ${model.retries} ▶`;
      const shown = fit(text, innerWidth - 2);
      return at ? `{cyan-bg}{black-fg} ${blessed.escape(shown)} {/}` : ` ${blessed.escape(shown)}`;
    });
    body.setContent(lines.join('\n'));
    const current = items[cursor];
    const keys = current?.kind === 'provider'
      ? 'Space on/off · Shift+↑↓ or +/- move up/down the priority'
      : 'Space, ◀ ▶ or +/- change the value';
    const intro = 'The first enabled assistant is used; when it reports a usage limit or cannot be reached, the next one takes the message until the limit resets.';
    footer.setContent([
      ...wrap(intro, innerWidth, 2).map(line => `{gray-fg}${blessed.escape(line)}{/}`),
      state.notice ? `{yellow-fg}${blessed.escape(fit(state.notice, innerWidth))}{/}` : `{cyan-fg}${blessed.escape(keys)}{/}`,
      '{gray-fg}↑↓ select · Enter or S save · Esc cancel{/}',
    ].join('\n'));
    screen.render();
  }
  function close(): void {
    if (!state) return;
    state = null;
    box.hide(); screen.render();
    setImmediate(() => hooks.closed());
  }
  function save(): void {
    const s = state;
    if (!s || s.busy) return;
    s.busy = true; s.notice = 'Saving…'; render();
    Promise.resolve().then(() => application.setAssistantSettings(toSettings(s.model))).then(() => { if (state === s) close(); }, (error: unknown) => {
      application.log(errorMessage(error));
      if (state === s) { s.busy = false; s.notice = errorMessage(error); render(); }
    });
  }
  function change(s: State, delta: -1 | 1): void {
    const item = settingsItems(s.model)[s.cursor];
    if (item?.kind === 'retries') stepRetries(s.model, delta);
    else if (item?.kind === 'option') cycleOption(s.model, item.row, item.spec, delta);
  }
  function onKey(ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg): void {
    const s = state;
    if (!s || s.busy || hooks.blocked() || key.full === 'C-c') return;
    const items = settingsItems(s.model);
    const item = items[s.cursor];
    s.notice = '';
    const shifted = key.shift === true || key.full === 'S-up' || key.full === 'S-down';
    if (key.name === 'escape') { close(); return; }
    if (key.name === 'enter' || key.name === 'return' || ch === 's' || ch === 'S') { save(); return; }
    if ((key.name === 'up' || key.name === 'down') && shifted && item?.kind === 'provider') {
      const index = moveProvider(s.model, item.row, key.name === 'up' ? -1 : 1);
      s.cursor = settingsItems(s.model).findIndex(entry => entry.kind === 'provider' && entry.row === index);
    } else if (key.name === 'up') s.cursor = Math.max(0, s.cursor - 1);
    else if (key.name === 'down') s.cursor = Math.min(items.length - 1, s.cursor + 1);
    else if (item?.kind === 'provider' && (ch === '+' || ch === '=' || ch === '-' || ch === '_')) {
      const index = moveProvider(s.model, item.row, ch === '+' || ch === '=' ? -1 : 1);
      s.cursor = settingsItems(s.model).findIndex(entry => entry.kind === 'provider' && entry.row === index);
    } else if (key.name === 'space' || ch === ' ') {
      if (item?.kind === 'provider') { if (!toggleProvider(s.model, item.row)) s.notice = 'At least one assistant must stay enabled.'; s.cursor = Math.min(s.cursor, settingsItems(s.model).length - 1); }
      else change(s, 1);
    } else if (key.name === 'right' || ch === '+' || ch === '=') change(s, 1);
    else if (key.name === 'left' || ch === '-' || ch === '_') change(s, -1);
    layout();
  }
  screen.on('keypress', onKey);

  function layout(): void {
    const width = Math.max(50, Math.min(78, Number(screen.width) - 2));
    innerWidth = width - 4;
    box.width = width;
    const rows = state ? settingsItems(state.model).length : 6;
    const height = Math.min(Number(screen.height) - 1, rows + 8);
    box.height = height;
    body.width = innerWidth; body.height = rows;
    footer.width = innerWidth; footer.top = rows + 1; footer.height = 5;
    if (state) render();
  }
  return {
    open() {
      if (state) return;
      state = { model: createSettingsModel(application.snapshot().assistant), cursor: 0, notice: '', busy: false };
      hooks.opened();
      box.show(); box.setFront(); box.focus();
      layout(); render();
    },
    close,
    isOpen: () => state !== null,
    focus: () => { if (state) box.focus(); },
    layout,
  };
}
