// W1-T13786: every paced GitHub read waited a fixed 1.5 s, sized in W1-T468 for three tick reads against the
// secondary limit. Measured 2026-11-18 to 2026-11-19, the fleet left 5,000 to 9,000 reads of each hour unspent.
// The read gap is now the larger of the secondary spacing (60,000 ms x instances / 900) and the budget spacing
// (the spendable budget over the time to the reset, at least this process's equal share).
// Every clock here is a fake that only the pacer's sleeps move; no test reads the wall clock.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { clockFromMillisFn } from "#src/lib/clock.js";
import {
  createInstallationBudget, createInstallationBudgetState, ghBudgetReadGapMs, GITHUB_WRITE_RESERVE_FRACTION,
  installationBudgetForThread,
} from "#src/lib/github-installation-budget.js";
import {
  applyGhReadCadence, configureGithubInstallationBudget, createGhCallPacer, DEFAULT_GH_PACE_MIN_GAP_MS,
  DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS, DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS, GH_PACE_LOOP_WAIT_STEP, ghExecFile,
  ghJsonAsync, ghReadCadenceStampPath, githubInstallationBudget, GhPaceFloorStandDownError, GhPaceWouldBlockError,
  paceGhEntryAsync, readGhReadCadenceStampMs, stampGhRead, takeGhPaceLoopWaits, withDaemonGhTransportFloor,
} from "#src/lib/github-transport.js";
import { startProcessInstallationBudget } from "#src/lib/installation-budget-start.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { withGhShim } from "#test/helpers/gh-shim.js";

const START_MS = 1_794_600_000_000;
const LIMIT = 15_000;
const RESERVE = Math.ceil(LIMIT * GITHUB_WRITE_RESERVE_FRACTION);
const FIFTY_MINUTES_S = 3_000;
const HOUR_MS = 3_600_000;
const READ = ["api", "repos/fixture/gap/pulls/1"];

afterEach(() => {
  configureGithubInstallationBudget(undefined);
  takeGhPaceLoopWaits();
});

/** The design's gap, written out: the larger of the secondary spacing and 1 / the read rate. */
function designGapMs(o: { remaining: number; toResetMs: number; shares: number; instances: number; ownReads: number }): number {
  const secondaryMs = 60_000 * o.instances / 900;
  const spendable = o.remaining - RESERVE;
  const sinceStartMs = HOUR_MS - o.toResetMs;
  const othersPerMs = Math.max(0, LIMIT - o.remaining - o.ownReads) / sinceStartMs;
  const perMs = Math.max(spendable / o.toResetMs / o.shares, spendable / o.toResetMs - othersPerMs);
  return Math.ceil(Math.max(secondaryMs, 1 / perMs));
}

/** A process budget on a fake clock, with one reading recorded, and a pacer with no minGapMs on the same clock. */
function budgetScene(o: { remaining: number; toResetS?: number; shares?: number; instances?: number; ownReads?: number }) {
  let now = START_MS;
  const clock = clockFromMillisFn(() => now);
  const shares = o.shares ?? 7;
  const budget = createInstallationBudget({ consumers: shares, instances: o.instances ?? shares, clock });
  configureGithubInstallationBudget(budget);
  const reset = START_MS / 1000 + (o.toResetS ?? FIFTY_MINUTES_S);
  const record = (remaining: number): void => budget.record({ remaining, limit: LIMIT, reset, resource: "core" });
  record(o.remaining);
  for (let i = 0; i < (o.ownReads ?? 0); i++) assert.equal(budget.claimRead().ok, true);
  const sleeps: number[] = [];
  const pass = (ms: number): void => { sleeps.push(ms); now += ms; };
  const pacer = createGhCallPacer({ now: () => now, sleepSync: pass, sleep: async (ms) => pass(ms) });
  return { budget, pacer, sleeps, clock, record, now: () => now, advance: (ms: number) => { now += ms; } };
}

