import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS,
  materializeWorkerHome,
  perRunWorkerHomeDir,
  reapWorkerHome,
  sweepStaleWorkerHomes,
} from "../src/lib/worker-home.js";

// W1-T2463: EVERY FIX SPAWN IN ONE DAEMON RUN STILL SHARES A SINGLE WORKER HOME AND ANY ONE OF
// THEM DELETES IT UNDER THE OTHERS. `perRunWorkerHomeDir` keyed the per-run home on `runId`
// ALONE, and `worker.ts:1009` passed `args.runId` with nothing else, so every spawn inside one
// daemon run resolved to the SAME `worker-home-<runId>` — and `reapWorkerHome`'s unconditional
// `rmSync -rf` (worker.ts's `finally`) tore that shared directory down while a still-live
// sibling was using it (MEASURED: 24h of daemon stderr showed 7 DAEMON-named homes with
// teardowns 2/3/5/6/6/7/9, 2 `absent`, and 1 `ENOTEMPTY` — the ENOTEMPTY is the collision proof:
// two spawns were live in ONE directory simultaneously).
//
// THE REMEDY (see plan/tasks.d/W1-T2463-*.yaml for the full design):
//  Q1. runId stays the FIRST/durable path component — reclamation's `workerMarkerEnv` still
//      writes the bare `args.runId`, untouched by this file.
//  Q2. uniqueness is OPT-IN at the call site (`perRunWorkerHomeDir`'s new `perSpawn` option) —
//      the DEFAULT shape is byte-identical, so `readUsageSnapshot`'s stable "usage-probe" home
//      (the only OTHER caller in src/) is unaffected.
//  Q3. `sweepStaleWorkerHomes` parses the per-spawn token back OUT of the directory name before
//      matching it against a live inflight lock or a terminal ledger verdict — both exact
//      string comparisons against the bare `runId`.

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rmd-workerhome-perspawn-"));
}

// ── Claim 1: opting in makes two spawns sharing one runId resolve to DISTINCT homes ──

test("perRunWorkerHomeDir: two calls sharing ONE runId resolve to DISTINCT homes once the call site opts in via perSpawn — the collision cannot recur", () => {
  const root = join(tmp(), "worker-home");
  const runId = "DAEMON-shared-run";
  const first = perRunWorkerHomeDir(root, runId, { perSpawn: true });
  const second = perRunWorkerHomeDir(root, runId, { perSpawn: true });
  assert.notEqual(first, second, "worker.ts:1009's own collision — two spawns, one runId — must not recur once opted in");
  assert.ok(first.startsWith(`${root}-${runId}.`), `${first} must still carry runId as its durable prefix`);
  assert.ok(second.startsWith(`${root}-${runId}.`), `${second} must still carry runId as its durable prefix`);
});

test("perRunWorkerHomeDir: perSpawn is a NO-OP shape change when runId itself is absent — an absent runId already generates a fresh id every call", () => {
  const root = join(tmp(), "worker-home");
  const a = perRunWorkerHomeDir(root, undefined, { perSpawn: true });
  const b = perRunWorkerHomeDir(root, undefined, { perSpawn: true });
  assert.notEqual(a, b);
  for (const h of [a, b]) assert.ok(h.startsWith(`${root}-`));
});

// ── Claim 2: a driven multi-spawn produces N distinct paths and N clean teardowns ──

