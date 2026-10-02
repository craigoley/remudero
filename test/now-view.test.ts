import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { computeBoardSnapshot, type BoardSnapshot } from "../src/lib/board.js";
import {
  OPEN_SNAPSHOT_RESAVE_MS,
  boardOpenSnapshotPath,
  createBoardSnapshotCache,
  readOpenBoardSnapshot,
  type BoardSnapshotIo,
} from "../src/lib/board-snapshot-cache.js";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import { createLedgerProjector, isFactStep, openProjectorReadModel, type LedgerProjector } from "../src/lib/ledger-projector.js";
import { factColumns } from "../src/lib/read-model-consistency.js";
import {
  NOW_GITHUB_STALE_MS,
  NOW_HOST_PROBE_MS,
  NOW_LEGACY_ROW_WINDOW_MS,
  NOW_QUEUED_ROWS,
  NOW_REFRESH_MS,
  createNowView,
  defaultProbeHost,
  groupNowBoard,
  mergedTodayCount,
  nowActions,
  nowBoardShadowDiff,
  nowPlanPath,
  parseStrike,
  snapshotGithub,
  twoSignificantFigures,
  type NowInstance,
  type NowViewContext,
  type NowViewData,
  type NowViewOptions,
} from "../src/lib/now-view.js";
import type { BoardPrRest } from "../src/lib/open-prs-rest.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelDb } from "../src/lib/read-model-db.js";
import { createReadModelTicker, readModelSwitchesPath, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { HOST_PROBE_BUDGET_MS, PLAN_BUDGET_MS } from "../src/lib/view-freshness.js";
import { buildBatchedGithub, DEFAULT_LIVENESS_BOUND_MS, defaultCreditStorePath, readLedgerLines, saveCreditStore, type BatchedPr, type CreditStore, type GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { SHADOW_CLASSIFICATIONS, VIEW_SHADOW_DIFF_STEP, createViewShadow, readShadowEvidence } from "../src/lib/view-shadow.js";
import { viewEtag, type ViewSwitchMode } from "../src/lib/views.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx): string {
  const dir = makeTempDir("now-view");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0, ...over };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function stubGateway(over: Partial<GitHub> = {}): GitHub {
  return {
    readFailed: () => false,
    prByRef: () => null,
    findMergedByTrailer: () => null,
    findMergedByHeadBranch: () => [],
    listMergedHeadBranches: () => [],
    listOpenHeadBranches: () => [],
    headRefName: () => undefined,
    prBody: () => undefined,
    issueByUrl: () => ({ state: "OPEN", title: "stuck on a human" }),
    ...over,
  } as GitHub;
}

interface Stepped extends Clock {
  set(ms: number): void;
}

function stepped(): Stepped {
  let now = T0;
  return { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString(), set: (ms) => { now = ms; } };
}

interface Rig {
  name: string;
  ledgerDir: string;
  db: ReadModelDb;
  projector: LedgerProjector;
  /** Appends rows to the live file at the clock's time (or each row's own `ts`) and ticks the projector. */
  append(...rows: Array<Record<string, unknown>>): void;
}

function rig(t: TestCtx, root: string, name: string, clock: Stepped): Rig {
  const ledgerDir = join(root, name, "state");
  mkdirSync(ledgerDir, { recursive: true });
  const db = openProjectorReadModel(join(root, "read-model-home"), name, clock);
  t.after(() => db.close());
  const acquired = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(acquired.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: acquired.lease, clock });
  return {
    name, ledgerDir, db, projector,
    append: (...rows) => {
      appendFileSync(join(ledgerDir, "ledger.ndjson"), rows.map((r) => `${JSON.stringify({ ts: clock.iso(), host: "h1", ...r })}\n`).join(""));
      projector.tick();
    },
  };
}

function ctxOf(clock: Clock, rigs: Rig[], mode: ViewSwitchMode | null = "shadow", lease: "held" | "elsewhere" = "held"): NowViewContext {
  return {
    now: clock.now(),
    ...(mode ? { switches: { views: { now: mode } } } : {}),
    instances: rigs.map((r) => ({
      state: { instance: r.name, generation: Number(r.db.meta("generation")), lease, failures: 0, tickedAt: clock.now(), newestTs: null },
      db: r.db,
    })),
  };
}

function viewOf(clock: Clock, instances: NowInstance[], over: Partial<NowViewOptions> = {}): ReturnType<typeof createNowView> {
  return createNowView({
    instances, clock,
    readPlan: () => planOf([task("W1-T1"), task("W1-T2"), task("W1-T3"), task("W1-T4"), task("W1-T5")]),
    github: () => ({ github: stubGateway(), generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 1 },
    ...over,
  });
}

function only(bodies: Array<{ key: string; data: NowViewData }>, key = "instance=core"): NowViewData {
  const body = bodies.find((b) => b.key === key);
  assert.ok(body, `a body for ${key}: got ${bodies.map((b) => b.key).join(",") || "none"}`);
  return body.data;
}

/** The legacy GET /v1/status board: the same function over the LIVE FILE ONLY, as `createBoardSnapshotCache` reads it. */
function legacyBoard(ledgerDir: string, plan: Plan, clock: Clock): BoardSnapshot {
  const ledgerPath = join(ledgerDir, "ledger.ndjson");
  return computeBoardSnapshot({ plan, ledgerPath, github: stubGateway(), readLedger: () => readLedgerLines(ledgerPath), now: () => clock.now() });
}

const PLAN = planOf([task("W1-T1"), task("W1-T2"), task("W1-T3"), task("W1-T4"), task("W1-T5")]);

function boardRows(r: Rig, clock: Stepped): void {
  clock.set(T0);
  r.append({ step: "escalation.issue_opened", task_id: "W1-T2", issue_url: "https://github.com/o/r/issues/5", class: "MANUAL" });
  r.append({ run_id: "run-W1-T3", task_id: "W1-T3", step: "dispatch.blocked_independent", verdict: "failed" });
  clock.set(T0 + 30_000);
  r.append({ step: "run.start", task_id: "W1-T1", run_id: "r1" });
  clock.set(T0 + 60_000);
}

test("the now view's board groups equal the legacy status board groups on a fixture", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  boardRows(core, clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }]);
  const data = only(view.materialize(ctxOf(clock, [core])));
  const legacy = legacyBoard(core.ledgerDir, PLAN, clock);
  // Positive control: every group holds a row, so the equality below compares something.
  assert.deepEqual(data.board.groups, { running: ["W1-T1"], needsYou: ["W1-T2"], blocked: ["W1-T3"], queued: ["W1-T4", "W1-T5"] });
  assert.deepEqual(data.board.groups, groupNowBoard(legacy.tasks));
  assert.deepEqual(data.board.counts, { running: legacy.counts.running, queued: legacy.counts.queued, blocked: legacy.counts.blocked });
  assert.deepEqual(nowBoardShadowDiff(data, legacy, [], T0), [], "no difference to classify");
  assert.equal(data.board.tasks.find((x) => x.taskId === "W1-T2")?.escalation?.issueUrl, "https://github.com/o/r/issues/5");
  assert.equal(data.board.tasks.find((x) => x.taskId === "W1-T1")?.phase !== undefined, true);

  // The ledger clock moves past W1-T1's lone start: the reused board re-derives it exactly as the legacy board does.
  clock.set(T0 + 30_000 + DEFAULT_LIVENESS_BOUND_MS + 60_000);
  core.append({ step: "verdict", task_id: "W1-T4", run_id: "r4", verdict: "no_pr" });
  const later = only(view.materialize(ctxOf(clock, [core])));
  const legacyLater = legacyBoard(core.ledgerDir, PLAN, clock);
  assert.equal(later.board.groups.running.includes("W1-T1"), false, "the lone start is no longer running");
  assert.deepEqual(later.board.groups, groupNowBoard(legacyLater.tasks));
});

test("full-history board diffs against the live-file legacy board are tagged legacy_horizon", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  // A rotation archived the block row: the live file no longer names W1-T3.
  const archived = { ts: new Date(T0 - 2 * 3_600_000).toISOString(), host: "h1", run_id: "run-W1-T3", task_id: "W1-T3", step: "dispatch.blocked_independent", verdict: "failed" };
  writeFileSync(join(core.ledgerDir, "ledger.2026-09-30T10-30-00-000Z.ndjson"), `${JSON.stringify(archived)}\n`);
  clock.set(T0);
  core.append({ step: "escalation.issue_opened", task_id: "W1-T2", issue_url: "https://github.com/o/r/issues/5", class: "MANUAL" });
  clock.set(T0 + 60_000);
  const data = only(viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }]).materialize(ctxOf(clock, [core])));
  const legacy = legacyBoard(core.ledgerDir, PLAN, clock);
  assert.deepEqual(data.board.groups.blocked, ["W1-T3"], "the view reads the archived row");
  const rows = [archived];
  assert.deepEqual(nowBoardShadowDiff(data, legacy, rows, T0), [{ taskId: "W1-T3", view: "blocked", legacy: "queued", classification: "legacy_horizon" }]);
  assert.deepEqual(nowBoardShadowDiff(data, legacy, rows, T0 - 3 * 3_600_000).map((d) => d.classification), ["bug"], "a diff the horizon cannot explain is a bug");
});

