// W1-T12230: the freshness restart scores each commit of an advance by the code it affects: a review's paths, the
// daemon loop's import closure, or code only a worker loads.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { freshnessRestartOpts } from "#src/cli/commands/daemon.js";
import { runDaemon, type DaemonFreshness, type DaemonOpts } from "#src/lib/daemon.js";
import { judgeAdvanceByClosure, type DaemonClosure } from "#src/lib/daemon-closure.js";
import {
  coalesceFreshnessRestart,
  countFreshnessChangeClasses,
  decideFreshnessRestart,
  FRESHNESS_COALESCE_WINDOW_MS,
  FRESHNESS_LOOP_ONLY_HORIZON_MS,
  freshnessAdvanceWorth,
  INSTALL_INPUTS_RELEASE,
  type DeployWorthChange,
} from "#src/lib/deploy-judge.js";
import { loadPlan } from "#src/lib/plan.js";
import { loadPolicy, policyPath, PolicyError, validatePolicy } from "#src/lib/policy.js";
import { classifyAdvanceCommit, daemonFreshnessFromService, type AdvanceClosure, type ServiceFreshness } from "#src/lib/self-sync.js";
import { trackInFlightReview } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LIMIT = { value: 18, reason: "test" };
const T0 = Date.parse("2026-11-24T00:00:00Z");
const fresh = () => ({ total: 0, scoredShas: [] as string[] });
const sha = (tag: string) => tag.padEnd(40, "0");

const reviewer: DeployWorthChange = { sha: sha("a1"), subject: "fix: review", files: ["src/lib/review.ts"], changeClass: "reviewer" };
const loop: DeployWorthChange = { sha: sha("b2"), subject: "fix: loop", files: ["src/lib/daemon.ts"], changeClass: "loop" };
const workerOnly: DeployWorthChange = { sha: sha("c3"), subject: "fix: worker", files: ["scripts/a.mjs"], changeClass: "worker_only" };

/** A clean assessment one advance behind, whose closure reading names `inside`. */
function behind(changes: Array<{ sha: string; files: string[] }>, closure: AdvanceClosure | undefined): ServiceFreshness {
  const changedPaths = [...new Set(changes.flatMap((change) => change.files))];
  return {
    status: "assessed", dirty: false,
    behind: { oldSha: sha("e0"), newSha: changes[0]!.sha, changedPaths, changes, ...(closure ? { closure } : {}) },
  };
}

