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
| `version-tag-check.mjs` | yes | The changelog tag on the main menu shows `CURRENT_VERSION`, starts collapsed, expands on click, and lists every entry in `CHANGELOG` -- both read directly from `src/changelog.js`, so this never needs a manual bump when the version changes. |
| `difficulty-ui-verify.mjs` | yes | The difficulty picker renders Easy/Normal/Hard, persists the choice to `localStorage` and restores it on reload, and actually reaches `Game`/`AiController` (a bot's `aggression` and `economyMultiplier` measurably increase across tiers with the same seed). Also checks the troop/worker slider's DOM bounds are 25–75, and that the attacking-troops HUD stat is hidden while idle, shows a live count during a real attack, and hides again once it settles. |
| `encirclement-test.mjs` | no | Headless correctness tests for encirclement + treasury spoils, built on exact hand-painted board states rather than hoping a real match produces one: a neutral pocket ringed by one nation is absorbed for free; a pocket touching two nations is left alone; a landlocked nation ringed by a single rival is annexed and hands over 100% of its gold; the same setup *with* a coastline is not annexed; an allied encircler does not annex; an ordinary conquest kill pays the killer 50%; a nuke-kill pays nobody; a huge open region isn't swallowed whole. |
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
