import './settings.css';
import { dateTime } from './format';

type Appearance = { theme: 'system' | 'light' | 'dark'; density: 'compact' | 'comfortable' };
type Connections = { telegram: { configured: boolean; awaiting_reply: boolean }; extension: { last_fill_at: string | null } };
export function createSettings(api: <T>(path: string, method?: string, body?: unknown) => Promise<T>, notice: (error: unknown) => void) {
  const page = document.getElementById('a-settings')!;
  page.innerHTML = `<header class="settings-heading"><h1>Settings</h1><p>How Joule looks, and what it is connected to.</p><button id="settings-refresh">Refresh</button></header><div class="settings-grid"><section class="settings-card" aria-labelledby="connections-title"><h2 id="connections-title">Connections</h2><div class="connection-row"><span id="upwork-dot" class="connection-dot" aria-hidden="true"></span><div><h3>Upwork</h3><p id="settings-upwork-status">Not checked yet</p></div><button id="settings-upwork-action" data-action="connect">Connect</button></div><div class="connection-row"><span id="telegram-dot" class="connection-dot" aria-hidden="true"></span><div><h3>Telegram</h3><p id="settings-telegram-status">Not checked yet</p></div><button id="settings-telegram-action" data-action="telegram" hidden>Start queue</button><details id="telegram-setup" hidden><summary>Set up</summary><p>Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Joule’s .env file, then restart Joule.</p></details></div><div class="connection-row"><span class="connection-dot" aria-hidden="true"></span><div><h3>Joule Fill extension</h3><p id="settings-extension-status">Not checked yet</p><span id="settings-joule-url"></span></div><button id="settings-copy-url">Copy URL</button></div></section><section class="settings-card" aria-labelledby="appearance-title"><h2 id="appearance-title">Appearance</h2><fieldset id="appearance-controls" disabled><legend class="sr-only">Appearance</legend>${[['theme', 'Theme', 'Dashboard and Joule Fill panel', ['system', 'light', 'dark']], ['density', 'Density', 'Row height in Triage', ['compact', 'comfortable']]].map(([name, label, description, options]) => `<div class="appearance-row"><div><h3>${label}</h3><p>${description}</p></div><div class="settings-segment" role="group" aria-label="${label}">${(options as string[]).map(value => `<button type="button" data-appearance="${name}" data-value="${value}" aria-pressed="false">${value[0].toUpperCase() + value.slice(1)}</button>`).join('')}</div></div>`).join('')}</fieldset><p id="appearance-status" role="status">Loading appearance…</p></section></div>`;
  const get = (id: string) => document.getElementById(id)!;
  const controls = get('appearance-controls') as HTMLFieldSetElement;
  let appearance: Appearance;
  function apply(value: Appearance) {
    appearance = value;
    document.documentElement.dataset.theme = value.theme;
    document.documentElement.dataset.density = value.density;
    try { localStorage.setItem('joule.appearance', JSON.stringify(value)); } catch { /* The server remains the source of truth when storage is unavailable. */ }
    page.querySelectorAll<HTMLElement>('[data-appearance]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.value === value[button.dataset.appearance as keyof Appearance])));
  }
  async function loadAppearance() {
    try { apply(await api<Appearance>('appearance')); controls.disabled = false; get('appearance-status').textContent = ''; }
    catch (error) { get('appearance-status').textContent = 'Could not load appearance. Refresh to retry.'; notice(error); }
  }
  async function connections() {
    get('settings-upwork-status').textContent = 'Checking…';
    get('settings-telegram-status').textContent = get('settings-extension-status').textContent = 'Checking…';
    get('upwork-dot').classList.remove('active'); get('telegram-dot').classList.remove('active');
    get('settings-telegram-action').hidden = get('telegram-setup').hidden = true;
    await Promise.all([
      api<{ connected: boolean }>('upwork/status').then(value => {
        get('settings-upwork-status').textContent = value.connected ? 'Connected' : 'Not connected';
        get('settings-upwork-action').textContent = value.connected ? 'Reconnect' : 'Connect';
        get('upwork-dot').classList.toggle('active', value.connected);
      }).catch(error => { get('settings-upwork-status').textContent = 'Status unavailable'; notice(error); }),
      api<Connections>('connections').then(value => {
        const { telegram, extension } = value;
        get('settings-telegram-status').textContent = !telegram.configured ? 'Not configured' : telegram.awaiting_reply ? 'Configured · awaiting your reply' : 'Configured · queue ready';
        get('telegram-dot').classList.toggle('active', telegram.configured);
        get('settings-telegram-action').hidden = !telegram.configured; get('telegram-setup').hidden = telegram.configured;
        get('settings-extension-status').textContent = extension.last_fill_at ? `Last Fill trace · ${dateTime(extension.last_fill_at)}` : 'No Fill trace received';
      }).catch(error => { get('settings-telegram-status').textContent = get('settings-extension-status').textContent = 'Status unavailable'; notice(error); }),
    ]);
  }
  page.addEventListener('click', async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-appearance]');
    if (!button || controls.disabled) return;
    controls.disabled = true; get('appearance-status').textContent = 'Saving…';
    try { apply(await api<Appearance>('appearance', 'PUT', { ...appearance, [button.dataset.appearance!]: button.dataset.value })); get('appearance-status').textContent = 'Saved'; }
    catch (error) { get('appearance-status').textContent = 'Could not save appearance.'; notice(error); }
    finally { controls.disabled = false; if (document.activeElement === document.body) button.focus({ preventScroll: true }); }
  });
  get('settings-refresh').addEventListener('click', () => { void loadAppearance(); void connections(); });
  get('settings-joule-url').textContent = location.origin;
  get('settings-copy-url').addEventListener('click', () => void navigator.clipboard.writeText(location.origin).then(() => { get('settings-copy-url').textContent = 'Copied'; }).catch(notice));
  return { init: loadAppearance, connections };
}
