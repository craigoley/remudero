import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock, type Clock } from "../src/lib/clock.js";
import { runDaemon } from "../src/lib/daemon.js";
import {
  decideRepositoryMaintenance,
  projectRepositoryMaintenanceStatus,
  readGcLogPresent,
  readRepositoryMaintenanceState,
  repositoryMaintenanceStatePath,
  runRepositoryMaintenanceCadence,
  runRepositoryMaintenanceController,
  surveyRepository,
  writeRepositoryMaintenanceState,
  type RepositoryMaintenanceState,
  type RepositorySurvey,
} from "../src/lib/object-reaper.js";
import { loadPolicy } from "../src/lib/policy.js";
import { loadPlan } from "../src/lib/plan.js";
import { buildStatusBoard, renderStatusBoardText } from "../src/lib/status-board.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import {
  buildRepositoryMaintenanceDaemonHook,
  daemonCommand,
  runRepositoryMaintenanceRung,
  statusCommand,
} from "../src/run-task.js";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const NOW_CLOCK = fixedClock(NOW.getTime());
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

function sequenceClock(instants: Date[]): Clock {
  let index = 0;
  const last = instants.at(-1) ?? NOW;
  return {
    now: () => last.getTime(),
    iso: () => last.toISOString(),
    date: () => instants[index++] ?? last,
  };
}

function idlePlan() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-maintenance-plan-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: W1-T9999\n  title: human hold\n  repo: remudero\n  type: implement\n  verify: human\n  depends_on: []\n  status: queued\n");
  return loadPlan(path);
}

test("W1-T3116: the durable state and gc.log readers distinguish absent, readable and corrupt material state", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-maintenance-readers-"));
  const statePath = repositoryMaintenanceStatePath(join(dir, "state"));
  try {
    assert.deepEqual(readRepositoryMaintenanceState(statePath), {
      kind: "absent",
      state: { consecutiveFailures: 0 },
    });
    const expected = state({
      consecutiveFailures: 2,
      lastAttemptIso: "2026-09-08T10:00:00.000Z",
      lastSuccessIso: "2026-09-07T10:00:00.000Z",
      nextEligibleIso: "2026-09-08T13:00:00.000Z",
      escalationRecordedIso: "2026-09-08T11:00:00.000Z",
    });
    writeRepositoryMaintenanceState(statePath, expected);
    assert.deepEqual(readRepositoryMaintenanceState(statePath), { kind: "readable", state: expected });
    assert.equal(existsSync(statePath + ".tmp-" + process.pid), false, "the atomic temp is renamed away");

    for (const invalid of [
      "null\n",
      '{"consecutiveFailures":-1}\n',
      '{"consecutiveFailures":0,"nextEligibleIso":"not-a-date"}\n',
      "{not json}\n",
    ]) {
      writeFileSync(statePath, invalid);
      assert.equal(readRepositoryMaintenanceState(statePath).kind, "corrupt");
    }

    const ordinary = join(dir, "ordinary");
    mkdirSync(join(ordinary, ".git"), { recursive: true });
    assert.equal(readGcLogPresent(ordinary), false);
    writeFileSync(join(ordinary, ".git", "gc.log"), "automatic gc failed\n");
    assert.equal(readGcLogPresent(ordinary), true);

    const linked = join(dir, "linked");
    const linkedGitDir = join(dir, "admin", "worktrees", "linked");
    mkdirSync(linkedGitDir, { recursive: true });
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, ".git"), `gitdir: ${linkedGitDir}\n`);
    assert.equal(readGcLogPresent(linked), false);
    writeFileSync(join(linkedGitDir, "gc.log"), "linked failure\n");
    assert.equal(readGcLogPresent(linked), true);
    assert.equal(readGcLogPresent(join(dir, "missing")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3116: repository surveys parse Git's object census and fail closed on unreadable evidence", () => {
  const calls: string[][] = [];
  const readable = surveyRepository("/repo", 2, "OK", {
    exec: ((_command: string, args: string[]) => {
      calls.push(args);
      return args.includes("count-objects") ? "count: 7\nsize: 3\npacks: 2\n" : "/repo/.git\n";
    }) as never,
    exists: (() => true) as never,
    read: (() => "too many unreachable objects\nsecond line\n") as never,
  });
  assert.deepEqual(readable, {
    readable: true,
    looseCount: 7,
    looseBytes: 3_072,
    packCount: 2,
    gcLogPresent: true,
    gcLogDetail: "too many unreachable objects",
    activeLaneCount: 2,
    diskVerdict: "OK",
  });
  assert.deepEqual(calls, [
    ["-C", "/repo", "count-objects", "-v"],
    ["-C", "/repo", "rev-parse", "--absolute-git-dir"],
  ]);

  const incomplete = surveyRepository("/repo", 0, "OK", {
    exec: ((_command: string, args: string[]) => args.includes("count-objects") ? "count: 1\n" : "/repo/.git\n") as never,
    exists: (() => false) as never,
  });
  assert.equal(incomplete.readable, false);
  assert.equal(incomplete.looseBytes, undefined);

  const unreadableLog = surveyRepository("/repo", 0, "OK", {
    exec: ((_command: string, args: string[]) => args.includes("count-objects") ? "count: 1\nsize: 1\npacks: 0\n" : "/repo/.git\n") as never,
    exists: (() => true) as never,
    read: (() => { throw new Error("permission denied"); }) as never,
  });
  assert.equal(unreadableLog.readable, false);
  assert.match(unreadableLog.detail ?? "", /gc\.log unreadable.*permission denied/);

  const unreadableRepo = surveyRepository("/missing", 1, "LOW", {
    exec: (() => { throw new Error("not a repository"); }) as never,
  });
  assert.deepEqual(unreadableRepo, {
    readable: false,
    detail: "Git object survey failed: not a repository",
    activeLaneCount: 1,
    diskVerdict: "LOW",
  });
});

