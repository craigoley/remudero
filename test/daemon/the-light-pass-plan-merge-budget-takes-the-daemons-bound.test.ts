/**
 * W1-T12357 — THE LIGHT PASS PLAN-MERGE BUDGET TAKES THE DAEMON'S BOUND.
 *
 * W1-T12267 caps the plan-merge budget of a light pass at half of `sweepWallClockBoundMs`. The light pass hook
 * read that bound from the default policy only. The daemon reads its own `plan/policy.yaml`, so a changed bound
 * moved the sweep tick and left the budget cap where it was.
 *
 * Every test drives the real `buildSweepLightHook` through its io ports. Criterion 2 also drives the real
 * `daemonCommand` over a checkout whose `plan/policy.yaml` names another bound.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { OpenPrView, SweepDeps } from "#src/lib/sweep.js";
import type { DaemonSummary } from "#src/lib/daemon.js";

// The daemon reads `plan/policy.yaml` under the checkout the argv module finds. Point it at a fixture checkout
// before the modules load; the fixture's policy is the real one with another sweep bound.
const CHANGED_BOUND_MS = 400_000;
const checkout = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12357-checkout-`));
mkdirSync(join(checkout, "plan"), { recursive: true });
const realPolicy = readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8");
const changedPolicy = realPolicy.replace(/^(sweepWallClockBoundMs:\n {2}value: )\d+$/m, `$1${CHANGED_BOUND_MS}`);
writeFileSync(join(checkout, "plan", "policy.yaml"), changedPolicy);
execFileSync("git", ["init", "-q", checkout]);
execFileSync("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/craigoley/remudero.git"]);
const savedArgv = [...process.argv];
process.argv.push("--repo-root", checkout);
// The run-task test seam, not a direct `src/run-task.ts` import: the reach ratchet caps direct importers.
const { buildSweepLightHook, daemonCommand } = await import("#test/helpers/run-task-test.js");
const { DEFAULT_SWEEP_POLICY } = await import("#src/lib/sweep.js");
const { loadDefaultPolicy, loadPolicy } = await import("#src/lib/policy.js");
process.argv.splice(0, process.argv.length, ...savedArgv);
process.on("exit", () => rmSync(checkout, { recursive: true, force: true }));

type LightPassReadPorts = NonNullable<Parameters<typeof buildSweepLightHook>[12]>;

const NOW = Date.now();
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const DEFAULT_BOUND_MS = loadDefaultPolicy().values.sweepWallClockBoundMs;

function planPr(prNumber: number): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    headSha: `head-${prNumber}`, headRefName: `run-unfiled-${prNumber}`, lastActivityAt: at(60_000),
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    mergeState: "clean", isPlanFiling: true, changedFiles: [`plan/tasks.d/W1-T${prNumber}-a-task.yaml`],
  };
}

/** Completed ordinary light passes, one tick each, 20 minutes apart: an interval above half of any bound here. */
function priorTicks(): Array<Record<string, unknown>> {
  const base = NOW - 3 * 3_600_000;
  return [0, 1_200_000, 2_400_000, 3_600_000].flatMap((offset, tick) => {
    const ids = { pass_id: `prior-${tick}`, light_pass_scope: "idle", tick_id: `tick-${tick}` };
    const ts = new Date(base + offset).toISOString();
    return [{ ts, run_id: "PRIOR", task_id: "SWEEP", step: "sweep.pass", ...ids },
      { ts, run_id: "PRIOR", task_id: "SWEEP", step: "sweep.summary", ...ids, elapsed_ms: 1 }];
  });
}

