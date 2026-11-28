/**
 * test/review/the-daemon-admits-no-new-child-while-its-own-cgroup-throttles-at-memory-high.test.ts — W1-T15116.
 *
 * THE DEFECT. MEASURED 2026-11-27: one sweep pass admitted reviews of four PRs in three seconds, judged against one
 * PSI and MemAvailable reading taken before any child started. Their children (1.4 to 2.0 GB each) held the daemon
 * cgroup at memory.current 18.7 GB over memory.high 17.5 GB for over 80 minutes, and nothing posted.
 *
 * THE FIX. Before each full review it admits, the pass re-reads the daemon cgroup and charges every full review still
 * running here its learned peak until its own child's RSS is visible, then only the peak's unrealized part (the RSS is
 * already in memory.current), and holds a review that would cross memory.high. The child's RSS is read from the pid
 * its launch returned (run-child.ts spawnReview), so the proofs below go through the production postReview and the
 * real createDetachedWorkHost. Room admits every candidate: no count, width or time bound (INVARIANT room-still-admits).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { REPO_ROOT } from "#test/helpers/repo-root.js";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import { readLedgerLines } from "#src/lib/status.js";
import type { ProcessListing } from "#src/lib/host-memory-ledger.js";
import { readReviewTreeResidents, reviewAdmissionCharge } from "#src/lib/host-memory-admission.js";
import {
  initialReviewCapacityState, readDaemonCgroupMemory, reviewMemoryHighVerdict, selectAdaptiveReviewWidth,
  type DaemonCgroupMemoryReading, type ReviewCapacityObservation, type ReviewCapacityPolicy,
} from "#src/lib/review-capacity.js";
import { createDetachedWorkHost, type DetachedWorkSpec, type spawnRunChild } from "#src/lib/run-child.js";
import {
  inFlightFullReviewCount, installDetachedWorkHost, productionReviewMemoryHighReaders, registerChildWork, settleChildWork,
  type BuildSweepEffectsDeps, type ReviewMemoryHighReaders,
} from "#src/lib/sweep.js";
import type { SweepCommandHost } from "#src/cli/commands/sweep.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  withFullSweepRepairAdmission,
  type OpenPrView,
  type SweepDeps,
  type SweepPolicy,
} from "#test/helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// Avoid the argv module's checkout discovery (the run-children suite's own route to the production postReview).
const savedArgv = [...process.argv];
process.argv.push("--repo-root", REPO_ROOT);
const { buildSweepEffects } = await import("#src/cli/commands/sweep.js");
process.argv.splice(0, process.argv.length, ...savedArgv);

const NOW = Date.parse("2026-11-27T09:28:50Z");
const MIB = 1024 * 1024;
const tempDirs: string[] = [];

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

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15116-${label}-`));
  tempDirs.push(dir);
  return dir;
}

interface Harness {
  deps: SweepDeps;
  started: number[];
  reads: number;
  releaseAll: () => void;
}

interface HarnessOptions {
  estimateMib?: number;
  residents?: ReviewMemoryHighReaders["residents"];
  /** The production postReview (through the real detached host); absent, a registry-only stand-in with no pid. */
  postReview?: NonNullable<SweepDeps["postReview"]>;
  selectWidth?: () => number;
}

/** Every review is held running until released, so each admission is judged with the earlier ones still in flight. */
function harness(reading: () => DaemonCgroupMemoryReading, opts: HarnessOptions = {}): Harness {
  const started: number[] = [];
  const gates: Array<() => void> = [];
  const h: Harness = { deps: undefined as unknown as SweepDeps, started, reads: 0, releaseAll: () => gates.splice(0).forEach((g) => g()) };
  const memory: ReviewMemoryHighReaders = {
    read: () => {
      h.reads++;
      return reading();
    },
    estimateMib: () => opts.estimateMib ?? 1_500,
    residents: opts.residents ?? (() => []),
  };
  const dir = tempDir("pass");
  h.deps = withFullSweepRepairAdmission({
    log: () => {},
    arm: () => "armed",
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: opts.postReview ?? (async (p) => {
      started.push(p.prNumber);
      const runId = `t15116-hosted-${p.prNumber}`;
      registerChildWork({ runId, kind: "review", taskId: p.taskId ?? `PR-${p.prNumber}`, prNumber: p.prNumber, headSha: p.headSha });
      gates.push(() => { settleChildWork(runId); });
    }),
    ledgerPath: join(dir, "ledger.ndjson"),
    runId: "SWEEP-T15116-1",
    now: () => NOW,
    reviewMemoryHigh: memory,
    ...(opts.selectWidth === undefined ? {} : { selectAdaptiveReviewWidth: opts.selectWidth }),
  });
  live.push(h);
  return h;
}

