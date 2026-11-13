import { age, dateTime, escape } from './format';
import './email.css';
type Config = { inbox: 'gmail' | 'imap'; host: string; port: number; tls: boolean; username: string; scope: 'pipeline' | 'folder'; folder: string; check_minutes: number | null };
type Status = { state: 'not_connected' | 'connected' | 'expired'; config: Config | null };
type Suggestion = { id: number; job_id: number; sender_name: string; sender_address: string; subject: string; quote: string; date: string | null; title: string; company: string | null; current_stage: string; proposal: string };
type Mail = { suggestions: Suggestion[]; last_checked: string | null; check_error: boolean };
export function createEmail(api: <T>(path: string, method?: string, body?: unknown) => Promise<T>, changed: (id: number) => Promise<void>) {
  const dialog = document.createElement('dialog'); dialog.className = 'app-dialog'; dialog.id = 'email-dialog'; dialog.setAttribute('aria-labelledby', 'email-title');
  dialog.innerHTML = `<form><header><div><h2 id="email-title">Connect email</h2><p>Joule reads replies to Pipeline Jobs and suggests moves. You confirm every move.</p></div><button type="button" data-email-close aria-label="Close email dialog">Close <kbd>Esc</kbd></button></header><div class="email-fields"><fieldset><legend>1 · Inbox</legend>${[['gmail','Gmail','App password · imap.gmail.com:993 over TLS'],['outlook','Outlook / Microsoft 365','Needs Microsoft sign-in — not available yet'],['imap','Other (IMAP)','Host, username and password']].map(([value,name,description]) => `<label class="email-choice"><input type="radio" name="inbox" value="${value}" ${value === 'gmail' ? 'checked' : value === 'outlook' ? 'disabled' : ''}><span><b>${name}</b><small>${description}</small></span></label>`).join('')}</fieldset><div id="email-imap-fields" class="email-grid"><label>Host<input name="host" required autocomplete="off"></label><label>Port<input name="port" type="number" min="1" max="65535" required></label><label class="email-tls"><input name="tls" type="checkbox" checked>Direct TLS (otherwise STARTTLS)</label></div><div class="email-grid"><label>Username<input name="username" required autocomplete="username"></label><label>App password<input name="password" type="password" autocomplete="new-password"></label></div><fieldset><legend>2 · What Joule reads</legend><label class="email-choice"><input type="radio" name="scope" value="pipeline" checked><span><b>Mail matching Pipeline Jobs</b><small>INBOX · suggestions wait for your confirmation</small></span></label><label class="email-choice"><input type="radio" name="scope" value="folder"><span><b>One label or folder</b><small>Only the named IMAP folder or Gmail label</small></span></label><label id="email-folder-field">Folder or label<input name="folder" placeholder="Jobs" required></label></fieldset><fieldset><legend>3 · Behaviour</legend><label class="email-interval">Check every<select name="check_minutes"><option value="15">15 minutes</option><option value="60">1 hour</option><option value="scan">With each Scan</option></select></label><div class="email-auto"><div><b>Move Jobs without asking when certain</b><p>Joule only suggests moves. Rejections always wait.</p></div><button type="button" class="schedule-switch" role="switch" aria-label="Move Jobs without asking" aria-checked="false" disabled><span></span></button></div></fieldset><p class="email-privacy">Credentials stay on your Joule server. Only matched sender, subject, a one-line quote and date are kept. No bodies or attachments are stored; mail is never sent, deleted or changed.</p><p id="email-error" role="alert"></p></div><footer><button type="button" id="email-disconnect">Disconnect</button><button type="button" data-email-close>Cancel</button><button class="btn primary" type="submit" id="email-save">Connect email</button></footer></form>`;
  document.getElementById('dashboard')!.append(dialog);
  const form = dialog.querySelector('form')!, field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  let status: Status = {state:'not_connected', config:null}, busy = false, trigger = '', version = 0;
  let mail: Mail = {suggestions:[], last_checked:null, check_error:false};
  const label = () => status.state === 'expired' ? 'Reconnect' : status.config ? 'Manage' : 'Connect email';
  function render() {
    const connected = status.state === 'connected', expired = status.state === 'expired';
    const summary = expired ? 'Sign-in expired' : connected ? `Connected · ${status.config!.username} · ${status.config!.host}` : 'Not connected';
    document.querySelectorAll<HTMLElement>('[data-email-status]').forEach(node => { node.textContent = summary; });
    document.getElementById('settings-email-dot')?.classList.toggle('active', connected);
    const button = document.getElementById('settings-email-action'); if (button) button.textContent = label();
    const rail = document.getElementById('email-rail');
    if (rail) rail.innerHTML = `<header><h3>From email</h3><span class="tag ${expired ? 'failed' : connected ? 'applied' : 'dismissed'}">${expired ? 'sign-in expired' : connected ? `${mail.suggestions.length} suggestions` : 'not connected'}</span>${status.config ? `<button id="email-rail-action" class="btn small" data-open-email>${label()}</button>` : ''}</header><p class="muted">${connected ? `${escape(summary)} · ${mail.last_checked ? `checked ${age(mail.last_checked)}` : 'not checked yet'} · you confirm every move` : escape(expired ? 'Sign in again to restore checks. Your Pipeline is unchanged.' : 'Connect an inbox for replies to Jobs in Pipeline. You confirm every move.')}</p>${!status.config ? `<button id="email-rail-action" class="btn primary" data-open-email>${label()}</button>` : ''}${mail.check_error ? '<p class="email-rail-error" role="status">Could not check email. Existing suggestions are unchanged; the next check will retry.</p>' : ''}${status.config ? mail.suggestions.map(suggestion).join('') || '<p class="muted">No email suggestions.</p>' : '<p class="muted">Read-only · nothing is sent or changed.</p>'}<p id="email-action-error" class="email-rail-error" role="alert"></p>`;
  }
  function suggestion(row: Suggestion) {
    const proposal = JSON.parse(row.proposal), target = proposal.closed_reason ? 'Rejected' : proposal.stage ? proposal.stage.replace(/^./, (c: string) => c.toUpperCase()) : `${proposal.next_label || 'Next date'} · ${dateTime(proposal.next_at)}`;
    const text = proposal.closed_reason ? 'Close Job' : proposal.stage ? 'Move' : 'Add date';
    return `<article class="email-suggestion" aria-label="${escape(row.subject)}"><div><b title="${escape(row.sender_address)}">${escape(row.sender_name || row.sender_address)}</b>${row.date ? `<span class="muted">${age(row.date)} ago</span>` : ''}</div><strong>${escape(row.subject)}</strong><p class="muted">“${escape(row.quote)}”</p><button class="email-job" data-action="open" data-id="${row.job_id}">${escape(row.title)}${row.company ? ` · ${escape(row.company)}` : ''}</button><p class="email-proposal"><span class="tag">${escape(row.current_stage)}</span> → <span class="tag ${proposal.closed_reason ? 'filtered' : 'applied'}">${escape(target)}</span></p><div class="email-suggestion-actions">${[['confirm', text], ['exclude', 'Not this Job'], ['ignore', 'Ignore']].map(([action, label]) => `<button class="btn small ${action === 'confirm' && proposal.stage ? 'primary' : ''}" data-email-suggestion="${row.id}" data-email-action="${action}" data-id="${row.job_id}">${label}</button>`).join('')}</div></article>`;
  }
  async function act(button: HTMLButtonElement) {
    button.disabled = true;
    try { await api(`email/suggestions/${button.dataset.emailSuggestion}/${button.dataset.emailAction}`, 'POST'); if (button.dataset.emailAction !== 'ignore') await changed(Number(button.dataset.id)); await load(); document.getElementById('email-rail-action')?.focus({preventScroll:true}); }
    catch (error) { document.getElementById('email-action-error')!.textContent = error instanceof Error ? error.message : String(error); }
    finally { button.disabled = false; }

  }
  async function load() {
    // Astro 7.3.8 runtime/client/load.js hydrates; order native fetch results here.
    const request = ++version;
    try { const [next, emails] = await Promise.all([api<Status>('email'), api<Mail>('email/suggestions')]); if (request !== version) return; status = next; mail = emails; render(); }
    catch {
      if (request !== version) return;
      document.querySelectorAll<HTMLElement>('[data-email-status]').forEach(node => { node.textContent = 'Status unavailable'; });
      const rail = document.getElementById('email-rail'); if (rail) rail.innerHTML = '<h3>From email</h3><p>Email connection status unavailable.</p><button id="email-rail-action" class="btn" data-open-email>Connection settings</button>';
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
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-email-suggestion]'); if (action) { void act(action); return; }
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
    try { const next = await api<Status>('email', 'PUT', body); ++version; status = next; if (!next.config) mail = {suggestions:[], last_checked:null, check_error:false}; render(); dialog.close(); void load(); }
    catch (error) { document.getElementById('email-error')!.textContent = error instanceof Error ? error.message : String(error); await load(); }
    finally { field('password').value = ''; busy = false; save.disabled = false; if (dialog.open && document.activeElement === document.body) focused.focus(); }
  });
  document.getElementById('email-disconnect')!.addEventListener('click', async () => {
    if (busy) return; busy = true;
    try { const next = await api<Status>('email', 'DELETE'); ++version; status = next; if (!next.config) mail = {suggestions:[], last_checked:null, check_error:false}; render(); dialog.close(); void load(); }
    catch (error) { document.getElementById('email-error')!.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  });
  dialog.querySelectorAll('[data-email-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('close', () => { field('password').value = ''; document.getElementById(trigger)?.focus({preventScroll:true}); });
  return {load};
}
