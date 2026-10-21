/**
 * (1.4.0) The words a newcomer to Claude Code meets in Jaffer, in plain language: the Glossary (Help → Glossary…), the ⓘ buttons and the
 * first-time tips read these. Pure data; `short` is the popover's text (at most 220 characters), `more` the glossary's (at most 700).
 * Only what is sure about Claude Code is said here.
 */
export interface GlossaryEntry {
  id: string;
  title: string;
  short: string;
  more: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    id: 'session',
    title: 'Session',
    short: 'A session is one conversation with Claude Code, from the moment you start claude until you quit it. The ring in the title bar and the Now card follow the session in your terminal.',
    more: 'Each session has its own id and its own conversation file, so you can come back to it later with claude --resume. The session clock counts from when Jaffer first heard from it, and the turn count says how many times Claude has answered.',
  },
  {
    id: 'turn',
    title: 'Turn',
    short: 'A turn is one round: you send a prompt, Claude works (it reads, runs tools, edits files), and the turn ends when it stops and waits for you again.',
    more: 'The ring in the title bar fills against how long your turns usually take. The small bars in the Now card are your last turns: a taller bar took longer. "Claude worked … today" adds up the turns that finished today. Long turns usually read and write more, so they use more tokens.',
  },
  {
    id: 'model',
    title: 'Model',
    short: 'The model is the version of Claude that answers you, such as Opus, Sonnet or Haiku. Larger models are usually more capable; smaller ones are faster.',
    more: 'You choose it in Claude Code with /model. The model sets how big the context window is and which price Jaffer uses for its cost estimate. Jaffer never chooses or changes the model.',
  },
  {
    id: 'context-window',
    title: 'Context window',
    short: 'The context window is how much Claude can keep in mind at once: your messages, its replies, the files it read and the results of its tools, counted in tokens.',
    more: "While auto-compact is on, Claude Code compacts the conversation by itself when it gets close to full, to make room. Jaffer's context meter in the Now card is an estimate from the token counts of the latest response: it turns yellow from 80% and red from 92%.",
  },
  {
    id: 'compaction',
    title: 'Compaction',
    short: 'Compaction is how Claude Code makes room: it replaces the older part of the conversation with a summary, so the session can go on.',
    more: 'With auto-compact on, it happens by itself near the limit of the context window, and you can start it yourself with /compact. Details from early in the session may be shortened, so say again what still matters. While it runs, the ring in the title bar turns dotted.',
  },
  {
    id: 'token',
    title: 'Token',
    short: 'A token is a small piece of text, often part of a word. Claude reads and writes text as tokens, and the context window and prices are counted in them.',
    more: 'In English a token is roughly three or four characters; code and other languages differ. Jaffer reads only the token counts from your conversation files to estimate the cost and how full the context is, never the text around them.',
  },
  {
    id: 'cost-estimate',
    title: 'Cost estimate',
    short: "Jaffer's dollar figures are estimates: the token counts priced at Anthropic's public API list prices. A Claude subscription is not billed per token.",
    more: "Use them to compare turns, days and projects, not as a bill. Your plan's usage limits are counted by Anthropic, not by Jaffer. A model missing from the price table shows tokens and no dollars. You can turn the figures off in Settings → Claude Code.",
  },
  {
    id: 'subagent',
    title: 'Subagent',
    short: 'A subagent is a helper Claude that the main Claude starts for a side task. It works in its own context and reports back a result.',
    more: 'Claude Code has built-in helpers, and you can define your own in .claude/agents (for a project) or ~/.claude/agents (for you). Jaffer shows each running helper as an extra small mole and lists it in the Now card, without its id.',
  },
  {
    id: 'hook',
    title: 'Hook',
    short: 'A hook is a command Claude Code runs at a set moment, for example before a tool runs or when a turn ends.',
    more: "Hooks are set in Claude Code's settings files. When you connect Jaffer, it adds its own hooks so it can follow what Claude does in Jaffer's terminal: they report what Claude does, and the optional permission hook (off unless you switch it on) can answer allow or deny after your click. The Setup list shows how many hooks each event has.",
  },
  {
    id: 'mcp',
    title: 'MCP server',
    short: 'An MCP server is a small program that gives Claude extra tools, such as reading an issue tracker or a database. MCP stands for Model Context Protocol.',
    more: "You add servers with claude mcp add, and a project can list them in its .mcp.json. Check MCP servers in the Setup list starts each one briefly to see whether it answers. A server that needs you to sign in says so, and you do that in Claude Code.",
  },
  {
    id: 'skill',
    title: 'Skill',
    short: 'A skill is a folder of instructions (a SKILL.md file) that teaches Claude how to do one kind of task. Claude uses it when that task comes up.',
    more: "Your own skills live in ~/.claude/skills and a project's in .claude/skills; plugins can bring skills too. The Setup list shows the skills it finds for the terminal's folder, and whether each is on.",
  },
  {
    id: 'plugin',
    title: 'Plugin',
    short: 'A plugin is a package that adds to Claude Code in one install: skills, commands, subagents, hooks or MCP servers.',
    more: 'Plugins are installed from marketplaces in Claude Code, and each can be turned on or off. The Setup list shows the installed ones and whether they are on. Jaffer only reads this; it never changes a setting.',
  },
  {
    id: 'rules',
    title: 'CLAUDE.md and rules',
    short: 'CLAUDE.md files hold standing instructions that Claude reads at the start of every session: how to build and test a project, its style, what to avoid.',
    more: "There is one for you (~/.claude/CLAUDE.md) and one for each project (CLAUDE.md in the folder or a folder above it). Files in .claude/rules can hold more rules, some only for certain paths. Claude Code calls these memory. They are plain text files: edit them as you like.",
  },
  {
    id: 'permission-prompt',
    title: 'Permission prompt',
    short: "When Claude wants to do something its rules don't already allow, such as running a command or editing a file, Claude Code asks you to allow or deny it.",
    more: 'You answer in the terminal. With Answer permission prompts from the notification on (Settings → Privacy and permissions), Jaffer can show the request too; Allow there needs your own click with the whole request shown. Jaffer never answers for you.',
  },
  {
    id: 'plan-mode',
    title: 'Plan mode',
    short: 'In plan mode Claude looks around and writes a plan first, without editing files, and presents it for your approval before any work starts.',
    more: 'In Claude Code, Shift+Tab switches between its modes, plan mode among them. When the plan looks right, you approve it and Claude goes ahead.',
  },
  {
    id: 'transcript',
    title: 'Conversation file',
    short: 'Claude Code saves every session as a conversation file (a transcript): a JSONL file under ~/.claude/projects, one folder per project.',
    more: "These files are what make resuming possible. Jaffer's Past conversations list reads only a little of each: its id, folder, times, a title and token counts. Removing a conversation moves its file to the Trash, never deletes it for good.",
  },
  {
    id: 'resume',
    title: 'Resume',
    short: 'Resuming starts Claude Code again with an earlier session, history and all, so you can carry on where you left off.',
    more: 'Click a past conversation in the side panel (or press ⇧⌘R for the latest one) and Jaffer types claude --resume with its id at an idle prompt. With Type the resume line for you off (Settings → Privacy and permissions), it only copies the command.',
  },
  {
    id: 'companion',
    title: 'Companion',
    short: 'The companion is the little mole (or scene) that lives in each terminal. It digs while something runs and pops up when Claude needs you.',
    more: 'Each helper Claude gets its own small mole. Choose another companion, its size, or switch it off in Settings → Appearance. It only shows what Claude Code reports; it never does anything itself.',
  },
  {
    id: 'side-panel',
    title: 'Side panel',
    short: 'The side panel (⌘B) shows what Claude is doing now, your past conversations, and how Claude Code is set up in this folder.',
    more: 'Drag its left edge to make it wider or narrower. Closed, it reads nothing. What it shows is redacted like the rest of the window, so secrets in commands are hidden.',
  },
  {
    id: 'split-terminals',
    title: 'Split terminals',
    short: 'Press ⌘D to split the window into up to four terminals, each with its own shell. ⌘1 to ⌘4 move between them and ⇧⌘W closes one.',
    more: 'The terminal with the outline is the focused one: the Now card, resume and the menus act on it. Quitting Jaffer ends every terminal, and none of them is saved.',
  },
];

export const glossaryEntry = (id: string): GlossaryEntry | undefined => GLOSSARY.find((e) => e.id === id);

/** The entries whose title, short line or more holds `q` (case-insensitive; only its first 64 characters count); all for an empty `q`. */
export function searchGlossary(q: string): GlossaryEntry[] {
  const t = q.slice(0, 64).trim().toLowerCase();
  if (!t) return GLOSSARY;
  return GLOSSARY.filter((e) => `${e.title}\n${e.short}\n${e.more}`.toLowerCase().includes(t));
}
