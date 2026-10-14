import type { VNode } from 'preact';

type P = { size?: number; class?: string };
const base = (size = 16) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' as const, 'stroke-linejoin': 'round' as const });

export const IconAgent = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
    <path d="M19 15l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9z" />
  </svg>
);
export const IconTerminal = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M4 17l6-6-6-6" />
    <path d="M12 19h8" />
  </svg>
);
export const IconSearch = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4-4" />
  </svg>
);
export const IconX = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconGear = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
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
export const IconInfo = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
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
export const IconPencil = ({ size, class: c }: P): VNode => (
  <svg {...base(size)} class={c}>
    <path d="M4 20h4L19 9l-4-4L4 16v4z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
);
