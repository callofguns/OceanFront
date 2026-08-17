// Bot nations. Each bot re-evaluates every few seconds: grow the economy,
// then decide whether to expand into open land or invade a neighbour.

import { NUKE_COST, OCEAN, NEUTRAL_DENSITY, BOAT_MIN_TROOPS } from './config.js';

const THINK_MIN = 18; // ticks
const THINK_MAX = 34;

export class AiController {
  /** `tier` is a DIFFICULTIES entry from config.js (defaults to a neutral
   *  1x multiplier so a bot can still be constructed without one, e.g. in
   *  older test helpers). */
  constructor(player, rng, tier = { aggression: 1 }) {
    this.player = player;
    this.rng = rng;
    // Personality, so bots do not all play identically -- scaled by
    // difficulty, so harder bots lean further toward attacking sooner and
    // more often, not just having a bigger economy behind them.
    this.aggression = (0.5 + rng() * 0.9) * tier.aggression;
    this.greed = (0.6 + rng() * 0.8) * tier.aggression;
    this.expansionism = (0.7 + rng() * 0.8) * tier.aggression;
    this.cooldown = Math.floor(rng() * THINK_MAX);
    this.lastBorderScan = null;
  }

  update(game) {
    if (--this.cooldown > 0) return;
    this.cooldown = THINK_MIN + Math.floor(this.rng() * (THINK_MAX - THINK_MIN));

    const p = this.player;
    if (p.tiles.size === 0) return;

    const border = this.#scanBorders(game);
    this.#setPosture(border);
    this.#doDiplomacy(game, border);
    this.#spendGold(game, border);
    this.#useMissiles(game);
    this.#makeWar(game, border);
  }

  /** Answer standing offers, look for a pact, and occasionally stab a friend. */
  #doDiplomacy(game, border) {
    const p = this.player;
    const dip = game.diplomacy;

    for (const offer of dip.offersTo(p.id)) {
      if (dip.aiWouldAccept(p.id, offer.from, this.rng)) dip.accept(offer);
      else dip.decline(offer);
    }

    // A nation with no open land and none but allies on its borders has
    // nowhere left to grow. Without this valve a web of pacts freezes the
    // whole map into a permanent stalemate, so somebody has to break faith.
    const neighbours = [...border.contact.keys()];
    const boxedIn =
      border.neutral === 0 && neighbours.length > 0 && neighbours.every((id) => p.allies.has(id));

    if (p.allies.size > 0 && (boxedIn ? this.rng() < 0.5 : this.rng() < 0.05 * this.aggression)) {
      let victim = null;
      for (const allyId of p.allies) {
        const ally = game.players[allyId];
        if (!ally?.alive || !dip.canBreak(p.id, allyId)) continue;
        if (!border.contact.has(allyId)) continue;
        // Normally we only turn on someone we can clearly beat; when boxed in,
        // the weakest neighbour will have to do.
        const beatable = ally.tiles.size < p.tiles.size * 0.6 && p.density > ally.density * 1.3;
        if (!boxedIn && !beatable) continue;
        if (!victim || ally.tiles.size < victim.tiles.size) victim = ally;
      }
      if (victim) {
        dip.breakAlliance(p.id, victim.id);
        return;
      }
    }

    // Seek a pact with a bordering rival, preferring whoever we cannot beat.
    if (p.allies.size >= 2 || this.rng() > 0.3) return;
    const candidates = [...border.contact.keys()].filter(
      (id) => !p.allies.has(id) && dip.canPropose(p.id, id)
    );
    if (candidates.length === 0) return;

