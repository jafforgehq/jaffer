import type { VNode } from 'preact';

type P = { size?: number; class?: string };
const base = (size = 16) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' as const, 'stroke-linejoin': 'round' as const });

export const IconAgent = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
    <path d="M19 15l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9z" />
  </svg>
);
export const IconBrain = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M9 4a3 3 0 00-3 3 3 3 0 00-2 2.8A3 3 0 005 14a3 3 0 003 4 3 3 0 004 1V5a3 3 0 00-3-1z" />
    <path d="M15 4a3 3 0 013 3 3 3 0 012 2.8A3 3 0 0119 14a3 3 0 01-3 4 3 3 0 01-4 1V5a3 3 0 013-1z" />
  </svg>
);
export const IconTerminal = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M4 17l6-6-6-6" />
    <path d="M12 19h8" />
  </svg>
);
export const IconFile = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
    <path d="M14 3v5h5" />
  </svg>
);
export const IconSearch = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4-4" />
  </svg>
);
export const IconPin = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M12 17v5" />
    <path d="M9 3h6l-1 7 3 3H7l3-3-1-7z" />
  </svg>
);
export const IconX = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconCheck = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M5 12l5 5L20 7" />
  </svg>
);
export const IconSend = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M5 12h14" />
    <path d="M13 6l6 6-6 6" />
  </svg>
);
export const IconStop = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </svg>
);
export const IconGear = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </svg>
);
export const IconChevron = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
export const IconRefresh = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M20 11a8 8 0 10-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </svg>
);
export const IconSplit = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </svg>
);
export const IconPlus = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconUndo = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 010 12h-3" />
  </svg>
);
