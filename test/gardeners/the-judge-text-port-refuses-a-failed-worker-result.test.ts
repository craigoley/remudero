import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { benchmarkNonDispatchSpawn } from "#src/lib/benchmark-run.js";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { runGardenAsync, type GardenerDeps } from "#src/lib/gardener.js";
import {
  ISSUE_REVALIDATION_VERDICT_STEP, issueRevalidationJudgeText, JudgeWorkerFailedError, productionIssueRevalidationPorts,
  runIssueRevalidationGarden, type IssueRevalidationPorts, type RevalidationIssue,
} from "#src/lib/issue-revalidation-garden.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import { parseTasksFromYaml, type Task } from "#src/lib/plan.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import {
  queueJudgeGardenSpec, queueJudgeInventory, queueJudgePromptBound, queueJudgeRouteWindow, QueueJudgeUnavailableError, buildQueueJudgeSources,
  type QueueJudgeRouteWindow, type QueueJudgeSources,
} from "#src/lib/queue-judge-gardener.js";
import { OPENWEIGHT_CONTEXT_WINDOWS, OPENWEIGHT_MAX_COMPLETION_TOKENS } from "#src/lib/worker-provider.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
type Row = Record<string, unknown>;

function workerResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "s", costUsd: 0.08, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], provider: "cash", model: "fixture", servedModel: "fixture", effort: "low",
    tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...over };
}

/** The production judge text port. Only the provider call is fake; the benchmark wrapper and the spend ledger are real. */
function judgePort(t: { after(fn: () => void): void }, result: () => WorkerResult) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-port-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { root, claudeBin: "/bin/false" } as Config, ledger = join(root, "state", "ledger.ndjson");
  const prompts: string[] = [];
  const raw: typeof import("#src/lib/worker.js").spawnWorker = async (args: SpawnWorkerArgs) => { prompts.push(args.prompt); return result(); };
  const benchmark = benchmarkNonDispatchSpawn("escalation-summary", raw);
  const text = issueRevalidationJudgeText({ mount: { model: "fixture", effort: "low", maxTurns: 1, contextBudget: 1024, provider: "cash" },
    cwd: root, settingsFile: join(root, "settings.json"), config, spawn: (args) => benchmark({ ...args, config }) });
  const spend = () => existsSync(ledger) ? [...readLedgerLines(ledger)].filter((r) => r.step === "issue_revalidation.attempt_spend") as unknown as Row[] : [];
  return { text, prompts, spend };
}

test("W1-T12549 criterion 1: a failed worker result throws JudgeWorkerFailedError naming its subtype, after its spend is recorded", async (t) => {
  for (const [over, subtype] of [
    [{ subtype: "openweight_error", isError: true, apiError: true }, "openweight_error"],
    [{ subtype: "error_max_turns", isError: true }, "error_max_turns"],
    [{ subtype: "success", apiError: true }, "success with an API error"],
    [{ subtype: "success", isError: true }, "success with an error"],
    [{ subtype: "interrupted" }, "interrupted"],
  ] as const) {
    const port = judgePort(t, () => workerResult({ ...over, text: "REVALIDATION_VERDICT: resolved", costUsd: 0.0839 }));
    await assert.rejects(port.text("prompt", 0), (e: unknown) => {
      assert.ok(e instanceof JudgeWorkerFailedError, String(e));
      assert.equal(e.subtype, subtype);
      assert.equal(e.message, `worker result failed (${subtype})`);
      return true;
    });
    assert.deepEqual(port.spend().map((r) => [r.attempt_state, r.total_cost_usd]), [["result", 0.0839]], "the failed attempt's spend is still recorded");
  }
});

