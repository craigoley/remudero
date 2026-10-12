import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMainHealthRung } from "../src/lib/main-health-rung.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  BASE_RED_REFRESH_STEP,
  BASE_RED_STOOD_DOWN_STEP,
  baseRedHistoryFromLedger,
  decideBaseRed,
  mainLatestRunFromLedger,
  runSweep,
  type OpenPrView,
} from "./helpers/sweep-test.js";

const HEAD = "a".repeat(40);
const LAST = "b".repeat(40);
const NOW = Date.parse("2026-10-03T19:00:00Z");
const check = (name: string, conclusion: string | null) => ({ name, conclusion, status: conclusion ? "completed" : "in_progress" });
const pr = (names = ["lint-plan"]): OpenPrView => ({
  prNumber: 8920, prUrl: "https://github.com/o/r/pull/8920", taskId: "W1-T5490",
  headSha: HEAD, headRefName: "run-W1-T5490-1", checksState: "red", reviewState: "pending",
  unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW - 60_000).toISOString(),
  ciFailures: names.map((name) => ({ name, conclusion: "FAILURE", logTail: "AssertionError: inherited red" })),
});
const redMain = () => ({ step: "main.health.observed", sha: LAST, state: "red", failing_checks: ["ci"], observed_checks: ["ci", "build"] });

test("W1-T5490: a pull-request-only red waits while main is red", async () => {
  const rows: Record<string, unknown>[] = [redMain()];
  const dispatched: number[] = [];
  const updated: number[] = [];
  const run = () => runSweep([pr(), { ...pr(), prNumber: 9000, checksState: "green", reviewState: "success", ciFailures: undefined }], {
    ledgerPath: "/dev/null/t5490", runId: "T5490", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {},
    dispatchFix: (p) => { dispatched.push(p.prNumber); },
    updateBranch: (p) => { updated.push(p.prNumber); return "updated"; },
  });
  await run();
  await run();
  assert.deepEqual(dispatched, []);
  assert.deepEqual(updated, []);
  assert.equal(rows.filter((r) => r.step === BASE_RED_STOOD_DOWN_STEP).length, 1);
  assert.match(String(rows.find((r) => r.step === "sweep.disposed" && r.pr_number === 8920)?.stand_down_reason), /main.*red/);
  rows.push({ ...redMain(), sha: HEAD, state: "green", failing_checks: [] });
  await run();
  assert.deepEqual(updated, [8920]);
  assert.equal(rows.filter((r) => r.step === BASE_RED_REFRESH_STEP).length, 1);
  await run();
  assert.deepEqual(dispatched, [8920], "the existing one-refresh rule remains bounded");
});

test("W1-T5490: a check main ran green remains the PR's own, even beside an inherited red", () => {
  const main = mainLatestRunFromLedger([redMain()]);
  for (const names of [["build"], ["lint-plan", "build"], ["ci", "build"]]) {
    assert.deepEqual(decideBaseRed(pr(names), main, baseRedHistoryFromLedger([])), { kind: "own" });
  }
  assert.deepEqual(decideBaseRed(pr(["ci"]), main, baseRedHistoryFromLedger([])), { kind: "wait", check: "ci" });
});

test("W1-T5490: green, unknown and legacy observations retain their previous decisions", () => {
  for (const row of [{ ...redMain(), state: "green" }, { ...redMain(), state: "undetermined" },
    { step: "main.health.observed", sha: LAST, state: "red", failing_checks: ["ci"] }]) {
    assert.deepEqual(decideBaseRed(pr(), mainLatestRunFromLedger([row]), baseRedHistoryFromLedger([])), { kind: "own" });
  }
  assert.equal(mainLatestRunFromLedger([redMain()])?.sha, LAST);
});

