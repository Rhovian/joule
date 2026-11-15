const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
const {createBackground} = require('../background.js');
function storage(values) {
  return {get: async key => key === null ? {...values} : ({[key]: values[key]}), set: async data => Object.assign(values, data), remove: async key => { delete values[key]; }};
}
test('Ask previews without writing; Fill field writes the shown answer to the selected frame', async () => {
  const document = new JSDOM('<label for="q">Why us?</label><textarea id="q" maxlength="4"></textarea><label for="s">Authorized?</label><select id="s"><option value=""></option><option value="yes">Yes</option><option value="no" disabled>No</option></select><input type="checkbox">').window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const worker = createWorker(document), fields = worker.describe().map(field => Object.fromEntries(Object.entries({...field, options:field.options.map(({label,value})=>({label,value})), documentId:'original-document', ref: [7, field.ref]}).sort(([a],[b])=>a.localeCompare(b))));
  const active = {id: 1, source: 'hotfix'}, tab = {id: 4, url: 'https://jobs.lever.co/acme/apply'};
  const ui = {id: 'extension', url: 'chrome-extension://extension/sidepanel.html'};
  const session = {active}, calls = [], sent = [];
  const chrome = {runtime: {id: 'extension', getURL: path => `chrome-extension://extension/${path}`},
    storage: {local: storage({origin: 'http://localhost:8000'}), session: storage(session)}, tabs: {get: async () => ({...tab}),
      sendMessage: async (id, message, target) => { sent.push(target); return worker.apply(message.actions, message.expected); }}};
  let value = 'Known answer', state = 'dismissed', generationGate;
  const background = createBackground(chrome, async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/api/jobs/1')) { if (options?.method === 'PATCH') state = JSON.parse(options.body).state; return {ok:true,json:async()=>({id:1,state})}; }
    if (generationGate) await generationGate;
    return {ok: true, json: async () => ({value, reason: value === null ? 'not answerable from Profile' : undefined})};
  });
  const ask = field => background.handle({type: 'ask-preview', jobId: 1, tabId: 4, field}, ui);
  assert.equal((await ask(fields[0])).value, 'Known answer');
  assert.equal(document.getElementById('q').value, '');
  assert.equal(sent.length, 0);
  const context = {job: active, tabId: tab.id, url: tab.url};
  let release; generationGate = new Promise(resolve => { release = resolve; });
  const generating = background.handle({type:'ask-preview',jobId:1,tabId:4,field:fields[0],context},ui);
  await new Promise(resolve => setImmediate(resolve));
  session.active = {id:2,source:'hotfix'}; tab.url = 'https://jobs.lever.co/other/apply';
  release(); assert.equal((await generating).value,'Known answer'); generationGate = null;
  const restarted = createBackground(chrome);
  const saved = await restarted.handle({type:'work',context},ui);
  assert.equal(saved['ask-preview:[7,0]'].value.value,'Known answer');
  assert.equal(sent.length,0,'retained previews never write to the other page');
  await assert.rejects(background.handle({type:'fill-field',jobId:1,tabId:4,field:fields[0],value:'Known answer',pageURL:context.url},ui),/changed/i);
  session.active=active; tab.url=context.url;
  document.getElementById('q').value = 'edit';
  const before = calls.length;
  assert.equal((await background.handle({type: 'fill-field', tabId: 4, jobId: 1, field: fields[0], value: 'Shown answer'}, ui)).filled, 1);
  assert.equal(document.getElementById('q').value, 'Show');
  assert.equal(document.getElementById('s').value, '');
  assert.equal(calls.length, before, 'Fill field reuses the shown answer without an AI request');
  for (const change of [{pageURL:'https://jobs.lever.co/other'}, {jobId:2}]) await assert.rejects(background.handle({type:'fill-field',tabId:4,jobId:1,field:fields[0],value:'shown',...change},ui), /changed/i);
  await ask(fields[0]);
  assert.equal(document.getElementById('q').value, 'Show');
  value = null;
  const sentBefore = sent.length;
  assert.equal((await ask(fields[1])).reason, 'not answerable from Profile');
  assert.equal(sent.length, sentBefore);
  value = 'yes';
  const preview = await ask(fields[1]);
  assert.equal(document.getElementById('s').value, '');
  assert.equal(sent.length, sentBefore);
  assert.equal((await background.handle({type:'fill-field',tabId:4,jobId:1,field:fields[1],value:preview.value},ui)).filled,1);
  assert.equal(document.getElementById('s').value, 'yes');
  assert.deepEqual(sent[0], {frameId: 7,documentId:'original-document'});
  assert.equal(calls[0].url, 'http://localhost:8000/api/fill/jobs/1/ask');
  assert.deepEqual(JSON.parse(calls[0].options.body), {question: 'Why us?', options: []});
  assert.equal(document.querySelector('input').checked, false);
  const stateAction = (type, jobId=1) => background.handle({type,jobId},ui);
  await assert.rejects(stateAction('mark-applied',2), /changed/i);
  await stateAction('mark-applied'); assert.equal(state,'applied');
  session.appliedUndo.id=2; await assert.rejects(stateAction('undo-applied'), /Undo/); session.appliedUndo.id=1;
  state='seen'; await assert.rejects(stateAction('undo-applied'), /Undo/); state='applied';
  await stateAction('undo-applied'); assert.equal(state,'dismissed');
  state='applied'; assert.equal((await stateAction('mark-applied')).canUndo,false);
  session.active.source='upwork'; await assert.rejects(stateAction('mark-applied'), /changed/i);
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
  assert.equal(worker.apply([{ref:0,action:'set',value:'no',overwrite:true}]).filled,1);
  assert.equal(document.querySelectorAll('input')[1].checked,true);
});