test("the now view reports host health for the selected instance, not core", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const site = rig(t, root, "site", clock);
  clock.set(T0);
  core.append({ step: "daemon.tick", poll_interval_ms: 60_000 });
  clock.set(T0 + 300_000);
  site.append({ step: "daemon.tick" });
  clock.set(T0 + 360_000);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }, { name: "site", ledgerDir: site.ledgerDir }], {
    hostProbe: { rateLimit: () => 4321, diskFree: (path) => (path === core.ledgerDir ? 111 : path === site.ledgerDir ? 222 : undefined) },
  });
  const bodies = view.materialize(ctxOf(clock, [core, site]));
  const coreHealth = only(bodies).health;
  const siteHealth = only(bodies, "instance=site").health;
  // Core last polled 6 min ago (silent, stamped with that poll's own time); the site 1 min ago (polling, no time).
  assert.deepEqual({ disk: coreHealth.diskFreeBytes, rate: coreHealth.rateLimitRemaining, daemon: coreHealth.daemon }, { disk: 110, rate: 4300, daemon: { state: "silent", at: new Date(T0).toISOString(), reason: "no daemon.* row for over 5 min" } });
  assert.deepEqual({ disk: siteHealth.diskFreeBytes, rate: siteHealth.rateLimitRemaining, daemon: siteHealth.daemon }, { disk: 220, rate: undefined, daemon: { state: "polling" } });
  assert.match(siteHealth.reasons?.rateLimitRemaining ?? "", /core's GitHub token/);
  const hostSource = bodies.find((b) => b.key === "instance=site")?.sources.find((s) => s.name === "host-probe:site");
  assert.equal(hostSource?.asOf, new Date(T0 + 360_000).toISOString());

  const blind = defaultProbeHost({ name: "core", ledgerDir: join(root, "nowhere") }, true, clock, { rateLimit: () => undefined, diskFree: () => undefined }).health;
  assert.deepEqual(Object.keys(blind.reasons ?? {}).sort(), ["diskFreeBytes", "rateLimitRemaining"]);
  assert.deepEqual([blind.diskFreeBytes, blind.rateLimitRemaining], [undefined, undefined]);
  assert.deepEqual(blind.daemon, { state: "silent", reason: "no daemon.* row in the instance's live ledger" });
});

test("an action's strike count is a structured field", () => {
  assert.deepEqual(parseStrike("fix strike repeated the identical unmet criteria (strike 1/2) — escalating"), { n: 1, of: 2 });
  assert.deepEqual(parseStrike("fix strikes exhausted (3/2) — escalating"), { n: 3, of: 2 });
  assert.deepEqual(parseStrike("exhausted: fix strikes 2/2"), { n: 2, of: 2 });
  assert.deepEqual(parseStrike("its shared fix budget is exhausted (2/2)"), { n: 2, of: 2 });
  assert.equal(parseStrike("conflicted with main"), undefined);
  const rows = [
    { ts: "2026-09-30T11:00:00.000Z", step: "sweep.disposed", pr_number: 11, disposition: "wait" },
    { ts: "2026-09-30T11:05:00.000Z", step: "sweep.disposed", pr_number: 11, disposition: "blocked-fixable" },
    { ts: "2026-09-30T11:10:00.000Z", step: "automerge.hold_engaged", pr_number: 13 },
    { ts: "2026-09-30T11:11:00.000Z", step: "sweep.disposed" },
  ];
  const actions = nowActions({
    blockedPrs: [
      { kind: "blocked_pr", prNumber: 11, prUrl: "https://github.com/o/r/pull/11", taskId: "W1-T1", disposition: "blocked-fixable", reason: "unmet criteria (strike 1/2)" },
      { kind: "blocked_pr", prNumber: 12, disposition: "blocked-ambiguous", reason: "fix strikes exhausted (3/2) — escalating" },
      { kind: "blocked_pr", prNumber: 14, disposition: "conflicted", reason: "conflicts with main" },
    ],
    mergeHeld: [{ prNumber: 13, taskId: "W1-T3", by: "operator", reason: "hold for the release" }, { by: "operator", reason: "fleet hold" }],
  }, rows);
  assert.deepEqual(actions.map((a) => [a.prNumber ?? null, a.tone, a.strike ?? null, a.sortAt ?? null]), [
    [12, "exhausted", { n: 3, of: 2 }, null],
    [13, "held", null, "2026-09-30T11:10:00.000Z"],
    [null, "held", null, null],
    [14, "unknown", null, null],
    [11, "repairing", { n: 1, of: 2 }, "2026-09-30T11:05:00.000Z"],
  ]);
  assert.equal(actions.at(-1)?.taskId, "W1-T1");
  assert.equal(actions.at(-1)?.prUrl, "https://github.com/o/r/pull/11");
});

function openPr(number: number, taskId: string): BoardPrRest {
  return {
    number, url: `https://github.com/o/r/pull/${number}`, state: "OPEN", headRefName: `run-${taskId}-1790000000000`, headRefOid: `sha-${number}`,
    body: "work in progress", autoMergeRequest: null, title: `open ${number}`, updatedAt: "2026-09-30T11:00:00Z",
  };
}

function restPull(row: BoardPrRest): Record<string, unknown> {
  return {
    number: row.number, html_url: row.url, state: row.state === "OPEN" ? "open" : "closed", merged_at: null, body: row.body, title: row.title,
    updated_at: row.updatedAt, head: { ref: row.headRefName, sha: row.headRefOid }, auto_merge: row.autoMergeRequest,
  };
}

test("the now view shows open pull requests from the persisted snapshot", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const instanceRoot = join(root, "console");
  const inst = rig(t, root, "console", clock);
  inst.append({ step: "daemon.tick" });
  const plan = planOf([task("W1-T7"), task("W1-T8")]);
  const instance: NowInstance = { name: "console", ledgerDir: inst.ledgerDir, repo: "o/r" };
  const withoutSnapshot = only(createNowView({ instances: [instance], clock, readPlan: () => plan, hostProbe: { rateLimit: () => 1 } })
    .materialize(ctxOf(clock, [inst])), "instance=console");
  assert.deepEqual(withoutSnapshot.prQueue.rows, [], "before the gateway persists its open half there is nothing to show");

  // The legacy gateway fetches its open half as it always has; the snapshot cache now persists it.
  const logged: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const open = [openPr(9001, "W1-T7")];
  const calls: string[] = [];
  const gateway = buildBatchedGithub("o", "r", {
    ttlMs: 0, now: () => clock.now(),
    snapshotCache: createBoardSnapshotCache(instanceRoot, "o", "r", { log: (event, extra) => logged.push({ event, ...(extra ? { extra } : {}) }) }),
    exec: (args) => {
      calls.push(args[1] ?? "");
      return /state=open/.test(args[1] ?? "") ? JSON.stringify(open.map(restPull)) : "[]";
    },
  });
  assert.deepEqual(gateway.listOpenHeadBranches!()?.map((p) => p.number), [9001]);
  gateway.listOpenHeadBranches!();
  const committed = () => logged.filter((l) => l.event === "board_snapshot.committed" && l.extra?.channel === "open").length;
  assert.equal(committed(), 1, "an unchanged open set within a minute is not rewritten");
  clock.set(T0 + OPEN_SNAPSHOT_RESAVE_MS);
  gateway.listOpenHeadBranches!();
  assert.equal(committed(), 2, "a minute later it is re-saved, so its age stays honest");
  assert.equal(calls.filter((c) => /state=open/.test(c)).length, 3, "no GitHub read beyond the gateway's own");

  const bodies = createNowView({ instances: [instance], clock, readPlan: () => plan, hostProbe: { rateLimit: () => 1 } })
    .materialize(ctxOf(clock, [inst]));
  const data = only(bodies, "instance=console");
  assert.deepEqual(data.prQueue.rows.map((r) => [r.prNumber, r.taskId]), [[9001, "W1-T7"]]);
  assert.equal(data.board.tasks.find((x) => x.taskId === "W1-T7")?.prUrl, "https://github.com/o/r/pull/9001");
  const githubSource = bodies[0]!.sources.find((s) => s.name === "github:console");
  assert.deepEqual(githubSource, {
    name: "github:console", asOf: new Date(T0 + OPEN_SNAPSHOT_RESAVE_MS).toISOString(), state: "fresh", kind: "github", instance: "console", budgetMs: NOW_GITHUB_STALE_MS, lagMs: 0,
  });
  clock.set(T0 + OPEN_SNAPSHOT_RESAVE_MS + NOW_GITHUB_STALE_MS + 1_000);
  assert.match(String(snapshotGithub(instanceRoot, "o", "r", clock).source.reason), /last saved 181 s ago/);
});

test("the open snapshot refuses what it cannot keep and says why on read", (t) => {
  const root = scratch(t);
  const logged: string[] = [];
  const log = (event: string, extra?: Record<string, unknown>) => logged.push(`${event}:${String(extra?.reason ?? "")}`);
  assert.equal(createBoardSnapshotCache(root, "o", "r", { log, bounds: { maxBytes: 10 } }).commitOpen!([openPr(1, "W1-T1")], T0), false);
  assert.equal(createBoardSnapshotCache(root, "o", "r", { log }).commitOpen!([{ ...openPr(2, "W1-T2"), title: 7 as unknown as string }], T0), false);
  const failingIo = { mkdir: () => {}, openWrite: () => { throw new Error("disk full"); }, stat: () => { throw new Error("absent"); } } as unknown as BoardSnapshotIo;
  assert.equal(createBoardSnapshotCache(root, "o", "r", { log, io: failingIo }).commitOpen!([openPr(3, "W1-T3")], T0), false);
  assert.deepEqual(logged.filter((l) => l.startsWith("board_snapshot.commit_refused")), [
    "board_snapshot.commit_refused:oversized", "board_snapshot.commit_refused:invalid_row", "board_snapshot.commit_refused:write_failed",
  ]);
  assert.match((readOpenBoardSnapshot(root, "o", "r") as { reason: string }).reason, /unreadable/);
  const path = boardOpenSnapshotPath(root, "o", "r");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "board-open-snapshot", schema: 1, repository: "o/other", savedAt: "x", rows: [] }));
  assert.match((readOpenBoardSnapshot(root, "o", "r") as { reason: string }).reason, /another schema or repository/);
  writeFileSync(path, JSON.stringify({ type: "board-open-snapshot", schema: 1, repository: "o/r", savedAt: "x", rows: [{ number: 1 }] }));
  assert.match((readOpenBoardSnapshot(root, "o", "r") as { reason: string }).reason, /invalid row/);
  writeFileSync(path, JSON.stringify({ type: "board-open-snapshot", schema: 1, repository: "o/r", savedAt: "x" }));
  assert.deepEqual(readOpenBoardSnapshot(root, "o", "r"), { ok: true, snapshot: { repository: "o/r", savedAt: "x", rows: [] } });
});

