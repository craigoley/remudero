import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { gardenSchedule, issueRevalidationGardenPass, REGISTERED_GARDEN_NAMES, gardenPacingPath } from "#src/lib/garden-registry.js";
import { overseerStatePath } from "#src/lib/gardener-overseer.js";
import {
  classifyIssue, decideAction, evidenceNames, ISSUE_REVALIDATION_FAILED_STEP, ISSUE_REVALIDATION_PASS_STEP,
  ISSUE_REVALIDATION_VERDICT_STEP, issueRevalidationJudgeText, livenessVerdictFromOverseerState, loadIssueRevalidationPolicy,
  MAX_ISSUE_REVALIDATION_JUDGES_PER_PASS, openIssuesRestArgs, operatorSpokeLast, parseIssueCommentsRest, parseIssueRevalidationPolicy,
  parseIssueRevalidationVerdict, parseOpenIssuesRest, priorVerdictsFromRows, productionIssueRevalidationPorts, readModelVerdictFromRows,
  READ_MODEL_CLEAN_RUNS, runIssueRevalidationGarden, STILL_TRUE_REFRESH_MS, buildIssueRevalidationPrompt,
  type IssueRevalidationPorts, type IssueRevalidationPolicy, type PriorVerdict, type RevalidationComment, type RevalidationIssue,
  type RevalidationVerdict,
} from "#src/lib/issue-revalidation-garden.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { issueRevalidationRunTaskPorts } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { benchmarkNonDispatchSpawn, receiptIdentity } from "#src/lib/benchmark-run.js";
import type { Config } from "#src/lib/config.js";
import { readLedgerLines } from "#src/lib/status.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HOUR = 3_600_000;

function revalidationMoneyResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "private-session", costUsd: 0.25, numTurns: 1, text: "REVALIDATION_VERDICT: unknown",
    blocks: [], stderr: "private-stderr", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: ["ANTHROPIC_API_KEY"], provider: "claude", model: "fixture",
    servedModel: "fixture", effort: "low", tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...over };
}
function revalidationMoneyFixture(t: { after(fn: () => void): void },
  provider: (args: SpawnWorkerArgs, call: number) => Promise<WorkerResult>,
  options: { select?: boolean; failSink?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}issue-money-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { root, claudeBin: "/bin/false" } as Config, path = join(root, "state", "ledger.ndjson");
  if (options.failSink) writeFileSync(join(root, "state"), "not a directory");
  const requests: SpawnWorkerArgs[] = [];
  const raw: typeof import("#src/lib/worker.js").spawnWorker = async args => {
    requests.push(args);
    const assignment: WorkerSelectionAssignment = { version: 1, id: `issue-assignment-${requests.length}`, phase: "pre-execution",
      requested: { model: args.model ?? "fixture", effort: args.effort ?? "low", maxTurns: null },
      selected: { provider: "claude", model: "fixture", effort: "low" },
      routing: { mode: "claude-only", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } }, candidates: [] };
    if (options.select !== false) args.onSelectionAssignment?.(assignment);
    const result = await provider(args, requests.length);
    if (options.select !== false) result.selectionAssignmentId ??= assignment.id;
    return result;
  };
  const benchmark = benchmarkNonDispatchSpawn("escalation-summary", raw);
  const judge = issueRevalidationJudgeText({ mount: { model: "fixture", effort: "low", maxTurns: 1, contextBudget: 1024, provider: "claude" },
    cwd: root, settingsFile: join(root, "settings.json"), config,
    // Only external provider execution is fake. Real composition, benchmark receipts and default ledger append run.
    spawn: args => benchmark({ ...args, config }) });
  return { root, judge, requests, rows: () => existsSync(path) ? [...readLedgerLines(path)] as unknown as Record<string, unknown>[] : [],
    money: () => existsSync(path) ? [...readLedgerLines(path)].filter(r => r.step === "issue_revalidation.attempt_spend") as unknown as Record<string, unknown>[] : [] };
}

test("W1-T10287: issue revalidation retains each actual attempt before verdict parsing", async t => {
  const malformed = "private-malformed-result", failure = new Error("private-provider-failure");
  const f = revalidationMoneyFixture(t, async () => revalidationMoneyResult({ text: malformed }));
  assert.deepEqual(f.money(), [], "no execution is not a measured free call");
  assert.equal(await f.judge("private-prompt", 7), malformed);
  assert.equal(f.money()[0]?.total_cost_usd, 0.25);
  assert.equal(parseIssueRevalidationVerdict(malformed).verdict, "unknown");
  assert.equal(f.requests.length, 1, "telemetry adds no parse retry");
  assert.deepEqual(f.requests[0]?.tools, []);
  assert.equal(f.requests[0]?.permissionMode, "bypassPermissions");
  assert.deepEqual(receiptIdentity(f.requests[0]!), { taskId: "ISSUE-REVALIDATION",
    runId: "issue-revalidation-7-36cd785d911d" });
  for (const interrupted of [false, true]) {
    const g = revalidationMoneyFixture(t, async args => {
      args.onModelFallbackAttempt?.({ model: "fixture", reason: "draft-contract", selectionAssignmentId: "fallback-a",
        result: revalidationMoneyResult({ costUsd: 0.125, text: malformed, selectionAssignmentId: "fallback-a" }) });
      if (interrupted) throw failure;
      return revalidationMoneyResult({ costUsd: 0.5, subtype: "interrupted", isError: true });
    });
    if (interrupted) await assert.rejects(g.judge("private-prompt", 8), error => error === failure);
    else assert.equal(await g.judge("private-prompt", 8), "REVALIDATION_VERDICT: unknown");
    assert.deepEqual(g.money().filter(r => r.price_state === "reported").map(r => r.total_cost_usd), interrupted ? [0.125] : [0.125, 0.5]);
    assert.equal(g.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(g.money()), /private-(?:prompt|malformed-result|provider-failure|stderr|session)|ANTHROPIC_API_KEY/);
  }
  const broken = revalidationMoneyFixture(t, async () => { throw failure; }, { failSink: true });
  await assert.rejects(broken.judge("private-prompt", 9), error => error === failure);
  const badFields = revalidationMoneyFixture(t, async () => {
    const result = revalidationMoneyResult();Object.defineProperty(result, "tokens", { get() { throw new Error("private-fields"); } });return result;
  });
  assert.equal(await badFields.judge("p", 9), "REVALIDATION_VERDICT: unknown");
  assert.equal(badFields.money()[0]?.price_state, "unknown");
  const unstarted = revalidationMoneyFixture(t, async () => { throw failure; }, { select: false });
  await assert.rejects(unstarted.judge("p", 10), error => error === failure);
  assert.equal(unstarted.money()[0]?.attempt_state, "not-started");
  assert.equal(unstarted.money()[0]?.total_cost_usd, undefined);
});

