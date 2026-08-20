# 🌊 OceanFront

A real-time territory expansion game for the browser. Claim a homeland on a
procedurally generated world, grow tile by tile, put your people to work, and
turn their gold into cities, fleets and warheads until you hold the map.

No build step, no runtime dependencies. Plain ES modules and a canvas. Works
on desktop and phones, and installs as an offline-capable app on either.
(Playwright is a devDependency used only by the test suite, see
`tools/tests/README.md`.)

```bash
npm start          # serves on http://localhost:8080
```

Then open <http://localhost:8080> and pick a spot on the map.

## How it plays

You start with a handful of tiles and a small army. Everything follows from
one core decision you keep making: **where you point your troops**.

**Expanding.** Click any land you don't own and your troops pour across the
border. Attacks target a *nation*, not a tile. Click anywhere Meridia owns and
the whole shared border lights up. Each tile costs troops to take, scaled by
the defender's strength relative to your own committed force, the terrain, and
how much of the map either side already holds: open plains are cheap,
mountains are brutal, and a crushing numerical advantage makes conquest both
cheaper and faster than an even fight does. Unclaimed grey land is the
cheapest thing on the map, which is why the opening minutes are a land grab.

**Growing.** There's no split between troops and civilians. Your whole
population *is* your army. Every tile you hold raises your troop cap, with
diminishing returns the wider you sprawl: doubling a small nation's land
roughly doubles its cap, but doubling a huge one barely nudges it, so cities
matter more than sheer tile count once you're big. Troops regrow on their own
toward that cap, faster the further below it you are.

Land and gold pull on different levers, and deliberately do not overlap.
Territory pays no gold at all. It buys you an army, not an income. Gold
trickles in on its own and stacks with cities, ports and trade routes, so
getting rich means building something, not simply sprawling.

**Surrounding.** Anything completely boxed in by a single nation falls to it for
free. Once you have surrounded something there is no fight left to have. An
unclaimed pocket is judged on its land neighbours alone, so stray holes inside
your borders get filled in. A whole *nation* has to be genuinely landlocked.
Any coast at all and it can still ship an army out, so the sea is a real escape
route. Annexing a nation this way hands you its entire treasury. Taking a
nation's last tile in ordinary combat hands you half.

**Building.** Gold buys structures, each of which raises a different ceiling:

| Structure | Effect |
| --- | --- |
| 🏙 City | +2,200 max troops, +0.8 gold/s |
| ⚓ Port | +6 gold/s, opens sea trade, doubles boat range |
| 🛡 Defense Post | Land within 30 tiles costs attackers 5× as much and falls 3× slower |
| 🚀 Missile Silo | Unlocks nuclear strikes anywhere on the map |
| 📡 SAM Launcher | Intercepts missiles aimed within 46 tiles |

Each one you build makes the next of its kind more expensive, so sprawling
beats stacking.

**Escalating.** Nukes scorch a 13-tile radius. Territory goes neutral, troops
die, structures are destroyed, and the ground stays visibly burnt for the rest
of the match. SAMs get one shot at anything flying nearby. Troop boats sail
from your coast to any shore in range, which is the only way onto an island.

**Scheming.** Alliances are mutual non-aggression pacts. Neither side can
attack the other, and allied ports trade at a 75% premium. Peace literally
pays. You can break a pact after it has aged, but betrayal is remembered:
your traitor score rises, and other nations stop trusting your offers until it
decays. The AI plays the same game, including turning on you.

**Tribes.** Alongside the full nations, the map is dotted with tribes,
small, lazy bands that spend the opening minutes grabbing whatever open land
is nearby. They'll sign any pact offered to them but never propose one
themselves, tear down anything they capture rather than build it up, and
pick fights without much regard for how strong the other side is. Easy
pickings if you find one, and never any tougher on Hard. Only the full
nations scale with difficulty.

**Winning.** Hold 60% of the world's land, or outlast everyone.

## Controls