/** A drain that waited on a review: the measured cost the host's placement moves a review to a child on. */
const REVIEW_DRAIN = [{ step: "daemon.freshness_drain.completed", duration_ms: 1_000,
  waited_on: [{ what: "review", kind: "review", settled_after_ms: 1_000 }] }];

/**
 * The production review path: the sweep's own postReview (buildSweepEffects), installed with the real
 * createDetachedWorkHost in `on`. Only spawnRunChild is a fixture: it launches nothing and answers a handle with a pid,
 * as the real one does. Each child's tree (the child and one descendant, 1000 + 500 MiB) is listed in a fixture /proc
 * read by the production reader (readReviewTreeResidents) once `show` makes it visible; an unrelated 1500 MiB
 * process is always listed and belongs to no review.
 */
function hostedFleet() {
  const root = tempDir("host");
  mkdirSync(join(root, "state"), { recursive: true });
  const launched: Array<{ prNumber: number; pid: number }> = [];
  const finishers: Array<() => void> = [];
  const visible = new Set<number>();
  let nextPid = 41_000;
  const spawn = (async (input: { work?: DetachedWorkSpec }) => {
    const pid = nextPid++;
    const prNumber = input.work!.prNumber!;
    launched.push({ prNumber, pid });
    let finish!: () => void;
    const settled = new Promise<unknown>((resolve) => { finish = () => resolve(undefined); });
    finishers.push(finish);
    return { started: true, runId: `work-review-t15116-${prNumber}`, dir: join(root, "state", "runs", String(prNumber)), pid,
      settled, abort: async () => ({}) };
  }) as unknown as typeof spawnRunChild;
  installDetachedWorkHost(createDetachedWorkHost({
    stateRoot: join(root, "state"), repoDir: root, root, repo: "fixture", log: () => {}, readMode: () => "on",
    readLedger: () => REVIEW_DRAIN, spawn,
  }));

  const asked: number[][] = [];
  const statusKb = new Map<number, number>([[98_765, 1_500 * 1024]]);
  const listing = (): ProcessListing => ({ complete: true, rows: [
    { pid: 1, parent: 0, start: "1" }, { pid: 98_765, parent: 1, start: "unrelated" },
    ...launched.filter(({ pid }) => visible.has(pid)).flatMap(({ pid }) => [
      { pid, parent: 1, start: `child-${pid}` }, { pid: pid + 500, parent: pid, start: `grandchild-${pid}` },
    ]),
  ] });
  const readFile = (path: string): string => {
    const pid = Number(/^\/proc\/(\d+)\/status$/.exec(path)?.[1]);
    const kb = statusKb.get(pid);
    if (kb === undefined) throw new Error(`ENOENT ${path}`);
    return `Name:\tnode\nVmRSS:\t${kb} kB\n`;
  };
  const residents: ReviewMemoryHighReaders["residents"] = (pids) => {
    asked.push([...pids]);
    return readReviewTreeResidents(pids, { listProcesses: listing, readFile });
  };
  /** The child's tree becomes visible in /proc: 1000 MiB in the child, 500 MiB in its descendant. */
  const show = (): void => {
    for (const { pid } of launched) {
      visible.add(pid);
      statusKb.set(pid, 1_000 * 1024);
      statusKb.set(pid + 500, 500 * 1024);
    }
  };
  /** The daemon cgroup's working set: a base, plus each visible child's 1500 MiB tree. */
  const workingSet = (baseMib: number): number => baseMib + launched.filter(({ pid }) => visible.has(pid)).length * 1_500;

  const config = { root, claudeBin: "/bin/true" } as Config;
  const plan: Plan = { tasks: [], byId: new Map() };
  const noop = (value?: unknown) => () => value;
  const host = {
    USAGE: "fixture usage", buildSweepEffects: noop(), buildInboxDraftHook: noop(), createPlanFilingClassificationTelemetry: noop(),
    buildEscalationTriageRuntime: noop(), refreshEscalationTriageEvidence: noop(), sweepPostFixReverification: noop({ results: [], total: 0, redriven: 0 }),
    tickReadReverificationDeps: noop({}), gitCredentialFixSpawn: noop(() => assert.fail("no fix spawn expected")),
    updatedForWorkflowFromLedger: noop(() => false), buildRereadPrAtAct: noop(), handedOffHeadRiskJudge: noop(), codeScanningJudgeDeps: noop({}),
    sweepEscalationReconcile: noop({}), sweepEscalationTriage: noop(), sweepPrTerminalRung: noop(), runAutomaticBranchReapRung: noop(),
    runTmpSweepRung: noop(), runWorkerTailSweepRung: noop(), runInflightLockSweepRung: noop(), runWorkerStallDetectorRung: noop(),
    runMountRecommenderRung: noop(), fixRungAllowedBesideInFlight: noop(true), inFlightTaskIdsFrom: () => [],
    blockedFixableIsRequeueOnly: () => false, lightPassActionable: () => false, reviewOnlyLightPassDeps: () => ({}),
    freshTreeGit: () => assert.fail("no fresh worktree requested"),
    realDeps: () => ({ reviewWorktree: { addWorktree: () => assert.fail("no review worktree requested") } }),
    buildFreshTreeReviewRunner: () => () => assert.fail("no fresh review requested"),
    buildReviewerCodeFreshnessGate: () => ({ call: () => 17, staleThisPass: () => undefined }),
    buildBaseReproductionProbe: () => () => ({ reproduced: false }), buildImportClosureRead: () => () => [],
    buildRequiredFixReviewRunner: () => () => 0, readyDraftViaGh: () => () => {},
  } as unknown as SweepCommandHost & Required<Pick<SweepCommandHost, "freshTreeGit">>;
  const deps: BuildSweepEffectsDeps = {
    owner: "acme", repo: "fixture", localRepoName: "fixture", config, ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: "SWEEP-T15116-HOST", plan, log: () => {},
  };
  const postReview = buildSweepEffects(host, { ...deps, reviewerCodeFreshnessImpl: () => ({ status: "unreadable", reason: "fixture" }) as never,
    instanceRegistryTextImpl: () => undefined }).postReview!;
  const launchedPrs = (): number[] => launched.map((c) => c.prNumber).sort((a, b) => a - b);
  const fleet = { launched, launchedPrs, asked, residents, show, workingSet, postReview,
    finishAll: () => finishers.splice(0).forEach((f) => f()) };
  fleets.push(fleet);
  return fleet;
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
const fleets: Array<{ finishAll: () => void }> = [];
afterEach(async () => {
  settleChildWork("t15116-child-review");
  live.splice(0).forEach((h) => h.releaseAll());
  fleets.splice(0).forEach((f) => f.finishAll());
  installDetachedWorkHost(undefined);
  await settle();
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
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

test("W1-T15116 criterion 1: through the real host, each child is charged its learned peak until its own RSS is visible", async () => {
  // A 3,000 MiB learned review peak under a 14,000 MiB memory.high, an 8,000 MiB base. Each launched child's tree holds
  // 1,500 MiB once visible, which the working set then contains.
  const fleet = hostedFleet();
  let highMib = 14_000;
  const reading = () => bounded(fleet.workingSet(8_000), highMib);
  const opts = { estimateMib: 3_000, residents: fleet.residents, postReview: fleet.postReview };

  // Pass 1: two admissions through the production postReview and the real createDetachedWorkHost.
  const first = harness(reading, opts);
  await runSweep([eligiblePr(23970, 40), eligiblePr(23971, 30)], first.deps, width(4));
  await settle();
  assert.deepEqual(fleet.launchedPrs(), [23970, 23971], "both reviews launched as children");
  assert.equal(inFlightFullReviewCount(), 2, "each child is still running after postReview returned");
  const pids = fleet.launched.map((c) => c.pid).sort((a, b) => a - b);

  // Pass 2, the children not yet visible in /proc: each keeps its full learned peak. The unrelated 1,500 MiB process
  // offsets nothing. 8,000 + 6,000 + 3,000 = 17,000 > 14,000.
  fleet.asked.length = 0;
  const unseen = harness(reading, opts);
  await runSweep([eligiblePr(23972, 20)], unseen.deps, width(4));
  assert.equal(fleet.launched.length, 2, "held");
  assert.deepEqual([...(fleet.asked.at(-1) ?? [])].sort((a, b) => a - b), pids,
    "the admission reads RSS from the pids spawnReview returned");
  assert.match(standDown(unseen.deps, 23972) ?? "",
    /working set 8000 MiB .* \+ 2 admitted review\(s\) still running charged 6000 MiB \+ this review's learned peak 3000 MiB = 17000 MiB > memory\.high 14000 MiB/);

  // Pass 3, both trees visible (1,500 MiB each, now inside the 11,000 MiB working set): each is charged only its
  // unrealized 1,500 MiB, not its 3,000 MiB peak, so their RSS is never counted twice. 11,000 + 3,000 + 3,000 = 17,000.
  fleet.show();
  const seen = harness(reading, opts);
  await runSweep([eligiblePr(23972, 20)], seen.deps, width(4));
  assert.equal(fleet.launched.length, 2, "still held at 14,000");
  assert.match(standDown(seen.deps, 23972) ?? "",
    /working set 11000 MiB .* \+ 2 admitted review\(s\) still running charged 3000 MiB \(2 measured, their 3000 MiB RSS already in the working set\) \+ this review's learned peak 3000 MiB = 17000 MiB > memory\.high 14000 MiB/);

  // Pass 4 at memory.high 17,000: the measured charge fits exactly. Charging each child its whole peak (20,000) would
  // have held it.
  highMib = 17_000;
  const fits = harness(reading, opts);
  await runSweep([eligiblePr(23972, 20)], fits.deps, width(4));
  await settle();
  assert.deepEqual(fleet.launchedPrs(), [23970, 23971, 23972], "admitted on the measured charge");
  assert.equal(standDown(fits.deps, 23972), undefined);

  fleet.finishAll();
  await settle();
  assert.equal(inFlightFullReviewCount(), 0, "a settled child is no longer charged");
});

test("W1-T15116: child-hosted reviews stay charged after postReview returns", async () => {
  // A hosted child outlives the parent's postReview promise. Its learned peak remains charged until the child settles.
  // The child has posted, so it has freed the ordinary review lane; its memory still contributes to the cgroup.
  registerChildWork({ runId: "t15116-child-review", kind: "review", taskId: "W1-T15116", prNumber: 20969,
    headSha: "child-head", readPhase: () => "review:posted" });
  assert.equal(inFlightFullReviewCount(), 1);
  const h = harness(() => bounded(11_100, 14_000));
  const pass = runSweep(four(), h.deps, width(4));
  await settle();
  assert.deepEqual(h.started, [], "the posted child frees its lane but its 1,500 MiB charge holds this candidate");
  assert.equal(inFlightFullReviewCount(), 1);
  assert.match(standDown(h.deps, 20970) ?? "", /1 admitted review\(s\) still running charged 1500 MiB/);
  settleChildWork("t15116-child-review");
  await pass;
  await settle();
  assert.equal(inFlightFullReviewCount(), 0);
});

test("W1-T15116 criterion 1: a review's charge is its learned peak until its own RSS is read, then the unrealized part", () => {
  assert.deepEqual(reviewAdmissionCharge([undefined], 3_000, undefined), { chargeMib: 3_000, measured: 0, measuredMib: 0 },
    "unseen review retains its learned estimate");
  assert.deepEqual(reviewAdmissionCharge([71], 3_000, [{ pid: 71, mib: 1_500 }]), { chargeMib: 1_500, measured: 1, measuredMib: 1_500 },
    "visible RSS is already in memory.current");
  assert.equal(reviewAdmissionCharge([71, 72], 3_000, [{ pid: 71, mib: 1_500 }]).chargeMib, 4_500, "an unread second tree retains its estimate");
  assert.deepEqual(reviewAdmissionCharge([71], 3_000, [{ pid: 99, mib: 2_900 }]), { chargeMib: 3_000, measured: 0, measuredMib: 0 },
    "an unrelated review-class tree cannot offset this review's estimate");
  assert.equal(reviewAdmissionCharge([71], 1_500, [{ pid: 71, mib: 2_000 }]).chargeMib, 0, "a tree past its peak is charged nothing more");
});

test("W1-T15116: the production reader sums each launched child's own tree from /proc, and nothing else", () => {
  const listing: ProcessListing = { complete: true, rows: [
    { pid: 1, parent: 0, start: "1" }, { pid: 41_000, parent: 1, start: "a" }, { pid: 41_500, parent: 41_000, start: "b" },
    { pid: 98_765, parent: 1, start: "c" },
  ] };
  const kb = new Map([[41_000, 1_000 * 1024], [41_500, 500 * 1024], [98_765, 1_500 * 1024]]);
  const readFile = (path: string): string => {
    const value = kb.get(Number(/^\/proc\/(\d+)\/status$/.exec(path)?.[1]));
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return `VmHWM:\t9 kB\nVmRSS:\t${value} kB\n`;
  };
  assert.deepEqual(readReviewTreeResidents([41_000, 42_000], { listProcesses: () => listing, readFile }), [{ pid: 41_000, mib: 1_500 }],
    "the child and its descendant are summed; a pid not yet listed is absent, so it keeps its learned peak");
  kb.delete(41_500);
  assert.deepEqual(readReviewTreeResidents([41_000], { listProcesses: () => listing, readFile }), [{ pid: 41_000, mib: 1_000 }],
    "an unreadable member adds nothing, which can only raise the charge");
  assert.equal(readReviewTreeResidents([41_000], { listProcesses: () => { throw new Error("EACCES /proc"); }, readFile }), undefined);
  assert.deepEqual(readReviewTreeResidents([], { listProcesses: () => assert.fail("no pid, no listing"), readFile }), []);

  // The default reader is the real /proc: this test process's own RSS reads as a positive tree.
  if (existsSync(`/proc/${process.pid}/status`)) {
    const self = readReviewTreeResidents([process.pid], { listProcesses: () => ({ complete: true, rows: [{ pid: process.pid, parent: 0, start: "self" }] }) });
    assert.equal(self?.length, 1);
    assert.ok((self?.[0]?.mib ?? 0) > 0, JSON.stringify(self));
  }
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

test("W1-T15116 criterion 2: with review children already running, candidates whose real total fits are all admitted", async () => {
  // The reviewer's replay: working set 11,000 MiB including two running 1,500 MiB child reviews, memory.high 14,000, a
  // 1,500 MiB learned peak. The real total with one more is 12,500 and fits; counting the children's RSS a second time
  // (15,500) held it.
  const fleet = hostedFleet();
  const reading = () => bounded(fleet.workingSet(8_000), 14_000);
  const opts = { estimateMib: 1_500, residents: fleet.residents, postReview: fleet.postReview };
  await runSweep([eligiblePr(24970, 40), eligiblePr(24971, 30)], harness(reading, opts).deps, width(4));
  await settle();
  assert.deepEqual(fleet.launchedPrs(), [24970, 24971]);
  fleet.show();
  assert.equal(fleet.workingSet(8_000), 11_000, "the working set holds both children's 1,500 MiB trees");
  assert.equal(inFlightFullReviewCount(), 2);

  // Two more candidates: 11,000 + 0 + 1,500 = 12,500, then 11,000 + 1,500 (the first, not yet launched) + 1,500 =
  // 14,000. Both fit, so both start: no count stands in for the headroom.
  const h = harness(reading, opts);
  await runSweep([eligiblePr(24972, 20), eligiblePr(24973, 10)], h.deps, width(4));
  await settle();
  assert.deepEqual(fleet.launchedPrs(), [24970, 24971, 24972, 24973]);
  assert.equal(standDown(h.deps, 24972), undefined);
  assert.equal(standDown(h.deps, 24973), undefined);
  fleet.finishAll();
  await settle();
});

const CAPACITY_POLICY: ReviewCapacityPolicy = {
  hostWorkerBudget: 16, workerMemoryReserveMib: 1536, healthyWindowSamples: 3, sampleCadenceMs: 60_000, telemetryCadenceMs: 300_000,
  cpuPsiLowPct: 5, memoryPsiLowPct: 5, memoryPsiHighPct: 15, providerAllowancePct: 2, settlementWindowMs: 1_800_000,
  unhealthySettlementThreshold: 2, minHealthySettlements: 1, latencyExpansionRatio: 2,
};

function capacityObservation(over: Partial<ReviewCapacityObservation> = {}): ReviewCapacityObservation {
  return {
    nowMs: NOW, queueDepth: 4, activeWorkers: 0, memAvailableMib: 30_000, cpuPsiSomeAvg10Pct: 1, cpuPsiFullAvg10Pct: 0,
    cpuWeightShare: 1, memoryPsiSomeAvg10Pct: 1, provider: { fresh: true, readable: true, headroomPct: 80, reservePct: 5, ageMs: 1000 },
    settlements: { successes: 2, failures: 0, timeouts: 0 }, ...over,
  };
}

test("W1-T15116 criterion 2: memory-pressure and memory-reserve still shed while memory.high has room", async () => {
  // memory.high has room for all four (4,000 + 4 x 1,500 = 10,000 <= 17,000). The width selector's own sheds still cut
  // the pass: the memory.high admission never widens past them.
  const policy: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, reviewLanes: 4, reviewLaneMin: 1, reviewLaneMax: 4 };
  const cases = [
    [60970, "memory-pressure", { memoryPsiSomeAvg10Pct: 31.4 }],
    [61970, "memory-reserve", { memAvailableMib: 1_000 }],
    [62970, "healthy", {}],
  ] as const;
  for (const [base, expected, over] of cases) {
    const selected = selectAdaptiveReviewWidth(initialReviewCapacityState(4), CAPACITY_POLICY, capacityObservation(over),
      { baseWidth: 4, minWidth: 1, maxWidth: 4 }).decision;
    if (expected === "healthy") assert.equal(selected.effectiveWidth, 4);
    else assert.deepEqual([selected.reason, selected.effectiveWidth], [expected, 3], `${expected} sheds one lane`);
    const h = harness(() => bounded(4_000, 17_000), { selectWidth: () => selected.effectiveWidth });
    const pass = runSweep(four(base), h.deps, policy);
    await settle();
    assert.equal(h.started.length, selected.effectiveWidth, `${expected}: ${h.started.length} started at width ${selected.effectiveWidth}`);
    h.releaseAll();
    await pass;
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

  const ledgerPath = join(tempDir("prod"), "state", "ledger.ndjson");
  assert.equal(productionReviewMemoryHighReaders({ ledgerPath }), undefined, "a caller with no live judge reads no host cgroup");
  const prod = productionReviewMemoryHighReaders({ ledgerPath }, true);
  assert.ok(prod);
  assert.ok(["bounded", "unbounded", "unread"].includes(prod.read().kind));
  assert.ok(prod.estimateMib() > 0, "the review class's learned peak, or its default when unmeasured");
  const residents = prod.residents([process.pid]);
  assert.ok(residents === undefined || residents.every((r) => r.pid === process.pid && r.mib > 0), JSON.stringify(residents));
  assert.deepEqual(prod.residents([]), [], "no launched pid, nothing read");
});
