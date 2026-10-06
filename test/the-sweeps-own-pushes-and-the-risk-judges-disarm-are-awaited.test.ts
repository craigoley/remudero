import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { gitPushRunBranch, LanePushForeignHeadError } from "../src/lib/git-push.js";
import { disarmAutoMerge } from "../src/lib/arm-auto-merge.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Plan } from "../src/lib/plan.js";
import { runRiskJudge, type RiskJudgeVerdict } from "../src/lib/risk-judge.js";
import { extractRefusal } from "../src/lib/refusal-amendment.js";
import { buildSweepEffects, type BuildSweepEffectsDeps, type OpenPrView } from "../src/lib/sweep.js";
import * as entrypoint from "../src/run-task.js";
import { ghShim, type GhShim } from "./helpers/gh-shim.js";
import { buildFixturePlanPrBody } from "./helpers/plan-pr-body-fixture.js";

const PROOF = "test/the-sweeps-own-pushes-and-the-risk-judges-disarm-are-awaited.test.ts";
const HEAD = "a".repeat(40);
const PR_URL = "https://github.com/acme/remudero/pull/5742";
const task = { id: "W1-T5742", title: "await daemon writes", files: [], status: "queued" };

async function observeChild<T>(shim: GhShim, match: string, call: () => T | Promise<T>) {
  let ticks = 0;
  const timer = setInterval(() => {
    const events = shim.events();
    if (events.some((e) => e.phase === "start" && e.args.join(" ").includes(match) &&
      !events.some((done) => done.id === e.id && done.phase === "end"))) ticks++;
  }, 5);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  try {
    return { result: await withLiveWritesAllowed(call), ticks };
  } finally {
    process.env.PATH = savedPath;
    clearInterval(timer);
  }
}

