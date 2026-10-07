import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { reviewDecisionDigest, reviewerOutcome } from "../src/lib/review.js";
import { shadowJudgeSampled } from "../src/lib/shadow-judge.js";
import { workerLedgerFields, type WorkerExit, type WorkerResult } from "../src/lib/worker.js";
import { runReview, workerErrorVerdict } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

function result(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "worker-ended", costUsd: 0.12, numTurns: 2, text: "", blocks: [], stderr: "",
    subtype: "error_exit_null", isError: true, apiError: false, permissionDenials: [],
    childEnvKeys: [], model: "gpt-6.1-sol", effort: "high",
    tokens: { input: 12, output: 3, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false, ...overrides,
  };
}

function exitFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => key.startsWith("worker_exit")));
}

test("test/every-lane-records-how-its-worker-ended.test.ts", async (t) => {
  for (const [exit, expected] of [
    [{ kind: "signal", signal: "SIGTERM" }, { worker_exit: "signal", worker_exit_signal: "SIGTERM" }],
    [{ kind: "signal", signal: "SIGKILL" }, { worker_exit: "signal", worker_exit_signal: "SIGKILL" }],
    [{ kind: "exit", code: 1 }, { worker_exit: "exit", worker_exit_code: 1 }],
    [{ kind: "exit", code: 0 }, { worker_exit: "exit", worker_exit_code: 0 }],
    [{ kind: "unobserved" }, { worker_exit: "unobserved" }],
    [undefined, {}],
  ] as [WorkerExit | undefined, Record<string, unknown>][]) {
    await t.test(`worker row records ${JSON.stringify(exit)}`, () => {
      const fields = workerLedgerFields(result({ exit }));
      assert.deepEqual(exitFields(fields), expected);
      assert.deepEqual(exitFields(JSON.parse(JSON.stringify(fields))), expected);
    });
  }

  await t.test("reviewer outcome distinguishes signals from crashes and preserves other outcomes", () => {
    for (const subtype of ["error_exit_null", "error_codex"]) {
      assert.equal(reviewerOutcome({ attempted: true, subtype,
        exit: { kind: "signal", signal: "SIGTERM" } }), "signal_terminated");
    }
    assert.equal(reviewerOutcome({ attempted: true, subtype: "error_exit_1",
      exit: { kind: "exit", code: 1 } }), "error_exit_1");
    assert.equal(reviewerOutcome({ attempted: true, subtype: "success",
      exit: { kind: "exit", code: 0 } }), "success");
    assert.equal(reviewerOutcome({ attempted: true, subtype: "error_codex",
      exit: { kind: "unobserved" } }), "error_codex");
    assert.equal(reviewerOutcome({ attempted: true, subtype: "error_exit_null" }), "error_exit_null");
    assert.equal(reviewerOutcome({ attempted: true }), "unknown");
    assert.equal(reviewerOutcome({ attempted: false }), "not_attempted");
    assert.equal(reviewerOutcome({ attempted: true, spawnError: true }), "spawn_error");
    assert.equal(reviewerOutcome({ attempted: false, planOnlySkip: true }), "not_attempted_plan_only");
  });

  await t.test("implement signal failure names the observed signal without changing verdict or spend", () => {
    for (const stage of ["implement", "recon", "resume"]) {
      for (const subtype of ["error_exit_null", "error_codex"]) {
        const verdict = workerErrorVerdict(result({ subtype, exit: { kind: "signal", signal: "SIGTERM" } }), 0.9, stage);
        assert.ok(verdict);
        assert.equal(verdict.verdict, "failed");
        assert.equal(verdict.budgetBreach, false);
        assert.equal(verdict.ledger.reason, `worker ended by signal SIGTERM at ${stage}`);
        assert.deepEqual(exitFields(verdict.ledger), { worker_exit: "signal", worker_exit_signal: "SIGTERM" });
        assert.equal(verdict.ledger.cost_usd, 0.9);
        assert.equal(verdict.ledger.num_turns, 2);
      }
    }
    const crashed = workerErrorVerdict(result({ subtype: "error_exit_1", exit: { kind: "exit", code: 1 } }), 0.9, "implement");
    assert.ok(crashed);
    assert.equal(crashed.verdict, "failed");
    assert.equal(crashed.ledger.reason, "worker error at implement: error_exit_1");
    assert.deepEqual(exitFields(crashed.ledger), { worker_exit: "exit", worker_exit_code: 1 });
    const unobserved = workerErrorVerdict(result({ exit: { kind: "unobserved" } }), 0.9, "implement");
    assert.ok(unobserved);
    assert.deepEqual(exitFields(unobserved.ledger), { worker_exit: "unobserved" });
    const legacy = workerErrorVerdict(result(), 0.9, "implement");
    assert.ok(legacy);
    assert.deepEqual(exitFields(legacy.ledger), {});
    assert.equal(workerErrorVerdict(result({ subtype: "success" }), 0.9, "implement"), null);
    assert.equal(workerErrorVerdict(result({ isError: false }), 0.9, "implement"), null);
    const budget = workerErrorVerdict(result({ subtype: "error_max_budget_usd" }), 0.9, "implement");
    assert.ok(budget);
    assert.equal(budget.verdict, "blocked_budget");
    assert.equal(budget.budgetBreach, true);
    assert.match(budget.ledger.reason, /worker breached maxBudgetUsd/);
  });

  for (const [exit, subtype, outcome] of [
    [{ kind: "signal", signal: "SIGTERM" }, "error_exit_null", "signal_terminated"],
    [{ kind: "exit", code: 1 }, "error_exit_1", "error_exit_1"],
  ] as [WorkerExit, string, string][]) {
    await t.test(`review lane posts the floor verdict after ${outcome}`, async () => {
      const repo = gitRepo({ kind: "worker-end-review" });
      const oldPath = process.env.PATH;
      try {
        mkdirSync(join(repo.dir, "src"));
        writeFileSync(join(repo.dir, "src", "example.ts"), "export const fixed = true;\n");
        repo.git("add", "src/example.ts");
        repo.git("commit", "-qm", "fixture source");
        const headSha = repo.git("rev-parse", "HEAD");
        const acceptance = [{ claim: "the fixed source is present", proof: "grep: fixed in src/example.ts" }];
        const diff = "diff --git a/src/example.ts b/src/example.ts\n+export const fixed = true;\n";
        let report = "";
        for (let i = 0; i < 1000; i += 1) {
          const candidate = `the fixed source is present (${i})`;
          const digest = reviewDecisionDigest({ headSha, diff, report: candidate, body: candidate,
            acceptance, declaredFiles: ["src/example.ts"] });
          if (!shadowJudgeSampled(`review:https://github.com/acme/remudero/pull/1:${headSha}:${digest}`)) {
            report = candidate;
            break;
          }
        }
        assert.ok(report);
        const shim = ghShim([
          { when: "pulls/1", stdout: JSON.stringify({ number: 1, state: "open", body: report,
            head: { ref: "fixture", sha: headSha }, html_url: "https://github.com/acme/remudero/pull/1" }) },
          { when: "pr diff", stdout: "diff --git a/src/example.ts b/src/example.ts\n+export const fixed = true;" },
          { when: "api", stdout: "{}" },
        ]);
        process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
        const rows: { step: string; fields: Record<string, unknown> }[] = [];
        const messages: string[] = [];
        let calls = 0;
        const verdict = await runReview({
          owner: "acme", repo: "remudero", prUrl: "https://github.com/acme/remudero/pull/1",
          task: { id: "W1-T6074", files: ["src/example.ts"],
            acceptance },
          report, settingsFile: join(repo.dir, "settings.json"),
          config: { root: repo.dir, claudeBin: "/unused" } as Parameters<typeof runReview>[0]["config"],
          log: (step, fields = {}) => { rows.push({ step, fields }); }, say: (message) => { messages.push(message); }, account: (r) => r,
          reviewerSpawnWorker: async () => { calls += 1; return result({ exit, subtype }); },
          reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 },
          headCheckoutDir: repo.dir, ledgerPath: join(repo.dir, "ledger.ndjson"), runId: `review-${outcome}`,
          readReviewReuseFacts: () => undefined, disarm: () => "not-armed", arm: () => "ledger-refused",
        });
        assert.equal(calls, 1);
        assert.equal(verdict.state, "success");
        assert.equal(verdict.reviewerOutcome, outcome);
        const reviewerRow = rows.find((row) => row.step === "review.reviewer");
        assert.ok(reviewerRow);
        assert.deepEqual(exitFields(reviewerRow.fields), exit.kind === "signal"
          ? { worker_exit: "signal", worker_exit_signal: "SIGTERM" }
          : { worker_exit: "exit", worker_exit_code: 1 });
        const posted = rows.find((row) => row.step === "review.posted");
        assert.ok(posted, JSON.stringify({ messages, rows }));
        assert.equal(posted.fields.reviewer_outcome, outcome);
        assert.equal(posted.fields.state, "success");
        assert.ok(shim.calls().some((call) => call.includes(`/statuses/${headSha}`) && call.includes("state=success")));
      } finally {
        process.env.PATH = oldPath;
        repo.cleanup();
      }
    });
  }
});
