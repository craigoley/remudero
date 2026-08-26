import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { loadPolicy, policyPath, type Policy } from "../src/lib/policy.js";
import { retroTriggerCheck } from "../src/run-task.js";

// ── W1-T2288: `retroShippedGithubGateway`'s OWN `mergedCommits` THUNK ────────────────────────
//
// The trigger's only route to a merge that has no run at all (a plan/triage/feedback filing) is
// `github.mergedCommits?.()`, and the REAL implementation is a `git log` shell-out inside
// `retroShippedGithubGateway` (run-task.ts). Every existing suite injects `deps.github`, so the
// factory — and therefore that thunk — never runs: `test/retro-trigger-corpus.test.ts` and
// `test/retro-trigger-check.test.ts` together leave the whole gateway at zero hits.
//
// REACHING IT NEEDS `deps.github` OMITTED, AND THAT RUNS INTO A GATE. `retroTriggerCheck` calls
// `github.unavailable?.()` BEFORE it calls `mergedCommits`, and the real `unavailable` is
// `probeGithubThrottle` (lib/retro.ts) — a live `gh api rate_limit`. MEASURED BOTH WAYS on this
// tree: with an authenticated `gh` the check returns a decision in ~207ms and the thunk runs;
// with `gh` UNAUTHENTICATED — which is CI's condition, since ci.yml sets no `GH_TOKEN` anywhere —
// the probe returns its failure string, the check short-circuits in ~19ms and the thunk never
// runs. A test that simply omitted `deps.github` would therefore pass locally and cover nothing
// in CI, which is the silent half of the shape this repo files shards about.
//
// SO THE PROBE IS PATH-STUBBED, the same idiom test/arm-at-open.test.ts and
// test/architect-mount.test.ts already use for `gh`: a fake `gh` on PATH answers the throttle
// probe healthily, `unavailable()` returns undefined, and `mergedCommits` runs the REAL `git log`
// against the REAL checkout. Nothing about the git read is stubbed — that is the line under test.

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** A `gh` that answers `probeGithubThrottle`'s `rate_limit --jq .rate.remaining` healthily and
 *  nothing else — the narrowest stub that gets past the gate. */
function healthyGhOnPath(): { bin: string; restore: () => void } {
  const bin = mkdtempSync(join(tmpdir(), "retro-gw-gh-stub-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 4321\nexit 0\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  return {
    bin,
    restore: () => {
      process.env.PATH = oldPath;
      rmSync(bin, { recursive: true, force: true });
    },
  };
}

function fixtureConfig(): Config {
  const root = mkdtempSync(join(tmpdir(), "retro-gw-root-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return { claudeBin: "/bin/true", root };
}

const SHIPPED_POLICY: Policy = loadPolicy(policyPath(REPO_ROOT));
/** Thresholds high enough that the decision below is driven by the COUNT, never by a day bound. */
function policyFixture(mergesThreshold: number): Policy {
  return { ...SHIPPED_POLICY, values: { ...SHIPPED_POLICY.values, retro: { mergesThreshold, daysThreshold: 99_999 } } };
}

test("the real gateway's mergedCommits shells git log over full history and feeds the trigger's runless count", () => {
  const gh = healthyGhOnPath();
  try {
    // `deps.github` DELIBERATELY OMITTED — that omission is what builds the real gateway.
    const decision = retroTriggerCheck(new Date("2026-08-26T00:00:00.000Z"), {
      config: fixtureConfig(),
      policy: policyFixture(1),
    });
    assert.notEqual(
      decision,
      undefined,
      "the throttle probe short-circuited — the gateway's mergedCommits never ran and this test would prove nothing",
    );
    assert.equal(decision!.fire, true);
    assert.equal(decision!.reason, "merges");
    // The ledger fixture is an EMPTY state dir, so `shipped` contributes nothing: every one of
    // these merges came through `mergedCommits` — the thunk under test — and nowhere else.
    assert.ok(
      decision!.mergesSinceMarker > 0,
      `mergesSinceMarker must come from the git-log read; saw ${decision!.mergesSinceMarker}`,
    );
    // FALSIFIER ON THE COUNT ITSELF: it must track this checkout's real commit history rather
    // than being any nonzero number the thunk happens to produce.
    const realCommits = execFileSync("git", ["-C", REPO_ROOT, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
    assert.ok(
      decision!.mergesSinceMarker <= Number(realCommits),
      `the runless count (${decision!.mergesSinceMarker}) cannot exceed this checkout's commit count (${realCommits})`,
    );
  } finally {
    gh.restore();
  }
});

test("the same call with an UNHEALTHY throttle probe short-circuits before mergedCommits — the gate this suite had to get past is real", () => {
  const bin = mkdtempSync(join(tmpdir(), "retro-gw-gh-exhausted-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 0\nexit 0\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const decision = retroTriggerCheck(new Date("2026-08-26T00:00:00.000Z"), {
      config: fixtureConfig(),
      policy: policyFixture(1),
    });
    assert.equal(decision, undefined, "an exhausted probe must stop the check before it reads any merge signal");
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});
