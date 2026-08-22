// Release history shown as a small, collapsible tag at the bottom of the
// main menu. CURRENT_VERSION drives the visible tag, bump it whenever a
// new entry is added below. Newest first.

export const CURRENT_VERSION = 'v2.7.1-beta';

/**
 * The roadmap, newest work first, shown as "Coming soon" above the release
 * history. Deliberately just ordered titles with no dates or version numbers
 * attached: this is what is being worked towards, not a set of promises.
 */
export const UPCOMING = [
  'Player profile panel',
  'Better UI',
  'Multiplayer',
  'Local multiplayer',
  'Duo, trio and team games',
];

export const CHANGELOG = [
  {
    version: 'v2.7.1-beta',
    notes: [
      'Your own name tag now stays visible for much longer than everyone else\'s as you zoom out — it only disappears once the map is fully zoomed all the way out, instead of fading away early like a rival\'s.',
      'Tribes can no longer attack you or any nation, by land or by sea. They still fight each other and grab open land, but they\'re pure background scenery now — easy pickings, never a threat.',
    ],
  },
  {
    version: 'v2.7.0-beta',
    notes: [
      'Ten new hand-made maps: the six continents (Africa, Asia, Europe, North America, South America, Oceania), plus four original arena maps for something different — Labyrinth (a real maze), The Box (a symmetric four-way arena), Onion (concentric rings around a central stronghold), and Branching Paths (a fractal network of peninsulas). All pick from the same World row on the main menu.',
      'Names and troop counts now fade away as you zoom out, instead of staying pinned to a readable size no matter how far back you pull. The map reads cleaner at a glance, and the biggest nations keep their names visible the longest.',
      'You can now zoom out further than before, past the point where the whole map used to fill the screen, shrinking it down to see it as a small island in open water.',
      'Fixed the installable/offline copy of the game missing some map files from its cache.',
    ],
  },
  {
    version: 'v2.6.0-beta',
    notes: [
      'Nations now play a much more patient, decisive game: they hold back a growing army until it is genuinely substantial before picking a fight, then commit almost everything to it once they do, rather than trickling out a token force whenever the mood struck.',
      'Nations actively hunt down tribes near their borders, sometimes striking several at once, instead of only occasionally bumping into one. Tribe land is also cheaper to take than a real rival\'s.',
      'Nations now fight back hardest against whoever is currently invading them, even an enemy they would normally consider too strong to challenge.',
      'Tribes are far more numerous now, filling out the map much more than before.',
      'Fixed two nations attacking each other at the same time causing the border between them to flicker back and forth instead of settling. The stronger attack now properly absorbs the weaker one and pushes on with the difference.',
    ],
  },
  {
    version: 'v2.5.0-beta',
    notes: [
      'Hand-made maps are here, starting with the World: a drawn map of the real continents, with mountain ranges where they belong and rivers running down to the sea. Pick it from the World row on the main menu, alongside the usual randomly generated sizes. Unlike those, its coastlines are the same every time. The seed still decides where everyone starts and how the match unfolds.',
      'Rivers are water, so armies cannot march across one. You need a boat. That makes a river a real border worth holding, and a coastline worth watching.',
      'The updates window now opens with a Coming soon list, so you can see what is being worked on next.',
    ],
  },
  {
    version: 'v2.4.0-beta',
    notes: [
      'The main menu is now a real landing page instead of a small floating card, built to match how OpenFrontIO\'s own landing page is actually put together: a slim top bar, a hero block for your name and colour that washes toward whatever you pick, a big card for choosing your world size, and a footer.',
      'World size is now its own set of cards with a quick visual size indicator, instead of a plain row of buttons.',
    ],
  },
  {
    version: 'v2.3.0-beta',
    notes: [
      'A full visual redesign. Monochrome surfaces throughout, with color kept only where it means something: gold for currency, red for danger and attacking troops, blue for selection and the primary action. Rounder, more consistent corners and real breathing room between elements. The system font is used everywhere, so the game renders in actual San Francisco on a Mac or iPhone rather than a generic fallback.',
      'The main menu is now grouped into clear sections (Nation, World) instead of one long list of fields.',
      '"How to play" is now a proper popup, reachable from the main menu and, for the first time, mid-match too, instead of an inline expand you could only see before starting.',
      'New: an in-match menu, opened from a gear button in the topbar. It pauses the game while open (without undoing a pause you set yourself), and offers How to Play, Restart Match with the same seed, and New Game to return to the main menu without a page refresh.',
    ],
  },
  {
    version: 'v2.2.0-beta',
    notes: [
      'Tribes: small, lazy AI bands now fill out the map alongside the full nations, grabbing open land early so there\'s less of a free-for-all land grab in the opening minutes. They sign any pact offered to them but never propose one, tear down anything they capture instead of building it up, and pick fights without much regard for how strong the other side is. Easy pickings if you find one, but numerous enough to matter. They\'re never affected by the difficulty setting. Only the full nations get tougher on Hard.',
      'Tribe territory now renders as a soft, muted, borderless blob on the map. No outline, duller colors, so they read as background at a glance instead of competing visually with real rivals. The leaderboard shows their names dimmer and italic for the same reason.',
      'The version tag at the bottom of the main menu now opens the release history as a proper popup instead of expanding in place, on both desktop and mobile.',
      'Fixed the main menu getting cut off at the top on phones with no way to scroll up to see it.',
    ],
  },
  {
    version: 'v2.1.0-beta',
    notes: [
      'WASD and arrow-key panning is much more responsive now, over 20x faster than before. Flicking across the map takes a beat, not a scroll.',
    ],
  },
  {
    version: 'v2.0.0-beta',
    notes: [
      'No more troops-vs-workers split. Your whole population is your army now. Land raises your troop cap with real diminishing returns on sprawl, so cities matter more once you\'re big, and troops regrow faster the further below the cap you sit.',
      'Gold no longer comes from a workforce at all. It trickles in on its own and stacks with cities, ports and trade, completely independent of population.',
      'Combat now weighs both sides fully: terrain, relative strength, and how much of the map each side already controls all shift the price and the pace of taking a tile, not just a flat toll for the ground.',
      'A dominant nation is measurably cheaper and faster to chip away at than a small, evenly matched one. Sheer size stops being armor.',
      'Betraying an ally trusted enough to know better costs real blood, not just a reputational hit. Attacking a known traitor is both cheaper and faster.',
      'Defense Posts cover far more ground and hit much harder, but no longer stack. One well-placed post secures a wide radius on its own.',
      'The army bar in the topbar (formerly the population bar) now shows troops committed to an attack as its second segment instead of workers, matching what your standing army is actually doing.',
    ],
  },
  {
    version: 'v1.6.0-beta',
    notes: [
      'Population now shows as a fill bar in the topbar instead of a plain number pair. Troops and workers as two stacked segments against your current cap, with a live growth-rate readout next to it.',
    ],
  },
  {
    version: 'v1.5.0-beta',
    notes: [
      'Combat now weighs the strength of both sides: a crushing numerical advantage makes each tile cheaper to take, while an even or losing fight costs more. A real siege, not a flat toll.',
      'Rough terrain now slows conquest down, not just costs more troops. Mountains are taken more slowly than open plains even when troops are no object.',
      'Attacking a known traitor now costs less. Betrayal has a real cost in blood, not just trust.',
    ],
  },
  {
    version: 'v1.4.0-beta',
    notes: [
      'Smarter bots: they now prefer piling onto a rival someone else is already invading, and snowballing one whose army has just collapsed, instead of only ever grinding at whoever scores best on paper.',
      'Bot difficulty now also changes how fast bots react and how full an army they want before attacking. Hard bots think and strike noticeably faster, not just harder.',
      'Hard bots refuse token attacks too small to matter, but still always retaliate when attacked themselves.',
      'Bots now occasionally raid by sea for unpredictability, not only as a last resort, and can opportunistically betray an ally whose army has collapsed.',
    ],
  },
  {
    version: 'v1.3.0-beta',
    notes: [
      'Land is now your army: every tile you hold speeds up how fast troops regrow, so a wide nation rebuilds a shattered army far quicker than a small one.',
      'Territory no longer pays gold. Income comes from workers, cities, ports and trade. Getting rich means building something, not just sprawling.',
      'Anything you completely surround falls to you for free. Unclaimed pockets inside your borders get filled in. A landlocked nation ringed by you alone is annexed outright.',
      'Annexing a nation by surrounding it hands you its entire treasury. Taking a nation’s last tile in ordinary combat hands you half.',
    ],
  },
  {
    version: 'v1.2.0-beta',
    notes: [
      'Land is cheaper to expand into, on top of the previous reduction.',
      'The Troops stat now shows a separate number for troops currently committed to attacks or a naval invasion.',
      'Tightened the troops ↔ workers slider to a 25 to 75% range (bots included), so neither side can be neglected entirely.',
      'Added an Easy / Normal / Hard bot difficulty setting to the main menu, scaling both bot economy and aggression.',
    ],
  },
  {
    version: 'v1.1.0-beta',
    notes: [
      'Troops now reinforce faster the bigger your standing army already is. A large military snowballs instead of growing at a flat rate.',
      'Added this version tag and update history to the main menu.',
    ],
  },
  {
    version: 'v1.0.0-beta',
    notes: [
      'First tagged release.',
      'Responsive mobile layout with a bottom-sheet menu, pinch-to-zoom, and an installable, offline-capable app.',
      'Fixed touch input so taps reliably register on the first try across the whole UI.',
      'Territory is cheaper to claim, and conquered land now fills in as a solid, gap-free shape instead of leaving stray unclaimed holes.',
    ],
  },
];
