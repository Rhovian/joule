const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createBackground} = require('../background.js');
const manifest = JSON.parse(fs.readFileSync(`${__dirname}/../manifest.json`, 'utf8'));
function setup() {
  const listeners = {}, calls = [];
  const event = name => ({addListener: callback => { listeners[name] = callback; }});
  const chrome = {
    runtime: {onInstalled: event('install')},
    contextMenus: {create: item => calls.push(item), onClicked: event('menu')},
    commands: {onCommand: event('command')},
    scripting: {executeScript: async options => { calls.push(options); }},
    sidePanel: {open: async options => { calls.push(options); }},
  };
  const background = createBackground(chrome);
  background.installGestures();
  return {listeners, calls, background};
}
test('manifest keeps destination access temporary and declares the command', () => {
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
  assert.equal(manifest.commands['fill-with-joule'].suggested_key, 'Ctrl+Shift+Y');
});
test('both gestures inject the same worker on an unlisted host without requesting host access', async () => {
  const {listeners, calls} = setup(), tab = {id: 4, url: 'https://employer.example/apply'};
  listeners.install();
  assert.deepEqual(calls.pop(), {id: 'fill-with-joule', title: 'Fill with Joule', contexts: ['page', 'editable']});
  for (const invoke of [() => listeners.menu({menuItemId: 'fill-with-joule'}, tab),
    () => listeners.command('fill-with-joule', tab)]) {
    const pending = invoke();
    // open() must be called synchronously while the user gesture is active.
    assert.deepEqual(calls.splice(0), [{target: {tabId: 4}, files: ['content.js']}, {tabId: 4}]);
    await pending;
  }
  listeners.menu({menuItemId: 'other'}, tab);
  listeners.command('other', tab);
  assert.equal(calls.length, 0);
});
test('injection refuses denied hosts, subdomains, trailing dots and restricted URLs before browser calls', async () => {
  const {background, calls} = setup();
  const urls = ['chrome://settings', 'file:///tmp/form', 'invalid'];
  for (const domain of ['upwork.com', 'linkedin.com', 'indeed.com', 'glassdoor.com']) {
    urls.push(...[domain, `jobs.${domain}`, `JOBS.${domain}.`].map(host => `https://${host}/apply`));
  }
  for (const url of urls) await assert.rejects(background.inject({id: 4, url}));
  await assert.rejects(background.inject(undefined), /refused/);
  assert.equal(calls.length, 0);
});
test('repeated injection and static plus gesture injection register only one worker', () => {
  const listeners = [], messages = [], context = vm.createContext({URL, document: {}, location: {href: 'https://employer.example/apply'},
    chrome: {runtime: {onMessage: {addListener: listener => listeners.push(listener)},
      sendMessage: message => { messages.push(message); return Promise.resolve(); }}}});
  const source = fs.readFileSync(`${__dirname}/../content.js`, 'utf8');
  vm.runInContext(source, context);
  vm.runInContext(source, context);
  assert.equal(listeners.length, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'register');
});