test("W1-T10287: issue revalidation monetary receipts deduplicate without merging distinct attempts", async t => {
  for (const select of [false, true]) {
    const f = revalidationMoneyFixture(t, async args => {
      const result = revalidationMoneyResult();
      for (let i = 0; i < 2; i++) args.onModelFallbackAttempt?.({ model: "fixture", reason: "draft-contract", result });
      return result;
    }, { select });
    await f.judge("same prompt", 1);await f.judge("same prompt", 1);
    assert.deepEqual(f.money().map(r => r.total_cost_usd), [0.25, 0.25], "one callback/final pair per actual invocation, not one per prompt");
  }
  const g = revalidationMoneyFixture(t, async args => {
    const same = revalidationMoneyResult({ selectionAssignmentId: "a" });
    args.onModelFallbackAttempt?.({ model: "fixture", reason: "draft-contract", selectionAssignmentId: "a", result: same });
    args.onModelFallbackAttempt?.({ model: "fixture", reason: "draft-contract", selectionAssignmentId: "a", result: { ...same } });
    args.onModelFallbackAttempt?.({ model: "fixture", reason: "draft-contract", selectionAssignmentId: "b", result: same });
    return { ...same, selectionAssignmentId: "b" };
  });
  await g.judge("p", 1);
  assert.deepEqual(g.money().map(r => r.selection_assignment_id), ["a", "b"], "immutable distinct attempts survive same-object or same-price aliases");
  assert.deepEqual(g.money().map(r => r.total_cost_usd), [0.25, 0.25]);
});

test("W1-T10287: issue revalidation preserves reported zero unknown and subscription price semantics", async t => {
  for (const [over, price, mode] of [
    [{ provider: "cash", costUsd: 0 }, 0, "api"],
    [{ costUsd: 0.5 }, 0.5, "api"],
    [{ costUsd: undefined }, undefined, "api"],
    [{ subtype: undefined }, undefined, "unknown"],
    [{ provider: "codex", costUsd: 0, childEnvKeys: [], notionalCostUsd: 1.5 }, undefined, "subscription"],
  ] as const) {
    const f = revalidationMoneyFixture(t, async () => revalidationMoneyResult(over as Partial<WorkerResult>));
    await f.judge("p", 1);
    const row = f.money()[0];assert.ok(row);
    assert.equal(row.total_cost_usd, price);assert.equal(row.billing_mode, mode);
    assert.equal(row.price_state, price === undefined ? "unknown" : "reported");
    if ("notionalCostUsd" in over) assert.equal(row.notional_cost_usd, over.notionalCostUsd);
  }
});
const NOW = Date.UTC(2026, 9, 13, 12);
const clock = fixedClock(NOW);
const at = (hours: number) => fixedClock(NOW + hours * HOUR).iso();
const issueUrl = (n: number) => `https://github.com/acme/remudero/issues/${n}`;

function issue(n: number, body: string, extra: Partial<RevalidationIssue> = {}): RevalidationIssue {
  return { number: n, url: issueUrl(n), title: `issue ${n}`, body, labels: [], createdAt: at(-200), updatedAt: at(-100), ...extra };
}
const escalation = (cls: string, task: string, extra = "") => `**Class:** ${cls}\n**Task:** ${task}\n**Host:** h\n\n${extra}`;
const fleet = (hours: number): RevalidationComment => ({ authorLogin: "remudero-fleet[bot]", authorType: "Bot", authorAssociation: "NONE", createdAt: at(hours) });
const owner = (hours: number): RevalidationComment => ({ authorLogin: "craigoley", authorType: "User", authorAssociation: "OWNER", createdAt: at(hours) });

/** The fixture backlog: one issue per class the garden must reach, not only the reconciler's referents. */
const BACKLOG: RevalidationIssue[] = [
  issue(1, escalation("BLOCKED", "PR-100")),
  issue(2, "Hand-filed: the `stale.widget` rows stopped after src/lib/widget.ts changed."),
  issue(3, escalation("BLOCKED", "scout-gardener-liveness")),
  issue(4, escalation("BLOCKED", "READ-MODEL-CONSOLE")),
  issue(5, escalation("MANUAL", "MEMORY-CAPACITY-serve-cold-start")),
  issue(6, escalation("GRILL", "W1-T999-grill")),
  issue(7, escalation("BLOCKED", "TRIAGE-fb-1-a")),
  issue(8, "nightly drift", { title: "clock-sweep: some-suite drifts on the wall clock" }),
];

interface Recorder {
  rows: Array<{ step: string; extra: Record<string, unknown> }>;
  closes: string[];
  comments: string[];
  conversions: number[];
  judged: number[];
}

function ports(over: Partial<IssueRevalidationPorts> & { mode?: IssueRevalidationPolicy["mode"]; cap?: number; judgeVerdicts?: Record<number, RevalidationVerdict | Error> } = {}): { ports: IssueRevalidationPorts; rec: Recorder } {
  const rec: Recorder = { rows: [], closes: [], comments: [], conversions: [], judged: [] };
  const judgeVerdicts: Record<number, RevalidationVerdict | Error> = over.judgeVerdicts ?? {
    2: { verdict: "resolved", reason: "widget rows resumed", citation: "ledger step stale.widget: 40 rows in 48 h" },
    5: { verdict: "resolved", reason: "the reserve fits", citation: "#11139 merged" },
    6: { verdict: "convert-to-task", reason: "names work no task owns" },
    7: { verdict: "unknown", reason: "cannot tell" },
    8: new Error("spawn failed"),
  };
  const comments: Record<number, RevalidationComment[]> = { 4: [fleet(-50), owner(-10)] };
  const p: IssueRevalidationPorts = {
    policy: () => ({ mode: over.mode ?? "shadow", maxClosesPerPass: over.cap ?? 5 }),
    listOpenIssues: async () => BACKLOG,
    listComments: async (n) => comments[n] ?? [fleet(-90)],
    referentVerdicts: async (issues) => new Map(issues.map((i): [number, RevalidationVerdict] =>
      [i.number, { verdict: "resolved", reason: "PR-100 merged", citation: "PR #100 merged" }])),
    hasReferent: (i) => /PR-\d+/.test(i.body),
    livenessVerdict: () => ({ verdict: "still-true", reason: "the overseer still holds an episode" }),
    readModelVerdict: () => ({ verdict: "resolved", reason: "6/6 clean", citation: "6/6 runs clean" }),
    evidence: () => ({ facts: ["fact"] }),
    judge: async (i) => {
      rec.judged.push(i.number);
      const v = judgeVerdicts[i.number];
      if (v instanceof Error) throw v;
      return v ?? { verdict: "unknown", reason: "no fixture verdict" };
    },
    priorVerdicts: () => new Map(),
    close: async (url) => void rec.closes.push(url),
    comment: async (url) => void rec.comments.push(url),
    fileConversion: async (i) => { rec.conversions.push(i.number); return `fb-issue-acme-remudero-${i.number}`; },
    log: (step, extra = {}) => void rec.rows.push({ step, extra }),
    clock,
    ...over,
  };
  return { ports: p, rec };
}

