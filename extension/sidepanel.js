const element = id => document.getElementById(id);
const text = (tag, value, className = '') => Object.assign(document.createElement(tag), {textContent: value ?? '', className});
let jobs = [], busy = false, active = null, refreshPending = false, choosing = false, connected = null, origin = '';
let resumeDraft = null, displayedPage = null, lastResult = null;
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw Error(result.error);
  return result.value;
}
function status(value, error = false) {
  element('status').textContent = value;
  element('status').className = error ? 'error' : 'sr-only';
  element('status').hidden = !value;
}
function connectionOptions(open) {
  element('connection-options').hidden = !open;
  element('settings').setAttribute('aria-expanded', String(open));
}
function online(value, reason = '') {
  connected = value;
  document.body.classList.toggle('offline', !value);
  element('connection-state').textContent = value ? 'Connected' : 'Offline';
  element('connection-title').textContent = value ? 'Connection options' : 'Can’t reach Joule';
  element('connection-message').textContent = reason;
  if (!value) connectionOptions(true);
}
function score(job) {
  const value = job.score;
  return text('span', value ?? '—', `score ${value == null ? 'unscored' : value >= 90 ? 'high' : value >= 80 ? 'good' : value >= 70 ? 'mid' : ''}`);
}
function showActive(job) {
  if (active?.id !== job?.id) clearResult();
  active = job ? {...jobs.find(item => item.id === job.id), ...job} : null;
  element('active').textContent = active ? `${active.title}${lastResult && active.company ? ` · ${active.company}` : ''}` : '';
  element('score').replaceWith(Object.assign(score(active || {}), {id: 'score'}));
  element('job-meta').textContent = active ? [active.company, active.source].filter(Boolean).join(' · ') + ' ·' : '';
  element('open-joule').hidden = !origin;
  element('open-joule').href = origin + '/#triage';
  element('matched').hidden = !active || choosing;
  element('picker').hidden = !!active && !choosing;
  element('cv-card').hidden = !active || choosing;
  element('cancel-pick').hidden = !active;
  element('picker-title').textContent = active ? 'Choose a Job' : 'No Job matches this page';
  document.body.classList.toggle('nomatch', !active || choosing);
  element('fill').disabled = busy || !active || choosing || connected === false;
  element('fill').textContent = busy ? 'Working…' : connected === false ? 'Fill form' : !active || choosing ? 'Pick a Job to Fill' : lastResult ? 'Fill again' : 'Fill form';
  element('attach').disabled = busy || !active;
}
function clearResult() {
  lastResult = null;
  document.body.classList.remove('after');
  for (const id of ['result', 'remaining', 'optional', 'filled', 'resume-download']) element(id).hidden = true;
  for (const id of ['need-rows', 'optional-rows', 'filled-rows']) element(id).replaceChildren();
  element('resume-download').removeAttribute('href');
  element('optional').open = element('filled').open = false;
}
async function refreshDrafts() {
  const result = active ? await send({type: 'resume'}) : {};
  resumeDraft = result.resume_draft;
  element('resume').textContent = resumeDraft ? `v${resumeDraft.version} · ${new Date(resumeDraft.created_at).toLocaleString()}` : 'Generated during Fill if attached';
  showActive(active);
}
function picker() {
  const query = element('job-search').value.trim().toLowerCase();
  const choices = active && !jobs.some(job => job.id === active.id) ? [active, ...jobs] : jobs;
  element('job-choices').replaceChildren(...choices.filter(job => `${job.title} ${job.company} ${job.source}`.toLowerCase().includes(query)).map(job => {
    const button = text('button', '', 'job-choice'), info = document.createElement('span');
    button.type = 'button'; button.disabled = busy; button.dataset.job = job.id;
    info.append(text('strong', job.title), text('small', [job.company, job.source, job.has_drafts ? 'Draft available' : ''].filter(Boolean).join(' · ')));
    button.append(score(job), info);
    button.addEventListener('click', () => run(async () => {
      clearResult(); choosing = false;
      showActive(await send({type: 'select', id: job.id}));
      element('match-mode').textContent = 'picked manually';
      await refreshDrafts(); status('Ready to Fill');
    }));
    return button;
  }));
  if (!element('job-choices').children.length) element('job-choices').append(text('p', 'No Jobs match your search.', 'field-row muted'));
}
async function run(work) {
  if (busy) return;
  busy = true;
  const focused = document.activeElement, disabled = new Set(document.querySelectorAll('button:disabled,input:disabled'));
  document.querySelectorAll('button,input').forEach(node => { node.disabled = true; });
  showActive(active); status('Working…');
  try { await work(); }
  catch (error) {
    if (connected === false) element('connection-message').textContent = error.message;
    status(error.message, connected !== false);
    try { showActive(await send({type: 'active'})); } catch { showActive(null); }
  } finally {
    busy = false;
    document.querySelectorAll('button,input').forEach(node => { node.disabled = disabled.has(node); });
    showActive(active);
    if (document.activeElement === document.body && focused.isConnected) focused.focus({preventScroll: true});
    if (refreshPending) { refreshPending = false; void run(refresh); }
  }
}
async function refresh() {
  clearResult();
  let detection;
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab) throw Error('Chrome did not provide an active tab');
    displayedPage = {id: tab.id, url: tab.url};
    choosing = false; showActive(await send({type: 'detect', tabId: tab.id}));
    detection = active ? 'Detected Job from page URL.' : 'No stored Job matches this page; pick a Job manually.';
    element('match-mode').textContent = 'matched from page URL';
  } catch (error) { showActive(null); detection = `Auto-detect failed: ${error.message}`; }
  try { jobs = await send({type: 'jobs'}); }
  catch (error) { online(false, error.message); throw error; }
  const reconnecting = connected === false;
  online(true); if (reconnecting) connectionOptions(false);
  await refreshDrafts(); picker();
  status(detection, detection.startsWith('Auto-detect failed:'));
}
function fieldRow(action, field, result, tabId) {
  const row = text('div', '', 'field-row'), line = text('div', '', 'field-line'), question = text('div', '', 'field-question');
  if (field?.required) question.append(text('span', 'Required', 'required'), document.createElement('br'));
  question.append(document.createTextNode(field?.label || field?.id || 'Field'));
  line.append(question); row.append(line);
  if (action.reason) row.append(text('p', action.reason, 'field-reason'));
  if (action.action !== 'ask') return row;
  const answer = text('p', '', 'field-answer'), response = text('p', '', 'field-reason'), buttons = text('div', '', 'actions');
  answer.hidden = response.hidden = true;
  const ask = text('button', 'Ask'), copy = text('button', 'Copy'), save = text('button', 'Save to bank');
  copy.hidden = true; save.title = 'Save the current answer from the form';
  ask.addEventListener('click', () => run(async () => {
    const resultAnswer = await send({type: 'ask', tabId, jobId: result.job.id, field});
    answer.textContent = resultAnswer.value ?? ''; answer.hidden = resultAnswer.value === null;
    copy.hidden = !resultAnswer.value; response.hidden = false;
    response.textContent = resultAnswer.value === null ? resultAnswer.reason || 'No answer available from Profile.' : resultAnswer.filled ? 'Answer filled. Review and edit the form before saving.' : 'The form was kept unchanged. Copy the answer if needed.';
    row.classList.toggle('answered', resultAnswer.value !== null); ask.textContent = 'Ask again';
    status(response.textContent);
  }));
  copy.addEventListener('click', () => run(async () => { await navigator.clipboard.writeText(answer.textContent); status('Answer copied.'); }));
  save.addEventListener('click', () => run(async () => {
    await send({type: 'save', tabId, jobId: result.job.id, field});
    save.textContent = 'Saved'; status('Saved to bank. Next Fill replays this answer.');
  }));
  buttons.append(ask, copy, save); row.append(answer, buttons, response);
  return row;
}
element('fill').addEventListener('click', () => run(async () => {
  clearResult();
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  const result = await send({type: 'fill', tabId: tab.id, attachResume: element('attach').checked});
  lastResult = {...result, job: result.job || active};
  await refreshDrafts();
  const groups = {need: [], optional: [], filled: []};
  for (const action of result.actions) {
    const field = result.fields.find(field => field.ref[0] === action.ref[0] && field.ref[1] === action.ref[1]);
    const observed = result.trace?.fields?.find(row => row.ref[0] === action.ref[0] && row.ref[1] === action.ref[1]);
    const done = observed ? observed.after : action.action === 'set' || action.action === 'upload' && action.file === 'resume' && result.attached > 0;
    groups[done ? 'filled' : field?.required ? 'need' : 'optional'].push({action, field});
  }
  for (const [key, rows] of Object.entries(groups)) {
    rows.sort((a, b) => Number(b.field?.required) - Number(a.field?.required));
    const group = element(key === 'need' ? 'remaining' : key), list = element(`${key}-rows`);
    group.hidden = !rows.length;
    element(`${key}-heading`).textContent = key === 'need' ? `Needs you · ${rows.length}` : `${rows.length} ${key === 'filled' ? 'filled' : 'optional fields'}`;
    element(`${key === 'need' ? 'need' : key}-count`).textContent = rows.length;
    element(`${key === 'need' ? 'need' : key}-bar`).style.flex = rows.length;
    for (const {action, field} of rows) list.append(fieldRow(action, field, lastResult, tab.id));
  }
  element('result').hidden = false;
  element('resume-result').textContent = result.attached ? `✓ ${result.resumeName || 'Tailored CV'} attached` : result.resumeStatus || '';
  element('fill-warning').textContent = result.traceError || '';
  element('fill-warning').hidden = !result.traceError;
  if (result.resumeDownload) {
    const link = element('resume-download');
    // Native downloads need no downloads permission; HTML's downloading-resources algorithm handles this data URL.
    link.href = `data:application/pdf;base64,${result.resumeDownload.base64}`;
    link.download = result.resumeDownload.name; link.hidden = false;
  }
  document.body.classList.add('after');
  status(`${result.filled} filled. Review the form.`);
}));
element('job-search').addEventListener('input', picker);
element('change').addEventListener('click', () => { choosing = true; element('job-search').value = ''; picker(); showActive(active); element('job-search').focus(); });
element('cancel-pick').addEventListener('click', () => { choosing = false; showActive(active); });
element('settings').addEventListener('click', () => connectionOptions(element('connection-options').hidden));
element('retry').addEventListener('click', () => run(refresh));
element('test').addEventListener('click', () => run(async () => {
  element('connection-message').textContent = await connect(chrome, element('origin').value);
  origin = normalizeOrigin(element('origin').value);
  await refresh();
}));
function detectPage() { if (busy) refreshPending = true; else void run(refresh); }
void run(async () => {
  const config = await chrome.storage?.local?.get('origin');
  element('origin').value = config?.origin || '';
  try { const url = new URL(config?.origin); if (['http:', 'https:'].includes(url.protocol)) origin = url.origin; } catch { /* Unconfigured URL is handled by connection options. */ }
  await refresh();
});
chrome.tabs.onActivated.addListener(detectPage);
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (tab.active && change.url) {
    if (displayedPage?.id === id && displayedPage.url) {
      const previous = new URL(displayedPage.url), current = new URL(change.url);
      previous.hash = current.hash = '';
      if (previous.href === current.href) { displayedPage.url = change.url; return; }
    }
    detectPage();
  }
});
