/**
 * W1-T14218: the ops filing reader is warm before a selection needs it.
 *
 * W1-T14214's reader read the ops history only behind a selection, and the daemon awaited the public filing read at
 * boot but not the ops one, so the first selection after a boot (about the only one a boot gets) dated no ops task.
 * The daemon now starts the ops filing read each time the ops catalog source settles an ok snapshot.
 *
 * The ops catalog is a real git repository, read by the same `git log` the daemon runs against the fetched ops
 * checkout. Its commit's committer time is the filing time, and "now" is set from it.
 *
 * Criteria 1-2 (the last readable commit's dates through an absent commit) were not built: the record's MEASURE
 * FIRST counted under one ops-commit-absent refusal an hour on the host.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
// Load the existing analytics side of the daemon's import cycle first.
import "#src/lib/live-analytics-snapshot-cache.js";
import { OPS_CATALOG_REFRESHED_STEP, opsCatalogFilingFeeds, opsCatalogShadowFeed } from "#src/cli/commands/daemon.js";
import { buildDispatchValueContext, filingDatesFromPlanHistory, type CostOfDelaySnapshot, type DispatchValueContext } from "#src/lib/dispatch-value.js";
import { planSyncGitRunnerAsync } from "#src/lib/tick-read-worker.js";
import { fixedClock } from "#src/lib/clock.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { OpsCatalogShadowInput } from "#src/lib/ops-catalog-source.js";
import {
  catalogFilingReader,
  opsFilingBinding,
  prefetchedOpsFilingReader,
  readOpsFilingHistory,
  type CatalogFilingAnswer,
  type OpsFilingAnswer,
  type OpsFilingPorts,
} from "#src/lib/dispatch-filing-catalogs.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MEDIAN_WAIT = 9.5 * HOUR;
const PLAN_PATH = "plan/tasks.yaml";
const REPOSITORY = "owner/ops";
const PUBLIC_ID = "W1-T14911";
const OPS_A = "W1-T14912";
const OPS_B = "W1-T14913";
const MOVED_ID = "W1-T14914";
/** The ports the daemon passes: the public filing read's parser and the plan sync's awaited git runner. */
const PORTS: OpsFilingPorts = { parseFilingDates: filingDatesFromPlanHistory, gitFor: planSyncGitRunnerAsync };

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: [`src/${id}.ts`],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, ...over,
});

/** Eight measured public tasks, each started one median wait after filing and merged: the wait evidence. */
function evidence(nowMs: number): { rows: Array<Record<string, unknown>>; dates: Map<string, number> } {
  const rows: Array<Record<string, unknown>> = [];
  const dates = new Map<string, number>();
  for (let i = 0; i < 8; i++) {
    const id = `W1-T${6100 + i}`;
    const startedAt = nowMs - 2 * DAY;
    dates.set(id, startedAt - MEDIAN_WAIT);
    rows.push({ step: "run.start", task_id: id, run_id: id, task_class: "src", ts: new Date(startedAt).toISOString() });
    rows.push({ step: "verdict", task_id: id, run_id: id, verdict: "merged", cost_usd: 2, ts: new Date(startedAt + HOUR).toISOString() });
  }
  return { rows, dates };
}

/** An ops catalog checkout whose one commit adds a task shard per id; the commit's time is their filing time. */
function opsCatalog(t: TestContext, ids: readonly string[]): { repo: GitRepo; commit: string; filedAtMs: number } {
  const repo = gitRepo({ scope: t, kind: "ops-catalog" });
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  for (const id of ids) writeFileSync(join(repo.dir, "plan", "tasks.d", `${id}-an-ops-task.yaml`), `- id: ${id}\n  title: ${id}\n`);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "--allow-empty", "-m", "plan: file ops tasks");
  const commit = repo.git("rev-parse", "HEAD");
  return { repo, commit, filedAtMs: Number(repo.git("log", "-1", "--format=%ct", commit)) * 1000 };
}

