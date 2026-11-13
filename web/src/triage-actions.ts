import type { Undo } from './undo';
import type { Job } from './types';
import { escape } from './format';

type Change = { id: number; state: string };
export function createTriageActions(history: Undo, actions: {
  view: () => string; jobs: () => Job[]; cursor: () => number; select: (id: number) => void; detail: () => Job | null;
  patch: (id: number, state: string) => Promise<void>; update: (id: number, state: string) => void;
  refresh: () => Promise<void>; render: () => void; confirm: (message: string) => void; error: (error: unknown) => void;
}) {
  const picks = new Set<number>();
  let busy = false, undo: { changes: Change[]; cursor: number } | null = null;
  const below = () => actions.jobs().filter(j => j.score !== null && j.score < 70 && ['new', 'seen'].includes(j.state) && j.filtered_reason === null);
  function render() {
    document.getElementById('bulk-actions')!.hidden = !picks.size;
    document.getElementById('selected-count')!.textContent = `${picks.size} selected`;
    const low = document.getElementById('dismiss-below') as HTMLButtonElement;
    low.innerHTML = `Dismiss below 70 <span class="muted">${below().length}</span>`;
    low.disabled = busy || !below().length;
    document.querySelectorAll<HTMLButtonElement>('[data-action=state], [data-action=bulk-state], [data-action=undo]').forEach(button => { button.disabled = busy; });
  }
  function announce(changes: Change[], cursor: number, label: string, view: string) {
    undo = { changes, cursor };
    history.remember(view, label, restore);
  }
  // astro@7.3.8/dist/runtime/client/load.js only hydrates; Promise.allSettled retains each PATCH outcome for undo.
  async function apply(changes: Change[]) {
    const outcomes = await Promise.allSettled(changes.map(change => actions.patch(change.id, change.state)));
    return changes.filter((change, index) => {
      const outcome = outcomes[index];
      if (outcome.status === 'rejected') { actions.error(outcome.reason); return false; }
      actions.update(change.id, change.state); return true;
    });
  }
  async function state(ids: number[], state: string, view: string) {
    const list = actions.jobs(), detail = actions.detail();
    const changes = [...new Set(ids)].map(id => list.find(j => j.id === id) ?? (detail?.id === id ? detail : null))
      .filter((j): j is Job => !!j && j.state !== state).map(j => ({ id: j.id, state: j.state }));
    if (!changes.length) return;
    const cursor = ids.length === 1 ? ids[0] : actions.cursor(), index = list.findIndex(j => j.id === cursor);
    busy = true; render();
    try {
      const done = await apply(changes.map(j => ({ id: j.id, state })));
      if (!done.length) return;
      const changed = new Set(done.map(j => j.id));
      done.forEach(j => picks.delete(j.id));
      const next = list.slice(index + 1).find(j => !changed.has(j.id)) ?? list.slice(0, index).reverse().find(j => !changed.has(j.id));
      if (index >= 0) actions.select(next?.id ?? 0);
      announce(changes.filter(j => changed.has(j.id)), cursor,
        `${state === 'dismissed' ? 'Dismissed' : state === 'applied' ? 'Applied' : changes.some(j => j.state === 'applied') ? 'Unmarked applied' : 'Restored'} · ${done.length === 1 ? (list.find(j => j.id === done[0].id) ?? detail)?.title : `${done.length} Jobs`}`, view);
      await actions.refresh();
    } finally { busy = false; actions.render(); }
  }
  async function restore() {
    if (!undo) return true;
    busy = true; render();
    const saved = undo;
    try {
      const restored = new Set((await apply(saved.changes)).map(j => j.id));
      const reapplied = saved.changes.some(j => restored.has(j.id) && j.state === 'applied');
      saved.changes = saved.changes.filter(j => !restored.has(j.id));
      if (!saved.changes.length) undo = null;
      actions.select(saved.cursor);
      await actions.refresh();
      if (restored.size) actions.confirm(`Undo applied · ${restored.size} Job${restored.size === 1 ? '' : 's'}${saved.changes.length ? ` · ${saved.changes.length} still need undo` : ''}${reapplied ? ' · Re-applied at Applied with a fresh Pipeline entry' : ''}`);
      return !saved.changes.length;
    } finally { busy = false; actions.render(); }
  }
  return {
    has: (id: number) => picks.has(id), ids: () => [...picks], render,
    state: (ids: number[], next: string) => { const view = actions.view(); return history.perform(() => state(ids, next, view)); }, undo: () => history.run('triage'),
    key(key: 'a' | 'd') {
      const view = actions.view(), ids = [...picks], target = key === 'a' ? 'applied' : 'dismissed';
      return history.perform(async () => {
        if (ids.length) return state(ids, target, view);
        const job = actions.detail() ?? actions.jobs().find(j => j.id === actions.cursor());
        if (job) await state([job.id], job.state === target ? 'seen' : target, view);
      });
    },
    below: () => below().map(j => j.id),
    checkbox: (id: number) => `<label class="row-pick"><input type="checkbox" data-pick-job="${id}" aria-label="Select Job ${escape(id)}" ${picks.has(id) ? 'checked' : ''}></label>`,
    toggle(id: number) { if (picks.has(id)) picks.delete(id); else picks.add(id); actions.render(); },
    clear() { if (picks.size) { picks.clear(); actions.render(); } },
    remove(ids: number[]) { ids.forEach(id => picks.delete(id)); actions.render(); },
    sync() { const visible = new Set(actions.jobs().map(j => j.id)); picks.forEach(id => { if (!visible.has(id)) picks.delete(id); }); },
  };
}
