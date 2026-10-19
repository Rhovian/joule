const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');

for (const filled of [1, 0]) test(`set rows have no actions; Ask filled=${filled} preserves the save flow`, async () => {
  const job = {id: 1, title: 'Engineer', company: 'Acme', source: 'hotfix'}, calls = [];
  const fields = ['First Name', 'Country', 'Why us?', 'Gender', 'Resume'].map((label, i) => ({ref: [0, i], label, required: true}));
  const actions = ['set', 'set', 'ask', 'leave', 'upload'].map((action, i) => ({ref: fields[i].ref, action}));
  const panel = new JSDOM(fs.readFileSync(`${__dirname}/../sidepanel.html`, 'utf8'), {runScripts: 'outside-only'});
  panel.window.chrome = {
    runtime: {sendMessage: async message => {
      calls.push(message);
      const value = {
        detect: job, jobs: [job], resume: {},
        fill: {job, fields, actions, filled: 2},
        ask: {value: 'Profile answer', filled}, save: {},
      }[message.type];
      return {value};
    }},
    tabs: {query: async () => [{id: 4}], onActivated: {addListener() {}}, onUpdated: {addListener() {}}},
  };
  panel.window.eval(fs.readFileSync(`${__dirname}/../sidepanel.js`, 'utf8'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const element = id => panel.window.document.getElementById(id);
  await settle();
  element('fill').click(); await settle();
  const rows = [...element('remaining').children];
  assert.equal(rows.length, 5, 'rows remain visible for review');
  for (const index of [0, 1, 3, 4]) assert.equal(rows[index].querySelectorAll('button').length, 0);
  const askRow = rows[2], buttons = () => [...askRow.querySelectorAll('button')];
  assert.deepEqual(buttons().map(button => button.textContent), ['Ask', 'Save to bank']);
  buttons()[0].click(); await settle();
  assert.deepEqual(buttons().map(button => button.textContent), filled ? ['Save to bank'] : ['Ask', 'Save to bank']);
  buttons().find(button => button.textContent === 'Save to bank').click(); await settle();
  const saved = calls.find(call => call.type === 'save');
  assert.equal(saved.jobId, job.id);
  assert.equal(saved.tabId, 4);
  assert.equal(saved.field.label, 'Why us?');
  assert.equal(element('status').textContent, 'Saved to bank. Next Fill replays this answer.');
  panel.window.close();
});
