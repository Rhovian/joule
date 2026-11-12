const triageViews = [
  { id: 'inbox', name: 'Inbox', show: ['new', 'unscored'], sources: null, sort: 'rank', minScore: null },
  { id: '90-plus', name: '90+ only', show: ['new'], sources: null, sort: 'score', minScore: 90 },
  { id: 'upwork', name: 'Upwork', show: ['new', 'unscored'], sources: ['upwork'], sort: 'rank', minScore: null },
];
export function createViews(apply: (preset: typeof triageViews[number]) => void, refresh: () => void) {
  const select = document.getElementById('triage-view') as HTMLSelectElement, storageKey = 'joule.triage.view';
  let current = triageViews[0];
  try { const saved = localStorage.getItem(storageKey); current = triageViews.find(p => p.id === saved) ?? current; } catch { /* Storage may be unavailable; Inbox still works. */ }
  const modified = new Option('', '', false, false);
  modified.disabled = modified.hidden = true;
  select.replaceChildren(modified, ...triageViews.map(p => new Option(p.name, p.id)));
  function choose(id: string, remember = true) {
    current = triageViews.find(p => p.id === id) ?? triageViews[0];
    apply(current); select.value = current.id;
    if (remember) try { localStorage.setItem(storageKey, current.id); } catch { /* Presets work without persistence. */ }
  }
  choose(current.id, false);
  select.addEventListener('change', () => { choose(select.value); refresh(); });
  return {
    get minScore() { return current.minScore; },
    modified() { modified.textContent = `${current.name} · modified`; select.value = ''; },
    reset() { choose('inbox'); refresh(); },
  };
}
