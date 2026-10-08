import type { ComponentChildren, VNode } from 'preact';
import type { Companion } from '../../shared/companions';
import type { CrewMood } from '../../shared/pet-crew';
import type { Effort } from '../../shared/pet-effort';
import type { PetMood } from '../../shared/pet-mood';
import {
  AGENT_HUB,
  AGENT_LETTERS,
  agentEdges,
  agentNodes,
  constellation,
  coreSatellites,
  CORE_BARS,
  MATRIX_AGENT_COLUMNS,
  MATRIX_ROWS,
  matrixColumns,
  matrixShown,
  packetsPerLink,
  radarBlips,
  SCENE_H,
  SCENE_W,
  SCOPE,
  sceneDensity,
  sceneTempo,
  starsShown,
  warpShips,
  warpStars,
  WARP_FLAGSHIP,
} from '../../shared/scene-geometry';

/** One helper agent in a scene: what it is doing, and how long it has been at it. */
export interface SceneAgent {
  mood: CrewMood;
  effort: Effort;
}

export interface SceneProps {
  variant: Exclude<Companion, 'mole'>;
  mood: PetMood;
  effort: Effort;
  agents: SceneAgent[];
  label: string;
}

const px = (n: number): string => n.toFixed(1);

/**
 * The frame every scene shares: a dark panel in the corner of the terminal. Everything about how it moves is CSS keyed on
 * `data-mood`, `data-effort` and `data-density`, as the mole's is, so it stands still under Animations off and Reduce motion.
 */
