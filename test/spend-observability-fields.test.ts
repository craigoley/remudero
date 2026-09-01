/**
 * test/spend-observability-fields.test.ts — W1-T2383, all five ranks.
 *
 * FIVE SPEND QUESTIONS ARE UNANSWERABLE AND FOUR ARE ONE FIELD ON A ROW THAT ALREADY EXISTS. This
 * suite is the one place every acceptance proof for W1-T2383 points at; it accumulated across
 * three earlier merges (#3097 ranks 1-2, #3101 rank 3, and rank 5's `recon.reused`/rank 4's
 * `compaction_configured` predate this shard entirely — #2808 and #2829) whose own test files
 * (test/lane-run-start-rows.test.ts, test/recon-artifact-reuse.test.ts, test/worker.test.ts,
 * test/compaction.test.ts) already drive the underlying code in full. What follows CLOSES this
 * file's own coverage of the same five claims, without re-implementing anything those files
 * already prove more thoroughly — each block below drives the SAME exported, real code they do.
 *
 *  RANK 1 — `cost_usd` (and the mount that spent it) on `risk_judge.decision`. Measured
 *  2026-08-27: 276 risk-judge rows, ZERO carrying a cost and ZERO carrying a mount, so
 *  `resolveRiskJudgeMount`'s DELIBERATE choice of the cheapest configured tier at a floor is a
 *  design decision whose consequence cannot be read off anything on disk. (Shipped #3097.)
 *
 *  RANK 2 — `max_turns` beside `num_turns` on `fix.done`. Absent on 233 of 233 rows against
 *  $629.99 of fix-rung spend, on a surface verdict rows do not contain at all (16 of 109 fix run
 *  ids carry a verdict), so an EXHAUSTED fix run is indistinguishable from a merely long one.
 *  (Shipped #3097.)
 *
 *  RANK 3 — a `run.start` row for the triage and retro lanes, which today read `type: implement`
 *  on all 544 rows or emit no `run.start` at all. `laneRunStartFields` (run-task.ts) is the one
 *  builder both lane call sites share. (Shipped #3101.)
 *
 *  RANK 4 — `compaction_events`/`compaction_configured`/`compaction_failures` POPULATED, not
 *  declared-and-empty. #2829 (W1-T2245) landed this before this shard was even filed — the
 *  shard's own amendment records that item (4) needed nothing built. `collectWorkerResult` +
 *  `workerLedgerFields` (worker.ts) are the real, driven path.
 *
 *  RANK 5 — `recon.reused`, so `recon.invalidated`'s 7-count acquires a denominator. Built by
 *  W1-T2241 (#2808), predating this shard; this file drives the same real `runTask` dispatch
 *  path test/recon-artifact-reuse.test.ts's own fixture does, trimmed to the one absent→reused
 *  transition this claim is about.
 *
 * DECLARED IS NOT POPULATED. Every test below DRIVES the real code path and READS THE ROW BACK —
 * never an assertion that a type has a key.
 *
 * NOTHING HERE CHANGES BEHAVIOUR — no cap, no mount, no gate, no pacing/throttling/sleeping is
 * added anywhere in this diff, and the Q3 section (ranks 1-2) plus the "still synchronous, still
 * bounded" checks further down are what say so for ranks 3-5.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { realRiskJudge, riskJudgeSpendCollector, runRiskJudge, type RiskJudgeInput } from "../src/lib/risk-judge.js";
import { laneRunStartFields, runFixRung, runTask } from "../src/run-task.js";
import { buildDigest } from "../src/lib/digest.js";
import { groupSpendByAccount } from "../src/lib/ledger.js";
import { collectWorkerResult, workerLedgerFields } from "../src/lib/worker.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { GitHub } from "../src/lib/status.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

const JUDGE_MOUNT: Mount = { model: "haiku", effort: "low", maxTurns: 40, contextBudget: 40000 };
const FIX_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function worker(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

const JUDGE_INPUT: RiskJudgeInput = {
  change: { description: "W1-X — https://github.com/acme/r/pull/1", files: ["src/a.ts"] },
  gatesState: { review_state: "success", review_capped: false, ci: "green", arm_decision: "armed" },
  planContext: { taskId: "W1-X", taskType: "implement" },
};

function captureRows(): {
  rows: Array<{ step: string } & Record<string, unknown>>;
  log: (step: string, extra?: Record<string, unknown>) => void;
} {
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  return { rows, log: (step, extra) => rows.push({ step, ...(extra ?? {}) }) };
}

const PARSED_LOW = "RISK_VERDICT: low\nCONFIDENCE: 0.9\nREASONS:\n- nothing adverse";

// ══ RANK 1 — the risk judge prices itself ══════════════════════════════════════════════════════

test("W1-T2383 (rank 1): a driven risk-judge decision row carries the cost, the turns, the cap and the mount that spent them", async () => {
  const { rows, log } = captureRows();
  const spend = riskJudgeSpendCollector();
  await runRiskJudge(
    JUDGE_INPUT,
    {
      judge: realRiskJudge({
        mount: JUDGE_MOUNT,
        cwd: "/tmp",
        settingsFile: "/tmp/s.json",
        spend,
        spawn: async (args) =>
          worker({ text: PARSED_LOW, costUsd: 0.0123, numTurns: 4, maxTurns: args.maxTurns, accountLabel: "acct-A" }),
      }),
      escalate: () => "https://example.invalid/issues/1",
      log,
      spend,
    },
  );

  const row = rows.find((r) => r.step === "risk_judge.decision");
  assert.ok(row, "the decision row is still written");
  assert.equal(row!.cost_usd, 0.0123, "POPULATED, not declared — the real spawn's costUsd reached the row");
  assert.equal(row!.num_turns, 4);
  assert.equal(row!.max_turns, 40, "the cap rides BESIDE the count (W1-T303/W1-T2238), off the mount, never read back");
  assert.equal(row!.model, "haiku", "the tier whose price this makes readable");
  assert.equal(row!.effort, "low");
  assert.equal(row!.account_label, "acct-A", "so a spend reader credits the row instead of refusing it as unlabelled");
  assert.equal(row!.attempts, 1, "the healthy path spawns exactly once (W1-T2212)");
  assert.equal(row!.verdict, "low", "the verdict itself is untouched by measuring what it cost");
});

test("W1-T2383 (rank 1): a RETRIED judgment reports what every attempt cost, not only the last", async () => {
  const { rows, log } = captureRows();
  const spend = riskJudgeSpendCollector();
  let call = 0;
  await runRiskJudge(
    JUDGE_INPUT,
    {
      judge: realRiskJudge({
        mount: JUDGE_MOUNT,
        cwd: "/tmp",
        settingsFile: "/tmp/s.json",
        spend,
        spawn: async (args) => {
          call++;
          return worker({
            text: call === 1 ? "no verdict here at all" : PARSED_LOW,
            costUsd: call === 1 ? 0.02 : 0.03,
            numTurns: call,
            maxTurns: args.maxTurns,
          });
        },
      }),
      escalate: () => "https://example.invalid/issues/1",
      log,
      spend,
    },
  );

  const row = rows.find((r) => r.step === "risk_judge.decision")!;
  assert.equal(call, 2, "the unparseable first attempt really was retried");
  assert.equal(Number(row.cost_usd).toFixed(4), "0.0500", "an unparseable attempt still cost real money and is counted");
  assert.equal(row.num_turns, 3);
  assert.equal(row.attempts, 2);
});

test("W1-T2383 (rank 1): a judgment that SPAWNED NOTHING omits every spend key rather than reporting a zero", async () => {
  const { rows, log } = captureRows();
  const spend = riskJudgeSpendCollector();
  await runRiskJudge(
    JUDGE_INPUT,
    {
      judge: async () => {
        throw new Error("judge unavailable before any spawn");
      },
      escalate: () => "https://example.invalid/issues/1",
      log,
      spend,
    },
  );

  const row = rows.find((r) => r.step === "risk_judge.decision")!;
  assert.equal("cost_usd" in row, false, "a zero would read as 'measured, free' — absence is the honest report");
  assert.equal("model" in row, false);
  assert.equal("attempts" in row, false);
  assert.equal(row.verdict, "high", "and the fail-closed judge-unavailable verdict is unchanged");
});

test("W1-T2383 (rank 1): a caller that wires NO collector ledgers the row byte-identically to before this task", async () => {
  const { rows, log } = captureRows();
  await runRiskJudge(
    JUDGE_INPUT,
    {
      judge: async () => ({ verdict: "low" as const, confidence: 0.5, reasons: ["r"] }),
      escalate: () => "https://example.invalid/issues/1",
      log,
    },
  );
  const row = rows.find((r) => r.step === "risk_judge.decision")!;
  assert.deepEqual(Object.keys(row).sort(), ["action", "confidence", "reason", "reasons", "step", "verdict"]);
});

// ══ RANK 2 — the fix rung records the cap it ran under ═════════════════════════════════════════

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function review(state: "success" | "failure", criteria: CriterionVerdict[], headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "met" : "unmet",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

const issues: IssueGateway = { create: () => "https://example.invalid/issues/2" };

async function driveOneFixRound(spawnResult: WorkerResult): Promise<Array<{ step: string } & Record<string, unknown>>> {
  const { rows, log } = captureRows();
  await runFixRung({
    taskId: "W1-F",
    runId: "W1-F-1730000000000",
    task: { id: "W1-F", title: "A task" },
    prUrl: "https://github.com/acme/r/pull/9",
    branch: "run-W1-F-1730000000000",
    worktreePath: "/tmp/rmd-t2383-wt",
    initialSessionId: "session-0",
    mount: FIX_MOUNT,
    settingsFile: "/tmp/rmd-t2383-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "r", headCheckoutDir: "/tmp/rmd-t2383-wt", reviewerMount: FIX_MOUNT },
    strikeCap: 2,
    initialReview: review("failure", [criterion({ claim: "criterion A", met: false, reason: "r" })], "head0"),
    deps: {
      spawn: async () => spawnResult,
      waitForCiGreen: async () => ({ state: "green" }) as never,
      runReview: async () => review("success", [criterion({ claim: "criterion A", met: true })], "head1") as never,
      push: () => {},
      issues,
      ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-t2383-")), "ledger.ndjson"),
      log,
      say: () => {},
      account: (r: WorkerResult) => r,
    },
  });
  return rows;
}

test("W1-T2383 (rank 2): a driven fix.done row carries the cap it ran under, beside the turns it used", async () => {
  const rows = await driveOneFixRound(worker({ costUsd: 1.25, numTurns: 37, maxTurns: FIX_MOUNT.maxTurns, sessionId: "s1" }));
  const done = rows.find((r) => r.step === "fix.done");
  assert.ok(done, "the fix.done row is still written");
  assert.equal(done!.max_turns, 400, "POPULATED from SpawnWorkerArgs.maxTurns, i.e. the mount's cap");
  assert.equal(done!.num_turns, 37, "beside the count, never replacing it");
  assert.equal(done!.cost_usd, 1.25, "and every field the row already carried is unchanged");
});

test("W1-T2383 (rank 2): a spawn configured with NO cap omits max_turns rather than writing undefined", async () => {
  const rows = await driveOneFixRound(worker({ costUsd: 0.5, numTurns: 3, maxTurns: undefined, sessionId: "s2" }));
  const done = rows.find((r) => r.step === "fix.done")!;
  assert.equal("max_turns" in done, false, "never a guessed value — the same W1-T303 discipline");
  assert.equal(done.num_turns, 3);
});

// ══ Q3 — every reader of a touched row, shown unchanged ════════════════════════════════════════

test("W1-T2383 (Q3): the digest's cost total is step-gated on `verdict`, so a priced risk-judge row moves it by nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t2383-digest-"));
  const path = join(dir, "ledger.ndjson");
  const base = [
    { ts: "2026-08-27T10:00:00.000Z", run_id: "R", task_id: "W1-A", step: "verdict", verdict: "merged", cost_usd: 2 },
  ];
  const withJudge = [
    ...base,
    { ts: "2026-08-27T10:01:00.000Z", run_id: "R", task_id: "W1-A", step: "risk_judge.decision", verdict: "low", cost_usd: 99 },
  ];
  const render = (lines: Array<Record<string, unknown>>): string => {
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return buildDigest(path, "2026-08-27T00:00:00.000Z");
  };
  const before = render(base);
  const after = render(withJudge);
  const costLine = (s: string): string => s.split("\n").find((l) => l.includes("notional cost:")) ?? "";
  assert.equal(costLine(after), costLine(before), "the $99 judge row contributes nothing — the fold reads `verdict` rows only");
  assert.match(costLine(before), /notional cost: \$2\.00/, "CONTROL: the line really is the cost line and really carries the verdict row s 2 dollars");
});

test("W1-T2383 (Q3): the board's spend fold still reads only cost_usd and num_turns on implement.done/fix.done, so max_turns is inert there", () => {
  const src = readFileSync(new URL("../src/lib/board.ts", import.meta.url), "utf8");
  const from = src.indexOf('if (line.step !== "implement.done" && line.step !== "fix.done") continue;');
  assert.ok(from >= 0, "the fold must still exist under that exact predicate");
  const region = src.slice(from, from + 260);
  assert.match(region, /line\.cost_usd/);
  assert.match(region, /line\.num_turns/);
  assert.equal(/line\.max_turns/.test(region), false, "the added key is read by nothing in this fold");
});

test("W1-T2383 (Q3): the one step-agnostic spend reader credits the new row instead of refusing it as unlabelled", () => {
  const priced = groupSpendByAccount([
    { ts: "2026-08-27T10:00:00.000Z", step: "risk_judge.decision", cost_usd: 0.01, account_label: "acct-A" },
  ] as never);
  assert.deepEqual(priced.byAccount, [{ accountLabel: "acct-A", totalCostUsd: 0.01, lineCount: 1 }]);
  assert.equal(priced.refused.unlabelledCount, 0, "carrying account_label is what keeps this out of the refusal bucket");
});

// ══ RANK 3 — the triage and retro lanes get a run.start row ════════════════════════════════════

test("W1-T2383 (rank 3): laneRunStartFields names the LANE as type/task_class/mount_class, never 'implement'", () => {
  const triage = laneRunStartFields({ lane: "triage", repo: "acme/remudero", architect: "opus", worker: "sonnet" });
  const retro = laneRunStartFields({ lane: "retro", repo: "acme/remudero", architect: "opus", worker: "sonnet" });

  assert.equal(triage.type, "triage", "the field every existing run.start reader joins on now names the real lane");
  assert.equal(triage.task_class, "triage");
  assert.equal(triage.mount_class, "triage");
  assert.equal(triage.repo, "acme/remudero");
  assert.equal(triage.architect, "opus");
  assert.equal(triage.worker, "sonnet");
  assert.notEqual(triage.type, "implement", "the gap this closes: all 544 prior rows read implement regardless of lane");

  assert.equal(retro.type, "retro");
  assert.equal(retro.task_class, "retro");
  assert.equal(retro.mount_class, "retro");

  assert.deepEqual(
    Object.keys(triage).sort(),
    ["architect", "mount_class", "repo", "task_class", "type", "worker"],
    "deliberately NO mount object (no route exists for these lanes) — see the builder's own doc",
  );
});

test("W1-T2383 (rank 3): both lane call sites in src/run-task.ts actually LOG run.start through the shared builder", () => {
  const triageSite = runTaskSrc.match(/log\("run\.start",\s*laneRunStartFields\(\{\s*lane:\s*"triage"/);
  const retroSite = runTaskSrc.match(/log\("run\.start",\s*laneRunStartFields\(\{\s*lane:\s*"retro"/);
  assert.ok(triageSite, "the triage lane's run.start row must be built by the one shared builder, not a second, driftable literal");
  assert.ok(retroSite, "so must retro's — ONE builder, TWO call sites, per laneRunStartFields's own doc");
});

test("W1-T2383 (rank 3, Q3): laneRunStartFields is a pure, synchronous object literal — nothing here can pace, throttle or sleep a call", () => {
  const from = runTaskSrc.indexOf("export function laneRunStartFields(");
  assert.ok(from >= 0);
  const to = runTaskSrc.indexOf("\n}\n", from);
  const body = runTaskSrc.slice(from, to);
  assert.equal(/setTimeout|setInterval|\bsleep\s*\(|\bawait\b/.test(body), false, "a field builder that returns instantly cannot pace anything");
});

// ══ RANK 4 — compaction is populated, not declared-and-empty (already built — this drives it) ══

function compactionMessageStream(): AsyncIterable<unknown> {
  return (async function* (): AsyncGenerator<unknown> {
    yield { type: "assistant", message: { content: [{ type: "text", text: "working…" }] } };
    yield {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 150000, post_tokens: 12000, duration_ms: 2100 },
    };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "PR_URL: https://github.com/x/y/pull/1",
      session_id: "sess-t2383-compaction",
      total_cost_usd: 1.1,
      num_turns: 12,
      permission_denials: [],
    };
  })();
}

test("W1-T2383 (rank 4): a driven call's ledger line carries a POPULATED compaction_events, not a declared-and-empty key", async () => {
  const r = await collectWorkerResult(compactionMessageStream(), { childEnvKeys: [], compactionConfigured: true });
  const fields = workerLedgerFields(r);
  assert.deepEqual(fields.compaction_events, [{ trigger: "auto", preTokens: 150000, postTokens: 12000, durationMs: 2100 }]);
  assert.equal(fields.compaction_configured, true, "CONFIGURED rides beside the events — #2829's disabled/never-needed/failed split");
  assert.deepEqual(fields.compaction_failures, [], "no compact_result:'failed' status message in this stream");
  assert.equal(fields.quality_suspect, true, "one compaction fired, so the call is quality-suspect per isQualitySuspect");
});

test("W1-T2383 (rank 4): a call that never configures compaction reads compaction_configured=false, DISTINCT from a configured call that never needed it", async () => {
  const r = await collectWorkerResult(compactionMessageStream(), { childEnvKeys: [] });
  const fields = workerLedgerFields(r);
  assert.equal(fields.compaction_configured, false, "the default — no caller here set autoCompactEnabled, the same structural zero #2245/#2829 explain");
  assert.deepEqual(fields.compaction_events, [{ trigger: "auto", preTokens: 150000, postTokens: 12000, durationMs: 2100 }], "the events are read off the stream, independent of the configured flag");
});

test("W1-T2383 (rank 4, Q3): this shard adds no new compaction call site — autoCompactEnabled is still only ever READ, never assigned, in src/lib/worker.ts", () => {
  const workerSrc = readFileSync(new URL("../src/lib/worker.ts", import.meta.url), "utf8");
  const start = workerSrc.indexOf("const options: Options = {");
  const end = workerSrc.indexOf("const runQuery = args.queryFn");
  assert.ok(start > -1 && end > start, "expected the Options-construction region to still exist in worker.ts");
  assert.doesNotMatch(
    workerSrc.slice(start, end),
    /autoCompactEnabled/i,
    "turning the channel on is tuning, out of scope twice over (see test/compaction-zero-is-unexplained.test.ts)",
  );
  assert.doesNotMatch(workerSrc, /\.autoCompactEnabled\s*=(?!=)/, "no assignment form anywhere, only the read comparison below");
  assert.match(workerSrc, /\(options as Record<string, unknown>\)\.autoCompactEnabled === true/, "the read-only check feeding compactionConfigured is still here");
});

// ══ RANK 5 — a reused recon artifact is recorded, giving recon.invalidated a denominator ═══════

const RECON_REUSE_TASK_ID = "T-T2383-RECON-REUSE";

const RECON_REUSE_PLAN = [
  `- id: ${RECON_REUSE_TASK_ID}`,
  "  title: W1-T2383 rank 5 recon-reuse probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/widget.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

const RECON_REUSE_OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const reconReuseHoldingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const reconReuseCleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

/** A real, throwaway bare "origin" + a real clone at `repoDir` — mirrors
 *  test/recon-artifact-reuse.test.ts's own `gitFixture`, trimmed to what THIS one transition
 *  (absent → reused) needs; that file's own fixture proves the fuller absent/reused/invalidated
 *  lifecycle and is not re-proved here.
 *
 *  W1-T2510: the task's own record must ALSO live inside the worktree's `plan/` tree (a shard
 *  under `plan/tasks.d/`), not only at the separate `opts.planPath` this fixture already uses to
 *  tell the orchestrator which task to select — `plan_sha` is now `taskRecordSha`, read from the
 *  WORKTREE, same as `filesDigest` always has been. Without a committed shard, the record reads
 *  as ABSENT on every dispatch and can never validate a reuse, which would make the SECOND
 *  dispatch below (same task record, same files — a reuse) fail for a reason unrelated to what
 *  it is testing. */
