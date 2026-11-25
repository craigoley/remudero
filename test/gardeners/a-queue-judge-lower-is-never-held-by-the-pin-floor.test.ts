import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import { parseTasksFromYaml, type Task } from "#src/lib/plan.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import {
  admittedFloorEscalations, buildQueueJudgeSources, checkMoves, queueJudgeInventory, type EvidencePack, type JudgeMove, type QueueJudgeSources,
} from "#src/lib/queue-judge-gardener.js";

// W1-T14651 INVARIANT only-more-urgent-crosses-the-floor: a proposal whose target priority is greater than or equal to the
// task's current priority is never escalated for the smallest-pin floor, and the judge closes its own floor escalations
// that the corrected rule admits.

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
type Row = Record<string, unknown>;

const shardText = (id: string, priority: string): string => [
  `- id: ${id}`, `  title: "task ${id}"`, "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  risk: low",
  "  files:", `    - src/${id}.ts`, `  priority: ${priority}`, "  status: queued", "  attempts: 0", "",
].join("\n");

const move = (id: string, priority: number): JudgeMove => ({
  id, priority, reason: `waiting on ${id} costs the queue`, evidence: ["age"], expected_cost_of_delay: 1,
  expected_outcome: { unblocks_tasks: [], ends_incidents: [], unsticks_prs: [], starts_within: 2 },
});
const startRow = (task: string, ms: number): Row => ({ step: "run.start", task_id: task, run_id: `run-${task}-${ms}`, ts: iso(ms) });
const pack = (id: string, priority: number | null, pinned: boolean): EvidencePack => ({
  id, title: id, priority, pinned, facts: [{ ref: "age", text: "old", source: "history" }], dependents: [], incidents: [], prs: [], heldBy: undefined, signature: "sig",
});
const packs = (...list: EvidencePack[]): ReadonlyMap<string, EvidencePack> => new Map(list.map((p) => [p.id, p]));

function world(t: { after: (fn: () => void) => void }, tasks: Array<[string, string]>, rows: Row[], answer: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-queue-judge-floor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const shards = new Map<string, string>();
  const all: Task[] = [];
  for (const [id, priority] of tasks) {
    const rel = `plan/tasks.d/${id}.yaml`;
    shards.set(id, rel);
    writeFileSync(join(root, rel), shardText(id, priority));
    all.push(...parseTasksFromYaml(shardText(id, priority), rel));
  }
  const plan: PlanInventory = { open: all, all, shards };
  const state = { now: NOW };
  const clock: Clock = { now: () => state.now, date: () => new Date(state.now), iso: () => iso(state.now) };
  const ledger: Row[] = [...rows];
  const logs: Array<{ step: string; extra: Row }> = [];
  const escalations: Array<{ taskId?: string }> = [];
  const churn = { changed: 0 };
  const answers = [answer];
  const sources: Partial<QueueJudgeSources> = {
    clock, plan: () => plan, readShard: (rel) => readFileSync(join(root, rel), "utf8"),
    ledger: (steps) => ledger.filter((r) => steps.includes(String(r.step))),
    incidents: () => [], openPrNumbers: () => new Set(), filingDates: () => new Map([["W1-T3", NOW - 10 * HOUR]]), history: () => [],
    churn: () => churn.changed, credited: () => 0,
    judgeText: async () => answers.shift() ?? '{"moves":[]}',
  };
  const deps: GardenerDeps = {
    stateDir: join(root, "state"), repoRoot: root, clock, seed: 1,
    log: (step, extra = {}) => { logs.push({ step, extra }); ledger.push({ task_id: "DAEMON", ...extra, step, ts: iso(state.now) }); },
    escalate: (e) => { escalations.push(e); return `https://example.test/issues/${escalations.length}`; },
    openWorkspace: () => { throw new Error("no checkout is opened by an inventory"); },
  };
  return { deps, full: buildQueueJudgeSources(deps, sources), logs, escalations, state, churn, answers, read: (id: string) => readFileSync(join(root, shards.get(id)!), "utf8") };
}

const answerFor = (...moves: JudgeMove[]): string => JSON.stringify({ moves });
const PIN = "5  # operator-2026-10-15: protective";

// The proofs for these criteria grep the TITLES below (a code line, not a comment), so each criterion is named in a title.
test("W1-T14651 criterion 1: checkMoves returns an unpinned priority-1 task moved to 2 under a smallest pin of 3 as an accepted lower", () => {
  // 1 -> 2 is below the floor (3) but less urgent than the task now: a lower, never held.
  const lower = checkMoves([move("W1-T3", 2)], packs(pack("W1-T1", 3, true), pack("W1-T3", 1, false)));
  assert.deepEqual(lower.accepted.map((a) => [a.target, a.class]), [["W1-T3", "lower"]]);
  assert.equal(lower.escalate.length, 0);
});

