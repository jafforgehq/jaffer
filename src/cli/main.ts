import fs from 'node:fs';
import path from 'node:path';
import { makePaths } from '../shared/paths';
import { ConfigStore } from '../shared/config';
import { MemoryEngine } from '../core/memory/engine';
import { makeMemoryApi, type MemoryApi } from '../core/memory-api';
import { tryConnect, ensureDaemon, launchDaemon } from '../core/daemon-client';
import { runMcpServer } from '../core/mcp/server';
import { VERSION } from '../core/version';
import { claudeStatus, setupClaude, teardownClaude } from '../core/integrations/claude';
import { resetJaffer } from '../core/reset';
import { detectTargets } from '../core/memory/exports';
import type { RpcClient } from '../core/rpc';

const paths = makePaths();
const args = process.argv.slice(2);
const cmd = args[0];

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);

function flag(name: string, def?: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}`);
  if (i >= 0) return args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : 'true';
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : def;
}
function positional(from = 1): string[] {
  const out: string[] = [];
  for (let i = from; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      if (!a.includes('=') && args[i + 1] && !args[i + 1]!.startsWith('--')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function launcher() {
  const here = __dirname; // dist/cli
  return { execPath: process.execPath, daemonScript: path.join(here, '..', 'daemon', 'jafferd.cjs'), cliScript: path.join(here, 'jaffer.cjs'), electron: !!process.versions.electron };
}

let localEngine: MemoryEngine | null = null;
function local(): MemoryApi {
  if (!localEngine) localEngine = new MemoryEngine({ paths, config: new ConfigStore(paths) });
  return makeMemoryApi(localEngine);
}

/** Talk to the daemon when it is up; otherwise operate on the memory files directly (hooks still work with the app closed). */
async function memoryCall(method: string, params: unknown, client: RpcClient | null): Promise<any> {
  if (client) return client.call(method, params);
  const fn = local()[method];
  if (!fn) throw new Error(`${method} needs the Jaffer daemon (open the app or run \`jaffer daemon start\`).`);
  return fn(params);
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

