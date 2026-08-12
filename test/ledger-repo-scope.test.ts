import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, matchesRepoScopedTask, repoScopedTaskKey } from "../src/lib/ledger.js";
import { escalateCircuitBreak } from "../src/run-task.js";
import { clearKick, isSafeRepoName, kickFilePath, pendingKicks, requestKick } from "../src/lib/fleet-control.js";

// W1-T429: every task-id-keyed DECISION read on instance-global state was repo-blind — the
// ledger is one file per INSTANCE, and only `run.start` carried a `repo:` dimension, so two
// repos sharing an id scheme (the fleet's plans do: this repo's W1-T12 and a project-init'd
// repo's W1-T12 are the SAME KEY) cross-contaminated caps/breakers/markers the moment `--repo`
// was used. This file is the falsifier design note (iv) names, both directions.

// ── repoScopedTaskKey: the one key-renderer (design note i) ─────────────────────────────────

test("repoScopedTaskKey: `<repo>:<task_id>` when repo is known, bare task_id as the legacy fallback", () => {
  assert.equal(repoScopedTaskKey("remudero", "W1-T429"), "remudero:W1-T429");
  assert.equal(repoScopedTaskKey("wild-trails", "W1-T429"), "wild-trails:W1-T429");
  assert.equal(repoScopedTaskKey(undefined, "W1-T429"), "W1-T429");
});

// ── matchesRepoScopedTask: the read-side adoption, both falsifier directions ────────────────

test("FALSIFIER (forward): a same task_id, DIFFERENT-repo line never matches — the isolating direction", () => {
  const remuderoLine = { task_id: "W1-T12", repo: "remudero" };
  const wildTrailsLine = { task_id: "W1-T12", repo: "wild-trails" };
  assert.equal(matchesRepoScopedTask(remuderoLine, "remudero", "W1-T12"), true);
  assert.equal(matchesRepoScopedTask(wildTrailsLine, "remudero", "W1-T12"), false, "a cap consumed by repo A must leave repo B unmatched");
  assert.equal(matchesRepoScopedTask(remuderoLine, "wild-trails", "W1-T12"), false, "and the reverse");
  assert.equal(matchesRepoScopedTask(wildTrailsLine, "wild-trails", "W1-T12"), true);
});

test("FALSIFIER (backward): a legacy line with no `repo` field still matches a query that now knows one", () => {
  const legacyLine = { task_id: "W1-T12" }; // ledgered before this task existed — no repo dimension at all
  assert.equal(matchesRepoScopedTask(legacyLine, "remudero", "W1-T12"), true, "an upgrade must never orphan a pre-existing marker");
  assert.equal(matchesRepoScopedTask(legacyLine, undefined, "W1-T12"), true, "and a repo-less query still finds it too");
  assert.equal(matchesRepoScopedTask(legacyLine, "remudero", "W1-T99"), false, "a different task id is still never matched");
});

test("deleting the legacy fallback would fail the backward direction (documents WHY the clause exists)", () => {
  // Mirrors matchesRepoScopedTask's own first branch ONLY — the exact-key comparison the
  // backward-compat clause supplements. Proves the fallback clause is load-bearing: without it,
  // a legacy line (no `repo`) never matches a repo-aware query.
  const exactKeyOnly = (line: { task_id?: unknown; repo?: unknown }, repo: string | undefined, taskId: string): boolean => {
    if (typeof line.task_id !== "string") return false;
    const lineRepo = typeof line.repo === "string" ? line.repo : undefined;
    return repoScopedTaskKey(lineRepo, line.task_id) === repoScopedTaskKey(repo, taskId);
  };
  const legacyLine = { task_id: "W1-T12" };
  assert.equal(exactKeyOnly(legacyLine, "remudero", "W1-T12"), false, "without the fallback, the legacy line is silently orphaned");
  assert.equal(matchesRepoScopedTask(legacyLine, "remudero", "W1-T12"), true, "the real function's fallback recovers it");
});

// ── integration: escalateCircuitBreak's own dedup, the actual breaker-gate read/write ───────

function fakeIssues(urlPrefix: string) {
  let calls = 0;
  return {
    calls: () => calls,
    gateway: {
      create(): string {
        calls += 1;
        return `${urlPrefix}/${calls}`;
      },
    },
  };
}

