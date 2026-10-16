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
    const comboOptions = new WeakMap();
    const normalized = text => text.trim().toLowerCase().replace(/\s+/g, ' ');
    const required = element => element.required || element.getAttribute('aria-required') === 'true' ||
      (element.getAttribute('role') === 'combobox' && /[*✱]/.test(label(element)));
    const selection = element => element.parentElement?.parentElement?.querySelector('[class*="singleValue"], [class*="single-value"]');
    const emptyCombo = element => visible(element) && !element.value && !selection(element);
    const key = (element, value) => element.dispatchEvent(new window.KeyboardEvent('keydown', {key: value, bubbles: true}));
    const options = element => (element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '')
      .split(/\s+/).flatMap(id => [...(document.getElementById(id)?.querySelectorAll('[role=option]') || [])])
      .filter(option => visible(option) && option.getAttribute('aria-disabled') !== 'true');
    // react-select 5.10.2 owns selection state; input.value alone cannot select an option.
    // Its onKeyDown, renderInput and renderMenu expose keyboard + ARIA hooks:
    // https://github.com/JedWatson/react-select/blob/react-select%405.10.2/packages/react-select/src/Select.tsx
    // jsdom 26.1.0 supplies MutationObserver, but no wait-for-widget-state helper:
    // https://github.com/jsdom/jsdom/tree/26.1.0#unimplemented-parts-of-the-web-platform
    function waitFor(predicate) {
      return new Promise(resolve => {
        let timer;
        const observer = new window.MutationObserver(check);
        function finish(value) { observer.disconnect(); window.clearTimeout(timer); resolve(value); }
        function check() { const value = predicate(); if (value) finish(value); }
        observer.observe(document, {subtree: true, childList: true, attributes: true});
        timer = window.setTimeout(() => finish(null), 1500);
        check();
      });
    }
    async function prepare() {
      for (const element of document.querySelectorAll('[role=combobox]')) {
        if (!required(element) || !emptyCombo(element) || /\b(eeo|demograph\w*|disab\w*|veteran\w*|pronouns?|criminal|consent|attest\w*|privacy|race|ethnic\w*|hispanic|latino|gender|sex|sexual|agree|agreement|certify|certification)\b/i.test(label(element))) continue;
        element.focus();
        key(element, 'ArrowDown');
        await waitFor(() => options(element).length);
        const available = options(element);
        // The API permits 100 choices; larger menus use a Profile answer + exact search.
        comboOptions.set(element, (available.length <= 100 ? available : []).map(option => ({
          value: option.textContent.trim().slice(0, 200), label: option.textContent.trim().slice(0, 200),
        })));
        key(element, 'Escape');
        element.blur();
      }
    }
    async function applyComboboxes(actions, expected) {
      if (expected && JSON.stringify(describe()[expected.ref]) !== JSON.stringify(expected)) return {filled: 0};
      let filled = 0;
      for (const action of actions) {
        const element = controls[action.ref];
        if (element?.getAttribute('role') !== 'combobox') { filled += apply([action]).filled; continue; }
        if (action.action !== 'set' || typeof action.value !== 'string' || !required(element) || !emptyCombo(element)) continue;
        element.focus();
        key(element, 'ArrowDown');
        // Async city widgets need a query before options exist; never accept free text as a selection.
        if (!element.readOnly) {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, action.value);
          element.dispatchEvent(new window.Event('input', {bubbles: true}));
        }
        const matching = () => options(element).filter(option => normalized(option.textContent) === normalized(action.value));
        await waitFor(() => matching().length);
        const matches = matching();
        // Recheck after async loading, including operator edits and newly selected values.
        if (visible(element) && !selection(element) && (!element.value || element.value === action.value) && matches.length === 1) {
          // D12 revisit: activate only a matched ARIA option, never a page button (§2 no-submit).
          const activation = new window.MouseEvent('click', {bubbles: true, cancelable: true});
          activation.preventDefault(); // No link navigation or form-submit default action, even on hostile markup.
          matches[0].dispatchEvent(activation);
          if (await waitFor(() => selection(element) && normalized(selection(element).textContent) === normalized(action.value))) {
            element.style.outline = '2px solid #25854a';
            filled++;
          }
        }
        if (element.isConnected) {
          if (element.value === action.value) {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, '');
            element.dispatchEvent(new window.Event('input', {bubbles: true}));
          }
          if (element.getAttribute('aria-expanded') === 'true') key(element, 'Escape');
          element.blur();
        }
      }
      return {filled};
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
        autocomplete: element.autocomplete || '', label: element.type === 'radio' ? element.closest('fieldset')?.querySelector('legend')?.textContent.trim() || label(element) : label(element), required: required(element),
        options: element.type === 'radio' ? radios(element).filter(visible).map(option => ({value: option.value, label: label(option)})) :
          element.tagName === 'SELECT' ? [...element.options].map(option => ({value: option.value, label: option.textContent.trim()})) : comboOptions.get(element) || [],
        accept: element.accept || '', maxlength: element.maxLength >= 0 ? element.maxLength : null,
      }));
    }
    function apply(actions, expected) {
      if (actions.some(action => action.action === 'set' && controls[action.ref]?.getAttribute('role') === 'combobox' && required(controls[action.ref]))) return applyComboboxes(actions, expected);
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
    function answer(expected) {
      if (JSON.stringify(describe()[expected.ref]) !== JSON.stringify(expected)) throw Error('Fill again before Save');
      const element = controls[expected.ref];
      if (!element || !visible(element)) throw Error('Field unavailable');
      const selected = element.type === 'radio' ? radios(element).find(option => option.checked && visible(option)) : null;
      const value = element.getAttribute('role') === 'combobox' ? selection(element)?.textContent.trim() :
        element.type === 'radio' ? selected && label(selected) :
        element.tagName === 'SELECT' ? element.value && element.selectedOptions[0]?.textContent.trim() :
          ['text', 'email', 'tel', 'url', 'search', 'textarea'].includes(element.type) ? element.value : null;
      if (!value) throw Error('Answer the field before saving');
      return {question: expected.label, answer: value};
    }
    return {describe, prepare, apply, upload, answer};
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
        worker.prepare().then(() => chrome.runtime.sendMessage({type: 'frame', request: message.request, fields: worker.describe()}))
          .then(() => respond({ok: true}), () => respond({ok: false}));
        return true;
      }
      if (message.type === 'apply') {
        Promise.resolve(worker.apply(message.actions, message.expected)).then(respond, () => respond({filled: 0}));
        return true;
      }
      if (message.type === 'upload') respond(worker.upload(message.ref, message.file));
      if (message.type === 'answer') {
        try { respond(worker.answer(message.expected)); }
        catch (error) { respond({error: error.message}); }
      }
    });
    // Registration survives SW suspension in storage.session; a new frame replaces its own entry.
    chrome.runtime.sendMessage({type: 'register'}).catch(() => {});
  }
})();
