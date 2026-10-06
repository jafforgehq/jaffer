import type { ComponentChildren, VNode } from 'preact';

/**
 * A small, safe markdown renderer for agent replies. It builds Preact nodes directly (no innerHTML),
 * so model output can never inject markup. Supports what terminal-style answers need:
 * headings, lists, fenced code, inline code, bold/italic, links, blockquotes, rules.
 */

function inline(text: string, keyBase: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\((?:https?:\/\/)[^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${n++}`;
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (m[2] || m[3]) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (m[4]) out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    else if (m[5]) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      const href = lm[2]!;
      out.push(
        <a key={key} href={href} onClick={(e) => (e.preventDefault(), void window.jaffer.openExternal(href))} title={href}>
          {lm[1]}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }): VNode {
  return (
    <div class="codeblock">
      <div class="codeblock-bar">
        <span>{lang || 'text'}</span>
        <button class="linkish" onClick={() => void navigator.clipboard.writeText(code)}>
          Copy
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }): VNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: VNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or EOF while streaming)
      blocks.push(<CodeBlock key={k++} code={body.join('\n')} lang={fence[1]} />);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(4, h[1]!.length) + 1;
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={k++}>{inline(h[2]!, `h${k}`)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: VNode[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        const content = lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        items.push(<li key={items.length}>{inline(content, `li${k}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push(<blockquote key={k++}>{inline(q.join(' '), `q${k}`)}</blockquote>);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={k++} />);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^```/.test(lines[i]!) && !/^(#{1,4})\s+/.test(lines[i]!) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!) && !/^>\s?/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={k++}>{inline(para.join('\n'), `p${k}`)}</p>);
  }
  return <div class="md">{blocks}</div>;
}
