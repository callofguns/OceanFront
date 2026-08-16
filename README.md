# 🌊 OceanFront

A real-time territory expansion game for the browser. Claim a homeland on a
procedurally generated world, grow tile by tile, put your people to work, and
turn their gold into cities, fleets and warheads until you hold the map.

No build step, no dependencies — plain ES modules and a canvas. Works on
desktop and phones, and installs as an offline-capable app on either.

```bash
npm start          # serves on http://localhost:8080
```

Then open <http://localhost:8080> and pick a spot on the map.

## How it plays

You start with a handful of tiles and a small population. Everything follows
from two decisions you keep making: **how much of your population carries a
rifle instead of earning gold**, and **where you point it**.

**Expanding.** Click any land you don't own and your troops pour across the
border. Attacks target a *nation*, not a tile — click anywhere Meridia owns and
the whole shared border lights up. Each tile costs troops to take, scaled by the
defender's troop density and the terrain: open plains are cheap, mountains are
brutal. Unclaimed grey land is the cheapest thing on the map, which is why the
opening minutes are a land grab.

**Earning.** Population splits between troops and workers on the bottom slider.
Workers generate gold and nothing else; troops take and hold ground and generate
nothing. Sitting at 90% troops makes you dangerous and poor. Sitting at 20%
makes you rich and someone else's next meal.

**Building.** Gold buys structures, each of which raises a different ceiling:

| Structure | Effect |
| --- | --- |
| 🏙 City | +2,200 max population, +0.8 gold/s |
| ⚓ Port | +6 gold/s, opens sea trade, doubles boat range |
| 🛡 Defense Post | Land within 18 tiles costs attackers 2.4× as much |
| 🚀 Missile Silo | Unlocks nuclear strikes anywhere on the map |
| 📡 SAM Launcher | Intercepts missiles aimed within 46 tiles |

Each one you build makes the next of its kind more expensive, so sprawling
beats stacking.

**Escalating.** Nukes scorch a 13-tile radius — territory goes neutral, troops
die, structures are destroyed, and the ground stays visibly burnt for the rest
of the match. SAMs get one shot at anything flying nearby. Troop boats sail
from your coast to any shore in range, which is the only way onto an island.

**Scheming.** Alliances are mutual non-aggression pacts. Neither side can
attack the other, and allied ports trade at a 75% premium — peace literally
pays. You can break a pact after it has aged, but betrayal is remembered:
your traitor score rises, and other nations stop trusting your offers until it
decays. The AI plays the same game, including turning on you.

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
leaderboard and sliders live behind three tabs at the bottom of the screen —
tap a tab to open it as a sheet over the map, tap it again (or tap the map)
to close it. Picking a structure to build closes the sheet automatically so
the map underneath is reachable to place it.

## Playing as an app

OceanFront is an installable Progressive Web App:

- **Android / desktop Chrome or Edge:** an "Install OceanFront" banner
  appears automatically after your first visit; accepting adds it as a
  standalone app with its own icon, no browser chrome.
- **iOS Safari:** use Share → **Add to Home Screen**. Safari doesn't support
  the automatic install prompt, but the manifest and icons are set up so the
  home-screen icon and standalone window work correctly once added.

Once installed (or even just visited once), a service worker (`sw.js`)
caches every game file, so the match still runs with **no network
connection at all**. There's nothing to sync — a world is just a seed, and
the whole simulation runs client-side — so offline play is exactly the same
game, not a degraded mode. Bump `CACHE_VERSION` in `sw.js` when shipping a
release that changes any cached file; that busts old installs' caches on
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
  player.js       population, troop/worker split, income
  game.js         tick loop, combat, boats, missiles, buildings, trade
  diplomacy.js    alliances, offers, betrayal and reputation
  ai.js           bot personalities and decision-making
  render.js       camera and canvas drawing
  ui.js           DOM wiring, input (mouse, touch/pinch), mobile chrome
  main.js         fixed-timestep game loop, service worker registration
tools/
  simulate.js     headless all-AI match runner
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
trade routes, what got built, and tick timings — then exits non-zero if the
simulation stalls, builds nothing, or blows the 100 ms tick budget. It is the
fastest way to see whether a change to `config.js` ruins the game.

Typical healthy run: a winner in 8–16 game-minutes, all five structure types
built, alliances peaking mid-game and collapsing as nations run out of room,
and average tick times well under a millisecond.

## Notes

- Worlds are fully deterministic — the same seed always generates the same map
  and the same starting positions.
- The territory layer is rasterized one pixel per tile into an offscreen canvas
  and only redrawn when ownership actually changes.
- A live match is exposed as `window.OceanFront` for debugging from the console.
