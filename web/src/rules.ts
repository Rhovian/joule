import { escape } from './format';
type Rule = { key: string; label: string; scope: string; values: unknown; count: number };
export function createRulesCard(column: Element, api: <T>(path: string) => Promise<T>, notice: (error: unknown) => void) {
  const card = document.createElement('section'); card.className = 'settings-card filtered-rules'; card.setAttribute('aria-labelledby', 'rules-title');
  card.innerHTML = `<header><h2 id="rules-title">Filtered rules</h2><span id="rules-count"></span></header><div id="rules-rows"><p>Loading rules…</p></div><footer><p id="rules-hint"></p><a href="#triage" data-action="show-filtered">Review Filtered ›</a></footer>`;
  column.prepend(card);
  function describe(value: unknown): string {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) return 'not set';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (Array.isArray(value)) return value.map(describe).join(', ');
    if (typeof value === 'object') return Object.entries(value).flatMap(([key, v]) => {
      const text = describe(v);
      return text === 'not set' ? [] : [`${key.replaceAll('_', ' ')}${['industries', 'timezones'].includes(key) ? ' (not evaluated)' : ''}: ${text}`];
    }).join(' · ') || 'not set';
    return String(value);
  }
  async function load() {
    try {
      const value = await api<{path: string; rules: Rule[]; total: number; error: string | null}>('rules');
      card.querySelector('#rules-count')!.textContent = `${value.total} Filtered Jobs`;
      card.querySelector('#rules-rows')!.innerHTML = value.rules.map(row => `<div class="rule-row" data-rule="${escape(row.key)}"><div><h3>${escape(row.label)}</h3><p>${escape(row.scope)}</p><p class="rule-values">${escape(value.error && row.values == null ? 'unavailable' : describe(row.values))}</p></div><span class="tag filtered">${row.count} Filtered</span></div>`).join('');
      card.querySelector('#rules-hint')!.textContent = `${value.error ? `${value.error}. ` : ''}Edit in ${value.path}. Re-read on every Scan. Values include defaults when available; counts reflect stored reasons across all Sources and states.`;
    } catch (error) { card.querySelector('#rules-rows')!.textContent = 'Could not load rules. Check preferences.yaml and Refresh to retry.'; card.querySelector('#rules-count')!.textContent = ''; notice(error); }
  }
  return {load};
}