test("the now view stays dark until its switch reads shadow or serve", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  core.append({ step: "daemon.tick" });
  const logged: string[] = [];
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { log: (step) => logged.push(step) });
  assert.deepEqual(view.materialize(ctxOf(clock, [core], null)), [], "no switch: dark");
  assert.deepEqual(view.materialize(ctxOf(clock, [core], "off")), []);
  assert.deepEqual(view.materialize(ctxOf(clock, [core], "shadow", "elsewhere")), [], "another serve holds the lease");
  assert.equal(view.materialize(ctxOf(clock, [core], "serve")).length, 1);
  assert.deepEqual(view.materialize(ctxOf(clock, [core], "serve")), [], "nothing moved: no new body");
  core.append({ step: "verdict", task_id: "W1-T4", run_id: "r4", verdict: "no_pr" });
  assert.equal(view.materialize(ctxOf(clock, [core])).length, 1, "a new generation re-materializes");
  clock.set(T0 + NOW_REFRESH_MS);
  assert.equal(view.materialize(ctxOf(clock, [core])).length, 1, "the clock re-materializes");
  core.append({ step: "verdict", task_id: "W1-T5", run_id: "r5", verdict: "no_pr" });
  assert.equal(view.materialize(ctxOf(clock, [core], "auto")).length, 1, "auto builds whatever its readiness");
  const stranger = ctxOf(clock, [core]);
  assert.deepEqual(view.materialize({ ...stranger, instances: [{ ...stranger.instances[0]!, state: { ...stranger.instances[0]!.state, instance: "unknown" } }] }), []);
  assert.deepEqual(logged, []);
});

test("decisions come from core's stores for core only and one failing instance leaves the others", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const site = rig(t, root, "site", clock);
  const bare = rig(t, root, "bare", clock);
  const feedbackRoot = join(root, "checkout");
  mkdirSync(join(feedbackRoot, "plan", "feedback"), { recursive: true });
  for (const [id, status] of [["fb-1", "grilling"], ["fb-2", "grilling"], ["fb-3", "new"]]) {
    writeFileSync(join(feedbackRoot, "plan", "feedback", `${id}.yaml`), `id: ${id}\nts: "2026-09-30T10:00:00.000Z"\nraw: "which way for ${id}?"\nstatus: ${status}\n`);
  }
  const logged: Array<Record<string, unknown>> = [];
  const view = viewOf(clock, [
    { name: "core", ledgerDir: core.ledgerDir, feedbackRoot },
    { name: "site", ledgerDir: site.ledgerDir, feedbackRoot },
    { name: "bare", ledgerDir: bare.ledgerDir },
  ], {
    coreInstance: "core",
    readPlan: (instance) => {
      if (instance.name === "bare") throw new Error("plan unreadable");
      return PLAN;
    },
    log: (step, extra) => logged.push({ step, ...extra }),
  });
  const bodies = view.materialize(ctxOf(clock, [core, site, bare]));
  assert.deepEqual(only(bodies).decisions.map((d) => [d.id, d.answer.path, d.answer.fields]), [["grill:fb-1", "/v1/feedback", { replyTo: "fb-1" }], ["grill:fb-2", "/v1/feedback", { replyTo: "fb-2" }]]);
  assert.equal(only(bodies).decisionsReasons, undefined);
  assert.deepEqual(only(bodies, "instance=site").decisionsReasons, { grill: "feedback questions live in core only", task_question: "the question store core answers is core's own" });
  assert.equal(bodies.some((b) => b.key === "instance=bare"), false);
  assert.deepEqual(logged, [{ step: "read_model.now_view_failed", instance: "bare", error: "plan unreadable" }]);
  const unrooted = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }]).materialize(ctxOf(clock, [core]));
  assert.deepEqual(only(unrooted).decisionsReasons, { grill: "no feedback root is configured", task_question: "no feedback root is configured" });
});

/** Core with a feedback root and a QUESTION on the open task W1-T1, asked at T0 - 1 h. */
function questionRig(t: TestCtx): { clock: Stepped; core: Rig; view: ReturnType<typeof createNowView>; feedbackRoot: string } {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const feedbackRoot = join(root, "checkout");
  mkdirSync(join(feedbackRoot, "plan"), { recursive: true });
  const asked = { ts: new Date(T0 - 3_600_000).toISOString(), task: "W1-T1", question: "keep the old route for one release?", current_assumption: "yes, one release", impact_if_wrong: "low" };
  writeFileSync(join(feedbackRoot, "plan", "questions.ndjson"), `${JSON.stringify(asked)}\n`);
  core.append({ step: "daemon.tick" });
  return { clock, core, feedbackRoot, view: viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir, feedbackRoot }], { listGrilling: () => [] }) };
}

test("an unanswered task question appears as a decision with the questions answer route", (t) => {
  const { clock, core, view } = questionRig(t);
  const data = only(view.materialize(ctxOf(clock, [core])));
  assert.deepEqual(data.decisions, [{
    id: `question:W1-T1:${new Date(T0 - 3_600_000).toISOString()}`, kind: "task_question", instance: "core", taskId: "W1-T1", title: "task W1-T1",
    prompt: "keep the old route for one release?", askedAt: new Date(T0 - 3_600_000).toISOString(), currentAssumption: "yes, one release", impactIfWrong: "low",
    answer: { method: "POST", path: "/v1/questions/answer", tier: "low", fields: { taskId: "W1-T1" }, input: "text" },
  }]);
});

test("a panel question answered row removes the decision", (t) => {
  const { clock, core, view } = questionRig(t);
  const before = only(view.materialize(ctxOf(clock, [core])));
  assert.equal(before.decisions.length, 1, "control: the question is open first");
  // The answer route's store write failed (recorded_to_question_store false): the ledgered fact alone answers it.
  clock.set(T0 + 1_000);
  core.append({ step: "panel.question_answered", task_id: "W1-T1", answer: "yes", recorded_to_question_store: false });
  const after = only(view.materialize(ctxOf(clock, [core])));
  assert.deepEqual(after.decisions, []);
  assert.notEqual(viewEtag("now", 3, false, after), viewEtag("now", 3, false, before), "the decision's absence moves the etag");
});

test("an answer in the question store removes the decision and the clock alone never moves the etag", (t) => {
  const { clock, core, view, feedbackRoot } = questionRig(t);
  const first = only(view.materialize(ctxOf(clock, [core])));
  clock.set(T0 + NOW_REFRESH_MS + 1_000);
  const later = only(view.materialize(ctxOf(clock, [core])));
  assert.equal(viewEtag("now", 3, false, later), viewEtag("now", 3, false, first), "a re-materialize 31 s later changes nothing in data");
  appendFileSync(join(feedbackRoot, "plan", "questions.ndjson"), `${JSON.stringify({ ts: new Date(T0).toISOString(), task: "W1-T1", answer: "no", origin: "tok" })}\n`);
  // A distinct mtime whatever the filesystem's resolution: the answer is what moved it.
  utimesSync(join(feedbackRoot, "plan", "questions.ndjson"), new Date(T0), new Date("2030-01-01T00:00:00.000Z"));
  clock.set(T0 + NOW_REFRESH_MS + 2_000);
  const answered = view.materialize(ctxOf(clock, [core]));
  assert.deepEqual(only(answered).decisions, [], "the store's mtime made the view due before its 30 s refresh");
});

test("the default seams read each instance's own plan and snapshot", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const planPath = join(root, "checkout", "plan", "tasks.yaml");
  mkdirSync(join(root, "checkout", "plan", "tasks.d"), { recursive: true });
  writeFileSync(planPath, "- id: W1-T1\n  title: first\n  repo: remudero\n  depends_on: []\n  type: implement\n  risk: medium\n  verify: auto\n  status: queued\n");
  assert.equal(nowPlanPath({ name: "core", ledgerDir: core.ledgerDir, planPath }), planPath);
  assert.equal(nowPlanPath({ name: "site", ledgerDir: join(root, "site", "state"), repo: "o/site" }), join(root, "site", "repos", "site", "plan", "tasks.yaml"));
  assert.equal(nowPlanPath({ name: "x", ledgerDir: join(root, "x", "state") }), undefined);
  const logged: Array<Record<string, unknown>> = [];
  const view = createNowView({ instances: [{ name: "core", ledgerDir: core.ledgerDir, planPath, repo: "o/r" }, { name: "x", ledgerDir: core.ledgerDir }], clock,
    hostProbe: { rateLimit: () => 1 }, ledgerSource: (state) => ({ name: `ledger:${state.instance}`, asOf: null, state: "fresh" }), log: (step, extra) => logged.push({ step, ...extra }) });
  const x = ctxOf(clock, [core]);
  const bodies = view.materialize({ ...x, instances: [...x.instances, { ...x.instances[0]!, state: { ...x.instances[0]!.state, instance: "x" } }] });
  const data = only(bodies);
  assert.deepEqual(data.board.tasks.map((r) => r.taskId), ["W1-T1"]);
  // The default plan judge reads git, and this checkout is no repository: unknowable, never assumed fresh.
  assert.deepEqual(bodies[0]!.sources.map((s) => `${s.name}=${s.state}`), ["ledger:core=fresh", "github:core=stale", "plan:core=unavailable", "host-probe:core=fresh"]);
  assert.match(String(bodies[0]!.sources.find((s) => s.name === "plan:core")?.reason), /cannot compare the plan's checkout with origin\/main/);
  assert.match(String(logged[0]?.error), /names no repository/);
});

