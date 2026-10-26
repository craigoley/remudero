import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import type { Escalation } from "#src/lib/escalate.js";
import { foldGardenEffects, gardenEffectsPath, gardenStatePath, initialGardenState, readGardenEffects, runGardenAsync, type GardenerDeps } from "#src/lib/gardener.js";
import type { IncidentLifecycleRecord } from "#src/lib/incident-lifecycle.js";
import type { MainCommit } from "#src/lib/hot-file-gardener.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import { parseTasksFromYaml, type Task } from "#src/lib/plan.js";
import {
  buildQueueJudgeSources, classRecords, QUEUE_JUDGE_CLASSES, queueJudgeGardenSpec, queueJudgeInventory, QueueJudgeUnavailableError, rankingPath, type QueueJudgeSources,
} from "#src/lib/queue-judge-gardener.js";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
type Row = Record<string, unknown>;

interface ShardFields { priority?: string; depends?: string[]; files?: string[]; rationale?: string; origin?: string; attempts?: number; marker?: string }
function shardText(id: string, f: ShardFields = {}): string {
  return [
    `- id: ${id}`, `  title: "task ${id}"`, "  repo: remudero", `  depends_on: [${(f.depends ?? []).join(", ")}]`, "  type: implement", "  verify: auto", "  risk: low",
    "  files:", ...(f.files ?? [`src/${id}.ts`]).map((p) => `    - ${p}`),
    ...(f.rationale ? ["  rationale: |", `    ${f.rationale}`] : []),
    ...(f.origin ? [`  origin: "${f.origin}"`] : []),
    ...(f.priority === undefined ? [] : [`  priority: ${f.priority}`]),
    "  status: queued", ...(f.marker ? [`  ${f.marker}`] : []), `  attempts: ${f.attempts ?? 0}`, "",
  ].join("\n");
}

interface WorldOpts {
  tasks: Array<[string, ShardFields]>;
  rows?: Row[];
  incidents?: IncidentLifecycleRecord[];
  openPrs?: number[];
  filed?: Record<string, number>;
  history?: MainCommit[];
  /** Resolved tasks have a shard on main but are no longer open. */
  resolved?: string[];
  answers?: string[];
}

