import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CursorState } from './episodes';
import type { CommandEpisode, Episode, ExternalAgentEpisode, MemoryKind, NoteEpisode, ProposedOp } from './types';

/**
 * Offline reflection: deterministic rules that turn raw episodes into memory proposals.
 * No network, no model. It gives Jaffer a working memory out of the box and keeps
 * learning when no API key is configured. The LLM reflector builds on top of this.
 */

type Candidates = CursorState['candidates'];

export interface HeuristicEnv {
  platform?: string;
  arch?: string;
  shell?: string;
  osRelease?: string;
  home?: string;
}

export interface HeuristicInput {
  episodes: Episode[];
  candidates: Candidates;
  now?: number;
  env?: HeuristicEnv;
}

export interface HeuristicOutput {
  ops: ProposedOp[];
  candidates: Candidates;
}

const TRIVIAL = new Set(['cd', 'ls', 'll', 'la', 'pwd', 'clear', 'cat', 'echo', 'which', 'man', 'open', 'vim', 'nvim', 'vi', 'nano', 'code', 'cursor', 'touch', 'mkdir', 'rm', 'cp', 'mv', 'source', 'export', 'exit', 'history', 'less', 'head', 'tail', 'grep', 'rg', 'find', 'fd', 'sleep', 'true', 'false', 'z', 'j', 'type', 'alias', 'unset', 'pbcopy', 'pbpaste', 'tree', 'wc', 'diff']);

const TASK_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'test', re: /^(?:(?:npm|pnpm|yarn|bun)(?: run)? test(?::\w+)?|npx (?:vitest|jest)\b.*|vitest\b.*|jest\b.*|pytest\b.*|python3? -m pytest\b.*|cargo test\b.*|go test\b.*|swift test\b.*|make test\b.*|just test\b.*|mvn test\b.*|gradle(?:w)? test\b.*|\.\/gradlew test\b.*|rspec\b.*|bundle exec rspec\b.*|mix test\b.*|dotnet test\b.*)$/ },
  { label: 'build', re: /^(?:(?:npm|pnpm|yarn|bun)(?: run)? build(?::\w+)?|cargo build\b.*|go build\b.*|swift build\b.*|make(?: build| all)?|just build\b.*|xcodebuild\b.*|mvn (?:package|install)\b.*|gradle(?:w)? build\b.*|\.\/gradlew build\b.*|tsc\b.*|dotnet build\b.*|docker build\b.*)$/ },
  { label: 'lint', re: /^(?:(?:npm|pnpm|yarn|bun)(?: run)? lint(?::\w+)?|eslint\b.*|npx eslint\b.*|ruff(?: check)?\b.*|flake8\b.*|cargo clippy\b.*|golangci-lint\b.*|swiftlint\b.*|make lint\b.*|rubocop\b.*)$/ },
  { label: 'format', re: /^(?:(?:npm|pnpm|yarn|bun)(?: run)? (?:format|fmt|prettier)\b.*|prettier\b.*|npx prettier\b.*|cargo fmt\b.*|gofmt\b.*|black\b.*|ruff format\b.*|swiftformat\b.*|make fmt\b.*)$/ },
  { label: 'typecheck', re: /^(?:(?:npm|pnpm|yarn|bun)(?: run)? (?:typecheck|type-check|check-types|tsc)\b.*|mypy\b.*|pyright\b.*|cargo check\b.*|npx tsc\b.*)$/ },
  { label: 'dev', re: /^(?:(?:npm|pnpm|yarn|bun)(?: run)? (?:dev|start|serve)(?::\w+)?|cargo run\b.*|go run\b.*|python3? manage\.py runserver\b.*|rails s(?:erver)?\b.*|make (?:run|dev|serve)\b.*|just (?:dev|run)\b.*|docker compose up\b.*|docker-compose up\b.*|swift run\b.*)$/ },
];

const PM_RE = /^(npm|pnpm|yarn|bun|npx|pnpx|bunx)\b/;
const PMS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

