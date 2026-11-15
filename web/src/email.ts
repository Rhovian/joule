import { escape } from './format';
import './email.css';

type Status = { state: string; account: string | null; last_checked: string | null; flags: { id: number; job_id: number; first_move_id: number; sender: string; subject: string; quote: string; title: string; company: string | null }[] };

export function createEmail(api: <T>(path: string, method?: string, body?: unknown) => Promise<T>, changed: (id: number) => Promise<void>) {
  async function load() {
    try {
      const status = await api<Status>('email');
      const summary = status.state === 'configured' ? `Gmail · ${status.account} · read-only` : status.state === 'checking' ? `Gmail · ${status.account} · processing backlog` : status.state === 'unavailable' ? 'Gmail check failed · review authorization' : 'Gmail not connected · see README setup';
      document.querySelectorAll<HTMLElement>('[data-email-status]').forEach(node => { node.textContent = summary; });
      document.getElementById('settings-email-dot')?.classList.toggle('active', ['configured', 'checking'].includes(status.state));
      const rail = document.getElementById('email-rail');
      if (rail) rail.innerHTML = `<h3>From Gmail</h3><p class="muted">${escape(summary)}</p><p class="muted">Certain replies move Jobs automatically. Review flagged messages below using the Pipeline controls.</p>${status.last_checked ? `<p class="muted">Last attempted ${escape(new Date(status.last_checked).toLocaleString())}</p>` : ''}${status.flags.map(row => `<article class="email-suggestion"><b>Review required · ${escape(row.title)}${row.company ? ` · ${escape(row.company)}` : ''}</b><strong>${escape(row.subject)}</strong><span>${escape(row.sender)}</span><p>${escape(row.quote)}</p><button data-action="open" data-id="${row.job_id}">Review Job</button><button data-dismiss-mail="${row.id}" data-job="${row.job_id}" data-in-pipeline="${row.first_move_id > 0}">Dismiss flag</button></article>`).join('') || '<p class="muted">No uncertain matches.</p>'}<p id="email-action-error" role="alert"></p>`;
    } catch {
      document.querySelectorAll<HTMLElement>('[data-email-status]').forEach(node => { node.textContent = 'Gmail status unavailable'; });
    }
  }
  document.addEventListener('click', async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-dismiss-mail]');
    if (!button) return;
    button.disabled = true;
    try { await api(`email/flags/${button.dataset.dismissMail}/dismiss`, 'POST'); if (button.dataset.inPipeline === 'true') await changed(Number(button.dataset.job)); await load(); }
    catch { button.disabled = false; const error = document.getElementById('email-action-error'); if (error) error.textContent = 'Could not dismiss flag.'; }
  });
  return { load };
}
