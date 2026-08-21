# Hand-off

Context for a new Claude Code session picking up OceanFront. Read this first;
it's a summary of decisions and gotchas from the session that built this
project, not a replacement for `README.md` (player-facing rules) or
`tools/tests/README.md` (how to verify a change).

## What this is

OceanFront is a real-time territory-expansion browser game (OpenFront /
Territorial.io-style): claim a coastline, expand tile by tile, grow an army
that IS your whole population, build structures, and optionally nuke, ally
with, or betray the AI nations around you. Zero runtime dependencies --
vanilla ES modules served by a tiny static file server (`server.js`),
simulated at a fixed tick rate independent of rendering.

## Current state

On `main` (or `Update-Testing`, staged for a later merge -- check which with
`git log`). Latest version tag in-game is whatever `CURRENT_VERSION` says in
`src/changelog.js` -- check there and with `git log -1` for the exact commit,
rather than trusting a hash written here, since both move. As of this
hand-off that's **v2.6.0-beta** on `main`, with ten more hand-authored maps
(the six continents plus four original pattern/arena maps) merged into
`Update-Testing` on top of it, not yet released under a bumped version (see
the load-bearing lessons below). Whether any
recent version has been cut as a GitHub release is worth asking the user
rather than assuming (see below -- this session can't push tags itself, so
there's no way to check from git alone).

## Standing workflow rules

These came from explicit instructions earlier in the project and are easy to
lose track of -- follow them until told otherwise:

- **A feature branch off `Update-Testing` for every update, merged back into
  `Update-Testing` as soon as it works, merged into `main` only on explicit
  go-ahead once a batch of updates has been played together there.** This
  workflow has moved around: distinct per-feature branches early on
  (`claude/mobile-pwa-...`, `claude/tap-reliability-fixes-...`), then a
  single reused `test` branch, then a stretch of pushing straight to `main`,
  then a branch-per-update rule forking from `main` itself. Current shape,
  laid out explicitly by the user as a "GitHub production line":
  1. For each new piece of work, branch off `Update-Testing`'s *current*
     state (not `main`) -- `git fetch origin Update-Testing && git checkout
     -B feature/<slug> origin/Update-Testing` for a new feature, or
     `bugfix/<slug>` for a fix, named clearly (`feature/player-movement`,
     `bugfix/jump-glitch`). Do the work, verify it (`npm test`, plus
     whatever targeted checks the change calls for), and commit with clear,
     actionable messages -- never "fixed stuff"/"update", say what changed
     ("Add double jump mechanic", "Fix audio bug on start screen") -- with
     each commit kept focused on one specific thing rather than bundling
     unrelated changes together. Push the branch.
  2. **Automatically, without waiting for the user, as soon as the branch
     works:** fetch and check out `Update-Testing`, merge the finished
     branch into it, resolve any conflicts (regenerate rather than
     hand-merge any generated files, same as this project's general
     merge-conflict practice), and push `Update-Testing`. **Do not touch
     `CURRENT_VERSION` or add a `CHANGELOG` entry at this step** -- see the
     version-bump bullet below, that now happens only at push-to-main time,
     specifically so several rounds of work can pile up on `Update-Testing`
     under one still-unbumped version before it ships as one release with
     more in it. Do this merge promptly per update rather than batching
     several branches unmerged -- the point is for `Update-Testing` itself
     to accumulate a few played-together updates, not for branches to pile
     up unmerged.
  3. Leave `main` untouched until the user explicitly says to merge (e.g.
     "push to main"). That go-ahead means `Update-Testing`, with everything
     accumulated on it since the last release, has been played/verified and
     is ready to ship -- **at that point**, and not before: ask the user
     for the version number (see below), write one `CHANGELOG` entry in
     `src/changelog.js` covering everything accumulated since the last
     release (every round merged into `Update-Testing` since then, not
     just the most recent one), bump `CURRENT_VERSION`, commit that, then
     merge `Update-Testing` into `main` and push.
  No PR unless separately asked. Do that unless told the rules changed
  again.
- **Releases use Semantic Versioning (`vMAJOR.MINOR.PATCH`), the user picks
  the version number, and the bump only happens at push-to-main time.**
  Two rules stacked here, both from explicit user instruction: the version
  number itself is the user's call, not the session's (ask rather than
  decide); and unlike earlier in this project, a `CURRENT_VERSION` bump and
  its `CHANGELOG` entry are **not** written per feature round as it lands
  on `Update-Testing` -- they wait until the user actually says "push to
  main," at which point the entry summarizes the whole batch that
  accumulated, not just the last thing merged. This is deliberate: it lets
  a release carry more in it instead of a version bump for every single
  round. `src/changelog.js`'s `CHANGELOG` entry is still written as a
  bulleted "what's new" list and still doubles as the source material for
  the GitHub release's patch notes -- only *when* it gets written changed.
- **Releases are automated -- `.github/workflows/release.yml` tags and
  publishes on every push to `main`.** A Claude Code session still can't
  push a git tag directly (confirmed HTTP 403 from GitHub across many
  attempts, not a proxy/egress issue -- branch pushes over the identical
  connection succeed; no GitHub MCP tool creates tags/releases either), but
  Actions' own `GITHUB_TOKEN` isn't subject to that block. The workflow
  reads `CURRENT_VERSION` from `src/changelog.js` (see
  `.github/scripts/release-info.mjs`, runnable/testable standalone) and
  creates that tag + a GitHub release from that version's `CHANGELOG` entry
  -- but only if that version isn't tagged yet, so it's a clean no-op on
  every push that doesn't bump the version. Bumping `CURRENT_VERSION`
  correctly (see the SemVer bullet, above) is still a human/authoring
  decision made when the changelog entry is written -- the workflow doesn't
  guess a bump from a diff, it just stops a correctly-bumped version from
  ever going untagged. So: get the version bump and changelog entry right
  before merging to `main`, and the release itself takes care of itself.
- **Never open a pull request unless explicitly asked.**
- **When the user references OpenFrontIO (by name, "open front", or similar),
  go read its actual source on GitHub and copy the real code/mechanics --
  don't paraphrase from memory or a summary.** `add_repo` (owner
  `openfrontio`, repo `OpenFrontIO`) gives read access and a clone command
  even though it isn't in this session's attached-repo list -- it's a public
  repo the git proxy serves anonymously. Clone it shallow
  (`GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 ...`) and grep/read it
  directly rather than guessing file paths one `curl` at a time against
  `raw.githubusercontent.com` -- much faster once cloned, and lets you
  actually search (`grep -rl`) for the right file instead of probing paths
  blind. This project's whole population/combat model (v2.0.0-beta) and the
  Tribes archetype (v2.2.0-beta) were both built this way; the tribe
  rendering pass (muted `botColors`-derived palette, no border stroke) came
  from directly reading `src/client/theme/ThemeProvider.ts` and
  `default-theme.json` this same way, not guessing. Always port the
  mathematical/mechanical *shape*, then re-derive constants anchored to
  OceanFront's own scale -- see the rescaling lesson below -- and never let
  OpenFrontIO's own name appear in anything player-facing (`src/changelog.js`
  entries, in-game text); it's fine in code comments and this file.
