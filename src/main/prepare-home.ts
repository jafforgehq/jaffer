import type { JafferPaths } from '../shared/paths';

/**
 * One-time work on Jaffer's home at the app's start, after an older Jaffer's background session has been ended and before the app starts
 * its own terminal (the migration of a Mac that had an older Jaffer goes here). It never throws and it is bounded: a step that fails or
 * hangs must not keep the terminal from starting. Today there is nothing to do.
 */
export async function prepareHome(_paths: JafferPaths): Promise<void> {
  /* nothing yet */
}
