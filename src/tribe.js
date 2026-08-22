// Tribes: the game's second, much weaker AI archetype. A tribe is a small,
// lazy band that grabs open land early so nobody gets a free unclaimed-land
// walkover, signs any pact it's offered, and tears down anything it
// captures. It never attacks a real player -- a nation or the human --
// whether by land or by sea, only ever another tribe or open land, so it
// stays background scenery rather than a threat: pure easy pickings for
// whoever finds one. It never builds, never nukes, never proposes a pact,
// never betrays one, and is never scaled by the match's difficulty setting
// -- see the tribes block in src/config.js.

import { shuffle } from './rng.js';
import {
  OCEAN,
  BOAT_MIN_TROOPS,
  TRIBE_THINK_RANGE,
  TRIBE_TRIGGER_RANGE,
  TRIBE_ATTACK_COMMIT,
  TRIBE_NEUTRAL_COMMIT,
  TRIBE_TRAITOR_ATTACK_CHANCE,
  TRIBE_TRAITOR_THRESHOLD,
  TRIBE_BOAT_CHANCE,
  TRIBE_BOAT_COMMIT,
  TRIBE_BOAT_MIN_TROOPS_FACTOR,
} from './config.js';

export class TribeController {
  /** Same duck-typed contract as AiController: the tick loop only ever
   *  calls update(game). No `tier` parameter -- tribes are difficulty-flat
   *  by design (see config.js), and taking one would invite DIFFICULTIES
   *  scaling back in. */
  constructor(player, rng) {
    this.player = player;
    this.rng = rng;
    const [lo, hi] = TRIBE_THINK_RANGE;
    // Fixed per tribe for the whole match, unlike a nation's
    // re-rolled-every-think cadence.
    this.attackRate = lo + Math.floor(rng() * (hi - lo));
    const [tlo, thi] = TRIBE_TRIGGER_RANGE;
    this.triggerRatio = tlo + rng() * (thi - tlo);
    this.cooldown = Math.floor(rng() * this.attackRate); // stagger
    this.firstThink = true;
  }

  update(game) {
    if (--this.cooldown > 0) return;
    this.cooldown = this.attackRate;

    const p = this.player;
    if (p.tiles.size === 0) return;

    const border = this.#scanBorders(game);

    // A brand new tribe takes open land immediately, before any readiness
    // check -- at spawn its fillRatio starts below its own trigger ratio,
    // so without this it would sit out the entire opening land grab, which
    // is the one thing a tribe exists to contest.
    if (this.firstThink) {
      this.firstThink = false;
      if (border.neutral > 0) {
        game.launchAttack(p, -1, p.troops * TRIBE_NEUTRAL_COMMIT);
        return;
      }
    }

    this.#acceptEveryOffer(game);
    this.#demolishOne(game);
    this.#maybeAttack(game, border);
  }

