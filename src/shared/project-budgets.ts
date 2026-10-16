/**
 * Project budgets (1.4.0, `claude.projectBudgets`): the person's own weekly budgets per folder, `"<folder>=<usd per week>"` one per
 * entry, measured against the costed past conversations (the 30 newest, as cost by folder; this week: the last 7 days). Pure.
 */

const MAX = 20;

/** A folder as the folder chips have it: `~` expanded, no trailing slash. */
function folder(raw: string, home: string): string {
  const p = raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw;
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

/** The budgets of the setting's lines: an absolute (or `~`) folder, `=`, a positive number of dollars; bad lines skipped, the first per folder, at most 20. */
export function parseProjectBudgets(lines: unknown, home: string): { cwd: string; usd: number }[] {
  const out: { cwd: string; usd: number }[] = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line !== 'string' || line.length > 4200) continue;
    const eq = line.lastIndexOf('=');
    if (eq < 0) continue;
    const raw = line.slice(0, eq).trim();
    const usd = Number(line.slice(eq + 1).trim());
    if (!raw || !(usd > 0) || !Number.isFinite(usd)) continue;
    const cwd = folder(raw, home);
    if (!cwd.startsWith('/') || cwd.length > 4096 || out.some((b) => b.cwd === cwd)) continue;
    out.push({ cwd, usd });
    if (out.length >= MAX) break;
  }
  return out;
}

/** Each budget's folder: the cost of its conversations that ended in the last 7 days (up to now) against its budget; warn from 80 %, danger from 100 %. */
export function budgetLevels(rows: { cwd?: string; endedAt: number; usd?: number }[], budgets: { cwd: string; usd: number }[], now: number): { cwd: string; usd: number; budget: number; level: 'ok' | 'warn' | 'danger' }[] {
  const items = Array.isArray(rows) ? rows : [];
  return budgets.map((b) => {
    let usd = 0;
    for (const c of items) {
      const t = c?.endedAt;
      if (c?.cwd === b.cwd && typeof c.usd === 'number' && Number.isFinite(c.usd) && typeof t === 'number' && t <= now && t > now - 7 * 86_400_000) usd += c.usd;
    }
    const r = usd / b.usd;
    return { cwd: b.cwd, usd, budget: b.usd, level: r >= 1 ? 'danger' : r >= 0.8 ? 'warn' : 'ok' };
  });
}
