import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan } from "../src/lib/plan.js";
import type { Config } from "../src/lib/config.js";
import type { LedgerUnionResult } from "../src/lib/ledger-grep.js";
import type { LearningsIndex } from "../src/lib/learnings.js";
import type { Policy } from "../src/lib/policy.js";
import {
  recordWipeTestCadenceFire,
  runMeasurementCadenceReport,
  wipeTestCadenceCheck,
  wipeTestCadenceMarkerPath,
} from "../src/lib/measurement-cadence.js";
import { runDaemon } from "../src/lib/daemon.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { runWipeTestPair, WIPE_TEST_PAIRING_FLOOR } from "../src/lib/wipe-test.js";
import { buildWipeTestCadenceDaemonHooks, daemonCommand } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const NOW = new Date("2026-09-06T12:00:00Z");
const ON = { enabled: true, minIntervalMinutes: 1440, maxPerDay: 1 };

function tmp(prefix: string): string {
  // RMD_TMP_PREFIX so src/lib/tmp.ts's sweepStaleTempDirs can reap these on boot — the hook
  // refuses an unprefixed callsite, and a helper taking the prefix as a parameter is exactly the
  // shape it cannot resolve statically, so the prefix is applied here rather than at each caller.
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

function policy(wipeTestCadence = ON): Policy {
  return { values: { wipeTestCadence } } as unknown as Policy;
}

function okUnion(matches: string[] = []): LedgerUnionResult {
  return {
    stateDir: "/state",
    archiveFiles: ["/state/ledger.1.ndjson.gz"],
    archiveCount: 1,
    liveFileRead: true,
    unread: [],
    unclassified: [],
    ok: true,
    matches,
  };
}

function unreadableUnion(): LedgerUnionResult {
  return {
    stateDir: "/state",
    archiveFiles: [],
    archiveCount: 0,
    liveFileRead: false,
    unread: [],
    unclassified: [],
    ok: false,
    matches: [],
  };
}

function pairLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    step: "wipetest.pair",
    task_id: "wt-sbx",
    factor: "learnings",
    arm_a_run_id: "A",
    arm_b_run_id: "B",
    verdict_a: "merged",
    verdict_b: "merged",
    turns_delta: 1,
    cost_delta: 0.5,
    strikes_delta: 0,
    proof_exec_pass_a: 1,
    proof_exec_pass_b: 2,
    ...overrides,
  });
}

function index(): LearningsIndex {
  return {
    files: {
      "a.yaml": { entries: ["a"], globs: ["src/a.ts"] },
      "b.yaml": { entries: ["b"], globs: ["src/b.ts"] },
    },
    bySubsystem: {},
  };
}

