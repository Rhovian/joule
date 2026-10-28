/* Public forms only. A fresh browser profile never reuses the operator's login. */
const {chromium} = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {allowed} = require('./content.js');
const {normalizeOrigin} = require('./options.js');
const {submitValidation, collectValidation} = require('./replay-validation.js');

async function replay(url, origin = 'http://localhost:8000', headed = false) {
  if (!/^https?:$/.test(new URL(url).protocol) || !allowed(url)) throw Error('This form URL is refused');
  origin = normalizeOrigin(origin);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'joule-replay-'));
  let context;
  try {
    const extension = path.join(temporary, 'extension');
    await fs.mkdir(extension);
    const manifest = JSON.parse(await fs.readFile(path.join(__dirname, 'manifest.json'), 'utf8'));
    // Only this disposable copy has broad host access, to inject into employer embeds.
    manifest.host_permissions = ['http://*/*', 'https://*/*'];
    for (const file of ['background.js', 'content.js', 'options.js', 'options.html', 'sidepanel.js', 'sidepanel.html']) {
      await fs.copyFile(path.join(__dirname, file), path.join(extension, file));
    }
    await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
    // Playwright 1.56.1 documents persistent Chromium for unpacked/headless extensions:
    // https://github.com/microsoft/playwright/blob/v1.56.1/docs/src/chrome-extensions-js-python.md
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      channel: 'chromium', headless: !headed, serviceWorkers: 'block',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 15000});
    const id = new URL(worker.url()).hostname;
    // Close page WebSockets from startup so an existing connection cannot bypass Submit blocking.
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60000});
    await page.locator('input:not([type=hidden]),textarea,select,iframe').first().waitFor({state: 'attached', timeout: 30000});
    // Filter before first(): a CSS-hidden upload may precede the visible form controls.
    // Playwright 1.56.1 retries :visible selectors as the page renders:
    // https://github.com/microsoft/playwright/blob/v1.56.1/docs/src/other-locators.md#css-matching-only-visible-elements
    await Promise.any(page.frames().map(frame => frame.locator('input:not([type=hidden]):visible,textarea:visible,select:visible').first()
      .waitFor({state: 'visible', timeout: 30000})));
    const ui = await context.newPage();
    await ui.goto(`chrome-extension://${id}/options.html`);
    const result = await ui.evaluate(async ({origin, pageURL}) => {
      await chrome.storage.local.set({origin});
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === pageURL);
      if (!tab) throw Error('Application tab disappeared');
      await chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files: ['content.js']});
      const response = await chrome.runtime.sendMessage({type: 'replay', tabId: tab.id});
      if (response.error) throw Error(response.error);
      return {trace: response.value.trace, filled: response.value.filled, tabId: tab.id};
    }, {origin, pageURL: page.url()});
    result.trace.validation = await submitValidation(context, page);
    const trace = result.trace.validation.status === 'clicked' ?
      await ui.evaluate(collectValidation, {tabId: result.tabId, trace: result.trace}) : result.trace;
    // Node's fetch reaches only the configured joule endpoint; the entire browser remains offline.
    const saved = await fetch(`${origin}/api/fill/traces`, {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify(trace)});
    if (!saved.ok) throw Error(`Trace save failed: joule HTTP ${saved.status}`);
    return {filled: result.filled, file: (await saved.json()).file, validation: trace.validation.status};
  } finally {
    if (context) await context.close();
    await fs.rm(temporary, {recursive: true, force: true});
  }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args[0]) { console.error('Usage: npm run replay -- URL [JOULE_ORIGIN] [--headed]'); process.exitCode = 1; }
  else replay(args[0], args[1] && !args[1].startsWith('--') ? args[1] : undefined, args.includes('--headed'))
    .then(result => console.log(`${result.filled} filled; validation: ${result.validation}; trace: ${result.file}`))
    .catch(error => { console.error(`Replay failed: ${error.message}`); process.exitCode = 1; });
}
module.exports = {replay};
