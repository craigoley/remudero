/**
 * W1-T14214: an ops-catalog task is dated from the ops catalog's own filing history, so its cost of delay ages
 * like a public task's instead of sitting at age 0 behind every aged public task.
 *
 * The ops catalog here is a real git repository: the reader runs the same `git log` the daemon runs against the
 * fetched ops checkout, at the snapshot's bound ops commit. Its commit's own committer time is the filing time,
 * and "now" is set from it, since dispatch-value never reads the wall clock.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildDispatchValueContext, filingDatesFromPlanHistory, type CostOfDelaySnapshot, type DispatchValueContext } from "#src/lib/dispatch-value.js";
import { planSyncGitRunnerAsync } from "#src/lib/tick-read-worker.js";
import { compareDispatch } from "#src/lib/drain.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { OpsCatalogShadowInput } from "#src/lib/ops-catalog-source.js";
import {
  OPS_FILING_REFUSED_STEP,
  catalogFilingReader,
  opsFilingBinding,
  prefetchedOpsFilingReader,
  readOpsFilingHistory,
  type CatalogFilingAnswer,
  type OpsFilingBinding,
  type OpsFilingPorts,
} from "#src/lib/dispatch-filing-catalogs.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MEDIAN_WAIT = 9.5 * HOUR;
const PLAN_PATH = "plan/tasks.yaml";
const PUBLIC_ID = "W1-T14901";
const OPS_ID = "W1-T14902";
const MOVED_ID = "W1-T14903";
const ABSENT_COMMIT = "0123456789abcdef0123456789abcdef01234567";
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
    const id = `W1-T${6000 + i}`;
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

const bindingOf = (dir: string, commit: string, ids: readonly string[]): OpsFilingBinding =>
  ({ checkoutDir: dir, commit, taskIds: new Set(ids) });

function publicAnswer(dates: ReadonlyMap<string, number>): CatalogFilingAnswer {
  return { kind: "ready", snapshot: Object.freeze({ planTreeSha: "public-tree-sha", filedAtByTaskId: dates }) };
}

const planOf = (tasks: Task[]): Pick<Plan, "tasks"> => ({ tasks });

function schedule(tasks: Task[], rows: Array<Record<string, unknown>>, nowMs: number, snapshot: CostOfDelaySnapshot): DispatchValueContext {
  const result = buildDispatchValueContext(tasks, rows, new Set(tasks.map(t => t.id)), nowMs, true, "seed", snapshot);
  assert.equal(result.kind, "ready");
  return result.context;
}

const readySnapshot = (answer: CatalogFilingAnswer): CostOfDelaySnapshot => {
  assert.equal(answer.kind, "ready");
  return (answer as Extract<CatalogFilingAnswer, { kind: "ready" }>).snapshot;
};

test("W1-T14214 criterion 1: a composed plan's ops task an ops commit filed 3 days ago is dated 3 days old and not imputed", async (t) => {
  const ops = opsCatalog(t, [OPS_ID, MOVED_ID]);
  const nowMs = ops.filedAtMs + 3 * DAY;
  const { rows, dates } = evidence(nowMs);
  dates.set(PUBLIC_ID, nowMs - 3 * DAY);
  // A task moved to the ops catalog keeps the date its public filing gave it.
  dates.set(MOVED_ID, nowMs - 10 * DAY);
  const publicFiling = publicAnswer(dates);
  const tasks = [task(PUBLIC_ID, { priority: 1 }), task(OPS_ID, { priority: 0.4 }), task(MOVED_ID, { priority: 1 })];
  const binding = bindingOf(ops.repo.dir, ops.commit, [OPS_ID, MOVED_ID]);
  const rowsLogged: string[] = [];
  const reader = catalogFilingReader({ ports: PORTS, publicReader: () => publicFiling, ops: () => binding, log: (step) => rowsLogged.push(step) });
  assert.equal(reader(planOf(tasks))(PLAN_PATH), publicFiling, "before the first ops read settles, the selection is one behind");
  await reader.refresh();
  const answer = reader(planOf(tasks))(PLAN_PATH);
  const snapshot = readySnapshot(answer);
  assert.equal(snapshot.filedAtByTaskId.get(OPS_ID), ops.filedAtMs);
  assert.equal(snapshot.filedAtByTaskId.get(MOVED_ID), nowMs - 10 * DAY, "a public id keeps its public date");
  assert.equal(snapshot.planTreeSha, "public-tree-sha");
  assert.equal(reader(planOf(tasks))(PLAN_PATH), answer, "the merge is cached by (public tree, ops commit)");
  const context = schedule(tasks, rows, nowMs, snapshot);
  assert.equal(context.costOfDelayInputsByTaskId?.get(OPS_ID)?.filing_age_ms, 3 * DAY);
  assert.equal(context.costOfDelayInputsByTaskId?.get(PUBLIC_ID)?.filing_age_ms, 3 * DAY, "control: the public task's age");
  assert.ok(!(context.costOfDelayImputed ?? []).includes(OPS_ID), `imputed: ${JSON.stringify(context.costOfDelayImputed)}`);
  assert.deepEqual(rowsLogged, []);
});

test("W1-T14214 criterion 2: an ops priority-0.4 task filed 4 days ago orders ahead of a public priority-1 task filed 4 days ago", async (t) => {
  const ops = opsCatalog(t, [OPS_ID]);
  const nowMs = ops.filedAtMs + 4 * DAY;
  const { rows, dates } = evidence(nowMs);
  dates.set(PUBLIC_ID, nowMs - 4 * DAY);
  const publicFiling = publicAnswer(dates);
  const publicTask = task(PUBLIC_ID, { priority: 1 });
  const opsTask = task(OPS_ID, { priority: 0.4 });
  const tasks = [publicTask, opsTask];
  const reader = catalogFilingReader({ ports: PORTS,
    publicReader: () => publicFiling, ops: () => bindingOf(ops.repo.dir, ops.commit, [OPS_ID]), log: () => undefined,
  });
  await reader.refresh();
  const context = schedule(tasks, rows, nowMs, readySnapshot(reader(planOf(tasks))(PLAN_PATH)));
  assert.ok(compareDispatch(opsTask, publicTask, context) < 0,
    `ops ${JSON.stringify(context.costOfDelayInputsByTaskId?.get(OPS_ID))} public ${JSON.stringify(context.costOfDelayInputsByTaskId?.get(PUBLIC_ID))}`);
  // Control: dated by the public history alone, the same ops task is imputed at age 0 and orders behind.
  const undated = schedule(tasks, rows, nowMs, readySnapshot(publicFiling));
  assert.ok((undated.costOfDelayImputed ?? []).includes(OPS_ID));
  assert.ok(compareDispatch(opsTask, publicTask, undated) > 0, "control: undated, the ops task orders behind");
});

test("W1-T14214 criterion 3: an ops commit absent from the checkout leaves the ops task imputed at age 0, one row per ops commit, public dates unchanged", async (t) => {
  const ops = opsCatalog(t, [OPS_ID]);
  const nowMs = ops.filedAtMs + 3 * DAY;
  const { rows, dates } = evidence(nowMs);
  dates.set(PUBLIC_ID, nowMs - 3 * DAY);
  const publicFiling = publicAnswer(dates);
  const tasks = [task(PUBLIC_ID, { priority: 1 }), task(OPS_ID, { priority: 0.4 })];
  let binding = bindingOf(ops.repo.dir, ABSENT_COMMIT, [OPS_ID]);
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const reader = catalogFilingReader({ ports: PORTS, publicReader: () => publicFiling, ops: () => binding, log: (step, extra) => logged.push({ step, extra }) });
  assert.deepEqual(await reader.refresh(), { kind: "refused", reasons: ["ops-commit-absent"] });
  const first = reader(planOf(tasks))(PLAN_PATH);
  assert.equal(reader(planOf(tasks))(PLAN_PATH), publicFiling, "the public answer, unchanged");
  assert.equal(first, publicFiling);
  const context = schedule(tasks, rows, nowMs, readySnapshot(first));
  assert.equal(context.costOfDelayInputsByTaskId?.get(OPS_ID)?.filing_age_ms, 0);
  assert.ok((context.costOfDelayImputed ?? []).includes(OPS_ID));
  assert.equal(context.costOfDelayInputsByTaskId?.get(PUBLIC_ID)?.filing_age_ms, 3 * DAY);
  assert.deepEqual(logged, [{ step: OPS_FILING_REFUSED_STEP, extra: { reasons: ["ops-commit-absent"] } }], "one row for this ops commit");
  // A second unreadable ops commit is named once too.
  const other = opsCatalog(t, []);
  binding = bindingOf(other.repo.dir, other.commit, [OPS_ID]);
  assert.equal(reader(planOf(tasks))(PLAN_PATH), publicFiling, "still one behind: the last settled answer refused");
  assert.equal(logged.length, 1, "no row while the new commit's read is pending");
  assert.deepEqual(await reader.refresh(), { kind: "refused", reasons: ["missing-ops-filing-history"] });
  reader(planOf(tasks))(PLAN_PATH);
  reader(planOf(tasks))(PLAN_PATH);
  assert.deepEqual(logged.map(row => row.extra?.reasons), [["ops-commit-absent"], ["missing-ops-filing-history"]]);
  // The commit becomes readable: the ops task is dated, and the public dates are kept.
  binding = bindingOf(ops.repo.dir, ops.commit, [OPS_ID]);
  await reader.refresh();
  const dated = readySnapshot(reader(planOf(tasks))(PLAN_PATH));
  assert.equal(dated.filedAtByTaskId.get(OPS_ID), ops.filedAtMs);
  for (const [id, at] of dates) assert.equal(dated.filedAtByTaskId.get(id), at, id);
});

test("W1-T14214 criterion 3: git refusing the ops history (not a checkout, shallow, a rejected read) refuses by name, never throws", async (t) => {
  const ops = opsCatalog(t, [OPS_ID]);
  const notACheckout = ownedFixtureDir(t, "ops-not-a-checkout").dir;
  assert.deepEqual(await readOpsFilingHistory(notACheckout, ops.commit, PORTS), { kind: "refused", reasons: ["ops-filing-history-unreadable"] });
  const shallowDir = join(ownedFixtureDir(t, "ops-shallow").dir, "shallow");
  ops.repo.git("clone", "--quiet", "--depth", "1", `file://${ops.repo.dir}`, shallowDir);
  assert.deepEqual(await readOpsFilingHistory(shallowDir, ops.commit, PORTS), { kind: "refused", reasons: ["incomplete-ops-filing-history"] });
  assert.deepEqual(await readOpsFilingHistory(ops.repo.dir, ops.commit, { ...PORTS, gitFor: () => async (args) => {
    if (args[0] === "log") throw new Error("git log refused");
    return args[0] === "rev-parse" ? "false\n" : "";
  } }), { kind: "refused", reasons: ["ops-filing-history-unreadable"] });
  const rejecting = prefetchedOpsFilingReader(async () => { throw new Error("read rejected"); });
  const binding = bindingOf(ops.repo.dir, ops.commit, [OPS_ID]);
  assert.equal(rejecting(binding), undefined, "pending before the first read settles");
  assert.deepEqual(await rejecting.refresh(binding), { kind: "refused", reasons: ["ops-filing-history-unreadable"] });
  assert.deepEqual(rejecting(binding), { commit: ops.commit, answer: { kind: "refused", reasons: ["ops-filing-history-unreadable"] } });
});

test("W1-T14214 criterion 4: invariant:public-only-dates-unchanged with no ops task composed, the filing snapshot and every cost-of-delay input are the public-only ones", async (t) => {
  const ops = opsCatalog(t, [OPS_ID]);
  const nowMs = ops.filedAtMs + 3 * DAY;
  const { rows, dates } = evidence(nowMs);
  dates.set(PUBLIC_ID, nowMs - 3 * DAY);
  const publicFiling = publicAnswer(dates);
  const publicOnly = [task(PUBLIC_ID, { priority: 1 }), task("W1-T14904", { priority: 0.4 })];
  const expected = schedule(publicOnly, rows, nowMs, readySnapshot(publicFiling));
  const cases: Array<[string, () => OpsFilingBinding | undefined]> = [
    ["dispatch_ops_tasks off", () => undefined],
    ["an ops catalog with no task shard", () => bindingOf(ops.repo.dir, ops.commit, [])],
    ["an ops catalog whose tasks the plan does not compose", () => bindingOf(ops.repo.dir, ops.commit, [OPS_ID])],
  ];
  for (const [name, ops] of cases) {
    const reader = catalogFilingReader({ ports: PORTS, publicReader: () => publicFiling, ops, log: () => assert.fail(`${name}: no row`) });
    await reader.refresh();
    const answer = reader(planOf(publicOnly))(PLAN_PATH);
    assert.equal(answer, publicFiling, `${name}: the public reader's own answer`);
    const context = schedule(publicOnly, rows, nowMs, readySnapshot(answer));
    assert.deepEqual(context.costOfDelayInputsByTaskId, expected.costOfDelayInputsByTaskId, name);
    assert.deepEqual(context.stridePassByTaskId, expected.stridePassByTaskId, name);
  }
  // A refused public read stays the public read's refusal, ops binding or not.
  const refusedPublic: CatalogFilingAnswer = { kind: "refused", reasons: ["filing-history-pending"] };
  const reader = catalogFilingReader({ ports: PORTS,
    publicReader: () => refusedPublic, ops: () => bindingOf(ops.repo.dir, ops.commit, [OPS_ID]), log: () => undefined,
  });
  assert.equal(reader(planOf([task(OPS_ID)]))(PLAN_PATH), refusedPublic);
});

test("W1-T14214 criterion 4: the ops binding exists only while dispatch_ops_tasks is on for the source's repository and its snapshot is ok", () => {
  const commit = "a".repeat(40);
  const plan: Plan = { tasks: [task(OPS_ID)], byId: new Map() };
  const ok = { outcome: "ok", plan, opsCommit: commit, identityDigest: "b".repeat(64) } as OpsCatalogShadowInput;
  const on = { outcome: "on" as const, repository: "owner/ops", checkoutDir: "/ops" };
  assert.deepEqual(opsFilingBinding(on, "owner/ops", ok), { checkoutDir: "/ops", commit, taskIds: new Set([OPS_ID]) });
  assert.equal(opsFilingBinding({ outcome: "off" }, "owner/ops", ok), undefined);
  assert.equal(opsFilingBinding(on, "owner/other", ok), undefined);
  assert.equal(opsFilingBinding(on, "owner/ops", undefined), undefined);
  assert.equal(opsFilingBinding(on, "owner/ops", { outcome: "stale", refusalStage: "snapshot_age" } as OpsCatalogShadowInput), undefined);
  assert.equal(opsFilingBinding(on, "owner/ops", { ...ok, opsCommit: "not-a-commit" } as OpsCatalogShadowInput), undefined);
  assert.equal(opsFilingBinding(on, "owner/ops", { outcome: "ok" } as OpsCatalogShadowInput), undefined);
});
