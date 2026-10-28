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
    let controls = [], descriptors;
    // Captured Ashby widgets (vN, autocomplete w/T/E, text Pk/SP): no native select/radio API.
    // https://cdn.ashbyprd.com/frontend_non_user/c2a7197c175f484890751b5bbf8e105e2cd08e16/assets/index-BIeWnsEH.js
    const fieldRoot = element => element.closest('.ashby-application-form-field-entry');
    const leverTitle = element => element.closest('.application-question')?.querySelector('.application-label');
    const leverLocation = element => element.matches('#location-input.location-input') && !!leverTitle(element);
    const combo = element => element.getAttribute('role') === 'combobox' || leverLocation(element);
    const role = element => leverLocation(element) ? 'combobox' : element.getAttribute('role') || '';
    const question = element => leverTitle(element)?.textContent.trim() ||
      element.closest('fieldset')?.querySelector('legend, :scope > .ashby-application-form-question-title')?.textContent.trim() || label(element);
    const group = element => element.matches('.ashby-application-form-input-yesno');
    const autocomplete = element => element.matches('.ashby-application-form-input-autocomplete');
    const controlName = element => element.name || ripplingUpload(element)?.name || fieldRoot(element)?.dataset.fieldPath || '';
    const controlType = element => group(element) ? 'button-group' : element.type || '';
    const allControls = () => [...document.querySelectorAll('input,textarea,select,.ashby-application-form-input-yesno')]
      .filter(element => !element.closest('#candidatePronounsCheckboxes'))
      .filter(element => !element.closest('.ashby-application-form-input-yesno') || group(element));
    const choices = element => [...element.querySelectorAll('button[data-option]')];
    const pressed = element => choices(element).find(button => button.getAttribute('aria-pressed') === 'true');
    function activate(element, type = 'click') {
      // Operator-authorized Yes/No buttons and exact widget options only; cancel browser submit defaults.
      const event = new window.MouseEvent(type, {bubbles: true, cancelable: true});
      event.preventDefault();
      element.dispatchEvent(event);
    }
    // jsdom 26.1.0 implements DOM primitives, not form semantics or layout:
    // https://github.com/jsdom/jsdom/tree/26.1.0#pretending-to-be-a-visual-browser
    function gemUpload(element) {
      // Captured jobs.gem.com upload: hidden native input inside a visible presentation dropzone.
      // https://jobs.gem.com/apartment-list/am9icG9zdDoWMj3GYH-CbSnQ86QyPJlD
      if (window.location.hostname !== 'jobs.gem.com' || element.type !== 'file') return null;
      const dropzone = element.parentElement;
      const title = dropzone?.parentElement?.parentElement?.parentElement?.querySelector(':scope > span[class^="bodyImportant-"]');
      return dropzone?.matches('[role="presentation"][tabindex="0"]') && title ? {dropzone, title} : null;
    }
    function ripplingUpload(element) {
      // Captured 2026-10-28: native input is display:none; its visible label owns the ARIA title.
      // https://ats.rippling.com/d-wave-quantum/jobs/e8e5f61e-4338-4908-986b-354348a0e954/apply
      // jsdom 26.1.0 exposes attributes/layout primitives, not ATS upload descriptors:
      // https://github.com/jsdom/jsdom/tree/26.1.0/lib/jsdom/living
      if (window.location.hostname !== 'ats.rippling.com' || element.type !== 'file') return null;
      const dropzone = element.parentElement, name = dropzone?.dataset.testid;
      if (!dropzone?.matches('label') || !['resume', 'cover_letter'].includes(name) ||
          element.dataset.testid !== `input-${name}`) return null;
      const title = (dropzone.getAttribute('aria-labelledby') || '').split(/\s+/)
        .filter(id => id.endsWith('-label')).map(id => document.getElementById(id)).find(Boolean);
      return title ? {dropzone, title, name} : null;
    }
    function visible(element) {
      if (!element.isConnected || element.disabled || element.readOnly || element.matches(':disabled') || element.type === 'hidden') return false;
      const upload = gemUpload(element) || ripplingUpload(element);
      if (upload) return !element.hidden && element.getAttribute('aria-hidden') !== 'true' && visible(upload.dropzone);
      for (let node = element; node?.nodeType === 1; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      return element.type === 'file' || [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
    }
    function label(element) {
      const upload = ripplingUpload(element);
      if (upload) return upload.title.textContent.trim();
      if (element.type !== 'radio' && leverTitle(element)) return leverTitle(element).textContent.trim();
      const explicit = [...document.querySelectorAll('label[for]')].find(node => node.htmlFor === element.id && element.id);
      const wrapping = element.closest('label');
      const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      return (explicit?.textContent || wrapping?.textContent || labelled || element.getAttribute('aria-label') ||
        element.closest('fieldset')?.querySelector('legend')?.textContent || fieldRoot(element)?.querySelector('label')?.textContent || gemUpload(element)?.title.textContent || element.getAttribute('placeholder') || '').trim();
    }
    const comboOptions = new WeakMap();
    const committedLabels = new WeakMap();
    const normalized = text => text.trim().toLowerCase().replace(/\s+/g, ' ');
    const required = element => element.required || element.getAttribute('aria-required') === 'true' ||
      !!leverTitle(element)?.querySelector('.required') ||
      (element.getAttribute('role') === 'combobox' && /[*✱]/.test(label(element))) ||
      !!fieldRoot(element)?.querySelector('label[class*="_required_"]');
    const selection = element => element.parentElement?.parentElement?.querySelector('[class*="singleValue"], [class*="single-value"]');
    const selectedText = element => leverLocation(element) ?
      (element.closest('.application-field').querySelector('#selected-location')?.value ? element.value : '') : autocomplete(element) ?
      (element.getAttribute('aria-expanded') === 'false' ? element.value : '') : selection(element)?.textContent.trim();
    const emptyCombo = element => visible(element) && !element.value && !selection(element);
    // Greenhouse's K/fa wrapper controls menuIsOpen on keyup.code, independently of react-select.
    // https://job-boards.cdn.greenhouse.io/assets/entry.client-ClhIqXFJ.js
    const key = (element, value) => {
      for (const type of ['keydown', 'keyup']) element.dispatchEvent(new window.KeyboardEvent(type, {
        key: value, code: value, bubbles: true, cancelable: true,
      }));
    };
    const options = element => (leverLocation(element) ? [...element.closest('.application-field').querySelectorAll('.dropdown-location')] :
      (element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '')
      .split(/\s+/).flatMap(id => [...(document.getElementById(id)?.querySelectorAll('[role=option]') || [])])
    )
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
    const sensitive = element => /\b(eeo|demograph\w*|disab\w*|veteran\w*|pronouns?|criminal|consent|attest\w*|privacy|race|ethnic\w*|hispanic|latino|gender|sex|sexual|agree|agreement|certify|certification)\b/i.test(question(element));
    async function prepare() {
      for (const element of document.querySelectorAll('[role=combobox]')) {
        if (autocomplete(element)) continue; // Ashby location results exist only after a search query.
        if (!required(element) || !emptyCombo(element) || sensitive(element)) continue;
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
        if (!element || !combo(element)) { filled += (await apply([action])).filled; continue; }
        if (action.action !== 'set' || typeof action.value !== 'string' || !required(element) || !emptyCombo(element)) continue;
        element.focus();
        key(element, 'ArrowDown');
        // Async city widgets need a query before options exist; never accept free text as a selection.
        if (!element.readOnly) {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, action.value);
          element.dispatchEvent(new window.Event('input', {bubbles: true}));
          // Lever's keydown starts its debounced search; mousedown commits the selected location.
          // https://jobs.lever.co/js/retrieveLocations.js (captured 2026-10-16)
          if (leverLocation(element)) key(element, 'End');
        }
        const matching = () => options(element).filter(option => normalized(option.textContent) === normalized(action.value));
        await waitFor(() => matching().length);
        const matches = matching();
        let committed = false;
        // Recheck after async loading, including operator edits and newly selected values.
        if (visible(element) && !selection(element) && !selectedText(element) && (!element.value || element.value === action.value) && matches.length === 1) {
          // D12 revisit: activate only an exact matched widget option (§2 no-submit).
          activate(matches[0], leverLocation(element) ? 'mousedown' : 'click');
          // Greenhouse renders a country option (United States +1) as only +1 after selection.
          // https://job-boards.cdn.greenhouse.io/assets/entry.client-ClhIqXFJ.js (Oo/Do)
          // Confirm a committed value exists; the exact unique option was checked above.
          if (await waitFor(() => selectedText(element))) {
            committed = true;
            if (selection(element)) committedLabels.set(element, {markup: selection(element).outerHTML, label: matches[0].textContent.trim()});
            element.style.outline = '2px solid #25854a';
            filled++;
          }
        }
        if (element.isConnected) {
          if (!committed && element.value && element.value !== action.value) continue;
          if (!committed && !selectedText(element) && element.value === action.value) {
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
      controls = allControls().filter(element =>
        visible(element) && !['submit', 'button', 'reset', 'image'].includes(element.type) &&
        (element.type !== 'radio' || radios(element).find(visible) === element));
      return descriptors = controls.map((element, ref) => ({
        ref, tag: element.tagName.toLowerCase(), type: controlType(element),
        role: role(element), name: controlName(element), id: element.id || '',
        autocomplete: element.autocomplete || '', label: element.type === 'radio' ? question(element) : label(element), required: required(element),
        // Sensitive choices are never matched or asked; descriptive survey options can exceed API bounds.
        // jsdom 26.1.0 only exposes DOM text, not ATS question semantics (source linked above).
        options: sensitive(element) ? [] : group(element) ? choices(element).map(option => ({value: option.dataset.option, label: option.textContent.trim()})) : element.type === 'radio' ? radios(element).filter(visible).map(option => ({value: option.value, label: label(option)})) :
          element.tagName === 'SELECT' ? [...element.options].map(option => ({value: option.value, label: option.textContent.trim()})) : comboOptions.get(element) || [],
        accept: element.accept || '', maxlength: element.maxLength >= 0 ? element.maxLength : null,
      }));
    }
    async function applyWidgets(actions, expected) {
      if (expected && JSON.stringify(describe()[expected.ref]) !== JSON.stringify(expected)) return {filled: 0};
      let filled = 0;
      for (const action of actions) {
        const element = controls[action.ref];
        if (!element || action.action !== 'set') continue;
        if (group(element)) {
          const buttons = choices(element);
          if (!required(element) || !visible(element) || sensitive(element) || pressed(element) || buttons.length !== 2 ||
            !['yes', 'no'].every(value => buttons.some(button => button.dataset.option === value))) continue;
          const button = buttons.find(button => button.dataset.option === action.value && visible(button));
          if (!button) continue;
          activate(button);
          if (await waitFor(() => button.getAttribute('aria-pressed') === 'true')) { element.style.outline = '2px solid #25854a'; filled++; }
        } else {
          const commitOnBlur = element.matches('.ashby-application-form-input-text');
          if (commitOnBlur && (!visible(element) || element.value !== '')) continue;
          if (commitOnBlur) element.focus();
          filled += apply([action], undefined, true).filled;
          // With Resource Timing, the wrapper waits for the debounced save before blurring.
          // Keep the local blur path for DOM-only fixtures that do not implement network observation.
          if (commitOnBlur && !remoteSave(element)) { await Promise.resolve(); element.blur(); }
        }
      }
      return {filled};
    }
    const remoteSave = element => !!window.PerformanceObserver && !!element && !!fieldRoot(element);
    let saveBlocked = false;
    function watchSave() {
      // Ashby qRe/NN saves local state after 500ms; overlapping mutations can lose other fields.
      // Captured source: https://cdn.ashbyprd.com/frontend_non_user/cffa242202eae98df17fda905c8a6012577a34bd/assets/index-CJB0DO-6.js
      // Resource Timing is shared with the page even in Chrome's isolated content-script world.
      // No runtime dependency supplies a remote-form-save barrier; jsdom 26.1.0 has no networking/layout:
      // https://github.com/jsdom/jsdom/tree/26.1.0#unimplemented-parts-of-the-web-platform
      const since = window.performance.now();
      let resolve, timer;
      const done = new Promise(complete => { resolve = complete; });
      const finish = result => { observer.disconnect(); window.clearTimeout(timer); resolve(result); };
      const observer = new window.PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const url = new URL(entry.name);
          if (entry.startTime < since || url.origin !== window.location.origin ||
            url.pathname !== '/api/non-user-graphql' || url.searchParams.get('op') !== 'ApiSetFormValue') continue;
          finish(entry.responseStatus === undefined || (entry.responseStatus >= 200 && entry.responseStatus < 300));
        }
      });
      observer.observe({type: 'resource'});
      timer = window.setTimeout(() => finish(false), 5000);
      return {done, cancel: () => finish(null)};
    }
    async function applyAshby(actions, expected) {
      let filled = 0;
      for (const action of actions) {
        const element = controls[action.ref], saving = action.action === 'set' && remoteSave(element);
        if (saving && saveBlocked) throw Error('Previous form save is unconfirmed');
        const watch = saving ? watchSave() : null;
        try {
          const result = await applyNow([action], expected);
          if (result.filled && watch) {
            const writtenValue = element.value;
            if (!await watch.done) { saveBlocked = true; throw Error('Form save is unconfirmed'); }
            // Let the completed mutation update savedValue before blur; otherwise blur saves twice.
            await new Promise(resolve => window.setTimeout(resolve, 0));
            if (document.activeElement === element && element.value === writtenValue) element.blur();
          }
          filled += result.filled;
        } finally { watch?.cancel(); }
      }
      return {filled};
    }
    function apply(actions, expected, committing = false) {
      if (!committing && actions.some(action => action.action === 'set' && remoteSave(controls[action.ref]))) return applyAshby(actions, expected);
      return applyNow(actions, expected, committing);
    }
    function applyNow(actions, expected, committing = false) {
      if (actions.some(action => action.action === 'set' && controls[action.ref] && combo(controls[action.ref]) && required(controls[action.ref]))) return applyComboboxes(actions, expected);
      if (!committing && actions.some(action => { const element = controls[action.ref]; return element && (group(element) || element.matches('.ashby-application-form-input-text')); })) return applyWidgets(actions, expected);
      // Compare fresh page data after a slow Ask; navigation/edits must not retarget the answer.
      if (expected && JSON.stringify(describe()[expected.ref]) !== JSON.stringify(expected)) return {filled: 0};
      let filled = 0;
      for (const action of actions) {
        let element = controls[action.ref];
        if (element && sensitive(element)) continue;
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
          element.value !== '' || combo(element) ||
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
    function selector(element) {
      if (element.id) return `[id=${JSON.stringify(element.id)}]`;
      const path = [];
      for (let node = element; node?.nodeType === 1; node = node.parentElement) {
        const peers = [...(node.parentElement?.children || [node])].filter(peer => peer.tagName === node.tagName);
        path.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${peers.indexOf(node) + 1})`);
      }
      return path.join(' > ');
    }
    // Read validity only: checkValidity/reportValidity would fire validation events.
    // https://developer.mozilla.org/en-US/docs/Web/API/ValidityState/valueMissing
    async function traceApply(actions) {
      // Keep the descriptor/ref snapshot used for Match; async rendering must not retarget writes.
      const fields = descriptors || describe(), nodes = [...controls], rows = [];
      let filled = 0;
      const present = element => element && (group(element) ? !!pressed(element) :
        element.type === 'radio' ? radios(element).some(option => option.checked) :
        combo(element) ? !!selectedText(element) : element.type === 'checkbox' ? element.checked :
        element.type === 'file' ? !!element.files.length : !!element.value);
      for (const field of fields) {
        const action = actions.find(action => action.ref === field.ref) || {action: 'leave'};
        const element = nodes[field.ref], before = !!present(element);
        const row = {ref: field.ref, selector: selector(element),
          label: field.label.slice(0, 300), type: field.role || field.type || field.tag,
          action: action.action, outcome: 'skipped', error: null, before, after: false, signals: []};
        try {
          const result = await apply([action]);
          filled += result.filled;
          row.outcome = result.filled ? 'written' : action.action === 'set' ? (before ? 'preserved' : 'not-written') : 'skipped';
          // Only focus fields this Fill wrote, to commit ordinary controlled inputs too.
          if (result.filled && !remoteSave(element) && !group(element) && !combo(element)) {
            element.focus(); await Promise.resolve(); element.blur();
          }
        } catch { row.outcome = 'error'; row.error = 'apply-failed'; }
        rows.push(row);
      }
      // DOM has no framework-settled primitive; Ashby's pinned bundle above debounces 500ms.
      await new Promise(resolve => window.setTimeout(resolve, 750));
      for (const row of rows) {
        const original = nodes[row.ref], field = fields[row.ref];
        const matches = field.id ? [...document.querySelectorAll('[id]')].filter(node => node.id === field.id) :
          field.name ? allControls().filter(node => controlName(node) === field.name) : [original].filter(node => node.isConnected);
        const element = original.isConnected ? original : matches.length === 1 ? matches[0] : null;
        if (!element) { row.signals.push('field-detached'); continue; }
        row.after = !!present(element);
        const ids = `${element.getAttribute('aria-errormessage') || ''} ${element.getAttribute('aria-describedby') || ''}`;
        const root = fieldRoot(element) || element.closest('.application-question, fieldset') ||
          (combo(element) && element.closest('[class*=container]')) || element.parentElement;
        // react-select's required surrogate lives beside its visible combobox input.
        // Pinned renderRequiredInput: react-select 5.10.2 Select.tsx (source linked above).
        const native = [element, ...(combo(element) ? root.querySelectorAll('input[required]') : [])];
        if (native.some(node => node.validity?.valueMissing)) row.signals.push('native-value-missing');
        if (element.getAttribute('aria-invalid') === 'true' || root.getAttribute('aria-invalid') === 'true') row.signals.push('aria-invalid');
        const errors = [...ids.split(/\s+/).map(id => document.getElementById(id)),
          ...root.querySelectorAll('[role=alert], [class*="error" i]')].filter(node => node && visible(node));
        // Categories only: error text may echo an answer.
        if (errors.some(node => /required|missing|must (?:enter|select|provide)|cannot be (?:blank|empty)/i.test(node.textContent))) row.signals.push('required-error');
        if (field.required && !row.after) row.signals.push('required-empty');
        if (row.outcome === 'written' && !row.after) row.signals.push('value-lost');
      }
      return {filled, trace: rows};
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
      if (!controls.length) throw Error('Save refused: this document has not been scanned; run Fill again.');
      // React may replace an input and lose its WeakMap option cache. Match stable question identity,
      // not DOM ordering/options/requiredness that legitimately change when the operator answers.
      // react-select's renderInput/renderFormField: https://github.com/JedWatson/react-select/blob/react-select%405.10.2/packages/react-select/src/Select.tsx
      const candidates = expected.id || expected.name ? allControls()
        .filter(node => expected.id ? node.id === expected.id : controlName(node) === expected.name)
        .filter(node => node.type !== 'radio' || radios(node).find(visible) === node) :
        [controls[expected.ref]].filter(node => node?.isConnected);
      if (candidates.length !== 1) throw Error(`Save refused: field is ${candidates.length ? 'ambiguous' : 'missing'}; run Fill again.`);
      const element = candidates[0];
      if (!visible(element)) throw Error('Save refused: field is hidden, disabled or read-only.');
      const identity = {tag: element.tagName.toLowerCase(), type: controlType(element),
        role: role(element), name: controlName(element), id: element.id || '',
        label: element.type === 'radio' ? question(element) : label(element)};
      for (const key of Object.keys(identity)) {
        if (identity[key] !== expected[key]) throw Error(`Save refused: field ${key} changed; run Fill again.`);
      }
      const selected = element.type === 'radio' ? radios(element).find(option => option.checked && visible(option)) : null;
      const committed = committedLabels.get(element);
      const value = group(element) ? pressed(element)?.textContent.trim() : combo(element) ?
        (committed && committed.markup === selection(element)?.outerHTML ? committed.label : selectedText(element)) :
        element.type === 'radio' ? selected && label(selected) :
        element.tagName === 'SELECT' ? element.value && element.selectedOptions[0]?.textContent.trim() :
          ['text', 'email', 'tel', 'url', 'search', 'textarea'].includes(element.type) ? element.value : null;
      if (!value) throw Error('Answer the field before saving');
      return {question: expected.label, answer: value};
    }
    return {describe, prepare, apply, traceApply, upload, answer};
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
      if (message.type === 'trace-apply') {
        worker.traceApply(message.actions).then(respond, () => respond({filled: 0, error: 'trace-apply-failed'}));
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