const issueUrl = (n: number) => `https://github.com/acme/remudero/issues/${n}`;
const handFiled = (n: number): RevalidationIssue => ({ number: n, url: issueUrl(n), title: `issue ${n}`,
  body: "Hand-filed: the `stale.widget` rows stopped after src/lib/widget.ts changed.", labels: [],
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" });

async function revalidate(t: { after(fn: () => void): void }, result: WorkerResult) {
  const port = judgePort(t, () => result);
  const clock = fixedClock(NOW);
  const judge = productionIssueRevalidationPorts({ owner: "acme", repo: "remudero", repoRoot: REPO_ROOT, stateDir: "/unused/judge-port",
    log: () => {}, clock, hasReferent: () => false, referentVerdicts: async () => new Map(), judgeText: port.text }).judge;
  const rec = { rows: [] as Array<{ step: string; extra: Row }>, closes: [] as string[], comments: [] as string[], conversions: [] as number[] };
  const ports: IssueRevalidationPorts = {
    policy: () => ({ mode: "act", maxClosesPerPass: 5 }),
    listOpenIssues: async () => [handFiled(2), handFiled(3)],
    listComments: async () => [{ authorLogin: "remudero-fleet[bot]", authorType: "Bot", authorAssociation: "NONE", createdAt: "2026-11-03T00:00:00.000Z" }],
    referentVerdicts: async () => new Map(), hasReferent: () => false,
    livenessVerdict: () => ({ verdict: "unknown", reason: "unused" }), readModelVerdict: () => ({ verdict: "unknown", reason: "unused" }),
    evidence: () => ({ facts: ["fact"] }), judge, priorVerdicts: () => new Map(),
    close: async (url) => void rec.closes.push(url), comment: async (url) => void rec.comments.push(url),
    fileConversion: async (i) => { rec.conversions.push(i.number); return `fb-${i.number}`; },
    log: (step, extra = {}) => void rec.rows.push({ step, extra }), clock,
  };
  await runIssueRevalidationGarden(ports);
  return { rec, verdicts: rec.rows.filter((r) => r.step === ISSUE_REVALIDATION_VERDICT_STEP).map((r) => r.extra) };
}

const RESOLVED = "REVALIDATION_VERDICT: resolved\nREVALIDATION_REASON: the rows resumed\nREVALIDATION_CITATION: PR #100 merged";
const CONVERT = "REVALIDATION_VERDICT: convert-to-task\nREVALIDATION_REASON: names work no task owns";

test("W1-T12549 criterion 2: a successful result keeps its verdict; a failed one closes, comments on and converts no issue", async (t) => {
  const good = await revalidate(t, workerResult({ text: RESOLVED }));
  assert.deepEqual(good.verdicts.map((v) => v.verdict), ["resolved", "resolved"], "a successful result's text is still the answer");
  assert.equal(good.rec.closes.length, 2);
  const port = judgePort(t, () => workerResult({ text: RESOLVED }));
  assert.equal(await port.text("p", 2), RESOLVED, "the text comes back unchanged");
  for (const text of [RESOLVED, CONVERT]) {
    const failed = await revalidate(t, workerResult({ text, subtype: "openweight_error", isError: true, apiError: true }));
    assert.deepEqual(failed.verdicts.map((v) => v.verdict), ["unknown", "unknown"]);
    assert.ok(failed.verdicts.every((v) => /worker result failed \(openweight_error\)/.test(String(v.reason))), JSON.stringify(failed.verdicts));
    assert.equal(failed.rec.closes.length, 0);
    assert.equal(failed.rec.comments.length, 0);
    assert.equal(failed.rec.conversions.length, 0);
  }
});

function shardText(id: string, priority: number, title: string): string {
  return [`- id: ${id}`, `  title: "${title}"`, "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  risk: low",
    "  files:", `    - src/${id}.ts`, `  priority: ${priority}`, "  status: queued", "  attempts: 0", ""].join("\n");
}

function queueWorld(t: { after(fn: () => void): void }, tasks: Array<[string, number, string]>, judgeText: QueueJudgeSources["judgeText"],
  promptWindow: QueueJudgeSources["promptWindow"] = () => ({ tokens: 131_072, model: "small-window" })) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}queue-judge-port-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const shards = new Map<string, string>(), all: Task[] = [];
  for (const [id, priority, title] of tasks) {
    const rel = `plan/tasks.d/${id}.yaml`;
    shards.set(id, rel);
    writeFileSync(join(root, rel), shardText(id, priority, title));
    all.push(...parseTasksFromYaml(shardText(id, priority, title), rel));
  }
  const plan: PlanInventory = { open: all, all, shards };
  const clock: Clock = { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() };
  const logs: Array<{ step: string; extra: Row }> = [];
  const deps: GardenerDeps = {
    stateDir: join(root, "state"), repoRoot: root, clock, seed: 1,
    log: (step, extra = {}) => void logs.push({ step, extra }),
    escalate: () => "https://example.test/issues/1",
    openWorkspace: () => ({ root, land: () => "https://example.test/pull/1", dispose: () => {} }),
  };
  const sources: Partial<QueueJudgeSources> = {
    clock, plan: () => plan, readShard: (rel) => readFileSync(join(root, rel), "utf8"), ledger: () => [], incidents: () => [],
    openPrNumbers: () => new Set(), filingDates: () => new Map(), history: () => [], churn: () => 0, credited: () => 0, judgeText, promptWindow,
  };
  return { deps, sources, logs, read: (id: string) => readFileSync(join(root, shards.get(id)!), "utf8") };
}

test("W1-T12549 criterion 3: a failed judge worker is logged as an unavailable judge, never as a malformed answer", async (t) => {
  const port = judgePort(t, () => workerResult({ subtype: "openweight_error", isError: true, apiError: true }));
  // The production wiring: the queue judge calls the issue-revalidation port with issue number 0.
  const w = queueWorld(t, [["W1-T1", 2, "task one"], ["W1-T2", 2, "task two"]], (prompt) => port.text(prompt, 0));
  await assert.rejects(() => runGardenAsync(queueJudgeGardenSpec(w.deps, w.sources), w.deps), QueueJudgeUnavailableError);
  const unavailable = w.logs.filter((l) => l.step === "queue_judge.unavailable");
  assert.deepEqual(unavailable.map((l) => l.extra.reason), ["judge spawn failed: worker result failed (openweight_error)"]);
  assert.equal(unavailable[0]!.extra.worker_subtype, "openweight_error");
  assert.ok(!w.logs.some((l) => "answer_chars" in l.extra || /malformed|strict JSON/.test(String(l.extra.reason))));
  assert.equal(port.prompts.length, 1);
  assert.equal(port.spend().length, 1, "the pass still records what the failed attempt cost");
});

