/**
 * (1.4.0) The tour (Help → Take the Tour): eight coach marks over real parts of the window. `target` is the `data-tour` mark of the
 * element the step points at; `needs` is what has to be shown first (the side panel, the Setup section expanded, Settings open on
 * Privacy). `action` is the one Try it of a step: it runs a named UI action and nothing else (the tour types nothing and changes no
 * setting but `tour.done`). Pure data.
 */
export interface TourStep {
  id: string;
  target: string;
  title: string;
  /** One to three sentences. */
  text: string;
  /** One line each, under the text (the privacy step's switches). */
  lines?: string[];
  needs?: 'panel' | 'setup' | 'settings';
  action?: { label: string; run: 'palette' | 'split-terminal' | 'settings' };
  /** A glossary entry the step is about. */
  glossary?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'terminal',
    target: 'panes',
    title: 'Your terminal',
    text: 'This is an ordinary shell: run your commands here, and start Claude Code with claude (or ⇧⌘C). ⌘D adds another terminal, up to four.',
  },
  {
    id: 'now',
    target: 'now',
    title: 'The Now card',
    text: 'What Claude is doing right now: the tool it uses and how long the turn has run. It also shows an estimate of the cost and how full the context is.',
    needs: 'panel',
    glossary: 'context-window',
  },
  {
    id: 'conversations',
    target: 'conversations',
    title: 'Past conversations',
    text: 'Every Claude Code session you had, newest first. Click one to resume it where you left off. The pencil renames it, and tags help you sort them.',
    needs: 'panel',
    glossary: 'resume',
  },
  {
    id: 'palette',
    target: 'titlebar',
    title: 'The command palette',
    text: 'Press ⌘P for every action Jaffer has, and to find a past conversation by its name. It opens up here.',
    action: { label: 'Try it', run: 'palette' },
  },
  {
    id: 'split',
    target: 'panes',
    title: 'Split terminals',
    text: '⌘D splits the window into up to four terminals, each with its own shell. Close the focused one with ⇧⌘W or its ✕.',
    action: { label: 'Try it', run: 'split-terminal' },
    glossary: 'split-terminals',
  },
  {
    id: 'setup',
    target: 'setup',
    title: 'Setup',
    text: "What Claude Code is set up with in this folder: MCP servers, skills, rules, plugins and hooks. It only reads; it changes nothing.",
    needs: 'setup',
  },
  {
    id: 'privacy',
    target: 'settings-privacy',
    title: 'Privacy and permissions',
    text: 'Jaffer only reads or does what you allow, one switch each.',
    lines: [
      'Explain: sends Claude’s latest reply to a helper Claude to explain it (off at first).',
      'Search text: scans your conversation files when you search them (off at first).',
      'Type the resume line: a click on a past conversation types claude --resume for you (on).',
      'Trash: lets you move past conversations to the Trash, always asking first (on).',
      'Notification answers: shows Claude’s permission prompts outside the terminal too (off).',
    ],
    needs: 'settings',
    action: { label: 'Open Settings', run: 'settings' },
    glossary: 'permission-prompt',
  },
  {
    id: 'learn',
    target: 'now-info',
    title: 'Learn as you go',
    text: 'Click ⓘ anywhere for a short explanation of what you see. Help → Glossary… has all the words in one place.',
    needs: 'panel',
  },
];
