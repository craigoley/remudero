import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BOARD_CLOCK_REDERIVE_MS,
  BOARD_DERIVE_DEBOUNCE_MS,
  BOARD_ORACLE_INTERVAL_MS,
  BOARD_ORACLE_RECURRENCE_MS,
  boardDirtForRow,
  canonicalProjection,
  classifyBoardShadowDiffs,
  createBoardProjection,
  githubGenerationOf,
  type BoardDirtRules,
  type BoardProjection,
} from "../src/lib/board-projection.js";
import type { Clock } from "../src/lib/clock.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { createLedgerProjector, openProjectorReadModel, type LedgerProjector } from "../src/lib/ledger-projector.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelDb, type ReadModelLease } from "../src/lib/read-model-db.js";
import { DEFAULT_LIVENESS_BOUND_MS, ENVIRONMENTAL_BLOCK_COOLDOWN_MS, projectPlan, type GitHub, type PrRef } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
type TestCtx = { after: (fn: () => void) => void };

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0, ...over };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function fakeGithub(over: Partial<GitHub> = {}): GitHub {
  return {
    readFailed: () => false,
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [],
    listOpenHeadBranches: () => [],
    headRefName: () => undefined,
    prBody: () => undefined,
    issueByUrl: () => ({ state: "OPEN", title: "stuck" }),
    ...over,
  } as GitHub;
}

interface Rig {
  dir: string;
  db: ReadModelDb;
  lease: ReadModelLease;
  projector: LedgerProjector;
  clock: Clock & { set(ms: number): void };
  append(...rows: Array<Record<string, unknown>>): void;
  board(opts?: { plan?: () => Plan; rules?: Partial<BoardDirtRules>; github?: GitHub; lease?: boolean }): BoardProjection;
}

function rig(t: TestCtx): Rig {
  const dir = makeTempDir("board-projection");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = T0;
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString(), set: (ms: number) => { now = ms; } };
  const db = openProjectorReadModel(dir, "core", clock);
  t.after(() => db.close());
  const acquired = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(acquired.ok);
  const lease = acquired.lease;
  const projector = createLedgerProjector({ ledgerDir: dir, db, lease, clock });
  const defaultPlan = planOf([task("W1-T1"), task("W1-T2"), task("W1-T3")]);
  return {
    dir, db, lease, projector, clock,
    append: (...rows) => {
      appendFileSync(join(dir, "ledger.ndjson"), rows.map((r) => `${JSON.stringify({ ts: new Date(now).toISOString(), host: "h1", ...r })}\n`).join(""));
      projector.tick();
    },
    board: (opts = {}) => createBoardProjection({
      db, ...(opts.lease === false ? {} : { lease }), ledgerPath: join(dir, "ledger.ndjson"), clock,
      readPlan: opts.plan ?? (() => defaultPlan), github: opts.github ?? fakeGithub(), githubGeneration: () => "g1",
      readCreditStore: () => ({}), readCreditOverrideFile: () => "", ...(opts.rules ? { rules: opts.rules } : {}),
    }),
  };
}

function blockRow(taskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { run_id: `run-${taskId}`, task_id: taskId, step: "dispatch.blocked_independent", verdict: "failed", ...extra };
}

/** Moves the clock past the derive debounce, so the next update is not deferred. */
function later(r: Rig, ms = BOARD_DERIVE_DEBOUNCE_MS): void {
  r.clock.set(r.clock.now() + ms);
}