test("FALSIFIER (forward, integration): the SAME task id in TWO repos escalates independently on ONE shared ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-repo-scope-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const task = { id: "W1-T12", title: "t", repo: "remudero", type: "implement", depends_on: [], status: "queued" };

    const remudero = fakeIssues("https://github.com/craigoley/remudero/issues");
    escalateCircuitBreak(task as never, { owner: "craigoley", repo: "remudero", ledgerPath, runId: "R1", issues: remudero.gateway });
    assert.equal(remudero.calls(), 1, "repo A's own escalation fires");

    // A SAME task_id "W1-T12" but a DIFFERENT repo, over the SAME ledger file (the one-instance,
    // --repo hazard this task exists to close) — must NOT be deduped by repo A's marker.
    const wildTrails = fakeIssues("https://github.com/craigoley/wild-trails/issues");
    escalateCircuitBreak(task as never, { owner: "craigoley", repo: "wild-trails", ledgerPath, runId: "R2", issues: wildTrails.gateway });
    assert.equal(wildTrails.calls(), 1, "repo B is NOT dedup'd off repo A's marker for the same bare task id");

    // Re-running repo A again DOES dedup against its own marker.
    escalateCircuitBreak(task as never, { owner: "craigoley", repo: "remudero", ledgerPath, runId: "R3", issues: remudero.gateway });
    assert.equal(remudero.calls(), 1, "repo A's own re-run dedups as before — the cap is still enforced, just repo-isolated");

    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const markers = lines.filter((l) => l.step === "dispatch.circuit_broken.escalated");
    assert.equal(markers.length, 2, "one marker per repo, not one shared/collapsed marker");
    assert.deepEqual(markers.map((m) => m.repo).sort(), ["remudero", "wild-trails"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER (backward, integration): a legacy pre-existing marker (no repo field) still dedups against a repo-aware run", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-repo-scope-legacy-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const task = { id: "W1-T12", title: "t", repo: "remudero", type: "implement", depends_on: [], status: "queued" };

    // Simulate a marker written BEFORE this task existed — bare task_id, no `repo` field.
    appendLedger(ledgerPath, {
      run_id: "R0",
      task_id: task.id,
      step: "dispatch.circuit_broken.escalated",
      issue_url: "https://github.com/craigoley/remudero/issues/1",
      delivered: true,
    });

    const gw = fakeIssues("https://github.com/craigoley/remudero/issues");
    escalateCircuitBreak(task as never, { owner: "craigoley", repo: "remudero", ledgerPath, runId: "R1", issues: gw.gateway });
    assert.equal(gw.calls(), 0, "an upgrade must never re-arm an already-fired escalation the legacy marker already recorded");

    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.step === "dispatch.circuit_broken.escalated").length, 1, "no duplicate marker was written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fleet-control KICK markers adopt the same key (design note iii) ─────────────────────────

test("KICK markers: repo-scoped requests for the SAME task id land on DISTINCT filenames and both stay pending", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-kick-repo-scope-"));
  try {
    requestKick(dir, "W1-T12", "console-a", "remudero");
    requestKick(dir, "W1-T12", "console-b", "wild-trails");
    assert.notEqual(kickFilePath(dir, "W1-T12", "remudero"), kickFilePath(dir, "W1-T12", "wild-trails"));

    const pending = pendingKicks(dir);
    assert.equal(pending.length, 2, "one console click for repo B must not overwrite repo A's pending kick");
    assert.deepEqual(pending.map((k) => k.repo).sort(), ["remudero", "wild-trails"]);

    assert.equal(clearKick(dir, "W1-T12", "remudero"), true);
    const afterClear = pendingKicks(dir);
    assert.equal(afterClear.length, 1, "clearing repo A's marker leaves repo B's pending kick untouched");
    assert.equal(afterClear[0].repo, "wild-trails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("KICK markers: omitting repo reproduces the exact legacy, unscoped path (no behavior change for existing callers)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-kick-legacy-"));
  try {
    requestKick(dir, "W1-T12", "console-a");
    const pending = pendingKicks(dir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].repo, undefined, "a caller that never threads a repo through still gets the bare, unscoped marker");
    assert.equal(clearKick(dir, "W1-T12"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestKick REFUSES an unsafe repo BEFORE any write, same fail-closed discipline as an unsafe task id", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-kick-unsafe-repo-"));
  try {
    assert.throws(() => requestKick(dir, "W1-T12", "console-a", "../evil"), /unsafe repo/);
    assert.equal(pendingKicks(dir).length, 0, "no marker was ever written for an unsafe repo");
    assert.equal(isSafeRepoName("../evil"), false);
    assert.equal(isSafeRepoName("remudero"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
