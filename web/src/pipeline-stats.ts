import { escape } from './format';
import './pipeline-stats.css';
type Rate = { name: string; applied: number; replies: number };
type Terminal = { at: number; stage: string | null; closed_reason: string | null; count: number };
export type Statistics = { follow_up_ids: number[]; follow_up_days: number; no_reply_days: number; total: number; job_ids: number[]; replies: number; reached: number[]; terminals: Terminal[]; bands: Rate[]; sources: Rate[] };
const stages = ['Applied', 'Screen', 'Interview', 'Offer', 'Accepted'];
const names: Record<string, string> = { applied:'Waiting', screen:'In screen', interview:'Interviewing', offer:'Deciding', accepted:'Accepted', stage:'Still in stage', no_reply:'No reply', rejected:'Rejected', withdrawn:'Withdrawn' };
const percent = (n: number, total: number) => total ? `${Math.round(100 * n / total)}%` : '—';
export const periodSelect = () => `<label class="pipeline-period">Applied <select data-pipeline-period aria-label="Application period"><option value="">All time</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></label>`;
function rates(rows: Rate[]) {
  return rows.map(row => `<div class="reply-rate"><span title="${escape(row.name)}">${escape(row.name)}</span><meter min="0" max="${row.applied || 1}" value="${row.replies}" aria-label="${escape(row.name)} reply rate"></meter><span>${row.replies} of ${row.applied} · ${percent(row.replies, row.applied)}</span></div>`).join('');
}
function flow(data: Statistics) {
  const scale = 150 / data.total, step = 215, top = 34;
  let paths = '', labels = '', height = 210;
  // Native SVG paths: Astro's client runtime hydrates components; it supplies no chart layout.
  // astro@7.3.8/dist/runtime/client/load.js
  for (let at = 0; at < 4; at++) {
    const x = at * step, next = (data.reached[at + 1] || 0) * scale;
    const ribbon = (y: number, end: number, size: number, kind: string, text: string) => `<path class="flow-${kind}" d="M${x+7},${y} C${x+100},${y} ${x+115},${end} ${x+step},${end} V${end+size} C${x+115},${end+size} ${x+100},${y+size} ${x+7},${y+size} Z"><title>${escape(text)}</title></path><rect class="flow-${kind} flow-node" x="${x+step}" y="${end}" width="7" height="${size}" rx="1"/>`;
    labels += `<text x="${x}" y="20">${stages[at]} ${data.reached[at]}</text><rect class="flow-moved flow-node" x="${x}" y="${top}" width="7" height="${data.reached[at]*scale}" rx="1"/>`;
    if (next) paths += ribbon(top, top, next, 'moved', `${stages[at+1]}: ${data.reached[at+1]}`);
    let source = top + next, end = source + 12;
    const terminals = data.terminals.filter(t => t.at === at).sort((a,b) => Number(!!a.closed_reason) - Number(!!b.closed_reason) || (a.closed_reason || a.stage!).localeCompare(b.closed_reason || b.stage!));
    for (const item of terminals) {
      const size = item.count * scale, kind = item.closed_reason || 'stage';
      const returned = !item.closed_reason && stages.findIndex(stage => stage.toLowerCase() === item.stage) < at;
      const text = `${returned ? `${item.stage} ↩` : names[item.closed_reason || item.stage!]} ${item.count}`;
      paths += ribbon(source, end, size, kind, text);
      labels += `<text x="${x+step+14}" y="${end+size/2+4}">${escape(text)}</text>`;
      source += size; end += size + 14;
    }
    height = Math.max(height, end + 8);
  }
  const exits = ['stage','no_reply','rejected','withdrawn'].map(kind => ({kind, count:data.terminals.filter(t => (t.closed_reason || 'stage') === kind).reduce((n,t) => n+t.count,0)})).filter(t => t.count);
  return `<div class="mobile-flow-exits"><div>${exits.map(t => `<span class="flow-${t.kind}" style="flex:${t.count}" title="${names[t.kind]} ${t.count}"></span>`).join('')}</div><p>${exits.map(t => `${t.count} ${names[t.kind]}`).join(' · ')}</p></div><svg class="pipeline-sankey" viewBox="0 0 1010 ${height}" role="img" aria-label="Application flow: ${data.total} applied; ${data.reached[1]} reached Screen; ${data.reached[2]} reached Interview; ${data.reached[3]} reached Offer"><title>Flow by furthest Stage reached; blue exits show the current Stage. ↩ means moved back.</title>${paths}${labels}</svg><div class="flow-headlines">${[[data.replies,'got a reply'],[data.reached[2],'reached Interview'],[data.reached[3],'reached Offer']].map(([count,text]) => `<span><b>${percent(Number(count),data.total)}</b>${text}</span>`).join('')}</div>`;
}
export function createMetrics(reload: () => Promise<void>, error: (e: unknown) => void, replace: (id: string, html: string) => void) {
  let days = '', hidden = false;
  function period(value: string) {
    days = value;
    document.querySelectorAll<HTMLSelectElement>('[data-pipeline-period]').forEach(node => { node.value = days; });
  }
  document.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (select.matches('[data-pipeline-period]')) { period(select.value); void reload().catch(error); }
  });
  function toggle() {
    hidden = !hidden; document.getElementById('pipeline-flow-body')!.hidden = hidden;
    const button = document.getElementById('pipeline-flow-toggle')!;
    button.setAttribute('aria-expanded', String(!hidden)); button.innerHTML = `${hidden ? 'Show' : 'Hide'} <kbd>v</kbd>`;
  }
  document.getElementById('pipeline-flow-toggle')!.addEventListener('click', toggle);
  document.getElementById('source-reply-rates')!.innerHTML = `<header><h3>Reply rate by Source</h3>${periodSelect()}</header><p class="muted">Replies to Jobs you applied to, from Pipeline.</p><div id="source-rate-rows">Loading reply rates…</div>`;
  return {
    period, query: () => days ? `?days=${days}` : '', toggle,
    render(data: Statistics) {
      replace('pipeline-flow-body', data.total ? flow(data) : `<p class="pipeline-empty">${days ? 'No applied Jobs in this period. Choose All time to see older applications.' : 'No applied Jobs. Mark a Job applied in <a href="#triage">Triage</a> to start the flow.'}</p>`);
      replace('pipeline-rates', `<h3>Reply rate <small>by current Fit Score</small></h3>${rates(data.bands)}<p class="muted">A reply is any answer, including a rejection. <a href="#scans">By Source ›</a></p>`);
      replace('source-rate-rows', data.total ? rates(data.sources) : '<p class="muted">No applied Jobs in this period.</p>');
    },
    failed() { for (const id of ['pipeline-flow-body','pipeline-rates','source-rate-rows']) replace(id, '<p class="muted">Could not load reply rates. Reopen Pipeline to retry.</p>'); },
  };
}