test("W1-T14651 criterion 2: a raise below the floor and a pinned move to a larger number still escalate", () => {
  // 4 -> 2 under a smallest pin of 3 is a raise below the floor: held.
  const raise = checkMoves([move("W1-T7", 2)], packs(pack("W1-T1", 3, true), pack("W1-T7", 4, false)));
  assert.deepEqual(raise.escalate.map((a) => [a.target, a.class]), [["W1-T7", "raise"]]);
  assert.equal(raise.accepted.length, 0);
  // A task with no declared priority is raised by any value, so the floor still holds it.
  const none = checkMoves([move("W1-T8", 2)], packs(pack("W1-T1", 3, true), pack("W1-T8", null, false)));
  assert.deepEqual(none.escalate.map((a) => a.target), ["W1-T8"]);
  // A pinned priority is never moved to a larger number.
  const pinned = checkMoves([move("W1-T1", 4)], packs(pack("W1-T1", 3, true)));
  assert.deepEqual(pinned.escalate.map((a) => a.target), ["W1-T1"]);
});

test("W1-T14651 criterion 4: invariant only-more-urgent-crosses-the-floor, no target at or above the current priority is escalated", () => {
  const floor = 5;
  for (let current = 1; current <= 4; current += 1) {
    for (let target = current; target <= 6; target += 1) {
      const r = checkMoves([move("W1-T3", target)], packs(pack("W1-T1", floor, true), pack("W1-T3", current, false)));
      assert.equal(r.escalate.length, 0, `${current} -> ${target} is not more urgent, so the floor never holds it`);
    }
  }
});

test("W1-T14651: a lowering proposal is judged as a lower and opens no needs-human issue", async (t) => {
  // Through the judge, the lower opens no needs-human issue.
  const w = world(t, [["W1-T1", PIN], ["W1-T3", "2"]], [startRow("W1-T9", NOW - HOUR)], answerFor(move("W1-T3", 4)));
  const inv = await queueJudgeInventory(w.full, w.deps);
  assert.equal(w.escalations.length, 0, "a lower opens no needs-human issue");
  assert.deepEqual(inv.moves.map((m) => [m.target, m.class, m.from, m.to]), [["W1-T3", "lower", 2, 4]]);
});

test("W1-T14651 criterion 3: the judge closes its own open floor escalations that the corrected rule admits", async (t) => {
  // An open floor escalation the corrected rule admits is closed with a reason and one row.
  const url = "https://example.test/issues/77";
  const prior: Row[] = [
    { step: "queue_judge.escalated", task_id: "W1-T3", from: 2, to: 4, evidence_signature: "sig", issue_url: url, ts: iso(NOW - 5 * HOUR) },
    // A raise under the floor stays held, so its issue stays open.
    { step: "queue_judge.escalated", task_id: "W1-T6", from: 3, to: 0.5, evidence_signature: "sig", issue_url: "https://example.test/issues/78", ts: iso(NOW - 5 * HOUR) },
    startRow("W1-T9", NOW - HOUR),
  ];
  const w = world(t, [["W1-T1", PIN], ["W1-T3", "2"], ["W1-T6", "3"]], prior, answerFor());
  const closed: Array<{ url: string; comment: string }> = [];
  const deps: GardenerDeps = { ...w.deps, closeIssue: (u, comment) => { closed.push({ url: u, comment }); } };
  await queueJudgeInventory(w.full, deps);
  assert.deepEqual(closed.map((c) => c.url), [url]);
  assert.match(closed[0]!.comment, /lowers its urgency/);
  assert.equal(w.logs.find((l) => l.step === "queue_judge.escalation_closed")?.extra.issue_url, url);
  // Its own closing is on the record: a later pass does not close it twice.
  w.state.now += 100 * HOUR;
  w.churn.changed = 99;
  w.answers.push('{"moves":[]}');
  await queueJudgeInventory(w.full, deps);
  assert.equal(closed.length, 1);
});

test("W1-T14651: a failed close of a floor escalation is ledgered and the pass goes on", async (t) => {
  const rows: Row[] = [{ step: "queue_judge.escalated", task_id: "W1-T3", from: 2, to: 4, evidence_signature: "sig", issue_url: "https://example.test/issues/9", ts: iso(NOW - HOUR) }];
  const w = world(t, [["W1-T3", "2"]], rows, answerFor());
  const deps: GardenerDeps = { ...w.deps, closeIssue: () => { throw new Error("gh refused"); } };
  const inv = await queueJudgeInventory(w.full, deps);
  assert.equal(inv.asked, true);
  assert.equal(w.logs.some((l) => l.step === "queue_judge.escalation_closed"), false);
  assert.match(String(w.logs.find((l) => l.step === "queue_judge.escalation_close_failed")?.extra.error), /gh refused/);
});

test("W1-T14651 criterion 2: a pinned task's escalated move to a larger number is never closed as admitted", () => {
  // A pinned task moved to a larger number stays escalated.
  const rows: Row[] = [{ step: "queue_judge.escalated", task_id: "W1-T1", from: 1, to: 3, issue_url: "u1" }];
  assert.deepEqual(admittedFloorEscalations(rows, packs(pack("W1-T1", 1, true))), []);
  // The same row on an unpinned task is admitted.
  assert.deepEqual(admittedFloorEscalations(rows, packs(pack("W1-T1", 1, false))).map((r) => r.issue_url), ["u1"]);
});