type Run = { id: number; name: string; head_sha: string; conclusion: string };
async function observe(headChecks = [check("ci", "cancelled")], runs: Run[] = [], options: {
  jobs?: ReturnType<typeof check>[]; jobsFor?: (path: string) => ReturnType<typeof check>[] | undefined;
  historyError?: boolean; jobsError?: boolean; infra?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5490-"));
  const rows: Record<string, unknown>[] = [];
  const evidence: string[][] = [];
  const closed: string[] = [];
  const calls: string[] = [];
  const requeued: string[] = [];
  try {
    const rung = buildMainHealthRung("o", "r", {
      fetch: async (args) => {
        const path = args[1]!;
        calls.push(path);
        if (path === "repos/o/r") return { default_branch: "trunk" };
        if (path === "repos/o/r/commits/trunk") return { sha: HEAD };
        // W1-T6023: main's first-parent window, which a fallback run's head must sit in.
        if (path.startsWith("repos/o/r/commits?")) return [{ sha: HEAD, parents: [{ sha: LAST }] }, { sha: LAST, parents: [] }];
        if (path.includes("/check-runs?")) return { check_runs: headChecks };
        if (path.endsWith("/status")) return { statuses: [] };
        if (path.includes("/actions/runs?")) {
          if (options.historyError) throw new Error("history unavailable");
          return { workflow_runs: runs };
        }
        if (path.includes("/jobs?")) {
          if (options.jobsError) throw new Error("jobs unavailable");
          return { jobs: options.jobsFor?.(path) ?? options.jobs ?? [{ ...check("ci", "failure"), id: 42, html_url: "https://github.com/o/r/actions/runs/1/job/42" }, check("build", "success")] };
        }
        throw new Error(`unrouted: ${path}`);
      },
      issues: { create: () => "https://github.com/o/r/issues/1", listOpen: () => [], closeWithComment: (url) => { closed.push(url); } },
      ledgerPath: join(root, "ledger.ndjson"), runId: "T5490",
      log: (step, extra) => { rows.push({ step, ...extra }); },
      readRequiredChecks: () => ["ci", "build", "lint-plan", "claims", "coverage-ratchet"],
      readCiFailures: (rollup) => {
        evidence.push((rollup ?? []).map((c) => c.name!));
        if (!options.infra) return [];
        assert.equal(rollup?.[0]?.externalId, "job:42");
        return [{ name: "ci", conclusion: "FAILURE", jobId: "42", logTail: [
          "Artifact upload completed successfully!", "Finalizing artifact upload",
          "Failed to FinalizeArtifact: 403 Forbidden Error from intermediary",
        ].join("\n") }];
      },
      requeueCheck: (failure) => { requeued.push(failure.jobId!); return true; },
    });
    await rung();
    if (options.infra) await rung();
    return { observed: rows.find((r) => r.step === "main.health.observed")!, rows, evidence, calls, closed, requeued, ledger: readLedgerLines(join(root, "ledger.ndjson")) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const completed = (conclusion = "failure", name = "CI", head_sha = LAST, id = 1): Run => ({ id, name, head_sha, conclusion });

test("W1-T5490: a cancelled head falls back to the last completed main run", async () => {
  const r = await observe(undefined, [completed("cancelled", "CI", HEAD, 2), completed()]);
  assert.equal(r.observed.state, "red");
  assert.equal(r.observed.sha, HEAD);
  assert.equal(r.observed.decided_by_sha, LAST);
  assert.deepEqual(r.observed.failing_checks, ["ci"]);
  assert.deepEqual(r.observed.observed_checks, ["ci", "build"]);
  assert.deepEqual(r.evidence, [["ci", "build"]], "enrichment uses the deciding run's jobs");
  assert.ok(r.calls.includes("repos/o/r/actions/runs/1/jobs?per_page=100"));
  assert.equal(r.calls.filter((p) => p.includes("/actions/runs?")).length, 1, "history is shared with escalation");
});

test("W1-T5490: a completed run carrying no required check is passed over for one that does", async () => {
  const tripwireOnly = (path: string) => (path.includes("/runs/3/") ? [check("main-tripwire", "success")] : undefined);
  const r = await observe(undefined, [completed("success", "main-tripwire", HEAD, 3), completed()], { jobsFor: tripwireOnly });
  assert.equal(r.observed.state, "red");
  assert.equal(r.observed.decided_by_sha, LAST);
  assert.deepEqual(r.calls.filter((p) => p.includes("/jobs?")), ["repos/o/r/actions/runs/3/jobs?per_page=100", "repos/o/r/actions/runs/1/jobs?per_page=100"]);
});

test("W1-T5490: pending and absent heads use completed evidence, and a completed green run can recover", async () => {
  for (const headChecks of [[check("ci", null)], []]) {
    const r = await observe(headChecks, [completed("success")], { jobs: [check("ci", "success")] });
    assert.equal(r.observed.state, "green");
    assert.equal(r.observed.decided_by_sha, LAST);
  }
});

test("W1-T5490: main-plan-guard failure makes main red even when required CI is green", async () => {
  const r = await observe([check("ci", "success"), check("build", "success")], [completed("failure", "main-plan-guard", HEAD)]);
  assert.equal(r.observed.state, "red");
  assert.equal(r.observed.decided_by_sha, HEAD);
  assert.deepEqual(r.observed.failing_checks, ["main-plan-guard"]);
  const main = mainLatestRunFromLedger(r.rows);
  assert.deepEqual(decideBaseRed(pr(), main, baseRedHistoryFromLedger([])), { kind: "wait", check: "lint-plan" });
  assert.deepEqual(decideBaseRed(pr(["build"]), main, baseRedHistoryFromLedger([])), { kind: "own" });
});

test("W1-T5490: a guard's latest completed success supersedes its older failure without proving CI green", async () => {
  const r = await observe(undefined, [completed("success", "main-plan-guard", HEAD, 2), completed("failure", "main-plan-guard")]);
  assert.equal(r.observed.state, "undetermined");
  assert.deepEqual(r.observed.failing_checks, []);
});

test("W1-T5490: no completed history leaves a cancelled head undetermined", async () => {
  const r = await observe(undefined, [completed("cancelled")]);
  assert.equal(r.observed.state, "undetermined");
  assert.deepEqual(r.observed.failing_checks, []);
});

test("W1-T5490: unrelated failed workflows do not override a genuinely green head", async () => {
  const r = await observe([check("ci", "success")], [completed("failure", "heartbeat-watch")]);
  assert.equal(r.observed.state, "green");
  assert.equal(r.observed.decided_by_sha, HEAD);
});

test("W1-T5490: a current required red or tripwire red is never replaced by older green CI", async () => {
  for (const checks of [[check("ci", "failure")], [check("ci", null), check("main-tripwire", "failure")]]) {
    const r = await observe(checks, [completed("success")], { jobs: [check("ci", "success")] });
    assert.equal(r.observed.state, "red");
    assert.equal(r.observed.decided_by_sha, HEAD);
    assert.equal(r.calls.some((p) => p.includes("/jobs?")), false);
  }
});

test("W1-T5490: a cancelled guard cannot suppress the latest real guard failure", async () => {
  const r = await observe([check("ci", "success")], [completed("cancelled", "main-plan-guard", HEAD, 2), completed("failure", "main-plan-guard")]);
  assert.equal(r.observed.state, "red");
  assert.equal(r.observed.decided_by_sha, LAST);
});

test("W1-T5490: skipped and vacuous completed runs do not prove main green", async () => {
  const r = await observe(undefined, [completed("success")], { jobs: [check("ci", "skipped"), check("coverage-ratchet", "success")] });
  assert.equal(r.observed.state, "undetermined");
});

test("W1-T5490: unreadable history preserves a current verdict and names the missing evidence", async () => {
  for (const [checks, state] of [[[], "undetermined"], [[check("ci", "failure")], "red"], [[check("ci", "success")], "green"]] as const) {
    const r = await observe([...checks], [], { historyError: true });
    assert.equal(r.observed.state, state);
    assert.ok(r.rows.some((r) => r.step === "main.health.run_history_unreadable"));
  }
});

test("W1-T5490: unreadable fallback jobs leave main undetermined and name the failed read", async () => {
  const r = await observe([check("ci", null)], [completed()], { jobsError: true });
  assert.equal(r.observed.state, "undetermined");
  assert.ok(r.rows.some((r) => r.step === "main.health.completed_run_unreadable"));
});

test("W1-T5490: infrastructure retries from fallback evidence are bounded by the deciding SHA", async () => {
  const r = await observe(undefined, [completed()], { infra: true });
  assert.deepEqual(r.requeued, ["42"]);
  const attempts = r.ledger.filter((row) => row.step === "sweep.check_requeued");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.head_sha, LAST);
  assert.ok(r.rows.some((row) => row.step === "main.health.escalated"), "a repeated infrastructure red escalates after its one retry");
});

// 2026-10-10: main red on test-slow-shard (2/2) alone held eight PRs whose reds were coverage
// shards main ran GREEN — the census held only ci-gate's required aggregates, never a shard name.
test("base red census: a shard main ran green beside a red required aggregate is the PR's own red", async () => {
  const r = await observe([check("ci", "failure"), check("build", "success"), check("coverage-shard (2/8)", "success"),
    check("test-slow-shard (2/2)", "failure"), check("coverage-shard (5/8)", null)]);
  assert.equal(r.observed.state, "red");
  const main = mainLatestRunFromLedger(r.rows);
  const none = baseRedHistoryFromLedger([]);
  assert.deepEqual(decideBaseRed(pr(["coverage-shard (2/8)"]), main, none), { kind: "own" });
  assert.deepEqual(decideBaseRed(pr(["test-slow-shard (2/2)"]), main, none), { kind: "wait", check: "test-slow-shard (2/2)" });
  assert.deepEqual(decideBaseRed(pr(["coverage-shard (5/8)"]), main, none), { kind: "wait", check: "coverage-shard (5/8)" },
    "a shard still running on main is not evidence it passed");
});

test("base red census: a held head never claims main fails its check while main is undetermined", async () => {
  const rows: Record<string, unknown>[] = [redMain()];
  const run = () => runSweep([pr(["ci"])], {
    ledgerPath: "/dev/null/t5490", runId: "T5490", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {},
    dispatchFix: () => {}, updateBranch: () => "updated",
  });
  await run();
  rows.push({ step: "main.health.observed", sha: HEAD, state: "undetermined", failing_checks: [], observed_checks: [] });
  await run();
  const reason = String(rows.filter((r) => r.step === "sweep.disposed" && r.pr_number === 8920).at(-1)?.stand_down_reason);
  assert.doesNotMatch(reason, /also fails on main/);
  assert.match(reason, /main is undetermined at a{40}, not yet green/);
});
