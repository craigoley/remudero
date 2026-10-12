/**
 * A fresh-tree review keeps the sweep's review options.
 *
 * When the daemon's own reviewer code is behind origin/main, `buildReviewerCodeFreshnessGate`
 * moves the review into a subprocess at a fresh worktree (W1-T3723). It forwarded only the PR
 * argument and `--repo`, so the sweep's `planOnlyFiling` and `executionMode` never reached the
 * child. The child then resolved a hand-filed plan PR on a `run-unfiled-<ms>` head to the
 * `unfiled` review key while the sweep looked for `PR-<n>`, and re-reviewed it every pass:
 * 2026-10-05, #9305 22 fresh-tree reviews, #9314 6, #9318 4, none merged. It also judged every
 * fresh-tree review `deterministic` instead of the `semantic` mode the sweep asked for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReviewerCodeFreshnessGate,
  resolveReviewTaskId,
  reviewOptionFlags,
  reviewOptionsFromFlags,
} from "../src/run-task.js";

const STALE = {
  status: "stale" as const,
  codeSha: "c0de000000000000000000000000000000000000",
  originMainSha: "fe94423b595a72b77bdb2ea7bf72daba603e3db7",
  changedPaths: ["src/run-task.ts"],
};

async function freshTreeArgs(reviewDeps: { planOnlyFiling?: boolean; executionMode?: "semantic" | "deterministic" }): Promise<string[]> {
  let seen: string[] = [];
  const gate = buildReviewerCodeFreshnessGate(
    () => STALE,
    () => {},
    async () => assert.fail("a stale reviewer must never judge in-process"),
    async (_pr, rest) => {
      seen = rest;
      return 0;
    },
  );
  assert.equal(await gate.call("9314", ["--repo", "remudero"], reviewDeps as never), 0);
  return seen;
}

test("a fresh-tree review receives the sweep's plan-only filing fact and execution mode as flags", async () => {
  assert.deepEqual(await freshTreeArgs({ planOnlyFiling: true, executionMode: "semantic" }), [
    "--repo", "remudero", "--plan-only-filing", "--execution-mode", "semantic",
  ]);
  assert.deepEqual(await freshTreeArgs({ planOnlyFiling: false }), ["--repo", "remudero", "--not-plan-only-filing"]);
  assert.deepEqual(await freshTreeArgs({}), ["--repo", "remudero"]);
});

test("the review CLI reads the forwarded flags back into the same options", () => {
  for (const opts of [
    { planOnlyFiling: true, executionMode: "semantic" as const },
    { planOnlyFiling: false, executionMode: "deterministic" as const },
    { planOnlyFiling: true },
    {},
  ]) {
    assert.deepEqual(reviewOptionsFromFlags(["--repo", "remudero", ...reviewOptionFlags(opts)]), opts);
  }
  assert.deepEqual(reviewOptionsFromFlags(["--execution-mode", "bogus"]), {}, "an unknown mode is not adopted");
});

test("a run-unfiled plan filing reviewed from a fresh tree keys under its PR, not the unfiled sentinel", async () => {
  const forwarded = reviewOptionsFromFlags(await freshTreeArgs({ planOnlyFiling: true, executionMode: "semantic" }));
  assert.equal(resolveReviewTaskId("", "run-unfiled-1791203001234", forwarded.planOnlyFiling ?? false), undefined);
  assert.equal(resolveReviewTaskId("", "run-unfiled-1791203001234", false), "unfiled", "the live shape without the fact");
});
