/**
 * W1-T14493: security-merge-policy posted `error` while the exact head's CodeQL run was still going, so a pull request
 * that was only waiting read as red. While that run is queued or in progress (and inside its bound), a decision that only
 * awaits the CodeQL result posts `pending`; every other case posts what it did before, and nothing new allows merge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error — trusted metadata script is plain ESM, outside tsconfig source roots.
import { CODEQL_RUN_PENDING_BOUND_MS, codeqlRunInFlight, publishSecurityMergeDecision } from "#src/lib/code-scanning-merge-adapter.mjs";

const head = "a".repeat(40), base = "b".repeat(40);
const target = { owner: "craigoley", repo: "remudero", prNumber: 11468, expectedHead: head };
const NOW = Date.parse("2026-11-24T12:00:00Z");
const pr = () => ({ state: "open", head: { sha: head }, base: { sha: base, ref: "main", repo: { full_name: "craigoley/remudero" } }, changed_files: 1 });
const codeqlCheck = (status: string) => ({ id: 7, name: "CodeQL", head_sha: head, status, conclusion: status === "completed" ? "success" : null,
  app: { id: 57789, slug: "github-advanced-security", owner: { login: "github" } }, output: { title: "", summary: "" } });
const run = (over: Record<string, unknown> = {}) => ({ id: 9, path: ".github/workflows/codeql.yml", head_sha: head, status: "in_progress",
  run_started_at: new Date(NOW - 5 * 60_000).toISOString(), repository: { full_name: "craigoley/remudero" }, ...over });

/** A pinned read: the PR, one source file, the given check corpus and the given workflow-run page (or a throw). */
function api(checks: unknown[], runs: unknown[] | "throw" | "malformed", now: number | undefined = NOW) {
  const statuses: { state: string; description: string }[] = [];
  const read = async (path: string) => {
    if (path.includes("/actions/runs?")) {
      if (runs === "throw") throw Error("actions api unavailable");
      return runs === "malformed" ? { workflow_runs: null } : { total_count: runs.length, workflow_runs: runs };
    }
    if (path.includes("/files?")) return [{ filename: "src/a.ts" }];
    if (path.includes("/check-runs?")) return { total_count: checks.length, check_runs: checks };
    return pr();
  };
  return { statuses, api: { read, status: async (s: { state: string; description: string }) => { statuses.push(s); },
    ...(now === undefined ? {} : { now: () => now }) } };
}

test("W1-T14493: a missing codeql result with a running exact-head codeql run posts pending", async () => {
  for (const [checks, reason] of [[[], "trusted-exact-head-codeql-result-missing"], [[codeqlCheck("in_progress")], "security-analysis-pending"]] as const) {
    for (const status of ["queued", "in_progress"]) {
      const f = api([...checks], [run({ status })]);
      const result = await publishSecurityMergeDecision(target, f.api, "https://example.invalid/run");
      assert.equal(result.published, true);
      assert.equal(result.decision.reason, reason);
      assert.equal(f.statuses[0]!.state, "pending", `${reason} with a ${status} run`);
      assert.equal(f.statuses[0]!.description, `unknown: ${reason}`);
    }
  }
  // The newest of two runs decides: a re-run in progress after a finished one is still waiting.
  const rerun = api([], [run({ id: 3, status: "completed" }), run({ id: 4 })]);
  await publishSecurityMergeDecision(target, rerun.api, undefined);
  assert.equal(rerun.statuses[0]!.state, "pending");
  // Without an injected clock the real one is read; a run started a moment ago is inside the bound.
  const realClock = api([], [run({ run_started_at: new Date().toISOString() })], undefined);
  await publishSecurityMergeDecision(target, realClock.api, undefined);
  assert.equal(realClock.statuses[0]!.state, "pending");
});

test("W1-T14493: a finished absent unreadable or overdue codeql run still posts error", async () => {
  const overdue = new Date(NOW - CODEQL_RUN_PENDING_BOUND_MS - 1).toISOString();
  const cases: [string, unknown[] | "throw" | "malformed"][] = [
    ["a completed run", [run({ status: "completed" })]],
    ["no run", []],
    ["an unreadable run list", "throw"],
    ["a malformed run list", "malformed"],
    ["a run past the bound", [run({ run_started_at: overdue })]],
    ["a run with no start time", [run({ run_started_at: undefined, created_at: undefined })]],
    ["another workflow's run", [run({ path: ".github/workflows/ci.yml" })]],
    ["another repository's run", [run({ repository: { full_name: "someone/fork" } })]],
    ["another head's run", [run({ head_sha: base })]],
    ["a run with no usable id", [run({ id: 0 })]],
    ["a newer finished run over an older running one", [run({ id: 4, status: "completed" }), run({ id: 3 })]],
  ];
  for (const [label, runs] of cases) {
    const f = api([], runs);
    await publishSecurityMergeDecision(target, f.api, undefined);
    assert.equal(f.statuses[0]!.state, "error", label);
  }
  // A page that holds only part of the runs is not read as complete.
  const partial = { read: async () => ({ total_count: 101, workflow_runs: [run()] }) };
  assert.equal(await codeqlRunInFlight(target, head, partial.read, NOW), false);
  // A decision for any other reason is not turned pending by a running CodeQL run.
  const failed = api([{ ...codeqlCheck("completed"), conclusion: "failure", output: { title: "x", summary: "unrecognised" } }], [run()]);
  await publishSecurityMergeDecision(target, failed.api, undefined);
  assert.equal(failed.statuses[0]!.state, "error");
});

test("W1-T14493: a pending security status never allows merge", async () => {
  for (const checks of [[], [codeqlCheck("queued")], [codeqlCheck("in_progress")]]) {
    const f = api(checks, [run()]);
    const result = await publishSecurityMergeDecision(target, f.api, undefined);
    assert.equal(f.statuses[0]!.state, "pending");
    assert.equal(result.decision.mergeAllowed, false);
    assert.equal(result.decision.state, "unknown");
    assert.notEqual(f.statuses[0]!.state, "success");
  }
  // A clean completed result is still the only success, and a running run beside it changes nothing.
  const clean = { ...codeqlCheck("completed"), output: { title: "No new alerts in code changed by this pull request",
    summary: "[View all branch alerts](/craigoley/remudero/security/code-scanning?query=pr%3A11468+tool%3ACodeQL+is%3Aopen)." } };
  const f = api([clean], [run()]);
  const result = await publishSecurityMergeDecision(target, f.api, undefined);
  assert.equal(result.decision.mergeAllowed, true);
  assert.equal(f.statuses[0]!.state, "success");
});
