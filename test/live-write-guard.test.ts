// The live-write guard (operator ruling 2026-07-30, recon-AQ option 2).
//
// recon-AQ established that test/mounts-wiring.test.ts reaches the LIVE repo: over three
// days it pushed 6 branches, opened 5 PRs, filed 3 needs-human issues, and left one PR
// with auto-merge ARMED, at real model spend. These tests lock the four outward boundaries
// shut under the test runner, and lock them OPEN everywhere else so the daemon is unaffected.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertLiveWriteAllowed,
  isTestRunner,
  LiveWriteBlockedError,
  LIVE_WRITE_OVERRIDE_ENV,
  type LiveWriteBoundary,
} from "../src/lib/live-write-guard.js";

/** The env a real daemon/operator process carries: no runner variable at all. */
const REAL_RUN: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/Users/x" };
/** The env node's own test runner sets — measured, not assumed (see the module header). */
const TEST_RUN: NodeJS.ProcessEnv = { ...REAL_RUN, NODE_TEST_CONTEXT: "child-v8" };

const BOUNDARIES: LiveWriteBoundary[] = ["git-push", "gh-pr-create", "gh-pr-merge", "gh-issue-create"];

test("the signal is NODE_TEST_CONTEXT, and NODE_ENV is deliberately NOT used", () => {
  // NODE_ENV is unset in BOTH contexts on this host, so a guard keyed on it would never
  // fire — the inert-module trap this repo already fell into twice.
  assert.equal(isTestRunner(REAL_RUN), false, "a real daemon run must not look like a test");
  assert.equal(isTestRunner(TEST_RUN), true, "a node --test run must be detected");
  assert.equal(isTestRunner({ ...REAL_RUN, NODE_ENV: "test" }), false, "NODE_ENV must NOT arm the guard");
});

test("the signal is presence-tested, so a future runner value cannot silently disarm it", () => {
  assert.equal(isTestRunner({ ...REAL_RUN, NODE_TEST_CONTEXT: "child-v8" }), true);
  assert.equal(isTestRunner({ ...REAL_RUN, NODE_TEST_CONTEXT: "some-future-value" }), true);
  assert.equal(isTestRunner({ ...REAL_RUN, NODE_TEST_CONTEXT: "" }), false, "empty is not a runner");
});

test("every outward boundary REFUSES under the test runner, naming itself", () => {
  for (const b of BOUNDARIES) {
    assert.throws(
      () => assertLiveWriteAllowed(b, "detail here", TEST_RUN),
      (e: unknown) => {
        assert.ok(e instanceof LiveWriteBlockedError, `${b} must throw LiveWriteBlockedError`);
        assert.equal(e.boundary, b, "the error must NAME the boundary it refused");
        assert.match(e.message, /REFUSED/, "the refusal must be loud, not a silent no-op");
        assert.match(e.message, new RegExp(b), "the message must carry the boundary name");
        return true;
      },
      `${b} must refuse under the test runner`,
    );
  }
});

test("REGRESSION LOCK: with the signal absent every boundary behaves exactly as before", () => {
  // The daemon must be completely unaffected. Not "throws something else" — returns cleanly.
  for (const b of BOUNDARIES) {
    assert.doesNotThrow(() => assertLiveWriteAllowed(b, "detail here", REAL_RUN), `${b} must be a no-op in a real run`);
  }
});

test("a deliberate override lets an intended live write through, so the guard is narrow", () => {
  const opted: NodeJS.ProcessEnv = { ...TEST_RUN, [LIVE_WRITE_OVERRIDE_ENV]: "1" };
  for (const b of BOUNDARIES) {
    assert.doesNotThrow(() => assertLiveWriteAllowed(b, "detail here", opted));
  }
  // Only the exact opt-in value counts — a stray truthy string must NOT disarm it.
  assert.throws(() => assertLiveWriteAllowed("git-push", "d", { ...TEST_RUN, [LIVE_WRITE_OVERRIDE_ENV]: "yes" }));
});

test("STRUCTURAL: every outward-effect call site in src/ is guarded — this is what keeps containment total", () => {
  // The four boundaries have NO single choke point (8 push sites, 5 merge, 4 pr-create,
  // 1 issue-create across five files), so "remember to guard" would decay into partial
  // containment — which is worse than none because it invites false confidence. This test
  // is the replacement for a choke point: a NEW unguarded outward call fails the build.
  const SHAPES = [
    '"push", "origin", "HEAD"',
    '"pr", "create"',
    '"pr", "merge"',
    '"issue", "create"',
    "refs/heads/${LANDING_BRANCH}",
  ];
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const p = join(dir, e);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });

  const unguarded: string[] = [];
  for (const file of walk("src")) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!SHAPES.some((s) => line.includes(s))) return;
      if (line.includes("assertLiveWriteAllowed")) return;
      // guarded when the assert appears on the preceding line, or anywhere in the
      // enclosing few lines above (a builder guard at the top of its function).
      const window = lines.slice(Math.max(0, i - 8), i).join("\n");
      if (!window.includes("assertLiveWriteAllowed")) unguarded.push(`${file}:${i + 1} ${line.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(unguarded, [], `these outward call sites are NOT guarded:\n${unguarded.join("\n")}`);
});
