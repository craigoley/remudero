import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSelfHealNothingChanged } from "../src/lib/fix-rung-classify.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixRung } from "./helpers/run-task-test.js";
import { ghShim } from "./helpers/gh-shim.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { SpawnWorkerArgs } from "../src/lib/worker.js";
import type { ReviewVerdict } from "../src/lib/review.js";

const R = "the worker changed nothing";

test("W1-T5334: fix_refusal:the-worker-changed-nothing is prevented, not retried", () => {
  assert.equal(shouldSelfHealNothingChanged("FIXED", R, 1), true);
  assert.equal(shouldSelfHealNothingChanged(undefined, R, 1), true);
  assert.equal(shouldSelfHealNothingChanged("FLAKE", R, 1), true);
  assert.equal(shouldSelfHealNothingChanged("BASE_RED", R, 1), false);
  assert.equal(shouldSelfHealNothingChanged(undefined, R, 2), false);
  assert.equal(shouldSelfHealNothingChanged("FIXED", R, 2), false);
  assert.equal(shouldSelfHealNothingChanged("FLAKE", R, 2), false);
  assert.equal(shouldSelfHealNothingChanged("FIXED", "other reason", 1), false);
  assert.equal(shouldSelfHealNothingChanged(undefined, "other reason", 1), false);
});

