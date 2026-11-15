const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');

test('set rows have no actions; Ask preview edits are used by Fill field and Copy', async () => {
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
        'ask-preview': {value: 'Profile answer <b>as text</b>'}, 'fill-field': {filled:1}, save: {},
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
  assert.deepEqual(buttons().map(button => button.textContent), ['Fill field', 'Copy', 'Save to bank', 'Ask again']);
  const preview = askRow.querySelector('.field-answer'), edited = 'Edited <b>answer</b>\nSecond line';
  assert.equal(preview.matches(':enabled:not([readonly])'), true);
  assert.equal(preview.value, 'Profile answer <b>as text</b>');
  preview.value = edited;
  assert.equal(askRow.querySelector('b'), null);
  assert.match(element('status').textContent, /preview only.*Fill field/i);
  assert.equal(calls.filter(call => call.type === 'fill-field').length,0);
  buttons().find(button => button.textContent === 'Fill field').click(); await settle();
  assert.equal(calls.find(call => call.type === 'fill-field').value, edited);
  assert.equal(element('status').textContent, 'Field filled. Review the form.');
  buttons().find(button => button.textContent === 'Copy').click(); await settle();
  assert.equal(copied, edited);
  buttons().find(button => button.textContent === 'Save to bank').click(); await settle();
  const saved = calls.find(call => call.type === 'save');
  assert.equal(saved.jobId, job.id);
  assert.equal(saved.tabId, 4);
  assert.equal(saved.field.label, 'Why us?');
  assert.equal(element('status').textContent, 'Saved to bank. Next Fill replays this answer.');
  panel.window.close();
});

test('matched Jobs always offer CV download, with edited Job selection clearing the cached file', async () => {
  const job = {id: 1, source: 'hotfix'};
  const changes = [];
  let download = {name: 'JB_CV_Acme.pdf', base64: 'JVBERg=='};
  const panel = new JSDOM(fs.readFileSync(`${__dirname}/../sidepanel.html`, 'utf8'), {runScripts: 'outside-only'});
  const downloads = [], nativeClick = panel.window.HTMLAnchorElement.prototype.click;
  panel.window.HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download')) downloads.push({name:this.download,href:this.href}); else nativeClick.call(this);
  };
  panel.window.chrome = {
    runtime: {sendMessage: async message => {
      if (['mark-applied','undo-applied'].includes(message.type)) { changes.push(message); return {value:{job:{...job,state:message.type==='mark-applied'?'applied':'new'},canUndo:message.type==='mark-applied'}}; }
      return {value: {
      detect: job, select: {...job, id: 2}, jobs: [job, {...job, id: 2}], resume: {}, 'resume-download': download,
      fill: {job, fields: [], actions: [], filled: 0, resumeDownload: download},
    }[message.type]}; }},
    tabs: {query: async () => [{id: 4}], onActivated: {addListener() {}}, onUpdated: {addListener() {}}},
  };
  panel.window.matchMedia = () => ({matches: false, addEventListener() {}});
  panel.window.eval(fs.readFileSync(`${__dirname}/../sidepanel.js`, 'utf8'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const element = id => panel.window.document.getElementById(id);
  await settle();
  const link = element('resume-download');
  assert.equal(link.closest('#cv-card') !== null, true);
  assert.equal(link.hidden, false);
  link.click(); await settle();
  assert.equal(link.download, download.name);
  assert.deepEqual(downloads,[{name:download.name,href:`data:application/pdf;base64,${download.base64}`}]);
  assert.equal(changes.length, 0);
  element('fill').click(); await settle();
  assert.equal(link.hidden, false);
  assert.equal(link.textContent, 'Download Tailored CV');
  assert.equal(link.download, download.name);
  assert.equal(link.href, `data:application/pdf;base64,${download.base64}`);
  assert.equal(changes.length, 0, 'Fill never marks applied automatically');
  element('mark-applied').click(); await settle();
  assert.equal(element('undo-applied').hidden, false);
  element('undo-applied').click(); await settle();
  assert.deepEqual(changes.map(message => [message.type,message.jobId]), [['mark-applied',1],['undo-applied',1]]);
  assert.equal(element('undo-applied').hidden, true);
  download = undefined;
  element('fill').click(); await settle();
  assert.equal(link.hidden, false);
  assert.equal(link.getAttribute('href'), '#');
  assert.equal(link.hasAttribute('download'), false);
  download = {name: 'CV.pdf', base64: 'JVBERg=='};
  element('fill').click(); await settle();
  element('change').click();
  element('job-choices').querySelector('[data-job="2"]').click(); await settle();
  assert.equal(link.hidden, false);
  assert.equal(link.getAttribute('href'), '#');
  assert.equal(link.hasAttribute('download'), false);
  panel.window.close();
});
