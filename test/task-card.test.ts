// test/task-card.test.ts — W1-T158's DETAIL layer: the row-click task CARD (title, rationale,
// acceptance criteria, dependency chain, run history w/ cost+verdict, PR links), rendering from
// the plan + ledger with ZERO extra GitHub calls beyond the batched snapshot GET /v1/status
// already paid for (lib/task-card.ts's own header explains why — reusing board.ts's own
// projectPlan pass over the SAME `github` gateway instance).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildTaskCard, computeTaskCard, taskCardRuns } from "../src/lib/task-card.js";
import type { Task } from "../src/lib/plan.js";
import { buildBatchedGithub } from "../src/lib/status.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T1",
    title: "the task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]) {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function fakeGitHub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}

// ── taskCardRuns: mirrors lib/trace.ts's runsForTask credit discipline, minus any GitHub read ──

test("taskCardRuns: groups ledger lines by run_id (oldest first), pulling verdict/cost_usd/pr_url off the SAME run's own lines", () => {
  const lines = [
    { run_id: "W1-T1-1", task_id: "W1-T1", step: "run.start" },
    { run_id: "W1-T1-1", task_id: "W1-T1", step: "verdict", verdict: "blocked_ci", cost_usd: 1.5 },
    { run_id: "OTHER-1", task_id: "W1-T9", step: "verdict", verdict: "merged", cost_usd: 99 }, // must not leak in
    { run_id: "W1-T1-2", task_id: "W1-T1", step: "pr.opened", pr_url: "https://github.com/o/r/pull/10" },
    { run_id: "W1-T1-2", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 3.25 },
  ];
  const runs = taskCardRuns(lines, "W1-T1");
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], { runId: "W1-T1-1", verdict: "blocked_ci", costUsd: 1.5, prUrl: undefined });
  assert.deepEqual(runs[1], { runId: "W1-T1-2", verdict: "merged", costUsd: 3.25, prUrl: "https://github.com/o/r/pull/10" });
});

test("taskCardRuns: a run with no verdict/cost/pr.opened line still surfaces (all fields undefined)", () => {
  const runs = taskCardRuns([{ run_id: "W1-T2-1", task_id: "W1-T2", step: "run.start" }], "W1-T2");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].verdict, undefined);
  assert.equal(runs[0].costUsd, undefined);
  assert.equal(runs[0].prUrl, undefined);
});

test("taskCardRuns: a daemon/sweep tick that merely stamps this task_id on an unrelated control-loop run_id is NOT credited (same fixture shape as lib/trace.ts's own regression test)", () => {
  const lines = [
    { run_id: "W1-T40-1784432542469", task_id: "W1-T40", step: "run.start" },
    { run_id: "W1-T40-1784432542469", task_id: "W1-T40", step: "verdict", verdict: "blocked_ci", cost_usd: 2 },
    { run_id: "DAEMON-1784434332059", task_id: "W1-T40", step: "sweep.disposed", pr_number: 238 },
  ];
  const runs = taskCardRuns(lines, "W1-T40");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, "W1-T40-1784432542469");
});

// ── buildTaskCard: pure assembly from a Task + its StatusProjection + ledger lines ──────────────

test("buildTaskCard: renders title/rationale/acceptance/dependsOn/status/merged/prNumber/prUrl/runs", () => {
  const t = task({
    id: "W1-T7",
    title: "widget the frobnicator",
    rationale: "operators need the frobnicator widgeted",
    acceptance: [{ claim: "it widgets", proof: "a test asserts widgeting" }],
    depends_on: ["W1-T1", "W1-T2"],
  });
  const projection = {
    taskId: "W1-T7",
    status: "merged" as const,
    merged: true,
    source: "ledger" as const,
    prNumber: 42,
    prUrl: "https://github.com/o/r/pull/42",
  };
  const lines = [
    { run_id: "W1-T7-1", task_id: "W1-T7", step: "verdict", verdict: "merged", cost_usd: 4.2 },
    { run_id: "W1-T7-1", task_id: "W1-T7", step: "pr.opened", pr_url: "https://github.com/o/r/pull/42" },
  ];
  const card = buildTaskCard(t, projection, lines);
  assert.equal(card.id, "W1-T7");
  assert.equal(card.title, "widget the frobnicator");
  assert.equal(card.rationale, "operators need the frobnicator widgeted");
  assert.deepEqual(card.acceptance, [{ claim: "it widgets", proof: "a test asserts widgeting" }]);
  assert.deepEqual(card.dependsOn, ["W1-T1", "W1-T2"]);
  assert.equal(card.status, "merged");
  assert.equal(card.merged, true);
  assert.equal(card.prNumber, 42);
  assert.equal(card.prUrl, "https://github.com/o/r/pull/42");
  assert.equal(card.runs.length, 1);
  assert.equal(card.runs[0].verdict, "merged");
  assert.equal(card.runs[0].costUsd, 4.2);
  assert.equal(card.runs[0].prUrl, "https://github.com/o/r/pull/42");
});

test("buildTaskCard: a task with no rationale/acceptance/runs renders empty-but-valid (never throws)", () => {
  const card = buildTaskCard(task({ id: "W1-T3" }), undefined, []);
  assert.equal(card.rationale, undefined);
  assert.deepEqual(card.acceptance, []);
  assert.deepEqual(card.runs, []);
  assert.equal(card.merged, false);
});

// ── computeTaskCard: the whole plan+ledger+projection assembly ─────────────────────────────────

