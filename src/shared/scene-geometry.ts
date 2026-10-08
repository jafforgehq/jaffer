import type { PetMood } from './pet-mood';
import type { Effort } from './pet-effort';

/**
 * Where everything sits in the scenes that can replace the mole (Matrix, Agent network, Warp, Radar, Reactor core). One frame for all of
 * them, 240 × 80, so they share a corner. Pure numbers, so the layout is tested: everything inside the frame, always the same.
 */
export const SCENE_W = 240;
export const SCENE_H = 80;

/** A small seeded generator: the same scene every time, never `Math.random`. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Point {
  x: number;
  y: number;
}

/** How many helper agents a scene shows: 0 to 3, whatever it is asked (a missing or odd number is none). */
function agentCount(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.floor(n))) : 0;
}

// -------------------------------------------------------------------------------------------------------- how hard it works

/** Seconds of one beat: the faster the longer something has worked. Scenes multiply their own durations by it. */
export function sceneTempo(effort: Effort): number {
  return [1, 0.8, 0.6, 0.45][effort] ?? 1;
}

/**
 * How much is going on, 0 (nothing) to 6 (everything): the number of rain columns, stars or packets that show. Asleep is nothing,
 * Claude open and idle is a little, working is a lot and more the longer it goes on.
 */
export function sceneDensity(mood: PetMood, effort: Effort): number {
  switch (mood) {
    case 'sleep':
      return 0;
    case 'rest':
      return 1;
    case 'dig':
      return 3 + effort;
    case 'alert':
      return 2;
    case 'cheer':
      return 5;
  }
}

// -------------------------------------------------------------------------------------------------------- Matrix

export const MATRIX_COLUMNS = 22;
export const MATRIX_ROWS = 8;
/** Half-width katakana and digits, as in the film. */
const GLYPHS = 'ｦｧｨｩｪｫｬｭｮｯｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';

export interface RainColumn {
  x: number;
  /** The order columns come in as the rain gets denser: spread across the frame, never all on the left. */
  rank: number;
  glyphs: string[];
  /** Duration of one fall, in beats. */
  speed: number;
  /** Where in its fall it starts, 0..1 (so the columns are never in step). */
  phase: number;
}

/** 0..n-1 in bit-reversed order (0, 16, 8, 24, 4, …): any run of the first k is spread evenly over the whole. */
function spread(n: number): number[] {
  const bits = Math.ceil(Math.log2(n));
  const order: number[] = [];
  for (let i = 0; order.length < n && i < 1 << bits; i++) {
    let rev = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) rev |= 1 << (bits - 1 - b);
    if (rev < n) order.push(rev);
  }
  return order;
}

export function matrixColumns(): RainColumn[] {
  const r = rng(7);
  const order = spread(MATRIX_COLUMNS);
  return Array.from({ length: MATRIX_COLUMNS }, (_, i) => ({
    x: 7 + i * ((SCENE_W - 14) / (MATRIX_COLUMNS - 1)),
    rank: order.indexOf(i),
    glyphs: Array.from({ length: MATRIX_ROWS }, () => GLYPHS[Math.floor(r() * GLYPHS.length)]!),
    speed: 2.2 + r() * 2.2,
    phase: r(),
  }));
}

/** How many rain columns fall at a given density. */
export function matrixShown(density: number): number {
  return [0, 4, 8, 12, 16, 19, MATRIX_COLUMNS][Math.max(0, Math.min(6, Math.floor(density) || 0))]!;
}

/** The rain columns that are agents: spread across the frame, so each has room. */
export const MATRIX_AGENT_COLUMNS = [5, 11, 17] as const;
export const AGENT_LETTERS = ['α', 'β', 'γ'] as const;

// -------------------------------------------------------------------------------------------------------- Agent network

export const AGENT_HUB: Point = { x: 78, y: 40 };

/** Where the helper agents sit around the hub, for 0 to 3 of them. */
export function agentNodes(count: number): Point[] {
  const n = agentCount(count);
  return [
    [],
    [{ x: 170, y: 40 }],
    [
      { x: 160, y: 21 },
      { x: 160, y: 59 },
    ],
    [
      { x: 150, y: 17 },
      { x: 190, y: 40 },
      { x: 150, y: 63 },
    ],
  ][n]!;
}

export interface Edge {
  from: Point;
  to: Point;
  /** `hub` links the main agent to a helper; `peer` links two helpers (they talk to each other too). */
  kind: 'hub' | 'peer';
}