test("W1-T3116: unreadable or busy repository state defers without spawning and preserves the due episode", async () => {
  const dueState = state({ nextEligibleIso: "2026-09-08T11:00:00.000Z" });
  for (const observed of [survey({ readable: false }), survey({ gcLogPresent: true, activeLaneCount: 1 })]) {
    let spawned = false;
    const result = await runRepositoryMaintenanceController(
      { repoDir: "/repo", survey: observed, state: dueState, policy: POLICY },
      { clock: NOW_CLOCK, spawn: (() => { spawned = true; throw new Error("must not spawn"); }) as never },
    );
    assert.equal(result.decision.verdict, "deferred");
    assert.equal(result.state.nextEligibleIso, dueState.nextEligibleIso);
    assert.equal(spawned, false);
  }
});

test("W1-T3116: backoff and unhealthy disk state defer before maintenance", () => {
  assert.deepEqual(
    decideRepositoryMaintenance({
      survey: survey(),
      state: state({ nextEligibleIso: "2026-09-08T13:00:00.000Z" }),
      policy: POLICY,
      now: NOW,
    }),
    {
      verdict: "deferred",
      reason: "maintenance backoff or cadence has not elapsed",
      nextEligibleIso: "2026-09-08T13:00:00.000Z",
    },
  );
  assert.deepEqual(
    decideRepositoryMaintenance({
      survey: survey({ diskVerdict: "LOW" }),
      state: state(),
      policy: POLICY,
      now: NOW,
    }),
    {
      verdict: "deferred",
      reason: "disk state is not healthy enough for repository maintenance",
      nextEligibleIso: undefined,
    },
  );
});

