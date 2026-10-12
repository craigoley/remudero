import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildFixProgressInput, judgeFixProgress, parseFixProgressVerdict } from "../src/lib/fix-progress-judge.js";
import { productionFixProgressJudge, DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { runFixRung, buildFixRungDispatchArgs, readFixRoundCommitsViaGit } from "./helpers/run-task-test.js";
import type { ReviewRunResult } from "./helpers/run-task-test.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { gitRepo } from "./helpers/git-repo.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TASK = "W1-T7096";
const NOW = Date.now();
const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 7096, prUrl: "https://github.com/o/r/pull/7096", taskId: TASK,
  headSha: "head-3", checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 3, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  ciFailures: [{ name: "ci", logTail: "failure" }], ...over,
});
const rounds = (noOp = false): Record<string, unknown>[] => Array.from({ length: 3 }, (_, i) => [
  { task_id: TASK, step: "fix.dispatch", round_id: `round-${i}`, head_sha: noOp ? "head-3" : `head-${i}`,
    ci_failures: (noOp ? ["ci"] : ["ci", ...Array.from({ length: 3 - i }, (_, j) => `red-${j}`)]).map(check => ({ check })) },
  { task_id: TASK, step: "fix.done", round_id: `round-${i}`, head_sha: noOp ? "head-3" : `head-${i}`,
    pushed_head_sha: noOp ? undefined : `head-${i + 1}`, fix_outcome: noOp ? "NO_CHANGE" : "FIXED", subtype: "success" },
]).flat();

function sweepFixture(rows: Record<string, unknown>[], judge: NonNullable<SweepDeps["fixProgressJudge"]>) {
  const dispatched: unknown[] = [], escalated: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/progress-ledger", runId: "progress-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: judge, arm: () => {}, close: () => {},
    escalate: (_pr, reason) => { escalated.push(reason); },
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence); },
  };
  return { deps, dispatched, escalated };
}

