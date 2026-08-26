// Central tuning table. Every gameplay number lives here so balance can be
// adjusted without hunting through the simulation code.

import { WORLD_MAP } from './maps/world.js';
import { AFRICA_MAP } from './maps/africa.js';
import { ASIA_MAP } from './maps/asia.js';
import { EUROPE_MAP } from './maps/europe.js';
import { NORTH_AMERICA_MAP } from './maps/north-america.js';
import { SOUTH_AMERICA_MAP } from './maps/south-america.js';
import { OCEANIA_MAP } from './maps/oceania.js';
import { LABYRINTH_MAP } from './maps/labyrinth.js';
import { THE_BOX_MAP } from './maps/the-box.js';
import { ONION_MAP } from './maps/onion.js';
import { BRANCHING_PATHS_MAP } from './maps/branching-paths.js';

export const TICKS_PER_SECOND = 10;
export const TICK_MS = 1000 / TICKS_PER_SECOND;

// ---------------------------------------------------------------- terrain ---

export const OCEAN = 0;
export const PLAINS = 1;
export const HIGHLAND = 2;
export const MOUNTAIN = 3;

export const TERRAIN_NAMES = ['Ocean', 'Plains', 'Highland', 'Mountain'];

/**
 * Terrain's two OpenFrontIO-exact numbers: `mag` (troop cost -- both sides'
 * losses scale off it) and `speed` (how much of an attack's per-tick tile
 * budget one tile eats -- see the attack-budget section, below).
 * OpenFrontIO's own values are 80/100/120 for mag; rescaled here to
 * OceanFront's population range (see the economy section's calibration
 * note) by matching the two terms of the attacker-loss blend (below) in the
 * same proportion at a representative mid-game nation -- the terrain
 * *ratio* between Plains/Highland/Mountain (1 : 1.25 : 1.5) is unchanged.
 * `speed` needs no rescaling: budget and pace-cost are both expressed in
 * the same made-up "tile budget" unit OpenFrontIO invented, not troops, so
 * its literal 16.5/20/25 ports as-is.
 *
 * Tuned down 25% from the first-pass calibration (6.0/7.5/9.0) after
 * pacing-sweep showed a genuine war-of-attrition effect between evenly
 * matched nations, not just a faster land-grab phase: overall match length
 * grew noticeably on several size/difficulty combos (medium/easy nearly
 * doubled, 5.1->10.3min) even though land was being claimed *faster* than
 * before and no combo stalled or produced a sub-3-minute blowout.
 * Re-verified via a full sweep after this cut.
 *
 * Cut a further 40% (to the current 2.7/3.36/4.05) this round, for an
 * unrelated reason: porting the real, un-scaled triggerRatio/reserveRatio
 * aggression system (config.js's ai section) makes every bot, Hard
 * included, wait for a noticeably fuller army before attacking than the
 * old difficulty-scaled `readiness` ever did -- faithful to OpenFrontIO's
 * own source, but it slowed combat down enough on its own (verified with
 * `tribes: 0`, isolating the aggression system from this round's other
 * changes) that `large/hard` -- previously OceanFront's *fastest*
 * combo -- started occasionally blowing straight through pacing-sweep's
 * 30-minute cap without a winner. Since the newly-ported ratios are
 * deliberately not a difficulty lever (matching OpenFrontIO exactly, see
 * the ai section) they aren't the right place to compensate; TERRAIN_MAG
 * is the same broad, already-established lever used for the cut above,
 * so this round pulls it again rather than reaching for a bespoke fix.
 * Re-verified via a full pacing-sweep afterward: zero stalls and zero
 * sub-3-minute blowouts across all size/difficulty combos, both with the
 * new tribe scale (TRIBE_TARGET_COUNT, below) and in isolation.
 */
export const TERRAIN_MAG = [Infinity, 2.7, 3.36, 4.05];
export const TERRAIN_SPEED = [Infinity, 16.5, 20, 25];
/** The Highland entry -- OpenFrontIO's own "100" -- used to normalize `mag`
 *  back to its {0.8, 1.0, 1.2} terrain factor inside the cost formula,
 *  below, so that shape survives TERRAIN_MAG being rescaled. */
export const MAG_REFERENCE = 7.5;

// ----------------------------------------------------------------- combat ---
//
// tileCost() (now attackLogic() -- see game.js) is ported from OpenFrontIO's
// Config.ts attackLogic()/attackTilesPerTick(): both sides' losses and the
// tile's share of an attack's per-tick budget all come from one call, using
// terrain, defense-post proximity, traitor status and each side's share of
// the map's land -- not a single flat troop price the way this used to
// work. See the economy section, above, for the general calibration note;
// combat-specific derivation notes are inline below.

/** Fraction of a defender's per-tile density that dies when a tile falls --
 *  OpenFrontIO's own defenderTroopLoss is density with an implicit
 *  coefficient of 1 (no separate discount the way this used to have). */
export const DEFENDER_LOSS = 1;
/**
 * The attacker-loss blend is `0.6 * currentLoss + 0.4 * altLoss`, ported
 * exactly: `currentLoss` scales with the *relative* strength of the
 * attacking force against the defender's whole remaining army
 * (defender.troops / attack's committed troops), clamped to
 * COMBAT_RATIO_FLOOR/CEIL -- OpenFrontIO's own exact 0.6/2 bound (widened
 * from this project's previously tuned-down 0.85/1.4, since a plain flat
 * `mag` term now also anchors the low end so the widening doesn't repeat
 * last round's pacing regression the same way -- re-verify via
 * pacing-sweep regardless, the same diagnostic that caught it before).
 * `altLoss` is density-based and needs no clamp of its own.
 */
