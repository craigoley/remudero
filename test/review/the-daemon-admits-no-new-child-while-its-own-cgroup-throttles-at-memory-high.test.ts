/**
 * test/review/the-daemon-admits-no-new-child-while-its-own-cgroup-throttles-at-memory-high.test.ts — W1-T15116.
 *
 * THE DEFECT. MEASURED 2026-11-27: one sweep pass admitted reviews of four PRs in three seconds, judged against one
 * PSI and MemAvailable reading taken before any child started. Their children (1.4 to 2.0 GB each) held the daemon
 * cgroup at memory.current 18.7 GB over memory.high 17.5 GB for over 80 minutes, and nothing posted.
 *
 * THE FIX. Before each full review it admits, the pass re-reads the daemon cgroup and charges every full review still
 * running here its learned peak (less what its tree already holds), and holds a review that would cross memory.high.
 * Room admits every candidate: no count, width or time bound (INVARIANT room-still-admits).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { readLedgerLines } from "#src/lib/status.js";
import { readDaemonCgroupMemory, reviewMemoryHighVerdict, type DaemonCgroupMemoryReading } from "#src/lib/review-capacity.js";
import { inFlightFullReviewCount, productionReviewMemoryHighReaders, type ReviewMemoryHighReaders } from "#src/lib/sweep.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  withFullSweepRepairAdmission,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "#test/helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-27T09:28:50Z");
const MIB = 1024 * 1024;

function width(n: number): SweepPolicy {
  return { ...DEFAULT_SWEEP_POLICY, reviewLanes: n, reviewLaneMin: n, reviewLaneMax: n };
}

/** Green with no review yet: disposition `post-review`, a full review. */
function eligiblePr(prNumber: number, minutesAgo: number): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    isPlanFiling: false,
    createdAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
  };
}

function bounded(workingSetMib: number, highMib: number): DaemonCgroupMemoryReading {
  return { kind: "bounded", cgroupDir: "/sys/fs/cgroup", highMib, currentMib: workingSetMib, workingSetMib };
}

interface Harness {
  deps: SweepDeps;
  started: number[];
  reads: number;
  releaseAll: () => void;
}

