// W1-T4633: the sweep closed a valid PR for an "unmet dependency" seconds before the SAME pass
// credited that dependency's merge, and the branch reaper then deleted the closed PR's head.
// MEASURED 2026-09-27: W1-T4610 merged as #7458 at 15:09:29Z; at 15:12:50Z the sweep closed #7465
// (W1-T4611, depends_on W1-T4610) as "unmet dependency ... the plan resequenced after this PR was
// admitted"; at 15:13:06Z the SAME pass's sweep.credit_backfill wrote verdict.merged for W1-T4610.
// The resequence row read a ledger that had not yet absorbed a merge the pass already held as a
// credit candidate. The head branch was restored by hand.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { readLedgerLines, type BranchReapPlan } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  projectMergedTaskCandidates,
  runSweep,
  type CreditCandidate,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { buildOpenPrViews, DECLARED_BRANCH_GUARDS, keepReversiblyClosedHeads, reapBranchesCommand } from "../src/run-task.js";

const NOW = Date.parse("2026-09-27T15:12:50.591Z");
const PR_NUMBER = 7465;
const TASK_ID = "W1-T4611";
const DEP_ID = "W1-T4610";
const HEAD_REF = "run-W1-T4611-1790522000000";
const DEP_PR_URL = "https://github.com/craigoley/remudero/pull/7458";

function task(over: Partial<Task> = {}): Task {
  return { id: TASK_ID, title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, ...over };
}