test("a ledger row dirties exactly the tasks it affects", (t) => {
  assert.deepEqual(boardDirtForRow({ step: "verdict", task_id: "W1-T1", task: "W1-T2" }), { all: false, tasks: ["W1-T1", "W1-T2"] });
  assert.deepEqual(boardDirtForRow({ step: "verdict", task: "W1-T2" }), { all: false, tasks: ["W1-T2"] });
  assert.deepEqual(boardDirtForRow({ step: "verdict", task_id: "W1-T1", task: "W1-T1" }), { all: false, tasks: ["W1-T1"] });
  assert.deepEqual(boardDirtForRow({ step: "verdict", task_id: "W1-T1", task: "W1-T2" }, { alias: false, crossTask: true }), { all: false, tasks: ["W1-T1"] });
  assert.deepEqual(boardDirtForRow({ step: "daemon.boot" }), { all: true, reason: "daemon.boot" });
  assert.deepEqual(boardDirtForRow({ step: "pr.opened", plan_only: true, task_id: "W1-T9" }), { all: true, reason: "pr.opened plan_only" });
  assert.deepEqual(boardDirtForRow({ step: "pr.opened", task_id: "W1-T9" }), { all: false, tasks: ["W1-T9"] });
  assert.deepEqual(boardDirtForRow({ step: "daemon.boot" }, { alias: true, crossTask: false }), { all: false, tasks: [] });

  const r = rig(t);
  r.append({ step: "verdict", task_id: "W1-T3", run_id: "r0", verdict: "no_pr" });
  const board = r.board();
  assert.equal(board.update().full, true, "the first derive has nothing to reuse");
  later(r);
  r.append(blockRow("W1-T1", { task: "W1-T2" }));
  const aliased = board.update();
  assert.deepEqual(aliased.rederived, ["W1-T1", "W1-T2"], "a row naming two tasks moves both and no other");
  assert.equal(board.projections().get("W1-T2")?.status, "blocked", "the task named only in `task` re-derived");
  later(r);
  r.append({ step: "verdict", task_id: "W1-T3", run_id: "r3", verdict: "no_pr" });
  assert.deepEqual(board.update().rederived, ["W1-T3"]);
  later(r);
  r.append({ step: "daemon.boot", head_sha: "abc" });
  assert.equal(board.update().full, true, "a daemon boot re-derives every task");
  later(r);
  r.append({ step: "pr.opened", plan_only: true, pr_url: "https://github.com/o/r/pull/9", task_id: "PLAN" });
  const planOnly = board.update();
  assert.equal(planOnly.full, true, "a plan_only pr.opened row re-derives every task");
  assert.deepEqual(planOnly.rederived, ["W1-T1", "W1-T2", "W1-T3"]);
});

test("the no-reuse oracle catches a deliberately stale reuse", (t) => {
  const r = rig(t);
  r.append(blockRow("W1-T1"));
  const board = r.board();
  board.update();
  assert.equal(board.oracle().mismatches.length, 0, "a board derived from scratch agrees with itself");
  const held = board.projections().get("W1-T1")!;
  assert.equal(held.status, "blocked");
  // Corrupt the persisted projection under its own (still valid) stamp: a restart reuses it as is.
  r.db.prepare("UPDATE task_projection SET json = ? WHERE task_id = 'W1-T1'").run(JSON.stringify({ ...held, status: "queued", independentFailureBlocked: undefined }));
  r.db.prepare("INSERT INTO task_projection(task_id, stamp, json) VALUES('GHOST', 'x', '{\"taskId\":\"GHOST\"}')").run();
  const restarted = r.board();
  assert.equal(restarted.projections().get("W1-T1")?.status, "queued", "the stale projection is what the restart holds");
  const found = restarted.oracle();
  assert.deepEqual(found.mismatches.map((m) => m.taskId), ["GHOST", "W1-T1"]);
  assert.deepEqual(found.mismatches.find((m) => m.taskId === "W1-T1")?.fields, ["independentFailureBlocked", "status"]);
  assert.equal(found.compared, 3);
  assert.equal(restarted.projections().get("W1-T1")?.status, "blocked", "the oracle heals what it finds");
  assert.equal(restarted.projections().has("GHOST"), false);
  assert.equal(r.db.prepare("SELECT count(*) AS n FROM task_projection WHERE task_id = 'GHOST'").get()?.n, 0);
  assert.equal(r.board().oracle().mismatches.length, 0, "the heal is persisted");
});

