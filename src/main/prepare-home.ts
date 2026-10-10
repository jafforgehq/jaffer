import os from 'node:os';
import type { JafferPaths } from '../shared/paths';
import { migrateToPlainTerminal, type MigrateOptions } from '../core/migrate';
import { findClaude } from '../core/integrations/claude';

/**
 * One-time work on Jaffer's home at the app's start, after an older Jaffer's background session has been ended and before the app starts
 * its own terminal: the clean-up of a Mac an older Jaffer ran on (`migrateToPlainTerminal`; it runs once, then `migrated: 1` in the
 * settings makes it a single file read). `claude` is looked for only when that step is due (a login shell can take seconds). It never
 * throws, and the app gives it 30 s at most (`prepareHomeBounded`): the terminal starts all the same. `deps` are for tests.
 */
export async function prepareHome(
  paths: JafferPaths,
  deps: { userHome?: string; uid?: number; migrate?: (o: MigrateOptions) => Promise<unknown> } = {},
): Promise<void> {
  try {
    await (deps.migrate ?? migrateToPlainTerminal)({
      home: paths.home,
      userHome: deps.userHome ?? os.homedir(),
      uid: deps.uid ?? process.getuid?.() ?? -1,
      findClaude: () => findClaude(process.env),
    });
  } catch {
    /* never in the terminal's way */
  }
}
