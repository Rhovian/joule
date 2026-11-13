import type { Job } from './types';
import { escape } from './format';

export function external(url: unknown, label: unknown) {
  try {
    const parsed = new URL(String(url));
    if (['http:', 'https:'].includes(parsed.protocol)) return `<a href="${escape(parsed.href)}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>`;
  } catch { /* Invalid links remain text. */ }
  return escape(label);
}
export function descriptionText(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node instanceof Element && /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(node.tagName)) return '';
    const block = node instanceof Element && /^(P|BR|LI|DIV|H[1-6])$/.test(node.tagName);
    return `${block ? '\n' : ''}${Array.from(node.childNodes, walk).join('')}${block ? '\n' : ''}`;
  };
  return walk(doc.body).replace(/\n[\t ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export const dismiss = (j: Job, shortcut = false) => `<button data-action="state" data-state="${j.state === 'dismissed' ? 'seen' : 'dismissed'}" data-id="${escape(j.id)}">${shortcut ? '<kbd>d</kbd>' : ''}${j.state === 'dismissed' ? 'Restore' : 'Dismiss'}</button>`;
export const applied = (j: Job, label = j.state === 'applied' ? 'Unmark applied' : 'Mark applied', shortcut = false) => `<button data-action="state" data-state="${j.state === 'applied' ? 'seen' : 'applied'}" data-id="${escape(j.id)}">${shortcut ? '<kbd>a</kbd>' : ''}${escape(label)}</button>`;
export const score = (j: Pick<Job, 'score' | 'score_stale'>) => `<span class="score ${j.score === null ? 'unscored' : j.score >= 90 ? 'high' : j.score >= 80 ? 'good' : j.score >= 70 ? 'mid' : 'low'}${j.score_stale && j.score !== null ? ' stale' : ''}" title="${j.score_stale && j.score !== null ? 'Fit Score out of date' : 'Fit Score'}">${escape(j.score ?? '—')}</span>`;
export const links = (j: Job) => `<div class="source-links">Primary · ${external(j.link, j.source)}${j.duplicates.map(d => `<span>Duplicate · ${external(d.link, d.source)}</span>`).join('')}</div>`;
export const flags = (j: Job) => `<span class="tag state ${['new', 'seen', 'dismissed', 'applied'].includes(j.state) ? j.state : ''}">${escape(j.state)}</span>${j.score_stale ? '<span class="flag">score out of date</span>' : ''}${j.content_purged_at ? '<span class="flag">expired; open on Upwork</span>' : ''}${j.location_unclear ? '<span class="flag">location unclear</span>' : ''}${j.filtered_reason ? '<span class="tag filtered">Filtered</span>' : ''}`;
export function pay(j: Job) {
  const values = [j.pay_min, j.pay_max].filter((n): n is number => n !== null);
  return values.length ? `${[...new Set(values)].join('–')} ${j.pay_currency ?? ''}${j.pay_period ? ` /${j.pay_period}` : ''}` : '';
}
