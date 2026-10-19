const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
const {createBackground} = require('../background.js');
const ui = {id: 'extension', url: 'chrome-extension://extension/sidepanel.html'};
function form() {
  const document = new JSDOM('<label for="age">Are you 18 years of age or older?*</label><div><div><div><input id="age" role="combobox" aria-required="true"></div></div></div>').window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const worker = createWorker(document), input = document.getElementById('age');
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      input.setAttribute('aria-controls', 'menu');
      const menu = document.createElement('div'); menu.id = 'menu';
      menu.innerHTML = '<div role="option">Yes</div><div role="option">No</div>';
      document.body.append(menu);
    } else if (event.key === 'Escape') document.getElementById('menu')?.remove();
  });
  return {document, worker, input};
}
test('manual combobox answer survives input replacement, lost option cache and a shifted DOM index', async () => {
  const {document, worker, input} = form();
  await worker.prepare();
  const field = worker.describe()[0];
  assert.equal(field.options.length, 2);
  const replacement = input.cloneNode(true); input.replaceWith(replacement);
  const selected = document.createElement('span'); selected.className = 'select__single-value'; selected.textContent = 'Yes';
  replacement.parentElement.parentElement.append(selected);
  document.body.prepend(document.createElement('input'));
  assert.deepEqual(worker.answer(field), {question: field.label, answer: 'Yes'});
});
test('Save identifies an actual field-label change instead of a generic stale-descriptor message', () => {
  const {document, worker} = form(), field = worker.describe()[0];
  document.querySelector('label').textContent = 'A different question';
  assert.throws(() => worker.answer(field), /field label changed/i);
});
function backgroundSetup() {
  const values = {active: {id: 1, source: 'hotfix'}, origin: 'http://localhost:8000'}, calls = [];
  const storage = {get: async key => ({[key]: values[key]}), set: async data => Object.assign(values, data)};
  let tab = {id: 4, url: 'https://job-boards.greenhouse.io/addepar/jobs/123'};
  const chrome = {runtime: {id: 'extension', getURL: path => `chrome-extension://extension/${path}`},
    storage: {local: storage, session: storage}, tabs: {get: async () => ({...tab}), sendMessage: async () => ({question: 'Age?', answer: 'Yes'})}};
  const background = createBackground(chrome, async (url, options) => {
    calls.push({url, body: options?.body && JSON.parse(options.body)});
    return {ok: true, json: async () => url.includes('/resolve?') ? null : {}};
  });
  const save = () => background.handle({type: 'save', jobId: 1, tabId: 4, field: {ref: [0, 0], label: 'Age?'}}, ui);
  return {chrome, values, calls, background, save, navigate: url => { tab = {...tab, url}; }};
}
test('auto-detection clearing the Job before and during Save, plus a fragment change, do not invalidate a global bank save', async () => {
  const {chrome, values, calls, background, save, navigate} = backgroundSetup();
  await background.handle({type: 'detect', tabId: 4}, ui);
  assert.equal(values.active, null);
  chrome.tabs.sendMessage = async () => {
    await background.handle({type: 'detect', tabId: 4}, ui);
    navigate('https://job-boards.greenhouse.io/addepar/jobs/123#application');
    return {question: 'Age?', answer: 'Yes'};
  };
  await save();
  assert.deepEqual(calls.at(-1), {url: 'http://localhost:8000/api/fill/answers', body: {question: 'Age?', answer: 'Yes'}});
});
test('a real URL change during Save is rejected with its cause and no bank write', async () => {
  const {chrome, calls, save, navigate} = backgroundSetup();
  chrome.tabs.sendMessage = async () => {
    navigate('https://job-boards.greenhouse.io/other/jobs/456');
    return {question: 'Age?', answer: 'Yes'};
  };
  await assert.rejects(save(), /page URL changed/i);
  assert.equal(calls.length, 0);
});
test('fragment-only tab updates preserve pending rows and the selected Job', async () => {
  const job = {id: 1, title: 'Engineer', source: 'hotfix'}, calls = [], listeners = {};
  const tab = {id: 4, active: true, url: 'https://job-boards.greenhouse.io/addepar/jobs/123'};
  const field = {ref: [0, 0], label: 'Age?', required: true};
  const panel = new JSDOM(fs.readFileSync(`${__dirname}/../sidepanel.html`, 'utf8'), {runScripts: 'outside-only'});
  panel.window.chrome = {runtime: {sendMessage: async message => {
    calls.push(message);
    return {value: {detect: job, jobs: [job], resume: {}, fill: {job, fields: [field], actions: [{ref: field.ref, action: 'ask'}], filled: 0}, save: {}}[message.type]};
  }}, tabs: {query: async () => [{...tab}], onActivated: {addListener() {}}, onUpdated: {addListener: fn => { listeners.update = fn; }}}};
  panel.window.eval(fs.readFileSync(`${__dirname}/../sidepanel.js`, 'utf8'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const element = id => panel.window.document.getElementById(id);
  await settle(); element('fill').click(); await settle();
  const detects = calls.filter(call => call.type === 'detect').length;
  tab.url += '#application'; listeners.update(tab.id, {url: tab.url}, tab); await settle();
  assert.equal(calls.filter(call => call.type === 'detect').length, detects);
  const save = [...element('remaining').querySelectorAll('button')].find(button => button.textContent === 'Save to bank');
  assert.ok(save, 'the pending row must remain available');
  save.click(); await settle();
  assert.equal(element('status').textContent, 'Saved to bank. Next Fill replays this answer.');
  panel.window.close();
});
test('Save rejects an unscanned document, a removed/ambiguous field, and an unanswered combobox explicitly', () => {
  const {document, worker, input} = form();
  assert.throws(() => worker.answer({ref: 0}), /document has not been scanned/i);
  const field = worker.describe()[0];
  assert.throws(() => worker.answer(field), /Answer the field before saving/);
  input.disabled = true;
  assert.throws(() => worker.answer(field), /hidden, disabled or read-only/);
  input.disabled = false;
  const clone = input.cloneNode(true); document.body.append(clone);
  assert.throws(() => worker.answer(field), /field is ambiguous/);
  clone.remove(); input.remove();
  assert.throws(() => worker.answer(field), /field is missing/);
});