test("W1-T13786 criterion 1: a healthy budget gives the secondary spacing, 467 ms for 7 instances, not 1,500 ms", async () => {
  // 1,000 reads used in the window, all of them this process's own: the others read nothing.
  const s = budgetScene({ remaining: 14_000, ownReads: 1_000 });
  const secondaryMs = Math.ceil(60_000 * 7 / 900);
  assert.equal(secondaryMs, 467);
  assert.equal(s.budget.readGapMs(), secondaryMs);
  for (let i = 0; i < 10; i++) await s.pacer.waitAsync!();
  assert.deepEqual(s.sleeps, Array.from({ length: 9 }, () => secondaryMs), "ten waits leave nine gaps of the secondary spacing");
  assert.notEqual(secondaryMs, DEFAULT_GH_PACE_MIN_GAP_MS);
  assert.ok(DEFAULT_GH_PACE_MIN_GAP_MS / secondaryMs > 3, "reads go about three times as fast as the fixed gap allowed");

  // A process with no installation budget (a hand run, the interactive token) keeps the 1.5 s gap,
  // even with a healthy reading on its unconfigured budget.
  let now = START_MS;
  configureGithubInstallationBudget(createInstallationBudget({ consumers: undefined, clock: clockFromMillisFn(() => now) }));
  githubInstallationBudget().record({ remaining: 14_000, limit: LIMIT, reset: START_MS / 1000 + FIFTY_MINUTES_S, resource: "core" });
  assert.equal(githubInstallationBudget().consumers, undefined);
  const sleeps: number[] = [];
  const unbudgeted = createGhCallPacer({ now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  for (let i = 0; i < 3; i++) await unbudgeted.waitAsync!();
  assert.deepEqual(sleeps, [DEFAULT_GH_PACE_MIN_GAP_MS, DEFAULT_GH_PACE_MIN_GAP_MS], "no budget, no adaptive gap");
  const shared = cadenceScene();
  try {
    applyGhReadCadence(READ, shared.deps);
    assert.deepEqual(shared.waits, [DEFAULT_GH_PACE_MIN_GAP_MS], "the shared gap with no budget is 1.5 s too");
  } finally { rmSync(shared.root, { recursive: true, force: true }); }
});

test("W1-T13786 criterion 2: as the budget runs down the gap never shrinks and follows the equal share", async () => {
  const gaps: number[] = [];
  for (const remaining of [10_000, 5_000, 2_500, 1_700]) {
    // No own reads: everything used so far in the window is the others' spending, at the window's average rate.
    const s = budgetScene({ remaining });
    const gap = s.budget.readGapMs();
    const expected = designGapMs({ remaining, toResetMs: FIFTY_MINUTES_S * 1000, shares: 7, instances: 7, ownReads: 0 });
    assert.equal(gap, expected, `the gap at ${remaining} remaining is 1 / max(S / T / shares, S / T - others' rate)`);
    assert.ok(gap > Math.ceil(60_000 * 7 / 900), "these readings are past the secondary spacing");
    // The pacer waits that gap.
    await s.pacer.waitAsync!();
    await s.pacer.waitAsync!();
    assert.deepEqual(s.sleeps, [gap]);
    gaps.push(gap);
    configureGithubInstallationBudget(undefined);
  }
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] >= gaps[i - 1], `gap ${gaps[i]} after ${gaps[i - 1]} must not shrink`);
  assert.ok(gaps[gaps.length - 1] > DEFAULT_GH_PACE_MIN_GAP_MS, `the last gap ${gaps[gaps.length - 1]} ends above 1,500 ms`);
  // The worked example: S 3,500 over 3,000 s in 7 shares is one read every 6 s.
  assert.ok(Math.abs(gaps[1] - 6_000) <= 1);
});

