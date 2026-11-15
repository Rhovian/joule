import { dateTime, escape } from './format';
type Profile = { exists: boolean; updated_at: string | null; fields: {label: string; value: string}[]; error: string | null; stale: number; busy: boolean; backed_up?: boolean };
export function createProfileCard(grid: Element, api: <T>(path: string, method?: string, body?: unknown) => Promise<T>, notice: (error: unknown) => void, changed: () => Promise<void>, scoring: (id: number) => void) {
  const card = document.createElement('section'); card.className = 'settings-card master-profile'; card.setAttribute('aria-labelledby', 'master-profile-title');
  card.innerHTML = `<header><h2 id="master-profile-title">Master CV &amp; profile</h2><span>Feeds Fit Score, every Draft and Joule Fill</span></header><div class="master-file"><div><strong>cv.yaml</strong><p id="master-updated">Loading Master CV…</p></div><a id="master-open" class="btn small" target="_blank" rel="noopener noreferrer">Open</a><button id="master-replace" disabled>Replace</button><input id="master-upload" type="file" accept=".yaml,.yml,application/yaml,text/yaml" aria-label="Replace Master CV" hidden></div><div id="master-stale" hidden><p></p><button id="master-rescore">Rescore</button></div><dl id="master-fields"></dl><p id="master-status" role="status"></p>`;
  grid.prepend(card);
  const get = <T extends HTMLElement>(id: string) => card.querySelector<T>(`#master-${id}`)!;
  const file = get<HTMLInputElement>('upload'), replace = get<HTMLButtonElement>('replace'), rescore = get<HTMLButtonElement>('rescore'), status = get('status');
  function render(value: Profile) {
    get('updated').textContent = value.exists ? `YAML · updated ${value.updated_at ? dateTime(value.updated_at) : 'unknown'}` : 'No Master CV uploaded';
    const open = get<HTMLAnchorElement>('open');
    if (value.exists && !value.error) open.href = '/api/profile/cv.pdf'; else open.removeAttribute('href');
    open.setAttribute('aria-disabled', String(!value.exists || !!value.error));
    get('fields').innerHTML = value.fields.map(field => `<div><dt>${escape(({label:'Title',name:'Name',firstName:'First name',lastName:'Last name',location:'Location / address'} as Record<string,string>)[field.label] || field.label.replaceAll('_',' ').replace(/^./, c => c.toUpperCase()))}</dt><dd>${escape(field.value)}</dd></div>`).join('');
    get('stale').hidden = !value.stale;
    get('stale').querySelector('p')!.textContent = `${value.stale} retained Job${value.stale === 1 ? '' : 's'} ${value.stale === 1 ? 'has' : 'have'} an out-of-date Fit Score.`;
    rescore.textContent = `Rescore ${value.stale}`; rescore.disabled = value.busy || !value.stale;
    status.textContent = value.error || ''; replace.disabled = false;
  }
  async function load() {
    try { render(await api<Profile>('profile')); }
    catch (error) { replace.disabled = false; status.textContent = 'Could not load Master CV. Refresh to retry.'; notice(error); }
  }
  replace.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const selected = file.files?.[0]; if (!selected) return;
    replace.disabled = true; status.textContent = 'Validating cv.yaml…';
    try {
      if (selected.size > 2 * 1024 * 1024) throw Error('CV exceeds 2 MB');
      const content = new TextDecoder('utf-8', {fatal:true}).decode(await selected.arrayBuffer());
      const value = await api<Profile>('profile/cv', 'PUT', {content}); render(value);
      status.textContent = value.backed_up ? 'Master CV replaced. Previous file kept as cv.yaml.bak.' : 'Master CV uploaded.';
      await changed();
    } catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not replace Master CV.'; notice(error); }
    finally { replace.disabled = false; file.value = ''; }
  });
  rescore.addEventListener('click', async () => {
    rescore.disabled = true; status.textContent = 'Queuing out-of-date Jobs…';
    try {
      const result = await api<{id:number|null; queued:number}>('profile/rescore', 'POST', {});
      status.textContent = `${result.queued} out-of-date Jobs queued.`;
      if (result.id) scoring(result.id); else await load();
    } catch (error) { rescore.disabled = false; status.textContent = error instanceof Error ? error.message : 'Could not rescore Jobs.'; notice(error); }
  });
  return {load};
}