function world(t: { after: (fn: () => void) => void }, opts: WorldOpts) {
  const root = mkdtempSync(join(tmpdir(), "rmd-queue-judge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const shards = new Map<string, string>();
  const tasks: Task[] = [];
  for (const [id, f] of opts.tasks) {
    const rel = `plan/tasks.d/${id}.yaml`;
    shards.set(id, rel);
    writeFileSync(join(root, rel), shardText(id, f));
    tasks.push(...parseTasksFromYaml(shardText(id, f), rel));
  }
  const open = tasks.filter((x) => !(opts.resolved ?? []).includes(x.id));
  const plan: PlanInventory = { open, all: tasks, shards };
  const state = { now: NOW };
  const clock: Clock = { now: () => state.now, date: () => new Date(state.now), iso: () => iso(state.now) };
  const rows: Row[] = [...(opts.rows ?? [])];
  const logs: Array<{ step: string; extra: Row }> = [];
  const escalations: Escalation[] = [];
  const calls = { judge: 0, ledger: 0, workspace: 0, churn: 0 };
  const prompts: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const churn = { changed: 0 };
  const stateDir = join(root, "state");
  const sources: Partial<QueueJudgeSources> = {
    clock,
    plan: () => plan,
    readShard: (rel) => readFileSync(join(root, rel), "utf8"),
    ledger: (steps) => { calls.ledger++; return rows.filter((r) => steps.includes(String(r.step))); },
    incidents: () => opts.incidents ?? [],
    openPrNumbers: () => new Set(opts.openPrs ?? []),
    filingDates: () => new Map(Object.entries(opts.filed ?? {})),
    history: () => opts.history ?? [],
    churn: () => { calls.churn++; return churn.changed; },
    credited: () => 0,
    judgeText: async (prompt) => { calls.judge++; prompts.push(prompt); return answers.shift() ?? '{"moves":[]}'; },
  };
  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const deps: GardenerDeps = {
    stateDir, repoRoot: root, clock, seed: 1,
    log: (step, extra = {}) => { logs.push({ step, extra }); rows.push({ task_id: "DAEMON", ...extra, step, ts: iso(state.now) }); },
    escalate: (e) => { escalations.push(e); return `https://example.test/issues/${escalations.length}`; },
    openWorkspace: () => { calls.workspace++; return { root, land: (p) => { landed.push(p); return "https://example.test/pull/900"; }, dispose: () => {} }; },
  };
  const full = buildQueueJudgeSources(deps, sources);
  return { root, stateDir, plan, shards, sources, full, deps, rows, logs, escalations, calls, prompts, answers, churn, landed, state, read: (id: string) => readFileSync(join(root, shards.get(id)!), "utf8") };
}

const move = (id: string, priority: number, evidence: string[], extra: Partial<{ reason: string; cost: number; unblocks: string[]; incidents: string[]; prs: number[]; within: number }> = {}) => ({
  id, priority, reason: extra.reason ?? `waiting on ${id} costs the queue`, evidence, expected_cost_of_delay: extra.cost ?? 1,
  expected_outcome: { unblocks_tasks: extra.unblocks ?? [], ends_incidents: extra.incidents ?? [], unsticks_prs: extra.prs ?? [], starts_within: extra.within ?? 2 },
});
const answer = (...moves: Array<ReturnType<typeof move>>): string => JSON.stringify({ moves });
const startRow = (task: string, ms: number, run = `run-${task}-${ms}`): Row => ({ step: "run.start", task_id: task, run_id: run, ts: iso(ms) });

test("W1-T9925: an operator-pinned priority is never lowered and a judged lowering escalates instead", async (t) => {
  // T1 is pinned at 1 and T5 at 2; T3 is plain and has a dependent, so the judge may move it.
  const w = world(t, {
    tasks: [
      ["W1-T1", { priority: "1  # operator-2026-10-15: protective memory fix" }],
      ["W1-T5", { priority: "2  # operator-2026-10-20: protective", origin: "operator session" }],
      ["W1-T3", { priority: "2" }],
      ["W1-T4", { priority: "2", depends: ["W1-T3"] }],
    ],
    answers: [answer(
      move("W1-T1", 3, ["origin"], { reason: "older and quiet" }),
      move("W1-T5", 1, ["origin"], { reason: "protective intent ends a restart loop", cost: 9 }),
      move("W1-T3", 1, ["dependents"], { unblocks: ["W1-T4"], cost: 5 }),
    )],
  });
  const before = w.read("W1-T1");
  const spec = queueJudgeGardenSpec(w.deps, w.sources);
  const result = await runGardenAsync(spec, w.deps);
  // The pin is unchanged and the lowering became ONE escalation carrying the judge's reason and evidence.
  assert.equal(w.read("W1-T1"), before);
  assert.equal(w.escalations.length, 1);
  assert.equal(w.escalations[0]!.taskId, "W1-T1");
  assert.match(w.escalations[0]!.detail, /older and quiet/);
  assert.match(w.escalations[0]!.detail, /origin/);
  assert.deepEqual(w.escalations[0]!.options.map((o) => o.label), ["confirm", "keep"]);
  assert.ok(!result.plan?.actions.some((a) => a.target === "W1-T1"));
  // A pin may be RAISED (a smaller number) like any task, and its operator reason stays beside the judge's.
  assert.match(w.read("W1-T5"), /^ {2}priority: 1 {2}# operator-2026-10-20: protective \| queue-judge-2026-10-26: protective intent ends a restart loop$/m);
  assert.match(w.read("W1-T3"), /^ {2}priority: 1 {2}# queue-judge-2026-10-26: /m);
  // The judge never sits more urgent than the operator's smallest pin: a value below it is also an escalation.
  const filed = { "W1-T3": NOW - 10 * HOUR };
  const lowWorld = world(t, { tasks: [["W1-T1", { priority: "1  # operator-2026-10-15: protective" }], ["W1-T3", { priority: "2" }]], filed, rows: [startRow("W1-T9", NOW - HOUR)], answers: [answer(move("W1-T3", 0.5, ["age"]))] });
  const inv = await queueJudgeInventory(lowWorld.full, lowWorld.deps);
  assert.equal(inv.moves.length, 0);
  assert.deepEqual(lowWorld.escalations.map((e) => e.taskId), ["W1-T3"]);
  assert.match(lowWorld.read("W1-T3"), /priority: 2$/m);
});

test("W1-T9925: a pass over an empty queue is a no-op", async (t) => {
  const w = world(t, { tasks: [["W1-T1", { priority: "1" }]], resolved: ["W1-T1"] });
  const before = w.read("W1-T1");
  const spec = queueJudgeGardenSpec(w.deps, { ...w.sources, ledger: () => { throw new Error("an empty queue reads no ledger row"); } });
  const result = await runGardenAsync(spec, w.deps);
  assert.equal(result.prUrl, undefined);
  assert.equal(w.calls.judge, 0, "the judge is not asked");
  assert.equal(w.calls.workspace, 0, "no checkout is opened, so no PR can open");
  assert.equal(w.read("W1-T1"), before, "no shard is written");
  assert.equal(existsSync(rankingPath(w.stateDir)), false, "no ranking is recorded for a queue that has none");
  assert.equal(existsSync(gardenEffectsPath(w.stateDir, "queue-judge")), false);
  assert.ok(!w.logs.some((l) => l.step.startsWith("queue_judge.")), "an idle pass ledgers no judge row");
});

test("W1-T9925: a re-rank writes the priority with a one-line reason and the evidence it read", async (t) => {
  const w = world(t, {
    tasks: [
      ["W1-T1", { priority: "2", marker: "# backlog gardener: band=2 evidence=0123456789abcdef" }],
      ["W1-T2", { priority: "1" }],
      ["W1-T6", { priority: "2", depends: ["W1-T1"] }],
    ],
    answers: [answer(move("W1-T1", 1, ["dependents"], { reason: "Unblocks the cheap-restart\nchain: 42% of lane minutes", unblocks: ["W1-T6"], cost: 7 }))],
  });
  const spec = queueJudgeGardenSpec(w.deps, w.sources);
  const result = await runGardenAsync(spec, w.deps);
  assert.equal(result.prUrl, "https://example.test/pull/900");
  const text = w.read("W1-T1");
  // The one-line reason rides the priority line; the marker names the evidence hash; the backlog marker is gone.
  assert.match(text, /^ {2}priority: 1 {2}# queue-judge-2026-10-26: Unblocks the cheap-restart chain: 42% of lane minutes$/m);
  const marker = /^ {2}# queue judge: priority=1 evidence=([a-f0-9]{16})$/m.exec(text);
  assert.ok(marker, "the marker sits beneath status: queued");
  assert.doesNotMatch(text, /backlog gardener/);
  assert.equal(parseTasksFromYaml(text, "w1-t1")[0]!.priority, 1);
  assert.equal(w.read("W1-T2"), shardText("W1-T2", { priority: "1" }), "an unmoved task is untouched");
  // The PR names the move, its evidence and one grep proof per moved shard on its marker.
  const pr = w.landed[0]!;
  assert.match(pr.title, /^chore\(plan\): queue judge re-ranks 1 task\(s\) by measured cost of delay$/);
  assert.ok(pr.title.length <= 100);
  assert.match(pr.body, /\*\*W1-T1\*\*: priority 2 -> 1 \(raise\)/);
  assert.match(pr.body, /Evidence: dependents/);
  assert.match(pr.body, new RegExp(`proof: grep: # queue judge: priority=1 evidence=${marker![1]} in plan/tasks.d/W1-T1\\.yaml`));
  // The prediction row is ledgered with the PR that carries it.
  const prediction = w.logs.find((l) => l.step === "queue_judge.prediction")!.extra;
  assert.equal(prediction.task_id, "W1-T1");
  assert.equal(prediction.from, 2);
  assert.equal(prediction.to, 1);
  assert.equal(prediction.pr_url, "https://example.test/pull/900");
  assert.equal(prediction.evidence_signature, marker![1]);
  assert.deepEqual(prediction.evidence, ["dependents"]);
  assert.equal(prediction.expected_cost_of_delay, 7);
  assert.deepEqual((prediction.expected_outcome as { unblocks_tasks: string[] }).unblocks_tasks, ["W1-T6"]);
  assert.equal(w.logs.filter((l) => l.step === "queue_judge.prediction").length, 1);
});

test("W1-T9925: the evidence pack names dependents, incidents, stuck-PR citations, age, attempts and operator origin", async (t) => {
  const incident = (fingerprint: string, status: IncidentLifecycleRecord["status"]): IncidentLifecycleRecord => ({
    fingerprint, title: `incident ${fingerprint}`, source: "ledger" as IncidentLifecycleRecord["source"], kind: "ledger" as IncidentLifecycleRecord["kind"], status,
    firstSeenMs: NOW - 5 * HOUR, lastSeenMs: NOW - HOUR, count24h: 4, feedbackId: null, pr: null,
  });
  const w = world(t, {
    tasks: [
      ["W1-T1", { priority: "1", rationale: "fixes fp-open and fp-done", origin: "operator session 2026-10-16", attempts: 2 }],
      ["W1-T2", { priority: "1", depends: ["W1-T1"] }],
      ["W1-T3", { priority: "1", depends: ["W1-T2"] }],
    ],
    incidents: [incident("fp-open", "filed"), incident("fp-done", "verified")],
    openPrs: [77],
    filed: { "W1-T1": NOW - 12 * HOUR, "W1-T9": NOW - 20 * HOUR },
    rows: [
      startRow("W1-T9", NOW - 10 * HOUR), startRow("W1-T1", NOW - 3 * HOUR, "run-a"), startRow("W1-T1", NOW - 2 * HOUR, "run-b"),
      { step: "verdict", task_id: "W1-T1", run_id: "run-a", verdict: "no_pr", ts: iso(NOW - 2.5 * HOUR) },
      { step: "escalation.issue_opened", task_id: "W1-T1", issue_url: "https://example.test/issues/55", ts: iso(NOW - HOUR) },
      { step: "sweep.disposed", pr_number: 77, disposition: "blocked-fixable", reason: "red; W1-T1 owns the step", task_id: "W1-T1", ts: iso(NOW - HOUR) },
      { step: "sweep.disposed", pr_number: 78, disposition: "blocked-fixable", reason: "W1-T1", task_id: "W1-T1", ts: iso(NOW - HOUR) },
    ],
    answers: [answer()],
  });
  await queueJudgeInventory(w.full, w.deps);
  const line = w.prompts[0]!.split("\n").map((l) => (l.startsWith("{\"id\":\"W1-T1\"") ? l : "")).find(Boolean)!;
  const pack = JSON.parse(line) as { id: string; pinned: boolean; facts: Array<{ ref: string; text: string; source: string }> };
  const fact = (ref: string) => pack.facts.find((f) => f.ref === ref)!;
  assert.match(fact("dependents").text, /2 open dependent\(s\): W1-T2, W1-T3/);
  assert.match(fact("incident:fp-open").text, /open incident \(filed, 4 in 24h\)/);
  assert.equal(pack.facts.some((f) => f.ref === "incident:fp-done"), false, "a verified incident is not open");
  assert.equal(fact("escalation:https://example.test/issues/55").source.startsWith("ledger escalation.issue_opened"), true);
  assert.match(fact("prs").text, /1 open PR\(s\) cite it: #77; stuck disposition cites it: #77/);
  assert.doesNotMatch(fact("prs").text, /#78/, "a PR that is no longer open is not a blocker");
  assert.match(fact("age").text, /median waits/);
  assert.match(fact("attempts").text, /2 run\.start row\(s\), 0 non-worker refusal\(s\), shard attempts=2, last verdict=no_pr/);
  assert.match(fact("origin").text, /operator session/);
  // Every fact names its source, and the prompt carries the operator's rule verbatim and the judge's own record.
  assert.ok(pack.facts.every((f) => f.source.length > 0));
  assert.match(w.prompts[0]!, /cost of delay = what waiting costs \(dependents and capacity unblocked, incidents and red PRs it ends, protective intent\), never the task's age alone/);
  assert.match(w.prompts[0]!, /YOUR OWN RECORD/);
  // Reads are bounded to named steps: no call asked for an unfiltered union.
  assert.ok(w.calls.ledger >= 2);
});

test("W1-T9925: a malformed or unsupported judge answer writes nothing and is asked again", async (t) => {
  const w = world(t, {
    tasks: [["W1-T1", { priority: "2" }], ["W1-T2", { priority: "2", depends: ["W1-T1"] }]],
    answers: ["this is not json", answer(move("W1-T1", 1, ["incident:not-in-the-pack"])), answer(move("W1-T9", 1, ["age"])), answer(move("W1-T1", 1, ["dependents"], { unblocks: ["W1-T2"] }))],
  });
  const before = w.read("W1-T1");
  const spec = queueJudgeGardenSpec(w.deps, w.sources);
  // 1. Malformed: the run fails, no checkout opens, no shard or ranking is written, and the reason is ledgered.
  await assert.rejects(() => runGardenAsync(spec, w.deps), QueueJudgeUnavailableError);
  assert.equal(w.calls.workspace, 0);
  assert.equal(w.read("W1-T1"), before);
  assert.equal(existsSync(rankingPath(w.stateDir)), false);
  assert.match(String(w.logs.find((l) => l.step === "queue_judge.unavailable")!.extra.reason), /strict JSON/);
  // 2. Unsupported: evidence missing from the pack refuses the row, and a pass whose every row is refused is asked again.
  await assert.rejects(() => queueJudgeInventory(w.full, w.deps), /every proposed row was refused/);
  assert.match(String(w.logs.find((l) => l.step === "queue_judge.row_refused")!.extra.reason), /evidence missing from the pack: incident:not-in-the-pack/);
  // 3. An unknown id is refused row by row.
  await assert.rejects(() => queueJudgeInventory(w.full, w.deps), /every proposed row was refused/);
  assert.ok(w.logs.some((l) => l.step === "queue_judge.row_refused" && /unknown id/.test(String(l.extra.reason))));
  assert.equal(existsSync(rankingPath(w.stateDir)), false, "nothing was ranked, so nothing is due later");
  // 4. The judge is asked again and a supported answer stands.
  const inv = await queueJudgeInventory(w.full, w.deps);
  assert.equal(w.calls.judge, 4);
  assert.deepEqual(inv.moves.map((m) => m.target), ["W1-T1"]);
  assert.equal(w.read("W1-T1"), before, "the inventory itself writes no shard");
  // A failed spawn is the same: unavailable, ledgered, asked again.
  const failing = world(t, { tasks: [["W1-T1", { priority: "2" }]] });
  const sources = buildQueueJudgeSources(failing.deps, { ...failing.sources, judgeText: async () => { throw new Error("spawn exploded"); } });
  await assert.rejects(() => queueJudgeInventory(sources, failing.deps), QueueJudgeUnavailableError);
  assert.match(String(failing.logs.find((l) => l.step === "queue_judge.unavailable")!.extra.reason), /spawn exploded/);
});

test("W1-T9925: cadence follows measured churn and each diff is bounded by measured review cost", async (t) => {
  const prUrl = "https://example.test/pull/50";
  const openMs = NOW - 3 * HOUR;
  const tasks: Array<[string, ShardFields]> = [1, 2, 3, 4].map((n) => [`W1-T${n}`, { priority: "2", depends: [] }]);
  tasks.push(["W1-T5", { priority: "2", depends: ["W1-T1", "W1-T2", "W1-T3", "W1-T4"] }]);
  const w = world(t, {
    tasks,
    filed: {},
    // 6 distinct tasks started over 3 h: 2 starts an hour. The judge's own PR #50 opened 3 h ago and merged 1 h ago (2 h open
    // to merge, so 4 starts are predicted before the next pass) and took 60 minutes to its first PASS for one shard (60 min a shard).
    rows: [
      ...[0, 1, 2, 3, 4, 5].map((n) => startRow(`W1-T${100 + n}`, NOW - 3 * HOUR + n * 1000)),
      { step: "queue_judge.prediction", task_id: "W1-T90", class: "raise", to: 1, pr_url: prUrl, ts: iso(openMs) },
      { step: "queue_judge.outcome", task_id: "W1-T90", prediction_ts: iso(openMs), class: "raise", verdict: "hit", ts: iso(NOW - HOUR) },
      { step: "review.posted", pr_url: prUrl, state: "success", ts: iso(openMs + HOUR) },
    ],
    history: [{ sha: "c".repeat(40), at: iso(NOW - HOUR), subject: "chore(plan): queue judge re-ranks 1 task(s) (#50)", files: [] }],
    answers: [answer(
      move("W1-T1", 1, ["dependents"], { cost: 1, unblocks: ["W1-T5"] }), move("W1-T2", 1, ["dependents"], { cost: 8, unblocks: ["W1-T5"] }),
      move("W1-T3", 1, ["dependents"], { cost: 4, unblocks: ["W1-T5"] }), move("W1-T4", 1, ["dependents"], { cost: 6, unblocks: ["W1-T5"] }),
    )],
  });
  const spec = queueJudgeGardenSpec(w.deps, w.sources);
  // No ranking yet: a first pass is due at once.
  assert.equal(spec.cheapFingerprint(), "first");
  const inv = await spec.inventoryAsync!();
  // Size: 120 min open-to-merge / 60 min a shard = 2 shards fit, though the record would allow 3 and the judge proposed 4.
  assert.equal(inv.bound!.reviewCostSource, "own");
  assert.equal(inv.bound!.reviewMinutesPerShard, 60);
  assert.equal(inv.bound!.windowMinutes, 120);
  assert.equal(inv.bound!.fit, 2);
  assert.deepEqual(inv.records.map((r) => [r.class, r.allowance]), [["raise", 3], ["lower", 3]]);
  assert.deepEqual(inv.moves.map((m) => m.target), ["W1-T2", "W1-T4"], "the largest predicted changes are kept");
  assert.deepEqual(inv.deferred.map((m) => m.target), ["W1-T3", "W1-T1"], "every other move is named as deferred");
  const card = spec.scorecard(inv, { actions: inv.moves, acting: ["raise"] }) as { deferred: Array<{ task_id: string }>; bound: { fit: number } };
  assert.deepEqual(card.deferred.map((d) => d.task_id), ["W1-T3", "W1-T1"]);
  assert.equal(card.bound.fit, 2);
  assert.ok(w.logs.some((l) => l.step === "queue_judge.scorecard"));
  // Cadence: due once the queue has turned over the 4 starts its last pass predicted (2 an hour x 2 h), and not before.
  w.churn.changed = 3;
  assert.match(spec.cheapFingerprint(), /^quiet:/);
  const judged = w.calls.judge;
  assert.equal((await queueJudgeInventory(w.full, w.deps)).skipped, "not-due");
  assert.equal(w.calls.judge, judged, "a quiet queue is not re-judged");
  w.churn.changed = 4;
  assert.match(spec.cheapFingerprint(), /^due:/);
  // Until it has a merged PR of its own, the backlog gardener's merged plan PRs are the review-cost prior, and the row says so.
  const prior = world(t, {
    tasks: [["W1-T1", { priority: "2" }]],
    rows: [
      { step: "backlog.scorecard", pr_url: "https://example.test/pull/60", actions: 2, ts: iso(NOW - 4 * HOUR) },
      { step: "review.posted", pr_url: "https://example.test/pull/60", state: "success", ts: iso(NOW - 4 * HOUR + 30 * 60_000) },
    ],
    history: [{ sha: "d".repeat(40), at: iso(NOW - 3 * HOUR), subject: "chore(plan): backlog (#60)", files: [] }],
  });
  const priorInv = await queueJudgeInventory(prior.full, prior.deps);
  assert.equal(priorInv.bound!.reviewCostSource, "backlog-prior");
  assert.equal(priorInv.bound!.reviewMinutesPerShard, 15);
});

test("W1-T9925: predictions are scored against outcomes and the record sets the allowance", async (t) => {
  const predAt = NOW - 6 * HOUR;
  const prediction = (task: string, cls: "raise" | "lower", extra: Row = {}): Row => ({
    step: "queue_judge.prediction", task_id: task, class: cls, from: 2, to: 1, starts_within_hours: 2, churn_threshold: 1,
    expected_outcome: { unblocks_tasks: [], ends_incidents: [], unsticks_prs: [], starts_within: 2 }, pr_url: "https://example.test/pull/10", ts: iso(predAt), ...extra,
  });
  const w = world(t, {
    // T10 started in its window and its dependent T20 followed: a hit. T11 never started: a miss. T12 is held by a file overlap
    // with the in-flight T13: not ranking. T14 was lowered and nothing cited it: a hit. T15 was lowered and an escalation cited it: a miss.
    tasks: [
      ["W1-T10", { priority: "1" }], ["W1-T11", { priority: "1" }], ["W1-T12", { priority: "1", files: ["src/shared.ts"] }],
      ["W1-T13", { priority: "1", files: ["src/shared.ts"] }], ["W1-T14", { priority: "3" }], ["W1-T15", { priority: "3" }], ["W1-T20", { priority: "2" }],
    ],
    resolved: ["W1-T10", "W1-T11", "W1-T14", "W1-T15"],
    rows: [
      prediction("W1-T10", "raise", { expected_outcome: { unblocks_tasks: ["W1-T20"], ends_incidents: [], unsticks_prs: [], starts_within: 2 } }),
      prediction("W1-T11", "raise"), prediction("W1-T12", "raise"), prediction("W1-T14", "lower"), prediction("W1-T15", "lower"),
      startRow("W1-T10", predAt + HOUR), startRow("W1-T20", predAt + 2 * HOUR), startRow("W1-T13", NOW - 10 * 60_000, "run-13"),
      { step: "escalation.issue_opened", task_id: "W1-T15", issue_url: "https://example.test/issues/9", ts: iso(predAt + HOUR) },
    ],
    filed: { "W1-T20": NOW - 5 * HOUR },
    answers: [answer()],
  });
  w.churn.changed = 50;
  // Before any scoring the class has its prior record and the allowance the fleet's prior gives it.
  assert.deepEqual(classRecords(w.stateDir, []).map((r) => [r.class, r.allowance, r.shadow]), [["raise", 3, false], ["lower", 3, false]]);
  const first = await queueJudgeInventory(w.full, w.deps);
  const verdicts = Object.fromEntries(first.scored.map((o) => [o.task_id, o.verdict]));
  assert.deepEqual(verdicts, { "W1-T10": "hit", "W1-T11": "miss", "W1-T12": "not_ranking", "W1-T14": "hit", "W1-T15": "miss" });
  assert.equal(first.scored.find((o) => o.task_id === "W1-T12")!.holder, "file-overlap:W1-T13", "a held task names its holder");
  assert.deepEqual(w.logs.filter((l) => l.step === "queue_judge.outcome").map((l) => l.extra.task_id).sort(), ["W1-T10", "W1-T11", "W1-T12", "W1-T14", "W1-T15"]);
  // Hits credit and misses debit through the effects file the framework folds; not_ranking is neither.
  const effects = readGardenEffects(gardenEffectsPath(w.stateDir, "queue-judge"));
  assert.deepEqual(effects.map((e) => `${e.actionClass}:${e.verdict}`).sort(), ["lower:credit", "lower:debit", "raise:credit", "raise:debit"]);
  const folded = foldGardenEffects(initialGardenState(QUEUE_JUDGE_CLASSES), effects).state;
  assert.deepEqual(folded.classes, { raise: { alpha: 4, beta: 2 }, lower: { alpha: 4, beta: 2 } });
  // The record moves the allowance: authority shrinks with misses and the class falls into shadow at or below the prior mean.
  writeFileSync(gardenStatePath(w.stateDir, "queue-judge"), JSON.stringify(folded));
  const outcomes = w.rows.filter((r) => r.step === "queue_judge.outcome").map((r, i) => ({ ...r, ts: iso(NOW + i) }));
  const records = classRecords(w.stateDir, outcomes);
  const raise = records.find((r) => r.class === "raise")!;
  assert.deepEqual([raise.hits, raise.misses, raise.notRanking], [1, 1, 1]);
  assert.ok(raise.allowance < 3, "the allowance fell from the prior's 3");
  assert.equal(raise.shadow, true);
  // A shadow class still asks the judge and ledgers its predictions, but its moves open no PR and write nothing.
  w.state.now = NOW + HOUR;
  w.answers.splice(0, w.answers.length, answer(
    move("W1-T20", 1, ["age"], { cost: 3 }), move("W1-T12", 0.5, ["held:file-overlap:W1-T13"], { cost: 2 }), move("W1-T13", 3, ["attempts"], { cost: 1 }),
  ));
  const second = await queueJudgeInventory(w.full, w.deps);
  assert.deepEqual(second.shadowed.map((m) => m.class).sort(), ["lower", "raise", "raise"]);
  assert.equal(second.moves.length, 0, "a class at or below the fleet's prior opens no PR");
  const shadowRows = w.logs.filter((l) => l.step === "queue_judge.prediction" && l.extra.shadow === true);
  assert.equal(shadowRows.length, 3);
  assert.ok(shadowRows.every((l) => l.extra.pr_url === null));
  assert.equal(w.calls.workspace, 0);
});