test("computeTaskCard: returns undefined for a task id absent from the plan", () => {
  const plan = planOf([task({ id: "W1-T1" })]);
  const card = computeTaskCard({ plan, ledgerPath: "/nonexistent/ledger.ndjson", github: fakeGitHub() }, "W1-T404");
  assert.equal(card, undefined);
});

// ── the assembled HTTP route: GET /v1/task ──────────────────────────────────────────────────────

const READ_TOKEN = "task-card-read-token";
const WRITE_TOKEN = "task-card-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-task-card-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function planYaml(plan: ReturnType<typeof planOf>): string {
  if (plan.tasks.length === 0) return "[]\n";
  return plan.tasks.map((t) => `- id: ${t.id}\n  title: "${t.title}"\n  repo: ${t.repo}\n  type: ${t.type}\n`).join("");
}

function writePlanFile(root: string, yamlBody: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, yamlBody, { flag: "wx" });
  return planPath;
}

function depsFor(root: string, plan: ReturnType<typeof planOf>, github: GitHub): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlanFile(root, planYaml(plan));
  return {
    board: { plan, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
  };
}

async function withServeServer<T>(deps: ServeDeps, fn: (base: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function get(base: string, path: string, token = READ_TOKEN) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

test("GET /v1/task?id=<unknown-task-id> without ?id= -> 400", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task({ id: "A" })]), fakeGitHub()), async (base) => {
    const res = await get(base, "/v1/task");
    assert.equal(res.status, 400);
  });
});

test("GET /v1/task?id=<unknown-task-id> -> 404", async () => {
  const root = tmpRoot();
  await withServeServer(depsFor(root, planOf([task({ id: "A" })]), fakeGitHub()), async (base) => {
    const res = await get(base, "/v1/task?id=NOPE");
    assert.equal(res.status, 404);
  });
});

test("GET /v1/task?id=<id> -> 200 with the full card (title/rationale/acceptance/dependsOn/run-history w/ cost+verdict/PR links)", async () => {
  const root = tmpRoot();
  const plan = planOf([
    task({ id: "W1-T1" }), // a dependency, no runs
    task({
      id: "W1-T2",
      title: "the real task",
      rationale: "because operators need it",
      depends_on: ["W1-T1"],
      acceptance: [{ claim: "does the thing", proof: "a test proves it" }],
    }),
  ]);
  const deps = depsFor(root, plan, fakeGitHub());
  writeFileSync(
    deps.board.ledgerPath,
    [
      JSON.stringify({ ts: "2026-01-01T00:00:00Z", run_id: "W1-T2-1", task_id: "W1-T2", step: "verdict", verdict: "merged", cost_usd: 2.5 }),
      JSON.stringify({ ts: "2026-01-01T00:00:01Z", run_id: "W1-T2-1", task_id: "W1-T2", step: "pr.opened", pr_url: "https://github.com/o/r/pull/9" }),
    ].join("\n") + "\n",
  );
  await withServeServer(deps, async (base) => {
    const res = await get(base, "/v1/task?id=W1-T2");
    assert.equal(res.status, 200);
    const { card } = (await res.json()) as { card: { id: string; title: string; rationale?: string; acceptance: unknown[]; dependsOn: string[]; runs: Array<{ runId: string; verdict?: string; costUsd?: number; prUrl?: string }> } };
    assert.equal(card.id, "W1-T2");
    assert.equal(card.title, "the real task");
    assert.equal(card.rationale, "because operators need it");
    assert.deepEqual(card.acceptance, [{ claim: "does the thing", proof: "a test proves it" }]);
    assert.deepEqual(card.dependsOn, ["W1-T1"]); // the dep chain, LINKED client-side by id
    assert.equal(card.runs.length, 1);
    assert.equal(card.runs[0].verdict, "merged");
    assert.equal(card.runs[0].costUsd, 2.5);
    assert.equal(card.runs[0].prUrl, "https://github.com/o/r/pull/9");
  });
});

// ── the acceptance-bar proof: O(0) additional GitHub calls beyond the batched snapshot ─────────
// Same "counting gateway" technique test/serve.test.ts and test/status.test.ts already use for
// buildBatchedGithub's own O(1)-fetch invariant: GET /v1/status pays exactly one `fetchAll`; a
// card open for ANY task must add ZERO more — the falsifier this proves against is "a card that
// fires a per-open GitHub fetch".

test("GET /v1/task adds ZERO additional GitHub fetches beyond the already-warm batched snapshot", async () => {
  const root = tmpRoot();
  let fetchCalls = 0;
  const github = buildBatchedGithub("craigoley", "remudero", {
    fetchAll: () => {
      fetchCalls++;
      return [];
    },
  });
  const plan = planOf([task({ id: "W1-T1" }), task({ id: "W1-T2" }), task({ id: "W1-T3" })]);
  await withServeServer(depsFor(root, plan, github), async (base) => {
    assert.equal(fetchCalls, 1, "buildServeServer must pre-warm board.github synchronously at construction");

    const status = await get(base, "/v1/status");
    assert.equal(status.status, 200);
    assert.equal(fetchCalls, 1, "GET /v1/status must serve from the already-warm cache");

    const card1 = await get(base, "/v1/task?id=W1-T2");
    assert.equal(card1.status, 200);
    assert.equal(fetchCalls, 1, "opening a card must add ZERO GitHub fetches beyond the batched snapshot");

    const card2 = await get(base, "/v1/task?id=W1-T3");
    assert.equal(card2.status, 200);
    assert.equal(fetchCalls, 1, "a SECOND card open (a different task) must still add zero fetches");
  });
});
