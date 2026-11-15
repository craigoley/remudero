/**
 * W1-T12028 — a judge answer wrapped in prose, or with one bad row, is still read.
 *
 * OBSERVED 2026-11-06 to 11-10 on the core daemon: 12 queue-judge passes failed on "malformed judge answer"
 * beside 14 predictions. The reader took the whole answer or nothing: text before the JSON, or one row with
 * one wrong field, voided every move, and the ledger row said only that the shape was wrong.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import { parseTasksFromYaml, type Task } from "#src/lib/plan.js";
import { buildQueueJudgeSources, queueJudgeInventory, QueueJudgeUnavailableError, readQueueJudgeAnswer } from "#src/lib/queue-judge-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const move = (id: string, priority: number, extra: Record<string, unknown> = {}) => ({
  id, priority, reason: `waiting on ${id} costs the queue`, evidence: ["dependents"], expected_cost_of_delay: 1,
  expected_outcome: { unblocks_tasks: ["W1-T2"], ends_incidents: [], unsticks_prs: [], starts_within: 2 }, ...extra,
});
const shard = (id: string, depends: string[]): string =>
  [`- id: ${id}`, `  title: "task ${id}"`, "  repo: remudero", `  depends_on: [${depends.join(", ")}]`, "  priority: 2", "  type: implement", "  verify: auto",
    "  risk: low", "  status: queued", "  attempts: 0", "  acceptance:", '    - claim: "it works"', '      proof: "test: it works"', ""].join("\n");

/** A two-task queue (W1-T2 waits on W1-T1) whose judge returns `answer`. */
function world(t: { after: (fn: () => void) => void }, answer: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}queue-judge-answer-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const shards = new Map<string, string>();
  const tasks: Task[] = [];
  for (const [id, depends] of [["W1-T1", []], ["W1-T2", ["W1-T1"]]] as Array<[string, string[]]>) {
    const rel = `plan/tasks.d/${id}.yaml`;
    shards.set(id, rel);
    writeFileSync(join(root, rel), shard(id, depends));
    tasks.push(...parseTasksFromYaml(shard(id, depends), rel));
  }
  const plan: PlanInventory = { open: tasks, all: tasks, shards };
  const clock: Clock = { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const deps: GardenerDeps = {
    stateDir: join(root, "state"), repoRoot: root, clock, seed: 1,
    log: (step, extra = {}) => { logs.push({ step, extra }); },
    escalate: () => "https://example.test/issues/1",
    openWorkspace: () => ({ root, land: () => "https://example.test/pull/900", dispose: () => {} }),
  };
  const sources = buildQueueJudgeSources(deps, {
    clock, plan: () => plan, readShard: (rel) => readFileSync(join(root, rel), "utf8"), ledger: () => [], incidents: () => [],
    openPrNumbers: () => new Set<number>(), filingDates: () => new Map<string, number>(), history: () => [], churn: () => 0, credited: () => 0,
    judgeText: async () => answer,
  });
  return { deps, sources, logs };
}

test("W1-T12028 criterion 1: an answer with prose or a fence around its JSON is read as the moves it holds", async (t) => {
  const json = JSON.stringify({ moves: [move("W1-T1", 1)] });
  for (const text of [json, `Here is my ranking.\n\n${json}\n\nThat is all.`, `Ranking follows:\n\`\`\`json\n${json}\n\`\`\`\nDone.`, `I rank one task: ${JSON.stringify([move("W1-T1", 1)])}`]) {
    const reading = readQueueJudgeAnswer(text);
    assert.equal(reading.shape, undefined, text.slice(0, 30));
    assert.deepEqual(reading.moves.map((m) => [m.id, m.priority]), [["W1-T1", 1]]);
  }
  const w = world(t, `Here is my ranking.\n\n${json}\n`);
  const inv = await queueJudgeInventory(w.sources, w.deps);
  assert.deepEqual(inv.moves.map((m) => m.target), ["W1-T1"], "the wrapped answer's move reaches the inventory");
  assert.equal(w.logs.some((l) => l.step === "queue_judge.unavailable"), false);
});

test("W1-T12028 criterion 2: a row that is not a move is refused alone and names its field; the other rows stand", async (t) => {
  const bad = move("W1-T2", 1, { expected_cost_of_delay: "high" });
  const reading = readQueueJudgeAnswer(JSON.stringify({ moves: [move("W1-T1", 1), bad, "not a row"] }));
  assert.deepEqual(reading.moves.map((m) => m.id), ["W1-T1"]);
  assert.deepEqual(reading.malformedRows, [{ index: 1, id: "W1-T2", field: "expected_cost_of_delay" }, { index: 2, id: undefined, field: "row" }]);
  const w = world(t, JSON.stringify({ moves: [move("W1-T1", 1), bad] }));
  const inv = await queueJudgeInventory(w.sources, w.deps);
  assert.deepEqual(inv.moves.map((m) => m.target), ["W1-T1"]);
  const refused = w.logs.filter((l) => l.step === "queue_judge.row_refused");
  assert.deepEqual(refused.map((l) => [l.extra.task_id, l.extra.reason]), [["W1-T2", "malformed row 1: expected_cost_of_delay"]]);
  // An answer whose every row is malformed is still asked again, as an answer whose every row was refused is.
  const none = world(t, JSON.stringify({ moves: [bad] }));
  await assert.rejects(() => queueJudgeInventory(none.sources, none.deps), /every proposed row was refused/);
  assert.match(String(none.logs.find((l) => l.step === "queue_judge.unavailable")!.extra.reason), /W1-T2: malformed row 0: expected_cost_of_delay/);
});

test("W1-T12028 criterion 3: an unreadable answer is ledgered with its shape and length, never its text", async (t) => {
  for (const [text, shape] of [["I could not rank the queue today.", "not-json"], ['{"ranking":[]}', "no-moves-list"]] as const) {
    assert.equal(readQueueJudgeAnswer(text).shape, shape);
    const w = world(t, text);
    await assert.rejects(() => queueJudgeInventory(w.sources, w.deps), QueueJudgeUnavailableError);
    const row = w.logs.find((l) => l.step === "queue_judge.unavailable")!.extra;
    assert.equal(row.shape, shape);
    assert.equal(row.answer_chars, text.length);
    assert.match(String(row.reason), /strict JSON/);
    assert.equal(JSON.stringify(row).includes(text), false, "the answer's text is not ledgered");
  }
});
