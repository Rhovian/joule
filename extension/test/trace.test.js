const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
const {createBackground} = require('../background.js');
function setup(html) {
  const document = new JSDOM(`<form>${html}<button>Submit</button></form>`).window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const worker = createWorker(document);
  return {document, worker};
}
test('trace observes blur state, lost values, native validity and required errors without submitting or answers', async () => {
  const {document, worker} = setup(`<label for="email">Email</label><input id="email" type="email" required>
    <input id="lost" required><input id="empty" required><input id="kept" value="operator-secret">
    <input id="bad" required aria-describedby="error"><span id="error" hidden></span>`);
  let submissions = 0, invalid = 0, committed = false;
  document.addEventListener('submit', () => submissions++);
  document.addEventListener('invalid', () => invalid++, true);
  document.querySelector('#email').addEventListener('blur', () => { committed = true; });
  document.querySelector('#lost').addEventListener('input', event => setTimeout(() => { event.target.value = ''; }, 20));
  document.querySelector('#bad').addEventListener('blur', event => {
    event.target.setAttribute('aria-invalid', 'true');
    const error = document.querySelector('#error'); error.hidden = false; error.textContent = 'Required: private@example.com';
  });
  const result = await worker.traceApply(worker.describe().map(field => ({ref: field.ref,
    action: field.id === 'empty' ? 'ask' : 'set', value: 'private@example.com'})));
  const byId = id => result.trace.find(row => row.selector === `[id="${id}"]`);
  assert.equal(result.filled, 3);
  assert.equal(committed, true);
  assert.deepEqual(byId('email').signals, []);
  assert.ok(byId('lost').signals.includes('value-lost'));
  assert.ok(byId('empty').signals.includes('native-value-missing'));
  assert.equal(byId('kept').outcome, 'preserved');
  assert.deepEqual(byId('bad').signals, ['aria-invalid', 'required-error']);
  assert.equal(submissions, 0); assert.equal(invalid, 0);
  assert.doesNotMatch(JSON.stringify(result), /private@example|operator-secret/);
});
test('trace follows a replaced field by id and reports detached controls', async () => {
  const {document, worker} = setup('<input id="replaced" required><input required>');
  document.querySelector('#replaced').addEventListener('input', event => {
    const replacement = event.target.cloneNode(); replacement.value = ''; event.target.replaceWith(replacement);
  });
  document.querySelector('input:not([id])').addEventListener('input', event => event.target.remove());
  const actions = worker.describe().map(field => ({ref: field.ref, action: 'set', value: 'secret'}));
  document.querySelector('form').insertAdjacentHTML('afterbegin', '<input id=unrelated>');
  const result = await worker.traceApply(actions);
  assert.equal(document.querySelector('#unrelated').value, '');
  assert.ok(result.trace[0].signals.includes('value-lost'));
  assert.deepEqual(result.trace[1].signals, ['field-detached']);
});
test('trace isolates field errors and continues filling other fields', async () => {
  const {document, worker} = setup('<input id="throws"><input id="works">');
  document.querySelector('#throws').focus = () => { throw Error('secret answer in page exception'); };
  const result = await worker.traceApply(worker.describe().map(field => ({ref: field.ref, action: 'set', value: 'secret'})));
  assert.equal(result.trace[0].error, 'apply-failed');
  assert.equal(result.trace[1].outcome, 'written');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});
