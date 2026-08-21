// Bot nations. Each bot re-evaluates every few seconds: grow the economy,
// then decide whether to expand into open land or invade a neighbour.

import {
  NUKE_COST,
  OCEAN,
  BOAT_MIN_TROOPS,
  AI_VICTIM_SHARE,
  AI_VERY_WEAK_RATIO,
  AI_NAVAL_HARASSMENT_CHANCE,
  AI_WEAK_ATTACK_RATIO,
  AI_BETRAYAL_WEAK_ALLY_RATIO,
  AI_BETRAYAL_WEAK_ALLY_CHANCE,
  AI_TRIGGER_RATIO_RANGE,
  AI_RESERVE_RATIO_RANGE,
  AI_EXPAND_RATIO_RANGE,
  AI_TRIGGER_OVERRIDE_CHANCE,
  AI_TRIBE_ATTACK_COMMIT_MULT,
  AI_TRIBE_ATTACK_MIN_MULT,
  AI_TRIBE_PARALLELISM,
} from './config.js';

// Fallback range for the default tier below -- identical to 'normal' in
// config.js's DIFFICULTIES, so anything constructing an AiController without
// a tier (older test helpers, tools/simulate.js's human-AI) behaves exactly
// as it did before difficulty-scaled cadence existed.
const DEFAULT_THINK_RANGE = [18, 34];

/** Uniform roll within a [lo, hi] range, e.g. one of config.js's
 *  AI_*_RATIO_RANGE pairs. */
function randRange(rng, [lo, hi]) {
  return lo + rng() * (hi - lo);
}

export class AiController {
  /** `tier` is a DIFFICULTIES entry from config.js (defaults to a neutral
   *  1x multiplier plus Normal's cadence, so a bot can still be constructed
   *  without one, e.g. in older test helpers). */
  constructor(player, rng, tier = { aggression: 1 }) {
    this.player = player;
    this.rng = rng;
    // Diplomacy-only personality now (see #doDiplomacy/#maybeBetrayWeakAlly)
    // -- scaled by difficulty, so harder bots break pacts more readily, not
    // just field a bigger economy. No longer drives attack targeting or
    // commit size; see triggerRatio/reserveRatio/expandRatio, below, for
    // that.
    this.aggression = (0.5 + rng() * 0.9) * tier.aggression;
    this.greed = (0.6 + rng() * 0.8) * tier.aggression;
    // The real aggression system, ported from OpenFrontIO's
    // NationExecution.ts (read off their actual source this round): three
    // ratios rolled once per bot, identical range for a nation or a tribe,
    // and deliberately NOT scaled by difficulty -- see config.js's ai
    // section for the exact ranges and what each one gates. Replaces the
    // old invented `expansionism` field, which was rolled here and never
    // read anywhere else -- a real dead-code bug found while researching
    // this port.
    this.triggerRatio = randRange(rng, AI_TRIGGER_RATIO_RANGE);
    this.reserveRatio = randRange(rng, AI_RESERVE_RATIO_RANGE);
    this.expandRatio = randRange(rng, AI_EXPAND_RATIO_RANGE);
    // How often this bot reconsiders its posture and looks for a fight --
    // the biggest difficulty lever left, since it changes reaction speed
    // rather than just strength once a bot does act.
    this.thinkRange = tier.thinkRange ?? DEFAULT_THINK_RANGE;
    // Refuses a token attack that's too small to matter (see #makeWar) --
    // only on tiers that opt in.
    this.strictAttacks = tier.strictAttacks ?? false;
    this.cooldown = Math.floor(rng() * this.thinkRange[1]);
    this.lastBorderScan = null;
  }

