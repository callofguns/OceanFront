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
hand-off that's **v2.0.0-beta**, the round that ported OpenFrontIO's exact
population/combat model wholesale (see the load-bearing lessons below);
whether any recent version has been cut as a GitHub release is worth asking
the user rather than assuming (see below -- this session can't push tags
itself, so there's no way to check from git alone).

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
     merge-conflict practice), and push `Update-Testing`. Do this promptly
     per update rather than batching several branches unmerged -- the point
     is for `Update-Testing` itself to accumulate a few played-together
     updates, not for branches to pile up unmerged.
  3. Leave `main` untouched until the user explicitly says to merge (e.g.
     "push to main"). That go-ahead means `Update-Testing`, with everything
     accumulated on it since the last release, has been played/verified and
     is ready to ship -- only then merge `Update-Testing` into `main` and
     push.
  No PR unless separately asked. Do that unless told the rules changed
  again.
- **Releases use Semantic Versioning (`vMAJOR.MINOR.PATCH`) with written
  patch notes.** Major = a huge change or a full release (reserved for
  leaving beta); minor = a new feature; patch = a small fix -- pick the
  version bump by what actually changed, not just an incrementing minor
  number regardless. `src/changelog.js`'s in-game `CURRENT_VERSION`/
  `CHANGELOG` should follow this same discipline, and doubles as the source
  material for a GitHub release's patch notes: draft them as a bulleted
  "what's new / what's fixed / what's coming next" list whenever a version
  on `main` is ready to tag.
- **Never push a git tag or create a GitHub release yourself.** Tag pushes
  get an HTTP 403 from GitHub (confirmed, across many attempts, not a
  proxy/egress issue -- branch pushes over the identical connection succeed).
  No GitHub MCP tool creates tags or releases either (only read tools exist:
  `get_tag`, `get_release_by_tag`, `list_tags`, `list_releases`,
  `get_latest_release`). When a version on `main` is ready, tell the user
  the exact commit to tag, the SemVer version it should be, and hand them
  the drafted patch notes to paste into the release description.
- **Never open a pull request unless explicitly asked.**

## Architecture at a glance

- `src/config.js` -- every tunable number in the game lives here. Changing
  balance should almost always mean editing a constant here, not scattering
  magic numbers through the logic.
- `src/game.js` -- the simulation: tick loop, combat, encirclement, boats,
  missiles, buildings, trade. No DOM, no rendering; runs identically headless
  or in a browser.
- `src/player.js` -- a nation's troops (population is troops-only -- see the
  load-bearing lessons below), troop cap and growth, gold income.
- `src/ai.js` -- bot decision-making, re-evaluated every few seconds per bot.
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

## How to verify a change

```sh
npm install && npm test      # full committed regression suite
npm run test:sim             # one headless match with a summary report
node tools/tests/pacing-sweep.mjs "label"   # balance sweep, run before/after a config.js edit and diff
```

Full details, including what each test actually checks, are in
`tools/tests/README.md`.

## Known open items

- **No recent version is confirmed tagged as a GitHub release.** See the
  workflow rules above -- this session can't push tags, so ask the user
  rather than assuming one has been cut.
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
- **`small/hard` in `pacing-sweep.mjs` reads at 2.6 minutes**, marginally
  under the informal "no sub-3-minute blowout" guideline this project has
  used in past rounds -- every other combo is comfortably above 3 minutes
  and nothing stalls, so this was judged not worth a further tuning pass on
  its own, but is worth a second look if small/hard specifically feels too
  fast in play.
