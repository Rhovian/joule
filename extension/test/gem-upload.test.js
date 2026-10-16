const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
const markup = fs.readFileSync(`${__dirname}/fixtures/gem-upload.html`, 'utf8');
function setup(url = 'https://jobs.gem.com/example/job') {
  const document = new JSDOM(markup, {url}).window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  return {document, worker: createWorker(document)};
}
test('captured Gem hidden inputs use visible upload labels and accept a resume once', () => {
  const {document, worker} = setup(), window = document.defaultView;
  const fields = worker.describe();
  assert.deepEqual(fields.map(f => f.label), ['Resume *', 'Cover letter']);
  const input = document.querySelector('input'), events = [];
  window.DataTransfer = class {files = []; items = {add: file => this.files.push(file)};};
  Object.defineProperty(input, 'files', {value: [], writable: true});
  input.addEventListener('change', () => events.push(input.files[0].name));
  const file = {base64: 'JVBERi0=', name: 'test.pdf'};
  assert.deepEqual(worker.upload(fields[0].ref, file), {filled: 1});
  assert.deepEqual(events, ['test.pdf']);
  assert.equal(worker.upload(fields[0].ref, file).filled, 0);
  assert.equal(document.querySelectorAll('input')[1].files.length, 0);
});
test('hidden dropzones, disabled inputs and other hosts remain excluded', () => {
  for (const mode of ['host', 'hidden', 'disabled']) {
    const {document, worker} = setup(mode === 'host' ? 'https://example.com' : undefined);
    if (mode === 'hidden') document.querySelectorAll('[role=presentation]').forEach(n => n.hidden = true);
    if (mode === 'disabled') document.querySelectorAll('input').forEach(n => n.disabled = true);
    assert.deepEqual(worker.describe(), []);
  }
});
