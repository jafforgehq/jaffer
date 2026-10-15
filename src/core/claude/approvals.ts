import { isSensitiveCommand, redactText } from '../../shared/redact';
import { isSensitivePath } from '../../shared/sensitive-path';
import { COMMAND_HEAD } from '../../shared/process-badge';

/**
 * Answering Claude Code's permission prompt from the notification (`claude.approvals`, off by default). The pure pieces: how long the
 * blocking `PermissionRequest` hook waits for a click, what it prints for Claude Code to read, and the one line the notification and the
 * window show about the request, with whether that line IS the request (only then is Allow offered). Nothing of a request is kept: the
 * detail is built from `tool_input` and the input is dropped.
 */

/** How long the hook waits for a click (Claude Code gives it 25 s); then it prints nothing and Claude Code's own prompt appears. */
export const APPROVAL_WAIT_MS = 20_000;

/** A request waiting for the person, as the daemon tells the app (in memory only). `allowable`: the detail is the whole request, as it is. */
export interface ApprovalView {
  id: string;
  sessionId: string;
  tool: string;
  detail: string;
  allowable: boolean;
  expiresAt: number;
}

/** The line shown about a request, and whether it is the request verbatim (nothing redacted, hidden, cut or left out). */
export interface ApprovalDetail {
  text: string;
  complete: boolean;
}

const MAX_DETAIL = 120;
const MAX_TOOL = 64;
/** Room for the cut marker `… (+N chars)` (N has at most 9 digits). */
const CUT_ROOM = 21;
/**
 * What a notification must not hide: format and control characters (bidi marks and overrides, zero widths, the soft hyphen, the tag
 * characters, ...), line and paragraph separators, the combining grapheme joiner, variation selectors, the Mongolian free variation
 * selectors, the Khmer inherent vowels and the Hangul fillers. Each run shows as one placeholder, and the line is then not the request.
 */
const HIDDEN = /[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180d\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]+/gu;
const NONE: ApprovalDetail = { text: '', complete: false };

/** What Claude Code reads from the hook's stdout: allow, or deny with a message; anything else than exactly 'allow' is a deny. */
export function decisionOutput(decision: 'allow' | 'deny'): string {
  const d = decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Jaffer' };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
}

/**
 * `s` (already cut to a head and redacted) as shown: a newline is a visible ⏎, a run of hidden characters one �, and past 120 characters it
 * is cut with `… (+N chars)` (`unread`: what was never read past the head). Complete only when `exact` and none of that happened.
 */
function shown(s: string, unread: number, exact: boolean): ApprovalDetail {
  const lines = s.replace(/\r\n|\r|\n/g, '\u23ce');
  const t = lines.replace(HIDDEN, '\ufffd');
  if (t.length <= MAX_DETAIL && unread <= 0) return { text: t, complete: exact && t === s };
  const keep = MAX_DETAIL - CUT_ROOM;
  return { text: `${t.slice(0, keep)}\u2026 (+${unread + t.length - keep} chars)`, complete: false };
}

/** The tool's name as shown: text only, no hidden characters, at most 64 characters. */
export function approvalTool(name: unknown): string {
  return typeof name === 'string' ? redactText(name.slice(0, 4 * MAX_TOOL)).replace(HIDDEN, '').trim().slice(0, MAX_TOOL) : '';
}

const field = (input: unknown, key: string): string => {
  const v = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : '';
};

/** Text read from a head of `s` (`max`), redacted, as shown. */
function redactedHead(s: string, max: number): ApprovalDetail {
  if (!s) return NONE;
  const head = s.slice(0, max);
  const red = redactText(head); // (redacted before the cut: half a secret never shows)
  return shown(red, s.length - head.length, red === head);
}

/**
 * A file's path, relative to the folder Claude works in or with ~ for the home folder; a sensitive one is never shown (`isSensitivePath`
 * fails closed past 4096 characters).
 */
function filePath(p: string, where: { cwd?: string; home?: string }): ApprovalDetail {
  if (!p) return NONE;
  const q = p.slice(0, 4097);
  if (isSensitivePath(q)) return { text: 'a key or credential file', complete: false };
  const cwd = (where.cwd ?? '').slice(0, 4096).replace(/\/+$/, '');
  const home = (where.home ?? '').slice(0, 4096).replace(/\/+$/, '');
  // (relative only inside a real folder: at the root, `etc/hosts` would read as a path in some other folder)
  const rel = cwd && q.startsWith(`${cwd}/`) ? q.slice(cwd.length + 1) : home && q.startsWith(`${home}/`) ? `~/${q.slice(home.length + 1)}` : q;
  return redactedHead(rel, 4097);
}

/**
 * The line under "Claude asks to use <tool>", and whether it is the whole request as it is (Allow is offered only then): the command for
 * Bash (redacted; a sensitive one not at all), the path for the file tools (never complete for the ones that write), the url for
 * WebFetch, and nothing for any other tool (never complete). At most 120 characters; the input is cut before it is read.
 */
export function approvalDetail(tool: string, input: unknown, where: { cwd?: string; home?: string } = {}): ApprovalDetail {
  switch (tool) {
    case 'Bash': {
      const cmd = field(input, 'command');
      if (cmd && isSensitiveCommand(cmd.slice(0, COMMAND_HEAD))) return { text: 'a sensitive command (not shown)', complete: false };
      return redactedHead(cmd, COMMAND_HEAD);
    }
    case 'Read':
      return filePath(field(input, 'file_path'), where);
    // the tools that write: the path shows, never complete (what they would write is not shown, and a settings, rc or hook file can widen
    // what Claude may do): Deny or "Answer in terminal" only
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return { ...filePath(field(input, 'file_path'), where), complete: false };
    case 'NotebookEdit':
      return { ...filePath(field(input, 'notebook_path'), where), complete: false };
    case 'WebFetch':
      return redactedHead(field(input, 'url'), 4096);
  }
  return NONE;
}