const LEFT_OUT_MOVE = JSON.stringify({ moves: [{ id: "W1-T100", priority: 0.5, reason: "left out", evidence: ["origin"], expected_cost_of_delay: 1,
  expected_outcome: { unblocks_tasks: [], ends_incidents: [], unsticks_prs: [], starts_within: 2 } }] });
// Ids run opposite to priority, so a cut follows the priority, not the id order. About 450,000 characters in all.
const BIG_QUEUE: Array<[string, number, string]> = Array.from({ length: 50 }, (_, i) => [`W1-T${100 + i}`, 50 - i, `${"x".repeat(9_000)} ${i}`]);

async function askOnce(t: { after(fn: () => void): void }, window: QueueJudgeRouteWindow) {
  const prompts: string[] = [];
  const w = queueWorld(t, BIG_QUEUE, async (prompt) => { prompts.push(prompt); return LEFT_OUT_MOVE; }, () => window);
  const outcome = await queueJudgeInventory(buildQueueJudgeSources(w.deps, w.sources), w.deps).then(() => "asked", (e: unknown) => e);
  const asked = (prompts[0] ?? "").split("\n").filter((l) => l.startsWith("{\"id\":")).map((l) => JSON.parse(l) as { id: string; priority: number });
  const row = (step: string) => w.logs.filter((l) => l.step === step).map((l) => l.extra);
  return { w, prompts, asked, outcome, bound: row("queue_judge.prompt_bound"), leftOut: row("queue_judge.packs_left_out") };
}

test("W1-T12549 criterion 4: a small-window route leaves out the highest priority numbers first, and a large one leaves none out", async (t) => {
  const small = await askOnce(t, { tokens: 131_072, model: "small-window" });
  const max = (131_072 - OPENWEIGHT_MAX_COMPLETION_TOKENS) * 3;
  assert.deepEqual(small.bound.map((b) => [b.source, b.window_tokens, b.max_chars, b.model]), [["route-window", 131_072, max, "small-window"]]);
  assert.ok(small.prompts[0]!.length <= max, `${small.prompts[0]!.length} > ${max}`);
  assert.equal(small.leftOut.length, 1);
  assert.equal(small.leftOut[0]!.left_out, BIG_QUEUE.length - small.asked.length);
  assert.equal(small.leftOut[0]!.kept, small.asked.length);
  assert.ok(small.asked.length > 0 && small.asked.length < BIG_QUEUE.length, String(small.asked.length));
  // Every asked task is more urgent (a smaller number) than every task left out.
  const maxAsked = Math.max(...small.asked.map((p) => p.priority));
  const leftIds = small.leftOut[0]!.task_ids as string[];
  assert.ok(BIG_QUEUE.filter(([id]) => leftIds.includes(id)).every(([, priority]) => priority > maxAsked));
  // A left-out task is not judged this pass: the only move names one, so it is refused and nothing is written.
  assert.ok(leftIds.includes("W1-T100"));
  assert.ok(small.outcome instanceof QueueJudgeUnavailableError, String(small.outcome));
  assert.ok(small.w.logs.some((l) => l.step === "queue_judge.row_refused" && l.extra.task_id === "W1-T100"));
  assert.match(small.w.read("W1-T100"), /^ {2}priority: 50$/m);

  const large = await askOnce(t, { tokens: 272_000, model: "large-window" });
  assert.deepEqual(large.bound.map((b) => [b.source, b.max_chars]), [["route-window", (272_000 - OPENWEIGHT_MAX_COMPLETION_TOKENS) * 3]]);
  assert.equal(large.asked.length, BIG_QUEUE.length, "a window that holds the queue leaves no pack out");
  assert.equal(large.leftOut.length, 0);
});

test("W1-T12549 criterion 4: an unknown window falls back to the smallest declared one and says so", async (t) => {
  const smallest = Math.min(...Object.values(OPENWEIGHT_CONTEXT_WINDOWS).map((w) => w.totalTokens));
  const unknown = await askOnce(t, { tokens: undefined, reason: "not cash" });
  assert.deepEqual(unknown.bound.map((b) => [b.source, b.window_tokens, b.reason]), [["unknown-window-default", smallest, "not cash"]]);
  assert.ok(unknown.prompts[0]!.length <= (smallest - OPENWEIGHT_MAX_COMPLETION_TOKENS) * 3);
  assert.equal(queueJudgePromptBound({ tokens: undefined, reason: "x" }).maxChars, (smallest - OPENWEIGHT_MAX_COMPLETION_TOKENS) * 3);
  // The production route read: the repository's own judge mount names a cash deployment with a declared window.
  const mounts = loadMounts(mountsPath(REPO_ROOT));
  const routed = queueJudgeRouteWindow(mounts.escalation_judge!, mounts.capabilities);
  assert.equal(typeof routed.tokens, "number", JSON.stringify(routed));
  assert.equal(queueJudgeRouteWindow({ model: "haiku", effort: "low", provider: "claude" }, mounts.capabilities).tokens, undefined);
});