export const COMBAT_RATIO_FLOOR = 0.6;
export const COMBAT_RATIO_CEIL = 2;
/**
 * The pace side has its own, separate ratio clamp on `defender.troops /
 * (5 * attackTroops)` -- OpenFrontIO's exact bound, new to this project
 * (the old flat TERRAIN_SPEED_COST had no ratio sensitivity at all).
 */
export const PACE_RATIO_FLOOR = 0.2;
export const PACE_RATIO_CEIL = 1.5;
/**
 * Attacking a nation whose traitorScore is over TRAITOR_DISTRUST_LIMIT (see
 * the diplomacy section, below) multiplies both the troop-loss blend and
 * the pace term -- OpenFrontIO's exact traitorDefenseDebuff()/
 * traitorSpeedDebuff() values (this project previously only had the cost
 * side, at a gentler 0.85).
 */
export const TRAITOR_DEFENSE_DEBUFF = 0.5;
export const TRAITOR_SPEED_DEBUFF = 0.8;
/**
 * Big-nation curve, ported from OpenFrontIO's defense-debuff sigmoid and
 * its large-attacker bonus -- both rescaled from absolute tile counts to a
 * *share of the map's land*, since OpenFrontIO's own 150,000/100,000-tile
 * thresholds assume mega-nations that dwarf OceanFront's whole map.
 * Expressed as a share, the same logistic curve, and the same 3:1
 * midpoint:decay-scale ratio, apply at any map size. A defender's cost/pace
 * eases from ~0.97x near 0 land down toward ~0.73x by VICTORY_LAND_SHARE
 * (the curve's useful range spans almost exactly one match); an attacker
 * past LARGE_ATTACKER_SHARE gets a matching discount, the necessary
 * counterweight -- without it, a defender-only softening curve makes the
 * endgame *harder* to finish as a nation grows, not easier, since it stacks
 * against the flat `mag` term that has no size sensitivity of its own.
 * Both reinforce, rather than fight, this project's existing density-based
 * anti-snowball dynamic (a big, spread-thin nation is already cheaper per
 * tile) -- they ease the flat `mag` floor specifically, once a nation is
 * dominant enough that the density-only effect alone isn't easing it fast.
 */
export const DEFENSE_DEBUFF_MIDPOINT_SHARE = 0.3;
export const DEFENSE_DEBUFF_DECAY = Math.LN2 / 0.1;
export const LARGE_ATTACKER_SHARE = 0.2;
/**
 * Budget an attack gets to spend each tick, ported from OpenFrontIO's
 * attackTilesPerTick(): a ratio of the attacking force to the defender's
 * remaining army, clamped, times the size of the contested border (plus a
 * little random jitter, same as OpenFrontIO's own +nextInt(0,5)) -- replaces
 * the old flat ATTACK_BASE_TILES + troops*ATTACK_TILES_PER_TROOP shape,
 * which had no defender-strength sensitivity at all. Against neutral land
 * the ratio drops out entirely (there's no defender to be relatively
 * stronger or weaker than), leaving a flat per-border-tile budget.
 */
export const ATTACK_BUDGET_RATIO_SCALE = 5;
export const ATTACK_BUDGET_FLOOR = 0.01;
export const ATTACK_BUDGET_CEIL = 0.5;
export const ATTACK_BUDGET_PER_BORDER = 3;
export const NEUTRAL_BUDGET_PER_BORDER = 2;
/**
 * Neutral land's own, simpler attacker-loss/pace shape (OpenFrontIO's
 * TerraNullius branch) -- no ratio clamp and no defender loss, since there's
 * no defender. NEUTRAL_PACE_SCALE replaces OpenFrontIO's literal 2000 (a
 * budget-unit constant, not troop-denominated, but still needed rescaling
 * against this project's much smaller typical attack sizes -- OpenFrontIO's
 * value throttles pace hard above roughly 6,600 committed troops, which is
 * this project's whole late-game range, not just its biggest pushes).
 */
export const NEUTRAL_PACE_SCALE = 180;
export const NEUTRAL_PACE_FLOOR = 5;
export const NEUTRAL_PACE_CEIL = 100;
/** Troops refunded when an attack is called off manually. */
export const RETREAT_REFUND = 0.75;
/** An attack with fewer troops than this fizzles out. */
export const ATTACK_MIN_TROOPS = 8;
/**
 * How many frontier tiles are sampled before picking one to take. Picking
 * purely at random leaves stray unclaimed holes behind (a tile can go a long
 * time without winning the lottery even once it is boxed in on every side)
 * and gives conquered territory a ragged, spiky outline. Sampling a handful
 * and preferring the most enclosed one instead keeps the front solid and
 * closes in on gaps as soon as they open up.
 */
export const FRONTIER_SAMPLE_SIZE = 6;

/** Standard logistic curve -- OpenFrontIO's own Util.ts sigmoid(), used by
 *  the big-nation combat curve, above. */
export function sigmoid(value, decayRate, midpoint) {
  return 1 / (1 + Math.exp(-decayRate * (value - midpoint)));
}

// ------------------------------------------------------------------- ai ----
// Bot target-selection thresholds. AiController tries these in priority
// order (see #makeWar in ai.js) before falling back to its original
// weighted-score search -- so a bot notices an opening (a rival already
// being invaded, or one whose army just collapsed) instead of only ever
// grinding at whoever scores best on paper.

/** Share of a rival's troops that must already be under attack (from
 *  anyone) before a bot piles on rather than picking a fresh fight. */
export const AI_VICTIM_SHARE = 0.5;
/** A rival is "very weak" once its troops fall below this fraction of what
 *  it's building toward (its population cap times its own troop ratio). */
