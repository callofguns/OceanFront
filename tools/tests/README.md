# Regression suite

Everything here was built while diagnosing and fixing real bugs (mobile touch
reliability, duplicate listeners, the land/gold economy rework, ...). Each
script is written to fail against the code it was checking before the fix
landed, not just to "look reasonable" -- treat a failure here as a real
regression, not test flakiness, until proven otherwise.

## Running it

```sh
npm install          # once, pulls in the Playwright devDependency
npm test              # starts the dev server and runs the whole suite
```

Or run one script at a time against a server you already have running:

```sh
npm start &            # dev server, defaults to :8080
BASE=http://localhost:8080 node tools/tests/browsertest.mjs
```

`npm test` (`tools/tests/run-all.mjs`) starts its own server on `:8123` (or
`$PORT`) so it never collides with a `npm start` you already have open, runs
every script below in sequence, and prints a pass/fail summary. It exits
non-zero if anything failed.

## What each script checks

| script | needs a server? | covers |
|---|---|---|
| `browsertest.mjs` | yes | Full desktop flow: spawn, economy ticking, attacking neutral land, building all five structure types, launching a nuke, proposing/accepting an alliance and the resulting attack-block and Betray option, sea trade routes, and forcing a win to check the end screen. |
| `mobiletest.mjs` | yes | Phone viewport (iPhone 13 via Playwright's device profile): no horizontal overflow, tap-to-spawn, the bottom-sheet tab bar (open/close/backdrop/auto-close-on-pick), a *real* two-finger pinch-zoom dispatched through CDP's touch input pipeline, and the PWA manifest + service worker registration. |
| `tap-and-narrow-test.mjs` | yes | The narrowest realistic phone width (375px, iPhone SE) doesn't overflow, and every button with a `:hover` CSS rule fires on exactly one real touch tap (the regression this project hit early: hover-without-a-touch-guard needs two taps on a touchscreen). |
| `dup-listener-and-outside-test.mjs` | yes | Replaying a match (`Play again`) doesn't stack a second copy of every persistent-button listener; the topbar stays the real hit-target (not the sheet backdrop) while a sheet is open; tapping outside an open sheet closes it *without* also triggering a map action; tapping inside it does not close it. |
| `tap-reliability-verify.mjs` | yes | The deepest tap-reliability regression this project hit: leaderboard/build/speed/tab buttons measured for real single-tap success during a *live* game with the HUD refreshing ~8x/sec, plus a direct check that a specific nation's row stays the same DOM node across refreshes instead of being torn down and rebuilt (which is what was dropping taps). |
| `version-tag-check.mjs` | yes | The version tag on the main menu shows `CURRENT_VERSION`, opens the release history as a popup on click (closed by default) and lists every `CHANGELOG` entry -- both read directly from `src/changelog.js`, so this never needs a manual bump when the version changes. Checked at both desktop and a 375px phone width (tap instead of click), since the popup is the same `.overlay`/`.dialog` pattern on both, not a separate mobile path: closes via the ✕ button, via clicking/tapping the backdrop, and via Escape, but *not* when clicking inside the dialog card itself; on the phone viewport also checks the dialog stays within the screen with no horizontal page overflow. |
| `difficulty-ui-verify.mjs` | yes | The difficulty picker renders Easy/Normal/Hard, persists the choice to `localStorage` and restores it on reload, and actually reaches `Game`/`AiController` (a nation's `aggression`, `goldMultiplier`, `troopsCapMultiplier` and `troopsMultiplier` all measurably increase across tiers with the same seed -- the averages here explicitly exclude tribes, whose own multipliers get their own, opposite assertion: identical across every tier, and weaker than even Easy nations'). Also checks that the attacking-troops HUD stat is hidden while idle, shows a live count during a real attack, and hides again once it settles. |
| `encirclement-test.mjs` | no | Headless correctness tests for encirclement + treasury spoils, built on exact hand-painted board states rather than hoping a real match produces one: a neutral pocket ringed by one nation is absorbed for free; a pocket touching two nations is left alone; a landlocked nation ringed by a single rival is annexed and hands over 100% of its gold; the same setup *with* a coastline is not annexed; an allied encircler does not annex; an ordinary conquest kill pays the killer 50%; a nuke-kill pays nobody; a huge open region isn't swallowed whole. Zeroes each test player's `goldMultiplier` during setup, since gold now trickles in on its own regardless of population and would otherwise drift the hand-set treasuries these assertions depend on. |
| `ai-behavior-test.mjs` | no | Headless correctness tests for the AI, on the same hand-painted-board approach: `thinkRange`/`readiness`/`strictAttacks` flow correctly from `DIFFICULTIES` (and a tier-less construction still behaves exactly as before that existed); a rival already under heavy third-party attack is preferred over an equally-affordable calm one (pile-on); a rival whose army has collapsed is preferred over a healthy one (snowball); Hard refuses a token attack under 20% of the target's troops but still retaliates when it's the one under attack; an ally is opportunistically betrayed once its army collapses, but not a healthy one and not on a bad roll; and a nation boxed in by an ally plus a rival too dense to ever attack still trips the existing "nowhere left to grow" betrayal valve. All the strength/viability comparisons here are `Player#fillRatio`-based (troops vs. own troop cap) rather than raw density, matching the AI's own `#viableRivals`/`boxedIn` gates -- see HANDOFF.md's load-bearing lessons for why density stopped being a size-neutral signal once the troop cap became a sublinear function of tiles. |
| `combat-cost-test.mjs` | no | Headless correctness tests for `Game#attackLogic()`, OpenFrontIO's exact combat/expansion math ported this round: relative-strength-scaled attacker cost (`COMBAT_RATIO_FLOOR`/`CEIL`, OpenFrontIO's own 0.6/2 bound); the defender loses troops too, from the same call, matching their density exactly; neutral land has no ratio sensitivity and no defender loss; a known traitor's territory is cheaper *and* falls faster (`TRAITOR_DEFENSE_DEBUFF`/`TRAITOR_SPEED_DEBUFF`); terrain affects pace independently from cost; a Defense Post in range is a flat, non-stacking bonus (two overlapping posts cost exactly the same as one); and a dominant nation's territory is cheaper and faster to take per tile than a small one's at identical density and troop ratio (the land-share-based big-nation "relief" curve). |
| `pop-bar-test.mjs` | yes | The HUD troop-cap fill bar (matches OpenFrontIO's own troop bar exactly, not just its layout): the troops/attacking-troops fill segments' transforms match `troops/maxTroops` and committed-troops/`maxTroops` and stack correctly (a fake in-flight attack object is pushed directly into `game.attacks` to exercise the second segment without needing real match geography); forcing troops over the cap clamps the combined fill at 100% and flags `.is-over`; the `+N/s` rate chip matches `Player#popRate`'s sign and flips to the falling style when overfull and decaying; the bar's DOM nodes (track, both fills, the overlay numbers, the rate chip) are reused across 20 refreshes rather than rebuilt -- the same DOM-churn tap-loss shape `tap-reliability-verify.mjs` checks for the leaderboard; and the bar is visible with the topbar still fitting at a 375px phone width. |
| `keyboard-pan-test.mjs` | yes | WASD/arrow-key camera panning, sped up this round to match OpenFrontIO's much snappier feel (`KEYBOARD_PAN_SPEED` in `src/config.js`, `0.75` -> `16`, roughly 45px/s -> ~960px/s): drives `UI#applyKeyboardPan` directly with a synthetic held key (camera first recentred away from the spawn-dependent clamp edge so the measurement isn't confounded by hitting the map boundary) and checks a 1-second hold covers at least 500px, several times the old rate; releasing every key stops further movement; and a long hold into a map corner at the new, larger per-step size still leaves the camera clamped to finite coordinates, not runaway or `NaN`. |
| `tribe-behavior-test.mjs` | no | Headless correctness tests for `TribeController` (`src/tribe.js`), the game's second, much weaker AI archetype, on the same hand-painted-board approach as `ai-behavior-test.mjs`: its cadence/readiness constants are difficulty-flat (identical `attackRate`/`triggerRatio` regardless of match difficulty, and weaker economy multipliers than even Easy nations); a freshly spawned tribe grabs open land on its very first think even while under its own trigger ratio, then respects that ratio afterward; it has no relative-strength viability gate at all, attacking rivals a nation's `ratio>=0.75` gate would refuse; attack sizing matches the configured flat commit fractions; it accepts every alliance offer unconditionally (including from a known traitor, and past the 2-ally cap a nation respects) and never proposes one itself; it never betrays an ally, even on the roll that would make a nation do it; it demolishes exactly one owned structure per think with no gold refund, and `Game#demolish()` itself is checked directly (wrong owner, a stale already-removed reference, successful bookkeeping, `game.dirty`); retaliation against an active attacker overrides the ordinary target search; a bordering traitor is attacked on a chance-gated roll; picking on a full nation or the human is a soft preference, not an absolute rule; a tribe never builds or fires a missile even flush with gold and a captured silo; and wiring into a real `Game` produces the exact configured nation/tribe counts per map size, unique tribe names, and every tribe actually spawning alive (no silent fallback to `#randomFreeLand()`). |
| `tribe-render-test.mjs` | yes | Tribes render distinctly from nations on the map, matching OpenFrontIO's own bot rendering: `renderer.colors[id].noBorder` is set for tribes and not for nations, a tribe's real (not hand-painted) border tile renders pixel-identical to its own interior tile -- no border stroke at all -- while a nation's border tile renders visibly brighter than its interior (the lightened border formula), and a tribe's color comes from the muted `TRIBE_COLORS` palette. Runs a real match at 3x speed so both a tribe and a nation hold genuine territory with real border/interior tiles, rather than hand-painting geometry (`game.map.baseColor`, which the border/interior blend formula depends on, isn't retroactively recomputed for a manually-overridden terrain byte, so this test reads pixels from tiles a real match actually produced). |
| `pause-menu-test.mjs` | yes | The in-match pause menu, reached from the topbar's gear button (new this round): closed by default, opens on click, and closes via the ✕. Opening it force-pauses the simulation, remembering whatever speed was running so Resume can restore it -- but if the player had already paused manually before opening the menu, Resume leaves it paused instead of un-pausing a state they chose themselves. "How to play" opens the help modal on top of the still-open pause menu. Restart Match replays the exact seed last passed to `onStart` (not a freshly re-randomized one) and drops back into spawn selection. New Game tears the match down cleanly: `window.OceanFront.game` is `null` afterward (nothing left ticking behind the hidden HUD), the speed buttons reset to 1x for next time, and a genuinely fresh match can be started right after. |
| `world-map-test.mjs` | no | Hand-authored maps, using the World map (`src/maps/world.js`) as the real case. Checks the things that would make an authored map unplayable rather than merely ugly: the grid is rectangular and uses only legend characters (and a ragged or mistyped one is rejected loudly rather than silently built into a broken world); dimensions, land share and terrain mix land where they were drawn; every authored river cell is water at full resolution **and connects through to the open sea**, which is the load-bearing one -- rivers are ordinary water, so the only way across is by boat, and a river stranded in its own ocean component is a permanent wall no fleet can reach; `findSpawnPoints` fills every slot from its real plains-with-room path rather than the degenerate any-land fallback; terrain is byte-identical whatever the match seed is, while spawns still vary with it; and a real `Game` on the map spawns everyone and can actually launch a landing force across a one-tile river channel. |
| `mutual-attack-test.mjs` | no | The mutual-attack netting in `Game#launchAttack`, ported from OpenFrontIO's exact `incomingAttacks`/`outgoingAttacks` cancellation: a new attack against a target that already has a live attack coming back the other way nets against it immediately, rather than the two running as independent attacks and boiling the border. A smaller new attack is fully cancelled (no attack object ever created, no refund -- those troops are spent meeting the bigger force); a bigger new attack absorbs the smaller opposing one whole and continues with the exact net remainder; an exact tie nets to zero on both sides (no zombie attack left dangling below `ATTACK_MIN_TROOPS`); same-direction reinforcement (already-existing behaviour) is untouched by the new branch; attacking unclaimed land is never netted against anything (there's no opposing attack possible against `NEUTRAL`); and a real all-AI match, run out under the same invariant check every tick, never produces two simultaneously-live opposing attacks between the same two players -- this last check is what actually failed against the pre-fix code (caught a real violation from a genuine match, not just the hand-painted cases). |
| `pacing-sweep.mjs` | no | **Not a pass/fail check** -- a balance-tuning tool. Runs several seeds across every map size × difficulty combination and prints average match length, structures built, gold, and tick cost. Run it before and after a `config.js` balance edit and diff the two outputs; that is the actual verification step, this script just produces the numbers. Not part of `npm test` because a full sweep takes a couple of minutes and has nothing to assert pass/fail on. |

