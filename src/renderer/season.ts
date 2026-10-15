import { cfg } from './state';
import { seasonOf, type Season } from '../shared/season';

const SEASONS = new Set<string>(['halloween', 'winter', 'valentine']);

/**
 * The season the companion dresses for: none with Settings → Appearance → Seasonal touches off. A test can name a season
 * (`?debug=1&season=winter`, or `season=none`), and only a page opened with `debug`: a normal run goes by the date.
 */
export function currentSeason(): Season | null {
  if (cfg.value?.appearance?.seasonal === false) return null;
  const q = new URLSearchParams(location.search);
  const fake = q.has('debug') ? q.get('season') : null;
  if (fake === 'none') return null;
  return fake && SEASONS.has(fake) ? (fake as Season) : seasonOf(new Date());
}
