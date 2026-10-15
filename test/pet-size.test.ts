import { describe, expect, it } from 'vitest';
import { PET_SIZES, petScale } from '../src/shared/companions';

describe('petScale: how much bigger or smaller the companion is drawn', () => {
  it('maps the four sizes to their factors', () => {
    expect(PET_SIZES.map((s) => s.id)).toEqual(['small', 'normal', 'large', 'huge']);
    expect(['small', 'normal', 'large', 'huge'].map(petScale)).toEqual([0.75, 1, 1.5, 2.25]);
  });
  it('counts anything else (a typo, a newer version, not text) as normal', () => {
    expect(['', 'giant', 'HUGE', undefined, null, 3, {}].map((v) => petScale(v as never))).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});
