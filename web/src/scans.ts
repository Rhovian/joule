import type { Source, Scan } from './types';
import { age, escape, dateTime } from './format';
import { sourceStatus } from './source-status';

type State = { sources: Source[]; scan: Scan | null; running: number | null; starting: boolean; scoring: boolean; scheduled: boolean; connected: boolean };
export function createScans(replace: (id: string, html: string) => void) {
  const page = document.getElementById('a-scans')!;
  page.innerHTML = `<div class="scans-layout"><div class="scans-main"><header class="scans-heading"><div><h2>Scans</h2><p id="scans-summary" class="muted">Loading Sources…</p></div><button id="scan-all" class="btn primary" data-action="scan">Scan all</button></header><div id="scans-progress" class="scan-progress" role="status"></div><details class="scan-filter-panel" open><summary class="mobile-only">Find or filter Sources</summary><div class="scans-filters" role="group" aria-label="Filter Sources">${[['all', 'All'], ['failed', 'Failed'], ['stale', 'Stale'], ['never', 'Never scanned']].map(([key, label]) => `<button class="chip" data-scan-filter="${key}" aria-pressed="${key === 'all'}">${label} <span data-scan-count="${key}">0</span></button>`).join('')}<span class="scans-sort muted">Needs attention first, then newest Scan</span><label class="scan-search"><span class="sr-only">Find a Source</span><input id="scan-search" type="search" placeholder="Find a Source" autocomplete="off"></label></div></details><div class="table-wrap"><table class="scan-table"><caption class="mobile-only">Sources · New / Duplicate / Filtered / Scored</caption><thead><tr>${['Source', 'Status', 'Last Scan', 'New', 'Duplicate', 'Filtered', 'Scored', ''].map(label => `<th scope="col">${label || '<span class="sr-only">Actions</span>'}</th>`).join('')}</tr></thead><tbody id="scan-rows"></tbody></table></div></div><aside aria-label="Scan settings and reply rates"><div id="scan-settings"></div><section id="source-reply-rates" class="reply-card"></section></aside></div>`;
  let state: State, filter = 'all', settingsHTML = '';
  const search = document.getElementById('scan-search') as HTMLInputElement;
  const closedErrors = new Set<string>();
  function renderRows() {
    if (!state) return;
    const { sources, scan, running, starting } = state, query = search.value.trim().toLocaleLowerCase();
    const rows = sources.map(source => {
      if (running && scan?.id === running && scan.sources.includes(source.name)) source = { ...source, last_finished: sourceStatus(source).finished ?? null,
        last: { id: scan.id, status: scan.status, started_at: scan.started_at, finished_at: scan.finished_at, counts: scan.per_source[source.name] ?? null } };
      return { source, inScan: !!running && source.last?.id === running, ...sourceStatus(source) };
    });
    page.querySelectorAll<HTMLElement>('[data-scan-count]').forEach(node => {
      const key = node.dataset.scanCount!;
      node.textContent = String(key === 'all' ? rows.length : rows.filter(row => row[key as 'failed' | 'stale' | 'never']).length);
    });
    page.querySelectorAll<HTMLElement>('[data-scan-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scanFilter === filter)));
    const matching = rows.filter(row => (filter === 'all' || row[filter as 'failed' | 'stale' | 'never']) && row.source.name.toLocaleLowerCase().includes(query));
    const attention = (row: typeof rows[number]) => Number(row.failed || row.stale || row.never || row.interrupted);
    matching.sort((a, b) => attention(b) - attention(a) || Date.parse(b.source.last?.started_at ?? '1970-01-01') - Date.parse(a.source.last?.started_at ?? '1970-01-01') || a.source.name.localeCompare(b.source.name));
    replace('scan-rows', matching.map(({ source: s, inScan, finished, stamp, days, failed, interrupted, stale, never }) => {
      const counts = (inScan ? s.last?.counts : null) ?? finished?.counts;
      const errors = [...new Set([...(inScan ? finished?.counts?.errors ?? [] : []), ...(counts?.errors ?? [])])];
      if (failed && !errors.length) errors.push('Scan failed; no Source error details were recorded.');
      const errorId = `scan-errors-${s.name}`, open = !closedErrors.has(s.name);
      return `<tr data-scan-source="${escape(s.name)}" class="${inScan ? 'in-scan' : ''}"><th scope="row">${escape(s.name)}<small class="mobile-only mobile-scan-meta">${stamp ? age(stamp, true) : 'never'} · ${['new', 'duplicate', 'filtered', 'scored'].map(key => counts ? escape(counts[key as 'new' | 'duplicate' | 'filtered' | 'scored'] ?? 0) : '—').join(' · ')}</small></th><td><div class="flags">${inScan ? '<span class="tag running" title="Included in the current Scan">in Scan</span>' : ''}${failed || errors.length ? errors.length ? `<button id="scan-error-toggle-${escape(s.name)}" class="tag failed" data-scan-errors="${escape(s.name)}" aria-expanded="${open}" aria-controls="${escape(errorId)}">failed ▾</button>` : '<span class="tag failed">failed</span>' : interrupted ? '<span class="tag filtered">interrupted</span>' : !inScan ? `<span class="tag ${never ? 'dismissed' : 'duplicate'}">${never ? 'never scanned' : 'done'}</span>` : ''}${stale ? `<span class="tag filtered">${days}d old</span>` : ''}</div></td><td class="scan-date">${stamp ? `<time datetime="${escape(stamp)}" title="Last finished Scan">${escape(dateTime(stamp))}</time>` : '—'}</td>${['new', 'duplicate', 'filtered', 'scored'].map(key => `<td class="scan-number">${counts ? escape(counts[key as 'new' | 'duplicate' | 'filtered' | 'scored'] ?? 0) : '—'}</td>`).join('')}<td class="scan-action"><button id="scan-source-${escape(s.name)}" class="btn small" data-action="scan" data-source="${escape(s.name)}" ${running || starting ? 'disabled' : ''}>${inScan ? 'In Scan' : failed ? 'Retry' : 'Scan'}</button></td></tr>${errors.length ? `<tr id="${escape(errorId)}" class="scan-error-row" ${open ? '' : 'hidden'}><td colspan="8"><div class="scan-error"><div>${errors.map(error => `<p>${escape(error)}</p>`).join('')}</div>${s.name === 'upwork' ? '<button class="btn small" data-action="connect">Reconnect Upwork</button>' : ''}</div></td></tr>` : ''}`;
    }).join('') || `<tr><td colspan="8" class="empty">${sources.length ? 'No Sources match these filters.' : 'No Sources enabled.'}</td></tr>`);
  }
  search.addEventListener('input', renderRows);
  page.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('button');
    if (button?.dataset.scanFilter) { filter = button.dataset.scanFilter; renderRows(); }
    if (button?.dataset.scanErrors) {
      const name = button.dataset.scanErrors;
      if (!closedErrors.delete(name)) closedErrors.add(name);
      renderRows();
    }
  });
  return { update(next: State) {
    state = next;
    const { sources, scan, running, starting, scoring, scheduled, connected } = state;
    const latest = sources.map(s => sourceStatus(s).stamp).filter((stamp): stamp is string => !!stamp).sort().at(-1);
    document.getElementById('scans-summary')!.textContent = `${sources.length} Source${sources.length === 1 ? '' : 's'}${latest ? ` · last completed Scan ${dateTime(latest)}` : ''}`;
    (document.getElementById('scan-all') as HTMLButtonElement).disabled = !!running || starting;
    const counts = scan && running ? Object.values(scan.per_source) : [];
    const progress = document.getElementById('scans-progress')!;
    progress.hidden = !running && !starting;
    progress.innerHTML = `<strong><span class="desktop-scan-progress">${starting && !running ? 'Starting Scan…' : `${scoring ? 'Scoring' : 'Scanning'} ${escape(scan?.sources.join(', ') ?? 'Sources…')}`}</span><span class="mobile-only">${starting && !running ? 'Starting Scan…' : `${scoring ? 'Scoring' : 'Scanning'} ${scan ? `${scan.sources.length} Source${scan.sources.length === 1 ? '' : 's'}` : 'Sources…'}`}</span></strong><span class="muted">${counts.length ? `${counts.reduce((n, c) => n + c.new, 0)} new · ${counts.reduce((n, c) => n + c.duplicate, 0)} Duplicate · ${counts.reduce((n, c) => n + c.filtered, 0)} Filtered · ${counts.reduce((n, c) => n + c.scored, 0)} scored` : 'Waiting for Source counts…'}</span><progress aria-label="Scan in progress"></progress>${scan && running ? age(scan.started_at, true) : ''}`;
    const settings = sources.some(s => s.name === 'upwork') ? `<section class="scan-card"><div class="schedule-heading"><div><h3>Scheduled Scans</h3><p class="muted">${scheduled ? 'On' : 'Off'} · Upwork only</p></div><button class="schedule-switch" data-action="schedule" role="switch" aria-label="Scheduled Upwork Scans" aria-checked="${scheduled}"><span></span></button></div></section><section class="scan-card"><h3>Telegram queue</h3><p class="muted">Review queued Upwork Proposals in Telegram.</p><button class="btn" data-action="telegram">Start Telegram queue</button></section><section class="scan-card"><h3>Upwork connection</h3><p class="${connected ? 'connected' : 'muted'}">${connected ? '● Connected' : 'Not connected'}</p>${connected ? '' : '<button class="btn" data-action="connect">Connect Upwork</button>'}</section><p class="muted scan-keys"><kbd>s</kbd> opens Scans · <kbd>Esc</kbd> returns to Triage</p>` : '<p class="muted">Upwork controls appear when that Source is enabled.</p>';
    // astro@7.3.8/dist/runtime/client/load.js only hydrates; retain unchanged controls across polls.
    if (settings !== settingsHTML) { replace('scan-settings', settings); settingsHTML = settings; }
    renderRows();
  } };
}
