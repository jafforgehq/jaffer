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

// ---- second set (session rail, cards, palette)
export const IconSidebar = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9 4v16" />
  </svg>
);
export const IconFolder = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V17a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
  </svg>
);
export const IconBranch = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="6" cy="5.5" r="2" />
    <circle cx="6" cy="18.5" r="2" />
    <circle cx="18" cy="8.5" r="2" />
    <path d="M6 7.5v9M18 10.5c0 4-6 3-11 6.2" />
  </svg>
);
export const IconClock = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const IconPlay = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M7 5l12 7-12 7V5z" fill="currentColor" />
  </svg>
);
export const IconCheckCircle = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.7 2.7L16 9.8" />
  </svg>
);
export const IconXCircle = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </svg>
);
export const IconChevronDown = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
export const IconShield = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" />
    <path d="M9 12l2.2 2.2L15.5 10" />
  </svg>
);
export const IconDownload = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M12 4v11" />
    <path d="M7.5 11L12 15.5 16.5 11" />
    <path d="M5 19h14" />
  </svg>
);
export const IconReset = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M4 12a8 8 0 108-8 8 8 0 00-5.7 2.4L4 8.5" />
    <path d="M4 3.5v5h5" />
  </svg>
);
export const IconBolt = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z" />
  </svg>
);
export const IconPanelRight = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M15 4v16" />
  </svg>
);
export const IconPalette = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M12 3a9 9 0 100 18c1.3 0 2-.9 2-1.8 0-1.2-1-1.6-1-2.7 0-.9.7-1.5 1.7-1.5H17a4 4 0 004-4c0-4.4-4-8-9-8z" />
    <circle cx="7.5" cy="11" r="1" fill="currentColor" />
    <circle cx="10" cy="7" r="1" fill="currentColor" />
    <circle cx="15" cy="7.5" r="1" fill="currentColor" />
  </svg>
);
export const IconPlug = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0V8zM12 17v4" />
  </svg>
);
export const IconBook = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M5 4.5A1.5 1.5 0 016.5 3H19v15H6.5A1.5 1.5 0 005 19.5v-15z" />
    <path d="M5 19.5A1.5 1.5 0 006.5 21H19v-3" />
  </svg>
);
export const IconSliders = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </svg>
);
export const IconCpu = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </svg>
);
export const IconInfo = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);
export const IconUser = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
  </svg>
);
export const IconCopy = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
  </svg>
);
export const IconEdit = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M4 20h4L19 9l-4-4L4 16v4z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
);
export const IconList = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
  </svg>
);
export const IconLightbulb = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0012 3z" />
  </svg>
);
export const IconLayout = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M9 9v11" />
  </svg>
);
export const IconCommandKey = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M9 9V7a3 3 0 10-3 3h12a3 3 0 10-3-3v10a3 3 0 103-3H6a3 3 0 103 3V9" />
  </svg>
);
export const IconDot = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
  </svg>
);
export const IconArrowUp = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
export const IconWand = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M5 19L15 9M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2zM19 12l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7.7-1.5z" />
  </svg>
);
