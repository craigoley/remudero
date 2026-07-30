// Every serve suite that drives a real browser must launch it the SAME way.
//
// This locks in the W1-T202 cleanup. Rounds 1 and 2 of that task added per-file launch
// mitigations -- a macOS-inert `--disable-dev-shm-usage` and a one-shot relaunch on
// rejection -- to two of the seven browser-launching suites, chasing a contention race
// that did not exist. The real cause was environmental: the review host had no Chromium
// build matching the pinned Playwright, so every launch failed deterministically and the
// gate reported it as a defect in the code under review.
//
// The lasting damage was DRIFT: two suites launching differently from the other five, with
// comments asserting a cause nobody had confirmed. This guard makes that drift structural
// rather than a matter of review vigilance -- the next per-file "just this one file" launch
// tweak fails here and has to argue for itself across all seven at once.
//
// NB: this file must never contain the Playwright launch call as a contiguous literal.
// test/serve-browser-teardown.test.ts enumerates browser-launching suites with a
// fixed-string `grep -rl -F` over test/, so writing it verbatim -- even in a comment --
// would recruit this file into a teardown-shape guard it has no browser to satisfy. The
// needle below is assembled across a concatenation seam for exactly that reason.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Assembled, never written contiguously — see the note above. Matched on the ASSIGNMENT
 * form rather than the bare call: the bare call also appears in the explanatory comments of
 * every suite and in test/serve-browser-teardown.test.ts's own grep needle, so counting it
 * would conflate prose with call sites. `browserPromise = <launch>` is the real thing, and
 * is itself load-bearing (teardown must be able to see the promise). */
const LAUNCH_CALL = "browserPromise = chromium.launch" + "(";

/** The one launch form all seven suites share. `--no-sandbox` is the only argument any of
 * them has ever legitimately needed. */
const CANONICAL_ARGS = '{ args: ["--no-sandbox"] }';

/** Every test file that launches a browser, read from the tree rather than hard-coded, so a
 * newly added suite is covered the day it lands. */
function browserLaunchingSuites(): string[] {
  const out = execFileSync("grep", ["-rl", "-F", "--include=*.test.ts", "--", LAUNCH_CALL, "test"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.endsWith("serve-launch-uniformity.test.ts"));
}

test("every browser-launching serve suite launches exactly ONCE — no retry-around-the-launch may creep back in", () => {
  const suites = browserLaunchingSuites();
  assert.ok(suites.length >= 5, `expected the serve browser suites to be discoverable, found ${suites.length}`);
  for (const f of suites) {
    const src = readFileSync(f, "utf8");
    const launches = src.split(LAUNCH_CALL).length - 1;
    // A relaunch-on-rejection is a SECOND call site. Requiring exactly one forbids that
    // shape structurally, without this guard needing to recognise any particular retry
    // spelling: a missing-executable failure fails identically on every attempt, so a
    // retry can only ever double the latency of a certain failure.
    assert.equal(launches, 1, `${f}: expected exactly one browser launch, found ${launches} (a launch retry?)`);
  }
});

test("every browser-launching serve suite uses the identical canonical launch arguments — no per-file flag drift", () => {
  for (const f of browserLaunchingSuites()) {
    const src = readFileSync(f, "utf8");
    const call = src.slice(src.indexOf(LAUNCH_CALL) + LAUNCH_CALL.length);
    const args = call.slice(0, call.indexOf(")") + 1);
    assert.ok(
      args.startsWith(CANONICAL_ARGS),
      `${f}: launch args drifted from the canonical ${CANONICAL_ARGS} — found ${args}`,
    );
  }
});

test("no serve suite carries the --disable-dev-shm-usage flag, which is a no-op on this host", () => {
  // macOS has no /dev/shm, so the flag relocates shared memory that was never there. It
  // was added on the theory that a constrained runner's /dev/shm was overflowing; the
  // actual failure was a missing browser binary.
  for (const f of browserLaunchingSuites()) {
    assert.equal(
      readFileSync(f, "utf8").includes("disable-dev-shm-usage"),
      false,
      `${f}: --disable-dev-shm-usage is inert on macOS and must not be reintroduced without evidence`,
    );
  }
});
