import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import * as review from "../src/lib/review.js";
import { shadowJudgeSampled } from "../src/lib/shadow-judge.js";
import { WorkerAbandonedError, type SpawnWorkerArgs, type WorkerResult } from "../src/lib/worker.js";
import { runReview } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

function result(sessionId: string, overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId, costUsd: 0.12, numTurns: 2, text: "", blocks: [], stderr: "",
    subtype: "error_exit_null", isError: true, apiError: false, permissionDenials: [],
    childEnvKeys: [], model: "sonnet", effort: "high", provider: "claude",
    tokens: { input: 12, output: 3, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false, ...overrides,
  };
}

const signal = (name: string, sessionId: string) => result(sessionId, { exit: { kind: "signal", signal: name } });
const success = (sessionId: string) => result(sessionId, {
  exit: { kind: "exit", code: 0 }, subtype: "success", isError: false,
  text: "REVIEW_VERDICT 1: FAIL — the semantic reviewer rejects this change",
});
const crash = (sessionId: string) => result(sessionId, { exit: { kind: "exit", code: 1 }, subtype: "error_exit_1" });
const abandoned = () => new WorkerAbandonedError({ elapsedMs: 2000, boundMs: 1234 });

async function fixture(
  results: (WorkerResult | Error)[],
  mutateAttempt?: number,
) {
  const repo = gitRepo({ kind: "reviewer-rerun" });
  const oldPath = process.env.PATH;
  let shim: ReturnType<typeof ghShim> | undefined;
  try {
    mkdirSync(join(repo.dir, "src"));
    writeFileSync(join(repo.dir, "src", "example.ts"), "export const fixed = true;\n");
    repo.git("add", "src/example.ts");
    repo.git("commit", "-qm", "fixture source");
    const headSha = repo.git("rev-parse", "HEAD");
    const prUrl = "https://github.com/acme/remudero/pull/1";
    const acceptance = [
      { claim: "the fixed source is present", proof: "the fixed source is present" },
      { claim: "the fixed source is present", proof: "grep: fixed in src/example.ts" },
    ];
    const diff = "diff --git a/src/example.ts b/src/example.ts\n+export const fixed = true;\n";
    let report = "";
    for (let i = 0; i < 1000; i += 1) {
      const candidate = `the fixed source is present (${i})`;
      const digest = review.reviewDecisionDigest({ headSha, diff, report: candidate, body: candidate,
        acceptance, declaredFiles: ["src/example.ts"] });
      if (!shadowJudgeSampled(`review:${prUrl}:${headSha}:${digest}`)) {
        report = candidate;
        break;
      }
    }
    assert.ok(report, "exclude the independent shadow reviewer from attempt counts");
    shim = ghShim([
      { when: "pulls/1", stdout: JSON.stringify({ number: 1, state: "open", body: report,
        head: { ref: "fixture", sha: headSha }, html_url: prUrl }) },
      { when: "pr diff", stdout: diff.trim() },
      { when: "api", stdout: "{}" },
    ]);
    process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
    const rows: { step: string; fields: Record<string, unknown> }[] = [];
    const spawns: SpawnWorkerArgs[] = [];
    const accounted: WorkerResult[] = [];
    const args: Parameters<typeof runReview>[0] = {
      owner: "acme", repo: "remudero", prUrl,
      task: { id: "W1-T6094", files: ["src/example.ts"], acceptance },
      report, settingsFile: join(repo.dir, "settings.json"),
      config: { root: repo.dir, claudeBin: "/unused" } as Parameters<typeof runReview>[0]["config"],
      log: (step, fields = {}) => {
        rows.push({ step, fields });
        appendLedger(join(repo.dir, ".git", "ledger.ndjson"), {
          ts: new Date().toISOString(), run_id: "review-rerun", task_id: "W1-T6094", step, ...fields,
        });
      }, say: () => {},
      account: (r) => { accounted.push(r); return r; },
      reviewerSpawnWorker: async (spawnArgs) => {
        spawns.push(spawnArgs);
        assert.equal(repo.git("-C", spawnArgs.cwd, "rev-parse", "HEAD"), headSha);
        assert.equal(repo.git("-C", spawnArgs.cwd, "status", "--porcelain"), "");
        assert.equal(spawnArgs.resumeSessionId, undefined);
        assert.equal("forkSession" in spawnArgs, false);
        assert.equal((await runReview(args)).decisionDisposition, "in_flight");
        if (spawns.length === mutateAttempt) {
          writeFileSync(join(spawnArgs.cwd, "mutation.txt"), "invalid review snapshot\n");
        }
        const next = results[spawns.length - 1];
        assert.ok(next, "only the authorized attempts may spawn");
        if (next instanceof Error) throw next;
        return next;
      },
      reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 },
      reviewerClockBoundMs: 1234, budgetUsd: 0.5,
      headCheckoutDir: repo.dir, ledgerPath: join(repo.dir, ".git", "ledger.ndjson"), runId: "review-rerun",
      readReviewReuseFacts: () => undefined, disarm: () => "not-armed", arm: () => "ledger-refused",
    };
    const verdict = await runReview(args);
    assert.equal(repo.git("status", "--porcelain"), "");
    for (const spawn of spawns) assert.equal(existsSync(spawn.cwd), false);
    if (spawns.length === 2) {
      for (const key of ["cwd", "prompt", "model", "effort", "maxTurns", "maxBudgetUsd", "clockBound",
        "tools", "sandboxIntent", "sandboxReadRoots", "mountProvider"] as const) {
        assert.deepEqual(spawns[1]![key], spawns[0]![key], `the rerun preserves ${key}`);
      }
    }
    return { verdict, rows, spawns, accounted, calls: shim.calls(), headSha,
      replay: await runReview(args) };
  } finally {
    process.env.PATH = oldPath;
    repo.cleanup();
    if (shim) rmSync(shim.dir, { recursive: true, force: true });
  }
}

