// Release history shown as a small, collapsible tag at the bottom of the
// main menu. CURRENT_VERSION drives the visible tag -- bump it whenever a
// new entry is added below. Newest first.

export const CURRENT_VERSION = 'v2.2.0-beta';

export const CHANGELOG = [
  {
    version: 'v2.2.0-beta',
    notes: [
      'Tribes: small, lazy AI bands now fill out the map alongside the full nations, grabbing open land early so there\'s less of a free-for-all land grab in the opening minutes. They sign any pact offered to them but never propose one, tear down anything they capture instead of building it up, and pick fights without much regard for how strong the other side is -- easy pickings if you find one, but numerous enough to matter. They\'re never affected by the difficulty setting; only the full nations get tougher on Hard.',
      'Tribe territory now renders as a soft, muted, borderless blob on the map -- no outline, duller colors -- so they read as background at a glance instead of competing visually with real rivals. The leaderboard shows their names dimmer and italic for the same reason.',
      'The version tag at the bottom of the main menu now opens the release history as a proper popup instead of expanding in place, on both desktop and mobile.',
    ],
  },
  {
    version: 'v2.1.0-beta',
    notes: [
      'WASD and arrow-key panning is much more responsive now, over 20x faster than before -- flicking across the map takes a beat, not a scroll.',
    ],
  },
  {
    version: 'v2.0.0-beta',
    notes: [
      'No more troops-vs-workers split — your whole population is your army now. Land raises your troop cap with real diminishing returns on sprawl, so cities matter more once you\'re big, and troops regrow faster the further below the cap you sit.',
      'Gold no longer comes from a workforce at all — it trickles in on its own and stacks with cities, ports and trade, completely independent of population.',
      'Combat now weighs both sides fully: terrain, relative strength, and how much of the map each side already controls all shift the price and the pace of taking a tile, not just a flat toll for the ground.',
      'A dominant nation is measurably cheaper and faster to chip away at than a small, evenly matched one — sheer size stops being armor.',
      'Betraying an ally trusted enough to know better costs real blood, not just a reputational hit — attacking a known traitor is both cheaper and faster.',
      'Defense Posts cover far more ground and hit much harder, but no longer stack — one well-placed post secures a wide radius on its own.',
      'The army bar in the topbar (formerly the population bar) now shows troops committed to an attack as its second segment instead of workers, matching what your standing army is actually doing.',
    ],
  },
  {
    version: 'v1.6.0-beta',
    notes: [
      'Population now shows as a fill bar in the topbar instead of a plain number pair — troops and workers as two stacked segments against your current cap, with a live growth-rate readout next to it.',
    ],
  },
  {
    version: 'v1.5.0-beta',
    notes: [
      'Combat now weighs the strength of both sides: a crushing numerical advantage makes each tile cheaper to take, while an even or losing fight costs more — a real siege, not a flat toll.',
      'Rough terrain now slows conquest down, not just costs more troops — mountains are taken more slowly than open plains even when troops are no object.',
      'Attacking a known traitor now costs less — betrayal has a real cost in blood, not just trust.',
    ],
  },
  {
    version: 'v1.4.0-beta',
    notes: [
      'Smarter bots: they now prefer piling onto a rival someone else is already invading, and snowballing one whose army has just collapsed, instead of only ever grinding at whoever scores best on paper.',
      'Bot difficulty now also changes how fast bots react and how full an army they want before attacking — Hard bots think and strike noticeably faster, not just harder.',
      'Hard bots refuse token attacks too small to matter, but still always retaliate when attacked themselves.',
      'Bots now occasionally raid by sea for unpredictability, not only as a last resort, and can opportunistically betray an ally whose army has collapsed.',
    ],
  },
  {
    version: 'v1.3.0-beta',
    notes: [
      'Land is now your army: every tile you hold speeds up how fast troops regrow, so a wide nation rebuilds a shattered army far quicker than a small one.',
      'Territory no longer pays gold. Income comes from workers, cities, ports and trade — getting rich means building something, not just sprawling.',
      'Anything you completely surround falls to you for free. Unclaimed pockets inside your borders get filled in; a landlocked nation ringed by you alone is annexed outright.',
      'Annexing a nation by surrounding it hands you its entire treasury. Taking a nation’s last tile in ordinary combat hands you half.',
    ],
  },
  {
    version: 'v1.2.0-beta',
    notes: [
      'Land is cheaper to expand into, on top of the previous reduction.',
      'The Troops stat now shows a separate number for troops currently committed to attacks or a naval invasion.',
      'Tightened the troops ↔ workers slider to a 25–75% range (bots included), so neither side can be neglected entirely.',
      'Added an Easy / Normal / Hard bot difficulty setting to the main menu, scaling both bot economy and aggression.',
    ],
  },
  {
    version: 'v1.1.0-beta',
    notes: [
      'Troops now reinforce faster the bigger your standing army already is — a large military snowballs instead of growing at a flat rate.',
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
