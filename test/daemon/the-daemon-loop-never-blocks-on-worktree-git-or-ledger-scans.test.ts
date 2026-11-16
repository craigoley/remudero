// W1-T12753: the daemon's lifetime-pressure route and verify-human cadence read the ledger through the async
// readers, the src/ citation grep is an awaited child, and the stall profiler starts at a short fixed onset and
// says what neither the sync-spawn meter nor the profile explains.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import v8 from "node:v8";
import test, { type TestContext } from "node:test";
import type { Config } from "#src/lib/config-schema.js";
import { startLoopStallProfiler } from "#src/lib/loop-stall-profiler.js";
import { loadPlan } from "#src/lib/plan.js";
import { readLedgerLines, taskAttributableLifetimeDispatches } from "#src/lib/status.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { writeLedger, type LedgerRotationFixture } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { productionLifetimePressureHook, readLiveLedgerRowsOffLoop, rowsWithArchivedVerifyHumanVerdicts,
  rowsWithArchivedVerifyHumanVerdictsAsync } from "#test/helpers/run-task-test.js";

type Row = Record<string, unknown>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

/** The longest stretch of `work` in which a 50 ms timer did not fire, counting the call's start and end. */
async function longestTimerGap(work: () => Promise<unknown>): Promise<{ gapMs: number; callMs: number }> {
  const fired: number[] = [];
  const start = performance.now();
  const timer = setInterval(() => fired.push(performance.now()), 50);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  const end = performance.now();
  const points = [start, ...fired, end];
  let gapMs = 0;
  for (let i = 1; i < points.length; i++) gapMs = Math.max(gapMs, points[i]! - points[i - 1]!);
  return { gapMs, callMs: end - start };
}

/** The git this test would run without the slow one ahead of it on PATH. */
function realGit(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "git"))) return join(dir, "git");
  throw new Error("no git on PATH");
}

const RULING = "OPERATOR RULING 2026-11-01: needs_operator";
const SETTLED_RULING = "OPERATOR RULING 2026-11-01: automate";

function attempts(taskId: string): Row[] {
  return [
    { ts: "2026-11-14T10:00:00.000Z", task_id: taskId, run_id: `${taskId}-w1`, step: "run.start" },
    { ts: "2026-11-14T10:05:00.000Z", task_id: taskId, run_id: `${taskId}-w1`, step: "verdict", verdict: "failed", reason: "worker failed" },
  ];
}

/** The lifetime-pressure key the route builds for a task with these rows and one failed verdict. */
function lifetimeKey(taskId: string, rows: Row[], ruling: string): string {
  const [, date, decision] = /^OPERATOR RULING (\S+): (\S+)/.exec(ruling)!;
  return `${taskId}:adaptive-lifetime=${taskAttributableLifetimeDispatches(rows, taskId)}:capacity=0:open=0:merged=0:` +
    `last=verdict:failed:1:ruling=${date}:${decision}`;
}

function filler(prefix: string, count: number, bytes = 150): Row[] {
  const pad = "x".repeat(bytes);
  return Array.from({ length: count }, (_, i) => ({
    ts: `2026-11-1${prefix.length % 9}T00:00:00.${String(i % 1000).padStart(3, "0")}Z`,
    run_id: `${prefix}-${i}`, task_id: `T-FILL-${i % 500}`, step: "daemon.tick", detail: pad,
  }));
}

/** An archive day: `count` rows, every tenth a settled verdict of some other task. */
function archiveWithVerdicts(prefix: string, count: number): Row[] {
  const reason = "y".repeat(450);
  return Array.from({ length: count }, (_, i) => ({
    ts: "2026-11-11T00:00:00.000Z", run_id: `${prefix}-${i}`, task_id: `T-OTHER-${i}`,
    step: i % 10 === 0 ? "verify_human.judged" : "daemon.tick", observed_state: `T-OTHER-${prefix}-${i}:k`,
    judge_decision: "backlog", judge_reason: reason,
  }));
}

/**
 * A state directory the production hook can run on: two tasks under lifetime pressure, T-SETTLED settled by an
 * archived verdict and T-RULED due with an operator ruling, so no judge is ever spawned. Archives are written
 * oldest first (every second one gzipped unless `gzipOdd` is false); the settled verdict sits in the middle one.
 */