function Frame({ p, children }: { p: SceneProps; children: ComponentChildren }): VNode {
  return (
    <svg
      class="scene"
      data-variant={p.variant}
      data-mood={p.mood}
      data-effort={p.effort}
      data-agents={p.agents.length}
      data-density={sceneDensity(p.mood, p.effort)}
      style={{ '--t': `${sceneTempo(p.effort)}s` } as never}
      viewBox={`0 0 ${SCENE_W} ${SCENE_H}`}
      role="img"
      aria-label={p.label}
    >
      <title>{p.label}</title>
      <defs>
        <clipPath id="scene-clip">
          <rect x="0.5" y="0.5" width={SCENE_W - 1} height={SCENE_H - 1} rx="9" />
        </clipPath>
        <pattern id="scene-scan" width="4" height="3" patternUnits="userSpaceOnUse">
          <rect width="4" height="1" />
        </pattern>
        <linearGradient id="rd-sweep-fill" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--ok)', stopOpacity: 0 }} />
          <stop offset="1" style={{ stopColor: 'var(--ok)', stopOpacity: 0.55 }} />
        </linearGradient>
      </defs>
      <rect class="scene-bg" x="0.5" y="0.5" width={SCENE_W - 1} height={SCENE_H - 1} rx="9" />
      <g class="scene-art" clip-path="url(#scene-clip)">
        {children}
        <rect class="scene-scan" x="0" y="0" width={SCENE_W} height={SCENE_H} fill="url(#scene-scan)" />
      </g>
      <rect class="scene-edge" x="0.5" y="0.5" width={SCENE_W - 1} height={SCENE_H - 1} rx="9" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------- Matrix

const COLUMNS = matrixColumns();

function Matrix({ p }: { p: SceneProps }): VNode {
  const shown = matrixShown(sceneDensity(p.mood, p.effort));
  const colX = (slot: number) => COLUMNS[MATRIX_AGENT_COLUMNS[slot]!]!.x;
  return (
    <Frame p={p}>
      <g class="mx-cols">
        {COLUMNS.map((c, i) => {
          const slot = (MATRIX_AGENT_COLUMNS as readonly number[]).indexOf(i);
          const agent = slot >= 0 ? p.agents[slot] : undefined;
          return (
            <g key={i} transform={`translate(${px(c.x)} 0)`} class={c.rank < shown || agent ? 'mx-slot' : 'mx-slot mx-hidden'}>
              {agent && <rect class="mx-beam" data-slot={slot} x="-5" y="0" width="10" height={SCENE_H} />}
              <g class="mx-col" data-agent={agent ? slot : undefined} data-state={agent?.mood} data-effort={agent?.effort} style={{ '--k': c.speed.toFixed(2), '--p': c.phase.toFixed(3) } as never}>
                {c.glyphs.map((g, r) => (
                  <text key={r} class={r === MATRIX_ROWS - 1 ? 'mx-g head' : 'mx-g'} y={9 + r * 9} style={{ fillOpacity: (0.1 + 0.9 * Math.pow(r / (MATRIX_ROWS - 1), 1.6)).toFixed(2) } as never}>
                    {agent && r === MATRIX_ROWS - 1 ? AGENT_LETTERS[slot] : g}
                  </text>
                ))}
              </g>
            </g>
          );
        })}
      </g>
      {p.agents.slice(0, -1).map((_, i) => (
        <line key={i} class="mx-link" x1={colX(i)} x2={colX(i + 1)} y1={30 + i * 14} y2={30 + i * 14} style={{ '--n': i } as never} />
      ))}
      {p.agents.map((a, i) => (
        <text key={i} class="mx-tag" data-slot={i} data-state={a.mood} x={colX(i)} y="77" text-anchor="middle">
          {AGENT_LETTERS[i]}
        </text>
      ))}
      <text class="mx-prompt" x="10" y="70">
        &gt;<tspan class="mx-cursor">_</tspan>
      </text>
      <text class="mx-mark bang" x={SCENE_W / 2} y="56" text-anchor="middle">
        !
      </text>
      <text class="mx-mark done" x={SCENE_W / 2} y="56" text-anchor="middle">
        ✓
      </text>
    </Frame>
  );
}

// ---------------------------------------------------------------------------------------------------------------- Agent network

const STARS_FAR = constellation();
const AGENT_HUES = ['info', 'violet', 'ok'] as const;

function Agents({ p }: { p: SceneProps }): VNode {
  const nodes = agentNodes(p.agents.length);
  const edges = agentEdges(p.agents.length);
  const per = packetsPerLink(p.mood, p.effort);
  return (
    <Frame p={p}>
      <g class="ag-far">
        {STARS_FAR.map((s, i) => (
          <circle key={i} cx={px(s.x)} cy={px(s.y)} r={i % 5 === 0 ? 0.9 : 0.55} style={{ '--n': i % 7 } as never} />
        ))}
      </g>
      <g class="ag-links">
        {edges.map((e, i) => (
          <line key={i} class={`ag-link ${e.kind}`} x1={e.from.x} y1={e.from.y} x2={e.to.x} y2={e.to.y} />
        ))}
      </g>
      <g class="ag-packets">
        {edges.flatMap((e, i) =>
          Array.from({ length: per }, (_, k) => {
            const forward = (i + k) % 2 === 0; // some go out, some come back: they talk to each other
            const a = forward ? e.from : e.to;
            const b = forward ? e.to : e.from;
            return <circle key={`${i}-${k}`} class={`ag-packet ${e.kind}`} r={e.kind === 'hub' ? 1.9 : 1.5} cx={a.x} cy={a.y} style={{ '--dx': `${px(b.x - a.x)}px`, '--dy': `${px(b.y - a.y)}px`, '--n': (k * 0.43 + i * 0.29).toFixed(2) } as never} />;
          }),
        )}
      </g>
      <g transform={`translate(${AGENT_HUB.x} ${AGENT_HUB.y})`}>
        <g class="ag-hub">
          <g class="ag-spin">
            <circle class="ag-orbit" r="16" />
            {[0, 120, 240].map((deg) => (
              <circle key={deg} class="ag-orbiter" r="1.5" cx={(16 * Math.sin((deg * Math.PI) / 180)).toFixed(2)} cy={(-16 * Math.cos((deg * Math.PI) / 180)).toFixed(2)} />
            ))}
          </g>
          <circle class="ag-ring" r="11" />
          <circle class="ag-core" r="4.8" />
          <circle class="ag-burst" r="11" />
        </g>
      </g>
      {nodes.map((n, i) => (
        <g key={i} transform={`translate(${n.x} ${n.y})`}>
          <g class="ag-node" data-i={i} data-hue={AGENT_HUES[i]} data-state={p.agents[i]?.mood} data-effort={p.agents[i]?.effort}>
            <circle class="ag-core" r="6" />
            <circle class="ag-ring" r="8" />
            <circle class="ag-burst" r="8" />
            <text class="ag-tag" y="2.8" text-anchor="middle">
              {AGENT_LETTERS[i]}
            </text>
          </g>
        </g>
      ))}
    </Frame>
  );
}

// ---------------------------------------------------------------------------------------------------------------- Warp

const STARS = warpStars();
const SHIP = 'M0 -7 L6 6 L0 3 L-6 6 Z';

function Warp({ p }: { p: SceneProps }): VNode {
  const stars = STARS.slice(0, starsShown(sceneDensity(p.mood, p.effort)));
  const ships = warpShips(p.agents.length);
  return (
    <Frame p={p}>
      <g class="ws-stars">
        {stars.map((s, i) => (
          <line key={i} class="ws-star" x1={px(s.x1)} y1={px(s.y1)} x2={px(s.x2)} y2={px(s.y2)} pathLength="1" style={{ '--k': s.speed.toFixed(2), '--p': s.phase.toFixed(3) } as never} />
        ))}
      </g>
      <g class="ws-comms">
        {ships.map((s, i) => (
          <line key={i} class="ws-comm" x1={s.x} y1={s.y} x2={WARP_FLAGSHIP.x} y2={WARP_FLAGSHIP.y} style={{ '--n': i } as never} />
        ))}
        {ships.map((s, i) => (
          <g key={i} transform={`translate(${s.x} ${s.y})`}>
            <circle class="ws-ping" r="3" style={{ '--n': i } as never} />
          </g>
        ))}
      </g>
      <g transform={`translate(${WARP_FLAGSHIP.x} ${WARP_FLAGSHIP.y})`}>
        <g class="ws-ship main">
          <path class="ws-flame" d="M-2.4 5 L0 12 L2.4 5 Z" />
          <path class="ws-hull" d={SHIP} />
        </g>
      </g>
      {ships.map((s, i) => (
        <g key={i} transform={`translate(${s.x} ${s.y}) scale(0.72)`}>
          <g class="ws-ship wing" data-i={i} data-hue={AGENT_HUES[i]} data-state={p.agents[i]?.mood} data-effort={p.agents[i]?.effort}>
            <path class="ws-flame" d="M-2.4 5 L0 12 L2.4 5 Z" />
            <path class="ws-hull" d={SHIP} />
          </g>
        </g>
      ))}
      <g class="ws-alert">
        <path d="M120 10 L134 34 L106 34 Z" />
        <text x="120" y="31" text-anchor="middle">
          !
        </text>
      </g>
      <rect class="ws-flash" x="0" y="0" width={SCENE_W} height={SCENE_H} />
    </Frame>
  );
}

// ---------------------------------------------------------------------------------------------------------------- Radar

const WEDGE = (() => {
  const a = (-55 * Math.PI) / 180;
  const x = SCOPE.x + SCOPE.r * Math.sin(a);
  const y = SCOPE.y - SCOPE.r * Math.cos(a);
  return `M${SCOPE.x} ${SCOPE.y} L${x.toFixed(2)} ${y.toFixed(2)} A${SCOPE.r} ${SCOPE.r} 0 0 1 ${SCOPE.x} ${SCOPE.y - SCOPE.r} Z`;
})();

const STATUS: Record<PetMood, string> = { sleep: 'STANDBY', rest: 'LINKED', dig: 'ACTIVE', alert: 'ATTENTION', cheer: 'COMPLETE' };

/** How many of the four load bars are lit. */
function load(mood: PetMood, effort: Effort): number {
  return mood === 'dig' ? effort + 1 : mood === 'rest' ? 1 : mood === 'sleep' ? 0 : 4;
}

function Readout({ p, x }: { p: SceneProps; x: number }): VNode {
  const lit = load(p.mood, p.effort);
  return (
    <g class="hud-read" transform={`translate(${x} 0)`}>
      <text class="hud-lab" y="17">
        AGENTS
      </text>
      <text class="hud-num" y="36">
        {String(p.agents.length).padStart(2, '0')}
      </text>
      <text class="hud-status" y="49">
        {STATUS[p.mood]}
      </text>
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} class={i < lit ? 'hud-bar lit' : 'hud-bar'} x={i * 13} y="58" width="10" height="5" rx="1" style={{ '--n': i } as never} />
      ))}
    </g>
  );
}

