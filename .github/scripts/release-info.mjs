#!/usr/bin/env node
// Run from the repo root (the release workflow does this). Reads
// src/changelog.js -- the same module that drives the in-game version tag
// -- and writes the two files release.yml needs to create (or skip) a
// GitHub release for the current version:
//
//   RELEASE_VERSION   plain text, one line, e.g. "v2.1.0-beta"
//   RELEASE_NOTES.md  that version's CHANGELOG entry as a bullet list,
//                     ready to hand straight to `gh release create
//                     --notes-file`
//
// CURRENT_VERSION is the single source of truth for what to tag -- there is
// no separate auto-increment here on purpose. Bumping it correctly (patch
// for a small fix, minor for a new feature, major for leaving beta / a full
// release) is a human/authoring decision made when the changelog entry is
// written, not something a workflow should guess from a diff.
import { CURRENT_VERSION, CHANGELOG } from '../../src/changelog.js';
import { writeFileSync } from 'node:fs';

const entry = CHANGELOG.find((e) => e.version === CURRENT_VERSION);
if (!entry) {
  console.error(
    `No CHANGELOG entry matches CURRENT_VERSION (${CURRENT_VERSION}) -- ` +
      'src/changelog.js is out of sync with itself (the version was bumped ' +
      'without adding/renaming its entry, or vice versa). Fix that file, ' +
      'not this script.'
  );
  process.exit(1);
}

writeFileSync('RELEASE_VERSION', `${CURRENT_VERSION}\n`);
writeFileSync('RELEASE_NOTES.md', `${entry.notes.map((n) => `- ${n}`).join('\n')}\n`);
console.log(`Prepared release notes for ${CURRENT_VERSION} (${entry.notes.length} note(s)).`);
