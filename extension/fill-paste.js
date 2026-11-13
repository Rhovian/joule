/** Local hints only; the operator can correct metadata and the detected kind.
 * Shared by Fill a Job and the extension; astro@7.3.8 exports rendering, not Job-text extraction.
 * Recognised headings delimit questions; no extra AI call or parser dependency.
 */
function readPaste(text) {
  const lines = text.trim().split(/\r?\n/);
  const upworkQuestions = /^you will be asked to answer/i;
  const heading = lines.findIndex(line => /^(?:application|screening) questions\s*:?\s*$/i.test(line.trim()) || upworkQuestions.test(line.trim()));
  const description = (heading < 0 ? lines : lines.slice(0, heading)).join('\n').trim();
  const questions = heading < 0 ? [] : lines.slice(heading + 1).map(line => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '')).filter(Boolean);
  const first = lines.find(line => line.trim())?.trim() ?? '';
  const title = (lines.find(line => /^title:/i.test(line.trim()))?.replace(/^\s*title:\s*/i, '') ?? first).slice(0, 500);
  const company = lines.find(line => /^company:/i.test(line.trim()))?.replace(/^\s*company:\s*/i, '') ?? (lines[1]?.includes(' · ') ? lines[1].split(' · ')[0].trim() : '');
  const questionOnly = heading === 0 || (Boolean(text.trim()) && heading < 0 && lines.filter(line => line.trim()).every(line => /\?\s*$/.test(line)));
  const upwork = (heading >= 0 && upworkQuestions.test(lines[heading].trim())) || lines.slice(0, 3).some(line => /^\s*(?:upwork\b|(?:https?:\/\/)?(?:www\.)?upwork\.com(?:\/|$)|source:\s*upwork\b)/i.test(line));
  return { description, questions, title, company, kind: questionOnly ? 'questions' : upwork ? 'upwork' : 'posting' };
}

if (typeof window !== 'undefined') window.readPaste = readPaste;
if (typeof module !== 'undefined') module.exports = {readPaste};
