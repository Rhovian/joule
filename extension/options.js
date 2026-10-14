function normalizeOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('Use an http(s) origin without credentials, path, query or fragment');
  }
  return url.origin;
}
async function connect(chrome, value, fetcher = fetch) {
  const origin = normalizeOrigin(value);
  // Chrome match patterns cover all ports; request only this hostname and scheme.
  const url = new URL(origin);
  if (!await chrome.permissions.request({origins: [`${url.protocol}//${url.hostname}/*`]})) throw Error('Host permission was declined');
  const response = await fetcher(`${origin}/api/jobs?unscored=false`);
  if (!response.ok) throw Error(`joule HTTP ${response.status}`);
  if (!Array.isArray(await response.json())) throw Error('Unexpected Jobs response');
  await chrome.storage.local.set({origin});
  return 'Connected to joule';
}
if (typeof module !== 'undefined') module.exports = {connect, normalizeOrigin};
if (typeof document !== 'undefined') {
  const input = document.getElementById('origin');
  chrome.storage.local.get('origin').then(config => { input.value = config.origin || ''; });
  document.getElementById('test').addEventListener('click', async () => {
    const button = document.getElementById('test'), status = document.getElementById('status');
    button.disabled = true;
    try { status.textContent = await connect(chrome, input.value); }
    catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
}
