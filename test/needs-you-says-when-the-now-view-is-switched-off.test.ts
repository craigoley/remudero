// W1-T14172: the read-model `now` view has been switched off since 2026-11-20T02:07Z, yet the needs-you
// composite kept using the last now body it held as if it were current ("13 Needs you"), and the held task
// questions (queued tasks with needs_input) never reached the Inbox, since only the now build found them.
// The composite now reads the now switch, and when core's now body is not used it reads held questions
// from the plan through a cheap held-tasks source.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import type { HumanGateCountSummary, HumanGateProjection } from "#src/lib/human-gate.js";
import { NAV_BADGE_VIEW_NAME, type NavBadgeData } from "#src/lib/nav-badge-view.js";
import { composeNeedsYou, NEEDS_YOU_VIEW_NAME, planHeldTasks, withNeedsYouView, type NeedsYouData } from "#src/lib/needs-you-view.js";
import { questionStorePath, type NowDecision } from "#src/lib/now-decisions.js";
import { loadPlanFromYaml, sharedAnswersPath, type Plan } from "#src/lib/plan.js";
import type { ReadModelInstanceState, ReadModelSwitches, ReadModelWorkerHandle } from "#src/lib/read-model-worker.js";
import type { Route } from "#src/lib/service.js";
import { withStatusNeedsYou } from "#src/lib/serve.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { EffectiveViewMode, ViewBodyEntry, ViewSource } from "#src/lib/views.js";
import { viewEtag } from "#src/lib/views.js";
import { readTaskInputAnswer, taskInputAnswerWithLedger } from "#src/lib/worker.js";

type TestCtx = { after: (fn: () => void) => void };
const T0 = Date.parse("2026-11-21T12:00:00.000Z");
const clock: Clock = { now: () => T0, date: () => new Date(T0), iso: () => new Date(T0).toISOString() };
const OLD = "2026-11-20T02:07:39.000Z";

function entry(view: string, key: string, version: number, data: unknown, sources: ViewSource[], generatedAt = OLD): ViewBodyEntry {
  return { view, key, version, generation: 1, etag: viewEtag(view, version, false, data), body: { view, version, generatedAt, asOf: generatedAt, stale: false, sources, data } };
}

function decision(instance: string, id: string, askedAt: string, taskId?: string): NowDecision {
  return { id, kind: "task_question", instance, ...(taskId ? { taskId } : {}), title: id, prompt: "p", askedAt,
    answer: { method: "POST", path: "/v1/questions/answer", tier: "low", fields: taskId ? { taskId } : {}, input: "text" } };
}

/** The core now body built just before the switch went off: 13 open decisions. */
function oldCoreNow(decisions = Array.from({ length: 13 }, (_, i) => decision("core", `question:W1-T${800 + i}:${OLD}`, OLD))): ViewBodyEntry {
  return entry("now", "instance=core", 3, { instance: "core", actions: [], decisions }, [{ name: "ledger:core", asOf: OLD, state: "fresh" }]);
}

const badgeBody = (): ViewBodyEntry => entry(NAV_BADGE_VIEW_NAME, "", 1, { agent: { proposalIds: [], instances: [] }, inbox: { reason: "fixture" } }, [{ name: "ledger:core", asOf: OLD, state: "fresh" }]);