function planOf(...tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/** The #7465 shape: W1-T4611 depends on W1-T4610, which the pass's merged set has not absorbed. */
const PLAN = planOf(task({ depends_on: [DEP_ID] }), task({ id: DEP_ID }));
const NOTHING_MERGED = (): boolean => false;

/** The credit candidate the SAME pass holds for #7458 (credit observable by its trailer) before its
 *  own credit backfill has appended `verdict.merged` for it. */
function depMergedCandidate(over: Partial<CreditCandidate> = {}): CreditCandidate {
  return { taskId: DEP_ID, prNumber: 7458, prUrl: DEP_PR_URL, merged: true, creditIsImplementation: true, ...over };
}

/** The real full-sweep producer over the one open PR, against an EMPTY ledger — the credit backfill
 *  that will write W1-T4610's `verdict.merged` has not run yet this pass. */
function producedView(): OpenPrView {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t4633-view-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const prUrl = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
  const fetch = (args: string[]): unknown => {
    const path = args.at(-1) ?? "";
    if (/state=open/.test(path)) {
      return [
        {
          number: PR_NUMBER,
          html_url: prUrl,
          head: { ref: HEAD_REF, sha: "c".repeat(40) },
          updated_at: "2026-09-27T15:11:00.000Z",
          body: `Remudero-Task: ${TASK_ID}`,
          auto_merge: null,
          state: "open",
        },
      ];
    }
    if (/\/files\?/.test(path)) return [{ filename: "src/lib/serve.ts" }];
    if (/\/pulls\/7465$/.test(path)) return { mergeable: true, mergeable_state: "blocked" };
    if (/check-runs/.test(path)) return { check_runs: [{ name: "ci-gate", status: "in_progress", conclusion: null }] };
    if (/\/status$/.test(path)) return { statuses: [] };
    return [];
  };
  try {
    const [v] = buildOpenPrViews("craigoley", "remudero", ledgerPath, {
      fetch,
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => [],
      readMainPlan: () => PLAN,
      isMerged: NOTHING_MERGED,
    });
    assert.ok(v, "precondition: the producer returned the #7465-shaped PR");
    // Precondition: WITHOUT the fresh credit, the row has its (stale) authority to close.
    assert.match(v.planResequenceIneligible ?? "", new RegExp(DEP_ID));
    assert.deepEqual(v.planResequenceUnmetDependencies, [DEP_ID], "the unmet ids travel as data, not prose");
    return v;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sweepDeps(): SweepDeps & { closed: OpenPrView[]; logged: Array<{ step: string; extra?: Record<string, unknown> }>; ledgerPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t4633-sweep-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const closed: OpenPrView[] = [];
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return {
    dir,
    closed,
    logged,
    ledgerPath,
    runId: "SWEEP-W1-T4633",
    now: () => NOW,
    arm: () => {},
    close: (pr) => {
      closed.push(pr);
    },
    dispatchFix: () => {},
    escalate: () => {},
    log: (step, extra) => {
      logged.push({ step, extra });
    },
  } as SweepDeps & { closed: OpenPrView[]; logged: Array<{ step: string; extra?: Record<string, unknown> }>; ledgerPath: string; dir: string };
}

function disposedRow(ledgerPath: string): Record<string, unknown> | undefined {
  return readLedgerLines(ledgerPath).find((row) => row.step === "sweep.disposed" && row.pr_number === PR_NUMBER);
}

test("W1-T4633: a dependency this pass already holds as merged is met, so the dependent PR is not closed", async () => {
  // Credit observable by trailer: implementation-subject known, and ALSO the unknown-subject case —
  // "did the merge implement it" is a supersession question, not "did the dependency merge".
  for (const candidate of [depMergedCandidate(), depMergedCandidate({ creditIsImplementation: undefined })]) {
    const [projected] = projectMergedTaskCandidates([producedView()], [candidate]);
    assert.equal(projected?.planResequenceIneligible, undefined, "the fresh merge credit meets the dependency");
    const sweep = sweepDeps();
    try {
      await runSweep([projected!], sweep, DEFAULT_SWEEP_POLICY);
      assert.deepEqual(sweep.closed, [], "the #7465 close does not happen");
      assert.notEqual(disposedRow(sweep.ledgerPath)?.disposition, "stale");
    } finally {
      rmSync(sweep.dir, { recursive: true, force: true });
    }
  }
});

test("W1-T4633: fresh credit removes only the merged dependencies, and never a blocked/retired reason", () => {
  const other = "W1-T4612";
  const view: OpenPrView = {
    ...producedView(),
    planResequenceIneligible: `unmet dependencies in the current plan: ${DEP_ID}, ${other}`,
    planResequenceUnmetDependencies: [DEP_ID, other],
  };
  const [partial] = projectMergedTaskCandidates([view], [depMergedCandidate()]);
  assert.equal(partial?.planResequenceIneligible, `unmet dependency in the current plan: ${other}`);
  assert.deepEqual(partial?.planResequenceUnmetDependencies, [other]);

  // A not-merged candidate is not merge evidence.
  const [unmerged] = projectMergedTaskCandidates([view], [depMergedCandidate({ merged: false })]);
  assert.equal(unmerged?.planResequenceIneligible, view.planResequenceIneligible);

  // The blocked/retirement branches of the same row carry no unmet ids and are left untouched.
  const blocked: OpenPrView = { ...view, planResequenceIneligible: "blocked in the current plan", planResequenceUnmetDependencies: undefined };
  assert.equal(projectMergedTaskCandidates([blocked], undefined)[0]?.planResequenceIneligible, "blocked in the current plan");
  assert.equal(projectMergedTaskCandidates([blocked], [depMergedCandidate()])[0]?.planResequenceIneligible, "blocked in the current plan");
});

test("W1-T4633: an unreadable dependency credit leaves the PR open and records why", async () => {
  // No merge-credit read this pass: the dependency's merge state is indeterminate, not "unmerged".
  {
    const [projected] = projectMergedTaskCandidates([producedView()], undefined);
    assert.equal(projected?.planResequenceIneligible, undefined, "indeterminate grants no authority to close");
    assert.match(projected?.planResequenceHeld ?? "", new RegExp(DEP_ID), "the held reason names the dependency");
    const sweep = sweepDeps();
    try {
      await runSweep([projected!], sweep, DEFAULT_SWEEP_POLICY);
      assert.deepEqual(sweep.closed, [], "never closed on an indeterminate credit read");
      const held = sweep.logged.find((l) => l.step === "sweep.plan_resequence_close.held");
      assert.ok(held, "the stand-down is recorded, not silent");
      assert.equal(held.extra?.pr_number, PR_NUMBER);
      assert.match(String(held.extra?.reason), new RegExp(DEP_ID));
    } finally {
      rmSync(sweep.dir, { recursive: true, force: true });
    }
  }
});

/** A fake git/gh surface with two closed-unmerged run branches: #7465's head, closed by the sweep's
 *  resequence row, and an ordinary closed PR's head, which stays reapable (the control). */
function reapExec(calls: string[][]) {
  const names = ["main", HEAD_REF, "run-W1-T4000-1790000000000"];
  return (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "ls-remote") return names.map((name, i) => `${i + 1}\trefs/heads/${name}`).join("\n") + "\n";
    if (args[0] === "for-each-ref") {
      return args.includes("--merged=origin/main") ? "origin/main\n" : names.map((name, i) => `origin/${name}\t${i + 1}\t1`).join("\n");
    }
    if (args[0] === "merge-base") {
      if (args[2] === "origin/main") return "";
      throw new Error("not an ancestor");
    }
    if (args[0] === "rev-parse") return "deadbeef\n";
    if (args[0] === "grep" && args.includes("-o")) return DECLARED_BRANCH_GUARDS.map((name) => `src/run-task.ts:1:${name}`).join("\n");
    if (args[0] === "grep") throw new Error("exit 1: no source match");
    if (cmd === "gh") {
      const endpoint = args[1] ?? "";
      if (endpoint.includes("state=all")) return `${HEAD_REF}\tclosed\tfalse\nrun-W1-T4000-1790000000000\tclosed\tfalse\n`;
      return "";
    }
    return "";
  };
}

test("W1-T4633: a PR the resequence row does close keeps its head branch through the reaper", async () => {
  // The control: no merge credit anywhere, so the dependency really is unmet and the close stands.
  const [projected] = projectMergedTaskCandidates([producedView()], []);
  assert.match(projected?.planResequenceIneligible ?? "", new RegExp(DEP_ID));
  const sweep = sweepDeps();
  const realLog = console.log;
  try {
    await runSweep([projected!], sweep, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(sweep.closed.map((pr) => pr.prNumber), [PR_NUMBER], "a genuinely unmet dependency still closes");
    const row = disposedRow(sweep.ledgerPath);
    assert.equal(row?.disposition, "stale");
    assert.equal(row?.keep_head_branch, HEAD_REF, "the reversible close records the branch it must keep");

    const calls: string[][] = [];
    const output: string[] = [];
    console.log = (...args: unknown[]) => void output.push(args.map(String).join(" "));
    const code = reapBranchesCommand(["--prune"], { exec: reapExec(calls), ledgerPath: sweep.ledgerPath });
    console.log = realLog;
    assert.equal(code, 0);
    const deletes = calls.filter((c) => c[1] === "push" && c.includes("--delete")).flat();
    assert.ok(!deletes.includes(HEAD_REF), "the resequence-closed PR's head branch is NOT deleted");
    assert.ok(deletes.includes("run-W1-T4000-1790000000000"), "an ordinary closed-unmerged head is still reaped");
    assert.match(output.join("\n"), new RegExp(`kept:.*1[\\s\\S]*${HEAD_REF}`), "the kept branch is named, not silently skipped");
    const dryRun = readLedgerLines(sweep.ledgerPath).find((r) => r.step === "branch_reap.dry_run");
    assert.deepEqual(dryRun?.kept_reversible_close_branches, [HEAD_REF]);
  } finally {
    console.log = realLog;
    rmSync(sweep.dir, { recursive: true, force: true });
  }
});

test("W1-T4633: an unreadable reaper ledger conservatively keeps every closed-unmerged head", () => {
  const control = "run-W1-T4000-1790000000000";
  const merged = "run-W1-T3999-1789990000000";
  const plan: BranchReapPlan = {
    deletable: [HEAD_REF, control, merged],
    guarded: [],
    hold: [],
    undetermined: [],
    undeclaredGuards: [],
    missingBranches: [],
    reasons: {
      [HEAD_REF]: "closed_unmerged",
      [control]: "closed_unmerged",
      [merged]: "merged",
    },
  };
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    const kept = keepReversiblyClosedHeads(plan, () => {
      throw new Error("permission denied");
    });
    assert.deepEqual(kept, [HEAD_REF, control], "every closed-unmerged head is retained when ledger state is unreadable");
    assert.deepEqual(plan.deletable, [merged], "only non-closed candidates remain deletable");
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /keeping every closed-unmerged head/);
    assert.match(errors[0] ?? "", /permission denied/);
  } finally {
    console.error = originalError;
  }
});