- **Avoid em dashes entirely and limit semicolons, in every piece of writing
  from here on.** Applies to player-facing text first (`index.html` copy,
  `src/changelog.js` notes) and to new prose written for docs/comments/commit
  messages generally. Use a period, comma, or colon instead of an em dash.
  Existing docs and code comments have not been swept for this
  retroactively (there are plenty left in this file, `styles.css`, and
  elsewhere) except where a file was already being touched for another
  reason. Fix them opportunistically when you're in a file anyway, not as a
  standalone sweep unless asked.
- **The Apple-style UI overhaul (v2.3.0-beta) is done.** Monochrome base
  palette (`styles.css`'s `--bg`/`--panel`/`--edge`/`--ink*` tokens, all
  true neutral grey now, not blue-tinted), color kept only where it's
  semantic (`--accent`/`--gold`/`--danger`/`--good`), the system font stack
  for real San Francisco on Apple devices, a real spacing scale
  (`--space-1` through `--space-6`), and a role-based radius scale
  (`--radius-lg`/`--radius`/`--radius-sm`). Researched against OpenFrontIO's
  actual design system and menu inventory (see the bullet above), then
  deliberately scoped down to what a single-player-vs-AI game actually
  needs -- see the plan history for the full list of what was cut and why
  (accounts, store, teams, chat, graphics/sound settings, a radial context
  menu, none of which OceanFront has the underlying system for).
- **The main menu is now a real landing page, not a floating dialog.**
  `#startscreen` was rebuilt to match how OpenFrontIO's own landing page is
  actually built (read off `PlayPage.ts`/`GameModeSelector.ts`/
  `DesktopNavBar.ts`/`Footer.ts`): a slim top bar, a colour-washed hero
  identity block, a big card grid for the one choice that deserves that
  weight (world size, since a single-player game has no separate
  lobby-browser step the way OpenFrontIO does), and a footer -- instead of
  `.overlay`'s shared centered-card look. `#startscreen` overrides just
  `.overlay`'s display/background/padding by ID, so `#endscreen` and the
  popups keep the original centered-card treatment untouched. The page is
  now genuinely taller than one phone screen by design, the same way
  OpenFrontIO's own landing page requires scrolling to reach `SOLO` --
  `tools/tests/tap-and-narrow-test.mjs`'s raw-CDP-touch `realTap()` helper
  needed one line (`scrollIntoViewIfNeeded()`) added to keep working, since
  unlike `page.click()`/`page.tap()`, a raw `Input.dispatchTouchEvent` does
  not auto-scroll its target into view first. Worth remembering for any
  future test that dispatches touch events directly against CDP rather
  than through Playwright's own click/tap helpers.

## Architecture at a glance

- `src/config.js` -- every tunable number in the game lives here. Changing
  balance should almost always mean editing a constant here, not scattering
  magic numbers through the logic.