function lifetimeFixture(t: TestContext, archives: Row[][], liveFiller: Row[] = [], extraLive: Row[] = [], gzipOdd = true, dir?: string) {
  const live = [...attempts("T-SETTLED"), ...attempts("T-RULED"), ...liveFiller, ...extraLive];
  const settledKey = lifetimeKey("T-SETTLED", live, SETTLED_RULING);
  const verdict = { ts: "2026-11-10T00:00:00.000Z", run_id: "OLD", task_id: "T-SETTLED", step: "verify_human.judged",
    observed_state: settledKey, judge_decision: "automate", judge_reason: "settled earlier" };
  const rotations: LedgerRotationFixture[] = archives.map((rows, i) => ({
    at: `2026-11-0${i + 1}T00:00:00.000Z`, rows: i === Math.floor(archives.length / 2) ? [...rows, verdict] : rows, gz: gzipOdd && i % 2 === 1,
  }));
  const ledger = writeLedger(live, dir === undefined ? { scope: t, rotations } : { dir, rotations });
  mkdirSync(join(ledger.dir, ".remudero"));
  copyFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), join(ledger.dir, ".remudero", "mounts.yaml"));
  mkdirSync(join(ledger.dir, "state"));
  const task = (id: string, note: string) =>
    `- id: ${id}\n  title: ${id} feature\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  note: ${JSON.stringify(note)}\n`;
  writeFileSync(join(ledger.dir, "tasks.yaml"), task("T-SETTLED", SETTLED_RULING) + task("T-RULED", RULING));
  const plan = loadPlan(join(ledger.dir, "tasks.yaml"));
  const hook = productionLifetimePressureHook({
    plan: () => plan, root: ledger.dir, config: { root: ledger.dir } as Config, ledgerPath: ledger.path, runId: "T12753-TEST",
  });
  const tasks = [plan.byId.get("T-SETTLED")!, plan.byId.get("T-RULED")!];
  const proposals = () => {
    const path = join(ledger.dir, "state", "inbox-proposals.json");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  return { ledger, run: () => hook(tasks), settledKey, proposals, liveCount: live.length };
}

/** What the route wrote: T-RULED judged by its ruling and staged for the operator; T-SETTLED left alone. */
function assertRouteEffects(f: ReturnType<typeof lifetimeFixture>): void {
  const written = [...readLedgerLines(f.ledger.path)].slice(f.liveCount);
  assert.deepEqual(written.map((row) => [row.step, row.task_id, row.judge_decision]),
    [["verify_human.judged", "T-RULED", "needs_operator"]]);
  assert.match(String(written[0]!.observed_state), /^T-RULED:adaptive-lifetime=1:.*:ruling=2026-11-01:needs_operator$/);
  assert.match(f.proposals(), /T-RULED/);
  assert.doesNotMatch(f.proposals(), /T-SETTLED/);
}

test("W1-T12753 criterion 1: the lifetime-pressure hook reads 50 MB of archives and the live ledger with the loop free", async (t) => {
  // Five ~11 MB archives in which every tenth row is another task's verdict, as on the core ledger, so the sync union
  // read parses ~10,000 rows (about 2.7 s on the Azure host), and a ~5 MB live ledger.
  const f = lifetimeFixture(t, Array.from({ length: 5 }, (_, i) => archiveWithVerdicts(`A${i}`, 20_000)), filler("L", 2_500, 2_000), [], false);
  const archiveBytes = readdirSync(f.ledger.dir).filter((name) => /^ledger\..+\.ndjson(?:\.gz)?$/.test(name))
    .reduce((sum, name) => sum + statSync(join(f.ledger.dir, name)).size, 0);
  assert.ok(archiveBytes >= 50_000_000, `archives hold ${archiveBytes} bytes`);
  const { gapMs, callMs } = await longestTimerGap(f.run);
  assert.ok(gapMs <= 500, `the loop was held ${Math.round(gapMs)} ms in a ${Math.round(callMs)} ms call`);
  assertRouteEffects(f);
});

test("W1-T12753 criterion 2: the async route reads the same rows in the same order as the sync readers", async (t) => {
  const replayed = { ts: "2026-11-09T00:00:00.000Z", run_id: "R", task_id: "T-OTHER", step: "verify_human.judged",
    observed_state: "T-OTHER:k", judge_decision: "backlog", judge_reason: "replayed" };
  const f = lifetimeFixture(t, [[replayed, ...filler("B0", 50)], filler("B1", 50), [replayed, ...filler("B2", 50)]],
    filler("L", 30), [replayed]);
  writeFileSync(f.ledger.path, `${readFileSync(f.ledger.path, "utf8")}{"torn\n`);
  const live = [...readLedgerLines(f.ledger.path)];
  // The live file: readLedgerLines' rows, the torn line dropped, in file order.
  assert.deepEqual(await readLiveLedgerRowsOffLoop(f.ledger.path), live);
  assert.deepEqual(await readLiveLedgerRowsOffLoop(join(f.ledger.dir, "absent.ndjson")), []);
  // The verdicts: archived verify_human.judged rows first, live rows last, exactly as the sync reader returns them.
  const sync = rowsWithArchivedVerifyHumanVerdicts(f.ledger.path, live);
  const async = await rowsWithArchivedVerifyHumanVerdictsAsync(f.ledger.path, live);
  assert.deepEqual(async, sync);
  assert.equal(async[0]!.step, "verify_human.judged");
  assert.deepEqual(async.slice(-live.length), live);
  assert.ok(async.some((row) => row.observed_state === f.settledKey), "the archived settled verdict is read");
  // The route stages and writes what it did with the sync readers.
  await f.run();
  assertRouteEffects(f);
});