`tools/simulate.js` (one level up, not in this directory) is the other
headless tool: a single-match play-through with a running log and a final
report, useful for a quick sanity check or profiling one seed in detail.
`npm run test:sim` runs it with defaults; see its own header comment for
flags (`--size`, `--seed`, `--minutes`, `--difficulty`).

## Environment variables

- `BASE` -- the dev server URL every browser script points at. Defaults to
  `http://localhost:8123` to match what `run-all.mjs` starts, so if you're
  running scripts individually against `npm start`'s default `:8080`, set it
  explicitly.
- `SHOTS` -- where screenshot-taking scripts write their PNGs. Defaults to
  `path.join(os.tmpdir(), 'oceanfront-test-shots')`.
- `PORT` -- which port `run-all.mjs` starts its own server on. Defaults to
  `8123`.

## Playwright resolution

`tools/tests/lib/browser.mjs` tries the normal `playwright` package first
(works after `npm install`, anywhere), and falls back to a fixed sandbox path
only if that import fails. The fallback exists purely for the sandboxed
environment this suite was originally developed in, where Playwright is
preinstalled globally rather than through `package.json` -- it's a no-op
everywhere else.

`package.json` pins an **exact** Playwright version rather than a `^` range
on purpose: each Playwright release expects a specific browser binary
revision, and a newer minor version can ask for one that isn't downloaded in
a given environment, failing with `Executable doesn't exist at ...`. If that
happens, either run `npx playwright install chromium` to fetch the matching
browser, or (in an environment with browsers preinstalled at a fixed
Playwright version, like this project's original sandbox) pin `package.json`
back down to that exact version instead.

## Adding a new regression test

If you fix a bug this way again: write the test so it demonstrably fails
against the old code first, save a copy, fix the bug, confirm the test now
passes, then commit both together and add a row to the table above. A fix
without a test that would have caught it is not verified, it's hoped.
