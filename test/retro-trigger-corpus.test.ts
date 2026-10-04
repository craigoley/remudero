import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { retroTriggerCheck } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import { ownBranchOf, runlessMergesSince, saveMarker, type GitLogCommit, type ShippedGithub } from "../src/lib/retro.js";
import { loadPolicy, policyPath, type Policy } from "../src/lib/policy.js";

// ── W1-T2288 — the retro TRIGGER's iteration domain ───────────────────────────────────────────
//
// `retroTriggerCheck` used to build `mergesSinceMarker` from
// `shippedSince(gatherRuns(parseLedger(readFileSync(ledgerPath))), marker?.ts, github).shipped.length`
// alone. TWO independent bugs bounded what could ever be counted: (1) `shippedSince` iterates
// `runs` — a merge with NO run (a plan filing; every plan filing has none) has no loop iteration
// and is structurally unreachable, and (2) the ledger read was the LIVE file only, so a run whose
// rows had already rotated out was invisible even when it happened. This file pins both fixes:
// `runlessMergesSince` (retro.ts, pure) adds the merges `shippedSince` cannot reach, and
// `retroTriggerCheck` now reads the archive∪live ledger UNION for the runs it does reach.
//
// This file never drives a live `gh`/`git` round-trip: `config` points at a throwaway root
// (mirrors test/retro-trigger-check.test.ts's own `fixtureRoot`) and every `ShippedGithub` is a
// bespoke literal, including its new optional `mergedCommits` — the SAME injection seam that
// file already established.

function fixtureRoot(): { config: Config; markerPath: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "retro-trigger-corpus-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const config: Config = { claudeBin: "/bin/true", root };
  return { config, markerPath: join(stateDir, "last-retro.json"), stateDir };
}

/** A gateway that credits nothing on its own and adds no runless merges — the pre-W1-T2288
 *  behavior, byte for byte (no `mergedCommits` implemented at all). */
function bareGithub(): ShippedGithub {
  return {
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    unavailable: () => undefined,
  };
}

/** One ledger-native MERGED run: `run.start` + a `verdict: merged` line crediting `prUrl` to
 *  `taskId`'s own run branch, once paired with a `headRefName` gateway that resolves it. */
function mergedRunLines(runId: string, taskId: string, ts: string, prUrl: string): string {
  return (
    [
      JSON.stringify({ ts, run_id: runId, task_id: taskId, type: "implement", step: "run.start" }),
      JSON.stringify({ ts, run_id: runId, task_id: taskId, step: "verdict", verdict: "merged", pr_url: prUrl, cost_usd: 1 }),
    ].join("\n") + "\n"
  );
}

function commit(date: string, message: string): GitLogCommit {
  return { date, message };
}

// A full, VALID `Policy` (spreads the real shipped policy) with just the `retro` row
// overridden — the same fixture shape test/retro-trigger-check.test.ts's `policyFixture` uses.
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SHIPPED_POLICY: Policy = loadPolicy(policyPath(REPO_ROOT));
function policyFixture(retro: { mergesThreshold: number; daysThreshold: number }): Policy {
  return { ...SHIPPED_POLICY, values: { ...SHIPPED_POLICY.values, retro } };
}

// ── claims 1 + 2 + 9: the domain widens past runs, a plan filing is counted, and the falsifier
//    (a runs-only count) is provably wrong for this exact fixture ────────────────────────────

test("a merge with NO run at all (a plan filing) is counted — shippedSince alone reads 0 here", () => {
  const { config, markerPath } = fixtureRoot();
  saveMarker(markerPath, { ts: "2026-07-20T00:00:00.000Z", learnings_count: 0, runs_seen: 0 });
  // The ledger is genuinely empty — no run ever happened. gatherRuns/shippedSince (unchanged)
  // read zero runs and therefore zero shipped merges: this is the falsifier. A runs-only
  // implementation (restore `mergesSinceMarker = shippedSince(...).shipped.length`) turns this
  // assertion red — `mergesSinceMarker` would be 0, not 1.
  writeFileSync(join(config.root, "state", "ledger.ndjson"), "");
  const github: ShippedGithub = {
    ...bareGithub(),
    mergedCommits: () => [
      // No `Remudero-Task:` trailer at all — a plan filing, exactly `LINT_FILING_SUBJECT_RE`'s
      // own vocabulary (run-task.ts) and exactly what `ownBranchOf` rejects as a head (a
      // `plan/*` branch is never `run-<taskId>-<epoch>`, which every plan filing already is).
      commit("2026-07-25T00:00:00.000Z", "chore(plan): sync MASTER-PLAN.md and plan/tasks.yaml"),
    ],
  };
  const decision = retroTriggerCheck(new Date("2026-07-26T00:00:00.000Z"), { config, github });
  assert.equal(decision?.mergesSinceMarker, 1, "the plan filing merge is counted even though it has no run");
});

