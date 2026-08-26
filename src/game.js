// The simulation. Owns the map, the players and every in-flight action.
// Ticks at a fixed rate (see TICKS_PER_SECOND); rendering is decoupled.

import {
  OCEAN,
  TERRAIN_MAG,
  TERRAIN_SPEED,
  MAG_REFERENCE,
  DEFENDER_LOSS,
  COMBAT_RATIO_FLOOR,
  COMBAT_RATIO_CEIL,
  PACE_RATIO_FLOOR,
  PACE_RATIO_CEIL,
  TRAITOR_DEFENSE_DEBUFF,
  TRAITOR_SPEED_DEBUFF,
  DEFENSE_DEBUFF_MIDPOINT_SHARE,
  DEFENSE_DEBUFF_DECAY,
  LARGE_ATTACKER_SHARE,
  ATTACK_BUDGET_RATIO_SCALE,
  ATTACK_BUDGET_FLOOR,
  ATTACK_BUDGET_CEIL,
  ATTACK_BUDGET_PER_BORDER,
  NEUTRAL_BUDGET_PER_BORDER,
  NEUTRAL_PACE_SCALE,
  NEUTRAL_PACE_FLOOR,
  NEUTRAL_PACE_CEIL,
  sigmoid,
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
  ENCLOSURE_SCAN_TICKS,
  ENCLOSED_MAX_TILES,
  ANNEX_GOLD_SHARE,
  CONQUEST_GOLD_SHARE,
  TRAITOR_DISTRUST_LIMIT,
  SPAWN_TROOPS,
  SPAWN_GOLD,
  TRIBE_TROOPS_CAP_MULTIPLIER,
  TRIBE_TROOPS_MULTIPLIER,
  TRIBE_GOLD_MULTIPLIER,
  TRIBE_COLORS,
  TRIBE_DEFENSE_DISCOUNT,
  SPAWN_POOL_OVERSHOOT,
  SPAWN_POOL_MARGIN,
  TEAM_MODES,
  DEFAULT_TEAM_MODE,
  TEAM_SPAWN_RADIUS,
} from './config.js';
import { generateMap, buildAuthoredMap, findSpawnPoints } from './map.js';
import { makeRng, shuffle } from './rng.js';
import { Player } from './player.js';
import { NATION_NAMES, tribeNames } from './names.js';
import { AiController } from './ai.js';
import { TribeController } from './tribe.js';
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
    const { preset, seed, playerName, playerColor, difficulty, teamMode } = options;
    this.seed = seed >>> 0;
    this.rng = makeRng(this.seed ^ 0x9e3779b9);
    // A preset carrying `authored` plays a hand-drawn map (src/maps/) at a
    // fixed size; the seed still drives spawns and the AI, it just never
    // touches the terrain. Everything downstream sees the same GameMap
    // either way.
    this.map = preset.authored
      ? buildAuthoredMap(preset.authored, this.seed)
      : generateMap(preset.w, preset.h, this.seed);
    this.preset = preset;
    this.difficulty = DIFFICULTIES[difficulty] ? difficulty : DEFAULT_DIFFICULTY;
    this.teamMode = TEAM_MODES[teamMode] ? teamMode : DEFAULT_TEAM_MODE;
    this.teamSize = TEAM_MODES[this.teamMode].teamSize;

    this.owner = new Int16Array(this.map.size).fill(NEUTRAL);
    this.buildingAt = new Map();

    this.players = [];
    this.attacks = [];
    this.boats = [];
    this.missiles = [];
    this.effects = [];
    this.events = [];
    /** Presentation hook for "something happened" -- set by sound.js via
     *  SoundBoard#bind(), left null otherwise. Mirrors the log()/
     *  pushEffect() pattern: Game only ever emits facts through signal(),
     *  never decides what is worth a sound. Every headless test and
     *  tools/simulate.js import this module undecorated, so this must stay
     *  a plain nullable field, never something that changes behavior. */
    this.onEvent = null;
    /** Active sea trade links, rebuilt periodically for income and display. */
    this.tradeRoutes = [];

    this.tickCount = 0;
    this.state = 'spawn'; // 'spawn' | 'playing' | 'over'
    this.winner = null;
    /** Which team crossed the win condition, set alongside `winner` by
     *  #endMatch. In a solo match this is inert -- see #endMatch. */
    this.winningTeamId = null;
    this.dirty = true;

    // Scratch buffers reused by the water pathfinder.
    this._prev = new Int32Array(this.map.size);
    this._dist = new Int32Array(this.map.size);
    this._stamp = new Int32Array(this.map.size);
    this._gen = 0;
    this._nb = new Int32Array(4);

    // Bumped by every ownership change, so the encirclement scan can skip
    // entirely when the map has not moved since it last ran. Kept separate
    // from `dirty`, which the renderer clears on its own schedule.
    this._territoryVersion = 0;
    this._enclosureScanAt = -1;
    this._floodQueue = new Int32Array(this.map.size);

    this.#createPlayers(preset, playerName, playerColor);
    this.#assignTeams();
    this.diplomacy = new Diplomacy(this);
    this.spawnCandidates = findSpawnPoints(
      this.map,
      Math.ceil(this.players.length * SPAWN_POOL_OVERSHOOT) + SPAWN_POOL_MARGIN,
      this.rng
    );
  }

  get human() {
    return this.players[0];
  }

  #createPlayers(preset, playerName, playerColor) {
    const human = new Player(0, playerName || 'You', playerColor || PLAYER_COLORS[0], true);
    this.players.push(human);
    this.#createNations(preset.bots, human);
    this.#createTribes(preset.tribes, human);
  }

  #createNations(count, human) {
    const tier = DIFFICULTIES[this.difficulty];
    const names = shuffle(this.rng, NATION_NAMES.slice());
    const colors = PLAYER_COLORS.filter((c) => c !== human.color);
    for (let i = 0; i < count; i++) {
      const bot = new Player(this.players.length, names[i % names.length], colors[i % colors.length], false);
      bot.troopsCapMultiplier = tier.troopsCapMultiplier;
      bot.troopsMultiplier = tier.troopsMultiplier;
      bot.goldMultiplier = tier.goldMultiplier;
      bot.ai = new AiController(bot, this.rng, tier);
      this.players.push(bot);
    }
  }

  /** Tribes read nothing from DIFFICULTIES -- see the tribes block in
   *  config.js. The match's difficulty setting scales nations only. */
  #createTribes(count, human) {
    const names = tribeNames(this.rng, count);
    const colors = TRIBE_COLORS.filter((c) => c !== human.color);
    for (let i = 0; i < count; i++) {
      const tribe = new Player(this.players.length, names[i], colors[i % colors.length], false);
      tribe.isTribe = true;
      tribe.troopsCapMultiplier = TRIBE_TROOPS_CAP_MULTIPLIER;
      tribe.troopsMultiplier = TRIBE_TROOPS_MULTIPLIER;
      tribe.goldMultiplier = TRIBE_GOLD_MULTIPLIER;
      tribe.ai = new TribeController(tribe, this.rng);
      this.players.push(tribe);
    }
  }

  /**
   * Fixed team affiliation for every nation, decided once here and never
   * touched again -- teams cannot be joined, left or betrayed. Tribes are
   * never on a team at any size (teamId stays null, which is what
   * Game#isFriendly and the renderer's teamKeyOf key off to make sure two
   * different tribes are never friendly with each other).
   *
   * The solo branch is load-bearing: it must consume ZERO draws from
   * this.rng, so a solo match's spawn points, nation names and every AI
   * roll land on exactly the numbers they did before teams existed.
   * Verified by a pacing-sweep diff against a pre-feature baseline (see
   * HANDOFF.md). Do not add an rng draw to it, and do not "simplify" it
   * into the shuffled path below -- they look similar but the shuffled
   * path is not free.
   */
  #assignTeams() {
    const ids = [];
    for (const p of this.players) {
      if (p.isTribe) {
        p.teamId = null;
        continue;
      }
      if (this.teamSize <= 1) {
        p.teamId = p.id;
        continue;
      }
      ids.push(p.id);
    }
    if (this.teamSize <= 1) {
      this.teams = this.players.filter((p) => !p.isTribe).map((p) => [p.id]);
      return;
    }

    // Round to the nearest whole number of teams rather than flooring, then
    // deal round-robin over a shuffled order. preset.bots is always even,
    // so the nation count is always odd and some rounding is unavoidable --
    // the merge pass below is what keeps that from producing a team of one.
    const numTeams = Math.max(1, Math.round(ids.length / this.teamSize));
    shuffle(this.rng, ids); // the SEEDED rng -- never Math.random(), or
                            // Restart Match would reshuffle the teams
    const members = Array.from({ length: numTeams }, () => []);
    ids.forEach((id, index) => members[index % numTeams].push(id));

    // Rounding can leave one team short (9 nations in duos rounds to 5
    // teams: [2,2,2,2,1]). Fold any one-member team into the smallest
    // other team -- a "team" of one would silently play as a solo nation
    // inside a team match, which is the one outcome this mode must not
    // produce.
    for (;;) {
      const lonely = members.findIndex((m) => m.length === 1);
      if (lonely === -1) break;
      let host = -1;
      for (let t = 0; t < members.length; t++) {
        if (t === lonely || members[t].length === 0) continue;
        if (host === -1 || members[t].length < members[host].length) host = t;
      }
      if (host === -1) break; // only one team exists at all -- nothing to merge into
      members[host].push(...members[lonely]);
      members[lonely] = [];
    }

    // Compact away the emptied slots so team ids stay 0..n-1 and contiguous
    // -- the leaderboard indicator labels teams A, B, C off this index.
    this.teams = members.filter((m) => m.length > 0);
    this.teams.forEach((m, teamId) => {
      for (const id of m) this.players[id].teamId = teamId;
    });
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
    player.troops = SPAWN_TROOPS;
    player.gold = SPAWN_GOLD;
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
    if (old >= 0) {
      this.players[old].removeTile(tile);
      // Remember who is taking our land, so the treasury has somewhere to go
      // if this turns out to be the last tile. Land lost to a nuke goes to
      // NEUTRAL and clears this instead -- nobody profits from fallout.
      this.players[old].lastConquerorId = newOwnerId;
    }
    this.owner[tile] = newOwnerId;
    if (newOwnerId >= 0) this.players[newOwnerId].addTile(tile);
    this._territoryVersion++;

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

  /** Whether `ownerId` has a defense post within range of `tile` --
   *  OpenFrontIO's own mechanic: a single flat bonus if any post is in
   *  range, not a stacking one, so this stops at the first hit. */
  hasDefensePostInRange(tile, ownerId) {
    if (ownerId < 0) return false;
    const owner = this.players[ownerId];
    if (!owner || owner.buildingCounts.defense === 0) return false;
    for (const b of owner.buildings) {
      if (b.key !== 'defense') continue;
      if (this.map.dist(b.tile, tile) <= BUILDINGS.defense.radius) return true;
    }
    return false;
  }

  /**
   * Combat outcome for taking `tile` from `targetId` (NEUTRAL for unclaimed
   * land), given the attacking force's current troop pool `attackTroops`
   * (an Attack's or a Boat's `.troops`) and `attackerId` (whose own share of
   * the map's land feeds the large-attacker bonus, below). Ported from
   * OpenFrontIO's attackLogic()/attackTilesPerTick(): both sides' losses and
   * the tile's share of an attack's per-tick budget come from one call,
   * using terrain, defense-post proximity, traitor status and each side's
   * share of the map's land -- see src/config.js's combat section for the
   * exact constants and how they were scaled. Against neutral land there's
   * no defender to lose troops or to be relatively stronger/weaker than, so
   * `defenderLoss` is 0 and the ratio-sensitive terms drop out entirely.
   */
  attackLogic(tile, targetId, attackTroops, attackerId) {
    const t = this.map.terrain[tile];
    const defender = targetId >= 0 ? this.players[targetId] : null;
    const troops = Math.max(1, attackTroops); // guards the divisions below

    let mag = TERRAIN_MAG[t];
    let speed = TERRAIN_SPEED[t];
    if (defender && this.hasDefensePostInRange(tile, targetId)) {
      mag *= BUILDINGS.defense.lossBonus;
      speed *= BUILDINGS.defense.speedBonus;
    }
    // A tribe's land is cheaper to take -- OpenFrontIO's Config.ts exact
    // mag *= 0.7 discount whenever the defender is a Bot (their name for
    // what OceanFront calls a tribe; see tribe.js's header comment).
    if (defender && defender.isTribe) mag *= TRIBE_DEFENSE_DISCOUNT;

    if (!defender) {
      return {
        attackerLoss: mag / 5,
        defenderLoss: 0,
        tilesPerTickUsed: Math.min(
          NEUTRAL_PACE_CEIL,
          Math.max(NEUTRAL_PACE_FLOOR, (NEUTRAL_PACE_SCALE * Math.max(10, speed)) / troops)
        ),
      };
    }

    const defenderShare = defender.tiles.size / this.map.landCount;
    const defenseSig = 1 - sigmoid(defenderShare, DEFENSE_DEBUFF_DECAY, DEFENSE_DEBUFF_MIDPOINT_SHARE);
    const bigDefenderMult = 0.7 + 0.3 * defenseSig;

    let bigAttackerLossMult = 1;
    let bigAttackerPaceMult = 1;
    const attacker = attackerId >= 0 ? this.players[attackerId] : null;
    if (attacker) {
      const attackerShare = attacker.tiles.size / this.map.landCount;
      if (attackerShare > LARGE_ATTACKER_SHARE) {
        bigAttackerLossMult = (LARGE_ATTACKER_SHARE / attackerShare) ** 0.7;
        bigAttackerPaceMult = (LARGE_ATTACKER_SHARE / attackerShare) ** 0.6;
      }
    }

    const traitor = defender.traitorScore > TRAITOR_DISTRUST_LIMIT;
    const lossTraitorMod = traitor ? TRAITOR_DEFENSE_DEBUFF : 1;
    const paceTraitorMod = traitor ? TRAITOR_SPEED_DEBUFF : 1;

    const ratio = Math.min(COMBAT_RATIO_CEIL, Math.max(COMBAT_RATIO_FLOOR, defender.troops / troops));
    const currentLoss = ratio * mag * 0.8 * bigDefenderMult * bigAttackerLossMult * lossTraitorMod;
    const altLoss = 1.3 * defender.density * (mag / MAG_REFERENCE) * lossTraitorMod;
    const attackerLoss = 0.6 * currentLoss + 0.4 * altLoss;

    const paceRatio = Math.min(PACE_RATIO_CEIL, Math.max(PACE_RATIO_FLOOR, defender.troops / (5 * troops)));
    const tilesPerTickUsed = paceRatio * speed * bigDefenderMult * bigAttackerPaceMult * paceTraitorMod;

    return { attackerLoss, defenderLoss: defender.density * DEFENDER_LOSS, tilesPerTickUsed };
  }

  /**
   * Two players who may never fight: the same nation, two members of one
   * team, or two nations bound by an alliance. This is the single legality
   * gate every attack path funnels through -- land attacks, annexation,
   * naval landings, missiles, and every AI target pool -- so a team pact
   * and a diplomatic one are enforced by exactly one rule.
   *
   * Diplomacy's own bookkeeping deliberately does NOT go through here: the
   * two-ally cap, betrayal eligibility and Diplomacy#aiWouldAccept's
   * reputation math all keep reading `player.allies` directly, because a
   * teammate is never added to `.allies` -- a team is not a pact you
   * signed, and a trio's members should each still be free to sign two
   * real alliances of their own.
   *
   * NEUTRAL (-1) is nobody's friend, so unclaimed land stays attackable.
   */
  isFriendly(aId, bId) {
    if (aId < 0 || bId < 0) return false;
    if (aId === bId) return true;
    const a = this.players[aId];
    const b = this.players[bId];
    if (!a || !b) return false;
    if (a.teamId !== null && a.teamId === b.teamId) return true;
    return this.diplomacy.areAllied(aId, bId);
  }

  /**
   * A single comparable token for "who counts as the same side" -- a team
   * id for a nation, a value in its own private negative namespace for a
   * tribe (which is on no team and must still read as distinct from every
   * other tribe). In a solo match this is injective over player ids, which
   * is what makes the renderer's border test provably identical to the
   * pre-teams one there.
   */
  teamKeyOf(playerId) {
    const p = this.players[playerId];
    if (!p) return NaN;
    return p.teamId === null ? -1 - p.id : p.teamId;
  }

  /** Every nation on a team, alive or not, in player order. Empty for
   *  `null`/`undefined` (a tribe has no team). */
  teamMembers(teamId) {
    if (teamId === null || teamId === undefined) return [];
    return this.players.filter((p) => p.teamId === teamId);
  }

  /** Why an attack on a friend was refused, in the acting player's own
   *  words -- a team is permanent, an alliance can be torn up, so the two
   *  read differently. */
  #friendlyReason(actorId, otherId) {
    const actor = this.players[actorId];
    const other = this.players[otherId];
    return other.teamId !== null && other.teamId === actor.teamId
      ? `${other.name} is on your team.`
      : `You are allied with ${other.name}. Break the pact first.`;
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
    // Every attack in the game funnels through here, so the friendliness
    // check only needs to exist once. Covers a real alliance AND a team.
    if (targetId >= 0 && this.isFriendly(attacker.id, targetId)) return null;
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

    // Two nations attacking each other at once is what turns a border into a
    // flicker: each side's frontier logic hands back exactly what the other
    // just took, and neither side's budget is sensitive enough to the
    // other's real strength to converge (see HANDOFF.md). OpenFrontIO's fix,
    // ported exactly (their incomingAttacks/outgoingAttacks cancellation in
    // AttackExecution.ts): a new attack immediately meets whatever the enemy
    // already has coming the other way, and the two pools cancel down to one
    // net force before any tile changes hands. There is never more than one
    // live attack between the same two players.
    let net = committed;
    if (targetId >= 0) {
      const opposing = this.attacks.find(
        (a) => !a.done && a.attackerId === targetId && a.targetId === attacker.id
      );
      if (opposing) {
        if (opposing.troops > net) {
          // The incoming attack outweighs this one and absorbs it whole --
          // no attack of its own is ever created here. Not refunded: those
          // troops are spent cancelling the bigger force, not returned home.
          opposing.troops -= net;
          return null;
        }
        // This attack outweighs (or matches) the incoming one -- absorb it
        // whole and continue with the remainder. Same no-refund rule
        // applies to the cancelled attack's troops.
        net -= opposing.troops;
        opposing.done = true;
      }
    }
    if (net < ATTACK_MIN_TROOPS) {
      attacker.troops += net;
      return null;
    }

    const attack = new Attack(attacker.id, targetId, net);
    this.#seedFrontier(attack);
    if (attack.frontier.length === 0) {
      attacker.troops += net;
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

    // Budget an attack gets to spend this tick, ported from OpenFrontIO's
    // attackTilesPerTick(): recomputed every call (not a flat per-troop
    // rate) from the attacker's strength relative to the defender's whole
    // remaining army, times the size of the contested border -- see
    // src/config.js's combat section.
    const border = attack.frontier.length + Math.floor(this.rng() * 5);
    let budget;
    if (defender) {
      const ratio = Math.min(
        ATTACK_BUDGET_CEIL,
        Math.max(ATTACK_BUDGET_FLOOR, ((ATTACK_BUDGET_RATIO_SCALE * attack.troops) / Math.max(1, defender.troops)) * 2)
      );
      budget = ratio * border * ATTACK_BUDGET_PER_BORDER;
    } else {
      budget = border * NEUTRAL_BUDGET_PER_BORDER;
    }

    let taken = 0;
    while (taken < budget && attack.frontier.length > 0) {
      const r = this.#pickFrontierTile(attack);
      const tile = attack.frontier[r];

      // Stale entry: the tile changed hands since it was queued.
      if (this.owner[tile] !== attack.targetId || this.map.terrain[tile] === OCEAN) {
        this.#removeFrontier(attack, r);
        continue;
      }

      const { attackerLoss, defenderLoss, tilesPerTickUsed } =
        this.attackLogic(tile, attack.targetId, attack.troops, attack.attackerId);
      if (attack.troops < attackerLoss) {
        // Might just be an expensive mountain -- try elsewhere a few times.
        attack.fails++;
        if (attack.fails > 25) break;
        continue;
      }
      attack.fails = 0;

      attack.troops -= attackerLoss;
      if (defender) defender.killTroops(defenderLoss);
      this.setOwner(tile, attacker.id);
      this.#removeFrontier(attack, r);
      // Rough ground (and a defended one) eats more of the tick's tile
      // budget, not just more troops -- terrain slows conquest down, it
      // doesn't only tax it.
      taken += tilesPerTickUsed;

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
      const affordable = attack.troops >= this.attackLogic(tile, attack.targetId, attack.troops, attack.attackerId).attackerLoss;
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

  /** Attacks currently landing on `playerId`, from any attacker -- lets a
   *  third party notice a nation is already being invaded and pile on. */
  attacksOn(playerId) {
    return this.attacks.filter((a) => !a.done && a.targetId === playerId);
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

  // ---------------------------------------------------------- encirclement ---

  /**
   * Hand over anything that has been completely boxed in by a single nation.
   * Once you have surrounded something there is no fight left to have, so it
   * falls for free rather than having to be ground down tile by tile.
   *
   * Skipped entirely when no land has changed hands since the last scan,
   * which is the common case between battles.
   */
  #absorbEnclosed() {
    if (this._enclosureScanAt === this._territoryVersion) return;
    this.#absorbEnclosedPockets();
    // Pockets first: swallowing the last patch of open land beside a nation
    // can be exactly what seals it in, so this resolves in one pass instead
    // of waiting for the next scan.
    this.#annexEnclosedNations();
    this._enclosureScanAt = this._territoryVersion;
  }

  /**
   * Unclaimed pockets whose every land neighbour is the same nation. Judged
   * on land alone, so a stray hole on your own coastline still gets filled
   * in -- those are exactly the gaps a ragged front leaves behind.
   */
  #absorbEnclosedPockets() {
    const map = this.map;
    const stamp = this._stamp;
    const queue = this._floodQueue;
    const nb = this._nb;

    this._gen++;
    const gen = this._gen;

    for (let start = 0; start < map.size; start++) {
      if (stamp[start] === gen) continue;
      if (map.terrain[start] === OCEAN || this.owner[start] !== NEUTRAL) continue;

      // Flood the whole neutral component. `queue[0..tail)` ends up holding
      // exactly its tiles, so no per-component allocation is needed.
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      stamp[start] = gen;
      let claimant = NEUTRAL; // NEUTRAL = none seen yet, -2 = more than one

      while (head < tail) {
        const cur = queue[head++];
        const n = map.neighbors(cur, nb);
        for (let k = 0; k < n; k++) {
          const j = nb[k];
          if (map.terrain[j] === OCEAN) continue;
          const o = this.owner[j];
          if (o === NEUTRAL) {
            if (stamp[j] !== gen) {
              stamp[j] = gen;
              queue[tail++] = j;
            }
          } else if (claimant === NEUTRAL) {
            claimant = o;
          } else if (claimant !== o) {
            claimant = -2;
          }
        }
      }

      // One owner all the way round, and small enough that this is closing
      // out a pocket rather than standing in for actually expanding.
      if (claimant < 0 || tail > ENCLOSED_MAX_TILES) continue;
      for (let i = 0; i < tail; i++) this.setOwner(queue[i], claimant);
    }
  }

  /**
   * Nations sealed in by a single rival. Unlike pockets these must be truly
   * landlocked: any coast at all means an army can still be shipped out, so
   * the sea counts as a way out rather than a technicality.
   */
  #annexEnclosedNations() {
    const map = this.map;
    const nb = this._nb;

    for (const victim of this.players) {
      if (!victim.alive || victim.tiles.size === 0) continue;

      let captor = NEUTRAL; // NEUTRAL = none yet, -2 = open land or several rivals
      let hasCoast = false;

      outer:
      for (const tile of victim.tiles) {
        const n = map.neighbors(tile, nb);
        for (let k = 0; k < n; k++) {
          const j = nb[k];
          if (map.terrain[j] === OCEAN) {
            hasCoast = true;
            break outer;
          }
          const o = this.owner[j];
          if (o === victim.id) continue;
          if (o === NEUTRAL) {
            // Still has somewhere to grow, so not sealed in.
            captor = -2;
            break outer;
          }
          if (captor === NEUTRAL) captor = o;
          else if (captor !== o) {
            captor = -2;
            break outer;
          }
        }
      }

      if (hasCoast || captor < 0) continue;
      // Friendship holds here for the same reason it holds in launchAttack
      // -- you cannot quietly swallow a teammate or someone you have sworn
      // not to attack.
      if (this.isFriendly(victim.id, captor)) continue;

      const conqueror = this.players[captor];
      if (conqueror?.alive) this.#annex(conqueror, victim);
    }
  }

  /** Absorb `victim` whole into `conqueror`: land, structures and treasury. */
  #annex(conqueror, victim) {
    // Snapshot first -- setOwner mutates victim.tiles as it goes. Structures
    // change hands with the ground they stand on, via #transferBuilding.
    const tiles = [...victim.tiles];
    for (const tile of tiles) this.setOwner(tile, conqueror.id);

    const spoils = victim.gold * ANNEX_GOLD_SHARE;
    conqueror.gold += spoils;
    victim.gold = 0;

    // Whatever the victim still had in the field dies with the nation.
    for (const a of this.attacks) {
      if (!a.done && a.attackerId === victim.id) {
        a.troops = 0;
        a.done = true;
      }
    }
    for (const b of this.boats) if (b.ownerId === victim.id) b.done = true;

    victim.alive = false;
    victim.troops = 0;

    const loot = spoils >= 1 ? `, seizing ${Math.round(spoils).toLocaleString()} gold` : '';
    this.log(`${conqueror.name} surrounded and annexed ${victim.name}${loot}.`, conqueror.color);
    this.signal('annexed', { conquerorId: conqueror.id, victimId: victim.id });
    if (victim.isHuman) this.#endMatch(null);
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
    // launchAttack has always had this guard; a naval landing never did --
    // a real gap, not just a teams-mode one, since it let a boat seize a
    // sworn ally's tile outright.
    const targetId = this.owner[targetTile];
    if (targetId >= 0 && this.isFriendly(player.id, targetId)) {
      return { ok: false, reason: this.#friendlyReason(player.id, targetId) };
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

    // A legally launched boat can still arrive at a tile that became
    // friendly mid-voyage -- an alliance signed while it was at sea, or a
    // teammate taking the tile first. Stand it down rather than throwing
    // it back, mirroring what already happens to a live land attack when
    // the two sides sign a pact mid-fight (see cancelAttacksBetween).
    if (defenderId >= 0 && this.isFriendly(boat.ownerId, defenderId)) {
      player.troops += boat.troops * RETREAT_REFUND;
      if (player.isHuman) {
        this.log(`Landing force stood down — ${this.players[defenderId].name} holds that shore.`, player.color);
      }
      return;
    }

    const { attackerLoss, defenderLoss } = this.attackLogic(tile, defenderId, boat.troops, boat.ownerId);

    if (boat.troops <= attackerLoss) {
      // The landing is thrown back into the sea.
      if (defenderId >= 0) this.players[defenderId].killTroops(boat.troops * 0.4);
      this.pushEffect('splash', this.map.xOf(tile), this.map.yOf(tile), 6);
      if (player.isHuman) this.log('Naval landing was repelled.', '#ff8080');
      return;
    }

    if (defenderId >= 0) this.players[defenderId].killTroops(defenderLoss);
    this.setOwner(tile, player.id);
    this.pushEffect('landing', this.map.xOf(tile), this.map.yOf(tile), 8);

    const remaining = boat.troops - attackerLoss;
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

    // Scorching your OWN ground stays legal (it always has been) -- this
    // only stops a warhead aimed at a teammate or a sworn ally, a guard
    // launchNuke never had at all. Only the aimed tile is checked, not the
    // whole blast radius: fallout doesn't respect treaties, same as
    // launchAttack guards the target and not the frontier it might touch.
    const targetId = this.owner[targetTile];
    if (targetId >= 0 && targetId !== player.id && this.isFriendly(player.id, targetId)) {
      return { ok: false, reason: this.#friendlyReason(player.id, targetId) };
    }

    player.gold -= NUKE_COST;
    this.missiles.push(new Missile(player.id, silo.tile, targetTile, this.map));
    this.log(`${player.name} launched a missile.`, player.color);
    this.signal('nuke-launch', { playerId: player.id });
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
          this.signal('intercept', { playerId: p.id, x: m.x, y: m.y });
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
    this.signal('nuke-hit', { x: cx, y: cy });
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
    this.signal('build', { key, playerId: player.id });
    return { ok: true, building: b };
  }

  costFor(player, key) {
    return buildingCost(BUILDINGS[key], player.countOf(key));
  }

  /**
   * Tear down a structure you own. No refund -- matching what already
   * happens when a structure is destroyed by a nuke or by its ground going
   * neutral (#destroyBuilding, above). Not currently exposed in the player
   * UI; TribeController (src/tribe.js) is the only caller today, but
   * nothing here is tribe-specific. Returns whether anything was actually
   * removed.
   */
  demolish(player, building) {
    if (!player || !building) return false;
    if (building.ownerId !== player.id) return false;
    // Guards a stale reference: the tile may have changed hands (which
    // re-owns the building via #transferBuilding) or been nuked flat
    // between the caller reading it and calling in.
    if (this.buildingAt.get(building.tile) !== building) return false;
    this.#destroyBuilding(building);
    this.dirty = true;
    return true;
  }

  // ------------------------------------------------------------- lifecycle --

  pushEffect(type, x, y, radius) {
    this.effects.push({ type, x, y, radius, t: 0, life: type === 'nuke' ? 28 : 14 });
  }

  log(text, color = '#cfd8e3') {
    this.events.unshift({ text, color, tick: this.tickCount });
    if (this.events.length > 40) this.events.pop();
  }

  /** Emits a raw fact for whatever is listening (sound.js, if bound) to
   *  decide what to do with -- human-only gating and every other policy
   *  decision lives entirely in the listener, never here. A broken listener
   *  must never stop a match, hence the try/catch. */
  signal(type, data) {
    if (!this.onEvent) return;
    try {
      this.onEvent(type, data);
    } catch {
      /* a presentation-layer failure is never allowed to break the sim */
    }
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

    if (this.tickCount % ENCLOSURE_SCAN_TICKS === 0) this.#absorbEnclosed();

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

      // Whoever took the last tile carries off part of the treasury. Land
      // lost to a nuke points at NEUTRAL instead, so scorching a nation off
      // the map earns nothing -- there is nobody standing there to loot it.
      const killer = p.lastConquerorId >= 0 ? this.players[p.lastConquerorId] : null;
      let spoils = 0;
      if (killer?.alive && killer.id !== p.id) {
        spoils = p.gold * CONQUEST_GOLD_SHARE;
        killer.gold += spoils;
      }
      p.gold = 0;

      const loot = spoils >= 1
        ? ` ${killer.name} carried off ${Math.round(spoils).toLocaleString()} gold.`
        : '';
      this.log(`${p.name} has been wiped off the map.${loot}`, p.color);
      // killerId is -1 for a nuke-kill (land reverts to NEUTRAL, nobody was
      // standing there to conquer it) -- never a real player id, so a
      // listener gating on it declines the reward sound correctly.
      this.signal('eliminated', { killerId: killer?.id ?? -1, victimId: p.id });
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

    // Team wins, checked only once both solo checks above have declined --
    // a lone nation crossing the threshold still ends the match on its own
    // terms, it just credits its team too (see #endMatch's default team).
    // Solo matches never reach past this line: every team is a singleton,
    // so neither loop below can ever find more than one member.
    if (this.teamSize < 2) return;

    const byTeam = new Map();
    for (const p of alive) {
      if (p.teamId === null) continue; // tribes are on no team
      const list = byTeam.get(p.teamId);
      if (list) list.push(p);
      else byTeam.set(p.teamId, [p]);
    }

    // Last team standing. Deliberately as strict as the alive.length === 1
    // check above -- surviving tribes block it exactly the way they block
    // a solo last-nation-standing win, so teams and solos win on equal
    // terms.
    if (byTeam.size === 1) {
      const [, members] = [...byTeam.entries()][0];
      if (members.length > 1 && alive.length === members.length) {
        this.#endMatch(this.#teamLeader(members));
        return;
      }
    }

    // Combined land share -- the same threshold one nation has to clear
    // alone, measured across the whole team.
    for (const members of byTeam.values()) {
      if (members.length < 2) continue;
      let tiles = 0;
      for (const m of members) tiles += m.tiles.size;
      if (tiles / this.map.landCount >= VICTORY_LAND_SHARE) {
        this.#endMatch(this.#teamLeader(members));
        return;
      }
    }
  }

  /** Whoever on a winning team personally holds the most land -- `winner`
   *  stays a single Player, the contract src/ui.js's showEndScreen and
   *  tools/simulate.js both already depend on. */
  #teamLeader(members) {
    let best = members[0];
    for (const m of members) if (m.tiles.size > best.tiles.size) best = m;
    return best;
  }

  /** `winningTeamId` defaults to the winner's own team, so the two
   *  pre-existing solo-win checks above credit a teammate's landslide to
   *  the whole team without either of them needing to change. Inert in
   *  solo: a solo player's team is only ever themselves, so
   *  `winningTeamId === human.teamId` is true only when `winner ===
   *  human` already was. Stays null when there is no winner (the human
   *  was eliminated or annexed -- #checkEliminations/#annex both call
   *  this with `null`). */
  #endMatch(winner, winningTeamId = winner?.teamId ?? null) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.winner = winner;
    this.winningTeamId = winningTeamId;
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
