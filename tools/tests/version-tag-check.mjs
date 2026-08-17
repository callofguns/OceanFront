// Checks the version tag and changelog UI on the start screen. Reads the
// expected version straight from src/changelog.js rather than hardcoding it,
// so this never needs a manual bump when CURRENT_VERSION changes.
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
const page = await browser.newPage({ viewport: { width: 500, height: 900 } });
page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console error: ${m.text()}`); });

await page.goto(BASE, { waitUntil: 'networkidle' });

console.log('▸ Start screen version tag');
const summaryText = await page.textContent('#changelog summary');
console.log(`  tag text: "${summaryText.trim()}"`);
if (summaryText.trim() === CURRENT_VERSION) ok('shows current version');
else bad(`unexpected version text: "${summaryText}" (expected ${CURRENT_VERSION})`);

const collapsedVisible = await page.isVisible('#changelog .entries');
if (!collapsedVisible) ok('history is collapsed by default (small tag, not intrusive)');
else bad('history should not be visible before expanding');

await page.screenshot({ path: `${SHOTS}/v01-collapsed.png` });

await page.click('#changelog summary');
await page.waitForTimeout(150);
const expandedVisible = await page.isVisible('#changelog .entries');
if (expandedVisible) ok('clicking the tag expands the history');
else bad('history did not expand on click');

const versionHeaders = await page.$$eval('#changelog .entry-version', (els) => els.map((e) => e.textContent));
console.log(`  entries shown: ${JSON.stringify(versionHeaders)}`);
const expectedVersions = CHANGELOG.map((e) => e.version);
const missing = expectedVersions.filter((v) => !versionHeaders.includes(v));
if (missing.length === 0) ok(`all ${expectedVersions.length} release entries are present`);
else bad(`missing entries: ${missing.join(', ')}`);

await page.screenshot({ path: `${SHOTS}/v02-expanded.png` });

await browser.close();
console.log(`\n${errors.length === 0 ? 'ALL CHECKS PASSED.' : errors.length + ' PROBLEM(S): ' + errors.join('; ')}`);
if (errors.length > 0) process.exitCode = 1;