/** The io ports of one light pass over two ready plan PRs, and the policy every effects build was given. */
function lightPassPorts(prs: OpenPrView[], runId: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12357-`));
  const rows: Array<Record<string, unknown>> = [
    ...priorTicks(),
    ...prs.map((p) => ({ ts: at(120_000), step: "review.posted", task_id: p.taskId, pr_url: p.prUrl,
      head_sha: p.headSha, state: "success", capped: false, plan_only: true })),
  ];
  const merged: number[] = [];
  const effectsPolicies: Array<number | undefined> = [];
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId, readLedger: () => rows,
    appendLine: (_path, row) => { rows.push({ ts: new Date().toISOString(), ...row }); },
    readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    arm: async (p): Promise<"direct-merged"> => { merged.push(p.prNumber); return "direct-merged"; },
    postReview: () => {}, close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"),
    escalate: () => {},
    readMainTip: async () => "main-1",
    readLiveState: (p) => ({ ok: true, state: "OPEN", headSha: p.headSha }),
    rereadPrAtAct: async () => undefined,
    readActionsStatusSummary: async () => ({ components: [], incidents: [] }),
    readBranchProtectionStrict: async () => false,
    updateBranch: () => assert.fail("unexpected update-branch"),
  };
  const io: LightPassReadPorts = {
    openPrViews: async () => prs,
    effects: (deps) => { effectsPolicies.push(deps.policy?.sweepWallClockBoundMs); return effects; },
    readCompare: async () => ({ ahead_by: 0, files: [] }),
  };
  const log = (step: string, extra: Record<string, unknown> = {}): void => {
    rows.push({ ts: new Date().toISOString(), run_id: runId, task_id: "SWEEP", step, ...extra });
  };
  /** The summary rows of this pass that held plan merge turns. */
  const planSummaries = (from: Array<Record<string, unknown>> = rows) =>
    from.filter((r) => r.step === "sweep.summary" && r.run_id === runId && r.plan_merge_attempts !== undefined);
  return { root, rows, merged, effectsPolicies, io, log, planSummaries,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Builds the hook with the io ports and, when given, a bound, as the daemon's call does. */
function hookWith(f: ReturnType<typeof lightPassPorts>, runId: string, bound?: number) {
  // The bound rides in the same io object the daemon passes.
  const io: LightPassReadPorts = bound === undefined ? f.io : {
    openPrViews: f.io.openPrViews, effects: f.io.effects, readCompare: f.io.readCompare, sweepWallClockBoundMs: bound,
  };
  return buildSweepLightHook("o", "r", { root: f.root } as never, join(f.root, "ledger.ndjson"), runId,
    { tasks: [], byId: new Map() } as never, f.log, undefined, undefined, undefined, undefined, undefined, io);
}

test("W1-T12357: the light pass hook gives each pass the bound it was given", async () => {
  const bound = 300_000;
  const f = lightPassPorts([planPr(1235701), planPr(1235702)], "T12357-1");
  try {
    await hookWith(f, "T12357-1", bound)();
    assert.ok(f.effectsPolicies.length > 0, "the hook built its effects");
    for (const seen of f.effectsPolicies) assert.equal(seen, bound, "the effects of the pass take the bound");
    const summaries = f.planSummaries();
    assert.ok(summaries.length > 0, "a pass held the plan merge turns");
    for (const summary of summaries) {
      assert.equal(summary.plan_merge_interval_ms, 1_200_000);
      assert.equal(summary.plan_merge_budget_ms, bound / 2, "the budget cap is half of the bound the hook was given");
    }
    assert.deepEqual(f.merged, [1235701, 1235702]);
  } finally { f.cleanup(); }
});

test("W1-T12357: a daemon with a changed sweep bound caps the plan-merge budget at half of it", async () => {
  assert.equal(loadPolicy(join(checkout, "plan", "policy.yaml")).values.sweepWallClockBoundMs, CHANGED_BOUND_MS,
    "precondition: the fixture checkout's policy names the changed bound");
  assert.notEqual(CHANGED_BOUND_MS, DEFAULT_BOUND_MS, "precondition: the changed bound is not the default");
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12357-home-`));
  const stateRoot = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root: stateRoot }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const f = lightPassPorts([planPr(1235711), planPr(1235712)], "T12357-2");
  // Every GitHub read the daemon makes on its way to the light pass gets an empty list.
  const shim = ghShim([{ when: "", stdout: "[]" }]);
  const keys = ["HOME", "PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS"] as const;
  const oldEnv = keys.map((key) => [key, process.env[key]] as const);
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(home, "gh-cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  let daemonLedger: string | undefined;
  let tickBound: number | undefined;
  process.env.HOME = home;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      // The boot seams of test/daemon/ops-catalog-shadow-disabled.test.ts: no boot sweep, App refresh or heap tuning.
      config: { root: stateRoot, claudeBin: "/bin/true" },
      githubFactory: () => ({}) as never,
      startGithubAppRefresh: () => ({ armed: false }),
      applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
      daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath,
        node_version: process.version }),
      checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
      bootClaimReserver: { mintAnchor: () => "fixture", attempt: () => "unreachable", holder: () => undefined,
        drop: () => false, list: () => [] },
      buildSweepHook: () => async () => {},
      // The daemon's own arguments reach the real builder. Only the GitHub reads and effects are fixtures;
      // the io object the daemon built, with its bound, is kept.
      buildSweepLightHook: (...args: Parameters<typeof buildSweepLightHook>) => {
        daemonLedger = args[3];
        const forwarded: Parameters<typeof buildSweepLightHook> = [...args];
        forwarded[12] = { ...args[12], ...f.io };
        return buildSweepLightHook(...forwarded);
      },
      wireSweepWake: () => ({ sleep: async () => "timeout" as const, acknowledge: () => {}, close: () => {} }),
      runDaemon: async (_plan, wired, opts): Promise<DaemonSummary> => {
        tickBound = opts?.sweepWallClockBoundMs;
        await wired.sweepLight?.();
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.equal(tickBound, CHANGED_BOUND_MS, "the sweep tick takes the changed bound");
    assert.ok(daemonLedger && existsSync(daemonLedger), "the daemon wrote its ledger");
    const daemonRows = readFileSync(daemonLedger, "utf8").split("\n").filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const summaries = daemonRows.filter((r) => r.step === "sweep.summary" && r.plan_merge_attempts !== undefined);
    assert.ok(summaries.length > 0, "the daemon's light pass wrote a summary row with plan merge turns");
    for (const summary of summaries) {
      assert.equal(summary.plan_merge_interval_ms, 1_200_000, "the measured interval is above half of the bound");
      assert.equal(summary.plan_merge_budget_ms, CHANGED_BOUND_MS / 2, "the budget cap is half of the changed bound");
    }
  } finally {
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(shim.dir, { recursive: true, force: true });
    f.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T12357: a hook with no bound keeps the default policy", async () => {
  const f = lightPassPorts([planPr(1235721), planPr(1235722)], "T12357-3");
  try {
    await hookWith(f, "T12357-3")();
    assert.ok(f.effectsPolicies.length > 0, "the hook built its effects");
    for (const seen of f.effectsPolicies) assert.equal(seen, DEFAULT_SWEEP_POLICY.sweepWallClockBoundMs);
    const summaries = f.planSummaries();
    assert.ok(summaries.length > 0, "a pass held the plan merge turns");
    for (const summary of summaries) {
      assert.equal(summary.plan_merge_budget_ms, Math.floor(DEFAULT_BOUND_MS / 2), "the default bound caps the budget");
    }
  } finally { f.cleanup(); }
});
