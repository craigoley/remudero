/**
 * W1-T2492: a harness built to improve OTHER repos measures only itself — `onboard`, the managed
 * repo registry and `rmd daemon --repo` are all shipped, yet `zeroTouchMergeRate` (W1-T437)
 * blended every merge into one rate no matter which repo it targeted. With 1,000 of the plan's
 * 1,002 tasks naming this one repo, a foreign repo could merge nothing but reverts and the
 * blended number would not move.
 *
 * This suite proves `lib/autonomy.ts`'s `repos: RepoOutcome[]` split (this task's ONLY converted
 * metric — `verdict-calibration` and `rule-efficacy` are deliberately untouched, per the task's
 * rationale) against every acceptance criterion:
 *
 *   1. a separate rate per repo, never one blended number
 *   2. each per-repo rate names its own denominator (`total`)
 *   3. below `MIN_REPO_POPULATION_FLOOR`, a repo prints its count and refuses the rate
 *   4. an onboarded repo (named in `knownRepos`) with zero merges is reported, never omitted
 *   5. with every merge attributed to ONE repo, the per-repo report equals the top-level report
 *      already printed (additive, not a second measurement)
 *   6. an unreadable ledger corpus reports UNMEASURED per repo too, never a live-file-only rate
 *   7. a merge whose repo cannot be resolved lands in `UNATTRIBUTABLE_REPO`, never dropped
 *   8. FALSIFIER: collapsing the split back to one blended rate reports a DIFFERENT number than
 *      either repo's true rate — proving the split carries real information
 *
 * Plus one end-to-end test that `autonomyRateCommand` (run-task.ts) actually wires a loaded
 * plan's `task.repo` field into `repoOf`/`knownRepos`, not just the pure core.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  mineAutonomyLedgerLines,
  zeroTouchMergeRate,
  MIN_REPO_POPULATION_FLOOR,
  UNATTRIBUTABLE_REPO,
  type AutonomyLedgerMining,
  type MergeRecord,
} from "../src/lib/autonomy.js";
import type { LedgerUnionResult } from "../src/lib/ledger-grep.js";
import { autonomyRateCommand } from "../src/run-task.js";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Same hand-built fixture idiom `test/autonomy-ratchet.test.ts` uses — bypasses
 *  `resolveLedgerUnion`'s own fs read so the pure core is exercised directly. */
function mining(linesByTaskId: Record<string, Record<string, unknown>[]>, ledgerOverrides: Partial<LedgerUnionResult> = {}): AutonomyLedgerMining {
  const ledger: LedgerUnionResult = {
    stateDir: "/fixture/state",
    archiveFiles: ["/fixture/state/ledger.2026-01-01.ndjson.gz"],
    archiveCount: 1,
    liveFileRead: false,
    unread: [],
    ok: true,
    matches: [],
    ...ledgerOverrides,
  };
  return { ledger, linesByTaskId: new Map(Object.entries(linesByTaskId)) };
}

const SHA = (n: number) => n.toString(16).padStart(40, "0");

/** `n` zero-touch merges (auto-armed, no other ledger line) for `taskIds`, at floor volume so
 *  each repo's rate is actually printed rather than refused. */
function zeroTouchMerges(taskIds: string[]): { merges: MergeRecord[]; lines: Record<string, Record<string, unknown>[]> } {
  const merges: MergeRecord[] = [];
  const lines: Record<string, Record<string, unknown>[]> = {};
  taskIds.forEach((id, i) => {
    merges.push({ taskId: id, sha: SHA(i + 1), ts: `2026-01-0${(i % 9) + 1}T00:00:00+00:00` });
    lines[id] = [{ step: "automerge.armed", task_id: id }];
  });
  return { merges, lines };
}

function repoOfMap(map: Record<string, string>): (taskId: string) => string | undefined {
  return (taskId) => map[taskId];
}

test("sanity: MIN_REPO_POPULATION_FLOOR is a real bound, at least 2", () => {
  assert.ok(MIN_REPO_POPULATION_FLOOR >= 2);
});

// ── (1) + (2): a separate rate per repo, each with its own named denominator ──────────────────

test("reports a separate rate per repo, never one blended number — each names its own denominator", () => {
  // repoA: every merge zero-touch. repoB: every merge touched. Blended over all 10 would be 50%.
  const aIds = Array.from({ length: MIN_REPO_POPULATION_FLOOR }, (_, i) => `W1-TA${i}`);
  const bIds = Array.from({ length: MIN_REPO_POPULATION_FLOOR }, (_, i) => `W1-TB${i}`);
  const a = zeroTouchMerges(aIds);
  const b = zeroTouchMerges(bIds);
  // Touch every repoB merge with a reframe.
  for (const id of bIds) b.lines[id].push({ step: "ratify.reframed", task_id: id });

  const merges = [...a.merges, ...b.merges];
  const m = mining({ ...a.lines, ...b.lines });
  const repoOf = repoOfMap(Object.fromEntries([...aIds.map((id) => [id, "repo-a"]), ...bIds.map((id) => [id, "repo-b"])]));

  const report = zeroTouchMergeRate(merges, m, { repoOf });

  assert.equal(report.zeroTouchRate, 0.5, "sanity: the blended top-level rate IS 50%");

  const repoA = report.repos.find((r) => r.repo === "repo-a")!;
  const repoB = report.repos.find((r) => r.repo === "repo-b")!;
  assert.equal(repoA.total, MIN_REPO_POPULATION_FLOOR, "repo-a's own denominator");
  assert.equal(repoB.total, MIN_REPO_POPULATION_FLOOR, "repo-b's own denominator");
  assert.equal(repoA.zeroTouchRate, 1, "repo-a is 100% zero-touch");
  assert.equal(repoB.zeroTouchRate, 0, "repo-b is 0% zero-touch");
  assert.notEqual(repoA.zeroTouchRate, report.zeroTouchRate);
  assert.notEqual(repoB.zeroTouchRate, report.zeroTouchRate);
});

