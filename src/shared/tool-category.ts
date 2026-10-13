/** What kind of work a Claude Code tool call is, from its name alone (as Claude Code sends it): the companion and the tool strip show it. */
export type ToolCategory = 'shell' | 'read' | 'write' | 'web' | 'agent' | 'other';

const CATEGORY = new Map<string, ToolCategory>([
  ['Bash', 'shell'],
  ['Read', 'read'],
  ['Grep', 'read'],
  ['Glob', 'read'],
  ['LS', 'read'],
  ['NotebookRead', 'read'],
  ['Edit', 'write'],
  ['Write', 'write'],
  ['MultiEdit', 'write'],
  ['NotebookEdit', 'write'],
  ['WebFetch', 'web'],
  ['WebSearch', 'web'],
  ['Task', 'agent'],
  ['Agent', 'agent'],
]);

export function toolCategory(name: string): ToolCategory {
  return CATEGORY.get(name) ?? 'other';
}