test("the periodic oracle measures a gap each dirty-set rule closes", (t) => {
  const r = rig(t);
  const logged: Array<Record<string, unknown>> = [];
  const gapped = createBoardProjection({
    db: r.db, ledgerPath: join(r.dir, "ledger.ndjson"), clock: r.clock, readPlan: () => planOf([task("W1-T1"), task("W1-T2")]),
    github: fakeGithub(), githubGeneration: () => "g1", readCreditStore: () => ({}), readCreditOverrideFile: () => "",
    rules: { alias: false }, log: (step, extra) => logged.push({ step, ...extra }),
  });
  const closed = r.board();
  assert.equal(gapped.update().oracle, undefined, "the first derive only starts the oracle's clock");
  closed.update();
  later(r);
  r.append(blockRow("DAEMON", { task: "W1-T2" }));
  gapped.update();
  closed.update();
  assert.equal(gapped.projections().get("W1-T2")?.status, "queued", "without the alias rule W1-T2 is reused stale");
  r.clock.set(r.clock.now() + BOARD_ORACLE_INTERVAL_MS);
  const measured = gapped.update().oracle;
  assert.deepEqual(measured?.mismatches.map((m) => m.taskId), ["W1-T2"]);
  assert.equal(logged.at(-1)?.step, "read_model.board_oracle");
  assert.equal(logged.at(-1)?.mismatches, 1);
  assert.equal(closed.update().oracle?.mismatches.length, 0, "with every rule on the oracle finds nothing");
});

test("an environmental block clears on the clock re-derive without a new row", (t) => {
  const r = rig(t);
  r.append(blockRow("W1-T1", { verdict: "blocked_transient" }), { step: "run.start", task_id: "W1-T2", run_id: "r2" });
  const board = r.board();
  const frozen = r.board();
  const noClock = r.board({ rules: { clock: false }, lease: false });
  board.update();
  frozen.update();
  noClock.update();
  assert.equal(board.projections().get("W1-T1")?.status, "blocked");
  r.clock.set(T0 + ENVIRONMENTAL_BLOCK_COOLDOWN_MS + 1);
  const cleared = board.update();
  assert.ok(cleared.rederived.includes("W1-T1"), "the cooldown elapsed on the clock alone");
  assert.equal(board.projections().get("W1-T1")?.status, "queued");
  const noClockUpdate = noClock.update();
  assert.deepEqual(noClockUpdate.rederived, [], "without the clock rule nothing re-derives");
  assert.deepEqual(noClockUpdate.oracle?.mismatches.map((m) => m.taskId), ["W1-T1", "W1-T2"], "the oracle measures the missing clock rule");
  later(r, 1);
  assert.equal(frozen.update().derived, true);
  later(r, BOARD_CLOCK_REDERIVE_MS - 2);
  assert.equal(board.update().derived, false, "the clock re-derive waits its interval");
});

test("a lone run start inside the liveness bound re-derives when any newer row lands", (t) => {
  const r = rig(t);
  r.append({ step: "run.start", task_id: "W1-T1", run_id: "r1" });
  const board = r.board({ rules: { clock: false } });
  board.update();
  r.clock.set(T0 + DEFAULT_LIVENESS_BOUND_MS + 1);
  r.append({ step: "verdict", task_id: "W1-T3", run_id: "r3", verdict: "no_pr" });
  assert.deepEqual(board.update().rederived, ["W1-T1", "W1-T3"], "W1-T1's start may have turned orphan");
  r.clock.set(r.clock.now() + DEFAULT_LIVENESS_BOUND_MS);
  r.append({ step: "verdict", task_id: "W1-T3", run_id: "r3b", verdict: "no_pr" });
  assert.deepEqual(board.update().rederived, ["W1-T3"], "a start already past the bound cannot turn again");
  const ignoring = r.board({ rules: { clock: false, ledgerClock: false }, lease: false });
  ignoring.update();
  later(r);
  r.append({ step: "run.start", task_id: "W1-T2", run_id: "r2" });
  ignoring.update();
  r.clock.set(r.clock.now() + DEFAULT_LIVENESS_BOUND_MS + 1);
  r.append({ step: "verdict", task_id: "W1-T3", run_id: "r3c", verdict: "no_pr" });
  assert.deepEqual(ignoring.update().rederived, ["W1-T3"], "without the rule the start is not revisited");
});