/** Every review is held running until released, so each admission is judged with the earlier ones still in flight. */
function harness(reading: () => DaemonCgroupMemoryReading, estimateMib = 1_500): Harness {
  const started: number[] = [];
  const gates: Array<() => void> = [];
  const h: Harness = { deps: undefined as unknown as SweepDeps, started, reads: 0, releaseAll: () => gates.splice(0).forEach((g) => g()) };
  const memory: ReviewMemoryHighReaders = {
    read: () => {
      h.reads++;
      return reading();
    },
    estimateMib: () => estimateMib,
    residents: () => [], // no tree's resident memory is visible yet: each running review is charged its whole peak
  };
  h.deps = withFullSweepRepairAdmission({
    log: () => {},
    arm: () => "armed",
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: async (p) => {
      started.push(p.prNumber);
      await new Promise<void>((resolve) => gates.push(resolve));
    },
    ledgerPath: join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15116-`)), "ledger.ndjson"),
    runId: "SWEEP-T15116-1",
    now: () => NOW,
    reviewMemoryHigh: memory,
  });
  live.push(h);
  return h;
}

function standDown(deps: SweepDeps, prNumber: number): string | undefined {
  const row = readLedgerLines(deps.ledgerPath).findLast((l) => l.step === "sweep.disposed" && l.pr_number === prNumber);
  return row?.stand_down_reason as string | undefined;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Four reviews of one pass (the 09:28:50Z burst); `base` keeps each test's review keys its own. */
const four = (base = 20970): OpenPrView[] => [eligiblePr(base, 40), eligiblePr(base + 1, 30), eligiblePr(base + 2, 20), eligiblePr(base + 3, 10)];

/** Releases every review a harness still holds when a test ends, pass or fail, so no review leaks into the next test. */
const live: Harness[] = [];
afterEach(async () => {
  live.splice(0).forEach((h) => h.releaseAll());
  await settle();
});

test("W1-T15116 criterion 1: one pass cannot admit reviews past the cgroup's memory.high headroom", async () => {
  // Working set 10,000 MiB under a 14,000 MiB memory.high, a 1,500 MiB review peak: two fit (11,500 then 13,000), the
  // third would read 14,500. One pre-admission reading would have admitted all four.
  const h = harness(() => bounded(10_000, 14_000));
  const pass = runSweep(four(), h.deps, width(4));
  await settle();
  assert.deepEqual(h.started, [20970, 20971], "two reviews fit the headroom; the third is held");
  assert.equal(inFlightFullReviewCount(), 2);
  assert.ok(h.reads >= 3, "the cgroup is re-read for each admission, not once per pass");

  // A later pass while both still run admits none: the running reviews are still charged, whichever pass admitted them.
  const later = harness(() => bounded(10_000, 14_000));
  await runSweep([eligiblePr(21105, 5)], later.deps, width(4));
  assert.deepEqual(later.started, [], "a later pass charges the reviews still running from the earlier one");
  assert.match(standDown(later.deps, 21105) ?? "", /\+ 2 admitted review\(s\) still running charged 3000 MiB/);

  h.releaseAll();
  await pass;
  await settle();
  assert.equal(inFlightFullReviewCount(), 0, "a settled review is no longer charged");
  // The held tail is disposed when its pass ends, each row naming the reading, the charge and memory.high.
  for (const held of [20972, 20973]) {
    const reason = standDown(h.deps, held);
    assert.match(reason ?? "", /held for a later pass: daemon cgroup memory\.high headroom \(W1-T15116\)/);
    assert.match(reason ?? "", /working set 10000 MiB .* \+ 2 admitted review\(s\) still running charged 3000 MiB \+ this review's learned peak 1500 MiB = 14500 MiB > memory\.high 14000 MiB/);
  }

  // Once they settle, the held reviews are admitted on a later pass.
  const next = harness(() => bounded(10_000, 14_000));
  const nextPass = runSweep([eligiblePr(20972, 20), eligiblePr(20973, 10)], next.deps, width(4));
  await settle();
  assert.deepEqual(next.started, [20972, 20973]);
  next.releaseAll();
  await nextPass;
  await settle();
});

test("W1-T15116 criterion 2: a pass with headroom admits every candidate", async () => {
  // Room for every candidate: all four start, with no count, width or time bound standing in.
  const h = harness(() => bounded(4_000, 17_000));
  const pass = runSweep(four(30970), h.deps, width(4));
  await settle();
  assert.deepEqual(h.started, [30970, 30971, 30972, 30973]);
  h.releaseAll();
  await pass;
  await settle();
  for (const pr of four(30970)) assert.equal(standDown(h.deps, pr.prNumber), undefined);

  // memory.high `max` (never throttles) and an unread cgroup both admit exactly as before this task.
  for (const [base, reading] of [[40970, { kind: "unbounded", cgroupDir: "/sys/fs/cgroup" }], [50970, { kind: "unread", reason: "test: no cgroup" }]] as const) {
    const other = harness(() => reading);
    const otherPass = runSweep(four(base), other.deps, width(4));
    await settle();
    assert.deepEqual(other.started, [base, base + 1, base + 2, base + 3], `${reading.kind} admits every candidate`);
    other.releaseAll();
    await otherPass;
    await settle();
  }
});

test("W1-T15116: the verdict charges admitted reviews and the candidate, and names each kind it admitted on", () => {
  assert.deepEqual(reviewMemoryHighVerdict(bounded(1_000, 3_000), { admitted: 1, admittedChargeMib: 1_000, candidateMib: 1_000 }), { admit: true, why: "fits" });
  assert.equal(reviewMemoryHighVerdict(bounded(1_001, 3_000), { admitted: 1, admittedChargeMib: 1_000, candidateMib: 1_000 }).admit, false);
  assert.deepEqual(reviewMemoryHighVerdict({ kind: "unbounded", cgroupDir: "/x" }, { admitted: 9, admittedChargeMib: 9e9, candidateMib: 1 }), { admit: true, why: "unbounded" });
  assert.deepEqual(reviewMemoryHighVerdict({ kind: "unread", reason: "r" }, { admitted: 9, admittedChargeMib: 9e9, candidateMib: 1 }), { admit: true, why: "unread" });
  const withCache = reviewMemoryHighVerdict(
    { kind: "bounded", cgroupDir: "/x", highMib: 100, currentMib: 150, workingSetMib: 120, inactiveFileMib: 30 },
    { admitted: 0, admittedChargeMib: 0, candidateMib: 10 },
  );
  assert.equal(withCache.admit, false);
  assert.match(withCache.admit ? "" : withCache.reason, /working set 120 MiB \(memory\.current 150 MiB, inactive_file 30 MiB\)/);
});

test("W1-T15116: the cgroup reader names every outcome distinctly", () => {
  const files = (map: Record<string, string>) => (path: string): string => {
    const text = map[path];
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  };
  const self = { "/proc/self/cgroup": "0::/system.slice/daemon.scope\n" };
  const dir = "/sys/fs/cgroup/system.slice/daemon.scope";
  const full = { ...self, [`${dir}/memory.high`]: `${17_000 * MIB}\n`, [`${dir}/memory.current`]: `${18_000 * MIB}\n` };

  assert.deepEqual(readDaemonCgroupMemory({ readFile: files({ ...full, [`${dir}/memory.stat`]: `anon 1\ninactive_file ${2_000 * MIB}\n` }) }),
    { kind: "bounded", cgroupDir: dir, highMib: 17_000, currentMib: 18_000, workingSetMib: 16_000, inactiveFileMib: 2_000 });
  assert.deepEqual(readDaemonCgroupMemory({ readFile: files({ ...full, [`${dir}/memory.stat`]: "anon 1\n" }) }),
    { kind: "bounded", cgroupDir: dir, highMib: 17_000, currentMib: 18_000, workingSetMib: 18_000, statUnread: "no inactive_file line in memory.stat" });
  const statUnread = readDaemonCgroupMemory({ readFile: files(full) });
  assert.equal(statUnread.kind, "bounded");
  assert.match(statUnread.kind === "bounded" ? statUnread.statUnread ?? "" : "", /^memory\.stat unreadable: ENOENT/);
  assert.equal(statUnread.kind === "bounded" ? statUnread.workingSetMib : -1, 18_000, "unread cache is never subtracted");

  assert.deepEqual(readDaemonCgroupMemory({ readFile: files({ ...full, [`${dir}/memory.high`]: "max\n" }) }), { kind: "unbounded", cgroupDir: dir });
  assert.match(JSON.stringify(readDaemonCgroupMemory({ readFile: files({}) })), /"unread".*cgroup membership unreadable: ENOENT/);
  assert.deepEqual(readDaemonCgroupMemory({ readFile: files({ "/proc/self/cgroup": "1:name=systemd:/x\n" }) }),
    { kind: "unread", reason: "no cgroup v2 membership line (0::) in the process's cgroup file" });
  assert.match(JSON.stringify(readDaemonCgroupMemory({ readFile: files(self) })), /"unread".*memory\.high or memory\.current unreadable: ENOENT/);
  assert.match(JSON.stringify(readDaemonCgroupMemory({ readFile: files({ ...full, [`${dir}/memory.current`]: "lots\n" }) })),
    /"unread".*is not a byte count/);
  // A private cgroup namespace reads `0::/`: the mount itself.
  assert.equal((readDaemonCgroupMemory({ readFile: files({ "/proc/self/cgroup": "0::/\n" }), cgroupMount: "/m" }) as { reason?: string }).reason?.startsWith("/m/ memory.high"), true);
});

test("W1-T15116: the real reader and the production readers run against this host", () => {
  // The real default: reads this process's own cgroup files, whatever this host has, and returns one of the three kinds.
  const real = readDaemonCgroupMemory();
  assert.ok(["bounded", "unbounded", "unread"].includes(real.kind), JSON.stringify(real));
  if (real.kind === "bounded") assert.ok(real.highMib > 0 && real.workingSetMib >= 0 && real.workingSetMib <= real.currentMib);

  const ledgerPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15116-prod-`)), "state", "ledger.ndjson");
  assert.equal(productionReviewMemoryHighReaders({ ledgerPath }), undefined, "a caller with no live judge reads no host cgroup");
  const live = productionReviewMemoryHighReaders({ ledgerPath }, true);
  assert.ok(live);
  assert.ok(["bounded", "unbounded", "unread"].includes(live.read().kind));
  assert.ok(live.estimateMib() > 0, "the review class's learned peak, or its default when unmeasured");
  const residents = live.residents();
  assert.ok(residents === undefined || Array.isArray(residents));
});