    candidates.sort((a, b) => game.players[b].tiles.size - game.players[a].tiles.size);
    const target = candidates[0];
    // No point courting someone we could simply take.
    if (game.players[target].tiles.size < p.tiles.size * 0.5) return;
    dip.propose(p.id, target);
  }

  /**
   * Single pass over owned tiles collecting who we touch, how much open land
   * is reachable, and a reservoir sample of tiles for building placement.
   */
  #scanBorders(game) {
    const p = this.player;
    const nb = new Int32Array(4);
    const contact = new Map(); // ownerId -> border tile count
    let neutral = 0;
    let coastal = 0;

    const sample = [];
    const borderSample = [];
    const coastSample = [];
    const SAMPLE = 24;
    let seen = 0;

    for (const tile of p.tiles) {
      seen++;
      // Reservoir sample of interior tiles.
      if (sample.length < SAMPLE) sample.push(tile);
      else {
        const r = Math.floor(this.rng() * seen);
        if (r < SAMPLE) sample[r] = tile;
      }

      if (game.map.coastal[tile]) {
        coastal++;
        if (coastSample.length < SAMPLE) coastSample.push(tile);
      }

      const n = game.map.neighbors(tile, nb);
      let isBorder = false;
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (game.map.terrain[j] === OCEAN) continue;
        const o = game.owner[j];
        if (o === p.id) continue;
        isBorder = true;
        if (o < 0) neutral++;
        else contact.set(o, (contact.get(o) || 0) + 1);
      }
      if (isBorder && borderSample.length < SAMPLE) borderSample.push(tile);
    }

    return { contact, neutral, coastal, sample, borderSample, coastSample };
  }

  /** Shift the troops/workers slider based on how dangerous the map looks. */
  #setPosture(border) {
    const p = this.player;
    const threatened = border.contact.size > 0;
    const target = threatened ? 0.55 + 0.15 * this.aggression : 0.42;
    // Same 25-75% bound the player's own slider is limited to (see the
    // #troop-ratio input in index.html) -- bots play by the same rule
    // rather than being able to out-militarize what the player is allowed.
    p.troopRatio = Math.max(0.25, Math.min(0.75, target));
  }

  #spendGold(game, border) {
    const p = this.player;
    if (border.sample.length === 0) return;

    // Strategic hardware is checked before cities. Cities are always cheaper,
    // so testing them first would drain the treasury every cycle and a bot
    // would never save enough to reach the late game.
    const major = p.tiles.size > 600;
    if (major && p.countOf('silo') < 1 && p.gold >= game.costFor(p, 'silo')) {
      if (this.#tryBuild(game, 'silo', border.sample)) return;
    }
    if (major && p.countOf('sam') < 2 && p.gold >= game.costFor(p, 'sam') * 1.2) {
      if (this.#tryBuild(game, 'sam', border.sample)) return;
    }

    if (border.coastal > 0 && p.countOf('port') < 4 && p.gold >= game.costFor(p, 'port') * 1.2) {
      if (this.#tryBuild(game, 'port', border.coastSample)) return;
    }

    if (border.contact.size > 0 && p.gold >= game.costFor(p, 'defense') * 1.6) {
      if (this.#tryBuild(game, 'defense', border.borderSample)) return;
    }

    if (p.gold >= game.costFor(p, 'city') * (1.0 + (1 - this.greed) * 0.5)) {
      if (this.#tryBuild(game, 'city', border.sample)) return;
    }
  }

  #tryBuild(game, key, candidates) {
    for (const tile of candidates) {
      if (!game.buildingPlacementError(this.player, key, tile)) {
        game.build(this.player, key, tile);
        return true;
      }
    }
    return false;
  }

  #useMissiles(game) {
    const p = this.player;
    if (p.countOf('silo') === 0) return;
    if (p.gold < NUKE_COST * (1.6 + this.greed)) return;
    if (this.rng() > 0.35) return;

    // Aim at the strongest rival we can see.
    const rivals = game.players.filter((q) => q.alive && q.id !== p.id && q.tiles.size > 400);
    if (rivals.length === 0) return;
    rivals.sort((a, b) => b.tiles.size - a.tiles.size);
    const target = rivals[0];
    if (target.tiles.size < p.tiles.size * 0.6) return;

    // Prefer a tile near their centre of mass.
    let best = null;
    let bestD = Infinity;
    let seen = 0;
    for (const tile of target.tiles) {
      if (seen++ % 37 !== 0) continue;
      const d = Math.hypot(
        game.map.xOf(tile) - target.centroid.x,
        game.map.yOf(tile) - target.centroid.y
      );
      if (d < bestD) {
        bestD = d;
        best = tile;
      }
    }
    if (best !== null) game.launchNuke(p, best);
  }

  #makeWar(game, border) {
    const p = this.player;
    if (game.attacksBy(p.id).length > 0) return;

    // Wait until the army is worth committing.
    const readiness = p.troops / Math.max(1, p.maxPop * p.troopRatio);
    if (readiness < 0.45) return;

    const myDensity = p.density;
    let bestTarget = null;
    let bestScore = 0;

    if (border.neutral > 0) {
      // Open land is cheap; value it against how much of it we can reach.
      const affordable = p.troops / (NEUTRAL_DENSITY * 2 + 1);
      bestScore = Math.min(border.neutral, affordable) * 0.9 * this.expansionism;
      bestTarget = -1;
    }

    const leader = game.standings()[0];
    for (const [rivalId, contactTiles] of border.contact) {
      const rival = game.players[rivalId];
      if (!rival.alive) continue;
      if (p.allies.has(rivalId)) continue; // bound by treaty

      const theirDensity = rival.density;
      const ratio = (myDensity + 1) / (theirDensity + 1);
      if (ratio < 0.75) continue; // too well defended to be worth it

      let score = Math.min(contactTiles, p.troops / (theirDensity * 2 + 1)) * ratio * this.aggression;
      // Gang up on the runaway leader; go easy on the nearly-dead.
      if (leader && rival.id === leader.id && rival.id !== p.id) score *= 1.5;
      if (rival.tiles.size < p.tiles.size * 0.25) score *= 1.3;
      if (rival.isHuman) score *= 1.1;

      if (score > bestScore) {
        bestScore = score;
        bestTarget = rivalId;
      }
    }

    if (bestTarget === null) {
      this.#tryNavalInvasion(game, border);
      return;
    }

    const commit = bestTarget === -1 ? 0.55 : 0.4 + 0.35 * this.aggression;
    game.launchAttack(p, bestTarget, p.troops * commit);
  }

  /** Landlocked bots with nothing to fight look for an island to raid. */
  #tryNavalInvasion(game, border) {
    const p = this.player;
    if (border.coastal === 0 || p.troops < BOAT_MIN_TROOPS * 6) return;
    if (this.rng() > 0.4) return;

    for (let attempt = 0; attempt < 8; attempt++) {
      const tile = Math.floor(this.rng() * game.map.size);
      if (!game.map.isLand(tile)) continue;
      if (game.owner[tile] === p.id) continue;
      if (game.map.dist(tile, game.map.idx(Math.round(p.centroid.x), Math.round(p.centroid.y))) > game.boatRange(p)) {
        continue;
      }
      const res = game.launchBoat(p, tile, p.troops * 0.45);
      if (res.ok) return;
    }
  }
}
