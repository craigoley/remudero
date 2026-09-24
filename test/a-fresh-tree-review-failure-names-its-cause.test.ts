/**
 * W1-T4055 — A FRESH-TREE REVIEW THAT FAILS SAYS WHY.
 *
 * On 2026-09-20/21 the fresh-tree review path exited non-zero 52 times in 53, and 136 reviews were
 * skipped as stale reviewer code, while the ledger carried only `exit_code` or a bare
 * `fresh_tree: "unavailable"`. Install, checkout, auth or a reviewer error: the one process that saw
 * the cause threw it away. These fixtures drive the PRODUCTION spawn against a real executable
 * `bin/rmd` in a temp tree, so the tail that reaches the row is the tail the child really wrote.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { makeTempDir } from "../src/lib/tmp.js";
import {
  FRESH_TREE_FAILURE_MAX_CHARS,
  buildFreshTreeReviewRunner,
  buildReviewerCodeFreshnessGate,
  freshTreeFailureText,
  spawnRmdReviewForFreshTree,
} from "../src/run-task.js";

const CODE_SHA = "aaaaaaaaaaaa";
const MAIN_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STALE = { status: "stale" as const, codeSha: CODE_SHA, originMainSha: MAIN_SHA, changedPaths: ["src/lib/review.ts"] };

type Row = { step: string; extra?: Record<string, unknown> };

/** A reviewer tree whose `bin/rmd` runs `script` — the path the runner derives for MAIN_SHA. */
function reviewerTree(script: string): { root: string; cleanup: () => void } {
  const root = makeTempDir("t4055-fresh-tree");
  const bin = join(root, `reviewer-${MAIN_SHA.slice(0, 12)}`, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "rmd"), `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(join(bin, "rmd"), 0o755);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The production gate over the production runner and spawn; only git and the worktree cut are faked. */
async function reviewThroughGate(
  root: string,
  over: { inspectExistingWorktree?: () => "absent" | "reusable" | "unsafe" } = {},
): Promise<{ code: number; rows: Row[] }> {
  const rows: Row[] = [];
  const runner = buildFreshTreeReviewRunner("/repo", {
    git: () => "",
    addWorktree: () => {},
    inspectExistingWorktree: over.inspectExistingWorktree ?? (() => "absent"),
    prepareWorktree: () => true,
    spawnReview: spawnRmdReviewForFreshTree,
    worktreeRoot: root,
  });
  const gate = buildReviewerCodeFreshnessGate(
    () => STALE,
    (step, extra) => { rows.push({ step, extra }); },
    async () => assert.fail("a stale reviewer must never judge in-process"),
    runner,
  );
  const code = await gate.call("5883", [], {} as never);
  return { code, rows };
}

test("W1-T4055: a failed fresh-tree review records its stderr tail", async () => {
  const tree = reviewerTree([
    'echo "loading reviewer" >&2',
    'echo "Error [ERR_MODULE_NOT_FOUND]: Cannot find package \'yaml\' imported from src/lib/plan.ts" >&2',
    "exit 3",
  ].join("\n"));
  try {
    const { code, rows } = await reviewThroughGate(tree.root);
    assert.equal(code, 3);
    const ran = rows.find((r) => r.step === "review.ran_from_fresh_tree");
    assert.equal(ran?.extra?.exit_code, 3);
    assert.match(String(ran?.extra?.failure), /\[ERR_MODULE_NOT_FOUND\]: Cannot find package 'yaml'/);
    assert.match(String(ran?.extra?.failure), /loading reviewer/, "a short stderr is carried whole");
  } finally {
    tree.cleanup();
  }
});

test("W1-T4055: a fresh-tree review killed by a signal names the signal", async () => {
  // An OOM-killed child writes nothing; "no stderr" would hide the one fact there is.
  const tree = reviewerTree("kill -KILL $$");
  try {
    const { code, rows } = await reviewThroughGate(tree.root);
    assert.equal(code, 1);
    assert.equal(rows.find((r) => r.step === "review.ran_from_fresh_tree")?.extra?.failure, "killed by SIGKILL");
  } finally {
    tree.cleanup();
  }
});

test("W1-T4055: a clean fresh-tree review carries no failure", async () => {
  // CONTROL: the field is evidence of a failure, so a success must never grow one.
  const tree = reviewerTree('echo "reviewed" >&2\nexit 0');
  try {
    const { code, rows } = await reviewThroughGate(tree.root);
    assert.equal(code, 0);
    const ran = rows.find((r) => r.step === "review.ran_from_fresh_tree");
    assert.equal(ran?.extra?.exit_code, 0);
    assert.equal("failure" in (ran?.extra ?? {}), false);
  } finally {
    tree.cleanup();
  }
});

test("W1-T4055: an unavailable fresh tree records its reason", async () => {
  // Two ways the child never runs: the reviewer path is unsafe to reuse, and there is no bin/rmd at all.
  const root = makeTempDir("t4055-unavailable");
  try {
    const unsafe = await reviewThroughGate(root, { inspectExistingWorktree: () => "unsafe" });
    const unsafeSkip = unsafe.rows.find((r) => r.step === "review.skipped_stale_reviewer_code");
    assert.equal(unsafeSkip?.extra?.fresh_tree, "unavailable");
    assert.match(String(unsafeSkip?.extra?.fresh_tree_reason), /is not an exact clean detached checkout of b{40}/);

    const missing = await reviewThroughGate(root);
    const missingSkip = missing.rows.find((r) => r.step === "review.skipped_stale_reviewer_code");
    assert.equal(missingSkip?.extra?.fresh_tree, "unavailable");
    assert.match(String(missingSkip?.extra?.fresh_tree_reason), /ENOENT/);
    assert.equal(missing.rows.some((r) => r.step === "review.ran_from_fresh_tree"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4055: the failure text is bounded", async () => {
  // Five thousand noisy lines, then the one that matters. The row keeps the TAIL, where it lands.
  const tree = reviewerTree([
    'for i in $(seq 1 5000); do echo "noise line $i $(printf "x%.0s" $(seq 1 60))" >&2; done',
    'echo "FATAL: the last line is the cause" >&2',
    "exit 1",
  ].join("\n"));
  try {
    const { rows } = await reviewThroughGate(tree.root);
    const failure = String(rows.find((r) => r.step === "review.ran_from_fresh_tree")?.extra?.failure);
    assert.ok(failure.length <= FRESH_TREE_FAILURE_MAX_CHARS, `failure is ${failure.length} chars`);
    assert.match(failure, /FATAL: the last line is the cause$/);
    assert.doesNotMatch(failure, /noise line 1 /, "the head of a long stderr is what gets cut");
    assert.match(failure, /^…\[\d+ earlier chars cut\]/, "a cut is never silent");
  } finally {
    tree.cleanup();
  }
});

test("W1-T4055: a credential in the failure text is scrubbed before it is cut", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const text = freshTreeFailureText(`fatal: https://x-access-token:${token}@github.com/o/r.git\nremote: ${token}`);
  assert.doesNotMatch(text, /ghp_A/);
  assert.match(text, /https:\/\/<redacted>@github\.com/);
  // An empty stderr still says so, rather than ledgering an empty string.
  assert.equal(freshTreeFailureText("  \n "), "no stderr");
});
