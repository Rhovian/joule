/** Local hints only; the operator can correct metadata and the detected kind.
 * astro@7.3.8/package.json exports rendering APIs, not Job-text extraction.
 * Recognised headings delimit questions; no extra AI call or parser dependency.
 */
export function readPaste(text: string) {
  const lines = text.trim().split(/\r?\n/);
  const heading = lines.findIndex(line => /^(?:application|screening) questions\s*:?\s*$/i.test(line.trim()) || /^you will be asked to answer/i.test(line.trim()));
  const description = (heading < 0 ? lines : lines.slice(0, heading)).join('\n').trim();
  const questions = heading < 0 ? [] : lines.slice(heading + 1).map(line => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '')).filter(Boolean);
  const first = lines.find(line => line.trim())?.trim() ?? '';
  const title = (lines.find(line => /^title:/i.test(line.trim()))?.replace(/^\s*title:\s*/i, '') ?? first).slice(0, 500);
  const company = lines.find(line => /^company:/i.test(line.trim()))?.replace(/^\s*company:\s*/i, '') ?? (lines[1]?.includes(' · ') ? lines[1].split(' · ')[0].trim() : '');
  const questionOnly = heading === 0 || (Boolean(text.trim()) && heading < 0 && lines.filter(line => line.trim()).every(line => /\?\s*$/.test(line)));
  return { description, questions, title, company, kind: questionOnly ? 'questions' : /\bupwork\b/i.test(text) ? 'upwork' : 'posting' };
}
