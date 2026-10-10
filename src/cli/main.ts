import fs from 'node:fs';
import path from 'node:path';
import { makePaths } from '../shared/paths';
import { ConfigStore } from '../shared/config';
import { tryConnect, ensureDaemon, launchDaemon } from '../core/daemon-client';
import { VERSION } from '../core/version';
import { parseArgs } from './args';
import { claudeStatus, setupClaude, teardownClaude } from '../core/integrations/claude';
import { removeAgentWithoutDaemon, resetJaffer } from '../core/reset';
import { agentStatusText, errorText, keepRunningOffText, type AgentStatus } from '../shared/keep-running';

const paths = makePaths();
const args = process.argv.slice(2);
const cmd = args[0];

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);

const parsed = parseArgs(args);
const flag = (name: string, def?: string): string | undefined => parsed.flags.get(name) ?? def;

function launcher() {
  const here = __dirname; // dist/cli
  return { execPath: process.execPath, daemonScript: path.join(here, '..', 'daemon', 'jafferd.cjs'), cliScript: path.join(here, 'jaffer.cjs'), electron: !!process.versions.electron };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let s = '';
    const t = setTimeout(() => resolve(s), 400);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => {
      clearTimeout(t);
      resolve(s);
    });
  });
}

const HELP = `${bold('jaffer')} ${VERSION} — the command line for your Jaffer session

${bold('Claude Code')}
  jaffer setup claude [--remove|--status]   connect Claude Code to Jaffer (its hooks: the companion, notifications, the cost figure)

${bold('Session')}
  jaffer status · jaffer doctor · jaffer daemon [start|stop|status]
  jaffer service [status|install|remove]    keep the session running in the background (a login agent; macOS, ~/.jaffer only)
  jaffer config get|set <dot.path> <json>   (session.keepRunning false ends a session launchd runs: typed in it, it needs --yes)
`;