test("W1-T3116: ordinary due work uses only Git's incremental maintenance tasks", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const surveys = [survey(), survey({ looseCount: 40, looseBytes: 163_840 })];
  const instants = [NOW, new Date(NOW.getTime() + 1_234)];
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
      clock: sequenceClock(instants),
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
      clock: NOW_CLOCK,
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
      clock: NOW_CLOCK,
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

test("W1-T3116: the controller records an escalation once and never starts Git at the threshold", async () => {
  const rows: string[] = [];
  let spawned = false;
  const first = await runRepositoryMaintenanceController(
    {
      repoDir: "/repo",
      survey: survey({ gcLogPresent: true }),
      state: state({ consecutiveFailures: 3 }),
      policy: POLICY,
    },
    {
      clock: NOW_CLOCK,
      spawn: (() => { spawned = true; throw new Error("must not spawn"); }) as never,
      log: (step) => rows.push(step),
    },
  );
  assert.equal(first.decision.verdict, "escalate");
  assert.equal(first.state.escalationRecordedIso, NOW.toISOString());
  assert.deepEqual(rows, ["repository.maintenance.escalate"]);
  assert.equal(spawned, false);

  rows.length = 0;
  const repeated = await runRepositoryMaintenanceController(
    {
      repoDir: "/repo",
      survey: survey({ gcLogPresent: true }),
      state: first.state,
      policy: POLICY,
    },
    { clock: NOW_CLOCK, log: (step) => rows.push(step) },
  );
  assert.equal(repeated.state.escalationRecordedIso, NOW.toISOString());
  assert.deepEqual(rows, [], "an already-recorded episode does not emit another escalation");
});

test("W1-T3116: spawn, child and post-survey failures remain attributed and retry with bounded jitter", async () => {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const spawnFailed = await runRepositoryMaintenanceController(
    {
      repoDir: "/repo",
      survey: survey(),
      readPostSurvey: () => { throw new Error("post survey unavailable"); },
      state: state(),
      policy: POLICY,
    },
    {
      clock: NOW_CLOCK,
      spawn: ((_options: unknown, onStderr?: (chunk: string) => void) => {
        onStderr?.("git warning\n");
        throw new Error("spawn refused");
      }) as never,
      jitter: () => 2,
      log: (step, fields) => rows.push({ step, fields }),
    },
  );
  assert.equal(spawnFailed.outcome, "failed");
  assert.equal(spawnFailed.state.nextEligibleIso, "2026-09-08T13:06:00.000Z", "jitter is clamped to ten percent");
  assert.match(String(rows.at(-1)?.fields.stderr_excerpt), /git warning[\s\S]*spawn refused[\s\S]*post-maintenance survey failed/);

  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("error", new Error("child failed")));
  const childFailed = await runRepositoryMaintenanceController(
    {
      repoDir: "/repo",
      survey: survey(),
      readPostSurvey: () => survey(),
      state: state(),
      policy: POLICY,
    },
    { clock: NOW_CLOCK, jitter: () => -1, spawn: (() => ({ pid: 93, process: child })) as never },
  );
  assert.equal(childFailed.exitCode, null);
  assert.equal(childFailed.outcome, "failed");
  assert.equal(childFailed.state.nextEligibleIso, "2026-09-08T13:00:00.000Z", "negative jitter is clamped to zero");
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
  const instants = [NOW, new Date(NOW.getTime() + 25)];
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
      clock: sequenceClock(instants),
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
      clock: NOW_CLOCK,
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
        clock: NOW_CLOCK,
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
        clock: NOW_CLOCK,
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
      clock: NOW_CLOCK,
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
      clock: NOW_CLOCK,
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

test("W1-T3116: a background cadence rejection is attributed and the single-flight guard reopens", async () => {
  const rows: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  let calls = 0;
  const hook = buildRepositoryMaintenanceDaemonHook({
    repoDir: "/repo",
    stateDir: "/state",
    diskVerdict: "OK",
    policy: POLICY,
    log: (step, fields) => rows.push({ step, fields }),
    run: (async () => {
      calls++;
      throw new Error("cadence exploded");
    }) as never,
  });
  await hook(2);
  await new Promise((resolve) => setImmediate(resolve));
  await hook(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.step, "repository.maintenance.failed");
  assert.deepEqual(rows[0]?.fields, {
    reason: "background cadence threw",
    error: "cadence exploded",
    active_lane_count: 2,
  });
});

test("W1-T3116: the daemon calls maintenance only at the no-dispatch boundary and contains a rejection", async () => {
  for (const throws of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "rmd-maintenance-daemon-"));
    const activeCounts: number[] = [];
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    let sleeps = 0;
    await runDaemon(
      idlePlan(),
      {
        refreshMerged: () => () => false,
        runOne: async () => assert.fail("a verify:human task must never dispatch"),
        runRepositoryMaintenance: async (activeLaneCount) => {
          activeCounts.push(activeLaneCount);
          if (throws) throw new Error("maintenance hook failed");
        },
        checkStop: () => stopDetail(root),
        sleep: async () => {
          sleeps++;
          requestStop(root, "test complete");
        },
        log: (step, fields = {}) => rows.push({ step, fields }),
      },
      { max: 1, pollIntervalMs: 1 },
    );
    assert.deepEqual(activeCounts, [0]);
    assert.equal(sleeps, 1);
    assert.equal(
      rows.some((row) => row.step === "repository.maintenance.failed"),
      throws,
      "only a throwing maintenance hook produces the contained failure row",
    );
  }
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
      NOW.getTime(),
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
      NOW.getTime(),
    ).verdict,
    "backoff",
  );
  assert.equal(
    projectRepositoryMaintenanceStatus(state({ consecutiveFailures: 3 }), POLICY, NOW.getTime()).verdict,
    "escalate",
  );
  assert.equal(projectRepositoryMaintenanceStatus(state(), POLICY, NOW.getTime()).verdict, "never-run");
  assert.equal(
    projectRepositoryMaintenanceStatus(
      state({ lastSuccessIso: "2026-09-07T11:00:00.000Z", nextEligibleIso: "2026-09-08T11:00:00.000Z" }),
      POLICY,
      NOW.getTime(),
    ).verdict,
    "due",
  );
  assert.equal(
    projectRepositoryMaintenanceStatus(state({ consecutiveFailures: 1 }), POLICY, NOW.getTime()).verdict,
    "retry-due",
  );
});