/** The ops source's ok snapshot at `commit`, holding `ids`. */
function okSnapshot(commit: string, ids: readonly string[]): OpsCatalogShadowInput {
  const tasks = ids.map(id => task(id));
  const plan: Plan = { tasks, byId: new Map(tasks.map(t => [t.id, t])) };
  return { outcome: "ok", plan, opsCommit: commit, identityDigest: "c".repeat(64) } as OpsCatalogShadowInput;
}

/** An ops source whose refreshes answer only when the test releases them: "settles after boot". */
function heldSource(): { source: { refresh(): Promise<OpsCatalogShadowInput> }; settle(input: OpsCatalogShadowInput): void; calls(): number } {
  const pending: Array<(input: OpsCatalogShadowInput) => void> = [];
  let calls = 0;
  return {
    source: { refresh: () => { calls += 1; return new Promise<OpsCatalogShadowInput>(resolve => pending.push(resolve)); } },
    settle: (input) => { const next = pending.shift(); assert.ok(next, "a source refresh is pending"); next(input); },
    calls: () => calls,
  };
}

/** The ops history reads the reader starts, each held so the test can await the one a warm-up started. */
function countedReads(): { readOps: ReturnType<typeof prefetchedOpsFilingReader>; started: Array<Promise<OpsFilingAnswer>> } {
  const started: Array<Promise<OpsFilingAnswer>> = [];
  const readOps = prefetchedOpsFilingReader((checkoutDir, commit) => {
    const read = readOpsFilingHistory(checkoutDir, commit, PORTS);
    started.push(read);
    return read;
  });
  return { readOps, started };
}

/** One ledgered refresh row per settled source read; resolves the oldest waiter. */
function refreshRows(): { log: (step: string, fields: Record<string, unknown>) => void; next(): Promise<void> } {
  const waiters: Array<() => void> = [];
  const seen: string[] = [];
  return {
    log: (step) => { seen.push(step); waiters.shift()?.(); },
    next: () => new Promise<void>(resolve => { waiters.push(resolve); }),
  };
}

function publicAnswer(dates: ReadonlyMap<string, number>): CatalogFilingAnswer {
  return { kind: "ready", snapshot: Object.freeze({ planTreeSha: "public-tree-sha", filedAtByTaskId: dates }) };
}

const planOf = (tasks: Task[]): Pick<Plan, "tasks"> => ({ tasks });
const selectionOn = { outcome: "on" as const, repository: REPOSITORY, checkoutDir: "" };

function schedule(tasks: Task[], rows: Array<Record<string, unknown>>, nowMs: number, snapshot: CostOfDelaySnapshot): DispatchValueContext {
  const result = buildDispatchValueContext(tasks, rows, new Set(tasks.map(t => t.id)), nowMs, true, "seed", snapshot);
  assert.equal(result.kind, "ready");
  return result.context;
}

const readySnapshot = (answer: CatalogFilingAnswer): CostOfDelaySnapshot => {
  assert.equal(answer.kind, "ready");
  return (answer as Extract<CatalogFilingAnswer, { kind: "ready" }>).snapshot;
};