function pmOf(cmd: string): (typeof PMS)[number] | null {
  const m = PM_RE.exec(cmd.trim());
  if (!m) return null;
  const t = m[1]!;
  if (t === 'npx') return 'npm';
  if (t === 'pnpx') return 'pnpm';
  if (t === 'bunx') return 'bun';
  return t as (typeof PMS)[number];
}

export function displayPath(p: string, home = os.homedir()): string {
  return p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

function projectName(p: string | undefined): string {
  return p ? path.basename(p) : 'this machine';
}

function scopeOf(project: string | undefined): string {
  return project ? `project:${project}` : 'global';
}

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

function bump(c: Candidates, key: string, now: string, n = 1, payload?: unknown): number {
  const cur = c[key] ?? { count: 0, last: now };
  cur.count += n;
  cur.last = now;
  if (payload !== undefined) cur.payload = payload;
  c[key] = cur;
  return cur.count;
}

function firstTokens(cmd: string, n = 2): string {
  return cmd.trim().split(/\s+/).slice(0, n).join(' ');
}

function isCmd(e: Episode): e is CommandEpisode {
  return e.t === 'cmd';
}

const DIRECTIVE_RE =
  /\b(always|never|from now on|going forward|make sure (?:to|you)|do not|don't|dont|please don't|stop (?:using|doing|adding|writing)|prefer|i prefer|i like|i use|we use|our (?:convention|standard|rule)|remember (?:that|to)|default to|instead of)\b/i;
const CORRECTION_RE = /^\s*(?:no[,.! ]|nope\b|wrong\b|that'?s (?:not|wrong)|not (?:that|like that|what)|actually[, ]|stop\b|don'?t\b|do not\b|undo\b|revert\b|instead\b|i said\b|i meant\b|why did you\b|you (?:should|shouldn'?t|forgot|missed|broke)\b)/i;

export function detectCorrection(text: string): boolean {
  return CORRECTION_RE.test(text.trim().slice(0, 200)) || /\b(?:that'?s not what i|i (?:already )?told you|i asked (?:you )?(?:to|for)|use .{1,40} instead)\b/i.test(text.slice(0, 400));
}

/** Pull durable-sounding directives ("always use pnpm") out of something the user wrote. */
export function extractDirectives(text: string): { text: string; kind: MemoryKind; personal: boolean }[] {
  const out: { text: string; kind: MemoryKind; personal: boolean }[] = [];
  const cleaned = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, (m) => m); // keep inline code
  const sentences = cleaned
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let s of sentences) {
    if (s.length < 12 || s.length > 220 || s.endsWith('?')) continue;
    if (!DIRECTIVE_RE.test(s)) continue;
    s = s.replace(/^(?:and|also|ok(?:ay)?|so|please|btw|hey|yes|yeah|no)[,\s]+/i, '').trim();
    if (s.length < 12) continue;
    const lower = s.toLowerCase();
    const personal = /\b(?:i|my|me|i'm|i've)\b/.test(lower);
    let kind: MemoryKind = 'preference';
    if (/^(?:never|don'?t|do not|stop)\b|\bnever\b/.test(lower)) kind = 'lesson';
    else if (/\b(?:we use|our (?:convention|standard|rule)|this (?:repo|project|codebase))\b/.test(lower)) kind = 'convention';
    out.push({ text: s.charAt(0).toUpperCase() + s.slice(1), kind, personal });
  }
  return out.slice(0, 3);
}

export function runHeuristics(input: HeuristicInput): HeuristicOutput {
  const now = input.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const cands: Candidates = JSON.parse(JSON.stringify(input.candidates ?? {}));
  const ops: ProposedOp[] = [];
  const home = input.env?.home ?? os.homedir();

  const cmds = input.episodes.filter(isCmd);
  const userCmds = cmds;

  // ---- environment ------------------------------------------------------
  if (input.env && (input.env.platform || input.env.shell)) {
    const os_ = input.env.platform === 'darwin' ? `macOS${input.env.osRelease ? ` (Darwin ${input.env.osRelease})` : ''}` : (input.env.platform ?? 'unknown OS');
    const shell = input.env.shell ? path.basename(input.env.shell) : undefined;
    ops.push({
      op: 'add',
      kind: 'environment',
      scope: 'global',
      key: 'h:env',
      text: `Machine: ${os_}${input.env.arch ? `, ${input.env.arch}` : ''}${shell ? `, default shell ${shell}` : ''}.`,
      confidence: 0.9,
      source: 'heuristic',
    });
  }

  // ---- active projects -------------------------------------------------
  const perProject = new Map<string, number>();
  for (const c of userCmds) {
    const p = c.project;
    if (p && p !== home) perProject.set(p, (perProject.get(p) ?? 0) + 1);
  }
  for (const [p, n] of perProject) bump(cands, `proj:${p}`, nowIso, n);
  const projEntries = Object.entries(cands)
    .filter(([k, v]) => k.startsWith('proj:') && v.count >= 8)
    .map(([k, v]) => ({ path: k.slice(5), count: v.count, last: v.last }))
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1))
    .slice(0, 5);
  if (projEntries.length > 0) {
    ops.push({
      op: 'add',
      kind: 'project',
      scope: 'global',
      key: 'h:projects',
      text: `Most active projects: ${projEntries.map((p) => `${path.basename(p.path)} (${displayPath(p.path, home)})`).join(', ')}.`,
      confidence: 0.55,
      source: 'heuristic',
    });
  }

  // ---- package manager --------------------------------------------------
  const pmByProject = new Map<string, Map<string, number>>();
  for (const c of userCmds) {
    const pm = pmOf(c.cmd);
    if (!pm) continue;
    const proj = c.project ?? '';
    const m = pmByProject.get(proj) ?? new Map<string, number>();
    m.set(pm, (m.get(pm) ?? 0) + 1);
    pmByProject.set(proj, m);
  }
  for (const [proj, m] of pmByProject) for (const [pm, n] of m) bump(cands, `pm:${proj}:${pm}`, nowIso, n);
  const pmProjects = new Set<string>();
  for (const k of Object.keys(cands)) if (k.startsWith('pm:')) pmProjects.add(k.split(':')[1] ?? '');
  for (const proj of pmProjects) {
    const counts = PMS.map((pm) => ({ pm, n: cands[`pm:${proj}:${pm}`]?.count ?? 0 }));
    const total = counts.reduce((s, x) => s + x.n, 0);
    const top = counts.sort((a, b) => b.n - a.n)[0]!;
    if (total >= 4 && top.n / total >= 0.8) {
      const others = PMS.filter((p) => p !== top.pm).join('/');
      const where = proj ? `in ${projectName(proj)}` : 'for JavaScript projects';
      ops.push({
        op: 'add',
        kind: 'convention',
        scope: scopeOf(proj || undefined),
        key: `h:pm:${proj}`,
        text: `Uses ${top.pm} (not ${others}) for package management and scripts ${where}.`,
        confidence: Math.min(0.9, 0.5 + top.n / 40),
        source: 'heuristic',
      });
    }
  }

  // ---- project task commands -------------------------------------------
  const touchedTaskProjects = new Set<string>();
  for (const c of userCmds) {
    if (c.exit !== 0) continue;
    const cmd = c.cmd.trim().replace(/\s+/g, ' ');
    for (const t of TASK_PATTERNS) {
      if (!t.re.test(cmd)) continue;
      const proj = c.project ?? '';
      const key = `task:${proj}`;
      const rec = (cands[key]?.payload as Record<string, Record<string, number>> | undefined) ?? {};
      rec[t.label] ??= {};
      rec[t.label]![cmd] = (rec[t.label]![cmd] ?? 0) + 1;
      bump(cands, key, nowIso, 1, rec);
      touchedTaskProjects.add(proj);
      break;
    }
  }
  for (const proj of touchedTaskProjects) {
    const rec = cands[`task:${proj}`]?.payload as Record<string, Record<string, number>> | undefined;
    if (!rec) continue;
    const parts: string[] = [];
    let strongest = 0;
    for (const label of ['test', 'build', 'lint', 'format', 'typecheck', 'dev']) {
      const row = rec[label];
      if (!row) continue;
      const best = Object.entries(row).sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= 3) {
        parts.push(`${label}: \`${best[0].slice(0, 80)}\``);
        strongest = Math.max(strongest, best[1]);
      }
    }
    if (parts.length > 0) {
      ops.push({
        op: 'add',
        kind: 'workflow',
        scope: scopeOf(proj || undefined),
        key: `h:tasks:${proj}`,
        text: `${proj ? `Commands in ${projectName(proj)}` : 'Usual commands'} — ${parts.join('; ')}.`,
        confidence: Math.min(0.9, 0.5 + strongest / 30),
        source: 'heuristic',
      });
    }
  }

  // ---- failure → fix lessons -------------------------------------------
  for (let i = 0; i < userCmds.length; i++) {
    const f = userCmds[i]!;
    if (f.exit === null || f.exit === 0 || f.exit === 130 || f.exit === 127) continue;
    const ftoks = f.cmd.trim().split(/\s+/);
    const head = ftoks[0] ?? '';
    if (!head || TRIVIAL.has(head)) continue;
    const t0 = Date.parse(f.ts);
    for (let j = i + 1; j < Math.min(userCmds.length, i + 6); j++) {
      const g = userCmds[j]!;
      if (Date.parse(g.ts) - t0 > 10 * 60_000) break;
      if (g.cwd !== f.cwd || g.exit !== 0) continue;
      const gtoks = g.cmd.trim().split(/\s+/);
      if (gtoks[0] !== head || g.cmd === f.cmd) continue;
      const fs_ = new Set(ftoks);
      const gs = new Set(gtoks);
      const diff = [...gs].filter((x) => !fs_.has(x)).length + [...fs_].filter((x) => !gs.has(x)).length;
      if (diff < 1 || diff > 4) continue;
      const sig = `fix:${f.project ?? ''}:${firstTokens(f.cmd, 2)}`;
      const count = bump(cands, sig, nowIso, 1, { failed: f.cmd, fixed: g.cmd, project: f.project });
      if (count >= 2) {
        ops.push({
          op: 'add',
          kind: 'lesson',
          scope: scopeOf(f.project),
          key: `h:${sig}`,
          text: `${f.project ? `In ${projectName(f.project)}, ` : ''}\`${f.cmd.slice(0, 90)}\` tends to fail; \`${g.cmd.slice(0, 90)}\` is what works.`,
          confidence: Math.min(0.85, 0.45 + count * 0.1),
          source: 'heuristic',
        });
      }
      break;
    }
  }

  // ---- habitual commands -----------------------------------------------
  const freq = new Map<string, { n: number; project?: string }>();
  for (const c of userCmds) {
    if (c.exit !== 0) continue;
    const cmd = c.cmd.trim().replace(/\s+/g, ' ');
    if (cmd.length < 24 || TASK_PATTERNS.some((t) => t.re.test(cmd)) || TRIVIAL.has(cmd.split(' ')[0] ?? '')) continue;
    const k = `${c.project ?? ''}\u0000${cmd}`;
    const cur = freq.get(k) ?? { n: 0, project: c.project };
    cur.n++;
    freq.set(k, cur);
  }
  for (const [k, v] of freq) {
    const cmd = k.split('\u0000')[1]!;
    bump(cands, `freq:${hash(k)}`, nowIso, v.n, { cmd, project: v.project });
  }
  const habitual = Object.entries(cands)
    .filter(([k, v]) => k.startsWith('freq:') && v.count >= 6)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3);
  for (const [k, v] of habitual) {
    const p = v.payload as { cmd: string; project?: string };
    ops.push({
      op: 'add',
      kind: 'workflow',
      scope: scopeOf(p.project),
      key: `h:${k}`,
      text: `${p.project ? `In ${projectName(p.project)}, you` : 'You'} often run \`${p.cmd.slice(0, 110)}\`.`,
      confidence: 0.45,
      source: 'heuristic',
    });
  }

  // ---- repeated routines → skills --------------------------------------
  const byProject = new Map<string, CommandEpisode[]>();
  for (const c of userCmds) {
    if (c.exit !== 0) continue;
    const proj = c.project ?? '';
    const arr = byProject.get(proj) ?? [];
    arr.push(c);
    byProject.set(proj, arr);
  }
  const seqCounts = new Map<string, { steps: string[]; project: string; bursts: Set<number> }>();
  for (const [proj, arr] of byProject) {
    const bursts: string[][] = [];
    let cur: string[] = [];
    let lastT = 0;
    for (const c of arr) {
      const t = Date.parse(c.ts);
      if (cur.length && t - lastT > 5 * 60_000) {
        bursts.push(cur);
        cur = [];
      }
      const cmd = c.cmd.trim().replace(/\s+/g, ' ');
      if (!TRIVIAL.has(cmd.split(' ')[0] ?? '') && cur[cur.length - 1] !== cmd) cur.push(cmd);
      lastT = t;
    }
    if (cur.length) bursts.push(cur);
    bursts.forEach((b, bi) => {
      for (let n = 2; n <= 4; n++) {
        for (let s = 0; s + n <= b.length; s++) {
          const steps = b.slice(s, s + n);
          if (steps.join(' ').length < 30) continue;
          const id = `${proj}\u0000${steps.join('\u0001')}`;
          const rec = seqCounts.get(id) ?? { steps, project: proj, bursts: new Set<number>() };
          rec.bursts.add(bi);
          seqCounts.set(id, rec);
        }
      }
    });
  }
  const seqKeys: { key: string; steps: string[]; project: string; count: number }[] = [];
  for (const [id, rec] of seqCounts) {
    const key = `seq:${hash(id)}`;
    const count = bump(cands, key, nowIso, rec.bursts.size, { steps: rec.steps, project: rec.project });
    if (count >= 3) seqKeys.push({ key, steps: rec.steps, project: rec.project, count });
  }
  // Prefer the longest routine; drop sub-sequences of a longer qualifying one.
  seqKeys.sort((a, b) => b.steps.length - a.steps.length || b.count - a.count);
  const kept: typeof seqKeys = [];
  for (const s of seqKeys) {
    const joined = s.steps.join('\u0001');
    if (kept.some((k) => k.project === s.project && k.steps.join('\u0001').includes(joined))) continue;
    kept.push(s);
  }
  for (const s of kept.slice(0, 3)) {
    const name = s.steps.map((x) => firstTokens(x, 2)).join(' → ').slice(0, 60);
    ops.push({
      op: 'skill',
      name,
      description: `A routine you repeat${s.project ? ` in ${projectName(s.project)}` : ''}: ${s.steps.map((x) => `\`${x.slice(0, 60)}\``).join(' then ')}.`,
      whenToUse: `When you need to ${name}. Seen ${s.count} times.`,
      steps: s.steps,
      scope: scopeOf(s.project || undefined),
      key: `h:${s.key}`,
      confidence: Math.min(0.85, 0.4 + s.count * 0.1),
    });
  }

  // ---- explicit statements from the user -------------------------------
  for (const e of input.episodes) {
    let text: string | null = null;
    if (e.t === 'ext' && (e as ExternalAgentEpisode).role === 'user') text = (e as ExternalAgentEpisode).text;
    else if (e.t === 'note') text = (e as NoteEpisode).text;
    if (!text) continue;
    for (const d of extractDirectives(text)) {
      const scope = !d.personal && e.project ? `project:${e.project}` : 'global';
      ops.push({ op: 'add', kind: d.kind, scope, text: d.text, confidence: 0.7, source: 'user' });
    }
  }

  return { ops, candidates: pruneCandidates(cands, now) };
}

/** Keep the candidate table from growing without bound: forget one-off sightings after 30 days. */
function pruneCandidates(c: Candidates, now: number): Candidates {
  const out: Candidates = {};
  for (const [k, v] of Object.entries(c)) {
    const age = (now - Date.parse(v.last)) / 86_400_000;
    const keepLong = k.startsWith('proj:') || k.startsWith('pm:') || k.startsWith('task:');
    if (v.count >= 3 || age < 30 || keepLong) out[k] = v;
  }
  return out;
}
