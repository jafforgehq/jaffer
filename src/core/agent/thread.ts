import fs from 'node:fs';
import type { JafferPaths } from '../../shared/paths';
import { ensureDir, readJsonl, uid, writeFileAtomic, writeJsonl } from '../../shared/util';
import type { ContentBlock, Message, ThreadItem } from './types';

const CTX_OPEN = '<jaffer-context>';
const TERM_OPEN = '<terminal>';
const SUMMARY_OPEN = '<session-summary>';

/** Rough token estimate (~3.6 chars/token for mixed prose + code). Good enough to decide when to compact. */
export function estimateTokens(messages: Message[], systemChars = 0): number {
  let chars = systemChars;
  for (const m of messages) chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  return Math.ceil(chars / 3.6);
}

export function stripThinking(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return m;
    const kept = (m.content as ContentBlock[]).filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    return kept.length === m.content.length ? m : { ...m, content: kept.length ? kept : [{ type: 'text', text: '(…)' }] };
  });
}

/** True for a user message that starts a turn (carries text), as opposed to one that only returns tool results. */
export function isTurnStart(m: Message): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  return (m.content as ContentBlock[]).some((b) => b.type === 'text');
}

/**
 * The single, never-reset conversation. Persisted append-only as JSONL so a crash loses at most
 * the message in flight. Thinking blocks are only kept while a turn is in progress; completed
 * turns are stored without them, which is always a valid history for the API.
 */
export class Thread {
  messages: Message[] = [];
  summary = '';
  private shown = new Set<string>();

  constructor(private paths: JafferPaths) {
    ensureDir(paths.sessionDir);
    this.load();
  }

  private load(): void {
    const rows = readJsonl<{ t: 'm'; m: Message } | { t: 'reset'; messages: Message[]; summary: string }>(this.paths.thread);
    for (const r of rows) {
      if (r.t === 'm') this.messages.push(r.m);
      else if (r.t === 'reset') {
        this.messages = r.messages;
        this.summary = r.summary;
      }
    }
    this.messages = this.repair(this.messages);
    try {
      this.summary = this.summary || fs.readFileSync(this.paths.threadSummary, 'utf8');
    } catch {
      /* no summary yet */
    }
  }

  /**
   * A crash mid-turn can leave an assistant tool_use without its tool_result (invalid for the API).
   * Trim any trailing incomplete exchange so the thread always resumes cleanly.
   */
  private repair(msgs: Message[]): Message[] {
    const out = [...msgs];
    for (;;) {
      const last = out[out.length - 1];
      if (!last) break;
      if (last.role === 'assistant' && Array.isArray(last.content) && (last.content as ContentBlock[]).some((b) => b.type === 'tool_use')) {
        out.pop();
        continue;
      }
      if (last.role === 'user' && !isTurnStart(last)) {
        out.pop();
        continue;
      }
      break;
    }
    // A dangling user message at the end (no reply) is fine: the next turn simply appends to it.
    return out;
  }

  push(m: Message): void {
    this.messages.push(m);
    ensureDir(this.paths.sessionDir);
    fs.appendFileSync(this.paths.thread, JSON.stringify({ t: 'm', m }) + '\n', { mode: 0o600 });
  }

  /** Replace history after compaction (rewrites the log with a single checkpoint record). */
  replace(messages: Message[], summary: string): void {
    this.messages = messages;
    this.summary = summary;
    this.shown.clear();
    writeJsonl(this.paths.thread, [{ t: 'reset', messages, summary }]);
    writeFileAtomic(this.paths.threadSummary, summary, 0o600);
  }

  /** Remove thinking blocks from completed turns and persist that state. */
  settle(): void {
    const stripped = stripThinking(this.messages);
    if (stripped.some((m, i) => m !== this.messages[i])) {
      this.messages = stripped;
      writeJsonl(this.paths.thread, [{ t: 'reset', messages: this.messages, summary: this.summary }]);
    }
  }

  // ------------------------------------------------------------ memory delta bookkeeping

  wasShown(id: string): boolean {
    return this.shown.has(id);
  }
  markShown(ids: string[]): void {
    for (const id of ids) this.shown.add(id);
  }
  get shownCount(): number {
    return this.shown.size;
  }

  // ------------------------------------------------------------ UI projection

  items(limit = 400): ThreadItem[] {
    const items: ThreadItem[] = [];
    const calls = new Map<string, Extract<ThreadItem, { kind: 'tool' }>>();
    let n = 0;
    for (const m of this.messages) {
      const id = `t${n++}`;
      if (m.role === 'user') {
        if (typeof m.content === 'string') {
          pushUser(items, id, m.content);
          continue;
        }
        for (const b of m.content as ContentBlock[]) {
          if (b.type === 'text') pushUser(items, id, b.text);
          else if (b.type === 'tool_result') {
            const t = calls.get(b.tool_use_id);
            if (t) {
              t.output = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => ('text' in c ? c.text : '')).join('') : '';
              t.isError = b.is_error === true;
            }
          }
        }
      } else {
        if (typeof m.content === 'string') {
          if (m.content.trim()) items.push({ kind: 'assistant', id, text: m.content });
          continue;
        }
        let text = '';
        for (const b of m.content as ContentBlock[]) {
          if (b.type === 'text') text += b.text;
          else if (b.type === 'tool_use') {
            if (text.trim()) {
              items.push({ kind: 'assistant', id: `${id}a`, text });
              text = '';
            }
            const item: Extract<ThreadItem, { kind: 'tool' }> = { kind: 'tool', id: b.id, name: b.name, summary: '', input: b.input };
            calls.set(b.id, item);
            items.push(item);
          }
        }
        if (text.trim()) items.push({ kind: 'assistant', id: `${id}z`, text });
      }
    }
    return items.slice(-limit);
  }
}

function pushUser(items: ThreadItem[], id: string, text: string): void {
  const t = text.trim();
  if (!t || t.startsWith(CTX_OPEN) || t.startsWith(TERM_OPEN)) return;
  if (t.startsWith(SUMMARY_OPEN)) {
    items.push({ kind: 'summary', id, text: t.replace(/<\/?session-summary>/g, '').trim() });
    return;
  }
  items.push({ kind: 'user', id, text: t });
}

export const newId = (p: string): string => uid(p);