  /** Signs anything, from anyone, with no evaluation -- no reputation
   *  check, no strength check, no ally-count cap. Deliberately bypasses
   *  Diplomacy#aiWouldAccept, which encodes a nation's judgement. A tribe
   *  never proposes, so it can only ever be the junior partner. */
  #acceptEveryOffer(game) {
    const dip = game.diplomacy;
    for (const offer of dip.offersTo(this.player.id)) dip.accept(offer);
  }

  /** Tears down exactly one owned structure per think. Everything a tribe
   *  owns was inherited by conquest (it never builds), and this is why a
   *  tribe that captures a city never snowballs off it. */
  #demolishOne(game) {
    const p = this.player;
    if (p.buildings.length === 0) return;
    game.demolish(p, p.buildings[0]); // oldest held first
  }

  /** Bordering hostiles, whether any open land is adjacent, and whether we
   *  touch the coast. Everything a tribe's decision needs and nothing
   *  else -- no reservoir sampling for building placement, unlike
   *  AiController#scanBorders, since a tribe never builds. */
  #scanBorders(game) {
    const p = this.player;
    const nb = new Int32Array(4);
    const contact = new Map(); // ownerId -> border tile count
    let neutral = 0;
    let coastal = 0;
    for (const tile of p.tiles) {
      if (game.map.coastal[tile]) coastal++;
      const n = game.map.neighbors(tile, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (game.map.terrain[j] === OCEAN) continue;
        const o = game.owner[j];
        if (o === p.id) continue;
        if (o < 0) neutral++;
        else contact.set(o, (contact.get(o) || 0) + 1);
      }
    }
    return { contact, neutral, coastal };
  }

  #maybeAttack(game, border) {
    const p = this.player;
    // launchAttack reinforces an existing attack on the same target rather
    // than stacking a second one, so without this guard a tribe would pour
    // its whole army into one grind forever.
    if (game.attacksBy(p.id).length > 0) return;
    if (p.fillRatio < this.triggerRatio) return;

    // Never a real player -- a nation or the human -- only ever another
    // tribe. That's the whole point: a tribe is background scenery, not a
    // threat, so it can't be the thing that ends your game.
    const hostiles = [...border.contact.keys()].filter(
      (id) => game.players[id].alive && !p.allies.has(id) && game.players[id].isTribe
    );

    // 1. Hit back at whoever is invading us (only ever another tribe, per
    //    the filter above -- a nation or the human attacking a tribe just
    //    goes unanswered).
    for (const atk of game.attacksOn(p.id)) {
      if (hostiles.includes(atk.attackerId)) {
        this.#strike(game, atk.attackerId);
        return;
      }
    }

    // 2. A neighbouring tribe that has broken a pact is fair game.
    for (const id of hostiles) {
      if (
        game.players[id].traitorScore >= TRIBE_TRAITOR_THRESHOLD &&
        this.rng() < TRIBE_TRAITOR_ATTACK_CHANCE
      ) {
        this.#strike(game, id);
        return;
      }
    }

    // 3. Otherwise take the first viable neighbouring tribe in random
    //    order. No relative-strength gate at all -- a tribe will happily
    //    throw itself at something far stronger. That absence is what
    //    makes it a tribe, not a smaller nation.
    const order = shuffle(this.rng, hostiles.slice());
    for (const id of order) {
      if (this.#strike(game, id)) return;
    }

    // 4. Nothing worth fighting: take open land if any is left...
    if (border.neutral > 0) {
      game.launchAttack(p, -1, p.troops * TRIBE_NEUTRAL_COMMIT);
      return;
    }
    // 5. ...and failing that, try the sea, so an island tribe isn't inert.
    this.#tryNavalInvasion(game, border);
  }

  /** Same flat fraction-of-current-troops idiom as AiController#makeWar. */
  #strike(game, targetId) {
    const p = this.player;
    return game.launchAttack(p, targetId, p.troops * TRIBE_ATTACK_COMMIT) !== null;
  }

  #tryNavalInvasion(game, border) {
    const p = this.player;
    if (border.coastal === 0) return false;
    if (p.troops < BOAT_MIN_TROOPS * TRIBE_BOAT_MIN_TROOPS_FACTOR) return false;
    if (this.rng() > TRIBE_BOAT_CHANCE) return false;

    for (let attempt = 0; attempt < 6; attempt++) {
      const tile = Math.floor(this.rng() * game.map.size);
      if (!game.map.isLand(tile)) continue;
      const owner = game.owner[tile];
      if (owner === p.id) continue;
      // A boat landing on owned land is an attack same as any other -- only
      // unclaimed tiles or another tribe's are fair game, matching #maybeAttack.
      if (owner >= 0 && !game.players[owner].isTribe) continue;
      const home = game.map.idx(Math.round(p.centroid.x), Math.round(p.centroid.y));
      if (game.map.dist(tile, home) > game.boatRange(p)) continue;
      const res = game.launchBoat(p, tile, p.troops * TRIBE_BOAT_COMMIT);
      if (res.ok) return true;
    }
    return false;
  }
}