describe("test/a-progress-judge-decides-the-next-fix-round.test.ts", () => {
  test("a shrinking red set earns a fourth dispatch past the old strike cap", async () => {
    const rows = rounds();
    let calls = 0;
    const f = sweepFixture(rows, async input => {
      calls++;
      assert.equal(input.rounds.length, 3);
      assert.deepEqual(input.rounds[2].redAfter, ["ci"]);
      return { verdict: "continue", reason: "each round removed a failing check" };
    });
    await runSweep([pr()], f.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(calls, 1);
    assert.equal(f.dispatched.length, 1);
    assert.deepEqual(f.escalated, []);
    assert.equal(rows.find(row => row.step === "fix.progress_judged")?.verdict, "continue");
  });

  test("three no-op rounds escalate with the loop the judge names", async () => {
    const rows = rounds(true);
    const f = sweepFixture(rows, async input => {
      assert.equal(input.signals.noOpRounds, 3);
      return { verdict: "escalate", loop: "three no-op rounds at the same head", reason: "no progress" };
    });
    await runSweep([pr()], f.deps);
    assert.equal(f.dispatched.length, 0);
    assert.equal(f.escalated.length, 1);
    assert.match(f.escalated[0], /three no-op rounds at the same head/);
    await runSweep([pr()], f.deps);
    assert.equal(f.escalated.length, 1, "an already delivered escalation holds until new evidence");
  });

  test("an absent or malformed verdict holds and re-asks next pass", async () => {
    const rows = rounds();
    let calls = 0;
    const f = sweepFixture(rows, async () => ++calls === 1 ? undefined : { verdict: "continue", reason: "new evidence" });
    await runSweep([pr()], f.deps);
    assert.equal(f.dispatched.length, 0);
    await runSweep([pr()], f.deps);
    assert.equal(calls, 2);
    assert.equal(f.dispatched.length, 1);
    assert.equal(parseFixProgressVerdict('{"verdict":"escalate","reason":"stop"}'), undefined);
    assert.equal(parseFixProgressVerdict('{"verdict":"change-approach","reason":"try"}'), undefined);
    assert.equal(parseFixProgressVerdict("garbage"), undefined);
  });

  test("change-approach is carried in worker evidence and operator answers reach the judge", async () => {
    const rows = rounds();
    const f = sweepFixture(rows, async input => {
      assert.equal(input.operatorAnswer, "keep the public API");
      return { verdict: "change-approach", approach: "reproduce the failing test first", reason: "patches repeated" };
    });
    await runSweep([pr({ pendingAnswer: { constraint: "keep the public API" } })], f.deps);
    assert.equal((f.dispatched[0] as { progressApproach: string }).progressApproach, "reproduce the failing test first");
  });

  test("pre-signals report repeated diff, oscillation, refusals and incomplete history without deciding", async () => {
    const rows = rounds(true);
    rows[2].ci_failures = [{ check: "other" }];
    rows[0].diff_stat = rows[2].diff_stat = "1 file changed";
    rows[0].diff_digest = rows[2].diff_digest = "same-patch";
    rows.push({ task_id: TASK, step: "fix.commit_refused", round_id: "round-2", reason: "nothing changed" });
    const input = buildFixProgressInput({ taskId: TASK, headSha: "head-3", currentRed: ["other"], ledger: rows });
    assert.equal(input.signals.identicalDiffs, 1);
    assert.equal(input.signals.oscillating, true);
    assert.equal(input.rounds[2].refusal, "nothing changed");
    const result = await judgeFixProgress(input, async () => ({ verdict: "continue", reason: "operator supplied new facts" }));
    assert.equal(result.verdict, "continue");
  });

  test("a proof-amendment identity row is not presented to the progress judge as a worker round", () => {
    const input = buildFixProgressInput({ taskId: TASK, headSha: "head-3", currentRed: ["ci"], ledger: [
      { task_id: TASK, step: "fix.dispatch", kind: "proof_amendment", identity_key: "amendment-1" },
      { task_id: TASK, step: "fix.dispatch", round_id: "worker-1", head_sha: "head-3", ci_failures: [{ check: "ci" }] },
      { task_id: TASK, step: "fix.done", round_id: "worker-1", head_sha: "head-3", subtype: "success" },
    ] });
    assert.deepEqual(input.rounds.map(round => round.id), ["worker-1"]);
  });

  test("a throwing judge yields unavailable with its reason", async () => {
    const input = buildFixProgressInput({ taskId: TASK, headSha: "head-3", currentRed: ["ci"], ledger: [] });
    const result = await judgeFixProgress(input, async () => { throw new Error("provider unavailable"); });
    assert.equal(result.verdict, "unavailable");
    assert.match(result.reason, /provider unavailable/);
  });

  test("the production judge reuses the risk mount and tool-free provider request", async () => {
    let prompt = "";
    const judge = productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json",
      mount: { model: "test-model", effort: "low", maxTurns: 1, contextBudget: 10000 }, spawn: async args => {
        prompt = args.prompt;
        assert.deepEqual(args.tools, []);
        assert.equal(args.model, "test-model");
        return { text: 'FIX_PROGRESS: {"verdict":"continue","reason":"red shrank"}' } as never;
      } });
    const result = await judge(buildFixProgressInput({ taskId: TASK, headSha: "h", currentRed: ["ci"], ledger: [] }));
    assert.equal(result?.verdict, "continue");
    assert.match(prompt, /stronger evidence/);
  });

  async function runRungFixture(mode: "shrinking" | "no-op" | "unavailable" = "shrinking") {
    const root = mkdtempSync(join(tmpdir(), "rmd-progress-"));
    const mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
    const review = (remaining: number): ReviewRunResult => ({
      state: remaining ? "failure" : "success", headSha: mode === "no-op" ? "head-0" : `head-${4 - remaining}`,
      criteria: Array.from({ length: remaining }, (_, i) => ({ claim: `claim-${i}`, proof: "unit test: claim",
        met: false, reason: "unmet", proof_exec: "executed_fail" })),
      testTheater: false, summary: "review", floorDegraded: false, capped: false,
      keywordOnly: false, planOnly: false, reviewerOutcome: "success",
    });
    const rows: Record<string, unknown>[] = [];
    let workers = 0, judgments = 0;
    const issueBodies: string[] = [];
    const outcome = await runFixRung({ taskId: TASK, runId: "rung-progress", task: { id: TASK, title: "progress" },
      prUrl: "https://github.com/o/r/pull/7096", branch: "run-W1-T7096-123", worktreePath: root,
      initialSessionId: "session", mount, settingsFile: "settings/worker.json", config: {} as never,
      budgetUsd: 1, strikeCap: 2, initialReview: review(4),
      progressDecision: { verdict: "continue", reason: "sweep admitted the first round" },
      reviewBase: { owner: "o", repo: "r", headCheckoutDir: root, reviewerMount: mount },
      escalationJudge: async () => ({ decision: "deliver", reason: "named loop" }),
      deps: {
        fixProgressJudge: async input => {
          judgments++;
          assert.equal(input.rounds.length, workers);
          if (mode === "unavailable") return undefined;
          if (mode === "no-op") {
            assert.equal(input.signals.noOpRounds, workers);
            return workers >= 3
              ? { verdict: "escalate", loop: "three no-op rounds on unchanged code", reason: "no progress" }
              : { verdict: "continue", reason: "request more evidence" };
          }
          assert.deepEqual(input.currentRed, Array.from({ length: 4 - workers }, (_, i) => `review:claim-${i}`));
          return { verdict: "continue", reason: "one fewer unmet criterion" };
        },
        spawn: async () => {
          workers++;
          return { sessionId: "session", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "",
            subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false };
        },
        waitForCiGreen: async () => "green", runReview: async () => review(mode === "shrinking" ? 4 - workers : 4),
        fetchPrBody: async () => `Remudero-Task: ${TASK}`, fetchPrDiffFiles: async () => [], push: () => {},
        issues: { create: (_title, body) => { issueBodies.push(body); return "https://github.com/o/r/issues/1"; } },
        ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => [],
        log: (step, fields) => { rows.push({ ...fields, step }); }, say: () => {}, account: r => r,
      },
    });
    return { outcome, workers, judgments, rows, issueBodies };
  }

  test("runFixRung asks again between shrinking rounds and reaches its fourth worker", async () => {
    const f = await runRungFixture();
    assert.equal(f.outcome.outcome, "fixed");
    assert.equal(f.workers, 4);
    assert.equal(f.judgments, 3);
    assert.equal(f.rows.filter(row => row.step === "fix.progress_judged").length, 3);
    assert.deepEqual(f.issueBodies, []);
  });

  test("runFixRung gives three no-op rounds to the judge and escalates its named loop", async () => {
    const f = await runRungFixture("no-op");
    assert.equal(f.outcome.outcome, "escalated");
    assert.equal(f.workers, 3);
    assert.equal(f.judgments, 3);
    assert.match(f.outcome.reason, /three no-op rounds on unchanged code/);
    assert.equal(f.issueBodies.length, 1);
    assert.match(f.issueBodies[0], /three no-op rounds on unchanged code/);
  });

  test("runFixRung hands an unavailable judgment back to the next sweep without another worker", async () => {
    const f = await runRungFixture("unavailable");
    assert.equal(f.outcome.outcome, "handed_off");
    assert.equal(f.workers, 1);
    assert.equal(f.judgments, 1);
    assert.match(f.outcome.reason, /absent or unparseable/);
    assert.deepEqual(f.issueBodies, []);
  });

  test("a metadata wait is judged again after the edited-event repair failed to clear the red", async () => {
    const rows = [{ task_id: TASK, step: "sweep.disposed", pr_number: 7096, head_sha: "head-3",
      metadata_red_checks: ["commitlint"], metadata_repair_outcome: "repaired", disposition: "blocked-fixable", acted: false }];
    let judged = false;
    const f = sweepFixture(rows, async input => {
      judged = true;
      assert.match(input.parkedReason!, /edited-event verdict/);
      return { verdict: "change-approach", approach: "inspect the current title", reason: "repair did not clear it" };
    });
    await runSweep([pr({ priorStrikes: 0, ciFailures: [{ name: "commitlint", logTail: "header invalid" }] })], f.deps);
    assert.equal(judged, true);
    assert.equal(f.dispatched.length, 1);
  });

  test("a metadata escalation is not asked or delivered twice for the same parked input", async () => {
    const rows: Record<string, unknown>[] = [{ task_id: TASK, step: "sweep.disposed", pr_number: 7096, head_sha: "head-3",
      metadata_red_checks: ["commitlint"], metadata_repair_outcome: "repaired", disposition: "blocked-fixable", acted: false }];
    let judged = 0;
    const f = sweepFixture(rows, async input => {
      judged++;
      assert.match(input.parkedReason!, /edited-event verdict/);
      return { verdict: "escalate", loop: "metadata repair did not clear the red", reason: "await new evidence" };
    });
    const metadataRed = pr({ priorStrikes: 0, ciFailures: [{ name: "commitlint", logTail: "header invalid" }] });

    await runSweep([metadataRed], f.deps);
    assert.equal(judged, 1);
    assert.equal(f.escalated.length, 1);
    assert.equal(typeof rows.findLast(row => row.step === "sweep.disposed")?.progress_escalated_key, "string");

    await runSweep([metadataRed], f.deps);
    assert.equal(judged, 1, "the identical parked input reuses its delivered escalation instead of asking again");
    assert.equal(f.escalated.length, 1, "an unchanged escalation is delivered only once");
    assert.equal(f.dispatched.length, 0);
  });

  test("an unavailable parked-path judgment stands down without dispatching or escalating", async () => {
    const rows: Record<string, unknown>[] = [{ task_id: TASK, step: "sweep.disposed", pr_number: 7096, head_sha: "head-3",
      metadata_red_checks: ["commitlint"], metadata_repair_outcome: "repaired", disposition: "blocked-fixable", acted: false }];
    let judged = 0;
    const f = sweepFixture(rows, async input => {
      judged++;
      assert.match(input.parkedReason!, /edited-event verdict/);
      return undefined;
    });

    await runSweep([pr({ priorStrikes: 0, ciFailures: [{ name: "commitlint", logTail: "header invalid" }] })], f.deps);

    assert.equal(judged, 1);
    assert.equal(rows.findLast(row => row.step === "fix.progress_judged")?.verdict, "unavailable");
    assert.equal(f.dispatched.length, 0);
    assert.equal(f.escalated.length, 0);
  });

  test("incomplete refused history waits once then returns to the judge", async () => {
    const rows: Record<string, unknown>[] = [
      { task_id: TASK, step: "sweep.disposed", pr_number: 7096, head_sha: "head-3",
        disposition: "blocked-fixable", acted: true, red_checks: ["ci"] },
      { task_id: TASK, step: "fix.commit_refused", head_sha: "head-3", reason: "missing receipt" },
    ];
    let judged = 0;
    const f = sweepFixture(rows, async input => {
      judged++;
      assert.match(input.parkedReason!, /incomplete round history/);
      return { verdict: "continue", reason: "recover missing receipt" };
    });
    await runSweep([pr()], f.deps);
    assert.equal(judged, 0);
    assert.equal(f.dispatched.length, 0);
    await runSweep([pr()], f.deps);
    assert.equal(judged, 1);
    assert.equal(f.dispatched.length, 1);
  });

  test("the dispatch builder carries the progress approach to the rung", () => {
    const mount = { model: "sonnet", effort: "medium", maxTurns: 1, contextBudget: 10000 };
    const args = buildFixRungDispatchArgs({ task: { id: TASK, title: "progress" } as never,
      runId: "test", prUrl: pr().prUrl, branch: "run-W1-T7096-1", worktreePath: "/tmp", mount,
      settingsFile: "settings/worker.json", config: {} as never, budgetUsd: 1, strikeCap: 2,
      evidence: { unmetCriteria: [], progressApproach: "reproduce before patching",
        progressDecision: { verdict: "change-approach", approach: "reproduce before patching", reason: "repeated diff" } },
      pr: pr(), reviewBase: { owner: "o", repo: "r", headCheckoutDir: "/tmp", reviewerMount: mount } });
    assert.equal(args.progressApproach, "reproduce before patching");
    assert.equal(args.progressDecision?.verdict, "change-approach");
  });
  test("proof-repair refusals beyond the former limit carry the judge's new approach into another round", async () => {
    const rows = rounds(true).flatMap((row, i) => i % 2 === 0 ? [row,
      { task_id: TASK, step: "fix.commit_refused", round_id: row.round_id, head_sha: "head-3", reason: "proof did not discriminate" }] : [row]);
    let judged = false;
    const f = sweepFixture(rows, async input => {
      judged = true;
      assert.equal(input.signals.refusedRounds, 3);
      assert.match(input.parkedReason!, /proof-repair refused 3/);
      return { verdict: "change-approach", approach: "propose a corrected proof", reason: "body edits cannot fix the proof" };
    });
    f.deps.repairMetadata = async () => ({ repaired: false, noCure: true, reason: "stale proof" });
    f.deps.readPlanRepairFacts = async () => ({ authorLogin: "remudero-fleet[bot]" }) as never;
    const proofLog = 'proof-discrimination: FAIL — 1 proof(s) pass at both PR head and merge base (abc123):\n  proof: unit test: stale proof\n  head hits: 1; base hits: 1';
    await runSweep([pr({ ciFailures: [{ name: "proof-discrimination", logTail: proofLog }],
      redRequiredChecks: ["proof-discrimination"], changedFiles: ["src/a.ts"] })], f.deps);
    assert.equal(judged, true, "the former refusal limit supplies evidence to the judge");
    assert.equal(f.dispatched.length, 1, "the judge authorizes another proof-repair worker round");
    assert.equal((f.dispatched[0] as { progressApproach: string }).progressApproach, "propose a corrected proof");
    assert.equal(rows.find(row => row.step === "fix.progress_judged")?.former_ceiling, 2);
    assert.deepEqual(f.escalated, []);
  });

  test("real round commit evidence records a diff stat and a patch digest", () => {
    const repo = gitRepo({ kind: "progress-diff" });
    const before = repo.git("rev-parse", "HEAD");
    writeFileSync(join(repo.dir, "change.txt"), "a real round\n");
    repo.git("add", "change.txt");
    repo.git("commit", "-m", "fix: change a file");
    const evidence = readFixRoundCommitsViaGit(repo.dir, before);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].changedFiles, 1);
    assert.match(evidence[0].diffStat!, /1 file changed/);
    assert.match(evidence[0].diffDigest!, /^[a-f0-9]{64}$/);
    assert.deepEqual(readFixRoundCommitsViaGit(repo.dir, before), evidence);
  });

  test("malformed progress responses and non-successful provider results never authorize dispatch", async () => {
    for (const text of ["null", "[]", '{"verdict":"other","reason":"guess"}',
      '{"verdict":"continue","reason":""}', '{"verdict":"change-approach","approach":"","reason":"try"}',
      '{"verdict":"escalate","loop":"","reason":"stop"}']) assert.equal(parseFixProgressVerdict(text), undefined);
    assert.deepEqual(parseFixProgressVerdict('```json\n{"verdict":"escalate","loop":"oscillating","reason":"red returns"}\n```'),
      { verdict: "escalate", loop: "oscillating", reason: "red returns" });
    const input = buildFixProgressInput({ taskId: TASK, headSha: "h", currentRed: ["ci"], ledger: [] });
    assert.equal((await judgeFixProgress(input)).verdict, "unavailable");
    const judge = productionFixProgressJudge({ cwd: process.cwd(), settingsFile: "settings/worker.json",
      spawn: async () => ({ subtype: "error", text: '{"verdict":"continue","reason":"ignore the failed call"}' }) as never });
    assert.equal(await judge(input), undefined);
  });
});
