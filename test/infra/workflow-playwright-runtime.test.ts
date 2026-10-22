import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";

// ── THE FALSIFIER: the browser still installs, and text still measures, WITHOUT the fonts ────
//
// The static assertions above prove the command no longer calls apt. They cannot prove Chromium
// still runs. These two do, IN THE SAME CI JOB THAT INSTALLED IT — if `npx playwright install
// chromium` (no --with-deps) failed to produce a working browser, `chromium.launch()` throws here
// and this file fails rather than the failure surfacing as an unexplained shell-ux error.
// The launch PROMISE is assigned SYNCHRONOUSLY and teardown awaits it, never the resolved handle --
// the convention test/serve-browser-teardown.test.ts enforces across every browser-launching suite.
// Closing the handle leaks a browser when teardown fires before `before` resolved (e.g. a zero-match
// --test-name-pattern run), which is exactly what this file would otherwise do.
let browserPromise: Promise<Browser> | undefined;
let browser: Browser | undefined;
let launchError: unknown;
before(async () => {
  browserPromise = chromium.launch({ args: ["--no-sandbox"] });
  try {
    browser = await browserPromise;
  } catch (e) {
    launchError = e;
  }
});
after(async () => {
  const launched = await browserPromise;
  await launched?.close();
});

test("W1-T1027: chromium launches from an install that never ran apt", async () => {
  assert.equal(
    launchError,
    undefined,
    `chromium.launch() failed, so 'npx playwright install chromium' did not produce a working browser: ${String(launchError)}`,
  );
  assert.ok(browser, "expected a launched browser");
  assert.ok(browser!.version().length > 0, "expected a real browser version string");
});

test("W1-T1027: the console's own font stack still resolves and measures, with no font package installed", async () => {
  assert.ok(browser, "expected a launched browser (see the launch test above)");
  const page = await browser!.newPage();
  try {
    // The console declares `system-ui, -apple-system, "Segoe UI", sans-serif` — no family among the
    // nine --with-deps used to install. If NO font resolved, text would measure zero width and the
    // 390px no-horizontal-overflow assertion in test/serve.shell-ux.test.ts could not mean anything.
    await page.setContent(
      '<div id="probe" style="font-family: system-ui, -apple-system, \'Segoe UI\', sans-serif; font-size: 16px; display: inline-block;">Remudero console</div>',
    );
    const box = await page.evaluate(() => {
      const el = document.getElementById("probe")!;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    assert.ok(box.w > 0 && box.h > 0, `expected measurable text, got ${JSON.stringify(box)}`);
    // A zero-glyph fallback would collapse to the container; a real font gives width roughly
    // proportional to the string. This is a LOWER bound, deliberately loose — it must not become a
    // metrics assertion that breaks on a font revision.
    assert.ok(box.w > 40, `expected 16px Latin text to measure wider than 40px, got ${box.w}`);
  } finally {
    await page.close();
  }
});