test("a plan reload re-derives the tasks whose plan changed", (t) => {
  const r = rig(t);
  r.append(blockRow("W1-T3"));
  let plan = planOf([task("W1-T1"), task("W1-T2"), task("W1-T3")]);
  const board = r.board({ plan: () => plan });
  board.update();
  later(r);
  assert.equal(board.update().derived, false, "the same plan object moves nothing");
  // A reload hands over new objects: identical tasks keep their stamps, a changed or new one moves.
  plan = planOf([task("W1-T1"), task("W1-T2", { title: "retitled" }), task("W1-T4")]);
  later(r);
  const reloaded = board.update();
  assert.deepEqual(reloaded.rederived, ["W1-T2", "W1-T4"]);
  assert.equal(reloaded.reused, 1);
  assert.deepEqual([...board.projections().keys()].sort(), ["W1-T1", "W1-T2", "W1-T4"], "a task that left the plan leaves the board");
  assert.equal(r.db.prepare("SELECT count(*) AS n FROM task_projection WHERE task_id = 'W1-T3'").get()?.n, 0);
});

test("full-history results tag legacy_horizon diffs", (t) => {
  const r = rig(t);
  r.append(blockRow("W1-T1"));
  const horizon = T0 + 60_000;
  r.clock.set(horizon + 60_000);
  r.append({ step: "verdict", task_id: "W1-T2", run_id: "r2", verdict: "no_pr" });
  const plan = planOf([task("W1-T1"), task("W1-T2"), task("W1-T3")]);
  const board = r.board({ plan: () => plan });
  board.update();
  const recent = board.rows().filter((row) => typeof row.ts === "string" && Date.parse(row.ts) >= horizon);
  const legacy = projectPlan(plan, { ledgerPath: join(r.dir, "ledger.ndjson"), github: fakeGithub(), readLedger: () => recent, now: () => r.clock.now(), readCreditStore: () => ({}), writeCreditStore: () => {}, readCreditOverrideFile: () => "" });
  legacy.set("W1-T2", { ...legacy.get("W1-T2")!, needsHuman: true });
  const diffs = classifyBoardShadowDiffs(board.projections(), legacy, board.rows(), horizon);
  assert.deepEqual(diffs, [
    { taskId: "W1-T1", fields: ["independentFailureBlocked", "status"], classification: "legacy_horizon" },
    { taskId: "W1-T2", fields: ["needsHuman"], classification: "bug" },
  ]);
});

test("a restarted board reuses its persisted projections", (t) => {
  const r = rig(t);
  r.append(blockRow("W1-T1"), { step: "run.start", task_id: "W1-T2", run_id: "r2" });
  r.board().update();
  const restarted = r.board();
  const first = restarted.update();
  assert.deepEqual(first.rederived, ["W1-T1", "W1-T2"], "only the blocked and the in-flight projection re-derive on the clock");
  assert.equal(first.reused, 1, "the settled task is reused across the restart");
  assert.equal(restarted.projections().get("W1-T1")?.status, "blocked");
  const memoryOnly = r.board({ lease: false });
  memoryOnly.update({ force: true });
  r.db.prepare("DELETE FROM task_projection").run();
  memoryOnly.update({ force: true });
  assert.equal(r.db.prepare("SELECT count(*) AS n FROM task_projection").get()?.n, 0, "without the lease nothing persists");
});

