import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "#src/lib/clock.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import { parseTasksFromYaml, type Task } from "#src/lib/plan.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import { buildQueueJudgeSources, queueJudgeInventory, type QueueJudgeSources } from "#src/lib/queue-judge-gardener.js";
import { OPENWEIGHT_MAX_COMPLETION_TOKENS } from "#src/lib/worker-provider.js";

// W1-T14652: the packs one pass leaves out go first the next pass, so every queued task is judged within a bounded number
// of passes; INVARIANT a-fitting-queue-is-unchanged: when every pack fits, the prompt is what it was without the carry.

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
type Row = Record<string, unknown>;

const IDS = ["W1-T11", "W1-T12", "W1-T13", "W1-T14", "W1-T15", "W1-T16"];

const shardText = (id: string, priority: number): string => [
  `- id: ${id}`, `  title: "task ${id}"`, "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  risk: low",
  "  files:", `    - src/${id}.ts`, `  priority: ${priority}`, "  status: queued", "  attempts: 0", "",
].join("\n");

function world(t: { after: (fn: () => void) => void }, priorRows: Row[] = []) {
  const root = mkdtempSync(join(tmpdir(), "rmd-queue-judge-rotation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const shards = new Map<string, string>();
  const all: Task[] = [];
  IDS.forEach((id, i) => {
    const rel = `plan/tasks.d/${id}.yaml`;
    shards.set(id, rel);
    writeFileSync(join(root, rel), shardText(id, i + 1));
    all.push(...parseTasksFromYaml(shardText(id, i + 1), rel));
  });
  const plan: PlanInventory = { open: all, all, shards };
  const state = { now: NOW };
  const clock: Clock = { now: () => state.now, date: () => new Date(state.now), iso: () => iso(state.now) };
  const ledger: Row[] = [{ step: "run.start", task_id: "W1-T99", run_id: "run-W1-T99-1", ts: iso(NOW - HOUR) }, ...priorRows];
  const churn = { changed: 0 };
  const prompts: string[] = [];
  const window = { tokens: 1_000_000 };
  const sources: Partial<QueueJudgeSources> = {
    clock, plan: () => plan, readShard: (rel) => readFileSync(join(root, rel), "utf8"),
    ledger: (steps) => ledger.filter((r) => steps.includes(String(r.step))),
    incidents: () => [], openPrNumbers: () => new Set(), filingDates: () => new Map(), history: () => [],
    churn: () => churn.changed, credited: () => 0,
    promptWindow: () => ({ tokens: window.tokens, model: "test-model" }),
    judgeText: async (prompt: string) => { prompts.push(prompt); return '{"moves":[]}'; },
  };
  const deps: GardenerDeps = {
    stateDir: join(root, "state"), repoRoot: root, clock, seed: 1,
    log: (step, extra = {}) => { ledger.push({ task_id: "DAEMON", ...extra, step, ts: iso(state.now) }); },
    escalate: () => "https://example.test/issues/1",
    openWorkspace: () => { throw new Error("no checkout is opened by an inventory"); },
  };
  const full = buildQueueJudgeSources(deps, sources);
  const pass = async (): Promise<string[]> => {
    state.now += 100 * HOUR;
    churn.changed = 99;
    await queueJudgeInventory(full, deps);
    return promptIds(prompts[prompts.length - 1]!);
  };
  return { pass, prompts, window, ledger };
}

const promptIds = (prompt: string): string[] => [...prompt.matchAll(/^\{"id":"(W1-T\d+)"/gm)].map((m) => m[1]!);

/** A window in tokens that holds the prompt's head and about four of its six pack lines, never five. */
function windowForAbout4(fullPrompt: string): number {
  const lines = fullPrompt.split("\n");
  const packLines = lines.filter((l) => l.startsWith('{"id":"W1-T'));
  const avg = packLines.reduce((n, l) => n + l.length + 1, 0) / packLines.length;
  const maxChars = fullPrompt.length - Math.ceil(avg * 1.5);
  return Math.ceil(maxChars / 3) + OPENWEIGHT_MAX_COMPLETION_TOKENS;
}

test("W1-T14652 criterion 1: a pack left out of one pass is kept in the next and every pack is kept within ceil(packs / kept) passes", async (t) => {
  const probe = world(t);
  const everything = await probe.pass();
  assert.equal(everything.length, IDS.length, "with a roomy window every pack is in the prompt");
  const windowTokens = windowForAbout4(probe.prompts[0]!);

  const w = world(t);
  w.window.tokens = windowTokens;
  const first = await w.pass();
  assert.ok(first.length > 0 && first.length < IDS.length, `the bound leaves some packs out (kept ${first.length})`);
  const passes = Math.ceil(IDS.length / first.length);
  const seen = new Set(first);
  let previous = first;
  for (let i = 1; i < passes; i += 1) {
    const leftOut = IDS.filter((id) => !previous.includes(id));
    const next = await w.pass();
    for (const id of leftOut.slice(0, next.length)) assert.ok(next.includes(id), `${id} was left out last pass and is kept this one`);
    next.forEach((id) => seen.add(id));
    previous = next;
  }
  assert.deepEqual([...seen].sort(), IDS, `every pack was kept within ${passes} passes`);
  // Without the carry the lowest-priority packs would be left out every pass; here the first pass's survivors rotate away.
  assert.notDeepEqual([...previous].sort(), [...first].sort());
});

test("W1-T14652 criterion 2: invariant a-fitting-queue-is-unchanged, a queue whose packs all fit gets the prompt it got without any carry", async (t) => {
  const plain = world(t);
  const baseline = await plain.pass();
  assert.deepEqual(baseline, IDS, "packs appear in task id order when every one fits");

  // A prior pass recorded some ids as left out, in the reverse of id order; every pack still fits, so nothing may move.
  const carried = world(t, [{ step: "queue_judge.packs_left_out", task_id: "DAEMON", task_ids: [...IDS].reverse().slice(0, 3), ts: iso(NOW - HOUR) }]);
  const after = await carried.pass();
  assert.deepEqual(after, IDS);
  assert.equal(carried.prompts[0], plain.prompts[0], "the prompt is byte-identical");
  assert.equal(carried.ledger.some((r) => r.step === "queue_judge.packs_left_out" && r.ts === iso(NOW + 100 * HOUR)), false, "nothing is recorded as left out");
});
