import assert from "node:assert/strict";
import test from "node:test";
import { buildDispatchValueContext } from "../src/lib/dispatch-value.js";
import { dispatchOrder, nextRunnable, runnableCandidates } from "../src/lib/drain.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { dispatchValueContextForSelection, readDispatchFilingSnapshot } from "../src/run-task.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRepo } from "./helpers/git-repo.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-04T12:00:00Z");
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, repo: "remudero", depends_on: [], files: ["src/a.ts"],
  type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, ...over,
});
const fresh = task("W1-T4052");
const old = task("W1-T1070");
const filed = new Map([[fresh.id, NOW - DAY], [old.id, NOW - 30 * DAY]]);
const history: Array<Record<string, unknown>> = [];
for (let i = 0; i < 20; i++) {
  const id = `W1-T${5000 + i}`;
  const age = (i < 10 ? 1 : 30) * DAY;
  filed.set(id, NOW - DAY - age);
  history.push({ step: "run.start", task_id: id, run_id: id, task_class: "src", ts: new Date(NOW - DAY).toISOString() });
  history.push({ step: "verdict", task_id: id, run_id: id, verdict: i < 10 ? "merged" : "already_satisfied", cost_usd: 2, ts: new Date(NOW - DAY).toISOString() });
}
function calibrate(tasks: Task[], rows = history, dates = filed, nowMs = NOW) {
  const result = buildDispatchValueContext(tasks, rows, new Set(tasks.map(t => t.id)), nowMs, true, "tree-sha", {
    planTreeSha: "tree-sha", filedAtByTaskId: dates,
  });
  assert.equal(result.kind, "ready");
  return result.context;
}
const plan = (tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map(t => [t.id, t])) });

test("W1-T4064: a fresh task with higher cost of delay outranks an older equal-class task", () => {
  const context = calibrate([old, fresh]);
  assert.equal(nextRunnable(plan([old, fresh]), () => false, { dispatchValueContext: context })?.id, fresh.id);
  assert.equal(runnableCandidates(plan([old, fresh]), () => false, 1, { dispatchValueContext: context })[0]?.id, fresh.id);
});

test("W1-T4064: every eligible task is selected within finitely many passes under stride order", () => {
  const rows = [...history];
  const seen = new Set<string>();
  const tasks = [old, fresh];
  for (let pass = 0; pass < 200; pass++) {
    const context = calibrate(tasks, rows);
    const picked = nextRunnable(plan(tasks), () => false, { dispatchValueContext: context });
    assert.ok(picked);
    seen.add(picked.id);
    rows.push({ step: "run.start", task_id: picked.id, run_id: `selection-${pass}`, task_class: "src", ts: new Date(NOW).toISOString() });
  }
  assert.deepEqual([...seen].sort(), tasks.map(t => t.id).sort());
  const freshCount = rows.filter(r => r.step === "run.start" && r.task_id === fresh.id).length;
  const oldCount = rows.filter(r => r.step === "run.start" && r.task_id === old.id).length;
  assert.ok(freshCount > oldCount, "slots follow the measured shares while the old task still receives service");
});

test("W1-T4064: order is identical for the same plan tree and calibration snapshot", () => {
  const tasks = [old, fresh];
  const a = calibrate(tasks);
  const b = calibrate([...tasks].reverse(), [...history].reverse(), new Map([...filed].reverse()));
  assert.equal(JSON.stringify(dispatchOrder(tasks, a)), JSON.stringify(dispatchOrder([...tasks].reverse(), b)));
  assert.equal(JSON.stringify([...a.stridePassByTaskId!]), JSON.stringify([...b.stridePassByTaskId!]));
});

test("W1-T4064: explicit priority still sorts ahead of any computed score", () => {
  const prioritized = task(old.id, { priority: 0 });
  assert.equal(nextRunnable(plan([fresh, prioritized]), () => false, {
    dispatchValueContext: calibrate([fresh, prioritized]),
  })?.id, old.id);
});