test("runlessMergesSince: a trailer-less commit always counts; a trailered commit counts only when its task has no run", () => {
  const commits: GitLogCommit[] = [
    commit("2026-07-21T00:00:00.000Z", "chore(plan): sync"),
    commit("2026-07-22T00:00:00.000Z", "fix(x): something\n\nRemudero-Task: W1-T1"),
    commit("2026-07-23T00:00:00.000Z", "fix(y): something else\n\nRemudero-Task: W1-T2"),
    commit("2026-07-19T00:00:00.000Z", "chore(plan): before the marker, excluded by date"),
  ];
  const taskIdsWithRuns = new Set(["W1-T1"]); // W1-T1 has a run; W1-T2 does not
  const result = runlessMergesSince(commits, "2026-07-20T00:00:00.000Z", taskIdsWithRuns);
  assert.deepEqual(
    result.map((c) => c.message),
    ["chore(plan): sync", "fix(y): something else\n\nRemudero-Task: W1-T2"],
    "the filing commit and the runless-trailered commit count; the run-owned trailer and the pre-marker commit do not",
  );
});

// ── claim 3: gate-side crediting is reused, not reimplemented, and never double-counted ──────

test("a gate-side merge (shippedSince's own github-credited path) is still counted, and the SAME task's git-log trailer is never double-counted", () => {
  const { config, markerPath } = fixtureRoot();
  saveMarker(markerPath, { ts: "2026-07-20T00:00:00.000Z", learnings_count: 0, runs_seen: 0 });
  const runId = "R9";
  const taskId = "W1-T9";
  const ownBranch = ownBranchOf(runId);
  // The run ended some OTHER terminal verdict — never ledger verdict=merged — exactly the gap
  // shippedSince's github-side union exists to close.
  writeFileSync(
    join(config.root, "state", "ledger.ndjson"),
    [
      JSON.stringify({ ts: "2026-07-25T00:00:00.000Z", run_id: runId, task_id: taskId, type: "implement", step: "run.start" }),
      JSON.stringify({ ts: "2026-07-25T00:00:00.000Z", run_id: runId, task_id: taskId, step: "verdict", verdict: "blocked_review" }),
    ].join("\n") + "\n",
  );
  const github: ShippedGithub = {
    findMergedByTrailer: (id) => (id === taskId ? { number: 9, url: "https://github.com/o/r/pull/9" } : null),
    headRefName: (prUrl) => (prUrl === "https://github.com/o/r/pull/9" ? ownBranch : undefined),
    unavailable: () => undefined,
    // The SAME task's PR also shows up verbatim in git log (it did land, after all) — this must
    // NOT add a second count on top of shippedSince's gate-side credit.
    mergedCommits: () => [commit("2026-07-25T01:00:00.000Z", `fix(x): whatever\n\nRemudero-Task: ${taskId}`)],
  };
  const decision = retroTriggerCheck(new Date("2026-07-26T00:00:00.000Z"), { config, github });
  assert.equal(decision?.mergesSinceMarker, 1, "credited exactly once — via shippedSince's gate-side path, not reimplemented and not doubled");
});

// ── claim 4: the ledger read no longer depends on rows surviving rotation in the live file alone ─

test("a run whose ledger rows rotated out of the live file is still credited, via an ARCHIVE rotation", () => {
  const { config, markerPath, stateDir } = fixtureRoot();
  saveMarker(markerPath, { ts: "2026-07-20T00:00:00.000Z", learnings_count: 0, runs_seen: 0 });
  const runId = "R7";
  const taskId = "W1-T7";
  const prUrl = "https://github.com/o/r/pull/7";
  // The LIVE file holds nothing of this run — exactly what rotation leaves behind.
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  // The run's rows survive only in an on-disk rotation — a plain `ledger.*.ndjson` archive,
  // ledgerRotationEntries' own classification (prefix `ledger.`, suffix `.ndjson`, not the live
  // file's exact name).
  writeFileSync(join(stateDir, "ledger.2026-07-24T00-00-00-000Z.ndjson"), mergedRunLines(runId, taskId, "2026-07-24T00:00:00.000Z", prUrl));
  const github: ShippedGithub = {
    findMergedByTrailer: () => null,
    headRefName: (u) => (u === prUrl ? ownBranchOf(runId) : undefined),
    unavailable: () => undefined,
  };
  const decision = retroTriggerCheck(new Date("2026-07-26T00:00:00.000Z"), { config, github });
  assert.equal(decision?.mergesSinceMarker, 1, "the archived run is credited — the live file alone would have read zero runs");
});

test("with ZERO archives present, the ledger read falls back to the live file — no regression on a fresh state dir", () => {
  const { config, markerPath, stateDir } = fixtureRoot();
  saveMarker(markerPath, { ts: "2026-07-20T00:00:00.000Z", learnings_count: 0, runs_seen: 0 });
  const runId = "R8";
  const taskId = "W1-T8";
  const prUrl = "https://github.com/o/r/pull/8";
  writeFileSync(join(stateDir, "ledger.ndjson"), mergedRunLines(runId, taskId, "2026-07-24T00:00:00.000Z", prUrl));
  const github: ShippedGithub = {
    findMergedByTrailer: () => null,
    headRefName: (u) => (u === prUrl ? ownBranchOf(runId) : undefined),
    unavailable: () => undefined,
  };
  const decision = retroTriggerCheck(new Date("2026-07-26T00:00:00.000Z"), { config, github });
  assert.equal(decision?.mergesSinceMarker, 1, "zero archives ⇒ falls back to the live file, exactly today's read, still credited");
});

