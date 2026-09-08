import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  decideRepositoryMaintenance,
  projectRepositoryMaintenanceStatus,
  runRepositoryMaintenanceCadence,
  runRepositoryMaintenanceController,
  type RepositoryMaintenanceState,
  type RepositorySurvey,
} from "../src/lib/object-reaper.js";
import { loadPolicy } from "../src/lib/policy.js";
import { buildRepositoryMaintenanceDaemonHook } from "../src/run-task.js";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const POLICY = {
  incrementalIntervalMs: 24 * 60 * 60 * 1_000,
  timeoutMs: 10 * 60 * 1_000,
  retryBaseMs: 60 * 60 * 1_000,
  retryMaxMs: 8 * 60 * 60 * 1_000,
  escalationThreshold: 3,
};

function survey(overrides: Partial<RepositorySurvey> = {}): RepositorySurvey {
  return {
    readable: true,
    looseCount: 100,
    looseBytes: 409_600,
    packCount: 2,
    gcLogPresent: false,
    activeLaneCount: 0,
    diskVerdict: "OK",
    ...overrides,
  };
}

function state(overrides: Partial<RepositoryMaintenanceState> = {}): RepositoryMaintenanceState {
  return { consecutiveFailures: 0, ...overrides };
}

function exitingProcess(code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("exit", code));
  return child;
}

test("W1-T3116: unreadable or busy repository state defers without spawning and preserves the due episode", async () => {
  const dueState = state({ nextEligibleIso: "2026-09-08T11:00:00.000Z" });
  for (const observed of [survey({ readable: false }), survey({ gcLogPresent: true, activeLaneCount: 1 })]) {
    let spawned = false;
    const result = await runRepositoryMaintenanceController(
      { repoDir: "/repo", survey: observed, state: dueState, policy: POLICY },
      { now: () => NOW, spawn: (() => { spawned = true; throw new Error("must not spawn"); }) as never },
    );
    assert.equal(result.decision.verdict, "deferred");
    assert.equal(result.state.nextEligibleIso, dueState.nextEligibleIso);
    assert.equal(spawned, false);
  }
});

test("W1-T3116: ordinary due work uses only Git's incremental maintenance tasks", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const surveys = [survey(), survey({ looseCount: 40, looseBytes: 163_840 })];
  const clock = [NOW, new Date(NOW.getTime() + 1_234)];
  let completeRow: Record<string, unknown> | undefined;
  const result = await runRepositoryMaintenanceController(
    {
      repoDir: "/repo",
      survey: surveys.shift()!,
      readPostSurvey: () => surveys.shift()!,
      state: state({ lastSuccessIso: "2026-09-07T11:59:59.000Z" }),
      policy: POLICY,
    },
    {
      now: () => clock.shift() ?? NOW,
      log: (step, fields) => {
        if (step === "repository.maintenance.complete") completeRow = fields;
      },
      spawn: ((options: { command: string; args: string[]; cwd?: string }) => {
        calls.push(options);
        return { pid: 41, process: exitingProcess(0) };
      }) as never,
    },
  );

  assert.equal(result.decision.verdict, "incremental-due");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "git");
  assert.equal(calls[0]?.cwd, "/repo");
  assert.deepEqual(calls[0]?.args, [
    "maintenance",
    "run",
    "--task=commit-graph",
    "--task=loose-objects",
    "--task=incremental-repack",
  ]);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.state.consecutiveFailures, 0);
  assert.equal(result.state.lastSuccessIso, "2026-09-08T12:00:01.234Z");
  assert.equal(completeRow?.duration_ms, 1_234, "duration uses the live completion clock, not a frozen decision time");
});

test("W1-T3116: a failed-GC marker selects full GC only at a proven quiet boundary and RMD never removes the marker", async () => {
  const calls: Array<{ args: string[] }> = [];
  const result = await runRepositoryMaintenanceController(
    {
      repoDir: "/repo",
      survey: survey({ gcLogPresent: true, gcLogDetail: "too many unreachable loose objects" }),
      readPostSurvey: () => survey({ gcLogPresent: false, looseCount: 5, looseBytes: 20_480 }),
      state: state(),
      policy: POLICY,
    },
    {
      now: () => NOW,
      spawn: ((options: { args: string[] }) => {
        calls.push(options);
        return { pid: 42, process: exitingProcess(0) };
      }) as never,
    },
  );

  assert.deepEqual(calls[0]?.args, ["maintenance", "run", "--task=gc"]);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.postSurvey?.gcLogPresent, false, "Git's post-state, not an RMD unlink, proves recovery");
});