test("W1-T12230 criterion 1: each commit of an advance gets one class, and a commit that cannot be classed is loop", () => {
  const inside: AdvanceClosure = { status: "read", material: true, outside: 2, inside: ["src/lib/daemon.ts"] };
  assert.equal(classifyAdvanceCommit(["src/lib/review.ts", "src/lib/daemon.ts"], inside), "reviewer", "a review path wins");
  assert.equal(classifyAdvanceCommit(["package-lock.json"], inside), "reviewer");
  assert.equal(classifyAdvanceCommit(["src/lib/daemon.ts", "test/x.test.ts"], inside), "loop", "a file in the closure");
  assert.equal(classifyAdvanceCommit(["scripts/a.mjs"], inside), "worker_only");
  assert.equal(classifyAdvanceCommit(["src/lib/worker-only.ts", "docs/x.md"], inside), "worker_only");
  // A read verdict that the whole advance missed the closure: no commit of it is in the closure.
  assert.equal(classifyAdvanceCommit(["src/lib/x.ts"], { status: "read", material: false, outside: 1 }), "worker_only");
  // Cannot be classed: each fails toward a restart.
  assert.equal(classifyAdvanceCommit(["src/lib/x.ts"], { status: "unreadable", reason: "no tree" }), "loop", "unreadable closure");
  assert.equal(classifyAdvanceCommit(["scripts/a.mjs"], undefined), "loop", "no closure reading");
  assert.equal(classifyAdvanceCommit(["src/lib/x.ts"], { status: "read", material: true, outside: 1 }), "loop", "met, no inside list");
  assert.equal(classifyAdvanceCommit([], inside), "loop", "no files");
  assert.equal(classifyAdvanceCommit([" "], inside), "loop", "a blank file");
  assert.equal(classifyAdvanceCommit(["docs/x.md"], inside), "loop", "none of the three rules fits");

  // The production closure verdict records `inside`, so a commit of a material advance is classed by its own files.
  const closureAt = (tag: string, paths: string[]): DaemonClosure =>
    ({ status: "read", sha: sha(tag), entry: "src/cli/index.ts", paths: new Set(paths) });
  const verdict = judgeAdvanceByClosure(["src/lib/daemon.ts", "src/lib/worker-only.ts"],
    closureAt("e0", ["src/lib/daemon.ts"]), closureAt("f1", ["src/lib/daemon.ts"]));
  assert.deepEqual(verdict, { status: "read", material: true, outside: 1, inside: ["src/lib/daemon.ts"] });
  assert.equal(classifyAdvanceCommit(["src/lib/worker-only.ts"], verdict), "worker_only", "outside the closure of a material advance");
  assert.equal(classifyAdvanceCommit(["src/lib/daemon.ts"], verdict), "loop");
  // A module the advance adds is in the new side's closure, one it deletes in the old side's.
  const added = judgeAdvanceByClosure(["src/lib/new.ts", "src/lib/gone.ts"], closureAt("e0", ["src/lib/gone.ts"]), closureAt("f1", ["src/lib/new.ts"]));
  assert.equal(classifyAdvanceCommit(["src/lib/new.ts"], added), "loop");
  assert.equal(classifyAdvanceCommit(["src/lib/gone.ts"], added), "loop");
  const missed = judgeAdvanceByClosure(["scripts/a.mjs"], closureAt("e0", ["src/lib/daemon.ts"]), closureAt("f1", ["src/lib/daemon.ts"]));
  assert.deepEqual(missed, { status: "read", material: false, outside: 1, inside: [] });
  assert.equal(classifyAdvanceCommit(["scripts/a.mjs"], missed), "worker_only");

  // The freshness reading carries the class on each change, on the stale arm and the dirty arm alike.
  const commits = [
    { sha: sha("a1"), files: ["src/lib/review.ts"] },
    { sha: sha("b2"), files: ["src/lib/daemon.ts"] },
    { sha: sha("c3"), files: ["scripts/a.mjs"] },
  ];
  const read = daemonFreshnessFromService(behind(commits, { status: "read", material: true, outside: 2, inside: ["src/lib/daemon.ts"] }));
  assert.equal(read.stale, true);
  assert.deepEqual((read as { changes: Array<{ changeClass?: string }> }).changes.map((change) => change.changeClass), ["reviewer", "loop", "worker_only"]);
  const unread = daemonFreshnessFromService(behind(commits, { status: "unreadable", reason: "no tree" }));
  assert.deepEqual((unread as { changes: Array<{ changeClass?: string }> }).changes.map((change) => change.changeClass), ["reviewer", "loop", "loop"]);
  const dirty = daemonFreshnessFromService({ ...behind(commits, { status: "unreadable", reason: "no tree" }), dirty: true, dirty_paths: ["x"] } as ServiceFreshness);
  assert.equal(dirty.stale, false);
  assert.deepEqual((dirty.notStale as { changes: Array<{ changeClass?: string }> }).changes.map((change) => change.changeClass), ["reviewer", "loop", "loop"]);
  // No closure reading: the commits stay unclassed, which the judge counts as loop.
  const unclassed = daemonFreshnessFromService(behind(commits, undefined));
  assert.deepEqual((unclassed as { changes: Array<{ changeClass?: string }> }).changes.map((change) => change.changeClass), [undefined, undefined, undefined]);
  assert.deepEqual(countFreshnessChangeClasses((unclassed as { changes: DeployWorthChange[] }).changes), { reviewer: 0, loop: 3, worker_only: 0 });
});

