import { conversationFiles, MAX_REMOVE, type ConversationFiles } from '../core/claude/history';
import { isSessionId } from '../shared/session-id';

/**
 * (1.3.0) Removing past conversations: the one place Jaffer changes Claude Code's files, and only this way. The files come from
 * `conversationFiles` (never from the page), a conversation still running is refused, the person is asked once (a native dialog, Cancel the
 * default), and each file goes to the Trash (`shell.trashItem`), never deleted, so it can be put back. Electron stays out of this file:
 * main passes the dialog, the Trash and the running sessions in.
 */
export interface TrashDeps {
  claudeDir: string;
  trashItem(p: string): Promise<void>;
  /** The native question for `n` conversations; true: Move to Trash. */
  confirm(n: number): Promise<boolean>;
  /** The ids of the sessions the daemon's watcher has that have not ended; throws when that cannot be known. */
  liveIds(): Promise<string[]>;
  /** (1.4.0) `permissions.trash`: false refuses everything before anything is looked up or asked. Absent: on. */
  enabled?(): boolean;
}

/** `unknown`: the running sessions could not be looked up, so nothing was touched (never a guess). */
export type TrashRefusal = 'running' | 'not found' | 'error' | 'unknown' | 'off';
export interface TrashResult {
  trashed: string[];
  refused: { id: string; reason: TrashRefusal }[];
  cancelled?: boolean;
}

/** The dialog main shows (through its counting wrapper). */
export function trashAsk(n: number) {
  const one = n === 1;
  return {
    type: 'warning' as const,
    message: `Move ${n} past conversation${one ? '' : 's'} to the Trash?`,
    detail: `Claude Code can no longer resume ${one ? 'it' : 'them'}. You can put ${one ? 'it' : 'them'} back from the Trash.`,
    buttons: ['Move to Trash', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  };
}

export async function trashConversations(ids: unknown, deps: TrashDeps): Promise<TrashResult> {
  const valid = [...new Set(Array.isArray(ids) ? ids.slice(0, MAX_REMOVE).filter((x): x is string => typeof x === 'string' && isSessionId(x)) : [])];
  const why = new Map<string, TrashRefusal>();
  const result = (trashed: string[], cancelled?: true): TrashResult => ({
    trashed,
    refused: valid.filter((id) => why.has(id)).map((id) => ({ id, reason: why.get(id)! })),
    ...(cancelled ? { cancelled } : {}),
  });
  /** The ones of `pick` not running, with their files (in the order asked); the others get their reason. Never a guess: unknown running sessions refuse all. */
  const look = async (pick: string[]): Promise<Map<string, ConversationFiles[]>> => {
    let live: Set<string>;
    try {
      live = new Set(await deps.liveIds());
    } catch {
      for (const id of pick) why.set(id, 'unknown');
      return new Map();
    }
    for (const id of pick) if (live.has(id)) why.set(id, 'running');
    const found = new Map<string, ConversationFiles[]>();
    for (const f of await conversationFiles(deps.claudeDir, pick.filter((id) => !why.has(id)))) found.set(f.id, [...(found.get(f.id) ?? []), f]);
    for (const id of pick) if (!why.has(id) && !found.has(id)) why.set(id, 'not found');
    return found;
  };

  if (!valid.length) return result([]);
  if (deps.enabled && !deps.enabled()) {
    for (const id of valid) why.set(id, 'off');
    return result([]);
  }
  const asked = await look(valid);
  if (!asked.size) return result([]);
  if (!(await deps.confirm(asked.size))) return result([], true);
  // looked at again after the question (the person may take their time): resumed meanwhile, gone, or swapped for a link
  const found = await look([...asked.keys()]);
  const trashed: string[] = [];
  for (const [id, files] of found) {
    try {
      for (const f of files) {
        await deps.trashItem(f.file);
        if (f.dir) await deps.trashItem(f.dir);
      }
      trashed.push(id);
    } catch {
      why.set(id, 'error');
    }
  }
  return result(trashed);
}
