const element = id => document.getElementById(id);
const review = document.querySelector('.review');
const text = (tag, value, className = '') => Object.assign(document.createElement(tag), {textContent: value ?? '', className});
let jobs = [], busy = false, active = null, choosing = false, connected = null, origin = '';
let resumeDraft = null, displayedPage = null, lastResult = null, theme = 'system', themeVersion = 0, pageDraft = null, canUndo = false;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  document.documentElement.classList.toggle('dark', theme === 'dark' || theme === 'system' && systemTheme.matches);
}
systemTheme.addEventListener('change', applyTheme);
applyTheme();
async function refreshTheme() {
  // runtime.sendMessage has no cancellation option; ignore superseded or offline replies.
  // https://developer.chrome.com/docs/extensions/reference/api/runtime#method-sendMessage
  const version = ++themeVersion;
  let value;
  try { value = await send({type: 'appearance'}); } catch { /* Unavailable appearance falls back to System. */ }
  if (version !== themeVersion || !connected) return;
  theme = ['light', 'dark'].includes(value?.theme) ? value.theme : 'system';
  applyTheme();
}
const context = () => active && displayedPage?.url ? {job:active,tabId:displayedPage.id,url:displayedPage.url,origin} : null;
let work = {}, runVersion = 0, refreshVersion = 0, restoreControls = () => {};
const sameContext = bound => !bound || origin === bound.origin && active?.id === bound.job.id && displayedPage?.id === bound.tabId && displayedPage?.url?.split('#')[0] === bound.url?.split('#')[0];
async function generate(message, apply) {
  const bound = message.context || context(), result = await send({...message,...(bound ? {context:bound} : {})});
  if (sameContext(bound)) await apply(result);
}
async function send(message) {
  if (['fill','ask-preview','resume-download','resume','cover-letter'].includes(message.type)) {
    const bound = message.context || context();
    if (bound) message = {...message,context:bound,jobId:bound.job.id,tabId:bound.tabId};
  }
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw Error(result.error === 'Unknown request' ? `Reload Joule Fill in chrome://extensions and reopen the panel: its background worker does not support ${message.type}.` : result.error);
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
  if (!value) { themeVersion++; theme = 'system'; applyTheme(); connectionOptions(true); }
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
  element('cv-card').hidden = element('resume-download').hidden = !active || choosing;
  element('cover-letter').hidden = !active || choosing;
  element('cancel-pick').hidden = !active;
  element('picker-title').textContent = active ? 'Choose a Job' : 'No Job matches this page';
  document.body.classList.toggle('nomatch', !active || choosing);
  element('fill').disabled = busy || !active || choosing || connected === false;
  element('fill').textContent = busy ? 'Working…' : connected === false ? 'Fill form' : !active || choosing ? 'Pick a Job to Fill' : lastResult ? 'Fill again' : 'Fill form';
  element('attach').disabled = busy || !active;
  element('mark-applied').hidden = !lastResult; element('undo-applied').hidden = !lastResult || !canUndo;
  element('mark-applied').textContent = active?.state === 'applied' ? 'Applied' : 'Mark applied';
  element('mark-applied').disabled = busy || active?.state === 'applied';
  element('create-job').hidden = !!active || !pageDraft || connected === false;
}
function clearResult() {
  lastResult = null; canUndo = false; work = {};
  showCover('');
  review.textContent = 'Joule never submits. Review every value, then submit yourself.';
  document.body.classList.remove('after');
  for (const id of ['result', 'remaining', 'optional', 'filled']) element(id).hidden = true;
  for (const id of ['need-rows', 'optional-rows', 'filled-rows']) element(id).replaceChildren();
  element('resume-download').href = '#'; element('resume-download').removeAttribute('download');
  element('optional').open = element('filled').open = false;
}
async function refreshDrafts() {
  const bound = context();
  const result = active ? await send({type: 'resume'}) : {};
  if (!sameContext(bound)) return;
  resumeDraft = result.resume_draft;
  showCover('');
  if (active && result.cover_letter_draft_id) {
    try { const letter = await send({type: 'cover-letter', jobId: active.id}); if (!sameContext(bound)) return; showCover(letter); }
    catch (error) { if (!sameContext(bound)) return; element('cover-status').textContent = error.message; }
  }
  element('resume').textContent = resumeDraft ? `v${resumeDraft.version} · ${new Date(resumeDraft.created_at).toLocaleString()}` : 'Generated when needed for Fill or Download';
  showActive(result.job || active);
}
function showCover(value) {
  element('cover-status').textContent = '';
  element('cover-text').textContent = value;
  element('cover-copy').hidden = !value;
  element('cover-generate').textContent = value ? 'Regenerate' : 'Generate';
}
element('cover-generate').addEventListener('click', () => run(async () => {
  await generate({type: 'cover-letter', jobId: active.id, generate: true},showCover);
}));
element('cover-copy').addEventListener('click', () => run(() => navigator.clipboard.writeText(element('cover-text').textContent)));

