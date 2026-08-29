// W1-T2441: the per-spawn worker-home reap (`reapWorkerHome`, worker-home.ts) already computes
// a `WorkerHomeReapResult` naming WHICH target it removed (or didn't) and WHY, on every arm —
// but `src/lib/worker.ts:1178` called it in statement position and discarded the return value
// (`grep -acE "=\s*reapWorkerHome\(" src/lib/worker.ts` read 0 before this task). This suite
// proves the result is no longer thrown away: the target/reason/spawn-identity are all
// observable, and the reap stays best-effort and never throws on any arm. Claim 4 below USED to
// assert that the remedy had deliberately not shipped; it has since shipped under this same task
// id, and that slot is re-cut accordingly rather than left asserting the opposite.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  perRunWorkerHomeDir,
  reapWorkerHome,
  WORKER_HOME_SPAWN_UUID_RE,
  type WorkerHomeReapResult,
} from "../src/lib/worker-home.js";
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
  // W1-T2441 REMEDY: spawnWorker now resolves a PER-SPAWN home, so the target is
  // `<root>-<runId>-<uuid>`, never the bare `<root>-<runId>`. Both halves are asserted below.
  const homePrefix = join(dir, "worker-home-reap-vis-success");
  const observed: Array<{ result: WorkerHomeReapResult; spawn: { runId?: string; taskId?: string } }> = [];
  await spawnWorker({
    ...e2eSpawnWorkerArgs(dir, "reap-vis-success", { taskId: "T-success" }),
    queryFn: fakeQueryFn("success"),
    containment: fakeContainment(999996),
    logHomeReap: (result, spawn) => observed.push({ result, spawn }),
  } as Parameters<typeof spawnWorker>[0]);

  assert.equal(observed.length, 1, "logHomeReap must be called exactly once, on the success exit path");
  assert.equal(observed[0].result.reaped, true);
  const target = String(observed[0].result.target);
  assert.ok(target.startsWith(`${homePrefix}-`), `the target must keep the runId and add a per-spawn suffix: ${target}`);
  assert.notEqual(target, homePrefix, "the bare runId-keyed path is exactly what two spawns used to collide on");
  assert.equal(existsSync(target), false, "sanity: the home the reap NAMED really was removed");
  assert.equal(existsSync(homePrefix), false, "and no bare runId-keyed home was ever created beside it");
  assert.equal(observed[0].spawn.runId, "reap-vis-success");
  assert.equal(observed[0].spawn.taskId, "T-success");
});

test("spawnWorker (end-to-end, ERROR path): logHomeReap STILL observes the reap when the SDK stream throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-home-reap-e2e-error-"));
  const homePrefix = join(dir, "worker-home-reap-vis-error");
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
  const target = String(observed[0].result.target);
  assert.ok(target.startsWith(`${homePrefix}-`), `per-spawn target on the error path too: ${target}`);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(homePrefix), false);
});

// ── W1-T2441 REMEDY, at the REAL call site: N spawns, ONE runId, N homes, N reaps ───────────
// The pure-function proof lives in test/worker-home-per-spawn-uniqueness.test.ts; this one drives
// the actual `spawnWorker` three times with the SAME daemon-scoped runId — the fix rung's own
// shape — and asserts three distinct targets, three reaped:true rows, and nothing left on disk.