export const AI_VERY_WEAK_RATIO = 0.2;
/** Chance, per think-cycle, that a coastal bot raids by sea purely for
 *  unpredictability -- not only as a last resort with no land target. */
export const AI_NAVAL_HARASSMENT_CHANCE = 0.08;
/**
 * On difficulty tiers with `strictAttacks` set, a bot won't launch an
 * attack committing fewer troops than this fraction of the target's troops
 * -- a token peck just donates troops to the rebalancer for nothing. Waived
 * while the bot is itself under attack, so it always retaliates.
 */
export const AI_WEAK_ATTACK_RATIO = 0.2;
/** Fraction of an ally's expected army below which a bot may opportunistically
 *  betray them, independent of being boxed in (see AI_VERY_WEAK_RATIO). */
export const AI_BETRAYAL_WEAK_ALLY_RATIO = 0.2;
/** Base per-think-cycle chance of that opportunistic betrayal, scaled by
 *  the bot's aggression. */
export const AI_BETRAYAL_WEAK_ALLY_CHANCE = 0.15;

/**
 * The real aggression system, ported from OpenFrontIO's NationExecution.ts/
 * TribeExecution.ts: three ratios rolled once per bot at construction, the
 * same range for a nation or a tribe, and deliberately NOT scaled by
 * difficulty (OpenFrontIO's own source rolls these with a plain
 * `random.nextInt`, no tier multiplier in sight -- difficulty there only
 * ever touches cadence and which strategies are tried, both of which
 * OceanFront already models via thinkRange/strictAttacks). Replaces the
 * old invented `aggression`/`expansionism` personality traits.
 *
 *  - reserveRatio is a hard gate: below it, never attack a rival.
 *  - triggerRatio is a softer gate: below it, still attack with a flat
 *    10% chance per think (see AI_TRIGGER_OVERRIDE_CHANCE).
 *  - Attacking a rival commits everything above `maxTroops * reserveRatio`;
 *    attacking open land (or a tribe, via #attackNearbyTribes) commits
 *    everything above the smaller `maxTroops * expandRatio` instead.
 */
export const AI_TRIGGER_RATIO_RANGE = [0.5, 0.6];
export const AI_RESERVE_RATIO_RANGE = [0.3, 0.4];
export const AI_EXPAND_RATIO_RANGE = [0.1, 0.2];
/** Flat per-think chance to attack anyway while below triggerRatio. */
export const AI_TRIGGER_OVERRIDE_CHANCE = 0.1;

/**
 * A nation's dedicated tribe-hunting behavior, ported from OpenFrontIO's
 * attackBots(): nations go after nearby tribes preferentially and can hit
 * several at once, independent of (and in addition to) the single ordinary
 * attack #makeWar's main chain allows. Commit size is target.troops() * 4,
 * capped at the attacker's own maxTroops, and skipped entirely unless a
 * decisive win is affordable (maxTroops >= target.troops() * 2) --
 * OpenFrontIO's exact shape, verbatim.
 */
export const AI_TRIBE_ATTACK_COMMIT_MULT = 4;
export const AI_TRIBE_ATTACK_MIN_MULT = 2;
/** How many tribes a nation will attack simultaneously, by difficulty --
 *  OpenFrontIO's own tiers are 1 / 1-2 / 3 / 100 (Easy..Impossible);
 *  rescaled onto this project's three tiers, keeping Hard's "go after a
 *  handful at once" step up rather than porting Impossible's effectively
 *  unlimited figure, which has no equivalent tier here. */
export const AI_TRIBE_PARALLELISM = { easy: 1, normal: 2, hard: 4 };
/** Attacking a tribe costs less than attacking a nation or the human --
 *  OpenFrontIO's Config.ts exact mag *= 0.7 discount when the defender is a
 *  Bot. Applied in Game#attackLogic. */
export const TRIBE_DEFENSE_DISCOUNT = 0.7;

// ----------------------------------------------------------------- tribes ---
/**
 * Tribes are the game's second AI archetype: small, lazy bands that exist
 * to occupy open land early so nobody gets a free unclaimed-land walkover.
 * They are deliberately NOT scaled by the match's difficulty setting --
 * every number here is flat, and weaker than even Easy's nation
 * multipliers, so a tribe never grows into a real rival no matter what tier
 * is picked. See src/tribe.js.
 */

/** Ticks between re-evaluations. Rolled once per tribe at construction and
 *  held fixed for the whole match (unlike a nation, which re-rolls a fresh
 *  value inside its range every think) -- 4-8s at 10 ticks/s, against
 *  Normal's 1.8-3.4s (DIFFICULTIES.normal.thinkRange). */
export const TRIBE_THINK_RANGE = [40, 80];

/** Standing-army fullness (Player#fillRatio) a tribe wants before it will
 *  commit to any fight, rolled once per tribe. Compare DIFFICULTIES'
 *  readiness: 0.55 easy / 0.45 normal / 0.35 hard -- tribes are the laziest
 *  thing on the map. */
export const TRIBE_TRIGGER_RANGE = [0.5, 0.6];

/** Share of current troops committed per attack -- the same flat
 *  fraction-of-current-troops idiom as AiController#makeWar, with no
 *  aggression or difficulty term. */
export const TRIBE_ATTACK_COMMIT = 0.5;
/** Open land never fights back, and taking it is the whole point of a
 *  tribe, so this matches a nation's own neutral-grab commit. */
export const TRIBE_NEUTRAL_COMMIT = 0.55;

/** Chance a bordering known traitor gets attacked on sight, before the
 *  ordinary shuffle. */
