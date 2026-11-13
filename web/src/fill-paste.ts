import '../../extension/fill-paste.js';
declare global { var readPaste: (text: string) => { description: string; questions: string[]; title: string; company: string; kind: string }; }
export const readPaste = globalThis.readPaste;