// ── claim 5: the merges threshold itself is unchanged — the same N now reachable by more merges ─

test("mergesThreshold is unchanged: a runless plan filing crosses the SAME threshold value that ledger-only runs already cross", () => {
  const { config, markerPath } = fixtureRoot();
  saveMarker(markerPath, { ts: "2026-07-20T00:00:00.000Z", learnings_count: 0, runs_seen: 0 });
  writeFileSync(join(config.root, "state", "ledger.ndjson"), "");
  const github: ShippedGithub = {
    ...bareGithub(),
    mergedCommits: () => [commit("2026-07-25T00:00:00.000Z", "chore(plan): sync")],
  };
  const now = new Date("2026-07-26T00:00:00.000Z"); // 6 days since marker — under a 7-day daysThreshold
  const underThreshold = retroTriggerCheck(now, {
    config,
    github,
    policy: policyFixture({ mergesThreshold: 2, daysThreshold: 7 }),
  });
  assert.equal(underThreshold?.fire, false, "1 counted merge is under a mergesThreshold of 2 — no fire, no threshold change needed");

  const atThreshold = retroTriggerCheck(now, {
    config,
    github,
    policy: policyFixture({ mergesThreshold: 1, daysThreshold: 7 }),
  });
  assert.equal(atThreshold?.fire, true, "the SAME threshold value (1) fires once the corpus reaches it — the fix is what is counted");
  assert.equal(atThreshold?.reason, "merges");
});

// ── claim 6: the days-threshold arm is untouched — still fires on an idle repository ─────────

test("the days threshold still fires on an idle repository with zero merges of any kind", () => {
  const { config, markerPath } = fixtureRoot();
  saveMarker(markerPath, { ts: "2026-07-01T00:00:00.000Z", learnings_count: 0, runs_seen: 0 });
  writeFileSync(join(config.root, "state", "ledger.ndjson"), "");
  const github: ShippedGithub = { ...bareGithub(), mergedCommits: () => [] };
  const decision = retroTriggerCheck(new Date("2026-07-26T00:00:00.000Z"), {
    config,
    github,
    policy: policyFixture({ mergesThreshold: 25, daysThreshold: 7 }),
  });
  assert.equal(decision?.mergesSinceMarker, 0, "genuinely nothing merged");
  assert.equal(decision?.fire, true, "25 days idle crosses a daysThreshold of 7 regardless of the merge count");
  assert.equal(decision?.reason, "days");
});

// ── claim 7: the P9 ownership assert still rejects a merge credited to a branch that is not the
//    run's own — shippedSince's rejection logic is exercised unchanged ───────────────────────

test("a merge whose head branch is NOT the claiming run's own branch is REJECTED — never credited", () => {
  const { config, markerPath } = fixtureRoot();
  saveMarker(markerPath, { ts: "2026-07-20T00:00:00.000Z", learnings_count: 0, runs_seen: 0 });
  const runId = "R5";
  const taskId = "W1-T5";
  const prUrl = "https://github.com/o/r/pull/5";
  writeFileSync(join(config.root, "state", "ledger.ndjson"), mergedRunLines(runId, taskId, "2026-07-24T00:00:00.000Z", prUrl));
  const github: ShippedGithub = {
    findMergedByTrailer: () => null,
    // Resolves to a FOREIGN branch, never `ownBranchOf(runId)` — the stale/foreign-trailer class.
    headRefName: () => "dependabot/npm_and_yarn/whatever",
    unavailable: () => undefined,
  };
  const decision = retroTriggerCheck(new Date("2026-07-26T00:00:00.000Z"), { config, github });
  assert.equal(decision?.mergesSinceMarker, 0, "the foreign-branch credit is rejected, not counted");
});

// ── claim 8: nothing in the trigger path files a task or ratifies a learning without an operator ─

test("retroTriggerCheck touches only state/ — no plan/ or learnings/ directory is created or written", () => {
  const { config, markerPath } = fixtureRoot();
  saveMarker(markerPath, { ts: "2026-07-20T00:00:00.000Z", learnings_count: 0, runs_seen: 0 });
  writeFileSync(join(config.root, "state", "ledger.ndjson"), "");
  const github: ShippedGithub = { ...bareGithub(), mergedCommits: () => [commit("2026-07-25T00:00:00.000Z", "chore(plan): sync")] };
  const before = readdirSync(config.root).sort();
  retroTriggerCheck(new Date("2026-07-26T00:00:00.000Z"), { config, github });
  const after = readdirSync(config.root).sort();
  assert.deepEqual(after, before, "no new top-level entry (a plan/ or learnings/ dir, a filed task) appeared under config.root");
  assert.ok(!after.includes("plan"), "no plan/ directory — nothing files a task");
  assert.ok(!after.includes("learnings"), "no learnings/ directory — nothing ratifies a learning");
});