function ratchetFixture(over: Partial<BuildSweepEffectsDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5742-sweep-"));
  mkdirSync(join(root, "state", "inflight"), { recursive: true });
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const removed: string[] = [];
  let read = 0;
  const branch = "run-W1-T5742-1791283542371";
  const deps: BuildSweepEffectsDeps = {
    owner: "acme", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"), runId: "SWEEP-T5742",
    plan: { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan,
    log: (step, extra) => { logs.push({ step, extra }); },
    ghJsonImpl: () => ({ headRefName: branch, headRefOid: HEAD, body: "Remudero-Task: W1-T5742\n" }),
    registeredWorktreeOwnerImpl: () => undefined,
    fixBranchClaimKeyImpl: () => "t5742-claim",
    createFixRungWorktreeImpl: () => {},
    readBaselineRatchetWorktreeStateImpl: () => ({ headSha: HEAD,
      changedPaths: read++ === 0 ? [] : ["scripts/comment-load-baseline.json"] }),
    readPackageScriptsImpl: () => ({ "comment-load-ratchet": "fixture", "comment-load-signal": "fixture" }),
    runNpmScriptImpl: () => ({ status: 0 }),
    commitGeneratorOutputImpl: () => ({ changed: true, sha: HEAD }),
    worktreeRemoveImpl: (_repo, path) => { removed.push(path); },
    ...over,
  };
  const pr = { prNumber: 5742, prUrl: PR_URL, taskId: task.id, headSha: HEAD,
    headRefName: branch, unmetCriteria: [] } as unknown as OpenPrView;
  return { deps, pr, logs, removed, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test(`${PROOF}: both sweep builders let a timer fire during their default push`, async () => {
  for (const build of [buildSweepEffects, entrypoint.buildSweepEffects]) {
    const f = ratchetFixture();
    const shim = ghShim([
      { when: "rev-parse HEAD", stdout: HEAD },
      { when: "push origin HEAD", delaySeconds: 0.3 },
    ], { command: "git", kind: "t5742-push" });
    try {
      const effects = build(f.deps);
      const { result, ticks } = await observeChild(shim, "push origin HEAD", () =>
        effects.repairRecordableRatchet!(f.pr, ["comment-load-ratchet"]));
      assert.equal(result, true);
      assert.ok(ticks > 0, "a timer fired while the sweep's git push was alive");
      assert.equal(f.logs.at(-1)!.step, "sweep.ratchet_repair_executor_applied");
      assert.equal(f.logs.at(-1)!.extra!.commit_sha, HEAD);
      assert.equal(f.removed.length, 1);
      assert.equal(shim.calls().filter((c) => c.includes("push origin HEAD")).length, 1);
    } finally {
      f.cleanup();
      rmSync(shim.dir, { recursive: true, force: true });
    }
  }
});

test(`${PROOF}: a rejected awaited sweep push records refusal before releasing its claim`, async () => {
  const failure = new LanePushForeignHeadError("foreign head", "branch", HEAD);
  const f = ratchetFixture({ gitPushRunBranchImpl: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(f.removed, [], "the worktree survives while its push is in flight");
    throw failure;
  } });
  try {
    assert.equal(await buildSweepEffects(f.deps).repairRecordableRatchet!(f.pr, ["comment-load-ratchet"]), false);
    assert.equal(f.logs.at(-1)!.step, "sweep.ratchet_repair_executor_declined");
    assert.equal(f.logs.at(-1)!.extra!.reason, "executor_error");
    assert.equal(f.logs.at(-1)!.extra!.error, "foreign head");
    assert.equal(f.removed.length, 1);
  } finally {
    f.cleanup();
  }
});

test(`${PROOF}: the default sweep push refuses the sync form's moved head and failed transport`, async () => {
  for (const moved of [true, false]) {
    const f = ratchetFixture();
    const observed = moved ? "b".repeat(40) : HEAD;
    const shim = ghShim([
      { when: "rev-parse HEAD", stdout: observed },
      { when: "push origin HEAD", stderr: "remote refused", exit: 1, delaySeconds: 0.05 },
    ], { command: "git", kind: "t5742-refused-push" });
    try {
      const { result } = await observeChild(shim, "push origin HEAD", () =>
        buildSweepEffects(f.deps).repairRecordableRatchet!(f.pr, ["comment-load-ratchet"]));
      assert.equal(result, false);
      assert.equal(f.logs.at(-1)!.extra!.reason, "executor_error");
      assert.equal(shim.calls().filter((c) => c.includes("push origin HEAD")).length, moved ? 0 : 1);
      assert.equal(f.removed.length, 1);
      if (moved) {
        let refusal: unknown;
        try {
          withLiveWritesAllowed(() => gitPushRunBranch("/wt", { expectedHeadSha: HEAD, capture: () => observed }));
        } catch (error) {
          refusal = error;
        }
        assert.ok(refusal instanceof LanePushForeignHeadError);
        assert.match(String(f.logs.at(-1)!.extra!.error), /it was asked to land/);
      } else {
        assert.match(String(f.logs.at(-1)!.extra!.error), /remote refused/);
      }
    } finally {
      f.cleanup();
      rmSync(shim.dir, { recursive: true, force: true });
    }
  }
});

const verdict: RiskJudgeVerdict = { verdict: "high", confidence: 0.95, reasons: ["fixture risk"] };
const ctx = { prUrl: PR_URL, taskId: task.id, runId: "RUN-T5742", ledgerPath: "/unused",
  reason: "risk judge escalated — auto-merge refused", refusal: "fixture escalation" };

test(`${PROOF}: risk escalation awaits its default disarm while a timer fires during gh`, async () => {
  assert.equal(typeof entrypoint.riskJudgeDisarm, "function");
  const shim = ghShim([{ when: "--disable-auto", delaySeconds: 0.3 }], { kind: "t5742-disarm" });
  const steps: string[] = [];
  try {
    const { result, ticks } = await observeChild(shim, "--disable-auto", () => runRiskJudge({
      change: { description: "fixture" }, gatesState: {}, planContext: {},
    }, {
      judge: async () => verdict,
      escalate: async () => {
        const disposition = await entrypoint.riskJudgeDisarm(ctx);
        assert.ok(shim.events().some((e) => e.phase === "end"));
        steps.push(disposition.step);
        return "https://github.com/acme/remudero/issues/5742";
      },
      log: (step) => { steps.push(step); },
    }));
    assert.ok(ticks > 0, "a timer fired while risk escalation's gh disarm was alive");
    assert.equal(result.action.kind, "escalate");
    assert.ok(steps.indexOf("automerge.disarmed") < steps.indexOf("risk_judge.escalated"));
    assert.deepEqual(shim.calls(), [`pr merge ${PR_URL} --disable-auto`]);
  } finally {
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test(`${PROOF}: awaited risk disarm retains every sync disposition and lost-race escalation`, async () => {
  assert.equal(typeof entrypoint.riskJudgeDisarm, "function");
  for (const [stderr, merged, outcome] of [
    [undefined, false, "disarmed"], ["can't disable auto-merge", false, "not-armed"],
    ["can't disable auto-merge", true, "lost-race"], ["permission denied", false, "failed"],
  ] as const) {
    const shim = ghShim([
      { when: "--disable-auto", stderr, exit: stderr ? 1 : 0 },
      { when: "api", stdout: JSON.stringify({ merged }) },
    ], { kind: "t5742-disarm-outcome" });
    const dispositionDeps = { mergeSha: () => HEAD, ledgerLines: () => [] };
    try {
      const { result } = await observeChild(shim, "--disable-auto", () =>
        entrypoint.riskJudgeDisarm(ctx, undefined, dispositionDeps));
      const sync = disarmAutoMerge(PR_URL, {
        disableAuto: () => { if (stderr) throw Object.assign(new Error(stderr), { stderr }); },
        isMerged: () => merged, say: () => {},
      });
      assert.equal(sync, outcome);
      assert.equal(result.row.outcome, outcome);
      assert.deepEqual(result, entrypoint.disposeDisarm(sync, ctx, dispositionDeps));
      assert.equal(result.escalation?.class, merged ? "HARD_STOP" : undefined);
    } finally {
      rmSync(shim.dir, { recursive: true, force: true });
    }
  }
});

test(`${PROOF}: both sweep plan filings await push before creating a pr or cleaning up`, async () => {
  for (const lane of ["refusal", "repair"] as const) {
    for (const refused of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "rmd-t5742-plan-push-"));
      const shard = "plan/tasks.d/W1-T5742-fixture.yaml";
      const staleProof = "unit test: stale fixture proof";
      mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
      writeFileSync(join(root, shard), `- id: W1-T5742\n  repo: remudero\n  status: queued\n  attempts: 0\n` +
        `  acceptance:\n    - claim: fixture\n      proof: ${staleProof}\n`);
      const order: string[] = [];
      const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
      const effects = buildSweepEffects({
        owner: "acme", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
        ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-T5742",
        plan: { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan,
        log: (step, extra) => { logs.push({ step, extra }); }, reloadPlanForFixImpl: () => undefined,
        planRepairGitImpl: (_file, args) => args.includes("rev-parse") ? HEAD : "",
        worktreeAddImpl: (_repo, path) => { mkdirSync(join(path, "plan", "tasks.d"), { recursive: true }); },
        worktreeRemoveImpl: () => { order.push("cleanup"); },
        buildPlanPrBodyImpl: buildFixturePlanPrBody,
        planPrPreflightImpl: () => ({ ok: true, failures: [], unreadable: [] }),
        gitPushRunBranchImpl: async (_path, opts) => {
          assert.equal(opts!.expectedHeadSha, HEAD);
          order.push("push-start");
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.deepEqual(order, ["push-start"], "no pr or cleanup before push settles");
          order.push("push-end");
          if (refused) throw new LanePushForeignHeadError("foreign head", "branch", HEAD);
        },
        ghJsonImpl: (args) => {
          if (!args.includes("--method")) return [];
          order.push("create-pr");
          return { html_url: PR_URL, number: 5742 };
        },
      });
      try {
        const result = await withLiveWritesAllowed(async () => {
          if (lane === "repair") return effects.dispatchPlanOnlyRepair!(
            { taskId: task.id, prNumber: 5742, prUrl: PR_URL, headSha: HEAD } as OpenPrView,
            { proofs: [{ claim: "fixture", proof: staleProof, proofExec: "not_executable" }] });
          const reportExcerpt = "REFUSED:\n1. [premise-rotted] fixture needs amendment";
          return effects.draftRefusalAmendments!([{ taskId: task.id, runId: "RUN-T5742",
            reportExcerpt, refusals: extractRefusal(reportExcerpt) }]);
        });
        assert.deepEqual(order, refused ? ["push-start", "push-end", "cleanup"] :
          ["push-start", "push-end", "create-pr", "cleanup"]);
        if (lane === "repair") {
          assert.equal(result, true);
          assert.equal(logs.at(-1)!.extra!.outcome, refused ? "error" : "dispatched");
        } else {
          assert.ok(Array.isArray(result));
          assert.equal(result[0]!.outcome, refused ? "error" : "drafted");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test(`${PROOF}: a rejected risk disarm remains a rejected operation`, async () => {
  assert.equal(typeof entrypoint.riskJudgeDisarm, "function");
  const failure = new Error("disarm could not start");
  await assert.rejects(entrypoint.riskJudgeDisarm(ctx, async () => { throw failure; }),
    (error) => error === failure);
});

test(`${PROOF}: the plan round's default git port awaits the explicit remote branch push`, async () => {
  const f = ratchetFixture({
    repoRoot: process.cwd(),
    dispatchFixPreflightStandDownImpl: async () => false,
    fetchPrDiffFilesImpl: async () => ["plan/tasks.yaml"],
    fixRungTaskForImpl: () => ({ task: { ...task, risk: "high", acceptance: [], files: ["plan/tasks.yaml"] }, synthetic: false }),
    ghJsonImpl: () => ({ head: { ref: "ci-friction-garden-1791283542371", sha: HEAD },
      user: { login: "remudero-fleet[bot]" }, title: "chore(plan): fixture", body: "fixture" }),
    materializePlanRoundWorktreeImpl: () => ({ worktreePath: "/fixture" }),
    restRollupForImpl: async () => [], fetchCiFailuresImpl: async () => [],
    runPlanScopedFixRoundImpl: async (input: { deps: { push: (sha: string) => Promise<void> } }) => {
      await input.deps.push(HEAD);
      return { outcome: "pushed" };
    },
  });
  const shim = ghShim([
    { when: "rev-parse HEAD", stdout: HEAD },
    { when: "push origin HEAD:", delaySeconds: 0.3 },
  ], { command: "git", kind: "t5742-plan-round" });
  try {
    const effects = buildSweepEffects(f.deps);
    const { result, ticks } = await observeChild(shim, "push origin HEAD:", () => effects.dispatchPlanGateRound!(f.pr));
    assert.deepEqual(result, { outcome: "pushed" });
    assert.ok(ticks > 0, "the plan round's git port allows timer ticks while pushing");
    assert.deepEqual(shim.calls(), ["-C /fixture rev-parse HEAD",
      "-C /fixture push origin HEAD:refs/heads/ci-friction-garden-1791283542371"]);
    assert.equal(f.removed.length, 1);
  } finally {
    f.cleanup();
    rmSync(shim.dir, { recursive: true, force: true });
  }
});
