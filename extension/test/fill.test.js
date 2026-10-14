const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {createWorker, allowed} = require('../content.js');
const {createBackground} = require('../background.js');
const {connect, normalizeOrigin} = require('../options.js');
function dom(html) {
  const document = new JSDOM(html).window.document;
  // jsdom has no layout. Give normal fields a box; preserve explicit zero-size cases.
  document.defaultView.HTMLElement.prototype.getClientRects = function () {
    return this.dataset.zero ? [] : [{width: 100, height: 20}];
  };
  return document;
}
function storage() {
  const data = {};
  return {
    get: async key => key ? {[key]: data[key]} : {...data},
    set: async values => Object.assign(data, values),
    remove: async key => { delete data[key]; },
  };
}
function fakeChrome() {
  return {runtime: {id: 'extension', getURL: path => `chrome-extension://extension/${path}`},
    storage: {local: storage(), session: storage()}, permissions: {request: async () => true}, tabs: {}};
}
const ui = {id: 'extension', url: 'chrome-extension://extension/sidepanel.html'};
for (const fixture of ['greenhouse', 'lever']) {
  test(`${fixture}: identity writes use native setter, emit events, preserve values and consent`, () => {
    const document = dom(fs.readFileSync(`${__dirname}/fixtures/${fixture}.html`, 'utf8'));
    const worker = createWorker(document), fields = worker.describe();
    const text = fields.filter(field => !['file', 'checkbox'].includes(field.type) && !field.role);
    let inputs = 0, changes = 0;
    document.addEventListener('input', () => inputs++);
    document.addEventListener('change', () => changes++);
    const preserved = document.querySelector('input[type=email]');
    preserved.value = 'operator@example.com';
    const first = document.querySelector('input');
    Object.defineProperty(first, 'value', {set() { throw Error('own React setter must be bypassed'); }, get() {
      return Object.getOwnPropertyDescriptor(document.defaultView.HTMLInputElement.prototype, 'value').get.call(this);
    }});
    assert.equal(worker.apply(text.map(field => ({ref: field.ref, action: 'set', value: 'identity'}))).filled, text.length - 1);
    assert.equal(first.value, 'identity');
    assert.equal(preserved.value, 'operator@example.com');
    assert.equal(inputs, text.length - 1);
    assert.equal(changes, inputs);
    assert.equal(worker.apply(fields.map(field => ({ref: field.ref, action: 'set', value: 'overwrite'}))).filled, 0);
    assert.equal(document.querySelector('input[type=checkbox]').checked, false);
    assert.ok(fields.find(field => field.type === 'file'));
    assert.ok(!fields.some(field => ['shadow', 'trap', 'gone'].includes(field.id)));
    if (fixture === 'greenhouse') {
      assert.equal(fields.find(field => field.id === 'question_66210918').label, 'LinkedIn Profile');
      assert.equal(document.getElementById('location').value, '');
    } else assert.equal(fields[0].label, 'Full name ✱');
  });
}
test('label precedence and visibility are checked again at apply time', () => {
  const document = dom(`<label for="a">Explicit</label><label>Wrap<input id="a" aria-label="ARIA" placeholder="Placeholder"></label>
    <span id="label">Referenced</span><input id="b" aria-labelledby="label" aria-label="ARIA">
    <fieldset><legend>Legend</legend><input id="c" placeholder="Placeholder"></fieldset>
    <input disabled><input readonly><input data-zero="true"><input hidden><div aria-hidden="true"><input></div>
    <input id="file" type="file" data-zero="true"><textarea id="d" maxlength="3"></textarea>`);
  const worker = createWorker(document), fields = worker.describe();
  assert.deepEqual(fields.map(field => field.label), ['Explicit', 'Referenced', 'Legend', '', '']);
  document.getElementById('a').style.display = 'none';
  document.getElementById('b').disabled = true;
  document.getElementById('c').remove();
  assert.equal(worker.apply(fields.map(field => ({ref: field.ref, action: 'set', value: 'abcdef'}))).filled, 1);
  assert.equal(document.getElementById('d').value, 'abc');
});
test('manifest confines static access and grep finds no page submit/click/state mutation', () => {
  const manifest = JSON.parse(fs.readFileSync(`${__dirname}/../manifest.json`));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].matches.length, 5);
  assert.equal(manifest.externally_connectable, undefined);
  assert.ok(!JSON.stringify(manifest).includes('<all_urls>'));
  for (const pattern of manifest.content_scripts[0].matches) assert.ok(allowed(pattern.replace('*', 'form')));
  for (const filename of ['background.js', 'content.js', 'options.js', 'sidepanel.js']) {
    const source = fs.readFileSync(`${__dirname}/../${filename}`, 'utf8');
    assert.doesNotMatch(source, /\.(?:submit|requestSubmit|click)\s*\(|(?:Event|dispatchEvent)\s*\(\s*['"]submit|method:\s*['"]PATCH/);
  }
});
test('denylist covers apex, subdomain and trailing dot without denying lookalikes', () => {
  for (const domain of ['upwork.com', 'linkedin.com', 'indeed.com', 'glassdoor.com']) {
    for (const host of [domain, `www.${domain}`, `${domain}.`]) assert.equal(allowed(`https://${host}/jobs`), false);
    assert.equal(allowed(`https://${domain}.example.org/`), true);
  }
  assert.equal(allowed('invalid'), false);
});
test('Options requests one origin, reads cheap Jobs route and saves only after success', async () => {
  const chrome = fakeChrome(), calls = [];
  chrome.permissions.request = async request => { calls.push(request); return true; };
  assert.equal(await connect(chrome, 'http://localhost:8000/', async url => {
    assert.equal(url, 'http://localhost:8000/api/jobs?unscored=false');
    return {ok: true, json: async () => []};
  }), 'Connected to joule');
  assert.deepEqual(calls, [{origins: ['http://localhost/*']}]);
  assert.equal((await chrome.storage.local.get('origin')).origin, 'http://localhost:8000');
  await assert.rejects(connect(chrome, 'http://localhost:9000', async () => ({ok: false, status: 400})), /HTTP 400/);
  assert.equal((await chrome.storage.local.get('origin')).origin, 'http://localhost:8000');
  for (const value of ['file:///tmp/a', 'https://u:p@host', 'https://host/path', 'https://host/?query']) assert.throws(() => normalizeOrigin(value));
  chrome.permissions.request = async () => false;
  await assert.rejects(connect(chrome, 'https://host', () => { throw Error('must not fetch'); }), /declined/);
});
async function setup() {
  const chrome = fakeChrome(), calls = [];
  await chrome.storage.local.set({origin: 'http://localhost:8000'});
  const jobs = [{id: 1, title: 'High rank', company: 'A', source: 'hotfix', rank: 99, has_drafts: false},
    {id: 2, title: 'Draft Job', company: 'B', source: 'hn', rank: 5, has_drafts: true},
    {id: 3, source: 'upwork', rank: 100, has_drafts: true},
    {id: 4, source: 'hotfix', rank: null, has_drafts: false},
    {id: 5, source: 'hn', rank: 10, has_drafts: true}];
  let missing = false;
  const background = createBackground(chrome, async (url, options) => {
    calls.push({url, options});
    const id = Number(url.split('/').at(-1));
    if (url.endsWith('/match')) return missing ? {ok: false, status: 404} : {ok: true, json: async () => {
      const {fields} = JSON.parse(options.body);
      for (const field of fields) {
        assert.equal(field.ref.length, 2);
        assert.ok(field.ref.every(part => Number.isInteger(part) && part >= 0));
      }
      return {job: jobs[1], actions: fields.map(field => ({ref: field.ref, action: 'set', value: field.label})), resume_draft_id: null, cover_letter_draft_id: null};
    }};
    return {ok: true, json: async () => url.endsWith('/api/jobs') ? jobs : jobs.find(job => job.id === id)};
  });
  return {chrome, calls, background, missing: () => { missing = true; }};
}
test('picker excludes Upwork, sorts Drafts first then rank, rejects page messages', async () => {
  const {background, calls} = await setup();
  assert.deepEqual((await background.handle({type: 'jobs'}, ui)).map(job => job.id), [5, 2, 1, 4]);
  assert.deepEqual(calls.map(call => call.url), ['http://localhost:8000/api/jobs']);
  await assert.rejects(background.handle({type: 'select', id: 3}, ui), /Upwork/);
  await assert.rejects(background.handle({type: 'select', id: '../answers'}, ui), /Invalid/);
  await assert.rejects(background.handle({type: 'jobs'}, {id: 'extension', tab: {id: 1}, url: 'https://jobs.lever.co/a'}), /Only extension UI/);
  assert.ok(!calls.some(call => call.options?.method === 'PATCH'));
});
test('Fill aggregates and routes two frames, reuses session after SW restart, clears missing Job', async () => {
  const setupResult = await setup(), {chrome, background, calls} = setupResult;
  await background.handle({type: 'select', id: 2}, ui);
  const tab = {id: 4, url: 'https://company.example/careers'};
  chrome.tabs.get = async () => tab;
  const senders = [0, 7].map(frameId => ({id: 'extension', tab, frameId, url: 'https://jobs.lever.co/a'}));
  await Promise.all(senders.map(sender => background.handle({type: 'register'}, sender)));
  const applied = [];
  chrome.tabs.sendMessage = async (tabId, message, target) => {
    if (message.type === 'describe') {
      await background.handle({type: 'frame', request: message.request, fields: [{ref: 0, label: `frame ${target.frameId}`} ]}, senders.find(sender => sender.frameId === target.frameId));
      return {ok: true};
    }
    applied.push({target, message});
    return {filled: message.actions.length};
  };
  const result = await background.handle({type: 'fill', tabId: 4}, ui);
  assert.equal(result.filled, 2);
  assert.deepEqual(result.fields.map(field => field.ref), [[0, 0], [7, 0]]);
  assert.deepEqual(applied.map(call => call.message.actions[0].ref), [0, 0]);
  assert.deepEqual(applied.map(call => call.target.frameId), [0, 7]);
  const match = calls.find(call => call.url.endsWith('/match'));
  assert.equal(match.url, 'http://localhost:8000/api/fill/jobs/2/match');
  assert.equal(match.options.headers['Content-Type'], 'application/json');
  assert.equal((await createBackground(chrome).handle({type: 'active'}, ui)).id, 2);
  setupResult.missing();
  await assert.rejects(background.handle({type: 'fill', tabId: 4}, ui), /HTTP 404/);
  assert.equal(await background.handle({type: 'active'}, ui), null);
});
test('Fill refuses denylisted top hosts and unsolicited frame messages before fetching', async () => {
  const {chrome, background, calls} = await setup();
  await background.handle({type: 'select', id: 2}, ui);
  const count = calls.length;
  for (const host of ['upwork.com', 'www.linkedin.com', 'indeed.com', 'glassdoor.com']) {
    chrome.tabs.get = async () => ({id: 4, url: `https://${host}/`});
    await assert.rejects(background.handle({type: 'fill', tabId: 4}, ui), /refused/);
  }
  await assert.rejects(background.handle({type: 'frame', request: 'spoof', fields: []}, {tab: {id: 4}}), /Unrequested/);
  assert.equal(calls.length, count);
});
