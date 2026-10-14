const element = id => document.getElementById(id);
let jobs = [], busy = false, active = null;
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw Error(result.error);
  return result.value;
}
function showActive(job) {
  active = job;
  element('active').textContent = job ? `${job.title} — ${job.company || ''} (${job.source})` : 'Pick a Job before Fill';
  element('fill').disabled = busy || !job;
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
  for (const id of ['fill', 'refresh', 'jobs']) element(id).disabled = true;
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
  picker();
  element('status').textContent = `${jobs.length} non-Upwork Jobs`;
}
element('refresh').addEventListener('click', () => run(refresh));
element('filter').addEventListener('input', picker);
element('jobs').addEventListener('change', () => run(async () => {
  if (!element('jobs').value) return;
  showActive(await send({type: 'select', id: Number(element('jobs').value)}));
  element('remaining').replaceChildren();
  element('status').textContent = 'Ready to Fill';
}));
element('fill').addEventListener('click', () => run(async () => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  const result = await send({type: 'fill', tabId: tab.id});
  element('remaining').replaceChildren();
  const descriptor = ref => result.fields.find(field => field.ref[0] === ref[0] && field.ref[1] === ref[1]);
  const remaining = result.actions.filter(action => action.action !== 'set')
    .sort((a, b) => Number(descriptor(b.ref)?.required) - Number(descriptor(a.ref)?.required));
  for (const action of remaining) {
    const field = descriptor(action.ref), item = document.createElement('li');
    item.textContent = `${field?.required ? 'Required · ' : ''}${field?.label || field?.id || 'Field'}: ${action.action} — ${action.reason || 'complete manually in this slice'}`;
    element('remaining').append(item);
  }
  element('status').textContent = `${result.filled} filled; ${remaining.length} remaining. Review the form.`;
}));
run(refresh);
