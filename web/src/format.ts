export const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function age(stamp: string, relative = false) {
  const date = new Date(stamp), hours = Math.max(0, Math.floor((Date.now() - date.getTime()) / 3600000));
  return `<time datetime="${escape(stamp)}" title="${escape(stamp)}">${Number.isNaN(hours) ? '—' : hours < 1 ? relative ? 'just now' : 'now' : `${hours < 24 ? `${hours}h` : hours < 168 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours / 168)}w`}${relative ? ' ago' : ''}`}</time>`;
}
