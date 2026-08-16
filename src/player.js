// A nation: its land, its population split between troops and workers, its
// treasury and its structures.

import {
  BASE_POP,
  POP_PER_TILE,
  POP_GROWTH,
  POP_BASE_GROWTH,
  POP_DECAY,
  MIGRATE_RATE,
  WORKER_GOLD,
  TILE_GOLD,
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

  get goldPerSecond() {
    return (
      this.workers * WORKER_GOLD +
      this.tiles.size * TILE_GOLD +
      this.buildingCounts.port * BUILDINGS.port.goldBonus +
      this.buildingCounts.city * BUILDINGS.city.goldBonus +
      this.tradeIncome
    );
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
    const cap = this.maxPop;
    const pop = this.pop;

    if (pop < cap) {
      const growth = ((pop * POP_GROWTH + POP_BASE_GROWTH) * (1 - pop / cap)) / TICKS_PER_SECOND;
      // New population enters on the side the slider is calling for.
      this.troops += growth * this.troopRatio;
      this.workers += growth * (1 - this.troopRatio);
    } else if (pop > cap) {
      // Overpopulated after losing land: shrink back down toward the cap.
      const decay = ((pop - cap) * POP_DECAY) / TICKS_PER_SECOND;
      const total = pop || 1;
      this.troops = Math.max(0, this.troops - decay * (this.troops / total));
      this.workers = Math.max(0, this.workers - decay * (this.workers / total));
    }

    // Re-balance existing population toward the requested split.
    const desiredTroops = this.pop * this.troopRatio;
    let move = ((desiredTroops - this.troops) * MIGRATE_RATE) / TICKS_PER_SECOND;
    if (move > this.workers) move = this.workers;
    if (-move > this.troops) move = -this.troops;
    this.troops += move;
    this.workers -= move;

    if (this.troops < 0) this.troops = 0;
    if (this.workers < 0) this.workers = 0;

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
