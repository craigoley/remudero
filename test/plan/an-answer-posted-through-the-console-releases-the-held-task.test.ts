import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import "#src/lib/live-analytics-snapshot-cache.js";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import { runDaemon } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { renderIssueBody, type Escalation, type OpenIssue } from "#src/lib/escalate.js";
import { writeClassificationSnapshot } from "#src/lib/fleet-lane.js";
import { readEscalationAnswers, type EscalationAnswerGateway } from "#src/lib/escalation-answers.js";
import { appendThreadMessage } from "#src/lib/inbox-thread.js";
import { inboxViewBodies } from "#src/lib/inbox-view.js";
import { instanceRouteSet, mountUnderInstance } from "#src/lib/instance-gateway.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { composeNeedsYou } from "#src/lib/needs-you-view.js";
import { NOW_DECISIONS_CAP } from "#src/lib/now-decisions.js";
import { createNowView, NOW_VIEW_NAME, NOW_VIEW_VERSION, type NowViewContext, type NowViewData } from "#src/lib/now-view.js";
import { buildAnswerQuestionRoute, buildEscalationReplyRoute, type PanelActionDeps } from "#src/lib/panel-actions.js";
import { inboxLanes } from "#src/lib/panel-graph.js";
import { unfiledScopeGrant } from "#src/lib/fix-progress-judge.js";
import { assertRunnable, loadPlanFromYaml, TaskAdmissionError, type Plan } from "#src/lib/plan.js";
import { policyPath } from "#src/lib/policy.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import type { BoardCatalogClient, BoardCatalogContext } from "#src/lib/serve-plan-reload.js";
import { createService } from "#src/lib/service.js";
import type { GitHub } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { viewEtag, type ViewBodyEntry, type ViewSource } from "#src/lib/views.js";
import { taskInputAnswerWithLedger } from "#src/lib/worker.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const TASK = "W1-T90001";
const QUESTION = "Which retry bound should the sweep use: 3 or 5 passes?";
const ASKED_AT = "2026-11-14T20:00:00Z";
const WRITE_TOKEN = "t13940-write-token";
const T0 = Date.parse("2026-11-20T12:00:00.000Z");

const PLAN: Plan = loadPlanFromYaml(`- id: ${TASK}
  title: "a held fixture task"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  origin: architect
  files: [src/lib/plan.ts]
  needs_input:
    question: "${QUESTION}"
    source_pr: "#18449"
    asked_at: "${ASKED_AT}"
`, "plan/tasks.d/W1-T90001-held.yaml");

type TestCtx = { after: (fn: () => void) => void };