test("W1-T3116: zero exit with a surviving marker is failure, backs off durably, then escalates without respawning", async () => {
  let spawnCount = 0;
  const failed = await runRepositoryMaintenanceController(
    {
      repoDir: "/repo",
      survey: survey({ gcLogPresent: true }),
      readPostSurvey: () => survey({ gcLogPresent: true }),
      state: state({ consecutiveFailures: 2 }),
      policy: POLICY,
    },
    {
      now: () => NOW,
      jitter: () => 0,
      spawn: (() => {
        spawnCount++;
        return { pid: 43, process: exitingProcess(0) };
      }) as never,
    },
  );

  assert.equal(failed.outcome, "failed");
  assert.equal(failed.state.consecutiveFailures, 3);
  assert.equal(failed.state.nextEligibleIso, "2026-09-08T16:00:00.000Z");

  const escalation = decideRepositoryMaintenance({
    survey: survey({ gcLogPresent: true }),
    state: failed.state,
    policy: POLICY,
    now: new Date("2026-09-08T16:00:00.000Z"),
  });
  assert.equal(escalation.verdict, "escalate");
  assert.equal(spawnCount, 1, "the threshold changes the disposition rather than starting an unbounded retry");
});

test("W1-T3116: a maintenance timeout tears down the process group and records measured failure detail", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const clock = [NOW, new Date(NOW.getTime() + 25)];
  const teardowns: number[] = [];
  let failureRow: Record<string, unknown> | undefined;
  const result = await runRepositoryMaintenanceController(
    {
      repoDir: "/repo",
      survey: survey(),
      readPostSurvey: () => survey(),
      state: state(),
      policy: { ...POLICY, timeoutMs: 5 },
    },
    {
      now: () => clock.shift() ?? NOW,
      jitter: () => 0,
      spawn: (() => ({ pid: 91, process: child })) as never,
      teardown: (pgid) => teardowns.push(pgid),
      log: (step, fields) => {
        if (step === "repository.maintenance.failed") failureRow = fields;
      },
    },
  );

  assert.equal(result.outcome, "failed");
  assert.deepEqual(teardowns, [91]);
  assert.equal(failureRow?.timed_out, true);
  assert.equal(failureRow?.duration_ms, 25);
  assert.equal(failureRow?.loose_count_before, 100);
  assert.equal(failureRow?.loose_count_after, 100);
});

test("W1-T3116: the Git child receives process location/config only, never provider credentials", async () => {
  let childEnv: Record<string, string | undefined> | undefined;
  await runRepositoryMaintenanceController(
    {
      repoDir: "/repo",
      survey: survey(),
      readPostSurvey: () => survey(),
      state: state(),
      policy: POLICY,
    },
    {
      now: () => NOW,
      env: {
        PATH: "/bin",
        HOME: "/home/rmd",
        OPENAI_API_KEY: "must-not-leak",
        ANTHROPIC_API_KEY: "must-not-leak",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "gc.auto",
        GIT_CONFIG_VALUE_0: "0",
        GIT_CONFIG_KEY_1: "maintenance.auto",
        GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "safe.directory",
        GIT_CONFIG_VALUE_2: "/repo",
      },
      spawn: ((options: { env: Record<string, string | undefined> }) => {
        childEnv = options.env;
        return { pid: 92, process: exitingProcess(0) };
      }) as never,
    },
  );

  assert.deepEqual(childEnv, {
    PATH: "/bin",
    HOME: "/home/rmd",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "gc.auto",
    GIT_CONFIG_VALUE_0: "0",
    GIT_CONFIG_KEY_1: "maintenance.auto",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "safe.directory",
    GIT_CONFIG_VALUE_2: "/repo",
  });
});

test("W1-T3116: an ineligible tick performs no command, timer, unlink, or scheduler setup", () => {
  const healthyState = state({ lastSuccessIso: "2026-09-08T11:30:00.000Z" });
  const decision = decideRepositoryMaintenance({
    survey: survey(),
    state: healthyState,
    policy: POLICY,
    now: NOW,
  });
  assert.equal(decision.verdict, "healthy");
  assert.equal(decision.nextEligibleIso, "2026-09-09T11:30:00.000Z");
});

