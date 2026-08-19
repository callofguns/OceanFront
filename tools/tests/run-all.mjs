// Runs the full committed regression suite in one shot: starts the dev
// server, runs every test script in tools/tests/ against it in sequence, and
// prints a pass/fail summary. Exits non-zero if anything failed.
//
//   npm test
//   node tools/tests/run-all.mjs
//
// `pacing-sweep.mjs` is deliberately NOT included here -- it is a balance
// tuning tool with no pass/fail assertions (see tools/tests/README.md), not a
// regression check, and a full sweep can take a couple of minutes. Run it by
// hand when tuning config.js.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTS_DIR = path.join(ROOT, 'tools', 'tests');
const PORT = Number(process.env.PORT || 8123);
const BASE = `http://localhost:${PORT}`;

// Headless first (fast, no server needed), then everything that drives a
// real browser against the dev server.
const HEADLESS = ['encirclement-test.mjs', 'ai-behavior-test.mjs', 'combat-cost-test.mjs'];
const BROWSER_TESTS = [
  'browsertest.mjs',
  'mobiletest.mjs',
  'tap-and-narrow-test.mjs',
  'dup-listener-and-outside-test.mjs',
  'tap-reliability-verify.mjs',
  'version-tag-check.mjs',
  'difficulty-ui-verify.mjs',
  'pop-bar-test.mjs',
];

function run(script, env = {}) {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(70)}\n▶ ${script}\n${'='.repeat(70)}`);
    const child = spawn(process.execPath, [path.join(TESTS_DIR, script)], {
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const results = [];

for (const script of HEADLESS) {
  results.push([script, await run(script)]);
}

console.log(`\nStarting dev server on :${PORT} for the browser suite...`);
const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(PORT)], {
  stdio: 'ignore',
});
const serverUp = await waitForServer(BASE);
if (!serverUp) {
  console.error(`Server never came up on ${BASE} -- aborting the browser suite.`);
  server.kill();
  process.exit(1);
}

try {
  for (const script of BROWSER_TESTS) {
    results.push([script, await run(script, { BASE })]);
  }
} finally {
  server.kill();
}

console.log(`\n${'='.repeat(70)}\nSUMMARY\n${'='.repeat(70)}`);
let allPassed = true;
for (const [script, passed] of results) {
  console.log(`  ${passed ? '✓ PASS' : '✗ FAIL'}  ${script}`);
  if (!passed) allPassed = false;
}
console.log('');
if (allPassed) {
  console.log('ALL REGRESSION TESTS PASSED.');
} else {
  console.log('SOME TESTS FAILED -- see output above for details.');
  process.exitCode = 1;
}