test('background saves frame traces, includes frame errors and exposes transport failure', async () => {
  const store = data => ({get: async key => ({[key]: data[key]}), set: async values => Object.assign(data, values)});
  const chrome = {runtime: {id: 'ext', getURL: p => `chrome-extension://ext/${p}`},
    storage: {local: store({origin: 'http://localhost:8000'}), session: store({active: {id: 1}, 'frames:2': {0: 'url', 4: 'url'}})},
    tabs: {get: async () => ({id: 2, url: 'https://public.example/apply?token=secret'})}};
  let background, saved, fail = false, traceStatus = 200;
  chrome.tabs.sendMessage = async (tabId, message, {frameId}) => {
    if (message.type === 'describe') return background.handle({type: 'frame', request: message.request, fields: [{ref: 0, label: 'Email'}]},
      {id: 'ext', tab: {id: 2}, frameId, url: 'https://public.example/apply'});
    if (frameId === 4) throw Error('frame gone');
    return {filled: 1, trace: [{ref: 0, outcome: 'written'}]};
  };
  background = createBackground(chrome, async (url, options) => {
    if (url.endsWith('/match')) return {ok: true, json: async () => ({actions: [{ref: [0, 0], action: 'set', value: 'SECRET'}]})};
    saved = JSON.parse(options.body);
    if (fail) throw Error('offline');
    return {ok: traceStatus === 200, status: traceStatus, json: async () => ({file: '/local/trace.json'})};
  });
  const ui = {id: 'ext', url: 'chrome-extension://ext/sidepanel.html'};
  const result = await background.handle({type: 'fill', tabId: 2}, {...ui, tab: {id: 7, url: ui.url}});
  assert.equal(result.traceFile, '/local/trace.json');
  assert.deepEqual(saved.fields[0].ref, [0, 0]);
  assert.deepEqual(saved.errors, ['frame-4-unavailable']);
  assert.equal(saved.fields[1].error, 'frame-unavailable');
  assert.equal(saved.fields[1].after, null);
  assert.doesNotMatch(JSON.stringify(saved), /SECRET/);
  traceStatus = 422;
  const rejectedTrace = await background.handle({type: 'fill', tabId: 2}, ui);
  assert.equal(rejectedTrace.filled, 1);
  assert.match(rejectedTrace.traceError, /Diagnostic trace could not be saved \(joule HTTP 422\)/);
  assert.doesNotMatch(rejectedTrace.traceError, /Fill matching failed|Update and restart/);
  fail = true;
  assert.match((await background.handle({type: 'fill', tabId: 2}, ui)).traceError, /could not be saved/);
});

test('trace checks native required surrogates even when a widget displays a selection', async () => {
  const {document, worker} = setup(`<div class="select-container"><div><input id="city" role="combobox" aria-required="true"></div>
    <div class="singleValue">Denver</div><input required aria-hidden="true" style="opacity:0"></div>`);
  const result = await worker.traceApply([{ref: 0, action: 'leave'}]);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].after, true);
  assert.ok(result.trace[0].signals.includes('native-value-missing'));
  assert.equal(document.querySelector('input[required]').value, '');
});
test('checkbox presence reads checked state rather than the default on value', async () => {
  const {worker} = setup('<input id="unchecked" type="checkbox" required><input id="checked" type="checkbox" checked>');
  worker.describe();
  const {trace} = await worker.traceApply([]);
  assert.equal(trace[0].before, false);
  assert.equal(trace[0].after, false);
  assert.ok(trace[0].signals.includes('required-empty'));
  assert.equal(trace[1].before, true);
  assert.equal(trace[1].after, true);
});
test('matching 422 and missing trace endpoint 405 are reported as separate failures', async () => {
  const store = data => ({get: async key => ({[key]: data[key]}), set: async values => Object.assign(data, values)});
  const chrome = {runtime: {id: 'ext', getURL: p => `chrome-extension://ext/${p}`},
    storage: {local: store({origin: 'http://localhost:8000'}), session: store({active: {id: 1}, 'frames:2': {0: 'url'}})},
    tabs: {get: async () => ({id: 2, url: 'https://public.example/apply'})}};
  let background;
  chrome.tabs.sendMessage = async (tabId, message) => background.handle({type: 'frame', request: message.request,
    fields: [{ref: 0, label: 'Email'}]}, {id: 'ext', tab: {id: 2}, frameId: 0, url: 'https://public.example/apply'});
  background = createBackground(chrome, async url => ({ok: false, status: url.endsWith('/match') ? 422 : 405}));
  await assert.rejects(background.handle({type: 'fill', tabId: 2}, {id: 'ext', url: 'chrome-extension://ext/sidepanel.html'}),
    /Fill matching failed: joule HTTP 422.*Diagnostic trace could not be saved \(joule HTTP 405\).*Update and restart/);
});
