/**
 * test/the-fix-rung-reads-its-contract-at-the-pr-head.test.ts — W1-T4073.
 *
 * THE DEFECT (observed 2026-09-22): the #6630 fix round rendered `task.files` from the daemon's BOOT
 * plan, 27 minutes stale. W1-T4051's record there named a test file #6627 had already replaced, so
 * the worker created the superseded file and the harness committed it. `resolvePlanCriteriaAtHead`
 * existed but was wired only at re-review. The fix resolves the contract at the PR head once the
 * checkout exists, and that one task feeds the prompt, the scope guard and the harness commit.
 *
 * Pure seams plus one real `dispatchFix` over injected seams; no gateway or network is reached.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import type { PlanCriteriaAtHeadResult } from "../src/lib/review.js";
import {
  buildSweepEffects,
  DEFAULT_SWEEP_POLICY,
  fixRungTaskAtHead,
  fixRungTaskFor,
  fixRungWantsHeadContract,
  type BuildSweepEffectsDeps,
} from "../src/lib/sweep.js";
import { commitWorkerEdits, fixRungScopeStandDownReason } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const ID = "W1-T4051";
const SUPERSEDED = "test/the-board-review-check-does-not-freeze-the-loop.test.ts";
const REPLACEMENT = "test/the-board-review-check-is-bounded.test.ts";
const BRANCH = "run-W1-T4051-1790000000000";
const PR_URL = "https://github.com/craigoley/remudero/pull/6630";
const CRITERION = { claim: "the head's own claim", proof: 'unit test: "head claim"' };

const emptyPlan = (): Plan => ({ tasks: [], byId: new Map() }) as unknown as Plan;
const snapshotPlan = (): Plan => {
  const t = { id: ID, title: "the board review", repo: "remudero", risk: "medium", acceptance: [], files: [SUPERSEDED] };
  return { tasks: [t], byId: new Map([[ID, t]]) } as unknown as Plan;
};

const atHead = (over: Partial<PlanCriteriaAtHeadResult> = {}): PlanCriteriaAtHeadResult => ({
  criteria: [CRITERION],
  taskId: ID,
  taskDeclaredFiles: [REPLACEMENT],
  taskRisk: "high",
  taskBudgetUsd: 12,
  ...over,
});

const Z = (...entries: string[]) => entries.map((e) => `${e}\0`).join("");
function fakeGit(status: string) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "status") return status;
    if (args[0] === "rev-parse") return "cafebabe000000000000000000000000000000ff\n";
    return "";
  };
  return { run, calls };
}

/** Drive the REAL `dispatchFix` over injected seams; `args` is what the rung was handed. */
async function dispatch(opts: {
  plan: Plan;
  resolve: NonNullable<BuildSweepEffectsDeps["resolveTaskContractAtHeadImpl"]> | undefined;
}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t4073-"));
  const shim = ghShim(
    [
      {
        when: `pr view ${PR_URL} --json headRefName,headRefOid,body,files`,
        stdout: JSON.stringify({ headRefName: BRANCH, headRefOid: "head123", body: "", files: [] }),
      },
    ],
    { kind: "w1-t4073-gh" },
  );
  const oldPath = process.env.PATH;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const built: Array<{ task: { id: string; files?: string[]; acceptance?: unknown[]; risk?: string } }> = [];
  let rungCalls = 0;
  const resolverCalls: Array<[string, string, string]> = [];
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    mkdirSync(join(root, "state", "inflight"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });
    const effects = buildSweepEffects({
      owner: "craigoley",
      repo: "remudero-fixture",
      repoRoot: process.cwd(),
      localRepoName: "remudero",
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T4073",
      plan: opts.plan,
      log: (step: string, extra?: Record<string, unknown>) => logs.push({ step, extra }),
      policy: DEFAULT_SWEEP_POLICY,
      reviewRunner: async () => 0,
      issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/1" },
      stallNotice: () => {},
      armImpl: () => "armed",
      armSessionPrsOverride: false,
      updateBranchImpl: async () => "updated",
      captureRepairFeedbackImpl: () => {},
      ghRunImpl: () => {},
      spawnWallClockBoundMsOverride: 1,
      reclaimWorkerImpl: () => {},
      disarmImpl: () => undefined,
      readJsonImpl: async () => ({}),
      updatePrBodyImpl: async () => {},
      registeredWorktreeOwnerImpl: () => undefined,
      registeredOwnerRecovery: { capture: () => undefined, remove: () => undefined },
      dispatchFixPreflightStandDownImpl: async () => undefined,
      reloadPlanForFixImpl: () => undefined,
      fixBranchClaimKeyImpl: () => "w1t4073-claim",
      createFixRungWorktreeImpl: () => undefined,
      captureWorktreeSnapshotImpl: () => ({ headSha: "birth123" }),
      worktreeRemoveImpl: () => {},
      openTaskIdsFromPlanImpl: () => new Set<string>(),
      readPackageScriptsImpl: () => ({}),
      buildFixRungDispatchArgsImpl: (a: never) => {
        built.push(a);
        return {};
      },
      runFixRungImpl: async () => {
        rungCalls++;
      },
      ...(opts.resolve
        ? {
            resolveTaskContractAtHeadImpl: (...a: [string, string, string]) => {
              resolverCalls.push(a);
              return opts.resolve!(...a);
            },
          }
        : {}),
    } as unknown as BuildSweepEffectsDeps);
    await effects.dispatchFix!(
      {
        prNumber: 6630,
        prUrl: PR_URL,
        headSha: "head123",
        taskId: ID,
        priorStrikes: 0,
        mergeState: "clean",
        checksState: "failure",
      } as never,
      { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never,
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
  return { logs, built, rungCalls, resolverCalls };
}

test("W1-T4073: a record amended after boot reaches the fix prompt", async () => {
  // The pure seam: the snapshot's superseded file is replaced by the head's.
  const snapshot = { task: fixRungTaskFor(snapshotPlan(), { prNumber: 6630, taskId: ID }).task, synthetic: false };
  const resolved = fixRungTaskAtHead(snapshot, ID, atHead());
  assert.ok("task" in resolved);
  assert.deepEqual(resolved.task.files, [REPLACEMENT]);
  const evidence = { ciFailures: [{ name: "ci", logTail: "red" }] };
  const prompt = renderFixPrompt({ task: resolved.task, round: 1, branch: BRANCH, evidence });
  assert.ok(prompt.includes(REPLACEMENT), "the amended file is in the worker's declared scope");
  assert.ok(!prompt.includes(SUPERSEDED), "the superseded file the operator had to revert is not");
  // The falsifier: handing the snapshot contract through renders the superseded file name.
  assert.ok(renderFixPrompt({ task: snapshot.task, round: 1, branch: BRANCH, evidence }).includes(SUPERSEDED));

  // And through the real dispatch: the rung is handed the head's contract, resolved in the PR checkout.
  const d = await dispatch({ plan: snapshotPlan(), resolve: async () => atHead() });
  assert.equal(d.built.length, 1);
  assert.deepEqual(d.built[0]!.task.files, [REPLACEMENT]);
  assert.deepEqual(d.built[0]!.task.acceptance, [CRITERION]);
  assert.equal(d.built[0]!.task.risk, "high");
  assert.equal(d.resolverCalls.length, 1);
  assert.equal(d.resolverCalls[0]![0], PR_URL);
  assert.equal(d.resolverCalls[0]![1], ID);
  assert.match(d.resolverCalls[0]![2], /sweep-W1-T4051-/, "resolved against the checkout it just created");
});

test("W1-T4073: a task absent from the snapshot but present at head is not synthetic", async () => {
  const snap = fixRungTaskFor(emptyPlan(), { prNumber: 6630, taskId: ID }, undefined, BRANCH, ["src/x.ts"]);
  assert.equal(snap.synthetic, true, "the boot snapshot does not know the task");
  const resolved = fixRungTaskAtHead(snap, ID, atHead());
  assert.ok("task" in resolved);
  assert.equal(resolved.synthetic, false);
  assert.equal(resolved.task.id, ID);
  assert.deepEqual(resolved.task.files, [REPLACEMENT], "the head's record wins over the PR footprint");
  assert.equal(resolved.task.budget_usd, 12);

  // A readable head that does not carry the id leaves the snapshot resolution exactly as it was.
  const absent = fixRungTaskAtHead(snap, ID, { criteria: [], taskId: ID });
  assert.equal(absent, snap, "absent at head is not unreadable and not a contract to apply");

  // Only a real plan id looks at the head; a lane or PR-<n> id has no record at any head.
  assert.equal(fixRungWantsHeadContract({ taskId: ID }), true);
  for (const taskId of [undefined, "RETRO", "TRIAGE-x-1", "PLAN-x-1", "APPROVE-x", "PR-12"]) {
    assert.equal(fixRungWantsHeadContract({ taskId }), false, String(taskId));
  }

  const d = await dispatch({ plan: emptyPlan(), resolve: async () => atHead() });
  assert.equal(d.built.length, 1);
  assert.equal(d.built[0]!.task.id, ID);
  assert.deepEqual(d.built[0]!.task.files, [REPLACEMENT]);
});

test("W1-T4073: an unreadable head contract stands the round down", async () => {
  const snap = { task: fixRungTaskFor(snapshotPlan(), { prNumber: 6630, taskId: ID }).task, synthetic: false };
  const cases: Array<[PlanCriteriaAtHeadResult | undefined, string | undefined, RegExp]> = [
    [undefined, undefined, /no contract returned/],
    [undefined, "resolver threw: boom", /resolver threw: boom/],
    [{ criteria: [], taskId: ID, divergence: { taskId: ID, reason: "duplicate id W1-T4051" } }, undefined, /duplicate id/],
  ];
  for (const [resolved, error, why] of cases) {
    const out = fixRungTaskAtHead(snap, ID, resolved, error);
    assert.ok("standDown" in out, "never falls back to the snapshot contract");
    assert.match(out.standDown, /PR-head task contract unreadable/);
    assert.match(out.standDown, why);
  }

  for (const resolve of [
    async () => undefined,
    async (): Promise<PlanCriteriaAtHeadResult> => {
      throw new Error("git object missing");
    },
    async (): Promise<PlanCriteriaAtHeadResult> => ({ criteria: [], taskId: ID, divergence: { taskId: ID, reason: "dup" } }),
  ]) {
    const d = await dispatch({ plan: snapshotPlan(), resolve });
    assert.equal(d.rungCalls, 0, "no worker is spawned on a contract nobody could read");
    assert.equal(d.built.length, 0);
    const row = d.logs.find((l) => l.step === "sweep.fix.head_contract_unreadable");
    assert.ok(row, "the stand-down is named in the ledger");
    assert.equal(row.extra?.task_id, ID);
    assert.match(String(row.extra?.reason), /PR-head task contract unreadable/);
  }

  // A caller that never wires the resolver keeps the snapshot contract, so older fixtures are unchanged.
  const unwired = await dispatch({ plan: snapshotPlan(), resolve: undefined });
  assert.equal(unwired.rungCalls, 1);
  assert.deepEqual(unwired.built[0]!.task.files, [SUPERSEDED]);
});

test("W1-T4073: the prompt and scope guard and commit share one contract", () => {
  const snapshot = { task: fixRungTaskFor(snapshotPlan(), { prNumber: 6630, taskId: ID }).task, synthetic: false };
  const out = fixRungTaskAtHead(snapshot, ID, atHead());
  assert.ok("task" in out);
  const { task } = out;

  // The prompt names exactly the files the guard and the commit are given.
  const prompt = renderFixPrompt({ task, round: 1, branch: BRANCH, evidence: { ciFailures: [{ name: "ci", logTail: "red" }] } });
  assert.ok(prompt.includes(`may only touch: ${task.files.join(", ")}`));

  // Scope guard: the head's file is in scope; the superseded one is a new out-of-scope path.
  assert.equal(fixRungScopeStandDownReason([REPLACEMENT], [], task.files), undefined);
  const guard = fixRungScopeStandDownReason([SUPERSEDED], [], task.files);
  assert.deepEqual(guard?.newOutOfScopePaths, [SUPERSEDED]);

  // Commit: the harness stages the head's file and leaves the superseded one undeclared.
  const git = fakeGit(Z(`M  ${REPLACEMENT}`, `?? ${SUPERSEDED}`));
  const committed = commitWorkerEdits("/w", task.files, "fix: repair the failing check", { runGit: git.run });
  assert.equal(committed.committed, true);
  assert.deepEqual(committed.undeclared, [SUPERSEDED]);
});
