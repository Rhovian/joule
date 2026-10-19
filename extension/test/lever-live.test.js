const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
function setup() {
  const document = new JSDOM(fs.readFileSync(`${__dirname}/fixtures/lever-live.html`, 'utf8')).window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const worker = createWorker(document);
  return {document, worker, fields: worker.describe()};
}
const action = (field, value) => [{ref: field.ref, action: 'set', value}];
test('captured Lever labels omit statuses/placeholders and radio questions retain separate option labels', async () => {
  const {document, worker, fields} = setup();
  assert.ok(fields.every(f => f.label && !/^(Type your response|Yes|Field)$/.test(f.label)));
  assert.equal(fields.find(f => f.name === 'resume').label, 'Resume/CV ✱');
  const location = fields.find(f => f.name === 'location');
  assert.equal(location.label, 'Current location ✱');
  assert.equal(location.role, 'combobox');
  assert.ok(location.required);
  assert.ok(!fields.some(f => f.name === 'pronouns' || /PronounsOption/.test(f.id)));
  const radios = fields.filter(f => f.type === 'radio');
  assert.equal(radios.length, 2);
  assert.match(radios[0].label, /^Will you now or in the future require Sponsorship/);
  assert.deepEqual(radios[0].options, [{value: 'Yes', label: 'Yes'}, {value: 'No', label: 'No'}]);
  assert.equal((await worker.apply(action(radios[0], 'No'), radios[0])).filled, 1);
  assert.deepEqual(worker.answer(radios[0]), {question: radios[0].label, answer: 'No'});
  assert.equal((await worker.apply(action(radios[0], 'Yes'))).filled, 0);
  const text = fields.find(f => /^How did you hear/.test(f.label));
  assert.equal((await worker.apply(action(text, 'Job board'), text)).filled, 1);
  assert.equal(worker.answer(text).answer, 'Job board');
  const resumeLabel = document.querySelector('.resume .filename');
  resumeLabel.textContent = 'file.pdf';
  assert.equal(worker.describe().find(f => f.name === 'resume').label, 'Resume/CV ✱');
});
test('Lever consent questions get real context and remain untouched even if an action is supplied', async () => {
  const {document, worker, fields} = setup();
  for (const f of fields.filter(f => /consent/.test(f.label))) {
    assert.ok(f.required);
    assert.equal((await worker.apply(action(f, 'Yes'), f)).filled, 0);
  }
  assert.ok([...document.querySelectorAll('input[type=checkbox]')].every(n => !n.checked));
});
test('Lever searches on keydown, commits only the exact result on mousedown, and survives blur', async () => {
  const {document, worker, fields} = setup(), window = document.defaultView;
  const input = document.querySelector('#location-input'), hidden = document.querySelector('#selected-location');
  const field = fields.find(f => f.name === 'location'), value = 'Denver, CO, USA';
  let commits = 0, submits = 0;
  document.querySelector('form').addEventListener('submit', () => submits++);
  // Models the captured retrieveLocations.js input/keydown/mousedown/blur contract.
  // Input alone opens the menu; a non-navigation key starts its debounced search.
  input.addEventListener('input', () => input.dataset.open = 'true');
  input.addEventListener('keydown', event => {
    if (event.key !== 'End') return;
    window.setTimeout(() => {
      const list = document.querySelector('.dropdown-results');
      for (const name of ['Denver, PA, USA', value]) {
        const option = document.createElement('div'); option.className = 'dropdown-location'; option.textContent = name;
        option.addEventListener('mousedown', event => {
          assert.ok(event.defaultPrevented); commits++;
          input.value = name; hidden.value = JSON.stringify({name, id: 'captured-test-id'});
          input.dataset.open = 'false'; list.replaceChildren();
        }); list.append(option);
      }
    }, 5);
  });
  input.addEventListener('blur', () => { if (input.dataset.open === 'true') { input.value = ''; hidden.value = ''; } });
  assert.equal((await worker.apply(action(field, value), field)).filled, 1);
  assert.equal(input.value, value);
  assert.ok(hidden.value);
  assert.equal(worker.answer(field).answer, value);
  assert.equal((await worker.apply(action(field, 'Denver, PA, USA'))).filled, 0);
  assert.equal(commits, 1); assert.equal(submits, 0);
});
test('Lever leaves operator typing focused when a search response is pending', async () => {
  const {document, worker, fields} = setup(), input = document.querySelector('#location-input');
  const field = fields.find(f => f.name === 'location');
  input.addEventListener('input', () => { input.value = 'Operator query'; });
  input.addEventListener('blur', () => { input.value = ''; }); // Lever clears uncommitted queries on blur.
  assert.equal((await worker.apply(action(field, 'Denver, CO, USA'), field)).filled, 0);
  assert.equal(input.value, 'Operator query');
  assert.equal(document.activeElement, input);
});
test('sensitive survey descriptions do not send oversized choices to Match', async () => {
  const {document, worker} = setup();
  // Shield AI live form, 2026-10-19: race explanations make option labels exceed 200 chars.
  document.querySelector('form').insertAdjacentHTML('beforeend', `<li class="application-question">
    <div class="application-label">Race</div><fieldset><label><input type="radio" name="eeo[race]" value="Asian">
    Asian<span>${'A public demographic description. '.repeat(10)}</span></label></fieldset></li>`);
  const field = worker.describe().find(field => field.name === 'eeo[race]');
  assert.equal(field.label, 'Race');
  assert.deepEqual(field.options, []);
  assert.equal((await worker.apply(action(field, 'Asian'))).filled, 0);
});
