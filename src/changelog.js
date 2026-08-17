// Release history shown as a small, collapsible tag at the bottom of the
// main menu. CURRENT_VERSION drives the visible tag -- bump it whenever a
// new entry is added below. Newest first.

export const CURRENT_VERSION = 'v1.2.0-beta';

export const CHANGELOG = [
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