export const TRIBE_TRAITOR_ATTACK_CHANCE = 1 / 3;
/** Traitor score at which a tribe treats a neighbour as fair game. Equal to
 *  BETRAYAL_PENALTY (one betrayal marks you), deliberately NOT
 *  TRAITOR_DISTRUST_LIMIT -- that needs several betrayals and would make
 *  this branch almost unreachable for a tribe. */
export const TRIBE_TRAITOR_THRESHOLD = 1;

/** Flat economy scaling, applied instead of a DIFFICULTIES tier. Weaker
 *  than Easy's 0.5 / 0.9 / 0.6 across the board. */
export const TRIBE_TROOPS_CAP_MULTIPLIER = 0.35;
export const TRIBE_TROOPS_MULTIPLIER = 0.75;
export const TRIBE_GOLD_MULTIPLIER = 0.4;

/** Naval fallback, only when there is nothing at all to attack by land --
 *  a tribe stranded on an island would otherwise sit inert for the whole
 *  match. Lazier than a nation's own fallback and, unlike a nation, never
 *  fires as unprompted harassment while land targets exist. */
export const TRIBE_BOAT_CHANCE = 0.25;
export const TRIBE_BOAT_COMMIT = 0.4;
export const TRIBE_BOAT_MIN_TROOPS_FACTOR = 4;

/**
 * How many tribes every map size requests, on top of its `bots` (full
 * nations) -- see MAP_PRESETS, below. OpenFrontIO's own real design is a
 * flat request identical on every map, the realized count purely whatever
 * the spawn algorithm's geometry can fit -- so this stays one flat number
 * everywhere rather than a per-preset table, matching that shape. The
 * number itself is NOT their literal 400, though: that figure assumes
 * their own SpawnExecution, which has a fixed, non-relaxing
 * minDistanceBetweenPlayers and simply spawns fewer than requested once a
 * map is full. findSpawnPoints (src/map.js) instead relaxes its minDist
 * floor until the request is met, so asking for 400 on OceanFront's
 * smaller presets doesn't degrade to "fewer, still reasonably spaced" the
 * way it does for OpenFrontIO -- it packs every last one in, however
 * tight. Measured directly this round: at 400 on the small preset (26k
 * land tiles), a completely idle human is fully boxed in by neighbouring
 * tribes within 100 ticks in every seed tried (0 neutral border tiles
 * left) -- a genuine playability regression, not a cosmetic one. 100 was
 * then verified the same way (idle human, 100 ticks, three seeds) to
 * leave a healthy 20-28 neutral border tiles on every preset from small
 * through World, so it's the figure actually shipped -- still roughly
 * an order of magnitude above the old per-preset table (6/10/16), just
 * not literally OpenFrontIO's number, which their own spawn algorithm's
 * different fallback behavior doesn't force here. Tune down here (and/or
 * AI_TRIBE_PARALLELISM) if a future pacing-sweep finds even this too
 * costly or unplayable on some preset. */
export const TRIBE_TARGET_COUNT = 100;

/** Muted palette, kept separate from PLAYER_COLORS so tribes read as
 *  background at a glance and never collide with a nation's colour. An
 *  evenly-spread 16-entry sample of OpenFrontIO's own bot color pool (its
 *  default-theme.json's `botColors`, 49 entries, all low-saturation
 *  olive/slate/dusty-rose tones -- picked over inventing a new palette so
 *  tribes read exactly as muted as the archetype they're ported from).
 *  TRIBE_TARGET_COUNT is now well past 16, so colors necessarily repeat
 *  across a match (`colors[i % colors.length]` in Game#createTribes) --
 *  harmless, since the whole point is that tribes read as background, not
 *  as individually distinct the way PLAYER_COLORS' nations do. */
export const TRIBE_COLORS = [
  '#96a08c', '#aaaa78', '#96aa96', '#788c78',
  '#82a096', '#8296aa', '#8ca0aa', '#78828c',
  '#968296', '#aa96aa', '#aa788c', '#b48c8c',
  '#be8c78', '#aa9682', '#a08c96', '#b4a0a0',
];

// ---------------------------------------------------------------- economy ---
//
// Population is troops-only, matching OpenFrontIO's model exactly (no
// separate worker class) -- ported from its Config.ts `maxTroops()`/
// `troopIncreaseRate()`/`goldAdditionRate()`. OpenFront's own constants
// (a flat 50,000-troop base, a 250,000-per-city bonus, mag values of
// 80-120) are calibrated to its own much bigger map scale, where a single
// mega-nation can own >100,000 tiles -- OceanFront's largest map has
// ~87,600 total land tiles shared across up to 22 players. The formulas
// below keep OpenFront's exact *shape* (the exponents, the multiplicative
// structure); the constants were rescaled by anchoring at a ~2,000-tile
// "typical mid-game nation" (the observed median size a few minutes into a
// match) so density -- troops per tile, the one population-derived number
// that actually reaches combat -- lands close to today's value there, then
// cross-checked against this file's own already-tuned BUILDINGS.city
// bonus: the independently-derived city-troop value came out within ~1.3x
// of the existing constant, which is a real validation that this anchoring
// approach is sound, not just a guess. Everything below is still a
// *starting point*, tuned via tools/tests/pacing-sweep.mjs like every
// other balance constant in this project -- the anchor just gives it a
// much better-grounded starting point than a single-point fit would.

/** Troops formula: 2 * (TROOPS_TILE_SCALE * tiles^TROOPS_TILE_EXP +
 *  TROOPS_BASE) + city bonus -- OpenFrontIO's exact sublinear shape, so
 *  sprawl has diminishing returns instead of a flat per-tile rate. Sized so
 *  maxTroops(2000 tiles) ~= 6,680, matching today's fixed-point troop cap
 *  at that same tile count (~6,580, density ~3.3). */
