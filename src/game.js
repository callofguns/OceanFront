// The simulation. Owns the map, the players and every in-flight action.
// Ticks at a fixed rate (see TICKS_PER_SECOND); rendering is decoupled.

import {
  OCEAN,
  TERRAIN_COST,
  TERRAIN_DEFENSE,
  NEUTRAL_DENSITY,
  DEFENDER_STRENGTH,
  DEFENDER_LOSS,
  ATTACK_BASE_TILES,
  ATTACK_TILES_PER_TROOP,
  ATTACK_MAX_TILES,
  ATTACK_MIN_TROOPS,
  FRONTIER_SAMPLE_SIZE,
  RETREAT_REFUND,
  BUILDINGS,
  buildingCost,
  NUKE_COST,
  NUKE_RADIUS,
  MISSILE_SPEED,
  SAM_ACCURACY,
  BOAT_SPEED,
  BOAT_RANGE,
  BOAT_RANGE_WITH_PORT,
  BOAT_MIN_TROOPS,
  VICTORY_LAND_SHARE,
  TICKS_PER_SECOND,
  PLAYER_COLORS,
  TRADE_GOLD_PER_PARTNER,
  TRADE_MAX_PARTNERS_PER_PORT,
  TRADE_ALLY_BONUS,
  TRADE_REFRESH_TICKS,
  DIFFICULTIES,
  DEFAULT_DIFFICULTY,
} from './config.js';
import { generateMap, findSpawnPoints } from './map.js';
import { makeRng, shuffle } from './rng.js';
import { Player } from './player.js';
import { NATION_NAMES } from './names.js';
import { AiController } from './ai.js';
import { Diplomacy } from './diplomacy.js';

export const NEUTRAL = -1;

class Attack {
  constructor(attackerId, targetId, troops) {
    this.attackerId = attackerId;
    this.targetId = targetId;
    this.troops = troops;
    this.frontier = [];
    this.inFrontier = new Set();
    this.fails = 0;
    this.done = false;
  }
}

class Boat {
  constructor(ownerId, troops, path, targetTile) {
    this.ownerId = ownerId;
    this.troops = troops;
    this.path = path;
    this.targetTile = targetTile;
    this.progress = 0;
    this.done = false;
  }
}

class Missile {
  constructor(ownerId, fromTile, toTile, map) {
    this.ownerId = ownerId;
    this.fromTile = fromTile;
    this.toTile = toTile;
    this.x = map.xOf(fromTile);
    this.y = map.yOf(fromTile);
    const tx = map.xOf(toTile);
    const ty = map.yOf(toTile);
    this.total = Math.hypot(tx - this.x, ty - this.y) || 1;
    this.dx = (tx - this.x) / this.total;
    this.dy = (ty - this.y) / this.total;
    this.travelled = 0;
    this.done = false;
  }
}

export class Game {
  constructor(options) {
    const { preset, seed, playerName, playerColor, difficulty } = options;
    this.seed = seed >>> 0;
    this.rng = makeRng(this.seed ^ 0x9e3779b9);
    this.map = generateMap(preset.w, preset.h, this.seed);
    this.preset = preset;
    this.difficulty = DIFFICULTIES[difficulty] ? difficulty : DEFAULT_DIFFICULTY;

    this.owner = new Int16Array(this.map.size).fill(NEUTRAL);
    this.buildingAt = new Map();

    this.players = [];
    this.attacks = [];
    this.boats = [];
    this.missiles = [];
    this.effects = [];
    this.events = [];
    /** Active sea trade links, rebuilt periodically for income and display. */
    this.tradeRoutes = [];

    this.tickCount = 0;
    this.state = 'spawn'; // 'spawn' | 'playing' | 'over'
    this.winner = null;
    this.dirty = true;

    // Scratch buffers reused by the water pathfinder.
    this._prev = new Int32Array(this.map.size);
    this._dist = new Int32Array(this.map.size);
    this._stamp = new Int32Array(this.map.size);
    this._gen = 0;
    this._nb = new Int32Array(4);

    this.#createPlayers(preset.bots, playerName, playerColor);
    this.diplomacy = new Diplomacy(this);
    this.spawnCandidates = findSpawnPoints(this.map, this.players.length + 6, this.rng);
  }

