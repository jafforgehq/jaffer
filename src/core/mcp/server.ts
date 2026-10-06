import readline from 'node:readline';

/**
 * A small Model Context Protocol server (JSON-RPC 2.0, newline-delimited over stdio) that exposes
 * Jaffer's memory to any MCP-capable agent — Claude Code first among them — so external agents
 * read from, and write to, the same self-evolving memory as the built-in one.
 */

export type Call = (method: string, params: any) => Promise<any>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: any, ctx: { cwd: string }): Promise<string>;
}

const INSTRUCTIONS = `Jaffer is the user's terminal. It keeps a long-term memory of the user — preferences, project conventions, lessons learned, and procedures that worked — and updates it automatically from their sessions.
- Call jaffer_context at the start of non-trivial work in a project to load what is already known.
- Call jaffer_recall when you need background (how this project is built, past decisions, what the user prefers).
- Call jaffer_remember when the user states a durable preference/convention or after solving something non-obvious. One self-contained sentence. Never store secrets or task-specific temporary details.
- Call jaffer_forget when a memory is wrong or the user asks you to forget something.`;

/** Tools that act in the user's own terminal session. Offered only to Jaffer's own panel agent, never to a Claude Code you run yourself. */
function sessionTools(call: Call): Tool[] {
  const outcome = async (name: string, input: unknown): Promise<string> => {
    const r = await call('agent.tool', { name, input });
    if (r.isError) throw new Error(r.output);
    return r.output;
  };
  return [
    {
      name: 'run_command',
      description: "Run a shell command in the user's own terminal session. It is typed into their real shell, visible to them, and shares its working directory, environment variables and virtualenvs. Returns the exit code and the output. Use this for every shell command (do not use Bash).",
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'number', description: 'Give up waiting after this long (default 120). The command keeps running.' } }, required: ['command'] },
      run: (a) => outcome('run_command', a),
    },
    {
      name: 'read_terminal',
      description: "Read the last lines of the user's terminal screen: what is running and what it printed.",
      inputSchema: { type: 'object', properties: { lines: { type: 'number' } }, required: [] },
      run: (a) => outcome('read_terminal', a),
    },
  ];
}

export function makeTools(call: Call, opts: { session?: boolean } = {}): Tool[] {
  return [
    ...(opts.session ? sessionTools(call) : []),
    {
      name: 'jaffer_context',
      description: "Load what Jaffer knows that is relevant to the current project and (optionally) a topic: the user's preferences, conventions, lessons and learned procedures.",
      inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'Optional focus, e.g. "deploying" or "tests".' } }, required: [] },
      run: async (a, { cwd }) => {
        const text: string = await call('memory.context', { cwd, query: a?.topic, budget: 5000 });
        return text.trim() || 'Nothing relevant is stored yet.';
      },
    },
    {
      name: 'jaffer_recall',
      description: "Search Jaffer's long-term memory. Returns matching memories with ids, and learned procedures (skills).",
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      run: async (a, { cwd }) => {
        const r = await call('memory.recall', { query: String(a?.query ?? ''), cwd, limit: Math.min(15, Number(a?.limit) || 8) });
        const lines = (r.items as any[]).map((i) => `- [${i.id}] (${i.kind}, ${i.scope === 'global' ? 'global' : 'project'}, confidence ${i.confidence}) ${i.text}`);
        for (const s of r.skills as any[]) lines.push(`- skill "${s.name}": ${s.whenToUse} → ${(s.steps as string[]).join(' ; ')}`);
        return lines.length ? lines.join('\n') : 'No matching memories.';
      },
    },
    {
      name: 'jaffer_remember',
      description: 'Save a durable memory: a user preference, a project convention, a lesson, or a useful fact. One self-contained sentence. Never store secrets or transient details.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: ['preference', 'convention', 'fact', 'workflow', 'lesson'] },
          scope: { type: 'string', enum: ['global', 'project'], description: "'project' ties it to the current project (default 'global')." },
        },
        required: ['text'],
      },
      run: async (a, { cwd }) => {
        const r = await call('memory.remember', { text: String(a?.text ?? ''), kind: a?.kind, scope: a?.scope === 'project' ? 'project' : 'global', cwd, source: 'agent' });
        return r.deduped ? `Already known (reinforced): ${r.item.text}` : `Remembered [${r.item.id}]: ${r.item.text}`;
      },
    },
    {
      name: 'jaffer_forget',
      description: 'Forget a memory by id (from jaffer_recall) or by describing it.',
      inputSchema: { type: 'object', properties: { id_or_description: { type: 'string' } }, required: ['id_or_description'] },
      run: async (a) => {
        const r = await call('memory.forget', { id: String(a?.id_or_description ?? '') });
        return r.archived.length ? `Forgot: ${r.archived.map((i: any) => i.text).join(' | ')}` : 'Nothing matched.';
      },
    },
  ];
}

export interface McpOptions {
  call: Call;
  version: string;
  cwd?: string;
  /** Also offer the terminal tools (only for the panel agent's own Claude Code process). */
  session?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export function runMcpServer(o: McpOptions): { close(): void } {
  const tools = makeTools(o.call, { session: o.session });
  const out = o.output ?? process.stdout;
  const cwd = o.cwd ?? process.cwd();
  const send = (msg: unknown) => out.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: o.input ?? process.stdin });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: { jsonrpc?: string; id?: number | string | null; method?: string; params?: any };
    try {
      req = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const id = req.id;
    const reply = (result: unknown) => id !== undefined && id !== null && send({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => id !== undefined && id !== null && send({ jsonrpc: '2.0', id, error: { code, message } });

    switch (req.method) {
      case 'initialize': {
        const requested = typeof req.params?.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.params.protocolVersion) ? req.params.protocolVersion : '2025-06-18';
        reply({ protocolVersion: requested, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'jaffer', version: o.version }, instructions: INSTRUCTIONS });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
        return;
      case 'tools/call': {
        const tool = tools.find((t) => t.name === req.params?.name);
        if (!tool) {
          fail(-32602, `Unknown tool: ${req.params?.name}`);
          return;
        }
        tool
          .run(req.params?.arguments ?? {}, { cwd })
          .then((text) => reply({ content: [{ type: 'text', text }] }))
          .catch((e) => reply({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }));
        return;
      }
      default:
        if (id !== undefined && id !== null) fail(-32601, `Method not found: ${req.method}`);
    }
  });
  return { close: () => rl.close() };
}
