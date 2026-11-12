import './fill.css';
import { readPaste } from './fill-paste';

const dialog = document.getElementById('fill-dialog') as HTMLDialogElement;
dialog.innerHTML = `<header class="fill-header"><div><h2 id="fill-title">Fill a Job</h2><p>Paste a Job. Leave with the words and the PDF.</p></div><button type="button" data-close>Close <kbd>Esc</kbd></button></header>
<form id="fill-form"><div class="fill-columns"><section class="fill-paste"><label for="fill-text">Paste here</label><p>A Job posting, or an Upwork posting with screening questions. Put questions one per line under “Application questions”.</p><textarea id="fill-text" maxlength="50000" required placeholder="Paste a Job posting…" autofocus></textarea><p class="fill-private">Inputs and outputs are not saved or queued. Copy or download before leaving.</p></section>
<section class="fill-options"><label for="fill-kind">Joule read this as</label><div class="fill-detection"><select id="fill-kind"><option value="posting">Job posting</option><option value="upwork">Upwork posting</option><option value="questions">Application questions</option></select><span id="fill-question-count"></span></div><p class="fill-kind-help"></p><details id="fill-question-review" hidden><summary>Review detected questions</summary><ol></ol></details>
<label for="fill-job-title">Title</label><input id="fill-job-title" maxlength="500" required><div class="fill-metadata"><div><label for="fill-company">Company</label><input id="fill-company" maxlength="500"></div><div><label for="fill-filename">CV file name</label><input id="fill-filename" maxlength="150"></div></div>
<h3>What do you want back?</h3><label class="fill-output"><input id="fill-letter" type="checkbox" checked><span><b>Cover Letter</b><small>From your Profile and writing samples.</small></span></label><label class="fill-output"><input id="fill-answers" type="checkbox"><span><b>Answers to application questions</b><small id="fill-answers-help"></small></span></label><label class="fill-output"><input id="fill-cv" type="checkbox" checked><span><b>Tailored CV</b><small>PDF from your Master CV.</small></span></label><label class="fill-output"><input id="fill-proposal" type="checkbox"><span><b>Proposal</b><small>Upwork cover text.</small></span></label></section></div><footer class="fill-footer"><button class="btn primary" id="fill-generate" type="submit">Generate outputs</button><kbd>⌘ / Ctrl Enter</kbd><button type="button" data-close>Cancel</button></footer></form>
<section id="fill-results" hidden><div class="fill-results-heading"><button type="button" id="fill-back">‹ Paste</button><span>Step 2 of 2 · Outputs</span><button type="button" id="fill-new">New fill</button></div><h3 id="fill-result-title" tabindex="-1"></h3><p id="fill-result-kind"></p><p>Copy or download before leaving; these outputs are not saved.</p><div id="fill-cards"></div></section><p id="fill-status" role="status" aria-live="polite"></p>`;
const get = <T extends HTMLElement>(id: string) => dialog.querySelector<T>(`#fill-${id}`)!;
const form = get<HTMLFormElement>('form');
const paste = get<HTMLTextAreaElement>('text');
const kind = get<HTMLSelectElement>('kind');
const title = get<HTMLInputElement>('job-title');
const company = get<HTMLInputElement>('company');
const filename = get<HTMLInputElement>('filename');
const cv = get<HTMLInputElement>('cv');
const letter = get<HTMLInputElement>('letter');
const answers = get<HTMLInputElement>('answers');
const proposal = get<HTMLInputElement>('proposal');
const status = get('status');
const results = get('results');
const cards = get('cards');
const edited = new Set<string>();
let kindChanged = false, busy = false;
let pdfUrl: string | null = null;
let navHome: { parent: Node; next: Node | null } | null = null;
const nav = document.getElementById('mobile-nav')!;
const triggers = document.querySelectorAll<HTMLButtonElement>('[data-open-fill]');
function defaults(reset = false) {
  const upwork = kind.value === 'upwork';
  const count = readPaste(paste.value).questions.length;
  proposal.disabled = !upwork;
  answers.disabled = !upwork || !count;
  if (reset || !edited.has('outputs')) {
    proposal.checked = upwork;
    answers.checked = upwork && count > 0;
    cv.checked = letter.checked = !upwork;
  }
  get('answers-help').textContent = upwork ? `${count} screening question${count === 1 ? '' : 's'} detected.` : 'Board-question answers are not available for pasted Jobs.';
  dialog.querySelector('.fill-kind-help')!.textContent = kind.value === 'questions' ? 'Paste the Job posting above the questions to provide context, then correct the kind.' : 'Detected locally. Correct the kind or edit the pasted text if needed.';
  updateButton();
}
function updateButton() {
  const count = [letter, cv, answers, proposal].filter(input => input.checked && !input.disabled).length;
  const button = get<HTMLButtonElement>('generate');
  button.textContent = busy ? 'Generating…' : `Generate ${count} output${count === 1 ? '' : 's'}`;
  button.disabled = busy || !count || kind.value === 'questions';
}
function updateFilename() {
  if (!edited.has('filename')) filename.value = `JB_CV_${(company.value || title.value || 'Job').replace(/[^\p{L}\p{N}_-]+/gu, '_')}.pdf`;
}
function detect() {
  const data = readPaste(paste.value);
  const previousKind = kind.value;
  if (!kindChanged) kind.value = data.kind;
  if (!edited.has('title')) title.value = data.title;
  if (!edited.has('company')) company.value = data.company;
  updateFilename();
  get('question-count').textContent = `${data.questions.length} question${data.questions.length === 1 ? '' : 's'}`;
  const review = get<HTMLDetailsElement>('question-review'); review.hidden = !data.questions.length;
  review.querySelector('ol')!.replaceChildren(...data.questions.map(question => { const li = document.createElement('li'); li.textContent = question; return li; }));
  defaults(kind.value !== previousKind);
}
paste.addEventListener('input', detect);
kind.addEventListener('change', () => { kindChanged = true; defaults(true); });
for (const [name, input] of [['title', title], ['company', company], ['filename', filename]] as const) input.addEventListener('input', () => { edited.add(name); updateFilename(); });
[letter, cv, answers, proposal].forEach(input => input.addEventListener('change', () => { edited.add('outputs'); updateButton(); }));
function open() {
  if (dialog.open) return;
  navHome = { parent: nav.parentNode!, next: nav.nextSibling }; dialog.append(nav);
  nav.querySelectorAll('[aria-current]').forEach(tab => tab.removeAttribute('aria-current'));
  nav.querySelector('[data-open-fill]')!.setAttribute('aria-current', 'page');
  dialog.showModal();
}
triggers.forEach(button => button.addEventListener('click', open));
dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
nav.querySelectorAll('a').forEach(link => link.addEventListener('click', () => { if (dialog.open) dialog.close(); }));
dialog.addEventListener('close', () => {
  if (navHome) navHome.parent.insertBefore(nav, navHome.next);
  navHome = null;
  nav.querySelector('[data-open-fill]')!.removeAttribute('aria-current');
  nav.querySelector(`[data-view="${location.hash === '#scans' ? 'scans' : 'triage'}"]`)!.setAttribute('aria-current', 'page');
});
document.addEventListener('keydown', event => {
  if (dialog.open) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !busy && !get<HTMLButtonElement>('generate').disabled && !form.hidden) { event.preventDefault(); form.requestSubmit(); }
    return;
  }
  if (event.key === 'n' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing && !document.querySelector('dialog[open]') && !(event.target as HTMLElement).closest('input:not([type=checkbox]), textarea, select, [contenteditable]')) { event.preventDefault(); open(); }
});
get('back').addEventListener('click', () => { results.hidden = true; form.hidden = false; paste.focus(); });
function discardPDF() { if (pdfUrl) URL.revokeObjectURL(pdfUrl); pdfUrl = null; }
get('new').addEventListener('click', () => {
  if (busy) return;
  discardPDF(); form.reset(); edited.clear(); kindChanged = false; cards.replaceChildren(); status.textContent = ''; results.hidden = true; form.hidden = false; detect(); paste.focus();
});
window.addEventListener('pagehide', discardPDF);
function output(heading: string, value: string) {
  const card = document.createElement('article'); card.className = 'fill-card';
  const header = document.createElement('header');
  const h = document.createElement('h4'); h.textContent = heading;
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy';
  copy.addEventListener('click', () => void navigator.clipboard.writeText(value).then(() => { copy.textContent = 'Copied'; }).catch(() => { status.textContent = 'Clipboard unavailable. Select the text to copy.'; }));
  header.append(h, copy);
  const text = document.createElement('p'); text.className = 'fill-answer'; text.textContent = value;
  const expand = document.createElement('button'); expand.type = 'button'; expand.textContent = 'Read all'; expand.setAttribute('aria-expanded', 'false');
  expand.addEventListener('click', () => { const expanded = text.classList.toggle('expanded'); expand.textContent = expanded ? 'Show less' : 'Read all'; expand.setAttribute('aria-expanded', String(expanded)); });
  card.append(header, text, expand); cards.append(card);
}
async function request(path: string, body: object) {
  const response = await fetch(`/api/manual/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(typeof data?.detail === 'string' ? data.detail : `Request failed (${response.status})`); }
  return response;
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const data = readPaste(paste.value);
  if (!data.description || data.questions.length > 50 || data.questions.some(question => question.length > 5000)) { status.textContent = 'Include a Job posting and at most 50 questions, each at most 5,000 characters.'; return; }
  const wanted = { letter: letter.checked, cv: cv.checked, proposal: proposal.checked && !proposal.disabled, answers: answers.checked && !answers.disabled };
  const metadata = { title: title.value.trim(), company: company.value.trim() || null, description: data.description };
  const downloadName = (filename.value.trim() || 'Tailored_CV.pdf').replace(/[\\/\x00-\x1f]/g, '_').replace(/(?:\.pdf)?$/i, '.pdf');
  busy = true;
  const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>('input, button, textarea, select')).filter(input => !input.disabled && !input.hasAttribute('data-close'));
  controls.forEach(input => { input.disabled = true; }); updateButton(); status.textContent = 'Generating your outputs…';
  cards.replaceChildren(); discardPDF();
  const errors: string[] = [];
  if (wanted.proposal || wanted.answers) {
    try {
      const bundle = await (await request('proposal', { ...metadata, questions: wanted.answers ? data.questions : [] })).json();
      if (wanted.proposal) output('Proposal', bundle.cover);
      if (wanted.answers) bundle.answers.forEach((answer: string, i: number) => output(data.questions[i], answer));
    } catch (error) { errors.push(`Proposal / answers: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (wanted.letter) {
    try {
      const document = await (await request('cover-letter', metadata)).json();
      output('Cover Letter', document.text);
    } catch (error) { errors.push(`Cover Letter: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (wanted.cv) {
    try {
      pdfUrl = URL.createObjectURL(await (await request('cv', metadata)).blob());
      const card = document.createElement('article'); card.className = 'fill-card';
      const h = document.createElement('h4'); h.textContent = 'Tailored CV';
      const link = document.createElement('a'); link.href = pdfUrl; link.download = downloadName; link.textContent = `Download ${downloadName}`;
      card.append(h, link); cards.append(card);
    } catch (error) { errors.push(`Tailored CV: ${error instanceof Error ? error.message : String(error)}`); }
  }
  busy = false; controls.forEach(input => { input.disabled = false; }); updateButton();
  status.textContent = errors.join(' · ');
  if (cards.children.length) {
    get('result-title').textContent = metadata.title;
    get('result-kind').textContent = `${kind.selectedOptions[0].textContent} · ${wanted.answers ? data.questions.length : 0} screening questions`;
    form.hidden = true; results.hidden = false;
    if (dialog.open) get('result-title').focus();
  } else if (dialog.open) get('generate').focus();
});
detect();
