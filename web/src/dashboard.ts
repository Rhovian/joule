export {};
type Counts = { new: number; duplicate: number; filtered: number; errors: string[] };
type Scan = { id: number; status: string; started_at: string; finished_at: string | null; sources: string[]; per_source: Record<string, Counts> };
type Source = { name: string; last: (Omit<Scan, 'sources' | 'per_source'> & { counts: Counts }) | null };
type Job = {
  id: number; title: string; company: string | null; source: string; link: string; state: string;
  score: number | null; score_reason: string | null; filtered_reason: string | null;
  location_raw: string | null; location_unclear: number | null; pay_min: number | null;
  pay_max: number | null; pay_currency: string | null; pay_period: string | null;
  duplicates: { id: number; source: string; link: string }[]; description?: string | null;
  extra?: { client?: Record<string, unknown>; screening_questions?: string[]; apply_url?: string } | null;
};
const root = document.querySelector<HTMLElement>('#dashboard')!;
const element = (id: string) => document.getElementById(id)!;
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function external(url: unknown, label: unknown) {
  try {
    const parsed = new URL(String(url));
    if (['http:', 'https:'].includes(parsed.protocol)) return `<a href="${escape(parsed.href)}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>`;
  } catch { /* Invalid links remain text. */ }
  return escape(label);
}
function descriptionText(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node instanceof Element && /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(node.tagName)) return '';
    const block = node instanceof Element && /^(P|BR|LI|DIV|H[1-6])$/.test(node.tagName);
    return `${block ? '\n' : ''}${Array.from(node.childNodes, walk).join('')}${block ? '\n' : ''}`;
  };
  return walk(doc.body).replace(/\n[\t ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `Request failed (${response.status})`);
  return data as T;
}
let jobs: Job[] = [], sources: Source[] = [], selected = 0, detail: Job | null = null;
let detailId = 0, jobsVersion = 0, connected = true, runningId: number | null = null, scan: Scan | null = null, starting = false;
let noticeTimer: ReturnType<typeof setTimeout>, pollTimer: ReturnType<typeof setTimeout>;
function notice(error: unknown) {
  element('notice').textContent = error instanceof Error ? error.message : String(error);
  element('notice').classList.add('visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => element('notice').classList.remove('visible'), 6500);
}
function replace(id: string, html: string) {
  const container = element(id), active = document.activeElement as HTMLElement;
  const items = Array.from(container.querySelectorAll<HTMLElement>('button, a'));
  const index = items.indexOf(active), top = container.scrollTop;
  container.innerHTML = html;
  container.scrollTop = top;
  if (index >= 0) container.querySelectorAll<HTMLElement>('button, a')[index]?.focus({ preventScroll: true });
}
const dismiss = (j: Job) => `<button data-action="state" data-id="${escape(j.id)}">${j.state === 'dismissed' ? 'Restore' : 'Dismiss'}</button>`;
const score = (j: Job) => `<span class="score ${j.score === null ? 'unscored' : j.score >= 75 ? 'high' : j.score >= 50 ? 'mid' : 'low'}">${escape(j.score ?? '—')}</span>`;
const links = (j: Job) => `<div class="source-links">Primary · ${external(j.link, j.source)}${j.duplicates.map(d => `<span>Duplicate · ${external(d.link, d.source)}</span>`).join('')}</div>`;
const flags = (j: Job) => `<span class="state ${['new', 'seen', 'dismissed'].includes(j.state) ? j.state : ''}">${escape(j.state)}</span>${j.location_unclear ? '<span class="flag">location unclear</span>' : ''}${j.filtered_reason ? '<span class="flag">Filtered</span>' : ''}`;
const reason = (j: Job) => `<p class="reason">${escape(j.score_reason)}</p>${j.filtered_reason ? `<p class="reason">Filtered · ${escape(j.filtered_reason)}</p>` : ''}`;
function pay(j: Job) {
  const values = [j.pay_min, j.pay_max].filter((n): n is number => n !== null);
  return values.length ? `${[...new Set(values)].join('–')} ${j.pay_currency ?? ''}${j.pay_period ? ` /${j.pay_period}` : ''}` : '';
}
function renderJobs() {
  element('job-count').textContent = `${jobs.length} visible`;
  replace('jobs', `<table class="triage-table"><thead><tr><th>Primary Job / Sources</th><th>Fit Score / reasoning</th><th>Location / pay</th><th>State / actions</th></tr></thead><tbody>${jobs.map(j =>
    `<tr class="${j.id === selected ? 'selected' : ''} ${j.state === 'dismissed' ? 'is-dismissed' : ''}" data-job="${escape(j.id)}"><td><button class="job-title" data-action="open" data-id="${escape(j.id)}">${escape(j.title)}</button><p class="company">${escape(j.company)}</p>${links(j)}</td><td><div class="table-score">${score(j)}<span>${j.score === null ? 'unscored' : 'Fit Score'}</span></div>${reason(j)}</td><td><p>${escape(j.location_raw)}</p><small>${escape(pay(j))}</small></td><td><div class="flags">${flags(j)}</div><div class="row-actions">${dismiss(j)}</div></td></tr>`).join('')}</tbody></table>${jobs.length ? '' : '<p class="empty">No visible Jobs. Run a Scan or adjust the toggles.</p>'}`);
}
async function loadJobs() {
  const version = ++jobsVersion;
  const query = new URLSearchParams(Array.from(root.querySelectorAll<HTMLInputElement>('.controls input'), input => [input.name, String(input.checked)]));
  const next = await api<Job[]>(`jobs?${query}`);
  if (version !== jobsVersion) return;
  jobs = next;
  if (!jobs.some(j => j.id === selected)) selected = jobs[0]?.id ?? 0;
  renderJobs();
}
function counts(c?: Counts) {
  return c ? `<p class="scan-counts">${escape(c.new)} new · ${escape(c.duplicate)} Duplicate · ${escape(c.filtered)} Filtered</p>${(c.errors ?? []).map(e => `<p class="scan-error">${escape(e)}</p>`).join('')}` : '';
}
function renderSources() {
  replace('a-scans', `<section class="scan-panel"><div class="section-heading"><h2>Scans</h2><button data-action="scan" ${runningId || starting ? 'disabled' : ''}>Scan all</button></div><p class="muted">Discover Jobs from each Source.</p>${runningId ? `<div class="scan-progress" role="status"><strong>Scan in progress</strong>${scan ? scan.sources.map(name => `<div>${escape(name)}${counts(scan?.per_source[name])}</div>`).join('') : '<span>Waiting for Source counts…</span>'}</div>` : '<p class="scan-idle">Ready for a new Scan</p>'}<div class="scan-sources">${sources.map(s => `<article class="scan-source"><div><strong>${escape(s.name)}</strong><button data-action="scan" data-source="${escape(s.name)}" ${runningId || starting ? 'disabled' : ''}>Scan</button></div>${s.last ? `<small>Last Scan · ${escape(s.last.finished_at ?? s.last.started_at)} · ${escape(s.last.status)}</small>${counts(s.last.counts)}` : '<small>No Scan yet</small>'}${s.name === 'upwork' && !connected ? '<p class="connect"><a href="/auth/upwork/connect">Connect Upwork</a></p>' : ''}</article>`).join('')}</div></section>`);
}
async function loadSources() {
  const result = await api<{ sources: Source[]; running: number | null }>('sources');
  sources = result.sources;
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
      notice(`Scan ${scan.status}`);
      const results = await Promise.allSettled([loadJobs(), loadSources()]);
      results.forEach(r => { if (r.status === 'rejected') notice(r.reason); });
      return;
    }
    renderSources();
  } catch (error) { notice(error); }
  pollTimer = setTimeout(() => void pollScan(), 2000);
}
async function startScan(source?: string) {
  if (runningId || starting) { notice('Scan in progress'); return; }
  starting = true; renderSources();
  try { watchScan((await api<{ id: number }>('scans', 'POST', source ? { sources: [source] } : {})).id); }
  catch (error) { notice(error); await loadSources(); }
  finally { starting = false; renderSources(); }
}
function renderDetail() {
  if (!detailId) { element('detail').innerHTML = ''; return; }
  const j = detail;
  const client = j?.extra?.client;
  replace('detail', `<div class="drawer-backdrop" data-action="close"></div><aside class="job-detail drawer" role="dialog" aria-modal="false" aria-label="Job detail" tabindex="-1"><div class="detail-top"><span class="eyebrow">PRIMARY JOB · ${escape(detailId)}</span><button data-action="close" aria-label="Close Job detail">Close ×</button></div>${j ? `<div class="detail-heading">${score(j)}<div><h2>${escape(j.title)}</h2><p>${escape(j.company)}</p></div></div><div class="flags">${flags(j)}</div><p class="job-meta">${escape(j.location_raw)} · ${escape(pay(j))}</p>${links(j)}${reason(j)}${client ? `<div class="client-stats">Client · ${Object.entries(client).map(([key, value]) => `${escape(key.replaceAll('_', ' '))}: ${escape(typeof value === 'object' && value !== null ? JSON.stringify(value) : value)}`).join(' · ')}</div>` : ''}<div class="detail-actions">${dismiss(j)}${external(j.link, 'Open Primary Job')}${j.extra?.apply_url ? external(j.extra.apply_url, 'Apply') : ''}</div><section class="job-content"><h3>Job detail</h3><p class="description">${escape(descriptionText(j.description ?? ''))}</p>${j.extra?.screening_questions?.length ? `<h4>Screening questions</h4><ol>${j.extra.screening_questions.map(q => `<li>${escape(q)}</li>`).join('')}</ol>` : ''}</section>` : '<p class="muted">Loading Job…</p>'}</aside>`);
}
async function openJob(id: number) {
  selected = id; detailId = id; detail = null; renderJobs(); renderDetail();
  element('detail').querySelector<HTMLElement>('button')?.focus();
  const j = await api<Job>(`jobs/${id}`);
  if (detailId !== id) return;
  detail = j; renderDetail();
  if (j.state === 'new') {
    await api(`jobs/${id}`, 'PATCH', { state: 'seen' });
    j.state = 'seen'; const row = jobs.find(job => job.id === id); if (row) row.state = 'seen';
    renderJobs(); if (detailId === id) renderDetail();
  }
}
function closeDetail() {
  const id = detailId; detailId = 0; detail = null; renderDetail();
  root.querySelector<HTMLElement>(`[data-action="open"][data-id="${id}"]`)?.focus({ preventScroll: true });
}
async function changeState(id: number) {
  const j = detail?.id === id ? detail : jobs.find(job => job.id === id);
  if (!j) return;
  const state = j.state === 'dismissed' ? 'seen' : 'dismissed';
  await api(`jobs/${id}`, 'PATCH', { state });
  j.state = state;
  if (detail?.id === id) { detail.state = state; renderDetail(); }
  await loadJobs();
}
function focusScans() {
  if (matchMedia('(width < 900px)').matches) { closeDetail(); element('a-scans').classList.add('is-open'); }
  root.querySelector('[data-action="scans"]')?.setAttribute('aria-expanded', String(element('a-scans').classList.contains('is-open')));
  element('a-scans').focus();
}
root.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target || target instanceof HTMLInputElement) return;
  const id = Number(target.dataset.id);
  if (target.dataset.action === 'open') void openJob(id).catch(notice);
  if (target.dataset.action === 'state') void changeState(id).catch(notice);
  if (target.dataset.action === 'close') closeDetail();
  if (target.dataset.action === 'scan') void startScan(target.dataset.source).catch(notice);
  if (target.dataset.action === 'scans') {
    const open = element('a-scans').classList.toggle('is-open'); target.setAttribute('aria-expanded', String(open));
    if (open) element('a-scans').focus();
  }
});
root.addEventListener('change', event => { if ((event.target as HTMLElement).closest('.controls')) void loadJobs().catch(notice); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && detailId) { closeDetail(); return; }
  if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable]') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 's') { event.preventDefault(); focusScans(); return; }
  if (detailId || !jobs.length) return;
  if (['j', 'k', 'o', 'd'].includes(event.key)) event.preventDefault();
  if (event.key === 'j' || event.key === 'k') {
    const index = jobs.findIndex(j => j.id === selected);
    selected = jobs[Math.max(0, Math.min(jobs.length - 1, index + (event.key === 'j' ? 1 : -1)))].id;
    renderJobs(); root.querySelector(`[data-job="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  if (event.key === 'o') void openJob(selected).catch(notice);
  if (event.key === 'd') void changeState(selected).catch(notice);
});
void Promise.allSettled([loadJobs(), loadSources()]).then(results => results.forEach(r => { if (r.status === 'rejected') notice(r.reason); }));
