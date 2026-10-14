/* Plain JS is deliberate: design D14 makes this an unpacked extension without a build. */
(() => {
  function allowed(url) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
      return !['upwork.com', 'linkedin.com', 'indeed.com', 'glassdoor.com']
        .some(domain => host === domain || host.endsWith(`.${domain}`));
    } catch { return false; }
  }
  function createWorker(document) {
    const window = document.defaultView;
    let controls = [];
    // jsdom 26.1.0 implements DOM primitives, not form semantics or layout:
    // https://github.com/jsdom/jsdom/tree/26.1.0#pretending-to-be-a-visual-browser
    function visible(element) {
      if (!element.isConnected || element.disabled || element.readOnly || element.matches(':disabled') || element.type === 'hidden') return false;
      for (let node = element; node?.nodeType === 1; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      return element.type === 'file' || [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
    }
    function label(element) {
      const explicit = [...document.querySelectorAll('label[for]')].find(node => node.htmlFor === element.id && element.id);
      const wrapping = element.closest('label');
      const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      return (explicit?.textContent || wrapping?.textContent || labelled || element.getAttribute('aria-label') ||
        element.closest('fieldset')?.querySelector('legend')?.textContent || element.getAttribute('placeholder') || '').trim();
    }
    const radios = element => [...document.querySelectorAll('input[type=radio]')].filter(other =>
      other.form === element.form && (element.name ? other.name === element.name : other === element));
    function describe() {
      controls = [...document.querySelectorAll('input,textarea,select')].filter(element =>
        visible(element) && !['submit', 'button', 'reset', 'image'].includes(element.type) &&
        (element.type !== 'radio' || radios(element).find(visible) === element));
      return controls.map((element, ref) => ({
        ref, tag: element.tagName.toLowerCase(), type: element.type || '',
        role: element.getAttribute('role') || '', name: element.name || '', id: element.id || '',
        autocomplete: element.autocomplete || '', label: element.type === 'radio' ? element.closest('fieldset')?.querySelector('legend')?.textContent.trim() || label(element) : label(element), required: element.required,
        options: element.type === 'radio' ? radios(element).filter(visible).map(option => ({value: option.value, label: label(option)})) :
          element.tagName === 'SELECT' ? [...element.options].map(option => ({value: option.value, label: option.textContent.trim()})) : [],
        accept: element.accept || '', maxlength: element.maxLength >= 0 ? element.maxLength : null,
      }));
    }
    function apply(actions, expected) {
      // Compare fresh page data after a slow Ask; navigation/edits must not retarget the answer.
      if (expected && JSON.stringify(describe()[expected.ref]) !== JSON.stringify(expected)) return {filled: 0};
      let filled = 0;
      for (const action of actions) {
        let element = controls[action.ref];
        if (action.action === 'set' && element?.type === 'radio') {
          if (radios(element).some(option => option.checked)) continue;
          element = radios(element).find(option => option.value === action.value && visible(option));
          if (!element) continue;
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set.call(element, true);
          for (const type of ['input', 'change']) element.dispatchEvent(new window.Event(type, {bubbles: true}));
          element.style.outline = '2px solid #25854a';
          filled++;
          continue;
        }
        // Recheck immediately before writing; operator typing in this tiny window is an accepted design race (§6).
        if (action.action !== 'set' || typeof action.value !== 'string' || !element || !visible(element) ||
          element.value !== '' || element.getAttribute('role') === 'combobox' ||
          !['text', 'email', 'tel', 'url', 'search', 'textarea', 'select-one'].includes(element.type)) continue;
        if (element.tagName === 'SELECT' && ![...element.options].some(option => option.value === action.value && !option.disabled && !option.closest('optgroup[disabled]'))) continue;
        const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype :
          element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element,
          element.maxLength >= 0 ? action.value.slice(0, element.maxLength) : action.value);
        for (const type of ['input', 'change']) element.dispatchEvent(new window.Event(type, {bubbles: true}));
        element.style.outline = '2px solid #25854a';
        filled++;
      }
      return {filled};
    }
    function upload(ref, file) {
      const element = controls[ref];
      if (!element || element.type !== 'file' || !visible(element) || element.files.length || element.value) return {filled: 0};
      const bytes = Uint8Array.from(window.atob(file.base64), char => char.charCodeAt(0));
      const transfer = new window.DataTransfer();
      transfer.items.add(new window.File([bytes], file.name, {type: 'application/pdf'}));
      element.files = transfer.files;
      for (const type of ['input', 'change']) element.dispatchEvent(new window.Event(type, {bubbles: true}));
      element.style.outline = '2px solid #25854a';
      return {filled: 1};
    }
    return {describe, apply, upload};
  }
  if (typeof module !== 'undefined') module.exports = {createWorker, allowed};
  if (typeof chrome !== 'undefined' && typeof document !== 'undefined' && allowed(location.href)) {
    // executeScript runs again on each gesture; keep one listener/worker per isolated world.
    // https://developer.chrome.com/docs/extensions/reference/api/scripting#method-executeScript
    if (globalThis.jouleFillInstalled) return;
    globalThis.jouleFillInstalled = true;
    const worker = createWorker(document);
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== chrome.runtime.id || sender.tab || !allowed(location.href)) return;
      if (message.type === 'describe') {
        chrome.runtime.sendMessage({type: 'frame', request: message.request, fields: worker.describe()})
          .then(() => respond({ok: true}), () => respond({ok: false}));
        return true;
      }
      if (message.type === 'apply') respond(worker.apply(message.actions, message.expected));
      if (message.type === 'upload') respond(worker.upload(message.ref, message.file));
    });
    // Registration survives SW suspension in storage.session; a new frame replaces its own entry.
    chrome.runtime.sendMessage({type: 'register'}).catch(() => {});
  }
})();