test("W1-T14218 criterion 4: an ops source that settles ok after boot and before the first selection warms the reader, so that selection dates every ops id from the ops history", async (t) => {
  const ops = opsCatalog(t, [OPS_A, OPS_B]);
  const nowMs = ops.filedAtMs + 3 * DAY;
  const { rows, dates } = evidence(nowMs);
  dates.set(PUBLIC_ID, nowMs - 3 * DAY);
  const publicFiling = publicAnswer(dates);
  const tasks = [task(PUBLIC_ID, { priority: 1 }), task(OPS_A, { priority: 0.4 }), task(OPS_B, { priority: 0.4 })];
  const selection = { ...selectionOn, checkoutDir: ops.repo.dir };
  const clock = fixedClock(nowMs);

  // Boot, the daemon's way: the feeds are built, the first source read starts unawaited, the loop is not entered yet.
  const held = heldSource();
  const refreshed = refreshRows();
  const reads = countedReads();
  const { opsShadow, datedFiling } = opsCatalogFilingFeeds(held.source, clock, { log: refreshed.log }, {
    publicReader: () => publicFiling, log: () => undefined, ports: PORTS, readOps: reads.readOps,
    ops: (latest) => opsFilingBinding(selection, REPOSITORY, latest),
  });
  assert.ok(opsShadow, "a source builds the ops feed");
  t.after(() => opsShadow.stop());
  assert.equal(opsShadow.current(), undefined, "the source's first read is pending at boot");
  assert.equal(opsShadow.forDispatch(), undefined, "so forDispatch() is undefined at boot");
  assert.equal(reads.started.length, 0, "no binding, no ops read yet");

  // The source settles ok before the first selection: that settle starts the ops filing read, off the loop.
  const settled = refreshed.next();
  held.settle(okSnapshot(ops.commit, [OPS_A, OPS_B]));
  await settled;
  assert.equal(reads.started.length, 1, "the settled ok snapshot started one ops filing read");
  await Promise.all(reads.started);

  // The first selection after the boot.
  const snapshot = readySnapshot(datedFiling(planOf(tasks))(PLAN_PATH));
  const context = schedule(tasks, rows, nowMs, snapshot);
  for (const id of [OPS_A, OPS_B]) {
    assert.equal(snapshot.filedAtByTaskId.get(id), ops.filedAtMs, id);
    assert.equal(context.costOfDelayInputsByTaskId?.get(id)?.filing_age_ms, 3 * DAY, `${id}: aged from the ops history`);
  }
  assert.deepEqual((context.costOfDelayImputed ?? []).filter(id => id === OPS_A || id === OPS_B), [], "no ops id imputed");
  assert.equal(context.costOfDelayInputsByTaskId?.get(PUBLIC_ID)?.filing_age_ms, 3 * DAY, "control: the public task's age");

  // Control, W1-T14214's wiring: the same source with the reader read only behind a selection. The first selection
  // after the boot answers the public dates alone, every ops id imputed at age 0.
  const heldOld = heldSource();
  const refreshedOld = refreshRows();
  const oldFeed = opsCatalogShadowFeed(heldOld.source, clock, { log: refreshedOld.log });
  const oldReads = countedReads();
  const oldReader = catalogFilingReader({ publicReader: () => publicFiling, log: () => undefined, ports: PORTS,
    readOps: oldReads.readOps, ops: () => opsFilingBinding(selection, REPOSITORY, oldFeed.forDispatch()) });
  oldFeed.current();
  const oldSettled = refreshedOld.next();
  heldOld.settle(okSnapshot(ops.commit, [OPS_A, OPS_B]));
  await oldSettled;
  assert.equal(oldReads.started.length, 0, "control: no read before the first selection");
  const cold = oldReader(planOf(tasks))(PLAN_PATH);
  assert.equal(cold, publicFiling, "control: the first selection is one behind");
  const coldContext = schedule(tasks, rows, nowMs, readySnapshot(cold));
  for (const id of [OPS_A, OPS_B]) {
    assert.equal(coldContext.costOfDelayInputsByTaskId?.get(id)?.filing_age_ms, 0, `control: ${id} at age 0`);
    assert.ok((coldContext.costOfDelayImputed ?? []).includes(id), `control: ${id} imputed`);
  }
  await oldReader.refresh();
});

