import { useState } from 'preact/hooks';
import type { VNode } from 'preact';

/** Anthropic's official install command for Claude Code on macOS. */
const INSTALL_CMD = 'curl -fsSL https://claude.ai/install.sh | bash';

export function InstallCommand(): VNode {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(INSTALL_CMD).then(() => setCopied(true)).catch(() => undefined);
  };
  return (
    <div class="ob-cmdrow">
      <code class="ob-cmd">{INSTALL_CMD}</code>
      <button class="btn small" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
