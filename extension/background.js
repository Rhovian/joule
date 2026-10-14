if (typeof importScripts === 'function') importScripts('content.js');
function createBackground(chrome, fetcher = fetch) {
  const pending = new Map();
  let registration = Promise.resolve();
  const allowed = typeof module !== 'undefined' ? require('./content.js').allowed :
    url => !/(^|\.)(upwork|linkedin|indeed|glassdoor)\.com\.?$/.test(new URL(url).hostname);
  const trusted = sender => sender.id === chrome.runtime.id && !sender.tab &&
    ['options.html', 'sidepanel.html'].some(path => sender.url === chrome.runtime.getURL(path));
  const integer = value => { if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid Job id'); return value; };
  async function api(path, body) {
    const {origin} = await chrome.storage.local.get('origin');
    if (!origin) throw Error('Configure the joule URL in Options first');
    const response = await fetcher(`${origin}${path}`, body === undefined ? {} : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    if (!response.ok) { const error = Error(`joule HTTP ${response.status}`); error.status = response.status; throw error; }
    return response.json();
  }
  async function handle(message, sender) {
    if (message.type === 'register' && sender.id === chrome.runtime.id && sender.tab && allowed(sender.url) && (!sender.tab.url || allowed(sender.tab.url))) {
      const key = `frames:${sender.tab.id}`;
      registration = registration.then(async () => {
        const stored = await chrome.storage.session.get(key);
        await chrome.storage.session.set({[key]: {...stored[key], [sender.frameId]: sender.url}});
      });
      await registration;
      return {};
    }
    if (message.type === 'frame') {
      const request = pending.get(message.request);
      if (!request || sender.id !== chrome.runtime.id || sender.tab?.id !== request.tabId ||
        !allowed(sender.url) || (sender.tab.url && !allowed(sender.tab.url))) throw Error('Unrequested frame');
      request.frames.set(sender.frameId, message.fields);
      return {};
    }
    if (!trusted(sender)) throw Error('Only extension UI can request joule data');
    if (message.type === 'jobs') {
      const jobs = (await api('/api/jobs')).filter(job => job.source !== 'upwork');
      // GET /api/jobs omits drafts; the existing detail route is the only draft read API.
      const details = await Promise.all(jobs.map(job => api(`/api/jobs/${integer(job.id)}`)));
      return jobs.map((job, index) => ({...job, hasDrafts: Object.keys(details[index].drafts || {}).length > 0}))
        .sort((a, b) => Number(b.hasDrafts) - Number(a.hasDrafts) || (b.rank ?? -Infinity) - (a.rank ?? -Infinity));
    }
    if (message.type === 'active') return (await chrome.storage.session.get('active')).active || null;
    if (message.type === 'select') {
      const job = await api(`/api/jobs/${integer(message.id)}`);
      if (job.source === 'upwork') throw Error('Upwork Jobs cannot be filled');
      const active = {id: job.id, title: job.title, company: job.company, source: job.source};
      await chrome.storage.session.set({active});
      return active;
    }
    if (message.type !== 'fill') throw Error('Unknown request');
    const {active} = await chrome.storage.session.get('active');
    if (!active || active.source === 'upwork') throw Error('Pick a non-Upwork Job first');
    const tab = await chrome.tabs.get(integer(message.tabId));
    if (!allowed(tab.url)) throw Error('This host is refused');
    const key = `frames:${tab.id}`;
    await registration;
    const registered = (await chrome.storage.session.get(key))[key] || {};
    const requestId = crypto.randomUUID();
    const request = {tabId: tab.id, frames: new Map()};
    pending.set(requestId, request);
    try {
      await Promise.all(Object.keys(registered).map(async frame => {
        try { await chrome.tabs.sendMessage(tab.id, {type: 'describe', request: requestId}, {frameId: Number(frame)}); }
        catch { /* A navigated/removed frame has no content script; omit it. */ }
      }));
      const fields = [];
      for (const [frameId, descriptors] of request.frames) {
        for (const descriptor of descriptors) {
          fields.push({...descriptor, ref: [frameId, descriptor.ref]});
        }
      }
      if (!fields.length) throw Error('No supported form found. Reload the ATS page if the extension was just installed.');
      if (fields.length > 200) throw Error('Form exceeds the 200-field limit');
      let result;
      try { result = await api(`/api/fill/jobs/${integer(active.id)}/match`, {fields}); }
      catch (error) { if (error.status === 404) await chrome.storage.session.remove('active'); throw error; }
      let filled = 0;
      for (const frameId of request.frames.keys()) {
        const actions = result.actions.filter(action => action.ref[0] === frameId)
          .map(action => ({...action, ref: action.ref[1]}));
        const applied = await chrome.tabs.sendMessage(tab.id, {type: 'apply', actions}, {frameId});
        filled += applied.filled;
      }
      return {...result, filled, fields};
    } finally { pending.delete(requestId); }
  }
  async function inject(tab) {
    if (!tab?.id || !allowed(tab.url) || !/^https?:/.test(tab.url)) throw Error('This host is refused');
    // activeTab gestures grant the main origin; cross-origin embeds use the direct-URL fallback (ADR §3e).
    // https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
    const injected = chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['content.js']});
    // Keep open() in the gesture, before awaiting injection or storage (Chrome 116+).
    // https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-open
    await Promise.all([injected, chrome.sidePanel.open({tabId: tab.id})]);
  }
  function installGestures() {
    chrome.runtime.onInstalled.addListener(() => {
      chrome.contextMenus.create({id: 'fill-with-joule', title: 'Fill with Joule', contexts: ['page', 'editable']});
    });
    const launch = tab => inject(tab).catch(error => console.error(`Joule Fill: ${error.message}`));
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === 'fill-with-joule') return launch(tab);
    });
    // onCommand supplies the active tab, avoiding an async query that can lose the gesture.
    // https://developer.chrome.com/docs/extensions/reference/api/commands#event-onCommand
    chrome.commands.onCommand.addListener((command, tab) => {
      if (command === 'fill-with-joule') return launch(tab);
    });
  }
  return {handle, inject, installGestures};
}
if (typeof module !== 'undefined') module.exports = {createBackground};
if (typeof chrome !== 'undefined') {
  // Lock configuration before accepting messages; content scripts never read the joule origin.
  const ready = chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const background = createBackground(chrome);
  background.installGestures();
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true});
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    ready.then(() => background.handle(message, sender)).then(value => respond({value}), error => respond({error: error.message}));
    return true;
  });
}