test("W1-T14218 criterion 4: each ok settle warms the reader; a commit already dated is not read again, a new or refused one is", async (t) => {
  const ops = opsCatalog(t, [OPS_A]);
  const nowMs = ops.filedAtMs + 3 * DAY;
  const { dates } = evidence(nowMs);
  const publicFiling = publicAnswer(dates);
  const selection = { ...selectionOn, checkoutDir: ops.repo.dir };
  const held = heldSource();
  const refreshed = refreshRows();
  const reads = countedReads();
  const { opsShadow } = opsCatalogFilingFeeds(held.source, fixedClock(nowMs), { log: refreshed.log }, {
    publicReader: () => publicFiling, log: () => undefined, ports: PORTS, readOps: reads.readOps,
    ops: (latest) => opsFilingBinding(selection, REPOSITORY, latest),
  });
  assert.ok(opsShadow);
  t.after(() => opsShadow.stop());
  const settleWith = async (input: OpsCatalogShadowInput): Promise<void> => {
    opsShadow.current();
    const settled = refreshed.next();
    held.settle(input);
    await settled;
    await Promise.all(reads.started);
  };
  const absent = "0123456789abcdef0123456789abcdef01234567";
  await settleWith(okSnapshot(absent, [OPS_A]));
  assert.equal(reads.started.length, 1, "an ok settle at an absent commit reads it");
  assert.deepEqual(await reads.started[0], { kind: "refused", reasons: ["ops-commit-absent"] });
  await settleWith(okSnapshot(absent, [OPS_A]));
  assert.equal(reads.started.length, 2, "a refused commit is read again at the next ok settle");
  await settleWith({ outcome: "unreadable", refusalStage: "source_refresh" } as OpsCatalogShadowInput);
  assert.equal(reads.started.length, 2, "a settle that is not ok starts no ops read");
  await settleWith(okSnapshot(ops.commit, [OPS_A]));
  assert.equal(reads.started.length, 3, "a new commit is read at its first ok settle");
  assert.equal((await reads.started[2])?.kind, "ready");
  await settleWith(okSnapshot(ops.commit, [OPS_A]));
  await settleWith(okSnapshot(ops.commit, [OPS_A]));
  assert.equal(reads.started.length, 3, "a commit already dated is answered from its settled read, not read again");
  assert.equal(held.calls(), 6, "control: six source refreshes settled");
  // No source (dispatch_ops_tasks off and no shadow): no feed, and the reader answers the public dates.
  const none = opsCatalogFilingFeeds(undefined, fixedClock(nowMs), {}, {
    publicReader: () => publicFiling, log: () => undefined, ports: PORTS,
    ops: (latest) => opsFilingBinding(selection, REPOSITORY, latest),
  });
  assert.equal(none.opsShadow, undefined);
  assert.equal(none.datedFiling(planOf([task(OPS_A)]))(PLAN_PATH), publicFiling);
  assert.equal(await none.datedFiling.refresh(), undefined);
});