function Radar({ p }: { p: SceneProps }): VNode {
  const blips = radarBlips(p.agents.length);
  return (
    <Frame p={p}>
      <g class="rd-scope">
        <circle class="rd-ring" cx={SCOPE.x} cy={SCOPE.y} r={SCOPE.r} />
        <circle class="rd-ring" cx={SCOPE.x} cy={SCOPE.y} r={SCOPE.r * 0.66} />
        <circle class="rd-ring" cx={SCOPE.x} cy={SCOPE.y} r={SCOPE.r * 0.33} />
        <line class="rd-cross" x1={SCOPE.x - SCOPE.r} y1={SCOPE.y} x2={SCOPE.x + SCOPE.r} y2={SCOPE.y} />
        <line class="rd-cross" x1={SCOPE.x} y1={SCOPE.y - SCOPE.r} x2={SCOPE.x} y2={SCOPE.y + SCOPE.r} />
        <g class="rd-sweep">
          <path class="rd-wedge" d={WEDGE} />
          <line class="rd-line" x1={SCOPE.x} y1={SCOPE.y} x2={SCOPE.x} y2={SCOPE.y - SCOPE.r} />
        </g>
        <circle class="rd-ping" cx={SCOPE.x} cy={SCOPE.y} r="10" />
        <circle class="rd-ping two" cx={SCOPE.x} cy={SCOPE.y} r="10" />
        {blips.map((b, i) => (
          <circle key={i} class="rd-blip" data-i={i} data-hue={AGENT_HUES[i]} data-state={p.agents[i]?.mood} cx={px(b.x)} cy={px(b.y)} r="2.4" style={{ '--a': b.angle } as never} />
        ))}
        <circle class="rd-me" cx={SCOPE.x} cy={SCOPE.y} r="2.4" />
      </g>
      <Readout p={p} x={112} />
    </Frame>
  );
}

