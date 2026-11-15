import type { Source } from './types';
import { age, escape } from './format';
import { sourceStatus } from './source-status';

export function createSourceFilter(onChange: () => void, onOpen: () => void) {
  const menu = document.getElementById('sources-menu')!;
  const trigger = document.getElementById('sources-button')!;
  const search = document.getElementById('source-search') as HTMLInputElement;
  const options = document.getElementById('source-options')!;
  let sources: Source[] = [], selected = new Set<string>();
  const isOpen = () => menu.matches(':popover-open');
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
        return `<div class="source-row"><button type="button" class="source-option" role="checkbox" aria-checked="${showing}" data-source="${escape(s.name)}" aria-label="${escape(s.name)}, ${jobsLabel}" aria-describedby="source-status-${escape(s.name)} source-age-${escape(s.name)}"><span class="source-check" aria-hidden="true">${showing ? '✓' : ''}</span><span class="source-name">${escape(s.name)}</span><span class="source-status" id="source-status-${escape(s.name)}">${flag}</span><span class="source-new" title="${jobsLabel}">${s.new_jobs}</span><span class="source-age" id="source-age-${escape(s.name)}"><span class="sr-only">Last finished Scan </span>${stamp ? age(stamp, true) : 'never'}</span></button><button type="button" class="source-only btn small" data-only="${escape(s.name)}" aria-label="Show only ${escape(s.name)}">only</button></div>`;
      }).join('')}</section>`;
    }).join('') + (matching.length ? '' : `<p class="source-empty">${sources.length ? 'No Sources match your search.' : 'No Sources enabled.'}</p>`);
    const only = focused?.only, name = focused?.source ?? only;
    if (name) options.querySelectorAll<HTMLButtonElement>('[data-source], [data-only]').forEach(button => {
      if (button.dataset[only ? 'only' : 'source'] === name) button.focus({ preventScroll: true });
    });
  }
  function choose(names: string[]) { selected = new Set(names); render(); onChange(); }
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
  const selection = () => selected.size === sources.length ? null : [...selected];
  return {
    update(next: Source[]) {
      const before = JSON.stringify(selection()?.slice().sort());
      selected = new Set(next.filter(s => {
        return !sources.some(old => old.name === s.name) || selected.has(s.name);
      }).map(s => s.name));
      sources = next; render();
      return before !== JSON.stringify(selection()?.slice().sort());
    },
    selection,
    count: () => selected.size,
    reset() { selected = new Set(sources.map(s => s.name)); render(); },
    close,
  };
}
