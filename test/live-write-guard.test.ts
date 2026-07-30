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
  liveWritesExempt,
  withLiveWritesAllowed,
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

// ── The per-test opt-out (operator ruling 2026-07-30, option 2) ─────────────────────
// Five suites legitimately drive these boundaries against their OWN containment, so the
// guard has to be suspendable at TEST granularity. These lock the two ways such a
// mechanism leaks, plus the regression that matters most: not wrapping is still refused.

test("REGRESSION LOCK: a boundary that does NOT wrap is still refused, so the opt-out did not make the guard inert", () => {
  assert.equal(liveWritesExempt(), false, "no exemption may be in effect before this test");
  assert.throws(
    () => assertLiveWriteAllowed("git-push", "unwrapped push", TEST_RUN),
    (e: unknown) => e instanceof LiveWriteBlockedError,
    "an unwrapped boundary must still throw",
  );
});

test("the opt-out suspends the guard only INSIDE the wrapped section", () => {
  assert.equal(liveWritesExempt(), false);
  const seen = withLiveWritesAllowed(() => {
    assert.equal(liveWritesExempt(), true, "exempt inside");
    assertLiveWriteAllowed("git-push", "wrapped push", TEST_RUN); // must NOT throw
    return "ran";
  });
  assert.equal(seen, "ran", "the wrapped section's return value passes through");
  assert.equal(liveWritesExempt(), false, "re-armed immediately after");
  assert.throws(() => assertLiveWriteAllowed("git-push", "after", TEST_RUN), LiveWriteBlockedError);
});

test("TRAP 1 throw: a wrapped section that THROWS leaves the guard armed again afterwards", () => {
  assert.throws(
    () =>
      withLiveWritesAllowed(() => {
        assert.equal(liveWritesExempt(), true, "exempt while inside");
        throw new Error("boom");
      }),
    /boom/,
    "the original error must propagate unchanged",
  );
  // Assert the RE-ARMED STATE directly, not merely the absence of an effect.
  assert.equal(liveWritesExempt(), false, "the exemption must not survive a throw");
  assert.throws(() => assertLiveWriteAllowed("gh-pr-create", "after throw", TEST_RUN), LiveWriteBlockedError);
});

test("TRAP 1 async: a wrapped ASYNC section stays exempt for the whole await and re-arms only after it settles", async () => {
  let exemptDuringAwait: boolean | undefined;
  const p = withLiveWritesAllowed(async () => {
    await new Promise((r) => setTimeout(r, 25));
    // If the restore ran synchronously, the guard would already be re-armed HERE and the
    // boundary would be refused mid-section — the exact early-restore bug.
    exemptDuringAwait = liveWritesExempt();
    assertLiveWriteAllowed("gh-pr-merge", "inside awaited work", TEST_RUN); // must NOT throw
    return "async-done";
  });
  assert.equal(liveWritesExempt(), true, "still exempt while the promise is pending");
  assert.equal(await p, "async-done");
  assert.equal(exemptDuringAwait, true, "exempt for the DURATION of the awaited work");
  assert.equal(liveWritesExempt(), false, "re-armed once the promise settles");
});

test("TRAP 1 async reject: a wrapped ASYNC section that REJECTS still re-arms the guard", async () => {
  await assert.rejects(
    withLiveWritesAllowed(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("async-boom");
    }),
    /async-boom/,
  );
  assert.equal(liveWritesExempt(), false, "the exemption must not survive an async rejection");
});

test("the opt-out NESTS without an inner section re-arming the guard for the outer one", () => {
  withLiveWritesAllowed(() => {
    withLiveWritesAllowed(() => {
      assert.equal(liveWritesExempt(), true);
    });
    // A boolean flag would have re-armed here; a depth counter must not.
    assert.equal(liveWritesExempt(), true, "the OUTER exemption survives the inner one ending");
    assertLiveWriteAllowed("git-push", "outer still exempt", TEST_RUN);
  });
  assert.equal(liveWritesExempt(), false);
});
