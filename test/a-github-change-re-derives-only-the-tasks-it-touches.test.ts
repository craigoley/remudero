import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalProjection, createBoardProjection, githubAnswerOf, githubDigest, githubViewOf, TASK_TOKEN_RE, type BoardDirtRules, type BoardProjection } from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease, type ReadModelDb, type ReadModelLease } from "#src/lib/read-model-db.js";
import { buildBatchedGithub, projectPlan, TASK_ID_TRAILER_RE, type BatchedIssue, type BatchedPr, type GitHub } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";

const T0 = Date.parse("2026-10-15T03:00:00.000Z");
const PR = (n: number): string => `https://github.com/o/r/pull/${n}`;
const ISSUE = "https://github.com/o/r/issues/9";
type TestCtx = { after: (fn: () => void) => void };

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0, ...over };
}

/** Each task reads GitHub by a different route, so each route's dependency is exercised on its own. */
const TASKS = [
  task("W1-T1"), // its open run branch (projectPlan's batched open slice)
  task("W1-T2"), // a merged PR carrying its trailer (the batched trailer lookup)
  task("W1-T3"), // a PR its ledger names in `pr.opened` (prByRef)
  task("W1-T4", { files: ["src/shared.ts"] }), // no PR: the open-sibling observation over every open PR's files
  task("W1-T5"), // an open PR naming it only by trailer (the open slice's trailer arm)
  task("W1-T6"), // nothing, until a run branch opens for it
  task("W1-T7"), // a merged run branch (the batched merged slice)
  task("W1-T8"), // an escalation whose issue the gateway joins (issueByUrl)
  task("W1-T9"), // durably credited: its derive reads nothing from GitHub, so only a global fact can move it
];
const CREDIT = { "W1-T9": { trailer: { source: "trailer" as const, prUrl: PR(109), prNumber: 109, prState: "MERGED" } } };
const PLAN: Plan = { tasks: TASKS, byId: new Map(TASKS.map((t) => [t.id, t])) };

interface Snapshot {
  rows: BatchedPr[];
  issues: BatchedIssue[];
  files: Record<string, string[]>;
  unavailable?: boolean;
  /** The escalation issue read throws, as an unanticipated gateway might (resolveEscalation catches it). */
  issueThrows?: boolean;
}

function initial(): Snapshot {
  return {
    rows: [
      { number: 101, url: PR(101), state: "OPEN", headRefName: "run-W1-T1-1790000000001", headRefOid: "a1", body: "build", title: "t1" },
      { number: 102, url: PR(102), state: "MERGED", mergedAt: "2026-10-14T00:00:00Z", headRefName: "run-W1-T2-1790000000002", headRefOid: "a2", body: "done\n\nRemudero-Task: W1-T2", title: "t2" },
      { number: 103, url: PR(103), state: "OPEN", headRefName: "hand-branch", headRefOid: "a3", body: "manual", title: "t3" },
      { number: 105, url: PR(105), state: "OPEN", headRefName: "hand-built-5", headRefOid: "a5", body: "Remudero-Task: W1-T5", title: "t5" },
      { number: 107, url: PR(107), state: "MERGED", mergedAt: "2026-10-14T00:00:00Z", headRefName: "run-W1-T7-1790000000007", headRefOid: "a7", body: "", title: "t7" },
      { number: 200, url: PR(200), state: "OPEN", headRefName: "dependabot/npm_and_yarn/x", headRefOid: "b0", body: "bump x", title: "bump" },
    ],
    issues: [{ number: 9, url: ISSUE, state: "OPEN", title: "stuck" }],
    files: { [PR(200)]: ["package.json"] },
  };
}

const NO_PACER = { wait(): void {}, recordResult(): void {} };

/** A gateway over one snapshot, as the now view's `snapshotGithub` builds one: a new snapshot is a new gateway. */
function gatewayOf(s: Snapshot): GitHub {
  const github = buildBatchedGithub("o", "r", {
    ttlMs: Number.MAX_SAFE_INTEGER, pacer: NO_PACER,
    fetchAll: () => {
      if (s.unavailable) throw new Error("github snapshot unavailable");
      return s.rows.map((r) => ({ ...r }));
    },
    fetchAllIssues: () => s.issues.map((i) => ({ ...i })),
    exec: () => {
      throw new Error("a snapshot gateway reads GitHub from the persisted snapshot only");
    },
    commitTrailerIndex: () => new Map(),
    changedFilesCache: { lookup: (url) => s.files[url], settle: async () => {} },
  });
  if (!s.issueThrows) return github;
  return { ...github, issueByUrl: () => { throw new Error("issue read refused"); } };
}

