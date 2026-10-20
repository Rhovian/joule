const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
function setup(status = 200, noise = false) {
  const document = new JSDOM(`<form>${['name', 'linkedin', 'email'].map(name =>
    `<div class="ashby-application-form-field-entry"><label for="${name}">${name}</label><input id="${name}" name="${name}" class="ashby-application-form-input-text"></div>`).join('')}</form>`,
    {url: 'https://jobs.ashbyhq.com/radai/application'}).window.document;
  const window = document.defaultView, observers = new Set(), saved = {};
  let active = 0, peak = 0, requests = 0;
  window.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  window.PerformanceObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  };
  for (const input of document.querySelectorAll('input')) {
    function save() {
      const snapshot = {...saved, [input.name]: input.value};
      active++; requests++; peak = Math.max(peak, active);
      if (noise) for (const observer of [...observers]) observer.callback({getEntries: () => [
        {name: 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSetFormValue', responseStatus: 200, startTime: 0},
        {name: 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiGetForm', responseStatus: 200, startTime: window.performance.now()},
        {name: 'https://other.example/api/non-user-graphql?op=ApiSetFormValue', responseStatus: 200, startTime: window.performance.now()},
      ]});
      window.setTimeout(() => {
        for (const key of Object.keys(saved)) delete saved[key];
        if (status === 200) Object.assign(saved, snapshot);
        active--;
        for (const observer of [...observers]) observer.callback({getEntries: () => [{
          name: 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSetFormValue', responseStatus: status, startTime: window.performance.now(),
        }]});
      }, 30);
    }
    // Captured Ashby qRe/NN: local input state, debounced remote save, and save-on-blur.
    input.addEventListener('input', () => window.setTimeout(save, 20));
    input.addEventListener('blur', () => { if (saved[input.name] !== input.value) save(); });
  }
  const worker = createWorker(document), fields = worker.describe();
  return {document, worker, fields, saved, metrics: () => ({peak, requests})};
}
test('Ashby writes wait for remote save before blur or the next field, retaining LinkedIn remotely', async () => {
  const {worker, fields, saved, metrics} = setup();
  const actions = fields.map(field => ({ref: field.ref, action: 'set', value: `${field.name}-saved`}));
  const {filled} = await worker.traceApply(actions);
  assert.equal(filled, 3);
  assert.deepEqual(saved, {name: 'name-saved', linkedin: 'linkedin-saved', email: 'email-saved'});
  assert.deepEqual(metrics(), {peak: 1, requests: 3});
});
test('a failed Ashby save stops subsequent writes instead of overlapping an unconfirmed save', async () => {
  const {worker, fields, document} = setup(503);
  const {trace} = await worker.traceApply(fields.map(field => ({ref: field.ref, action: 'set', value: 'saved'})));
  assert.equal(trace[0].error, 'apply-failed');
  assert.equal(document.querySelector('#linkedin').value, '');
  assert.equal(document.querySelector('#email').value, '');
});

test('unrelated and already-running resources cannot release an Ashby save barrier', async () => {
  const {worker, fields, saved, metrics} = setup(200, true);
  await worker.traceApply(fields.map(field => ({ref: field.ref, action: 'set', value: `${field.name}-saved`})));
  assert.equal(saved.linkedin, 'linkedin-saved');
  assert.deepEqual(metrics(), {peak: 1, requests: 3});
});
test('operator edits made while a preceding Ashby save is pending remain untouched', async () => {
  const {worker, fields, document} = setup();
  const writing = worker.traceApply(fields.map(field => ({ref: field.ref, action: 'set', value: 'saved'})));
  document.defaultView.setTimeout(() => { document.querySelector('#linkedin').value = 'operator'; }, 10);
  await writing;
  assert.equal(document.querySelector('#linkedin').value, 'operator');
});
