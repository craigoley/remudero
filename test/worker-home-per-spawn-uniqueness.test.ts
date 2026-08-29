// W1-T2441 (the REMEDY half; #3234 shipped the instrumentation half). #2862 threaded `runId` into
// `fixArgs` so `workerMarkerEnv` would write REMEDUERO_RUN_ID/TASK_ID into the child's env — the
// attribution the reclaim/orphan sweeps match on. `spawnWorker` ALSO passed that same `runId` to
// `perRunWorkerHomeDir`, and on the fix-rung path the id is DAEMON-SCOPED, so every fix spawn in
// one daemon run resolved to `worker-home-DAEMON-<epoch>` and the `finally`'s `rmSync -rf`
// removed it under its live siblings — violating `spawnWorker`'s own doc ("a worker-home dir
// UNIQUE to this call") and the `perRunWorkerHomeDir` doc's stated concurrency invariant.
//
// OBSERVED at head from #3234's own instrumentation (docker logs, 24h window, 84 rows / 73
// targets): 68 uuid-named homes reaped EXACTLY ONCE each, against DAEMON-named homes reaped
// 1/2/3/4/6 times — one reading true,absent,absent,true,true,true on a single run_id. That
// contrast is the control this suite reproduces in-process.
//
// The runId is KEPT in the path (durable in `ps`/logs, and the stale sweep reads it back); the
// uuid is what makes it per-spawn. Uniqueness is OPT-IN at the call site because
// `readUsageSnapshot` (run-task.ts) deliberately asks the same function for a STABLE home.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  perRunWorkerHomeDir,
  reapWorkerHome,
  runIdFromWorkerHomeSuffix,
  sweepStaleWorkerHomes,
} from "../src/lib/worker-home.js";
import { workerHomeReapLogFields } from "../src/lib/worker.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-workerhome-perspawn-"));
}

const DAEMON_RUN = "DAEMON-1787980131770"; // the run_id the shipped instrumentation actually caught

/** The exact sequence `spawnWorker` performs per spawn: resolve a home, materialize it, and reap
 *  it in a `finally`. Driven directly so N interleaved spawns are expressible without an SDK. */
function driveSpawns(root: string, runId: string, n: number, perSpawn: boolean): {
  homes: string[];
  reapRows: Array<Record<string, unknown>>;
} {
  const homes: string[] = [];
  for (let i = 0; i < n; i++) {
    const home = perRunWorkerHomeDir(root, runId, perSpawn ? { perSpawn: true } : {});
    mkdirSync(home, { recursive: true });
    homes.push(home);
  }
  // Teardown happens AFTER all N are live — the real overlap, not a serial loop.
  const reapRows = homes.map((home) => workerHomeReapLogFields(reapWorkerHome(root, home), { runId, taskId: "W1-T2452" }));
  return { homes, reapRows };
}

// ── Claim 1: unique per spawn ────────────────────────────────────────────────

test("N fix spawns sharing ONE daemon runId resolve to N DISTINCT home paths, and every path still carries the runId", () => {
  const root = join(tmp(), "worker-home");
  const { homes } = driveSpawns(root, DAEMON_RUN, 6, true);
  assert.equal(new Set(homes).size, 6, "six spawns in one daemon run must not share a directory");
  for (const h of homes) {
    assert.ok(h.includes(DAEMON_RUN), `the runId must survive in the path (ps/log legibility): ${h}`);
    assert.ok(h.startsWith(`${root}-`), "still a SIBLING of the singleton root, never nested under it");
  }
});

// ── Claim 2: reaped exactly once each — unique must not mean permanent ───────

test("each of the N distinct homes is reaped exactly once, reaped:true, and none survives the teardown", () => {
  const root = join(tmp(), "worker-home");
  const { homes, reapRows } = driveSpawns(root, DAEMON_RUN, 6, true);
  assert.equal(reapRows.length, 6);
  for (const row of reapRows) {
    assert.equal(row.reaped, true, `every teardown must actually remove its own home: ${JSON.stringify(row)}`);
    assert.equal(row.reason, undefined, "a successful reap states no refusal reason");
  }
  assert.equal(new Set(reapRows.map((r) => r.target)).size, 6, "six teardowns, six distinct targets");
  assert.equal(reapRows.filter((r) => r.reason === "absent").length, 0, "no teardown may find its home already gone");
  for (const h of homes) assert.equal(existsSync(h), false, "unique must not mean permanent — nothing is left behind");
});

// ── Claim 3: THE FALSIFIER — restore the shared name, reproduce absent-after-true ──

test("FALSIFIER: without the per-spawn discriminator the six spawns collide on ONE path and reproduce the observed absent-after-true sequence", () => {
  const root = join(tmp(), "worker-home");
  const { homes, reapRows } = driveSpawns(root, DAEMON_RUN, 6, false);

  assert.equal(new Set(homes).size, 1, "the defect: six spawns, one directory");
  assert.equal(homes[0], `${root}-${DAEMON_RUN}`, "and it is the exact shape the instrumentation logged");

  const sequence = reapRows.map((r) => (r.reaped ? "true" : String(r.reason)));
  assert.deepEqual(
    sequence,
    ["true", "absent", "absent", "absent", "absent", "absent"],
    "the first teardown removes the shared home and every sibling then finds it ABSENT — the shape " +
      "#3234 caught in production (true,absent,absent,true,true,true, the true-after-absent arms " +
      "being later spawns that had re-materialized it)",
  );
  assert.ok(sequence.slice(1).includes("absent"), "an absent-AFTER-true is the signature this remedy removes");
});