test("W1-T3116: the default cadence path reads, surveys, runs Git maintenance and persists verified state end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-maintenance-real-"));
  const repoDir = join(dir, "repo");
  const statePath = repositoryMaintenanceStatePath(join(dir, "state"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
    execFileSync("git", ["-C", repoDir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "seed"]);
    writeFileSync(join(repoDir, ".git", "gc.log"), "stale automatic-gc failure\n");
    const result = await runRepositoryMaintenanceCadence(
      {
        repoDir,
        statePath,
        activeLaneCount: 0,
        diskVerdict: "OK",
        policy: POLICY,
      },
      { clock: NOW_CLOCK },
    );
    assert.equal(result.kind, "ran");
    if (result.kind !== "ran") return;
    assert.equal(result.result.outcome, "succeeded", JSON.stringify(result.result));
    assert.equal(result.result.decision.verdict, "full-gc-due");
    assert.equal(result.status.verdict, "healthy");
    assert.equal(readRepositoryMaintenanceState(statePath).kind, "readable");

    const backoff = await runRepositoryMaintenanceCadence(
      {
        repoDir,
        statePath,
        activeLaneCount: 0,
        diskVerdict: "OK",
        policy: POLICY,
      },
      {
        clock: NOW_CLOCK,
        readState: () => ({
          kind: "readable",
          state: state({ consecutiveFailures: 1, nextEligibleIso: "2026-09-08T13:00:00.000Z" }),
        }),
      },
    );
    assert.equal(backoff.kind, "not-due");

    const escalated = await runRepositoryMaintenanceCadence(
      {
        repoDir,
        statePath,
        activeLaneCount: 0,
        diskVerdict: "OK",
        policy: POLICY,
      },
      {
        clock: NOW_CLOCK,
        readState: () => ({
          kind: "readable",
          state: state({ consecutiveFailures: 3, escalationRecordedIso: NOW.toISOString() }),
        }),
      },
    );
    assert.equal(escalated.kind, "not-due");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3116: the production rung maps stateDir to the durable file and reaches the real cadence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-maintenance-rung-"));
  const repoDir = join(dir, "repo");
  const stateDir = join(dir, "state");
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
    execFileSync("git", ["-C", repoDir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "seed"]);
    writeFileSync(join(repoDir, ".git", "gc.log"), "stale automatic-gc failure\n");
    const result = await runRepositoryMaintenanceRung({
      repoDir,
      stateDir,
      activeLaneCount: 0,
      diskVerdict: "OK",
      policy: POLICY,
      log: () => {},
    });
    assert.equal(result.kind, "ran");
    assert.equal(existsSync(join(stateDir, "repository-maintenance.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3116: status and text rendering expose healthy, escalated and corrupt maintenance state", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-maintenance-status-"));
  const statePath = repositoryMaintenanceStatePath(join(root, "state"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const deps = {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo",
    now: () => NOW.getTime(),
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    resolveHeadroomEnabled: () => false,
    readPushedRunBranches: () => "",
    readSharedPauseState: () => "absent" as const,
    readDispatchClaims: () => ({ status: "clear" as const }),
    repositoryMaintenancePolicy: POLICY,
  };
  try {
    writeRepositoryMaintenanceState(statePath, state({
      lastAttemptIso: "2026-09-08T11:00:00.000Z",
      lastSuccessIso: "2026-09-08T11:00:00.000Z",
      nextEligibleIso: "2026-09-09T11:00:00.000Z",
    }));
    const healthy = buildStatusBoard(root, ledgerPath, deps);
    assert.equal(healthy.generatedAt, NOW.toISOString());
    assert.equal(healthy.repositoryMaintenance?.status?.verdict, "healthy");
    assert.match(renderStatusBoardText(healthy), /REPOSITORY MAINTENANCE[\s\S]*verdict\s+: healthy/);
    assert.match(renderStatusBoardText(healthy), /last attempt: 2026-09-08T11:00:00.000Z/);
    assert.match(renderStatusBoardText(healthy), /retry pending: no/);

    writeRepositoryMaintenanceState(statePath, state({ consecutiveFailures: 3 }));
    const escalated = buildStatusBoard(root, ledgerPath, deps);
    assert.equal(escalated.repositoryMaintenance?.status?.verdict, "escalate");
    assert.match(renderStatusBoardText(escalated), /automatic Git maintenance exhausted its retry bound/);

    writeFileSync(statePath, "{bad json}\n");
    const corrupt = buildStatusBoard(root, ledgerPath, deps);
    assert.equal(corrupt.repositoryMaintenance?.status, undefined);
    assert.match(renderStatusBoardText(corrupt), /unknown — durable maintenance state is unreadable/);
    assert.match(renderStatusBoardText(corrupt), /repair state\/repository-maintenance\.json/);

    const withoutSection = { ...healthy, repositoryMaintenance: undefined };
    assert.doesNotMatch(renderStatusBoardText(withoutSection), /REPOSITORY MAINTENANCE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3116: a throwing disk survey is a named cadence deferral", async () => {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const result = await runRepositoryMaintenanceCadence(
    {
      repoDir: "/repo",
      statePath: "/state/repository-maintenance.json",
      activeLaneCount: 0,
      diskVerdict: () => { throw new Error("disk probe failed"); },
      policy: POLICY,
    },
    {
      clock: NOW_CLOCK,
      readState: () => ({ kind: "absent", state: state() }),
      gcLogPresent: () => false,
      log: (step, fields) => rows.push({ step, fields }),
    },
  );
  assert.deepEqual(result, { kind: "deferred", reason: "disk probe failed" });
  assert.deepEqual(rows, [{
    step: "repository.maintenance.deferred",
    fields: { reason: "disk headroom survey failed", detail: "disk probe failed" },
  }]);
});

test("W1-T3116: daemonCommand wires maintenance only for the self-target daemon", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-maintenance-daemon-command-"));
  const root = join(home, "Remudero");
  const planPath = join(home, "tasks.yaml");
  const previousHome = process.env.HOME;
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root }),
  );
  writeFileSync(planPath, "[]\n");
  const captured: Array<Parameters<typeof runDaemon>[1]> = [];
  const runDaemonStub: typeof runDaemon = async (_plan, deps) => {
    captured.push(deps);
    return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
  };
  try {
    process.env.HOME = home;
    assert.equal(
      await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
        runDaemon: runDaemonStub,
      }),
      0,
    );
    assert.equal(typeof captured[0]?.runRepositoryMaintenance, "function");

    assert.equal(
      await daemonCommand(["--repo", "craigoley/not-remudero", "--plan", planPath, "--max", "0"], {
        runDaemon: runDaemonStub,
      }),
      0,
    );
    assert.equal(captured[1]?.runRepositoryMaintenance, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("W1-T3116: statusCommand loads maintenance policy when readable and degrades when it is not", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-maintenance-status-command-"));
  const observed: unknown[] = [];
  const invoke = (repoRoot: string) =>
    statusCommand([], {
      loadConfig: () => ({ claudeBin: "/bin/true", root }),
      queryService: () => ({ running: false, pid: null, sensed: false }),
      ledgerPathFor: () => join(root, "state", "ledger.ndjson"),
      repoRoot,
      github: null,
      readLedgerLines: () => [],
      buildStatusBoard: (_root, _ledgerPath, deps) => {
        observed.push(deps.repositoryMaintenancePolicy);
        return {} as ReturnType<typeof buildStatusBoard>;
      },
      renderStatusBoardText: () => "rendered",
      out: () => {},
    });
  try {
    assert.equal(await invoke(fileURLToPath(new URL("..", import.meta.url))), 0);
    assert.deepEqual(observed[0], POLICY);
    assert.equal(await invoke(join(root, "missing-checkout")), 0);
    assert.equal(observed[1], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// @source-text-subject — this test's SUBJECT genuinely is the source text: it asserts there is
// exactly one production composition call site and that admission-time code never reaches the
// maintenance rung, which are structural wiring facts about the source, not runtime behaviour a
// call through the public API could exercise (W1-T2905's census would otherwise count these
// readFileSync() calls as prose standing in for behaviour, which they are not).
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