- `src/game.js` -- the simulation: tick loop, combat, encirclement, boats,
  missiles, buildings, trade. No DOM, no rendering; runs identically headless
  or in a browser.
- `src/player.js` -- a nation's troops (population is troops-only -- see the
  load-bearing lessons below), troop cap and growth, gold income.
- `src/ai.js` -- full-nation bot decision-making, re-evaluated every few
  seconds per bot.
- `src/tribe.js` -- the second, much weaker AI archetype (`Player#isTribe`).
  Small, lazy bands that occupy open land early, sign any pact but never
  propose one, demolish anything they capture, and pick fights with no
  relative-strength gate at all. Deliberately independent of `ai.js` --
  its own tiny border scan, no shared refactor -- and never reads
  `DIFFICULTIES`; see the tribes block in `config.js`.
- `src/map.js` -- both map paths: `generateMap()` builds a world from noise,
  `buildAuthoredMap()` scales up a hand-drawn ASCII grid. Both return the
  same `GameMap`, so nothing downstream knows or cares which ran.
- `src/maps/` -- hand-drawn maps as plain ASCII grids, one character per
  cell. Edit them directly; `tools/map-preview.mjs` renders one to a PNG so
  the result can actually be looked at while editing.
- `src/render.js` / `src/ui.js` -- canvas drawing and all DOM/input wiring,
  including the mobile bottom-sheet layout and touch handling.
- `tools/simulate.js` -- headless single-match runner with a report at the
  end (`npm run test:sim`). Good for a quick sanity check or profiling one
  seed.
- `tools/tests/` -- the committed regression suite; see its own README.

## Load-bearing lessons

Things that were each rediscovered the hard way once already -- don't
rediscover them a second time.

- **Population is troops-only now -- there is no rebalancer to route around.**
  Until v2.0.0-beta, a `MIGRATE_RATE` rebalancer in `src/player.js` pulled a
  troops/workers split back toward a target ratio every tick, so any "bonus"
  mechanic had to shift that *target* rather than add troops directly, or it
  leaked away. That whole mechanism -- workers, the slider, `MIGRATE_RATE`,
  troop momentum -- is gone. `Player#troops` is the entire population now;
  mutate it directly, the old workaround no longer applies and would just be
  dead code if reintroduced.
- **Porting a formula from a game with a different map scale means rescaling
  it, not copying its constants.** OpenFrontIO's own numbers (a 50,000-troop
  base, mag values of 80-120, a 150,000-tile sigmoid midpoint) are calibrated
  to maps where a single nation can own >100,000 tiles; OceanFront's largest
  map has ~87,600 tiles total, shared. Copying the literal constants would
  have inflated troop counts by ~1000x and made every other tuned constant in
  `config.js` (density-based combat costs, terrain values) meaningless
  overnight. The fix: port the exact mathematical *shape* (exponents, the
  ratio between terms, the multiplicative structure), then re-derive new
  constants anchored to OceanFront's own scale -- pick a representative
  "typical nation" size, solve for constants that reproduce something close
  to the *current*, already-tuned behavior at that one point, and let the
  curve's shape (usually sublinear/diminishing-returns, unlike a straight
  line) diverge naturally away from it. Cross-checking a freshly-derived
  constant against an *existing*, already-tuned one for the same concept
  (this round: the new city-troop-bonus constant landed within ~15% of the
  old `BUILDINGS.city.popBonus` it replaced, derived completely
  independently) is a strong sanity check that the anchoring approach itself
  is sound, not just a lucky guess.
- **A formula that reads as "makes X tougher" from its variable names might
  do the opposite -- reread the actual math, not the comments.** OpenFrontIO's
  defense-debuff sigmoid was initially assumed (including in a question put
  to the user) to make large defenders harder to attack, since the variable
  is named `defenseSig` and multiplies into `largeDefenderAttackDebuff`.
  Actually deriving `sigmoid()`'s output at both ends showed the opposite: it
  *decreases* the attacker's cost/pace as the defender's land share grows,
  making a dominant nation *easier*, not harder, to chip away at -- a
  reinforcement of this project's existing density-based anti-snowball
  design, not a competing force. Trust the arithmetic over what a name or a
  comment implies it does, especially before asking the user to weigh a
  tradeoff based on that assumption.
- **A viability heuristic built on `density` can silently invert when the
  population formula's shape changes.** `troops / tiles` used to be roughly
  size-independent (any nation near its cap settled around the same density
  regardless of how big it was, since the old cap was linear in tiles).
  Switching `maxTroops` to a sublinear function of tiles broke that: a big
  nation's *equilibrium* density is now naturally lower than a small one's,
  purely from size, not from being less militarized. Every AI heuristic that
  compared raw `density` between two nations to answer "is this one strong
  for its size" (the `#viableRivals` target gate, the `boxedIn` check, the
  ally-betrayal "worth it" gates) needed to switch to `troops / maxTroops`
  (a new `Player#fillRatio` getter) instead -- density stays exactly right
  for what the real combat formula charges per tile (`Game#attackLogic`
  still uses it directly, correctly), but stops being a good *size-neutral*
  strength signal the moment the underlying population curve stops being
  linear. Any future change to the population formula's shape is worth
  re-checking every AI heuristic that compares two nations' `density` for
  this same silent-inversion risk.
