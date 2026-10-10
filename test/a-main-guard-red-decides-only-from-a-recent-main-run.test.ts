import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMainHealthRung } from "../src/lib/main-health-rung.js";
import { failedMainGuardRuns, MAIN_HEALTH_FALLBACK_WINDOW_COMMITS } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const HEAD = "a".repeat(40);
const PARENT = "b".repeat(40);
const STALE = "c".repeat(40);
const guard = (headSha: string, conclusion: string) => ({ headSha, conclusion, workflowName: "main-plan-guard" });
const commitsPage = (shas: readonly string[]) =>
  shas.map((sha, i) => ({ sha, parents: shas[i + 1] ? [{ sha: shas[i + 1] }] : [] }));

async function observe(options: {
  runs: ReturnType<typeof guard>[];
  headConclusion?: string;
  commits?: () => unknown;
  repeat?: boolean;
  fallback?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6077-`));
  const rows: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let nowMs = 1_000;
  try {
    const rung = buildMainHealthRung("o", "r", {
      fetch: async (args) => {
        const path = args[1]!;
        calls.push(path);
        if (path === "repos/o/r") return { default_branch: "trunk" };
        if (path === "repos/o/r/commits/trunk") return { sha: HEAD };
        if (path.includes("/check-runs?")) {
          return { check_runs: [{ name: "ci", status: "completed", conclusion: options.headConclusion ?? "success" }] };
        }
        if (path.endsWith("/status")) return { statuses: [] };
        if (path.includes("/actions/runs?")) {
          const runs = options.runs.map((run, i) => ({
            id: i + 1, name: run.workflowName, head_sha: run.headSha, conclusion: run.conclusion, status: "completed",
          }));
          if (options.fallback) runs.push({ id: 100, name: "CI", head_sha: PARENT, conclusion: "success", status: "completed" });
          return { workflow_runs: runs };
        }
        if (path.startsWith("repos/o/r/commits?")) {
          return (options.commits ?? (() => commitsPage([HEAD, PARENT])))();
        }
        if (path.includes("/runs/100/jobs?")) return { jobs: [{ id: 100, name: "ci", status: "completed", conclusion: "success" }] };
        throw new Error(`unrouted: ${path}`);
      },
      issues: { create: () => "https://github.com/o/r/issues/1", listOpen: () => [], closeWithComment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "T6077",
      log: (step, extra) => { rows.push({ step, ...extra }); },
      readRequiredChecks: () => ["ci"],
      readCiFailures: () => [],
      now: () => nowMs,
    });
    await rung();
    if (options.repeat) {
      nowMs += 11_000;
      await rung();
    }
    const observed = rows.filter((row) => row.step === "main.health.observed");
    assert.ok(observed.length > 0);
    return { observed: observed[0]!, observations: observed, rows, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T6077: an out-of-window guard failure leaves main green and names the skipped sha", async () => {
  const r = await observe({ runs: [guard(STALE, "failure")] });
  assert.equal(r.observed.state, "green");
  assert.equal(r.observed.decided_by_sha, HEAD);
  assert.deepEqual(r.observed.failing_checks, []);
  assert.match(String(r.observed.reason), new RegExp(STALE));
  assert.match(String(r.observed.reason), /last 50 first-parent commits/);
  assert.equal(r.rows.some((row) => row.step === "main.health.escalated"), false);
});

test("W1-T6077: an in-window guard failure reads main red and uses its sha", async () => {
  const r = await observe({ runs: [guard(PARENT, "failure")] });
  assert.equal(r.observed.state, "red");
  assert.equal(r.observed.decided_by_sha, PARENT);
  assert.deepEqual(r.observed.failing_checks, ["main-plan-guard"]);
});

test("W1-T6077: the newest in-window verdict decides and skipped verdicts stay separate", () => {
  const staleGreen = guard(STALE, "success");
  const recentRed = guard(PARENT, "failure");
  const window = new Set([HEAD, PARENT]);
  assert.deepEqual(failedMainGuardRuns([staleGreen, recentRed], window), { runs: [recentRed], skipped: [staleGreen] });
  assert.deepEqual(failedMainGuardRuns([guard(HEAD, "success"), recentRed], window), { runs: [], skipped: [] });
  for (const conclusion of ["cancelled", "skipped", "stale", ""]) {
    assert.deepEqual(failedMainGuardRuns([guard(HEAD, conclusion), recentRed], window), { runs: [recentRed], skipped: [] });
  }
  assert.deepEqual(failedMainGuardRuns([{ ...recentRed, workflowName: "CI" }], window), { runs: [], skipped: [] });
});

test("W1-T6077: a stale guard success cannot hide an in-window guard failure", async () => {
  const r = await observe({ runs: [guard(STALE, "success"), guard(PARENT, "failure")] });
  assert.equal(r.observed.state, "red");
  assert.equal(r.observed.decided_by_sha, PARENT);
  assert.deepEqual(r.observed.failing_checks, ["main-plan-guard"]);
  assert.match(String(r.observed.reason), new RegExp(STALE));
});

test("W1-T6077: a newer in-window success still supersedes an older in-window failure", async () => {
  const r = await observe({ runs: [guard(HEAD, "success"), guard(PARENT, "failure")] });
  assert.equal(r.observed.state, "green");
  assert.deepEqual(r.observed.failing_checks, []);
});

test("W1-T6077: an unreadable guard window names the failed read without turning main red", async () => {
  for (const commits of [
    () => { throw new Error("commits unavailable"); },
    () => commitsPage([PARENT]),
    () => ({ message: "Not Found" }),
  ]) {
    const r = await observe({ runs: [guard(PARENT, "failure")], commits });
    assert.equal(r.observed.state, "green");
    assert.deepEqual(r.observed.failing_checks, []);
    assert.match(String(r.observed.reason), /first-parent commits were not read/);
    const unreadable = r.rows.find((row) => row.step === "main.health.recent_commits_unreadable");
    assert.ok(unreadable);
    assert.ok(String(r.observed.reason).includes(String(unreadable.error)));
  }
});

test("W1-T6077: guard recency shares the fallback window and reuses it across observations", async () => {
  const r = await observe({ runs: [guard(STALE, "failure")], headConclusion: "cancelled", fallback: true, repeat: true });
  assert.equal(r.observations.length, 2);
  for (const row of r.observations) {
    assert.equal(row.state, "green");
    assert.equal(row.decided_by_sha, PARENT);
    assert.match(String(row.reason), new RegExp(STALE));
  }
  assert.equal(r.calls.filter((path) => path.startsWith("repos/o/r/commits?")).length, 1);
});

test("W1-T6077: a failed shared window read is attempted once and never admits a guard", async () => {
  const r = await observe({
    runs: [guard(PARENT, "failure")], headConclusion: "cancelled", fallback: true,
    commits: () => { throw new Error("shared window unavailable"); },
  });
  assert.equal(r.observed.state, "undetermined");
  assert.deepEqual(r.observed.failing_checks, []);
  assert.match(String(r.observed.reason), /shared window unavailable/);
  assert.equal(r.calls.filter((path) => path.startsWith("repos/o/r/commits?")).length, 1);
  assert.equal(r.rows.filter((row) => row.step === "main.health.recent_commits_unreadable").length, 1);
});

test("W1-T6077: a guard-only window is cached and no failure needs no window read", async () => {
  const cached = await observe({ runs: [guard(STALE, "failure")], repeat: true });
  assert.equal(cached.observations.length, 2);
  assert.equal(cached.calls.filter((path) => path.startsWith("repos/o/r/commits?")).length, 1);
  for (const runs of [[], [guard(HEAD, "success")], [guard(HEAD, "cancelled")]]) {
    const r = await observe({ runs });
    assert.equal(r.observed.state, "green");
    assert.equal(r.calls.some((path) => path.startsWith("repos/o/r/commits?")), false);
  }
});

test("W1-T6077: the first-parent window admits its last commit and skips the next", async () => {
  const chain = [HEAD, ...Array.from({ length: MAIN_HEALTH_FALLBACK_WINDOW_COMMITS }, (_, i) => String(i).padStart(40, "0"))];
  const inside = await observe({ runs: [guard(chain[49]!, "failure")], commits: () => commitsPage(chain) });
  assert.equal(inside.observed.state, "red");
  const outside = await observe({ runs: [guard(chain[50]!, "failure")], commits: () => commitsPage(chain) });
  assert.equal(outside.observed.state, "green");
  assert.match(String(outside.observed.reason), new RegExp(chain[50]!));
});

test("W1-T6077: a skipped guard never replaces a required red or resolves a pending head", async () => {
  for (const [headConclusion, state] of [["failure", "red"], ["cancelled", "undetermined"]]) {
    const r = await observe({ runs: [guard(STALE, "failure")], headConclusion });
    assert.equal(r.observed.state, state);
    assert.equal(r.observed.decided_by_sha, HEAD);
    assert.match(String(r.observed.reason), new RegExp(STALE));
  }
});