test("spawnWorker (end-to-end): three spawns sharing ONE daemon runId produce three DISTINCT homes, each reaped exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-home-multi-spawn-"));
  const RUN = "DAEMON-1787980131770";
  const observed: Array<{ result: WorkerHomeReapResult; spawn: { runId?: string; taskId?: string } }> = [];
  for (let i = 0; i < 3; i++) {
    await spawnWorker({
      ...e2eSpawnWorkerArgs(dir, RUN, { taskId: "W1-T2452" }),
      queryFn: fakeQueryFn("success"),
      containment: fakeContainment(999990 + i),
      logHomeReap: (result, spawn) => observed.push({ result, spawn }),
    } as Parameters<typeof spawnWorker>[0]);
  }

  assert.equal(observed.length, 3, "one reap observation per spawn");
  const targets = observed.map((o) => String(o.result.target));
  assert.equal(new Set(targets).size, 3, `three spawns in one daemon run must not share a home: ${JSON.stringify(targets)}`);
  for (const o of observed) {
    assert.equal(o.result.reaped, true, `every spawn must remove its OWN home: ${JSON.stringify(o.result)}`);
    assert.equal(o.spawn.runId, RUN, "the runId #2862 threaded in is still carried — it is not reverted");
  }
  assert.equal(observed.filter((o) => o.result.reason === "absent").length, 0, "no spawn may find its home already deleted by a sibling");
  for (const t of targets) {
    assert.ok(t.includes(RUN), `the runId must still be legible in the path: ${t}`);
    assert.equal(existsSync(t), false, "unique must not mean permanent");
  }
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("worker-home-")), [], "no worker-home sibling is left behind");
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
  // W1-T2441: assert over the whole SIBLING SET rather than one literal path — with a per-spawn
  // suffix the old single-path check would pass vacuously against a name that is never created.
  const leftovers = readdirSync(dir).filter((n) => n.startsWith("worker-home-reap-vis-logger-throws"));
  assert.deepEqual(leftovers, [], "the reap itself must still have happened even though observing it failed");
});

// ── Claim 4, RETIRED AND REPLACED (W1-T2441's remedy half) ──────────────────
// This slot used to assert "no remedy": that two spawns sharing one runId still collide, and it
// said in its own message that it "fails the moment a future task ships the remedy". The remedy
// is now shipped, under THIS SAME TASK ID rather than a future one — so the lock is re-cut onto
// the invariant that actually holds, rather than deleted (which would leave the collision
// untested) or left standing (which would pass while meaning the opposite of what it says).
//
// BOTH HALVES ARE LOCKED: the DEFAULT is unchanged, because `readUsageSnapshot` (run-task.ts)
// asks this same function for a stable, non-per-call home; the SPAWN path is per-spawn unique.
// The full remedy suite lives in test/worker-home-per-spawn-uniqueness.test.ts.

test("remedy shipped: the DEFAULT still returns one stable path per runId, while the per-spawn form never repeats", () => {
  const root = join(tmp(), "worker-home");
  assert.equal(
    perRunWorkerHomeDir(root, "DAEMON-shared-run"),
    perRunWorkerHomeDir(root, "DAEMON-shared-run"),
    "the stable default is what readUsageSnapshot depends on and must not move",
  );
  assert.notEqual(
    perRunWorkerHomeDir(root, "DAEMON-shared-run", { perSpawn: true }),
    perRunWorkerHomeDir(root, "DAEMON-shared-run", { perSpawn: true }),
    "two fix spawns in one daemon run must never resolve to one directory again",
  );
});

// ── negative-reachability-ratchet fixture (W1-T2441, CI round 2) ────────────────────────────
// `WORKER_HOME_SPAWN_UUID_RE` (src/lib/worker-home.ts) is a module-scope `_RE` validator this
// task's own remedy introduced; test/negative-reachability-ratchet.test.ts's PROPERTY gate counts
// any such surface fixture-less (baseline 0 for a brand-new symbol) unless BOTH its unhealthy
// (rejecting) and healthy (accepting) arms are driven by identifier via a `.test(...)`/`.exec(...)`
// call somewhere in test/**/*.ts. `runIdFromWorkerHomeSuffix`'s own `.replace(...)` call cannot
// satisfy that detector (it only credits `.test`/`.exec`), so both arms are asserted here directly.
test("WORKER_HOME_SPAWN_UUID_RE: matches a trailing per-spawn uuid and rejects a bare runId with no uuid suffix", () => {
  // healthy arm: a suffix that DOES end in a per-spawn uuid, as perRunWorkerHomeDir's perSpawn
  // form actually produces (runId, hyphen, canonical v4-shaped uuid).
  assert.equal(
    WORKER_HOME_SPAWN_UUID_RE.test("DAEMON-1787980131770-1b9d6c2e-4b8a-4c1a-9c2a-abcdef123456"),
    true,
    "a genuine trailing per-spawn uuid must match",
  );
  // unhealthy arm: a bare runId with no uuid suffix at all — the DEFAULT (non-perSpawn) shape
  // perRunWorkerHomeDir still returns for readUsageSnapshot's stable-home caller.
  assert.equal(
    WORKER_HOME_SPAWN_UUID_RE.test("DAEMON-1787980131770"),
    false,
    "a bare runId with no trailing uuid must not match",
  );
});
