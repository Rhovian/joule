const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
const {createBackground} = require('../background.js');

function storage(values) {
  return {get: async key => ({[key]: values[key]}), set: async data => Object.assign(values, data)};
}
for (const existing of [true, false]) test(`panel and resume attachment; existing=${existing}`, async () => {
  const document = new JSDOM('<input id="resume" type="file">').window.document;
  const window = document.defaultView, worker = createWorker(document);
  // jsdom 26.1.0 has no DataTransfer: https://github.com/jsdom/jsdom/tree/26.1.0/lib/jsdom/living
  window.DataTransfer = class {
    files = [];
    items = {add: file => this.files.push(file)};
  };
  const input = document.getElementById('resume'), events = [], calls = [];
  Object.defineProperty(input, 'files', {value: [], writable: true});
  for (const type of ['input', 'change']) input.addEventListener(type, event => events.push(event.type));
  const tab = {id: 4, url: 'https://jobs.lever.co/acme/apply'};
  const ui = {id: 'extension', url: 'chrome-extension://extension/sidepanel.html'};
  const active = {id: 1, title: 'Engineer', company: 'Acme', source: 'hotfix'};
  const chrome = {runtime: {id: 'extension', getURL: path => `chrome-extension://extension/${path}`},
    storage: {local: storage({origin: 'http://localhost:8000'}), session: storage({active})},
    tabs: {get: async () => tab, query: async () => [tab]}};
  let generated = existing;
  const draft = {id: 9, version: 2, created_at: '2026-10-14T10:00:00Z'};
  const background = createBackground(chrome, async (url, options) => {
    calls.push({url, options});
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
      actions: fields.map(field => ({ref: field.ref, action: 'upload', file: 'resume'}))})};
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
