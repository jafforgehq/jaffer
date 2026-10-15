export type Season = 'halloween' | 'winter' | 'valentine';

/** The seasonal touch for a (local) date: Oct 24 to Nov 1, Dec 15 to Jan 3, Feb 12 to Feb 15; none the rest of the year. */
export function seasonOf(date: Date): Season | null {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  if ((m === 10 && d >= 24) || (m === 11 && d <= 1)) return 'halloween';
  if ((m === 12 && d >= 15) || (m === 1 && d <= 3)) return 'winter';
  if (m === 2 && d >= 12 && d <= 15) return 'valentine';
  return null; // (an invalid date has NaN parts: none of the above)
}
