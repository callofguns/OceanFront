# Hand-off

Context for a new Claude Code session picking up OceanFront. Read this first;
it's a summary of decisions and gotchas from the session that built this
project, not a replacement for `README.md` (player-facing rules) or
`tools/tests/README.md` (how to verify a change).

## What this is

OceanFront is a real-time territory-expansion browser game (OpenFront /
Territorial.io-style): claim a coastline, expand tile by tile, split your
population between troops and gold-earning workers, build structures, and
optionally nuke, ally with, or betray the AI nations around you. Zero runtime
dependencies -- vanilla ES modules served by a tiny static file server
(`server.js`), simulated at a fixed tick rate independent of rendering.

## Current state

On `main`. Latest version tag in-game is whatever `CURRENT_VERSION` says in
`src/changelog.js` -- check there and with `git log -1` for the exact commit,
rather than trusting a hash written here, since both move. As of this
hand-off that's **v1.3.0-beta**, not yet cut as a GitHub release (see below).

## Standing workflow rules

These came from explicit instructions earlier in the project and are easy to
lose track of -- follow them until told otherwise:

- **Push straight to `main`.** The project used a `test`-branch-then-merge
  workflow earlier on; the user later said to push directly to `main` "until
  the game is out of beta." Do that unless told the rules changed.
- **Never push a git tag or create a GitHub release yourself.** Tag pushes
  get an HTTP 403 from GitHub (confirmed, across many attempts, not a
  proxy/egress issue -- branch pushes over the identical connection succeed).
  No GitHub MCP tool creates tags or releases either (only read tools exist:
  `get_tag`, `get_release_by_tag`, `list_tags`, `list_releases`,
  `get_latest_release`). When a version is ready, tell the user the exact
  commit to tag and let them cut the release manually on GitHub.
- **Never open a pull request unless explicitly asked.**

## Architecture at a glance

- `src/config.js` -- every tunable number in the game lives here. Changing
  balance should almost always mean editing a constant here, not scattering
  magic numbers through the logic.
- `src/game.js` -- the simulation: tick loop, combat, encirclement, boats,
  missiles, buildings, trade. No DOM, no rendering; runs identically headless
  or in a browser.
- `src/player.js` -- a nation's population, troops/workers split, economy.
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

- **The population rebalancer corrects toward a target, continuously.**
  `MIGRATE_RATE` in `src/player.js` pulls the troops/workers split back
  toward the current ratio *every tick*. Any mechanic meant to boost troops
  (or workers) must shift the *target ratio*, never add troops directly --
  troops added outside that flow just leak back out into workers over the
  following seconds. This is why both troop momentum and `LAND_GROWTH` feed
  the population growth *rate*, and never touch `troops` directly. If a new
  "bonus" mechanic seems to have no effect in testing, this is the first
  thing to check.
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

## How to verify a change

```sh
npm install && npm test      # full committed regression suite
npm run test:sim             # one headless match with a summary report
node tools/tests/pacing-sweep.mjs "label"   # balance sweep, run before/after a config.js edit and diff
```

Full details, including what each test actually checks, are in
`tools/tests/README.md`.

## Known open items

- **`v1.3.0-beta` needs a manual GitHub release/tag.** See the workflow
  rules above -- this session can't push tags.
- **Easy-difficulty matches got noticeably shorter** in the land/gold rework
  (large map: 11.9 → 5.4 min average) as a side effect of troop growth now
  scaling with land -- flagged to the user, not changed. Worth another look
  if it comes up again.
