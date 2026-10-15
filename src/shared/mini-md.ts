/**
 * The small markdown the release notes use, as data the window turns into elements: `#`/`##`/`###` headings, `-` bullets, paragraphs,
 * `**bold**`, `*italic*` and `` `code` ``. Nothing is ever HTML (the text stays text) and nothing is unbounded: the input is clipped, every line is
 * clipped, and the inline scan only moves forward (a marker with no closer is plain text, and the search for one is not repeated).
 */
export interface Inline {
  text: string;
  style?: 'b' | 'i' | 'code';
}
export type MdBlock = { kind: 'h'; level: 2 | 3; inline: Inline[] } | { kind: 'p'; inline: Inline[] } | { kind: 'ul'; items: Inline[][] };

const MAX_TEXT = 200_000;
const MAX_LINE = 4096;

/** `**bold**`, `*italic*` and `` `code` `` in one line of text. Inside bold (`base`) only code is looked for, inside italic bold and code (the pieces keep the style, or take bold's): two levels at most. */
function inline(s: string, base?: 'b' | 'i'): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  let i = 0;
  let noBold = false; // (a search that found no closer is not repeated: that keeps the scan linear)
  let noCode = false;
  let noItalic = false;
  const flush = () => {
    if (plain) out.push(base ? { text: plain, style: base } : { text: plain });
    plain = '';
  };
  if (base) noItalic = true;
  if (base === 'b') noBold = true;
  while (i < s.length) {
    if (s.startsWith('**', i) && !noBold) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push(...inline(s.slice(i + 2, end), 'b'));
        i = end + 2;
        continue;
      }
      if (end < 0) noBold = true;
    } else if (s[i] === '*' && !s.startsWith('**', i) && s[i + 1] !== ' ' && !noItalic) {
      let end = s.indexOf('*', i + 1);
      while (end >= 0 && s[end + 1] === '*') end = s.indexOf('*', end + 2); // (a ** pair inside is bold, never the closer)
      if (end > i + 1) {
        flush();
        out.push(...inline(s.slice(i + 1, end), 'i'));
        i = end + 1;
        continue;
      }
      if (end < 0) noItalic = true;
    } else if (s[i] === '`' && !noCode) {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ text: s.slice(i + 1, end), style: 'code' });
        i = end + 1;
        continue;
      }
      if (end < 0) noCode = true;
    }
    plain += s[i++];
  }
  flush();
  return out;
}

export function parseMd(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: Inline[][] | null = null;
  const closePara = () => {
    if (para.length) blocks.push({ kind: 'p', inline: inline(para.join(' ')) });
    para = [];
  };
  const closeList = () => {
    if (list) blocks.push({ kind: 'ul', items: list });
    list = null;
  };
  for (const raw of md.slice(0, MAX_TEXT).split('\n')) {
    const line = raw.slice(0, MAX_LINE).replace(/\r$/, '');
    const h = /^(#{1,3}) +(\S.*)$/.exec(line);
    const li = /^[-*] +(\S.*)$/.exec(line);
    if (!line.trim()) (closePara(), closeList());
    else if (h) {
      closePara();
      closeList();
      blocks.push({ kind: 'h', level: h[1]!.length === 3 ? 3 : 2, inline: inline(h[2]!.trim()) });
    } else if (li) {
      closePara();
      (list ??= []).push(inline(li[1]!.trim()));
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  closePara();
  closeList();
  return blocks;
}