test("W1-T4064: age validity is learned from terminal outcomes rather than an age cap", () => {
  const reversedOutcomes = history.map(row => row.step !== "verdict" ? row : {
    ...row, verdict: row.verdict === "merged" ? "no_pr" : "merged",
  });
  assert.equal(dispatchOrder([old, fresh], calibrate([old, fresh], reversedOutcomes))[0].id, old.id);
  const refused = history.map(row => row.step !== "verdict" || row.verdict === "merged" ? row : {
    ...row, step: "dispatch.refused_already_merged",
  });
  assert.equal(dispatchOrder([old, fresh], calibrate([old, fresh], refused))[0].id, fresh.id);
});

test("W1-T4064: open fanout adds impact and measured cost per merge changes the share", () => {
  const parent = task(fresh.id);
  const child = task("W1-T4060", { depends_on: [parent.id] });
  const peer = task("W1-T1");
  const dates = new Map([...filed, [child.id, NOW - DAY], [peer.id, NOW - DAY]]);
  const context = calibrate([parent, child, peer], history, dates);
  assert.equal(context.costOfDelayByTaskId!.get(parent.id), 2 * context.costOfDelayByTaskId!.get(peer.id)!);
  const expensive = history.map(row => row.cost_usd === undefined ? row : { ...row, cost_usd: 4 });
  const expensiveContext = calibrate([parent, child, peer], expensive, dates);
  assert.equal(expensiveContext.costOfDelayByTaskId!.get(parent.id), context.costOfDelayByTaskId!.get(parent.id)! / 2);
});

test("W1-T4064: duplicate archive starts consume one slot and old slots survive the class window", () => {
  const selected = { step: "run.start", task_id: fresh.id, run_id: "selected", ts: new Date(NOW - 14 * DAY).toISOString() };
  const a = calibrate([old, fresh], [...history, selected]);
  const b = calibrate([old, fresh], [...history, selected, selected]);
  const initial = calibrate([old, fresh]);
  assert.equal(a.stridePassByTaskId!.get(fresh.id), 2 * initial.stridePassByTaskId!.get(fresh.id)!);
  assert.deepEqual([...a.stridePassByTaskId!], [...b.stridePassByTaskId!]);
});

test("W1-T4064: ranking leaves eligibility unchanged and remains a total order around merged tasks", () => {
  const human = task("W1-T1", { verify: "human", priority: 0 });
  const blocked = task("W1-T2", { status: "blocked", priority: 0 });
  const merged = task("W1-T3");
  const tasks = [human, merged, old, fresh, blocked];
  const dates = new Map([...filed, [human.id, NOW - DAY], [blocked.id, NOW - DAY], [merged.id, NOW - DAY]]);
  const result = buildDispatchValueContext(tasks, history, new Set(tasks.filter(t => t !== merged).map(t => t.id)), NOW, true, "seed", { planTreeSha: "tree-sha", filedAtByTaskId: dates });
  assert.equal(result.kind, "ready");
  for (const ordering of [tasks, [...tasks].reverse(), [old, blocked, merged, human, fresh]]) {
    assert.deepEqual(runnableCandidates(plan(ordering), id => id === merged.id, 2, { dispatchValueContext: result.context }).map(t => t.id), [fresh.id, old.id]);
  }
});

test("W1-T4064: missing filing dates and unmeasured costs refuse the computed schedule", () => {
  const snapshot = { planTreeSha: "tree-sha", filedAtByTaskId: new Map([[old.id, NOW - DAY]]) };
  const missing = buildDispatchValueContext([old, fresh], history, new Set([old.id, fresh.id]), NOW, true, "seed", snapshot);
  assert.equal(missing.kind, "refused");
  assert.deepEqual(missing.reasons, [`${fresh.id}:missing-filing-date`]);
  const noCosts = history.map(row => ({ ...row, cost_usd: undefined }));
  const unmeasured = buildDispatchValueContext([old], noCosts, new Set([old.id]), NOW, true, "seed", snapshot);
  assert.equal(unmeasured.kind, "refused");
  assert.deepEqual(unmeasured.reasons, [`${old.id}:unmeasured-cost`]);
  const unreadable = buildDispatchValueContext([old], history, new Set([old.id]), NOW, false, "seed", snapshot);
  assert.equal(unreadable.kind, "refused");
  assert.deepEqual(unreadable.reasons, ["incomplete-union"]);
});

