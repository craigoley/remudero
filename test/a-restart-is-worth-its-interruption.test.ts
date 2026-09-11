import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEPLOY_RESTART_SCORE_STEP,
  DEPLOY_RESTART_SCORE_THRESHOLD,
  accumulateDeployRestartPressure,
  judgeDeployWorth,
  replayDeployRestartFrequency,
  resetDeployRestartPressure,
  type DeployRestartPressureState,
  type DeployWorthChange,
  type DeployWorthVerdict,
} from "../src/lib/deploy-judge.js";
import { runDeployCycle, type DeployDeps, type HealthInputs, type IdleProbe } from "../src/lib/deployer.js";
import { rotateLedger } from "../src/lib/ledger.js";

const idle: IdleProbe = { workers: 0, inflightLocks: 0, worktreeLocks: 0 };
const busy: IdleProbe = { workers: 1, inflightLocks: 0, worktreeLocks: 0 };

function change(sha: string, files: readonly string[], subject = "feat(core): change runtime"): DeployWorthChange {
  return { sha, files, subject };
}

function pressure(
  changes: readonly DeployWorthChange[],
  state: DeployRestartPressureState = { total: 0, scoredShas: [] },
  opts: {
    threshold?: number;
    scoreChange?: (change: DeployWorthChange) => DeployWorthVerdict;
    nowMs?: number;
    rateCeilingMs?: number;
  } = {},
) {
  return accumulateDeployRestartPressure(changes, state, {
    threshold: {
      value: opts.threshold ?? DEPLOY_RESTART_SCORE_THRESHOLD.value,
      reason: "test threshold",
    },
    nowMs: opts.nowMs ?? 1000,
    rateCeilingMs: opts.rateCeilingMs ?? 0,
    scoreChange: opts.scoreChange ?? ((c) => judgeDeployWorth(c)),
  });
}

interface Recorder {
  calls: string[];
  logs: Array<{ step: string; data?: Record<string, unknown> }>;
  stateRef: { value: DeployRestartPressureState };
  deps: DeployDeps;
}

function makeDeps(opts: {
  markerPresent?: boolean;
  autoMode?: boolean;
  installHead?: string;
  originMain?: string;
  runningHead?: string;
  pendingChanges?: DeployWorthChange[];
  judge?: (change: DeployWorthChange, base: DeployWorthVerdict) => string | DeployWorthVerdict;
  restartPressureState?: DeployRestartPressureState;
  idle?: IdleProbe | IdleProbe[];
  nowMs?: number;
  health?: HealthInputs;
  rateCeilingMs?: number;
}): Recorder {
  const calls: string[] = [];
  const logs: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const headRef = { value: opts.installHead ?? "old" };
  const stateRef = { value: opts.restartPressureState ?? { total: 0, scoredShas: [] } };
  const idleSeq = Array.isArray(opts.idle) ? [...opts.idle] : undefined;
  const deps: DeployDeps = {
    log: (step, data) => {
      calls.push(`log:${step}`);
      logs.push({ step, data });
    },
    now: () => opts.nowMs ?? 1000,
    fetch: () => calls.push("fetch"),
    installHead: () => headRef.value,
    originMain: () => opts.originMain ?? "new",
    markerPresent: () => opts.markerPresent ?? false,
    autoMode: () => opts.autoMode ?? true,
    lastFailedHead: () => undefined,
    runningHead: () => opts.runningHead ?? headRef.value,
    dirtyFiles: () => [],
    incomingFiles: () => (opts.pendingChanges ?? []).flatMap((c) => [...c.files]),
    pendingChanges: () => opts.pendingChanges ?? [],
    restartPressureState: () => stateRef.value,
    setRestartPressureState: (next) => {
      calls.push(`setRestartPressureState:${next.total}`);
      stateRef.value = next;
    },
    restartWorthJudge: opts.judge,
    restartRateCeilingMs: () => opts.rateCeilingMs ?? 0,
    pullFf: () => {
      calls.push("pullFf");
      headRef.value = opts.originMain ?? "new";
    },
    resetHard: (ref) => {
      calls.push(`resetHard:${ref}`);
      headRef.value = ref;
    },
    probeIdle: () => {
      calls.push("probeIdle");
      return idleSeq ? (idleSeq.shift() ?? idle) : (opts.idle as IdleProbe | undefined) ?? idle;
    },
    kickstart: () => calls.push("kickstart"),
    waitBootHealth: () => {
      calls.push("waitBootHealth");
      return opts.health ?? { bootObserved: true, crashCount: 0 };
    },
    alert: () => calls.push("alert"),
    clearMarker: () => calls.push("clearMarker"),
    kickstartConsole: () => calls.push("kickstartConsole"),
    consolePid: () => 1234,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => calls.push("alertConsoleOnly"),
  };
  return { calls, logs, stateRef, deps };
}