test("the derive is debounced and a quiet update does nothing", (t) => {
  const r = rig(t);
  const board = r.board();
  board.update();
  r.append(blockRow("W1-T1"));
  const deferred = board.update();
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.newRows, 1);
  assert.equal(board.projections().get("W1-T1")?.status, "queued");
  later(r);
  assert.deepEqual(board.update().rederived, ["W1-T1"], "the deferred row is applied on the next update");
  later(r);
  const quiet = board.update();
  assert.equal(quiet.derived, false);
  assert.equal(quiet.deferred, false);
  assert.equal(board.update({ force: true }).derived, true);
});

test("rows keep ledger order by ts and unread steps only advance the newest ts", (t) => {
  const r = rig(t);
  const at = (ms: number) => new Date(ms).toISOString();
  writeFileSync(join(r.dir, "ledger.ndjson"), [
    { ts: at(T0 + 2_000), step: "verdict", task_id: "W1-T1", run_id: "b" },
    { ts: at(T0 + 1_000), step: "verdict", task_id: "W1-T1", run_id: "a" },
    { ts: at(T0 + 9_000), step: "sweep.pass", task_id: "DAEMON" },
  ].map((row) => `${JSON.stringify(row)}\n`).join(""));
  r.projector.tick();
  const board = r.board();
  board.update();
  r.append({ ts: at(T0 + 1_500), step: "verdict", task_id: "W1-T2", run_id: "c" }, { ts: at(T0 + 3_000), step: "verdict", task_id: "W1-T2", run_id: "d" });
  later(r);
  board.update();
  assert.deepEqual(board.rows().map((row) => row.run_id), [undefined, "a", "c", "b", "d"]);
  assert.equal(board.rows()[0]?.ts, at(T0 + 9_000), "the sentinel carries the unread row's ts");
  assert.equal(board.rows().some((row) => row.step === "sweep.pass"), false);
});

test("an escalation naming no plan task is projected and persisted", (t) => {
  const r = rig(t);
  r.append({ step: "escalation.issue_opened", task_id: "T-PROBE", run_id: "p1", issue_url: "https://github.com/o/r/issues/7", class: "PROBE" });
  const board = r.board();
  board.update();
  assert.equal(board.projections().get("T-PROBE")?.needsHuman, true);
  assert.equal(r.db.prepare("SELECT count(*) AS n FROM task_projection WHERE task_id = 'T-PROBE'").get()?.n, 1);
});

test("the default seams read the credit store and override record beside the ledger", (t) => {
  const r = rig(t);
  r.append(blockRow("W1-T1"));
  const make = () => createBoardProjection({ db: r.db, ledgerPath: join(r.dir, "state", "ledger.ndjson"), clock: r.clock, readPlan: () => planOf([task("W1-T1")]), github: fakeGithub() });
  const bare = make();
  bare.update();
  assert.equal(bare.projections().get("W1-T1")?.status, "blocked", "an absent store and override record read as empty");
  mkdirSync(join(r.dir, "state"));
  mkdirSync(join(r.dir, "plan"));
  const pr: PrRef = { number: 5, url: "https://github.com/o/r/pull/5", state: "MERGED" };
  writeFileSync(join(r.dir, "state", "merge-credit.json"), JSON.stringify({ "W1-T1": { trailer: { source: "trailer", prUrl: pr.url, prNumber: 5, prState: "MERGED" } } }));
  writeFileSync(join(r.dir, "plan", "credit-overrides.yaml"), "overrides: []\n");
  const credited = make();
  credited.update();
  assert.equal(credited.projections().get("W1-T1")?.merged, true, "the durable credit store was read");
});