// ── (3) below the population floor: prints the count, refuses the rate ────────────────────────

test("a repo below MIN_REPO_POPULATION_FLOOR prints its count and refuses the rate", () => {
  assert.ok(MIN_REPO_POPULATION_FLOOR > 1, "sanity: the floor excludes at least a 1-merge repo");
  const ids = ["W1-T1"]; // one merge — below any floor >= 2
  const { merges, lines } = zeroTouchMerges(ids);
  const m = mining(lines);
  const report = zeroTouchMergeRate(merges, m, { repoOf: repoOfMap({ "W1-T1": "thin-repo" }) });

  const thin = report.repos.find((r) => r.repo === "thin-repo")!;
  assert.equal(thin.total, 1, "the count is still printed");
  assert.equal(thin.zeroTouchRate, null, "the rate is refused");
  assert.equal(thin.rateRefusedReason, "below-population-floor");
});

test("a repo AT the population floor prints a real rate", () => {
  const ids = Array.from({ length: MIN_REPO_POPULATION_FLOOR }, (_, i) => `W1-T${i}`);
  const { merges, lines } = zeroTouchMerges(ids);
  const m = mining(lines);
  const repoOf = repoOfMap(Object.fromEntries(ids.map((id) => [id, "at-floor-repo"])));
  const report = zeroTouchMergeRate(merges, m, { repoOf });
  const r = report.repos.find((r) => r.repo === "at-floor-repo")!;
  assert.equal(r.total, MIN_REPO_POPULATION_FLOOR);
  assert.equal(r.zeroTouchRate, 1);
  assert.equal(r.rateRefusedReason, undefined);
});

// ── (4) an onboarded repo with zero merges is reported, never omitted ─────────────────────────

test("an onboarded repo (named in knownRepos) with zero merges this window is reported, not omitted", () => {
  const { merges, lines } = zeroTouchMerges(["W1-T1"]);
  const m = mining(lines);
  const report = zeroTouchMergeRate(merges, m, {
    repoOf: repoOfMap({ "W1-T1": "busy-repo" }),
    knownRepos: ["busy-repo", "idle-onboarded-repo"],
  });
  const idle = report.repos.find((r) => r.repo === "idle-onboarded-repo");
  assert.ok(idle, "the idle repo must appear at all — a dropped row is indistinguishable from 'never onboarded'");
  assert.equal(idle!.total, 0);
  assert.equal(idle!.zeroTouchRate, null);
  assert.equal(idle!.rateRefusedReason, "zero-merges");
});

// ── (5) single repo: the per-repo report equals the report already printed ────────────────────

test("with every merge attributed to a single repo, the per-repo report equals the top-level report already printed", () => {
  const ids = Array.from({ length: MIN_REPO_POPULATION_FLOOR + 2 }, (_, i) => `W1-T${i}`);
  const { merges, lines } = zeroTouchMerges(ids);
  // Touch exactly one so the rate isn't a trivial 100%/0%.
  lines[ids[0]].push({ step: "ratify.reframed", task_id: ids[0] });
  const m = mining(lines);
  const repoOf = repoOfMap(Object.fromEntries(ids.map((id) => [id, "solo-repo"])));

  const report = zeroTouchMergeRate(merges, m, { repoOf });

  assert.equal(report.repos.length, 1, "one repo in, one repo out");
  const solo = report.repos[0];
  assert.equal(solo.repo, "solo-repo");
  assert.equal(solo.total, report.totalMerges);
  assert.equal(solo.zeroTouchCount, report.zeroTouchCount);
  assert.equal(solo.zeroTouchRate, report.zeroTouchRate);
});

// ── (6) a corpus that cannot be read reports unmeasured, never a zero rate ────────────────────