test("W1-T3116: the durable cadence skips the object census until due, then persists the verified result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-maintenance-state-"));
  const statePath = join(dir, "repository-maintenance.json");
  let surveys = 0;
  let controllers = 0;
  let diskReads = 0;
  try {
    const deferred = await runRepositoryMaintenanceCadence(
      {
        repoDir: "/repo",
        statePath,
        activeLaneCount: 0,
        diskVerdict: () => {
          diskReads++;
          return "OK";
        },
        policy: POLICY,
      },
      {
        now: () => NOW,
        readState: () => ({
          kind: "readable",
          state: state({
            lastSuccessIso: "2026-09-08T11:30:00.000Z",
            nextEligibleIso: "2026-09-09T11:30:00.000Z",
          }),
        }),
        gcLogPresent: () => false,
        survey: () => {
          surveys++;
          return survey();
        },
        runController: async () => {
          controllers++;
          throw new Error("must not run");
        },
      },
    );
    assert.equal(deferred.kind, "not-due");
    assert.equal(surveys, 0, "the cheap state gate prevents count-objects on every idle poll");
    assert.equal(controllers, 0);
    assert.equal(diskReads, 0, "the cheap state gate also prevents an unnecessary disk-headroom read");

    const ran = await runRepositoryMaintenanceCadence(
      {
        repoDir: "/repo",
        statePath,
        activeLaneCount: 0,
        diskVerdict: () => {
          diskReads++;
          return "OK";
        },
        policy: POLICY,
      },
      {
        now: () => NOW,
        readState: () => ({ kind: "absent", state: state() }),
        gcLogPresent: () => false,
        survey: () => {
          surveys++;
          return survey();
        },
        runController: async (input) => {
          controllers++;
          assert.equal(input.readPostSurvey?.().readable, true);
          return {
            decision: { verdict: "incremental-due", reason: "no prior success recorded" },
            state: state({
              lastAttemptIso: NOW.toISOString(),
              lastSuccessIso: NOW.toISOString(),
              nextEligibleIso: "2026-09-09T12:00:00.000Z",
            }),
            outcome: "succeeded",
            postSurvey: survey({ looseCount: 40 }),
            exitCode: 0,
          };
        },
      },
    );
    assert.equal(ran.kind, "ran");
    assert.equal(surveys, 2, "one pre-survey plus the controller's one post-survey");
    assert.equal(controllers, 1);
    assert.equal(diskReads, 1, "one due episode shares one disk observation across both surveys");
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), ran.result.state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3116: corrupt durable state fails closed before any survey or maintenance child", async () => {
  let surveyed = false;
  const rows: string[] = [];
  const result = await runRepositoryMaintenanceCadence(
    {
      repoDir: "/repo",
      statePath: "/state/repository-maintenance.json",
      activeLaneCount: 0,
      diskVerdict: "OK",
      policy: POLICY,
    },
    {
      now: () => NOW,
      readState: () => ({ kind: "corrupt", reason: "bad json" }),
      survey: () => {
        surveyed = true;
        return survey();
      },
      log: (step) => rows.push(step),
    },
  );
  assert.equal(result.kind, "deferred");
  assert.equal(surveyed, false);
  assert.deepEqual(rows, ["repository.maintenance.deferred"]);
});

test("W1-T3116: a failed-GC marker waiting on active lanes performs no census, disk read or state write", async () => {
  let surveys = 0;
  let diskReads = 0;
  let writes = 0;
  const result = await runRepositoryMaintenanceCadence(
    {
      repoDir: "/repo",
      statePath: "/state/repository-maintenance.json",
      activeLaneCount: 2,
      diskVerdict: () => {
        diskReads++;
        return "OK";
      },
      policy: POLICY,
    },
    {
      now: () => NOW,
      readState: () => ({ kind: "readable", state: state() }),
      gcLogPresent: () => true,
      survey: () => {
        surveys++;
        return survey();
      },
      writeState: () => {
        writes++;
      },
    },
  );

  assert.deepEqual(result, { kind: "deferred", reason: "full GC requires zero active RMD lanes" });
  assert.equal(surveys, 0);
  assert.equal(diskReads, 0);
  assert.equal(writes, 0);
});

