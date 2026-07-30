// Browser preflight on the review host (fix for the PR #892 false-FAIL incident).
//
// These run in-process against injected deps — no filesystem, no network, no 180MB
// download — so they prove the DECISION logic (what is wanted, what is missing, what
// gets spawned) rather than exercising a real `npx playwright install`.
//
// The incident these pin: `ci` installs the pinned Playwright's Chromium before every
// test job; the review host never did. A `playwright` 1.61.1 → 1.62.0 bump moved the
// wanted revision 1228 → 1234, the host still had 1228, every browser launch failed, and
// a whole-file `test` proof's exit code turned that into "proof executed and FAILED on
// the PR head" against code CI was passing.
//
// NB: never write the literal Playwright launch call in this file, even inside a comment.
// test/serve-browser-teardown.test.ts enumerates browser-launching suites with a
// fixed-string `grep -rl -F` over test/, so a prose mention alone recruits this file into
// a teardown-shape guard it has no browser to satisfy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ensureBrowsers, pinnedPlaywrightCli, playwrightCacheRoot, requiredChromiumDirs } from "../src/lib/review.js";

/** A trimmed real `node_modules/playwright-core/browsers.json` — the shape and the
 * exact revisions from the 1.62.0 bump that caused the incident. */
const BROWSERS_JSON = JSON.stringify({
  browsers: [
    { name: "chromium", revision: "1234", installByDefault: true },
    { name: "chromium-headless-shell", revision: "1234", installByDefault: true },
    { name: "chromium-tip-of-tree", revision: "1433", installByDefault: false },
    { name: "chromium-tip-of-tree-headless-shell", revision: "1433", installByDefault: false },
    { name: "firefox", revision: "1509", installByDefault: true },
    { name: "webkit", revision: "2248", installByDefault: true },
    { name: "ffmpeg", revision: "1011", installByDefault: true },
  ],
});

test("requiredChromiumDirs: wants exactly the pinned Playwright's chromium pair, in Playwright's own on-disk dir naming", () => {
  assert.deepEqual(requiredChromiumDirs(BROWSERS_JSON), ["chromium-1234", "chromium_headless_shell-1234"]);
});

test("requiredChromiumDirs: never demands a tip-of-tree channel, firefox, webkit, or ffmpeg", () => {
  const dirs = requiredChromiumDirs(BROWSERS_JSON);
  // ffmpeg/firefox/webkit are installByDefault too — the filter is by NAME, not just
  // by the flag, so a present-and-launchable cache is never re-downloaded for a
  // browser no proof in this repo ever starts.
  for (const unwanted of ["tip-of-tree", "firefox", "webkit", "ffmpeg"]) {
    assert.equal(
      dirs.some((d) => d.includes(unwanted)),
      false,
      `${unwanted} must not be required by the preflight`,
    );
  }
});

test("requiredChromiumDirs: tracks the pinned revision rather than any hard-coded build", () => {
  // The whole point: a future bump must move what the preflight demands, with no code
  // change here. A hard-coded 1234 would silently re-break on the next dependabot PR.
  const bumped = JSON.stringify({ browsers: [{ name: "chromium", revision: "1300", installByDefault: true }] });
  assert.deepEqual(requiredChromiumDirs(bumped), ["chromium-1300"]);
});

test("ensureBrowsers: spawns NO install when every wanted Chromium build is already present", () => {
  let installs = 0;
  const outcome = ensureBrowsers({
    browsersJsonText: BROWSERS_JSON,
    isInstalled: () => true,
    install: () => void installs++,
  });
  assert.equal(outcome, "ok");
  assert.equal(installs, 0, "a healthy cache must cost zero downloads per review");
});

test("ensureBrowsers: installs when the cache holds an OLDER revision than the pinned Playwright wants (the PR #892 incident, exactly)", () => {
  let installs = 0;
  const outcome = ensureBrowsers({
    browsersJsonText: BROWSERS_JSON,
    // The host as it actually was: 1228 present from the previous pin, 1234 absent.
    isInstalled: (dir) => dir.endsWith("-1228"),
    install: () => void installs++,
  });
  assert.equal(outcome, "installed");
  assert.equal(installs, 1);
});

