import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { loadPlan } from "#src/lib/plan.js";
import type { Config } from "#src/lib/config.js";
import type { LedgerUnionResult } from "#src/lib/ledger-grep.js";
import type { LearningsIndex } from "#src/lib/learnings.js";
import type { Policy } from "#src/lib/policy.js";
import {
  readWipeTestAblationEvidence,
  recordWipeTestCadenceFire,
  runMeasurementCadenceReport,
  wipeTestCadenceCheck,
  wipeTestCadenceMarkerPath,
  type WipeTestAblationEvidence,
  type WipeTestEvidenceCost,
} from "#src/lib/measurement-cadence.js";
// A namespace import, so a test of one export fails alone where that export is missing rather than the file.
import * as cadence from "#src/lib/measurement-cadence.js";
import { runDaemon } from "#src/lib/daemon.js";
import type { DaemonDeps, DaemonSummary } from "#src/lib/daemon.js";
import { runWipeTestPair, WIPE_TEST_PAIRING_FLOOR } from "#src/lib/wipe-test.js";
import { buildWipeTestCadenceDaemonHooks, daemonCommand } from "#src/run-task.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = new Date("2026-09-06T12:00:00Z");
const ON = { enabled: true, minIntervalMinutes: 1440, maxPerDay: 1, baseShare: 1, settledHalfWidthTurns: 2 };

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

/** The hooks' evidence seam over a canned union: the raw lines {@link okUnion} or {@link unreadableUnion}
 *  carries, as the records a step-filtered union read returns. */
