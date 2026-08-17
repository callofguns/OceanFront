// Shared Playwright resolution for every browser-driven test under
// tools/tests/. This project ships with zero runtime dependencies, so
// Playwright is a devDependency used only here -- run `npm install` once and
// the bare specifier below resolves normally.
//
// The fallback path exists for the sandboxed environment this test suite was
// originally developed in, where Playwright is preinstalled globally at a
// fixed location rather than through package.json. It costs nothing on a
// normal checkout (the bare import always wins there) and means these tests
// keep working with zero setup in that sandbox specifically.
let pw;
try {
  pw = (await import('playwright')).default;
} catch {
  pw = (await import('/opt/node22/lib/node_modules/playwright/index.js')).default;
}

export const { chromium, devices } = pw;
