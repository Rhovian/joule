const element = id => document.getElementById(id);
let jobs = [], busy = false, active = null, refreshPending = false;
let resumeDraft = null;
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw Error(result.error);
  return result.value;
}
function showActive(job) {
  if (active?.id !== job?.id) { element('answer').value = ''; element('copy').disabled = true; }
  active = job;
  element('active').textContent = job ? `${job.title} — ${job.company || ''} (${job.source})` : 'Pick a Job before Fill';
  element('fill').disabled = busy || !job;
  element('attach').disabled = busy || !job;
  element('ask').disabled = busy || !job || !element('question').value.trim();
}
async function refreshDrafts() {
  const result = active ? await send({type: 'resume'}) : {};
  resumeDraft = result.resume_draft;
  element('resume').textContent = resumeDraft ? `Tailored CV v${resumeDraft.version} · ${new Date(resumeDraft.created_at).toLocaleString()}` : 'Generate a Tailored CV';
  element('attach').textContent = resumeDraft ? 'Attach resume' : 'Generate and attach resume';
  showActive(active);
}
function picker() {
  const query = element('filter').value.toLowerCase();
  element('jobs').replaceChildren(new Option('Pick a Job', ''));
  const choices = active && !jobs.some(job => job.id === active.id) ? [active, ...jobs] : jobs;
  for (const job of choices.filter(job => `${job.title} ${job.company} ${job.source}`.toLowerCase().includes(query))) {
    element('jobs').add(new Option(`${job.has_drafts ? 'Draft · ' : ''}${job.title} — ${job.company || ''} (${job.source})`, job.id));
  }
  element('jobs').value = active?.id || '';
}
async function run(work) {
  if (busy) return;
  busy = true;
  for (const id of ['fill', 'attach', 'ask', 'refresh', 'jobs']) element(id).disabled = true;
  element('status').textContent = 'Working…';
  try { await work(); }
  catch (error) { element('status').textContent = error.message; showActive(await send({type: 'active'})); }
  finally {
    busy = false;
    for (const id of ['refresh', 'jobs']) element(id).disabled = false;
    showActive(active);
    if (refreshPending) { refreshPending = false; run(refresh); }
  }
}
async function refresh() {
  let detection;
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab) throw Error('Chrome did not provide an active tab');
    showActive(await send({type: 'detect', tabId: tab.id}));
    detection = active ? 'Detected Job from page URL.' : 'No stored Job matches this page; pick a Job manually.';
  } catch (error) {
    showActive(null);
    detection = `Auto-detect failed: ${error.message}`;
  }
  element('remaining').replaceChildren();
  jobs = await send({type: 'jobs'});
  await refreshDrafts();
  picker();
  element('status').textContent = `${detection} · ${jobs.length} non-Upwork Jobs`;
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
  const remaining = result.actions.filter(action => action.action !== 'set');
  const listed = result.actions
    .sort((a, b) => Number(descriptor(b.ref)?.required) - Number(descriptor(a.ref)?.required));
  for (const action of listed) {
    const field = descriptor(action.ref), item = document.createElement('li');
    item.textContent = `${field?.required ? 'Required · ' : ''}${field?.label || field?.id || 'Field'}: ${action.action}${action.reason ? ` — ${action.reason}` : ''}`;
    if (action.action === 'ask') {
      const button = document.createElement('button');
      button.textContent = 'Ask';
      button.addEventListener('click', () => run(async () => {
        const answer = await send({type: 'ask', tabId: tab.id, jobId: result.job.id, field});
        if (answer.filled) button.remove();
        element('status').textContent = answer.value === null ? answer.reason :
          answer.filled ? 'Answer filled. Review and edit the form.' : 'Field changed or already filled; Fill again to refresh.';
      }));
      item.append(button);
    }
    if (action.action === 'ask') {
      const save = document.createElement('button');
      save.textContent = 'Save to bank';
      save.addEventListener('click', () => run(async () => {
        await send({type: 'save', tabId: tab.id, jobId: result.job.id, field});
        element('status').textContent = 'Saved to bank. Next Fill replays this answer.';
      }));
      item.append(save);
    }
    element('remaining').append(item);
  }
  element('status').textContent = `${result.filled} filled; ${remaining.length} remaining. Review the form.`;
}));
for (const [id, kind] of [['attach', 'resume']]) {
  element(id).addEventListener('click', () => run(async () => {
    element('status').textContent = kind === 'resume' && !resumeDraft ? 'Generating Tailored CV… (may take up to 5 minutes)' : 'Attaching…';
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const result = await send({type: 'attach', kind, tabId: tab.id});
    await refreshDrafts();
    element('status').textContent = `${result.filled} attached. Review the form.`;
  }));
}
element('question').addEventListener('input', () => showActive(active));
element('ask').addEventListener('click', () => run(async () => {
  element('answer').value = '';
  element('copy').disabled = true;
  const answer = await send({type: 'question', jobId: active.id, question: element('question').value.trim()});
  element('answer').value = answer.value ?? '';
  element('copy').disabled = !answer.value;
  element('status').textContent = answer.value === null ? answer.reason : 'Answer ready. Review before copying.';
}));
element('copy').addEventListener('click', () => run(async () => {
  await navigator.clipboard.writeText(element('answer').value);
  element('status').textContent = 'Answer copied.';
}));
function detectPage() {
  if (busy) refreshPending = true;
  else run(refresh);
}
run(refresh);
chrome.tabs.onActivated.addListener(detectPage);
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (tab.active && change.url) detectPage();
});