test("plan-only changes score exactly zero and never reach the judge", () => {
  let judgeCalls = 0;
  const out = pressure([change("p1", ["plan/tasks.d/W1-T1.yaml"], "chore(plan): file W1-T1")], { total: 7, scoredShas: [] }, {
    scoreChange: (c) =>
      judgeDeployWorth(c, {
        judge: () => {
          judgeCalls++;
          return { score: 18, reason: "must not be consulted", source: "judge" };
        },
      }),
  });

  assert.equal(out.scoreRows.length, 1);
  assert.equal(out.scoreRows[0]?.score, 0);
  assert.equal(out.state.total, 7, "zero-scored plan work exerts no restart pressure");
  assert.equal(judgeCalls, 0, "plan-only never reaches the judge");
  assert.equal(out.wantRestart, false);
});

test("scores accumulate: sub-threshold changes defer, and the crossing change wants one restart", () => {
  const scoreOne = (c: DeployWorthChange): DeployWorthVerdict => ({ score: 1, reason: c.sha, source: "deterministic" });
  const first = pressure([change("s1", ["src/a.ts"]), change("s2", ["scripts/a.mjs"])], undefined, { threshold: 3, scoreChange: scoreOne });
  assert.equal(first.wantRestart, false);
  assert.equal(first.state.total, 2);

  const crossing = pressure([change("s3", ["src/b.ts"])], first.state, { threshold: 3, scoreChange: scoreOne });
  assert.equal(crossing.wantRestart, true);
  assert.equal(crossing.state.total, 3);
  assert.match(crossing.reason, /crossed/);
});

test("a completed restart resets the accumulated pressure", () => {
  const r = makeDeps({
    autoMode: true,
    installHead: "old",
    originMain: "new",
    pendingChanges: [change("s1", ["src/deploy.ts"])],
    restartPressureState: { total: 17, scoredShas: [], lastRestartAtMs: 1 },
  });

  const out = runDeployCycle(r.deps);

  assert.equal(out.deployed, true);
  assert.deepEqual(r.stateRef.value, resetDeployRestartPressure(r.stateRef.value, 1000));
  assert.ok(r.calls.includes("kickstart"));
});

test("the judge may raise a runtime score but may never lower it, and plan-only still bypasses it", () => {
  let calls = 0;
  const lower = judgeDeployWorth(change("s1", ["src/a.ts"]), {
    judge: () => {
      calls++;
      return { score: 0, reason: "lower please", source: "judge" };
    },
  });
  assert.equal(lower.score, 1, "the deterministic source floor remains in force");
  assert.equal(lower.source, "judge");

  const plan = judgeDeployWorth(change("p1", ["MASTER-PLAN.md"]), {
    judge: () => {
      calls++;
      return { score: 18, reason: "plan should not reach this", source: "judge" };
    },
  });
  assert.equal(plan.score, 0);
  assert.equal(calls, 1, "only the runtime change reached the judge");
});

test("an uplift equal to the threshold makes one change justify a restart by itself", () => {
  const out = pressure([change("hotfix", ["src/escalate.ts"])], undefined, {
    scoreChange: (c) =>
      judgeDeployWorth(c, {
        judge: () => ({
          score: DEPLOY_RESTART_SCORE_THRESHOLD.value,
          reason: `${c.sha} clears a live defect`,
          source: "judge",
        }),
      }),
  });

  assert.equal(out.scoreRows[0]?.score, DEPLOY_RESTART_SCORE_THRESHOLD.value);
  assert.equal(out.wantRestart, true);
});

test("the recorded threshold is tunable: the same sequence restarts less when raised and more when lowered", () => {
  const sequence = Array.from({ length: 36 }, () => 1);

  assert.equal(replayDeployRestartFrequency(sequence, 18).restarts, 2);
  assert.equal(replayDeployRestartFrequency(sequence, 12).restarts, 3);
  assert.equal(replayDeployRestartFrequency(sequence, 9).restarts, 4);
});

test("a restart-worthy score cannot bypass the idle gate", () => {
  const r = makeDeps({
    autoMode: true,
    installHead: "old",
    originMain: "new",
    pendingChanges: [change("urgent", ["src/live.ts"])],
    idle: busy,
    judge: () => ({ score: DEPLOY_RESTART_SCORE_THRESHOLD.value, reason: "urgent", source: "judge" }),
  });

  const out = runDeployCycle(r.deps);

  assert.equal(out.deployed, false);
  assert.match(out.reason, /not-idle/);
  assert.ok(!r.calls.includes("kickstart"));
  assert.ok(!r.calls.includes("pullFf"));
});

