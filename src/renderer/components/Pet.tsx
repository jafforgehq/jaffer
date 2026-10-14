import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { bellAt, cfg, currentClaude, fixedAt, info, lastActivityAt } from '../state';
import { processBadge } from '../../shared/process-badge';
import { isDozing, petMood, petTool, type PetMood } from '../../shared/pet-mood';
import { toolCategory, type ToolCategory } from '../../shared/tool-category';
import { crewMoods, crewSize } from '../../shared/pet-crew';
import { effortLevel, longestRunning, type Effort } from '../../shared/pet-effort';
import { COMPANIONS, companionOf, type Companion } from '../../shared/companions';
import { Scene } from './Scenes';

/** What a scene says for itself (the mole's lines are about digging). */
const SCENE_SAYS: Record<PetMood, string> = {
  sleep: 'Nothing is running',
  rest: 'Claude Code is open',
  dig: 'Something is running',
  alert: 'Claude needs you!',
  cheer: 'Done!',
};

const SAYS: Record<PetMood, string> = {
  sleep: 'Zzz… nothing is running',
  rest: 'Claude Code is open',
  dig: 'Digging while something runs',
  alert: 'Claude needs you!',
  cheer: 'Done!',
};

let moleCount = 0;
/** How long the "Fixed it!" burst and the bell's flinch last. */
const BURST_MS = 1400;
const FLINCH_MS = 400;

