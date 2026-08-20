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
- **A UI overhaul is planned for a future update, not yet started.** Apple-
  style: minimal, clean, premium. Monochrome base palette with color used
  sparingly, for buttons and highlighted stats, not throughout. San
  Francisco for the font (with a sane fallback stack for non-Apple
  platforms, since this game runs everywhere). Real attention to spacing
  and how screen space is used, especially on mobile. Also referenced
  against OpenFrontIO's own UI (see the bullet above for how to research
  that when the round actually starts). Nothing has been built toward this
  yet, it's recorded here so it isn't lost before that round begins.

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

## How to verify a change

```sh
npm install && npm test      # full committed regression suite
npm run test:sim             # one headless match with a summary report
node tools/tests/pacing-sweep.mjs "label"   # balance sweep, run before/after a config.js edit and diff
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
