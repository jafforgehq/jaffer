import fs from 'node:fs';
import path from 'node:path';

export interface ProjectInfo {
  root: string | undefined;
  branch: string | undefined;
}

const cache = new Map<string, { at: number; info: ProjectInfo }>();
const TTL = 30_000;

function readBranch(gitDir: string): string | undefined {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 8);
  } catch {
    return undefined;
  }
}

/** Nearest enclosing git repository (or package/project marker) for a directory, plus its branch. */
export function resolveProject(cwd: string | undefined, home?: string): ProjectInfo {
  if (!cwd) return { root: undefined, branch: undefined };
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL) return hit.info;
  let dir = cwd;
  let info: ProjectInfo = { root: undefined, branch: undefined };
  for (let i = 0; i < 40; i++) {
    if (home && dir === home) break;
    const git = path.join(dir, '.git');
    try {
      const st = fs.statSync(git);
      if (st.isDirectory()) {
        info = { root: dir, branch: readBranch(git) };
        break;
      }
      if (st.isFile()) {
        // worktree / submodule: "gitdir: <path>"
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8'));
        info = { root: dir, branch: m ? readBranch(path.resolve(dir, m[1]!.trim())) : undefined };
        break;
      }
    } catch {
      /* not here */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(cwd, { at: Date.now(), info });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return info;
}
