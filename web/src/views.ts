const triageViews = [
  { id: 'inbox', name: 'Inbox', show: ['new', 'unscored'], sources: null, sort: 'rank', minScore: null },
  { id: '90-plus', name: '90+ only', show: ['new'], sources: null, sort: 'score', minScore: 90 },
  { id: 'upwork', name: 'Upwork', show: ['new', 'unscored'], sources: ['upwork'], sort: 'rank', minScore: null },
];
export function createViews(apply: (preset: typeof triageViews[number]) => void, refresh: () => void) {
  const select = document.getElementById('triage-view') as HTMLSelectElement, chip = document.getElementById('fit-filter')!, storageKey = 'joule.triage.view';
  let current = triageViews[0], minScore: number | null = null;
  try { const saved = localStorage.getItem(storageKey); current = triageViews.find(p => p.id === saved) ?? current; } catch { /* Storage may be unavailable; Inbox still works. */ }
  const modified = new Option('', '', false, false);
  modified.disabled = modified.hidden = true;
  select.replaceChildren(modified, ...triageViews.map(p => new Option(p.name, p.id)));
  function choose(id: string, remember = true) {
    current = triageViews.find(p => p.id === id) ?? triageViews[0];
    minScore = current.minScore; renderFit();
    apply(current); select.value = current.id;
    if (remember) try { localStorage.setItem(storageKey, current.id); } catch { /* Presets work without persistence. */ }
  }
  function renderFit() {
    chip.textContent = minScore === null ? '+ Fit ≥ 90' : `Fit ≥ ${minScore} ×`;
    chip.setAttribute('aria-pressed', String(minScore !== null));
    chip.setAttribute('aria-label', `${minScore === null ? 'Add' : 'Remove'} Fit Score ≥ ${minScore ?? 90} filter`);
  }
  function markModified() { modified.textContent = `${current.name} · modified`; select.value = ''; }
  chip.addEventListener('click', () => { minScore = minScore === null ? 90 : null; renderFit(); markModified(); refresh(); });
  choose(current.id, false);
  select.addEventListener('change', () => { choose(select.value); refresh(); });
  return {
    get minScore() { return minScore; },
    modified: markModified,
    reset() { choose('inbox'); refresh(); },
  };
}
