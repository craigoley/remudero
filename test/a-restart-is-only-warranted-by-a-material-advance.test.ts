import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceIsMaterial,
  checkServiceFreshness,
  daemonFreshnessFromService,
  MATERIAL_ADVANCE_PATHS,
  type GitRunner,
} from "../src/lib/self-sync.js";

// W1-T2964 — A RESTART IS ONLY WARRANTED BY A MATERIAL ADVANCE.
//
// Freshness compares SHAS, so any commit on origin/main replaces the daemon process — including one
// that changes only a plan shard or a doc, which cannot alter the resident module graph a restart
// exists to reload. Measured over the last 60 commits on origin/main (2026-09-06): 31 material, 27
// plan/docs/test/CI only. Each of those 27 costs a full boot, and main can advance again during it.
//
// The asymmetry that decides every uncertain case: a restart that was not needed costs a boot; a
// restart that was needed and skipped leaves the daemon reasoning with stale code indefinitely.

const HEAD = "1111111111111111111111111111111111111111";
const ORIGIN = "2222222222222222222222222222222222222222";

/** A git stub that answers the four calls `checkServiceFreshness` makes, with a scripted diff. */
function gitWith(diff: string | Error): GitRunner {
  return (args: string[]): string => {
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-parse") return args[1] === "HEAD" ? HEAD : ORIGIN;
    if (args[0] === "status") return "";
    if (args[0] === "diff") {
      if (diff instanceof Error) throw diff;
      return diff;
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

const assess = (diff: string | Error) => checkServiceFreshness("/repo", {}, { git: gitWith(diff) });

// ── claim 1 ────────────────────────────────────────────────────────────────────
test("W1-T2964: a plan-only advance is not material", () => {
  assert.equal(
    advanceIsMaterial(["plan/tasks.d/W1-T2964-something.yaml", "MASTER-PLAN.md"]),
    false,
    "a shard and a plan doc change nothing this process has loaded",
  );
  assert.equal(
    advanceIsMaterial(["docs/forensics/daemon.md", "test/daemon.test.ts", ".github/workflows/ci.yml", "learnings/x.yaml"]),
    false,
    "docs, tests, CI config and learnings are never loaded by the running daemon",
  );

  // End to end, through the real assessment and the real adapter — not the predicate alone.
  const svc = assess("plan/tasks.d/W1-T2964-something.yaml\nMASTER-PLAN.md\n");
  assert.equal(svc.status, "assessed");
  assert.deepEqual(
    svc.status === "assessed" ? svc.behind?.changedPaths : undefined,
    ["plan/tasks.d/W1-T2964-something.yaml", "MASTER-PLAN.md"],
    "the assessment records WHAT the advance touched, not merely that it happened",
  );
  assert.deepEqual(
    daemonFreshnessFromService(svc),
    { stale: false },
    "and the adapter declines to restart a process the advance cannot affect",
  );
});

// ── claim 2 ────────────────────────────────────────────────────────────────────
test("W1-T2964: a src advance is material", () => {
  for (const path of ["src/lib/daemon.ts", "bin/rmd", "package.json", "package-lock.json", "tsconfig.json"]) {
    assert.equal(advanceIsMaterial([path]), true, `${path} changes what this process loads`);
  }
  assert.equal(
    advanceIsMaterial(["plan/tasks.yaml", "docs/x.md", "src/lib/review.ts"]),
    true,
    "ONE material path in a mixed advance is enough — materiality is not a majority vote",
  );

  const svc = assess("plan/tasks.yaml\nsrc/lib/review.ts\n");
  assert.deepEqual(
    daemonFreshnessFromService(svc),
    { stale: true, oldSha: HEAD, newSha: ORIGIN },
    "a material advance still reports stale with both shas, exactly as before",
  );

  // The table is the contract: every entry must be one the daemon really loads, so a later edit
  // that adds a never-loaded path (and silently suppresses restarts for it) fails here.
  assert.deepEqual(
    [...MATERIAL_ADVANCE_PATHS],
    ["src/", "bin/", "package.json", "package-lock.json", "tsconfig.json"],
    "the material set is exactly the resident module graph and what resolves it",
  );
});

// ── claim 3 ────────────────────────────────────────────────────────────────────
test("W1-T2964: an unreadable diff fails toward material", () => {
  assert.equal(advanceIsMaterial(undefined), true, "no path list at all — the diff could not be read");
  assert.equal(advanceIsMaterial([]), true, "an EMPTY list is not evidence of an empty advance, only of a silent read");
  assert.equal(advanceIsMaterial([""]), true, "a blank entry is unaccountable, so it is material");

  // A throwing `git diff` must not become a suppressed restart: the assessment records `undefined`
  // and the adapter still reports stale. This is the arm that makes the feature safe to ship —
  // without it, a git failure would silently pin the daemon on old code forever.
  const svc = assess(new Error("fatal: bad object"));
  assert.equal(svc.status, "assessed");
  assert.equal(
    svc.status === "assessed" ? svc.behind?.changedPaths : "unset",
    undefined,
    "an unreadable diff is recorded as unknown, never as an empty advance",
  );
  assert.deepEqual(
    daemonFreshnessFromService(svc),
    { stale: true, oldSha: HEAD, newSha: ORIGIN },
    "and the daemon restarts anyway — the uncertain case takes the cheap side",
  );
});
