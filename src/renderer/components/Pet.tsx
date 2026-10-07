import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cfg, currentClaude, info } from '../state';
import { processBadge } from '../../shared/process-badge';
import { petMood, type PetMood } from '../../shared/pet-mood';

const SAYS: Record<PetMood, string> = {
  sleep: 'Zzz… nothing is running',
  rest: 'Claude Code is open',
  dig: 'Digging while something runs',
  alert: 'Claude needs you!',
  cheer: 'Done!',
};

/** A little mole at the bottom of the sidebar. Pure decoration: every pose is a CSS state, the motion stops with Settings → Animations. */
export function Pet(): VNode | null {
  const live = currentClaude()?.state;
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
  if (cfg.value?.appearance.pet === false) return null;
  const mood = petMood({ badge: processBadge(info.value.busy ?? null, live), claude: live, cheering });
  return (
    <div class="rail-pet">
      <svg class="pet" data-mood={mood} viewBox="0 0 120 72" role="img" aria-label={SAYS[mood]}>
        <title>{SAYS[mood]}</title>
        <defs>
          <clipPath id="pet-clip">
            <rect x="-20" y="-40" width="160" height="110" />
          </clipPath>
        </defs>
        <ellipse class="pet-hole" cx="60" cy="59" rx="27" ry="6" />
        <g clip-path="url(#pet-clip)">
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
          <g class="pet-arm pet-arm-l">
            <ellipse class="pet-paw" cx="43" cy="54" rx="6.8" ry="4.6" />
            <path class="pet-claws" d="M38.6 57.6l-1.6 2.6M42 58.6l-.4 3M45.6 58.2l.8 2.8" />
          </g>
          <g class="pet-arm pet-arm-r">
            <ellipse class="pet-paw" cx="77" cy="54" rx="6.8" ry="4.6" />
            <path class="pet-claws" d="M81.4 57.6l1.6 2.6M78 58.6l.4 3M74.4 58.2l-.8 2.8" />
          </g>
        </g>
        </g>
        <g class="pet-dirt">
          <circle cx="60" cy="58" r="2.2" style={{ '--dx': '-26px', '--dy': '-30px', animationDelay: '0s' } as never} />
          <circle cx="60" cy="58" r="1.7" style={{ '--dx': '-14px', '--dy': '-38px', animationDelay: '0.16s' } as never} />
          <circle cx="60" cy="58" r="2.4" style={{ '--dx': '2px', '--dy': '-42px', animationDelay: '0.32s' } as never} />
          <circle cx="60" cy="58" r="1.8" style={{ '--dx': '16px', '--dy': '-36px', animationDelay: '0.1s' } as never} />
          <circle cx="60" cy="58" r="2.1" style={{ '--dx': '28px', '--dy': '-28px', animationDelay: '0.26s' } as never} />
        </g>
        <path class="pet-mound" d="M8 70Q26 55 60 57Q94 55 112 70Z" />
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
    </div>
  );
}