test("W1-T3116: daemon scheduling is non-blocking and single-flight across idle ticks", async () => {
  let release!: () => void;
  let calls = 0;
  const firstRun = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hook = buildRepositoryMaintenanceDaemonHook({
    repoDir: "/repo",
    stateDir: "/state",
    diskVerdict: "OK",
    policy: POLICY,
    log: () => {},
    run: (async () => {
      calls++;
      await firstRun;
      return { kind: "deferred", reason: "fixture" };
    }) as never,
  });

  await hook(0);
  await hook(0);
  assert.equal(calls, 1, "the daemon call returns without waiting and a later idle tick does not duplicate it");

  release();
  await new Promise((resolve) => setImmediate(resolve));
  await hook(0);
  assert.equal(calls, 2, "the single-flight guard releases after the background controller settles");
});

test("W1-T3116: the status projection names success, failure/backoff and escalation without SSH", () => {
  assert.deepEqual(
    projectRepositoryMaintenanceStatus(
      state({
        lastAttemptIso: "2026-09-08T11:00:00.000Z",
        lastSuccessIso: "2026-09-08T11:00:00.000Z",
        nextEligibleIso: "2026-09-09T11:00:00.000Z",
      }),
      POLICY,
      NOW,
    ),
    {
      verdict: "healthy",
      lastAttemptIso: "2026-09-08T11:00:00.000Z",
      lastSuccessIso: "2026-09-08T11:00:00.000Z",
      nextEligibleIso: "2026-09-09T11:00:00.000Z",
      consecutiveFailures: 0,
      retryPending: false,
    },
  );
  assert.equal(
    projectRepositoryMaintenanceStatus(
      state({ consecutiveFailures: 2, nextEligibleIso: "2026-09-08T16:00:00.000Z" }),
      POLICY,
      NOW,
    ).verdict,
    "backoff",
  );
  assert.equal(
    projectRepositoryMaintenanceStatus(state({ consecutiveFailures: 3 }), POLICY, NOW).verdict,
    "escalate",
  );
});

test("W1-T3116: production has one idle cadence call and no task-admission maintenance rung", () => {
  const runTaskSource = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const daemonSource = readFileSync(new URL("../src/lib/daemon.ts", import.meta.url), "utf8");
  const statusBoardSource = readFileSync(new URL("../src/lib/status-board.ts", import.meta.url), "utf8");
  const entrypointSource = readFileSync(new URL("../deploy/entrypoint.sh", import.meta.url), "utf8");
  const bodyStart = runTaskSource.indexOf("async function runTaskBody");
  const firstWorktreeAdd = runTaskSource.indexOf("worktreeAdd(", bodyStart);
  const admissionBody = runTaskSource.slice(bodyStart, firstWorktreeAdd);
  assert.doesNotMatch(admissionBody, /logDiskReclaimRung\(config, log\)/);
  assert.doesNotMatch(admissionBody, /runRepositoryMaintenanceRung\(/);

  const hookCallSites = [...runTaskSource.matchAll(/(?<!function )buildRepositoryMaintenanceDaemonHook\(/g)];
  assert.equal(hookCallSites.length, 1, "one production composition call, not boot + dispatch + cadence copies");
  assert.match(runTaskSource, /input\.run \?\? runRepositoryMaintenanceRung/);
  assert.match(daemonSource, /if \(dispatchSet\.length === 0\)[\s\S]*deps\.runRepositoryMaintenance/);
  assert.match(
    daemonSource,
    /const activeLaneCount = Math\.max\([\s\S]{0,180}activeWorkerCount\(\)/,
    "the heavy-GC gate must include the whole-process build-and-review worker counter",
  );
  assert.match(daemonSource, /phase: "dispatch" \| "retro" \| "sweep"/);
  assert.doesNotMatch(daemonSource, /startInFlightTicker\([\s\S]{0,200}"maintenance"/);
  assert.match(statusBoardSource, /repositoryMaintenance: deriveRepositoryMaintenanceSection/);
  assert.match(statusBoardSource, /renderRepositoryMaintenanceBlock\(model\.repositoryMaintenance\)/);
  assert.doesNotMatch(
    entrypointSource,
    /rm -f \$TREE\/\.git\/gc\.log && git -C \$TREE gc --prune=now/,
    "boot must not hand routine recovery back to an SSH operator",
  );
  assert.match(
    entrypointSource,
    /daemon repository-maintenance controller owns recovery/,
    "boot should point to the autonomous owner and console evidence",
  );
});

test("W1-T3116: cadence, timeout, retry and escalation bounds are committed policy data", () => {
  const policy = loadPolicy(new URL("../plan/policy.yaml", import.meta.url).pathname).values.repositoryMaintenance;
  assert.deepEqual(policy, POLICY);
});
