const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
const {createBackground} = require('../background.js');

function storage(values) {
  return {get: async key => ({[key]: values[key]}), set: async data => Object.assign(values, data)};
}
for (const site of ['lever', 'rippling']) for (const existing of [true, false]) test(`panel and resume attachment; site=${site}; existing=${existing}`, async () => {
  const url = site === 'rippling' ? 'https://ats.rippling.com/acme/jobs/example/apply' : 'https://jobs.lever.co/acme/apply';
  const markup = site === 'rippling' ? fs.readFileSync(`${__dirname}/fixtures/rippling-upload.html`, 'utf8') : '<input id="resume" type="file">';
  const document = new JSDOM(markup, {url}).window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const window = document.defaultView, worker = createWorker(document);
  // jsdom 26.1.0 has no DataTransfer: https://github.com/jsdom/jsdom/tree/26.1.0/lib/jsdom/living
  window.DataTransfer = class {
    files = [];
    items = {add: file => this.files.push(file)};
  };
  const input = document.querySelector('input'), events = [], calls = [];
  Object.defineProperty(input, 'files', {value: [], writable: true});
  for (const type of ['input', 'change']) input.addEventListener(type, event => events.push(event.type));
  const tab = {id: 4, url};
  const ui = {id: 'extension', url: 'chrome-extension://extension/sidepanel.html'};
  const active = {id: 1, title: 'Engineer', company: 'Acme', source: 'hotfix'};
  const chrome = {runtime: {id: 'extension', getURL: path => `chrome-extension://extension/${path}`},
    storage: {local: storage({origin: 'http://localhost:8000'}), session: storage({active})},
    tabs: {get: async () => tab, query: async () => [tab],
      onActivated: {addListener() {}}, onUpdated: {addListener() {}}}};
  let generated = existing;
  const draft = {id: 9, version: 2, created_at: '2026-10-14T10:00:00Z'};
  const background = createBackground(chrome, async (url, options) => {
    calls.push({url, options});
    if (url.includes('/api/jobs/resolve?')) return {ok: true, json: async () => active};
    if (url.endsWith('/api/jobs')) return {ok: true, json: async () => []};
    if (url.endsWith('/drafts')) {
      assert.equal(url, 'http://localhost:8000/api/jobs/1/drafts');
      assert.deepEqual(JSON.parse(options.body), {kind: 'tailored_cv'});
      generated = true;
      return {ok: true, json: async () => ({})};
    }
    if (url.endsWith('/pdf')) return {ok: true,
      headers: new Headers({'Content-Disposition': 'inline; filename="JB_CV_Acme.pdf"'}),
      arrayBuffer: async () => Uint8Array.from([37, 80, 68, 70]).buffer};
    const {fields} = JSON.parse(options.body);
    return {ok: true, json: async () => ({resume_draft_id: generated ? 9 : null,
      resume_draft: generated ? draft : null, cover_letter_draft_id: null,
      actions: fields.map(field => field.name === 'cover_letter' ? {ref: field.ref, action: 'leave'} :
        {ref: field.ref, action: 'upload', file: 'resume'})})};
  });
  const sender = {id: 'extension', tab, frameId: 7, url: tab.url};
  await background.handle({type: 'register'}, sender);
  chrome.tabs.sendMessage = async (tabId, message, target) => {
    assert.equal(target.frameId, 7);
    if (message.type === 'describe') {
      await background.handle({type: 'frame', request: message.request, fields: worker.describe()}, sender);
      return {ok: true};
    }
    return worker.upload(message.ref, message.file);
  };
  chrome.runtime.sendMessage = async message => ({value: await background.handle(message, ui)});
  const panel = new JSDOM(fs.readFileSync(`${__dirname}/../sidepanel.html`, 'utf8'), {runScripts: 'outside-only'});
  panel.window.chrome = chrome;
  panel.window.eval(fs.readFileSync(`${__dirname}/../sidepanel.js`, 'utf8'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  const element = id => panel.window.document.getElementById(id);
  assert.equal(element('attach').textContent, existing ? 'Attach resume' : 'Generate and attach resume');
  if (existing) {
    assert.match(element('resume').textContent, /Tailored CV v2/);
    assert.ok(element('resume').textContent.includes(new Date(draft.created_at).toLocaleString()));
  } else assert.equal(element('resume').textContent, 'Generate a Tailored CV');
  element('attach').dispatchEvent(new panel.window.Event('click'));
  await settle();
  assert.equal(input.files[0].name, 'JB_CV_Acme.pdf');
  assert.equal(input.files[0].type, 'application/pdf');
  assert.equal(input.files[0].size, 4);
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(calls.filter(call => call.url.endsWith('/drafts')).length, existing ? 0 : 1);
  assert.ok(calls.some(call => call.url === 'http://localhost:8000/api/drafts/9/pdf'));
  assert.match(element('resume').textContent, /Tailored CV v2/);
  assert.equal(element('status').textContent, '1 attached. Review the form.');
});

for (const mode of ['reuse', 'generate', 'missing-input', 'failure', 'changed']) test(`Fill CV: ${mode}`, async () => {
  const active = {id: 1, source: 'hotfix'}, tab = {id: 4, url: 'https://jobs.lever.co/acme/apply'};
  const chrome = {runtime: {id: 'ext', getURL: p => `chrome-extension://ext/${p}`},
    storage: {local: storage({origin: 'http://localhost:8000'}), session: storage({active, 'frames:4': {7: tab.url}})},
    tabs: {get: async () => tab}};
  const sender = {id: 'ext', url: 'chrome-extension://ext/sidepanel.html'};
  let background, generated = mode !== 'generate', generations = 0, uploads = 0, complete = false;
  let release; const pendingUpload = new Promise(resolve => { release = resolve; });
  background = createBackground(chrome, async (url, options) => {
    if (url.endsWith('/drafts')) { generated = true; generations++; return {ok: true, json: async () => ({})}; }
    if (url.endsWith('/pdf')) {
      if (mode === 'changed') await chrome.storage.session.set({active: {id: 2}});
      return {ok: mode !== 'failure', status: 502,
        headers: new Headers({'Content-Disposition': 'inline; filename="CV.pdf"'}),
        arrayBuffer: async () => new ArrayBuffer(1)};
    }
    if (url.endsWith('/traces')) return {ok: true, json: async () => ({file: '/trace'})};
    if (generations) assert.deepEqual(JSON.parse(options.body).fields, []); // No second AI batch.
    return {ok: true, json: async () => ({resume_draft_id: generated ? 9 : null,
      actions: mode === 'missing-input' ? [] : [{ref: [7, 0], action: 'upload', file: 'resume'}]})};
  });
  chrome.tabs.sendMessage = async (id, message, target) => {
    assert.equal(target.frameId, 7);
    if (message.type === 'describe') return background.handle({type: 'frame', request: message.request,
      fields: [{ref: 0, id: 'resume', type: 'file'}]}, {id: 'ext', tab, frameId: 7, url: tab.url});
    if (message.type === 'trace-apply') return {filled: 2, trace: []};
    uploads++; await pendingUpload; return {filled: 1};
  };
  const filling = background.handle({type: 'fill', tabId: 4}, sender).then(result => { complete = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  if (['reuse', 'generate'].includes(mode)) { assert.equal(uploads, 1); assert.equal(complete, false); }
  release(); const result = await filling;
  assert.equal(result.filled, 2);
  assert.equal(generations, mode === 'generate' ? 1 : 0);
  assert.equal(result.attached, ['reuse', 'generate'].includes(mode) ? 1 : 0);
  assert.match(result.resumeStatus, mode === 'missing-input' ? /No resume file input/ :
    ['failure', 'changed'].includes(mode) ? /attachment failed/ : /Tailored CV attached/);
  await chrome.storage.session.set({active: null});
  await assert.rejects(background.handle({type: 'fill', tabId: 4}, sender), /No Job selected/);
});

test('Greenhouse upload waits for its committed filename and reports an upload error', async () => {
  for (const success of [true, false]) {
    const document = new JSDOM('<div class="file-upload"><div><input id="resume" type="file"></div></div>').window.document;
    const window = document.defaultView, input = document.querySelector('input'), root = document.querySelector('.file-upload');
    window.DataTransfer = class { files = []; items = {add: file => this.files.push(file)}; };
    Object.defineProperty(input, 'files', {value: [], writable: true});
    input.addEventListener('change', () => input.parentElement.remove());
    const worker = createWorker(document); worker.describe();
    let done = false;
    const uploading = worker.upload(0, {name: 'CV.pdf', base64: 'JVBERg=='}).finally(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
    root.innerHTML = success ? '<div class="file-upload__filename">CV.pdf</div>' : '<p id="resume-error">Upload failed</p>';
    if (success) assert.equal((await uploading).filled, 1);
    else await assert.rejects(uploading, /upload was not confirmed/);
  }
});