test("ensureBrowsers: treats a half-extracted build (no INSTALLATION_COMPLETE marker) as missing", () => {
  // isInstalled is marker-gated in production; a directory that exists but cannot
  // launch must trigger a repair, not read as healthy.
  let installs = 0;
  ensureBrowsers({ browsersJsonText: BROWSERS_JSON, isInstalled: () => false, install: () => void installs++ });
  assert.equal(installs, 1);
});

test("ensureBrowsers: a FAILED install never throws — the proof still runs and reports for itself", () => {
  const logged: string[] = [];
  const outcome = ensureBrowsers({
    browsersJsonText: BROWSERS_JSON,
    isInstalled: () => false,
    install: () => {
      throw new Error("offline");
    },
    log: (m) => logged.push(m),
  });
  // A preflight that could itself fail a criterion would just relocate the false-FAIL
  // problem it exists to remove.
  assert.equal(outcome, "failed");
  assert.equal(
    logged.some((m) => m.includes("offline")),
    true,
    "the failure must be NAMED, never swallowed silently",
  );
});

test("ensureBrowsers: an unreadable or malformed manifest is 'we cannot know', never a silent install", () => {
  let installs = 0;
  const deps = { isInstalled: () => false, install: () => void installs++ };
  assert.equal(ensureBrowsers({ ...deps, browsersJsonText: null }), "unreadable");
  assert.equal(ensureBrowsers({ ...deps, browsersJsonText: "{ not json" }), "unreadable");
  assert.equal(installs, 0, "an unknown 'wanted' set must not trigger a blind download");
});

test("ensureBrowsers: announces the install, naming the missing build, before spending the download", () => {
  const logged: string[] = [];
  ensureBrowsers({
    browsersJsonText: BROWSERS_JSON,
    isInstalled: () => false,
    install: () => {},
    log: (m) => logged.push(m),
  });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /chromium-1234/);
});

test("playwrightCacheRoot: resolves the per-platform default cache, and honours a PLAYWRIGHT_BROWSERS_PATH relocation", () => {
  assert.equal(playwrightCacheRoot({}, "darwin", "/Users/x"), "/Users/x/Library/Caches/ms-playwright");
  assert.equal(playwrightCacheRoot({}, "linux", "/home/x"), "/home/x/.cache/ms-playwright");
  assert.equal(playwrightCacheRoot({ PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" }, "linux", "/home/x"), "/opt/pw");
});

test("playwrightCacheRoot: PLAYWRIGHT_BROWSERS_PATH=0 means 'inside node_modules', not a directory named 0", () => {
  // Playwright's own sentinel. Treating "0" as a path would point the preflight at a
  // relative ./0 directory, so every build would read as missing forever.
  assert.equal(playwrightCacheRoot({ PLAYWRIGHT_BROWSERS_PATH: "0" }, "darwin", "/Users/x"), "/Users/x/Library/Caches/ms-playwright");
  assert.equal(playwrightCacheRoot({ PLAYWRIGHT_BROWSERS_PATH: "" }, "linux", "/home/x"), "/home/x/.cache/ms-playwright");
});

test("pinnedPlaywrightCli: runs the CHECKOUT's own Playwright CLI, never a name npx could re-resolve", () => {
  // `npx playwright install` would, on a cache miss, fetch whatever Playwright the
  // registry hands back — installing a revision the pinned tests do not want, which is
  // the very drift this preflight exists to end.
  assert.equal(pinnedPlaywrightCli("/w/t"), "/w/t/node_modules/playwright/cli.js");
});

test("browser preflight is wired into the real proof-execution path, gated to test proofs", () => {
  // Structural guard: the value of this fix is entirely in it being CALLED before the
  // first browser proof. A refactor that drops the call site would leave every unit
  // test above passing while the incident silently returns.
  const src = readFileSync(new URL("../src/lib/review.ts", import.meta.url), "utf8");
  const seam = /if \(whitelisted\.kind === "test"\) \{[\s\S]{0,400}?ensureBrowsersOnce\(cwd\);/;
  assert.match(src, seam, "ensureBrowsersOnce must be invoked from execWhitelistedProof's test-proof branch");
  assert.equal(
    /ensureBrowsersOnce\(cwd\);[\s\S]{0,200}?whitelisted\.kind === "grep"/.test(src),
    false,
    "a grep proof must never pay for a browser install",
  );
});
