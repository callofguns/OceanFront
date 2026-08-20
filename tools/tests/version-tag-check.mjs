// Checks the version tag and its release-history popup on the start screen.
// Reads the expected version straight from src/changelog.js rather than
// hardcoding it, so this never needs a manual bump when CURRENT_VERSION
// changes.
// Run the dev server first (`npm start`), then this script.
import { chromium } from './lib/browser.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CURRENT_VERSION, CHANGELOG } from '../../src/changelog.js';

const BASE = process.env.BASE || 'http://localhost:8123';
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'oceanfront-test-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.log(`  ✗ ${m}`); errors.push(m); }

const browser = await chromium.launch({ headless: true });

// ---------------------------------------------------------------- desktop --
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console error: ${m.text()}`); });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  console.log('▸ Start screen version tag (desktop)');
  const tagText = await page.textContent('#changelog-tag');
  console.log(`  tag text: "${tagText.trim()}"`);
  if (tagText.trim() === CURRENT_VERSION) ok('shows current version');
  else bad(`unexpected version text: "${tagText}" (expected ${CURRENT_VERSION})`);

  const closedByDefault = await page.isHidden('#changelog-modal');
  if (closedByDefault) ok('popup is closed by default (small tag, not intrusive)');
  else bad('popup should not be open before clicking the tag');

  await page.screenshot({ path: `${SHOTS}/v01-closed.png` });

  await page.click('#changelog-tag');
  await page.waitForTimeout(150);
  const openAfterClick = await page.isVisible('#changelog-modal');
  if (openAfterClick) ok('clicking the tag opens the popup');
  else bad('popup did not open on click');

  const versionHeaders = await page.$$eval('#changelog-entries .entry-version', (els) => els.map((e) => e.textContent));
  console.log(`  entries shown: ${JSON.stringify(versionHeaders)}`);
  const expectedVersions = CHANGELOG.map((e) => e.version);
  const missing = expectedVersions.filter((v) => !versionHeaders.includes(v));
  if (missing.length === 0) ok(`all ${expectedVersions.length} release entries are present`);
  else bad(`missing entries: ${missing.join(', ')}`);

  await page.screenshot({ path: `${SHOTS}/v02-open.png` });

  // Close via the ✕ button.
  await page.click('#changelog-close');
  await page.waitForTimeout(150);
  if (await page.isHidden('#changelog-modal')) ok('the ✕ button closes the popup');
  else bad('the ✕ button did not close the popup');

  // Close via clicking the backdrop (outside the dialog card).
  await page.click('#changelog-tag');
  await page.waitForTimeout(150);
  await page.click('#changelog-modal', { position: { x: 10, y: 10 } });
  await page.waitForTimeout(150);
  if (await page.isHidden('#changelog-modal')) ok('clicking the backdrop closes the popup');
  else bad('clicking the backdrop did not close the popup');

  // Clicking inside the dialog itself must NOT close it.
  await page.click('#changelog-tag');
  await page.waitForTimeout(150);
  await page.click('.changelog-dialog h1');
  await page.waitForTimeout(150);
  if (await page.isVisible('#changelog-modal')) ok('clicking inside the dialog does not close it');
  else bad('clicking inside the dialog incorrectly closed the popup');

  // Close via Escape.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  if (await page.isHidden('#changelog-modal')) ok('pressing Escape closes the popup');
  else bad('Escape did not close the popup');

  await page.close();
}

// ----------------------------------------------------------------- mobile --
{
  const page = await browser.newPage({ viewport: { width: 375, height: 667 }, hasTouch: true });
  page.on('pageerror', (e) => errors.push(`mobile page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`mobile console error: ${m.text()}`); });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  console.log('▸ Start screen version tag (375px phone)');
  await page.tap('#changelog-tag');
  await page.waitForTimeout(150);
  if (await page.isVisible('#changelog-modal')) ok('tapping the tag opens the popup on a phone viewport');
  else bad('the popup did not open on a phone viewport');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (!overflow) ok('the open popup causes no horizontal overflow at 375px');
  else bad('the open popup overflows the 375px viewport horizontally');

  const fitsViewport = await page.evaluate(() => {
    const r = document.querySelector('.changelog-dialog').getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0;
  });
  if (fitsViewport) ok('the dialog card stays within the phone viewport');
  else bad('the dialog card overflows the phone viewport');

  await page.screenshot({ path: `${SHOTS}/v03-mobile-open.png` });

  await page.tap('#changelog-close');
  await page.waitForTimeout(150);
  if (await page.isHidden('#changelog-modal')) ok('tapping the ✕ button closes the popup on a phone viewport');
  else bad('the ✕ button did not close the popup on a phone viewport');

  await page.close();
}

await browser.close();
console.log(`\n${errors.length === 0 ? 'ALL CHECKS PASSED.' : errors.length + ' PROBLEM(S): ' + errors.join('; ')}`);
if (errors.length > 0) process.exitCode = 1;
