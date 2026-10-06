import type { JafferConfig } from '../../shared/config';
import { assessCommand, assessFileRead, assessFileWrite, type Assessment } from './permissions';
import { resolvePath } from './tools';

/**
 * What a tool call may do without asking, for both agent engines. Names are Jaffer's own (`run_command`,
 * `edit_file`, …); the Claude Code engine normalises Claude's tool names to these before asking.
 */
export function assessTool(name: string, input: any, agent: JafferConfig['agent'], cwd: string): Assessment {
  switch (name) {
    case 'run_command':
      return assessCommand(String(input?.command ?? ''), agent.approvals, agent.allow);
    case 'read_file':
      return assessFileRead(resolvePath(String(input?.path ?? ''), cwd));
    case 'list_dir':
    case 'search_files':
    case 'read_terminal':
    case 'recall':
      return { verdict: 'auto', risk: 'read', reason: 'read-only' };
    case 'write_file':
    case 'edit_file':
      return assessFileWrite(resolvePath(String(input?.path ?? ''), cwd), agent.approvals, agent.allow, name);
    case 'terminal_input':
      return { verdict: 'ask', risk: 'risky', reason: 'types into the program running in your terminal' };
    case 'remember':
    case 'forget':
      return { verdict: 'auto', risk: 'write', reason: 'updates your memory (visible and reversible in the Memory panel)' };
    default:
      return { verdict: 'deny', risk: 'risky', reason: `unknown tool ${name}` };
  }
}
