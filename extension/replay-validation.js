// Playwright 1.56.1 routing cannot intercept page Service Worker requests; block those
// at context creation, and WebSockets before navigation. Abort routing + offline mode
// protect the Submit pass; the final local joule write happens outside this browser.
// https://github.com/microsoft/playwright/blob/v1.56.1/docs/src/network.md
async function submitValidation(context, page) {
  let blocked = 0;
  await context.route('**/*', route => { blocked++; return route.abort('blockedbyclient'); });
  const outcome = status => ({status, network_blocked: true, blocked_requests: blocked});
  await context.setOffline(true);
  let buttons = [];
  for (const frame of page.frames()) {
    const candidates = frame.getByRole('button', {name: /^(submit(?: (?:my )?application)?|send application|apply(?: now)?)$/i});
    for (const button of await candidates.all()) {
      if (await button.isVisible() && await button.isEnabled()) buttons.push(button);
    }
  }
  if (buttons.length > 1) {
    // A sticky Apply button may only scroll to the form. Prefer its actual native submit control.
    const submits = [];
    for (const button of buttons) if (await button.evaluate(node => node.type === 'submit' && !!node.form)) submits.push(button);
    if (submits.length) buttons = submits;
  }
  if (buttons.length !== 1) return outcome(buttons.length ? 'ambiguous-submit-control' : 'no-submit-control');
  try {
    await buttons[0].click({timeout: 5000, noWaitAfter: true});
    // No framework-settled primitive exists; bound the post-click observation window.
    await page.waitForTimeout(1000);
    return outcome('clicked');
  } catch { return outcome('submit-click-failed'); }
}

// Runs in the extension Options document, then observes each original Chrome frame.
// No values, validationMessage, text, URLs, or raw exceptions leave the page.
async function collectValidation({tabId, trace}) {
  for (const frameId of [...new Set(trace.fields.map(row => row.ref[0]))]) {
    const fields = trace.fields.filter(row => row.ref[0] === frameId);
    try {
      const [result] = await chrome.scripting.executeScript({target: {tabId, frameIds: [frameId]}, args: [fields], func: rows => {
        const visible = node => node && !node.hidden && node.getAttribute('aria-hidden') !== 'true' &&
          getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length;
        return rows.map(row => {
          const matches = row.selector ? document.querySelectorAll(row.selector) : [];
          if (matches.length !== 1) return ['submit-field-unavailable'];
          const element = matches[0], signals = [];
          const root = element.closest('.ashby-application-form-field-entry, .application-question, fieldset') ||
            (row.type === 'combobox' && element.closest('[class*=container]')) || element.parentElement;
          const native = [element, ...(row.type === 'combobox' ? root.querySelectorAll('input[required]') : [])];
          if (native.some(node => node.validity?.valueMissing)) signals.push('submit-native-value-missing');
          if (native.some(node => node.willValidate && !node.validity.valid && !node.validity.valueMissing)) signals.push('submit-native-invalid');
          if (element.getAttribute('aria-invalid') === 'true' || root.getAttribute('aria-invalid') === 'true') signals.push('submit-aria-invalid');
          const ids = `${element.getAttribute('aria-errormessage') || ''} ${element.getAttribute('aria-describedby') || ''}`;
          const errors = [...ids.split(/\s+/).map(id => document.getElementById(id)),
            ...root.querySelectorAll('[role=alert], [class*="error" i]')].filter(visible);
          if (errors.some(node => /required|missing|must (?:enter|select|provide)|cannot be (?:blank|empty)/i.test(node.textContent))) signals.push('submit-required-error');
          else if (errors.some(node => node.textContent.trim())) signals.push('submit-validation-error');
          return signals;
        });
      }});
      fields.forEach((row, index) => { row.signals.push(...result.result[index]); });
    } catch { fields.forEach(row => row.signals.push('submit-field-unavailable')); }
  }
  return trace;
}
module.exports = {submitValidation, collectValidation};