export const TROOPS_BASE = 470;
export const TROOPS_TILE_SCALE = 30;
export const TROOPS_TILE_EXP = 0.6; // OpenFrontIO's exact exponent, unscaled
/** Flat troops-cap bonus per City owned (was BUILDINGS.city.popBonus=2200
 *  -- the OpenFrontIO-shaped equivalent lands at ~1,900, within ~14% of the
 *  existing value, which barely needs to move). */
export const CITY_TROOP_BONUS = 1900;

/**
 * Growth is OpenFrontIO's exact self-limiting shape: a flat floor plus a
 * sublinear function of current troops, scaled down as troops approach the
 * cap, computed once per tick (confirmed from OpenFrontIO's own source: its
 * ControlPanel multiplies this by 10 -- its own tick rate -- purely for
 * display, the same relationship TICKS_PER_SECOND already has here, so this
 * ports with no extra per-tick/per-second conversion). Sized so the time to
 * refill an army from 10% to 90% of cap at the 2,000-tile anchor (~47s)
 * matches today's (~46s) almost exactly; smaller nations refill somewhat
 * faster and larger ones somewhat slower than today, which is the
 * intended, deliberate effect of removing the flat land-driven growth term.
 */
export const TROOPS_GROWTH_BASE = 1.35; // per tick
export const TROOPS_GROWTH_SCALE = 13;
export const TROOPS_GROWTH_EXP = 0.73; // OpenFrontIO's exact exponent, unscaled
/** Per-second shrink when troops are over the cap (lost territory) -- kept
 *  as this project's own existing shape; OpenFrontIO's fetched source
 *  doesn't show an over-cap decay path (likely lives in code not fetched
 *  this round). */
export const TROOPS_DECAY = 0.06;

/**
 * Gold, ported from OpenFrontIO's goldAdditionRate(): a flat per-tick
 * trickle, not population-driven at all, on top of trade and city/port
 * income (both already exist below as tradeIncome/goldBonus). Replaces the
 * old WORKER_GOLD * workers term now that there are no workers -- sized
 * against a measured baseline of what the worker term used to pay a
 * mid-game nation (roughly 8-15 gold/s), landing early income close to
 * today's and, true to OpenFrontIO's own shape, letting its *relative*
 * weight shrink as trade and structures take over later in a match.
 */
export const GOLD_BASE_RATE = 1.2; // gold per tick (=12/s)

/**
 * Starting troops on spawn -- kept at the old troops-only figure (not
 * troops+workers combined) so a fresh nation's density, and so how cheap it
 * is to invade in the first seconds of a match, doesn't jump on its own.
 */
export const SPAWN_TROOPS = 220;
export const SPAWN_GOLD = 150;

export const DEFAULT_ATTACK_RATIO = 0.25;

// -------------------------------------------------------------- buildings ---

export const BUILDINGS = {
  city: {
    key: 'city',
    name: 'City',
    icon: '🏙',
    baseCost: 450,
    costStep: 400,
    troopBonus: CITY_TROOP_BONUS,
    goldBonus: 0.8,
    spacing: 9,
    desc: '+2,200 max troops, +0.8 gold/s',
  },
  port: {
    key: 'port',
    name: 'Port',
    icon: '⚓',
    baseCost: 700,
    costStep: 550,
    goldBonus: 6,
    coastal: true,
    spacing: 7,
    desc: '+6 gold/s from trade. Doubles troop boat range',
  },
  defense: {
    key: 'defense',
    name: 'Defense Post',
    icon: '🛡',
    // OpenFrontIO's exact mechanic: a single flat bonus if any post is in
    // range (not the old stacking +40%-per-post), so cost is bumped and
    // spacing widened to match its own radius -- overlapping posts under a
    // non-stacking bonus are pure waste, so tiling coverage rather than
    // clustering it is now the efficient way to build them.
    baseCost: 2200,
    costStep: 1600,
    radius: 30,
    lossBonus: 5,
    speedBonus: 3,
    spacing: 30,
    desc: 'Land within 30 tiles costs attackers 5× as much and falls 3× slower',
  },
  silo: {
    key: 'silo',
    name: 'Missile Silo',
    icon: '🚀',
    baseCost: 3500,
    costStep: 2500,
    spacing: 14,
    desc: 'Unlocks nuclear strikes anywhere on the map',
  },
  sam: {
    key: 'sam',
    name: 'SAM Launcher',
    icon: '📡',
    baseCost: 2800,
    costStep: 1800,
    radius: 46,
    cooldown: 25 * TICKS_PER_SECOND,
    spacing: 14,
    desc: 'Intercepts missiles aimed within 46 tiles',
  },
};

export const BUILDING_ORDER = ['city', 'port', 'defense', 'silo', 'sam'];

export function buildingCost(def, owned) {
  return Math.round(def.baseCost + def.costStep * owned);
}

// ----------------------------------------------------------------- nukes ----

export const NUKE_COST = 1800;
export const NUKE_RADIUS = 13;
/** Tiles travelled per tick by a missile. */
export const MISSILE_SPEED = 2.6;
/** Chance a ready SAM in range knocks the missile down. */
export const SAM_ACCURACY = 0.75;

// ----------------------------------------------------------------- boats ----

export const BOAT_SPEED = 1.3;
export const BOAT_RANGE = 190;
export const BOAT_RANGE_WITH_PORT = 420;
/** Minimum troops needed to launch a naval invasion. */
export const BOAT_MIN_TROOPS = 30;

// ------------------------------------------------------------ diplomacy ----

