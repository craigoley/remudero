import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import "#src/lib/live-analytics-snapshot-cache.js";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import { runDaemon } from "#src/lib/daemon.js";
import { createDaemonMemoryGovernor } from "#src/lib/daemon-memory-policy.js";
import { renderIssueBody, type Escalation, type OpenIssue } from "#src/lib/escalate.js";
import { readEscalationAnswers, type EscalationAnswerGateway } from "#src/lib/escalation-answers.js";
import { appendThreadMessage } from "#src/lib/inbox-thread.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { composeNeedsYou } from "#src/lib/needs-you-view.js";
import { createNowView, NOW_VIEW_NAME, NOW_VIEW_VERSION, type NowViewContext, type NowViewData } from "#src/lib/now-view.js";
import { buildAnswerQuestionRoute, buildEscalationReplyRoute, type PanelActionDeps } from "#src/lib/panel-actions.js";
import { assertRunnable, loadPlanFromYaml, TaskAdmissionError, type Plan } from "#src/lib/plan.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import { createService } from "#src/lib/service.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { viewEtag, type ViewBodyEntry } from "#src/lib/views.js";
import { taskInputAnswerWithLedger } from "#src/lib/worker.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
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
function inbox(t: TestCtx) {
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
    instances: [{ name: "core", ledgerDir, feedbackRoot: serveRoot }], clock, readPlan: () => PLAN, listGrilling: () => [],
    github: () => ({ github: fakeGitHub(), generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 1 },
  });
  const ctx = (): NowViewContext => ({ now: clock.now(), switches: { views: { now: "shadow" } }, instances: [{
    state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null }, db }] });
  /** composeNeedsYou over this instance's now body: the list the Console renders, and its gates. */
  const needsYou = () => {
    projector.tick();
    clock.set(clock.now() + 60_000);
    const body = view.materialize(ctx()).find((b) => b.key === "instance=core");
    assert.ok(body, "a now body for core");
    const data: NowViewData = body.data;
    const entry: ViewBodyEntry = { view: NOW_VIEW_NAME, key: "instance=core", version: NOW_VIEW_VERSION, generation: 1, etag: viewEtag(NOW_VIEW_NAME, NOW_VIEW_VERSION, false, data),
      body: { view: NOW_VIEW_NAME, version: NOW_VIEW_VERSION, generatedAt: clock.iso(), asOf: null, stale: false, sources: body.sources, data } };
    const composed = composeNeedsYou(new Map([["now", entry]]), ["core"]).data;
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