const verdictRows = (rec: Recorder) => rec.rows.filter((r) => r.step === ISSUE_REVALIDATION_VERDICT_STEP).map((r) => r.extra);
const byIssue = (rec: Recorder) => new Map(verdictRows(rec).map((r) => [r.issue_number as number, r]));

const RECEIPT_A = "11111111-1111-4111-8111-111111111111";
const RECEIPT_B = "22222222-2222-4222-8222-222222222222";
const RECEIPT_TEXT = "REVALIDATION_VERDICT: resolved\nREVALIDATION_REASON: repaired\nREVALIDATION_CITATION: PR #100 merged";
function receiptSelection(args: SpawnWorkerArgs, id: string, provider: "claude" | "codex" = "claude"): void {
  args.onSelectionAssignment?.({ version: 1, id, phase: "pre-execution",
    requested: { model: args.model ?? "fixture", effort: args.effort ?? "low", maxTurns: null },
    selected: { provider, model: "fixture", effort: "low" },
    routing: { mode: "claude-only", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } }, candidates: [] });
}
function receiptConsumer(judgeText: (prompt: string, n: number) => Promise<string>) {
  return productionIssueRevalidationPorts({ owner: "acme", repo: "remudero", repoRoot: REPO_ROOT,
    stateDir: "/unused/receipt-consumer", log: () => {}, clock,
    hasReferent: () => false, referentVerdicts: async () => new Map(), judgeText,
  }).judge;
}
async function consumeReceipt(judge: IssueRevalidationPorts["judge"]) {
  const f = ports({ judge, listOpenIssues: async () => [BACKLOG[1]!] });
  const summary = await runIssueRevalidationGarden(f.ports);
  return { ...f, summary, row: verdictRows(f.rec)[0]!, receipt: verdictRows(f.rec)[0]!.judge_receipt as Record<string, unknown> };
}

test("W1-T10854: verdict receipt uses the final judge attempt once", async t => {
  for (const fallback of [false, true]) {
    const f = revalidationMoneyFixture(t, async args => {
      receiptSelection(args, RECEIPT_A);
      if (fallback) {
        args.onModelFallbackAttempt?.({ model: "fixture", reason: "draft-contract", selectionAssignmentId: RECEIPT_A,
          result: revalidationMoneyResult({ text: "unparseable prior rung", costUsd: 0.125, selectionAssignmentId: RECEIPT_A }) });
        receiptSelection(args, RECEIPT_B);
      }
      return revalidationMoneyResult({ text: RECEIPT_TEXT, selectionAssignmentId: fallback ? RECEIPT_B : RECEIPT_A });
    }, { select: false });
    let parses = 0;
    const original = RegExp.prototype.exec;
    const counter = t.mock.method(RegExp.prototype, "exec", function(this: RegExp, text: string) {
      if (this.source.startsWith("REVALIDATION_VERDICT:")) parses++;
      return original.call(this, text);
    });
    try {
      const result = await consumeReceipt(receiptConsumer(f.judge));
      assert.equal(result.receipt?.selection_assignment_id, fallback ? RECEIPT_B : RECEIPT_A);
      assert.equal(result.receipt.source, "model");
      assert.equal(result.receipt.identity_state, "observed");
      assert.equal(result.receipt.parser_state, "parsed");
      assert.equal(result.receipt.evidence_state, "accepted");
      assert.equal(result.receipt.parsed_verdict, "resolved");
      assert.equal(result.row.action, "close");
      assert.equal(parses, 1, "the receipt describes the consumed parse, never a second parse");
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.money().map(r => r.selection_assignment_id), fallback ? [RECEIPT_A, RECEIPT_B] : [RECEIPT_A]);
    } finally { counter.mock.restore(); }
  }
  const bridge = issueRevalidationRunTaskPorts({ owner: "acme", repo: "remudero", repoRoot: REPO_ROOT,
    stateDir: "/unused/default-bridge", log: () => {} }, { spawn: async args => {
    receiptSelection(args, RECEIPT_B);
    return revalidationMoneyResult({ text: RECEIPT_TEXT, selectionAssignmentId: RECEIPT_B });
  } });
  assert.equal((await consumeReceipt(receiptConsumer(bridge.judgeText))).receipt.selection_assignment_id, RECEIPT_B,
    "the real run-task bridge forwards per-invocation evidence without replacing default composition");
});