test("test/a-signal-ended-reviewer-is-re-run-once.test.ts", async (t) => {
  await t.test("the review library permits only the first observed signal to rerun", () => {
    assert.equal(review.reviewerRerunDecision(signal("SIGTERM", "first")), "rerun");
    assert.equal(review.reviewerRerunDecision(signal("SIGKILL", "second"), "SIGTERM"), "accept");
    assert.equal(review.reviewerRerunDecision(signal("SIGTERM", "second"), ""), "accept");
    for (const r of [crash("crash"), success("success"), result("legacy"),
      result("budget", { subtype: "error_max_budget_usd" }),
      result("unknown", { exit: { kind: "unobserved" } })]) {
      assert.equal(review.reviewerRerunDecision(r), "accept");
    }
  });

  await t.test("SIGTERM reruns once and posts the rerun's semantic verdict", async () => {
    const first = signal("SIGTERM", "first");
    const second = success("second");
    const f = await fixture([first, second]);
    assert.equal(f.spawns.length, 2);
    assert.deepEqual(f.accounted, [first, second]);
    assert.equal(f.verdict.state, "failure");
    assert.equal(f.verdict.reviewerOutcome, "success");
    assert.equal(f.verdict.evaluatorProvenance?.sessionId, "second");
    assert.equal(f.rows.find((r) => r.step === "review.reviewer")?.fields.session_id, "second");
    assert.equal(f.rows.filter((r) => r.step === "review.reviewer.rerun").length, 1);
    assert.equal(f.rows.find((r) => r.step === "review.reviewer.rerun")?.fields.first_signal, "SIGTERM");
    assert.equal(f.rows.find((r) => r.step === "review.reviewer.rerun")?.fields.session_id, "first");
    assert.equal(f.rows.some((r) => r.step === "review.reviewer.signal_ended_twice"), false);
    assert.ok(f.calls.some((call) => call.includes(`/statuses/${f.headSha}`) && call.includes("state=failure")));
    assert.equal(f.replay.decisionDisposition, "replayed");
  });

  await t.test("two signals post the floor alone and ledger both signal names", async () => {
    const f = await fixture([signal("SIGTERM", "first"), signal("SIGKILL", "second")]);
    assert.equal(f.spawns.length, 2);
    assert.equal(f.accounted.length, 2);
    assert.equal(f.verdict.state, "success");
    assert.equal(f.verdict.reviewerOutcome, "signal_terminated");
    const twice = f.rows.filter((r) => r.step === "review.reviewer.signal_ended_twice");
    assert.equal(twice.length, 1);
    assert.equal(twice[0]!.fields.first_signal, "SIGTERM");
    assert.equal(twice[0]!.fields.second_signal, "SIGKILL");
    const posted = f.rows.find((r) => r.step === "review.posted");
    assert.equal(posted?.fields.reviewer_outcome, "signal_terminated");
    assert.equal(posted?.fields.state, "success");
    assert.ok(f.calls.some((call) => call.includes(`/statuses/${f.headSha}`) && call.includes("state=success")));
  });

  for (const ending of [crash("first"), success("first"),
    result("first", { subtype: "error_max_budget_usd" }), new Error("spawn failed"), abandoned()]) {
    await t.test(`a first ${ending instanceof Error ? ending.name : ending.subtype} never reruns`, async () => {
      const f = await fixture([ending]);
      assert.equal(f.spawns.length, 1);
      assert.equal(f.rows.some((r) => r.step === "review.reviewer.rerun"), false);
      if (ending instanceof WorkerAbandonedError) {
        assert.equal(f.rows.filter((r) => r.step === "review.reviewer.abandoned").length, 1);
      }
    });
  }

  for (const ending of [crash("second"), result("second", { subtype: "error_max_budget_usd" }),
    new Error("rerun failed"), abandoned()]) {
    await t.test(`a rerun ${ending instanceof Error ? ending.name : ending.subtype} never gets a third attempt`, async () => {
      const f = await fixture([signal("SIGTERM", "first"), ending]);
      assert.equal(f.spawns.length, 2);
      assert.equal(f.verdict.state, "success");
      assert.equal(f.verdict.reviewerOutcome, ending instanceof Error ? "spawn_error" : ending.subtype);
      assert.equal(f.rows.some((r) => r.step === "review.reviewer.signal_ended_twice"), false);
      if (ending instanceof WorkerAbandonedError) {
        assert.equal(f.rows.filter((r) => r.step === "review.reviewer.abandoned").length, 1);
      }
    });
  }

  for (const attempt of [1, 2]) {
    await t.test(`snapshot integrity rejects mutation on attempt ${attempt}`, async () => {
      const f = await fixture([signal("SIGTERM", "first"), success("second")], attempt);
      assert.equal(f.spawns.length, attempt);
      assert.equal(f.verdict.state, "success");
      assert.equal(f.verdict.reviewerOutcome, "spawn_error");
      assert.equal(f.rows.find((r) => r.step === "review.reviewer.integrity_error")?.fields.reason, "dirty");
    });
  }
});