- **Live-updating DOM nodes must be reused, never rebuilt.** Rebuilding the
  leaderboard (or similar) with `replaceChildren()` on every refresh was
  silently dropping 0-33% of taps, because a tap's `pointerdown` and
  `pointerup` could land on two different DOM elements if the node was
  replaced mid-press. Fix: keep a `Map` of persistent row elements, update
  their content in place, and never destroy an element a finger might be on.
- **CSS `:hover` needs `@media (hover: hover)`.** Without that guard, the
  first tap on a touch device only applies the `:hover` state and a second
  tap is needed to actually activate -- looks exactly like "the button is
  broken," isn't.
- **The service worker is network-first-with-cache-fallback on purpose.** A
  cache-first strategy means shipped fixes never reach installed users. Don't
  revert this without a good reason, and bump the cache version string in
  `sw.js` on any change to it.
- **Playwright's synthetic `PointerEvent` isn't a real pointer to Chromium.**
  `new PointerEvent()` + `dispatchEvent()` doesn't back `setPointerCapture()`
  the way a real input does. Use `page.mouse.click()` for mouse-equivalent
  taps, or CDP's `Input.dispatchTouchEvent` (see `tools/tests/mobiletest.mjs`)
  for anything that needs to be genuinely multi-touch, like pinch-zoom.
- **A tighter AI viability gate can freeze the whole map, not just one
  matchup.** Adding a stricter "is this attack worth it" check to `#makeWar`
  in `src/ai.js` shifted enough early-game decisions that a rare late-game
  shape became reachable: two mutually allied "giants," each also allied
  with a small nation too densely defended for anyone to ever clear the
  `ratio >= 0.75` viability gate -- so nobody had a legal attack left, ever.
  The fix wasn't tuning the new check's threshold (that just moved which
  seeds broke); it was noticing the existing "boxed in, break an alliance"
  valve only checked whether every neighbour was an *ally*, not whether every
  neighbour was an ally *or unreachable anyway* -- those are the same dead
  end and both need to trip it. Any new attack-eligibility filter is worth
  pacing-sweeping across every map size and difficulty specifically looking
  for `stalled` results, not just checking that pacing looks reasonable on
  average.
- **A test predicate that means "the bots" silently absorbs a second AI
  archetype the day one exists.** `tools/tests/difficulty-ui-verify.mjs`'s
  cross-tier monotonicity check used `p.ai && p !== g.human` to mean "every
  non-human player" -- true right up until Tribes (`src/tribe.js`) added a
  second class of player that also carries a non-null `.ai`. Tribes are
  deliberately difficulty-*flat* (see the tribes block in `config.js`), so
  folding them into a difficulty-*monotonicity* average diluted it toward
  breaking, and `.ai.aggression` doesn't even exist on a `TribeController`,
  so the average itself came out `NaN`. Fixed by adding `&& !p.isTribe`, but
  the general shape is worth remembering: any predicate meant to select "the
  AI-controlled players" (not just this one) needs revisiting the moment a
  second AI archetype exists, and a completely new player archetype is worth
  grepping the test suite for `.ai` truthy-checks before assuming it slots
  in cleanly.
- **A flex container centering an overflowing item with `overflow-y: auto`
  clips the top, and that clipped part cannot be reached by scrolling.**
  `.overlay` (the start screen, end screen, and the changelog popup) uses
  `align-items: center` to center `.dialog`. Fine when the dialog fits the
  viewport. Once it's taller (a phone with the full main-menu form and
  actual browser chrome eating real height), the browser centers it by
  overflowing equally above and below, `overflow-y: auto` only ever lets
  `scrollTop` grow positive, so the part that overflowed upward stays
  permanently out of reach. This is a real, common CSS gotcha, not specific
  to this project. The bug report was "the main menu gets cut off at the
  top on mobile and doesn't scroll." Fixed by switching `.overlay` to
  `align-items: flex-start` under the existing mobile breakpoint
  (`tools/tests/tap-and-narrow-test.mjs` now checks the dialog's top is
  never clipped and the bottom is reachable by scrolling, at 375x667).
  Worth checking again if `.overlay`/`.dialog` content grows taller, or if
  the same `align-items: center` + `overflow: auto` shape gets reused
  anywhere else.
- **A visual restyle should never need to touch an id or class the test
  suite reads.** Before the v2.3.0-beta redesign, every `.mjs` file in
  `tools/tests/` was grepped for `getElementById`/`querySelector` to build
  an explicit list of load-bearing selectors (`#pop-bar-troops`, `.lb-row`,
  `.speed-btn[data-speed]`, the `:nth-child` ordering on the pickers, and
  around thirty more). The whole redesign -- new tokens, new radius/spacing
  scale, two new modals, a restructured main menu -- landed with every one
  of those unchanged, and the entire existing suite passed without a single
  test edit. That's the actual point of keeping presentation (CSS custom
  properties, radius/spacing values) and structure (ids, classes, DOM
  shape) as separate concerns: a future restyle should be able to do the
  same, and a future *structural* change should budget for updating the
  tests deliberately rather than discovering it broke them by accident.