test("W1-T10854: verdict receipt refuses unavailable or superseded identity", async t => {
  for (const shape of ["unreported", "unobserved", "foreign", "provider", "conflict", "superseded", "invalid", "selection-error", "result-error", "unkeyed-fallback", "fallback-error"] as const) {
    const f = revalidationMoneyFixture(t, async args => {
      if (shape !== "unobserved") receiptSelection(args, shape === "invalid" ? "not-an-immutable-id" : RECEIPT_A);
      if (shape === "conflict") receiptSelection(args, RECEIPT_A, "codex");
      if (shape === "selection-error") args.onSelectionAssignment?.({ id: RECEIPT_A,
        get selected() { throw new Error("private-selection-metadata"); } } as unknown as WorkerSelectionAssignment);
      if (shape === "unkeyed-fallback") args.onModelFallbackAttempt?.({ model: "fixture", reason: "draft-contract" });
      if (shape === "fallback-error") args.onModelFallbackAttempt?.({ model: "fixture", reason: "draft-contract",
        selectionAssignmentId: { toString() { throw new Error("private-fallback-metadata"); } } as unknown as string });
      if (shape === "superseded") {
        args.onModelFallbackAttempt?.({ model: "fixture", reason: "draft-contract", selectionAssignmentId: RECEIPT_A,
          result: revalidationMoneyResult({ selectionAssignmentId: RECEIPT_A }) });
        receiptSelection(args, RECEIPT_B);
      }
      const result = revalidationMoneyResult({ text: RECEIPT_TEXT,
        selectionAssignmentId: shape === "unreported" ? undefined : shape === "foreign" ? RECEIPT_B : RECEIPT_A,
        ...(shape === "provider" ? { provider: "codex" } : {}) });
      if (shape === "result-error") Object.defineProperty(result, "provider", { get() { throw new Error("private-result-metadata"); } });
      return result;
    }, { select: false });
    const result = await consumeReceipt(receiptConsumer(f.judge));
    assert.equal(result.receipt?.identity_state, "unavailable", shape);
    assert.equal(result.receipt.selection_assignment_id, undefined, shape);
    assert.equal(result.row.verdict, "resolved", "missing attribution cannot change the existing decision");
    assert.equal(result.row.action, "close");
    assert.equal(f.requests.length, 1);
  }
  for (const [text, state, evidence] of [["private malformed output", "unparseable", "not-assessed"],
    ["REVALIDATION_VERDICT: resolved\nREVALIDATION_CITATION: none", "parsed", "missing-citation"],
    ["REVALIDATION_VERDICT: still-true\nREVALIDATION_CITATION: src/widget.ts does not appear", "parsed", "absence-only"]] as const) {
    const f = revalidationMoneyFixture(t, async args => {
      receiptSelection(args, RECEIPT_A);
      return revalidationMoneyResult({ text, selectionAssignmentId: RECEIPT_A });
    }, { select: false });
    const r = await consumeReceipt(receiptConsumer(f.judge));
    assert.equal(r.receipt?.parser_state, state);assert.equal(r.receipt.evidence_state, evidence);
    assert.equal(r.row.verdict, "unknown");
  }
});

test("W1-T10854: legacy and unjudged verdicts remain separate", async () => {
  const legacy = await consumeReceipt(receiptConsumer(async () => RECEIPT_TEXT));
  assert.equal(legacy.row.action, "close");
  assert.equal(legacy.receipt?.source, "legacy");
  assert.equal(legacy.receipt.identity_state, "unavailable");
  const plain = ports({ listOpenIssues: async () => [BACKLOG[1]!] });
  await runIssueRevalidationGarden(plain.ports);
  assert.equal((verdictRows(plain.rec)[0]!.judge_receipt as Record<string, unknown>).source, "legacy");
  const cached = ports({ listOpenIssues: async () => [BACKLOG[1]!], priorVerdicts: () => new Map([[2,
    { verdict: "resolved", at: at(-1), issueUpdatedAt: BACKLOG[1]!.updatedAt, citation: "PR #100 merged" }]]) });
  await runIssueRevalidationGarden(cached.ports);
  assert.equal((verdictRows(cached.rec)[0]!.judge_receipt as Record<string, unknown>).source, "cached");
  assert.deepEqual(cached.rec.judged, []);
  const deterministic = ports({ listOpenIssues: async () => [BACKLOG[0]!] });
  await runIssueRevalidationGarden(deterministic.ports);
  assert.equal((verdictRows(deterministic.rec)[0]!.judge_receipt as Record<string, unknown>).source, "deterministic");
  const capped = ports({ listOpenIssues: async () => Array.from({ length: MAX_ISSUE_REVALIDATION_JUDGES_PER_PASS + 1 },
    (_, n) => issue(1000 + n, "hand filed")) });
  await runIssueRevalidationGarden(capped.ports);
  assert.equal((verdictRows(capped.rec).at(-1)!.judge_receipt as Record<string, unknown>).source, "unjudged");
});

test("W1-T10854: receipt metadata preserves failures and money", async t => {
  const original = new Error("private-provider-failure");
  const failed = revalidationMoneyFixture(t, async args => { receiptSelection(args, RECEIPT_A);throw original; }, { select: false });
  await assert.rejects(failed.judge("private-prompt", 2), error => error === original);
  assert.equal(failed.money()[0]!.selection_assignment_id, RECEIPT_A);
  const f = revalidationMoneyFixture(t, async args => {
    receiptSelection(args, RECEIPT_A);return revalidationMoneyResult({ text: RECEIPT_TEXT, selectionAssignmentId: RECEIPT_A });
  }, { select: false });
  assert.equal(await (f.judge as (p: string, n: number, observe: () => void) => Promise<string>)("p", 2,
    () => { throw new Error("private-optional-sink"); }), RECEIPT_TEXT);
  assert.deepEqual(f.money().map(r => [r.selection_assignment_id, r.total_cost_usd]), [[RECEIPT_A, 0.25]]);
  const unavailable = ports({ listOpenIssues: async () => [BACKLOG[1]!], judge: async () => {
    const v = { verdict: "resolved", reason: "repaired", citation: "PR #100 merged" } as RevalidationVerdict;
    Object.defineProperty(v, "judgeEvidence", { get() { throw new Error("private-metadata"); } });return v;
  } });
  await runIssueRevalidationGarden(unavailable.ports);
  assert.equal(verdictRows(unavailable.rec)[0]!.action, "close");
  assert.equal((verdictRows(unavailable.rec)[0]!.judge_receipt as Record<string, unknown>).identity_state, "unavailable");
  const malformed = receiptConsumer((async (_prompt: string, _n: number, observe: (value: unknown) => void) => {
    observe({ get identity_state() { throw new Error("private-identity-metadata"); } });return RECEIPT_TEXT;
  }) as never);
  assert.equal((await consumeReceipt(malformed)).receipt.identity_unavailable_reason, "receipt-build-failed");
  for (const evidence of [
    { version: 2 },
    { version: 1, source: "model", parser_state: "parsed", parsed_verdict: "still-true", evidence_state: "missing-citation" },
    { version: 1, source: "model", parser_state: "unparseable", evidence_state: "accepted" },
    { version: 1, source: "model", parser_state: "parsed", parsed_verdict: "unknown", evidence_state: "absence-only" },
  ]) {
    const r = await consumeReceipt(async () => ({ verdict: "resolved", reason: "r", citation: "PR #100 merged", judgeEvidence: evidence } as never));
    assert.equal(r.row.action, "close");assert.equal(r.receipt.identity_unavailable_reason, "receipt-build-failed");
  }
  const brokenLog = ports({ listOpenIssues: async () => [BACKLOG[1]!], log: step => {
    if (step === ISSUE_REVALIDATION_VERDICT_STEP) throw original;
  } });
  await assert.rejects(runIssueRevalidationGarden(brokenLog.ports), error => error === original);
  assert.doesNotMatch(JSON.stringify(verdictRows(unavailable.rec).map(r => r.judge_receipt)), /private-|ANTHROPIC_API_KEY/);
});