function tempDir(t: TestCtx, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13940-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function storeLines(root: string): Array<Record<string, unknown>> {
  const path = join(root, "plan", "questions.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rowsIn(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function answerRows(path: string, taskId = TASK): Array<Record<string, unknown>> {
  return rowsIn(path).filter((row) => row.step === "panel.question_answered" && row.task_id === taskId);
}

function deps(root: string, ledgerPath: string, threadStorePath?: string): PanelActionDeps {
  return { root, ledgerPath, issues: { close() {} }, clock: fixedClock(T0), ...(threadStorePath ? { threadStorePath } : {}) };
}

async function post(routes: ReturnType<typeof buildAnswerQuestionRoute>[], path: string, body: unknown): Promise<number> {
  const server = createService({ tokens: { read: "t13940-read-token", write: WRITE_TOKEN }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await res.arrayBuffer();
    return res.status;
  } finally {
    server.close();
  }
}

/** POST /v1/questions/answer through the real route, with serve's own question root. */
async function routeAnswer(serveRoot: string, ledgerPath: string, answer: string, taskId = TASK): Promise<void> {
  assert.equal(await post([buildAnswerQuestionRoute(deps(serveRoot, ledgerPath))], "/v1/questions/answer", { taskId, answer }), 200);
}

function escalation(): Escalation {
  return { class: "BLOCKED", taskId: TASK, summary: "held for an answer", detail: QUESTION,
    options: [{ label: "retry", detail: "resume the run" }, { label: "abandon", detail: "drop the task" }], recommendation: "retry" };
}

function issueReplyGateway(): EscalationAnswerGateway {
  const issue: OpenIssue = { number: 501, url: "https://github.com/craigoley/remudero/issues/501", body: renderIssueBody(escalation()) };
  return { listOpen: () => [issue], reactPlusOne: () => {},
    listComments: () => [{ id: 9001, body: "Use 5 passes.", authorLogin: "craigoley", authorAssociation: "OWNER", authorType: "User" }] };
}

/** A secondary instance's own gateway routes, mounted under `/v1/i/wreck/`, over that instance's ledger. */
function secondaryRoutes(t: TestCtx, ledgerPath: string): { routes: ReturnType<typeof instanceRouteSet>; checkout: string } {
  const root = tempDir(t, "wreck-root");
  const checkout = join(root, "repos", "wreckterra");
  mkdirSync(join(checkout, "plan"), { recursive: true });
  const routes = mountUnderInstance(instanceRouteSet({ instance: "wreck", root, ledgerPath, planPath: join(checkout, "plan", "tasks.yaml") },
    { plan: PLAN, ledgerPath, github: fakeGitHub() }, {}, "craigoley/wreckterra"), "wreck");
  return { routes, checkout };
}

/** The daemon's dispatch check: its reason when it refuses the task, undefined when it admits it. */
function refusal(daemonRoot: string, ledgerPath: string): string | undefined {
  try {
    assertRunnable(PLAN, PLAN.byId.get(TASK)!, () => true, undefined, taskInputAnswerWithLedger(daemonRoot, ledgerPath));
    return undefined;
  } catch (error) {
    assert.ok(error instanceof TaskAdmissionError, String(error));
    return error.message;
  }
}

async function kick(daemonRoot: string, ledgerPath: string): Promise<{ ran: string[]; rows: { step: string; data: Record<string, unknown> }[] }> {
  let kicks = [{ taskId: TASK, origin: "fixture" }];
  let polls = 0;
  const ran: string[] = [];
  const rows: { step: string; data: Record<string, unknown> }[] = [];
  await runDaemon(PLAN, {
    refreshMerged: () => () => false,
    taskInputAnswer: taskInputAnswerWithLedger(daemonRoot, ledgerPath),
    pendingKicks: () => kicks,
    clearKick: (id) => { kicks = kicks.filter((k) => k.taskId !== id); },
    checkStop: () => ++polls > 2 ? "fixture finished" : undefined,
    runOne: async (id) => { ran.push(id); return { taskId: id, runId: "fixture-run", merged: true, costUsd: 0, verdict: "merged" }; },
    sleep: async () => {},
    log: (step, data = {}) => { rows.push({ step, data }); },
    memoryGovernor: createDaemonMemoryGovernor({ read: () => ({ rss_bytes: 1 }), setFlags: () => {}, heapUsed: () => 1 }),
    heapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1_000_000_000 }),
    bootCheckoutBlocked: "",
  }, { headroomEnabled: false, max: 1 });
  return { ran, rows };
}

interface Stepped extends Clock { set(ms: number): void }

/** Serve's side: a read model over the shared ledger, serve's question root, and the now view over both. */
function inbox(t: TestCtx, instance = "core", plans: { readPlan?: Plan; catalogs?: BoardCatalogClient } = {}) {
  const root = readModelFixtureDir(t, "t13940").dir;
  // The answer writers stamp their ledger rows with the system clock; the read model must not see them as future rows.
  let nowMs = Date.now();
  const clock: Stepped = { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString(), set: (ms) => { nowMs = ms; } };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const ledgerPath = join(ledgerDir, "ledger.ndjson");
  writeLedger([{ ts: clock.iso(), host: "h1", step: "daemon.tick" }], { dir: ledgerDir });
  const db = openProjectorReadModel(join(root, "read-model-home"), "core", clock);
  onReadModelClose(t, () => db.close());
  const acquired = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(acquired.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: acquired.lease, clock });
  projector.tick();
  const serveRoot = join(root, "serve-gen");
  mkdirSync(join(serveRoot, "plan"), { recursive: true });
  const view = createNowView({
    instances: [instance === "core" ? { name: "core", ledgerDir, feedbackRoot: serveRoot } : { name: instance, ledgerDir }], coreInstance: "core", clock, readPlan: () => plans.readPlan ?? PLAN, listGrilling: () => [],
    ...(plans.catalogs ? { catalogs: plans.catalogs } : {}),
    github: () => ({ github: fakeGitHub(), generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 1 },
  });
  const ctx = (): NowViewContext => ({ now: clock.now(), switches: { views: { now: "shadow" } }, instances: [{
    state: { instance, generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null }, db }] });
  /** composeNeedsYou over this instance's now body: the list the Console renders, and its gates. */
  const needsYou = () => {
    projector.tick();
    clock.set(clock.now() + 60_000);
    const body = view.materialize(ctx()).find((b) => b.key === `instance=${instance}`);
    assert.ok(body, `a now body for ${instance}`);
    const data: NowViewData = body.data;
    const entry: ViewBodyEntry = { view: NOW_VIEW_NAME, key: `instance=${instance}`, version: NOW_VIEW_VERSION, generation: 1, etag: viewEtag(NOW_VIEW_NAME, NOW_VIEW_VERSION, false, data),
      body: { view: NOW_VIEW_NAME, version: NOW_VIEW_VERSION, generatedAt: clock.iso(), asOf: null, stale: false, sources: body.sources, data } };
    const composed = composeNeedsYou(new Map([["now", entry]]), [instance]).data;
    const held = composed.decisions.filter((d) => d.kind === "task_question" && d.taskId === TASK);
    const gates = composed.humanGates.gates.filter((g) => g.kind === "task_question");
    return { held, gates, composed };
  };
  return { ledgerPath, serveRoot, needsYou, projector };
}

test("W1-T13940 criterion 1: an answer through the real answer route, written to serve's own folder, releases the task on the daemon's next dispatch pass", async (t) => {
  const serveRoot = tempDir(t, "serve");
  const daemonRoot = tempDir(t, "daemon");
  const ledgerPath = join(tempDir(t, "state"), "ledger.ndjson");
  const held = await kick(daemonRoot, ledgerPath);
  assert.deepEqual(held.ran, []);
  assert.ok(held.rows.some(({ step, data }) => step === "console.kick_refused" && String(data.reason).includes(`needs-input: ${QUESTION}`)));

  await routeAnswer(serveRoot, ledgerPath, "Use 5 passes.");
  const served = storeLines(serveRoot);
  assert.equal(served.length, 1, "the route writes serve's own store");
  assert.equal(storeLines(daemonRoot).length, 0, "control: the daemon's store does not have the answer");
  const [row] = answerRows(ledgerPath);
  assert.equal(row.answer, "Use 5 passes.");
  assert.equal(typeof row.answer_id, "string");
  assert.equal(served[0].answer_id, row.answer_id, "the store entry and the ledger row carry one answer id");
  assert.equal(served[0].ts, new Date(T0).toISOString(), "the route takes its time from the module's clock");

  const released = await kick(daemonRoot, ledgerPath);
  assert.deepEqual(released.ran, [TASK]);
  assert.ok(released.rows.some(({ step, data }) => step === "console.kick_dispatched" && data.task === TASK));
  assert.equal(released.rows.some(({ step }) => step === "console.kick_refused"), false);
  const copied = storeLines(daemonRoot);
  assert.equal(copied.length, 1, "the daemon copies the answer into its own store once");
  assert.deepEqual({ task: copied[0].task, answer: copied[0].answer, origin: copied[0].origin, answer_id: copied[0].answer_id, source: copied[0].source },
    { task: TASK, answer: "Use 5 passes.", origin: row.origin, answer_id: row.answer_id, source: "ledger" });
  await kick(daemonRoot, ledgerPath);
  assert.equal(storeLines(daemonRoot).length, 1, "a later pass copies nothing again");
});

test("W1-T13940 criterion 2: a GitHub issue reply still releases the task, and a second pass adds no store entry and no ledger row", async (t) => {
  const daemonRoot = tempDir(t, "daemon");
  const ledgerPath = join(tempDir(t, "state"), "ledger.ndjson");
  assert.match(refusal(daemonRoot, ledgerPath) ?? "", /needs-input/);
  assert.deepEqual(await readEscalationAnswers(daemonRoot, "RUN-1", issueReplyGateway(), { ledgerPath }, fixedClock(T0)), { accepted: 1, ignored: 0, unreadable: 0 });
  const reader = taskInputAnswerWithLedger(daemonRoot, ledgerPath);
  assert.equal(reader(TASK), "Use 5 passes.");
  assert.equal(refusal(daemonRoot, ledgerPath), undefined, "the GitHub answer releases the task");
  const counts = () => [storeLines(daemonRoot).filter((line) => line.task === TASK).length, answerRows(ledgerPath).length];
  assert.deepEqual(counts(), [1, 1], "the reader does not copy the daemon's own GitHub answer a second time");
  assert.deepEqual(await readEscalationAnswers(daemonRoot, "RUN-2", issueReplyGateway(), { ledgerPath }, fixedClock(T0 + 1000)), { accepted: 0, ignored: 0, unreadable: 0 });
  assert.equal(reader(TASK), "Use 5 passes.");
  assert.equal(refusal(daemonRoot, ledgerPath), undefined);
  assert.deepEqual(counts(), [1, 1], "a second pass over the same reply adds nothing");
});

test("W1-T13940 criterion 3: a held task is one answerable decision in the needs-you list, its gate key matches, and an answer through the route removes it", async (t) => {
  const box = inbox(t);
  const before = box.needsYou();
  assert.equal(before.held.length, 1, "the held task is listed");
  const [decision] = before.held;
  assert.equal(decision.id, `question:${TASK}:${ASKED_AT}`);
  assert.equal(decision.title, "a held fixture task");
  assert.ok(decision.prompt.includes(QUESTION) && decision.prompt.includes("#18449"), decision.prompt);
  assert.equal(decision.askedAt, ASKED_AT);
  assert.deepEqual(decision.answer, { method: "POST", path: "/v1/questions/answer", tier: "low", fields: { taskId: TASK }, input: "text" });
  assert.deepEqual(before.gates.map((gate) => gate.key), [`task_question:core:${encodeURIComponent(decision.id)}`], "its gate key is the decision's key");
  assert.equal(before.gates.length, before.composed.decisions.filter((d) => d.kind === "task_question").length, "the count and the list agree");

  await routeAnswer(box.serveRoot, box.ledgerPath, "Use 5 passes.");
  const after = box.needsYou();
  assert.equal(after.held.length, 0, "an answered task leaves the list");
  assert.equal(after.gates.length, 0, "and the count");
});

test("W1-T13940 criterion 4: the Inbox lists the held task exactly when the dispatch check refuses it, and each answer writer writes one answer row", async (t) => {
  type Fixture = { name: string; refused: boolean; apply: (f: { serveRoot: string; daemonRoot: string; ledgerPath: string }) => Promise<void> | void };
  const fixtures: Fixture[] = [
    { name: "no answer", refused: true, apply: () => {} },
    { name: "route answer only", refused: false, apply: ({ serveRoot, ledgerPath }) => routeAnswer(serveRoot, ledgerPath, "Use 5 passes.") },
    { name: "GitHub answer only", refused: false, apply: async ({ daemonRoot, ledgerPath }) => {
      await readEscalationAnswers(daemonRoot, "RUN-1", issueReplyGateway(), { ledgerPath }, fixedClock(T0));
    } },
    { name: "both", refused: false, apply: async ({ serveRoot, daemonRoot, ledgerPath }) => {
      await readEscalationAnswers(daemonRoot, "RUN-1", issueReplyGateway(), { ledgerPath }, fixedClock(T0));
      await routeAnswer(serveRoot, ledgerPath, "Use 3 passes.");
    } },
    { name: "a blank answer", refused: true, apply: ({ serveRoot, ledgerPath }) => {
      appendFileSync(ledgerPath, `${JSON.stringify({ ts: new Date(T0).toISOString(), run_id: "PANEL-1", task_id: TASK, step: "panel.question_answered", origin: "tok", answer: "   " })}\n`);
      writeFileSync(join(serveRoot, "plan", "questions.ndjson"), `${JSON.stringify({ ts: new Date(T0).toISOString(), task: TASK, answer: " ", origin: "tok" })}\n`);
    } },
    { name: "a tab-and-newline-only answer", refused: true, apply: ({ ledgerPath }) => {
      appendFileSync(ledgerPath, `${JSON.stringify({ ts: new Date(T0).toISOString(), run_id: "PANEL-1", task_id: TASK, step: "panel.question_answered", origin: "tok", answer: "\t\n\r\n\t" })}\n`);
    } },
    { name: "an answer for another task", refused: true, apply: ({ serveRoot, ledgerPath }) => routeAnswer(serveRoot, ledgerPath, "Use 5 passes.", "W1-T90002") },
    { name: "an answer row rotation dropped after the daemon read it once", refused: false, apply: async ({ serveRoot, daemonRoot, ledgerPath }) => {
      await routeAnswer(serveRoot, ledgerPath, "Use 5 passes.");
      assert.equal(refusal(daemonRoot, ledgerPath), undefined, "the daemon reads the row once");
      box.projector.tick();
      writeFileSync(ledgerPath, rowsIn(ledgerPath).filter((row) => row.step !== "panel.question_answered").map((row) => `${JSON.stringify(row)}\n`).join(""));
      assert.equal(answerRows(ledgerPath).length, 0, "control: the live ledger no longer holds the row");
    } },
  ];
  let box!: ReturnType<typeof inbox>;
  for (const fixture of fixtures) {
    box = inbox(t);
    const daemonRoot = tempDir(t, "daemon");
    await fixture.apply({ serveRoot: box.serveRoot, daemonRoot, ledgerPath: box.ledgerPath });
    const refused = refusal(daemonRoot, box.ledgerPath) !== undefined;
    const listed = box.needsYou().held.length === 1;
    assert.equal(refused, fixture.refused, `${fixture.name}: the dispatch check`);
    assert.equal(listed, refused, `${fixture.name}: the Inbox lists the task exactly when the dispatch check refuses it`);
  }

  const root = tempDir(t, "writers");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const threads = join(root, "threads.jsonl");
  appendThreadMessage({ taskId: TASK, class: "BLOCKED" }, "escalation", "the retry still failed CI", { threadStorePath: threads });
  await routeAnswer(join(root, "serve"), ledgerPath, "route answer");
  assert.equal(await post([buildEscalationReplyRoute(deps(join(root, "config"), ledgerPath, threads))], "/v1/escalation/reply",
    { taskId: TASK, class: "BLOCKED", text: "reply answer" }), 200);
  await readEscalationAnswers(join(root, "daemon"), "RUN-1", issueReplyGateway(), { ledgerPath }, fixedClock(T0));
  const rows = answerRows(ledgerPath);
  assert.deepEqual(rows.map((row) => row.answer), ["route answer", "reply answer", "Use 5 passes."], "one row per writer");
  for (const row of rows) {
    assert.equal(row.task_id, TASK);
    assert.ok(typeof row.answer === "string" && row.answer.trim() !== "");
    assert.ok(typeof row.origin === "string" && row.origin !== "", JSON.stringify(row));
  }
});

test("W1-T13940 criterion 3: a held task that also has two outstanding store QUESTION lines is still one decision, carrying the plan question", async (t) => {
  const box = inbox(t);
  writeFileSync(join(box.serveRoot, "plan", "questions.ndjson"), [
    { ts: "2026-11-15T10:00:00Z", task: TASK, question: "A worker's first non-blocking question?" },
    { ts: "2026-11-15T11:00:00Z", task: TASK, question: "A worker's second non-blocking question?" },
  ].map((line) => `${JSON.stringify(line)}\n`).join(""));
  const before = box.needsYou();
  assert.equal(before.held.length, 1, JSON.stringify(before.held.map((d) => d.id)));
  const [decision] = before.held;
  assert.equal(decision.id, `question:${TASK}:${ASKED_AT}`);
  assert.ok(decision.prompt.includes(QUESTION), decision.prompt);
  assert.deepEqual(decision.answer, { method: "POST", path: "/v1/questions/answer", tier: "low", fields: { taskId: TASK }, input: "text" });
  assert.deepEqual(before.gates.map((gate) => gate.key), [`task_question:core:${encodeURIComponent(decision.id)}`], "one gate, the decision's own");

  await routeAnswer(box.serveRoot, box.ledgerPath, "Use 5 passes.");
  const after = box.needsYou();
  assert.equal(after.held.length, 0);
  assert.equal(after.gates.length, 0);
});

test("W1-T13940 criterion 3: a held task on a secondary daemon instance is one answerable decision in that instance's needs-you list", async (t) => {
  const box = inbox(t, "wreck");
  const before = box.needsYou();
  assert.equal(before.held.length, 1, "the secondary instance lists its held task");
  const [decision] = before.held;
  assert.equal(decision.instance, "wreck");
  assert.equal(decision.id, `question:${TASK}:${ASKED_AT}`);
  assert.deepEqual(decision.answer, { method: "POST", path: "/v1/i/wreck/questions/answer", tier: "low", fields: { taskId: TASK }, input: "text" });
  assert.deepEqual(before.gates.map((gate) => gate.key), [`task_question:wreck:${encodeURIComponent(decision.id)}`]);

  assert.equal(await post(secondaryRoutes(t, box.ledgerPath).routes, decision.answer.path, { ...decision.answer.fields, answer: "Use 5 passes." }), 200);
  const after = box.needsYou();
  assert.equal(after.held.length, 0, "the ledger answer clears it");
  assert.equal(after.gates.length, 0);
});

/** The public plan without the held task: an ops-catalog shard holds it, as the daemon's combined plan does. */
const PUBLIC_PLAN: Plan = loadPlanFromYaml(`- id: W1-T90003
  title: "a public fixture task"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  origin: architect
  files: [src/lib/plan.ts]
`, "plan/tasks.d/W1-T90003-public.yaml");

function opsCatalog(): BoardCatalogClient {
  const context = { outcome: "ok", observedAt: new Date(T0).toISOString(), taskCount: 1, plan: PLAN, publicPlan: PUBLIC_PLAN,
    opsIds: new Set([TASK]) } as BoardCatalogContext;
  return { current: () => context, revision: () => "ops-r1", accept: () => {} };
}

test("W1-T13940 criterion 3: a held task from the ops catalog is listed from the combined plan the daemon holds it over, with its question kept private", async (t) => {
  assert.equal(PUBLIC_PLAN.byId.has(TASK), false, "control: the public plan does not hold the task");
  const box = inbox(t, "core", { readPlan: PUBLIC_PLAN, catalogs: opsCatalog() });
  const before = box.needsYou();
  assert.equal(before.held.length, 1, "the Inbox lists the held ops task");
  const [decision] = before.held;
  assert.equal(decision.id, `question:${TASK}`, "the id carries no private field");
  assert.equal(decision.askedAt, undefined, "nor does the decision carry the private asked_at");
  assert.equal(JSON.stringify(before.composed).includes(ASKED_AT), false, "the published view never holds the private asked_at");
  assert.equal(decision.title, "a held fixture task");
  assert.equal(decision.prompt.includes(QUESTION) || decision.prompt.includes("#18449"), false, "the private question stays private");
  assert.deepEqual(decision.answer, { method: "POST", path: "/v1/questions/answer", tier: "low", fields: { taskId: TASK }, input: "text" });
  assert.deepEqual(before.gates.map((gate) => gate.key), [`task_question:core:${encodeURIComponent(decision.id)}`]);

  await routeAnswer(box.serveRoot, box.ledgerPath, "Use 5 passes.");
  const after = box.needsYou();
  assert.equal(after.held.length, 0);
  assert.equal(after.gates.length, 0);
});

test("W1-T13940 criterion 4: an ordinary escalation reply on an unfiled PR's thread writes no answer row, so it grants that PR no scope", async (t) => {
  const pr = 14217;
  const key = `PR-${pr}`;
  const root = tempDir(t, "scope");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  const hold = { ts: new Date(T0 - 60_000).toISOString(), task_id: key, step: "fix.scope_amendment", pr_number: pr, head_sha: "a".repeat(40),
    outcome: "unfiled-escalated", paths: ["scripts/mutation-relevant-paths.json"], issue_url: "https://github.com/craigoley/remudero/issues/14273" };
  writeFileSync(ledgerPath, `${JSON.stringify(hold)}\n`);
  const threads = join(root, "threads.jsonl");
  appendThreadMessage({ taskId: key, class: "BLOCKED" }, "escalation", "the fix needs a path outside the PR", { threadStorePath: threads });
  assert.equal(await post([buildEscalationReplyRoute(deps(join(root, "config"), ledgerPath, threads))], "/v1/escalation/reply",
    { taskId: key, class: "BLOCKED", text: "revise-pr" }), 200);
  const rows = rowsIn(ledgerPath);
  assert.ok(rows.some((row) => row.step === "panel.escalation_replied" && row.task_id === key), "control: the reply was ledgered");
  assert.deepEqual(answerRows(ledgerPath, key), [], "no answer row for a PR key");
  assert.equal(unfiledScopeGrant(rows, { prNumber: pr }), undefined, "the reply grants no scope");
});

test("W1-T13940 criterion 3: a secondary instance's held task, answered through its Inbox form, is answered in that instance's own ledger and leaves its list", async (t) => {
  const box = inbox(t, "wreck");
  const [decision] = box.needsYou().held;
  assert.ok(decision, "control: the secondary instance lists its held task");
  const coreLedger = join(tempDir(t, "core-state"), "ledger.ndjson");
  const { routes, checkout } = secondaryRoutes(t, box.ledgerPath);
  const core = buildAnswerQuestionRoute(deps(tempDir(t, "core-serve"), coreLedger));
  assert.equal(await post([core, ...routes], decision.answer.path, { ...decision.answer.fields, answer: "Use 5 passes." }), 200);
  assert.equal(answerRows(coreLedger).length, 0, "core's ledger does not take the secondary instance's answer");
  assert.equal(answerRows(box.ledgerPath).length, 1, "the instance's own ledger holds it");
  assert.equal(storeLines(checkout).filter((line) => line.task === TASK).length, 1, "and the instance checkout's store");
  assert.equal(refusal(checkout, box.ledgerPath), undefined, "the secondary daemon releases the task");
  const after = box.needsYou();
  assert.equal(after.held.length, 0, "the secondary view no longer lists it");
  assert.equal(after.gates.length, 0);
});

test("W1-T13940 criterion 3: past the decisions cap, the needs-you count says how many held tasks the list leaves out", async (t) => {
  const ids = Array.from({ length: 51 }, (_, i) => `W1-T9${String(1000 + i)}`);
  const many: Plan = loadPlanFromYaml(ids.map((id, i) => `- id: ${id}
  title: "held fixture ${i}"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  origin: architect
  files: [src/lib/plan.ts]
  needs_input:
    question: "question ${i}?"
    asked_at: "2026-11-14T20:${String(i).padStart(2, "0")}:00Z"
`).join(""), "plan/tasks.d/W1-T91000-many.yaml");
  const box = inbox(t, "core", { readPlan: many });
  const { composed, gates } = box.needsYou();
  const listed = composed.decisions.filter((d) => d.kind === "task_question");
  assert.equal(gates.length, 51, "every held task is a gate");
  assert.equal(listed.length, 50, "the list keeps its cap");
  // This fixture's GitHub, feedback-age and Inbox sources are partial, so the count is a lower bound; the next test makes every source complete.
  assert.equal(composed.humanGates.sources.find((source) => source.name === "task-questions")?.state, "complete", "an absent store is a complete source");
  assert.deepEqual(composed.needsYou.inbox, { atLeast: 51 });
  assert.deepEqual(composed.needsYou.display, { shown: 50, more: { atLeast: 1 } }, "the count names the one the list leaves out");
  assert.equal(composed.needsYou.display!.shown + (composed.needsYou.display!.more.atLeast ?? 0), gates.length, "the count and the list agree");
  assert.equal(composed.instances.find((i) => i.instance === "core")?.counts?.decisionsMore, 1, "the instance says one more decision exists");
});

test("W1-T13940 criterion 4: an array answer row counts as no answer in both the dispatch check and the Inbox", async (t) => {
  for (const answer of [[], ["  "], ["Use 5 passes."], { text: "Use 5 passes." }]) {
    const box = inbox(t);
    const daemonRoot = tempDir(t, "daemon");
    appendFileSync(box.ledgerPath, `${JSON.stringify({ ts: new Date().toISOString(), run_id: "PANEL-1", task_id: TASK, step: "panel.question_answered", origin: "tok", answer })}\n`);
    assert.ok(refusal(daemonRoot, box.ledgerPath) !== undefined, `${JSON.stringify(answer)}: the dispatch check still holds the task`);
    assert.equal(box.needsYou().held.length, 1, `${JSON.stringify(answer)}: the Inbox still lists it`);
  }
});

test("W1-T13940 criterion 4: a route answer repeated after a newer GitHub answer is not copied again, and the task stays answered once the ledger row is gone", (t) => {
  const daemonRoot = tempDir(t, "daemon");
  const ledgerPath = join(tempDir(t, "state"), "ledger.ndjson");
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const row = (ms: number, answer: string, origin: string, extra: Record<string, unknown> = {}) =>
    appendFileSync(ledgerPath, `${JSON.stringify({ ts: at(ms), run_id: "PANEL-1", task_id: TASK, step: "panel.question_answered", origin, answer, ...extra })}\n`);
  const read = () => taskInputAnswerWithLedger(daemonRoot, ledgerPath)(TASK);
  row(0, "Use 3 passes.", "tok", { answer_id: "a-1" });
  assert.equal(read(), "Use 3 passes.");
  // The daemon's own GitHub reply: its store line and its ledger row, as readEscalationAnswers writes them.
  mkdirSync(join(daemonRoot, "plan"), { recursive: true });
  appendFileSync(join(daemonRoot, "plan", "questions.ndjson"), `${JSON.stringify({ ts: at(1000), task: TASK, answer: "Use 5 passes.", origin: "issue#501:comment:9001" })}\n`);
  row(1000, "Use 5 passes.", "issue#501:comment:9001");
  assert.equal(read(), "Use 5 passes.", "control: the newer GitHub answer wins");
  row(2000, "Use 3 passes.", "tok", { answer_id: "a-2" });
  assert.equal(read(), "Use 3 passes.", "the repeated route answer is newest while its row is live");
  // The design skips a copy when the store holds the same answer id or the same origin and text: a-1's copy has both.
  assert.equal(storeLines(daemonRoot).filter((line) => line.origin === "tok").length, 1, "the repeated answer is not copied a second time");
  writeFileSync(ledgerPath, "");
  assert.equal(read(), "Use 5 passes.", "once the row is gone the store's newest answer answers, so the task stays released");
  const lines = storeLines(daemonRoot).length;
  read();
  assert.equal(storeLines(daemonRoot).length, lines, "a later read copies nothing");
});

test("W1-T13940 criterion 2: a GitHub reply whose store line and ledger row straddle a competing answer is copied by no later pass", (t) => {
  const daemonRoot = tempDir(t, "daemon");
  const ledgerPath = join(tempDir(t, "state"), "ledger.ndjson");
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const github = "issue#501:comment:9001";
  mkdirSync(join(daemonRoot, "plan"), { recursive: true });
  const store = join(daemonRoot, "plan", "questions.ndjson");
  // readEscalationAnswers stamps its store line, then its ledger row; a route answer lands between the two.
  appendFileSync(store, `${JSON.stringify({ ts: at(0), task: TASK, answer: "Use 5 passes.", origin: github })}\n`);
  appendFileSync(store, `${JSON.stringify({ ts: at(500), task: TASK, answer: "Use 3 passes.", origin: "tok", answer_id: "a-1" })}\n`);
  appendFileSync(ledgerPath, `${JSON.stringify({ ts: at(500), run_id: "PANEL-1", task_id: TASK, step: "panel.question_answered", origin: "tok", answer: "Use 3 passes.", answer_id: "a-1" })}\n`);
  appendFileSync(ledgerPath, `${JSON.stringify({ ts: at(1000), run_id: "RUN-1", task_id: TASK, step: "panel.question_answered", origin: github, answer: "Use 5 passes." })}\n`);
  const copiesOfReply = () => storeLines(daemonRoot).filter((line) => line.origin === github).length;
  for (const pass of [1, 2]) {
    assert.ok(taskInputAnswerWithLedger(daemonRoot, ledgerPath)(TASK), `pass ${pass}: the task is answered`);
    assert.equal(copiesOfReply(), 1, `pass ${pass}: the GitHub reply is in the store once`);
  }
  assert.equal(storeLines(daemonRoot).length, 2, "no pass copies anything");
  assert.equal(answerRows(ledgerPath).length, 2, "no pass writes a ledger row");
});

test("W1-T13940 criterion 4: a newer answer row with the same text but another origin is copied once, and a row whose origin and text the store holds is not", (t) => {
  const daemonRoot = tempDir(t, "daemon");
  const ledgerPath = join(tempDir(t, "state"), "ledger.ndjson");
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const row = (ms: number, origin: string, extra: Record<string, unknown> = {}) => appendFileSync(ledgerPath,
    `${JSON.stringify({ ts: at(ms), run_id: "PANEL-1", task_id: TASK, step: "panel.question_answered", origin, answer: "Use 5 passes.", ...extra })}\n`);
  mkdirSync(join(daemonRoot, "plan"), { recursive: true });
  appendFileSync(join(daemonRoot, "plan", "questions.ndjson"), `${JSON.stringify({ ts: at(0), task: TASK, answer: "Use 5 passes.", origin: "issue#501:comment:9001" })}\n`);
  row(0, "issue#501:comment:9001");
  const read = () => taskInputAnswerWithLedger(daemonRoot, ledgerPath)(TASK);
  assert.equal(read(), "Use 5 passes.");
  assert.equal(storeLines(daemonRoot).length, 1, "control: the daemon's own GitHub reply is not copied");
  row(1000, "tok", { answer_id: "a-1", author_login: "craigoley" });
  assert.equal(read(), "Use 5 passes.");
  row(2000, "tok", { answer_id: "a-2" });
  assert.equal(read(), "Use 5 passes.");
  writeFileSync(ledgerPath, "");
  assert.equal(read(), "Use 5 passes.", "the store still answers once the rows are gone");
  const ids = storeLines(daemonRoot).filter((line) => line.source === "ledger").map((line) => [line.answer_id, line.origin, line.author_login ?? null, line.ts]);
  assert.deepEqual(ids, [["a-1", "tok", "craigoley", at(1000)]], "the row with a new origin is copied; a-2's origin and text are already in the store");
  read();
  assert.equal(storeLines(daemonRoot).length, 2, "a later read copies nothing");
});

test("W1-T13940 criterion 4: the answer route and the escalation reply route stamp the store line and the answer row from the one injected clock", async (t) => {
  const root = tempDir(t, "clock");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const threads = join(root, "threads.jsonl");
  const stamp = new Date(T0 - 86_400_000).toISOString();
  await routeAnswer(join(root, "serve"), ledgerPath, "route answer");
  appendThreadMessage({ taskId: TASK, class: "BLOCKED" }, "escalation", "the retry still failed CI", { threadStorePath: threads });
  assert.equal(await post([buildEscalationReplyRoute({ ...deps(join(root, "config"), ledgerPath, threads), clock: fixedClock(T0 - 86_400_000) })],
    "/v1/escalation/reply", { taskId: TASK, class: "BLOCKED", text: "reply answer" }), 200);
  const stores = [...storeLines(join(root, "serve")), ...storeLines(join(root, "config"))].filter((line) => line.task === TASK);
  assert.deepEqual(stores.map((line) => [line.answer, line.ts]), [["route answer", new Date(T0).toISOString()], ["reply answer", stamp]], "control: the store lines use the clock");
  const rows = answerRows(ledgerPath);
  assert.deepEqual(rows.map((row) => [row.answer, row.ts, row.answer_id]), stores.map((line) => [line.answer, line.ts, line.answer_id]),
    "each answer row carries its store line's ts and answer_id");
  // An older route answer cannot outrank a newer GitHub answer by its wall-clock ledger stamp.
  const daemonRoot = tempDir(t, "daemon");
  appendFileSync(ledgerPath, `${JSON.stringify({ ts: new Date(T0 + 1000).toISOString(), run_id: "RUN-1", task_id: TASK, step: "panel.question_answered", origin: "issue#501:comment:9001", answer: "Use 5 passes." })}\n`);
  assert.equal(taskInputAnswerWithLedger(daemonRoot, ledgerPath)(TASK), "Use 5 passes.", "the newer GitHub answer wins");
});

/** A core now body whose every source is complete: a policy, a daemon boot, a fresh GitHub, measured feedback age, and
 *  `store` as the question store's text; composed with a real, empty Inbox needsYou page. */
function completeCoreNeedsYou(t: TestCtx, plan: Plan, store: string) {
  const root = readModelFixtureDir(t, "t13940-complete").dir;
  const nowMs = Date.parse("2026-11-20T12:00:00.000Z");
  const iso = (ms: number) => new Date(nowMs + ms).toISOString();
  const clock = fixedClock(nowMs);
  const ledgerDir = join(root, "state");
  const planPath = join(root, "checkout", "plan", "tasks.yaml");
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(join(dirname(planPath), "policy.yaml"), readFileSync(policyPath(REPO_ROOT), "utf8"));
  writeFileSync(join(dirname(planPath), "questions.ndjson"), store);
  writeFileSync(join(ledgerDir, "ledger.ndjson"), [{ ts: iso(-7_200_000), step: "daemon.boot", head_sha: "a".repeat(40) },
    { ts: iso(-1000), step: "daemon.freshness_not_stale", arm: "up_to_date" }].map((row) => `${JSON.stringify(row)}\n`).join(""));
  // Consenting, enrolled feedback-age evidence over a window that holds now: one triaged entry, every ledger form read.
  const ageDir = join(root, "feedback-age");
  mkdirSync(ageDir, { recursive: true });
  const window = { from: iso(-3_600_000), through: iso(3_600_000) };
  writeFileSync(join(ageDir, "ledger.ndjson"), [{ ts: window.from, step: "daemon.poll" }, { ts: iso(-1_800_000), step: "triage.start", feedback_id: "fb-1" },
    { ts: window.through, step: "daemon.poll" }].map((row) => `${JSON.stringify(row)}\n`).join(""));
  const db = openProjectorReadModel(join(root, "read-model"), "core", clock);
  onReadModelClose(t, () => db.close());
  const lease = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(lease.ok);
  createLedgerProjector({ ledgerDir, db, lease: lease.lease, clock }).tick();
  const github = { readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
    listOpenHeadBranches: () => [], listOpenPrs: () => [], headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => null } as unknown as GitHub;
  const view = createNowView({ instances: [{ name: "core", ledgerDir, planPath, feedbackRoot: dirname(dirname(planPath)) }], coreInstance: "core", clock,
    readPlan: () => plan, planBehind: () => ({ commits: 0 }), listGrilling: () => [],
    feedbackAgeObservation: { window, roots: [{ instance: "core", ledgerDir: ageDir, enrolled: true, consent: true, coverage: [window],
      entries: [{ id: "fb-1", status: "accepted", ts: iso(-2_400_000), raw: "a triaged entry", attachments: [], origin: "cli", proposal_pr: null }] }] },
    github: () => ({ github, generation: "known", source: { asOf: clock.iso(), state: "fresh" } }),
    hostProbe: { readLive: () => [], diskFree: () => 1000, rateLimit: () => 5000 } });
  const [body] = view.materialize({ now: clock.now(), switches: { views: { now: "serve" } }, instances: [{ db, state: { instance: "core",
    generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null } }] });
  assert.ok(body, "a core now body");
  const now: ViewBodyEntry = { view: NOW_VIEW_NAME, key: "instance=core", version: NOW_VIEW_VERSION, generation: 1, etag: "now",
    body: { view: NOW_VIEW_NAME, version: NOW_VIEW_VERSION, generatedAt: clock.iso(), asOf: clock.iso(), stale: false, sources: body.sources, data: body.data } };
  writeClassificationSnapshot(ledgerDir, [], clock);
  const lanes = inboxLanes({ proposals: [], classifications: [], ledgerLines: Object.assign([], { torn: 0, present: true }) }, root);
  const source: ViewSource = { name: "inbox-store:core", instance: "core", asOf: clock.iso(), state: "fresh" };
  const page = inboxViewBodies(lanes, source, "a".repeat(64)).find((b) => b.key === "section=needsYou")!;
  const inboxBody: ViewBodyEntry = { view: "inbox", key: page.key, version: 1, generation: 1, etag: "inbox",
    body: { view: "inbox", version: 1, generatedAt: clock.iso(), asOf: clock.iso(), stale: false, sources: page.sources, data: page.data } };
  return composeNeedsYou(new Map([["now", now], ["inbox", inboxBody]]), ["core"]).data;
}

test("W1-T13940 criterion 3: with a fully readable, valid core question store, past the cap the needs-you count of held tasks left out is exact", (t) => {
  const ids = Array.from({ length: NOW_DECISIONS_CAP + 1 }, (_, i) => `W1-T9${String(2000 + i)}`);
  const many: Plan = loadPlanFromYaml(ids.map((id, i) => `- id: ${id}
  title: "held fixture ${i}"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  origin: architect
  files: [src/lib/plan.ts]
  needs_input:
    question: "question ${i}?"
    asked_at: "2026-11-14T20:${String(i).padStart(2, "0")}:00Z"
`).join(""), "plan/tasks.d/W1-T92000-many.yaml");
  // A valid store: an answered question for a task outside the plan, every line whole.
  const valid = [{ ts: "2026-11-14T19:00:00Z", task: "W1-T99999", question: "an old question?" }, { ts: "2026-11-14T19:05:00Z", task: "W1-T99999", answer: "done", origin: "tok" }]
    .map((line) => `${JSON.stringify(line)}\n`).join("");
  const composed = completeCoreNeedsYou(t, many, valid);
  assert.deepEqual(composed.needsYou.uncertain, [], "control: every source is complete, the question store among them");
  const listed = composed.decisions.filter((d) => d.kind === "task_question");
  assert.equal(listed.length, NOW_DECISIONS_CAP, "the list keeps its cap");
  assert.deepEqual(composed.needsYou.inbox, { count: NOW_DECISIONS_CAP + 1 });
  assert.deepEqual(composed.needsYou.display, { shown: NOW_DECISIONS_CAP, more: { count: 1 } }, "the count of held tasks the list leaves out is exact");
  // The same store with one torn line is partial, and the count is then a lower bound.
  const torn = completeCoreNeedsYou(t, many, `${valid}{"task":"W1-T9\n`);
  assert.deepEqual(torn.needsYou.uncertain.map((source) => [source.name, source.state]), [["task-questions", "partial"]]);
  assert.deepEqual(torn.needsYou.display, { shown: NOW_DECISIONS_CAP, more: { atLeast: 1 } });
});

test("W1-T13940 criterion 4: a ledger answer whose origin and text the store already holds, under another answer id, adds no second store entry", (t) => {
  const daemonRoot = tempDir(t, "daemon");
  const ledgerPath = join(tempDir(t, "state"), "ledger.ndjson");
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  mkdirSync(join(daemonRoot, "plan"), { recursive: true });
  appendFileSync(join(daemonRoot, "plan", "questions.ndjson"), `${JSON.stringify({ ts: at(0), task: TASK, answer: "Use 5 passes.", origin: "tok", answer_id: "a-1" })}\n`);
  appendFileSync(ledgerPath, `${JSON.stringify({ ts: at(1000), run_id: "PANEL-1", task_id: TASK, step: "panel.question_answered", origin: "tok", answer: "Use 5 passes.", answer_id: "a-2" })}\n`);
  for (const pass of [1, 2]) {
    assert.equal(taskInputAnswerWithLedger(daemonRoot, ledgerPath)(TASK), "Use 5 passes.", `pass ${pass}: the task is answered`);
    assert.equal(storeLines(daemonRoot).length, 1, `pass ${pass}: the store already holds that origin and text, so nothing is copied`);
  }
  // Control: a row with a new origin and the same text is copied.
  appendFileSync(ledgerPath, `${JSON.stringify({ ts: at(2000), run_id: "PANEL-2", task_id: TASK, step: "panel.question_answered", origin: "tok-2", answer: "Use 5 passes.", answer_id: "a-3" })}\n`);
  taskInputAnswerWithLedger(daemonRoot, ledgerPath)(TASK);
  assert.deepEqual(storeLines(daemonRoot).map((line) => line.answer_id), ["a-1", "a-3"]);
});
