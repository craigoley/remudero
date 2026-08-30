// W1-T2441: the per-spawn worker-home reap (`reapWorkerHome`, worker-home.ts) already computes
// a `WorkerHomeReapResult` naming WHICH target it removed (or didn't) and WHY, on every arm —
// but `src/lib/worker.ts:1178` called it in statement position and discarded the return value
// (`grep -acE "=\s*reapWorkerHome\(" src/lib/worker.ts` read 0 before this task). This suite
// proves the result is no longer thrown away: the target/reason/spawn-identity are all
// observable, and the reap stays best-effort and never throws on any arm. Per this task's own
// "do not ship the remedy" constraint, the home was STILL keyed on the run alone (not the
// spawn) when this suite was filed — W1-T2463 has since shipped that remedy at the spawnWorker
// call site (worker.ts:1009), so the e2e tests below observe a per-spawn-token-bearing target
// rather than the bare `worker-home-<runId>` literal; see test/worker-home-per-spawn.test.ts.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { perRunWorkerHomeDir, reapWorkerHome, type WorkerHomeReapResult } from "../src/lib/worker-home.js";
import {
  CLAUDE_BIN_ENV_OVERRIDE,
  createClaudeExecutableCache,
  spawnWorker,
  workerHomeReapLogFields,
} from "../src/lib/worker.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-workerhome-reap-visibility-"));
}

// ── Claim 1 + 2: the reap result is no longer discarded — target and reason ──
// are both observable, for every arm `reapWorkerHome` can return.

test("workerHomeReapLogFields: a REAPED result surfaces reaped=true, its target, and the spawn identity", () => {
  const root = join(tmp(), "worker-home");
  const home = perRunWorkerHomeDir(root, "run-observed");
  mkdirSync(home, { recursive: true });
  try {
    const result = reapWorkerHome(root, home);
    assert.equal(result.reaped, true, "sanity: the reap itself succeeded");

    const fields = workerHomeReapLogFields(result, { runId: "run-observed", taskId: "task-1" });
    assert.equal(fields.reaped, true);
    assert.equal(fields.target, home, "the REMOVED TARGET must be observable, verbatim");
    assert.equal(fields.run_id, "run-observed", "the spawn identity (runId) must be observable");
    assert.equal(fields.task_id, "task-1", "the spawn identity (taskId) must be observable");
  } finally {
    // already removed by the reap under test; nothing to clean up
  }
});

test("workerHomeReapLogFields: a guard-rejected result surfaces its target and the REASON it was rejected", () => {
  const root = join(tmp(), "worker-home");
  const result = reapWorkerHome(root, root); // attempting to reap the singleton root itself
  assert.equal(result.reaped, false);

  const fields = workerHomeReapLogFields(result, { runId: "run-x" });
  assert.equal(fields.reaped, false);
  assert.equal(fields.target, root);
  assert.equal(fields.reason, "guard-rejected", "WHY the reap did nothing must be observable, not just THAT it did nothing");
});

test("workerHomeReapLogFields: an already-absent target surfaces reason 'absent'", () => {
  const root = join(tmp(), "worker-home");
  const home = perRunWorkerHomeDir(root, "never-materialized");
  const result = reapWorkerHome(root, home);
  const fields = workerHomeReapLogFields(result, { runId: "never-materialized" });
  assert.equal(fields.reaped, false);
  assert.equal(fields.target, home);
  assert.equal(fields.reason, "absent");
});

test("workerHomeReapLogFields: a caught rmSync error surfaces its own message as the reason, not a generic label", () => {
  const root = join(tmp(), "worker-home");
  const home = perRunWorkerHomeDir(root, "run-rm-fails");
  mkdirSync(home, { recursive: true });
  try {
    const result: WorkerHomeReapResult = reapWorkerHome(root, home, {
      fsImpl: {
        existsSync: () => true,
        rmSync: () => {
          throw new Error("simulated EBUSY");
        },
      },
    });
    const fields = workerHomeReapLogFields(result, { runId: "run-rm-fails" });
    assert.equal(fields.reaped, false);
    assert.match(String(fields.reason), /simulated EBUSY/, "the thrown error's own message must surface, not a guess");
  } finally {
    reapWorkerHome(root, home);
  }
});

// ── Claim 3: the reap remains best-effort and still never throws on any arm ──
// — proved both at the pure-helper level (formatting never throws on odd input)
// and end-to-end (a caller-supplied logHomeReap that itself throws never breaks
// spawnWorker's teardown).

test("workerHomeReapLogFields: formatting a result with no target/reason (e.g. a hand-built fixture) never throws", () => {
  assert.doesNotThrow(() => {
    const fields = workerHomeReapLogFields({ reaped: false }, {});
    assert.equal(fields.target, undefined);
    assert.equal(fields.reason, undefined);
    assert.equal(fields.run_id, undefined);
    assert.equal(fields.task_id, undefined);
  });
});

function e2eSpawnWorkerArgs(dir: string, runId: string, extra: Record<string, unknown> = {}) {
  const settingsFile = join(dir, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  return {
    cwd: dir,
    permissionMode: "bypassPermissions" as const,
    settingsFile,
    prompt: "W1-T2441 worker-home reap visibility fixture",
    runId,
    config: { claudeBin: "/unused", root: dir },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: dir, exists: () => true, canExecute: () => true, locations: [] },
    },
    keychain: {
      platform: "linux" as NodeJS.Platform,
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }),
    },
    ...extra,
  };
}