test("an unreadable ledger corpus reports UNMEASURED per repo too — the count still names the denominator, the rate never fakes zero", () => {
  const ids = Array.from({ length: MIN_REPO_POPULATION_FLOOR }, (_, i) => `W1-T${i}`);
  const { merges } = zeroTouchMerges(ids);
  const m = mining({}, { ok: false, archiveCount: 0, matches: [] });
  const report = zeroTouchMergeRate(merges, m, { repoOf: repoOfMap(Object.fromEntries(ids.map((id) => [id, "unmeasured-repo"]))) });

  assert.equal(report.status, "unmeasured");
  const r = report.repos.find((r) => r.repo === "unmeasured-repo")!;
  assert.equal(r.total, MIN_REPO_POPULATION_FLOOR, "the git-corpus denominator is still known and named");
  assert.equal(r.zeroTouchRate, null, "never a fabricated zero rate");
  assert.equal(r.rateRefusedReason, "corpus-unmeasured");
});

// ── (7) an unattributable merge is reported, never dropped ────────────────────────────────────

test("a merge whose repo cannot be resolved is reported UNATTRIBUTABLE, never dropped", () => {
  const ids = ["W1-T1", "W1-T2"];
  const { merges, lines } = zeroTouchMerges(ids);
  const m = mining(lines);
  // repoOf resolves W1-T1 but returns undefined for W1-T2 — the "cannot be placed" case.
  const report = zeroTouchMergeRate(merges, m, { repoOf: repoOfMap({ "W1-T1": "known-repo" }) });

  const unattributable = report.repos.find((r) => r.repo === UNATTRIBUTABLE_REPO);
  assert.ok(unattributable, "the unresolved merge must land somewhere reportable, never silently vanish");
  assert.equal(unattributable!.total, 1);
  assert.equal(
    report.repos.reduce((sum, r) => sum + r.total, 0),
    report.totalMerges,
    "every merge is accounted for across the repo split — none dropped",
  );
});

test("omitting repoOf entirely makes every merge unattributable — the honest answer, not a silent single-repo guess", () => {
  const { merges, lines } = zeroTouchMerges(["W1-T1"]);
  const m = mining(lines);
  const report = zeroTouchMergeRate(merges, m); // no opts.repoOf at all
  assert.deepEqual(
    report.repos.map((r) => r.repo),
    [UNATTRIBUTABLE_REPO],
  );
});

// ── (8) FALSIFIER: collapsing the split back to one rate is a DIFFERENT, wrong number ─────────

test("FALSIFIER: collapsing the per-repo split back to one blended rate reports a number neither repo actually has", () => {
  const aIds = Array.from({ length: MIN_REPO_POPULATION_FLOOR }, (_, i) => `W1-TC${i}`);
  const bIds = Array.from({ length: MIN_REPO_POPULATION_FLOOR }, (_, i) => `W1-TD${i}`);
  const a = zeroTouchMerges(aIds); // all zero-touch
  const b = zeroTouchMerges(bIds);
  for (const id of bIds) b.lines[id].push({ step: "ratify.reframed", task_id: id }); // all touched

  const merges = [...a.merges, ...b.merges];
  const m = mining({ ...a.lines, ...b.lines });
  const repoOf = repoOfMap(Object.fromEntries([...aIds.map((id) => [id, "repo-c"]), ...bIds.map((id) => [id, "repo-d"])]));
  const report = zeroTouchMergeRate(merges, m, { repoOf });

  const perRepoRates = new Set(report.repos.map((r) => r.zeroTouchRate));
  const blended = report.zeroTouchRate; // the number a caller gets by IGNORING the split
  assert.deepEqual([...perRepoRates].sort(), [0, 1], "the two repos' TRUE rates");
  assert.ok(
    !perRepoRates.has(blended),
    "collapsing back to the blended number (0.5) asserts a rate that belongs to NEITHER repo — " +
      "the split is the only thing standing between this and a false-healthy report",
  );
});

// ── end-to-end: autonomyRateCommand wires the loaded plan's task.repo into repoOf/knownRepos ──

function writePlan(dir: string, tasks: Array<{ id: string; repo: string }>): string {
  const planPath = join(dir, "plan", "tasks.yaml");
  mkdirSync(join(dir, "plan"), { recursive: true });
  const yaml = tasks
    .map((t) => `- id: ${t.id}\n  title: "fixture ${t.id}"\n  repo: ${t.repo}\n  type: implement\n  status: done\n`)
    .join("");
  writeFileSync(planPath, yaml);
  return planPath;
}

test("autonomyRateCommand: prints a per-repo breakdown built from the loaded plan's task.repo field, naming an idle onboarded repo", () => {
  const stateDir = tmpDir("rmd-autonomy-repo-cli-state-");
  const planDir = tmpDir("rmd-autonomy-repo-cli-plan-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    const planPath = writePlan(planDir, [
      { id: "W1-T900", repo: "remudero" },
      { id: "W1-T901", repo: "other-repo" },
    ]);
    // No ledger archive at all -> the whole window is UNMEASURED; this test only exercises the
    // plan-wiring (knownRepos includes a repo with no matching git-history merge at all).
    const code = autonomyRateCommand([], { stateDir, planPath, cwd: planDir });
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /by repo:/);
    // "other-repo" is named in the plan (onboarded) but this fixture's git history (planDir has
    // no .git at all) yields zero merges — it must still be listed, never silently absent.
    assert.match(out, /other-repo/);
  } finally {
    console.log = realLog;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(planDir, { recursive: true, force: true });
  }
});