const HELP = `${bold('jaffer')} ${VERSION} — the command line for your Jaffer session and memory

${bold('Memory')}
  jaffer remember <text> [--kind preference|convention|fact|workflow|lesson] [--project] [--pin]
  jaffer recall <query>
  jaffer forget <id|description>
  jaffer memory [list|log|reflect|consolidate|stats] ·  jaffer memory revert <runId>
  jaffer context [--query q]            print what Jaffer knows for the current directory

${bold('Agent')}

${bold('Claude Code')}
  jaffer setup claude [--remove|--status]   wire Claude Code to this memory (MCP server + hooks)
  jaffer mcp                                run the MCP server (used by Claude Code)

${bold('Session')}
  jaffer status · jaffer doctor · jaffer daemon [start|stop|status]
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
    case 'mcp': {
      const client = await tryConnect(paths);
      runMcpServer({ version: VERSION, call: (m, p) => memoryCall(m, p, client) });
      client?.onClose.on(() => process.exit(0));
      return; // keep running on stdin
    }

    case 'hook': {
      // Called by Claude Code; must be fast, silent on failure, and never block the session.
      const which = args[1];
      if (process.env.JAFFER_NO_HOOKS) return; // Jaffer's own `claude -p` helper calls must not be primed with memory
      // Only a claude running inside Jaffer's terminal reports to the live panel; memory hooks work anywhere.
      const inSession = process.env.JAFFER_SESSION === '1';
      if (!inSession && which !== 'session-start' && which !== 'stop') return;
      const input = await readStdin();
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(input || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
      } catch {
        /* no payload */
      }
      const client = await tryConnect(paths, 600);
      try {
        if (inSession && Object.keys(payload).length) await client?.call('claude.event', payload, 800).catch(() => undefined);
        if (which === 'session-start') {
          const text: string = await memoryCall('memory.context', { cwd: (payload.cwd as string | undefined) ?? process.cwd(), budget: 4500 }, client);
          if (text.trim()) process.stdout.write(`# Memory from Jaffer\nWhat the user's terminal has learned about them and this project. Background only; the user's instructions win.\n\n${text.trim()}\n`);
        } else if (which === 'stop') {
          await client?.call('ingest.now', {}, 1500).catch(() => undefined);
        }
      } catch {
        /* hooks never fail loudly */
      }
      client?.close();
      return;
    }

    case 'remember': {
      const text = positional().join(' ');
      if (!text) throw new Error('Usage: jaffer remember <text>');
      const client = await tryConnect(paths);
      const r = await memoryCall('memory.remember', { text, kind: flag('kind'), scope: flag('project') ? 'project' : 'global', cwd: process.cwd(), pinned: !!flag('pin') }, client);
      console.log(r.deduped ? `${dim('already known, reinforced:')} ${r.item.text}` : `${green('remembered')} ${dim(`[${r.item.id}]`)} ${r.item.text}`);
      client?.close();
      return;
    }

    case 'recall': {
      const q = positional().join(' ');
      if (!q) throw new Error('Usage: jaffer recall <query>');
      const client = await tryConnect(paths);
      const r = await memoryCall('memory.recall', { query: q, cwd: process.cwd(), limit: 10 }, client);
      for (const i of r.items) console.log(`${dim(i.id)} ${dim(`[${i.kind}${i.scope === 'global' ? '' : ' · project'}]`)} ${i.text}`);
      for (const s of r.skills) console.log(`${dim('skill')} ${bold(s.name)} — ${s.whenToUse}`);
      if (!r.items.length && !r.skills.length) console.log(dim('nothing matched'));
      client?.close();
      return;
    }

    case 'forget': {
      const q = positional().join(' ');
      if (!q) throw new Error('Usage: jaffer forget <id|description>');
      const client = await tryConnect(paths);
      const r = await memoryCall('memory.forget', { id: q }, client);
      console.log(r.archived.length ? `forgot: ${r.archived.map((i: any) => i.text).join(' | ')}` : dim('nothing matched'));
      client?.close();
      return;
    }

    case 'context': {
      const client = await tryConnect(paths);
      const text = await memoryCall('memory.context', { cwd: process.cwd(), query: flag('query'), budget: 6000 }, client);
      process.stdout.write((text.trim() || dim('(nothing learned yet)')) + '\n');
      client?.close();
      return;
    }

    case 'memory': {
      const sub = args[1] ?? 'list';
      const client = await tryConnect(paths);
      if (sub === 'list') {
        const r = await memoryCall('memory.list', { status: flag('all') ? 'all' : 'active' }, client);
        const byScope = new Map<string, any[]>();
        for (const i of r.items) byScope.set(i.scope, [...(byScope.get(i.scope) ?? []), i]);
        for (const [scope, items] of byScope) {
          console.log(bold(scope === 'global' ? 'Global' : `Project ${path.basename(scope.slice(8))}`));
          for (const i of items.sort((a, b) => b.confidence - a.confidence)) console.log(`  ${dim(i.id)} ${i.pinned ? '📌' : '  '}${dim(`${i.kind.padEnd(10)} ${i.confidence.toFixed(2)}`)} ${i.text}`);
        }
        if (r.skills.length) {
          console.log(bold('Skills'));
          for (const s of r.skills) console.log(`  ${dim(s.id)} ${s.name} — ${s.whenToUse}`);
        }
        if (!r.items.length && !r.skills.length) console.log(dim('Nothing learned yet.'));
      } else if (sub === 'log') {
        const r = await memoryCall('memory.log', { limit: 200 }, client);
        for (const run of r.runs.slice(0, 15)) {
          console.log(`${bold(run.runId)} ${dim(run.ts.slice(0, 16).replace('T', ' '))} ${dim(run.source)}${run.reason ? dim(' · ' + run.reason) : ''}`);
          for (const o of run.ops.slice(0, 6)) console.log(`   ${o.op.padEnd(10)} ${o.text ?? o.id}`);
        }
      } else if (sub === 'revert') {
        const id = args[2];
        if (!id) throw new Error('Usage: jaffer memory revert <runId>');
        const r = await memoryCall('memory.revert', { runId: id }, client);
        console.log(r.reverted ? `reverted ${r.reverted} change(s)` : 'nothing to revert (unknown run, or already reverted)');
      } else if (sub === 'reflect' || sub === 'consolidate') {
        const r = await memoryCall(sub === 'reflect' ? 'memory.reflect' : 'memory.consolidate', { force: true }, client);
        console.log(r.summary);
      } else if (sub === 'stats') {
        console.log(JSON.stringify(await memoryCall('memory.stats', {}, client), null, 2));
      } else throw new Error(`Unknown memory subcommand: ${sub}`);
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
      console.log(dim(`claude: ${res.status.claudeInstalled ? res.status.claudePath : 'not found'} · hooks: ${res.status.hooks ? 'on' : 'off'} · mcp: ${res.status.mcp ? 'on' : 'off'}`));
      if (!flag('remove')) console.log(dim('Open a new Claude Code session; it will start with your memory and can recall/remember on demand.'));
      return;
    }

    // Start over: take Jaffer off this Mac (see core/reset.ts). Run from another terminal, never from Jaffer's own: the session ends.
    case 'reset': {
      if (process.env.JAFFER_SESSION) throw new Error("This shell is Jaffer's own session, and resetting ends it. Run `jaffer reset` from another terminal (Terminal.app), or use Settings → Reset in the app.");
      const del = !!flag('delete');
      if (!flag('yes')) {
        if (!process.stdin.isTTY) throw new Error(`This ends your Jaffer session and removes its memory, settings, hooks and memory tools${del ? '' : ' (a backup of ' + paths.home + ' is kept)'}. Run again with --yes to confirm.`);
        console.log(`${bold('Reset Jaffer')}: ends the session and removes Jaffer's memory, settings and hooks (Claude Code and its login are not touched).`);
        console.log(del ? 'Nothing is kept.' : `A copy of ${paths.home} is kept next to it as a backup.`);
        const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question('Type reset to continue: ');
        rl.close();
        if (answer.trim().toLowerCase() !== 'reset') {
          console.log('Cancelled. Nothing was changed.');
          return;
        }
      }
      const running = await tryConnect(paths);
      if (running) {
        await running.call('app.shutdown', {}).catch(() => undefined);
        running.close();
        for (let i = 0; i < 40 && (await tryConnect(paths, 300).then((c) => (c?.close(), !!c))); i++) await new Promise((r) => setTimeout(r, 150));
      }
      const res = await resetJaffer({ home: paths.home, backup: !del });
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
        const mem = await client.call('memory.stats', {});
        const auth = await client.call('setup.claude.auth', {});
        console.log(`daemon: ${green('running')} pid ${hello.pid} · v${hello.version} · since ${hello.startedAt}`);
        console.log(`session: cwd ${info.cwd}${info.project ? ` · project ${path.basename(info.project)}${info.branch ? '@' + info.branch : ''}` : ''}${info.busy ? ` · running: ${info.busy}` : ''}`);
        console.log(`memory: ${mem.active} active · ${mem.pinned} pinned · ${mem.skills} skills · ${mem.episodesPending} events pending reflection`);
        console.log(`claude: ${auth.loggedIn ? green('signed in') : auth.installed ? red('signed out') + dim(' (run `claude auth login`)') : red('Claude Code not installed')}`);
        client.close();
      }
      if (cmd === 'doctor') {
        const cs = await claudeStatus();
        console.log(`claude code: ${cs.claudeInstalled ? cs.claudePath : red('not found')} · hooks ${cs.hooks ? green('on') : 'off'} · mcp ${cs.mcp ? green('on') : 'off'}`);
        for (const t of detectTargets()) console.log(`${t.label}: ${t.installed ? 'installed' : dim('not installed')}`);
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
          launchDaemon(paths, launcher());
          console.log('starting…');
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
        if (client) await client.call('config.patch', patch);
        else cfgStore.patch(patch);
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
  process.stderr.write(red(`jaffer: ${e instanceof Error ? e.message : e}\n`));
  process.exit(1);
});
