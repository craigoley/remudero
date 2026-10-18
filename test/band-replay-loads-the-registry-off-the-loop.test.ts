import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { runDaemon } from "#src/lib/daemon.js";
import { triageFleetLaneAsync, writeClassificationSnapshot, type FleetLaneDeps } from "#src/lib/fleet-lane.js";
import { createBandMeaningReplayRegistryReader, replayBandMeaningRefusals, replayBandMeaningRefusalsAsync,
  BAND_MEANING_REPLAY_STORE, type BandMeaningReplayInput } from "#src/lib/inbox-replay.js";
import { loadPlan } from "#src/lib/plan.js";

const ID = "followup:W1-T9699:pending";
const SEED = "2026-10-15T00:00:00.000Z";
const clock = fixedClock(Date.parse(SEED) + 60_000);
function fixture(t: TestContext) {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-replay-registry-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const registry = join(stateDir, "inbox-proposals.json"), shards = join(stateDir, "inbox-proposals.d");
  mkdirSync(shards);
  writeFileSync(registry, JSON.stringify({ proposals: [] }));
  writeFileSync(join(shards, "kept.json"), JSON.stringify({ id: ID, summary: "kept", evidenceAnchors: [] }));
  writeFileSync(ledgerPath, JSON.stringify({ ts: "2026-10-14T00:00:00.000Z", task_id: ID, step: "approve.error", error: "risk:high with no band_meaning declared" }) + "\n");
  const storePath = join(stateDir, BAND_MEANING_REPLAY_STORE);
  writeFileSync(storePath, JSON.stringify({ seededAt: SEED, refiledRule: "ratify.approved", proposals: { [ID]: { family: "followup", invalidatedAt: SEED } } }));
  const input: BandMeaningReplayInput = { stateDir, ledgerPath, clock, classificationStates: () => ({}) };
  const deps: FleetLaneDeps<number | Promise<number>> = { stateDir, ledgerPath, clock, mergedLastDay: () => 10, approve: () => {} };
  const rows = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((s) => JSON.parse(s) as Record<string, unknown>);
  return { stateDir, ledgerPath, registry, shards, storePath, input, deps, rows };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("test/band-replay-loads-the-registry-off-the-loop.test.ts", async (suite) => {
  await suite.test("W1-T9699: daemon band replay awaits the proposal registry off the loop", async (t) => {
    const f = fixture(t), gate = deferred<void>();
    let started = false, settled = false, syncRegistryReads = 0;
    const original = fs.readFileSync;
    const trap = t.mock.method(fs, "readFileSync", ((path: string, ...args: unknown[]) => {
      if (path === f.registry || String(path).startsWith(f.shards + "/")) {
        syncRegistryReads++; throw new Error("synchronous registry read forbidden");
      }
      return (original as (...args: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    const reader = createBandMeaningReplayRegistryReader(f.stateDir, { readBlob: async (path) => {
      started = true; await gate.promise; return fs.promises.readFile(path, "utf8");
    } });
    const pass = triageFleetLaneAsync({ ...f.deps, replayRegistryReader: reader }).finally(() => { settled = true; });
    try {
      for (let i = 0; i < 3; i++) await turn();
      assert.equal(started, true, "the production triage driver reaches the awaited read");
      assert.equal(settled, false, "a pending filesystem read yields without completing the replay");
      assert.equal(syncRegistryReads, 0, "the production path never calls the synchronous registry reader");
    } finally {
      gate.resolve(); await pass; trap.mock.restore(); syncBuiltinESMExports();
    }
    assert.equal(JSON.parse(readFileSync(f.storePath, "utf8")).proposals[ID].outcome, undefined);
  });

  await suite.test("W1-T9699: replay refresh reuses unchanged shards and observes changes", async (t) => {
    const f = fixture(t), counts: Array<Record<string, unknown>> = [];
    const reader = createBandMeaningReplayRegistryReader(f.stateDir, { log: (_step, extra) => counts.push(extra!) });
    assert.deepEqual([...(await reader.readIds() ?? [])], [ID]);
    await reader.readIds();
    assert.deepEqual(counts.map(({ files, read, unchanged, removed }) => ({ files, read, unchanged, removed })), [
      { files: 1, read: 1, unchanged: 0, removed: 0 }, { files: 1, read: 0, unchanged: 1, removed: 0 },
    ]);
    const replacement = join(f.shards, "replacement.tmp");
    writeFileSync(replacement, JSON.stringify({ id: "replacement", summary: "new" }));
    renameSync(replacement, join(f.shards, "kept.json"));
    assert.deepEqual([...(await reader.readIds() ?? [])], ["replacement"]);
    assert.equal(counts.at(-1)?.read, 1);
    unlinkSync(join(f.shards, "kept.json"));
    assert.deepEqual([...(await reader.readIds() ?? [])], []);
    assert.equal(counts.at(-1)?.removed, 1);
    writeFileSync(f.registry, JSON.stringify({ proposals: [{ id: "legacy" }] }));
    writeFileSync(join(f.shards, "one.json"), JSON.stringify({ id: "legacy" }));
    assert.deepEqual([...(await reader.readIds() ?? [])], ["legacy"], "blob/shard overlap is one id, not a collision");
  });

  await suite.test("W1-T9699: an unreadable replay registry judges no absence", async (t) => {
    for (const fault of ["missing blob", "malformed blob", "wrong shape", "bad shard", "collision", "refused refresh"]) {
      await t.test(fault, async (t) => {
        const f = fixture(t);
        // The last good population lacks ID: reusing it after a failed refresh would wrongly finalize ID as gone.
        writeFileSync(join(f.shards, "kept.json"), JSON.stringify({ id: "other" }));
        const reader = createBandMeaningReplayRegistryReader(f.stateDir, fault === "refused refresh"
          ? { shards: { refresh: async () => { throw new Error("EACCES current refresh refused"); } } } : {});
        if (fault !== "refused refresh") assert.deepEqual([...(await reader.readIds() ?? [])], ["other"]);
        if (fault === "missing blob") unlinkSync(f.registry);
        if (fault === "malformed blob") writeFileSync(f.registry, "{");
        if (fault === "wrong shape") writeFileSync(f.registry, "[]");
        if (fault === "bad shard") writeFileSync(join(f.shards, "kept.json"), "{");
        if (fault === "collision") writeFileSync(join(f.shards, "collision.json"), JSON.stringify({ id: "other" }));
        const pass = await replayBandMeaningRefusalsAsync(f.input, reader);
        assert.deepEqual(pass.recorded, [], "unknown evidence authorizes no absent-proposal judgment");
        assert.equal(JSON.parse(readFileSync(f.storePath, "utf8")).proposals[ID].outcome, undefined);
      });
    }
    await t.test("an unexpected rejected reader is a named deferral", async (t) => {
      const f = fixture(t);
      const pass = await replayBandMeaningRefusalsAsync(f.input, { readIds: async () => { throw new Error("reader failed"); } });
      assert.match(pass.deferred!, /reader failed/);
      assert.equal(pass.complete, false);
    });
  });

  await suite.test("W1-T9699: the real daemon retains one default reader across timer passes", { timeout: 10_000 }, async (t) => {
    const f = fixture(t), finished = deferred<void>(), approved: string[] = [];
    const ids = ["proof-debt:W1-T1", "proof-debt:W1-T2"];
    writeFileSync(f.registry, JSON.stringify({ proposals: ids.map((id) => ({ id, summary: id, evidenceAnchors: [] })) }));
    writeClassificationSnapshot(f.stateDir, ids.map((proposalId) => ({ proposalId, state: "ready" })), clock);
    writeFileSync(join(f.stateDir, "inbox-drafts.json"), JSON.stringify(Object.fromEntries(ids.map((id) => [id,
      { proposalId: id, fragmentYaml: "[]", stampLine: "", anchorFingerprint: "" }]))));
    const plan = join(f.stateDir, "tasks.yaml");
    writeFileSync(plan, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
    await runDaemon(loadPlan(plan), {
      refreshMerged: () => () => false,
      runOne: async (id) => { await finished.promise; return { taskId: id, runId: "fixture", merged: true, costUsd: 0, verdict: "merged" }; },
      fleetLane: { ...f.deps, approve: (id) => { approved.push(id); if (approved.length === 2) finished.resolve(); } },
      sleep: async () => {}, log: () => {},
    }, { headroomEnabled: false, max: 1, pollIntervalMs: 10 });
    const counts = f.rows().filter((r) => r.step === "proposal_shards.refreshed" && r.reader === "band-replay");
    assert.ok(counts.length >= 2, "the actual daemon timer ran at least two replay reads");
    assert.equal(counts[0]!.read, 1);
    assert.equal(counts[1]!.read, 0, "the same daemon's second pass reuses the unchanged shard");
    assert.equal(counts[1]!.unchanged, 1);
  });

  await suite.test("W1-T9699: default async decisions match sync and a changed owner root gets a new reader", async (t) => {
    const sync = fixture(t), async = fixture(t);
    unlinkSync(join(sync.shards, "kept.json")); unlinkSync(join(async.shards, "kept.json"));
    assert.deepEqual(await replayBandMeaningRefusalsAsync(async.input), replayBandMeaningRefusals(sync.input));
    const first = fixture(t), second = fixture(t), owner = first.deps;
    await triageFleetLaneAsync(owner);
    owner.stateDir = second.stateDir; owner.ledgerPath = second.ledgerPath;
    await triageFleetLaneAsync(owner);
    assert.equal(second.rows().find((r) => r.reader === "band-replay")?.read, 1);
  });

});