/** Ticks an alliance offer stays on the table before lapsing. */
export const ALLIANCE_OFFER_TTL = 30 * TICKS_PER_SECOND;
/** Betraying an ally adds this to your traitor score; it decays over time. */
export const BETRAYAL_PENALTY = 1;
export const TRAITOR_DECAY_PER_SECOND = 1 / 180;
/** Above this traitor score, nobody will accept your offers. */
export const TRAITOR_DISTRUST_LIMIT = 2.5;
/** An alliance cannot be broken for this long after it is signed. */
export const ALLIANCE_MIN_DURATION = 20 * TICKS_PER_SECOND;

// ---------------------------------------------------------------- trade ----

/** Gold per second each side earns per connected foreign port pair. */
export const TRADE_GOLD_PER_PARTNER = 2.4;
/** Diminishing returns: only this many partner ports pay out per port. */
export const TRADE_MAX_PARTNERS_PER_PORT = 3;
/** Allies trade at a premium. */
export const TRADE_ALLY_BONUS = 1.75;
/** Trade graph is rebuilt this often (ticks) rather than every tick. */
export const TRADE_REFRESH_TICKS = 3 * TICKS_PER_SECOND;

// ---------------------------------------------------------- encirclement ----

/**
 * Anything completely boxed in by a single nation falls to it for free --
 * once you have surrounded something, grinding it down tile by tile is a
 * formality. Two cases, with deliberately different rules:
 *
 *  - Unclaimed pockets are judged by their *land* neighbours only, so a
 *    stray hole on your own shoreline still gets filled in.
 *  - Whole nations must be genuinely landlocked to be annexed. A nation with
 *    any coast can still ship an army out (see boats, above), so the sea is
 *    a real escape route rather than a technicality.
 */
export const ENCLOSURE_SCAN_TICKS = 2 * TICKS_PER_SECOND;
/**
 * Largest unclaimed pocket that can be swallowed whole. Without a ceiling,
 * a nation that happens to be the only one touching a big untouched
 * interior would inhale it in one tick -- surrounding is meant to close out
 * a pocket, not to substitute for expanding.
 */
export const ENCLOSED_MAX_TILES = 400;

/** Share of a nation's treasury taken when it is annexed by encirclement. */
export const ANNEX_GOLD_SHARE = 1;
/** Share taken by whoever seizes a nation's last tile in ordinary conquest. */
export const CONQUEST_GOLD_SHARE = 0.5;

// --------------------------------------------------------------- victory ----

/** Share of all land needed to win outright. */
export const VICTORY_LAND_SHARE = 0.6;

// ----------------------------------------------------------------- maps -----

/**
 * Small/Medium/Large generate a fresh world from the seed. An entry carrying
 * `authored` instead plays a hand-drawn map (see src/maps/) at a fixed size,
 * where the seed still drives spawns and AI but never the terrain. `w`/`h`
 * are filled in for authored maps too, derived from the grid, so anything
 * reading a preset's dimensions works the same either way.
 */
/** Turns a src/maps/*.js definition into a MAP_PRESETS entry -- every
 *  authored map (World plus the six continents and four pattern maps
 *  below) follows this exact shape, so this replaces re-typing it by hand
 *  for each one. */
function authoredPreset(map) {
  return {
    key: map.key,
    label: map.label,
    w: map.grid[0].length * map.scale,
    h: map.grid.length * map.scale,
    bots: map.bots,
    tribes: TRIBE_TARGET_COUNT,
    authored: map,
  };
}

export const MAP_PRESETS = {
  small: { key: 'small', label: 'Small', w: 300, h: 190, bots: 8, tribes: TRIBE_TARGET_COUNT },
  medium: { key: 'medium', label: 'Medium', w: 420, h: 260, bots: 14, tribes: TRIBE_TARGET_COUNT },
  large: { key: 'large', label: 'Large', w: 560, h: 340, bots: 22, tribes: TRIBE_TARGET_COUNT },
  world: authoredPreset(WORLD_MAP),
  africa: authoredPreset(AFRICA_MAP),
  asia: authoredPreset(ASIA_MAP),
  europe: authoredPreset(EUROPE_MAP),
  northAmerica: authoredPreset(NORTH_AMERICA_MAP),
  southAmerica: authoredPreset(SOUTH_AMERICA_MAP),
  oceania: authoredPreset(OCEANIA_MAP),
  labyrinth: authoredPreset(LABYRINTH_MAP),
  theBox: authoredPreset(THE_BOX_MAP),
  onion: authoredPreset(ONION_MAP),
  branchingPaths: authoredPreset(BRANCHING_PATHS_MAP),
};

/**
 * How many spawn candidates to request relative to the number of players
 * that actually need one. Used to be a flat `players.length + 6` against a
 * fixed ~9-23 player field; with tribes roughly doubling that field, a
 * proportional overshoot keeps the same relative slack instead of the same
 * absolute one.
 */
export const SPAWN_POOL_OVERSHOOT = 1.25;
export const SPAWN_POOL_MARGIN = 6;

/**
 * How far from a team's first spawn its remaining members are allowed to be
 * placed, in tiles (Game#nearestFreeSpawn). findSpawnPoints spaces
 * candidates roughly 10 (Small) / 14 (Medium) / 18 (Large) tiles apart, so
 * this is about two to three candidate-spacings' worth of room: enough that
 * a team almost always finds somewhere nearby, tight enough that a duo's two
 * homelands read as one region rather than two coincidentally close ones. If
 * nothing inside the radius is free, the member falls back to the ordinary
 * scattered placement every other nation uses.
 */
export const TEAM_SPAWN_RADIUS = 45;