test("W1-T12230 criterion 2: a worker_only commit adds no change pressure, a reviewer and a loop commit add 1 each", () => {
  assert.equal(freshnessAdvanceWorth(workerOnly).score, 0);
  assert.equal(freshnessAdvanceWorth(reviewer).score, 1);
  assert.equal(freshnessAdvanceWorth(loop).score, 1);
  assert.equal(freshnessAdvanceWorth({ ...loop, changeClass: undefined }).score, 1, "an unclassed commit scores as today");
  const decide = (changes: DeployWorthChange[]) => decideFreshnessRestart({ changes, busy: true, staleSinceMs: T0, nowMs: T0, state: fresh(), threshold: LIMIT });
  assert.equal(decide([reviewer, loop, workerOnly]).weight, 2);
  assert.equal(decide([workerOnly, { ...workerOnly, sha: sha("c4") }]).weight, 0);
  assert.equal(decide([reviewer, loop]).weight, 2);
  assert.deepEqual(decideFreshnessRestart({ changes: [reviewer, loop, workerOnly], busy: true, staleSinceMs: T0, nowMs: T0, state: fresh(),
    threshold: LIMIT, loopOnlyHorizonMs: HOUR }).changeClasses, { reviewer: 1, loop: 1, worker_only: 1 });
});

test("W1-T12230 criterion 3: a loop-only advance reaches the score limit at loopOnlyHorizonMs, not at stalenessHorizonMs", () => {
  const horizons = { threshold: LIMIT, ageHorizonMs: HOUR, loopOnlyHorizonMs: 3 * HOUR };
  const at = (nowMs: number, changes: DeployWorthChange[]) =>
    decideFreshnessRestart({ changes, busy: true, staleSinceMs: T0, nowMs, state: fresh(), ...horizons });
  const atStaleness = at(T0 + HOUR, [loop, workerOnly]);
  assert.equal(atStaleness.agePressure, 6, "one hour of three");
  assert.equal(atStaleness.horizonMs, 3 * HOUR);
  assert.equal(atStaleness.action, "defer");
  assert.equal(at(T0 + 3 * HOUR - 1, [loop]).agePressure, 17);
  const atLoopHorizon = at(T0 + 3 * HOUR, [loop, workerOnly]);
  assert.equal(atLoopHorizon.agePressure, 18);
  assert.equal(atLoopHorizon.action, "restart");
  // Control: the same advance with a reviewer commit reaches it at the staleness horizon.
  assert.equal(at(T0 + HOUR, [loop, reviewer]).agePressure, 18);
  // Only worker_only commits: no staleness part at all.
  assert.equal(at(T0 + 10 * HOUR, [workerOnly]).agePressure, 0);
  // Without the row the judge keeps one horizon, as before.
  assert.equal(decideFreshnessRestart({ changes: [loop], busy: true, staleSinceMs: T0, nowMs: T0 + HOUR, state: fresh(), threshold: LIMIT, ageHorizonMs: HOUR }).agePressure, 18);
  // The coalescer's upper_age release takes the decision's horizon.
  const coalesce = (decision: ReturnType<typeof at>, nowMs: number) => coalesceFreshnessRestart({
    decision: { ...decision, action: "restart", restartTrigger: "change" }, newSha: loop.sha, lastAdvanceAtMs: nowMs, staleSinceMs: T0, nowMs,
    window: FRESHNESS_COALESCE_WINDOW_MS, threshold: LIMIT, ageHorizonMs: decision.horizonMs, lifetimeStartedAtMs: T0 - 24 * HOUR,
  });
  assert.notEqual(coalesce(atStaleness, T0 + HOUR).reason, "upper_age", "an hour is a third of the loop-only horizon");
  assert.equal(coalesce(at(T0 + 90 * MINUTE, [loop]), T0 + 90 * MINUTE).reason, "upper_age", "half of it releases");
});

type Row = { step: string; extra: Record<string, unknown>; atMs: number };

