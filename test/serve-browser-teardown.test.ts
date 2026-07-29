// The six serve* suites that drive a REAL headless browser share one hazard that no test inside
// those files can catch, because it only fires when NONE of their tests run: on a
// `--test-name-pattern` that matches zero tests in the file, node still runs both file-scope
// hooks, but fires `after` ~0.2ms in -- while `chromium.launch()` is still in flight and the
// resolved `browser` handle is therefore still undefined. Closing that handle is a no-op, the
// browser that finishes launching a moment later has no reference left to close it, and its
// `--remote-debugging-pipe` holds the worker's event loop open. The run then HANGS until the
// harness kills it, leaking a chrome-headless-shell process and a
// playwright_chromiumdev_profile-* directory each time (177 such directories had accumulated on
// the box where this was diagnosed, plus ~14 orphaned processes with etimes of 2-12+ hours).
//
// This file is the guard. It is deliberately OUTSIDE the six files: a regression there is
// invisible from within, since the failing condition is "none of my tests ran".

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** This file's own path, relative to the repo root — excluded from the sweep below, since its
 * prose necessarily names the very call it is policing. */
const SELF = "test/serve-browser-teardown.test.ts";

/** Every test file that calls `chromium.launch()`. Derived by READING the tree rather than
 * hardcoding, so a seventh browser-driving suite added later is held to the same contract
 * automatically instead of quietly opting out of it. */
function browserLaunchingTestFiles(): string[] {
  const out = execFileSync("grep", ["-rl", "-F", "--include=*.test.ts", "--", "chromium.launch(", "test"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== SELF)
    .sort();
}

test("every browser-launching test file awaits the launch PROMISE in teardown, never the resolved handle", () => {
  const files = browserLaunchingTestFiles();
  assert.ok(files.length >= 6, `expected at least the six known browser suites, found ${files.length}`);
  for (const f of files) {
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    assert.match(
      src,
      /browserPromise = chromium\.launch\(/,
      `${f}: chromium.launch() must be assigned to browserPromise SYNCHRONOUSLY, so teardown can see it`,
    );
    assert.match(
      src,
      /const launched = await browserPromise;\s*\n\s*await launched\?\.close\(\);/,
      `${f}: teardown must await the launch promise and close what it resolves to`,
    );
    assert.doesNotMatch(
      src,
      /after\(async \(\) => \{\s*\n\s*(?:if \(browser\) )?await browser\.close\(\);/,
      `${f}: closing the resolved handle is the leak -- it is still undefined when teardown fires on a zero-match filter`,
    );
  }
});

/** Env for a nested `node --test`, with the parent runner's own marker REMOVED.
 *
 * `NODE_TEST_CONTEXT=child-v8` is set by the test runner on every process it spawns, and a nested
 * `node --test` that inherits it switches into child-reporter mode and exits in ~50ms without
 * running anything. An earlier draft of this file inherited it and the timing test below passed
 * against DELIBERATELY BROKEN code -- vacuously, because no test ever ran in the child. Stripping
 * it is what makes the subprocess a real reproduction. */
function cleanTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test("a zero-match name filter over a browser-launching suite exits 0 promptly instead of hanging on an orphaned browser", () => {
  // The real thing, in a real subprocess: this is the exact invocation that hung for the full
  // proof timeout before the fix. execFileSync's own timeout is the falsifier -- a regression
  // reintroduces the hang and this throws rather than silently taking longer.
  const started = Date.now();
  execFileSync(
    process.execPath,
    ["--test", "--import", "tsx", "--test-name-pattern", "zzz no such test title zzz", "test/serve.find.test.ts"],
    { cwd: REPO_ROOT, timeout: 90_000, stdio: "pipe", encoding: "utf8", env: cleanTestEnv() },
  );
  const elapsedMs = Date.now() - started;
  assert.ok(
    elapsedMs < 45_000,
    `a zero-match filtered run must finish promptly; took ${elapsedMs}ms (the pre-fix behaviour was to hang until killed)`,
  );
});

// DELIBERATELY NOT TESTED HERE: "zero chrome-headless-shell processes exist afterwards". That is
// a property of the whole MACHINE, not of this subprocess, so any other tenant running a browser
// at the same moment fails it. Observed while writing this file: a concurrent daemon worker's own
// `npm test` had four such processes alive, which failed an earlier draft of this assertion for a
// reason that had nothing to do with the code under test. The orphan is instead proven
// TRANSITIVELY and deterministically by the timing test above -- an orphaned browser is exactly
// what held the event loop open, so a prompt clean exit is the observable consequence of there
// being none.