/**
 * Bot difficulty, chosen on the main menu. Scales bots on four axes:
 * troopsCapMultiplier and troopsMultiplier (troop *cap* and troop *growth
 * rate*, scaled separately -- OpenFrontIO's own maxTroops()/
 * troopIncreaseRate() both take an independent difficulty multiplier, so
 * this ports both rather than only growth), goldMultiplier (gold income --
 * unrelated to troops now that the two are fully decoupled, kept as its own
 * tuned dial, replacing the old single `economy` field), aggression (now
 * purely a diplomacy dial -- how readily a bot breaks a pact, see
 * #doDiplomacy/#maybeBetrayWeakAlly in ai.js; it no longer drives attack
 * targeting or commit size, which now come from the real, NOT
 * difficulty-scaled triggerRatio/reserveRatio/expandRatio ported from
 * OpenFrontIO -- see the ai section, above), and thinkRange (ticks between
 * re-evaluations -- how often a bot reconsiders its posture and looks for a
 * fight; this is the single biggest attack-behavior lever left, since it
 * changes how fast a bot reacts to a weakening rival or an opening on the
 * frontier, not just how strong it is once it decides to act).
 * troopsCapMultiplier/troopsMultiplier map onto OpenFrontIO's own *outer*
 * difficulty pair (its Easy/Impossible values, 0.5/0.9 and 1.25/1.05) rather
 * than its middle tiers -- OceanFront's "hard" is deliberately stronger than
 * a human opponent (matching the old economy=1.6 spirit) and "normal" is
 * the documented unscaled baseline, the same role OpenFrontIO's own
 * "Medium" (1.0/1.0) plays.
 * The human player is never affected by any of this -- it only ever scales
 * bots. 'normal' keeps the previous flat thinkRange (18-34 ticks) as the
 * unscaled baseline; every multiplier being 1 is what keeps Normal's
 * *strength* unchanged from before these tiers existed -- it does not
 * freeze the underlying decision logic itself, which improves for every
 * tier together. `readiness` was removed with the invented aggression
 * system it gated -- reserveRatio/triggerRatio supersede it, deliberately
 * un-scaled by tier, matching OpenFrontIO exactly.
 */
export const DIFFICULTIES = {
  easy: {
    key: 'easy', label: 'Easy',
    troopsCapMultiplier: 0.5, troopsMultiplier: 0.9, goldMultiplier: 0.6, aggression: 0.6,
    thinkRange: [32, 55],
  },
  normal: {
    key: 'normal', label: 'Normal',
    troopsCapMultiplier: 1, troopsMultiplier: 1, goldMultiplier: 1, aggression: 1,
    thinkRange: [18, 34],
  },
  hard: {
    key: 'hard', label: 'Hard',
    troopsCapMultiplier: 1.25, troopsMultiplier: 1.05, goldMultiplier: 1.6, aggression: 1.45,
    thinkRange: [10, 20],
    // Refuses to launch a token attack under 20% of the target's troops
    // (unless already under attack itself) rather than waste a cycle
    // donating troops to the rebalancer for no real gain.
    strictAttacks: true,
  },
};
export const DEFAULT_DIFFICULTY = 'normal';

/**
 * Match format, chosen on the main menu. `teamSize` is the *requested*
 * members per team -- the real split is decided once, at Game construction
 * (Game#assignTeams), from however many nations the preset actually fields,
 * so a 9-nation Small map in duos ends up as [3,2,2,2] rather than leaving a
 * lone nation without a partner. Teams are permanent for the whole match:
 * no leaving, no betrayal, no negotiation -- that is what makes a team
 * different from an alliance in src/diplomacy.js, which is all three.
 * Tribes are never on a team, at any size.
 *
 * `solo` (teamSize 1) is the historical shape of the game and must stay
 * bit-for-bit identical to it -- see Game#assignTeams for the invariant
 * this depends on.
 */
export const TEAM_MODES = {
  solo: { key: 'solo', label: 'Solo', teamSize: 1 },
  duos: { key: 'duos', label: 'Duos', teamSize: 2 },
  trios: { key: 'trios', label: 'Trios', teamSize: 3 },
  quads: { key: 'quads', label: 'Quads', teamSize: 4 },
};
export const DEFAULT_TEAM_MODE = 'solo';

export const PLAYER_COLORS = [
  '#e0484f', '#3f8ce8', '#37b26a', '#e0a33a', '#9b5de5',
  '#e2683c', '#22b8b0', '#d9478f', '#7bc043', '#5c6bc0',
  '#c94f7c', '#4aa8d8', '#8bc34a', '#ef7c1c', '#7e57c2',
  '#26a69a', '#d4a017', '#5d8aa8', '#b5651d', '#68a357',
  '#cc4b3a', '#4f9d9d', '#a3673f', '#6a8caf',
];

// ---------------------------------------------------------------- camera ----

/**
 * WASD/arrow-key pan speed, in screen pixels per `applyKeyboardPan` time
 * unit (see `UI#applyKeyboardPan` -- frame-rate independent, so this reads
 * directly as "pixels per ~1/60s of real time" the same way it always has).
 * OpenFrontIO drives its own keyboard pan off a flat `PAN_SPEED = 5`
 * screen-pixel step fired on a ~4ms clamped timer (a `setInterval(fn, 1)`,
 * which every mainstream browser clamps to ~4ms once it's a few calls deep)
 * -- roughly 1200px/s of real screen movement, not scaled by zoom either,
 * the same "flat screen-pixel offset" shape OceanFront's own pan already
 * uses. That's the piece worth porting; the literal `5`/`~4ms` pair isn't
 * meaningful on its own since it's an artifact of a different timer
 * mechanism, not a real speed. Retuned to land in the same ballpark
 * (~960px/s at 60fps) using OceanFront's existing per-frame model instead of
 * adding a second timer -- was `0.75` (~45px/s), over 20x slower than this.
 */