test("the now view judges its plan and host probe sources instead of calling them fresh", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { planBehind: () => ({ commits: 1, sinceMs: T0 - PLAN_BUDGET_MS - 1_000 }) });
  const sources = view.materialize(ctxOf(clock, [core]))[0]!.sources;
  const plan = sources.find((s) => s.name === "plan:core");
  assert.deepEqual({ state: plan?.state, phase: plan?.phase, reason: plan?.reason, budgetMs: plan?.budgetMs }, { state: "stale", phase: "behind", reason: "plan 1 merge behind origin/main", budgetMs: PLAN_BUDGET_MS });
  const probe = sources.find((s) => s.name === "host-probe:core");
  assert.deepEqual([probe?.state, probe?.kind, probe?.budgetMs, probe?.asOf], ["fresh", "host-probe", HOST_PROBE_BUDGET_MS, new Date(T0).toISOString()]);
});

test("merged today is exact: one per task and pull request, today and in the plan only", () => {
  const rows = [
    { ts: "2026-09-30T01:00:00.000Z", step: "pr.opened", run_id: "r1", task_id: "W1-T1", pr_url: "https://github.com/o/r/pull/1" },
    { ts: "2026-09-30T02:00:00.000Z", step: "verdict", verdict: "merged", run_id: "r1", task_id: "W1-T1" },
    { ts: "2026-09-30T02:05:00.000Z", step: "verdict.merged", task_id: "W1-T1", pr_url: "https://github.com/o/r/pull/1" },
    { ts: "2026-09-30T03:00:00.000Z", step: "verdict.merged", task_id: "W1-T2", pr_url: "https://github.com/o/r/pull/2" },
    { ts: "2026-09-29T23:59:00.000Z", step: "verdict.merged", task_id: "W1-T3", pr_url: "https://github.com/o/r/pull/3" },
    { ts: "2026-09-30T04:00:00.000Z", step: "verdict.merged", task_id: "SWEEP", pr_url: "https://github.com/o/r/pull/4" },
    { ts: "2026-09-30T04:00:00.000Z", step: "verdict", verdict: "no_pr", task_id: "W1-T3" },
  ];
  assert.deepEqual(mergedTodayCount(rows, PLAN, Date.parse("2026-09-30T12:00:00.000Z")), { count: 2, day: "2026-09-30" });
});

test("a large plan carries every id in its groups and bounds its queued rows", () => {
  const tasks = Array.from({ length: NOW_QUEUED_ROWS + 5 }, (_, i) => ({ taskId: `W1-T${i}`, title: `t${i}`, risk: "medium", status: "queued", merged: false, source: "none" }));
  const groups = groupNowBoard([...tasks, { taskId: "W1-TX", title: "x", risk: "low", status: "mystery", merged: false, source: "none" }] as never);
  assert.equal(groups.queued.length, NOW_QUEUED_ROWS + 6, "an unknown status still lands in queued");
  assert.equal(NOW_HOST_PROBE_MS > NOW_REFRESH_MS, true);
});

test("a now shadow sample is diffed against the legacy live-file board and each diff is classified", (t) => {
  const root = scratch(t);
  const ledgerDir = join(root, "core", "state");
  mkdirSync(join(ledgerDir, "read-model"), { recursive: true });
  const line = (r: Record<string, unknown>): string => `${JSON.stringify({ host: "h1", ...r })}\n`;
  // W1-T1 merged in a rotated archive: the view (full history) sees it, legacy's live-file board never does.
  writeFileSync(join(ledgerDir, "ledger.2026-09-30T09-00-00-000Z.ndjson.gz"), gzipSync([
    line({ ts: new Date(T0 - 3 * 3_600_000).toISOString(), step: "run.start", run_id: "r1", task_id: "W1-T1" }),
    line({ ts: new Date(T0 - 2 * 3_600_000).toISOString(), step: "verdict", run_id: "r1", task_id: "W1-T1", verdict: "merged" }),
    line({ ts: new Date(T0 - 2 * 3_600_000).toISOString(), step: "dispatch.blocked_independent", run_id: "r3", task_id: "W1-T3", verdict: "failed" }),
  ].join("")));
  writeFileSync(join(ledgerDir, "ledger.ndjson"), line({ ts: new Date(T0 - 60_000).toISOString(), step: "run.start", run_id: "r2", task_id: "W1-T2" }));
  writeFileSync(readModelSwitchesPath(ledgerDir), JSON.stringify({ views: { now: "shadow" } }));
  const clock = stepped();
  let free = 1_000;
  // Every probe reads a different free-disk figure, as two samples moments apart do.
  const view = viewOf(clock, [{ name: "core", ledgerDir }], { listGrilling: () => [], hostProbe: { rateLimit: () => 4321, diskFree: () => (free += 7) } });
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir: ledgerDir, instances: [{ name: "core", ledgerDir }], views: [view], clock, holder: "shadow-now", post: (m) => void posted.push(m) });
  t.after(() => ticker.release());
  ticker.tick();
  const body = posted.find((m) => m.type === "body" && m.entry.view === "now");
  assert.ok(body && body.type === "body", "the view materialized under shadow");
  assert.equal(view.legacy("instance=elsewhere", T0, body.entry.body.data), undefined, "an instance the view never held has no legacy side");

  assert.equal(ticker.shadow({ view: "now", key: "instance=core", requests: 1 }), true, "the worker computed the legacy side and compared");
  const row = posted.find((m) => m.type === "log" && m.step === VIEW_SHADOW_DIFF_STEP);
  assert.ok(row && row.type === "log", "a view.shadow_diff row was written");
  const diffs = row.extra.diffs as Array<{ path: string; classification: string }>;
  const merged = diffs.find((d) => d.path.startsWith("board.tasks[taskId=W1-T1]"));
  assert.equal(merged?.classification, "legacy_horizon", JSON.stringify(diffs));
  assert.ok(diffs.every((d) => (SHADOW_CLASSIFICATIONS as readonly string[]).includes(d.classification)));
  const counts = diffs.filter((d) => d.path.startsWith("board.counts"));
  assert.deepEqual(counts.map((d) => [d.path, d.classification]), [["board.counts.blocked", "legacy_horizon"], ["board.counts.queued", "legacy_horizon"]],
    "W1-T3's archived block moves it between two counts: measured horizon rows name it");
  assert.equal(diffs.filter((d) => d.classification === "real").length, 0, JSON.stringify(diffs));
  assert.equal(diffs.some((d) => d.path.startsWith("health") || d.path.startsWith("prQueue") || d.path.startsWith("recent")), false, "the probes and the PR queue agree");
});

test("a sweep re-emitting the disposition it already recorded changes nothing in the now body", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  boardRows(core, clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }]);
  const sweep = (disposition: string): void => core.append({ step: "sweep.disposed", task_id: "W1-T4", pr_number: 40, disposition, reason: `${disposition} (strike 1/2)` });
  const activity = (d: NowViewData): string | undefined => d.board.tasks.find((x) => x.taskId === "W1-T4")?.lastActivityAt;
  const sortAt = (d: NowViewData): string | undefined => d.actions.find((a) => a.prNumber === 40)?.sortAt;

  clock.set(T0 + 120_000);
  sweep("blocked-fixable");
  const first = only(view.materialize(ctxOf(clock, [core])));
  // Positive control: the sweep row is both W1-T4's activity and its action's time, so the equality below compares them.
  assert.equal(activity(first), new Date(T0 + 120_000).toISOString());
  assert.equal(sortAt(first), new Date(T0 + 120_000).toISOString(), JSON.stringify(first.actions));

  clock.set(T0 + 150_000);
  sweep("blocked-fixable");
  const repeated = view.materialize(ctxOf(clock, [core]));
  assert.equal(repeated.length, 1, "the new generation re-materialized the body");
  assert.deepEqual(only(repeated), first, "the same disposition again is not activity: the body, and so its ETag, is unchanged");

  clock.set(T0 + 180_000);
  sweep("blocked-ambiguous");
  const changed = only(view.materialize(ctxOf(clock, [core])));
  assert.equal(activity(changed), new Date(T0 + 180_000).toISOString(), "a new disposition is activity");
  assert.equal(sortAt(changed), new Date(T0 + 180_000).toISOString());
});

test("host gauges are rounded down to two significant figures", () => {
  assert.deepEqual([0, 87, 99, 100, 4_321, 4_399, 5_000, 50_123_456_789].map(twoSignificantFigures), [0, 87, 99, 100, 4_300, 4_300, 5_000, 50_000_000_000]);
  const probe = (rate: number, free: number) => defaultProbeHost({ name: "core", ledgerDir: "/nonexistent-now-view" }, true, stepped(), { readLive: () => [], rateLimit: () => rate, diskFree: () => free }).health;
  assert.deepEqual(probe(4_321, 12_345_678_901), probe(4_388, 12_399_999_999), "two probes a minute apart read the same gauges");
  assert.notDeepEqual(probe(4_321, 1_000), probe(4_288, 1_000), "a gauge crossing a figure still moves");
});

/** One shadow comparison of a materialized `now` body against its legacy side, judged on the rig's own read model. */
function compareNow(view: ReturnType<typeof createNowView>, r: Rig, body: { data: NowViewData; sources: Array<{ asOf: string | null }> }, now: number): Array<{ path: string; classification: string; reason: string }> {
  const legacy = view.legacy("instance=core", now, body.data);
  assert.ok(legacy, "the view holds core");
  const shadow = createViewShadow({ clock: fixedClock(now), log: () => {}, evidence: (input) => readShadowEvidence([r.db], input) });
  const asOf = body.sources.flatMap((s) => (s.asOf ? [s.asOf] : [])).sort()[0] ?? null;
  return shadow.compare({ view: "now", key: "instance=core", requests: 0, legacy, body: { data: body.data, asOf } }).diffs;
}

