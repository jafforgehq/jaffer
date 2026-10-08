import { describe, expect, it } from 'vitest';
import { COMPANIONS, companionOf, DEFAULT_COMPANION } from '../src/shared/companions';
import type { Effort } from '../src/shared/pet-effort';
import type { PetMood } from '../src/shared/pet-mood';
import {
  agentEdges,
  agentNodes,
  AGENT_HUB,
  constellation,
  coreSatellites,
  MATRIX_AGENT_COLUMNS,
  MATRIX_COLUMNS,
  MATRIX_ROWS,
  matrixColumns,
  matrixShown,
  packetsPerLink,
  starsShown,
  radarBlips,
  SCENE_H,
  SCENE_W,
  SCOPE,
  sceneDensity,
  sceneTempo,
  warpShips,
  warpStars,
  WARP_FLAGSHIP,
} from '../src/shared/scene-geometry';

const inside = (p: { x: number; y: number }, margin = 0) => p.x >= margin && p.x <= SCENE_W - margin && p.y >= margin && p.y <= SCENE_H - margin;
const apart = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('companions', () => {
  it('has the mole first and by default, and six companions with unique ids, names and a line each', () => {
    expect(COMPANIONS[0].id).toBe('mole');
    expect(DEFAULT_COMPANION).toBe('mole');
    expect(COMPANIONS.map((c) => c.id)).toEqual(['mole', 'matrix', 'agents', 'warp', 'radar', 'core']);
    expect(new Set(COMPANIONS.map((c) => c.name)).size).toBe(COMPANIONS.length);
    for (const c of COMPANIONS) expect(c.blurb.length).toBeGreaterThan(10);
  });

  it('whatever a config file says, is a companion that exists: anything else is the mole', () => {
    for (const c of COMPANIONS) expect(companionOf(c.id)).toBe(c.id);
    for (const bad of ['', 'Matrix', 'hologram', 'mole ', null, undefined, 3, {}, ['mole']]) expect(companionOf(bad), JSON.stringify(bad)).toBe('mole');
  });
});

describe('how hard a scene works', () => {
  const efforts: Effort[] = [0, 1, 2, 3];
  const moods: PetMood[] = ['sleep', 'rest', 'dig', 'alert', 'cheer'];

  it('the beat gets shorter the longer something has worked, and is always positive', () => {
    const t = efforts.map(sceneTempo);
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeLessThan(t[i - 1]!);
    for (const x of t) expect(x).toBeGreaterThan(0);
  });

  it('asleep is empty, idle is a little, working is a lot and more with effort, up to the most there is', () => {
    expect(sceneDensity('sleep', 0)).toBe(0);
    expect(sceneDensity('rest', 0)).toBe(1);
    const working = efforts.map((e) => sceneDensity('dig', e));
    expect(working).toEqual([3, 4, 5, 6]);
    for (const m of moods) for (const e of efforts) expect(sceneDensity(m, e)).toBeLessThanOrEqual(6);
    expect(sceneDensity('dig', 0)).toBeGreaterThan(sceneDensity('rest', 0));
    expect(sceneDensity('alert', 3)).toBeLessThan(sceneDensity('dig', 0)); // waiting for you is calmer than working
  });
});