- **A HUD element that changes width needs its overflow budget re-measured,
  not estimated.** Adding the pause-menu gear button to `#topbar` pushed
  its `scrollWidth` from 365px to 381px at the 375px viewport
  `tap-and-narrow-test.mjs`/`pop-bar-test.mjs` both assert against --
  looked like plenty of headroom until it wasn't. Reproduced with a small
  throwaway script reading `#topbar`'s real `scrollWidth` rather than
  guessing pixel budgets by eye, which is also how the fix (shrinking the
  new button and a couple of existing ones specifically at the narrowest
  breakpoint) was verified. The same applies in the other direction: adding
  height to `.dialog` (the main menu grew a `.menu-section-title` per group
  plus a footer) pushed `#btn-start` low enough to clip below a real
  390x844 phone's fold, caught by `document.elementFromPoint()` returning
  `null` at the button's own tap coordinates in a debug script, not by
  reasoning about it. Any change to a HUD element's size or a dialog's
  height belongs in one of these two same measurement scripts before
  trusting it fits.
- **`ui.onStart`/`ui.onSpeed`/`ui.onExit` -- main.js owns the match
  lifecycle, `UI` only ever asks for it through a callback.** `UI` has no
  reference to `main.js`'s `game`/`renderer` closure variables, by design
  (`src/game.js` and `src/render.js` know nothing about the DOM, and
  `src/ui.js` isn't supposed to reach into `main.js`'s internals either).
  Before `onExit` existed, there was no way to stop a live match from
  inside `UI` at all -- the pause menu's "New Game" needed one so `main.js`
  can null its own `game`/`renderer` and reset `accumulator`/`speed`/
  `endShown`, otherwise the old match would keep ticking invisibly behind
  the main menu (the frame loop only checks its own closure vars). Restart
  Match didn't need a new callback at all -- it just calls `onStart` again
  with the exact options `UI` already snapshotted from the first call
  (`this._lastStartOptions`), reusing the one path `main.js` already had
  for starting a match rather than inventing a second one. Any future UI
  action that needs to affect the match lifecycle should look for a fit in
  `onStart`/`onSpeed`/`onExit` first, and only add a new callback if none of
  them actually cover it.

- **Rivers are ordinary water tiles, and that is deliberate.** OpenFrontIO
  has no river terrain type either (`TerrainType` is
  `Plains, Highland, Mountain, Ocean, Impassable`), and its attack execution
  skips every water neighbour outright, so rivers there block land attacks
  exactly like open sea. OceanFront matches that: a river is `OCEAN`, an
  army cannot cross one, and `src/ui.js` already falls through from
  `game.borders()` to `game.launchBoat()`, so clicking a rival across a
  river naturally launches a boat. Deliberately **not** ported:
  OpenFrontIO's `shoreReachableNeighbors()` (which counts players separated
  by up to 4 water tiles as neighbours, for its relations graph only).
  Wiring that into `Game#borders()` here would make `borders()` return
  true, `launchAttack` would fire, and `#seedFrontier` skips ocean
  neighbours -- so the attack would seed an empty frontier and silently eat
  the committed troops. That is a bug, not a feature.
- **An authored river MUST reach the sea, and that is enforced in code, not
  by eye.** Because a river is just water, the only way across is a boat,
  and `Game#findWaterPath` can only route through water connected to the
  water it launched from. A river stranded in its own ocean component is
  therefore not a crossing at all, it is a wall no fleet can ever reach.
  Authored geography makes that trivially easy to do by accident: a single
  diagonal land bridge sealed the whole Mediterranean on the first draft of
  the world map, stranding the Danube, Volga and Nile together. Hand-fixing
  the grid turned into whack-a-mole, so `connectRiversToSea()` in
  `src/map.js` now guarantees the invariant for every map, and
  `authored-maps-test.mjs` asserts it on every authored map that carries a
  river. Bodies of water the author drew as enclosed still stay inland
  lakes -- only components holding a *carved river* get joined up.
- **`labelOceans()` clears `oceanComponent` before filling.** It used to
  skip any tile already carrying an id, which is fine when it runs once but
  silently wrong on a second pass: newly carved water got fresh ids while
  the bodies it had just joined kept their old, separate ones, so a merge
  looked like it had done nothing. Anything that changes terrain after the
  first labelling has to re-label, so the function has to be safe to
  re-run.
- **Watch for float32 round-trips in map code.** The authored-map pipeline
  stores its coarse height field in a `Float32Array`, and a
  `coarse[i] <= AUTHORED_HEIGHT[OCEAN]` test against the double it was
  written from is always false: `float32(0.18)` is `0.180000007...`. That
  one silently disabled river-mouth carving and cost a debugging round.
  Where a typed array holds a value that later needs comparing for
  equality, record the fact in a separate flag array instead.