test("the github generation follows the open pull requests and the read state", () => {
  const open: PrRef[] = [{ number: 2, url: "u2", state: "OPEN", headRefOid: "b" }, { number: 1, url: "u1", state: "OPEN" }];
  const base = githubGenerationOf(fakeGithub({ listOpenHeadBranches: () => open }));
  assert.equal(githubGenerationOf(fakeGithub({ listOpenHeadBranches: () => [...open].reverse() })), base, "order does not matter");
  assert.notEqual(githubGenerationOf(fakeGithub({ listOpenHeadBranches: () => [{ ...open[0]!, headRefOid: "c" }, open[1]!] })), base);
  assert.notEqual(githubGenerationOf(fakeGithub({ listOpenHeadBranches: () => null })), base);
  assert.notEqual(githubGenerationOf(fakeGithub({ listOpenHeadBranches: () => open, readFailed: () => true })), base);
  assert.notEqual(githubGenerationOf({ ...fakeGithub(), listOpenHeadBranches: undefined }), githubGenerationOf(fakeGithub({ listOpenHeadBranches: () => null })));
  const nulls = { ...fakeGithub(), readFailed: undefined };
  assert.equal(typeof githubGenerationOf(nulls), "string");
});

test("the default github generation re-derives every task when an open pull request moves", (t) => {
  const r = rig(t);
  let open: PrRef[] = [];
  const board = createBoardProjection({ db: r.db, ledgerPath: join(r.dir, "ledger.ndjson"), clock: r.clock, readPlan: () => planOf([task("W1-T1"), task("W1-T2")]),
    github: fakeGithub({ listOpenHeadBranches: () => open }), readCreditStore: () => ({}), readCreditOverrideFile: () => "" });
  board.update();
  later(r);
  open = [{ number: 3, url: "u3", state: "OPEN", headRefName: "run-W1-T1-1", headRefOid: "a" }];
  assert.equal(board.update().full, true);
});

test("a comparison ignores key order and the clock-read elapsed time", () => {
  const a = { taskId: "W1-T1", status: "running", merged: false, elapsedMs: 5, nested: { b: 1, a: [2, { d: 1, c: 2 }] } };
  const b = { nested: { a: [2, { c: 2, d: 1 }], b: 1 }, merged: false, status: "running", taskId: "W1-T1", elapsedMs: 9 };
  assert.equal(canonicalProjection(a as never), canonicalProjection(b as never));
  assert.equal(canonicalProjection(undefined), "absent");
  assert.notEqual(canonicalProjection(a as never), canonicalProjection({ ...a, status: "queued" } as never));
});

function fakeIssues(): IssueGateway & { titles: string[] } {
  const titles: string[] = [];
  return {
    titles,
    create: (title) => {
      titles.push(title);
      return `https://github.com/craigoley/remudero/issues/${9000 + titles.length}`;
    },
  };
}

function tamper(r: Rig, board: BoardProjection): void {
  const held = board.projections().get("W1-T1")!;
  r.db.prepare("UPDATE task_projection SET json = ? WHERE task_id = 'W1-T1'").run(JSON.stringify({ ...held, status: "queued", independentFailureBlocked: undefined }));
}