/** A read-model handle a test steers; `views` is the switch file as the main thread last read it, and the test may change it. */
function fakeHandle(views: ReadModelSwitches["views"], auto?: EffectiveViewMode) {
  const bodies = new Map<string, ViewBodyEntry>();
  const listeners = new Set<(e: ViewBodyEntry) => void>();
  const instances = new Map<string, ReadModelInstanceState>([["core", { instance: "core", generation: 1, lease: "held", failures: 0, newestTs: null }]]);
  const handle: ReadModelWorkerHandle = {
    bodies,
    state: () => ({ instances, switches: { projector: "on", views } }),
    body: (view, key = "") => bodies.get(`${view}\u0000${key}`),
    judge: (sources) => [...sources],
    switches: () => ({ projector: "on", views }),
    autoMode: (view) => (view === "now" ? auto : undefined),
    start: () => {},
    stop: () => true,
    reload: () => 0,
    shadow: () => {},
    driveShadow: () => {},
    onBody: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const post = (e: ViewBodyEntry): void => {
    bodies.set(`${e.view}\u0000${e.key}`, e);
    for (const l of listeners) l(e);
  };
  return { handle, post };
}

const dataOf = (handle: ReadModelWorkerHandle): NeedsYouData => handle.body(NEEDS_YOU_VIEW_NAME)!.body.data as NeedsYouData;

/** GET /v1/status as serve wraps it, reading the composite's projection. */
async function statusNeedsYou(read: () => HumanGateProjection | undefined): Promise<HumanGateCountSummary> {
  const board: Route = { method: "GET", path: "/v1/status", scope: "read", handler: (_req, res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ counts: { blocked: 0 } }));
  } };
  let sent = "";
  const res = { writeHead: () => res, end: (chunk?: string) => { sent = chunk ?? ""; } } as unknown as ServerResponse;
  await withStatusNeedsYou(board, read).handler({ url: "/v1/status", headers: {} } as never, res, {} as never);
  return (JSON.parse(sent) as { needsYou: HumanGateCountSummary }).needsYou;
}

