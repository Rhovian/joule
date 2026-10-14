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
    if (!['fill', 'attach', 'resume'].includes(message.type)) throw Error('Unknown request');
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
  return {handle};
}
if (typeof module !== 'undefined') module.exports = {createBackground};
if (typeof chrome !== 'undefined') {
  // Lock configuration before accepting messages; content scripts never read the joule origin.
  const ready = chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const background = createBackground(chrome);
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true});
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    ready.then(() => background.handle(message, sender)).then(value => respond({value}), error => respond({error: error.message}));
    return true;
  });
}
