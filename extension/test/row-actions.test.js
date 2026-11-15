const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');

for (const filled of [1, 0]) test(`set rows have no actions; Ask filled=${filled} preserves the save flow`, async () => {
  const job = {id: 1, title: 'Engineer', company: 'Acme', source: 'hotfix'}, calls = [];
  const fields = ['First Name', 'Country', 'Why us?', 'Gender', 'Resume'].map((label, i) => ({ref: [0, i], label, required: i !== 3}));
  const actions = ['set', 'set', 'ask', 'leave', 'upload'].map((action, i) => ({ref: fields[i].ref, action}));
  const panel = new JSDOM(fs.readFileSync(`${__dirname}/../sidepanel.html`, 'utf8'), {runScripts: 'outside-only'});
  panel.window.chrome = {
    runtime: {sendMessage: async message => {
      calls.push(message);
      const value = {
        detect: job, jobs: [job], resume: {},
        fill: {job, fields, actions, filled: 2},
        ask: {value: 'Profile answer <b>as text</b>', filled}, save: {},
      }[message.type];
      return {value};
    }},
    tabs: {query: async () => [{id: 4}], onActivated: {addListener() {}}, onUpdated: {addListener() {}}},
  };
  let copied; panel.window.navigator.clipboard = {writeText: async value => { copied = value; }};
  panel.window.matchMedia = () => ({matches: false, addEventListener() {}});
  panel.window.eval(fs.readFileSync(`${__dirname}/../sidepanel.js`, 'utf8'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const element = id => panel.window.document.getElementById(id);
  await settle();
  element('fill').click(); await settle();
  assert.equal(element('filled').open, false);
  assert.equal(element('optional').open, false);
  assert.deepEqual(['filled', 'need', 'optional'].map(key => element(`${key}-count`).textContent), ['2', '2', '1']);
  for (const row of element('filled-rows').children) assert.equal(row.querySelectorAll('button').length, 0);
  const askRow = [...element('remaining').querySelectorAll('.field-row')].find(row => row.textContent.includes('Why us?'));
  const buttons = () => [...askRow.querySelectorAll('button')].filter(button => !button.hidden);
  assert.deepEqual(buttons().map(button => button.textContent), ['Ask', 'Save to bank']);
  const settings = element('settings'); settings.disabled = true;
  buttons()[0].click(); await settle();
  assert.equal(settings.disabled, true, 'actions preserve unrelated disabled controls');
  assert.deepEqual(buttons().map(button => button.textContent), ['Ask again', 'Copy', 'Save to bank']);
  assert.equal(askRow.querySelector('.field-answer').textContent, 'Profile answer <b>as text</b>');
  assert.equal(askRow.querySelector('b'), null);
  buttons().find(button => button.textContent === 'Copy').click(); await settle();
  assert.equal(copied, 'Profile answer <b>as text</b>');
  buttons().find(button => button.textContent === 'Save to bank').click(); await settle();
  const saved = calls.find(call => call.type === 'save');
  assert.equal(saved.jobId, job.id);
  assert.equal(saved.tabId, 4);
  assert.equal(saved.field.label, 'Why us?');
  assert.equal(element('status').textContent, 'Saved to bank. Next Fill replays this answer.');
  panel.window.close();
});

test('Fill offers the PDF download and clears it on the next Fill or Job change', async () => {
  const job = {id: 1, source: 'hotfix'};
  let download = {name: 'JB_CV_Acme.pdf', base64: 'JVBERg=='};
  const panel = new JSDOM(fs.readFileSync(`${__dirname}/../sidepanel.html`, 'utf8'), {runScripts: 'outside-only'});
  panel.window.chrome = {
    runtime: {sendMessage: async message => ({value: {
      detect: job, select: {...job, id: 2}, jobs: [job, {...job, id: 2}], resume: {},
      fill: {job, fields: [], actions: [], filled: 0, resumeDownload: download},
    }[message.type]})},
    tabs: {query: async () => [{id: 4}], onActivated: {addListener() {}}, onUpdated: {addListener() {}}},
  };
  panel.window.matchMedia = () => ({matches: false, addEventListener() {}});
  panel.window.eval(fs.readFileSync(`${__dirname}/../sidepanel.js`, 'utf8'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const element = id => panel.window.document.getElementById(id);
  await settle(); element('fill').click(); await settle();
  const link = element('resume-download');
  assert.equal(link.hidden, false);
  assert.equal(link.textContent, 'Download Tailored CV');
  assert.equal(link.download, download.name);
  assert.equal(link.href, `data:application/pdf;base64,${download.base64}`);
  download = undefined;
  element('fill').click(); await settle();
  assert.equal(link.hidden, true);
  assert.equal(link.hasAttribute('href'), false);
  download = {name: 'CV.pdf', base64: 'JVBERg=='};
  element('fill').click(); await settle();
  element('change').click();
  element('job-choices').querySelector('[data-job="2"]').click(); await settle();
  assert.equal(link.hidden, true);
  assert.equal(link.hasAttribute('href'), false);
  panel.window.close();
});