test("a board drift that recurs within 24 h of a self-heal escalates through tryEscalate", (t) => {
  const r = rig(t);
  r.append(blockRow("W1-T1"));
  const issues = fakeIssues();
  const escalation = { issues, ledgerPath: join(r.dir, "ledger.ndjson"), runId: "board-oracle" };
  const withEscalation = (): BoardProjection => createBoardProjection({
    db: r.db, lease: r.lease, ledgerPath: join(r.dir, "ledger.ndjson"), clock: r.clock, readPlan: () => planOf([task("W1-T1"), task("W1-T2")]),
    github: fakeGithub(), githubGeneration: () => "g1", readCreditStore: () => ({}), readCreditOverrideFile: () => "", escalation, instance: "console",
  });
  const first = withEscalation();
  first.update();
  assert.equal(first.oracle().outcome, "agree");
  tamper(r, first);
  const healed = withEscalation().oracle();
  assert.equal(healed.outcome, "healed");
  assert.equal(issues.titles.length, 0, "the first drift heals without asking anyone");
  r.clock.set(T0 + 3_600_000);
  tamper(r, first);
  const again = withEscalation().oracle();
  assert.equal(again.outcome, "escalated", "the heal is remembered across a restart");
  assert.match(again.escalationReasons.join(), /within 24 h of an earlier self-heal/);
  assert.equal(again.issueUrl, "https://github.com/craigoley/remudero/issues/9001");
  assert.match(issues.titles[0]!, /read model console: the board projection drifted/);
  r.clock.set(T0 + 3_600_000 + BOARD_ORACLE_RECURRENCE_MS + 1);
  tamper(r, first);
  assert.equal(withEscalation().oracle().outcome, "healed", "a drift a day after the last heal starts over");
  assert.equal(issues.titles.length, 1);
  const runs = r.db.prepare("SELECT outcome, issue_url FROM board_oracle_run ORDER BY at_ms").all().map((row) => `${String(row.outcome)} ${String(row.issue_url)}`);
  assert.deepEqual(runs, ["healed null", "escalated https://github.com/craigoley/remudero/issues/9001", "healed null"]);
});

test("a board drift that survives its heal escalates and a transient one does not", (t) => {
  const r = rig(t);
  r.append({ step: "escalation.issue_opened", task_id: "W1-T1", issue_url: "https://github.com/o/r/issues/5", class: "MANUAL" });
  const states: string[] = [];
  const github = fakeGithub({ issueByUrl: () => ({ state: states.shift() ?? "OPEN", title: "stuck" }) });
  const issues = fakeIssues();
  const logged: Array<Record<string, unknown>> = [];
  const board = createBoardProjection({
    db: r.db, lease: r.lease, ledgerPath: join(r.dir, "ledger.ndjson"), clock: r.clock, readPlan: () => planOf([task("W1-T1")]),
    github, githubGeneration: () => "g1", readCreditStore: () => ({}), readCreditOverrideFile: () => "",
    escalation: { issues, ledgerPath: join(r.dir, "ledger.ndjson"), runId: "board-oracle" }, log: (step, extra) => logged.push({ step, ...extra }),
  });
  states.push("OPEN");
  board.update();
  assert.equal(board.projections().get("W1-T1")?.needsHuman, true);
  states.push("CLOSED", "OPEN");
  assert.equal(board.oracle().outcome, "transient", "a mismatch gone on the recheck is not healed");
  assert.equal(board.projections().get("W1-T1")?.needsHuman, true);
  states.push("CLOSED", "CLOSED", "OPEN");
  const survived = board.oracle();
  assert.equal(survived.outcome, "escalated");
  assert.match(survived.escalationReasons.join(), /still differ after the heal \(W1-T1\)/);
  assert.equal(issues.titles.length, 1);
  assert.equal(logged.at(-1)?.issue_url, survived.issueUrl);
  const quiet = createBoardProjection({
    db: r.db, ledgerPath: join(r.dir, "ledger.ndjson"), clock: r.clock, readPlan: () => planOf([task("W1-T1")]),
    github: fakeGithub({ issueByUrl: () => ({ state: states.shift() ?? "CLOSED", title: "stuck" }) }), githubGeneration: () => "g1",
    readCreditStore: () => ({}), readCreditOverrideFile: () => "",
  });
  assert.equal(quiet.projections().get("W1-T1")?.needsHuman, undefined, "it restarts on the healed projection");
  states.push("OPEN", "OPEN", "CLOSED");
  const unescalated = quiet.oracle();
  assert.equal(unescalated.outcome, "escalated", "the tier is reached without an escalation path");
  assert.equal(unescalated.issueUrl, null, "and nothing is filed");
  assert.equal(issues.titles.length, 1);
});
