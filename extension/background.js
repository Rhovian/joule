if (typeof importScripts === 'function') importScripts('content.js');
function createBackground(chrome, fetcher = fetch) {
  const pending = new Map();
  let registration = Promise.resolve();
  const allowed = typeof module !== 'undefined' ? require('./content.js').allowed :
    url => !/(^|\.)(upwork|linkedin|indeed|glassdoor)\.com\.?$/.test(new URL(url).hostname);
  const trusted = sender => sender.id === chrome.runtime.id && !sender.tab &&
    ['options.html', 'sidepanel.html'].some(path => sender.url === chrome.runtime.getURL(path));
  const integer = value => { if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid Job id'); return value; };
  async function api(path, body, pdf = false) {
    const {origin} = await chrome.storage.local.get('origin');
    if (!origin) throw Error('Configure the joule URL in Options first');
    const response = await fetcher(`${origin}${path}`, body === undefined ? {} : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    if (!response.ok) { const error = Error(`joule HTTP ${response.status}`); error.status = response.status; throw error; }
    if (!pdf) return response.json();
    // Chrome messages use JSON, not structured clone; binary PDFs need base64:
    // https://developer.chrome.com/docs/extensions/develop/concepts/messaging#serialization
    // The existing server emits a quoted ASCII filename (joule/jobs.py draft_pdf).
    const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1];
    if (!name) throw Error('PDF response has no filename');
    let binary = '';
    for (const byte of new Uint8Array(await response.arrayBuffer())) binary += String.fromCharCode(byte);
    return {name, base64: btoa(binary)};
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
    if (message.type === 'detect') {
      await chrome.storage.session.set({active: null});
      const tab = await chrome.tabs.get(integer(message.tabId));
      // Tab URL metadata needs tabs/host permission; static script matches do not grant it.
      // https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions
      if (!tab.url) throw Error('Chrome did not expose the page URL. Reload the extension to enable tab access, then Refresh Jobs.');
      const active = /^https?:/.test(tab.url) && allowed(tab.url) ?
        await api(`/api/jobs/resolve?url=${encodeURIComponent(tab.url)}`) : null;
      await chrome.storage.session.set({active});
      return active;
    }
    if (message.type === 'jobs') {
      const jobs = (await api('/api/jobs')).filter(job => job.source !== 'upwork');
      return jobs.sort((a, b) => Number(b.has_drafts) - Number(a.has_drafts) || (b.rank ?? -Infinity) - (a.rank ?? -Infinity));
    }
    if (message.type === 'active') return (await chrome.storage.session.get('active')).active || null;
    if (message.type === 'select') {
      const job = await api(`/api/jobs/${integer(message.id)}`);
      if (job.source === 'upwork') throw Error('Upwork Jobs cannot be filled');
      const active = {id: job.id, title: job.title, company: job.company, source: job.source};
      await chrome.storage.session.set({active});
      return active;
    }
    if (!['fill', 'attach', 'resume', 'ask', 'save'].includes(message.type)) throw Error('Unknown request');
    const {active} = await chrome.storage.session.get('active');
    if (!active || active.source === 'upwork') throw Error('Pick a non-Upwork Job first');
    async function match(fields) {
      try { return await api(`/api/fill/jobs/${integer(active.id)}/match`, {fields}); }
      catch (error) { if (error.status === 404) await chrome.storage.session.remove('active'); throw error; }
    }
    if (message.type === 'resume') return match([]);
    if (message.type === 'attach' && !['resume', 'cover_letter'].includes(message.kind)) throw Error('Invalid attachment kind');
    const tab = await chrome.tabs.get(integer(message.tabId));
    if (!allowed(tab.url)) throw Error('This host is refused');
    if (message.type === 'ask' || message.type === 'save') {
      const field = message.field;
      if (message.jobId !== active.id || !Array.isArray(field?.ref) || field.ref.length !== 2 ||
        !field.ref.every(part => Number.isSafeInteger(part) && part >= 0)) throw Error('Fill again before Ask or Save');
      if (message.type === 'save') {
        const answer = await chrome.tabs.sendMessage(tab.id, {type: 'answer', expected: {...field, ref: field.ref[1]}}, {frameId: field.ref[0]});
        if (answer.error) throw Error(answer.error);
        if ((await chrome.tabs.get(tab.id)).url !== tab.url ||
          (await chrome.storage.session.get('active')).active?.id !== active.id) throw Error('Fill again before Save');
        return api('/api/fill/answers', answer);
      }
      let result;
      try { result = await api(`/api/fill/jobs/${integer(active.id)}/ask`, {question: field.label, options: field.options || []}); }
      catch (error) { if (error.status === 404) await chrome.storage.session.remove('active'); throw error; }
      if (result.value === null) return {...result, filled: 0};
      const current = await chrome.tabs.get(tab.id);
      if (current.url !== tab.url || (await chrome.storage.session.get('active')).active?.id !== active.id) throw Error('Fill again before Ask');
      const applied = await chrome.tabs.sendMessage(tab.id, {type: 'apply', expected: {...field, ref: field.ref[1]},
        actions: [{ref: field.ref[1], action: 'set', value: result.value}]}, {frameId: field.ref[0]});
      return {...result, filled: applied.filled};
    }
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
      let result = await match(fields);
      if (message.type === 'attach') {
        if (message.kind === 'cover_letter' && !result.cover_letter_draft_id) throw Error('no Cover Letter Draft');
        const actions = result.actions.filter(action => action.action === 'upload' && action.file === message.kind);
        if (!actions.length) throw Error('No matching file input found');
        if (message.kind === 'resume' && !result.resume_draft_id) {
          // Duplicate append-only versions across panels are an accepted race (§6); the panel disables its button.
          await api(`/api/jobs/${integer(active.id)}/drafts`, {kind: 'tailored_cv'});
          result = await match(fields);
        }
        const draftId = message.kind === 'resume' ? result.resume_draft_id : result.cover_letter_draft_id;
        if (!draftId) throw Error('no Cover Letter Draft');
        const file = await api(`/api/drafts/${integer(draftId)}/pdf`, undefined, true);
        let filled = 0;
        for (const action of actions) {
          const applied = await chrome.tabs.sendMessage(tab.id, {type: 'upload', ref: action.ref[1], file}, {frameId: action.ref[0]});
          filled += applied.filled;
        }
        return {...result, filled, fields};
      }
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