/** One mole on its own molehill. The main one follows Claude and the terminal; a helper stands for one background agent. */
function Mole({ mood, label, helper, effort = 0, tool, dozing, flinch }: { mood: PetMood; label: string; helper?: number; effort?: Effort; tool?: ToolCategory | null; dozing?: boolean; flinch?: boolean }): VNode {
  const id = useRef(0);
  if (!id.current) id.current = ++moleCount;
  const clip = `pet-clip-${id.current}`; // one page can show nine moles: an id may be used once
  return (
    <svg
      class={helper === undefined ? 'pet' : 'pet pet-helper'}
      data-mood={mood}
      data-effort={effort}
      data-role={helper === undefined ? 'main' : 'helper'}
      data-tool={tool ?? undefined}
      data-idle={dozing ? 'doze' : undefined}
      data-flinch={flinch ? '1' : undefined}
      style={helper === undefined ? undefined : ({ '--i': helper + 1 } as never)}
      viewBox="0 0 120 72"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <defs>
        <clipPath id={clip}>
          <rect x="-20" y="-40" width="160" height="110" />
        </clipPath>
      </defs>
      <ellipse class="pet-hole" cx="60" cy="59" rx="27" ry="6" />
      <g clip-path={`url(#${clip})`}>
        <g class="pet-body">
          <ellipse class="pet-ear" cx="45" cy="30" rx="3.4" ry="3.4" />
          <ellipse class="pet-ear" cx="75" cy="30" rx="3.4" ry="3.4" />
          <ellipse class="pet-fur" cx="60" cy="43" rx="19" ry="17" />
          <ellipse class="pet-snout" cx="60" cy="48" rx="8.5" ry="6.2" />
          <circle class="pet-nose" cx="60" cy="45.4" r="3.1" />
          <g class="pet-eyes">
            <circle class="pet-eye" cx="52" cy="38" r="2" />
            <circle class="pet-eye" cx="68" cy="38" r="2" />
          </g>
          <path class="pet-lids" d="M49.4 38.4q2.6 2.6 5.2 0M65.4 38.4q2.6 2.6 5.2 0" />
          <path class="pet-sweat" d="M73.5 28.5q-3.2 4.4-3.2 6.6a3.2 3.2 0 0 0 6.4 0q0-2.2-3.2-6.6z" />
          <g class="pet-hat">
            <path d="M46.5 30.4q13.5-17 27 0z" />
            <rect x="43" y="29.4" width="34" height="3.2" rx="1.6" />
          </g>
          <g class="pet-arm pet-arm-l">
            <ellipse class="pet-paw" cx="43" cy="54" rx="6.8" ry="4.6" />
            <path class="pet-claws" d="M38.6 57.6l-1.6 2.6M42 58.6l-.4 3M45.6 58.2l.8 2.8" />
            <g class="pet-book">
              <rect class="pet-cover" x="29" y="40" width="17" height="12" rx="1.6" />
              <path class="pet-leaf" d="M30.6 41.4h14v9.2h-14z" />
              <path class="pet-page" d="M37.6 41.4h7v9.2h-7z" />
            </g>
          </g>
          <g class="pet-arm pet-arm-r">
            <ellipse class="pet-paw" cx="77" cy="54" rx="6.8" ry="4.6" />
            <path class="pet-claws" d="M81.4 57.6l1.6 2.6M78 58.6l.4 3M74.4 58.2l-.8 2.8" />
            <g class="pet-hammer">
              <path class="pet-haft" d="M79 52L88 36" />
              <rect class="pet-head" x="83.6" y="30.4" width="10" height="5.6" rx="1.2" transform="rotate(32 88.6 33.2)" />
            </g>
          </g>
          <g class="pet-dish">
            <path class="pet-mast" d="M60 27.6V16.4" />
            <path class="pet-bowl" d="M53.6 13.6q6.4 8 12.8 0z" />
            <path class="pet-wave" d="M68.4 9.6q4.2 3.6 0 7.4" />
            <path class="pet-wave two" d="M72.4 7q6.4 5.4 0 12.2" />
          </g>
        </g>
      </g>
      <g class="pet-dirt">
        <circle cx="60" cy="58" r="2.2" style={{ '--dx': '-26px', '--dy': '-30px', animationDelay: 'calc(0s + var(--i, 0) * 0.21s)' } as never} />
        <circle cx="60" cy="58" r="1.7" style={{ '--dx': '-14px', '--dy': '-38px', animationDelay: 'calc(0.16s + var(--i, 0) * 0.21s)' } as never} />
        <circle cx="60" cy="58" r="2.4" style={{ '--dx': '2px', '--dy': '-42px', animationDelay: 'calc(0.32s + var(--i, 0) * 0.21s)' } as never} />
        <circle cx="60" cy="58" r="1.8" style={{ '--dx': '16px', '--dy': '-36px', animationDelay: 'calc(0.1s + var(--i, 0) * 0.21s)' } as never} />
        <circle cx="60" cy="58" r="2.1" style={{ '--dx': '28px', '--dy': '-28px', animationDelay: 'calc(0.26s + var(--i, 0) * 0.21s)' } as never} />
        <circle class="pet-more" cx="60" cy="58" r="1.6" style={{ '--dx': '-34px', '--dy': '-20px', animationDelay: 'calc(0.2s + var(--i, 0) * 0.21s)' } as never} />
        <circle class="pet-more" cx="60" cy="58" r="1.9" style={{ '--dx': '36px', '--dy': '-18px', animationDelay: 'calc(0.38s + var(--i, 0) * 0.21s)' } as never} />
      </g>
      <path class="pet-mound" d="M8 70Q26 55 60 57Q94 55 112 70Z" />
      <path class="pet-pile" d="M92 70Q106 46 120 70Z" />
      <circle class="pet-pebble" cx="24" cy="64" r="1.6" />
      <circle class="pet-pebble" cx="96" cy="63" r="2" />
      <g class="pet-zs">
        <text x="76" y="30">z</text>
        <text x="84" y="21">z</text>
      </g>
      <g class="pet-bang">
        <circle cx="90" cy="20" r="9" />
        <text x="90" y="25" text-anchor="middle">!</text>
      </g>
      <g class="pet-sparks">
        <path d="M28 24l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
        <path d="M92 16l1.6 4 4 1.6-4 1.6-1.6 4-1.6-4-4-1.6 4-1.6z" />
        <path d="M100 38l1.2 3 3 1.2-3 1.2-1.2 3-1.2-3-3-1.2 3-1.2z" />
      </g>
    </svg>
  );
}

/** "Fixed it!": a ring of sparks flying out of the companion for a moment (CSS only; Settings → Animations and Reduce motion keep it away). */
const SPARKS = Array.from({ length: 8 }, (_, i) => ({ a: i * 45 + 12, d: 46 + (i % 3) * 8, dl: (i % 4) * 0.05 }));
function Burst(): VNode {
  return (
    <div class="pet-burst" aria-hidden="true">
      {SPARKS.map((p, i) => (
        <i key={i} class="pet-spark" style={{ '--a': `${p.a}deg`, '--d': `${p.d}px`, animationDelay: `${p.dl}s` } as never} />
      ))}
    </div>
  );
}

/** A live specimen of one companion for Settings, shown hard at work with two agents so the choice is made on what it does. */
export function CompanionPreview({ companion }: { companion: Companion }): VNode {
  const name = COMPANIONS.find((c) => c.id === companion)?.name ?? 'Mole';
  if (companion !== 'mole') {
    return (
      <Scene
        variant={companion}
        mood="dig"
        effort={1}
        agents={[
          { mood: 'dig', effort: 0 },
          { mood: 'dig', effort: 1 },
        ]}
        label={`${name} preview`}
      />
    );
  }
  return (
    <span class="comp-mole">
      <Mole mood="dig" effort={1} label={`${name} preview`} />
      <Mole helper={0} mood="dig" label="Helper mole preview" />
    </span>
  );
}