type Verdict = ReviewVerdict & { headSha: string; reviewerOutcome: string; verdictWithheld?: string };
function verdict(met: boolean): Verdict {
  return {
    state: met ? "success" : "failure", headSha: "head", reviewerOutcome: "success",
    criteria: [{ claim: "repair", proof: "unit test: repair", met, reason: "observed", proof_exec: met ? "executed_pass" : "executed_fail" }],
    testTheater: false, summary: met ? "passed" : "failed", floorDegraded: false,
    capped: false, keywordOnly: false, planOnly: false,
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-noop-prevention-"));
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const spawned: SpawnWorkerArgs[] = [];
  const reviewed: Array<Parameters<Parameters<typeof runFixRung>[0]["deps"]["runReview"]>[0]> = [];
  const reachedWorker = new Error("fixture reached the fix worker");
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };
  const options: Parameters<typeof runFixRung>[0] = {
    taskId: "W1-T10029", runId: "W1-T10029-fixture",
    task: { id: "W1-T10029", title: "repair", files: ["src/repair.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/1", branch: "run-W1-T10029-1730000000000",
    worktreePath: dir, initialSessionId: "", initialReview: { ...verdict(false), reviewerOutcome: "sweep-reconstructed" },
    strikeCap: 1, mount, settingsFile: join(dir, "settings.json"), config: {} as Config,
    budgetUsd: 1, reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: dir, reviewerMount: mount },
    deps: {
      spawn: async (args) => { spawned.push(args); throw reachedWorker; },
      runReview: async (args) => { reviewed.push(args); return verdict(true); },
      fetchPrBody: async () => "The current PR body.",
      waitForCiGreen: async () => { assert.fail("a review-only repair does not push or wait for a new head"); },
      push: () => { assert.fail("no worker commit to push"); },
      harnessCommitForShellLessWorker: () => { assert.fail("no worker edits to commit"); },
      issues: { create: () => { assert.fail("no escalation needed"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(dir, "ledger.ndjson"), log: (step, extra) => { logs.push({ step, extra }); },
      say: () => {}, account: (result) => result,
    },
  };
  return { options, logs, spawned, reviewed, reachedWorker, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("W1-T10029: fix_refusal:the-worker-changed-nothing is prevented, not retried", async () => {
  const f = fixture();
  try {
    const result = await runFixRung(f.options);
    assert.equal(result.outcome, "fixed");
    assert.equal(result.strikes, 0);
    assert.equal(result.retriggers, 0);
    assert.equal(f.spawned.length, 0);
    assert.equal(f.reviewed.length, 1);
    assert.equal(f.reviewed[0].report, "The current PR body.");
    assert.equal(f.reviewed[0].reviewInputBody, f.reviewed[0].report);
    assert.equal(f.reviewed[0].reportIsSubstitute, false);
    assert.equal(f.reviewed[0].implementationReport, undefined);
    assert.ok(f.logs.some((row) => row.step === "fix.pre_dispatch_review" && row.extra?.head_sha === "head"));
    assert.equal(f.logs.some((row) => ["fix.dispatch", "fix.commit_refused", "fix.done"].includes(row.step)), false);
  } finally { f.clean(); }
});

test("pre-dispatch review keeps a genuine failure actionable and uses its fresh criterion", async () => {
  const f = fixture();
  let reads = 0;
  f.options.deps.runReview = async () => {
    reads++;
    return { ...verdict(false), criteria: [{ ...verdict(false).criteria[0], claim: "fresh actionable failure" }] };
  };
  try {
    await assert.rejects(runFixRung(f.options), f.reachedWorker);
    assert.equal(reads, 1);
    assert.equal(f.spawned.length, 1);
    assert.match(f.spawned[0].prompt, /fresh actionable failure/);
  } finally { f.clean(); }
});

test("an unchanged fresh failure does not manufacture a second round or a snapshot stand-down", async () => {
  const f = fixture();
  let reads = 0;
  f.options.deps.runReview = async () => { reads++; return verdict(false); };
  f.options.deps.readLiveState = async () => ({ ok: true, state: "OPEN" });
  f.options.deps.captureWorktreeSnapshot = async () => ({ status: "", diff: "", untrackedHash: "unchanged" });
  try {
    await assert.rejects(runFixRung(f.options), f.reachedWorker);
    assert.equal(reads, 1);
    assert.equal(f.spawned.length, 1);
    assert.equal(f.logs.some((row) => row.step === "fix.stood_down"), false);
  } finally { f.clean(); }
});

for (const read of ["body", "review"] as const) {
  test(`pre-dispatch ${read} read failure is recorded and leaves the repair actionable`, async () => {
    const f = fixture();
    const fail = async (): Promise<never> => { throw new Error(`${read} unavailable`); };
    if (read === "body") f.options.deps.fetchPrBody = fail;
    else f.options.deps.runReview = fail;
    try {
      await assert.rejects(runFixRung(f.options), f.reachedWorker);
      assert.equal(f.spawned.length, 1);
      assert.ok(f.logs.some((row) => row.step === "fix.pre_dispatch_review_error" &&
        String(row.extra?.error).includes(`${read} unavailable`)));
    } finally { f.clean(); }
  });
}

for (const fresh of [
  { ...verdict(true), headSha: "new-head" },
  { ...verdict(true), verdictWithheld: "reviewer code is stale" },
]) {
  test(`pre-dispatch review cannot certify ${fresh.verdictWithheld ?? "a different head"}`, async () => {
    const f = fixture();
    f.options.deps.runReview = async () => fresh;
    try {
      const result = await runFixRung(f.options);
      assert.equal(result.outcome, "stood_down");
      assert.equal(result.strikes, 0);
      assert.equal(f.spawned.length, 0);
      assert.equal(result.standDownReason, fresh.verdictWithheld ?? "PR head moved during pre-dispatch review");
    } finally { f.clean(); }
  });
}

test("an observed failing review dispatches directly without another review", async () => {
  const f = fixture();
  f.options.initialReview = verdict(false);
  try {
    await assert.rejects(runFixRung(f.options), f.reachedWorker);
    assert.equal(f.reviewed.length, 0);
    assert.equal(f.spawned.length, 1);
  } finally { f.clean(); }
});

test("a reconstructed prose-only failure has no executed proof to revalidate", async () => {
  const f = fixture();
  f.options.initialReview.criteria[0].proof_exec = "not_executable";
  try {
    await assert.rejects(runFixRung(f.options), f.reachedWorker);
    assert.equal(f.reviewed.length, 0);
    assert.equal(f.spawned.length, 1);
  } finally { f.clean(); }
});

test("pre-dispatch review reads the live body through the default gh reader", async () => {
  const f = fixture();
  const shim = ghShim([{ when: `pr view ${f.options.prUrl} --json body`, stdout: JSON.stringify({ body: "Live body from gh." }) }]);
  const originalPath = process.env.PATH;
  delete f.options.deps.fetchPrBody;
  process.env.PATH = `${shim.dir}:${originalPath}`;
  try {
    const result = await runFixRung(f.options);
    assert.equal(result.strikes, 0);
    assert.equal(result.outcome, "fixed");
    assert.equal(f.reviewed[0].report, "Live body from gh.");
    assert.ok(shim.calls().some((call) => call.includes("--json body")));
  } finally {
    process.env.PATH = originalPath;
    rmSync(shim.dir, { recursive: true, force: true });
    f.clean();
  }
});

test("CI failures still dispatch a repair without the review-only precheck", async () => {
  const f = fixture();
  f.options.ciFailures = [{ name: "ci", logTail: "a real build failure" }];
  f.options.initialReview = { ...verdict(false), reviewerOutcome: "sweep-reconstructed-ci-log", criteria: [] };
  try {
    await assert.rejects(runFixRung(f.options), f.reachedWorker);
    assert.equal(f.reviewed.length, 0);
    assert.equal(f.spawned.length, 1);
    assert.match(f.spawned[0].prompt, /a real build failure/);
  } finally { f.clean(); }
});