  update(game) {
    if (--this.cooldown > 0) return;
    const [min, max] = this.thinkRange;
    this.cooldown = min + Math.floor(this.rng() * (max - min));

    const p = this.player;
    if (p.tiles.size === 0) return;

    const border = this.#scanBorders(game);
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

    // An ally whose army just collapsed is too good an opportunity to pass
    // up, independent of the boxed-in valve below (which only fires when
    // there's truly nowhere else to grow).
    if (this.#maybeBetrayWeakAlly(game, border)) return;

    // A nation with no open land and no border it could ever profitably
    // attack has nowhere left to grow. Without this valve a web of pacts
    // (or a ring of allies plus rivals too heavily fortified to ever clear
    // the viability gate below -- functionally the same dead end) freezes
    // the whole map into a permanent stalemate, so somebody has to break
    // faith.
    const neighbours = [...border.contact.keys()];
    // Fill ratio (troops vs. own cap), not density: maxTroops is now a
    // sublinear function of tiles (see Player#maxTroops), so a big and a
    // small nation settle at different equilibrium densities purely from
    // size, not from how militarized either one is. Fill ratio stays
    // meaningful across sizes the same way density used to before that --
    // the smoothing offset is 0.1, not density's old 1, since fillRatio is
    // bounded to roughly [0, 1] rather than density's much wider range;
    // reusing 1 here would flatten the gate to near-insensitivity.
    const myFill = p.fillRatio;
    const boxedIn =
      border.neutral === 0 &&
      neighbours.length > 0 &&
      neighbours.every((id) => {
        if (p.allies.has(id)) return true;
        const ratio = (myFill + 0.1) / (game.players[id].fillRatio + 0.1);
        return ratio < 0.75; // same floor #viableRivals uses in #makeWar
      });

    if (p.allies.size > 0 && (boxedIn ? this.rng() < 0.5 : this.rng() < 0.05 * this.aggression)) {
      let victim = null;
      for (const allyId of p.allies) {
        const ally = game.players[allyId];
        if (!ally?.alive || !dip.canBreak(p.id, allyId)) continue;
        if (!border.contact.has(allyId)) continue;
        // Normally we only turn on someone we can clearly beat; when boxed in,
        // the weakest neighbour will have to do.
        const beatable = ally.tiles.size < p.tiles.size * 0.6 && p.fillRatio > ally.fillRatio * 1.3;
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

  /** Opportunistically betray a bordering ally whose standing army has
   *  collapsed to a fraction of what it's building toward -- the same
   *  weakness signal #findVeryWeak uses against rivals, applied to a
   *  treaty partner instead. Returns whether a betrayal happened. */
  #maybeBetrayWeakAlly(game, border) {
    const p = this.player;
    const dip = game.diplomacy;
    if (p.allies.size === 0) return false;
    if (this.rng() >= AI_BETRAYAL_WEAK_ALLY_CHANCE * this.aggression) return false;

    for (const allyId of p.allies) {
      if (!border.contact.has(allyId)) continue; // out of reach either way
      const ally = game.players[allyId];
      if (!ally?.alive || !dip.canBreak(p.id, allyId)) continue;

      const expected = ally.maxTroops;
      if (expected <= 0 || ally.troops >= expected * AI_BETRAYAL_WEAK_ALLY_RATIO) continue;
      if (p.fillRatio <= ally.fillRatio * 1.2) continue; // still not worth the reputation hit

      dip.breakAlliance(p.id, ally.id);
      return true;
    }
    return false;
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

  /**
   * Decide who (if anyone) to attack this think-cycle. Tries a sequence of
   * purpose-built target finders in priority order and takes the first hit,
   * rather than scoring every option and picking the best: a rival already
   * being invaded, or one whose army just collapsed, is worth reacting to
   * immediately even if some other target would technically score higher.
   * Falls back to the original weighted search (#findWeakest) only once
   * none of those opportunities exist.
   */
  #makeWar(game, border) {
    const p = this.player;

    // Hunt nearby tribes first, independent of everything below -- a
    // nation can have several tribe attacks running at once (up to its
    // tier's parallelism) *alongside* one ordinary attack, exactly like
    // OpenFrontIO's own attackBots() running outside its normal
    // single-target strategy chain.
    this.#attackNearbyTribes(game, border);

    // Only a rival- or neutral-land attack counts against the single-
    // ordinary-attack gate -- the tribe attacks above are deliberately
    // exempt from it.
    const hasOrdinaryAttack = game.attacksBy(p.id).some(
      (a) => a.targetId < 0 || !game.players[a.targetId].isTribe
    );
    if (hasOrdinaryAttack) return;

    // Real gating ported from OpenFrontIO: reserveRatio is a hard floor
    // (never attack below it); triggerRatio is a softer one -- still
    // attack anyway with a flat chance rather than always waiting for a
    // full-strength army. Neither is difficulty-scaled -- see config.js.
    if (p.fillRatio < this.reserveRatio) return;
    if (p.fillRatio < this.triggerRatio && this.rng() >= AI_TRIGGER_OVERRIDE_CHANCE) return;

    // Occasionally raid by sea even with land targets available, purely for
    // unpredictability -- not only as the no-target fallback it is below.
    if (
      border.coastal > 0 &&
      this.rng() < AI_NAVAL_HARASSMENT_CHANCE &&
      this.#tryNavalInvasion(game, border)
    ) {
      return;
    }

    const rivals = this.#viableRivals(game, border, p.fillRatio);
    const target =
      this.#findRetaliation(game) ??
      this.#findVictim(game, rivals) ??
      this.#findVeryWeak(rivals) ??
      this.#findLeader(game, rivals) ??
      this.#findNeutral(border) ??
      this.#findWeakest(game, p, rivals);

    if (target === null) {
      this.#tryNavalInvasion(game, border);
      return;
    }

    // Real formula ported from OpenFrontIO: send everything above a
    // reserve, not a flat fraction of current troops. Attacking neutral
    // land keeps back only the smaller expandRatio reserve; attacking a
    // rival (including a retaliation target) keeps back the bigger
    // reserveRatio one.
    const reserve = p.maxTroops * (target === -1 ? this.expandRatio : this.reserveRatio);
    const troopsToSend = Math.max(0, p.troops - reserve);

    // Refuse a token attack too small to matter -- unless we're already
    // under attack ourselves, in which case any retaliation is worth it.
    if (
      this.strictAttacks &&
      target !== -1 &&
      game.attacksOn(p.id).length === 0 &&
      troopsToSend < game.players[target].troops * AI_WEAK_ATTACK_RATIO
    ) {
      this.#tryNavalInvasion(game, border);
      return;
    }

    game.launchAttack(p, target, troopsToSend);
  }

  /**
   * OpenFrontIO's attackBots(), ported: nations hunt nearby tribes
   * preferentially, hitting several at once (up to the difficulty tier's
   * parallelism) rather than the one-attack-at-a-time discipline everything
   * else in #makeWar follows. Structure-holding tribes are prioritized
   * (denying captured buildings matters more than raw land), then the
   * lowest-density ones -- weakest first. Bypasses the reserveRatio gate
   * entirely (uses the smaller expandRatio reserve instead) and skips a
   * tribe outright unless a decisive win is affordable.
   */
  #attackNearbyTribes(game, border) {
    const p = this.player;
    const parallelism = AI_TRIBE_PARALLELISM[game.difficulty] ?? AI_TRIBE_PARALLELISM.normal;
    const alreadyTargeted = new Set(game.attacksBy(p.id).map((a) => a.targetId));

    const tribes = [];
    for (const rivalId of border.contact.keys()) {
      if (alreadyTargeted.has(rivalId)) continue; // launchAttack would just reinforce -- skip the work
      const rival = game.players[rivalId];
      if (!rival.alive || !rival.isTribe || p.allies.has(rivalId)) continue;
      tribes.push(rival);
    }
    if (tribes.length === 0) return;

    tribes.sort((a, b) => {
      const holdsBuildings = (b.buildings.length > 0) - (a.buildings.length > 0);
      return holdsBuildings !== 0 ? holdsBuildings : a.density - b.density;
    });

    const reserve = p.maxTroops * this.expandRatio;
    for (const target of tribes.slice(0, parallelism)) {
      if (p.maxTroops < target.troops * AI_TRIBE_ATTACK_MIN_MULT) continue;
      const troopsToSend = Math.min(
        target.troops * AI_TRIBE_ATTACK_COMMIT_MULT,
        Math.max(0, p.troops - reserve)
      );
      if (troopsToSend > 0) game.launchAttack(p, target.id, troopsToSend);
    }
  }

  /**
   * Fight back against whoever is currently invading us -- ignores the
   * normal viability gate (#viableRivals' relative-strength ratio) other
   * finders respect, exactly like OpenFrontIO's own findIncomingAttackPlayer:
   * a weak nation still strikes back at a much stronger invader rather than
   * always folding meekly to them. Bot/tribe attackers are excluded --
   * #attackNearbyTribes is already the tribe-specific response, matching
   * OpenFrontIO's own incomingAttacks filter for non-bot players.
   */
  #findRetaliation(game) {
    const p = this.player;
    let best = null;
    let bestTroops = 0;
    for (const atk of game.attacksOn(p.id)) {
      const attacker = game.players[atk.attackerId];
      if (!attacker.alive || attacker.isTribe || p.allies.has(attacker.id)) continue;
      if (atk.troops > bestTroops) {
        bestTroops = atk.troops;
        best = attacker.id;
      }
    }
    return best;
  }

  /**
   * Bordering, living, non-allied rivals we're not hopelessly outmatched
   * against -- the shared candidate pool every rival-targeting finder below
   * draws from, so they all respect the same "can we actually take this"
   * gate the original single-score search used. Tribes are deliberately
   * excluded: #attackNearbyTribes is their dedicated handler, run
   * independently of this chain every think-cycle, and leaving them
   * reachable here too creates a self-referential loop -- a tribe
   * #attackNearbyTribes just committed troops*4 against always instantly
   * satisfies #findVictim's "already under heavy attack" check within the
   * very same think, which would make the ordinary chain simply reinforce
   * that same attack forever instead of ever reaching a genuine rival.
   */
  #viableRivals(game, border, myFill) {
    const p = this.player;
    const rivals = [];
    for (const [rivalId, contactTiles] of border.contact) {
      const rival = game.players[rivalId];
      if (!rival.alive) continue;
      if (rival.isTribe) continue; // #attackNearbyTribes' territory, not this chain's
      if (p.allies.has(rivalId)) continue; // bound by treaty

      // Fill ratio (not density -- see the boxedIn comment in #doDiplomacy)
      // gates and scores relative *strength*; theirDensity is kept
      // separately for #findWeakest's cost estimate, which genuinely is
      // density-driven since that's what Game#attackLogic itself charges.
      const ratio = (myFill + 0.1) / (rival.fillRatio + 0.1);
      if (ratio < 0.75) continue; // too well defended to be worth it

      rivals.push({ rival, contactTiles, theirDensity: rival.density, ratio });
    }
    return rivals;
  }

