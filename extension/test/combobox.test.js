const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {createWorker} = require('../content.js');

// Simulates the public react-select DOM contract; this is not a real React/ATS trial.
function widget({required = true, selected = '', async = false, choices = ['Yes', 'No']} = {}) {
  const document = new JSDOM(`<label for="q">${async ? 'Location (City)' : 'Authorized?'}${required ? '*' : ''}</label>
    <div><div id="values"><div><input id="q" role="combobox" aria-expanded="false"></div></div></div>`).window.document;
  const window = document.defaultView, input = document.getElementById('q');
  window.HTMLElement.prototype.getClientRects = () => [{width: 100, height: 20}];
  const choose = text => {
    const value = document.createElement('span');
    value.className = 'css-test-singleValue'; value.textContent = text;
    document.getElementById('values').append(value);
    input.value = ''; close();
  };
  function close() {
    document.getElementById('menu')?.remove();
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-controls');
  }
  function open() {
    close(); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'menu');
    const menu = document.createElement('div'); menu.id = 'menu'; menu.setAttribute('role', 'listbox');
    for (const text of choices) {
      const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = text;
      option.addEventListener('click', event => {
        assert.equal(event.defaultPrevented, true, 'widget selection must suppress browser default actions');
        choose(text);
      }); menu.append(option);
    }
    document.body.append(menu);
  }
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && !async) open();
    if (event.key === 'Escape') close();
  });
  input.addEventListener('input', () => {
    if (async && input.value) window.setTimeout(open, 5);
  });
  if (selected) choose(selected);
  return {document, input, worker: createWorker(document), choose};
}
const set = value => [{ref: 0, action: 'set', value}];
test('required options are discovered, replayed, saved, and existing selections preserved', async () => {
  const {worker, input} = widget();
  await worker.prepare();
  const field = worker.describe()[0];
  assert.equal(field.required, true);
  assert.deepEqual(field.options, [{value: 'Yes', label: 'Yes'}, {value: 'No', label: 'No'}]);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal((await worker.apply(set('Yes'), field)).filled, 1);
  assert.deepEqual(worker.answer(field), {question: 'Authorized?*', answer: 'Yes'});
  assert.equal((await worker.apply(set('No'))).filled, 0);
});
test('city query waits for async options and selects the exact label', async () => {
  const {worker, input} = widget({async: true, choices: ['Boise, Idaho, United States']});
  worker.describe();
  assert.equal((await worker.apply(set('Boise, Idaho, United States'))).filled, 1);
  assert.equal(input.value, '');
});
test('optional fields are untouched even with a supplied action', async () => {
  const {worker, input} = widget({required: false});
  let events = 0; input.addEventListener('keydown', () => events++);
  await worker.prepare(); worker.describe();
  assert.equal((await worker.apply(set('Yes'))).filled, 0);
  assert.equal(events, 0);
});
test('disabled, nonempty and preselected controls are preserved', async () => {
  for (const mode of ['disabled', 'typed', 'selected']) {
    const {worker, input, choose} = widget();
    worker.describe();
    if (mode === 'disabled') input.disabled = true;
    if (mode === 'typed') input.value = 'operator typing';
    if (mode === 'selected') choose('No');
    assert.equal((await worker.apply(set('Yes'))).filled, 0);
  }
});
test('unmatched, ambiguous and disabled options remain unselected and query is cleared', async () => {
  for (const mode of ['unmatched', 'ambiguous', 'disabled']) {
    const {worker, input, document} = widget({choices: mode === 'ambiguous' ? ['Yes', 'Yes'] : ['No']});
    if (mode === 'disabled') input.addEventListener('keydown', () => {
      document.querySelector('[role=option]')?.setAttribute('aria-disabled', 'true');
    });
    worker.describe();
    assert.equal((await worker.apply(set('Yes'))).filled, 0);
    assert.equal(input.value, '');
    assert.equal(input.getAttribute('aria-expanded'), 'false');
  }
});
test('stale descriptors and operator edits during option loading do not receive answers', async () => {
  const {worker, input} = widget({async: true, choices: ['Yes']});
  const field = worker.describe()[0];
  input.setAttribute('aria-label', 'Changed'); // Explicit label wins, so change that label too.
  input.labels[0].textContent = 'Changed*';
  assert.equal((await worker.apply(set('Yes'), field)).filled, 0);
  input.addEventListener('input', () => { if (input.value === 'Yes') input.value = 'operator'; });
  assert.equal((await worker.apply(set('Yes'))).filled, 0);
  assert.equal(input.value, 'operator');
});
test('large menus use free-text Ask rather than silently losing later options', async () => {
  const {worker} = widget({choices: Array.from({length: 101}, (_, i) => `Country ${i}`)});
  await worker.prepare();
  assert.deepEqual(worker.describe()[0].options, []);
  assert.equal((await worker.apply(set('Country 100'))).filled, 1);
});
test('required surveys are not opened during discovery; aria-required is recognized', async () => {
  const {worker, input} = widget({required: false});
  input.setAttribute('aria-required', 'true');
  input.labels[0].textContent = 'Are you Hispanic/Latino?';
  let events = 0; input.addEventListener('keydown', () => events++);
  await worker.prepare();
  assert.equal(worker.describe()[0].required, true);
  assert.equal(events, 0);
});
