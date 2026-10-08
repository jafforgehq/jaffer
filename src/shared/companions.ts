/** The little animation in the corner of the terminal. The mole is the original; the rest are scenes. */
export const COMPANIONS = [
  { id: 'mole', name: 'Mole', blurb: 'digs while something runs; a helper mole for every agent' },
  { id: 'matrix', name: 'Matrix', blurb: 'digital rain; every agent is a bright column' },
  { id: 'agents', name: 'Agent network', blurb: 'nodes passing data back and forth' },
  { id: 'warp', name: 'Warp', blurb: 'a starfield at speed, a wingman per agent' },
  { id: 'radar', name: 'Radar', blurb: 'a sweep and a blip per agent' },
  { id: 'core', name: 'Reactor core', blurb: 'rings, energy bars and orbiting agents' },
] as const;

export type Companion = (typeof COMPANIONS)[number]['id'];
export const DEFAULT_COMPANION: Companion = 'mole';

/** Whatever a config file says, a companion that exists: anything else (a typo, a variant from a newer version) is the mole. */
export function companionOf(v: unknown): Companion {
  return COMPANIONS.some((c) => c.id === v) ? (v as Companion) : DEFAULT_COMPANION;
}