test("W1-T12753 criterion 3: the src/ citation grep is an awaited child, so the loop runs while git greps", async (t) => {
  const bin = ownedFixtureDir(t, "slow-git").dir;
  const git = join(bin, "git");
  // Only `git grep` is slow (and finds nothing); every other git call is the real one.
  writeFileSync(git, `#!/bin/sh\ncase " $* " in *" grep "*) sleep 2; exit 1;; esac\nexec ${realGit()} "$@"\n`);
  chmodSync(git, 0o755);
  // The checkout is a real repository, so the hardened leaf pins it and runs the grep.
  const f = lifetimeFixture(t, [filler("C0", 20)], [], [], true, gitRepo({ scope: t }).dir);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  try {
    const { gapMs, callMs } = await longestTimerGap(f.run);
    assert.ok(callMs >= 2000, `the slow git ran: ${Math.round(callMs)} ms`);
    // Each sync grep would hold the loop its whole 2 s; a spawn itself may hold it briefly on a loaded host.
    assert.ok(gapMs < 1000, `the loop was held ${Math.round(gapMs)} ms while git slept`);
  } finally {
    process.env.PATH = path;
  }
  // Exit 1 is git grep's "no match": the route still judges T-RULED as not cited.
  assertRouteEffects(f);
});

// THE LIVE PROFILER TESTS COME LAST: they enable V8's Profiler domain, whose session resets this process's precise
// coverage when it disconnects (v8.takeCoverage() first keeps what was measured).

/** The stalling function the profile must name. */
function spinPastTheOnset(): number {
  let x = 0;
  for (let i = 0; i < 2e5; i++) x += (i * 31) % 7;
  return x;
}

function holdTheLoop(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) Array.from({ length: 50 }, spinPastTheOnset);
}

test("W1-T12753 criterion 6: a 5 s stall under a 100 s learned bound is profiled from a short fixed onset", async () => {
  const rows: Row[] = [];
  const profiler = startLoopStallProfiler();
  try {
    for (let i = 0; i < 10; i++) profiler.observe({ lagMs: 99_960, intervalMs: 40 }, (step, extra) => rows.push({ step, ...extra }));
    assert.equal(profiler.boundMs(), 100_000);
    assert.equal(await profiler.ready(), true);
    await sleep(200);
    holdTheLoop(5000);
    const row = await waitFor(() => rows.find((r) => r.step === "daemon.loop_stall_profile"));
    assert.equal(row.bound_ms, 100_000);
    assert.ok(Number(row.unprofiled_ms) < 2000, `unprofiled_ms ${row.unprofiled_ms}`);
    assert.ok(Number(row.lag_ms) >= 4000, `lag_ms ${row.lag_ms}`);
    const frames = row.top_frames as Array<{ function: string }>;
    assert.ok(frames.some((frame) => frame.function === "spinPastTheOnset"), JSON.stringify(frames));
  } finally {
    v8.takeCoverage();
    profiler.stop();
  }
});

test("W1-T12753 criterion 7: unattributed_ms is the lag neither the meter nor the profile explains", async () => {
  const rows: Row[] = [];
  const profiler = startLoopStallProfiler({ takeSyncSpawnMs: () => 0 });
  try {
    profiler.observe({ lagMs: 1, intervalMs: 40 }, (step, extra) => rows.push({ step, ...extra }));
    assert.equal(await profiler.ready(), true);
    await sleep(200);
    holdTheLoop(3000);
    const row = await waitFor(() => rows.find((r) => r.step === "daemon.loop_stall_profile"));
    const lagMs = Number(row.lag_ms);
    assert.ok(lagMs >= 2500, `lag_ms ${lagMs}`);
    assert.equal(row.unattributed_ms, Math.max(0, lagMs - Number(row.sync_spawn_ms) - Number(row.profiled_ms)));
    // The lag the profile cannot explain is the stall's head before the first chunk began (the onset plus however
    // long this host took to open the inspector session: `unprofiled_ms`, which a loaded CI runner stretches to
    // hundreds of ms) plus its tail (the watchdog's next tick and the final stop after the loop freed), which a
    // loaded host stretches too. Neither is a fixed fraction of the lag, so each is bounded by half the lag and the
    // pair together by three quarters: a profile that explains nothing (unattributed = lag) still fails both.
    const unprofiledMs = Number(row.unprofiled_ms);
    assert.ok(unprofiledMs < lagMs / 2, `unprofiled_ms ${unprofiledMs} of lag ${lagMs}: the profile began late`);
    assert.ok(Number(row.unattributed_ms) <= unprofiledMs + lagMs / 4,
      `unattributed_ms ${row.unattributed_ms} exceeds the unprofiled head ${unprofiledMs} plus a quarter of lag ${lagMs}`);
  } finally {
    v8.takeCoverage();
    profiler.stop();
  }
});
