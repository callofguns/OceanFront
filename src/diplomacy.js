// Alliances between nations.
//
// An alliance is a mutual non-aggression pact: neither side can attack the
// other while it stands. Breaking one is deliberate and costly -- it raises the
// betrayer's traitor score, which makes every other nation less willing to sign
// with them. That decays slowly, so a reputation can be rebuilt.

import {
  ALLIANCE_OFFER_TTL,
  BETRAYAL_PENALTY,
  TRAITOR_DECAY_PER_SECOND,
  TRAITOR_DISTRUST_LIMIT,
  ALLIANCE_MIN_DURATION,
  TICKS_PER_SECOND,
} from './config.js';

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export class Diplomacy {
  constructor(game) {
    this.game = game;
    /** pairKey -> tick the alliance was signed. */
    this.alliances = new Map();
    /** Outstanding offers, oldest first. */
    this.offers = [];
  }

  areAllied(a, b) {
    return this.alliances.has(pairKey(a, b));
  }

  alliesOf(playerId) {
    return this.game.players[playerId]?.allies ?? new Set();
  }

  /** Offers already on the table involving these two, in either direction. */
  pendingBetween(a, b) {
    return this.offers.find(
      (o) => (o.from === a && o.to === b) || (o.from === b && o.to === a)
    );
  }

  offersTo(playerId) {
    return this.offers.filter((o) => o.to === playerId);
  }

  canPropose(fromId, toId) {
    if (fromId === toId) return false;
    const from = this.game.players[fromId];
    const to = this.game.players[toId];
    if (!from?.alive || !to?.alive) return false;
    if (this.areAllied(fromId, toId)) return false;
    // A team is already permanently friendly -- there is nothing a real
    // alliance would add, and offering one reads as nonsensical. Covers
    // both the AI's own propose-candidate filter and a human clicking
    // Ally on a teammate, in one place.
    if (from.teamId !== null && from.teamId === to.teamId) return false;
    if (this.pendingBetween(fromId, toId)) return false;
    return true;
  }

  propose(fromId, toId) {
    if (!this.canPropose(fromId, toId)) return false;
    this.offers.push({ from: fromId, to: toId, tick: this.game.tickCount });
    const from = this.game.players[fromId];
    const to = this.game.players[toId];
    if (to.isHuman) {
      this.game.log(`${from.name} proposes an alliance.`, from.color);
      // Gated at the source, not in the listener: AI-to-AI offers fire
      // constantly and would be pure callback noise otherwise.
      this.game.signal('alliance-offer', { fromId, toId });
    }
    return true;
  }

  accept(offer) {
    this.#removeOffer(offer);
    if (this.areAllied(offer.from, offer.to)) return;
    const a = this.game.players[offer.from];
    const b = this.game.players[offer.to];
    if (!a?.alive || !b?.alive) return;

    this.alliances.set(pairKey(offer.from, offer.to), this.game.tickCount);
    a.allies.add(b.id);
    b.allies.add(a.id);

    // Standing attacks between new allies are called off immediately.
    this.game.cancelAttacksBetween(a.id, b.id);
    this.game.log(`${a.name} and ${b.name} are now allied.`, '#8fe1ff');
    this.game.signal('alliance-formed', { aId: a.id, bId: b.id });
    this.game.dirty = true;
  }

  decline(offer) {
    this.#removeOffer(offer);
    const from = this.game.players[offer.from];
    const to = this.game.players[offer.to];
    if (from?.isHuman) this.game.log(`${to.name} declined your alliance offer.`, '#9fb0c4');
  }

  #removeOffer(offer) {
    const i = this.offers.indexOf(offer);
    if (i >= 0) this.offers.splice(i, 1);
  }

  /** How long an alliance has stood, in ticks. -1 if there is none. */
  ageOf(a, b) {
    const signed = this.alliances.get(pairKey(a, b));
    return signed === undefined ? -1 : this.game.tickCount - signed;
  }

  canBreak(a, b) {
    const age = this.ageOf(a, b);
    return age >= 0 && age >= ALLIANCE_MIN_DURATION;
  }

  /** Tear up a pact. The initiator wears the reputational cost. */
  breakAlliance(initiatorId, otherId, { penalize = true } = {}) {
    const key = pairKey(initiatorId, otherId);
    if (!this.alliances.has(key)) return false;
    this.alliances.delete(key);

    const a = this.game.players[initiatorId];
    const b = this.game.players[otherId];
    a.allies.delete(otherId);
    b.allies.delete(initiatorId);

    if (penalize) {
      a.traitorScore += BETRAYAL_PENALTY;
      this.game.log(`${a.name} betrayed ${b.name}!`, '#ff9d5c');
      this.game.signal('betrayed', { initiatorId, otherId });
    } else {
      this.game.log(`${a.name} and ${b.name} went their separate ways.`, '#9fb0c4');
      this.game.signal('alliance-broken', { initiatorId, otherId });
    }
    this.game.dirty = true;
    return true;
  }

  /**
   * Would `responderId` sign with `proposerId`? Bots weigh reputation, relative
   * strength and whether they already share an enemy.
   */
  aiWouldAccept(responderId, proposerId, rng) {
    const responder = this.game.players[responderId];
    const proposer = this.game.players[proposerId];
    if (!responder?.alive || !proposer?.alive) return false;
    if (proposer.traitorScore >= TRAITOR_DISTRUST_LIMIT) return false;

    // Hard cap: without it the whole board ends up mutually allied and the
    // match deadlocks with nobody able to attack anybody.
    if (responder.allies.size >= 2) return false;

    const ai = responder.ai;
    // Warmongers are hard to pin down; cautious nations sign readily.
    let chance = 0.55 - (ai ? (ai.aggression - 0.9) * 0.3 : 0);

    // Nobody wants to be the junior partner of a runaway leader.
    const leader = this.game.standings()[0];
    if (leader && leader.id === proposerId && leader.tiles.size > responder.tiles.size * 2.2) {
      chance -= 0.35;
    }

    // A shared enemy is the best reason to shake hands.
    const sharedThreat = this.game.standings().find(
      (p) => p.id !== responderId && p.id !== proposerId && p.tiles.size > responder.tiles.size * 1.5
    );
    if (sharedThreat) chance += 0.25;

    // Reputation matters.
    chance -= proposer.traitorScore * 0.25;

    // Already well-connected nations are choosier.
    chance -= responder.allies.size * 0.12;

    return rng() < Math.max(0.03, Math.min(0.92, chance));
  }

  tick() {
    const now = this.game.tickCount;

    // Expire stale offers.
    for (let i = this.offers.length - 1; i >= 0; i--) {
      const o = this.offers[i];
      const from = this.game.players[o.from];
      const to = this.game.players[o.to];
      if (!from?.alive || !to?.alive || now - o.tick > ALLIANCE_OFFER_TTL) {
        this.offers.splice(i, 1);
      }
    }

    // Dissolve alliances where one side is gone.
    for (const key of [...this.alliances.keys()]) {
      const [a, b] = key.split(':').map(Number);
      if (!this.game.players[a].alive || !this.game.players[b].alive) {
        this.alliances.delete(key);
        this.game.players[a].allies.delete(b);
        this.game.players[b].allies.delete(a);
      }
    }

    // Traitor scores fade -- this branch runs once per second.
    if (now % TICKS_PER_SECOND === 0) {
      for (const p of this.game.players) {
        if (p.traitorScore > 0) {
          p.traitorScore = Math.max(0, p.traitorScore - TRAITOR_DECAY_PER_SECOND);
        }
      }
    }
  }
}