interface World {
  db: ReadModelDb;
  lease: ReadModelLease;
  ledgerPath: string;
  clock: Clock;
  snapshot: Snapshot;
  /** Replaces the snapshot: a new gateway and a new generation, as a re-saved snapshot whose content moved. */
  change(edit: (s: Snapshot) => void): void;
  gateway(): GitHub;
  board(rules?: Partial<BoardDirtRules>): BoardProjection;
}

function world(t: TestCtx): World {
  const dir = makeTempDir("github-dirt");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = T0;
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const db = openProjectorReadModel(dir, "core", clock);
  t.after(() => db.close());
  const acquired = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(acquired.ok);
  const lease = acquired.lease;
  const ledgerPath = join(dir, "ledger.ndjson");
  const projector = createLedgerProjector({ ledgerDir: dir, db, lease, clock });
  const rows = [
    { step: "pr.opened", task_id: "W1-T3", run_id: "r3", pr_url: PR(103) },
    { step: "escalation.issue_opened", task_id: "W1-T8", run_id: "r8", issue_url: ISSUE, class: "MANUAL" },
  ];
  appendFileSync(ledgerPath, rows.map((r) => `${JSON.stringify({ ts: clock.iso(), host: "h1", ...r })}\n`).join(""));
  projector.tick();
  let snapshot = initial();
  let gateway = gatewayOf(snapshot);
  let generation = createHash("sha1").update(JSON.stringify(snapshot)).digest("hex");
  const w: World = {
    db, lease, ledgerPath, clock,
    get snapshot() { return snapshot; },
    change(edit) {
      snapshot = structuredClone(snapshot);
      edit(snapshot);
      gateway = gatewayOf(snapshot);
      generation = createHash("sha1").update(JSON.stringify(snapshot)).digest("hex");
    },
    gateway: () => gateway,
    board: (rules) => createBoardProjection({
      db, lease, ledgerPath, clock, readPlan: () => PLAN, instance: "core",
      // As the now view wires it: the held gateway read per derive, and the snapshot's content as the generation.
      get github() { return gateway; },
      githubGeneration: () => generation,
      readCreditStore: () => structuredClone(CREDIT), readCreditOverrideFile: () => "",
      // Each oracle pass here is the full re-derive a step is checked against: every task, not one slice.
      oracleSlices: 1,
      ...(rules ? { rules } : {}),
    }),
  };
  return w;
}

/** The full re-derive: `projectPlan` with no reuse at all, over the board's own rows and the current gateway. */
function fullDerive(w: World, board: BoardProjection): Map<string, string> {
  const rows = board.rows();
  const full = projectPlan(PLAN, {
    ledgerPath: w.ledgerPath, github: w.gateway(), readLedger: () => rows as Array<Record<string, unknown>>, ledgerIndex: board.index(rows),
    now: () => w.clock.now(), readCreditStore: () => structuredClone(CREDIT), writeCreditStore: () => {}, readCreditOverrideFile: () => "", skipUncreditedBuildWarning: true,
  });
  return new Map([...full].map(([id, p]) => [id, canonicalProjection(p)]));
}

function held(board: BoardProjection): Map<string, string> {
  return new Map([...board.projections()].map(([id, p]) => [id, canonicalProjection(p)]));
}