export const KEYBOARD_PAN_SPEED = 16;

// ----------------------------------------------------------------- sound ----
//
// All audio is synthesized live via the Web Audio API (src/sound.js) --
// there are no binary audio files anywhere in this project. Two reasons:
// zero runtime dependencies stays true (no asset pipeline, nothing to
// precache but code), and it sidesteps asset licensing entirely -- the
// natural reference, OpenFrontIO, ships its sound effects under CC BY-SA
// 4.0 and its music fully proprietary (fetched from their live service, not
// even in their repo), and this project's own repeated precedent is to
// study OpenFrontIO's *mechanic* (which moments get sound, how volume/mute
// behave) and never import their literal asset files, same as every other
// round that has touched OpenFrontIO parity. Per-oscillator synthesis
// parameters (frequencies, filter Q, envelope shapes) live in sound.js
// itself, not here -- they're a sound's implementation, not a balance
// knob. Only what a person would plausibly retune lives in this file.

/** Both default ON at a moderate level -- sound is part of the game, not an
 *  opt-in some players will never find. Raw slider positions (0-1); sound.js
 *  squares them for an audio-taper curve, since perceived loudness is
 *  roughly logarithmic but a slider position is linear. */
export const SFX_VOLUME_DEFAULT = 0.7;
export const MUSIC_VOLUME_DEFAULT = 0.45;

/** Concurrent effect voices. A 9th evicts the oldest (faded, not cut) rather
 *  than piling on -- a busy tick would otherwise turn into mush. */
export const MAX_SFX_VOICES = 8;

/** Floor on how often any one effect may retrigger, in ms -- generalizes
 *  OpenFrontIO's own MIRV-hit throttle (a sound type that can legitimately
 *  fire many times in quick succession needs a minimum gap so it can't
 *  flood the mix). `click` fires the most and needs the shortest floor to
 *  still feel responsive; the two loudest/rarest effects get the longest. */
export const SFX_MIN_GAP_MS = 55;
export const SFX_GAP_MS = {
  click: 35,
  'nuke-launch': 250,
  'nuke-hit': 400,
  conquest: 300,
  annex: 300,
};

/** Final per-effect mix trim, applied on top of each recipe's own internal
 *  gains -- keeps the loudest effects (nukes) from drowning the quietest
 *  (click) once everything shares one sfx bus. */
export const SFX_MIX = {
  click: 0.35,
  'build-city': 0.8,
  'build-port': 0.8,
  'build-defense': 0.8,
  'build-silo': 0.85,
  'build-sam': 0.8,
  'nuke-launch': 1.0,
  'nuke-hit': 1.0,
  intercept: 0.85,
  conquest: 1.0,
  annex: 0.95,
  'alliance-offer': 0.7,
  'alliance-formed': 0.7,
  'alliance-broken': 0.6,
  betrayed: 0.85,
  victory: 1.0,
  defeat: 0.9,
};

/**
 * Generative ambient music, A natural minor. Six diatonic chords (Roman
 * numerals: i, VI, VII, III, iv, v), each a root-position triad spread
 * across a couple of octaves for an open, non-muddy voicing. Walked with a
 * weighted Markov chain (MUSIC_TRANSITIONS) rather than a fixed
 * progression -- a fixed 4-bar loop is exactly what becomes annoying on
 * repeat. Every row sums to 1 and every chord can always reach `i`, so the
 * walk can never stall or wander permanently out of key.
 */
export const MUSIC_CHORDS = {
  i: [110, 261.63, 329.63], // A2 C4 E4 -- A minor
  VI: [87.31, 220, 261.63], // F2 A3 C4 -- F major
  VII: [98, 246.94, 293.66], // G2 B3 D4 -- G major
  III: [130.81, 164.81, 196], // C3 E3 G3 -- C major
  iv: [146.83, 174.61, 220], // D3 F3 A3 -- D minor
  v: [164.81, 196, 246.94], // E3 G3 B3 -- E minor
};
export const MUSIC_TRANSITIONS = {
  i: { VI: 0.35, VII: 0.25, iv: 0.2, III: 0.2 },
  VI: { VII: 0.4, III: 0.3, i: 0.3 },
  VII: { i: 0.45, III: 0.3, VI: 0.25 },
  III: { VII: 0.35, iv: 0.3, VI: 0.35 },
  iv: { v: 0.3, i: 0.35, VII: 0.35 },
  v: { i: 0.6, VI: 0.4 },
};
/** Each chord holds for a random duration in this range, seconds -- fixed
 *  bar lengths are what make generative music start to feel like a loop. */
export const MUSIC_CHORD_SECONDS = [9, 15];
/** A sparse punctuating bell, pitched off the *current* chord (so it can
 *  never clash), fired at a random interval in this range, seconds. */
export const MUSIC_BELL_SECONDS = [11, 26];
/** Retuning a live oscillator glides audibly, so chord changes crossfade
 *  between two alternating pad voices instead -- this is that crossfade's
 *  length, seconds. */
export const MUSIC_CROSSFADE = 4;
export const MUSIC_FADE_IN = 2.5;
export const MUSIC_FADE_OUT = 1.2;
/** Slow filter LFO sweeping the pad voices for a "breathing" feel.
 *  Deliberately not a clean divisor of any chord length, so the sweep and
 *  the chord walk never lock into an audible, repeating pattern together. */
export const MUSIC_FILTER_LFO_HZ = 0.035;
/** How far the music ducks under a dramatic sfx hit (nuke-hit, conquest),
 *  as a fraction of its current level. */
export const MUSIC_DUCK_TO = 0.35;
