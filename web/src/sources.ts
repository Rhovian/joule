import type { Source } from './types';
import { age, escape } from './format';
import { sourceStatus } from './source-status';

export function createSourceFilter(onChange: () => void, onOpen: () => void, onInlineOpen: () => void) {
  const menu = document.getElementById('sources-menu')!;
  const trigger = document.getElementById('sources-button')!;
  const search = document.getElementById('source-search') as HTMLInputElement;
  const options = document.getElementById('source-options')!;
  // undefined keeps manual picks; null means all Sources; names keep a preset’s fixed scope.
  let sources: Source[] = [], selected = new Set<string>(), loaded = false, preset: string[] | null | undefined;
  const isOpen = () => menu.matches(':popover-open');
  const rows = () => Array.from(options.querySelectorAll<HTMLButtonElement>('[data-source]'));
  function close() { if (menu.hasAttribute('popover') && isOpen()) menu.hidePopover(); }
  function render() {
    menu.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach(button => { button.disabled = !sources.length; });
    document.getElementById('source-count')!.textContent = `${selected.size} of ${sources.length}`;
    document.getElementById('mobile-source-count')!.textContent = `Sources · ${selected.size} of ${sources.length}`;
    const focused = (document.activeElement as HTMLElement)?.dataset;
    const query = search.value.trim().toLocaleLowerCase();
    const matching = sources.filter(s => s.name.toLocaleLowerCase().includes(query))
      .sort((a, b) => b.new_jobs - a.new_jobs || a.name.localeCompare(b.name));
    options.innerHTML = [true, false].map(showing => {
      const group = matching.filter(s => selected.has(s.name) === showing);
      return `<section aria-label="${showing ? 'Showing' : 'Hidden'}"><h3 class="source-group">${showing ? 'Showing' : 'Hidden'} · ${group.length}</h3>${group.map(s => {
        const last = s.last, { stamp, days, failed, interrupted, stale } = sourceStatus(s);
        const jobsLabel = `${s.new_jobs} new Job${s.new_jobs === 1 ? '' : 's'}`;
        // Running status belongs to a shared Scan; label Source membership.
        const flag = failed ? '<span class="tag failed">failed</span>' : interrupted ? '<span class="tag filtered">interrupted</span>' : last?.status === 'running' ? '<span class="tag running" title="Included in the current Scan">in Scan</span>' : stale ? `<span class="tag filtered">${days}d old</span>` : '';
        return `<div class="source-row"><button type="button" class="source-option" role="checkbox" aria-checked="${showing}" data-source="${escape(s.name)}" aria-label="${escape(s.name)}, ${jobsLabel}" aria-describedby="source-status-${escape(s.name)} source-age-${escape(s.name)}"><span class="source-check" aria-hidden="true">${showing ? '✓' : ''}</span><span class="source-name">${escape(s.name)}</span><span class="source-status" id="source-status-${escape(s.name)}">${flag}</span><span class="source-new" title="${jobsLabel}">${s.new_jobs}</span><span class="source-age" id="source-age-${escape(s.name)}"><span class="sr-only">Last finished Scan </span>${stamp ? age(stamp, true) : 'never'}</span></button><button type="button" class="source-only btn small" data-only="${escape(s.name)}" aria-label="Show only ${escape(s.name)}">only <kbd>o</kbd></button></div>`;
      }).join('')}</section>`;
    }).join('') + (matching.length ? '' : `<p class="source-empty">${sources.length ? 'No Sources match your search.' : 'No Sources enabled.'}</p>`);
    const only = focused?.only, name = focused?.source ?? only;
    if (name) options.querySelectorAll<HTMLButtonElement>('[data-source], [data-only]').forEach(button => {
      if (button.dataset[only ? 'only' : 'source'] === name) button.focus({ preventScroll: true });
    });
  }
  function choose(names: string[]) { preset = undefined; selected = new Set(names); render(); onChange(); }
  menu.addEventListener('beforetoggle', event => {
    trigger.setAttribute('aria-expanded', String((event as ToggleEvent).newState === 'open'));
    if ((event as ToggleEvent).newState === 'open') { search.value = ''; render(); onOpen(); }
  });
  menu.addEventListener('focusout', event => {
    if (menu.hasAttribute('popover') && event.relatedTarget instanceof Node && !menu.contains(event.relatedTarget) && event.relatedTarget !== trigger) close();
  });
  search.addEventListener('input', render);
  menu.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.dataset.source) {
      if (!selected.delete(button.dataset.source)) selected.add(button.dataset.source);
      choose([...selected]);
    }
    if (button.dataset.only) choose([button.dataset.only]);
    if (button.dataset.pick) choose(sources.filter(s => button.dataset.pick === 'all' || button.dataset.pick === 'new' && s.new_jobs > 0).map(s => s.name));
  });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || document.querySelector('#shortcuts[open], #fill-dialog[open]')) return;
    const typing = (event.target as HTMLElement).closest('input:not([type=checkbox]), textarea, select, [contenteditable]');
    if (!menu.hasAttribute('popover')) {
      if (event.key === 'f' && !typing && !document.getElementById('triage')!.hidden) { event.preventDefault(); onInlineOpen(); }
      return;
    }
    if (!isOpen()) {
      if (event.key === 'f' && !typing && !document.getElementById('triage')!.hidden) {
        event.preventDefault(); const filters = trigger.closest('details'); if (filters) filters.open = true; menu.showPopover(); event.stopImmediatePropagation();
      }
      return;
    }
    // Astro 7.3.8's node_modules/astro/dist/runtime/client/load.js only delegates hydration.
    // Native popover/anchors handle dismissal/placement; the reference's row shortcuts live here.
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); return; }
    if (typing && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const buttons = rows(), index = buttons.indexOf((document.activeElement as HTMLElement).closest('.source-row')?.querySelector<HTMLButtonElement>('[data-source]')!);
    if (['ArrowDown', 'ArrowUp', 'j', 'k', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const backward = ['ArrowUp', 'k'].includes(event.key);
      let next = index + (backward ? -1 : 1);
      if (index < 0) next = backward ? buttons.length - 1 : 0;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
    }
    if (event.key === 'o' && index >= 0) { event.preventDefault(); choose([buttons[index].dataset.source!]); }
  });
  function selection() {
    if (!loaded && preset !== undefined) return preset;
    // An unavailable named preset selects none, even when no Sources are enabled.
    const emptyNamedPreset = sources.length === 0 && Array.isArray(preset);
    return selected.size === sources.length && !emptyNamedPreset ? null : [...selected];
  }
  function set(names: string[] | null) {
    preset = names;
    selected = new Set(sources.filter(s => names === null || names.includes(s.name)).map(s => s.name));
    if (loaded) render();
  }
  return {
    update(next: Source[]) {
      const before = JSON.stringify(selection()?.slice().sort());
      selected = new Set(next.filter(s => {
        if (preset !== undefined) return preset === null || preset.includes(s.name);
        return !sources.some(old => old.name === s.name) || selected.has(s.name);
      }).map(s => s.name));
      sources = next; loaded = true; render();
      return before !== JSON.stringify(selection()?.slice().sort());
    },
    selection,
    count: () => selected.size,
    set,
    close,
  };
}