describe('Matrix rain', () => {
  it('is the same every time, with every column inside the frame, evenly spread, each with its own glyphs, speed and phase', () => {
    const cols = matrixColumns();
    expect(matrixColumns()).toEqual(cols);
    expect(cols).toHaveLength(MATRIX_COLUMNS);
    for (const c of cols) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(SCENE_W);
      expect(c.glyphs).toHaveLength(MATRIX_ROWS);
      expect(c.speed).toBeGreaterThan(1);
      expect(c.phase).toBeGreaterThanOrEqual(0);
      expect(c.phase).toBeLessThan(1);
    }
    for (let i = 1; i < cols.length; i++) expect(cols[i]!.x).toBeGreaterThan(cols[i - 1]!.x);
    expect(new Set(cols.map((c) => c.phase)).size).toBeGreaterThan(MATRIX_COLUMNS - 3); // never all in step
    expect(new Set(cols.flatMap((c) => c.glyphs)).size).toBeGreaterThan(20);
  });

  it('brings the columns in a spread order, so a thin rain still covers the whole frame', () => {
    const cols = matrixColumns();
    expect(cols.map((c) => c.rank).sort((a, b) => a - b)).toEqual(Array.from({ length: MATRIX_COLUMNS }, (_, i) => i)); // every rank once
    for (const k of [4, 8, 12, 16]) {
      const xs = cols.filter((c) => c.rank < k).map((c) => c.x).sort((a, b) => a - b);
      expect(xs).toHaveLength(k);
      const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
      expect(Math.max(...gaps), `k=${k}`).toBeLessThanOrEqual((SCENE_W / k) * 2.1);
      expect(xs[0]!).toBeLessThan(SCENE_W * 0.3);
      expect(xs.at(-1)!).toBeGreaterThan(SCENE_W * 0.7);
    }
  });

  it('shows more columns the denser it is, none asleep and all at the most', () => {
    const shown = [0, 1, 2, 3, 4, 5, 6].map(matrixShown);
    expect(shown[0]).toBe(0);
    expect(shown[6]).toBe(MATRIX_COLUMNS);
    for (let i = 1; i < shown.length; i++) expect(shown[i]!).toBeGreaterThan(shown[i - 1]!);
    expect(matrixShown(99)).toBe(MATRIX_COLUMNS);
    expect(matrixShown(-3)).toBe(0);
    expect(matrixShown(NaN)).toBe(0);
  });

  it('keeps the agent columns apart and inside', () => {
    expect(MATRIX_AGENT_COLUMNS).toHaveLength(3);
    for (const i of MATRIX_AGENT_COLUMNS) expect(i).toBeLessThan(MATRIX_COLUMNS);
    const xs = MATRIX_AGENT_COLUMNS.map((i) => matrixColumns()[i]!.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThan(40);
  });
});