function fakeQueryFn(behavior: "success" | "error") {
  return ((params: { prompt: string; options: { spawnClaudeCodeProcess?: (o: unknown) => unknown } }) => {
    params.options.spawnClaudeCodeProcess?.({
      command: "/bin/sh",
      args: ["-c", "true"],
      env: {},
      signal: new AbortController().signal,
    });
    if (behavior === "error") {
      return (async function* () {
        throw new Error("simulated transport failure — no result envelope ever seen");
      })();
    }
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "s-1",
        total_cost_usd: 0.01,
        num_turns: 1,
      };
    })();
  }) as unknown as Parameters<typeof spawnWorker>[0]["queryFn"];
}

function fakeContainment(pid: number) {
  return {
    spawn: () => ({
      process: { stdin: {}, stdout: {}, kill: () => true, killed: false, exitCode: null, on() {}, once() {}, off() {} } as never,
      pid,
    }),
    teardown: () => {},
  };
}

test("spawnWorker (end-to-end, SUCCESS path): logHomeReap observes reaped=true with the real target and spawn identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-home-reap-e2e-success-"));
  // W1-T2463: spawnWorker now opts INTO a per-spawn uniqueness token appended after the
  // runId (`worker-home-<runId>.<token>`, worker.ts:1009/worker-home.ts's `perSpawn`), so the
  // literal target is no longer predictable ahead of time — only its runId-keyed PREFIX is.
  const expectedHomePrefix = join(dir, "worker-home-reap-vis-success");
  const observed: Array<{ result: WorkerHomeReapResult; spawn: { runId?: string; taskId?: string } }> = [];
  await spawnWorker({
    ...e2eSpawnWorkerArgs(dir, "reap-vis-success", { taskId: "T-success" }),
    queryFn: fakeQueryFn("success"),
    containment: fakeContainment(999996),
    logHomeReap: (result, spawn) => observed.push({ result, spawn }),
  } as Parameters<typeof spawnWorker>[0]);

  assert.equal(observed.length, 1, "logHomeReap must be called exactly once, on the success exit path");
  assert.equal(observed[0].result.reaped, true);
  const observedTarget = observed[0].result.target;
  assert.ok(observedTarget, "a reaped:true result must always name its target");
  assert.ok(
    observedTarget.startsWith(`${expectedHomePrefix}.`),
    "the observed target keeps runId as its durable prefix, with a W1-T2463 per-spawn token appended after it",
  );
  assert.equal(existsSync(observedTarget), false, "sanity: the SAME target the reap actually removed is really gone");
  assert.equal(observed[0].spawn.runId, "reap-vis-success");
  assert.equal(observed[0].spawn.taskId, "T-success");
});

test("spawnWorker (end-to-end, ERROR path): logHomeReap STILL observes the reap when the SDK stream throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-home-reap-e2e-error-"));
  const expectedHomePrefix = join(dir, "worker-home-reap-vis-error"); // see W1-T2463 note above
  const observed: Array<{ result: WorkerHomeReapResult; spawn: { runId?: string; taskId?: string } }> = [];
  await assert.rejects(
    () =>
      spawnWorker({
        ...e2eSpawnWorkerArgs(dir, "reap-vis-error"),
        queryFn: fakeQueryFn("error"),
        containment: fakeContainment(999995),
        logHomeReap: (result, spawn) => observed.push({ result, spawn }),
      } as Parameters<typeof spawnWorker>[0]),
    /simulated transport failure/,
  );
  assert.equal(observed.length, 1, "logHomeReap must fire on the thrown-error exit path too — the reap itself always runs there");
  assert.equal(observed[0].result.reaped, true);
  const observedTarget = observed[0].result.target;
  assert.ok(observedTarget, "a reaped:true result must always name its target");
  assert.ok(observedTarget.startsWith(`${expectedHomePrefix}.`));
  assert.equal(existsSync(observedTarget), false);
});

test("spawnWorker (end-to-end): a logHomeReap that itself THROWS never breaks the surrounding teardown — best-effort, never surfaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-home-reap-e2e-logger-throws-"));
  await assert.doesNotReject(() =>
    spawnWorker({
      ...e2eSpawnWorkerArgs(dir, "reap-vis-logger-throws"),
      queryFn: fakeQueryFn("success"),
      containment: fakeContainment(999994),
      logHomeReap: () => {
        throw new Error("simulated logger failure");
      },
    } as Parameters<typeof spawnWorker>[0]),
  );
  assert.equal(
    existsSync(join(dir, "worker-home-reap-vis-logger-throws")),
    false,
    "the reap itself must still have happened even though observing it failed",
  );
});

// ── Claim 4: NO REMEDY — the home is still keyed on the run, not the spawn, ──
// so two fix spawns inside one daemon run still collide on the same path, and
// the shared-home defect this instrumentation exists to make queryable still fires.

test("no remedy: perRunWorkerHomeDir still returns the SAME path for two spawns sharing one runId — the defect this task deliberately leaves firing", () => {
  const root = join(tmp(), "worker-home");
  const firstSpawn = perRunWorkerHomeDir(root, "DAEMON-shared-run");
  const secondSpawn = perRunWorkerHomeDir(root, "DAEMON-shared-run");
  assert.equal(
    firstSpawn,
    secondSpawn,
    "W1-T2441 is instrumentation-only: perRunWorkerHomeDir must remain keyed on runId, not per-spawn, " +
      "so this test fails the moment a future task ships the remedy here instead of its own task",
  );
});
