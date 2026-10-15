import { isSensitiveCommand, redactText } from '../../shared/redact';
import { isSensitivePath } from '../../shared/sensitive-path';
import { COMMAND_HEAD } from '../../shared/process-badge';

/**
 * Answering Claude Code's permission prompt from the notification (`claude.approvals`, off by default). The pure pieces: how long the
 * blocking `PermissionRequest` hook waits for a click, what it prints for Claude Code to read, and the one line the notification and the
 * window show about the request. Nothing of a request is kept: the detail is built from `tool_input` and the input is dropped.
 */

/** How long the hook waits for a click (Claude Code gives it 25 s); then it prints nothing and Claude Code's own prompt appears. */
export const APPROVAL_WAIT_MS = 20_000;

/** A request waiting for the person, as the daemon tells the app (in memory only). */
export interface ApprovalView {
  id: string;
  sessionId: string;
  tool: string;
  detail: string;
  expiresAt: number;
}

const MAX_DETAIL = 120;
const MAX_TOOL = 64;
/** Control characters, and the invisible ones that turn or hide text (a notification must show what it says). */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g;

/** What Claude Code reads from the hook's stdout: allow, or deny with a message; anything else than exactly 'allow' is a deny. */
export function decisionOutput(decision: 'allow' | 'deny'): string {
  const d = decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Jaffer' };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });
}

/** One line: hidden characters and runs of white space become one space, cut to `max` with an ellipsis. */
function oneLine(s: string, max: number): string {
  const t = s.replace(HIDDEN, ' ').replace(/ {2,}/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The tool's name as shown: text only, no hidden characters, at most 64 characters. */
export function approvalTool(name: unknown): string {
  return typeof name === 'string' ? redactText(name.slice(0, 4 * MAX_TOOL)).replace(HIDDEN, '').trim().slice(0, MAX_TOOL) : '';
}

const field = (input: unknown, key: string): string => {
  const v = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : '';
};

/** A file's name, unless the path is a sensitive one (`isSensitivePath` fails closed past 4096 characters). */
function fileName(p: string): string {
  if (!p || isSensitivePath(p)) return '';
  return redactText(p.replace(/\/+$/, '').split('/').pop() ?? '');
}

/**
 * The line under "Claude asks to use <tool>": the command for Bash (redacted; a sensitive one not at all), the file's name for the file
 * tools, the host for WebFetch, and nothing for any other tool. One line, at most 120 characters; the input is cut before it is read.
 */
export function approvalDetail(tool: string, input: unknown): string {
  let s = '';
  switch (tool) {
    case 'Bash': {
      const head = field(input, 'command').slice(0, COMMAND_HEAD);
      s = isSensitiveCommand(head) ? '' : redactText(head); // (redacted before the cut: half a secret never shows)
      break;
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'Read':
      s = fileName(field(input, 'file_path').slice(0, 4097));
      break;
    case 'NotebookEdit':
      s = fileName(field(input, 'notebook_path').slice(0, 4097));
      break;
    case 'WebFetch':
      try {
        s = new URL(field(input, 'url').slice(0, 2048)).hostname;
      } catch {
        s = '';
      }
      break;
  }
  return oneLine(s, MAX_DETAIL);
}