  /** A rival already facing a serious invasion from someone else -- pile on
   *  rather than let them recover in peace. */
  #findVictim(game, rivals) {
    let best = null;
    let bestShare = AI_VICTIM_SHARE;
    for (const { rival } of rivals) {
      const incoming = game.attacksOn(rival.id).reduce((sum, a) => sum + a.troops, 0);
      if (incoming === 0) continue;
      const share = incoming / Math.max(1, rival.troops);
      if (share > bestShare) {
        bestShare = share;
        best = rival.id;
      }
    }
    return best;
  }

  /** A rival whose standing army has collapsed to a fraction of what
   *  they're building toward -- an easy kill while they're down. */
  #findVeryWeak(rivals) {
    let best = null;
    let bestRatio = AI_VERY_WEAK_RATIO;
    for (const { rival } of rivals) {
      const expected = rival.maxTroops;
      if (expected <= 0) continue;
      const ratio = rival.troops / expected;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = rival.id;
      }
    }
    return best;
  }

  /** Gang up on the runaway map leader, if they're within reach. */
  #findLeader(game, rivals) {
    const leader = game.standings()[0];
    if (!leader || leader.id === this.player.id) return null;
    return rivals.some((r) => r.rival.id === leader.id) ? leader.id : null;
  }

  /** Open land is cheap and, unlike a rival, never fights back. */
  #findNeutral(border) {
    return border.neutral > 0 ? -1 : null;
  }

  /** Fallback: whichever bordering rival scores best by contested tiles,
   *  affordability and density advantage -- the original approach, now
   *  demoted to last resort since the finders above get first refusal. */
  #findWeakest(game, p, rivals) {
    const leader = game.standings()[0];
    let bestTarget = null;
    let bestScore = 0;
    for (const { rival, contactTiles, theirDensity, ratio } of rivals) {
      let score = Math.min(contactTiles, p.troops / (theirDensity * 2 + 1)) * ratio;
      // Gang up on the runaway leader; go easy on the nearly-dead.
      if (leader && rival.id === leader.id && rival.id !== p.id) score *= 1.5;
      if (rival.tiles.size < p.tiles.size * 0.25) score *= 1.3;
      if (rival.isHuman) score *= 1.1;

      if (score > bestScore) {
        bestScore = score;
        bestTarget = rival.id;
      }
    }
    return bestTarget;
  }

  /**
   * Looks for an island to raid by sea -- both as a fallback when nothing on
   * land is worth attacking, and occasionally just to harass. Returns
   * whether a boat actually launched, so a harassment roll knows whether it
   * spent this think-cycle or should fall through to a land decision.
   */
  #tryNavalInvasion(game, border) {
    const p = this.player;
    if (border.coastal === 0 || p.troops < BOAT_MIN_TROOPS * 6) return false;
    if (this.rng() > 0.4) return false;

    for (let attempt = 0; attempt < 8; attempt++) {
      const tile = Math.floor(this.rng() * game.map.size);
      if (!game.map.isLand(tile)) continue;
      if (game.owner[tile] === p.id) continue;
      if (game.map.dist(tile, game.map.idx(Math.round(p.centroid.x), Math.round(p.centroid.y))) > game.boatRange(p)) {
        continue;
      }
      const res = game.launchBoat(p, tile, p.troops * 0.45);
      if (res.ok) return true;
    }
    return false;
  }
}