const SERVICE_HELP = `Usage: jaffer service [status|install|remove]
  jaffer service status    whether macOS keeps your session running in the background: not installed, installed (active from the
                           next login or restart), running (pid), installed but not loaded, or refused (and why)
  jaffer service install   install the login agent: launchd starts the session at login and again after a crash
  jaffer service remove    remove it (when launchd runs the session, that ends the session now, and typed in that
                           session it needs --yes; with no session running, or one that cannot start, it is removed
                           without starting one)
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
      const input = await readStdin();
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(input || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
      } catch {
        /* no payload */
      }
      if (!Object.keys(payload).length) return;
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
      if (!fs.existsSync(wrapper)) {
        const client = await ensureDaemon(paths, launcher()); // creates the wrapper
        client.close();
      }
      const res = flag('remove') ? await teardownClaude() : await setupClaude(wrapper);
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
      // resetJaffer keeps the order: the switch off, the login agent away (launchd must not start the session again; when launchd runs
      // it, that ends it), the session ended, then the rest
      const running = await tryConnect(paths);
      const res = await resetJaffer({
        home: paths.home,
        backup: !del,
        keepRunningOff: async () => void (await running?.call('config.patch', { session: { keepRunning: false } })),
        endSession: async () => {
          if (!running) return;
          await running.call('app.shutdown', {}).catch(() => undefined);
          running.close();
          for (let i = 0; i < 40 && (await tryConnect(paths, 300).then((c) => (c?.close(), !!c))); i++) await new Promise((r) => setTimeout(r, 150));
        },
      });
      for (const m of res.messages) console.log(m);
      console.log(green('Done.') + dim(' If the Jaffer app is open, quit it (⌘Q); it starts a new session straight away. To finish a clean install, drag Jaffer.app to the Trash and install the latest release.'));
      return;
    }

    case 'status':
    case 'doctor': {
      const client = await tryConnect(paths);
      console.log(`${bold('Jaffer')} ${VERSION}   home: ${paths.home}`);
      if (!client) {
        console.log(`daemon: ${red('not running')} ${dim('(open the Jaffer app, or `jaffer daemon start`)')}`);
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
        if (client) {
          console.log('already running');
          client.close();
        } else {
          const how = await launchDaemon(paths, launcher());
          console.log(how === 'launchd' ? 'starting (through launchd, the login agent)…' : 'starting…');
        }
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

    // The login agent that keeps the session running, through the daemon (started like any other command that needs it).
    case 'service': {
      const sub = args[1] ?? 'status';
      if (flag('help') || sub === 'help') {
        process.stdout.write(SERVICE_HELP);
        return;
      }
      const method = { status: 'service.status', install: 'service.install', remove: 'service.remove' }[sub];
      if (!method) throw new Error(SERVICE_HELP.trimEnd());
      // Turning it off needs no daemon: with none answering (none runs, or one that cannot start crash-loops under launchd), the agent
      // is taken away here, as Reset does it, and no daemon is started for it.
      const client = sub === 'remove' ? await tryConnect(paths) : await ensureDaemon(paths, launcher());
      if (!client) {
        const off = await removeAgentWithoutDaemon({ home: paths.home });
        for (const m of off.messages) console.log(m);
        console.log(agentStatusText(off.status));
        return;
      }
      let s: AgentStatus;
      try {
        // turned off while launchd runs the session, it ends: asked for here, so said first (the app asks in a dialog). Typed in that very
        // session (Jaffer's own terminal), it ends the terminal it was typed in: only with --yes.
        if (sub === 'remove' && ((await client.call('service.status', {}, 30_000)) as AgentStatus).state === 'running') {
          process.stderr.write(`${keepRunningOffText().detail}\n`);
          if (process.env.JAFFER_SESSION === '1' && !flag('yes')) {
            process.exitCode = 1;
            process.stderr.write(red('This shell is that session: nothing was changed. Run `jaffer service remove --yes` to turn it off and end the session, or turn it off in Settings.\n'));
            return;
          }
        }
        s = await client.call(method, {}, 30_000);
      } finally {
        client.close();
      }
      if (sub === 'install' && s.state === 'refused') throw new Error(`Not installed: ${s.reason}`);
      console.log(agentStatusText(s));
      if (s.note) console.log(dim(s.note));
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
        // (--yes answers the question below: it is never part of a key or a value, wherever it stands)
        const words = args.filter((a) => a !== '--yes');
        const [key, raw] = [words[2], words.slice(3).join(' ')];
        if (!key || raw === '') throw new Error('Usage: jaffer config set <dot.path> <json value>');
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
        const patch: any = {};
        key.split('.').reduce((o, k, i, a) => (o[k] = i === a.length - 1 ? value : {}), patch);
        // Turning keeping the session running off while launchd runs the session ends it (the daemon takes the agent away right after
        // the reply): said first, as `jaffer service remove` does, and typed in that very session it ends the shell it was typed in, so
        // only with --yes. A daemon that cannot say (one from before 0.5 answers "unknown method: service.status", or the status fails)
        // does not reconcile the agent either: nothing can end, so the patch goes ahead.
        if (client && patch.session?.keepRunning === false) {
          const running = await (client.call('service.status', {}, 30_000) as Promise<AgentStatus>).then(
            (st) => st.state === 'running',
            () => false,
          );
          if (running) {
            process.stderr.write(`${keepRunningOffText().detail}\n`);
            if (process.env.JAFFER_SESSION === '1' && !flag('yes')) {
              client.close();
              process.exitCode = 1;
              process.stderr.write(red('This shell is that session: nothing was changed. Run the same command with --yes to turn it off and end the session, or turn it off in Settings.\n'));
              return;
            }
          }
        }
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
  // (a session daemon older than this CLI does not know what 0.5 added: said as Settings says it)
  process.stderr.write(red(`jaffer: ${errorText(e)}\n`));
  process.exit(1);
});
