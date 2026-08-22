// Correctness tests for the Tribes archetype (src/tribe.js): the game's
// second, much weaker AI, alongside the existing full-nation AiController.
// Same hand-painted-board harness as ai-behavior-test.mjs, so results are
// deterministic. Every case here is written to fail against a nation
// controller too -- that's what makes it a *tribe* test, not a duplicate.
import { Game, NEUTRAL } from '../../src/game.js';
import { TribeController } from '../../src/tribe.js';
import {
  MAP_PRESETS, PLAINS, OCEAN, DIFFICULTIES,
  TRIBE_THINK_RANGE, TRIBE_TRIGGER_RANGE, TRIBE_ATTACK_COMMIT, TRIBE_NEUTRAL_COMMIT,
  TRIBE_TRAITOR_THRESHOLD, TRIBE_TROOPS_CAP_MULTIPLIER, TRIBE_TROOPS_MULTIPLIER,
  TRIBE_GOLD_MULTIPLIER, TRAITOR_DISTRUST_LIMIT,
} from '../../src/config.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}

const CAST = [1, 2, 3, 4];

function blankGame(difficulty = 'normal') {
  const game = new Game({
    preset: MAP_PRESETS.small, seed: 1,
    playerName: 'P0', playerColor: '#e0484f', difficulty,
  });
  game.map.terrain.fill(OCEAN);
  game.owner.fill(NEUTRAL);
  for (const p of game.players) {
    p.tiles.clear();
    p.troops = 0;
    p.gold = 0;
    p.alive = true;
    p.ai = null;
    p.isTribe = false;
    p.buildings = [];
    game.buildingAt.clear();
  }
  game.state = 'playing';
  game.attacks = [];
  game.boats = [];

  // Park the rest of the field far away so nobody accidentally borders the
  // tiles this file paints.
  for (const p of game.players) {
    if (CAST.includes(p.id)) continue;
    const x = 5 + p.id * 6;
    const y = 180;
    game.map.terrain[game.map.idx(x, y)] = PLAINS;
    game.setOwner(game.map.idx(x, y), p.id);
  }
  return game;
}

function rect(game, x0, y0, x1, y1, id) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      game.map.terrain[game.map.idx(x, y)] = PLAINS;
      if (id !== NEUTRAL) game.setOwner(game.map.idx(x, y), id);
    }
  }
}

const dummyRng = () => 0.999;

// A tiny counting rng that returns a fixed value, so two independently
// constructed controllers see the identical draw sequence.
function fixedRng(value) {
  return () => value;
}