| Input | Action |
| --- | --- |
| Left click | Attack the clicked nation, or place a structure |
| Drag / WASD | Pan |
| Scroll | Zoom |
| Right click / Esc | Cancel the current mode |
| `1`–`5` | Select a structure to build |
| Shift + click | Keep placing the same structure |
| `N` | Nuclear strike targeting |
| Space | Pause |

**On a phone or tablet:** tap to attack, place structures and spawn, same as
clicking. Drag one finger to pan, pinch with two to zoom. The build menu,
leaderboard and attack-force slider live behind three tabs at the bottom of
the screen. Tap a tab to open it as a sheet over the map, tap it again (or
tap the map) to close it. Picking a structure to build closes the sheet
automatically so the map underneath is reachable to place it.

## Playing as an app

OceanFront is an installable Progressive Web App:

- **Android / desktop Chrome or Edge:** an "Install OceanFront" banner
  appears automatically after your first visit. Accepting adds it as a
  standalone app with its own icon, no browser chrome.
- **iOS Safari:** use Share → **Add to Home Screen**. Safari doesn't support
  the automatic install prompt, but the manifest and icons are set up so the
  home-screen icon and standalone window work correctly once added.

Once installed (or even just visited once), a service worker (`sw.js`)
caches every game file, so the match still runs with **no network
connection at all**. There's nothing to sync. A world is just a seed, and
the whole simulation runs client-side, so offline play is exactly the same
game, not a degraded mode. Bump `CACHE_VERSION` in `sw.js` when shipping a
release that changes any cached file. That busts old installs' caches on
their next visit.

## Project layout

```
index.html        markup for the HUD, start screen and end screen
styles.css        all styling, including the phone/tablet responsive layout
manifest.json     PWA metadata (name, icons, standalone display)
sw.js             service worker: offline caching for the whole game
icons/            app icons generated from the wave-emoji brand mark
server.js         zero-dependency static file server
src/
  config.js       every balance constant in one table
  rng.js          seeded RNG and value noise
  map.js          island generation, ocean labelling, spawn selection
  player.js       troops, troop cap and growth, income
  game.js         tick loop, combat, encirclement, boats, missiles, trade
  diplomacy.js    alliances, offers, betrayal and reputation
  ai.js           full-nation bot personalities and decision-making
  tribe.js        the weaker, second AI archetype, see "Tribes", above
  render.js       camera and canvas drawing
  ui.js           DOM wiring, input (mouse, touch/pinch), mobile chrome
  main.js         fixed-timestep game loop, service worker registration
tools/
  simulate.js     headless all-AI match runner
  tests/          committed regression suite, see tools/tests/README.md
```

The simulation is deliberately separate from rendering. `src/game.js` never
touches the DOM, which is what lets `tools/simulate.js` run entire matches in
Node with no browser.

## Balance testing

`tools/simulate.js` plays a full match with every nation under AI control and
reports how it developed:

```bash
node tools/simulate.js --size=large --seed=777 --minutes=40
```

It prints the expansion curve, surviving nations, standing alliances, active
trade routes, what got built, and tick timings, then exits non-zero if the
simulation stalls, builds nothing, or blows the 100 ms tick budget. It is the
fastest way to see whether a change to `config.js` ruins the game.

Typical healthy run: a winner in 8 to 16 game-minutes, all five structure
types built, alliances peaking mid-game and collapsing as nations run out of
room, and average tick times well under a millisecond.

## Testing

```bash
npm install && npm test
```

Runs the full committed regression suite (desktop and mobile browser flows,
touch reliability, encirclement correctness, PWA install) against a real
Chromium instance via Playwright. See `tools/tests/README.md` for what each
script covers and how to run one in isolation.

New to this project? Read `HANDOFF.md` first.

## Notes

- Worlds are fully deterministic. The same seed always generates the same map
  and the same starting positions.
- The territory layer is rasterized one pixel per tile into an offscreen canvas
  and only redrawn when ownership actually changes.
- A live match is exposed as `window.OceanFront` for debugging from the console.
