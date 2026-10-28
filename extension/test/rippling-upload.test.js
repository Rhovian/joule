const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
const markup = fs.readFileSync(`${__dirname}/fixtures/rippling-upload.html`, 'utf8');
function setup(url = 'https://ats.rippling.com/d-wave-quantum/jobs/example/apply') {
  const document = new JSDOM(markup, {url}).window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  return {document, worker: createWorker(document)};
}
test('captured Rippling upload exposes resume identity and accepts a PDF once', () => {
  const {document, worker} = setup(), window = document.defaultView;
  const fields = worker.describe();
  assert.deepEqual(fields.map(f => [f.name, f.label]), [['resume', 'Résumé'], ['cover_letter', 'Cover letter']]);
  const input = document.querySelector('input'), events = [];
  // jsdom 26.1.0 lacks DataTransfer: https://github.com/jsdom/jsdom/tree/26.1.0/lib/jsdom/living
  window.DataTransfer = class {files = []; items = {add: file => this.files.push(file)};};
  Object.defineProperty(input, 'files', {value: [], writable: true});
  for (const type of ['input', 'change']) input.addEventListener(type, () => events.push(type));
  const file = {base64: 'JVBERi0=', name: 'Tailored_CV.pdf'};
  assert.deepEqual(worker.upload(fields[0].ref, file), {filled: 1});
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(input.files[0].name, file.name);
  assert.equal(worker.upload(fields[0].ref, file).filled, 0);
  assert.equal(document.querySelectorAll('input')[1].files.length, 0);
});
test('Rippling exception preserves hidden, disabled, unrelated and changed-field guards', () => {
  for (const mode of ['host', 'hidden', 'aria-hidden', 'disabled', 'ancestor', 'unrelated', 'changed']) {
    const {document, worker} = setup(mode === 'host' ? 'https://example.com' : undefined);
    const fields = worker.describe();
    for (const input of document.querySelectorAll('input')) {
      if (mode === 'hidden') input.hidden = true;
      if (mode === 'aria-hidden') input.setAttribute('aria-hidden', 'true');
      if (mode === 'disabled') input.disabled = true;
      if (mode === 'ancestor' || mode === 'changed') input.closest('[data-testid=field]').hidden = true;
      if (mode === 'unrelated') input.parentElement.removeAttribute('data-testid');
    }
    if (mode === 'changed') {
      assert.equal(fields.length, 2);
      assert.equal(worker.upload(fields[0].ref, {}).filled, 0);
    }
    assert.deepEqual(worker.describe(), [], mode);
  }
});