test("a sample taken before the read model ingests a claim is timing across counts groups spend and the task window", (t) => {
  // Captured 2026-10-01T05:47:09Z: board.counts.running, groups.running, spendTodayUsd, taskProjection.returned and a
  // whole board.tasks[taskId=…] entry read real while W1-T4810's newest rows sat in the live file only.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const queued = Array.from({ length: NOW_QUEUED_ROWS + 5 }, (_, i) => task(`W1-T${100 + i}`));
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], {
    readPlan: () => planOf([task("W1-T4810"), ...queued]), listGrilling: () => [],
    ledgerSource: (state) => ({ name: "ledger:core", asOf: state.newestTs, state: "fresh" }),
  });
  clock.set(T0 - 60_000);
  core.append({ step: "daemon.tick" });
  // Stamped before the build, but the projector has not ingested them: the body's ledger is as of the tick.
  const late = [
    { ts: new Date(T0 - 30_000).toISOString(), host: "h1", step: "run.start", task_id: "W1-T4810", run_id: "W1-T4810-1790831583056" },
    { ts: new Date(T0 - 29_000).toISOString(), host: "h1", step: "implement.done", task_id: "W1-T4810", run_id: "W1-T4810-1790831583056", cost_usd: 0.42 },
  ];
  appendFileSync(join(core.ledgerDir, "ledger.ndjson"), late.map((r) => `${JSON.stringify(r)}\n`).join(""));
  clock.set(T0);
  const ctx = ctxOf(clock, [core]);
  ctx.instances[0]!.state.newestTs = new Date(T0 - 60_000).toISOString();
  const [body] = view.materialize(ctx);
  assert.ok(body);
  const diffs = compareNow(view, core, body, T0 + 90_000);
  const byPath = Object.fromEntries(diffs.map((d) => [d.path, d.classification]));
  assert.equal(byPath["board.counts.running"], "timing", JSON.stringify(diffs));
  assert.equal(byPath["board.groups.running"], "timing");
  assert.equal(byPath["board.groups.queued"], "timing");
  assert.equal(byPath["board.spendTodayUsd"], "timing");
  assert.equal(byPath["board.taskProjection.returned"], "timing");
  assert.equal(byPath[`board.tasks[taskId=W1-T${100 + NOW_QUEUED_ROWS - 1}]`], "timing", "the task the window let in on one side only");
  assert.deepEqual(diffs.filter((d) => d.classification === "real"), []);
});

test("the daemon's poll state is compared at the view's own probe instant", (t) => {
  // Captured 2026-10-01T05:37:24Z: health.daemon.{state,at,reason} read real because legacy probed minutes after the view.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  clock.set(T0 - 270_000);
  core.append({ step: "daemon.tick" });
  clock.set(T0);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.deepEqual(body.data.health.daemon, { state: "polling" });
  const diffs = compareNow(view, core, body, T0 + 90_000);
  assert.deepEqual(diffs.filter((d) => d.path.startsWith("health")), [], "both sides judge the poll 4.5 min old, not 6");
});