/** A busy daemon (an in-flight review) on a fake clock: each sleep moves it `stepMs`, and `read` gives the reading. */
async function busyDaemon(read: (nowMs: number) => DaemonFreshness, opts: DaemonOpts, stepMs: number): Promise<Row[]> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}restart-classes-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let release!: () => void;
  void trackInFlightReview(new Promise<void>((resolve) => { release = resolve; }), { taskId: "A", prNumber: 1 });
  let nowMs = T0;
  const rows: Row[] = [];
  try {
    const summary = await Promise.race([
      runDaemon(loadPlan(path), {
        ...hostIndependentDaemonDeps(),
        refreshMerged: () => () => true,
        runOne: async (taskId) => ({ taskId, runId: "unused", merged: true, costUsd: 0, verdict: "merged" }),
        now: () => new Date(nowMs),
        sleep: async () => { nowMs += stepMs; if (nowMs > T0 + 24 * HOUR) release(); },
        sweep: async () => ({}),
        checkFreshness: () => read(nowMs),
        readLedgerLines: () => [],
        log: (step, extra = {}) => {
          rows.push({ step, extra, atMs: nowMs });
          if (step === "daemon.freshness_decision" && extra.action === "restart") setTimeout(release, 5);
        },
      }, { sweepWallClockBoundMs: 24 * HOUR, freshnessMinLifetimeMs: 0, freshnessQuietWindowMs: 0, freshnessScoreLimit: 18, ...opts }),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 5_000)),
    ]);
    assert.notEqual(summary, "timed-out");
  } finally {
    release();
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}
const decisions = (rows: Row[]) => rows.filter((row) => row.step === "daemon.freshness_decision");

