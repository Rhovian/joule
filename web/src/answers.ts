import { escape } from './format';
type Entry = { id: number; question: string; answer: string; saved_from_fill: boolean };
export function createAnswerBank(grid: Element, api: <T>(path: string, method?: string, body?: unknown) => Promise<T>, notice: (error: unknown) => void) {
  const card = document.createElement('section'); card.className = 'settings-card answer-bank'; card.setAttribute('aria-labelledby', 'answers-title');
  card.innerHTML = `<header class="answers-heading"><h2 id="answers-title">Answer bank <span id="answers-count"></span></h2><label><span class="sr-only">Search questions and answers</span><input id="answers-search" type="search" placeholder="Search questions and answers" autocomplete="off"></label><button id="answers-add" disabled>Add answer</button></header><form id="answer-editor" hidden><h3></h3><label>Question<input name="question" maxlength="500" required></label><label>Answer<textarea name="answer" rows="5" maxlength="5000" required></textarea></label><p class="muted">Joule Fill replays matching saved answers.</p><div><button type="submit" class="btn primary">Save answer</button><button type="button" id="answer-cancel">Cancel</button></div></form><p id="answers-status" role="status">Loading answers…</p><div id="answer-rows"></div><footer><button id="answers-more" hidden></button><span>Joule Fill reuses these answers.</span></footer>`;
  grid.prepend(card);
  const get = <T extends HTMLElement>(id: string) => card.querySelector<T>(`#${id}`)!;
  const form = get<HTMLFormElement>('answer-editor'), search = get<HTMLInputElement>('answers-search'), status = get('answers-status');
  const question = form.elements.namedItem('question') as HTMLInputElement, answer = form.elements.namedItem('answer') as HTMLTextAreaElement;
  let entries: Entry[] = [], editing: number | null = null, expanded = false, saving = false;
  function render() {
    const query = search.value.trim().toLocaleLowerCase();
    const matching = entries.filter(e => `${e.question} ${e.answer}`.toLocaleLowerCase().includes(query));
    get('answers-count').textContent = String(entries.length);
    get('answer-rows').innerHTML = (query || expanded ? matching : matching.slice(0, 5)).map(e => `<article class="answer-row"><div><h3>${escape(e.question)}</h3><p title="${escape(e.answer)}">${escape(e.answer)}</p></div>${e.saved_from_fill ? '<span class="tag new">saved from Fill</span>' : ''}<button data-answer-edit="${e.id}" aria-label="Edit answer: ${escape(e.question)}">Edit</button></article>`).join('') || `<p class="answers-empty">${entries.length ? 'No answers match.' : 'No saved answers yet. Add one to reuse it in Joule Fill.'}</p>`;
    get('answers-more').hidden = !!query || entries.length <= 5;
    get('answers-more').textContent = expanded ? 'Show fewer' : `Show all ${entries.length}`;
  }
  async function load() {
    try { entries = await api<Entry[]>('answers'); status.textContent = ''; get<HTMLButtonElement>('answers-add').disabled = false; render(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not load answers.'; get<HTMLButtonElement>('answers-add').disabled = true; notice(error); }
  }
  function editor(entry?: Entry) {
    if (saving) return;
    editing = entry?.id ?? null; form.hidden = false; form.querySelector('h3')!.textContent = entry ? 'Edit answer' : 'Add answer';
    question.value = entry?.question ?? ''; question.readOnly = !!entry; answer.value = entry?.answer ?? '';
    (entry ? answer : question).focus();
  }
  get('answers-add').addEventListener('click', () => editor());
  get('answer-cancel').addEventListener('click', () => { form.hidden = true; get('answers-add').focus(); });
  get('answers-more').addEventListener('click', () => { expanded = !expanded; render(); });
  search.addEventListener('input', render);
  get('answer-rows').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-answer-edit]');
    if (button) editor(entries.find(e => e.id === Number(button.dataset.answerEdit)));
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving) return; saving = true; const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button'));
    controls.forEach(control => { control.disabled = true; }); status.textContent = 'Saving answer…';
    try {
      entries = await api<Entry[]>(editing === null ? 'answers' : `answers/${editing}`, editing === null ? 'POST' : 'PUT', { question: question.value, answer: answer.value });
      form.hidden = true; search.value = ''; expanded = true; render(); status.textContent = 'Answer saved. The next Fill uses this answer.'; get('answers-add').focus();
    } catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not save answer.'; notice(error); }
    finally { saving = false; controls.forEach(control => { control.disabled = false; }); if (!form.hidden && document.activeElement === document.body) answer.focus(); }
  });
  return { load };
}