function filingReader(label: string, patch: string) {
  const root = `/fixture/${label}`;
  const calls: string[][] = [];
  const readGit = (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "log") return patch;
    if (args[1] === "--is-shallow-repository") return "false";
    return args[1] === "--show-toplevel" ? root : "a".repeat(40);
  };
  return { path: `${root}/plan/tasks.yaml`, calls, readGit };
}

test("W1-T4064: filing history reads first introduction and caches by committed plan tree", () => {
  const reader = filingReader("filing-cache", "filing:100\n+- id: W1-T1\nfiling:200\n+  id: 'W1-T2'\n+- id: W1-T1\n");
  const first = readDispatchFilingSnapshot(reader.path, reader.readGit);
  assert.equal(first.kind, "ready");
  assert.deepEqual([...first.snapshot.filedAtByTaskId], [["W1-T1", 100_000], ["W1-T2", 200_000]]);
  assert.ok(reader.calls.some(args => args.includes("--first-parent")));
  const second = readDispatchFilingSnapshot(reader.path, reader.readGit);
  assert.equal(second.kind, "ready");
  assert.equal(first.snapshot, second.snapshot);
  assert.equal(reader.calls.filter(args => args[0] === "log").length, 1);
});

test("W1-T4064: filing reader distinguishes bad tree, empty history and a thrown read", () => {
  const reader = filingReader("empty-filing", "filing:100\n+ title: no task id\n");
  assert.deepEqual(readDispatchFilingSnapshot(reader.path, reader.readGit), { kind: "refused", reasons: ["missing-filing-history"] });
  assert.deepEqual(readDispatchFilingSnapshot(reader.path, (_cwd, args) => args[1] === "--is-shallow-repository" ? "false" : "bad"), { kind: "refused", reasons: ["unreadable-plan-tree"] });
  assert.deepEqual(readDispatchFilingSnapshot(reader.path, () => "true"), { kind: "refused", reasons: ["incomplete-filing-history"] });
  const thrown = readDispatchFilingSnapshot(reader.path, () => { throw new Error("history unavailable"); });
  assert.equal(thrown.kind, "refused");
  assert.match(thrown.reasons[0], /filing-history-unreadable:.*history unavailable/);
});

test("W1-T4064: default filing reader reads committed dates from a real repository", () => {
  const repo = gitRepo({ kind: "cost-of-delay" });
  try {
    mkdirSync(join(repo.dir, "plan"));
    const path = join(repo.dir, "plan/tasks.yaml");
    writeFileSync(path, "- id: W1-T1\n  title: first task\n");
    repo.git("add", ".");
    repo.git("commit", "-m", "file first task");
    const filedAt = Number(repo.git("show", "-s", "--format=%ct")) * 1000;
    writeFileSync(path, "- id: W1-T1\n  title: changed title\n");
    repo.git("add", ".");
    repo.git("commit", "-m", "edit title");
    const result = readDispatchFilingSnapshot(path);
    assert.equal(result.kind, "ready");
    assert.equal(result.snapshot.filedAtByTaskId.get("W1-T1"), filedAt);
    assert.equal(result.snapshot.planTreeSha, repo.git("rev-parse", "HEAD:plan"));
  } finally { repo.cleanup(); }
});