/**
 * A little mole in a corner of the terminal, and a helper mole beside it for every background agent Claude has running. Pure
 * decoration: every pose is a CSS state, the motion stops with Settings → Animations.
 */
export function Pet(): VNode | null {
  const session = currentClaude();
  const live = session?.state;
  const runningAgents = session && Array.isArray(session.subagents) ? session.subagents.filter((a) => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt) : [];
  const running = runningAgents.length;
  const busy = info.value.busy ?? null;

  // the longer something works, the harder its mole works: re-check every few seconds while anything is running
  const [, tick] = useState(0);
  const active = live === 'working' || running > 0 || !!busy;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [active]);

  const [cheering, setCheering] = useState(false);
  const prev = useRef(live);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (prev.current === 'working' && live === 'idle') {
      setCheering(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCheering(false), 2400);
    } else if (live === 'working') {
      clearTimeout(timer.current);
      setCheering(false);
    }
    prev.current = live;
  }, [live]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // helpers arrive at once and leave after a moment of cheering
  const target = crewSize(running);
  const [shown, setShown] = useState(target);
  const leave = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(leave.current);
    if (target >= shown) setShown(target);
    else leave.current = setTimeout(() => setShown(target), 1300);
  }, [target]);
  useEffect(() => () => clearTimeout(leave.current), []);

  // a command that worked after three failures: a burst of sparks for a moment
  const fixed = fixedAt.value;
  const [burst, setBurst] = useState(0);
  useEffect(() => {
    if (!fixed || Date.now() - fixed > BURST_MS) return;
    setBurst(fixed);
    const t = setTimeout(() => setBurst(0), BURST_MS);
    return () => clearTimeout(t);
  }, [fixed]);

  // a bell: a flinch
  const bell = bellAt.value;
  const [flinch, setFlinch] = useState(false);
  useEffect(() => {
    if (!bell || Date.now() - bell > FLINCH_MS) return;
    setFlinch(true);
    const t = setTimeout(() => setFlinch(false), FLINCH_MS);
    return () => clearTimeout(t);
  }, [bell]);

  // ten quiet minutes: doze. Any activity (the signal changes) wakes it at once; the clock is looked at twice a minute
  const lastActivity = lastActivityAt.value;
  const [, slowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => slowTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (cfg.value?.appearance.pet === false) return null;
  const companion = companionOf(cfg.value?.appearance.companion);
  const mood = petMood({ badge: processBadge(busy, live), claude: live, cheering });
  const now = Date.now();
  const effort = mood === 'dig' ? effortLevel(longestRunning([live === 'working' ? session?.since : undefined, busy ? info.value.busySince ?? undefined : undefined], now)) : 0;
  const tired = effort >= 2 ? ' · working hard' : '';
  const crew = running > 0 ? ` · ${running} background agent${running === 1 ? '' : 's'} working` : '';
  const helpers = crewMoods(running, shown);
  const tool = petTool(session);
  const dozing = live !== 'working' && live !== 'needs-you' && running === 0 && !processBadge(busy, live).spin && isDozing(lastActivity, now);
  const sparks = burst && cfg.value?.appearance.animations !== false ? <Burst key={burst} /> : null;
  if (companion !== 'mole') {
    const name = COMPANIONS.find((c) => c.id === companion)!.name;
    return (
      <div class="pet-corner" data-companion={companion}>
        <Scene
          variant={companion}
          mood={mood}
          effort={effort}
          agents={helpers.map((m, i) => ({ mood: m, effort: m === 'dig' ? effortLevel(longestRunning([runningAgents[i]?.startedAt], now)) : (0 as Effort) }))}
          label={`${name}: ${SCENE_SAYS[mood]}${tired}${crew}`}
          tool={tool}
          dozing={dozing}
          flinch={flinch}
        />
        {sparks}
      </div>
    );
  }
  return (
    <div class="pet-corner" data-companion="mole">
      <Mole mood={mood} effort={effort} label={`${SAYS[mood]}${tired}${dozing ? ' · dozing' : ''}${crew}`} tool={tool} dozing={dozing} flinch={flinch} />
      {helpers.map((m, i) => (
        <Mole
          key={i}
          helper={i}
          mood={m}
          effort={m === 'dig' ? effortLevel(longestRunning([runningAgents[i]?.startedAt], now)) : 0}
          tool={m === 'dig' && runningAgents[i]?.tool ? toolCategory(runningAgents[i]!.tool!) : null}
          label={m === 'cheer' ? 'A background agent finished' : 'A background agent is working'}
        />
      ))}
      {sparks}
    </div>
  );
}