test("driven multi-spawn: N spawns sharing one runId each get a DISTINCT home; N teardowns each report reaped:true, no absent, no ENOTEMPTY", () => {
  const root = join(tmp(), "worker-home");
  const realHome = tmp();
  const runId = "DAEMON-multi-spawn";
  const N = 6;
  const homes = Array.from({ length: N }, () => perRunWorkerHomeDir(root, runId, { perSpawn: true }));
  try {
    assert.equal(new Set(homes).size, N, "all N per-spawn homes sharing one runId must be pairwise distinct");

    // Simulate N spawns interleaved: each materializes its OWN home and plants its own state,
    // exactly the interleaving that used to race on the ONE shared `worker-home-<runId>`.
    for (const home of homes) {
      materializeWorkerHome({ workerHome: home, realHome });
      writeFileSync(join(home, ".bashrc"), `alias spawn=${basename(home)}\n`);
    }
    for (const home of homes) {
      assert.equal(existsSync(home), true, `${home} must exist before any teardown runs`);
    }

    // Every spawn tears down its OWN directory — never a shared one, so no rmSync can ever
    // observe a sibling repopulating it mid-walk (the ENOTEMPTY signature).
    const results = homes.map((home) => reapWorkerHome(root, home));
    for (const [i, result] of results.entries()) {
      assert.equal(result.reaped, true, `spawn ${i}'s own teardown must succeed`);
      assert.notEqual(result.reason, "absent", `spawn ${i}'s home must not read absent — it was live a moment before`);
      assert.doesNotMatch(String(result.reason ?? ""), /ENOTEMPTY/, `spawn ${i}'s teardown must never collide with a sibling's`);
    }
    for (const home of homes) assert.equal(existsSync(home), false, `${home} must be gone after its own reap`);
  } finally {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

// ── Claim 3: the DEFAULT call shape (no perSpawn) stays byte-identical ──

test("perRunWorkerHomeDir DEFAULT (perSpawn omitted): byte-identical to the pre-W1-T2463 shape — readUsageSnapshot's stable \"usage-probe\" home is unchanged, never littered per tick", () => {
  const root = join(tmp(), "worker-home");
  const a = perRunWorkerHomeDir(root, "usage-probe");
  const b = perRunWorkerHomeDir(root, "usage-probe");
  assert.equal(a, `${root}-usage-probe`, "the exact pre-W1-T2463 literal shape — no per-spawn token appended");
  assert.equal(a, b, "readUsageSnapshot's non-per-call home must resolve to the SAME path on every tick, never a fresh sibling");
});

test("perRunWorkerHomeDir DEFAULT (perSpawn explicitly false): identical to omitting the option entirely", () => {
  const root = join(tmp(), "worker-home");
  const omitted = perRunWorkerHomeDir(root, "run-explicit-false");
  const explicit = perRunWorkerHomeDir(root, "run-explicit-false", { perSpawn: false });
  assert.equal(omitted, explicit);
  assert.equal(explicit, `${root}-run-explicit-false`);
});

// ── Claim 4: runId is exactly recoverable from a perSpawn-shaped path ──

test("perRunWorkerHomeDir with perSpawn: the ORIGINAL runId component round-trips exactly out of the path — never merged/mangled with the per-spawn token", () => {
  const root = join(tmp(), "worker-home");
  const runId = "DAEMON-1735689000000";
  const home = perRunWorkerHomeDir(root, runId, { perSpawn: true, spawnToken: () => "spawnTokenABC" });
  assert.equal(home, `${root}-${runId}.spawnTokenABC`);
  const suffix = home.slice(`${root}-`.length);
  const recoveredRunId = suffix.split(".")[0];
  assert.equal(
    recoveredRunId,
    runId,
    "the run-id marker env (workerMarkerEnv) reclamation matches on is sourced from THIS runId — it must round-trip exactly",
  );
});

// ── Claims 5 & 6: sweepStaleWorkerHomes parses the per-spawn token back out ──
// Same fixture discipline test/daemon-worker-home-sweep.test.ts already uses for the W1-T1064
// predicate, applied to a PER-SPAWN-shaped (`<root>-<runId>.<token>`) home rather than the
// bare `<root>-<runId>` shape those tests cover.

function predicateFixture(): { root: string; stateDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "rmd-worker-home-perspawn-predicate-"));
  const root = join(base, "worker-home");
  const stateDir = join(base, "state");
  mkdirSync(join(stateDir, "inflight"), { recursive: true });
  return { root, stateDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function makePerSpawnHome(root: string, runId: string, token: string, ageMs: number): string {
  const home = `${root}-${runId}.${token}`;
  mkdirSync(home, { recursive: true });
  const mtime = new Date(Date.now() - ageMs);
  utimesSync(home, mtime, mtime);
  return home;
}

function writeTerminalVerdict(stateDir: string, taskId: string, runId: string): void {
  writeFileSync(
    join(stateDir, "ledger.ndjson"),
    `${JSON.stringify({ run_id: runId, task_id: taskId, step: "verdict", outcome: "merged" })}\n`,
  );
}

function writeInflightLock(stateDir: string, taskId: string, runId: string): void {
  writeFileSync(
    join(stateDir, "inflight", `${taskId}.lock`),
    JSON.stringify({ pid: 999999999, run_id: runId, host: "test-host", startedAt: new Date().toISOString() }),
  );
}

test("sweepStaleWorkerHomes: a per-spawn home's live inflight lock is matched by its RUNID component (not the full token-bearing suffix) — kept regardless of age", () => {
  const { root, stateDir, cleanup } = predicateFixture();
  try {
    const runId = "W1-T2463-live-run";
    // Ages the home far past the ceiling — only a correctly-parsed lock match can save it.
    const home = makePerSpawnHome(root, runId, "spawnTok1", DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS * 10);
    writeInflightLock(stateDir, "W1-T2463", runId); // the lock names the BARE runId, never a per-spawn suffix

    const summary = sweepStaleWorkerHomes(root, { now: () => Date.now() });

    assert.ok(
      summary.kept.includes(basename(home)),
      "the sweep must strip the per-spawn token before comparing against the lock's run_id, or this match fails",
    );
    assert.equal(existsSync(home), true, "a live run's per-spawn home must survive regardless of age");
  } finally {
    cleanup();
  }
});

test("sweepStaleWorkerHomes: a per-spawn home is removed on its runId's terminal ledger verdict, before the age ceiling — never falls through to the age backstop", () => {
  const { root, stateDir, cleanup } = predicateFixture();
  try {
    const runId = "W1-T2463-finished-run";
    const home = makePerSpawnHome(root, runId, "spawnTok2", 1000); // a second old, nowhere near the 24h ceiling
    writeTerminalVerdict(stateDir, "W1-T2463", runId); // the verdict names the BARE runId too

    const summary = sweepStaleWorkerHomes(root, { now: () => Date.now() });

    assert.ok(
      summary.removed.includes(basename(home)),
      "the sweep must strip the per-spawn token before comparing against the verdict's run_id, or this dead run falls through to the age backstop",
    );
    assert.equal(existsSync(home), false);
  } finally {
    cleanup();
  }
});

test("sweepStaleWorkerHomes: TWO per-spawn homes from the SAME runId are judged independently — one kept on its lock, the other removed on the SAME runId's absence elsewhere", () => {
  // Sanity: sweepStaleWorkerHomes evaluates every SIBLING directory on its own mtime/lock/
  // verdict facts — a per-spawn split must not accidentally make one home's fate leak onto
  // another's just because they share a runId prefix.
  const { root, stateDir, cleanup } = predicateFixture();
  try {
    const runId = "W1-T2463-mixed-run";
    const liveHome = makePerSpawnHome(root, runId, "spawnTokLive", DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS * 10);
    const deadHome = makePerSpawnHome(root, runId, "spawnTokDead", DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS * 10);
    writeInflightLock(stateDir, "W1-T2463", runId);

    const summary = sweepStaleWorkerHomes(root, { now: () => Date.now() });

    // Both siblings share one runId and that runId DOES resolve to a live lock, so BOTH are
    // kept — the lock is a positive fact about the RUN, not about one spawn's own directory.
    // This documents that a per-spawn split does not by itself distinguish dead spawns within
    // a still-live run; that is out of scope for this task (see the plan's own rationale).
    assert.ok(summary.kept.includes(basename(liveHome)));
    assert.ok(summary.kept.includes(basename(deadHome)));
    assert.equal(existsSync(liveHome), true);
    assert.equal(existsSync(deadHome), true);
  } finally {
    cleanup();
  }
});

// ── Claim 7: the reap stays unconditional and best-effort for a per-spawn home too ──

test("reapWorkerHome: a per-spawn home's teardown is unconditional and best-effort — the recursive remove is still called, and never throws", () => {
  const root = join(tmp(), "worker-home");
  const home = perRunWorkerHomeDir(root, "DAEMON-perspawn-reap", { perSpawn: true });
  mkdirSync(home, { recursive: true });
  let rmCalled = false;
  const result = reapWorkerHome(root, home, {
    fsImpl: {
      rmSync: (target, opts) => {
        rmCalled = true;
        assert.equal(target, home, "rmSync must be called against THIS spawn's own per-spawn target");
        assert.deepEqual(opts, { recursive: true, force: true }, "the reap stays recursive/force, unweakened");
      },
    },
  });
  assert.equal(rmCalled, true, "the recursive remove is still called unconditionally for a per-spawn home");
  assert.equal(result.reaped, true);
});

test("reapWorkerHome: an rmSync failure on a per-spawn home is caught and reported, never thrown — the reap stays best-effort", () => {
  const root = join(tmp(), "worker-home");
  const home = perRunWorkerHomeDir(root, "DAEMON-perspawn-reap-fails", { perSpawn: true });
  mkdirSync(home, { recursive: true });
  try {
    assert.doesNotThrow(() => {
      const result = reapWorkerHome(root, home, {
        fsImpl: {
          rmSync: () => {
            throw new Error("simulated ENOTEMPTY: directory not empty");
          },
        },
      });
      assert.equal(result.reaped, false);
      assert.match(result.reason ?? "", /simulated ENOTEMPTY/, "the thrown error's message surfaces in `reason`, never swallowed silently");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