test("W1-T4064: sparse age evidence stays positive and invalid numeric evidence is refused", () => {
  const dates = new Map([[old.id, NOW - 100 * DAY]]);
  const context = calibrate([old], history, dates);
  assert.ok(context.costOfDelayByTaskId!.get(old.id)! > 0, "no matched filing histories leaves a pooled prior");
  const snapshot = { planTreeSha: "tree-sha", filedAtByTaskId: dates };
  const build = (rows: Array<Record<string, unknown>>, nowMs = NOW, treeSha = "tree-sha", filedAtByTaskId = dates) =>
    buildDispatchValueContext([old], rows, new Set([old.id]), nowMs, true, "seed", { ...snapshot, planTreeSha: treeSha, filedAtByTaskId });
  assert.deepEqual(build(history, NaN), { kind: "refused", reasons: ["unreadable-snapshot"] });
  assert.deepEqual(build(history, NOW, ""), { kind: "refused", reasons: ["unreadable-snapshot"] });
  assert.deepEqual(build(history, NOW, "tree-sha", new Map([[old.id, NOW + DAY]])), { kind: "refused", reasons: [`${old.id}:missing-filing-date`] });
  const tiny = history.map(row => row.cost_usd === undefined ? row : { ...row, cost_usd: 1e-310 });
  assert.deepEqual(build(tiny), { kind: "refused", reasons: [`${old.id}:unmeasured-score`] });
});

test("W1-T4064: command snapshot is clock-free and unreadable inputs log once per change", () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => logs.push({ step, extra });
  const snapshot = { planTreeSha: "tree-sha", filedAtByTaskId: filed };
  const readFiling = () => ({ kind: "ready" as const, snapshot });
  const corpus = { rows: [...history, { step: "verdict.merged", ts: new Date(NOW).toISOString() }], ok: true, unread: [] as string[] };
  const readLedger = (() => corpus) as unknown as NonNullable<Parameters<typeof dispatchValueContextForSelection>[5]>["readLedger"];
  const select = (state: string, filing = readFiling) => dispatchValueContextForSelection(plan([old, fresh]), () => false, state, log, "/fixture/tasks.yaml", { readLedger, readFiling: filing });
  const a = select("snapshot-ready");
  assert.ok(a?.stridePassByTaskId);
  const original = Date.now;
  Date.now = () => NOW + 999 * DAY;
  try {
    assert.deepEqual([...select("snapshot-ready")!.stridePassByTaskId!], [...a.stridePassByTaskId!]);
  } finally { Date.now = original; }
  const missing = () => ({ kind: "refused" as const, reasons: ["missing-history"] });
  const fallback = dispatchValueContextForSelection(plan([old, fresh]), () => false, "snapshot-fallback", log, "/fixture/tasks.yaml", { readLedger, readFiling: missing });
  assert.ok(fallback?.costOfDelayFallback);
  assert.deepEqual(dispatchOrder([fresh, old], fallback).map(t => t.id), [old.id, fresh.id]);
  dispatchValueContextForSelection(plan([old, fresh]), () => false, "snapshot-fallback", log, "/fixture/tasks.yaml", { readLedger, readFiling: missing });
  const fallbacks = logs.filter(row => row.step === "dispatch.cost_of_delay.fallback");
  assert.equal(fallbacks.length, 1);
  assert.deepEqual(fallbacks[0].extra?.reasons, ["missing-history"]);
  corpus.rows.push({ step: fallbacks[0].step, ...fallbacks[0].extra, ts: new Date(NOW).toISOString() });
  dispatchValueContextForSelection(plan([old, fresh]), () => false, "snapshot-restarted", log, "/fixture/tasks.yaml", { readLedger, readFiling: missing });
  assert.equal(logs.filter(row => row.step === "dispatch.cost_of_delay.fallback").length, 1, "the persisted key survives restart");
  corpus.ok = false;
  corpus.unread.push("rotation-a");
  const absent = select("snapshot-unreadable");
  assert.equal(absent, undefined);
  select("snapshot-unreadable");
  assert.equal(logs.filter(row => row.step === "dispatch.cost_of_delay.fallback").length, 2);
  corpus.unread.push("rotation-b");
  select("snapshot-unreadable");
  assert.equal(logs.filter(row => row.step === "dispatch.cost_of_delay.fallback").length, 3);
  corpus.ok = true;
  assert.ok(select("snapshot-unreadable")?.stridePassByTaskId);
  corpus.ok = false;
  select("snapshot-unreadable");
  assert.equal(logs.filter(row => row.step === "dispatch.cost_of_delay.fallback").length, 4, "a new failure after recovery is a new transition");
});
