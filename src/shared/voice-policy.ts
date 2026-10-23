import { COMMAND_HEAD } from './process-badge';

/** Typing rule for dictated text (spec "Typing rule", conditions 1, 2, 3 and 5; 4 is `cleanDictation`). `claudeState` is the watcher's ClaudeState. */
export function mayType(i: { voiceOn: boolean; startPane: string; activePane: string; claudeState: string | undefined; typing: boolean }): { ok: true } | { ok: false; why: string } {
  if (!i.voiceOn) return { ok: false, why: 'Voice is off.' };
  if (i.startPane !== i.activePane) return { ok: false, why: 'The terminal changed while you spoke.' };
  if (i.claudeState === undefined || i.claudeState === 'ended') return { ok: false, why: 'Claude Code is not running in this terminal.' };
  if (i.claudeState !== 'idle') return { ok: false, why: 'Claude is busy or waiting for you.' };
  if (i.typing) return { ok: false, why: 'Another dictation is being typed.' };
  return { ok: true };
}

const MAX_DICTATION = 500;
const HEAD = 4 * COMMAND_HEAD;
// Every quantifier below is bounded or ends on a literal the run cannot contain, so each pass is linear.
const CSI = /\x1b\[[0-?]{0,64}[ -/]{0,16}[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]{0,256}(?:\x07|\x1b\\)/g;
const BREAKS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g'); // C0, DEL, C1 (ESC included), line/paragraph separators
const FORMAT = /\p{Cf}/gu;
const ANNOTATION = /\[[^\]]{0,100}\]|\([^)]{0,100}\)|\*[^*]{0,100}\*/g;

/** Text safe to type into Claude's prompt: no control or format character, no newline, one line, at most 500 characters; '' for Whisper noise. */
export function cleanDictation(raw: string): string {
  const s = String(raw)
    .slice(0, HEAD)
    .replace(CSI, ' ')
    .replace(OSC, ' ')
    .replace(BREAKS, ' ')
    .replace(FORMAT, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(s.replace(ANNOTATION, ' '))) return ''; // only [BLANK_AUDIO], (music), *sighs*, ♪ or punctuation
  return Array.from(s.slice(0, 4 * MAX_DICTATION)).slice(0, MAX_DICTATION).join('').trim();
}
