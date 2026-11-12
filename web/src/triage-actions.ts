import type { Job } from './types';
import { escape } from './format';

type Change = { id: number; state: string };
export function createTriageActions(actions: {
  jobs: () => Job[]; cursor: () => number; select: (id: number) => void; detail: () => Job | null;
  patch: (id: number, state: string) => Promise<void>; update: (id: number, state: string) => void;
  refresh: () => Promise<void>; render: () => void; error: (error: unknown) => void;
}) {
  const picks = new Set<number>(), toast = document.getElementById('undo-toast')!;
  let busy = false, undo: { changes: Change[]; cursor: number } | null = null, timer: ReturnType<typeof setTimeout>;
  const below = () => actions.jobs().filter(j => j.score !== null && j.score < 70 && j.state !== 'dismissed');
  function render() {
    document.getElementById('bulk-actions')!.hidden = !picks.size;
    document.getElementById('selected-count')!.textContent = `${picks.size} selected`;
    const low = document.getElementById('dismiss-below') as HTMLButtonElement;
    low.innerHTML = `Dismiss below 70 <span class="muted">${below().length}</span>`;
    low.disabled = busy || !below().length;
    document.querySelectorAll<HTMLButtonElement>('[data-action=state], [data-action=bulk-state], [data-action=undo]').forEach(button => { button.disabled = busy; });
  }
  function announce(changes: Change[], cursor: number, label: string) {
    undo = { changes, cursor };
    toast.querySelector('span')!.textContent = label;
    toast.hidden = false;
    clearTimeout(timer); timer = setTimeout(() => { toast.hidden = true; }, 6000);
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
  async function state(ids: number[], state: string) {
    if (busy) return;
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
        `${state === 'dismissed' ? 'Dismissed' : state === 'applied' ? 'Applied' : 'Restored'} · ${done.length === 1 ? (list.find(j => j.id === done[0].id) ?? detail)?.title : `${done.length} Jobs`}`);
      await actions.refresh();
    } finally { busy = false; actions.render(); }
  }
  async function restore() {
    if (!undo || busy) return;
    busy = true; render();
    const saved = undo;
    try {
      const restored = new Set((await apply(saved.changes)).map(j => j.id));
      saved.changes = saved.changes.filter(j => !restored.has(j.id));
      if (!saved.changes.length) { undo = null; toast.hidden = true; clearTimeout(timer); }
      actions.select(saved.cursor);
      await actions.refresh();
    } finally { busy = false; actions.render(); }
  }
  return {
    has: (id: number) => picks.has(id), ids: () => [...picks], render, state, undo: restore,
    below: () => below().map(j => j.id),
    checkbox: (id: number) => `<label class="row-pick"><input type="checkbox" data-pick-job="${id}" aria-label="Select Job ${escape(id)}" ${picks.has(id) ? 'checked' : ''}></label>`,
    toggle(id: number) { if (picks.has(id)) picks.delete(id); else picks.add(id); actions.render(); },
    clear() { picks.clear(); actions.render(); },
    remove(ids: number[]) { ids.forEach(id => picks.delete(id)); actions.render(); },
    sync() { const visible = new Set(actions.jobs().map(j => j.id)); picks.forEach(id => { if (!visible.has(id)) picks.delete(id); }); },
  };
}