- **Two independent `Attack` objects fighting the same border is what
  boils it.** Before this fix, `A→B` and `B→A` coexisted in `this.attacks`
  with zero interaction -- each side's frontier logic handed straight back
  exactly what the other just took, sometimes flipping one tile twice in a
  single tick, and neither side's budget was sensitive enough to relative
  strength to converge (a losing side's growing, ragged frontier actually
  *increased* its own budget -- an oscillator, not a damper).
  `Game#launchAttack` now ports OpenFrontIO's real fix exactly
  (`AttackExecution.ts`'s `incomingAttacks`/`outgoingAttacks`
  cancellation): a new attack immediately nets against any existing attack
  running the other way between the same two players -- smaller pool
  fully cancelled with no refund, larger pool reduced by the smaller
  pool's size and continues. This is a structural invariant (there is
  never more than one live attack between the same two players), not a
  tuning knob -- any future change to attack creation has to preserve it.
  `tools/tests/mutual-attack-test.mjs`'s real-match check (running a
  genuine all-AI match and asserting the invariant every tick) is the
  fastest way to notice if it broke -- the hand-painted cases alone missed
  a real violation that check caught on the first try.

## How to verify a change

```sh
npm install && npm test      # full committed regression suite
npm run test:sim             # one headless match with a summary report
node tools/tests/pacing-sweep.mjs "label"   # balance sweep, run before/after a config.js edit and diff
node tools/map-preview.mjs --size=world     # render a map to a PNG to look at
node tools/map-preview.mjs --size=world --crop=200,50,150,120 --zoom=3   # inspect at tile scale
```

Full details, including what each test actually checks, are in
`tools/tests/README.md`.

## Known open items

- **v2.0.0-beta's new constants are a first-pass calibration, not a fully
  matured balance.** Every new number in `config.js`'s economy/combat
  sections (`TROOPS_TILE_SCALE`/`TROOPS_BASE`, the growth-rate constants,
  `TERRAIN_MAG`, `GOLD_BASE_RATE`, the Defense Post's new cost, the
  big-nation sigmoid's midpoint/decay) was derived by anchoring to a
  representative nation size and cross-checked against `pacing-sweep.mjs`
  once (no stalls, no sub-3-minute blowouts, `medium/normal` and
  `large/normal` landed almost exactly on the pre-rework baseline after one
  `TERRAIN_MAG` correction) -- but a change this size touching nearly every
  numeric system in the game warrants more real playtesting than one
  session's sweep-and-eyeball pass can give it. If pacing or a specific
  matchup feels off, `TERRAIN_MAG` (overall combat cost/speed) and
  `TROOPS_TILE_SCALE`/`TROOPS_BASE` (overall population scale) are the two
  broadest levers, per the same pacing-sweep methodology as always.
- **`small/hard` in `pacing-sweep.mjs`** used to read at a marginal 2.6
  minutes; adding tribes (below) pushed it to ~3.1 minutes as a side effect
  (more contestants for the same land), which happens to resolve the old
  "no sub-3-minute blowout" flag on its own -- not something that was
  specifically tuned for, just worth knowing why the number moved.
- **Tribes' new constants (`src/tribe.js`, the tribes block in
  `config.js`) are a first-pass calibration, not a fully matured balance.**
  `TRIBE_THINK_RANGE`/`TRIBE_TRIGGER_RANGE`/`TRIBE_SERIOUS_SKIP_CHANCE`/
  `TRIBE_TRAITOR_ATTACK_CHANCE` are direct ports of the archetype's own
  upstream randomization ranges and define *what a tribe is* -- don't tune
  those casually, changing them changes the archetype, not the balance.
  `MAP_PRESETS.*.tribes` (the per-map tribe count) and
  `TRIBE_TROOPS_CAP_MULTIPLIER`/`TRIBE_TROOPS_MULTIPLIER`/
  `TRIBE_GOLD_MULTIPLIER` are the real retune levers, in that order, if
  pacing needs it -- checked once against a full `pacing-sweep.mjs` run
  (zero stalls across all 45 size/difficulty/seed combos, every tribe slot
  spawned successfully every time, land claimed stayed ~99%+, and average
  tick time actually *dropped* almost everywhere despite the larger player
  count, since a tribe's think cadence is far lazier than a nation's) but
  not yet played by a human. If a match feels too crowded or too empty
  early on, `MAP_PRESETS.*.tribes` is the first thing to adjust.
