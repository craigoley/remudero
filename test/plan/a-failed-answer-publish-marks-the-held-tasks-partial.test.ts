import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock, test } from "node:test";

import "#src/lib/live-analytics-snapshot-cache.js";
import type { Clock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { composeNeedsYou } from "#src/lib/needs-you-view.js";
import { createNowView, NOW_VIEW_NAME, NOW_VIEW_VERSION, type NowViewContext, type NowViewData } from "#src/lib/now-view.js";
import { assertRunnable, loadPlanFromYaml, publishAnswers, sharedAnswersPath, TaskAdmissionError, type AnswerRecord, type Plan } from "#src/lib/plan.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import { viewEtag, type ViewBodyEntry } from "#src/lib/views.js";
import { taskInputAnswerWithLedger } from "#src/lib/worker.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const TASK = "W1-T90002";
const QUESTION = "Which retry bound should the sweep use: 3 or 5 passes?";
const ANSWER = "Use 5 passes.";

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
    asked_at: "2026-11-14T20:00:00Z"
`, "plan/tasks.d/W1-T90002-held.yaml");

type TestCtx = { after: (fn: () => void) => void };

function lines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The core now view over a shared ledger, with serve's own question store holding the only answer to the held task. */
function coreInbox(t: TestCtx) {
  const root = readModelFixtureDir(t, "t14390").dir;
  let nowMs = Date.now();
  const clock: Clock & { set(ms: number): void } = { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString(), set: (ms) => { nowMs = ms; } };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const ledgerPath = join(ledgerDir, "ledger.ndjson");
  writeLedger([{ ts: clock.iso(), host: "h1", step: "daemon.tick" }], { dir: ledgerDir });
  const daemonRoot = join(root, "daemon-checkout");
  mkdirSync(join(daemonRoot, "plan"), { recursive: true });
  const serveRoot = join(root, "serve-gen");
  mkdirSync(join(serveRoot, "plan"), { recursive: true });
  writeFileSync(join(serveRoot, "plan", "questions.ndjson"), `${JSON.stringify({ ts: clock.iso(), task: TASK, answer: ANSWER, origin: "tok" })}\n`);
  const db = openProjectorReadModel(join(root, "read-model-home"), "core", clock);
  onReadModelClose(t, () => db.close());
  const acquired = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(acquired.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: acquired.lease, clock });
  const view = createNowView({
    instances: [{ name: "core", ledgerDir, feedbackRoot: serveRoot }], coreInstance: "core", clock, readPlan: () => PLAN, listGrilling: () => [],
    github: () => ({ github: fakeGitHub(), generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 1 },
  });
  const ctx = (): NowViewContext => ({ now: clock.now(), switches: { views: { now: "shadow" } }, instances: [{
    state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null }, db }] });
  const read = () => {
    projector.tick();
    clock.set(clock.now() + 60_000);
    const body = view.materialize(ctx()).find((b) => b.key === "instance=core");
    assert.ok(body, "a now body for core");
    const data: NowViewData = body.data;
    const entry: ViewBodyEntry = { view: NOW_VIEW_NAME, key: "instance=core", version: NOW_VIEW_VERSION, generation: 1, etag: viewEtag(NOW_VIEW_NAME, NOW_VIEW_VERSION, false, data),
      body: { view: NOW_VIEW_NAME, version: NOW_VIEW_VERSION, generatedAt: clock.iso(), asOf: null, stale: false, sources: body.sources, data } };
    const composed = composeNeedsYou(new Map([["now", entry]]), ["core"]).data;
    const held = composed.decisions.filter((d) => d.kind === "task_question" && d.taskId === TASK);
    const source = composed.humanGates.sources.find((s) => s.instance === "core" && s.name === "task-questions");
    return { held, source };
  };
  /** The daemon's dispatch check, which cannot see serve's store: its reason when it refuses the task. */
  const refusal = (): string | undefined => {
    try {
      assertRunnable(PLAN, PLAN.byId.get(TASK)!, () => true, undefined, taskInputAnswerWithLedger(daemonRoot, ledgerPath));
      return undefined;
    } catch (error) {
      assert.ok(error instanceof TaskAdmissionError, String(error));
      return error.message;
    }
  };
  const answersPath = sharedAnswersPath(ledgerPath);
  /** A readable answers file whose appends fail with EACCES, for every uid, until `allow` is called. */
  const readOnlyAnswers = () => {
    writeFileSync(answersPath, "");
    const original = fs.appendFileSync;
    const append = mock.method(fs, "appendFileSync", (path: fs.PathOrFileDescriptor, ...rest: [string, fs.WriteFileOptions?]) => {
      if (path === answersPath) throw Object.assign(new Error(`EACCES: permission denied, open '${answersPath}'`), { code: "EACCES" });
      return original(path, ...rest);
    });
    syncBuiltinESMExports();
    const allow = () => { append.mock.restore(); syncBuiltinESMExports(); };
    t.after(allow);
    return allow;
  };
  return { read, refusal, ledgerPath, answersPath, readOnlyAnswers };
}

function record(answer: string, origin: string): AnswerRecord {
  return { task: TASK, answer, ts: "2026-11-20T12:00:00.000Z", origin };
}

test("W1-T14390 criterion 1: a readable answers file whose append fails makes the core held-tasks source partial, with a reason naming the file and the error", (t) => {
  const box = coreInbox(t);
  box.readOnlyAnswers();
  const { source } = box.read();
  assert.equal(source?.state, "partial", "the held-tasks source is partial");
  assert.ok(source?.reason?.includes(`the answers file ${box.answersPath} could not be written: `), source?.reason);
  assert.ok(source?.reason?.endsWith(`EACCES: permission denied, open '${box.answersPath}'`), "the reason carries the write error");
  assert.equal(lines(box.answersPath).length, 0, "control: nothing was published");
});

test("W1-T14390 criterion 2: publishAnswers returns the first failure's reason and appends nothing after it", (t) => {
  const box = coreInbox(t);
  writeFileSync(box.answersPath, "");
  // The first candidate cannot be written, so the second one, which could, is not appended either.
  const unwritable = { ...record("first", "a"), toJSON() { throw new Error("the record cannot be written"); } } as AnswerRecord;
  const known: AnswerRecord[] = [];
  const reason = publishAnswers(box.ledgerPath, [unwritable, record("second", "b")], known);
  assert.equal(reason, `the answers file ${box.answersPath} could not be written: the record cannot be written`);
  assert.equal(lines(box.answersPath).length, 0, "no append after the first failure");
  assert.equal(known.length, 0, "nothing is counted as published");
});

test("W1-T14390 criterion 2: publishAnswers returns undefined when every append succeeds or nothing needs publishing, and the source stays complete", (t) => {
  const box = coreInbox(t);
  const ledgerPath = box.ledgerPath;
  const known: AnswerRecord[] = [];
  assert.equal(publishAnswers(ledgerPath, [record("first", "a"), record("second", "b")], known), undefined);
  assert.deepEqual(lines(box.answersPath).map((line) => line.answer), ["first", "second"]);
  assert.equal(publishAnswers(ledgerPath, [record("first", "a")], known), undefined, "nothing left to publish");
  assert.equal(publishAnswers(ledgerPath, [], known), undefined, "no candidates");
  assert.equal(lines(box.answersPath).length, 2, "nothing is appended twice");

  const inbox = coreInbox(t);
  const { source, held } = inbox.read();
  assert.equal(held.length, 0, "the store answer releases the task");
  assert.equal(source?.state, "complete", "a publish that succeeds keeps the held-tasks source complete");
  assert.deepEqual(lines(inbox.answersPath).map((line) => line.answer), [ANSWER], "and the answer is published");
});

test("W1-T14390 criterion 2: an append to an answers file that refuses writes returns a reason that names the file", (t) => {
  const box = coreInbox(t);
  box.readOnlyAnswers();
  const known: AnswerRecord[] = [];
  const reason = publishAnswers(box.ledgerPath, [record("first", "a"), record("second", "b")], known);
  assert.ok(reason?.startsWith(`the answers file ${box.answersPath} could not be written: `), reason);
  assert.equal(known.length, 0);
});

test("W1-T14390 criterion 3: a failed publish still releases the store-answered task in the Inbox, and a later writable read publishes the answer once", (t) => {
  const box = coreInbox(t);
  const allow = box.readOnlyAnswers();
  const failed = box.read();
  assert.equal(failed.held.length, 0, "the Inbox still counts its own store's answer");
  assert.equal(failed.source?.state, "partial");
  assert.match(box.refusal() ?? "", /needs-input/, "dispatch, which cannot see serve's store, still holds the task");

  allow();
  const writable = box.read();
  assert.equal(writable.held.length, 0, "the task stays released");
  assert.equal(writable.source?.state, "complete", "a writable file makes the source complete again");
  assert.deepEqual(lines(box.answersPath).map((line) => line.answer), [ANSWER], "the answer is published");
  assert.equal(box.refusal(), undefined, "so dispatch admits the task too");
  box.read();
  assert.equal(lines(box.answersPath).length, 1, "a later read publishes it only once");
});
