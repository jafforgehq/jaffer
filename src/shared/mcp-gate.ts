/**
 * (1.4.1) `claude mcp list` starts every server it lists. It does not start a project's unapproved `.mcp.json` servers (verified on Claude
 * Code 2.1.302: "Pending approval"), but a repository's own `.claude/settings.json` can pre-approve them (`enableAllProjectMcpServers`,
 * `enabledMcpjsonServers`), and Jaffer's spawn has no TTY (Claude Code skips its trust dialog then). So the check runs from the home folder
 * when the folder has a `.mcp.json` and settings that pre-approve its servers.
 *
 * `heads` holds each settings file as text, `undefined` when it is not there and `null` when it could not be read (over the bound, not a
 * regular file, a link out of the folder): that is a doubt, and a doubt gates. Text that is not JSON is ignored, as Claude Code ignores
 * settings that fail validation.
 */
export function mcpGate(heads: readonly (string | null | undefined)[], mcpJsonExists: boolean): boolean {
  if (!mcpJsonExists) return false;
  for (const h of heads) {
    if (h === undefined) continue;
    if (h === null) return true;
    let j: unknown;
    try {
      j = JSON.parse(h);
    } catch {
      continue;
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
    const o = j as Record<string, unknown>;
    if (o.enableAllProjectMcpServers || (Array.isArray(o.enabledMcpjsonServers) && o.enabledMcpjsonServers.length > 0)) return true;
  }
  return false;
}

/** What the Setup panel says when the check ran from the home folder instead. */
export const MCP_GATED_NOTE = "This folder's settings pre-approve its project servers, so Jaffer did not check them.";
