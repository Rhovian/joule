// Real Chromium + real extension + real joule writer; no external form receives Profile data.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {replay} = require('../replay.js');

test('URL-only runner writes the same private trace through a real joule server', {timeout: 90000}, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'joule-smoke-'));
  const root = path.resolve(__dirname, '../..');
  // Let the OS choose ports. uvicorn runs on the inherited listening descriptor.
  const socket = http.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  let server, submissions = 0, leaked = 0, upgrades = 0;
  const form = http.createServer((request, response) => {
    if (request.method === 'POST') submissions++;
    if (/leak|sw\.js/.test(request.url)) leaked++;
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/native') {
      response.end('<form method="post" action="/leak-native"><label for="email">Email</label><input id="email" type="email" required><button>Submit application</button></form>');
      return;
    }
    response.end(`<form method="post" novalidate action="/leak-native">
      <div><label for="email">Email</label><input id="email" type="email" required aria-errormessage="err"><span id="err" hidden></span></div>
      <div><label for="missing">A required custom answer</label><input id="missing" required></div>
      <script>document.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        const input = document.querySelector('#email');
        input.setAttribute('aria-invalid', 'true');
        input.setCustomValidity('Invalid private answer: ' + input.value);
        const error = document.querySelector('#err'); error.hidden = false;
        error.textContent = 'Required: framework did not accept ' + input.value;
        fetch('/leak-fetch', {method: 'POST', body: input.value}).catch(() => {});
        fetch('/leak-get?answer=' + encodeURIComponent(input.value)).catch(() => {});
        const xhr = new XMLHttpRequest(); xhr.open('POST', '/leak-xhr'); xhr.send(input.value);
        navigator.sendBeacon('/leak-beacon', input.value);
        new WebSocket(location.origin.replace('http', 'ws') + '/leak-ws');
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });</script><button>Submit</button></form>`);
  });
  form.on('upgrade', (request, socket) => { upgrades++; socket.destroy(); });
  try {
    await fs.mkdir(path.join(temporary, 'profile'));
    await fs.writeFile(path.join(temporary, 'profile/cv.yaml'), 'basics:\n  name: Ada Lovelace\n  email: smoke-private@example.com\n');
    server = spawn(path.join(root, '.venv/bin/uvicorn'), ['joule.app:app', '--fd', '3'], {
      cwd: root, env: {...process.env, JOULE_DATA_DIR: temporary}, stdio: ['ignore', 'pipe', 'pipe', socket._handle.fd],
    });
    await new Promise((resolve, reject) => {
      let logs = '';
      server.stderr.on('data', chunk => { logs += chunk; if (logs.includes('Application startup complete')) resolve(); });
      server.once('exit', code => reject(Error(`Server exited ${code}: ${logs}`)));
      server.once('error', reject);
    });
    await new Promise(resolve => socket.close(resolve));
    await new Promise(resolve => form.listen(0, '127.0.0.1', resolve));
    const result = await replay(`http://127.0.0.1:${form.address().port}/apply?token=private`, `http://127.0.0.1:${port}`);
    assert.equal(result.filled, 1);
    const text = await fs.readFile(result.file, 'utf8'), trace = JSON.parse(text);
    assert.equal(trace.version, 1);
    assert.equal(trace.job_id, null);
    assert.equal(trace.fields.find(row => row.label === 'Email').outcome, 'written');
    const email = trace.fields.find(row => row.label === 'Email');
    assert.ok(!email.signals.includes('aria-invalid'));
    assert.ok(email.signals.includes('submit-aria-invalid'));
    assert.ok(email.signals.includes('submit-required-error'));
    assert.ok(email.signals.includes('submit-native-invalid'));
    assert.equal(trace.validation.status, 'clicked');
    assert.equal(trace.validation.network_blocked, true);
    assert.ok(trace.validation.blocked_requests >= 4);
    assert.ok(trace.fields.find(row => row.label.startsWith('A required')).signals.includes('required-empty'));
    assert.doesNotMatch(text, /smoke-private|token=private/);
    assert.deepEqual(trace.errors, []);
    assert.ok(trace.fields.find(row => row.label.startsWith('A required')).signals.includes('submit-native-value-missing'));
    const native = await replay(`http://127.0.0.1:${form.address().port}/native`, `http://127.0.0.1:${port}`);
    const nativeTrace = JSON.parse(await fs.readFile(native.file, 'utf8'));
    assert.equal(nativeTrace.validation.status, 'clicked');
    assert.ok(nativeTrace.validation.blocked_requests >= 1);
    assert.equal(submissions, 0); assert.equal(leaked, 0); assert.equal(upgrades, 0);
    console.log('smoke: submit-only validation captured; fetch/GET/XHR/beacon/WebSocket/Service Worker + native POST blocked; 0 employer requests; private traces written');
  } finally {
    form.close(); socket.close();
    if (server) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    await fs.rm(temporary, {recursive: true, force: true});
  }
});
