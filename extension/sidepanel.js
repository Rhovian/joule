const element = id => document.getElementById(id);
let jobs = [], busy = false, active = null;
let resumeDraft = null, coverDraftId = null;
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw Error(result.error);
  return result.value;
}
function showActive(job) {
  active = job;
  element('active').textContent = job ? `${job.title} — ${job.company || ''} (${job.source})` : 'Pick a Job before Fill';
  element('fill').disabled = busy || !job;
  element('attach').disabled = busy || !job;
  element('cover').disabled = busy || !job || !coverDraftId;
}
async function refreshDrafts() {
  const result = active ? await send({type: 'resume'}) : {};
  resumeDraft = result.resume_draft;
  coverDraftId = result.cover_letter_draft_id;
  element('resume').textContent = resumeDraft ? `Tailored CV v${resumeDraft.version} · ${new Date(resumeDraft.created_at).toLocaleString()}` : 'Generate a Tailored CV';
  element('attach').textContent = resumeDraft ? 'Attach resume' : 'Generate and attach resume';
  showActive(active);
}
function picker() {
  const query = element('filter').value.toLowerCase();
  element('jobs').replaceChildren(new Option('Pick a Job', ''));
  for (const job of jobs.filter(job => `${job.title} ${job.company} ${job.source}`.toLowerCase().includes(query))) {
    element('jobs').add(new Option(`${job.hasDrafts ? 'Draft · ' : ''}${job.title} — ${job.company || ''} (${job.source})`, job.id));
  }
  element('jobs').value = active?.id || '';
}
async function run(work) {
  if (busy) return;
  busy = true;
  for (const id of ['fill', 'attach', 'cover', 'refresh', 'jobs']) element(id).disabled = true;
  element('status').textContent = 'Working…';
  try { await work(); }
  catch (error) { element('status').textContent = error.message; showActive(await send({type: 'active'})); }
  finally {
    busy = false;
    for (const id of ['refresh', 'jobs']) element(id).disabled = false;
    showActive(active);
  }
}
async function refresh() {
  jobs = await send({type: 'jobs'});
  showActive(await send({type: 'active'}));
  await refreshDrafts();
  picker();
  element('status').textContent = `${jobs.length} non-Upwork Jobs`;
}
element('refresh').addEventListener('click', () => run(refresh));
element('filter').addEventListener('input', picker);
element('jobs').addEventListener('change', () => run(async () => {
  if (!element('jobs').value) return;
  showActive(await send({type: 'select', id: Number(element('jobs').value)}));
  await refreshDrafts();
  element('remaining').replaceChildren();
  element('status').textContent = 'Ready to Fill';
}));
element('fill').addEventListener('click', () => run(async () => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  const result = await send({type: 'fill', tabId: tab.id});
  await refreshDrafts();
  element('remaining').replaceChildren();
  const descriptor = ref => result.fields.find(field => field.ref[0] === ref[0] && field.ref[1] === ref[1]);
  const remaining = result.actions.filter(action => action.action !== 'set')
    .sort((a, b) => Number(descriptor(b.ref)?.required) - Number(descriptor(a.ref)?.required));
  for (const action of remaining) {
    const field = descriptor(action.ref), item = document.createElement('li');
    item.textContent = `${field?.required ? 'Required · ' : ''}${field?.label || field?.id || 'Field'}: ${action.action}${action.reason ? ` — ${action.reason}` : ''}`;
    if (action.action === 'ask') {
      const button = document.createElement('button');
      button.textContent = 'Ask';
      button.addEventListener('click', () => run(async () => {
        const answer = await send({type: 'ask', tabId: tab.id, jobId: result.job.id, field});
        element('status').textContent = answer.value === null ? answer.reason :
          answer.filled ? 'Answer filled. Review and edit the form.' : 'Field changed or already filled; Fill again to refresh.';
        if (answer.filled) item.remove();
      }));
      item.append(button);
    }
    element('remaining').append(item);
  }
  element('status').textContent = `${result.filled} filled; ${remaining.length} remaining. Review the form.`;
}));
for (const [id, kind] of [['attach', 'resume'], ['cover', 'cover_letter']]) {
  element(id).addEventListener('click', () => run(async () => {
    element('status').textContent = kind === 'resume' && !resumeDraft ? 'Generating Tailored CV… (may take up to 5 minutes)' : 'Attaching…';
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const result = await send({type: 'attach', kind, tabId: tab.id});
    await refreshDrafts();
    element('status').textContent = `${result.filled} attached. Review the form.`;
  }));
}
run(refresh);
