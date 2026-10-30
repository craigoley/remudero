import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { buildSweepEffects, createFullPreludeTimer, runSweep } from "#src/lib/sweep.js";
import { reconcileFleetState } from "#src/lib/state-reconciler.js";

const proofFile = "test/the-full-prelude-names-where-fleet-state-spends-its-time.test.ts";

function fixture(failure?: "ci" | "deploy" | "workflow") {
  const root = mkdtempSync(join(tmpdir(), "rmd-fleet-state-parts-"));
  const state = join(root, "state");
  const workflows = join(root, ".github", "workflows");
  mkdirSync(state);
  mkdirSync(workflows, { recursive: true });
  const ledgerPath = join(state, "ledger.ndjson");
  const repaired = { step: "reconcile.repaired", gap_id: JSON.stringify(["ci", "old:a.yml"]), head: "head" };
  writeFileSync(ledgerPath, JSON.stringify(repaired) + "\n");
  writeFileSync(join(state, "ledger.2026-10-14T00-00-00-000Z.ndjson"), '{"step":"deploy.ok"}\n');
  writeFileSync(join(state, "ledger.2026-10-15T00-00-00-000Z.ndjson.gz"), gzipSync('{"step":"reconcile.escalated"}\n'));
  for (const name of ["a.yml", "b.yml"]) {
    writeFileSync(join(workflows, name), "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n");
  }
  let ms = 0;
  let clockReads = 0;
  const reads: string[] = [];
  const writes: string[][] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const effects = buildSweepEffects({
    owner: "o", repo: "r", repoRoot: root, config: { root } as never,
    ledgerPath, runId: "W1-T9781", plan: { tasks: [], byId: new Map() } as never,
    nowMsImpl: () => { if (++clockReads === 2) ms += 23; return ms; },
    log: (step, extra) => logs.push({ step, extra }),
    ghRunImpl: (_command, args) => { writes.push([...args]); },
    readJsonImpl: async (args) => {
      const endpoint = args[1];
      reads.push(endpoint);
      ms += 7;
      if (failure === "ci") throw new Error("commit read unavailable");
      if (failure === "workflow" && endpoint.includes("/workflows/")) throw new Error("workflow read unavailable");
      if (endpoint.includes("commits?")) return [
        { sha: "head", parents: [{ sha: "middle" }] },
        { sha: "side", parents: [] },
        { sha: "middle", parents: [{ sha: "old" }] },
        { sha: "old", parents: [] },
      ];
      if (endpoint.includes("/commits/")) return { files: [{ filename: "src/example.ts" }] };
      return { total_count: endpoint.includes("workflows/a.yml/runs?head_sha=old") ? 0 : 1 };
    },
    fleetDeployStateImpl: {
      deploy: {
        newestBakedSha: () => {
          ms += 11;
          if (failure === "deploy") throw new Error("deploy read unavailable");
          return "baked";
        },
        imagePublished: () => { ms += 13; return true; },
        imageBakedCommitsBehind: () => { ms += 17; return 0; },
        imageRecycleManual: () => { ms += 19; return false; },
      },
      failedAt: () => undefined, clearFailure: () => {},
      deployRequested: () => false, requestDeploy: () => { throw new Error("unexpected deploy repair"); },
    },
  });
  return { root, ledgerPath, effects, reads, writes, logs, clock: () => ms };
}

test(`${proofFile}: W1-T9781: fleet_state counts its main-commit GitHub reads`, async () => {
  const f = fixture();
  try {
    const state = await f.effects.readFleetState!([]);
    assert.equal(f.reads.length, 6, "listing, three first-parent commits and two changed-file reads");
    assert.ok(state.history.some((row) => row.step === "reconcile.escalated"), "gzip rotation was read");
    const recorded: Record<string, unknown>[] = [];
    await reconcileFleetState(state.rows, state.history, (row) => recorded.push(row));
    assert.equal(f.reads.length, 11, "four workflow observations plus the prior repair's covering head");
    assert.deepEqual(state.parts, {
      union_ms: 23, union_rotations: 2, commits_walked: 3,
      commit_reads: f.reads.length, commit_read_ms: 77, deploy_ms: 60,
    });
    assert.deepEqual(recorded, [], "all observed rows are healthy");
    assert.deepEqual(f.writes, [], "measurement does not dispatch workflows");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T9781: sweep.full_prelude carries the completed fleet_state parts once", async () => {
  const f = fixture();
  try {
    const rows: Record<string, unknown>[] = [];
    const timer = createFullPreludeTimer((row) => rows.push(row), f.clock);
    await runSweep([], {
      ledgerPath: f.ledgerPath, runId: "W1-T9781", readLedger: () => [],
      readLedgerUnion: () => ({ complete: true, lines: [] }),
      readFleetState: f.effects.readFleetState, markPrelude: timer.mark,
      arm: () => "armed", close: () => {}, dispatchFix: () => {}, escalate: () => {}, postReview: () => {},
      appendLine: () => { throw new Error("unexpected reconciliation write"); },
    });
    timer.write(false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].walk_reached, true);
    assert.deepEqual(rows[0].fleet_state_parts, {
      union_ms: 23, union_rotations: 2, commits_walked: 3,
      commit_reads: 11, commit_read_ms: 77, deploy_ms: 60,
    });
    assert.equal((rows[0].stages as Record<string, number>).fleet_state, 160);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T9781: failed reads retain their timing and the existing unreadable reasons", async () => {
  for (const failure of ["ci", "deploy"] as const) {
    const f = fixture(failure);
    try {
      const state = await f.effects.readFleetState!([]);
      await reconcileFleetState(state.rows, state.history, () => {});
      assert.deepEqual(state.parts, {
        union_ms: 23, union_rotations: 2, commits_walked: failure === "ci" ? 0 : 3,
        commit_reads: failure === "ci" ? 1 : 11,
        commit_read_ms: failure === "ci" ? 7 : 77, deploy_ms: failure === "deploy" ? 11 : 60,
      });
      assert.ok(f.logs.some((row) => row.step === "reconcile.unreadable" && row.extra?.pipeline === failure &&
        row.extra.reason === (failure === "ci" ? "commit read unavailable" : "deploy read unavailable")));
      assert.deepEqual(f.writes, []);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("W1-T9781: failed deferred observations count as reads without authorizing a repair", async () => {
  const f = fixture("workflow");
  try {
    const state = await f.effects.readFleetState!([]);
    const recorded: Record<string, unknown>[] = [];
    await reconcileFleetState(state.rows, state.history, (row) => recorded.push(row));
    assert.deepEqual(state.parts, {
      union_ms: 23, union_rotations: 2, commits_walked: 3,
      commit_reads: 10, commit_read_ms: 70, deploy_ms: 60,
    });
    assert.equal(recorded.length, 4);
    assert.ok(recorded.every((row) => row.step === "reconcile.unreadable" && row.reason === "workflow read unavailable"));
    assert.deepEqual(f.writes, []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T9781: each fleet-state read owns fresh counters", async () => {
  const f = fixture();
  try {
    const first = await f.effects.readFleetState!([]);
    await reconcileFleetState(first.rows, first.history, () => {});
    const second = await f.effects.readFleetState!([]);
    await reconcileFleetState(second.rows, second.history, () => {});
    assert.notEqual(first.parts, second.parts);
    assert.deepEqual(first.parts, {
      union_ms: 23, union_rotations: 2, commits_walked: 3,
      commit_reads: 11, commit_read_ms: 77, deploy_ms: 60,
    });
    assert.deepEqual(second.parts, { ...first.parts, union_ms: 0 });
    assert.equal(f.reads.length, 22);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