test("W1-T12230 criterion 3: the policy row loopOnlyHorizonMs reaches runDaemon through the daemon command's options", async () => {
  const raw = parseYaml(readFileSync(policyPath(REPO_ROOT), "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
  raw.freshnessRestart!.stalenessHorizonMs = { ...raw.freshnessRestart!.stalenessHorizonMs!, value: HOUR };
  raw.freshnessRestart!.loopOnlyHorizonMs = { ...raw.freshnessRestart!.loopOnlyHorizonMs!, value: 3 * HOUR };
  const opts = freshnessRestartOpts(validatePolicy(raw).values.freshnessRestart);
  assert.equal(opts.freshnessStalenessHorizonMs, HOUR);
  assert.equal(opts.freshnessLoopOnlyHorizonMs, 3 * HOUR, "the daemon command passes the row on");
  const shipped = freshnessRestartOpts(loadPolicy(policyPath(REPO_ROOT)).values.freshnessRestart);
  assert.equal(shipped.freshnessLoopOnlyHorizonMs, FRESHNESS_LOOP_ONLY_HORIZON_MS, "the shipped row reaches the daemon");
  const reading = (): DaemonFreshness => ({ stale: true, oldSha: sha("e0"), newSha: loop.sha, changes: [loop] });
  const rows = decisions(await busyDaemon(reading, opts, 30 * MINUTE));
  const restart = rows.find((row) => row.extra.action === "restart")!;
  assert.equal(restart.atMs - T0, 3 * HOUR, "a loop-only advance restarts at the policy row, not at stalenessHorizonMs");
  assert.equal(restart.extra.horizon_ms, 3 * HOUR);
  assert.ok(rows.some((row) => row.atMs - T0 === HOUR && row.extra.action === "defer"), "an hour in, it still defers");
});

test("W1-T12230 criterion 4: with a reviewer commit the staleness reaches the score limit at stalenessHorizonMs after its first read", async () => {
  // Pure: the reviewer part runs from when the daemon first read that commit, not from the first stale reading.
  const decide = (nowMs: number) => decideFreshnessRestart({
    changes: [loop, reviewer], busy: true, staleSinceMs: T0, nowMs, state: fresh(), threshold: LIMIT,
    ageHorizonMs: HOUR, loopOnlyHorizonMs: 3 * HOUR, classSinceMs: { loop: T0, reviewer: T0 + 30 * MINUTE },
  });
  assert.equal(decide(T0 + HOUR).agePressure, 9, "30 minutes of the reviewer's hour beats 60 of the loop's three");
  assert.equal(decide(T0 + 90 * MINUTE).agePressure, 18);
  assert.equal(decide(T0 + 90 * MINUTE).horizonMs, HOUR);

  // runDaemon: a loop commit read at T0, a reviewer commit first read 30 minutes later.
  const reading = (nowMs: number): DaemonFreshness => {
    const changes = nowMs >= T0 + 30 * MINUTE ? [reviewer, loop] : [loop];
    return { stale: true, oldSha: sha("e0"), newSha: changes[0]!.sha, changes };
  };
  const rows = decisions(await busyDaemon(reading, { freshnessStalenessHorizonMs: HOUR, freshnessLoopOnlyHorizonMs: 3 * HOUR }, 30 * MINUTE));
  const byTime = new Map(rows.map((row) => [row.atMs - T0, row.extra]));
  assert.equal(byTime.get(60 * MINUTE)?.age_pressure, 9, "an hour after the first stale reading, half an hour after the reviewer commit");
  assert.equal(byTime.get(60 * MINUTE)?.horizon_ms, HOUR);
  assert.equal(byTime.get(60 * MINUTE)?.action, "defer");
  const restart = rows.find((row) => row.extra.action === "restart")!;
  assert.equal(restart.atMs - T0, 90 * MINUTE, "one staleness horizon after the reviewer commit was first read");
  assert.equal(restart.extra.age_pressure, 18);
  assert.equal(restart.extra.horizon_ms, HOUR);
});

test("W1-T12230 criterion 5: freshnessRestart has the bounded row loopOnlyHorizonMs, never below stalenessHorizonMs", () => {
  const text = readFileSync(policyPath(REPO_ROOT), "utf8");
  assert.match(text, /^ {2}loopOnlyHorizonMs: \{ value: 14400000, origin: "lifted:src\/lib\/deploy-judge\.ts \(FRESHNESS_LOOP_ONLY_HORIZON_MS\)", min: 3600000, max: 43200000 \}$/m);
  const policy = loadPolicy(policyPath(REPO_ROOT));
  const rows = policy.values.freshnessRestart;
  assert.equal(rows.loopOnlyHorizonMs, FRESHNESS_LOOP_ONLY_HORIZON_MS);
  assert.ok(rows.loopOnlyHorizonMs! >= rows.stalenessHorizonMs);
  assert.deepEqual(policy.bounds["freshnessRestart.loopOnlyHorizonMs"], { min: 3_600_000, max: 43_200_000 });
  const withRows = (values: Record<string, number>) => {
    const raw = parseYaml(text) as Record<string, Record<string, Record<string, unknown>>>;
    for (const [key, value] of Object.entries(values)) raw.freshnessRestart![key] = { ...raw.freshnessRestart![key]!, value };
    return raw;
  };
  const refused = (values: Record<string, number>, pattern: RegExp) =>
    assert.throws(() => validatePolicy(withRows(values)), (e: unknown) => e instanceof PolicyError && pattern.test(e.message), JSON.stringify(values));
  // The record's 3 h sits below the shipped 4 h staleness horizon, so the loader refuses it.
  refused({ loopOnlyHorizonMs: 10_800_000 }, /loopOnlyHorizonMs\.value' \(10800000\) is below freshnessRestart\.stalenessHorizonMs \(14400000\)/);
  refused({ loopOnlyHorizonMs: 3_599_999 }, /out of its declared bound/);
  refused({ loopOnlyHorizonMs: 43_200_001 }, /out of its declared bound/);
  assert.equal(validatePolicy(withRows({ stalenessHorizonMs: 3_600_000, loopOnlyHorizonMs: 10_800_000 })).values.freshnessRestart.loopOnlyHorizonMs, 10_800_000);
  assert.equal(validatePolicy(withRows({ loopOnlyHorizonMs: 14_400_000 })).values.freshnessRestart.loopOnlyHorizonMs, 14_400_000, "equal is accepted");
  const absent = parseYaml(text) as Record<string, Record<string, unknown>>;
  delete absent.freshnessRestart!.loopOnlyHorizonMs;
  assert.equal(validatePolicy(absent).values.freshnessRestart.loopOnlyHorizonMs, undefined, "absent, the daemon keeps one horizon");
});

test("W1-T12230 criterion 6: the decision row carries the count in each class and the horizon, from the real freshness reading", async () => {
  const svc = behind(
    [{ sha: sha("b2"), files: ["src/lib/daemon.ts"] }, { sha: sha("c3"), files: ["scripts/a.mjs"] }, { sha: sha("c4"), files: ["src/lib/w.ts"] }],
    judgeAdvanceByClosure(["src/lib/daemon.ts", "scripts/a.mjs", "src/lib/w.ts"],
      { status: "read", sha: sha("e0"), entry: "src/cli/index.ts", paths: new Set(["src/lib/daemon.ts"]) },
      { status: "read", sha: sha("b2"), entry: "src/cli/index.ts", paths: new Set(["src/lib/daemon.ts"]) }),
  );
  const freshness = daemonFreshnessFromService(svc) as DaemonFreshness;
  assert.equal(freshness.stale, true);
  const rows = decisions(await busyDaemon(() => freshness, { freshnessStalenessHorizonMs: HOUR, freshnessLoopOnlyHorizonMs: 3 * HOUR }, MINUTE));
  const first = rows[0]!.extra;
  assert.deepEqual(first.change_classes, { reviewer: 0, loop: 1, worker_only: 2 });
  assert.equal(first.horizon_ms, 3 * HOUR);
  assert.equal(first.staleness_horizon_ms, HOUR);
  assert.equal(first.weight, 1, "the two worker-only commits add nothing");
});

test("W1-T12230 criterion 7: an install input change, a withheld review and an unreadable advance release the restart as today", () => {
  const lockfile: DeployWorthChange = { sha: sha("d5"), files: ["package-lock.json"], changeClass: "reviewer" };
  const base = { busy: true, staleSinceMs: T0, nowMs: T0, state: fresh(), threshold: LIMIT, ageHorizonMs: HOUR, loopOnlyHorizonMs: 12 * HOUR };
  const coalesce = (decision: ReturnType<typeof decideFreshnessRestart>, installInputsChanged = false) =>
    coalesceFreshnessRestart({
      decision, newSha: sha("f6"), lastAdvanceAtMs: T0, staleSinceMs: T0, nowMs: T0, window: FRESHNESS_COALESCE_WINDOW_MS,
      threshold: LIMIT, ageHorizonMs: decision.horizonMs, installInputsChanged, lifetimeStartedAtMs: T0 - MINUTE,
      minLifetimeMs: 3 * HOUR,
    });
  // A worker-only advance with a withheld review: the full threshold of pressure, released past the minimum lifetime.
  const withheld = decideFreshnessRestart({ ...base, changes: [workerOnly], withheldReviews: 1 });
  assert.equal(withheld.weight, 0);
  assert.equal(withheld.action, "restart");
  assert.equal(coalesce(withheld).reason, "withheld_reviews");
  // An unreadable advance: full weight, released at once.
  const unreadable = decideFreshnessRestart({ ...base, changes: undefined });
  assert.equal(unreadable.action, "restart");
  assert.equal(unreadable.restartTrigger, "unreadable");
  assert.equal(coalesce(unreadable).reason, "unreadable_advance");
  // An install input change, idle: released past the minimum lifetime.
  const install = decideFreshnessRestart({ ...base, busy: false, changes: [lockfile, workerOnly] });
  assert.equal(coalesce(install, true).reason, INSTALL_INPUTS_RELEASE);
});
