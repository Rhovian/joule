const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
const {createBackground} = require('../background.js');
test('Save reads current edits and option labels and posts them to the bank', async () => {
  const document = new JSDOM('<label for="q">Why us?</label><textarea id="q"></textarea><label for="s">Language?</label><select id="s"><option value="py">Python</option></select>').window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const worker = createWorker(document), fields = worker.describe().map(field => ({...field, ref: [7, field.ref]}));
  document.getElementById('q').value = 'Operator edit';
  const active = {id: 1, source: 'hotfix'}, tab = {id: 4, url: 'https://jobs.lever.co/acme/apply'};
  const storage = values => ({get: async key => ({[key]: values[key]})});
  const chrome = {runtime: {id: 'extension', getURL: path => `chrome-extension://extension/${path}`},
    storage: {local: storage({origin: 'http://localhost:8000'}), session: storage({active})},
    tabs: {get: async () => tab, sendMessage: async (id, message, target) => {
      assert.equal(id, 4); assert.equal(target.frameId, 7);
      assert.equal(message.type, 'answer'); return worker.answer(message.expected);
    }}};
  const calls = [], background = createBackground(chrome, async (url, options) => {
    calls.push({url, body: JSON.parse(options.body)}); return {ok: true, json: async () => ({})};
  });
  const ui = {id: 'extension', url: 'chrome-extension://extension/sidepanel.html'};
  for (const field of fields) await background.handle({type: 'save', jobId: 1, tabId: 4, field}, ui);
  assert.deepEqual(calls, [
    {url: 'http://localhost:8000/api/fill/answers', body: {question: 'Why us?', answer: 'Operator edit'}},
    {url: 'http://localhost:8000/api/fill/answers', body: {question: 'Language?', answer: 'Python'}},
  ]);
});
