import fs from 'node:fs';

/** A tiny append-only log for the updater (~/.jaffer/updater.log). It starts over past `maxBytes` and never throws. */
export function updaterLog(file: string, maxBytes = 200_000): (msg: string) => void {
  return (msg) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) fs.writeFileSync(file, '');
      fs.appendFileSync(file, `${new Date().toISOString()} ${msg.replace(/\s+/g, ' ').slice(0, 500)}\n`);
    } catch {
      /* logging must never break the app */
    }
  };
}
