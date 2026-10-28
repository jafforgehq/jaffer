/**
 * (1.4.1) The daemon methods the window's page may call through main (`jaffer:call`): exactly those the renderer names in its
 * `call('…')` sites (`test/page-methods.test.ts` keeps the two in step). Anything else is refused with `NOT_ALLOWED`. Main's own calls
 * to the daemon do not pass here. Never on it: `hello` (a client says who it is), `claude.event` and `claude.approval` (the hook CLI's
 * own), `session.snapshot` (the page draws the terminal from `session.attach` and the stream) and `app.shutdown` (the app ends its
 * child itself).
 */
export const ALLOWED_PAGE_METHODS: ReadonlySet<string> = new Set([
  'claude.approval.answer',
  'claude.approvals',
  'claude.explain',
  'claude.explain.supported',
  'claude.history',
  'claude.hooks',
  'claude.mcp',
  'claude.old',
  'claude.search',
  'claude.setup',
  'claude.state',
  'claude.storage',
  'claude.usage5h',
  'config.get',
  'config.patch',
  'pane.close',
  'pane.list',
  'pane.split',
  'pty.resize',
  'pty.write',
  'session.attach',
  'session.detach',
  'session.info',
  'session.restart',
  'setup.claude.auth',
  'setup.claude.install',
  'setup.claude.login',
  'setup.claude.remove',
  'setup.claude.status',
  'setup.cli.install',
]);

/** What the page hears for a method it may not call (fixed: it says nothing about the method). */
export const NOT_ALLOWED = 'Not allowed.';

export function pageMayCall(method: unknown): method is string {
  return typeof method === 'string' && ALLOWED_PAGE_METHODS.has(method);
}
