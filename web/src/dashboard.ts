import type { Scan, Source, Job, DraftKind } from './types';
import { age, escape } from './format';
import { createSourceFilter } from './sources';
import { createScans } from './scans';
import { createMobile } from './mobile';
import { createTriageActions } from './triage-actions';
import { sourceStatus } from './source-status';
import { external, score, dismiss, applied, pay } from './job';
import { renderDrawer, draftSelection, draftKind, type DrawerEdits, type Asked } from './drawer';
const root = document.querySelector<HTMLElement>('#dashboard')!;
const element = (id: string) => document.getElementById(id)!;
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `Request failed (${response.status})`);
  return data as T;
}
let jobs: Job[] = [], sources: Source[] = [], selected = 0, detail: Job | null = null;
// Astro 7.3.8 runtime/client/load.js delegates hydration; selection epochs guard native fetch responses.
let detailVersion = 0, activeSection = 'fit';
let scheduled = false, detailId = 0, jobsVersion = 0, connected = true, runningId: number | null = null, scan: Scan | null = null, starting = false;
let sort = 'rank', scoringAll = false, view = 'triage';
let jobCounts: Record<string, number> = {};
const sourceFilter = createSourceFilter(() => void loadJobs().catch(notice), () => void loadSources().catch(notice), () => mobile.openFilters());
let noticeTimer: ReturnType<typeof setTimeout>, pollTimer: ReturnType<typeof setTimeout>;
function notice(error: unknown) {
  element('notice').textContent = error instanceof Error ? error.message : String(error);
  element('notice').classList.add('visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => element('notice').classList.remove('visible'), 6500);
}
function replace(id: string, html: string) {
  const container = element(id), active = document.activeElement as HTMLElement;
  const items = Array.from(container.querySelectorAll<HTMLElement>('button, a, input, textarea, select, [tabindex]'));
  const index = items.indexOf(active), top = container.scrollTop;
  const focusId = container.contains(active) ? active.id : '';
  const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null;
  const drawerTop = container.querySelector('.drawer-scroll')?.scrollTop ?? 0;
  container.innerHTML = html;
  container.scrollTop = top;
  const drawer = container.querySelector('.drawer-scroll');
  if (drawer) drawer.scrollTop = drawerTop;
  const focus = focusId ? container.querySelector<HTMLElement>(`#${CSS.escape(focusId)}`) : index >= 0 ? container.querySelectorAll<HTMLElement>('button, a, input, textarea, select, [tabindex]')[index] : null;
  focus?.focus({ preventScroll: true });
  if (selection?.[0] != null && (focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement)) focus.setSelectionRange(selection[0], selection[1]);
}
const pendingScores = new Set<number>();
const scoreAgain = (j: Job) => j.score === null && !j.filtered_reason ? `<button data-action="score" data-id="${escape(j.id)}" ${pendingScores.has(j.id) ? 'disabled' : ''}>Score again</button>` : '';
const unscoredVisible = () => jobs.filter(j => j.score === null && !j.content_purged_at);
function renderScoreAll() {
  const bulk = element('bulk-score') as HTMLButtonElement, expired = triage.ids().some(id => jobs.find(j => j.id === id)?.content_purged_at);
  bulk.disabled = !!runningId || starting || !triage.ids().length || expired;
  bulk.title = expired ? 'Expired Jobs have no content to score' : 'Score selected Jobs';
  root.querySelectorAll<HTMLButtonElement>('[data-action="score-all"]').forEach(button => {
    button.disabled = !!runningId || starting || !unscoredVisible().length;
    button.textContent = scoringAll && runningId ? 'Scoring…' : `Score all${unscoredVisible().length ? ` ${unscoredVisible().length}` : ''}`;
  });
}
function emptyJobs() {
  if ((element('job-search') as HTMLInputElement).value.trim()) return '<div class="empty triage-empty"><h3>No Jobs match your search.</h3><button data-action="clear-search">Clear search</button></div>';
  const showing = sourceFilter.count();
  const filtered = root.querySelector<HTMLInputElement>('[name="filtered"]')!;
  const hidden = ['filtered', 'dismissed'].filter(name => !root.querySelector<HTMLInputElement>(`[name="${name}"]`)!.checked);
  const last = sources.map(s => s.last?.finished_at ?? s.last?.started_at)
    .filter((stamp): stamp is string => !!stamp && Number.isFinite(Date.parse(stamp)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const inbox = root.querySelector<HTMLInputElement>('[name="new"]')!.checked && root.querySelector<HTMLInputElement>('[name="unscored"]')!.checked;
  return `<div class="empty triage-empty"><h3>Inbox zero.</h3><p>${inbox ? 'No new Jobs from' : 'No Jobs match the Show toggles for'} the ${showing} Source${showing === 1 ? '' : 's'} you’re showing.${hidden.length ? ` ${hidden.map(name => `${jobCounts[name] ?? 0} ${name === 'filtered' ? 'Filtered' : 'dismissed'}`).join(' and ')} ${hidden.length === 1 && jobCounts[hidden[0]] === 1 ? 'is' : 'are'} hidden.` : ''}</p><div class="empty-actions"><button class="btn primary" data-action="scan" ${runningId || starting ? 'disabled' : ''}>Scan all</button><button data-action="show-filtered" ${filtered.checked ? 'disabled' : ''}>Show Filtered <span class="empty-count">${jobCounts.filtered ?? 0}</span></button><button class="btn ghost" data-action="clear-filters">Clear filters</button></div><a class="muted empty-scan" href="#scans">${last ? `Last Scan ${age(last, true)}` : 'No Scan yet'} · <kbd>s</kbd> Scans</a></div>`;
}
function renderJobs() {
  renderScoreAll();
  element('split-summary').textContent = `${jobs.length} Jobs · ${Array.from(root.querySelectorAll<HTMLInputElement>('.controls > label input:checked'), input => input.name[0].toUpperCase() + input.name.slice(1)).join(', ')} · ${sourceFilter.count()} Sources`;
  mobile.update(jobs.length, `${Array.from(root.querySelectorAll<HTMLInputElement>('.controls > label input:checked'), input => input.name[0].toUpperCase() + input.name.slice(1)).join(', ')} · ${sourceFilter.count()} of ${sources.length} Sources`);
  element('mobile-job-count').textContent = `${jobs.length} Jobs`;
  element('job-count').textContent = `${jobs.length} visible`;
  element('row-position').textContent = `Row ${Math.max(0, jobs.findIndex(j => j.id === selected) + 1)} of ${jobs.length}`;
  (element('job-sort') as HTMLSelectElement).value = sort;
  triage.render();
  element('jobs').setAttribute('aria-busy', 'false');
  replace('jobs', jobs.length ? `<table class="triage-table"><thead><tr><th scope="col">Rank</th><th scope="col">Fit</th><th scope="col">Job</th><th scope="col">Reason</th><th scope="col">Sources</th><th scope="col">Age</th><th scope="col">State</th></tr></thead><tbody>${jobs.map(j =>
    `<tr class="${j.id === selected ? 'selected' : ''} ${triage.has(j.id) ? 'checked' : ''} ${j.state === 'dismissed' ? 'is-dismissed' : ''}" data-job="${escape(j.id)}" aria-selected="${triage.has(j.id)}"><td class="rank">${triage.checkbox(j.id)}<span class="rank-number">${j.id === selected ? '› ' : ''}${j.rank == null ? '—' : Math.round(j.rank)}</span></td><td>${score(j)}</td><td><button class="job-title" data-action="open" data-id="${escape(j.id)}" title="${escape(j.title)}">${escape(j.title)}</button><span class="mobile-only mobile-title">${escape(j.title)}</span><button class="mobile-only mobile-card-action" data-action="open" data-id="${j.id}" aria-label="Open Job: ${escape(j.title)}"></button><p class="company" title="${escape([j.company, j.location_raw, pay(j)].filter(Boolean).join(' · '))}">${escape((detailId ? [j.company, j.source, j.duplicates.length ? `+${j.duplicates.length}` : null] : [j.company, j.location_raw]).filter(Boolean).join(' · '))}</p><p class="mobile-only mobile-job-meta">${escape([j.company, j.location_raw, j.source + (j.duplicates.length ? ` +${j.duplicates.length}` : '')].filter(Boolean).join(' · '))} · ${age(j.posted_at ?? j.first_seen_at)}</p></td><td><div class="row-reason">${escape(j.filtered_reason ? `Filtered · ${j.filtered_reason}` : j.score_reason ?? (j.score === null ? 'Not scored yet.' : ''))}</div>${scoreAgain(j)}</td><td class="row-sources">${external(j.link, j.source)}${j.duplicates.length ? `<button class="tag duplicate" data-action="open" data-id="${escape(j.id)}" title="${escape(j.duplicates.map(d => d.source).join(', '))}" aria-label="${j.duplicates.length} Duplicates; open Job Sources">+${j.duplicates.length}</button>` : ''}</td><td class="age">${age(j.posted_at ?? j.first_seen_at)}</td><td><div class="flags">${j.state === 'new' ? '' : `<span class="tag state ${['seen', 'dismissed', 'applied'].includes(j.state) ? j.state : ''}">${escape(j.state)}</span>`}${j.filtered_reason ? '<span class="tag filtered">Filtered</span>' : j.score === null ? '<span class="tag unscored">unscored</span>' : ''}${j.score_stale ? '<span class="flag">out of date</span>' : ''}${j.content_purged_at ? '<span class="flag">expired</span>' : ''}${j.location_unclear ? '<span class="flag">location unclear</span>' : ''}</div>${j.id === selected ? `<div class="row-actions">${applied(j, j.state === 'applied' ? 'Unmark' : 'Applied')}${dismiss(j)}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : emptyJobs());
}
async function loadJobs() {
  const version = ++jobsVersion;
  const query = new URLSearchParams(Array.from(root.querySelectorAll<HTMLInputElement>('.controls > label input'), input => [input.name, String(input.checked)]));
  const selectedSources = sourceFilter.selection();
  const sourceQuery = new URLSearchParams();
  selectedSources?.forEach(name => { query.append('source', name); sourceQuery.append('source', name); });
  query.set('sort', sort);
  query.set('q', (element('job-search') as HTMLInputElement).value.trim());
  const [next, totals]: [Job[], Record<string, number>] = selectedSources?.length === 0 ? [[], {}] : await Promise.all([
    api<Job[]>(`jobs?${query}`), api<Record<string, number>>(`jobs/counts?${sourceQuery}`),
  ]);
  if (version !== jobsVersion) return;
  root.querySelectorAll<HTMLElement>('[data-count]').forEach(node => { node.textContent = String(totals[node.dataset.count!] ?? 0); });
  jobCounts = totals;
  const previousIndex = Math.max(0, jobs.findIndex(j => j.id === selected));
  jobs = next; triage.sync();
  if (!jobs.some(j => j.id === selected)) selected = jobs[Math.min(previousIndex, jobs.length - 1)]?.id ?? 0;
  renderJobs();
  if (detailId) renderDetail();
}
const scansPage = createScans(replace);
function renderSources() {
  renderScoreAll();
  if (!jobs.length && element('jobs').getAttribute('aria-busy') === 'false') renderJobs();
  const status = element('scan-status');
  const failed = sources.filter(s => sourceStatus(s).failed).length;
  status.classList.toggle('failed', !runningId && failed > 0);
  status.textContent = starting ? 'Starting Scan…' : runningId
    ? `${scoringAll ? 'Scoring' : 'Scanning'}${scan ? ` ${scan.sources.join(', ')}` : '…'}`
    : failed ? `${failed} Source${failed === 1 ? '' : 's'} failed · Open Scans` : 'Scans ready';
  scansPage.update({ sources, scan, running: runningId, starting, scoring: scoringAll, scheduled, connected });
}
async function toggleSchedule() {
  scheduled = (await api<{ upwork: boolean }>('schedule', 'PUT', { upwork: !scheduled })).upwork;
  renderSources();
}
async function loadSources() {
  const result = await api<{ sources: Source[]; running: number | null; scheduled: boolean }>('sources');
  sources = result.sources; scheduled = result.scheduled;
  sourceFilter.update(sources);
  if (sources.some(s => s.name === 'upwork')) connected = (await api<{ connected: boolean }>('upwork/status')).connected;
  renderSources();
  if (result.running && !runningId) watchScan(result.running);
}
function watchScan(id: number) {
  runningId = id; scan = null; clearTimeout(pollTimer); renderSources();
  void pollScan();
}
async function pollScan() {
  try {
    scan = await api<Scan>(`scans/${runningId}`);
    if (scan.status !== 'running') {
      runningId = null; renderSources();
      notice(`${scoringAll ? 'Scoring' : 'Scan'} ${scan.status}`); scoringAll = false; renderScoreAll();
      const results = await Promise.allSettled([loadJobs(), loadSources()]);
      results.forEach(r => { if (r.status === 'rejected') notice(r.reason); });
      return;
    }
    renderSources();
  } catch (error) { notice(error); }
  pollTimer = setTimeout(() => void pollScan(), 2000);
}
async function scoreAll(ids = unscoredVisible().map(j => j.id), bulk = false) {
  if (runningId || starting || !ids.length) return;
  starting = true; scoringAll = true; renderSources();
  try { watchScan((await api<{ id: number }>('jobs/score', 'POST', { ids })).id); if (bulk) triage.remove(ids); }
  catch (error) { scoringAll = false; notice(error); await loadSources(); }
  finally { starting = false; renderSources(); }
}
async function startScan(source?: string) {
  if (runningId || starting) { notice('Scan in progress'); return; }
  starting = true; renderSources();
  try { watchScan((await api<{ id: number }>('scans', 'POST', source ? { sources: [source] } : {})).id); }
  catch (error) { notice(error); await loadSources(); }
  finally { starting = false; renderSources(); }
}
const pendingDrafts = new Set<string>(), pendingQueue = new Set<number>();
async function queueJob(id: number) {
  if (pendingQueue.has(id)) return;
  pendingQueue.add(id); renderDetail();
  try {
    const next = await api<Job>(`jobs/${id}/queue`, 'POST', {});
    updateDetail(next);
    await loadJobs();
  } finally { pendingQueue.delete(id); renderDetail(); }
}
async function writeDraft(id: number, kind: DraftKind) {
  const key = `${id}:${kind}`;
  if (pendingDrafts.has(key) || detail?.id !== id) return;
  const note = document.querySelector<HTMLInputElement>(`#draft-note-${kind}`)?.value || null;
  pendingDrafts.add(key); renderDetail();
  try {
    const next = await api<Job>(`jobs/${id}/drafts`, 'POST', { kind, note });
    delete editing(id).notes[kind]; delete editing(id).versions[kind];
    updateDetail(next);
  } finally { pendingDrafts.delete(key); renderDetail(); }
}
const asks = new Map<number, Asked[]>(), edits = new Map<number, DrawerEdits>();
function editing(id: number) {
  if (!edits.has(id)) edits.set(id, { question: '', notes: {}, versions: {} });
  return edits.get(id)!;
}
function updateDetail(next: Job) {
  if (detailId === next.id) { detailVersion++; detail = next; renderDetail(); }
}
async function ask(id: number) {
  const question = editing(id).question.trim();
  if (!question) return;
  const item: Asked = { question };
  asks.set(id, [...(asks.get(id) ?? []), item]); editing(id).question = ''; renderDetail();
  try { item.answer = (await api<{ answer: string }>(`jobs/${id}/ask`, 'POST', { question })).answer; }
  catch (error) { asks.set(id, (asks.get(id) ?? []).filter(a => a !== item)); if (!editing(id).question) editing(id).question = question; throw error; }
  finally { renderDetail(); }
}
async function copyDraft(index: number) {
  if (!detail) return;
  const content = draftSelection(detail, draftKind(detail), editing(detail.id)).draft?.content;
  if (!content) return;
  await navigator.clipboard.writeText((index < 0 ? content?.text ?? content?.cover : content?.answers?.[index]) ?? '');
}
function renderDetail() {
  const split = !!detailId;
  if (root.classList.contains('split') !== split) (element('triage-filters') as HTMLDetailsElement).open = !split;
  root.classList.toggle('split', split);
  if (!split) { element('detail').innerHTML = ''; return; }
  replace('detail', renderDrawer({ job: detail && { ...detail, rank: jobs.find(j => j.id === detailId)?.rank }, id: detailId, index: jobs.findIndex(j => j.id === detailId), total: jobs.length,
    section: activeSection, edits: editing(detailId), pendingDrafts, pendingScores, pendingQueue,
    asks: asks.get(detailId) ?? [], unscored: unscoredVisible().length, scoreAllDisabled: !!runningId || starting || !unscoredVisible().length }));
  renderScoreAll(); triage.render();
}
async function openJob(id: number, focus = !detailId) {
  if (id === detailId && detail) return;
  const version = ++detailVersion;
  selected = id; detailId = id; detail = null; activeSection = 'fit'; renderJobs(); renderDetail();
  if (focus) element('detail').querySelector<HTMLElement>('.drawer')?.focus({ preventScroll: true });
  const j = await api<Job>(`jobs/${id}`);
  if (detailId !== id || version !== detailVersion) return;
  detail = j; renderDetail();
  if (j.state === 'new' && !j.queued) {
    await api(`jobs/${id}`, 'PATCH', { state: 'seen' });
    const row = jobs.find(job => job.id === id); if (row?.state === 'new') row.state = 'seen';
    if (detailId === id && detail?.state === 'new') detail.state = 'seen';
    renderJobs(); if (detailId === id) renderDetail();
  }
}
function closeDetail() {
  if (!detailId) return;
  const id = jobs.some(j => j.id === detailId) ? detailId : selected; detailId = 0; detail = null; detailVersion++; renderDetail(); renderJobs();
  Array.from(root.querySelectorAll<HTMLElement>(`[data-action="open"][data-id="${id}"]`)).find(button => button.getClientRects().length)?.focus({ preventScroll: true });
  if (view === 'triage') mobile.revealCursor(id);
}
function moveJob(step: number) {
  const index = jobs.findIndex(j => j.id === (detailId || selected));
  const nextIndex = index < 0 ? jobs.findIndex(j => j.id === selected) : index + step;
  const next = jobs[Math.max(0, Math.min(jobs.length - 1, nextIndex))];
  if (!next) return;
  if (detailId) void openJob(next.id, false).catch(notice);
  else { selected = next.id; renderJobs(); }
  root.querySelector(`[data-job="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
}
function jumpSection(section: string) {
  const target = document.getElementById(`drawer-${section}`);
  element('detail').querySelector<HTMLElement>('.drawer')?.setAttribute('data-section', section);
  if (!target) return;
  activeSection = section;
  const copy = root.querySelector<HTMLButtonElement>('.mobile-job-actions [data-action=copy-draft]');
  if (copy) copy.disabled = section !== 'draft' || copy.dataset.available !== 'true';
  const pane = target.closest<HTMLElement>('.drawer-scroll');
  if (pane) pane.scrollTo({ top: mobile.phone ? 0 : target.offsetTop - (pane.querySelector('.drawer-nav')?.clientHeight ?? 0) - 12 });
  target.focus({ preventScroll: true });
  root.querySelectorAll<HTMLElement>('.drawer-nav button').forEach(button => {
    if (button.dataset.section === section) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
  });
}
const changeState = (id: number, state: string) => triage.state([id], state);
async function scoreJob(id: number) {
  if (pendingScores.has(id)) return;
  pendingScores.add(id); renderJobs(); renderDetail();
  try {
    const next = await api<Job>(`jobs/${id}/score`, 'POST', {});
    updateDetail(next);
    await loadJobs();
  } finally { pendingScores.delete(id); renderJobs(); renderDetail(); }
}
const triage = createTriageActions({
  jobs: () => jobs, cursor: () => selected, select: id => { selected = id; }, detail: () => detail,
  patch: async (id, state) => { await api(`jobs/${id}`, 'PATCH', { state }); },
  update(id, state) {
    const row = jobs.find(j => j.id === id); if (row) row.state = state;
    if (detail?.id === id) { detailVersion++; detail.state = state; renderDetail(); }
  }, refresh: async () => {
    await loadJobs();
    const row = root.querySelector<HTMLElement>(`[data-job="${selected}"]`);
    if (row?.getClientRects().length) row.scrollIntoView({ block: 'nearest' });
  }, render: renderJobs, error: notice,
});
const mobile = createMobile({ state: changeState, error: notice, refresh: () => void loadSources().catch(notice) });
function showView(next: string, focus = false) {
  sourceFilter.close();
  view = next === 'scans' ? 'scans' : 'triage';
  closeDetail();
  element('triage').hidden = view !== 'triage';
  element('job-search-box').hidden = view !== 'triage';
  if (view !== 'triage') triage.clear();
  element('a-scans').hidden = view !== 'scans';
  element('manual-panel').hidden = view !== 'triage';
  document.querySelectorAll<HTMLElement>('.app-nav [data-view], #mobile-nav [data-view]').forEach(tab => {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  document.title = `joule · ${view === 'triage' ? 'Triage' : 'Scans'}`;
  if ((element('mobile-filters') as HTMLDialogElement).open) (element('mobile-filters') as HTMLDialogElement).close();
  if (focus) element(view === 'triage' ? 'triage' : 'a-scans').focus();
}
window.addEventListener('hashchange', () => showView(location.hash.slice(1), true));
showView(location.hash.slice(1));
root.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target || target instanceof HTMLInputElement) {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-job]');
    if (row && !(event.target as HTMLElement).closest('a, button, input, label')) { if (detailId) void openJob(Number(row.dataset.job), false).catch(notice); else { selected = Number(row.dataset.job); renderJobs(); } }
    return;
  }
  if (target.dataset.action === 'show-filtered') {
    root.querySelector<HTMLInputElement>('[name="filtered"]')!.checked = true;
    void loadJobs().catch(notice);
  }
  if (target.dataset.action === 'clear-filters') {
    (element('job-search') as HTMLInputElement).value = '';
    sourceFilter.reset();
    root.querySelectorAll<HTMLInputElement>('.controls > label input').forEach(input => { input.checked = ['new', 'unscored'].includes(input.name); });
    void loadJobs().catch(notice);
  }
  const id = Number(target.dataset.id);
  if (target.dataset.action === 'move') moveJob(Number(target.dataset.step));
  if (target.dataset.action === 'section') jumpSection(target.dataset.section!);
  if (target.dataset.action === 'version') {
    const kind = target.dataset.kind as DraftKind;
    editing(detailId).versions[kind] = id; renderDetail(); element(`draft-versions-${kind}`).focus({ preventScroll: true });
  }
  if (target.dataset.action === 'undo') void triage.undo().catch(notice);
  if (target.dataset.action === 'clear-selection') triage.clear();
  if (target.dataset.action === 'bulk-state') void triage.state(triage.ids(), target.dataset.state!).catch(notice);
  if (target.dataset.action === 'bulk-score') void scoreAll(triage.ids(), true).catch(notice);
  if (target.dataset.action === 'dismiss-below') void triage.state(triage.below(), 'dismissed').catch(notice);
  if (target.dataset.action === 'clear-search') { (element('job-search') as HTMLInputElement).value = ''; void loadJobs().catch(notice); }
  if (target.dataset.action === 'queue') void queueJob(id).catch(notice);
  if (target.dataset.action === 'telegram') void api('telegram/start', 'POST', {}).then(() => notice('Sent the queue head to Telegram')).catch(notice);
  if (target.dataset.action === 'open') void openJob(id).catch(notice);
  if (target.dataset.action === 'draft') void writeDraft(id, target.dataset.kind as DraftKind).catch(notice);
  if (target.dataset.action === 'schedule') void toggleSchedule().catch(notice);
  if (target.dataset.action === 'ask') void ask(id).catch(notice);
  if (target.dataset.action === 'copy-answer') void navigator.clipboard.writeText(asks.get(detailId)?.[Number(target.dataset.index)]?.answer ?? '').catch(notice);
  if (target.dataset.action === 'copy-draft') void copyDraft(Number(target.dataset.index)).catch(notice);
  if (target.dataset.action === 'score-all') void scoreAll().catch(notice);
  if (target.dataset.action === 'score') void scoreJob(id).catch(notice);
  if (target.dataset.action === 'state') void changeState(id, target.dataset.state!).catch(notice);
  if (target.dataset.action === 'close') closeDetail();
  if (target.dataset.action === 'scan') void startScan(target.dataset.source).catch(notice);
  if (target.dataset.action === 'connect') window.open('/auth/upwork/connect', 'upwork-connect', 'popup,width=640,height=760');
});
window.addEventListener('message', event => {
  if (event.origin === location.origin && event.data === 'upwork-connected') { notice('Upwork connected'); void loadSources().catch(notice); }
});
root.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.pickJob) triage.toggle(Number(input.dataset.pickJob));
  if (input.id === 'job-sort') sort = input.value;
  if (input.matches('.controls > label input, #job-sort')) void loadJobs().catch(notice);
});
element('job-search').addEventListener('input', () => void loadJobs().catch(notice));
const shortcuts = element('shortcuts') as HTMLDialogElement;
element('show-shortcuts').addEventListener('click', () => shortcuts.showModal());
element('close-shortcuts').addEventListener('click', () => shortcuts.close());
root.addEventListener('input', event => {
  const target = event.target;
  if (!detailId || !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) || !target.closest('#detail')) return;
  if (target.dataset.note) editing(detailId).notes[target.dataset.note as DraftKind] = target.value;
  if (target.id === 'ask-question') editing(detailId).question = target.value;
});
document.addEventListener('keydown', event => {
  if ((element('mobile-filters') as HTMLDialogElement).open || shortcuts.open) return;
  const versions = root.querySelector<HTMLElement>('.draft-version-menu:popover-open');
  if (event.key === 'Escape' && versions) {
    event.preventDefault(); versions.hidePopover(); element(versions.id.replace('draft-version-menu-', 'draft-versions-')).focus({ preventScroll: true }); return;
  }
  if (event.key === 'Escape' && triage.ids().length) { event.preventDefault(); triage.clear(); return; }
  if (event.key === 'Escape' && detailId) { closeDetail(); return; }
  if ((event.target as HTMLElement).closest('input:not([type=checkbox]), textarea, select, [contenteditable]') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === '?') { event.preventDefault(); shortcuts.showModal(); return; }
  if (event.key === '/' && view === 'triage') { event.preventDefault(); if (mobile.phone) closeDetail(); (element('job-search') as HTMLInputElement).focus(); return; }
  if (event.key === 'z') { event.preventDefault(); void triage.undo().catch(notice); return; }
  if (event.key === 's') { event.preventDefault(); location.hash = 'scans'; return; }
  if (event.key === 'Escape' && view === 'scans') { location.hash = 'triage'; return; }
  if (view !== 'triage' || (!jobs.length && !detailId)) return;
  if (event.key === 'x' && selected) { event.preventDefault(); triage.toggle(selected); return; }
  if (triage.ids().length && ['a', 'd'].includes(event.key)) { event.preventDefault(); void triage.state(triage.ids(), event.key === 'a' ? 'applied' : 'dismissed').catch(notice); return; }
  if (detailId && ['1', '2', '3', '4'].includes(event.key)) { event.preventDefault(); jumpSection(['fit', 'draft', 'cv', 'ask'][Number(event.key) - 1]); return; }
  if (detailId && event.key === 'c') { event.preventDefault(); void copyDraft(-1).catch(notice); return; }
  if (['j', 'k', 'o', 'd', 'a'].includes(event.key)) event.preventDefault();
  if (event.key === 'j' || event.key === 'k') moveJob(event.key === 'j' ? 1 : -1);
  if (event.key === 'o' && selected) void openJob(selected).catch(notice);
  if (detailId && !detail) return;
  const job = detail ?? jobs.find(j => j.id === selected);
  if (!job) return;
  if (event.key === 'a') void changeState(job.id, job.state === 'applied' ? 'seen' : 'applied').catch(notice);
  if (event.key === 'd') void changeState(job.id, job.state === 'dismissed' ? 'seen' : 'dismissed').catch(notice);
});
void Promise.allSettled([loadJobs(), loadSources()]).then(results => results.forEach(r => { if (r.status === 'rejected') notice(r.reason); }));
