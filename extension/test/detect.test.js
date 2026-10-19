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
  let listed = true, resolveFails = false;
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
    if (path.pathname === '/api/jobs/resolve') {
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
  panel.window.eval(fs.readFileSync(`${__dirname}/../sidepanel.js`, 'utf8'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const element = id => panel.window.document.getElementById(id);
  await settle();
  assert.equal(element('jobs').value, '1');
  assert.equal(element('fill').disabled, false);
  assert.match(element('active').textContent, /Engineer — Acme/);
  assert.match(element('status').textContent, /Detected Job from page URL/);
  tab = {...tab, id: 5, url: 'https://employer.example/unknown'};
  listeners.activate({tabId: 5});
  await settle();
  assert.equal(values.active, null);
  assert.equal(element('fill').disabled, true);
  assert.match(element('status').textContent, /No stored Job matches/);
  element('jobs').value = '1';
  element('jobs').dispatchEvent(new panel.window.Event('change'));
  await settle();
  assert.equal(values.active.id, 1);
  assert.equal(element('fill').disabled, false);
  tab.url = 'https://jobs.lever.co/acme/1/apply';
  listeners.update(5, {url: tab.url}, tab);
  await settle();
  assert.equal(element('jobs').value, '1');
  listed = false;
  element('refresh').click();
  await settle();
  assert.equal(element('jobs').value, '1', 'matched Jobs outside the picker query stay selected');
  listed = true;
  tab.url = undefined;
  element('refresh').click();
  await settle();
  assert.equal(values.active, null);
  assert.match(element('status').textContent, /Auto-detect failed: Chrome did not expose the page URL/);
  assert.equal(element('fill').disabled, true);
  assert.equal(element('jobs').disabled, false);
  assert.equal(element('jobs').options.length, 2);
  element('jobs').value = '1';
  element('jobs').dispatchEvent(new panel.window.Event('change'));
  await settle();
  assert.equal(element('fill').disabled, false, 'manual selection works after detection failure');
  tab.url = 'https://jobs.lever.co/acme/1/apply';
  resolveFails = true;
  element('refresh').click();
  await settle();
  assert.equal(values.active, null, 'failed detection must not restore the previous manual Job');
  assert.match(element('status').textContent, /Auto-detect failed: joule HTTP 403/);
  assert.equal(element('jobs').disabled, false);
  for (const url of ['https://upwork.com/job']) {
    tab.url = url;
    const count = calls.length;
    assert.equal(await background.handle({type: 'detect', tabId: 5}, ui), null);
    assert.equal(calls.length, count);
  }
  await assert.rejects(background.handle({type: 'detect', tabId: 5}, {...ui, tab}), /Only extension UI/);
  panel.window.close();
});