test("W1-T14218 criterion 4: a warm-up that cannot run never changes the source's evidence or its refresh row", async (t) => {
  const ops = opsCatalog(t, [OPS_A]);
  const held = heldSource();
  const steps: string[] = [];
  const { opsShadow } = opsCatalogFilingFeeds(held.source, fixedClock(ops.filedAtMs), { log: (step) => steps.push(step) }, {
    publicReader: () => ({ kind: "refused", reasons: ["filing-history-pending"] }), log: () => undefined, ports: PORTS,
    ops: () => { throw new Error("selection read failed"); },
  });
  assert.ok(opsShadow);
  t.after(() => opsShadow.stop());
  opsShadow.current();
  held.settle(okSnapshot(ops.commit, [OPS_A]));
  for (let i = 0; i < 20 && steps.length === 0; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(steps, [OPS_CATALOG_REFRESHED_STEP], "the refresh row is still written");
  assert.equal(opsShadow.forDispatch()?.opsCommit, ops.commit, "the settled snapshot is still the evidence");
  // A settle listener that throws: the feed keeps its evidence and row, and its next refresh still runs.
  const heldThrowing = heldSource();
  const thrownSteps: string[] = [];
  let told = 0;
  const throwing = opsCatalogShadowFeed(heldThrowing.source, fixedClock(ops.filedAtMs), {
    log: (step) => thrownSteps.push(step), onSettled: () => { told += 1; throw new Error("listener failed"); },
  });
  throwing.current();
  heldThrowing.settle(okSnapshot(ops.commit, [OPS_A]));
  for (let i = 0; i < 20 && told === 0; i++) await new Promise<void>(resolve => setImmediate(resolve));
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(told, 1);
  assert.deepEqual(thrownSteps, [OPS_CATALOG_REFRESHED_STEP]);
  assert.equal(throwing.forDispatch()?.opsCommit, ops.commit);
  throwing.current();
  assert.equal(heldThrowing.calls(), 2, "the next refresh starts: the in-flight flag was cleared");
});

test("W1-T14218 criterion 3: invariant:readable-commit-dates-unchanged for a commit the checkout holds, the warmed snapshot equals W1-T14214's and every public date is unchanged", async (t) => {
  const ops = opsCatalog(t, [OPS_A, OPS_B, MOVED_ID]);
  const nowMs = ops.filedAtMs + 3 * DAY;
  const { dates } = evidence(nowMs);
  dates.set(PUBLIC_ID, nowMs - 3 * DAY);
  // A task moved to the ops catalog keeps the date its public filing gave it.
  dates.set(MOVED_ID, nowMs - 10 * DAY);
  const publicFiling = publicAnswer(dates);
  const tasks = [task(PUBLIC_ID), task(OPS_A), task(OPS_B), task(MOVED_ID)];
  const selection = { ...selectionOn, checkoutDir: ops.repo.dir };
  const ids = [OPS_A, OPS_B, MOVED_ID];

  // W1-T14214's reader over the same public tree and ops commit, read behind a selection.
  const before = catalogFilingReader({ publicReader: () => publicFiling, log: () => undefined, ports: PORTS,
    ops: () => opsFilingBinding(selection, REPOSITORY, okSnapshot(ops.commit, ids)) });
  await before.refresh();
  const expected = readySnapshot(before(planOf(tasks))(PLAN_PATH));

  const held = heldSource();
  const refreshed = refreshRows();
  const reads = countedReads();
  const { opsShadow, datedFiling } = opsCatalogFilingFeeds(held.source, fixedClock(nowMs), { log: refreshed.log }, {
    publicReader: () => publicFiling, log: () => assert.fail("a readable commit writes no refusal row"), ports: PORTS,
    readOps: reads.readOps, ops: (latest) => opsFilingBinding(selection, REPOSITORY, latest),
  });
  assert.ok(opsShadow);
  t.after(() => opsShadow.stop());
  opsShadow.current();
  const settled = refreshed.next();
  held.settle(okSnapshot(ops.commit, ids));
  await settled;
  await Promise.all(reads.started);
  const answer = datedFiling(planOf(tasks))(PLAN_PATH);
  const warmed = readySnapshot(answer);
  assert.equal(warmed.planTreeSha, expected.planTreeSha);
  assert.deepEqual([...warmed.filedAtByTaskId].sort(), [...expected.filedAtByTaskId].sort(), "the same merged dates");
  for (const [id, at] of dates) assert.equal(warmed.filedAtByTaskId.get(id), at, `public ${id} unchanged`);
  assert.equal(warmed.filedAtByTaskId.get(MOVED_ID), nowMs - 10 * DAY, "a public id keeps its public date");
  assert.equal(warmed.filedAtByTaskId.get(OPS_A), ops.filedAtMs);
  assert.equal(datedFiling(planOf(tasks))(PLAN_PATH), answer, "the merge is cached by (public tree, ops commit)");
  // A plan with no ops task the public history cannot date gets the public reader's own answer.
  assert.equal(datedFiling(planOf([task(PUBLIC_ID), task(MOVED_ID)]))(PLAN_PATH), publicFiling);
});