test("W1-T8864: the issue revalidation garden re-judges every open issue", async () => {
  // SHADOW: every open issue of every class gets one verdict row and nothing is written to GitHub.
  const shadow = ports();
  const summary = await runIssueRevalidationGarden(shadow.ports);
  assert.equal(summary.ran, true);
  assert.deepEqual(verdictRows(shadow.rec).map((r) => r.issue_number), BACKLOG.map((i) => i.number), "every open issue has a verdict");
  const rows = byIssue(shadow.rec);
  assert.deepEqual(
    BACKLOG.map((i) => [i.number, rows.get(i.number)!.issue_class, rows.get(i.number)!.verdict, rows.get(i.number)!.action, rows.get(i.number)!.guard]),
    [
      [1, "referent", "resolved", "close", null],
      [2, "hand-filed", "resolved", "close", null],
      [3, "liveness", "still-true", "refresh", null],
      [4, "read-model", "resolved", "keep", "newer-operator-comment"],
      [5, "memory-capacity", "resolved", "refresh", "operator-owned-class"],
      [6, "escalation", "convert-to-task", "refresh", "operator-owned-class"],
      [7, "triage", "unknown", "keep", null],
      [8, "clock-sweep", "unknown", "keep", null],
    ],
  );
  assert.ok(verdictRows(shadow.rec).every((r) => r.acted === false && r.mode === "shadow"));
  assert.deepEqual([shadow.rec.closes, shadow.rec.comments, shadow.rec.conversions], [[], [], []], "shadow writes nothing to GitHub");
  assert.match(String(rows.get(8)!.reason), /judge unavailable/);
  const pass = shadow.rec.rows.find((r) => r.step === ISSUE_REVALIDATION_PASS_STEP)!.extra;
  assert.deepEqual(pass.verdicts, { resolved: 4, "still-true": 1, "convert-to-task": 1, unknown: 2 });

  // ACT, cap 1: only positively evidenced, non-MANUAL, non-GRILL issues with no newer operator comment
  // close, at most one a pass; the operator-owned and still-true ones get a refresh comment instead.
  const act = ports({ mode: "act", cap: 1 });
  await runIssueRevalidationGarden(act.ports);
  assert.deepEqual(act.rec.closes, [issueUrl(1)], "one close, the first evidenced one");
  assert.equal(byIssue(act.rec).get(2)!.guard, "close-cap");
  assert.deepEqual(act.rec.comments.sort(), [issueUrl(3), issueUrl(5), issueUrl(6)].sort());
  assert.deepEqual(act.rec.conversions, []);
  assert.ok(!act.rec.closes.includes(issueUrl(5)) && !act.rec.closes.includes(issueUrl(6)), "MANUAL and GRILL never close");
  assert.ok(!act.rec.closes.includes(issueUrl(4)), "an issue the operator spoke on last is never touched");
});

test("act mode converts an unowned work item once and records the feedback id", async () => {
  const { ports: p, rec } = ports({ mode: "act", judgeVerdicts: { 7: { verdict: "convert-to-task", reason: "names work" } } });
  await runIssueRevalidationGarden({ ...p, listOpenIssues: async () => [BACKLOG[6]!] });
  assert.deepEqual(rec.conversions, [7]);
  assert.deepEqual(rec.comments, [issueUrl(7)]);
  assert.equal(byIssue(rec).get(7)!.acted, true);
  // A converted issue is not converted again.
  const again = ports({ mode: "act", judgeVerdicts: { 7: { verdict: "convert-to-task", reason: "names work" } } });
  const prior = new Map<number, PriorVerdict>([[7, { verdict: "convert-to-task", at: at(-1), action: "convert", acted: true, issueUpdatedAt: "x" }]]);
  await runIssueRevalidationGarden({ ...again.ports, listOpenIssues: async () => [BACKLOG[6]!], priorVerdicts: () => prior });
  assert.deepEqual(again.rec.conversions, []);
});

test("a failed write is ledgered and the pass goes on", async () => {
  const { ports: p, rec } = ports({ mode: "act", close: async () => { throw new Error("403"); } });
  await runIssueRevalidationGarden(p);
  const failed = rec.rows.filter((r) => r.step === "issue_revalidation.action_failed");
  assert.ok(failed.length >= 1);
  assert.equal(byIssue(rec).get(1)!.acted, false);
  assert.equal(verdictRows(rec).length, BACKLOG.length);
});

test("a failed list, an invalid policy and mode off each do nothing", async () => {
  const list = ports({ listOpenIssues: async () => { throw new Error("gh down"); } });
  assert.equal((await runIssueRevalidationGarden(list.ports)).ran, false);
  assert.equal(list.rec.rows[0]!.step, ISSUE_REVALIDATION_FAILED_STEP);
  assert.equal(list.rec.rows[0]!.extra.stage, "list");
  const bad = ports({ policy: () => { throw new Error("bad policy"); } });
  assert.equal((await runIssueRevalidationGarden(bad.ports)).ran, false);
  assert.equal(bad.rec.rows[0]!.extra.stage, "policy");
  const off = ports({ mode: "off" });
  assert.deepEqual(await runIssueRevalidationGarden(off.ports), { mode: "off", ran: false, issuesSeen: 0, rows: [], found: false });
  assert.deepEqual(off.rec.rows, []);
});

test("unreadable comments and a failed referent derivation never close", async () => {
  const { ports: p, rec } = ports({
    mode: "act",
    listComments: async () => { throw new Error("comments 502"); },
    referentVerdicts: async () => { throw new Error("gateway down"); },
  });
  await runIssueRevalidationGarden(p);
  assert.deepEqual(rec.closes, []);
  const rows = byIssue(rec);
  assert.equal(rows.get(1)!.verdict, "unknown");
  assert.equal(rows.get(2)!.guard, "comments-unread");
  assert.ok(rec.rows.some((r) => r.step === ISSUE_REVALIDATION_FAILED_STEP && r.extra.stage === "referent"));
});

