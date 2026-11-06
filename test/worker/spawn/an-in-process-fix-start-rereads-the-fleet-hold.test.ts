import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Config } from "#src/lib/config.js";
import type { AdmissionPorts } from "#src/lib/host-memory-admission.js";
import { openLearnedReservation } from "#src/lib/host-memory-learning.js";
import { activeWorkerCount, createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Hold = { control: "STOP" | "PAUSE"; detail: string };

function result(): WorkerResult {
  return { provider: "codex", sessionId: "fixture-session", text: "done", blocks: [], stderr: "", isError: false,
    apiError: false, subtype: "success", costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [],
    model: "fixture", effort: "low", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

function fixture(t: TestContext, workerClass: "fix" | "review") {
  const root = ownedFixtureDir(t, "fix-spawn-hold").dir;
  const config: Config = { root, claudeBin: "/unused", dailyCapUsd: 25,
    workerProviders: { enabled: ["claude", "codex", "cash"], cashFallbackWhenBlocked: true,
      cashEndpoint: "https://foundry.example.test/" } };
  let admissionEnded = false;
  let holdReads = 0;
  let spawnCalls = 0;
  let hold: Hold | undefined;
  const fRoot = root;
  const args: SpawnWorkerArgs = {
    cwd: root, permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings/worker.json"),
    config, model: "haiku", effort: "low", tools: ["Read", "Write", "Edit"], workerClass, memoryShadow: {} satisfies Partial<AdmissionPorts>,
    mountProvider: "codex", prompt: "fixture work",
    onMemoryAdmissionEnd: () => { admissionEnded = true; },
    readWorkerAdmissionHold: root => {
      assert.equal(root, fRoot);
      holdReads++;
      assert.equal(admissionEnded, true, "the hold is re-read after memory admission completes");
      return hold;
    },
    logWorkerSpawnWithheld: row => rows.push(row),
    providerRouting: {
      writeStatus: () => {},
      spawnCodex: async () => { spawnCalls++; return result(); },
    },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
      env: { RMD_CLAUDE_BIN: "/fixture/claude" }, home: root, exists: () => true,
      which: () => "/fixture/claude", canExecute: () => true, locations: [],
    } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({
      claudeAiOauth: { accessToken: "fixture-only", expiresAt: Date.now() + 3_600_000 },
    }), },
    ...(workerClass === "fix" ? { taskId: "W1-T11336", runId: "W1-T11336-fixture" } : {}),
  };
  const rows: Array<Record<string, unknown>> = [];
  return { root, args, rows, setHold: (next: Hold | undefined) => { hold = next; },
    reads: () => holdReads, spawns: () => spawnCalls };
}

test("W1-T11336 criterion 1: an in-process fix releases its reservation and stands down when PAUSE arrives during memory admission", async t => {
  const f = fixture(t, "fix");
  f.setHold({ control: "PAUSE", detail: "recycle requested" });
  const reservation = openLearnedReservation({ workerClass: "fix", root: f.root });
  assert.ok(reservation.published, "the test owns a real memory-admission reservation");
  let reservationReleases = 0;
  const release = reservation.releaseOccupancy.bind(reservation);
  reservation.releaseOccupancy = () => { reservationReleases++; release(); };
  f.args.admitWorkerMemory = async () => ({ kind: "admitted", tier: "fits", waitedMs: 0, attempts: 1, reservation });

  const before = activeWorkerCount(join(f.root, "state"));
  const result = await spawnWorker(f.args);

  assert.equal(f.reads(), 1);
  assert.equal(f.spawns(), 0, "a held fix start never invokes the provider spawn");
  assert.equal(result.notStarted, "admission-abandoned");
  assert.equal(result.subtype, "admission_abandoned");
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0]?.step, "worker.spawn_withheld");
  assert.equal(f.rows[0]?.hold, "fleet PAUSE hold: recycle requested");
  assert.equal(reservationReleases, 1, "the fresh hold releases the admitted reservation");
  assert.equal(activeWorkerCount(join(f.root, "state")), before, "the held start claims no in-process occupancy");
});

test("W1-T11336 criterion 1: an in-process fix stands down on STOP after memory admission", async t => {
  const f = fixture(t, "fix");
  f.setHold({ control: "STOP", detail: "operator stop" });

  const result = await spawnWorker(f.args);

  assert.equal(f.reads(), 1);
  assert.equal(f.spawns(), 0);
  assert.equal(result.notStarted, "admission-abandoned");
  assert.equal(f.rows[0]?.hold, "fleet STOP hold: operator stop");
});

test("W1-T11336 criterion 1: an in-process fix starts when the fresh hold read is clear", async t => {
  const f = fixture(t, "fix");
  const result = await spawnWorker(f.args);

  assert.equal(f.reads(), 1);
  assert.equal(f.spawns(), 1);
  assert.equal(result.notStarted, undefined);
  assert.equal(f.rows.length, 0);
});

test("W1-T11336 criterion 1: a non-fix worker is unchanged and does not read the fix-start hold", async t => {
  const f = fixture(t, "review");
  f.setHold({ control: "STOP", detail: "operator stop" });
  const result = await spawnWorker(f.args);

  assert.equal(f.reads(), 0);
  assert.equal(f.spawns(), 1);
  assert.equal(result.notStarted, undefined);
  assert.equal(f.rows.length, 0);
});


