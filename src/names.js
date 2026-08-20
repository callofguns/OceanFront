import { pick } from './rng.js';

// Flavour names for the AI nations.
export const NATION_NAMES = [
  'Valoria', 'Kesh Dominion', 'Norhaven', 'Tarkand', 'Silvermarch',
  'Ostreich', 'Caldera', 'Brakkir', 'Ashfell', 'Meridia',
  'Zarkhan', 'Vellmoor', 'Highreach', 'Ironbay', 'Sundara',
  'Oradia', 'Thal Vareth', 'Coralind', 'Duskvale', 'Ferrata',
  'Nyxholm', 'Palladia', 'Wyrmgard', 'Solmara', 'Kaldhar',
  'Emberlyn', 'Grivane', 'Marrowdeep', 'Ostara', 'Tempesta',
  'Ravenmoor', 'Cindralis', 'Skarnvik', 'Auroch', 'Belmara',
];

// Tribes get a generated two-word name instead of one drawn from
// NATION_NAMES, so a match can field far more of them than a hand-written
// list could ever cover, and so they never read as a peer of a named
// nation on the leaderboard or the map.
const TRIBE_FIRST = [
  'Ash', 'Bone', 'Cinder', 'Dune', 'Ember', 'Flint', 'Frost', 'Gale',
  'Hollow', 'Iron', 'Kelp', 'Marsh', 'Moss', 'Night', 'Pine', 'Reed',
  'Salt', 'Stone', 'Storm', 'Thorn', 'Tide', 'Wolf',
];
const TRIBE_SECOND = [
  'Banner', 'Cairn', 'Clan', 'Crest', 'Fang', 'Ford', 'Hold', 'Horn',
  'Kin', 'Marchers', 'Nomads', 'Pack', 'Reavers', 'Riders', 'Runners',
  'Shield', 'Spear', 'Wardens', 'Watch', 'Wake',
];

/** `count` distinct tribe names, drawn deterministically from `rng`. 22 x 20
 *  = 440 combinations for at most a few dozen draws, so the rejection loop
 *  below terminates immediately in practice; the guard and the numbered
 *  fallback exist so a future word-list edit degrades instead of hanging. */
export function tribeNames(rng, count) {
  const out = [];
  const seen = new Set();
  let guard = 0;
  while (out.length < count && guard++ < count * 50) {
    const name = `${pick(rng, TRIBE_FIRST)} ${pick(rng, TRIBE_SECOND)}`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  while (out.length < count) out.push(`Tribe ${out.length + 1}`);
  return out;
}