function tempDir(t: TestCtx, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t14172-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const heldTask = (id: string, askedAt: string): string => `- id: ${id}
  title: "held ${id}"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  origin: architect
  files: [src/lib/plan.ts]
  needs_input:
    question: "Which bound for ${id}?"
    asked_at: "${askedAt}"
`;

const HELD_PLAN: Plan = loadPlanFromYaml([heldTask("W1-T13904", "2026-11-19T10:00:00Z"), heldTask("W1-T13911", "2026-11-19T11:00:00Z"), heldTask("W1-T14002", "2026-11-20T09:00:00Z")].join(""), "plan/tasks.d/held.yaml");

/** Serve's own state folder and checkout: an empty ledger, the answers file beside it, and the question store. */
function stateFixture(t: TestCtx): { root: string; ledgerPath: string } {
  const dir = tempDir(t, "state");
  const root = join(dir, "checkout");
  mkdirSync(join(root, "plan"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  const ledgerPath = join(dir, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify({ ts: OLD, step: "daemon.tick" }) + "\n");
  return { root, ledgerPath };
}

test("W1-T14172 criterion 1: with views.now off the composite shows no decision from the old core now body and names the switch", () => {
  const composed = composeNeedsYou(new Map([["now\u0000instance=core", oldCoreNow()]]), ["core"], { nowMode: "off" });
  const now = composed.sources.find((s) => s.name === "read-model:now@core");
  assert.equal(now?.state, "unavailable");
  assert.match(now?.reason ?? "", /views\.now/);
  assert.match(now?.reason ?? "", /\boff\b/);
  assert.ok(now?.reason?.includes(OLD), `the reason names the old body's generatedAt: ${now?.reason}`);
  assert.equal(composed.data.decisions.length, 0, "none of the 13 old decisions is shown");
  assert.deepEqual(composed.data.instances, [{ instance: "core", reason: now?.reason }], "core has no counts");

  const { handle, post } = fakeHandle({ now: "off" });
  post(oldCoreNow());
  const view = withNeedsYouView(handle, clock);
  const body = view.body(NEEDS_YOU_VIEW_NAME)!;
  const data = body.body.data as NeedsYouData;
  assert.equal(data.decisions.length, 0, "the production overlay reads the switch too");
  assert.equal(data.instances.find((i) => i.instance === "core")?.counts, undefined);
  assert.equal(body.body.stale, true, "the composite is stale while the now view is off");
  assert.ok(data.humanGates.sources.some((s) => s.instance === "core" && s.state === "unavailable" && s.reason === now?.reason), "the gate source carries the reason");

  const control = composeNeedsYou(new Map([["now\u0000instance=core", oldCoreNow()]]), ["core"]);
  assert.equal(control.data.decisions.length, 13, "control: with no switch the 13 decisions are used, as before");
});

test("W1-T14172 criterion 2: the served nav badge and GET /v1/status mark the now decisions unavailable and do not count the old body", async () => {
  const { handle, post } = fakeHandle({ now: "off" });
  post(oldCoreNow());
  post(badgeBody());
  const view = withNeedsYouView(handle, clock);
  const reason = (dataOf(view).instances.find((i) => i.instance === "core")?.reason) ?? "";
  assert.match(reason, /views\.now is off/);
  const badge = (view.body(NAV_BADGE_VIEW_NAME)!.body.data as NavBadgeData).inbox.decisions as HumanGateCountSummary;
  const status = await statusNeedsYou(() => dataOf(view).humanGates);
  for (const [name, counts] of [["badge", badge], ["status", status]] as const) {
    assert.ok(counts.uncertain.some((u) => u.instance === "core" && u.state === "unavailable" && u.reason === reason), `${name} names the switch`);
    assert.notEqual(counts.inbox.count ?? counts.inbox.atLeast, 13, `${name} does not show the old body's count`);
    assert.equal(counts.inbox.count, undefined, `${name} is a lower bound, never a total`);
  }
  assert.deepEqual(status, badge, "both surfaces read the same composite");
});

test("W1-T14172 criterion 3: with views.now shadow or serve the composite is unchanged, and a switch flip composes again", () => {
  const bodies = new Map([["now\u0000instance=core", oldCoreNow()]]);
  const before = composeNeedsYou(bodies, ["core"]);
  for (const nowMode of ["shadow", "serve", undefined] as const) assert.deepEqual(composeNeedsYou(bodies, ["core"], { nowMode, held: { tasks: [], answered: () => false } }), before, `mode ${nowMode}`);

  const views: ReadModelSwitches["views"] = { now: "off" };
  const { handle, post } = fakeHandle(views);
  post(oldCoreNow());
  const view = withNeedsYouView(handle, clock);
  assert.equal(dataOf(view).decisions.length, 0, "off: nothing from the old body");
  views.now = "serve";
  assert.equal(dataOf(view).decisions.length, 13, "the next read after the flip composes again");
  views.now = "off";
  assert.equal(dataOf(view).decisions.length, 0, "and back");

  const auto = fakeHandle({ now: "auto" }, "serve");
  auto.post(oldCoreNow());
  assert.equal(dataOf(withNeedsYouView(auto.handle, clock)).decisions.length, 13, "auto that serves is served");
  const autoOff = fakeHandle({ now: "auto" }, "off");
  autoOff.post(oldCoreNow());
  assert.equal(dataOf(withNeedsYouView(autoOff.handle, clock)).decisions.length, 0, "auto resolved off is off");
});

test("W1-T14172 criterion 4: with views.now off the plan's held tasks reach the composite through a held-tasks source", (t) => {
  const { root, ledgerPath } = stateFixture(t);
  writeFileSync(sharedAnswersPath(ledgerPath), JSON.stringify({ task: "W1-T13911", answer: "Use 5.", ts: "2026-11-21T08:00:00Z", origin: "fixture" }) + "\n");
  const { handle, post } = fakeHandle({ now: "off" });
  post(oldCoreNow());
  let plan = HELD_PLAN;
  const view = withNeedsYouView(handle, clock, { heldTasks: planHeldTasks(() => plan, readTaskInputAnswer(root, ledgerPath), [ledgerPath, sharedAnswersPath(ledgerPath), questionStorePath(root)]) });
  const data = dataOf(view);
  const asked = data.decisions.filter((d) => d.kind === "task_question");
  assert.deepEqual(asked.map((d) => d.taskId).sort(), ["W1-T13904", "W1-T14002"], "the two unanswered held tasks, not the answered one, and none of the old body");
  for (const d of asked) {
    assert.equal(d.answer.path, "/v1/questions/answer");
    assert.deepEqual(d.answer.fields, { taskId: d.taskId });
  }
  const held = data.humanGates.sources.filter((s) => s.name === "held-tasks");
  assert.deepEqual(held.map((s) => [s.instance, s.state]), [["core", "complete"]], "one fresh (complete) held-tasks source for core");
  const gates = data.humanGates.gates.filter((g) => g.kind === "task_question");
  assert.deepEqual(gates.map((g) => g.key).sort(), asked.map((d) => `task_question:core:${encodeURIComponent(d.id)}`).sort(), "its two gates are the shown decisions");
  assert.equal(data.needsYou.display?.shown, 2, "both gates are shown on the page");

  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-11-21T09:00:00Z", step: "panel.question_answered", task_id: "W1-T13904", answer: "Yes.", origin: "console" }) + "\n");
  assert.deepEqual(dataOf(view).decisions.map((d) => d.taskId), ["W1-T14002"], "a new answer row in the ledger composes again");
  plan = loadPlanFromYaml(heldTask("W1-T14002", "2026-11-20T09:00:00Z") + heldTask("W1-T14999", "2026-11-21T10:00:00Z"), "plan/tasks.d/reloaded.yaml");
  assert.deepEqual(dataOf(view).decisions.map((d) => d.taskId).sort(), ["W1-T14002", "W1-T14999"], "a reloaded plan composes again");
});

test("W1-T14172 criterion 5: when the core now body is used the composite adds no held-tasks source and shows a held task once", (t) => {
  const { root, ledgerPath } = stateFixture(t);
  const { handle, post } = fakeHandle({ now: "serve" });
  post(oldCoreNow([decision("core", "question:W1-T13904:2026-11-19T10:00:00Z", "2026-11-19T10:00:00Z", "W1-T13904")]));
  let reads = 0;
  const heldTasks = planHeldTasks(() => HELD_PLAN, readTaskInputAnswer(root, ledgerPath), [ledgerPath]);
  const view = withNeedsYouView(handle, clock, { heldTasks: () => (reads++, heldTasks()) });
  const data = dataOf(view);
  assert.deepEqual(data.decisions.map((d) => d.taskId), ["W1-T13904"], "the held task the now body carries, once");
  assert.equal(data.humanGates.sources.some((s) => s.name === "held-tasks"), false);
  assert.equal(reads, 0, "the plan is not read while the now body is used");
});

test("W1-T14172 criterion 6: readTaskInputAnswer finds the answers taskInputAnswerWithLedger finds and writes no file", (t) => {
  const { root, ledgerPath } = stateFixture(t);
  writeFileSync(questionStorePath(root), JSON.stringify({ task: "W1-T1", answer: "from the store", ts: "2026-11-21T01:00:00Z", origin: "console:store" }) + "\n");
  appendFileSync(ledgerPath, JSON.stringify({ ts: "2026-11-21T02:00:00Z", step: "panel.question_answered", task_id: "W1-T2", answer: "from a row", origin: "console:row" }) + "\n");
  writeFileSync(sharedAnswersPath(ledgerPath), JSON.stringify({ task: "W1-T3", answer: "published", ts: "2026-11-21T03:00:00Z", origin: "console:pub" }) + "\n");
  const ids = ["W1-T1", "W1-T2", "W1-T3", "W1-T4"];
  const files = [questionStorePath(root), ledgerPath, sharedAnswersPath(ledgerPath)];
  const stamp = (): Array<[number, number]> => files.map((f) => { const s = statSync(f); return [s.size, s.mtimeMs]; });
  const before = stamp();
  const read = readTaskInputAnswer(root, ledgerPath);
  const quiet = ids.map((id) => read(id));
  assert.deepEqual(stamp(), before, "the read-only reader leaves every file as it was");
  assert.deepEqual(quiet, ["from the store", "from a row", "published", undefined]);
  const daemon = taskInputAnswerWithLedger(root, ledgerPath);
  assert.deepEqual(ids.map((id) => daemon(id)), quiet, "the daemon's reader decides the same");
  assert.notDeepEqual(stamp(), before, "control: the daemon's reader does write (it copies and publishes)");
  assert.deepEqual(ids.map((id) => readTaskInputAnswer(root, ledgerPath)(id)), quiet, "after its copies the read-only reader still agrees");
});