/** The snapshot changes, in order, and the tasks each one must re-derive: the tasks whose projection reads what moved. */
const STEPS: Array<{ name: string; edit: (s: Snapshot) => void; rederives: string[] }> = [
  { name: "a PR no task reads moves its head", edit: (s) => void (s.rows.find((r) => r.number === 200)!.headRefOid = "b1"), rederives: [] },
  { name: "W1-T1's open PR moves its head", edit: (s) => void (s.rows.find((r) => r.number === 101)!.headRefOid = "a1b"), rederives: ["W1-T1"] },
  { name: "the unread PR now touches W1-T4's declared file", edit: (s) => void (s.files[PR(200)] = ["package.json", "src/shared.ts"]), rederives: ["W1-T4"] },
  {
    name: "a newer open PR touching W1-T4's declared file opens: the sibling scan never read it",
    edit: (s) => {
      s.rows.push({ number: 201, url: PR(201), state: "OPEN", headRefName: "hand-201", headRefOid: "c1", body: "refactor", title: "refactor" });
      s.files[PR(201)] = ["src/shared.ts"];
    },
    rederives: ["W1-T4"],
  },
  { name: "the PR W1-T3's ledger names merges", edit: (s) => Object.assign(s.rows.find((r) => r.number === 103)!, { state: "MERGED", mergedAt: "2026-10-15T02:00:00Z" }), rederives: ["W1-T3"] },
  { name: "the trailer naming W1-T5 is edited out", edit: (s) => void (s.rows.find((r) => r.number === 105)!.body = "hand built"), rederives: ["W1-T5"] },
  {
    name: "a run branch opens for W1-T6",
    edit: (s) => void s.rows.push({ number: 106, url: PR(106), state: "OPEN", headRefName: "run-W1-T6-1790000000006", headRefOid: "a6", body: "", title: "t6" }),
    rederives: ["W1-T6"],
  },
  { name: "W1-T8's escalation issue closes", edit: (s) => void (s.issues[0]!.state = "CLOSED"), rederives: ["W1-T8"] },
  { name: "W1-T8's escalation issue read starts throwing: a thrown read is an answer too", edit: (s) => void (s.issueThrows = true), rederives: ["W1-T8"] },
  { name: "the escalation issue reads again", edit: (s) => void (s.issueThrows = false), rederives: ["W1-T8"] },
  { name: "the merged trailer PR for W1-T2 loses its trailer", edit: (s) => void (s.rows.find((r) => r.number === 102)!.body = "done"), rederives: ["W1-T2"] },
  { name: "W1-T7's merged run branch is renamed away", edit: (s) => void (s.rows.find((r) => r.number === 107)!.headRefName = "elsewhere"), rederives: ["W1-T7"] },
  { name: "W1-T1's PR merges", edit: (s) => Object.assign(s.rows.find((r) => r.number === 101)!, { state: "MERGED", mergedAt: "2026-10-15T02:30:00Z" }), rederives: ["W1-T1"] },
  { name: "the snapshot becomes unreadable: reachability has no owner", edit: (s) => void (s.unavailable = true), rederives: TASKS.map((x) => x.id) },
  { name: "it reads again", edit: (s) => void (s.unavailable = false), rederives: TASKS.map((x) => x.id) },
];

