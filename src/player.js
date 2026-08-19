// A nation: its land, its population split between troops and workers, its
// treasury and its structures.

import {
  BASE_POP,
  POP_PER_TILE,
  POP_GROWTH,
  POP_BASE_GROWTH,
  POP_DECAY,
  LAND_GROWTH,
  MIGRATE_RATE,
  TROOP_MOMENTUM_SCALE,
  TROOP_MOMENTUM_CAP,
  WORKER_GOLD,
  TICKS_PER_SECOND,
  DEFAULT_TROOP_RATIO,
  DEFAULT_ATTACK_RATIO,
  BUILDINGS,
} from './config.js';

export class Player {
  constructor(id, name, color, isHuman = false) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.isHuman = isHuman;
    this.alive = true;

    this.tiles = new Set();
    this.troops = 0;
    this.workers = 0;
    this.gold = 0;

    this.troopRatio = DEFAULT_TROOP_RATIO;
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

    /** Bot-difficulty scaling for gold income and population growth. Always
     *  1 for the human player -- difficulty only ever affects bots. */
    this.economyMultiplier = 1;

    /** Population gained (or lost, while decaying over the cap) per game
     *  second, measured directly off updateEconomy()'s own before/after pop
     *  rather than re-derived -- shown next to the HUD population bar. */
    this.popRate = 0;

    /** Who most recently took a tile from us. Whoever holds this when the
     *  last tile falls inherits a share of the treasury (CONQUEST_GOLD_SHARE);
     *  it stays NEUTRAL if the land was lost to a nuke rather than a nation,
     *  so scorching someone off the map earns no spoils. */
    this.lastConquerorId = -1;
  }

  get pop() {
    return this.troops + this.workers;
  }

  get tileCount() {
    return this.tiles.size;
  }

  /** Troops per tile -- the number that decides how hard this nation is to invade. */
  get density() {
    return this.tiles.size > 0 ? this.troops / this.tiles.size : 0;
  }

  get maxPop() {
    return BASE_POP + this.tiles.size * POP_PER_TILE + this.buildingCounts.city * BUILDINGS.city.popBonus;
  }

  /**
   * The troop share actually being grown/rebalanced toward, this tick --
   * the slider's troopRatio, plus a push proportional to how many troops
   * you already have. This is what makes a big army snowball: more troops
   * raises the target, which pulls even more of new growth (and existing
   * workers) into troops, which raises the target further next tick.
   */
  get effectiveTroopRatio() {
    const headroom = TROOP_MOMENTUM_CAP - this.troopRatio;
    if (headroom <= 0) return this.troopRatio;
    const bonus = headroom * (1 - Math.exp(-this.troops / TROOP_MOMENTUM_SCALE));
    return this.troopRatio + bonus;
  }

  /**
   * Territory pays nothing by itself -- gold comes from workers, cities,
   * ports and trade. Land is the military engine (see LAND_GROWTH); this is
   * the economic one, and the two are deliberately separate.
   */
  get goldPerSecond() {
    const income =
      this.workers * WORKER_GOLD +
      this.buildingCounts.port * BUILDINGS.port.goldBonus +
      this.buildingCounts.city * BUILDINGS.city.goldBonus +
      this.tradeIncome;
    return income * this.economyMultiplier;
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

  /** One simulation tick of population growth, migration and income. */
  updateEconomy() {
    const popBefore = this.pop;
    const cap = this.maxPop;
    const pop = this.pop;
    // Computed once and reused for both steps below, so growth and
    // rebalancing always agree on where troops are headed this tick.
    const ratio = this.effectiveTroopRatio;

    if (pop < cap) {
      // Territory feeds the growth rate, not just the ceiling -- a wide
      // nation rebuilds its army fast rather than only being able to hold a
      // bigger one.
      const rate = pop * POP_GROWTH + POP_BASE_GROWTH + this.tiles.size * LAND_GROWTH;
      // economyMultiplier scales bot difficulty (always 1 for the human).
      // Only growth is scaled, not the decay branch below -- a harder bot
      // should build up faster, not merely fall apart slower after losing
      // land, and vice versa for easy.
      const growth = ((rate * (1 - pop / cap)) / TICKS_PER_SECOND) * this.economyMultiplier;
      // New population enters on the side the slider (plus troop momentum)
      // is calling for.
      this.troops += growth * ratio;
      this.workers += growth * (1 - ratio);
    } else if (pop > cap) {
      // Overpopulated after losing land: shrink back down toward the cap.
      const decay = ((pop - cap) * POP_DECAY) / TICKS_PER_SECOND;
      const total = pop || 1;
      this.troops = Math.max(0, this.troops - decay * (this.troops / total));
      this.workers = Math.max(0, this.workers - decay * (this.workers / total));
    }

    // Re-balance existing population toward the requested split.
    const desiredTroops = this.pop * ratio;
    let move = ((desiredTroops - this.troops) * MIGRATE_RATE) / TICKS_PER_SECOND;
    if (move > this.workers) move = this.workers;
    if (-move > this.troops) move = -this.troops;
    this.troops += move;
    this.workers -= move;

    if (this.troops < 0) this.troops = 0;
    if (this.workers < 0) this.workers = 0;

    // Re-balancing above moves population between troops/workers but never
    // changes the total, so this delta is purely the growth/decay branches
    // -- measuring it here instead of re-deriving the formula stays correct
    // automatically if that formula ever changes again.
    this.popRate = (this.pop - popBefore) * TICKS_PER_SECOND;

    this.gold += this.goldPerSecond / TICKS_PER_SECOND;
  }

  /** Take troops out of the standing army for an attack or a boat. */
  withdrawTroops(amount) {
    const taken = Math.min(this.troops, Math.max(0, amount));
    this.troops -= taken;
    return taken;
  }

  /** Casualties, applied to troops first and then to the civilian population. */
  killTroops(amount) {
    const fromTroops = Math.min(this.troops, amount);
    this.troops -= fromTroops;
    const rest = amount - fromTroops;
    if (rest > 0) this.workers = Math.max(0, this.workers - rest);
  }
}