function reconReuseGitFixture(root: string): void {
  const originGit = mkdtempSync(join(tmpdir(), "rmd-t2383-recon-reuse-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "rmd-t2383-recon-reuse-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "t2383-recon-reuse@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "t2383-recon-reuse"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "src", "widget.ts"), "export const widget = 1;\n");
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.d", "t-t2383-recon-reuse.yaml"), RECON_REUSE_PLAN);
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "t2383-recon-reuse@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "t2383-recon-reuse"]);
  rmSync(seed, { recursive: true, force: true });
}

function reconReuseFakeGh(): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "rmd-t2383-recon-reuse-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      "  if [[ \"$5\" == 'headRefName' ]]; then echo '{\"headRefName\":\"'$3'\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'; exit 0; fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

function reconReuseWorkerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

async function reconReuseDispatchOnce(
  t: import("node:test").TestContext,
  root: string,
  spawn: typeof spawnWorker,
  ts: number,
): Promise<Array<{ step: string } & Record<string, unknown>>> {
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, RECON_REUSE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };

  const fakeBinDir = reconReuseFakeGh();
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const dateNowSpy = t.mock.method(Date, "now", () => ts);

  const { withLiveWritesAllowed } = await import("../src/lib/live-write-guard.js");
  try {
    const res = await withLiveWritesAllowed(() =>
      runTask(RECON_REUSE_TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: RECON_REUSE_OFFLINE_GITHUB,
        spawn,
        containmentExec: reconReuseHoldingContainmentExec,
        isolationExec: reconReuseCleanIsolationExec,
      }),
    );
    const allLedger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    // Only THIS dispatch's own rows — the ledger file is cumulative across both calls in the
    // test below, exactly like test/recon-artifact-reuse.test.ts's own `dispatchOnce`.
    return allLedger.filter((l) => l.run_id === res.runId);
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
  }
}

test("W1-T2383 (rank 5): a SECOND dispatch of the same task at the same plan_sha/files_digest ledgers recon.reused, giving recon.invalidated a denominator", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t2383-recon-reuse-root-"));
  try {
    reconReuseGitFixture(root);

    const spawn1: typeof spawnWorker = async () =>
      reconReuseWorkerResult({
        sessionId: "s-recon-1",
        text: "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    const ledger1 = await reconReuseDispatchOnce(t, root, spawn1, 1787900000001);
    assert.equal(ledger1.filter((l) => l.step === "recon.absent").length, 1, "CONTROL: dispatch 1 has no prior artifact");
    assert.equal(ledger1.filter((l) => l.step === "recon.reused").length, 0);

    const spawn2: typeof spawnWorker = async () =>
      reconReuseWorkerResult({ sessionId: "s-implement-2", text: "REPORT\nPR_URL: https://github.com/acme/r/pull/2\n" });
    const ledger2 = await reconReuseDispatchOnce(t, root, spawn2, 1787900000002);

    const reused = ledger2.filter((l) => l.step === "recon.reused");
    assert.equal(reused.length, 1, "the SAME plan_sha/files_digest means the prior artifact is REUSED, not re-run — this is the row rank 5 adds");
    assert.ok("plan_sha" in reused[0] && "files_digest" in reused[0], "the row carries the key a reader would join recon.invalidated against");
    assert.equal(ledger2.filter((l) => l.step === "recon.absent").length, 0);
    assert.equal(ledger2.filter((l) => l.step === "recon.invalidated").length, 0, "reused and invalidated are mutually exclusive on the same dispatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2383 (rank 5, Q3): recon.reused/absent/invalidated logging adds no timer — the branch that decides them runs synchronously before any spawn", () => {
  const from = runTaskSrc.indexOf('log("recon.reused"');
  const to = runTaskSrc.indexOf('log("recon.absent"', from);
  assert.ok(from > 0 && to > from);
  const region = runTaskSrc.slice(from - 400, to + 200);
  assert.equal(/setTimeout|setInterval/.test(region), false, "the reuse/absent/invalidated decision itself never paces or sleeps");
});
