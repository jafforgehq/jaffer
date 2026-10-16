import fs from 'node:fs';
import path from 'node:path';
import { makePaths } from '../shared/paths';
import { ConfigStore } from '../shared/config';
import { tryConnect } from '../core/daemon-client';
import { VERSION } from '../core/version';
import { parseArgs } from './args';
import { claudeStatus, setupClaude, teardownClaude } from '../core/integrations/claude';
import { resetJaffer } from '../core/reset';
import { APPROVAL_WAIT_MS, decisionOutput } from '../core/claude/approvals';
import { isPaneId } from '../shared/session-id';

const paths = makePaths();
const args = process.argv.slice(2);
const cmd = args[0];

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);

const parsed = parseArgs(args);
const flag = (name: string, def?: string): string | undefined => parsed.flags.get(name) ?? def;

/** The terminal runs only while the Jaffer app does: nothing here starts it (a session started from here would have no app to end it). */
const NOT_RUNNING = 'Jaffer is not running. Open Jaffer and run this again.';

/**
 * What Claude Code wrote on stdin (`max`: more than that many characters is no payload at all). Stdin is let go once it is read: one Claude
 * Code keeps open must not keep the hook running after its answer.
 */
async function readStdin(max = Infinity): Promise<string> {
  if (process.stdin.isTTY) return '';
  const s = await new Promise<string>((resolve) => {
    let s = '';
    const t = setTimeout(() => resolve(s), 400);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      s += d;
      if (s.length > max) {
        clearTimeout(t);
        resolve('');
      }
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      resolve(s);
    });
  });
  process.stdin.destroy();
  return s;
}

/**
 * `jaffer hook permission-request` (installed only with `claude.approvals` on, and the one hook Claude Code waits for): asks the window for
 * a click on Allow or Deny and prints Claude Code's decision for it. Anything else (no click in time, the setting off, no daemon, an error,
 * a bad payload) prints nothing, and Claude Code's own prompt appears. Exits 0 on every path and never prints anything else.
 */
async function askApproval(): Promise<void> {
  try {
    const p = JSON.parse((await readStdin(1024 * 1024)) || 'null');
    if (!p || typeof p !== 'object' || Array.isArray(p)) return;
    const client = await tryConnect(paths, 600);
    if (!client) return;
    try {
      const r = await client.call('claude.approval', { session_id: p.session_id, tool_name: p.tool_name, tool_input: p.tool_input, cwd: p.cwd }, APPROVAL_WAIT_MS + 1000).catch(() => null);
      const d = r && typeof r === 'object' ? (r as { decision?: unknown }).decision : undefined;
      if (d === 'allow' || d === 'deny') process.stdout.write(decisionOutput(d));
    } finally {
      client.close();
    }
  } catch {
    /* Claude Code's own prompt */
  }
}

const HELP = `${bold('jaffer')} ${VERSION} — the command line for your Jaffer session

${bold('Claude Code')}
  jaffer setup claude [--remove|--status]   connect Claude Code to Jaffer (its hooks: the companion, notifications, the cost figure)

${bold('Session')}
  jaffer status · jaffer doctor · jaffer daemon [status|stop]   (stop ends the terminal, and Jaffer quits with it)
  jaffer config get|set <dot.path> <json>
`;