test("throwing and unparseable judge verdicts fail closed at the deployer call site", () => {
  for (const judge of [
    () => {
      throw new Error("spawn unavailable");
    },
    () => "DEPLOY_IMPACT_SCORE: maybe\nDEPLOY_IMPACT_REASON: not parseable",
  ]) {
    const r = makeDeps({
      autoMode: true,
      installHead: "old",
      originMain: "new",
      pendingChanges: [change("s1", ["src/a.ts"])],
      judge,
    });

    const out = runDeployCycle(r.deps);
    assert.equal(out.deployed, false);
    assert.match(out.reason, /below threshold/);
    assert.ok(!r.calls.includes("pullFf"));
  }
});

test("the restart-rate ceiling holds even when the judge says every change is urgent, and it is ledgered", () => {
  const r = makeDeps({
    autoMode: true,
    installHead: "old",
    originMain: "new",
    nowMs: 2000,
    rateCeilingMs: 10_000,
    restartPressureState: { total: 17, scoredShas: [], lastRestartAtMs: 1000 },
    pendingChanges: [change("urgent", ["src/live.ts"])],
    judge: () => ({ score: DEPLOY_RESTART_SCORE_THRESHOLD.value, reason: "urgent", source: "judge" }),
  });

  const out = runDeployCycle(r.deps);

  assert.equal(out.deployed, false);
  assert.match(out.reason, /restart-rate ceiling/);
  assert.ok(!r.calls.includes("kickstart"));
  assert.ok(r.logs.some((l) => l.step === "deploy.restart_rate_limited"));
});

test("an explicit deploy marker forces deployment without consulting the restart judge", () => {
  let judgeCalls = 0;
  const r = makeDeps({
    markerPresent: true,
    autoMode: true,
    installHead: "old",
    originMain: "new",
    pendingChanges: [change("p1", ["plan/tasks.d/W1-T2.yaml"])],
    judge: () => {
      judgeCalls++;
      return { score: 18, reason: "ignored", source: "judge" };
    },
  });

  const out = runDeployCycle(r.deps);

  assert.equal(out.deployed, true);
  assert.equal(judgeCalls, 0);
  assert.ok(r.calls.includes("kickstart"));
});

test("score and pressure decisions are ledgered with decision, reason, total and threshold on both arms", () => {
  const below = makeDeps({
    autoMode: true,
    installHead: "old",
    originMain: "new",
    pendingChanges: [change("s1", ["src/a.ts"])],
  });
  runDeployCycle(below.deps);
  const belowDecision = below.logs.find((l) => l.step === "deploy.restart_pressure");
  assert.equal(belowDecision?.data?.decision, "defer");
  assert.match(String(belowDecision?.data?.reason), /below threshold/);
  assert.equal(belowDecision?.data?.total, 1);
  assert.equal(belowDecision?.data?.threshold, DEPLOY_RESTART_SCORE_THRESHOLD.value);

  const restart = makeDeps({
    autoMode: true,
    installHead: "old",
    originMain: "new",
    restartPressureState: { total: 17, scoredShas: [] },
    pendingChanges: [change("s2", ["scripts/deploy.mjs"])],
  });
  runDeployCycle(restart.deps);
  const restartDecision = restart.logs.find((l) => l.step === "deploy.restart_pressure");
  assert.equal(restartDecision?.data?.decision, "restart");
  assert.match(String(restartDecision?.data?.reason), /crossed/);

  const scoreRow = restart.logs.find((l) => l.step === DEPLOY_RESTART_SCORE_STEP);
  assert.equal(scoreRow?.data?.score, 1);
  assert.equal(scoreRow?.data?.total, 18);
  assert.equal(scoreRow?.data?.threshold, DEPLOY_RESTART_SCORE_THRESHOLD.value);
  assert.ok(typeof scoreRow?.data?.reason === "string" && scoreRow.data.reason.length > 0);
});

test("recent deploy score rows survive a real ledger rotation through the deploy.* retention path", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-deploy-worth-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  try {
    const rows = [
      JSON.stringify({ ts: "2026-09-11T00:00:00.000Z", step: DEPLOY_RESTART_SCORE_STEP, run_id: "d", task_id: "DEPLOY", score: 9 }),
      ...Array.from({ length: 80 }, (_, i) =>
        JSON.stringify({ ts: "2026-09-11T00:00:00.000Z", step: `noise.${i}`, run_id: "n", task_id: "N", pad: "x".repeat(120) }),
      ),
      "",
    ].join("\n");
    writeFileSync(ledgerPath, rows);

    const result = rotateLedger(ledgerPath, {
      ceilingBytes: 1000,
      now: () => new Date("2026-09-11T00:05:00.000Z"),
    });
    assert.equal(result.rotated, true);
    assert.match(readFileSync(ledgerPath, "utf8"), new RegExp(`"step":"${DEPLOY_RESTART_SCORE_STEP}"`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
