// A nation: its land, its troops (population is troops-only, matching
// OpenFrontIO's model -- see src/config.js's economy section), its
// treasury and its structures.

import {
  TROOPS_BASE,
  TROOPS_TILE_SCALE,
  TROOPS_TILE_EXP,
  TROOPS_GROWTH_BASE,
  TROOPS_GROWTH_SCALE,
  TROOPS_GROWTH_EXP,
  TROOPS_DECAY,
  GOLD_BASE_RATE,
  TICKS_PER_SECOND,
  DEFAULT_ATTACK_RATIO,
  BUILDINGS,
} from './config.js';

export class Player {
  constructor(id, name, color, isHuman = false) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.isHuman = isHuman;
    /** Set for the lightweight "tribe" archetype (see src/tribe.js): a
     *  small, lazy filler AI that occupies open land early and never
     *  snowballs. `isHuman` / `isTribe` / `ai` are the only three
     *  discriminators a Player has -- a full nation is `ai && !isTribe`. */
    this.isTribe = false;
    this.alive = true;

    this.tiles = new Set();
    this.troops = 0;
    this.gold = 0;

    this.attackRatio = DEFAULT_ATTACK_RATIO;

    /** Structures owned, in build order. */
    this.buildings = [];
    this.buildingCounts = Object.fromEntries(Object.keys(BUILDINGS).map((k) => [k, 0]));

    /** Ids of nations we have a non-aggression pact with. */
    this.allies = new Set();
    /** Rises on betrayal, decays over time; gates future alliance offers. */
    this.traitorScore = 0;
    /** Gold per second from sea trade, recomputed by the trade graph. */
    this.tradeIncome = 0;

    /** Cached centroid for map labels; refreshed periodically. */
    this.centroid = { x: 0, y: 0 };
    this.labelScale = 1;

    // AI personality, unused for the human player.
    this.ai = null;
    this.peakTiles = 0;

    /** Bot-difficulty scaling for troop cap, troop growth and gold income,
     *  kept separate now that they're fully decoupled (see DIFFICULTIES in
     *  config.js). Always 1 for the human player -- difficulty only ever
     *  affects bots. */
    this.troopsCapMultiplier = 1;
    this.troopsMultiplier = 1;
    this.goldMultiplier = 1;

    /** Troops gained (or lost, while decaying over the cap) per game
     *  second, measured directly off updateEconomy()'s own before/after
     *  troop count rather than re-derived -- shown next to the HUD troop
     *  bar. */
    this.popRate = 0;

    /** Who most recently took a tile from us. Whoever holds this when the
     *  last tile falls inherits a share of the treasury (CONQUEST_GOLD_SHARE);
     *  it stays NEUTRAL if the land was lost to a nuke rather than a nation,
     *  so scorching someone off the map earns no spoils. */
    this.lastConquerorId = -1;
  }

  get tileCount() {
    return this.tiles.size;
  }

  /** Troops per tile -- the number that decides how hard this nation is to invade. */
  get density() {
    return this.tiles.size > 0 ? this.troops / this.tiles.size : 0;
  }

  /**
   * Troop cap, ported from OpenFrontIO's maxTroops(): a sublinear function
   * of tiles held (diminishing returns on sprawl, unlike the old flat
   * per-tile rate) plus a flat bonus per City. See src/config.js's economy
   * section for the exact constants and how they were scaled.
   */
  get maxTroops() {
    return (2 * (TROOPS_TILE_SCALE * this.tiles.size ** TROOPS_TILE_EXP + TROOPS_BASE)
      + this.buildingCounts.city * BUILDINGS.city.troopBonus) * this.troopsCapMultiplier;
  }

  /**
   * Standing army as a share of this nation's own cap -- how full, not how
   * big. Unlike `density`, this stays meaningful for comparing nations of
   * very different sizes: maxTroops is now a sublinear function of tiles
   * (see above), so two equally-committed nations of different sizes settle
   * at different equilibrium densities on their own, purely from size, not
   * from how militarized either one actually is. AiController uses this,
   * not density, wherever the question is "how strong is this nation for
   * its own size" rather than "how much would this tile actually cost to
   * take" (the latter is what density itself still correctly measures, via
   * Game#attackLogic).
   */
  get fillRatio() {
    return this.troops / Math.max(1, this.maxTroops);
  }

  /**
   * Gold, ported from OpenFrontIO's goldAdditionRate(): a flat per-tick
   * trickle -- not population-driven at all -- plus port/city bonuses and
   * trade income. Territory itself still pays nothing directly; it buys an
   * army (maxTroops, above), not income.
   */
  get goldPerSecond() {
    const income =
      GOLD_BASE_RATE * TICKS_PER_SECOND +
      this.buildingCounts.port * BUILDINGS.port.goldBonus +
      this.buildingCounts.city * BUILDINGS.city.goldBonus +
      this.tradeIncome;
    return income * this.goldMultiplier;
  }

  countOf(key) {
    return this.buildingCounts[key] || 0;
  }

  addTile(i) {
    this.tiles.add(i);
    if (this.tiles.size > this.peakTiles) this.peakTiles = this.tiles.size;
  }

  removeTile(i) {
    this.tiles.delete(i);
  }

  /**
   * One simulation tick of troop growth (or over-cap decay) and income.
   * Growth is OpenFrontIO's exact self-limiting shape, ported from
   * troopIncreaseRate() -- a flat floor plus a sublinear function of
   * current troops, scaled toward zero as troops approach the cap. It's
   * already a per-tick formula in OpenFrontIO (confirmed from its own
   * source -- see src/config.js), so no extra per-tick/per-second
   * conversion is needed here.
   */
  updateEconomy() {
    const max = this.maxTroops;

    if (this.troops < max) {
      const toAdd = (TROOPS_GROWTH_BASE + this.troops ** TROOPS_GROWTH_EXP / TROOPS_GROWTH_SCALE)
        * (1 - this.troops / max) * this.troopsMultiplier;
      this.troops += toAdd;
      this.popRate = toAdd * TICKS_PER_SECOND;
    } else if (this.troops > max) {
      // Overpopulated after losing land: shrink back down toward the cap.
      // OpenFrontIO's fetched source has no equivalent path (population
      // there presumably never exceeds an instantaneously-recomputed cap
      // the way it can here) -- kept as this project's own existing shape.
      const decay = ((this.troops - max) * TROOPS_DECAY) / TICKS_PER_SECOND;
      this.troops = Math.max(max, this.troops - decay);
      this.popRate = -decay * TICKS_PER_SECOND;
    } else {
      this.popRate = 0;
    }

    if (this.troops < 0) this.troops = 0;

    this.gold += this.goldPerSecond / TICKS_PER_SECOND;
  }

  /** Take troops out of the standing army for an attack or a boat. */
  withdrawTroops(amount) {
    const taken = Math.min(this.troops, Math.max(0, amount));
    this.troops -= taken;
    return taken;
  }

  /** Casualties. */
  killTroops(amount) {
    this.troops = Math.max(0, this.troops - amount);
  }
}