// ---------------------------------------------------------------------------------------------------------------- Reactor core

const BAR_SHAPE = Array.from({ length: CORE_BARS }, (_, i) => 0.35 + 0.65 * Math.abs(Math.sin(i * 0.9 + 0.4)));

function Core({ p }: { p: SceneProps }): VNode {
  const sats = coreSatellites(p.agents.length);
  return (
    <Frame p={p}>
      <g class="co-reactor">
        <circle class="co-ring outer" cx={SCOPE.x} cy={SCOPE.y} r="31" />
        <circle class="co-ring mid" cx={SCOPE.x} cy={SCOPE.y} r="23" />
        <circle class="co-ring inner" cx={SCOPE.x} cy={SCOPE.y} r="15.5" />
        <circle class="co-glow" cx={SCOPE.x} cy={SCOPE.y} r="10" />
        <circle class="co-core" cx={SCOPE.x} cy={SCOPE.y} r="5.6" />
        <circle class="co-shock" cx={SCOPE.x} cy={SCOPE.y} r="10" />
        <g class="co-orbit">
          {sats.map((s, i) => (
            <circle key={i} class="co-sat" data-i={i} data-hue={AGENT_HUES[i]} data-state={p.agents[i]?.mood} cx={px(s.x)} cy={px(s.y)} r="2.7" />
          ))}
        </g>
      </g>
      <g class="co-bars" transform="translate(112 0)">
        <text class="hud-lab" y="14">
          ENERGY
        </text>
        {BAR_SHAPE.map((h, i) => (
          <rect key={i} class="co-bar" x={i * 8.9} y={63 - 42 * h} width="5.6" height={42 * h} rx="1" style={{ '--i': i, '--h': h.toFixed(2) } as never} />
        ))}
        <text class="hud-status" y="74" x="0">
          {STATUS[p.mood]}
        </text>
      </g>
    </Frame>
  );
}

// ----------------------------------------------------------------------------------------------------------------

/** One of the scenes that can replace the mole. */
export function Scene(p: SceneProps): VNode {
  switch (p.variant) {
    case 'matrix':
      return <Matrix p={p} />;
    case 'agents':
      return <Agents p={p} />;
    case 'warp':
      return <Warp p={p} />;
    case 'radar':
      return <Radar p={p} />;
    case 'core':
      return <Core p={p} />;
  }
}