test("a daemon row appended after the probe read but stamped before its instant leaves both sides on that read", (t) => {
  // Captured 2026-10-02T05:32:20Z on site: health.daemon.state legacy polling vs view silent at 05:26:55. deploy/entrypoint.sh
  // stamps each idle_starved pulse to the second, so the 05:31:58.000 pulse landed after the 05:31:58.358 probe had read the
  // live file. Legacy re-read the file 22 s later and took every row stamped by the probe's instant, that pulse included.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  const probeMs = T0 + 358;
  core.append({ step: "daemon.idle_starved.pulse", ts: new Date(probeMs - 603_358).toISOString() });
  clock.set(probeMs);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.equal(body.data.health.daemon.state, "silent", "the probe read the last idle pulse 10 min 3 s old, past two cadences");
  const silent = compareNow(view, core, body, probeMs + 22_000).filter((d) => d.path.startsWith("health"));
  assert.deepEqual(silent, [], "a genuinely silent daemon reads silent on both sides");
  appendFileSync(join(core.ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: new Date(T0).toISOString(), step: "daemon.idle_starved.pulse", task_id: "DAEMON" })}\n`);
  const late = compareNow(view, core, body, probeMs + 22_000).filter((d) => d.path.startsWith("health"));
  assert.deepEqual(late, [], "legacy reads the rows the probe read, not every row stamped by its instant");
  // Negative control: the next probe reads the pulse, and a body claiming silent against it is real.
  clock.set(probeMs + 60_000);
  const [next] = view.materialize(ctxOf(clock, [core]));
  assert.ok(next);
  assert.equal(next.data.health.daemon.state, "polling", "positive control: the pulse is in the file");
  next.data.health = { ...next.data.health, daemon: { state: "silent", at: new Date(probeMs - 303_358).toISOString(), reason: "no daemon.* row for over 5 min" } };
  const wrong = compareNow(view, core, next, probeMs + 82_000);
  assert.equal(wrong.find((d) => d.path === "health.daemon.state")?.classification, "real", JSON.stringify(wrong));
});

test("a queued order the live file's compaction changed is judged by each task's own sort-key row", (t) => {
  // Captured 2026-10-01T06:33Z on the console instance: board.groups.queued read real with the same ids on both
  // sides. Compaction had pruned UI-T36's and UI-T35's newest sweep.disposed rows from the live file only.
  const root = scratch(t);
  const clock = stepped();
  const r = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: r.ledgerDir }], { readPlan: () => planOf([task("UI-T35"), task("UI-T36"), task("UI-T37")]), listGrilling: () => [] });
  const at = (ts: string, step: string, id: string): Record<string, unknown> => ({ ts, step, task_id: id, run_id: `r-${id}`, pr_number: 1 });
  const kept = [
    at("2026-09-20T20:28:12.102Z", "verdict.merged", "UI-T35"),
    at("2026-09-20T20:28:13.999Z", "verdict.merged", "UI-T36"),
    at("2026-09-20T20:47:36.765Z", "verdict.merged", "UI-T37"),
  ];
  const pruned = [at("2026-09-20T21:13:00.205Z", "sweep.disposed", "UI-T35"), at("2026-09-21T16:03:10.652Z", "sweep.disposed", "UI-T36")];
  r.append(...kept, ...pruned);
  clock.set(Date.parse("2026-10-01T06:33:28.040Z"));
  const [body] = view.materialize(ctxOf(clock, [r]));
  assert.ok(body);
  writeFileSync(join(r.ledgerDir, "ledger.ndjson"), kept.map((r) => `${JSON.stringify({ host: "h1", ...r })}\n`).join(""));
  const queued = compareNow(view, r, body, clock.now() + 30_000).find((d) => d.path === "board.groups.queued");
  assert.ok(queued, "the two sides order the queue differently");
  assert.equal(queued.classification, "legacy_horizon", queued.reason);
});

test("a build in flight leaves the legacy side on the plan github snapshot and probe of the body it compares", (t) => {
  // Captured 2026-10-01 13:42–13:45Z and 14:02–14:05Z: board.groups.queued and board.tasks[taskId=W1-T5091…] read real for 14
  // newly filed tasks, prQueue.rows[prNumber=8405] for a just-opened PR, and health.daemon.state silent vs polling. Legacy read
  // the in-flight build's held plan, GitHub snapshot and probe, which that build advances stage by stage before it publishes.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(planPath, "");
  let plan = planOf([task("W1-T1"), task("W1-T2")]);
  let open: Array<{ number: number; url: string; state: string; title: string; headRefName: string }> = [];
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir, planPath }], {
    readPlan: () => plan,
    listGrilling: () => [],
    github: () => {
      const listed = open;
      return { github: stubGateway({ listOpenHeadBranches: () => listed }), generation: "g", source: { asOf: null, state: "fresh" } };
    },
  });
  clock.set(T0 - 270_000);
  core.append({ step: "daemon.tick" });
  clock.set(T0);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.deepEqual(body.data.health.daemon, { state: "polling" });

  // A plan merge files two tasks, a PR opens and the store is reopened; the next build gets as far as its probe.
  plan = planOf([task("W1-T1"), task("W1-T2"), task("W1-T5091"), task("W1-T5092")]);
  utimesSync(join(root, "plan", "tasks.d"), new Date(T0 + 60_000), new Date(T0 + 60_000));
  open = [{ number: 8405, url: "https://github.com/o/r/pull/8405", state: "OPEN", title: "counter storage", headRefName: "run-unfiled-1" }];
  clock.set(T0 + 90_000);
  const reopened = openProjectorReadModel(join(root, "read-model-home"), "core", clock);
  t.after(() => reopened.close());
  const ctx = ctxOf(clock, [{ ...core, db: reopened }]);
  let budget = 5;
  assert.equal(view.prepare(ctx, () => budget-- > 0), false, "the build stopped after its probe and before it assembled a body");

  const diffs = compareNow(view, core, body, T0 + 100_000);
  assert.deepEqual(diffs.filter((d) => d.path.startsWith("board.groups") || d.path.startsWith("board.tasks") || d.path.startsWith("prQueue") || d.path.startsWith("health")), [], JSON.stringify(diffs));
  assert.deepEqual(diffs.filter((d) => d.classification === "real"), [], JSON.stringify(diffs));

  // Positive control: the build, once published, does carry what the in-flight build had read.
  const [next] = view.materialize(ctx);
  assert.ok(next);
  assert.ok(next.data.board.groups.queued.includes("W1-T5091"), JSON.stringify(next.data.board.groups));
  assert.deepEqual(next.data.prQueue.rows.map((r) => r.prNumber), [8405]);
  assert.equal(next.data.health.daemon.state, "silent");
});

test("a task the compared body drops from its own plan is still a real now diff", (t) => {
  // The negative control: a body missing a task its own plan holds is a wrong value, and no row or plan generation explains it.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { readPlan: () => planOf([task("W1-T1"), task("W1-T5091")]), listGrilling: () => [] });
  clock.set(T0);
  core.append({ step: "daemon.tick" });
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  body.data.board.groups.queued = body.data.board.groups.queued.filter((id) => id !== "W1-T5091");
  const queued = compareNow(view, core, body, T0 + 10_000).find((d) => d.path === "board.groups.queued");
  assert.equal(queued?.classification, "real", JSON.stringify(queued));
  assert.match(queued!.reason, /no measured row explains W1-T5091/);
});

test("a probe a build in flight took after the compared body is not the legacy side's probe instant", (t) => {
  // Captured 2026-10-01T14:05:10Z: health.daemon.state legacy silent vs view polling. With no store reopen, the probe stage alone
  // advances the held probe a minute after the published body's, and legacy judged the daemon's last poll at that later instant.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  clock.set(T0 - 270_000);
  core.append({ step: "daemon.tick" });
  clock.set(T0);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  clock.set(T0 + 90_000);
  let budget = 5;
  assert.equal(view.prepare(ctxOf(clock, [core]), () => budget-- > 0), false, "the build stopped after its probe");
  const diffs = compareNow(view, core, body, T0 + 100_000);
  assert.deepEqual(diffs.filter((d) => d.path.startsWith("health")), [], JSON.stringify(diffs));
  const [next] = view.materialize(ctxOf(clock, [core]));
  assert.equal(next?.data.health.daemon.state, "silent", "positive control: the in-flight probe did read the daemon silent");
});

test("a task whose newest row is a step the fact store skips sorts by that row on both sides", (t) => {
  // Captured 2026-10-01 16:08–16:48Z on core: board.groups.queued read real for W1-T5147, whose only rows were machine_judge.*,
  // a step the fact store never keeps, so the view sorted it last while legacy sorted it first; and board.groups.running read
  // real with the same members in another order, W1-T4933's newest row being sweep.fix.strike_schedule_plan.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  clock.set(T0);
  core.append({ step: "run.start", task_id: "W1-T1", run_id: "r1" });
  clock.set(T0 + 10_000);
  core.append({ step: "run.start", task_id: "W1-T2", run_id: "r2" });
  clock.set(T0 + 20_000);
  core.append({ step: "worker.activity", task_id: "W1-T1", run_id: "r1" });
  clock.set(T0 + 30_000);
  core.append({ step: "machine_judge.ruled", task_id: "W1-T5", action: "proceed" });
  clock.set(T0 + 40_000);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.deepEqual(body.data.board.groups.running, ["W1-T1", "W1-T2"], "the newer worker.activity row leads");
  assert.equal(body.data.board.groups.queued[0], "W1-T5", "a task with only machine_judge rows sorts by them");
  const diffs = compareNow(view, core, body, T0 + 50_000);
  assert.deepEqual(diffs.filter((d) => d.path.startsWith("board.groups")), [], JSON.stringify(diffs));
  assert.deepEqual(diffs.filter((d) => d.classification === "real"), [], JSON.stringify(diffs));
});

test("a running order no sort-key row explains is still a real now diff", (t) => {
  // The negative control: the same members in an order neither side's rows give is a wrong value, not an order to ignore.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  clock.set(T0);
  core.append({ step: "run.start", task_id: "W1-T1", run_id: "r1" });
  clock.set(T0 + 10_000);
  core.append({ step: "run.start", task_id: "W1-T2", run_id: "r2" });
  clock.set(T0 + 20_000);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.deepEqual(body.data.board.groups.running, ["W1-T2", "W1-T1"]);
  body.data.board.groups.running = ["W1-T1", "W1-T2"];
  const running = compareNow(view, core, body, T0 + 30_000).find((d) => d.path === "board.groups.running");
  assert.equal(running?.classification, "real", JSON.stringify(running));
});

test("a rotation after the view's probe leaves the legacy probe on the rows that probe read", (t) => {
  // Captured 2026-10-01T16:18:08Z and 16:38:54Z: health.daemon.{state,at,reason} read legacy silent at a carried 16:00:06 or
  // 16:27:19 row against view polling. The 16:17:23 and 16:37:53 rotations moved every newer daemon.* row out of the live file
  // after the view had probed it, and legacy re-read the live file alone.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  clock.set(T0 - 600_000);
  core.append({ step: "daemon.boot" });
  clock.set(T0 - 60_000);
  core.append({ step: "daemon.tick" });
  clock.set(T0);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.deepEqual(body.data.health.daemon, { state: "polling" });
  const live = join(core.ledgerDir, "ledger.ndjson");
  const text = readFileSync(live, "utf8");
  const rotation = `ledger.${new Date(T0 + 30_000).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`;
  writeFileSync(join(core.ledgerDir, rotation), gzipSync(text));
  const plain = `ledger.${new Date(T0 - 900_000).toISOString().replace(/[:.]/g, "-")}.ndjson`;
  writeFileSync(join(core.ledgerDir, plain), "");
  writeFileSync(live, `${text.split("\n").filter((l) => l.includes("daemon.boot")).join("\n")}\n`);
  const logged: Array<Record<string, unknown>> = [];
  const judge = (data: NowViewData) => {
    const legacy = view.legacy("instance=core", T0 + 60_000, data);
    assert.ok(legacy);
    const shadow = createViewShadow({ clock: fixedClock(T0 + 60_000), log: (_step, extra) => logged.push(extra), evidence: (input) => readShadowEvidence([core.db], input) });
    return shadow.compare({ view: "now", key: "instance=core", requests: 0, legacy, body: { data, asOf: null } }).diffs.filter((d) => d.path.startsWith("health"));
  };
  assert.deepEqual(judge(body.data), [], "legacy probes the ledger as it stood at the view's probe");
  // Negative control: a daemon state the rows at the probe do not give is still real.
  body.data.health = { ...body.data.health, daemon: { state: "silent", at: new Date(T0 - 600_000).toISOString(), reason: "no daemon.* row for over 5 min" } };
  const wrong = judge(body.data);
  assert.equal(wrong.find((d) => d.path === "health.daemon.state")?.classification, "real", JSON.stringify(wrong));
  const read = (from: number, rotations: string[]) => ({ from: new Date(from).toISOString(), rotations, unread: [] });
  assert.deepEqual(logged.at(-1)?.inputs, {
    plan: "none", probeAt: new Date(T0).toISOString(), builtAt: new Date(T0).toISOString(), probeRows: 2,
    windows: { board: read(T0 - NOW_LEGACY_ROW_WINDOW_MS, [plain, rotation]), probe: read(T0, [rotation]), spend: read(Date.parse("2026-09-30T00:00:00.000Z"), [plain, rotation]) },
  }, "the diff row names what each window of legacy read");
});

test("a run priced first by a step outside the fact steps is in the view's day spend", (t) => {
  // Captured 2026-10-01T21:10:40Z on core: board.spendTodayUsd legacy 11.6470238 vs view 11.528704, the residual exactly
  // W1-T5115#W1-T5115-1790888555233@21:07:40.766Z, a containment.probe row carrying cost_usd. The fact store kept no
  // containment.probe or isolation.probe row, so the view's spend lacked that run until its first fact-step cost.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  const run = { task_id: "W1-T5", run_id: "W1-T5-1790888555233" };
  clock.set(T0);
  core.append({ step: "containment.probe", ...run, contained: true, cost_usd: 0.1183198 });
  clock.set(T0 + 120_000);
  core.append({ step: "isolation.probe", ...run, isolated: true, cost_usd: 0.05 });
  clock.set(T0 + 180_000);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.equal(body.data.board.spendTodayUsd, 0.1183198, "the run's first costed row is the day's spend on the view side");
  const costed = `${JSON.stringify({ ts: new Date(T0).toISOString(), step: "containment.probe", ...run, cost_usd: 0.1183198 })}`;
  assert.equal(factColumns(costed, isFactStep)?.step, "containment.probe", "the consistency oracle keeps the same row the projector does");
  assert.deepEqual(compareNow(view, core, body, T0 + 186_000).filter((d) => d.path === "board.spendTodayUsd"), []);
  // Negative control: a spend no paired row gives stays real.
  body.data.board.spendTodayUsd = 11.528704;
  const spend = compareNow(view, core, body, T0 + 186_000).find((d) => d.path === "board.spendTodayUsd");
  assert.equal(spend?.classification, "real", JSON.stringify(spend));
});

test("a rotation after the build leaves the legacy PR queue on the sweep rows the live file held then", (t) => {
  // Captured 2026-10-01T21:30:00Z on core: prQueue.rows[prNumber=8485].disposition legacy post-review vs view wait, and its
  // queueClass active vs waiting. The 21:29:08 rotation, after the 21:28:45 build, moved both wait rows out of the live file and
  // the compaction kept the older acted post-review row in it, so legacy re-read the live file alone and took that row.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const pr = { number: 8485, url: "https://github.com/o/r/pull/8485", state: "OPEN", title: "warm handoff", headRefName: "run-unfiled-1", headRefOid: "29b0b38e" };
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], {
    listGrilling: () => [],
    github: () => ({ github: stubGateway({ listOpenHeadBranches: () => [pr] }), generation: "g", source: { asOf: null, state: "fresh" } }),
  });
  const disposed = (disposition: string, acted: boolean) => ({ step: "sweep.disposed", pr_number: 8485, head_sha: "29b0b38e", disposition, acted, reason: disposition });
  clock.set(T0 - 600_000);
  core.append(disposed("post-review", true));
  clock.set(T0 - 300_000);
  core.append(disposed("wait", false));
  clock.set(T0);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.deepEqual(body.data.prQueue.rows.map((r) => [r.prNumber, r.disposition, r.queueClass]), [[8485, "wait", "waiting"]]);
  const live = join(core.ledgerDir, "ledger.ndjson");
  const text = readFileSync(live, "utf8");
  writeFileSync(join(core.ledgerDir, `ledger.${new Date(T0 + 23_000).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), gzipSync(text));
  writeFileSync(live, `${text.split("\n").filter((l) => l.includes('"acted":true')).join("\n")}\n`);
  const queue = () => compareNow(view, core, body, T0 + 75_000).filter((d) => d.path.startsWith("prQueue"));
  assert.deepEqual(queue(), [], "legacy reads the PR's sweep rows as the live file held them when the body was built");
  // Negative control: a disposition the paired rows do not give stays real.
  body.data.prQueue.rows[0]!.disposition = "mergeable";
  const wrong = queue();
  assert.equal(wrong.find((d) => d.path === "prQueue.rows[prNumber=8485].disposition")?.classification, "real", JSON.stringify(wrong));
});