test("an unchanged issue keeps its verdict without a judge spawn, and the judge is capped per pass", async () => {
  const prior = new Map<number, PriorVerdict>([[2, { verdict: "still-true", at: at(-2), issueUpdatedAt: at(-100), reason: "still", action: "refresh", acted: false }]]);
  const memo = ports({ priorVerdicts: () => prior });
  const summary = await runIssueRevalidationGarden(memo.ports);
  assert.ok(!memo.rec.judged.includes(2), "no spawn for an unchanged issue");
  assert.equal(byIssue(memo.rec).get(2)!.verdict, "still-true");
  assert.equal(summary.found, true, "other issues are new verdicts");

  const many = Array.from({ length: MAX_ISSUE_REVALIDATION_JUDGES_PER_PASS + 2 }, (_, k) => issue(100 + k, "hand-filed text"));
  const capped = ports({ listOpenIssues: async () => many });
  await runIssueRevalidationGarden(capped.ports);
  assert.equal(capped.rec.judged.length, MAX_ISSUE_REVALIDATION_JUDGES_PER_PASS);
  assert.match(String(byIssue(capped.rec).get(100 + MAX_ISSUE_REVALIDATION_JUDGES_PER_PASS)!.reason), /judge cap/);
});

test("classification, the operator check and the action table", () => {
  const has = (i: RevalidationIssue) => /PR-\d+/.test(i.body);
  assert.equal(classifyIssue(issue(1, escalation("BLOCKED", "LIVE-EDITS-core")), has), "live-edits");
  assert.equal(classifyIssue(issue(1, escalation("BLOCKED", "main-repair-abc")), has), "main-repair");
  assert.equal(operatorSpokeLast([fleet(-5), owner(-10)], undefined), false);
  assert.equal(operatorSpokeLast([fleet(-5), owner(-1)], undefined), true);
  assert.equal(operatorSpokeLast([owner(-1), { ...owner(0), createdAt: "not a time" }], ["someone-else"]), false, "a login list overrides OWNER");
  assert.equal(operatorSpokeLast([{ ...owner(-1), authorLogin: "Op" }], ["op"]), true);
  const resolved: RevalidationVerdict = { verdict: "resolved", reason: "r" };
  assert.deepEqual(decideAction({ verdict: resolved, escalationClass: undefined, operatorSpokeLast: false, prior: undefined, nowMs: NOW }), { action: "keep", guard: "no-citation" });
  const refreshed: PriorVerdict = { verdict: "still-true", at: at(-24), action: "refresh", acted: true };
  const still: RevalidationVerdict = { verdict: "still-true", reason: "s" };
  assert.deepEqual(decideAction({ verdict: still, escalationClass: "BLOCKED", operatorSpokeLast: false, prior: refreshed, nowMs: NOW }), { action: "keep", guard: "refresh-not-due" });
  assert.deepEqual(decideAction({ verdict: still, escalationClass: "BLOCKED", operatorSpokeLast: false, prior: refreshed, nowMs: NOW + STILL_TRUE_REFRESH_MS }), { action: "refresh" });
  assert.deepEqual(decideAction({ verdict: still, escalationClass: "MANUAL", operatorSpokeLast: false, prior: refreshed, nowMs: NOW }), { action: "keep", guard: "refresh-not-due" });
});

test("the policy block is strict, and the shipped one acts on operator 2026-10-14", () => {
  assert.deepEqual(loadIssueRevalidationPolicy(join(process.cwd(), "plan", "policy.yaml")), { mode: "act", maxClosesPerPass: 5 });
  const row = (value: unknown) => ({ value, origin: "net-new", min: 1, max: 20 });
  assert.throws(() => parseIssueRevalidationPolicy({ mode: { value: "on" }, maxClosesPerPass: row(5) }), /accepts only/);
  assert.throws(() => parseIssueRevalidationPolicy({ mode: { value: "act" }, maxClosesPerPass: row(50) }), /integer inside/);
  assert.throws(() => parseIssueRevalidationPolicy({ mode: { value: "act" }, maxClosesPerPass: row(2.5) }), /integer inside/);
  assert.throws(() => parseIssueRevalidationPolicy(undefined), /must be a mapping/);
  assert.deepEqual(parseIssueRevalidationPolicy({ mode: { value: "act" }, maxClosesPerPass: row(3) }), { mode: "act", maxClosesPerPass: 3 });
});

test("REST parsing keeps labels and times, drops pull requests, and refuses a malformed page", () => {
  const raw = JSON.stringify([
    { number: 9, html_url: issueUrl(9), title: "t", body: null, labels: [{ name: "needs-human" }, "plain"], created_at: at(-1), updated_at: at(0) },
    { number: 10, html_url: "x", pull_request: {} },
  ]) + JSON.stringify([{ number: 11, html_url: issueUrl(11), labels: "odd" }]);
  assert.deepEqual(parseOpenIssuesRest(raw), [
    { number: 9, url: issueUrl(9), title: "t", body: "", labels: ["needs-human", "plain"], createdAt: at(-1), updatedAt: at(0) },
    { number: 11, url: issueUrl(11), title: "", body: "", labels: [], createdAt: "", updatedAt: "" },
  ]);
  assert.throws(() => parseOpenIssuesRest("{}"), /JSON array/);
  assert.deepEqual(parseIssueCommentsRest(JSON.stringify([{ user: { login: "a", type: "Bot" }, author_association: "NONE", created_at: at(0), body: "seen" }, {}])), [
    { authorLogin: "a", authorType: "Bot", authorAssociation: "NONE", createdAt: at(0), body: "seen" },
    { authorLogin: "", authorType: "User", authorAssociation: "NONE", createdAt: "", body: "" },
  ]);
  assert.throws(() => parseIssueCommentsRest("{}"), /JSON array/);
  assert.deepEqual(openIssuesRestArgs("acme", "remudero"), ["api", "repos/acme/remudero/issues?state=open&per_page=100", "--paginate"]);
});