function showDownload(file) {
  const link = element('resume-download');
  // Native data-URL downloads need no downloads permission (HTML downloading-resources algorithm).
  link.href = `data:application/pdf;base64,${file.base64}`; link.download = file.name;
}
element('resume-download').addEventListener('click', event => {
  if (event.currentTarget.hasAttribute('download')) { status('Tailored CV ready to download.'); return; }
  event.preventDefault();
  void run(() => generate({type:'resume-download',jobId:active.id}, file => { showDownload(file); element('resume-download').click(); }));
});

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
      showActive(await send({type: 'select', id: job.id,tabId:displayedPage?.id,pageURL:displayedPage?.url}));
      element('match-mode').textContent = 'picked manually';
      await refreshDrafts(); status('Ready to Fill');
    }));
    return button;
  }));
  if (!element('job-choices').children.length) element('job-choices').append(text('p', 'No Jobs match your search.', 'field-row muted'));
}
async function run(work, replace = false) {
  if (busy && !replace) return;
  if (busy) restoreControls();
  const version = ++runVersion;
  busy = true;
  const focused = document.activeElement, disabled = new Set(document.querySelectorAll('button:disabled,input:disabled,select:disabled,textarea:disabled'));
  document.querySelectorAll('button,input,select,textarea').forEach(node => { node.disabled = true; });
  restoreControls = () => document.querySelectorAll('button,input,select,textarea').forEach(node => { node.disabled = disabled.has(node); });
  showActive(active); status('Working…');
  try { await work(); }
  catch (error) {
    if (version !== runVersion) return;
    if (connected === false) element('connection-message').textContent = error.message;
    status(error.message, connected !== false);
    try { showActive(await send({type: 'active'})); } catch { showActive(null); }
  } finally {
    if (version !== runVersion) return;
    busy = false; restoreControls();
    showActive(active);
    if (document.activeElement === document.body && focused.isConnected) focused.focus({preventScroll: true});
  }
}
async function refresh(updateTheme = false) {
  const version = ++refreshVersion;
  clearResult(); pageDraft = null;
  let detection;
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (version !== refreshVersion) return;
    if (!tab) throw Error('Chrome did not provide an active tab');
    displayedPage = {id: tab.id, url: tab.url};
    choosing = false; const job = await send({type: 'detect', tabId: tab.id});
    if (version !== refreshVersion) return; showActive(job);
    detection = active ? 'Detected Job from page URL.' : 'No stored Job matches this page; pick a Job manually.';
    element('match-mode').textContent = 'matched from page URL';
  } catch (error) { if (version !== refreshVersion) return; showActive(null); detection = `Auto-detect failed: ${error.message}`; }
  try { const listed = await send({type: 'jobs'}); if (version !== refreshVersion) return; jobs = listed; }
  catch (error) { if (version !== refreshVersion) return; online(false, error.message); throw error; }
  const reconnecting = connected === false, checkTheme = updateTheme || connected !== true;
  online(true); if (reconnecting) connectionOptions(false);
  if (checkTheme) void refreshTheme();
  await refreshDrafts(); if (version !== refreshVersion) return; picker();
  if (context()) {
    const saved = await send({type:'work',context:context()});
    if (version !== refreshVersion) return; work = saved || {};
    if (work.fill?.value) renderFill(work.fill.value,displayedPage.id);
    if (work['cover-letter']?.value !== undefined) showCover(work['cover-letter'].value);
    if (work['resume-download']?.value) showDownload(work['resume-download'].value);
  }
  if (!active && displayedPage?.url && /^https?:/.test(displayedPage.url)) {
    try {
      const page = await send({type: 'page', tabId: displayedPage.id});
      if (version !== refreshVersion) return; pageDraft = page;
      const data = readPaste(pageDraft.text), form = element('create-form');
      for (const name of ['title', 'company', 'kind', 'url']) form.elements.namedItem(name).value = name === 'url' ? pageDraft.url : name === 'title' ? pageDraft.title || data.title : data[name];
      showActive(active);
    } catch { /* Read access can be granted by Fill with Joule; manual selection stays available. */ }
  }
  const failed = Object.values(work).find(record => record?.status === 'error');
  if (failed) status(failed.error,true);
  else status(Object.values(work).some(record => record?.status === 'running') ? 'Generating for this Job. You can switch away and return.' : lastResult ? `${lastResult.filled} filled. Review the form.` : detection, detection.startsWith('Auto-detect failed:'));
}
function fieldRow(action, field, result, tabId) {
  const row = text('div', '', 'field-row'), line = text('div', '', 'field-line'), question = text('div', '', 'field-question');
  if (field?.required) question.append(text('span', 'Required', 'required'), document.createElement('br'));
  question.append(document.createTextNode(field?.label || field?.id || 'Field'));
  line.append(question); row.append(line);
  if (action.reason) row.append(text('p', action.reason, 'field-reason'));
  if (action.action !== 'ask') return row;
  const answer = text('textarea', '', 'field-answer'), response = text('p', '', 'field-reason'), buttons = text('div', '', 'actions');
  answer.rows = 4; answer.setAttribute('aria-label', `Edit answer for ${field?.label || field?.id || 'field'}`);
  answer.hidden = true; response.textContent = 'Ask previews an answer. Edit it, then Fill field writes it to the form.';
  const fill = text('button', 'Fill field', 'primary'), ask = text('button', 'Ask'), copy = text('button', 'Copy'), save = text('button', 'Save to bank');
  fill.hidden = copy.hidden = true; save.title = 'Save the current answer from the form';
  const bound = {job:result.job,tabId,url:result.trace?.url || displayedPage?.url,origin}, ref = JSON.stringify(field.ref);
  function showAnswer(resultAnswer) {
    answer.value = resultAnswer.value ?? ''; answer.hidden = resultAnswer.value === null;
    fill.hidden = copy.hidden = !resultAnswer.value; response.hidden = false;
    response.textContent = resultAnswer.value === null ? resultAnswer.reason || 'No answer available from Profile.' : 'Answer preview only. Click Fill field to write it to the form.';
    row.classList.toggle('answered', resultAnswer.value !== null); ask.textContent = 'Ask again'; buttons.append(ask);
    status(response.textContent);
  }
  const cached = work['ask-preview:' + ref];
  if (cached?.status === 'done') { showAnswer(cached.value); answer.value = work['edit:' + ref] ?? answer.value; }
  answer.addEventListener('input', () => { void send({type:'work-edit',context:bound,field,value:answer.value}); });
  ask.addEventListener('click', () => run(() => generate({type:'ask-preview',tabId,jobId:result.job.id,field,context:bound},showAnswer)));
  fill.addEventListener('click', () => run(async () => { await send({type: 'fill-field', context:bound, tabId, jobId: result.job.id, field, pageURL: result.trace?.url || displayedPage?.url, value: answer.value}); response.hidden = false; response.textContent = 'Field filled. Review the form.'; status(response.textContent); }));
  copy.addEventListener('click', () => run(async () => { await navigator.clipboard.writeText(answer.value); status('Answer copied.'); }));
  save.addEventListener('click', () => run(async () => {
    await send({type: 'save', tabId, jobId: result.job.id, field});
    save.textContent = 'Saved'; status('Saved to bank. Next Fill replays this answer.');
  }));
  buttons.append(fill, ask, copy, save); row.append(answer, buttons, response);
  return row;
}
element('fill').addEventListener('click', () => run(async () => {
  clearResult();
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  const bound = context();
  await generate({type: 'fill', tabId: tab.id, attachResume: element('attach').checked},async result => {
    await refreshDrafts(); if (sameContext(bound)) renderFill(result,tab.id);
  });
}));
function renderFill(result,tabId) {
  for (const id of ['need-rows','optional-rows','filled-rows']) element(id).replaceChildren();
  lastResult = {...result, job: result.job || active};
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
    for (const {action, field} of rows) list.append(fieldRow(action, field, lastResult, tabId));
  }
  element('result').hidden = false;
  element('resume-result').textContent = result.attached ? `✓ ${result.resumeName || 'Tailored CV'} attached` : result.resumeStatus || '';
  element('fill-warning').textContent = result.traceError || '';
  element('fill-warning').hidden = !result.traceError;
  if (result.resumeDownload) showDownload(result.resumeDownload);
  document.body.classList.add('after');
  element('mark-applied').hidden = false;
  review.textContent = 'Submitted it yourself? Applied moves the Job to Pipeline.';
  status(`${result.filled} filled. Review the form.`);
}
element('create-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy || !pageDraft) return;
  const values = Object.fromEntries(new FormData(element('create-form'))), draft = pageDraft, tabId = displayedPage.id;
  void run(async () => {
    const job = await send({type: 'create', tabId, pageURL: draft.url, data: {...values, description: draft.text}});
    pageDraft = null; choosing = false; showActive(job); await refreshDrafts(); status('Job created or matched. Scoring runs in Joule.');
  });
});
function appliedAction(type) { return run(async () => {
  const result = await send({type, jobId: lastResult.job.id});
  canUndo = result.canUndo; showActive({...active, state: result.job.state});
  status(type === 'mark-applied' ? result.canUndo ? 'Applied · in Pipeline. Undo restores the previous state.' : 'Already applied · in Pipeline.' : 'Previous state restored.');
}); }
element('mark-applied').addEventListener('click', () => appliedAction('mark-applied'));
element('undo-applied').addEventListener('click', () => appliedAction('undo-applied'));
element('job-search').addEventListener('input', picker);
element('change').addEventListener('click', () => { choosing = true; element('job-search').value = ''; picker(); showActive(active); element('job-search').focus(); });
element('cancel-pick').addEventListener('click', () => { choosing = false; showActive(active); });
element('settings').addEventListener('click', () => connectionOptions(element('connection-options').hidden));
element('retry').addEventListener('click', () => run(() => refresh(true)));
element('test').addEventListener('click', () => run(async () => {
  element('connection-message').textContent = await connect(chrome, element('origin').value);
  origin = normalizeOrigin(element('origin').value);
  await refresh(true);
}));
function detectPage() { void run(refresh,true); }
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
// Session storage changes also reach a reopened panel after the initiating panel has closed.
// https://developer.chrome.com/docs/extensions/reference/api/storage#event-onChanged
chrome.storage?.onChanged?.addListener((changes,area) => {
  if (area === 'session' && Object.entries(changes).some(([key,change]) => key.startsWith('work:') && ['done','error'].includes(change.newValue?.status))) detectPage();
});
