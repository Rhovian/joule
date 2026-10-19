if (typeof importScripts === 'function') importScripts('content.js');
function createBackground(chrome, fetcher = fetch) {
  const pending = new Map();
  let registration = Promise.resolve();
  const allowed = typeof module !== 'undefined' ? require('./content.js').allowed :
    url => !/(^|\.)(upwork|linkedin|indeed|glassdoor)\.com\.?$/.test(new URL(url).hostname);
  // A debugger-opened Options tab has sender.tab; its tab URL must also be extension UI.
  // https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender
  const trusted = sender => sender.id === chrome.runtime.id && (!sender.tab || sender.tab.url === sender.url) &&
    ['options.html', 'sidepanel.html'].some(path => sender.url === chrome.runtime.getURL(path));
  const integer = value => { if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid Job id'); return value; };
  const validRef = field => Array.isArray(field?.ref) && field.ref.length === 2 &&
    field.ref.every(part => Number.isSafeInteger(part) && part >= 0);
  // Fragment changes do not navigate to another document (Chrome tabs URL events include them).
  // https://developer.chrome.com/docs/extensions/reference/api/tabs#event-onUpdated
  const pageURL = url => { const page = new URL(url); page.hash = ''; return page.href; };
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
    if (!['fill', 'replay', 'attach', 'resume', 'ask', 'question', 'save'].includes(message.type)) throw Error('Unknown request');
    if (message.type === 'save') {
      if (!validRef(message.field)) throw Error('Save refused: invalid frame/field reference; run Fill again.');
      if (!Number.isSafeInteger(message.tabId) || message.tabId <= 0) throw Error('Save refused: invalid tab id.');
      const tab = await chrome.tabs.get(message.tabId);
      if (!allowed(tab.url)) throw Error('Save refused: this host is not supported.');
      let answer;
      try {
        answer = await chrome.tabs.sendMessage(tab.id, {type: 'answer', expected: {...message.field, ref: message.field.ref[1]}}, {frameId: message.field.ref[0]});
      } catch (error) { throw Error(`Save refused: form frame is unavailable; run Fill again. ${error.message}`); }
      if (!answer) throw Error('Save refused: form frame returned no answer; run Fill again.');
      if (answer.error) throw Error(answer.error);
      if (pageURL((await chrome.tabs.get(tab.id)).url) !== pageURL(tab.url)) throw Error('Save refused: page URL changed while reading the answer; run Fill again.');
      // The bank is shared across Jobs. Auto-detection's transient/changed active Job must not cancel a Save.
      return api('/api/fill/answers', answer);
    }
    const {active} = message.type === 'replay' ? {active: {id: null, source: 'replay'}} : await chrome.storage.session.get('active');
    if (!active || active.source === 'upwork') throw Error('Pick a non-Upwork Job first');
    async function match(fields) {
      try { return await api(message.type === 'replay' ? '/api/fill/replay-match' : `/api/fill/jobs/${integer(active.id)}/match`, {fields}); }
      catch (error) {
        if (error.status === 404) await chrome.storage.session.remove('active');
        error.message = `Fill matching failed: ${error.message}`;
        throw error;
      }
    }
    if (message.type === 'question') {
      if (message.jobId !== active.id) throw Error('Pick the intended Job before Ask');
      try {
        const result = await api(`/api/fill/jobs/${integer(active.id)}/ask`, {question: message.question});
        if ((await chrome.storage.session.get('active')).active?.id !== active.id) throw Error('Job changed; Ask again');
        return result;
      }
      catch (error) { if (error.status === 404) await chrome.storage.session.remove('active'); throw error; }
    }
    if (message.type === 'resume') return match([]);
    if (message.type === 'attach' && !['resume', 'cover_letter'].includes(message.kind)) throw Error('Invalid attachment kind');
    const tab = await chrome.tabs.get(integer(message.tabId));
    if (!allowed(tab.url)) throw Error('This host is refused');
    if (message.type === 'ask') {
      const field = message.field;
      if (message.jobId !== active.id) throw Error('Ask refused: active Job changed since Fill; run Fill again.');
      if (!validRef(field)) throw Error('Ask refused: invalid frame/field reference; run Fill again.');
      let result;
      try { result = await api(`/api/fill/jobs/${integer(active.id)}/ask`, {question: field.label, options: field.options || []}); }
      catch (error) { if (error.status === 404) await chrome.storage.session.remove('active'); throw error; }
      if (result.value === null) return {...result, filled: 0};
      const current = await chrome.tabs.get(tab.id);
      if (pageURL(current.url) !== pageURL(tab.url)) throw Error('Ask refused: page URL changed while generating the answer; run Fill again.');
      if ((await chrome.storage.session.get('active')).active?.id !== active.id) throw Error('Ask refused: active Job changed while generating the answer; run Fill again.');
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
    const trace = {version: 1, url: tab.url, job_id: active.id, fields: [], errors: []};
    const traceFailure = error => `Diagnostic trace could not be saved (${error.message}).` +
      ([404, 405].includes(error.status) ? ' Update and restart the joule server; its trace endpoint is unavailable.' : '');
    try {
      await Promise.all(Object.keys(registered).map(async frame => {
        try { await chrome.tabs.sendMessage(tab.id, {type: 'describe', request: requestId}, {frameId: Number(frame)}); }
        catch { trace.errors.push(`frame-${frame}-unavailable`); }
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
        try {
          const applied = await chrome.tabs.sendMessage(tab.id, {type: 'trace-apply', actions}, {frameId});
          filled += applied.filled || 0;
          if (!applied.trace) trace.errors.push(`frame-${frameId}-trace-unavailable`);
          for (const row of applied.trace || []) trace.fields.push({...row, ref: [frameId, row.ref]});
        } catch { trace.errors.push(`frame-${frameId}-unavailable`); }
        if (!trace.fields.some(row => row.ref[0] === frameId)) {
          for (const field of request.frames.get(frameId)) trace.fields.push({
            ref: [frameId, field.ref], selector: field.id ? `[id=${JSON.stringify(field.id)}]` : '',
            label: (field.label || '').slice(0, 300), type: field.role || field.type || field.tag || '',
            action: actions.find(action => action.ref === field.ref)?.action || 'leave',
            outcome: 'error', error: 'frame-unavailable', before: null, after: null, signals: [],
          });
        }
      }
      if (message.type === 'replay') return {...result, filled, fields, trace};
      let traceFile, traceError;
      try { traceFile = (await api('/api/fill/traces', trace)).file; }
      catch (error) { traceError = traceFailure(error); }
      return {...result, filled, fields, traceFile, traceError};
    } catch (error) {
      if (message.type !== 'attach') {
        trace.errors.push('fill-failed');
        try {
          const saved = await api('/api/fill/traces', trace);
          error.message += ` Diagnostic trace: ${saved.file}`;
        } catch (traceError) { error.message += ` ${traceFailure(traceError)}`; }
      }
      throw error;
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
