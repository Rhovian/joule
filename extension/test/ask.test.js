const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
const {createBackground} = require('../background.js');
function storage(values) {
  return {get: async key => ({[key]: values[key]}), set: async data => Object.assign(values, data), remove: async key => { delete values[key]; }};
}
test('Ask routes to the selected frame, clips text, maps select values and protects current fields', async () => {
  const document = new JSDOM('<label for="q">Why us?</label><textarea id="q" maxlength="4"></textarea><label for="s">Authorized?</label><select id="s"><option value=""></option><option value="yes">Yes</option><option value="no" disabled>No</option></select><input type="checkbox">').window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const worker = createWorker(document), fields = worker.describe().map(field => ({...field, ref: [7, field.ref]}));
  const active = {id: 1, source: 'hotfix'}, tab = {id: 4, url: 'https://jobs.lever.co/acme/apply'};
  const ui = {id: 'extension', url: 'chrome-extension://extension/sidepanel.html'};
  const session = {active}, calls = [], sent = [];
  const chrome = {runtime: {id: 'extension', getURL: path => `chrome-extension://extension/${path}`},
    storage: {local: storage({origin: 'http://localhost:8000'}), session: storage(session)}, tabs: {get: async () => tab,
      sendMessage: async (id, message, target) => { sent.push(target); return worker.apply(message.actions, message.expected); }}};
  let value = 'Known answer';
  const background = createBackground(chrome, async (url, options) => {
    calls.push({url, options}); return {ok: true, json: async () => ({value, reason: value === null ? 'not answerable from Profile' : undefined})};
  });
  const ask = field => background.handle({type: 'ask', jobId: 1, tabId: 4, field}, ui);
  assert.equal((await ask(fields[0])).filled, 1);
  assert.equal(document.getElementById('q').value, 'Know');
  assert.equal((await ask(fields[0])).filled, 0);
  value = 'outside';
  assert.equal((await ask(fields[1])).filled, 0);
  value = null;
  const sentBefore = sent.length;
  assert.equal((await ask(fields[1])).reason, 'not answerable from Profile');
  assert.equal(sent.length, sentBefore);
  value = 'yes';
  assert.equal((await ask(fields[1])).filled, 1);
  assert.equal(document.getElementById('s').value, 'yes');
  assert.deepEqual(sent[0], {frameId: 7});
  assert.equal(calls[0].url, 'http://localhost:8000/api/fill/jobs/1/ask');
  assert.deepEqual(JSON.parse(calls[0].options.body), {question: 'Why us?', options: []});
  assert.equal(document.querySelector('input').checked, false);
});
test('radio replay sets only the matching option and preserves operator selection', () => {
  const document = new JSDOM('<fieldset><legend>Authorized?</legend><label>Yes<input type="radio" name="auth" value="yes"></label><label>No<input type="radio" name="auth" value="no"></label></fieldset>').window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const worker = createWorker(document), events = [];
  worker.describe();
  for (const type of ['input', 'change']) document.addEventListener(type, event => events.push(event.type));
  assert.equal(worker.apply([{ref: 0, action: 'set', value: 'yes'}]).filled, 1);
  assert.equal(document.querySelector('input').checked, true);
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(worker.apply([{ref: 0, action: 'set', value: 'no'}]).filled, 0);
});