  get human() {
    return this.players[0];
  }

  #createPlayers(botCount, playerName, playerColor) {
    const human = new Player(0, playerName || 'You', playerColor || PLAYER_COLORS[0], true);
    this.players.push(human);

    const tier = DIFFICULTIES[this.difficulty];
    const names = shuffle(this.rng, NATION_NAMES.slice());
    const colors = PLAYER_COLORS.filter((c) => c !== human.color);
    for (let i = 0; i < botCount; i++) {
      const bot = new Player(i + 1, names[i % names.length], colors[i % colors.length], false);
      bot.economyMultiplier = tier.economy;
      bot.ai = new AiController(bot, this.rng, tier);
      this.players.push(bot);
    }
  }

  // ------------------------------------------------------------- spawning ---

  /** Place the human at `tile`, scatter the bots, and start the match. */
  beginMatch(humanTile) {
    const used = [humanTile];
    this.#claimStart(this.human, humanTile);

    const pool = this.spawnCandidates.filter((t) => this.map.dist(t, humanTile) > 18);
    let cursor = 0;
    for (const p of this.players) {
      if (p.isHuman) continue;
      let tile = pool[cursor++];
      while (tile !== undefined && used.some((u) => this.map.dist(u, tile) < 14)) {
        tile = pool[cursor++];
      }
      if (tile === undefined) tile = this.#randomFreeLand();
      if (tile === undefined) {
        p.alive = false;
        continue;
      }
      used.push(tile);
      this.#claimStart(p, tile);
    }

    this.state = 'playing';
    this.log(`${this.human.name} has claimed a homeland. The expansion begins.`, this.human.color);
  }

  #randomFreeLand() {
    for (let attempt = 0; attempt < 4000; attempt++) {
      const i = Math.floor(this.rng() * this.map.size);
      if (this.map.isLand(i) && this.owner[i] === NEUTRAL) return i;
    }
    return undefined;
  }

  #claimStart(player, tile) {
    const r = 3;
    const cx = this.map.xOf(tile);
    const cy = this.map.yOf(tile);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (!this.map.inBounds(x, y)) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = this.map.idx(x, y);
        if (!this.map.isLand(i) || this.owner[i] !== NEUTRAL) continue;
        this.setOwner(i, player.id);
      }
    }
    player.troops = 220;
    player.workers = 140;
    player.gold = 150;
    this.#updateCentroid(player);
  }

  /** True if a tile is a legal place for the human to start. */
  canSpawnAt(tile) {
    return this.map.isLand(tile) && this.owner[tile] === NEUTRAL;
  }

  // ------------------------------------------------------------ ownership ---

  setOwner(tile, newOwnerId) {
    const old = this.owner[tile];
    if (old === newOwnerId) return;
    if (old >= 0) this.players[old].removeTile(tile);
    this.owner[tile] = newOwnerId;
    if (newOwnerId >= 0) this.players[newOwnerId].addTile(tile);

    const b = this.buildingAt.get(tile);
    if (b) {
      if (newOwnerId >= 0) this.#transferBuilding(b, newOwnerId);
      else this.#destroyBuilding(b);
    }
    this.dirty = true;
  }

  #transferBuilding(b, newOwnerId) {
    const from = this.players[b.ownerId];
    if (from) {
      from.buildings = from.buildings.filter((x) => x !== b);
      from.buildingCounts[b.key]--;
    }
    b.ownerId = newOwnerId;
    const to = this.players[newOwnerId];
    to.buildings.push(b);
    to.buildingCounts[b.key]++;
  }

  #destroyBuilding(b) {
    const owner = this.players[b.ownerId];
    if (owner) {
      owner.buildings = owner.buildings.filter((x) => x !== b);
      owner.buildingCounts[b.key]--;
    }
    this.buildingAt.delete(b.tile);
  }

  // --------------------------------------------------------------- combat ---

  /** Defensive multiplier granted to `ownerId` by their own defense posts. */
  defenseAt(tile, ownerId) {
    if (ownerId < 0) return 1;
    const owner = this.players[ownerId];
    if (!owner || owner.buildingCounts.defense === 0) return 1;
    let mult = 1;
    for (const b of owner.buildings) {
      if (b.key !== 'defense') continue;
      if (this.map.dist(b.tile, tile) <= BUILDINGS.defense.radius) {
        mult += BUILDINGS.defense.defenseBonus;
      }
    }
    return mult;
  }

  tileCost(tile, targetId) {
    const t = this.map.terrain[tile];
    const density = targetId >= 0 ? this.players[targetId].density : NEUTRAL_DENSITY;
    const base = density * DEFENDER_STRENGTH + TERRAIN_COST[t];
    return base * TERRAIN_DEFENSE[t] * this.defenseAt(tile, targetId);
  }

  /** Does `attacker` share a land border with `targetId`? */
  borders(attacker, targetId) {
    const nb = this._nb;
    const small = targetId >= 0 && this.players[targetId].tiles.size < attacker.tiles.size
      ? this.players[targetId].tiles
      : attacker.tiles;
    const lookingForAttacker = small !== attacker.tiles;
    for (const tile of small) {
      const n = this.map.neighbors(tile, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (this.map.terrain[j] === OCEAN) continue;
        if (this.owner[j] === (lookingForAttacker ? attacker.id : targetId)) return true;
      }
    }
    return false;
  }

  /**
   * Commit troops against `targetId` (NEUTRAL for unclaimed land).
   * Reinforces an existing attack on the same target instead of stacking.
   */
  launchAttack(attacker, targetId, troops) {
    if (!attacker.alive || targetId === attacker.id) return null;
    // Every attack in the game funnels through here, so the alliance check
    // only needs to exist once.
    if (targetId >= 0 && this.diplomacy.areAllied(attacker.id, targetId)) return null;
    const committed = attacker.withdrawTroops(troops);
    if (committed < ATTACK_MIN_TROOPS) {
      attacker.troops += committed;
      return null;
    }

    const existing = this.attacks.find(
      (a) => !a.done && a.attackerId === attacker.id && a.targetId === targetId
    );
    if (existing) {
      existing.troops += committed;
      existing.fails = 0;
      this.#seedFrontier(existing);
      return existing;
    }

    const attack = new Attack(attacker.id, targetId, committed);
    this.#seedFrontier(attack);
    if (attack.frontier.length === 0) {
      attacker.troops += committed;
      return null;
    }
    this.attacks.push(attack);
    return attack;
  }

  #seedFrontier(attack) {
    const attacker = this.players[attack.attackerId];
    const target = attack.targetId >= 0 ? this.players[attack.targetId] : null;
    const nb = this._nb;

    // Walk whichever side has fewer tiles -- the border is the same either way.
    if (target && target.tiles.size < attacker.tiles.size) {
      for (const tile of target.tiles) {
        const n = this.map.neighbors(tile, nb);
        for (let k = 0; k < n; k++) {
          if (this.owner[nb[k]] === attacker.id) {
            this.#pushFrontier(attack, tile);
            break;
          }
        }
      }
    } else {
      for (const tile of attacker.tiles) {
        const n = this.map.neighbors(tile, nb);
        for (let k = 0; k < n; k++) {
          const j = nb[k];
          if (this.map.terrain[j] === OCEAN) continue;
          if (this.owner[j] === attack.targetId) this.#pushFrontier(attack, j);
        }
      }
    }
  }

  #pushFrontier(attack, tile) {
    if (attack.inFrontier.has(tile)) return;
    attack.inFrontier.add(tile);
    attack.frontier.push(tile);
  }

  #processAttack(attack) {
    const attacker = this.players[attack.attackerId];
    if (!attacker.alive) {
      attack.done = true;
      return;
    }
    const defender = attack.targetId >= 0 ? this.players[attack.targetId] : null;
    if (defender && !defender.alive) {
      attack.done = true;
      return;
    }

    const budget = Math.min(
      ATTACK_MAX_TILES,
      Math.ceil(ATTACK_BASE_TILES + attack.troops * ATTACK_TILES_PER_TROOP)
    );

    let taken = 0;
    while (taken < budget && attack.frontier.length > 0) {
      const r = this.#pickFrontierTile(attack);
      const tile = attack.frontier[r];

      // Stale entry: the tile changed hands since it was queued.
      if (this.owner[tile] !== attack.targetId || this.map.terrain[tile] === OCEAN) {
        this.#removeFrontier(attack, r);
        continue;
      }

      const cost = this.tileCost(tile, attack.targetId);
      if (attack.troops < cost) {
        // Might just be an expensive mountain -- try elsewhere a few times.
        attack.fails++;
        if (attack.fails > 25) break;
        continue;
      }
      attack.fails = 0;

      attack.troops -= cost;
      if (defender) {
        defender.killTroops(defender.density * DEFENDER_LOSS);
      }
      this.setOwner(tile, attacker.id);
      this.#removeFrontier(attack, r);
      taken++;

      // The new tile opens up more of the target's border.
      const n = this.map.neighbors(tile, this._nb);
      for (let k = 0; k < n; k++) {
        const j = this._nb[k];
        if (this.map.terrain[j] === OCEAN) continue;
        if (this.owner[j] === attack.targetId) this.#pushFrontier(attack, j);
      }
    }

    if (attack.frontier.length === 0 || attack.troops < ATTACK_MIN_TROOPS || attack.fails > 25) {
      attacker.troops += attack.troops;
      attack.troops = 0;
      attack.done = true;
    }
  }

  /**
   * Chooses which frontier tile to take next. Samples a handful of random
   * candidates and prefers whichever is most enclosed by the attacker's own
   * territory -- that's what a stray unclaimed hole looks like once it's
   * boxed in, so this closes it immediately instead of leaving it to lose
   * the flat random draw indefinitely. It also produces a solid, rounded
   * front rather than a spiky one, since a tile with several owned neighbours
   * is by definition filling in a notch rather than reaching for a new one.
   *
   * Affordable candidates always outrank unaffordable ones, regardless of
   * enclosure: without that, one expensive-but-highly-enclosed tile (a lone
   * mountain, say) would keep winning the sample and starve out every
   * cheaper tile elsewhere on the frontier, tripping the fails-counter and
   * ending the attack early with plenty of easy land still unclaimed.
   */
  #pickFrontierTile(attack) {
    const frontier = attack.frontier;
    const nb = this._nb;
    const attempts = Math.min(FRONTIER_SAMPLE_SIZE, frontier.length);

    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < attempts; i++) {
      const idx = Math.floor(this.rng() * frontier.length);
      const tile = frontier[idx];
      // A stale entry can't be scored meaningfully; leave it for the caller's
      // existing cleanup rather than letting it win by default.
      if (this.owner[tile] !== attack.targetId || this.map.terrain[tile] === OCEAN) continue;

      const n = this.map.neighbors(tile, nb);
      let enclosed = 0;
      for (let k = 0; k < n; k++) {
        if (this.owner[nb[k]] === attack.attackerId) enclosed++;
      }
      const affordable = attack.troops >= this.tileCost(tile, attack.targetId);
      const score = (affordable ? 1000 : 0) + enclosed;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    }

    return bestIndex === -1 ? Math.floor(this.rng() * frontier.length) : bestIndex;
  }

  #removeFrontier(attack, index) {
    const tile = attack.frontier[index];
    attack.inFrontier.delete(tile);
    const last = attack.frontier.pop();
    if (index < attack.frontier.length) attack.frontier[index] = last;
  }

  cancelAttacks(player) {
    let refunded = 0;
    for (const a of this.attacks) {
      if (a.done || a.attackerId !== player.id) continue;
      refunded += a.troops * RETREAT_REFUND;
      a.troops = 0;
      a.done = true;
    }
    player.troops += refunded;
    return refunded;
  }

  attacksBy(playerId) {
    return this.attacks.filter((a) => !a.done && a.attackerId === playerId);
  }

  /** Stand down any fighting between two nations, e.g. when they sign a pact. */
  cancelAttacksBetween(a, b) {
    for (const atk of this.attacks) {
      if (atk.done) continue;
      const between =
        (atk.attackerId === a && atk.targetId === b) ||
        (atk.attackerId === b && atk.targetId === a);
      if (!between) continue;
      this.players[atk.attackerId].troops += atk.troops * RETREAT_REFUND;
      atk.troops = 0;
      atk.done = true;
    }
  }

  isAtWar(a, b) {
    return this.attacks.some(
      (atk) =>
        !atk.done &&
        ((atk.attackerId === a && atk.targetId === b) ||
          (atk.attackerId === b && atk.targetId === a))
    );
  }

  // ---------------------------------------------------------------- trade ---

  /**
   * Rebuild the sea trade graph. Ports of different nations trade when they sit
   * on the same body of water and are not actively fighting; allies trade at a
   * premium. Each port only earns from a limited number of partners, so the
   * payoff is from trading widely rather than stacking ports in one harbour.
   */
  refreshTrade() {
    const ports = [];
    for (const p of this.players) {
      if (!p.alive) continue;
      p.tradeIncome = 0;
      for (const b of p.buildings) {
        if (b.key === 'port') ports.push({ tile: b.tile, owner: p, sea: this.map.seaOf(b.tile) });
      }
    }

    this.tradeRoutes = [];
    const used = new Array(ports.length).fill(0);

    for (let i = 0; i < ports.length; i++) {
      if (used[i] >= TRADE_MAX_PARTNERS_PER_PORT) continue;
      for (let j = i + 1; j < ports.length; j++) {
        if (used[i] >= TRADE_MAX_PARTNERS_PER_PORT) break;
        if (used[j] >= TRADE_MAX_PARTNERS_PER_PORT) continue;

        const a = ports[i];
        const b = ports[j];
        if (a.owner.id === b.owner.id) continue;
        if (a.sea < 0 || a.sea !== b.sea) continue;
        if (this.isAtWar(a.owner.id, b.owner.id)) continue;

        const allied = this.diplomacy.areAllied(a.owner.id, b.owner.id);
        const gold = TRADE_GOLD_PER_PARTNER * (allied ? TRADE_ALLY_BONUS : 1);
        a.owner.tradeIncome += gold;
        b.owner.tradeIncome += gold;
        used[i]++;
        used[j]++;
        this.tradeRoutes.push({ a: a.tile, b: b.tile, allied });
      }
    }
  }

  // ---------------------------------------------------------------- boats ---

  boatRange(player) {
    return player.buildingCounts.port > 0 ? BOAT_RANGE_WITH_PORT : BOAT_RANGE;
  }

  /**
   * BFS over water from the shore beside `targetTile` back to the attacker's
   * own coast. Returns the tile path in travel order, or null if out of range.
   */
  findWaterPath(player, targetTile) {
    const map = this.map;
    const range = this.boatRange(player);
    this._gen++;
    const gen = this._gen;
    const stamp = this._stamp;
    const prev = this._prev;
    const dist = this._dist;
    const nb = this._nb;

    const queue = new Int32Array(map.size);
    let head = 0;
    let tail = 0;

    const n0 = map.neighbors(targetTile, nb);
    for (let k = 0; k < n0; k++) {
      const j = nb[k];
      if (map.terrain[j] !== OCEAN || stamp[j] === gen) continue;
      stamp[j] = gen;
      prev[j] = -1;
      dist[j] = 0;
      queue[tail++] = j;
    }

    while (head < tail) {
      const cur = queue[head++];
      if (dist[cur] > range) break;

      // Reached water touching our own shore?
      const n = map.neighbors(cur, nb);
      for (let k = 0; k < n; k++) {
        if (this.owner[nb[k]] === player.id) {
          const path = [];
          let node = cur;
          while (node !== -1) {
            path.push(node);
            node = prev[node];
          }
          return path; // already ordered attacker-shore -> target-shore
        }
      }

      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (map.terrain[j] !== OCEAN || stamp[j] === gen) continue;
        stamp[j] = gen;
        prev[j] = cur;
        dist[j] = dist[cur] + 1;
        queue[tail++] = j;
      }
    }
    return null;
  }

  launchBoat(player, targetTile, troops) {
    if (!this.map.isLand(targetTile) || this.owner[targetTile] === player.id) {
      return { ok: false, reason: 'Pick enemy or unclaimed land across the water.' };
    }
    if (player.troops < BOAT_MIN_TROOPS) {
      return { ok: false, reason: 'Not enough troops to crew a landing force.' };
    }
    const path = this.findWaterPath(player, targetTile);
    if (!path) {
      return {
        ok: false,
        reason: player.buildingCounts.port > 0 ? 'Target is out of naval range.' : 'Out of range — build a Port to sail further.',
      };
    }
    const committed = player.withdrawTroops(Math.max(BOAT_MIN_TROOPS, troops));
    this.boats.push(new Boat(player.id, committed, path, targetTile));
    return { ok: true };
  }

  #processBoat(boat) {
    const player = this.players[boat.ownerId];
    if (!player.alive) {
      boat.done = true;
      return;
    }
    boat.progress += BOAT_SPEED;
    if (boat.progress < boat.path.length - 1) return;

    // Landfall.
    boat.done = true;
    const tile = boat.targetTile;
    const defenderId = this.owner[tile];
    const cost = this.tileCost(tile, defenderId);

    if (boat.troops <= cost) {
      // The landing is thrown back into the sea.
      if (defenderId >= 0) this.players[defenderId].killTroops(boat.troops * 0.4);
      this.pushEffect('splash', this.map.xOf(tile), this.map.yOf(tile), 6);
      if (player.isHuman) this.log('Naval landing was repelled.', '#ff8080');
      return;
    }

    if (defenderId >= 0) this.players[defenderId].killTroops(this.players[defenderId].density * DEFENDER_LOSS);
    this.setOwner(tile, player.id);
    this.pushEffect('landing', this.map.xOf(tile), this.map.yOf(tile), 8);

    const remaining = boat.troops - cost;
    player.troops += remaining;
    this.launchAttack(player, defenderId, remaining);
    if (player.isHuman) this.log('Landing force has established a beachhead.', player.color);
  }

  // -------------------------------------------------------------- missiles ---

  canNuke(player) {
    return player.buildingCounts.silo > 0;
  }

  launchNuke(player, targetTile) {
    if (!this.canNuke(player)) return { ok: false, reason: 'You need a Missile Silo first.' };
    if (player.gold < NUKE_COST) return { ok: false, reason: 'Not enough gold for a warhead.' };
    const silo = player.buildings.find((b) => b.key === 'silo');
    if (!silo) return { ok: false, reason: 'You need a Missile Silo first.' };

    player.gold -= NUKE_COST;
    this.missiles.push(new Missile(player.id, silo.tile, targetTile, this.map));
    this.log(`${player.name} launched a missile.`, player.color);
    return { ok: true };
  }

  #processMissile(m) {
    m.travelled += MISSILE_SPEED;
    m.x += m.dx * MISSILE_SPEED;
    m.y += m.dy * MISSILE_SPEED;

    // Interception: any rival SAM covering the missile's current position.
    for (const p of this.players) {
      if (!p.alive || p.id === m.ownerId || p.buildingCounts.sam === 0) continue;
      for (const b of p.buildings) {
        if (b.key !== 'sam' || b.cooldown > 0) continue;
        const d = Math.hypot(this.map.xOf(b.tile) - m.x, this.map.yOf(b.tile) - m.y);
        if (d > BUILDINGS.sam.radius) continue;
        b.cooldown = BUILDINGS.sam.cooldown;
        if (this.rng() < SAM_ACCURACY) {
          m.done = true;
          this.pushEffect('intercept', m.x, m.y, 7);
          this.log(`${p.name} intercepted an incoming missile.`, p.color);
          return;
        }
      }
    }

    if (m.travelled >= m.total) {
      m.done = true;
      this.#detonate(m);
    }
  }

  #detonate(m) {
    const map = this.map;
    const cx = map.xOf(m.toTile);
    const cy = map.yOf(m.toTile);
    const r = NUKE_RADIUS;
    const lossByPlayer = new Map();

    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (!map.inBounds(x, y)) continue;
        const dd = (x - cx) ** 2 + (y - cy) ** 2;
        if (dd > r * r) continue;
        const i = map.idx(x, y);

        // Scorch the ground permanently -- fallout is visible for the rest of the match.
        const falloff = 1 - Math.sqrt(dd) / r;
        const ash = 0.35 + 0.4 * falloff;
        map.baseColor[i * 3] = map.baseColor[i * 3] * (1 - ash) + 74 * ash;
        map.baseColor[i * 3 + 1] = map.baseColor[i * 3 + 1] * (1 - ash) + 66 * ash;
        map.baseColor[i * 3 + 2] = map.baseColor[i * 3 + 2] * (1 - ash) + 58 * ash;

        if (map.terrain[i] === OCEAN) continue;
        const o = this.owner[i];
        if (o >= 0) {
          lossByPlayer.set(o, (lossByPlayer.get(o) || 0) + 1);
          this.setOwner(i, NEUTRAL);
        }
        const b = this.buildingAt.get(i);
        if (b) this.#destroyBuilding(b);
      }
    }

    for (const [pid, tiles] of lossByPlayer) {
      const p = this.players[pid];
      p.killTroops(p.density * tiles * 1.4);
    }

    this.pushEffect('nuke', cx, cy, NUKE_RADIUS);
    this.dirty = true;
    const victim = [...lossByPlayer.entries()].sort((a, b) => b[1] - a[1])[0];
    if (victim) {
      this.log(`Nuclear strike devastated ${this.players[victim[0]].name}.`, '#ffb648');
    }
  }

  // ------------------------------------------------------------ buildings ---

  buildingPlacementError(player, key, tile) {
    const def = BUILDINGS[key];
    if (!def) return 'Unknown structure.';
    if (this.owner[tile] !== player.id) return 'You can only build on your own land.';
    if (this.map.terrain[tile] === OCEAN) return 'Cannot build at sea.';
    if (this.buildingAt.has(tile)) return 'Something is already built here.';
    if (def.coastal && !this.map.coastal[tile]) return 'A Port must sit on the coast.';
    if (player.gold < buildingCost(def, player.countOf(key))) return 'Not enough gold.';
    for (const b of player.buildings) {
      if (b.key === key && this.map.dist(b.tile, tile) < def.spacing) {
        return `Too close to another ${def.name}.`;
      }
    }
    return null;
  }

  build(player, key, tile) {
    const error = this.buildingPlacementError(player, key, tile);
    if (error) return { ok: false, reason: error };

    const def = BUILDINGS[key];
    player.gold -= buildingCost(def, player.countOf(key));
    const b = { key, tile, ownerId: player.id, cooldown: 0 };
    player.buildings.push(b);
    player.buildingCounts[key]++;
    this.buildingAt.set(tile, b);
    this.dirty = true;
    return { ok: true, building: b };
  }

  costFor(player, key) {
    return buildingCost(BUILDINGS[key], player.countOf(key));
  }

  // ------------------------------------------------------------- lifecycle --

  pushEffect(type, x, y, radius) {
    this.effects.push({ type, x, y, radius, t: 0, life: type === 'nuke' ? 28 : 14 });
  }

  log(text, color = '#cfd8e3') {
    this.events.unshift({ text, color, tick: this.tickCount });
    if (this.events.length > 40) this.events.pop();
  }

  tick() {
    if (this.state !== 'playing') return;
    this.tickCount++;

    for (const p of this.players) {
      if (p.alive) p.updateEconomy();
      for (const b of p.buildings) if (b.cooldown > 0) b.cooldown--;
    }

    for (const a of this.attacks) if (!a.done) this.#processAttack(a);
    if (this.attacks.length > 0 && this.tickCount % 5 === 0) {
      this.attacks = this.attacks.filter((a) => !a.done);
    }

    for (const b of this.boats) if (!b.done) this.#processBoat(b);
    if (this.boats.length > 0) this.boats = this.boats.filter((b) => !b.done);

    for (const m of this.missiles) if (!m.done) this.#processMissile(m);
    if (this.missiles.length > 0) this.missiles = this.missiles.filter((m) => !m.done);

    for (const e of this.effects) e.t++;
    if (this.effects.length > 0) this.effects = this.effects.filter((e) => e.t < e.life);

    this.diplomacy.tick();
    if (this.tickCount % TRADE_REFRESH_TICKS === 0) this.refreshTrade();

    // AI thinks on a stagger so all bots do not act on the same tick.
    for (const p of this.players) {
      if (p.alive && p.ai) p.ai.update(this);
    }

    if (this.tickCount % 10 === 0) {
      this.#checkEliminations();
      this.#checkVictory();
      for (const p of this.players) if (p.alive) this.#updateCentroid(p);
    }
  }

  #checkEliminations() {
    for (const p of this.players) {
      if (!p.alive || p.tiles.size > 0) continue;
      if (this.boats.some((b) => b.ownerId === p.id && !b.done)) continue;
      if (this.attacks.some((a) => a.attackerId === p.id && !a.done)) continue;
      p.alive = false;
      p.troops = 0;
      p.workers = 0;
      this.log(`${p.name} has been wiped off the map.`, p.color);
      if (p.isHuman) this.#endMatch(null);
    }
  }

  #checkVictory() {
    const alive = this.players.filter((p) => p.alive);
    if (alive.length === 1) {
      this.#endMatch(alive[0]);
      return;
    }
    for (const p of alive) {
      if (p.tiles.size / this.map.landCount >= VICTORY_LAND_SHARE) {
        this.#endMatch(p);
        return;
      }
    }
  }

  #endMatch(winner) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.winner = winner;
  }

  #updateCentroid(player) {
    if (player.tiles.size === 0) return;
    let sx = 0;
    let sy = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    // Sampling keeps this cheap for very large nations.
    const stride = Math.max(1, Math.floor(player.tiles.size / 600));
    let n = 0;
    let k = 0;
    for (const tile of player.tiles) {
      if (k++ % stride !== 0) continue;
      const x = this.map.xOf(tile);
      sx += x;
      sy += this.map.yOf(tile);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      n++;
    }
    if (n === 0) return;
    player.centroid.x = sx / n;
    player.centroid.y = sy / n;
    player.labelScale = Math.max(1, (maxX - minX) / 6);
  }

  /** Players ordered for the leaderboard. */
  standings() {
    return this.players
      .filter((p) => p.alive)
      .sort((a, b) => b.tiles.size - a.tiles.size);
  }

  landShare(player) {
    return this.map.landCount > 0 ? player.tiles.size / this.map.landCount : 0;
  }

  elapsedSeconds() {
    return this.tickCount / TICKS_PER_SECOND;
  }
}