test("the deterministic probes need positive evidence to call an issue resolved", () => {
  const run = (hours: number, outcome: string) => ({ ts: at(hours), step: "read_model.consistency", task_id: "READ-MODEL-CONSOLE", outcome });
  const clean = Array.from({ length: READ_MODEL_CLEAN_RUNS }, (_, k) => run(-k, "agree"));
  assert.equal(readModelVerdictFromRows("READ-MODEL-CONSOLE", clean).verdict, "resolved");
  assert.equal(readModelVerdictFromRows("READ-MODEL-CONSOLE", [...clean, run(1, "drift")]).verdict, "still-true");
  assert.equal(readModelVerdictFromRows("READ-MODEL-CONSOLE", clean.slice(1)).verdict, "unknown");
  assert.equal(livenessVerdictFromOverseerState("scout", { episodes: {} }, NOW - HOUR, NOW).verdict, "resolved");
  assert.equal(livenessVerdictFromOverseerState("scout", { episodes: { scout: { kind: "silence", since: at(-3) } } }, NOW, NOW).verdict, "still-true");
  assert.equal(livenessVerdictFromOverseerState("scout", { episodes: {} }, NOW - 10 * HOUR, NOW).verdict, "unknown");
  assert.equal(livenessVerdictFromOverseerState("scout", undefined, undefined, NOW).verdict, "unknown");
});

test("the judge's verdict parse fails toward unknown, and prior verdicts are the newest row per issue", () => {
  assert.deepEqual(parseIssueRevalidationVerdict("REVALIDATION_VERDICT: resolved\nREVALIDATION_REASON: gone\nREVALIDATION_CITATION: none"),
    { verdict: "unknown", reason: "resolved without a citation (gone)" });
  assert.deepEqual(parseIssueRevalidationVerdict("REVALIDATION_VERDICT: still-true"), { verdict: "still-true", reason: "(no reason stated)" });
  assert.equal(parseIssueRevalidationVerdict("I think it is fine").verdict, "unknown");
  assert.deepEqual(parseIssueRevalidationVerdict("REVALIDATION_VERDICT: Resolved\nREVALIDATION_REASON: r\nREVALIDATION_CITATION: PR #5 merged"),
    { verdict: "resolved", reason: "r", citation: "PR #5 merged" });
  const prompt = buildIssueRevalidationPrompt(BACKLOG[1]!, "hand-filed", { facts: [] });
  assert.match(prompt, /WHEN IN DOUBT, ANSWER unknown/);
  assert.match(prompt, /\(none could be read\)/);
  const step = ISSUE_REVALIDATION_VERDICT_STEP;
  const prior = priorVerdictsFromRows([
    { step, issue_number: 4, ts: at(-5), verdict: "unknown" },
    { step, issue_number: 4, ts: at(-1), verdict: "still-true", issue_updated_at: "u", action: "refresh", acted: true, reason: "r", citation: "c" },
    { step, issue_number: 4, ts: at(-3), verdict: "resolved" },
    { step: "other", issue_number: 5, ts: at(-1) },
    { step, issue_number: "x", ts: at(-1) },
  ]);
  assert.deepEqual([...prior], [[4, { verdict: "still-true", at: at(-1), issueUpdatedAt: "u", action: "refresh", acted: true, reason: "r", citation: "c" }]]);
  assert.deepEqual(evidenceNames({ title: "t", body: "`a.b` and src/lib/x.ts and stale.widget plus notes.md" }), ["a.b", "src/lib/x.ts", "stale.widget"]);
});

