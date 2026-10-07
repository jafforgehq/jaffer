import { describe, expect, it } from 'vitest';
import { detectCorrection, extractDirectives, runHeuristics } from '../src/core/memory/heuristics';
import type { CommandEpisode, Episode } from '../src/core/memory/types';

let seq = 0;
function cmd(cmd: string, over: Partial<CommandEpisode> = {}): CommandEpisode {
  seq++;
  return { t: 'cmd', seq, id: `e${seq}`, ts: new Date(Date.UTC(2026, 9, 1, 10, 0, seq * 10)).toISOString(), cwd: '/work/app', project: '/work/app', cmd, exit: 0, ...over };
}

describe('heuristics', () => {
  it('learns the package manager once it is clearly dominant', () => {
    const eps: Episode[] = [cmd('pnpm install'), cmd('pnpm test'), cmd('pnpm build'), cmd('pnpm dev'), cmd('npm -v')];
    const { ops } = runHeuristics({ episodes: eps, candidates: {} });
    const pm = ops.find((o) => o.op === 'add' && o.key === 'h:pm:/work/app');
    expect(pm).toBeTruthy();
    expect(pm && pm.op === 'add' && pm.text).toContain('pnpm');
  });

  it('does not claim a package manager from a handful of mixed commands', () => {
    const eps: Episode[] = [cmd('npm i'), cmd('pnpm i'), cmd('yarn')];
    const { ops } = runHeuristics({ episodes: eps, candidates: {} });
    expect(ops.find((o) => o.op === 'add' && o.key?.startsWith('h:pm:'))).toBeUndefined();
  });

  it('accumulates evidence across batches via candidates', () => {
    const first = runHeuristics({ episodes: [cmd('make test'), cmd('make test')], candidates: {} });
    expect(first.ops.find((o) => o.op === 'add' && o.key?.startsWith('h:tasks'))).toBeUndefined();
    const second = runHeuristics({ episodes: [cmd('make test')], candidates: first.candidates });
    const op = second.ops.find((o) => o.op === 'add' && o.key?.startsWith('h:tasks'));
    expect(op && op.op === 'add' && op.text).toContain('make test');
  });

  it('turns a repeated failure→fix into a lesson only after it recurs', () => {
    const failFix = (n: number): Episode[] => [
      cmd('npm install', { exit: 1, ts: new Date(Date.UTC(2026, 9, 1, 11, n, 0)).toISOString() }),
      cmd('npm install --legacy-peer-deps', { exit: 0, ts: new Date(Date.UTC(2026, 9, 1, 11, n, 30)).toISOString() }),
    ];
    const one = runHeuristics({ episodes: failFix(1), candidates: {} });
    expect(one.ops.find((o) => o.op === 'add' && o.kind === 'lesson')).toBeUndefined();
    const two = runHeuristics({ episodes: failFix(2), candidates: one.candidates });
    const lesson = two.ops.find((o) => o.op === 'add' && o.kind === 'lesson');
    expect(lesson && lesson.op === 'add' && lesson.text).toContain('--legacy-peer-deps');
  });

  it('ignores trivial command failures such as a mistyped cd', () => {
    const eps: Episode[] = [cmd('cd nope', { exit: 1 }), cmd('cd src', { exit: 0 }), cmd('cd nope2', { exit: 1 }), cmd('cd lib', { exit: 0 })];
    const { ops } = runHeuristics({ episodes: eps, candidates: {} });
    expect(ops.filter((o) => o.op === 'add' && o.kind === 'lesson')).toHaveLength(0);
  });

  it('mines repeated routines into a skill', () => {
    const eps: Episode[] = [];
    for (let i = 0; i < 3; i++) {
      const base = Date.UTC(2026, 9, 1 + i, 9, 0, 0);
      const t = (s: number) => new Date(base + s * 1000).toISOString();
      eps.push(cmd('git add -A && git status --short', { ts: t(0) }), cmd('git commit -m "wip" --no-verify', { ts: t(20) }), cmd('git push origin HEAD --force-with-lease', { ts: t(40) }));
    }
    const { ops } = runHeuristics({ episodes: eps, candidates: {} });
    const skill = ops.find((o) => o.op === 'skill');
    expect(skill && skill.op === 'skill' && skill.steps).toHaveLength(3);
  });

  it('describes the environment', () => {
    const { ops } = runHeuristics({ episodes: [], candidates: {}, env: { platform: 'darwin', arch: 'arm64', shell: '/bin/zsh' } });
    const env = ops.find((o) => o.op === 'add' && o.key === 'h:env');
    expect(env && env.op === 'add' && env.text).toMatch(/macOS.*arm64.*zsh/);
  });

  it('extracts directives from what the user said', () => {
    const d = extractDirectives('Thanks. Always use pnpm in this repo. Can you run the tests? Never commit directly to main.');
    expect(d.map((x) => x.text)).toEqual(['Always use pnpm in this repo.', 'Never commit directly to main.']);
    expect(d[1]!.kind).toBe('lesson');
  });

  it('detects corrections', () => {
    expect(detectCorrection("No, use pnpm instead")).toBe(true);
    expect(detectCorrection("that's not what I asked")).toBe(true);
    expect(detectCorrection('Please add a test for the parser')).toBe(false);
  });

  it('turns directives given to an agent into memory ops with the right scope', () => {
    const ep: Episode = { t: 'ext', agent: 'claude-code', role: 'user', seq: 1, id: 'a', ts: new Date().toISOString(), project: '/work/app', cwd: '/work/app', text: 'I prefer tabs over spaces. We use vitest for tests in this repo.' };
    const { ops } = runHeuristics({ episodes: [ep], candidates: {} });
    const adds = ops.filter((o) => o.op === 'add');
    expect(adds.find((o) => o.op === 'add' && o.text.includes('tabs'))).toMatchObject({ scope: 'global', source: 'user' });
    expect(adds.find((o) => o.op === 'add' && o.text.includes('vitest'))).toMatchObject({ scope: 'project:/work/app', kind: 'convention' });
  });
});
