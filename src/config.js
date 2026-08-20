// Central tuning table. Every gameplay number lives here so balance can be
// adjusted without hunting through the simulation code.

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
 */
export const TERRAIN_MAG = [Infinity, 4.5, 5.6, 6.75];
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

/** Chance a bordering full nation (or the human) is skipped over in favour
 *  of continuing the search for a softer target. Tribes mildly prefer
 *  picking on each other, but will still fight a nation or the player
 *  directly -- there is no difficulty-based leniency toward the human
 *  here, unlike nations. */
export const TRIBE_SERIOUS_SKIP_CHANCE = 0.5;

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

/** How many extra AI-controlled players each map size gets on top of its
 *  `bots` (full nations) -- see MAP_PRESETS, below. First-pass counts,
 *  measured against findSpawnPoints' spawn-density floor (no fallback
 *  spawns across a wide seed sweep at these counts) rather than guessed;
 *  tune here first if pacing needs it. */
export const TRIBE_COUNTS = { small: 6, medium: 10, large: 16 };

/** Muted palette, kept separate from PLAYER_COLORS so tribes read as
 *  background at a glance and never collide with a nation's colour. 16
 *  entries = the largest tribe count above, so no reuse within one match. */
export const TRIBE_COLORS = [
  '#a3705f', '#6f8fa3', '#7f9c6d', '#a99154',
  '#8b7ba6', '#a86f86', '#5f9b93', '#9c8b6a',
  '#7d8aa0', '#8fa05f', '#b0846a', '#6b95a8',
  '#a37f9c', '#84a58e', '#9d7a6a', '#75879b',
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

export const MAP_PRESETS = {
  small: { key: 'small', label: 'Small', w: 300, h: 190, bots: 8, tribes: TRIBE_COUNTS.small },
  medium: { key: 'medium', label: 'Medium', w: 420, h: 260, bots: 14, tribes: TRIBE_COUNTS.medium },
  large: { key: 'large', label: 'Large', w: 560, h: 340, bots: 22, tribes: TRIBE_COUNTS.large },
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
 * Bot difficulty, chosen on the main menu. Scales bots on five axes:
 * troopsCapMultiplier and troopsMultiplier (troop *cap* and troop *growth
 * rate*, scaled separately -- OpenFrontIO's own maxTroops()/
 * troopIncreaseRate() both take an independent difficulty multiplier, so
 * this ports both rather than only growth), goldMultiplier (gold income --
 * unrelated to troops now that the two are fully decoupled, kept as its own
 * tuned dial, replacing the old single `economy` field), aggression (the
 * personality traits in AiController, so harder bots also attack sooner and
 * more often, not just with a bigger stack behind them), thinkRange (ticks
 * between re-evaluations -- how often a bot reconsiders its posture and
 * looks for a fight; this is the single biggest lever, since it changes how
 * fast a bot reacts to a weakening rival or an opening on the frontier, not
 * just how strong it is once it decides to act), and readiness (the
 * standing-army fullness a bot wants before committing to a fight -- lower
 * means attacking sooner with a thinner army).
 * troopsCapMultiplier/troopsMultiplier map onto OpenFrontIO's own *outer*
 * difficulty pair (its Easy/Impossible values, 0.5/0.9 and 1.25/1.05) rather
 * than its middle tiers -- OceanFront's "hard" is deliberately stronger than
 * a human opponent (matching the old economy=1.6 spirit) and "normal" is
 * the documented unscaled baseline, the same role OpenFrontIO's own
 * "Medium" (1.0/1.0) plays.
 * The human player is never affected by any of this -- it only ever scales
 * bots. 'normal' keeps the previous flat values (18-34 ticks, 0.45
 * readiness) as the unscaled baseline; every multiplier being 1 is what
 * keeps Normal's *strength* unchanged from before these tiers existed -- it
 * does not freeze the underlying decision logic itself, which improves for
 * every tier together.
 */
export const DIFFICULTIES = {
  easy: {
    key: 'easy', label: 'Easy',
    troopsCapMultiplier: 0.5, troopsMultiplier: 0.9, goldMultiplier: 0.6, aggression: 0.6,
    thinkRange: [32, 55], readiness: 0.55,
  },
  normal: {
    key: 'normal', label: 'Normal',
    troopsCapMultiplier: 1, troopsMultiplier: 1, goldMultiplier: 1, aggression: 1,
    thinkRange: [18, 34], readiness: 0.45,
  },
  hard: {
    key: 'hard', label: 'Hard',
    troopsCapMultiplier: 1.25, troopsMultiplier: 1.05, goldMultiplier: 1.6, aggression: 1.45,
    thinkRange: [10, 20], readiness: 0.35,
    // Refuses to launch a token attack under 20% of the target's troops
    // (unless already under attack itself) rather than waste a cycle
    // donating troops to the rebalancer for no real gain.
    strictAttacks: true,
  },
};
export const DEFAULT_DIFFICULTY = 'normal';

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
