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

// Flat troop cost of stepping onto the tile, before defender strength.
export const TERRAIN_COST = [Infinity, 0.7, 1.5, 2.6];
// Multiplier applied to the whole tile cost -- rough ground defends itself.
export const TERRAIN_DEFENSE = [1, 1.0, 1.1, 1.3];

// ----------------------------------------------------------------- combat ---

/** Effective troops-per-tile that unclaimed land defends itself with. */
export const NEUTRAL_DENSITY = 1.1;
/** How much a defender's troop density is worth per tile. */
export const DEFENDER_STRENGTH = 1.15;
/** Fraction of a defender's per-tile density that dies when a tile falls. */
export const DEFENDER_LOSS = 0.85;
/** Attacks conquer at least this many tiles per tick... */
export const ATTACK_BASE_TILES = 5;
/** ...plus this many per committed troop, capped below. */
export const ATTACK_TILES_PER_TROOP = 1 / 130;
export const ATTACK_MAX_TILES = 150;
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

// ---------------------------------------------------------------- economy ---

export const BASE_POP = 300;
export const POP_PER_TILE = 4.2;
/** Logistic growth coefficient, per second. */
export const POP_GROWTH = 0.075;
/** Flat growth floor so tiny nations can still recover, per second. */
export const POP_BASE_GROWTH = 8;
/** Per-second shrink when population is over the cap (lost territory). */
export const POP_DECAY = 0.06;
/**
 * A large standing army pulls the troops/workers split further toward
 * troops than the slider alone asks for -- a big military snowballs instead
 * of growing at a flat rate. This has to work by shifting the *target* the
 * rebalancer (MIGRATE_RATE, below) pulls toward, not by adding troops on the
 * side: the rebalancer runs every tick and continuously corrects the split
 * back toward whatever ratio it's given, so troops added on top of that
 * would just leak back out into workers over time instead of compounding.
 *
 * The push approaches TROOP_MOMENTUM_CAP asymptotically as troops grow, at
 * the rate set by TROOP_MOMENTUM_SCALE (roughly the troop count at which
 * ~63% of the available headroom is used) -- never hitting a hard wall, so
 * a nation with 40,000 troops still keeps out-accelerating one with 15,000.
 * Real matches were sampled to size this: nations run from ~200 troops at
 * spawn up past 40,000 for a dominant empire by minute 10, so a linear rate
 * strong enough to matter early ends up flatly maxed out for most of the
 * game -- this curve stays meaningfully differentiated across that whole
 * range instead.
 */
export const TROOP_MOMENTUM_SCALE = 12000;
/** However large the army, the effective ratio never exceeds this -- some
 *  minimum worker base (and gold income) always survives. */
export const TROOP_MOMENTUM_CAP = 0.97;
/** How fast population re-balances toward the troop/worker slider, per second. */
export const MIGRATE_RATE = 0.4;

export const WORKER_GOLD = 0.0075;
export const TILE_GOLD = 0.003;

export const DEFAULT_TROOP_RATIO = 0.6;
export const DEFAULT_ATTACK_RATIO = 0.25;

// -------------------------------------------------------------- buildings ---

export const BUILDINGS = {
  city: {
    key: 'city',
    name: 'City',
    icon: '🏙',
    baseCost: 450,
    costStep: 400,
    popBonus: 2200,
    goldBonus: 0.8,
    spacing: 9,
    desc: '+2,200 max population, +0.8 gold/s',
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
    baseCost: 550,
    costStep: 300,
    radius: 18,
    defenseBonus: 1.4,
    spacing: 11,
    desc: 'Land within 18 tiles costs attackers 2.4× as much',
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

// --------------------------------------------------------------- victory ----

/** Share of all land needed to win outright. */
export const VICTORY_LAND_SHARE = 0.6;

// ----------------------------------------------------------------- maps -----

export const MAP_PRESETS = {
  small: { key: 'small', label: 'Small', w: 300, h: 190, bots: 8 },
  medium: { key: 'medium', label: 'Medium', w: 420, h: 260, bots: 14 },
  large: { key: 'large', label: 'Large', w: 560, h: 340, bots: 22 },
};

/**
 * Bot difficulty, chosen on the main menu. Scales bots on two axes: economy
 * (gold income and population growth -- always a felt difference, since it
 * doesn't depend on how a bot's own decision logic happens to play out) and
 * aggression (the personality traits in AiController, so harder bots also
 * attack sooner and more often, not just with a bigger stack behind them).
 * The human player is never affected by this -- it only ever scales bots.
 * 'normal' is 1/1, so games default to exactly today's balance.
 */
export const DIFFICULTIES = {
  easy: { key: 'easy', label: 'Easy', economy: 0.6, aggression: 0.6 },
  normal: { key: 'normal', label: 'Normal', economy: 1, aggression: 1 },
  hard: { key: 'hard', label: 'Hard', economy: 1.6, aggression: 1.45 },
};
export const DEFAULT_DIFFICULTY = 'normal';

export const PLAYER_COLORS = [
  '#e0484f', '#3f8ce8', '#37b26a', '#e0a33a', '#9b5de5',
  '#e2683c', '#22b8b0', '#d9478f', '#7bc043', '#5c6bc0',
  '#c94f7c', '#4aa8d8', '#8bc34a', '#ef7c1c', '#7e57c2',
  '#26a69a', '#d4a017', '#5d8aa8', '#b5651d', '#68a357',
  '#cc4b3a', '#4f9d9d', '#a3673f', '#6a8caf',
];
