const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');
function setup() {
  const document = new JSDOM(fs.readFileSync(`${__dirname}/fixtures/ashby.html`, 'utf8')).window.document;
  document.defaultView.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const worker = createWorker(document), fields = worker.describe();
  return {document, worker, fields};
}
test('captured Ashby entries expose real labels, requiredness, Yes/No choices and stable identity', () => {
  const {fields} = setup();
  assert.equal(fields.length, 6);
  const groups = fields.filter(field => field.type === 'button-group');
  assert.equal(groups.length, 3);
  assert.ok(groups.every(field => field.required && field.name && !/^(Yes|No)$/.test(field.label)));
  assert.deepEqual(groups[0].options, [{value: 'yes', label: 'Yes'}, {value: 'no', label: 'No'}]);
  const location = fields.find(field => field.role === 'combobox');
  assert.equal(location.name, '_systemfield_location');
  assert.equal(location.label, 'Which city and country do you intend to work from?');
  assert.equal(location.required, true);
});
test('required Yes/No buttons accept an exact choice, preserve either selection and never submit', async () => {
  const {document, worker, fields} = setup();
  const field = fields.find(field => field.type === 'button-group');
  const container = document.querySelector('.ashby-application-form-input-yesno');
  let submissions = 0;
  document.querySelector('form').addEventListener('submit', () => submissions++);
  for (const button of container.querySelectorAll('button')) button.addEventListener('click', event => {
    assert.equal(event.defaultPrevented, true);
    button.setAttribute('aria-pressed', 'true');
  });
  assert.equal((await worker.apply([{ref: field.ref, action: 'set', value: 'no'}])).filled, 1);
  assert.equal(worker.answer(field).answer, 'No');
  assert.equal((await worker.apply([{ref: field.ref, action: 'set', value: 'yes'}])).filled, 0);
  assert.equal(submissions, 0);
});
test('optional, sensitive and disabled Yes/No controls remain untouched', async () => {
  for (const mode of ['optional', 'sensitive', 'disabled']) {
    const {document, worker} = setup();
    const container = document.querySelector('.ashby-application-form-input-yesno');
    const label = container.parentElement.querySelector('label');
    if (mode === 'optional') label.className = '';
    if (mode === 'sensitive') label.textContent = 'Gender';
    if (mode === 'disabled') for (const button of container.querySelectorAll('button')) button.disabled = true;
    const field = worker.describe().find(field => field.type === 'button-group');
    let clicks = 0; container.addEventListener('click', () => clicks++);
    assert.equal((await worker.apply([{ref: field.ref, action: 'set', value: 'yes'}])).filled, 0);
    assert.equal(clicks, 0);
  }
});
test('captured location portal selects the exact Denver result and retains the committed input value', async () => {
  const {document, worker, fields} = setup();
  const field = fields.find(field => field.role === 'combobox'), input = document.querySelector('[role=combobox]');
  const value = 'Denver, Colorado, United States';
  input.addEventListener('input', () => {
    if (!input.value) return;
    document.body.insertAdjacentHTML('beforeend', fs.readFileSync(`${__dirname}/fixtures/ashby-location-options.html`, 'utf8'));
    const list = document.querySelector('[role=listbox]');
    input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'true');
    for (const option of list.querySelectorAll('[role=option]')) option.addEventListener('click', event => {
      assert.equal(event.defaultPrevented, true);
      input.value = option.textContent; input.setAttribute('aria-expanded', 'false'); list.remove();
    });
  });
  assert.equal((await worker.apply([{ref: field.ref, action: 'set', value}])).filled, 1);
  assert.equal(input.value, value);
  assert.equal(worker.answer(field).answer, value);
  assert.equal((await worker.apply([{ref: field.ref, action: 'set', value: 'other city'}])).filled, 0);
});
test('basic controlled inputs commit updated state on blur without an operator click', async () => {
  const {document, worker, fields} = setup();
  const committed = {};
  for (const input of document.querySelectorAll('.ashby-application-form-input-text')) {
    let state = '';
    input.addEventListener('input', () => { const value = input.value; queueMicrotask(() => { state = value; }); });
    input.addEventListener('blur', () => { committed[input.name] = state; });
  }
  const identity = fields.filter(field => ['_systemfield_name', '_systemfield_email'].includes(field.name));
  const actions = identity.map(field => ({ref: field.ref, action: 'set', value: field.type === 'email' ? 'ada@example.com' : 'Ada Lovelace'}));
  assert.equal((await worker.apply(actions)).filled, 2);
  assert.deepEqual(committed, {_systemfield_name: 'Ada Lovelace', _systemfield_email: 'ada@example.com'});
  assert.equal((await worker.apply(actions)).filled, 0);
});
test('Wrapbook survey radios expose the question separately from option labels and stay sensitive', async () => {
  const {document, worker} = setup();
  // Wrapbook live DOM, 2026-10-19: title label is a direct child of the survey fieldset.
  document.querySelector('form').insertAdjacentHTML('beforeend', `<fieldset>
    <label class="ashby-application-form-question-title">What is your gender?</label>
    <div><input id="gender-man" type="radio" name="gender"><label for="gender-man">Man</label></div>
    <div><input id="gender-other" type="radio" name="gender"><label for="gender-other">Other</label></div>
  </fieldset>`);
  const field = worker.describe().find(field => field.name === 'gender');
  assert.equal(field.label, 'What is your gender?');
  assert.deepEqual(field.options.map(option => option.label), ['Man', 'Other']);
  assert.equal((await worker.apply([{ref: field.ref, action: 'set', value: 'on'}])).filled, 0);
  assert.equal(document.querySelector('#gender-man').checked, false);
});
