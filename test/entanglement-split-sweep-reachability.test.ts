/**
 * W1-T3172 — close the cold-sweep gap between the Rule-25 verdict already recorded by
 * `review.posted` and W1-T2436's already-existing prerequisite worker.
 *
 * These tests deliberately drive the production chain rather than hand-populating the new
 * `OpenPrView` fields: ledger -> board view -> disposition -> cold reconstruction -> fix rung.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildFixRungDispatchArgs,
  buildOpenPrViews,
  runFixRung,
} from "../src/run-task.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  runSweep,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { reviewInputDigest } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const OWNER = "craigoley";
const REPO = "remudero";
const TASK_ID = "W1-T2904";
const PR_NUMBER = 4559;
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`;
const HEAD = "4559455945594559455945594559455945594559";
const BODY = `Remudero-Task: ${TASK_ID}`;
const INSTRUMENT_PATHS = ["scripts/coverage-ratchet.mjs"];
const SRC_PATHS = ["src/lib/worker-provider.ts"];
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function reviewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-09-08T13:23:28.000Z",
    step: "review.posted",
    task_id: TASK_ID,
    pr_url: PR_URL,
    head_sha: HEAD,
    review_input_digest: reviewInputDigest(HEAD, BODY),
    state: "failure",
    failure_class: "instrument_entangled",
    failure_reason: "entangled: instrument path(s) changed alongside src/ path(s)",
    unmet_criteria: [],
    reasons: [],
    decision_verdict: {
      state: "failure",
      instrumentEntangled: true,
      instrumentEntanglementPaths: {
        instrumentPaths: INSTRUMENT_PATHS,
        srcPaths: SRC_PATHS,
      },
    },
    ...overrides,
  };
}

function openPrFetch(body = BODY, head = HEAD): (args: string[]) => unknown {
  return (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/state=open/.test(path)) {
      return [{
        number: PR_NUMBER,
        html_url: PR_URL,
        head: { ref: `run-${TASK_ID}-1788881269762`, sha: head },
        updated_at: "2026-09-08T13:24:00.000Z",
        body,
        auto_merge: null,
        state: "open",
      }];
    }
    if (/check-runs/.test(path)) {
      return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success", started_at: "2026-09-08T13:22:00.000Z" }] };
    }
    if (/commits\/.+\/status/.test(path)) {
      return { statuses: [{ context: "remudero-review", state: "failure", created_at: "2026-09-08T13:23:28.000Z" }] };
    }
    if (/\/pulls\/4559$/.test(path)) return { mergeable: true, mergeable_state: "clean" };
    return [];
  };
}

function boardView(
  rows: Record<string, unknown>[],
  options: { body?: string; head?: string } = {},
): { view: OpenPrView; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t3172-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const [view] = buildOpenPrViews(OWNER, REPO, ledgerPath, {
    fetch: openPrFetch(options.body, options.head),
    requiredContexts: () => ["ci-gate"],
    readCiGateRequired: () => ["ci-gate"],
    fetchCiFailureEvidence: () => [],
  });
  assert.ok(view, "the fake REST gateway produced PR #4559");
  return { view, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function coldArgs(view: OpenPrView, evidence: FixDispatchEvidence) {
  return buildFixRungDispatchArgs({
    task: { id: TASK_ID, title: "Codex worker-provider integration" },
    runId: "SWEEP-W1-T3172",
    prUrl: PR_URL,
    branch: `run-${TASK_ID}-1788881269762`,
    worktreePath: "/tmp/rmd-w1-t3172-cold",
    mount: MOUNT,
    settingsFile: "/tmp/rmd-w1-t3172-settings.json",
    config: {} as Config,
    budgetUsd: 30,
    strikeCap: 3,
    evidence,
    pr: view,
    reviewBase: { owner: OWNER, repo: REPO, headCheckoutDir: "/tmp/rmd-w1-t3172-cold", reviewerMount: MOUNT },
  });
}

function workerResult(text: string): WorkerResult {
  return {
    sessionId: "split-worker",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

// W1-T3172 exact structural verdict reaches blocked-fixable.
test("an exact-input Rule-25 record reaches blocked-fixable through the real board producer", () => {
  const { view, cleanup } = boardView([reviewRow()]);
  try {
    assert.equal(view.reviewState, "failure");
    assert.deepEqual(view.unmetCriteria, [], "#4559 has no ordinary unmet criterion");
    assert.equal(view.instrumentEntangled, true);
    assert.deepEqual(view.instrumentEntanglementPaths, { instrumentPaths: INSTRUMENT_PATHS, srcPaths: SRC_PATHS });
    const disposition = deriveDisposition(view, DEFAULT_SWEEP_POLICY, Date.parse("2026-09-08T13:31:00.000Z"));
    assert.equal(disposition.disposition, "blocked-fixable");
    assert.match(disposition.reason, /W1-T2436/);
    assert.match(disposition.reason, /zero ordinary strikes/i);
  } finally {
    cleanup();
  }
});

// W1-T3172 cold reconstruction preserves both entanglement path sets.
test("cold reconstruction preserves the exact structured Rule-25 evidence", () => {
  const { view, cleanup } = boardView([reviewRow()]);
  try {
    const args = coldArgs(view, {
      unmetCriteria: view.unmetCriteria,
      instrumentEntangled: view.instrumentEntangled,
      instrumentEntanglementPaths: view.instrumentEntanglementPaths,
    });
    assert.equal(args.initialReview.instrumentEntangled, true);
    assert.deepEqual(args.initialReview.instrumentEntanglementPaths?.instrumentPaths, INSTRUMENT_PATHS);
    assert.deepEqual(args.initialReview.instrumentEntanglementPaths?.srcPaths, SRC_PATHS);
  } finally {
    cleanup();
  }
});

// W1-T3172 prerequisite spawn precedes every ordinary strike.
// W1-T3172 three-link falsifier reproduces the PR 4559 stall: this drive fails if the producer,
// disposition row, or cold-rung threading link is independently removed.
test("the full #4559 cold path opens and parks on a prerequisite without an ordinary strike", async () => {
  const { view, cleanup } = boardView([reviewRow()]);
  const events: string[] = [];
  const sweepDir = mkdtempSync(join(tmpdir(), "rmd-w1-t3172-sweep-"));
  try {
    const disposition = deriveDisposition(view, DEFAULT_SWEEP_POLICY, Date.parse("2026-09-08T13:31:00.000Z"));
    assert.equal(disposition.disposition, "blocked-fixable", "the sweep must actually dispatch this view");
    let dispatched: FixDispatchEvidence | undefined;
    const sweepDeps: SweepDeps = {
      arm: async () => {},
      close: async () => {},
      dispatchFix: async (_pr, evidence) => { dispatched = evidence; },
      escalate: async () => {},
      ledgerPath: join(sweepDir, "ledger.ndjson"),
      runId: "SWEEP-W1-T3172",
      now: () => Date.parse("2026-09-08T13:31:00.000Z"),
    };
    await runSweep([view], sweepDeps, DEFAULT_SWEEP_POLICY);
    assert.ok(dispatched, "the blocked-fixable sweep effect received the evidence");
    const outcome = await runFixRung({
      ...coldArgs(view, dispatched),
      deps: {
        spawn: async (args: SpawnWorkerArgs) => {
          events.push("prerequisite.spawn");
          assert.match(args.prompt, /scripts\/coverage-ratchet\.mjs/);
          assert.match(args.prompt, /src\/lib\/worker-provider\.ts/);
          return workerResult(`REPORT\nPR_URL: https://github.com/${OWNER}/${REPO}/pull/9001`);
        },
        waitForCiGreen: async () => {
          events.push("prerequisite.ci-green");
          return "green";
        },
        readPrerequisiteState: async () => ({ ok: true, state: "OPEN" }) as never,
        runReview: async () => { throw new Error("ordinary re-review must not run before the prerequisite merges"); },
        push: () => { throw new Error("the original branch must not be pushed while the prerequisite is open"); },
        issues: { create: () => { throw new Error("a healthy prerequisite must not escalate"); } },
        ledgerPath: join(tmpdir(), "rmd-w1-t3172-unused-ledger.ndjson"),
        log: (step: string) => events.push(step),
        say: () => {},
        account: (result: WorkerResult) => result,
        ledgerLines: () => [],
        updateBranch: () => { throw new Error("an OPEN prerequisite must never be rebased or merged"); },
      },
    } as never);
    assert.equal(outcome.outcome, "parked");
    assert.equal(outcome.strikes, 0);
    assert.equal(events.filter((event) => event === "prerequisite.spawn").length, 1);
    assert.equal(events.includes("fix.dispatch"), false, "no ordinary strike was recorded");
  } finally {
    rmSync(sweepDir, { recursive: true, force: true });
    cleanup();
  }
});

// W1-T3172 incomplete structural evidence fails closed.
test("stale, changed-input, malformed, and differently-classed evidence cannot authorize a split", () => {
  const changedBody = `${BODY}\n\nA material body edit.`;
  const cases: Array<{ name: string; rows: Record<string, unknown>[]; body?: string }> = [
    { name: "stale head", rows: [reviewRow({ head_sha: "old-head" })] },
    { name: "changed body digest", rows: [reviewRow()], body: changedBody },
    { name: "missing source paths", rows: [reviewRow({ decision_verdict: { instrumentEntangled: true, instrumentEntanglementPaths: { instrumentPaths: INSTRUMENT_PATHS } } })] },
    { name: "empty instrument paths", rows: [reviewRow({ decision_verdict: { instrumentEntangled: true, instrumentEntanglementPaths: { instrumentPaths: [], srcPaths: SRC_PATHS } } })] },
    { name: "non-string path", rows: [reviewRow({ decision_verdict: { instrumentEntangled: true, instrumentEntanglementPaths: { instrumentPaths: [42], srcPaths: SRC_PATHS } } })] },
    { name: "rule 15", rows: [reviewRow({ failure_class: "criteria_tampered", decision_verdict: { criteriaTampered: true } })] },
  ];
  for (const fixture of cases) {
    const { view, cleanup } = boardView(fixture.rows, { body: fixture.body });
    try {
      assert.equal(view.instrumentEntangled, undefined, fixture.name);
      assert.equal(view.instrumentEntanglementPaths, undefined, fixture.name);
      assert.doesNotMatch(deriveDisposition(view, DEFAULT_SWEEP_POLICY).reason, /W1-T2436/, fixture.name);
    } finally {
      cleanup();
    }
  }
});

test("last exact-input review wins, so success or a different failure class clears old split authority", () => {
  for (const terminal of [
    reviewRow({ state: "success", failure_class: undefined, decision_verdict: { state: "success" } }),
    reviewRow({ failure_class: "test_theater", decision_verdict: { state: "failure", testTheater: true } }),
  ]) {
    const { view, cleanup } = boardView([reviewRow(), terminal]);
    try {
      assert.equal(view.instrumentEntangled, undefined);
      assert.equal(view.instrumentEntanglementPaths, undefined);
    } finally {
      cleanup();
    }
  }
});

// W1-T3172 unrelated review routes stay byte-identical.
test("ordinary unmet and Rule-15 review routes remain unchanged", () => {
  const base: OpenPrView = {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-T1",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [{ claim: "still unmet", proof: "", met: false, reason: "missing", proof_exec: "not_executable" }],
    priorStrikes: 0,
    lastActivityAt: "2026-09-08T00:00:00.000Z",
    headSha: "abc",
    autoMergeArmed: false,
    isDependabot: false,
  };
  assert.deepEqual(deriveDisposition(base, DEFAULT_SWEEP_POLICY), {
    disposition: "blocked-fixable",
    reason: "1 unmet criterion — strike 1/2",
  });
  const rule15 = deriveDisposition({ ...base, unmetCriteria: [], reviewSummary: "Standing rule 15" }, DEFAULT_SWEEP_POLICY);
  assert.equal(rule15.disposition, "blocked-ambiguous");
  assert.match(rule15.reason, /Standing rule 15/);
});

// W1-T3172 exhaustion and prerequisite safety still win.
test("strike exhaustion precedes the split route", () => {
  const { view, cleanup } = boardView([reviewRow()]);
  try {
    const exhausted = deriveDisposition({ ...view, priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap }, DEFAULT_SWEEP_POLICY);
    assert.equal(exhausted.disposition, "blocked-ambiguous");
    assert.match(exhausted.reason, /strikes exhausted/);
    assert.doesNotMatch(exhausted.reason, /W1-T2436/);
  } finally {
    cleanup();
  }
});
