import './email.css';
type Config = { inbox: 'gmail' | 'imap'; host: string; port: number; tls: boolean; username: string; scope: 'pipeline' | 'folder'; folder: string; check_minutes: number | null };
type Status = { state: 'not_connected' | 'connected' | 'expired'; config: Config | null };
export function createEmail(api: <T>(path: string, method?: string, body?: unknown) => Promise<T>) {
  const dialog = document.createElement('dialog'); dialog.className = 'app-dialog'; dialog.id = 'email-dialog'; dialog.setAttribute('aria-labelledby', 'email-title');
  dialog.innerHTML = `<form><header><div><h2 id="email-title">Connect email</h2><p>Joule applies unambiguous rejections automatically and counts application acknowledgements. It does not suggest moves or dates.</p></div><button type="button" data-email-close aria-label="Close email dialog">Close</button></header><div class="email-fields"><fieldset><legend>1 · Inbox</legend>${[['gmail','Gmail','App password · imap.gmail.com:993 over TLS'],['outlook','Outlook / Microsoft 365','Needs Microsoft sign-in — not available yet'],['imap','Other (IMAP)','Host, username and password']].map(([value,name,description]) => `<label class="email-choice"><input type="radio" name="inbox" value="${value}" ${value === 'gmail' ? 'checked' : value === 'outlook' ? 'disabled' : ''}><span><b>${name}</b><small>${description}</small></span></label>`).join('')}</fieldset><div id="email-imap-fields" class="email-grid"><label>Host<input name="host" required autocomplete="off"></label><label>Port<input name="port" type="number" min="1" max="65535" required></label><label class="email-tls"><input name="tls" type="checkbox" checked>Direct TLS (otherwise STARTTLS)</label></div><div class="email-grid"><label>Username<input name="username" required autocomplete="username"></label><label>App password<input name="password" type="password" autocomplete="new-password"></label></div><fieldset><legend>2 · What Joule reads</legend><label class="email-choice"><input type="radio" name="scope" value="pipeline" checked><span><b>Mail matching Pipeline Jobs</b><small>INBOX · automatic rejections and informational acknowledgements</small></span></label><label class="email-choice"><input type="radio" name="scope" value="folder"><span><b>One label or folder</b><small>Only the named IMAP folder or Gmail label</small></span></label><label id="email-folder-field">Folder or label<input name="folder" placeholder="Jobs" required></label></fieldset><fieldset><legend>3 · Behaviour</legend><label class="email-interval">Check every<select name="check_minutes"><option value="15">15 minutes</option><option value="60">1 hour</option><option value="scan">With each Scan</option></select></label><p>Only unambiguous rejections update Pipeline. Other mail never moves Jobs or changes dates.</p></fieldset><p class="email-privacy">Credentials stay on your Joule server. Only matched sender, subject, a one-line quote and date are kept. No bodies or attachments are stored; mail is never sent, deleted or changed.</p><p id="email-error" role="alert"></p></div><footer><button type="button" id="email-disconnect">Disconnect</button><button type="button" data-email-close>Cancel</button><button class="btn primary" type="submit" id="email-save">Connect email</button></footer></form>`;
  document.getElementById('dashboard')!.append(dialog);
  const form = dialog.querySelector('form')!, field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  let status: Status = {state:'not_connected', config:null}, busy = false, trigger = '', version = 0;
  const label = () => status.state === 'expired' ? 'Reconnect' : status.config ? 'Manage' : 'Connect email';
  function render() {
    const connected = status.state === 'connected', expired = status.state === 'expired';
    const summary = expired ? 'Sign-in expired' : connected ? `Connected · ${status.config!.username} · ${status.config!.host}` : 'Not connected';
    document.querySelectorAll<HTMLElement>('[data-email-status]').forEach(node => { node.textContent = summary; });
    document.getElementById('settings-email-dot')?.classList.toggle('active', connected);
    const button = document.getElementById('settings-email-action'); if (button) button.textContent = label();
  }
  async function load() {
    // Astro 7.3.8 runtime/client/load.js hydrates; order native fetch results here.
    const request = ++version;
    try { const next = await api<Status>('email'); if (request !== version) return; status = next; render(); }
    catch {
      if (request !== version) return;
      document.querySelectorAll<HTMLElement>('[data-email-status]').forEach(node => { node.textContent = 'Status unavailable'; });
    }
  }
  function sync() {
    const imap = field('inbox').value === 'imap', folder = field('scope').value === 'folder';
    document.getElementById('email-imap-fields')!.hidden = !imap;
    for (const name of ['host','port','tls']) field(name).disabled = !imap;
    document.getElementById('email-folder-field')!.hidden = !folder; field('folder').disabled = !folder;
  }
  document.addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('#settings-refresh')) void load();
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-open-email]'); if (!button) return;
    trigger = button.id; form.reset();
    const config = status.config, interval = form.elements.namedItem('check_minutes') as HTMLSelectElement;
    const minutes = [...new Set([15, 60, ...(config?.check_minutes ? [config.check_minutes] : [])])];
    interval.replaceChildren(...minutes.map(value => new Option(value === 60 ? '1 hour' : `${value} minutes`, String(value))), new Option('With each Scan', 'scan'));
    for (const [name,value] of Object.entries(config || {host:'',port:993,tls:true,username:'',folder:'INBOX'})) {
      if (name === 'inbox' || name === 'scope') (form.querySelector(`[name="${name}"][value="${value}"]`) as HTMLInputElement).checked = true;
      else if (name === 'tls') field(name).checked = Boolean(value);
      else field(name).value = value === null ? 'scan' : String(value);
    }
    field('password').value = ''; field('password').placeholder = config ? 'Leave blank to keep saved password' : 'App password';
    document.getElementById('email-title')!.textContent = status.state === 'expired' ? 'Reconnect email' : config ? 'Manage email' : 'Connect email';
    document.getElementById('email-save')!.textContent = config ? 'Test & save' : 'Connect email';
    document.getElementById('email-disconnect')!.hidden = !config; document.getElementById('email-error')!.textContent = ''; sync(); dialog.showModal();
  });
  form.addEventListener('change', sync);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true;
    const save = document.getElementById('email-save') as HTMLButtonElement, focused = document.activeElement as HTMLElement; save.disabled = true;
    const body = { inbox:field('inbox').value, host:field('host').value || 'imap.gmail.com', port:Number(field('port').value), tls:field('tls').checked, username:field('username').value, password:field('password').value || null, scope:field('scope').value, folder:field('scope').value === 'pipeline' ? 'INBOX' : field('folder').value, check_minutes:field('check_minutes').value === 'scan' ? null : Number(field('check_minutes').value) };
    try { const next = await api<Status>('email', 'PUT', body); ++version; status = next; render(); dialog.close(); void load(); }
    catch (error) { document.getElementById('email-error')!.textContent = error instanceof Error ? error.message : String(error); await load(); }
    finally { field('password').value = ''; busy = false; save.disabled = false; if (dialog.open && document.activeElement === document.body) focused.focus(); }
  });
  document.getElementById('email-disconnect')!.addEventListener('click', async () => {
    if (busy) return; busy = true;
    try { const next = await api<Status>('email', 'DELETE'); ++version; status = next; render(); dialog.close(); void load(); }
    catch (error) { document.getElementById('email-error')!.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  });
  dialog.querySelectorAll('[data-email-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => { field('password').value = ''; document.getElementById(trigger)?.focus({preventScroll:true}); });
  return {load};
}