async function main(): Promise<void> {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    process.stdout.write(VERSION + '\n');
    return;
  }

  switch (cmd) {
    case 'hook': {
      // Called by Claude Code (every event, `async`): must be fast, print nothing, exit 0 on every path, and never block the session.
      if (process.env.JAFFER_NO_HOOKS) return; // a `claude` the daemon itself runs (`claude auth ...`) is not the terminal's
      // Only a claude running inside Jaffer's terminal reports (the companion, the notification and the cost figure follow it).
      if (process.env.JAFFER_SESSION !== '1') return;
      if (args[1] === 'permission-request') return void (await askApproval());
      const input = await readStdin();
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(input || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
      } catch {
        /* no payload */
      }
      if (!Object.keys(payload).length) return;
      // which of Jaffer's terminals this claude runs in (the shell's JAFFER_PANE), and nothing else added: a short plain id or none
      if (isPaneId(process.env.JAFFER_PANE)) payload.jaffer_pane = process.env.JAFFER_PANE;
      else delete payload.jaffer_pane;
      const client = await tryConnect(paths, 600);
      try {
        await client?.call('claude.event', payload, 800).catch(() => undefined);
      } catch {
        /* hooks never fail loudly */
      }
      client?.close();
      return;
    }

    case 'setup': {
      if (args[1] !== 'claude') throw new Error('Usage: jaffer setup claude [--remove|--status]');
      const wrapper = path.join(paths.binDir, 'jaffer');
      if (flag('status')) {
        const s = await claudeStatus();
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      // the hooks run ~/.jaffer/bin/jaffer, which Jaffer writes when it starts: without it there is nothing for them to run yet
      if (!flag('remove') && !fs.existsSync(wrapper)) {
        const running = await tryConnect(paths);
        running?.close();
        throw new Error(running ? `${wrapper} is missing. Quit Jaffer and open it again: it writes it when it starts.` : NOT_RUNNING);
      }
      // (with the approvals hook while that setting is on: connecting again must not take it away)
      const res = flag('remove') ? await teardownClaude() : await setupClaude(wrapper, { approvals: new ConfigStore(paths).get().claude.approvals });
      for (const m of res.messages) console.log(m);
      console.log(dim(`claude: ${res.status.claudeInstalled ? res.status.claudePath : 'not found'} · hooks: ${res.status.hooks ? 'on' : 'off'}`));
      if (!flag('remove')) console.log(dim('A Claude Code started in Jaffer’s terminal is followed by the companion, the notifications and the cost figure.'));
      return;
    }

    // Start over: take Jaffer off this Mac (see core/reset.ts). Run from another terminal, never from Jaffer's own: the session ends.
    case 'reset': {
      if (process.env.JAFFER_SESSION) throw new Error("This shell is Jaffer's own session, and resetting ends it. Run `jaffer reset` from another terminal (Terminal.app), or use Settings → Reset in the app.");
      const del = !!flag('delete');
      if (!flag('yes')) {
        if (!process.stdin.isTTY) throw new Error(`This ends your Jaffer session and removes its settings and hooks${del ? '' : ' (a backup of ' + paths.home + ' is kept)'}. Run again with --yes to confirm.`);
        console.log(`${bold('Reset Jaffer')}: ends the session and removes Jaffer's settings and hooks (Claude Code and its login are not touched).`);
        console.log(del ? 'Nothing is kept.' : `A copy of ${paths.home} is kept next to it as a backup.`);
        const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question('Type reset to continue: ');
        rl.close();
        if (answer.trim().toLowerCase() !== 'reset') {
          console.log('Cancelled. Nothing was changed.');
          return;
        }
      }
      // resetJaffer keeps the order: the login agent of an older Jaffer away, the session ended, then the rest
      const running = await tryConnect(paths);
      const res = await resetJaffer({
        home: paths.home,
        backup: !del,
        endSession: async () => {
          if (!running) return;
          await running.call('app.shutdown', {}).catch(() => undefined);
          running.close();
          for (let i = 0; i < 40 && (await tryConnect(paths, 300).then((c) => (c?.close(), !!c))); i++) await new Promise((r) => setTimeout(r, 150));
        },
      });
      for (const m of res.messages) console.log(m);
      console.log(green('Done.') + dim(`${running ? ' Jaffer’s terminal has ended, and the app quits with it.' : ''} To finish a clean install, drag Jaffer.app to the Trash and install the latest release.`));
      return;
    }

    case 'status':
    case 'doctor': {
      const client = await tryConnect(paths);
      console.log(`${bold('Jaffer')} ${VERSION}   home: ${paths.home}`);
      if (!client) {
        console.log(`daemon: ${red('not running')} ${dim(`(${NOT_RUNNING})`)}`);
      } else {
        const hello = await client.call('hello', {});
        const info = await client.call('session.info', {});
        const auth = await client.call('setup.claude.auth', {});
        console.log(`daemon: ${green('running')} pid ${hello.pid} · v${hello.version} · since ${hello.startedAt}`);
        console.log(`session: cwd ${info.cwd}${info.project ? ` · project ${path.basename(info.project)}${info.branch ? '@' + info.branch : ''}` : ''}${info.busy ? ` · running: ${info.busy}` : ''}`);
        console.log(`claude: ${auth.loggedIn ? green('signed in') : auth.installed ? red('signed out') + dim(' (run `claude auth login`)') : red('Claude Code not installed')}`);
        client.close();
      }
      if (cmd === 'doctor') {
        const cs = await claudeStatus();
        console.log(`claude code: ${cs.claudeInstalled ? cs.claudePath : red('not found')} · hooks ${cs.hooks ? green('on') : 'off'}`);
        console.log(`shell integration: ${process.env.JAFFER_SESSION ? green('this shell is a Jaffer session') : dim('this shell is not inside Jaffer')}`);
      }
      return;
    }

    case 'daemon': {
      const sub = args[1] ?? 'status';
      const client = await tryConnect(paths);
      if (sub === 'start') {
        // the terminal starts with the app, and only there: one started from here would outlive everything meant to end it
        client?.close();
        if (client) console.log('already running');
        else throw new Error(NOT_RUNNING);
        return;
      } else if (sub === 'stop') {
        if (!client) console.log('not running');
        else {
          await client.call('app.shutdown', {}).catch(() => undefined);
          console.log('stopped');
        }
      } else console.log(client ? green('running') : red('not running'));
      client?.close();
      return;
    }

    case 'config': {
      const client = await tryConnect(paths);
      const cfgStore = new ConfigStore(paths);
      const get = async () => (client ? client.call('config.get', {}) : cfgStore.get());
      if (args[1] === 'get' || !args[1]) {
        const cfg: any = await get();
        const key = args[2];
        console.log(JSON.stringify(key ? key.split('.').reduce((o: any, k) => o?.[k], cfg) : cfg, null, 2));
      } else if (args[1] === 'set') {
        const [key, raw] = [args[2], args.slice(3).join(' ')];
        if (!key || raw === '') throw new Error('Usage: jaffer config set <dot.path> <json value>');
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
        const patch: any = {};
        key.split('.').reduce((o, k, i, a) => (o[k] = i === a.length - 1 ? value : {}), patch);
        const after: any = client ? await client.call('config.patch', patch) : cfgStore.patch(patch);
        const kept = key.split('.').reduce((o: any, k) => o?.[k], after);
        // a value of the wrong kind is refused by the config (a switch is true or false, a list is a JSON list): say so
        if (JSON.stringify(kept) !== JSON.stringify(value)) {
          client?.close();
          throw new Error(`${key} was not changed: ${JSON.stringify(value)} is not a valid value for it (it stays ${JSON.stringify(kept)}). Switches are true or false, lists are JSON, e.g. '["main","prod"]'.`);
        }
        console.log('ok');
      }
      client?.close();
      return;
    }

    default:
      process.stderr.write(red(`Unknown command: ${cmd}\n\n`) + HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  process.stderr.write(red(`jaffer: ${e instanceof Error ? e.message : String(e)}\n`));
  process.exit(1);
});