test("a disposition the live file decides from a row the view's newer one superseded is legacy_horizon", (t) => {
  // Captured 2026-10-01T23:36:12Z on core: prQueue.rows[prNumber=8495].disposition legacy post-review vs view blocked-fixable
  // (builtAt 23:35:23, no rotation since). The 23:31:58 rotation, BEFORE that build, kept the head's one acted row (post-review,
  // 23:15:25) in the live file and archived its newer unacted blocked-fixable rows (23:20:22, 23:23:22); the fact store holds them.
  // Legacy now reads that rotation (below); this one is cut before legacy's row window, so its rows stay unseen.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const pr = { number: 8495, url: "https://github.com/o/r/pull/8495", state: "OPEN", title: "spend", headRefName: "run-W1-T5115-1", headRefOid: "b58cb560" };
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], {
    listGrilling: () => [],
    github: () => ({ github: stubGateway({ listOpenHeadBranches: () => [pr] }), generation: "g", source: { asOf: null, state: "fresh" } }),
  });
  const disposed = (disposition: string, acted: boolean) => ({ step: "sweep.disposed", pr_number: 8495, head_sha: "b58cb560", disposition, acted, reason: disposition });
  clock.set(T0 - NOW_LEGACY_ROW_WINDOW_MS - 1_200_000);
  core.append(disposed("post-review", true));
  clock.set(T0 - NOW_LEGACY_ROW_WINDOW_MS - 780_000);
  core.append(disposed("blocked-fixable", false));
  const live = join(core.ledgerDir, "ledger.ndjson");
  const text = readFileSync(live, "utf8");
  const [acted, unacted] = text.trim().split("\n");
  writeFileSync(join(core.ledgerDir, `ledger.${new Date(T0 - NOW_LEGACY_ROW_WINDOW_MS - 205_000).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), gzipSync(text));
  writeFileSync(live, `${acted}\n`);
  clock.set(T0);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.deepEqual(body.data.prQueue.rows.map((r) => [r.prNumber, r.disposition, r.queueClass]), [[8495, "blocked-fixable", "actionable"]]);
  const queue = () => compareNow(view, core, body, T0 + 49_000).filter((d) => d.path.startsWith("prQueue"));
  const got = queue();
  assert.deepEqual(got.map((d) => [d.path, d.classification]), [
    ["prQueue.rows[prNumber=8495].disposition", "legacy_horizon"],
    ["prQueue.rows[prNumber=8495].queueClass", "legacy_horizon"],
  ], JSON.stringify(got));
  // Negative control: a live file holding the view's row and a body deciding otherwise from it is a real disagreement.
  writeFileSync(live, `${unacted}\n${acted}\n`);
  body.data.prQueue.rows[0]!.disposition = "mergeable";
  const held = queue();
  assert.equal(held.find((d) => d.path === "prQueue.rows[prNumber=8495].disposition")?.classification, "real", JSON.stringify(held));
});

test("legacy takes the gauges its body's probe captured and never probes GitHub again", (t) => {
  // Captured 2026-10-01T22:35:05Z on core: health.rateLimitRemaining legacy undefined with reason "gh api rate_limit did not
  // answer" vs view 15000. Legacy re-ran gh api rate_limit at sample time and that one call failed.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  let rate: number | undefined = 15_000;
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [], hostProbe: { rateLimit: () => rate, diskFree: () => 1 } });
  clock.set(T0);
  core.append({ step: "daemon.tick" });
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.equal(body.data.health.rateLimitRemaining, 15_000);
  rate = undefined;
  assert.deepEqual(compareNow(view, core, body, T0 + 65_000).filter((d) => d.path.startsWith("health")), []);
  // Negative control: a gauge the body's own probe did not read stays real.
  body.data.health = { ...body.data.health, rateLimitRemaining: 9_900 };
  const wrong = compareNow(view, core, body, T0 + 65_000).find((d) => d.path === "health.rateLimitRemaining");
  assert.equal(wrong?.classification, "real", JSON.stringify(wrong));
});

test("the legacy side of a now sample makes no gh or exec call", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  let armed = false;
  const calls: string[] = [];
  const runner = (what: string) => {
    if (!armed) return;
    calls.push(what);
    throw new Error(`the legacy side ran ${what}`);
  };
  const open: BatchedPr[] = [{ number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", headRefName: "run-W1-T1-1", headRefOid: "abc", body: "", autoMergeRequest: null, title: "seven" }];
  const github = buildBatchedGithub("o", "r", {
    ttlMs: Number.MAX_SAFE_INTEGER, pacer: { wait() {}, recordResult() {} }, fetchAll: () => open, fetchAllIssues: () => [],
    exec: (args) => (runner(`gh ${args.join(" ")}`), JSON.stringify({ statuses: [] })),
  });
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], {
    listGrilling: () => [],
    github: () => ({ github, generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => (runner("gh api rate_limit"), 4321), diskFree: () => (runner("statfs"), 1) },
  });
  clock.set(T0);
  core.append({ step: "run.start", task_id: "W1-T1", run_id: "r1" }, { step: "pr.opened", task_id: "W1-T1", run_id: "r1", pr_url: open[0]!.url });
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.deepEqual(body.data.prQueue.rows.map((r) => r.prNumber), [7], "positive control: the build did read the gateway");
  armed = true;
  assert.ok(view.legacy("instance=core", T0 + 60_000, body.data));
  assert.deepEqual(calls, []);
});

/** A rotation file name for a cut at `ms`, in either form. */
const cutName = (ms: number, form: "gzip" | "plain"): string => `ledger.${new Date(ms).toISOString().replace(/[:.]/g, "-")}.ndjson${form === "gzip" ? ".gz" : ""}`;

/** Moves `lines` from the live file into a rotation cut at `ms`, as `rotateLedger` archives them. */
function archive(r: Rig, ms: number, form: "gzip" | "plain", lines: string[]): string {
  const name = cutName(ms, form);
  const text = `${lines.join("\n")}\n`;
  writeFileSync(join(r.ledgerDir, name), form === "gzip" ? gzipSync(text) : text);
  return name;
}

function liveLines(r: Rig): string[] {
  return readFileSync(join(r.ledgerDir, "ledger.ndjson"), "utf8").trim().split("\n");
}

test("legacy reads the newer sweep row a rotation before the build archived and matches the body", (t) => {
  // (a) The #8511 shape inside legacy's window: the 23:31:58 rotation, before the 23:35:23 build, archived PR 8495's newer
  // unacted blocked-fixable row and compaction kept its older acted post-review row live.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const pr = { number: 8495, url: "https://github.com/o/r/pull/8495", state: "OPEN", title: "spend", headRefName: "run-W1-T5115-1", headRefOid: "b58cb560" };
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], {
    listGrilling: () => [],
    github: () => ({ github: stubGateway({ listOpenHeadBranches: () => [pr] }), generation: "g", source: { asOf: null, state: "fresh" } }),
  });
  const disposed = (disposition: string, acted: boolean) => ({ step: "sweep.disposed", pr_number: 8495, head_sha: "b58cb560", disposition, acted, reason: disposition });
  clock.set(T0 - 1_200_000);
  core.append(disposed("post-review", true));
  clock.set(T0 - 780_000);
  core.append(disposed("blocked-fixable", false));
  const [acted, unacted] = liveLines(core);
  const old = archive(core, T0 - NOW_LEGACY_ROW_WINDOW_MS - 60_000, "gzip", [acted!]);
  const cut = archive(core, T0 - 205_000, "gzip", [unacted!]);
  writeFileSync(join(core.ledgerDir, "ledger.ndjson"), `${acted}\n`);
  clock.set(T0);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.deepEqual(body.data.prQueue.rows.map((r) => [r.prNumber, r.disposition]), [[8495, "blocked-fixable"]]);
  assert.deepEqual(compareNow(view, core, body, T0 + 49_000).filter((d) => d.path.startsWith("prQueue")), [], "legacy decides from the row the body did");
  const legacy = view.legacy("instance=core", T0 + 49_000, body.data);
  assert.deepEqual(legacy?.inputs.windows.board.rotations, [cut], "a rotation cut before the window is never opened");
  assert.notEqual(old, cut);
  // Negative control: a body deciding otherwise from the same row stays real.
  body.data.prQueue.rows[0]!.disposition = "mergeable";
  const wrong = compareNow(view, core, body, T0 + 49_000).find((d) => d.path === "prQueue.rows[prNumber=8495].disposition");
  assert.equal(wrong?.classification, "real", JSON.stringify(wrong));
});

test("legacy reads a task's newer row past an older one compaction kept live and matches the body", (t) => {
  // (b) Compaction keeps a rare step's old row live while it archives a busier step's newer one: W1-T3's block stays in the
  // live file and its later run.start sits only in a rotation cut before the build.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  clock.set(T0 - 2_400_000);
  core.append({ run_id: "run-W1-T3", task_id: "W1-T3", step: "dispatch.blocked_independent", verdict: "failed" });
  clock.set(T0 - 1_200_000);
  core.append({ step: "run.start", task_id: "W1-T3", run_id: "r3" });
  const [blocked, started] = liveLines(core);
  archive(core, T0 - 600_000, "gzip", [started!]);
  writeFileSync(join(core.ledgerDir, "ledger.ndjson"), `${blocked}\n`);
  clock.set(T0);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.ok(body.data.board.groups.running?.includes("W1-T3"), JSON.stringify(body.data.board.groups));
  assert.deepEqual(compareNow(view, core, body, T0 + 30_000).filter((d) => d.path.startsWith("board")), [], "legacy's board is the body's");
  // Negative control: a body grouping the task where no row puts it stays real.
  body.data.board.groups.running = (body.data.board.groups.running ?? []).filter((id) => id !== "W1-T3");
  body.data.board.groups.blocked = [...(body.data.board.groups.blocked ?? []), "W1-T3"];
  const wrong = compareNow(view, core, body, T0 + 30_000).filter((d) => d.path.startsWith("board.groups"));
  assert.ok(wrong.some((d) => d.classification === "real"), JSON.stringify(wrong));
});

test("legacy counts a row held in both rotation forms once and reads the day's spend from either", (t) => {
  // (c) The same costed row sits in a gzip and a plain rotation, both cut today but before legacy's board window, and a
  // second costed row sits in the plain one only: the day's spend reads both forms and each row once.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  clock.set(T0 - 3 * 3_600_000);
  core.append({ step: "implement.done", task_id: "W1-T1", run_id: "W1-T1-1", cost_usd: 0.5 });
  clock.set(T0 - 3 * 3_600_000 + 60_000);
  core.append({ step: "implement.done", task_id: "W1-T2", run_id: "W1-T2-1", cost_usd: 0.25 });
  const [first, second] = liveLines(core);
  archive(core, T0 - 2 * 3_600_000, "gzip", [first!]);
  archive(core, T0 - 2 * 3_600_000 + 1_000, "plain", [first!, second!]);
  writeFileSync(join(core.ledgerDir, "ledger.ndjson"), "");
  clock.set(T0);
  core.append({ step: "daemon.tick" });
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.equal(body.data.board.spendTodayUsd, 0.75);
  const legacy = view.legacy("instance=core", T0 + 30_000, body.data);
  const at = (ms: number, step: string): string => `${ms}|${step}`;
  assert.deepEqual(legacy?.rows["W1-T1"], [at(T0 - 3 * 3_600_000, "implement.done")], "the row in both forms is read once");
  assert.deepEqual(legacy?.rows["W1-T2"], [at(T0 - 3 * 3_600_000 + 60_000, "implement.done")], "the plain form is read");
  assert.deepEqual(legacy?.sums["board.spendTodayUsd"]?.legacy, [["W1-T1#W1-T1-1@2026-09-30T09:00:00.000Z", 0.5], ["W1-T2#W1-T2-1@2026-09-30T09:01:00.000Z", 0.25]], "each costed row once");
  assert.deepEqual(compareNow(view, core, body, T0 + 30_000).filter((d) => d.path === "board.spendTodayUsd"), []);
  // Negative control: a spend no paired row gives stays real.
  body.data.board.spendTodayUsd = 1.25;
  const wrong = compareNow(view, core, body, T0 + 30_000).find((d) => d.path === "board.spendTodayUsd");
  assert.equal(wrong?.classification, "real", JSON.stringify(wrong));
});

test("a row stamped after the body's build is in neither side of a now sample", (t) => {
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  clock.set(T0);
  core.append({ step: "daemon.tick" });
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  clock.set(T0 + 60_000);
  core.append({ step: "run.start", task_id: "W1-T4", run_id: "r4" }, { step: "implement.done", task_id: "W1-T4", run_id: "r4", cost_usd: 0.42 });
  assert.deepEqual(compareNow(view, core, body, T0 + 90_000), [], "legacy reads up to the build, as the body did");
  // Positive control: the same rows stamped before the build are on legacy's side.
  const legacy = view.legacy("instance=core", T0 + 90_000, body.data);
  assert.equal(legacy?.rows["W1-T4"], undefined);
  const late = liveLines(core).slice(-2).map((l) => l.replace(new Date(T0 + 60_000).toISOString(), new Date(T0 - 1_000).toISOString()));
  writeFileSync(join(core.ledgerDir, "ledger.ndjson"), `${[...liveLines(core).slice(0, -2), ...late].join("\n")}\n`);
  assert.deepEqual([...new Set(view.legacy("instance=core", T0 + 90_000, body.data)?.rows["W1-T4"])].map((k) => k.split("|")[1]).sort(), ["implement.done", "run.start"]);
});

test("a run whose only recent rows are steps the fact store skips stays running in the view as in legacy", (t) => {
  // Captured 2026-10-02T13:12:49Z: board.tasks[taskId=W1-T5073].status legacy running vs view queued (phase, worker,
  // counts and groups with it). Its newest fact row was the 12:41:35 worker.assignment and its newest row the 12:57:18
  // worker.activity, so from 13:11:35 the view's liveness bound read the run dead while legacy's rows kept it alive.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  clock.set(T0);
  core.append({ step: "run.start", task_id: "W1-T1", run_id: "W1-T1-1" });
  clock.set(T0 + 60_000);
  core.append({ step: "worker.assignment", task_id: "W1-T1", run_id: "W1-T1-1" });
  clock.set(T0 + 20 * 60_000);
  core.append({ step: "worker.activity", task_id: "W1-T1", run_id: "W1-T1-1" }, { step: "worker.state", task_id: "W1-T1", run_id: "W1-T1-1", state: "working" });
  clock.set(T0 + 35 * 60_000);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.deepEqual(body.data.board.groups.running, ["W1-T1"], JSON.stringify(body.data.board.groups));
  const diffs = compareNow(view, core, body, T0 + 35 * 60_000 + 30_000);
  assert.deepEqual(diffs.filter((d) => d.classification === "real"), [], JSON.stringify(diffs));
  // Negative control: a body that reads the run dead where legacy's rows keep it alive stays real.
  body.data.board.groups.running = [];
  body.data.board.groups.queued = ["W1-T1", ...(body.data.board.groups.queued ?? [])];
  const wrong = compareNow(view, core, body, T0 + 35 * 60_000 + 30_000).find((d) => d.path === "board.groups.running");
  assert.equal(wrong?.classification, "real", JSON.stringify(wrong));
});

test("a durable credit written after the now build is no diff when legacy replays the credit store that build read", (t) => {
  // The credit store and its overrides are files beside the ledger: the board projection read them at its update, and a
  // legacy side reading merge-credit.json again at the sample credits a task the compared body never could.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  clock.set(T0);
  core.append({ step: "daemon.tick" });
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  assert.ok(body.data.board.groups.queued?.includes("W1-T2"), JSON.stringify(body.data.board.groups));
  const store: CreditStore = { "W1-T2": { trailer: { source: "trailer", prUrl: "https://github.com/o/r/pull/9", prNumber: 9, prState: "MERGED" } } };
  saveCreditStore(defaultCreditStorePath(join(core.ledgerDir, "ledger.ndjson")), store);
  const diffs = compareNow(view, core, body, T0 + 30_000);
  assert.deepEqual(diffs.filter((d) => d.classification === "real"), [], JSON.stringify(diffs));
  // Positive control: the store as written credits the task, so a legacy side reading it now would differ.
  const credited = computeBoardSnapshot({ plan: PLAN, ledgerPath: join(core.ledgerDir, "ledger.ndjson"), github: stubGateway(), readLedger: () => readLedgerLines(join(core.ledgerDir, "ledger.ndjson")), now: () => T0 });
  assert.equal(credited.tasks.find((x) => x.taskId === "W1-T2")?.status, "merged");
});

test("a run escalated to another model mid-run shows the model its worker now asks for in the view as in legacy", (t) => {
  // Captured 2026-10-02T15:46:54Z: board.tasks[taskId=W1-T1289].worker.requestedModel legacy "opus" vs view "sonnet".
  // Its 15:20:50 worker.assignment escalated the run to opus and its worker.activity rows said so from 15:20:54, but
  // those rows are not facts, so the view derived the run's model from its 14:38:02 run.start mount alone.
  const root = scratch(t);
  const clock = stepped();
  const core = rig(t, root, "core", clock);
  const view = viewOf(clock, [{ name: "core", ledgerDir: core.ledgerDir }], { listGrilling: () => [] });
  const run = { task_id: "W1-T1", run_id: "W1-T1-1" };
  clock.set(T0);
  core.append({ step: "run.start", ...run, mount: { model: "sonnet" } });
  clock.set(T0 + 60_000);
  core.append({ step: "worker.activity", ...run, event_kind: "message", provider: "codex", requested_model: "sonnet" });
  clock.set(T0 + 120_000);
  core.append({ step: "worker.assignment", ...run, worker_assignment: { requested: { model: "opus" } } });
  clock.set(T0 + 125_000);
  core.append({ step: "worker.activity", ...run, event_kind: "message", provider: "claude", requested_model: "opus" });
  clock.set(T0 + 130_000);
  core.append({ step: "worker.activity", ...run, event_kind: "working" });
  clock.set(T0 + 180_000);
  const [body] = view.materialize(ctxOf(clock, [core]));
  assert.ok(body);
  const shown = body.data.board.tasks.find((x) => x.taskId === "W1-T1");
  assert.deepEqual(shown?.worker, { requestedModel: "opus" }, JSON.stringify(shown));
  const diffs = compareNow(view, core, body, T0 + 210_000);
  assert.deepEqual(diffs.filter((d) => d.classification === "real"), [], JSON.stringify(diffs));
  // Negative control: a body still showing the run's first model where legacy's rows say it moved stays real.
  shown!.worker = { requestedModel: "sonnet" };
  const wrong = compareNow(view, core, body, T0 + 210_000).find((d) => d.path === "board.tasks[taskId=W1-T1].worker.requestedModel");
  assert.equal(wrong?.classification, "real", JSON.stringify(wrong));
});