// ── Claim 4: the default is UNCHANGED, so the stable caller is unaffected ────

test("omitting perSpawn is byte-identical to before: readUsageSnapshot's constant id still resolves to ONE stable home", () => {
  const root = join(tmp(), "worker-home");
  // The exact call readUsageSnapshot (run-task.ts) makes — a CONSTANT id, wanting stability.
  const a = perRunWorkerHomeDir(root, "usage-probe");
  const b = perRunWorkerHomeDir(root, "usage-probe");
  assert.equal(a, b, "the usage probe must keep reusing one materialized directory, never litter siblings");
  assert.equal(a, `${root}-usage-probe`);
});

test("an ABSENT runId still yields a fresh uuid home per call, with or without perSpawn — uniqueness never depends on a threaded runId", () => {
  const root = join(tmp(), "worker-home");
  assert.notEqual(perRunWorkerHomeDir(root), perRunWorkerHomeDir(root));
  assert.notEqual(perRunWorkerHomeDir(root, undefined, { perSpawn: true }), perRunWorkerHomeDir(root, undefined, { perSpawn: true }));
});

// ── Claim 5: the stale sweep still resolves the run id out of the new name ──

test("runIdFromWorkerHomeSuffix strips a trailing per-spawn uuid, leaves a bare runId alone, and reports a bare-uuid home as unresolvable", () => {
  const withUuid = perRunWorkerHomeDir("/r/worker-home", DAEMON_RUN, { perSpawn: true }).slice("/r/worker-home-".length);
  assert.equal(runIdFromWorkerHomeSuffix(withUuid), DAEMON_RUN, "the uuid must not be read as part of the run id");
  assert.equal(runIdFromWorkerHomeSuffix(DAEMON_RUN), DAEMON_RUN, "a suffix with no uuid is already the run id");
  const bare = perRunWorkerHomeDir("/r/worker-home").slice("/r/worker-home-".length);
  assert.equal(runIdFromWorkerHomeSuffix(bare), "", "a bare-uuid home carries no run id at all");
});

test("sweepStaleWorkerHomes KEEPS a per-spawn home whose run holds a live inflight lock — the predicate the uuid would otherwise have demoted to the age backstop", () => {
  const parent = tmp();
  const root = join(parent, "worker-home");
  const inflightDir = join(parent, "state", "inflight");
  mkdirSync(inflightDir, { recursive: true });
  writeFileSync(join(inflightDir, "live.lock"), JSON.stringify({ pid: process.pid, run_id: DAEMON_RUN }), "utf8");

  const live = perRunWorkerHomeDir(root, DAEMON_RUN, { perSpawn: true });
  mkdirSync(live, { recursive: true });
  const foreign = perRunWorkerHomeDir(root, "DAEMON-no-such-run", { perSpawn: true });
  mkdirSync(foreign, { recursive: true });

  // Age both far past the ceiling so ONLY the lock predicate can save one of them.
  const summary = sweepStaleWorkerHomes(root, { inflightDir, ledgerPath: join(parent, "state", "ledger.ndjson"), maxAgeMs: -1 });

  assert.ok(summary.kept.includes(live.slice(`${parent}/`.length)), `a live run's home must be KEPT: ${JSON.stringify(summary)}`);
  assert.equal(existsSync(live), true, "and it must still be on disk");
  // CONTROL: the same sweep, same age, a run id nothing holds a lock for — removed.
  assert.equal(existsSync(foreign), false, "a home whose run resolves to nothing is still reaped by the age backstop");
});

test("sweepStaleWorkerHomes reaps a per-spawn home promptly on its run's TERMINAL VERDICT, before the age ceiling", () => {
  const parent = tmp();
  const root = join(parent, "worker-home");
  const stateDir = join(parent, "state");
  mkdirSync(join(stateDir, "inflight"), { recursive: true });
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify({ step: "verdict", run_id: DAEMON_RUN }) + "\n", "utf8");

  const dead = perRunWorkerHomeDir(root, DAEMON_RUN, { perSpawn: true });
  mkdirSync(dead, { recursive: true });

  // maxAgeMs deliberately HUGE: only the terminal-verdict predicate can remove it.
  const summary = sweepStaleWorkerHomes(root, { inflightDir: join(stateDir, "inflight"), ledgerPath, maxAgeMs: 365 * 24 * 60 * 60 * 1000 });
  assert.equal(existsSync(dead), false, `a dead run's home must be reaped on its verdict, not left for 24h: ${JSON.stringify(summary)}`);
});

// ── Claim 6: the real call site actually asks for it ────────────────────────

test("spawnWorker's own home resolution passes perSpawn — the remedy is wired at the real call site, not only typed", () => {
  const src = readFileSync(new URL("../src/lib/worker.ts", import.meta.url), "utf8");
  const call = /const workerHome = perRunWorkerHomeDir\(workerHomeRoot, args\.runId, \{ perSpawn: true \}\);/.exec(src);
  assert.ok(call, "spawnWorker must resolve its home with perSpawn: true");
  assert.equal(
    /const workerHome = perRunWorkerHomeDir\(workerHomeRoot, args\.runId\);/.test(src),
    false,
    "and the pre-remedy call must be gone",
  );
});