test("test/a-github-change-re-derives-only-the-tasks-it-touches.test.ts: a GitHub snapshot change to one task's pull request re-derives that task only, a change to a PR no task reads re-derives none, and the projections equal a full re-derive", (t) => {
  const a = world(t);
  const control = world(t); // A/A: a second board fed the same sequence.
  const boardA = a.board();
  const boardB = control.board();
  assert.equal(boardA.update({ force: true }).full, true, "the first derive has nothing to reuse");
  boardB.update({ force: true });
  assert.deepEqual(held(boardA), fullDerive(a, boardA), "the first derive is a full re-derive");
  const changed: string[] = [];
  for (const step of STEPS) {
    a.change(step.edit);
    control.change(step.edit);
    const before = held(boardA);
    const ua = boardA.update({ force: true });
    const ub = boardB.update({ force: true });
    assert.deepEqual(ua.rederived, step.rederives, `${step.name}: re-derives exactly the tasks it touches`);
    assert.deepEqual(ub.rederived, ua.rederived, `${step.name}: A/A boards agree on what re-derives`);
    const after = held(boardA);
    assert.deepEqual(after, fullDerive(a, boardA), `${step.name}: the incremental board equals a full re-derive`);
    assert.deepEqual(held(boardB), after, `${step.name}: A/A boards hold the same projections`);
    assert.deepEqual(boardA.oracle().mismatches, [], `${step.name}: the board oracle finds no mismatch`);
    changed.push(...[...after].filter(([id, json]) => before.get(id) !== json).map(([id]) => id));
  }
  // The sequence is only evidence if the projections actually moved: a step whose task never changes proves nothing.
  for (const id of ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5", "W1-T6", "W1-T7", "W1-T8"]) assert.ok(changed.includes(id), `${id}'s projection moved somewhere in the sequence`);

  // A restart while the snapshot moves: the persisted reads re-derive only the task whose PR moved.
  a.change((s) => void (s.rows.find((r) => r.number === 106)!.state = "CLOSED"));
  const restarted = a.board();
  const first = restarted.update({ force: true });
  assert.ok(first.rederived.includes("W1-T6"), "the task whose PR moved while the board was down re-derives");
  assert.ok(!first.rederived.includes("W1-T7") && !first.rederived.includes("W1-T2"), "a settled task is reused across the restart");
  assert.deepEqual(held(restarted), fullDerive(a, restarted), "the restarted board equals a full re-derive");
});

test("test/a-github-change-re-derives-only-the-tasks-it-touches.test.ts: a board that skips a dirty task's GitHub reads is caught by the full re-derive", (t) => {
  // The falsifier arm: the same sequence with the GitHub dirt switched off. Reuse goes stale, and both the
  // full re-derive and the board oracle must see it, or the equality above could not catch a missed dependency.
  const w = world(t);
  const board = w.board({ github: false });
  board.update({ force: true });
  const caught: string[] = [];
  for (const step of STEPS.filter((s) => s.rederives.length < TASKS.length)) {
    w.change(step.edit);
    const u = board.update({ force: true });
    assert.deepEqual(u.rederived, [], `${step.name}: with the rule off, nothing re-derives`);
    const stale = [...held(board)].filter(([id, json]) => fullDerive(w, board).get(id) !== json).map(([id]) => id);
    if (stale.length > 0) {
      caught.push(...stale);
      assert.deepEqual(board.oracle().mismatches.map((m) => m.taskId), stale, `${step.name}: the oracle names the stale task`);
    }
  }
  assert.ok(caught.length >= 5, `the skipped dirt is caught (${caught.join(", ")})`);
});

test("test/a-github-change-re-derives-only-the-tasks-it-touches.test.ts: reachability has no owner: a read failure moves the GitHub digest of a task that read nothing", () => {
  const ok = initial();
  const failed = { ...initial(), unavailable: true };
  const projection = { taskId: "W1-T9", status: "merged", merged: true, source: "trailer" } as const;
  const digest = (s: Snapshot): string => githubDigest(githubViewOf(gatewayOf(s), "g"), "W1-T9", PLAN.byId.get("W1-T9"), projection, []);
  assert.equal(digest(ok), digest(initial()), "the same snapshot, the same digest");
  assert.notEqual(digest(failed), digest(ok), "an unreadable snapshot moves every task, whatever it read");
});

test("test/a-github-change-re-derives-only-the-tasks-it-touches.test.ts: an answer JSON cannot hold equals no other answer, not even its own replay", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [10n, cycle]) {
    const first = githubAnswerOf(value);
    assert.match(first, /^x/);
    assert.notEqual(githubAnswerOf(value), first, "a replay of the same value never matches, so its task re-derives");
  }
  assert.equal(githubAnswerOf({ a: 1 }), githubAnswerOf({ a: 1 }), "a comparable answer still equals itself");
});

test("test/a-github-change-re-derives-only-the-tasks-it-touches.test.ts: the open slice's token scan finds every trailer owner projectPlan groups by, and refuses what is no task id", () => {
  for (const id of ["W1-T5", "W12-T3456", "W3-T77a"]) {
    assert.ok(TASK_ID_TRAILER_RE.test(id), `${id} is an id projectPlan's trailer grouping accepts`);
    assert.equal(TASK_TOKEN_RE.test(`Remudero-Task: ${id}`), true, `the scan accepts ${id}`);
    assert.equal(TASK_TOKEN_RE.exec(`done\n\nRemudero-Task: ${id}`)?.[0], id, `the scan finds ${id} exactly`);
  }
  assert.equal(TASK_TOKEN_RE.test("Remudero-Task: SEC-12\nrun-main"), false, "no task-id-shaped token, no owner");
});
