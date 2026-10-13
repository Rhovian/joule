export {};
const root = document.getElementById('manual')!;
root.innerHTML = `<h2>Manual input</h2><p>Paste an Upwork Job to generate a one-off Proposal. Copy the output before leaving this page; it is not saved.</p>
<form id="manual-proposal"><label>Upwork Job description<textarea name="description" rows="5" maxlength="50000" required></textarea></label>
<div id="manual-questions"></div><button type="button" id="manual-add-question">Add screening question</button>
<button type="submit">Generate Proposal and answers</button><p class="manual-status" role="status" aria-live="polite"></p><div class="manual-output"></div></form>`;
const form = root.querySelector<HTMLFormElement>('#manual-proposal')!;
const questions = root.querySelector<HTMLElement>('#manual-questions')!;
root.querySelector('#manual-add-question')!.addEventListener('click', () => {
  if (questions.children.length >= 50) return;
  const label = document.createElement('label');
  label.textContent = `Screening question ${questions.children.length + 1}`;
  const input = document.createElement('textarea');
  input.required = true; input.maxLength = 5000; input.rows = 2;
  label.append(input);
  const remove = document.createElement('button');
  remove.type = 'button'; remove.textContent = 'Remove question';
  remove.addEventListener('click', () => {
    label.remove();
    questions.querySelectorAll('label').forEach((item, i) => { item.firstChild!.textContent = `Screening question ${i + 1}`; });
  });
  label.append(remove); questions.append(label); input.focus();
});
function output(container: Element, title: string, value: string) {
  const heading = document.createElement('h3'); heading.textContent = title;
  const text = document.createElement('div'); text.className = 'draft-text'; text.textContent = value;
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy';
  copy.addEventListener('click', () => void navigator.clipboard.writeText(value).then(() => { copy.textContent = 'Copied'; }).catch(() => { copy.textContent = 'Select text to copy'; }));
  container.append(heading, text, copy);
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  const description = form.querySelector<HTMLTextAreaElement>('[name="description"]')!.value;
  const asked = Array.from(questions.querySelectorAll('textarea'), input => input.value);
  const status = form.querySelector<HTMLElement>('.manual-status')!;
  const result = form.querySelector<HTMLElement>('.manual-output')!;
  const controls = Array.from(form.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea'));
  controls.forEach(control => { control.disabled = true; }); status.textContent = 'Writing Proposal…';
  try {
    const response = await fetch('/api/manual/proposal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description, questions: asked }) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status})`);
    result.replaceChildren(); output(result, 'Proposal cover text', data.cover);
    data.answers.forEach((answer: string, i: number) => output(result, asked[i], answer));
    status.textContent = 'Ready to copy.';
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  finally { controls.forEach(control => { control.disabled = false; }); }
});

const cvForm = document.createElement('form');
cvForm.innerHTML = `<h3>Tailored CV for another Source</h3><p>Enter a Job title and description to generate a PDF from your Master CV. Download it before leaving; it is not saved.</p>
<label>Job title<input name="title" maxlength="500" required></label>
<label>Job description<textarea name="description" rows="5" maxlength="50000" required></textarea></label>
<button type="submit">Generate Tailored CV PDF</button><p role="status" aria-live="polite"></p><div class="manual-output"></div>`;
root.append(cvForm);
let pdfUrl: string | null = null;
cvForm.addEventListener('submit', async event => {
  event.preventDefault();
  const fields = new FormData(cvForm);
  const controls = Array.from(cvForm.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button, input, textarea'));
  const status = cvForm.querySelector('p[role="status"]')!;
  controls.forEach(control => { control.disabled = true; }); status.textContent = 'Writing Tailored CV…';
  try {
    const response = await fetch('/api/manual/cv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: fields.get('title'), description: fields.get('description') }) });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(typeof data?.detail === 'string' ? data.detail : `Request failed (${response.status})`);
    }
    const blob = await response.blob();
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(blob);
    const download = document.createElement('a'); download.href = pdfUrl; download.download = 'Tailored_CV.pdf'; download.textContent = 'Download Tailored CV PDF';
    cvForm.querySelector('.manual-output')!.replaceChildren(download);
    status.textContent = 'Ready to download.';
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  finally { controls.forEach(control => { control.disabled = false; }); }
});
window.addEventListener('pagehide', () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); });