test("wipeTestCadenceCheck uses its own marker and defaults to policy-disabled silence", () => {
  const root = tmp("rmd-wipe-cadence-marker-");
  try {
    assert.equal(wipeTestCadenceMarkerPath(root), join(root, "state", "last-wipe-test-cadence.json"));
    assert.equal(wipeTestCadenceCheck({ root, policy: { ...ON, enabled: false }, now: NOW }).fire, false);

    const first = wipeTestCadenceCheck({ root, policy: ON, now: NOW });
    assert.equal(first.fire, true);
    recordWipeTestCadenceFire(root, NOW);
    const second = wipeTestCadenceCheck({ root, policy: ON, now: new Date("2026-09-06T12:01:00Z") });
    assert.equal(second.fire, false);
    assert.match(second.reason, /minInterval/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWipeTestCadenceDaemonHooks rotates generated sandbox subjects and alternates factors", () => {
  const root = tmp("rmd-wipe-cadence-hook-");
  try {
    let rows: string[] = [];
    const hooks = buildWipeTestCadenceDaemonHooks({
      config: { root } as Config,
      policy: policy(),
      learningsIndex: index,
      ledgerUnion: () => okUnion(rows),
      now: () => NOW,
    });

    const first = hooks.checkWipeTestCadence();
    assert.equal(first.fire, true);
    assert.equal(first.seq, 1);
    assert.equal(first.factor, "learnings");
    assert.equal(first.subject.id, "wt-sbx-1");
    assert.deepEqual(first.subject.files, ["src/a.ts"]);
    assert.deepEqual(first.subject.selectedShards, ["a.yaml"]);

    rows = [pairLine({ task_id: "wt-sbx-1", factor: "learnings" })];
    const second = hooks.checkWipeTestCadence();
    assert.equal(second.fire, true);
    assert.equal(second.seq, 2);
    assert.equal(second.factor, "recon");
    assert.equal(second.subject.id, "wt-sbx-2");
    assert.deepEqual(second.subject.files, ["src/b.ts"]);
    assert.deepEqual(second.subject.selectedShards, ["b.yaml"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildWipeTestCadenceDaemonHooks refuses unreadable ledgers and bad generated subjects", () => {
  const root = tmp("rmd-wipe-cadence-bad-subject-");
  try {
    const unreadable = buildWipeTestCadenceDaemonHooks({
      config: { root } as Config,
      policy: policy(),
      learningsIndex: index,
      ledgerUnion: () => unreadableUnion(),
      now: () => NOW,
    }).checkWipeTestCadence();
    assert.equal(unreadable.fire, false);
    assert.match(unreadable.reason, /ledger union unreadable/);

    const badSubject = buildWipeTestCadenceDaemonHooks({
      config: { root } as Config,
      policy: policy(),
      learningsIndex: () => ({ files: { "a.yaml": { entries: ["a"], globs: [] } }, bySubsystem: {} }),
      ledgerUnion: () => okUnion(),
      now: () => NOW,
    }).checkWipeTestCadence();
    assert.equal(badSubject.fire, false);
    assert.match(badSubject.reason, /no isolating literal path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWipeTestCadence refuses an unresolvable target before any worker spawn", async () => {
  const root = tmp("rmd-wipe-cadence-refuse-");
  try {
    let dispatches = 0;
    const hooks = buildWipeTestCadenceDaemonHooks({
      config: { root } as Config,
      policy: policy(),
      learningsIndex: index,
      ledgerUnion: () => okUnion(),
      targetArgs: ["--repo", "remudero"],
      runTaskFn: (async () => {
        dispatches++;
        throw new Error("must not dispatch");
      }) as never,
      now: () => NOW,
    });

    const decision = hooks.checkWipeTestCadence();
    assert.equal(decision.fire, true);
    const result = await hooks.runWipeTestCadence(decision);
    assert.equal(result.status, "refused");
    assert.match(result.reason ?? "", /refusing non-sandbox target/);
    assert.equal(dispatches, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runWipeTestPair materializes generated sandbox subjects and ledgers the pair", async () => {
  const root = tmp("rmd-wipe-pair-core-");
  try {
    const repoDir = join(root, "repos", "remudero-sandbox");
    const stateDir = join(root, "state");
    mkdirSync(join(repoDir, "plan"), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(repoDir, "plan", "tasks.yaml"), "[]\n");
    const gitCalls: string[] = [];
    const runCalls: Array<{ taskId: string; maskLearnings?: boolean }> = [];
    const result = await runWipeTestPair(
      { id: "wt-sbx-9", files: ["src/a.ts"], selectedShards: ["a.yaml"] },
      "learnings",
      {
        owner: "craigoley",
        selfRepo: "remudero",
        repoRoot: root,
        config: { root } as Config,
        ledgerPath: join(stateDir, "ledger.ndjson"),
        pairIndex: 0,
        runId: "WIPETEST-1",
        now: () => NOW,
        resolveMergedState: () => ({ merged: false }),
        execFileSyncFn: ((cmd: string, args: readonly string[]) => {
          gitCalls.push([cmd, ...args].join(" "));
          return Buffer.from("");
        }) as never,
        runTaskFn: (async (taskId: string, opts: { maskLearnings?: boolean }) => {
          runCalls.push({ taskId, maskLearnings: opts.maskLearnings });
          return {
            taskId,
            runId: `RUN-${runCalls.length}`,
            merged: true,
            costUsd: runCalls.length,
            verdict: "merged",
          };
        }) as never,
      },
    );

    assert.equal(result.status, "measured");
    assert.deepEqual(gitCalls, [
      `git -C ${repoDir} fetch --quiet origin`,
      `git -C ${repoDir} reset --hard --quiet origin/main`,
    ]);
    assert.deepEqual(runCalls, [
      { taskId: "wt-sbx-9", maskLearnings: undefined },
      { taskId: "wt-sbx-9", maskLearnings: true },
    ]);
    assert.match(readFileSync(join(repoDir, "plan", "tasks.d", "wt-sbx-9.yaml"), "utf8"), /src\/a\.ts/);
    assert.match(readFileSync(join(stateDir, "ledger.ndjson"), "utf8"), /"step":"wipetest\.pair"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMeasurementCadenceReport includes a wipe-test seat that refuses below the pairing floor", () => {
  const root = tmp("rmd-wipe-report-floor-");
  try {
    const result = runMeasurementCadenceReport({
      stateDir: join(root, "state"),
      cwd: root,
      escalate: false,
      gitLog: () => ({ dump: "", ref: "origin/main" }),
      ledgerUnion: () => okUnion([pairLine({ factor: "learnings" })]),
    });
    const learnings = result.wipeTest!.factors.find((f) => f.factor === "learnings")!;
    assert.equal(learnings.status, "refused");
    assert.equal(learnings.pairCount, WIPE_TEST_PAIRING_FLOOR - 1);
    assert.match(learnings.refusedReason ?? "", /below pairing floor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMeasurementCadenceReport keeps verbCensus last and ignores torn wipe-test rows", () => {
  const root = tmp("rmd-wipe-report-order-");
  try {
    const result = runMeasurementCadenceReport({
      stateDir: join(root, "state"),
      cwd: root,
      escalate: false,
      gitLog: () => ({ dump: "", ref: "origin/main" }),
      ledgerUnion: () => okUnion(["{not json", pairLine({ factor: "learnings" })]),
    });
    assert.equal(Object.keys(result).at(-1), "verbCensus");
    const learnings = result.wipeTest!.factors.find((f) => f.factor === "learnings")!;
    assert.equal(learnings.status, "refused");
    assert.equal(learnings.pairCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMeasurementCadenceReport measures wipe-test factors at or above the pairing floor", () => {
  const root = tmp("rmd-wipe-report-measured-");
  try {
    const result = runMeasurementCadenceReport({
      stateDir: join(root, "state"),
      cwd: root,
      escalate: false,
      gitLog: () => ({ dump: "", ref: "origin/main" }),
      ledgerUnion: () =>
        okUnion([
          pairLine({ task_id: "wt-sbx-1", factor: "learnings", cost_delta: 1 }),
          pairLine({ task_id: "wt-sbx-2", factor: "learnings", cost_delta: 3 }),
          pairLine({ task_id: "wt-sbx-3", factor: "recon", turns_delta: 2 }),
          pairLine({ task_id: "wt-sbx-4", factor: "recon", turns_delta: 4 }),
        ]),
    });
    const learnings = result.wipeTest!.factors.find((f) => f.factor === "learnings")!;
    const recon = result.wipeTest!.factors.find((f) => f.factor === "recon")!;
    assert.equal(learnings.status, "measured");
    assert.equal(learnings.aggregate?.pairs, WIPE_TEST_PAIRING_FLOOR);
    assert.equal(learnings.aggregate?.avgCostDelta, 2);
    assert.equal(recon.status, "measured");
    assert.equal(recon.aggregate?.avgTurnsDelta, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDaemon ledgers wipe-test cadence fired, skipped, and refused rows", async () => {
  const root = tmp("rmd-wipe-daemon-");
  try {
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let tick = 0;
    await runDaemon(loadPlan(planPath), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => (++tick > 2 ? "bound" : undefined),
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
      checkWipeTestCadence: () =>
        tick === 1
          ? { fire: true, reason: "first run", seq: 1, subject: { id: "wt-sbx-1", selectedShards: ["a.yaml"] }, factor: "learnings" }
          : { fire: false, reason: "daily cap reached" },
      runWipeTestCadence: async (decision) => ({
        status: "refused",
        reason: "preflight refused",
        seq: decision.seq,
        subject: decision.subject,
        factor: decision.factor,
      }),
    });

    assert.ok(lines.some((l) => l.step === "wipetest.cadence.fired"));
    assert.ok(lines.some((l) => l.step === "wipetest.cadence.refused"));
    assert.ok(lines.some((l) => l.step === "wipetest.cadence.skipped"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDaemon ledgers wipe-test cadence check and run failures", async () => {
  const root = tmp("rmd-wipe-daemon-failures-");
  try {
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let tick = 0;
    await runDaemon(loadPlan(planPath), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => (++tick > 3 ? "bound" : undefined),
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra }),
      checkWipeTestCadence: () => {
        if (tick === 1) throw new Error("check boom");
        if (tick === 2) {
          return { fire: true, reason: "first run", seq: 1, subject: { id: "wt-sbx-1" }, factor: "learnings" };
        }
        return { fire: false, reason: "daily cap reached" };
      },
      runWipeTestCadence: async () => {
        throw new Error("run boom");
      },
    });

    assert.ok(lines.some((l) => l.step === "wipetest.cadence.check_failed"));
    assert.ok(
      lines.some((l) => l.step === "wipetest.cadence.refused" && String(l.extra.reason).includes("run boom")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// W1-T2905: this assertion used to READ src/run-task.ts AS TEXT and match two call-site regexes.
// That passes when the prose is right and the behaviour is wrong, and breaks on a refactor that
// moves the prose and nothing else -- the shape source-text-assertion-census.test.ts refuses. It
// is replaced by the seam the repo already pins for exactly this class of rung, and NOT by calling
// buildWipeTestCadenceDaemonHooks() directly: as the-daily-rung-only-fires-when-a-human-types-it
// .test.ts states for its sibling rung, "a test that called [the builder] directly would pass just
// as happily on the unwired code". Driving the real daemonCommand and asserting on the DaemonDeps
// it hands runDaemon is what fails when the producer line in run-task.ts is deleted -- which is
// what the deleted grep was standing in for, and is strictly stronger than it.
test("W1-T2659 REACHABILITY: daemonCommand WIRES the wipe-test rung into the deps it hands runDaemon", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}wipetest-wiring-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an explicit --plan skips the git self-sync entirely
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0, "the injected runDaemon returns a clean 'stopped' summary -> exit 0");
    assert.ok(captured, "runDaemon was reached and its DaemonDeps captured");
    // Without run-task.ts's producer line these are `undefined` and the whole rung is unreachable,
    // however many unit tests the rung itself carries.
    assert.equal(typeof captured.checkWipeTestCadence, "function", "a self-target daemon must wire the decision hook");
    assert.equal(typeof captured.runWipeTestCadence, "function", "a self-target daemon must wire the runner");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
