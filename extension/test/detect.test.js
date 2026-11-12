const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {createBackground} = require('../background.js');
const manifest = JSON.parse(fs.readFileSync(`${__dirname}/../manifest.json`, 'utf8'));

test('panel detects on open, tab switch and navigation; unmatched pages allow manual selection', async () => {
  const job = {id: 1, title: 'Engineer', company: 'Acme', source: 'hotfix'};
  const values = {origin: 'http://localhost:8000'}, calls = [], listeners = {};
  const storage = {get: async key => ({[key]: values[key]}), set: async data => Object.assign(values, data)};
  let tab = {id: 4, active: true, url: 'https://jobs.lever.co/acme/1/apply?utm_source=feed'};
  let listed = true, resolveFails = false, theme = 'dark', themeFails = false;
  const ui = {id: 'extension', url: 'chrome-extension://extension/sidepanel.html'};
  const chrome = {runtime: {id: 'extension', getURL: path => `chrome-extension://extension/${path}`},
    storage: {local: storage, session: storage}, tabs: {
      // Static content-script matches and joule's host grant do not expose ATS tab URLs.
      get: async () => manifest.permissions.includes('tabs') ? tab : {id: tab.id, active: tab.active},
      query: async () => [{id: tab.id, active: tab.active}],
      onActivated: {addListener: fn => { listeners.activate = fn; }},
      onUpdated: {addListener: fn => { listeners.update = fn; }},
    }};
  const background = createBackground(chrome, async url => {
    calls.push(url);
    const path = new URL(url);
    let value = {};
    if (path.pathname === '/api/appearance') {
      if (themeFails) return {ok: false, status: 404};
      value = {theme};
    } else if (path.pathname === '/api/jobs/resolve') {
      if (resolveFails) return {ok: false, status: 403};
      assert.equal(path.searchParams.get('url'), tab.url);
      value = tab.url.includes('/acme/1/') ? job : null;
    } else if (path.pathname === '/api/jobs') value = listed ? [job] : [];
    else if (path.pathname === '/api/jobs/1') value = job;
    return {ok: true, json: async () => value};
  });
  chrome.runtime.sendMessage = async message => {
    try { return {value: await background.handle(message, ui)}; }
    catch (error) { return {error: error.message}; }
  };
  const panel = new JSDOM(fs.readFileSync(`${__dirname}/../sidepanel.html`, 'utf8'), {runScripts: 'outside-only'});
  panel.window.chrome = chrome;
  const permissions = []; chrome.permissions = {request: async request => { permissions.push(request); return true; }};
  panel.window.fetch = async () => ({ok: true, json: async () => []});
  panel.window.eval(fs.readFileSync(`${__dirname}/../options.js`, 'utf8'));
  const media = {matches: false, addEventListener(type, fn) { this.changed = fn; }};
  panel.window.matchMedia = () => media;
  panel.window.eval(fs.readFileSync(`${__dirname}/../sidepanel.js`, 'utf8'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const element = id => panel.window.document.getElementById(id);
  await settle();
  assert.equal(panel.window.document.documentElement.classList.contains('dark'), true);
  assert.equal(element('matched').hidden, false);
  assert.equal(element('fill').disabled, false);
  assert.equal(element('active').textContent, 'Engineer');
  assert.match(element('job-meta').textContent, /Acme/);
  assert.match(element('status').textContent, /Detected Job from page URL/);
  tab = {...tab, id: 5, url: 'https://employer.example/unknown'};
  listeners.activate({tabId: 5});
  await settle();
  assert.equal(values.active, null);
  assert.equal(element('fill').disabled, true);
  assert.match(element('status').textContent, /No stored Job matches/);
  element('job-choices').querySelector('[data-job="1"]').click();
  await settle();
  assert.equal(values.active.id, 1);
  assert.equal(element('fill').disabled, false);
  tab.url = 'https://jobs.lever.co/acme/1/apply';
  listeners.update(5, {url: tab.url}, tab);
  await settle();
  assert.equal(element('matched').hidden, false);
  listed = false;
  element('retry').click();
  await settle();
  assert.equal(element('job-choices').querySelectorAll('[data-job="1"]').length, 1, 'matched Jobs outside the picker query remain available');
  listed = true;
  tab.url = undefined;
  element('retry').click();
  await settle();
  assert.equal(values.active, null);
  assert.match(element('status').textContent, /Auto-detect failed: Chrome did not expose the page URL/);
  assert.equal(element('fill').disabled, true);
  assert.equal(element('job-search').disabled, false);
  assert.equal(element('job-choices').querySelectorAll('button').length, 1);
  element('job-choices').querySelector('[data-job="1"]').click();
  await settle();
  assert.equal(element('fill').disabled, false, 'manual selection works after detection failure');
  tab.url = 'https://jobs.lever.co/acme/1/apply';
  resolveFails = true;
  element('retry').click();
  await settle();
  assert.equal(values.active, null, 'failed detection must not restore the previous manual Job');
  assert.match(element('status').textContent, /Auto-detect failed: joule HTTP 403/);
  assert.equal(element('job-search').disabled, false);
  for (const url of ['https://upwork.com/job']) {
    tab.url = url;
    const count = calls.length;
    assert.equal(await background.handle({type: 'detect', tabId: 5}, ui), null);
    assert.equal(calls.length, count);
  }
  await assert.rejects(background.handle({type: 'detect', tabId: 5}, {...ui, tab}), /Only extension UI/);
  resolveFails = false; tab.url = 'https://jobs.lever.co/acme/1/apply';
  element('settings').click(); assert.equal(element('connection-options').hidden, false);
  element('origin').value = 'file:///bad'; element('test').click(); await settle();
  assert.equal(permissions.length, 0); assert.equal(values.origin, 'http://localhost:8000');
  element('origin').value = 'http://localhost:9000'; element('test').click(); await settle();
  assert.equal(JSON.stringify(permissions), JSON.stringify([{origins: ['http://localhost/*']}]));
  assert.equal(values.origin, 'http://localhost:9000');
  assert.equal(element('connection-state').textContent, 'Connected');
  for (const [saved, darkOS, fails, dark] of [['dark', false, true, false], ['light', true, false, false], ['system', true, false, true]]) {
    theme = saved; media.matches = darkOS; themeFails = fails;
    element('retry').click(); await settle();
    assert.equal(panel.window.document.documentElement.classList.contains('dark'), dark);
    assert.equal(element('connection-state').textContent, 'Connected', 'appearance failure does not disconnect the panel');
  }
  media.matches = false; media.changed();
  assert.equal(panel.window.document.documentElement.classList.contains('dark'), false, 'System follows OS changes');
  panel.window.close();
});
