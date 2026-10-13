import { describe, expect, it } from 'vitest';
import { toolCategory } from '../src/shared/tool-category';

describe('toolCategory: what kind of work a Claude Code tool is', () => {
  it('maps the tools by name, as Claude Code sends them', () => {
    expect(toolCategory('Bash')).toBe('shell');
    for (const t of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']) expect(toolCategory(t), t).toBe('read');
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(toolCategory(t), t).toBe('write');
    for (const t of ['WebFetch', 'WebSearch']) expect(toolCategory(t), t).toBe('web');
    for (const t of ['Task', 'Agent']) expect(toolCategory(t), t).toBe('agent');
  });

  it('anything else is other: MCP tools, unknown names, other spellings, nothing at all, names of Object properties', () => {
    for (const t of ['mcp__github__create_issue', 'TodoWrite', 'bash', 'EDIT', ' Bash', '', 'constructor', '__proto__', 'toString']) expect(toolCategory(t), t).toBe('other');
  });
});