test("W1-T13786 criterion 3: the floor still stands down, the reserve still refuses and the low-water mark still widens", async () => {
  const s = budgetScene({ remaining: 14_000 });
  const floor = { remaining: Math.floor(LIMIT * 0.02), limit: LIMIT, resource: "core" };
  s.pacer.wait();
  s.pacer.recordResult(false, floor);
  assert.throws(() => s.pacer.wait(), GhPaceFloorStandDownError, "a reading at the floor stops the next wait");
  s.pacer.recordResult(false, floor);
  await assert.rejects(s.pacer.waitAsync!(), GhPaceFloorStandDownError, "and the next awaited wait");

  const reserve = budgetScene({ remaining: RESERVE });
  const refused = reserve.budget.claimRead();
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "reserve", "the admission refuses a read at the write reserve");

  // W1-T12820: with a wait bound, the gap never holds a read longer than that bound, so a read past the
  // share still reaches the admission and stands down at once instead of waiting most of the window.
  const bounded = createInstallationBudget({ consumers: 7, instances: 7, clock: clockFromMillisFn(() => START_MS), maxWaitMs: 60_000 });
  const lowReading = { remaining: 1_700, limit: LIMIT, reset: START_MS / 1000 + FIFTY_MINUTES_S, resource: "core" };
  bounded.record(lowReading);
  assert.equal(ghBudgetReadGapMs({
    reading: lowReading, nowMs: START_MS, shares: 7, instances: 7, ownWindowReads: 0, reserveFraction: GITHUB_WRITE_RESERVE_FRACTION,
  }), 105_000, "unbounded, the equal share at 1,700 remaining is one read every 105 s");
  assert.equal(bounded.readGapMs(), 60_000);
  for (let i = 0; i < 28; i++) assert.equal(bounded.claimRead().ok, true);
  const spent = bounded.claimRead();
  assert.equal(spent.ok, false);
  if (!spent.ok) assert.equal(bounded.resetWaitMs(spent), undefined, "past the share the read stands down, as on origin/main");

  const low = budgetScene({ remaining: 14_000 });
  low.pacer.wait();
  low.pacer.recordResult(false, { remaining: LIMIT * 0.1, limit: LIMIT, resource: "core" });
  low.pacer.wait();
  assert.deepEqual(low.sleeps, [DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS], "a low-water reading widens the gap as before");
});

const secondaryRefusal = (retryAfter?: number): Error => Object.assign(new Error("gh: You have exceeded a secondary rate limit"), {
  stderr: `HTTP 403: You have exceeded a secondary rate limit${retryAfter === undefined ? "" : `\nretry-after: ${retryAfter}`}`,
});
const secondaryLimited = (err: unknown): boolean => /secondary rate limit/.test(String((err as { stderr?: string }).stderr));

test("W1-T13786 criterion 4: a secondary-limit refusal backs off, widens the gap, and a clean result narrows it", async () => {
  for (const retryAfter of [30, undefined]) {
    const s = budgetScene({ remaining: 14_000 });
    let calls = 0;
    const out = await paceGhEntryAsync(s.pacer, secondaryLimited, async () => {
      calls += 1;
      if (calls === 1) throw secondaryRefusal(retryAfter);
      return "made";
    });
    assert.equal(out, "made");
    const [backoff] = s.sleeps;
    const base = retryAfter === undefined ? DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS : retryAfter * 1000;
    assert.ok(backoff >= base && backoff <= base * 1.25, `the retry waits ${backoff} ms: ${base} ms plus at most 25%`);
  }
  for (const retryAfter of [30, undefined]) {
    const s = budgetScene({ remaining: 14_000 });
    const healthyMs = s.budget.readGapMs();
    assert.ok(healthyMs < DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS);
    await assert.rejects(paceGhEntryAsync(s.pacer, secondaryLimited, async () => { throw secondaryRefusal(retryAfter); }, { maxAttempts: 1 }));
    await s.pacer.waitAsync!();
    assert.deepEqual(s.sleeps, [DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS], "the gap after a refusal is the rate-limit gap, not the budget gap");
    assert.equal(await paceGhEntryAsync(s.pacer, secondaryLimited, async () => "clean"), "clean");
    await s.pacer.waitAsync!();
    assert.deepEqual(s.sleeps, [DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS, DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS, healthyMs],
      "a clean result returns the gap to the budget gap");
  }
});