- **The nation/tribe AI was reworked to match OpenFrontIO's real system**
  (aggression, tribe targeting, spawn scale) -- researched directly against
  their actual source, not assumed, and it landed somewhere different from
  a literal copy in two specific, deliberate ways worth knowing about.
  - **Aggression**: the old invented `aggression`/`expansionism` personality
    traits (rolled per bot, difficulty-scaled) are gone --
    `expansionism` was dead code the whole time (rolled, never read).
    `AiController` now rolls `triggerRatio`/`reserveRatio`/`expandRatio`
    (config.js's ai section) exactly like OpenFrontIO's `NationExecution.ts`/
    `TribeExecution.ts`: **the same range for every difficulty tier, not
    scaled by it** -- that's their real design, ported faithfully.
    `reserveRatio` is a hard floor (never attack below it); `triggerRatio`
    a softer one (a flat 10% chance to attack anyway below it); commit
    size is `troops - maxTroops*ratio` (send everything above a reserve),
    not the old flat fraction-of-current-troops. `aggression` itself
    survives as a diplomacy-only dial (betrayal chance) -- it no longer
    touches attack targeting or sizing at all.
  - **Tribe/nation interaction**: nations now hunt bordering tribes
    (`#attackNearbyTribes`, OpenFrontIO's `attackBots()`) in parallel with
    -- not instead of -- one ordinary attack, up to `AI_TRIBE_PARALLELISM`
    simultaneous tribe fights, discounted `TRIBE_DEFENSE_DISCOUNT` (0.7x
    `mag` in `attackLogic()`, their exact number). `#findRetaliation`
    (`findIncomingAttackPlayer`) makes a nation fight back against its
    biggest current attacker ahead of everything else, bypassing the
    normal viability gate -- but ignores tribe attackers, since
    `#attackNearbyTribes` already owns that. One non-obvious fix needed to
    make the "independent" part actually true: tribes had to be excluded
    from `#viableRivals` entirely, because a tribe `#attackNearbyTribes`
    just hit (committing `troops*4`) instantly looks like a `#findVictim`
    "under heavy attack" target to the very same think-cycle's ordinary
    chain -- without the exclusion, a nation would just reinforce its own
    tribe attack forever instead of ever reaching a real rival.
  - **Spawn scale is 100, not OpenFrontIO's literal 400**, deliberately.
    `TRIBE_TARGET_COUNT` (config.js) is one flat number requested on every
    preset -- that flat-everywhere shape *is* OpenFrontIO's real design --
    but 400 itself assumes their own `SpawnExecution`'s fixed,
    non-relaxing minimum spawn distance, which just spawns fewer bots than
    requested once a map fills up. OceanFront's `findSpawnPoints`
    (src/map.js) instead relaxes its minDist floor until the request is
    met, so it does not degrade the same way: measured directly, 400 on
    the small preset (26k land tiles) leaves an idle human with zero
    neutral border tiles within 100 ticks in every seed tried -- boxed in
    immediately, not a cosmetic issue (`no neutral border tile found`
    actually broke `browsertest.mjs`'s live "attack neutral land" step).
    100 was verified the same way to leave 20-28 neutral border tiles on
    every preset from small through World. If tuning this further,
    `TRIBE_TARGET_COUNT` and `AI_TRIBE_PARALLELISM` are the two levers, in
    that order.
  - **`TERRAIN_MAG` was cut a further 40%** (4.5/5.6/6.75 down to
    2.7/3.36/4.05 -- see its own comment in config.js for the full
    derivation) for a reason unrelated to tribes at all: the real
    triggerRatio/reserveRatio system makes every bot, Hard included, wait
    for a noticeably fuller army before attacking than the old
    difficulty-scaled `readiness` ever did. Verified in isolation (`tribes:
    0`, so purely the aggression-system change): `large/hard` --
    previously OceanFront's *fastest* combo at ~5.5min average -- started
    occasionally blowing through pacing-sweep's 30-minute cap with no
    winner. Since the new ratios are deliberately not a difficulty lever
    (matching OpenFrontIO), they're the wrong place to compensate;
    `TERRAIN_MAG` is the already-established broad pacing lever, so this
    round pulled it again rather than inventing a bespoke fix. Re-verified
    clean afterward: zero stalls, zero sub-3-minute blowouts across all 9
    small/medium/large x easy/normal/hard combos, both with the new tribe
    scale and in isolation.
  - Screenshotted (World map, Hard, several thousand ticks in): reads as a
    real, active multi-nation war -- betrayals, nuclear strikes, a nation
    wiped off the map -- not a degenerate patchwork, and by that point in
    the match only a handful of the 100 tribes were still alive, which is
    `#attackNearbyTribes` doing its job rather than a bug.
- **The World map (v2.5.0-beta) is a first authored map, verified but not
  played by a human.** `tools/simulate.js --size=world` across several seeds
  lands at 4.0 to 6.8 game-minutes against `medium`'s 4.7 to 6.1, with lower
  tick cost and no stalls, and it holds ~40% land against the procedural
  generator's 46%. Land claimed does settle a little lower than a generated
  map's (83 to 99% versus 99.9%), which is expected: rivers and island
  chains leave pockets that are awkward to reach. The map itself is
  `src/maps/world.js` and is plain hand-editable data, so anything that
  reads wrong is a character edit away. `AUTHORED_*` in `src/map.js` are the
  levers for how the whole pipeline renders: `AUTHORED_SEA` for how fat the
  continents come out, `AUTHORED_NOISE`/`_COARSE` for how crinkled the
  coastlines are, `AUTHORED_RELIEF` for shading variation, `RIVER_MEANDER`
  for how much rivers wander.
- **Ten more hand-authored maps (six continents, four original pattern
  maps) were added the same way World was, not copied from OpenFrontIO.**
  OpenFrontIO's own map roster (118 maps, `Maps.gen.ts`) and its map
  terrain data specifically (not just their code) are CC BY-SA 4.0 licensed
  with required attribution -- researched directly against their actual
  repo before deciding, same as always when OpenFrontIO comes up. Literally
  importing their compiled map files would still be forking another
  project's specific derived creative content wholesale, which is a
  different kind of thing than every other OpenFrontIO round this project
  has done (porting mechanics/formulas, never assets), and it would break
  this project's own already-established precedent: World is documented
  above as OceanFront's own hand-drawn interpretation, not a copy of
  anything. This round is the same move repeated ten more times -- Africa,
  Asia, Europe, North America, South America, Oceania (real, familiar
  continent outlines, which are basic geographic fact, not anyone's
  copyrightable expression) plus Labyrinth, The Box, Onion, Branching Paths
  (four original abstract arena designs, only in the *spirit* of
  OpenFrontIO's "arcade" map category -- their actual pattern-map designs
  were deliberately never looked at, for the same reason). All ten went
  through a scratch procedural generator (not committed, scaffolding only)
  rather than hand-typed ASCII art purely to make tens of thousands of grid
  characters tractable and to iterate against the real numeric test bands
  directly; the checked-in output (`src/maps/*.js`) is the same flat
  `key/label/scale/bots/noiseSeed/grid` shape as `world.js`, wired into
  `MAP_PRESETS` through a new `authoredPreset()` helper in `config.js` that
  every authored map (World included) now goes through, instead of a
  hand-typed block per map. `tools/tests/world-map-test.mjs` was
  generalized into `tools/tests/authored-maps-test.mjs`, looping the exact
  same checks over all 11 authored maps instead of duplicating the file.
  - **Real bug caught by that verification, not by eyeballing a screenshot:
    Labyrinth's maze corridors never actually connected any two rooms.**
    `fillWallBetween`'s corridor-carving math wrote a single column/row
    sitting at the near edge of the wall gap and stopped there -- it never
    reached the far room, so every "corridor" was a dead-end stub and the
    whole map was 100 sealed, disconnected one-room islands (confirmed by a
    flood-fill: only 12 of 1215 land tiles were reachable from any single
    room). The automated map checks didn't catch this on their own since
    every room still individually had a valid plains spawn -- what actually
    caught it was the pacing sweep every new preset gets run through:
    Labyrinth stalled 3/3 seeds at the full 30-minute cap (every other
    preset resolves in 5-9 minutes), because with no land path between
    rooms at all, bots could only ever fight by naval attack, which is rare
    enough that games just never resolved. Fixed by making the corridor
    carve span the wall's *full* thickness in the direction of travel
    instead of one edge column, at a passage width narrower than a room
    (2 of 3 cells) so corridors still read as corridors rather than merged
    rooms; re-verified both structurally (a full flood-fill from one room
    now reaches every land tile) and dynamically (0/5 stalls afterward,
    same 5-9 minute resolution time as everything else). Worth remembering
    for any future maze/corridor-style authored map: connectivity has to be
    checked with an actual flood-fill or a real match, not inferred from
    "every room has a spawn" or a small rendered thumbnail -- the broken
    version looked like uniformly-spaced islands in a preview PNG, which
    reads as a plausible art style at a glance rather than an obvious bug.
  - Widening that corridor fix to span the full wall thickness also opens
    most of the wall lattice at once, since a full spanning tree touches
    nearly every room -- that leaves whatever water isn't carved scattered
    into several small sealed pockets rather than one connected moat. That
    is correct for a maze's walls, not damage to route around: an early
    attempt to force it back into one connected sea by flood-filling every
    orphaned pocket into land pushed Labyrinth's land share to 62.9%, well
    outside the 30-50% band every authored map is tuned to. Left as-is
    instead (Labyrinth measures 7 disconnected water bodies), and the
    generalized test's "not fragmented into many seas" check was scoped
    back to only run on maps that carry a river -- it was only ever a proxy
    for "a river didn't get stranded in its own sea" in the original
    World-only test, not a universal invariant every authored map's water
    has to satisfy, and promoting it to unconditional during the
    generalization pass was a real overreach caught by this same map.
- **The v2.3.0-beta visual redesign and pause menu are verified by the
  automated suite and a manual desktop/375px pass, not yet by a human
  playing a real match on a real phone.** The design tokens (`styles.css`'s
  `:root` block) are a first pass at the Apple/OpenFrontIO-informed look
  the user asked for, not a finished visual language -- if a specific
  color, radius, or spacing value reads wrong once played, it's a single
  custom-property edit, not a structural change. The pause menu itself
  (Resume/How to Play/Restart Match/New Game) is new surface area with no
  prior version to compare against; watch for edge cases around opening it
  during spawn selection or right as a match ends, which the automated
  suite covers but a human hasn't stress-tested yet.