test("the production ports read GitHub, the overseer, the ledger and origin/main through their seams", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}issue-revalidation-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  // A real repository with origin/main, so the evidence port's default git really shells out.
  const repo = gitRepo({ kind: "issue-revalidation-repo" });
  t.after(() => repo.cleanup());
  const repoRoot = repo.dir;
  mkdirSync(join(repoRoot, "src", "lib"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "lib", "widget.ts"), "export const widget = 'stale.widget';\n");
  repo.git("add", ".");
  repo.git("commit", "-q", "-m", "widget");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  // The ledger the default union reader opens: one prior verdict and the read-model runs.
  const ledger = [
    { ts: at(-2), step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 2, verdict: "still-true", issue_updated_at: at(-100) },
    ...Array.from({ length: READ_MODEL_CLEAN_RUNS }, (_, k) => ({ ts: at(-k - 1), step: "read_model.consistency", task_id: "READ-MODEL-CONSOLE", outcome: "agree" })),
    { ts: at(-1), step: "stale.widget" },
  ];
  writeFileSync(join(stateDir, "ledger.ndjson"), ledger.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(overseerStatePath(stateDir), JSON.stringify({ episodes: { scout: { kind: "failure", since: at(-4) } } }));
  utimesSync(overseerStatePath(stateDir), new Date(NOW), new Date(NOW));

  const reads: string[][] = [];
  const writes: string[] = [];
  const restIssues = JSON.stringify([{ number: 2, html_url: issueUrl(2), title: "widget", body: "`stale.widget` stopped; `nowhere.symbol` too", labels: [], created_at: at(-200), updated_at: at(-100) }]);
  const p = productionIssueRevalidationPorts({
    owner: "acme", repo: "remudero", stateDir, repoRoot, log: () => {}, clock,
    referentVerdicts: async () => new Map(), hasReferent: () => false,
    judgeText: async (prompt) => (assert.match(prompt, /stale\.widget` appears on origin\/main in 1 file/), "REVALIDATION_VERDICT: still-true\nREVALIDATION_REASON: r"),
    policy: () => ({ mode: "shadow", maxClosesPerPass: 5 }),
    readText: async (args) => { reads.push(args); return args[1]!.includes("/comments") ? JSON.stringify([]) : restIssues; },
    issues: { closeWithComment: async (url) => void writes.push(`close ${url}`), comment: async (url) => void writes.push(`comment ${url}`) },
  });
  const listed = await p.listOpenIssues();
  assert.equal(listed.length, 1);
  assert.deepEqual(await p.listComments(2), []);
  assert.deepEqual(reads[1], ["api", "repos/acme/remudero/issues/2/comments?per_page=100", "--paginate"]);
  assert.equal(p.livenessVerdict("scout").verdict, "still-true");
  assert.equal(p.livenessVerdict("plan").verdict, "resolved");
  assert.equal(p.readModelVerdict("READ-MODEL-CONSOLE").verdict, "resolved");
  assert.equal(p.priorVerdicts().get(2)?.verdict, "still-true");
  const facts = p.evidence(listed[0]!).facts;
  assert.ok(facts.some((f) => /`nowhere\.symbol` does not appear on origin\/main/.test(f)), facts.join("\n"));
  assert.ok(facts.some((f) => /ledger step stale\.widget: 1 row/.test(f)), facts.join("\n"));
  assert.equal((await p.judge(listed[0]!, "hand-filed", { facts })).verdict, "still-true");
  await p.close(issueUrl(2), "c");
  await p.comment(issueUrl(2), "b");
  assert.deepEqual(writes, [`close ${issueUrl(2)}`, `comment ${issueUrl(2)}`]);
  const id = await p.fileConversion(listed[0]!, { verdict: "convert-to-task", reason: "names work" });
  assert.equal(id, "fb-issue-acme-remudero-2");
  assert.ok(existsSync(join(repoRoot, "plan", "feedback", `${id}.yaml`)));
  assert.match(readFileSync(join(repoRoot, "plan", "feedback", `${id}.yaml`), "utf8"), /issue-revalidation \(W1-T8864\): names work/);
  assert.equal(await p.fileConversion(listed[0]!, { verdict: "convert-to-task", reason: "again" }), id, "an existing entry is reused");

  // An unreadable overseer state and a failed git read are unknown facts, never resolved ones.
  rmSync(overseerStatePath(stateDir));
  assert.equal(p.livenessVerdict("scout").verdict, "unknown");
  const broken = productionIssueRevalidationPorts({
    owner: "acme", repo: "remudero", stateDir, repoRoot: join(root, "missing"), log: () => {}, clock,
    referentVerdicts: async () => new Map(), hasReferent: () => false, judgeText: async () => "",
    readLedgerRows: () => { throw new Error("union unreadable"); },
    readText: async () => restIssues,
    issues: {},
  });
  await broken.listOpenIssues();
  const brokenFacts = broken.evidence(listed[0]!).facts;
  assert.ok(brokenFacts.some((f) => /could not be searched/.test(f)), brokenFacts.join("\n"));
  assert.ok(brokenFacts.some((f) => /the ledger could not be read \(union unreadable\)/.test(f)), brokenFacts.join("\n"));
  await assert.rejects(broken.close(issueUrl(2), "c"), /cannot close/);
  await assert.rejects(broken.comment(issueUrl(2), "c"), /cannot comment/);
});

test("the judge spawns once with no tools on the given mount", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const judgeText = issueRevalidationJudgeText({
    mount: { model: "m", effort: "low", maxTurns: 1, provider: "p" } as never, cwd: "/w", settingsFile: "/s.json",
    spawn: (async (args: Record<string, unknown>) => { seen.push(args); return { text: "REVALIDATION_VERDICT: unknown" }; }) as never,
  });
  assert.equal(await judgeText("prompt", 7), "REVALIDATION_VERDICT: unknown");
  assert.deepEqual(seen[0]!.tools, []);
  assert.equal(seen[0]!.mountProvider, "p");
  assert.equal(seen[0]!.prompt, "prompt");
});

test("the garden is registered, hourly at most, and its pass records pacing and never throws", async (t) => {
  assert.ok((REGISTERED_GARDEN_NAMES as readonly string[]).includes("issue-revalidation"));
  const schedule = gardenSchedule("issue-revalidation");
  assert.equal(schedule.intervalFor(60_000), HOUR);
  assert.equal(schedule.minIntervalMs, HOUR);
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}issue-revalidation-pass-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const { ports: p, rec } = ports();
  const pass = issueRevalidationGardenPass(stateDir, p, clock);
  assert.equal(pass.due(), true);
  await pass();
  assert.ok(existsSync(gardenPacingPath(stateDir, "issue-revalidation")));
  assert.equal(verdictRows(rec).length, BACKLOG.length);
  // A pass whose garden throws, and a pacing write that fails, are each ledgered.
  const throwing = ports({ listOpenIssues: async () => BACKLOG, priorVerdicts: () => { throw new Error("boom"); } });
  rmSync(stateDir, { recursive: true, force: true });
  writeFileSync(stateDir, "not a directory");
  await issueRevalidationGardenPass(stateDir, throwing.ports, clock)();
  assert.deepEqual(throwing.rec.rows.map((r) => r.extra.stage), ["pass", "pacing"]);
});

test("the run-task ports derive referents through the reconciler, load the plan once, and judge on the escalation mount", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}issue-revalidation-runtask-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let loads = 0;
  const plan = { tasks: [], byId: new Map([["W1-T1", {}]]) } as never;
  const states: Record<number, string> = { 100: "MERGED", 101: "CLOSED", 102: "OPEN" };
  const github = { prByRef: (n: number) => (n in states ? { number: n, state: states[n], url: `https://github.com/acme/remudero/pull/${n}` } : undefined) } as never;
  const spawned: Array<Record<string, unknown>> = [];
  const p = issueRevalidationRunTaskPorts({ owner: "acme", repo: "remudero", repoRoot: process.cwd(), stateDir, log: () => {} }, {
    loadPlan: () => { loads++; return plan; },
    reconcile: { github, evidenceRootFor: () => undefined },
    spawn: (async (args: Record<string, unknown>) => { spawned.push(args); return { text: "REVALIDATION_VERDICT: unknown" }; }) as never,
  });
  assert.equal(p.hasReferent(issue(1, escalation("BLOCKED", "PR-100"))), true);
  assert.equal(p.hasReferent(issue(2, escalation("BLOCKED", "W1-T1"))), true);
  assert.equal(p.hasReferent(issue(3, escalation("BLOCKED", "X"), { title: "see https://github.com/acme/remudero/pull/5" })), true);
  assert.equal(p.hasReferent(issue(4, escalation("BLOCKED", "X"))), false);
  assert.equal(loads, 1, "the plan loads once, on first use");
  const verdicts = await p.referentVerdicts([100, 101, 102, 103].map((n) => issue(n, escalation("BLOCKED", `PR-${n}`))));
  assert.deepEqual([...verdicts].map(([n, v]) => [n, v.verdict, v.citation ?? null]), [
    [100, "resolved", "PR #100 merged (https://github.com/acme/remudero/pull/100)"],
    [101, "resolved", "PR #101 closed without merging"],
    [102, "still-true", null],
    [103, "unknown", null],
  ]);
  assert.equal(await p.judgeText("the prompt", 7), "REVALIDATION_VERDICT: unknown");
  assert.deepEqual(spawned[0]!.tools, []);
  assert.equal(spawned[0]!.prompt, "the prompt");
});