describe('Agent network', () => {
  it('seats 0 to 3 helpers inside the frame, apart from the hub and from each other, and never more than three', () => {
    expect(agentNodes(0)).toEqual([]);
    for (const n of [1, 2, 3]) {
      const nodes = agentNodes(n);
      expect(nodes).toHaveLength(n);
      for (const p of nodes) {
        expect(inside(p, 10), JSON.stringify(p)).toBe(true);
        expect(apart(p, AGENT_HUB)).toBeGreaterThan(40);
      }
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(apart(nodes[i]!, nodes[j]!)).toBeGreaterThan(28);
    }
    expect(agentNodes(9)).toHaveLength(3);
    expect(agentNodes(-2)).toEqual([]);
    expect(agentNodes(NaN)).toEqual([]);
    expect(agentNodes(2.9)).toHaveLength(2);
  });

  it('sends more data packets the harder it works, none while idle or waiting for you', () => {
    expect(packetsPerLink('sleep', 0)).toBe(0);
    expect(packetsPerLink('rest', 3)).toBe(0);
    expect(packetsPerLink('alert', 3)).toBe(0);
    expect([0, 1, 2, 3].map((e) => packetsPerLink('dig', e as Effort))).toEqual([1, 2, 3, 3]);
    expect(packetsPerLink('cheer', 0)).toBeGreaterThan(0);
  });

  it('links the hub to every helper and the helpers to each other, with no link twice', () => {
    expect(agentEdges(0)).toEqual([]);
    expect(agentEdges(1).map((e) => e.kind)).toEqual(['hub']);
    expect(agentEdges(2).map((e) => e.kind)).toEqual(['hub', 'hub', 'peer']);
    expect(agentEdges(3).map((e) => e.kind)).toEqual(['hub', 'hub', 'hub', 'peer', 'peer', 'peer']);
    for (const n of [1, 2, 3]) {
      const keys = agentEdges(n).map((e) => [e.from, e.to].map((p) => `${p.x},${p.y}`).sort().join('|'));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('has a faint constellation of stable points inside the frame', () => {
    const c = constellation();
    expect(constellation()).toEqual(c);
    expect(c.length).toBeGreaterThan(10);
    for (const p of c) expect(inside(p, 4)).toBe(true);
  });
});

describe('Warp', () => {
  it('flies every star from near the centre out to the edge of the frame, the same stars every time', () => {
    const stars = warpStars();
    expect(warpStars()).toEqual(stars);
    expect(stars.length).toBeGreaterThan(20);
    for (const s of stars) {
      expect(inside({ x: s.x1, y: s.y1 }), 'start').toBe(true);
      expect(inside({ x: s.x2, y: s.y2 }, 2.9), 'end').toBe(true);
      expect(Math.hypot(s.x2 - s.x1, s.y2 - s.y1)).toBeGreaterThan(5);
      expect(s.speed).toBeGreaterThan(1);
    }
    expect(new Set(stars.map((s) => Math.round(Math.atan2(s.y2 - 38, s.x2 - 120) * 20))).size).toBeGreaterThan(15); // all directions
  });

  it('flies more stars the denser it is, and never fewer than a few', () => {
    const n = [0, 1, 2, 3, 4, 5, 6].map(starsShown);
    expect(n[0]).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < n.length; i++) expect(n[i]!).toBeGreaterThanOrEqual(n[i - 1]!);
    expect(n[6]).toBe(warpStars().length);
    expect(starsShown(NaN)).toBe(n[0]);
  });

  it('puts a wingman beside the flagship for each agent, inside the frame and apart', () => {
    expect(warpShips(0)).toEqual([]);
    for (const n of [1, 2, 3]) {
      const ships = warpShips(n);
      expect(ships).toHaveLength(n);
      for (const s of ships) {
        expect(inside(s, 8)).toBe(true);
        expect(apart(s, WARP_FLAGSHIP)).toBeGreaterThan(15);
      }
    }
    expect(warpShips(7)).toHaveLength(3);
  });
});

describe('Radar and Reactor core', () => {
  it('puts a blip for each agent inside the scope at the angle the sweep passes it', () => {
    expect(radarBlips(0)).toEqual([]);
    for (const n of [1, 2, 3]) {
      const blips = radarBlips(n);
      expect(blips).toHaveLength(n);
      for (const b of blips) {
        expect(apart(b, SCOPE)).toBeLessThan(SCOPE.r - 4);
        expect(apart(b, SCOPE)).toBeGreaterThan(8);
        // the angle really is where it sits, clockwise from up
        const deg = ((Math.atan2(b.x - SCOPE.x, SCOPE.y - b.y) * 180) / Math.PI + 360) % 360;
        expect(Math.abs(deg - b.angle)).toBeLessThan(0.01);
      }
    }
    expect(radarBlips(5)).toHaveLength(3);
  });

  it('puts a satellite for each agent on the reactor’s outer orbit', () => {
    expect(coreSatellites(0)).toEqual([]);
    for (const s of coreSatellites(3)) expect(apart(s, SCOPE)).toBeCloseTo(SCOPE.r - 3, 6);
    expect(coreSatellites(2)).toHaveLength(2);
  });

  it('keeps the scope inside the frame with room for a readout beside it', () => {
    expect(SCOPE.x - SCOPE.r).toBeGreaterThanOrEqual(0);
    expect(SCOPE.y - SCOPE.r).toBeGreaterThanOrEqual(0);
    expect(SCOPE.y + SCOPE.r).toBeLessThanOrEqual(SCENE_H);
    expect(SCENE_W - (SCOPE.x + SCOPE.r)).toBeGreaterThan(100);
  });
});
