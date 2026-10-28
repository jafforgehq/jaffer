import fs from 'node:fs';
import path from 'node:path';
import { assertJafferHome } from './reset';
import { readJson, writeJson } from '../shared/util';

/**
 * Voice mode (1.6.0 and 1.6.1) is gone. What it left in Jaffer's own folder is removed at the app's start, before the daemon reads the
 * settings: the downloaded model files in `<home>/voice` (a link is removed, never what it points at) and the keys `permissions.voice`
 * and `voice` in `config.json`. Safe to repeat, cheap when there is nothing (one lstat, one file read), never throws, and touches
 * nothing outside a folder `assertJafferHome` accepts.
 */
export function removeVoiceLeftovers(home: string, userHome: string): void {
  try {
    const h = assertJafferHome(home, userHome);
    const dir = path.join(h, 'voice');
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) fs.unlinkSync(dir);
    else if (st?.isDirectory()) fs.rmSync(dir, { recursive: true, force: true });

    const file = path.join(h, 'config.json');
    const cfg = readJson<Record<string, unknown>>(file, {});
    const perms = cfg.permissions;
    const hasPerm = perms !== null && typeof perms === 'object' && !Array.isArray(perms) && 'voice' in perms;
    if (!('voice' in cfg) && !hasPerm) return;
    const { voice: _voice, ...rest } = cfg;
    if (hasPerm) {
      const { voice: _perm, ...others } = perms as Record<string, unknown>;
      rest.permissions = others;
    }
    writeJson(file, rest);
  } catch {
    /* only a clean-up */
  }
}