function evidenceOf(union: () => LedgerUnionResult): (stateDir: string) => {
  evidence: WipeTestAblationEvidence;
  cost: WipeTestEvidenceCost;
} {
  return (stateDir) => ({
    evidence: readWipeTestAblationEvidence(stateDir, () => {
      const read = union();
      const rows = read.matches.map((line) => JSON.parse(line) as Record<string, unknown>);
      return { ...read, rows, torn: 0, filesRead: 0, unclassified: read.unclassified ?? [] };
    }),
    cost: { bytesRead: 0, rotationsRead: 0, rotations: 1 },
  });
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
      readEvidence: evidenceOf(() => okUnion(rows)),
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
      readEvidence: evidenceOf(() => unreadableUnion()),
      now: () => NOW,
    }).checkWipeTestCadence();
    assert.equal(unreadable.fire, false);
    assert.match(unreadable.reason, /ledger union unreadable/);

    const badSubject = buildWipeTestCadenceDaemonHooks({
      config: { root } as Config,
      policy: policy(),
      learningsIndex: () => ({ files: { "a.yaml": { entries: ["a"], globs: [] } }, bySubsystem: {} }),
      readEvidence: evidenceOf(() => okUnion()),
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
      readEvidence: evidenceOf(() => okUnion()),
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

// W1-T2905 / diff-coverage: `ledgerPath` is a SEAM, and every other test in this file injects it,
// so `runWipeTestPair`'s `deps.ledgerPath ?? ledgerPathForRoot(deps.config.root)` fallback never
// ran and both lines of `ledgerPathForRoot` were added with zero covering tests -- the all-fakes
// shape CLAUDE.md's coverage section names ("when every test injects a fake, the seam's DEFAULT
// implementation is unreachable"). This test OMITS the seam so the default resolves for real, and
// asserts WHERE it lands rather than merely that it ran: <config.root>/state/ledger.ndjson.
test("runWipeTestPair ledgers to <root>/state/ledger.ndjson when no ledgerPath seam is injected", async () => {
  const root = tmp("rmd-wipe-pair-default-ledger-");
  try {
    const repoDir = join(root, "repos", "remudero-sandbox");
    mkdirSync(join(repoDir, "plan"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(repoDir, "plan", "tasks.yaml"), "[]\n");
    let runs = 0;
    const result = await runWipeTestPair(
      { id: "wt-sbx-default", files: ["src/a.ts"], selectedShards: ["a.yaml"] },
      "learnings",
      {
        owner: "craigoley",
        selfRepo: "remudero",
        repoRoot: root,
        config: { root } as Config,
        // NO ledgerPath — that is the point of this test.
        pairIndex: 0,
        runId: "WIPETEST-DEFAULT",
        now: () => NOW,
        resolveMergedState: () => ({ merged: false }),
        execFileSyncFn: (() => Buffer.from("")) as never,
        runTaskFn: (async (taskId: string) => {
          runs += 1;
          return { taskId, runId: `RUN-${runs}`, merged: true, costUsd: runs, verdict: "merged" };
        }) as never,
      },
    );

    assert.equal(result.status, "measured");
    // The default path, spelled out here so a change to ledgerPathForRoot reddens this test.
    const defaulted = join(root, "state", "ledger.ndjson");
    assert.ok(existsSync(defaulted), `the pair must ledger to ${defaulted} with no seam injected`);
    assert.match(readFileSync(defaulted, "utf8"), /"step":"wipetest\.pair"/);
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

// ── The check re-read every rotation on every pulse of an unablated slot (2026-10-16) ─────────────
// OBSERVED on the fleet host: `wipetest.cadence.skipped` fired 66 times in ~85 min, each time after a
// synchronous union read of 290 of 377 rotations (260.6 MB), always to reach the same "slot draw ≥ share".

/** Whole seconds, so a rotation's mtime survives a round trip through utimes exactly. */
const ROTATION_MTIME_S = 1_790_000_000;

/** A state dir of `count` gzipped rotations, each holding filler, one `learnings.used` row and (in the
 *  first) one learnings pair, plus a live ledger. */
function seedRotations(stateDir: string, count: number): string[] {
  mkdirSync(stateDir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = String(i + 1).padStart(2, "0");
    const ts = `2026-09-${day}T00:00:00.000Z`;
    const rows = [
      ...Array.from({ length: 50 }, (_, n) => JSON.stringify({ ts, step: "tick", run_id: `filler-${i}-${n}`, pad: "x".repeat(200) })),
      JSON.stringify({ ts, step: "learnings.used", run_id: `W1-T${i}-1`, injected_ids: ["a"], used_ids: i % 2 === 0 ? ["a"] : [] }),
      ...(i === 0 ? [JSON.parse(pairLine({ task_id: "wt-sbx-1", factor: "learnings", turns_delta: -1 })) as Record<string, unknown>].map((r) => JSON.stringify({ ts, ...r })) : []),
    ];
    const path = join(stateDir, `ledger.2026-09-${day}T00-00-00-000Z.ndjson.gz`);
    writeFileSync(path, gzipSync(`${rows.join("\n")}\n`));
    utimesSync(path, ROTATION_MTIME_S, ROTATION_MTIME_S);
    paths.push(path);
  }
  writeFileSync(join(stateDir, "ledger.ndjson"), `${JSON.stringify({ ts: "2026-10-16T00:00:00.000Z", step: "tick" })}\n`);
  return paths;
}

/** Overwrite a rotation with bytes no gunzip accepts, keeping its size and mtime: a reader that re-opens it
 *  refuses the union, and one that kept what it read never notices. */
function scrambleInPlace(path: string): void {
  const size = statSync(path).size;
  writeFileSync(path, Buffer.alloc(size, 0x5a));
  utimesSync(path, ROTATION_MTIME_S, ROTATION_MTIME_S);
}

const SKIPPING = { ...ON, baseShare: 0.05 };

test("wipe-test cadence: a repeat check never re-reads a rotation it has already read", () => {
  const root = tmp("rmd-wipe-cadence-reread-");
  try {
    const rotations = seedRotations(join(root, "state"), 6);
    const hooks = buildWipeTestCadenceDaemonHooks({
      config: { root } as Config,
      policy: policy(SKIPPING),
      learningsIndex: index,
      now: () => NOW,
      draw: () => 0.99,
    });

    const first = hooks.checkWipeTestCadence();
    assert.equal(first.fire, false);
    assert.match(first.reason, /slot draw 0\.990/, "the first check reads the evidence and skips on the draw");

    for (const path of rotations) scrambleInPlace(path);
    appendFileSync(join(root, "state", "ledger.ndjson"), `${JSON.stringify({ ts: "2026-10-16T00:00:01.000Z", step: "tick" })}\n`);

    const second = hooks.checkWipeTestCadence();
    assert.equal(second.fire, false);
    assert.doesNotMatch(second.reason, /unreadable/, "a repeat check must not re-open a rotation it already read");
    assert.equal(second.reason, first.reason);
    assert.equal(second.evidence?.rotationsRead, 0, "the repeat read decompressed no rotation");
    assert.equal(second.evidence?.rotations, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wipe-test cadence: a slot's skip is reused until the slot or its evidence changes", () => {
  const root = tmp("rmd-wipe-cadence-slot-");
  try {
    seedRotations(join(root, "state"), 2);
    let now = NOW;
    let indexLoads = 0;
    const hooks = buildWipeTestCadenceDaemonHooks({
      config: { root } as Config,
      policy: policy(SKIPPING),
      learningsIndex: () => {
        indexLoads++;
        return index();
      },
      now: () => now,
      draw: () => 0.99,
    });

    const first = hooks.checkWipeTestCadence();
    assert.equal(first.fire, false);
    assert.equal(indexLoads, 1);

    const second = hooks.checkWipeTestCadence();
    assert.equal(indexLoads, 1, "the same slot over the same evidence is not re-derived");
    assert.equal(second.reason, first.reason);
    assert.equal(first.evidence?.reused, false);
    assert.equal(second.evidence?.reused, true);

    appendFileSync(
      join(root, "state", "ledger.ndjson"),
      `${JSON.stringify({ ts: "2026-10-16T00:00:02.000Z", ...(JSON.parse(pairLine({ task_id: "wt-sbx-2" })) as object) })}\n`,
    );
    const third = hooks.checkWipeTestCadence();
    assert.equal(indexLoads, 2, "a new pair is new evidence, so the slot is re-derived");
    assert.equal(third.evidence?.reused, false);

    now = new Date(NOW.getTime() + SKIPPING.minIntervalMinutes * 60_000);
    hooks.checkWipeTestCadence();
    assert.equal(indexLoads, 3, "the next slot is re-derived");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wipe-test cadence: each check reports the bytes and rotations its evidence read cost", () => {
  const root = tmp("rmd-wipe-cadence-cost-");
  try {
    const stateDir = join(root, "state");
    const rotations = seedRotations(stateDir, 4);
    const rotationBytes = rotations.reduce((sum, path) => sum + statSync(path).size, 0);
    const read = cadence.createWipeTestEvidenceReader();

    const cold = read(stateDir);
    assert.equal(cold.evidence.ok, true);
    if (cold.evidence.ok) {
      assert.equal(cold.evidence.pairs.length, 1);
      assert.deepEqual(cold.evidence.claimedUse, { learnings: 0.5 });
    }
    assert.equal(cold.cost.rotations, 4);
    assert.equal(cold.cost.rotationsRead, 4, "a cold read decompresses every rotation once");
    assert.ok(cold.cost.bytesRead >= rotationBytes, `cold bytes ${cold.cost.bytesRead} cover the ${rotationBytes} rotation bytes`);

    const unchanged = read(stateDir);
    assert.deepEqual(unchanged.cost, { bytesRead: 0, rotationsRead: 0, rotations: 4 }, "an unchanged ledger reads nothing");

    const tail = `${JSON.stringify({ ts: "2026-10-16T00:00:03.000Z", step: "tick" })}\n`;
    appendFileSync(join(stateDir, "ledger.ndjson"), tail);
    const grown = read(stateDir);
    assert.equal(grown.cost.rotationsRead, 0);
    assert.ok(grown.cost.bytesRead > 0 && grown.cost.bytesRead < rotationBytes, `a grown live file reads only its tail (${grown.cost.bytesRead} bytes)`);

    const restarted = cadence.createWipeTestEvidenceReader()(stateDir);
    assert.equal(restarted.cost.rotationsRead, 0, "a new reader answers every rotation from its durable digest");
    assert.ok(restarted.cost.bytesRead > 0, "the digests and the live file it re-reads are counted as bytes read");
    assert.deepEqual(restarted.evidence, cold.evidence);

    const empty = cadence.createWipeTestEvidenceReader()(join(root, "no-state"));
    assert.equal(empty.evidence.ok, false);
    if (!empty.evidence.ok) assert.match(empty.evidence.reason, /no rotation corpus/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wipe-test cadence: an unavailable or empty learnings index skips with the evidence cost", () => {
  const root = tmp("rmd-wipe-cadence-index-");
  try {
    seedRotations(join(root, "state"), 1);
    const build = (learningsIndex: () => LearningsIndex | null) =>
      buildWipeTestCadenceDaemonHooks({ config: { root } as Config, policy: policy(SKIPPING), learningsIndex, now: () => NOW, draw: () => 0.99 });
    const unavailable = build(() => null).checkWipeTestCadence();
    assert.match(unavailable.reason, /learnings index unavailable/);
    assert.equal(unavailable.evidence?.rotations, 1);
    const empty = build(() => ({ files: {}, bySubsystem: {} })).checkWipeTestCadence();
    assert.match(empty.reason, /learnings index has no shards/);
    assert.equal(empty.evidence?.reused, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDaemon puts the wipe-test evidence cost on the cadence rows", async () => {
  const root = tmp("rmd-wipe-daemon-cost-");
  try {
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const evidence = { bytesRead: 1234, rotationsRead: 0, rotations: 377, reused: true };
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
          ? { fire: true, reason: "first run", seq: 1, subject: { id: "wt-sbx-1" }, factor: "learnings", evidence }
          : { fire: false, reason: "slot draw 0.990", evidence },
      runWipeTestCadence: async (decision) => ({ status: "measured", seq: decision.seq, subject: decision.subject, factor: decision.factor }),
    });
    const expected = { evidence_bytes_read: 1234, evidence_rotations_read: 0, evidence_rotations: 377, decision_reused: true };
    for (const step of ["wipetest.cadence.fired", "wipetest.cadence.skipped"]) {
      const row = lines.find((l) => l.step === step);
      assert.ok(row, `${step} was written`);
      for (const [field, value] of Object.entries(expected)) assert.equal(row.extra[field], value, `${step}.${field}`);
    }
    assert.deepEqual(cadence.wipeTestCadenceEvidenceFields({ fire: false, reason: "paced" }), {}, "a paced skip read no evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