test("W1-T13786 criterion 5: every process on one reading gets the same gap, and never more than its equal share", () => {
  const clock = clockFromMillisFn(() => START_MS);
  const reading = { remaining: 2_500, limit: LIMIT, reset: START_MS / 1000 + 1_200, resource: "core" };
  const daemon = createInstallationBudget({ consumers: 7, instances: 7, clock, sharedState: createInstallationBudgetState() });
  daemon.record(reading);
  const worker = installationBudgetForThread(daemon.threadInput()!, clock);
  for (let i = 0; i < 3; i++) assert.equal(worker.claimRead().ok, true);
  assert.equal(worker.readGapMs(), daemon.readGapMs(), "the daemon and its read worker count as one process");

  const one = createInstallationBudget({ consumers: 7, instances: 7, clock });
  const other = createInstallationBudget({ consumers: 7, instances: 7, clock });
  for (const budget of [one, other]) {
    budget.record(reading);
    for (let i = 0; i < 3; i++) budget.claimRead();
  }
  assert.equal(one.readGapMs(), other.readGapMs(), "two budgets on the same reading and own reads give the same gap");

  // 20 minutes left, 12,500 used in 40 minutes: the others spend far faster than S / T.
  const spendable = reading.remaining - RESERVE;
  const toResetMs = 1_200_000;
  assert.ok((LIMIT - reading.remaining) / (HOUR_MS - toResetMs) > spendable / toResetMs);
  const equalShareMs = Math.ceil(toResetMs * 7 / spendable);
  assert.equal(equalShareMs, 8_400);
  assert.ok(one.readGapMs() <= equalShareMs, `the gap ${one.readGapMs()} is no longer than the equal share`);
  assert.ok(Number.isFinite(one.readGapMs()));
  assert.equal(one.claimRead().ok, true, "the read is still admitted while the reading is above the reserve");
  // One read above the reserve still has a finite gap.
  const edge = createInstallationBudget({ consumers: 7, instances: 7, clock });
  edge.record({ ...reading, remaining: RESERVE + 1 });
  assert.ok(Number.isFinite(edge.readGapMs()));
  assert.equal(edge.readGapMs(), ghBudgetReadGapMs({
    reading: { ...reading, remaining: RESERVE + 1 }, nowMs: START_MS, shares: 7, instances: 7, ownWindowReads: 0,
    reserveFraction: GITHUB_WRITE_RESERVE_FRACTION,
  }));
});