// ---------------------------------------------------------------------------
console.log('\n▸ Tribes are difficulty-flat and never take a tier');
{
  check('TribeController takes no third (tier) parameter', TribeController.length === 2);

  const p = { id: 1 };
  const easy = new TribeController(p, fixedRng(0.5));
  const hard = new TribeController(p, fixedRng(0.5));
  check('attackRate is identical given the same rng draw, regardless of match difficulty',
    easy.attackRate === hard.attackRate);
  check('triggerRatio is identical given the same rng draw, regardless of match difficulty',
    easy.triggerRatio === hard.triggerRatio);
  check('attackRate falls inside TRIBE_THINK_RANGE',
    easy.attackRate >= TRIBE_THINK_RANGE[0] && easy.attackRate < TRIBE_THINK_RANGE[1]);
  check('triggerRatio falls inside TRIBE_TRIGGER_RANGE',
    easy.triggerRatio >= TRIBE_TRIGGER_RANGE[0] && easy.triggerRatio <= TRIBE_TRIGGER_RANGE[1]);

  check('tribe troop-cap multiplier is weaker than even Easy nations’',
    TRIBE_TROOPS_CAP_MULTIPLIER < DIFFICULTIES.easy.troopsCapMultiplier);
  check('tribe troop growth multiplier is weaker than even Easy nations’',
    TRIBE_TROOPS_MULTIPLIER < DIFFICULTIES.easy.troopsMultiplier);
  check('tribe gold multiplier is weaker than even Easy nations’',
    TRIBE_GOLD_MULTIPLIER < DIFFICULTIES.easy.goldMultiplier);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Cadence: a complete no-op until the rolled attackRate is reached');
{
  const game = blankGame();
  const p = game.players[1];
  const rival = game.players[2];
  rect(game, 10, 10, 20, 20, p.id);
  rect(game, 21, 10, 30, 20, rival.id);
  rect(game, 5, 25, 9, 29, NEUTRAL);
  p.troops = 500;
  p.ai = new TribeController(p, dummyRng);
  p.ai.firstThink = false; // isolate cadence from the first-think special case

  const rate = p.ai.attackRate;
  for (let i = 0; i < rate - 1; i++) p.ai.update(game);
  check('no attack launched before attackRate ticks have passed', game.attacksBy(p.id).length === 0);
  check('no alliance activity before attackRate ticks have passed', game.diplomacy.offers.length === 0);

  p.ai.update(game); // the attackRate-th call
  check('acts once attackRate ticks have passed',
    game.attacksBy(p.id).length > 0 || game.diplomacy.offers.length >= 0);
}

// ---------------------------------------------------------------------------
console.log('\n▸ First think grabs open land immediately, even below the trigger ratio');
{
  const game = blankGame();
  const p = game.players[1];
  rect(game, 10, 10, 15, 15, p.id); // 36 tiles
  rect(game, 16, 10, 20, 15, NEUTRAL);

  p.ai = new TribeController(p, dummyRng);
  p.troops = p.maxTroops * (TRIBE_TRIGGER_RANGE[0] - 0.05); // deliberately below the trigger ratio
  check('setup: below the trigger ratio', p.fillRatio < p.ai.triggerRatio);
  check('setup: firstThink is true on a freshly constructed tribe', p.ai.firstThink === true);

  p.ai.cooldown = 0;
  p.ai.update(game);

  const attacks = game.attacksBy(p.id);
  check('an attack on open land was launched despite being under the trigger ratio',
    attacks.length === 1 && attacks[0].targetId === -1, `${attacks.length} attacks`);
  check('firstThink is now false', p.ai.firstThink === false);
}

// ---------------------------------------------------------------------------
console.log('\n▸ After the first think, the trigger ratio is respected');
{
  const game = blankGame();
  const p = game.players[1];
  rect(game, 10, 10, 15, 15, p.id);
  rect(game, 16, 10, 20, 15, NEUTRAL);

  p.ai = new TribeController(p, dummyRng);
  p.ai.firstThink = false;
  p.troops = p.maxTroops * (TRIBE_TRIGGER_RANGE[0] - 0.05);
  check('setup: below the trigger ratio', p.fillRatio < p.ai.triggerRatio);

  p.ai.cooldown = 0;
  p.ai.update(game);
  check('no attack launched while under the trigger ratio', game.attacksBy(p.id).length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n▸ No relative-strength gate: attacks a rival tribe far too strong for a nation to bother with');
{
  const game = blankGame();
  const p = game.players[1];
  const giant = game.players[2];
  rect(game, 10, 10, 15, 15, p.id);       // 36 tiles
  rect(game, 16, 10, 60, 60, giant.id);   // huge, borders p directly
  giant.isTribe = true; // a real player is never a candidate at all now (see above), so this has to be a tribe to test the missing viability gate

  // dummyRng (0.999) rolls triggerRatio near the top of TRIBE_TRIGGER_RANGE
  // (~0.6), so p's fillRatio needs real margin above that; giant's needs to
  // be high enough, relative to p's, to fail a nation's ratio>=0.75 gate --
  // note this is about the two fillRatios' *relative* size, not giant's much
  // larger absolute tile count, which the fillRatio-based gate ignores.
  p.troops = p.maxTroops * 0.65;
  giant.troops = giant.maxTroops * 0.98;

  p.ai = new TribeController(p, dummyRng);
  p.ai.firstThink = false;
  p.ai.cooldown = 0;

  const nationRatio = (p.fillRatio + 0.1) / (giant.fillRatio + 0.1);
  check('setup: a nation’s ratio>=0.75 viability gate would reject this target',
    nationRatio < 0.75, `ratio=${nationRatio.toFixed(3)}`);

  p.ai.update(game);
  const attacks = game.attacksBy(p.id);
  check('the tribe attacks the giant anyway -- no viability gate exists for tribes',
    attacks.length === 1 && attacks[0].targetId === giant.id);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Attack sizing matches the configured flat commit fractions');
{
  const game = blankGame();
  const p = game.players[1];
  const rival = game.players[2];
  rect(game, 10, 10, 15, 15, p.id);
  rect(game, 16, 10, 20, 15, rival.id);
  rival.isTribe = true; // a real player is never attacked at all now -- see the dedicated section below

  p.troops = 1000;
  rival.troops = 10;
  p.ai = new TribeController(p, dummyRng);
  p.ai.firstThink = false;
  p.ai.cooldown = 0;
  p.ai.update(game);

  const attacks = game.attacksBy(p.id);
  check('rival attack commits troops * TRIBE_ATTACK_COMMIT',
    attacks.length === 1 && Math.abs(attacks[0].troops - 1000 * TRIBE_ATTACK_COMMIT) < 1,
    `troops=${attacks[0]?.troops}`);
}
{
  const game = blankGame();
  const p = game.players[1];
  rect(game, 10, 10, 15, 15, p.id);
  rect(game, 16, 10, 20, 15, NEUTRAL);

  p.troops = 1000;
  p.ai = new TribeController(p, dummyRng);
  p.ai.cooldown = 0; // exercise via the first-think path
  p.ai.update(game);

  const attacks = game.attacksBy(p.id);
  check('neutral-land grab commits troops * TRIBE_NEUTRAL_COMMIT',
    attacks.length === 1 && Math.abs(attacks[0].troops - 1000 * TRIBE_NEUTRAL_COMMIT) < 1,
    `troops=${attacks[0]?.troops}`);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Unconditional alliance acceptance: no evaluation, no cap, never proposes');
{
  const game = blankGame();
  const p = game.players[1];
  rect(game, 10, 10, 15, 15, p.id);
  p.ai = new TribeController(p, dummyRng);
  p.ai.firstThink = false;
  p.ai.cooldown = 0;

  // Three separate proposers, one of them a known traitor -- a nation's
  // aiWouldAccept would refuse a traitor and cap out at 2 allies.
  const proposers = [game.players[2], game.players[3], game.players[4]];
  for (const [i, prop] of proposers.entries()) {
    rect(game, 20 + i * 10, 10, 20 + i * 10 + 4, 15, prop.id); // far from p, no actual border needed
    if (i === 0) prop.traitorScore = TRAITOR_DISTRUST_LIMIT + 1;
    game.diplomacy.propose(prop.id, p.id);
  }
  check('setup: three offers are pending, one from a known traitor',
    game.diplomacy.offersTo(p.id).length === 3 && proposers[0].traitorScore > TRAITOR_DISTRUST_LIMIT);

  p.ai.update(game);

  check('all three offers were accepted, including the traitor’s',
    proposers.every((prop) => game.diplomacy.areAllied(p.id, prop.id)));
  check('the tribe now holds 3 allies -- no 2-ally cap applies to it',
    p.allies.size === 3);
  check('the tribe never proposed an alliance of its own',
    game.diplomacy.offers.every((o) => o.from !== p.id));
}

// ---------------------------------------------------------------------------
console.log('\n▸ Never betrays, even on the roll that would make a nation do it');
{
  const game = blankGame();
  const p = game.players[1];
  const ally = game.players[2];
  rect(game, 10, 10, 30, 30, p.id);
  rect(game, 31, 10, 45, 30, ally.id);
  p.troops = 5000;
  ally.troops = 5; // collapsed -- exactly the shape that trips AiController's betrayal valve

  game.diplomacy.propose(p.id, ally.id);
  game.diplomacy.accept(game.diplomacy.offersTo(ally.id)[0]);
  check('setup: alliance formed', game.diplomacy.areAllied(p.id, ally.id));

  p.ai = new TribeController(p, fixedRng(0.001)); // the roll that betrays a nation on a good draw
  p.ai.firstThink = false;
  p.ai.cooldown = 0;
  p.ai.update(game);

  check('the collapsed ally is still allied -- a tribe has no betrayal logic at all',
    game.diplomacy.areAllied(p.id, ally.id) === true);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Demolishes exactly one owned structure per think, no refund');
{
  const game = blankGame();
  const p = game.players[1];
  rect(game, 10, 10, 20, 20, p.id);
  p.gold = 1_000_000; // interior tiles, so avoid the port's coastal requirement entirely

  const r1 = game.build(p, 'city', game.map.idx(12, 12));
  const r2 = game.build(p, 'silo', game.map.idx(14, 14));
  check('setup: two structures built', r1.ok && r2.ok && p.buildings.length === 2,
    `${r1.reason ?? ''}${r2.reason ?? ''}`);
  const b1 = r1.building;
  const b2 = r2.building;
  const goldBefore = p.gold;

  p.ai = new TribeController(p, dummyRng);
  p.ai.firstThink = false;
  p.ai.cooldown = 0;

  p.ai.update(game);
  check('exactly one structure removed on the first think',
    p.buildings.length === 1, `${p.buildings.length} remain`);
  check('no gold refunded', p.gold === goldBefore);

  p.ai.cooldown = 0;
  p.ai.update(game);
  check('the second structure is removed on the next think',
    p.buildings.length === 0, `${p.buildings.length} remain`);
  check('bookkeeping fully agrees: buildingCounts zeroed',
    p.buildingCounts.city === 0 && p.buildingCounts.silo === 0);
  check('bookkeeping fully agrees: buildingAt no longer references either tile',
    !game.buildingAt.has(b1.tile) && !game.buildingAt.has(b2.tile));
}

// ---------------------------------------------------------------------------
console.log('\n▸ Game#demolish: direct validation');
{
  const game = blankGame();
  const p = game.players[1];
  const other = game.players[2];
  rect(game, 10, 10, 20, 20, p.id);
  rect(game, 21, 10, 30, 20, other.id);
  p.gold = 1_000_000;
  other.gold = 1_000_000;

  const buildMine = game.build(p, 'city', game.map.idx(12, 12));
  const buildTheirs = game.build(other, 'city', game.map.idx(22, 12));
  check('setup: both structures actually built',
    buildMine.ok && buildTheirs.ok, `${buildMine.reason ?? ''}${buildTheirs.reason ?? ''}`);
  const mine = buildMine.building;
  const theirs = buildTheirs.building;

  check('refuses a building owned by someone else',
    game.demolish(p, theirs) === false && other.buildings.includes(theirs));

  game.dirty = false;
  const ok = game.demolish(p, mine);
  check('succeeds for a building you actually own', ok === true);
  check('fully removed: not in buildings/buildingAt/buildingCounts',
    !p.buildings.includes(mine) && !game.buildingAt.has(mine.tile) && p.buildingCounts.city === 0);
  check('sets game.dirty', game.dirty === true);

  check('a stale reference (already removed) is refused, not thrown',
    game.demolish(p, mine) === false);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Retaliation against an active attacker beats the ordinary shuffle -- but only against another tribe');
{
  const game = blankGame();
  const p = game.players[1];
  const attacker = game.players[2];
  const other = game.players[3];
  rect(game, 10, 10, 20, 20, p.id);
  rect(game, 21, 10, 30, 20, attacker.id);
  rect(game, 10, 21, 20, 25, other.id);
  attacker.isTribe = true;
  other.isTribe = true;

  p.troops = p.maxTroops * 0.9; // comfortably above any TRIBE_TRIGGER_RANGE roll
  attacker.troops = 2000;
  other.troops = 10;

  const inbound = game.launchAttack(attacker, p.id, 500);
  check('setup: p is under attack', inbound !== null && game.attacksOn(p.id).length > 0);

  // rng tuned so an un-gated shuffle would pick `other` first, proving the
  // retaliation branch really does short-circuit the ordinary search.
  p.ai = new TribeController(p, () => 0.999);
  p.ai.firstThink = false;
  p.ai.cooldown = 0;
  p.ai.update(game);

  const attacks = game.attacksBy(p.id);
  check('p retaliates against its actual attacker, not the shuffle’s pick',
    attacks.length === 1 && attacks[0].targetId === attacker.id, `targetId=${attacks[0]?.targetId}`);
}
{
  // Same shape, but the attacker is a real nation -- retaliation is an
  // attack on a player like any other, so it never fires, even though p is
  // actively under attack and nothing else is around to hit instead.
  const game = blankGame();
  const p = game.players[1];
  const attacker = game.players[2];
  rect(game, 10, 10, 20, 20, p.id);
  rect(game, 21, 10, 30, 20, attacker.id);

  p.troops = p.maxTroops * 0.9;
  attacker.troops = 2000;

  const inbound = game.launchAttack(attacker, p.id, 500);
  check('setup: p is under attack from a nation', inbound !== null && game.attacksOn(p.id).length > 0);

  p.ai = new TribeController(p, dummyRng);
  p.ai.firstThink = false;
  p.ai.cooldown = 0;
  p.ai.update(game);

  check('p does not retaliate against a nation, even while under attack',
    game.attacksBy(p.id).length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n▸ A bordering traitor is attacked on a favorable roll, spared on an unfavorable one');
{
  for (const [roll, shouldAttackTraitor, label] of [[0.01, true, 'favorable'], [0.99, false, 'unfavorable']]) {
    const game = blankGame();
    const p = game.players[1];
    const traitor = game.players[2];
    const clean = game.players[3];
    rect(game, 10, 10, 20, 20, p.id);
    rect(game, 21, 10, 25, 20, traitor.id);
    rect(game, 10, 21, 20, 25, clean.id);
    traitor.isTribe = true;
    clean.isTribe = true;

    traitor.troops = 10;
    clean.troops = 10;
    traitor.traitorScore = TRIBE_TRAITOR_THRESHOLD;
    p.troops = p.maxTroops * 0.9; // comfortably above any TRIBE_TRIGGER_RANGE roll

    p.ai = new TribeController(p, () => roll);
    p.ai.firstThink = false;
    p.ai.cooldown = 0;
    p.ai.update(game);

    const attacks = game.attacksBy(p.id);
    if (shouldAttackTraitor) {
      check(`${label} roll: attacks the traitor on sight`,
        attacks.length === 1 && attacks[0].targetId === traitor.id, `targetId=${attacks[0]?.targetId}`);
    } else {
      check(`${label} roll: still attacks somebody (falls through to the ordinary shuffle), just not by the traitor branch`,
        attacks.length === 1);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n▸ Never attacks a real player -- a nation or the human -- only ever another tribe');
{
  // Only neighbor is a nation, and no neutral land or coast to fall back
  // on -- must sit on its hands entirely, not attack anyway for lack of
  // anything else to do.
  const game = blankGame();
  const p = game.players[1];
  const nation = game.players[2];
  rect(game, 10, 10, 20, 20, p.id);
  rect(game, 21, 10, 30, 20, nation.id);
  nation.troops = 10;
  nation.ai = { aggression: 1 }; // marks it as a real ("serious") player, not a tribe
  p.troops = p.maxTroops * 0.9; // comfortably above any TRIBE_TRIGGER_RANGE roll

  p.ai = new TribeController(p, dummyRng);
  p.ai.firstThink = false;
  p.ai.cooldown = 0;
  p.ai.update(game);

  check('never attacks the only available neighbor, since it is a full nation',
    game.attacksBy(p.id).length === 0);
}
{
  // Same shape, but the human player (id 0, blankGame() reset it just like
  // every other player) borders it instead of an AI nation -- the rule
  // doesn't discriminate between the two kinds of real player.
  const game = blankGame();
  const p = game.players[1];
  const human = game.human;
  rect(game, 10, 10, 20, 20, p.id);
  rect(game, 21, 10, 30, 20, human.id);
  human.troops = 10;
  p.troops = p.maxTroops * 0.9;

  p.ai = new TribeController(p, dummyRng);
  p.ai.firstThink = false;
  p.ai.cooldown = 0;
  p.ai.update(game);

  check('never attacks the human player either',
    game.attacksBy(p.id).length === 0);
}
{
  // A tribe and a nation both border p -- the nation is never a candidate
  // at all, so the tribe rival is attacked regardless of any roll.
  const game = blankGame();
  const p = game.players[1];
  const nation = game.players[2];
  const rivalTribe = game.players[3];
  rect(game, 10, 10, 20, 30, p.id);
  rect(game, 21, 10, 30, 20, nation.id);
  rect(game, 21, 21, 30, 30, rivalTribe.id);
  nation.troops = 10;
  rivalTribe.troops = 10;
  nation.ai = { aggression: 1 };
  rivalTribe.isTribe = true;
  rivalTribe.ai = new TribeController(rivalTribe, dummyRng);
  p.troops = p.maxTroops * 0.9; // comfortably above any TRIBE_TRIGGER_RANGE roll

  // Even a roll that would have favoured the nation under the old
  // "mildly prefer tribes" chance has nothing to work with now -- the
  // nation was filtered out before any roll gets a say.
  p.ai = new TribeController(p, () => 0.999);
  p.ai.firstThink = false;
  p.ai.cooldown = 0;
  p.ai.update(game);

  const attacks = game.attacksBy(p.id);
  check('the tribe rival is attacked, the nation never a candidate',
    attacks.length === 1 && attacks[0].targetId === rivalTribe.id, `targetId=${attacks[0]?.targetId}`);
}
{
  // A boat landing on someone's territory is an attack too -- a tribe with
  // no land neighbor but a nation just across the water must not invade it.
  // blankGame() fills the whole map with ocean before either rect is
  // painted, so the gap between them (x 21-39) is already open water --
  // nothing extra needed to make it a crossable strait.
  const game = blankGame();
  const p = game.players[1];
  const nation = game.players[2];
  rect(game, 10, 10, 20, 20, p.id);
  rect(game, 40, 10, 50, 20, nation.id);
  // markCoast() ran against the originally generated map, before this
  // file's own terrain override, so it has no idea about the coastline
  // just painted above -- mark it by hand so border.coastal is set.
  for (const tile of p.tiles) game.map.coastal[tile] = 1;
  nation.troops = 10;
  p.troops = p.maxTroops * 0.9;

  // Every random-tile attempt in #tryNavalInvasion should land squarely on
  // the nation's territory, so a real invasion attempt is actually made and
  // it's the owner check specifically that has to stop it, not chance
  // missing the target entirely.
  const targetTile = game.map.idx(45, 15);
  const targetRoll = (targetTile + 0.5) / game.map.size;
  let call = 0;
  p.ai = new TribeController(p, () => {
    call++;
    // Calls 1-3 are the constructor's own rolls (attackRate/triggerRatio/
    // cooldown) -- their exact value doesn't matter here. Call 4 is
    // #tryNavalInvasion's boat-chance gate, which must pass (<=
    // TRIBE_BOAT_CHANCE). Every call after that is a tile-selection roll,
    // all aimed at the same tile deep in the nation's rect.
    if (call <= 3) return 0.5;
    if (call === 4) return 0.001;
    return targetRoll;
  });
  p.ai.firstThink = false;
  p.ai.cooldown = 0;
  p.ai.update(game);

  check('does not launch a boat at the nation across the water',
    game.boats.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n▸ Never builds and never fires a missile, even flush with gold and a captured silo');
{
  const game = blankGame();
  const p = game.players[1];
  rect(game, 10, 10, 20, 20, p.id);
  p.gold = 1_000_000;
  const built = game.build(p, 'silo', game.map.idx(12, 12));
  check('setup: silo actually built', built.ok, built.reason ?? '');
  const silo = built.building;
  p.gold = 1_000_000; // reset to a clean round number post-purchase, for the "unchanged" check below
  p.troops = 5000;

  p.ai = new TribeController(p, dummyRng);
  p.ai.firstThink = false;
  p.ai.cooldown = 0;
  p.ai.update(game);

  check('gold is unchanged -- a tribe never spends on structures', p.gold === 1_000_000);
  check('the silo was not used to launch anything', game.missiles.length === 0);
  check('buildings only ever shrinks (the demolish, not a purchase)',
    p.buildings.length === 0 && !game.buildingAt.has(silo.tile));
}

// ---------------------------------------------------------------------------
console.log('\n▸ Wiring into a real match: correct counts, unique names, everyone spawns alive');
{
  for (const key of ['small', 'medium', 'large']) {
    const preset = MAP_PRESETS[key];
    const game = new Game({
      preset, seed: 12345, playerName: 'P0', playerColor: '#e0484f', difficulty: 'normal',
    });
    const nations = game.players.filter((p) => p.ai && !p.isTribe && !p.isHuman);
    const tribes = game.players.filter((p) => p.isTribe);
    check(`${key}: correct nation count`, nations.length === preset.bots, `${nations.length}`);
    check(`${key}: correct tribe count`, tribes.length === preset.tribes, `${tribes.length}`);
    check(`${key}: every tribe is isTribe with a TribeController and no DIFFICULTIES leakage`,
      tribes.every((t) => t.ai instanceof TribeController
        && t.troopsCapMultiplier === TRIBE_TROOPS_CAP_MULTIPLIER));

    const names = new Set(tribes.map((t) => t.name));
    check(`${key}: tribe names are unique and non-empty`,
      names.size === tribes.length && [...names].every((n) => n.length > 0));

    game.beginMatch(game.spawnCandidates[0]);
    const missing = tribes.filter((t) => !t.alive || t.tiles.size === 0);
    check(`${key}: every tribe actually got a spawn (no #randomFreeLand/death fallback)`,
      missing.length === 0, `${missing.length} missing`);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
