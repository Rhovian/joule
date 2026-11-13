import './pipeline.css';
import { createMetrics, periodSelect, type Statistics } from './pipeline-stats';
import { age, dateTime, escape } from './format';
import { score } from './job';
import type { Undo } from './undo';
const stages = ['applied', 'screen', 'interview', 'offer', 'accepted'];
const columns = ['applied', 'screen', 'interview', 'offer', 'closed'], reasons = ['no_reply', 'rejected', 'withdrawn'];
const label = (value: string) => value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
type Move = { id: number; job_id: number; stage: string; closed_reason: string | null; next_at: string | null; next_label: string | null; created_at: string; how: string; note: string | null };
type Entry = Move & { first_move_id: number; applied_at: string; history: Move[] };
type Card = Omit<Entry, 'history'> & { title: string; company: string | null; source: string; score: number | null };
const column = (row: Move) => row.closed_reason ? 'closed' : row.stage === 'accepted' ? 'offer' : row.stage;
export function createPipeline(api: <T>(path: string, method?: string, body?: unknown) => Promise<T>, undo: Undo, actions: {
  open: (id: number) => Promise<void>; changed: () => void; error: (error: unknown) => void;
  active: () => boolean; phone: () => boolean; drawer: () => number; replace: (id: string, html: string) => void;
}) {
  const page = document.getElementById('a-pipeline')!, root = document.getElementById('dashboard')!;
  page.innerHTML = `<header class="pipeline-heading"><h1>Pipeline</h1><p id="pipeline-summary">Loading Pipeline…</p>${periodSelect()}</header><div class="pipeline-layout"><div class="pipeline-main"><section class="pipeline-flow"><header><h2>Flow</h2><div class="flow-legend">${[["moved","Moved on"],["stage","Still in stage"],["no_reply","No reply"],["rejected","Rejected"],["withdrawn","Withdrawn"]].map(([key,text]) => `<span class="flow-${key}">${text}</span>`).join('')}</div><button id="pipeline-flow-toggle" aria-controls="pipeline-flow-body" aria-expanded="true">Hide <kbd>v</kbd></button></header><div id="pipeline-flow-body">Loading flow…</div></section><div id="pipeline-content"></div></div><aside class="pipeline-sidebar"><section id="pipeline-followup" class="reply-card" aria-label="Follow up"></section><section id="pipeline-rates" class="reply-card" aria-label="Reply rate by Fit Score">Loading reply rates…</section></aside></div><footer class="keyboard-hint"><span>Applied · oldest first</span><span><kbd>h</kbd> <kbd>l</kbd> column · <kbd>j</kbd> <kbd>k</kbd> card · <kbd>o</kbd> open · <kbd>[</kbd> <kbd>]</kbd> back / on · <kbd>x</kbd> close · <kbd>e</kbd> date / note · <kbd>z</kbd> undo · <kbd>v</kbd> flow</span></footer>`;
  const dialog = document.createElement('dialog'); dialog.id = 'pipeline-dialog'; dialog.setAttribute('aria-labelledby', 'pipeline-dialog-title');
  dialog.innerHTML = `<form><header><h2 id="pipeline-dialog-title"></h2><button type="button" data-cancel aria-label="Close dialog">×</button></header><label data-close-fields>Closed reason<select name="reason">${reasons.map(r => `<option value="${r}">${label(r)}</option>`).join('')}</select></label><div data-edit-fields><label>Next date<input name="date" type="datetime-local"></label><label>Label<input name="label" maxlength="200" placeholder="Technical interview"></label></div><label>Note (optional)<textarea name="note" maxlength="10000" rows="3"></textarea></label><p role="status" id="pipeline-error"></p><footer><button class="btn primary" type="submit">Save</button><button type="button" data-cancel>Cancel</button></footer></form>`;
  root.append(dialog);
  let all: Card[] = [], rows: Card[] = [], selected = 0, col = 0, busy = false, error = '', version = 0;
  const metrics = createMetrics(load, actions.error, actions.replace);
  let followUps = new Set<number>(), thresholds = '';
  function statistics(stats: Statistics) { followUps = new Set(stats.follow_up_ids); thresholds = `Follow up after ${stats.follow_up_days}d · Closes as No reply after ${stats.no_reply_days}d`; metrics.render(stats); }
  const details = new Map<number, Entry | string>();
  const visible = () => col === 4 ? reasons.flatMap(reason => rows.filter(r => r.closed_reason === reason)) : rows.filter(r => column(r) === columns[col]);
  const current = () => rows.find(r => r.job_id === selected);
  function controls(row: Move, prefix: string) {
    const index = stages.indexOf(row.stage), closed = !!row.closed_reason;
    const button = (action: string, text: string, disabled = false) => `<button id="${prefix}-${row.job_id}-${action}" class="btn small" data-pipeline-action="${action}" data-id="${row.job_id}" ${busy || disabled ? 'disabled' : ''}>${text}</button>`;
    return `<div class="pipeline-actions">${prefix === 'board' ? `<button class="btn small" data-action="open" data-id="${row.job_id}">Open <kbd>o</kbd></button>` : ''}${button('back', closed ? `Reopen ${label(row.stage)}` : `← ${label(stages[Math.max(0, index - 1)])}`, !closed && index === 0)}${button('on', `${label(stages[Math.min(4, index + 1)])} →`, closed || index === 4)}${button('close', 'Close…', closed)}${button('edit', 'Date / note')}</div>`;
  }
  function card(row: Card) {
    const chosen = selected === row.job_id;
    return `<article id="pipeline-card-${row.job_id}" class="pipeline-card${chosen ? ' selected' : ''}${row.closed_reason ? ' closed' : ''}" tabindex="${chosen ? 0 : -1}" aria-label="${escape(row.title)}" ${chosen ? 'aria-current="true"' : ''}><button id="pipeline-select-${row.job_id}" class="pipeline-card-main" data-pipeline-select="${row.job_id}">${row.closed_reason ? '' : score(row)}<span><strong>${escape(row.title)}</strong><span class="pipeline-meta">${escape(row.company || row.source)} · ${age(row.applied_at)}</span></span></button>${followUps.has(row.job_id) ? '<span class="tag filtered">follow up</span>' : ''}${row.stage === 'accepted' ? '<span class="tag applied">Accepted</span>' : ''}${row.closed_reason ? `<p class="pipeline-meta">at ${label(row.stage)}</p>` : ''}${row.next_at ? `<p class="pipeline-next"><b>Next</b> ${escape(row.next_label || '')} · ${escape(dateTime(row.next_at))}</p>` : ''}${chosen ? controls(row, 'board') : ''}</article>`;
  }
  function render() {
    const waiting = rows.filter(row => followUps.has(row.job_id));
    actions.replace('pipeline-followup', `<h3>Follow up <span class="tag filtered">${waiting.length}</span></h3>${waiting.map(row => `<div class="followup-job"><div><b title="${escape(row.title)}">${escape(row.title)}</b><p class="muted">${Math.floor((Date.now() - Date.parse(row.applied_at)) / 86400000)}d without a reply</p></div><button class="btn small" data-action="follow-up" data-id="${row.job_id}">Draft follow-up</button></div>`).join('') || '<p class="muted">No Jobs need a follow-up.</p>'}<p class="muted">${thresholds}</p>`);
    const active = rows.filter(r => !r.closed_reason).length;
    document.querySelectorAll('[data-pipeline-count]').forEach(node => { node.textContent = String(all.filter(r => !r.closed_reason).length); });
    const summary = document.getElementById('pipeline-summary')!;
    if (error) summary.textContent = error; else summary.innerHTML = `${metrics.query() ? 'This period · ' : ''}<span class="pipeline-total">${rows.length} applied · </span>${active} active · ${rows.length - active} closed`;
    const groups = Object.fromEntries(columns.map(key => [key, rows.filter(r => column(r) === key)]));
    actions.replace('pipeline-content', `<nav class="pipeline-tabs" aria-label="Pipeline columns">${columns.map((key,i) => `<button data-pipeline-column="${i}" aria-pressed="${col === i}"><b>${groups[key].length}</b>${label(key)}</button>`).join('')}</nav><div class="pipeline-board">${columns.map((key,i) => `<section class="pipeline-column" data-column="${key}" data-current="${col === i}" aria-label="${label(key)}"><button class="pipeline-column-heading" data-pipeline-column="${i}" aria-pressed="${col === i}"><b>${label(key)}</b><span>${groups[key].length}</span>${i === 0 ? '<small>oldest first</small>' : ''}</button>${key === 'closed' ? reasons.map(reason => { const group = groups[key].filter(r => r.closed_reason === reason); return group.length ? `<div class="pipeline-closed-group"><h3>${label(reason)} <span>${group.length}</span></h3>${group.map(card).join('')}</div>` : ''; }).join('') : groups[key].map(card).join('')}${!groups[key].length ? '<p class="pipeline-empty">No Jobs</p>' : ''}</section>`).join('')}</div>${!rows.length && !error ? `<p class="pipeline-empty">${all.length ? 'No Jobs in this period. Choose All time to see older applications.' : 'Mark a Job applied in <a href="#triage">Triage</a> to start Pipeline.'}</p>` : ''}`);
  }
  function focus() { if (actions.active() && !actions.drawer()) document.getElementById(`pipeline-card-${selected}`)?.focus({preventScroll:true}); document.getElementById(`pipeline-card-${selected}`)?.scrollIntoView({block:'nearest', inline:'nearest'}); }
  function select(id: number, reveal = false) { selected = id; const row = current(); if (row) col = columns.indexOf(column(row)); render(); if (reveal) focus(); }
  async function load() {
    const request = ++version, query = metrics.query();
    try {
      const [next, stats] = await Promise.all([api<Card[]>('pipeline'), api<Statistics>(`pipeline/stats${query}`)]);
      if (request !== version) return;
      const ids = new Set(stats.job_ids); all = next; rows = all.filter(row => ids.has(row.job_id)); statistics(stats); error = ''; const row = current(); if (row) col = columns.indexOf(column(row)); else selected = visible()[0]?.job_id ?? 0;
    } catch (e) { if (request !== version) return; error = 'Could not load Pipeline. Reopen Pipeline to retry.'; metrics.failed(); actions.error(e); }
    render();
  }
  async function loadEntry(id: number) {
    try { details.set(id, await api<Entry>(`pipeline/${id}`)); } catch { details.set(id, 'Could not load Pipeline history. Retry to refresh.'); }
    actions.changed();
  }
  async function update(id: number, payload: unknown) {
    const next = await api<Entry>(`pipeline/${id}`, 'PATCH', payload), request = ++version;
    if (next.closed_reason || next.history.some(move => move.stage !== 'applied' || move.closed_reason === 'rejected')) followUps.delete(id);
    all = all.map(row => row.job_id === id ? {...row, ...next} : row); rows = rows.map(row => row.job_id === id ? {...row, ...next} : row); error = ''; details.set(id, next); if (selected === id) select(id, true); else render(); actions.changed();
    void api<Statistics>(`pipeline/stats${metrics.query()}`).then(stats => { if (request === version) { const ids = new Set(stats.job_ids); rows = all.filter(row => ids.has(row.job_id)); statistics(stats); render(); } }).catch(e => { if (request === version) { metrics.failed(); actions.error(e); } });
    return next;
  }
  function change(id: number, payload: (previous: Entry) => Record<string, unknown> | null, text: string) {
    return undo.perform(async () => {
      busy = true; render();
      try {
        const previous = await api<Entry>(`pipeline/${id}`), patch = payload(previous);
        if (!patch) return;
        const next = await update(id, patch);
        if (next.id === previous.id) return;
        undo.remember('pipeline', text, async () => {
          busy = true; render();
          try { select(id); if (actions.active() && actions.drawer()) await actions.open(id); await update(id, {stage:previous.stage, closed_reason:previous.closed_reason, next_at:previous.next_at, next_label:previous.next_label, how:'manual', note:`Undo · ${text}`}); actions.error('Undo applied · Pipeline'); return true; }
          finally { busy = false; render(); actions.changed(); }
        });
      } finally { busy = false; render(); actions.changed(); }
    });
  }
  function step(id: number, direction: number) {
    return change(id, previous => {
      const index = stages.indexOf(previous.stage);
      return direction < 0 && previous.closed_reason ? {stage:previous.stage} : previous.closed_reason || index + direction < 0 || index + direction >= stages.length ? null : {stage:stages[index + direction]};
    }, direction < 0 ? 'Moved back' : 'Moved on');
  }
  function edit(id: number, closing: boolean) {
    const cached = details.get(id), row = rows.find(r => r.job_id === id) ?? (typeof cached === 'object' ? cached : null); if (!row || dialog.open || closing && row.closed_reason) return;
    const form = dialog.querySelector('form')!, field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    form.dataset.jobId = String(id); form.dataset.closing = String(closing);
    document.getElementById('pipeline-dialog-title')!.textContent = closing ? 'Close as…' : 'Next date or note';
    (form.querySelector('[data-close-fields]') as HTMLElement).hidden = !closing; (form.querySelector('[data-edit-fields]') as HTMLElement).hidden = closing;
    let local = ''; if (row.next_at) { const date = new Date(row.next_at); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); local = date.toISOString().slice(0,16); }
    field('date').value = local; field('label').value = row.next_label || ''; field('note').value = ''; field('reason').value = row.closed_reason || 'rejected'; document.getElementById('pipeline-error')!.textContent = '';
    dialog.showModal(); field(closing ? 'reason' : 'date').focus();
  }
  dialog.querySelector('form')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement, field = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
    const closing = form.dataset.closing === 'true', save = form.querySelector<HTMLButtonElement>('[type=submit]')!; save.disabled = true;
    try { const patch = {...(closing ? {closed_reason:field('reason')} : {next_at:field('date') ? new Date(field('date')).toISOString() : null, next_label:field('label') || null}), note:field('note') || null};
    await change(Number(form.dataset.jobId), () => patch, closing ? `Closed as ${label(field('reason'))}` : 'Updated date / note'); dialog.close(); }
    catch (e) { document.getElementById('pipeline-error')!.textContent = e instanceof Error ? e.message : String(e); }
    finally { save.disabled = false; }
  });
  dialog.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', focus);
  function selectColumn(index: number) {
    col = index; selected = visible()[0]?.job_id ?? 0; render(); focus();
    if (actions.drawer() && selected) void actions.open(selected).catch(actions.error);
  }
  root.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-pipeline-column], [data-pipeline-select], [data-pipeline-action]'); if (!target) return;
    if (target.dataset.pipelineColumn !== undefined) { selectColumn(Number(target.dataset.pipelineColumn)); return; }
    if (target.dataset.pipelineSelect) { const id = Number(target.dataset.pipelineSelect); select(id); if (actions.phone() || actions.drawer()) void actions.open(id).catch(actions.error); return; }
    const id = Number(target.dataset.id), action = target.dataset.pipelineAction;
    if (action === 'back' || action === 'on') void step(id, action === 'back' ? -1 : 1).catch(actions.error);
    if (action === 'edit' || action === 'close') edit(id, action === 'close');
    if (action === 'retry') void loadEntry(id);
  });
  function moveCursor(step: number) {
    const list = visible(), index = list.findIndex(r => r.job_id === selected), row = list[Math.max(0,Math.min(list.length - 1,index + step))];
    if (row) { select(row.job_id, true); if (actions.drawer()) void actions.open(row.job_id).catch(actions.error); }
  }
  return {
    load, loadEntry, invalidate: (id: number) => details.delete(id), reveal: (id: number) => { if (!rows.some(row => row.job_id === id) && metrics.query()) { metrics.period(''); rows = all; actions.error('Showing All time · this Job is outside the selected period'); void load(); } select(id, true); }, visible,
    focus, move: moveCursor,
    section(id: number) {
      const row = details.get(id);
      return `<section id="drawer-pipeline" class="drawer-section pipeline-history" tabindex="-1" aria-label="Pipeline"><header><h3>Pipeline</h3><a class="btn small" href="#pipeline" data-action="open-pipeline" data-id="${id}">Open in Pipeline ›</a></header>${!row ? '<p role="status">Loading Pipeline history…</p>' : typeof row === 'string' ? `<p>${escape(row)} <button data-pipeline-action="retry" data-id="${id}">Retry</button></p>` : `<div class="pipeline-trail">${stages.map(stage => `<span class="tag ${stage === row.stage ? 'applied' : ''}">${label(stage)}</span>`).join('<span aria-hidden="true">→</span>')}${row.closed_reason ? `<span class="tag filtered">${label(row.closed_reason)}</span>` : ''}</div>${controls(row, 'drawer')}${row.next_at ? `<p><b>Next:</b> ${escape(row.next_label || '')} · ${escape(dateTime(row.next_at))}</p>` : ''}<ol>${row.history.map(move => `<li><time>${escape(dateTime(move.created_at))}</time><span>${move.closed_reason ? `Closed · ${label(move.closed_reason)} at ${label(move.stage)}` : label(move.stage)} · ${move.how === 'manual' ? 'by hand' : 'auto'}${move.note ? ` · ${escape(move.note)}` : ''}${move.next_at ? `<small>Next: ${escape(move.next_label || '')} · ${escape(dateTime(move.next_at))}</small>` : ''}</span></li>`).reverse().join('')}</ol>`}</section>`;
    },
    key(event: KeyboardEvent) {
      const key = event.key;
      if (!['h','l','j','k','o','[',']','x','e','z','v'].includes(key)) return false;
      event.preventDefault(); if (event.repeat && ['[',']','x','e'].includes(key)) return true;
      if (key === 'h' || key === 'l') { selectColumn(Math.max(0, Math.min(4, col + (key === 'h' ? -1 : 1)))); }
      if (key === 'j' || key === 'k') moveCursor(key === 'j' ? 1 : -1);
      if (key === 'o' && selected) void actions.open(selected).catch(actions.error);
      if ((key === '[' || key === ']') && selected) void step(selected, key === '[' ? -1 : 1).catch(actions.error);
      if ((key === 'x' || key === 'e') && selected) edit(selected, key === 'x');
      if (key === 'v' && !event.repeat) metrics.toggle();
      if (key === 'z') void undo.run('pipeline').catch(actions.error);
      return true;
    },
  };
}