/** A shared read cache in a temp directory that another process stamped at the fake clock's now. */
function cadenceScene(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}read-gap-`));
  const scoped: NodeJS.ProcessEnv = { RMD_GH_CACHE_HOME: root, RMD_GH_TRANSPORT_FLOOR: "advisory", ...env };
  const stamp = ghReadCadenceStampPath(scoped, "core")!;
  stampGhRead(stamp, "advisory\n", START_MS);
  let now = readGhReadCadenceStampMs(stamp)!;
  const waits: number[] = [];
  const deps = { env: scoped, nowMs: () => now, bucketOverride: "core", warn: () => {}, sleepSync: (ms: number) => { waits.push(ms); now += ms; } };
  return { root, env: scoped, stamp, waits, deps };
}

test("W1-T13786 criterion 6: a write claims no read budget, takes no stamp and waits on no read gap", async () => {
  const writes = [
    ["api", "-X", "POST", "repos/o/r/issues/1/comments", "-f", "body=x"],
    ["api", "-X", "PATCH", "repos/o/r/pulls/1", "-f", "title=x"],
    ["api", "-X", "PUT", "repos/o/r/pulls/1/merge"],
    ["api", "-X", "DELETE", "repos/o/r/git/refs/heads/x"],
    ["pr", "merge", "1", "--repo", "o/r"],
  ];
  // floor((1,505 - 1,500) / 4) = one read left before the reset.
  const s = budgetScene({ remaining: RESERVE + 5, shares: 4 });
  const gapBefore = s.budget.readGapMs();
  await withGhShim([{ when: "", stdout: "{}" }], (shim) => {
    const env = { ...process.env, RMD_GH_CACHE_HOME: join(shim.dir, "cache"), RMD_GH_TRANSPORT_FLOOR: "advisory" };
    for (const write of writes) ghExecFile("gh", write, { encoding: "utf8", env });
    assert.equal(shim.calls().length, writes.length, "every write ran");
    assert.equal(s.budget.admit().ok, true, "no write spent the one read left");
    assert.equal(s.budget.readGapMs(), gapBefore, "no write counted as a read in the window");
  });
  for (const write of writes) {
    const c = cadenceScene();
    try {
      const before = readGhReadCadenceStampMs(c.stamp);
      assert.equal(applyGhReadCadence(write, c.deps).allow, true);
      assert.deepEqual(c.waits, [], `${write.join(" ")} waits on no read gap`);
      assert.equal(readGhReadCadenceStampMs(c.stamp), before, `${write.join(" ")} takes no stamp`);
    } finally { rmSync(c.root, { recursive: true, force: true }); }
  }
  const read = cadenceScene();
  try {
    applyGhReadCadence(READ, read.deps);
    assert.deepEqual(read.waits, [gapBefore], "a read in the same scene waits the shared gap");
  } finally { rmSync(read.root, { recursive: true, force: true }); }
});

test("W1-T13786 criterion 7: on the daemon loop a budget gap within 1,500 ms is slept, and a longer one is refused", async () => {
  const short = budgetScene({ remaining: 14_000 });
  const shortGap = short.budget.readGapMs();
  assert.ok(shortGap <= DEFAULT_GH_PACE_MIN_GAP_MS);
  short.pacer.wait();
  await withDaemonGhTransportFloor(() => { short.pacer.wait(); }, {});
  assert.deepEqual(short.sleeps, [shortGap]);
  const rows = takeGhPaceLoopWaits();
  assert.deepEqual(rows.map((row) => [row.step, row.wait_ms]), [[GH_PACE_LOOP_WAIT_STEP, shortGap]], "one loop-wait row for the pacer gap");

  const long = budgetScene({ remaining: 5_000 });
  const longGap = long.budget.readGapMs();
  assert.ok(longGap > DEFAULT_GH_PACE_MIN_GAP_MS);
  long.pacer.wait();
  await withDaemonGhTransportFloor(() => {
    assert.throws(() => long.pacer.wait(), (err: unknown) => err instanceof GhPaceWouldBlockError && err.waitMs === longGap);
  }, {});
  assert.deepEqual(long.sleeps, []);
  assert.deepEqual(takeGhPaceLoopWaits(), [], "a refused wait writes no row");

  // The shared read gap, with no override, on the same bound.
  budgetScene({ remaining: 14_000 });
  const sharedShort = cadenceScene();
  try {
    await withDaemonGhTransportFloor(() => {
      assert.equal(applyGhReadCadence(READ, sharedShort.deps).allow, true);
    }, sharedShort.env);
    assert.deepEqual(sharedShort.waits, [shortGap]);
    assert.deepEqual(takeGhPaceLoopWaits().map((row) => [row.step, row.wait_ms]), [[GH_PACE_LOOP_WAIT_STEP, shortGap]]);
  } finally { rmSync(sharedShort.root, { recursive: true, force: true }); }
  budgetScene({ remaining: 5_000 });
  const sharedLong = cadenceScene();
  try {
    await withDaemonGhTransportFloor(() => {
      assert.throws(() => applyGhReadCadence(READ, sharedLong.deps), (err: unknown) => err instanceof GhPaceWouldBlockError && err.waitMs === longGap);
    }, sharedLong.env);
    assert.deepEqual(sharedLong.waits, []);
    assert.deepEqual(takeGhPaceLoopWaits(), []);
  } finally { rmSync(sharedLong.root, { recursive: true, force: true }); }
});

test("W1-T13786 criterion 8: with RMD_GH_SHARED_READ_GAP_MS unset the shared read gap is the budget gap, and a set value wins", () => {
  for (const remaining of [14_000, 5_000]) {
    const s = budgetScene({ remaining });
    const unset = cadenceScene();
    try {
      assert.equal(applyGhReadCadence(READ, unset.deps).allow, true);
      assert.deepEqual(unset.waits, [s.budget.readGapMs()], `at ${remaining} remaining the shared gap is the budget gap`);
    } finally { rmSync(unset.root, { recursive: true, force: true }); }
    const set = cadenceScene({ RMD_GH_SHARED_READ_GAP_MS: "250" });
    try {
      assert.equal(applyGhReadCadence(READ, set.deps).allow, true);
      assert.deepEqual(set.waits, [250], "the set value is used");
    } finally { rmSync(set.root, { recursive: true, force: true }); }
  }
});

const INSTALLATION = "155256285";
const REGISTRY = [
  "instances:",
  "  core:", "    repo: remudero", "    github_repo: craigoley/remudero", `    gh_app_installation_id: "${INSTALLATION}"`,
  "",
].join("\n");

test("W1-T13786 criterion 9: real ghJsonAsync reads through a gh shim are spaced by the gap their headers give", async () => {
  let now = START_MS;
  const clock = clockFromMillisFn(() => now);
  const rows: string[] = [];
  startProcessInstallationBudget({
    role: "serve", env: { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "core" },
    readRegistry: () => ({ text: REGISTRY, source: "fixture" }), log: (step) => rows.push(step), clock,
  });
  assert.deepEqual(rows, ["github.budget.configured"]);
  const shares = githubInstallationBudget().consumers!;
  const remaining = 5_000;
  const reset = START_MS / 1000 + FIFTY_MINUTES_S;
  const headers = [
    "HTTP/2.0 200 OK", `X-Ratelimit-Remaining: ${remaining}`, `X-Ratelimit-Limit: ${LIMIT}`, `X-Ratelimit-Reset: ${reset}`,
    "X-Ratelimit-Resource: core",
  ].join("\r\n");
  const sleeps: number[] = [];
  const expected: number[] = [];
  const pacer = createGhCallPacer({ now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  const saved = { cache: process.env.RMD_GH_CACHE_HOME, gap: process.env.RMD_GH_SHARED_READ_GAP_MS, floor: process.env.RMD_GH_TRANSPORT_FLOOR };
  await withGhShim([{ when: "api", stdout: `${headers}\r\n\r\n[]` }], async (shim) => {
    process.env.RMD_GH_CACHE_HOME = join(shim.dir, "cache");
    process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
    process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
    try {
      for (let i = 0; i < 4; i++) {
        if (i > 0) expected.push(designGapMs({ remaining, toResetMs: reset * 1000 - now, shares, instances: shares, ownReads: i - 1 }));
        assert.deepEqual(await paceGhEntryAsync(pacer, () => false, () => ghJsonAsync([...READ])), []);
      }
      assert.equal(shim.calls().length, 4, "each read ran the gh shim");
      assert.ok(shim.calls().every((call) => call.includes("-i")), "each read asked for the rate-limit headers");
    } finally {
      for (const [key, value] of [["RMD_GH_CACHE_HOME", saved.cache], ["RMD_GH_SHARED_READ_GAP_MS", saved.gap], ["RMD_GH_TRANSPORT_FLOOR", saved.floor]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  assert.deepEqual(sleeps, expected, "the reads are spaced by the gap the recorded headers give");
  // 4 shares, S 3,500 over 3,000 s: about one read every 3.4 s.
  assert.ok(Math.abs(expected[0] - 3_429) <= 1, `the first gap is ${expected[0]} ms`);
});
