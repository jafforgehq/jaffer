/**
 * The command line, split into flags and plain words. Some flags stand alone (`--pin`, `--remove`): they never take the word
 * after them as a value, so `jaffer remember --pin Always use pnpm` remembers "Always use pnpm", not "use pnpm".
 */
export const SWITCHES = new Set(['pin', 'project', 'all', 'status', 'remove', 'delete', 'yes', 'help', 'version']);

export interface ParsedArgs {
  /** The words that are not flags, without the command itself. */
  positional: string[];
  /** `--name value`, `--name=value` and bare `--name` (as "true"). */
  flags: Map<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positional.push(...argv.slice(i + 1)); // everything after -- is plain text, even if it starts with dashes
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 2) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (!SWITCHES.has(name) && next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i++;
    } else flags.set(name, 'true');
  }
  return { positional, flags };
}
