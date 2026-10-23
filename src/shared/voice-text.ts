import { COMMAND_HEAD } from './process-badge';
import { redactText } from './redact';

const HEAD = 4 * COMMAND_HEAD;
const MAX_SPOKEN = 1500;
const SENTENCE_WINDOW = 300;
// Every quantifier is bounded or stops at a character the run cannot contain; a token start is anchored by a lookbehind, so no pass is quadratic.
const INLINE_CODE = /`[^`]*`/g;
const URL = /https?:\/\/\S+/g;
const PATH = /(?<![\w./~-])(?:(?:~|\.{1,2})?(?:\/[\w.@-]+)+|[\w.@-]+(?:\/[\w.@-]+)*\/[\w.@-]+\.\w+)(?::\d+)?/g;
const TAG = /<\/?[A-Za-z][^<>\n]{0,200}>/g;
const LINK = /\[([^\]\n]{0,200})\]\([^)\n]{0,2000}\)/g;

const isFence = (l: string) => /^\s{0,3}(?:```|~~~)/.test(l);
const isToolLine = (l: string) => /^(?:@@|\$ |\||\+|-(?!\s)|---)/.test(l.trimStart());

/** The prose of a reply, fit to be read aloud: no code, paths, URLs, diffs or markup; at most ~1,500 characters; '' when nothing is left. */
export function speakable(reply: string): string {
  const out: string[] = [];
  let fenced = false;
  let indented = false;
  let prevBlank = true;
  for (const line of String(reply).slice(0, HEAD).split('\n')) {
    if (isFence(line)) { fenced = !fenced; prevBlank = false; continue; }
    if (fenced) continue;
    const blank = line.trim() === '';
    if (blank) { prevBlank = true; continue; }
    indented = /^(?: {4}|\t)/.test(line) && (prevBlank || indented);
    prevBlank = false;
    if (indented || isToolLine(line)) continue;
    out.push(
      line
        .replace(LINK, '$1')
        .replace(INLINE_CODE, ' ').replace(URL, ' ').replace(PATH, ' ').replace(TAG, ' ')
        .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/, '')
        .replace(/\*+|(?<!\w)_+|_+(?!\w)/g, ''),
    );
  }
  const text = redactText(out.join(' ').replace(/\s+/g, ' ').trim());
  return cut(text);
}

function cut(t: string): string {
  if (t.length <= MAX_SPOKEN) return t;
  const head = t.slice(0, MAX_SPOKEN);
  for (let i = head.length - 1; i >= MAX_SPOKEN - SENTENCE_WINDOW; i--) {
    if ('.!?'.includes(head[i]!) && (i + 1 >= t.length || t[i + 1] === ' ')) return head.slice(0, i + 1);
  }
  const sp = head.lastIndexOf(' ');
  return (sp > 0 ? head.slice(0, sp) : head.replace(/[\ud800-\udbff]$/, '')).trim();
}
