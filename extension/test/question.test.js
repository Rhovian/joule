const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {createBackground} = require('../background.js');
const ui = {id: 'extension', url: 'chrome-extension://extension/sidepanel.html'};
function setup() {
  const job = {id: 1, title: 'Engineer', company: 'Acme', source: 'hotfix'};
  const values = {active: job, origin: 'http://localhost:8000'}, calls = [];
  const storage = {get: async key => ({[key]: values[key]}), set: async data => Object.assign(values, data),
    remove: async key => { delete values[key]; }};
  const chrome = {runtime: {id: 'extension', getURL: path => `chrome-extension://extension/${path}`},
    storage: {local: storage, session: storage}, tabs: {
      get: async () => ({id: 4, url: 'https://employer.example/job'}), query: async () => [{id: 4}],
      onActivated: {addListener() {}}, onUpdated: {addListener() {}},
    }};
  const response = {value: 'Profile answer <b>as text</b>'};
  const background = createBackground(chrome, async (url, options) => {
    calls.push({url, options});
    let value = {};
    if (url.includes('/resolve?')) value = job;
    else if (url.endsWith('/api/jobs')) value = [job];
    else if (url.endsWith('/ask')) value = response;
    return {ok: true, json: async () => value};
  });
  chrome.runtime.sendMessage = async message => {
    try { return {value: await background.handle(message, ui)}; }
    catch (error) { return {error: error.message}; }
  };
  return {chrome, values, calls, response, background};
}
test('generic Ask uses the existing endpoint with no page field, shows literal text, copies, and handles refusal', async () => {
  const {chrome, values, calls, response} = setup();
  const panel = new JSDOM(fs.readFileSync(`${__dirname}/../sidepanel.html`, 'utf8'), {runScripts: 'outside-only'});
  panel.window.chrome = chrome;
  let copied;
  panel.window.navigator.clipboard = {writeText: async text => { copied = text; }};
  panel.window.eval(fs.readFileSync(`${__dirname}/../sidepanel.js`, 'utf8'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const element = id => panel.window.document.getElementById(id);
  await settle();
  chrome.tabs.get = async () => { throw Error('Ask must not inspect a page'); };
  chrome.tabs.query = chrome.tabs.get;
  assert.equal(element('ask').disabled, true);
  assert.equal(element('cover'), null);
  element('question').value = '  What is my timezone?  ';
  element('question').dispatchEvent(new panel.window.Event('input'));
  assert.equal(element('ask').disabled, false);
  element('ask').click();
  assert.equal(element('ask').disabled, true);
  await settle();
  const call = calls.find(call => call.url.endsWith('/ask'));
  assert.equal(call.url, 'http://localhost:8000/api/fill/jobs/1/ask');
  assert.deepEqual(JSON.parse(call.options.body), {question: 'What is my timezone?'});
  assert.equal(element('answer').value, response.value);
  assert.equal(element('copy').disabled, false);
  element('copy').click();
  await settle();
  assert.equal(copied, response.value);
  assert.equal(element('status').textContent, 'Answer copied.');
  response.value = null; response.reason = 'sensitive';
  element('ask').click(); await settle();
  assert.equal(element('answer').value, '');
  assert.equal(element('copy').disabled, true);
  assert.equal(element('status').textContent, 'sensitive');
  values.active = null;
  element('ask').click(); await settle();
  assert.match(element('status').textContent, /Pick a non-Upwork Job/);
  assert.equal(element('ask').disabled, true);
  panel.window.close();
});
test('generic Ask rejects page senders and a changed Job before calling joule', async () => {
  const {background, values, calls} = setup();
  const message = {type: 'question', jobId: 1, question: 'Where do I work?'};
  await assert.rejects(background.handle(message, {...ui, tab: {id: 4}}), /Only extension UI/);
  values.active.id = 2;
  await assert.rejects(background.handle(message, ui), /intended Job/);
  values.active = null;
  await assert.rejects(background.handle(message, ui), /Pick a non-Upwork Job/);
  assert.equal(calls.length, 0);
});
test('generic Ask rejects a response after the active Job changes and clears a missing Job', async () => {
  const {chrome, values} = setup();
  let finish;
  const background = createBackground(chrome, async () => new Promise(resolve => { finish = resolve; }));
  const pending = background.handle({type: 'question', jobId: 1, question: 'Why this Job?'}, ui);
  await new Promise(resolve => setImmediate(resolve));
  values.active = {...values.active, id: 2};
  finish({ok: true, json: async () => ({value: 'Old answer'})});
  await assert.rejects(pending, /Job changed/);
  const missing = createBackground(chrome, async () => ({ok: false, status: 404}));
  await assert.rejects(missing.handle({type: 'question', jobId: 2, question: 'Why?'}, ui), /HTTP 404/);
  assert.equal(values.active, undefined);
});