export function agentEdges(count: number): Edge[] {
  const nodes = agentNodes(count);
  const hub = nodes.map((to): Edge => ({ from: AGENT_HUB, to, kind: 'hub' }));
  const peers: Edge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const j = (i + 1) % nodes.length;
    if (nodes.length > 1 && (nodes.length > 2 || i < j)) peers.push({ from: nodes[i]!, to: nodes[j]!, kind: 'peer' });
  }
  return [...hub, ...peers];
}

/** The faint constellation behind the network. */
export function constellation(): Point[] {
  const r = rng(11);
  return Array.from({ length: 26 }, () => ({ x: 6 + r() * (SCENE_W - 12), y: 6 + r() * (SCENE_H - 12) }));
}

// -------------------------------------------------------------------------------------------------------- Warp

export const WARP_CENTRE: Point = { x: 120, y: 38 };

export interface Star {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** How long one pass takes, in beats, and where in it the star starts. */
  speed: number;
  phase: number;
}

/** Stars as lines from near the centre out to the edge of the frame in a fixed direction, so they can fly outwards. */
export function warpStars(): Star[] {
  const r = rng(3);
  const left = 3;
  const right = SCENE_W - 3;
  const top = 3;
  const bottom = SCENE_H - 3;
  return Array.from({ length: 38 }, () => {
    const a = r() * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // where the ray from the centre leaves the frame
    const tx = dx > 0 ? (right - WARP_CENTRE.x) / dx : dx < 0 ? (left - WARP_CENTRE.x) / dx : Infinity;
    const ty = dy > 0 ? (bottom - WARP_CENTRE.y) / dy : dy < 0 ? (top - WARP_CENTRE.y) / dy : Infinity;
    const t = Math.min(tx, ty);
    const t0 = 5 + r() * 10;
    return { x1: WARP_CENTRE.x + dx * t0, y1: WARP_CENTRE.y + dy * t0, x2: WARP_CENTRE.x + dx * t, y2: WARP_CENTRE.y + dy * t, speed: 1.4 + r() * 2.2, phase: r() };
  });
}

/** How many stars fly at a given density (a few always hang there, so the scene is never empty). */
export function starsShown(density: number): number {
  return [12, 16, 22, 26, 32, 38, 38][Math.max(0, Math.min(6, Math.floor(density) || 0))]!;
}

export const WARP_FLAGSHIP: Point = { x: 120, y: 52 };

/** Wingmen, one per agent, flying beside and behind the flagship. */
export function warpShips(count: number): Point[] {
  const n = agentCount(count);
  return [
    [],
    [{ x: 82, y: 60 }],
    [
      { x: 82, y: 60 },
      { x: 158, y: 60 },
    ],
    [
      { x: 82, y: 60 },
      { x: 158, y: 60 },
      { x: 120, y: 69 },
    ],
  ][n]!;
}

/** Data packets in flight on each link of the agent network: none while idle or waiting, more the harder it works. */
export function packetsPerLink(mood: PetMood, effort: Effort): number {
  if (mood === 'dig') return effort >= 2 ? 3 : effort === 1 ? 2 : 1;
  return mood === 'cheer' ? 2 : 0;
}

// -------------------------------------------------------------------------------------------------------- Radar and Reactor core

export const SCOPE: Point & { r: number } = { x: 56, y: 40, r: 33 };

export interface Blip extends Point {
  /** Degrees clockwise from straight up: when the sweep passes. */
  angle: number;
}

export function radarBlips(count: number): Blip[] {
  const n = agentCount(count);
  const spots = [
    { angle: 50, r: 0.62 },
    { angle: 165, r: 0.78 },
    { angle: 290, r: 0.5 },
  ].slice(0, n);
  return spots.map(({ angle, r }) => {
    const a = (angle * Math.PI) / 180;
    return { angle, x: SCOPE.x + Math.sin(a) * SCOPE.r * r, y: SCOPE.y - Math.cos(a) * SCOPE.r * r };
  });
}

/** Satellites on the reactor's outer orbit, one per agent. */
export function coreSatellites(count: number): Blip[] {
  const n = agentCount(count);
  return [20, 140, 260].slice(0, n).map((angle) => {
    const a = (angle * Math.PI) / 180;
    return { angle, x: SCOPE.x + Math.sin(a) * (SCOPE.r - 3), y: SCOPE.y - Math.cos(a) * (SCOPE.r - 3) };
  });
}

/** The bars of the energy readout. */
export const CORE_BARS = 14;
