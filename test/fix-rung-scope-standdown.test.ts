/**
 * test/fix-rung-scope-standdown.test.ts — W1-T1227.
 *
 * THE DEFECT (MEASURED 2026-08-23, W1-T1213/PR #2545 and PR-2527). The fix rung's prompt
 * (`renderFixPrompt`) carried only the task's `id`/`title` — never its declared `files` scope —
 * so a fix worker repairing a red check had no way to learn what it was and wasn't allowed to
 * touch. Twice in one twelve-hour window a ci-log repair added a path outside that scope (an
 * instrument baseline file; a benchmark test file that un-exempted a plan-only PR's `planOnly`
 * carve-out), and the NEXT round's rule-15/rule-25 refusal fired on the exact file the rung's own
 * worker had just written. Because the review verdict is written once per head sha, no re-run
 * could ever clear either PR — only a human, editing the branch by hand, could.
 *
 * THE FIX, TWO HALVES.
 *   (i) `renderFixPrompt` now surfaces `task.files` (already on `runFixRung`'s own opts type,
 *       W1-T322's widening — this task is what finally uses it) as an explicit DECLARED SCOPE
 *       block, present in EVERY mode's prompt whenever the task declares files.
 *   (ii) `fixRungScopeStandDownReason` (pure) compares the PR's live changed-file list, as of
 *        right now, against a BASELINE captured before this invocation's first strike. A path
 *        that is out of scope in the baseline (tolerated by `scopeGuardOutOfScopeFiles`'s
 *        push-and-flag disposition on the implement path — NOT this task's concern) is never
 *        re-flagged; only a NEWLY out-of-scope path — one the fix rung itself must have added —
 *        stands the rung down. `runFixRung` wires this at the pre-strike gate (the SAME seam
 *        `fixRungStandDownReason`/`preStrikeStandDown` already occupies), before EVERY strike
 *        past the first, so a repair that leaves the PR out of scope stands the rung down and
 *        escalates instead of spending another strike compounding on top of it — without waiting
 *        a whole round for CI to go green and a review to run, unlike the rule-15/rule-25
 *        refusals it sits beside (which remain untouched — W1-T297, design note vi).
 *
 * TWO SCOPE REGIMES (design note iii). When every file the task declares is itself plan-scoped,
 * the PR is plan-only and the test is membership in PLAN scope (`isInPlanScope`) — not the exact
 * declared list. Otherwise the test is exact membership in the declared `files` list, via the
 * SAME `scopeGuardOutOfScopeFiles` the implement path already uses. `scopeKind` on the pure
 * function's return value — and the stand-down `reason` text — names which regime fired, so the
 * two incidents this task was filed for read as distinguishable in the ledger and the escalation.
 *
 * NEITHER HALF EVER TOUCHES THE PR BODY OR THE TASK RECORD (design note iv) — the stand-down only
 * ledgers, `say`s, and escalates, exactly like the rule-15/rule-25 refusals beside it; no test
 * below wires an `updatePrBody`/task-record writer at all, so any accidental write would surface
 * as a thrown "not a function" rather than a silent pass.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  runFixRung,
  renderFixPrompt,
  fixRungScopeStandDownReason,
  scopeGuardOutOfScopeFiles,
} from "../src/run-task.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

function result(over: Partial<WorkerResult> = {}): WorkerResult {
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

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
  headSha = "deadbeef",
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts(task: { id: string; title: string; files?: string[] }) {
  return {
    taskId: task.id,
    runId: `${task.id}-1730000000000`,
    task,
    prUrl: "https://github.com/acme/remudero/pull/1",
    branch: `run-${task.id}-1730000000000`,
    worktreePath: "/tmp/rmd-fixrung-scope-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-scope-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-scope-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-scope-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 900;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/acme/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen(): OpenIssue[] {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment() {
      // not exercised by these tests
    },
  };
}

/** A `deps.fetchPrDiffFiles` fake that replays a fixed SEQUENCE of diff-file snapshots, one per
 *  call — the LAST entry repeats once the sequence is exhausted, mirroring "nothing else changed
 *  since." Call 0 is always the pre-loop baseline snapshot. */
function diffFileSequence(sequence: string[][]): (prUrl: string) => Promise<string[]> {
  let i = 0;
  return async () => sequence[Math.min(i++, sequence.length - 1)];
}

// ── renderFixPrompt — the DECLARED SCOPE block (criterion 1) ───────────────────────────────────

test("renderFixPrompt (criterion 1): names every declared file, in EVERY mode, before a fix worker is dispatched", () => {
  const task = { id: "W1-T1227X", title: "some task", files: ["src/foo.ts", "test/foo.test.ts"] };
  const modes: Array<{ label: string; evidence: Parameters<typeof renderFixPrompt>[0]["evidence"] }> = [
    { label: "ci-log", evidence: { ciFailures: [{ name: "build", logTail: "boom" }] } },
    { label: "merge-conflict", evidence: { mergeConflict: { files: [], oursLog: "", theirsLog: "" } } },
    { label: "body-coverage", evidence: { review: { unmetCriteria: [criterion({ claim: "c", met: false, reason: "matched 1/3 proof keywords" })], summary: "s" } } },
    { label: "reviewer-unmet", evidence: { review: { unmetCriteria: [criterion({ claim: "c", met: false, reason: "not close enough" })], summary: "s" } } },
  ];
  for (const { label, evidence } of modes) {
    const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T1227X-1", evidence });
    assert.match(prompt, /DECLARED SCOPE/, `${label}: names the declared-scope block`);
    assert.match(prompt, /src\/foo\.ts/, `${label}: names the first declared file`);
    assert.match(prompt, /test\/foo\.test\.ts/, `${label}: names the second declared file`);
  }
});

test("renderFixPrompt: a task with NO declared files renders no DECLARED SCOPE block at all — nothing to name", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-T1227X", title: "some task" },
    round: 1,
    branch: "run-W1-T1227X-1",
    evidence: { ciFailures: [{ name: "build", logTail: "boom" }] },
  });
  assert.doesNotMatch(prompt, /DECLARED SCOPE/);
});

// ── fixRungScopeStandDownReason — the pure boundary (criteria 2, 3, 4) ─────────────────────────

test("fixRungScopeStandDownReason (criterion 2): a NEW path outside the declared files list stands down, naming the files-scope reason", () => {
  const got = fixRungScopeStandDownReason(
    ["src/foo.ts", "scripts/instrument.json"],
    ["src/foo.ts"], // baseline — the instrument path is new
    ["src/foo.ts"], // declared scope
  );
  assert.ok(got);
  assert.equal(got.scopeKind, "files");
  assert.deepEqual(got.newOutOfScopePaths, ["scripts/instrument.json"]);
  assert.match(got.reason, /scripts\/instrument\.json/);
  assert.match(got.reason, /src\/foo\.ts/);
});

test("fixRungScopeStandDownReason (criterion 3): on a plan-only task (every declared file is plan-scoped), a non-plan path stands down for the PLAN-SCOPE reason, distinct from the files-scope reason", () => {
  const declaredPlanOnly = ["plan/tasks.d/W1-T1227X.yaml"];
  const got = fixRungScopeStandDownReason(
    ["plan/tasks.d/W1-T1227X.yaml", "test/w1-t187-benchmark.test.ts"],
    ["plan/tasks.d/W1-T1227X.yaml"], // baseline — the benchmark test is new
    declaredPlanOnly,
  );
  assert.ok(got);
  assert.equal(got.scopeKind, "plan");
  assert.deepEqual(got.newOutOfScopePaths, ["test/w1-t187-benchmark.test.ts"]);
  assert.match(got.reason, /plan-only/);
  assert.match(got.reason, /test\/w1-t187-benchmark\.test\.ts/);

  // Same shape of violation, non-plan-only declared scope, reads as the OTHER kind — the two
  // are genuinely distinguished by declared scope, not by the offending path's own shape.
  const filesKind = fixRungScopeStandDownReason(
    ["src/foo.ts", "test/w1-t187-benchmark.test.ts"],
    ["src/foo.ts"],
    ["src/foo.ts"],
  );
  assert.ok(filesKind);
  assert.equal(filesKind.scopeKind, "files");
});

test("fixRungScopeStandDownReason: a path already out of scope in the BASELINE is never re-flagged — only what the rung itself newly added counts", () => {
  const got = fixRungScopeStandDownReason(
    ["src/foo.ts", "scripts/pre-existing.json"],
    ["src/foo.ts", "scripts/pre-existing.json"], // identical baseline — nothing new
    ["src/foo.ts"],
  );
  assert.equal(got, undefined);
});

test("fixRungScopeStandDownReason (criterion 4): a repair confined to the declared file(s) — nothing new, in or out of scope — never stands down", () => {
  assert.equal(fixRungScopeStandDownReason(["src/foo.ts"], ["src/foo.ts"], ["src/foo.ts"]), undefined);
  assert.equal(fixRungScopeStandDownReason(["src/foo.ts"], [], ["src/foo.ts"]), undefined);
});

test("fixRungScopeStandDownReason: a task with no declared files at all gives this guard nothing to enforce — fails OPEN, never blind", () => {
  assert.equal(fixRungScopeStandDownReason(["src/foo.ts", "anything.json"], [], undefined), undefined);
  assert.equal(fixRungScopeStandDownReason(["src/foo.ts", "anything.json"], [], []), undefined);
});

test("fixRungScopeStandDownReason reuses scopeGuardOutOfScopeFiles's OWN membership test for the non-plan-only regime — never a parallel reimplementation", () => {
  const declared = ["src/foo.ts", "src/bar.ts"];
  const diff = ["src/foo.ts", "src/bar.ts", "src/rogue.ts"];
  assert.deepEqual(scopeGuardOutOfScopeFiles(diff, declared), ["src/rogue.ts"]);
  const got = fixRungScopeStandDownReason(diff, declared, declared);
  assert.deepEqual(got?.newOutOfScopePaths, ["src/rogue.ts"]);
});

// ── the full rung, behaviorally (criteria 2, 3, 4, 5) ───────────────────────────────────────────

test("runFixRung (criterion 2): a fix worker's round-1 commit that adds a path outside declared scope stands the rung down BEFORE round 2's strike — never dispatching it — and escalates naming the observed path", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const issues = fakeIssueStore();
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T1227X", title: "fix the CI baseline", files: ["src/foo.ts"] }),
    strikeCap: 3,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      // Round 1's own strike lands sha-1, still failing (some OTHER criterion regressed) — the
      // loop heads to round 2, whose pre-strike gate is where this must be caught.
      runReview: async () => ({ ...failing, headSha: "sha-1" }),
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      // Baseline (call 0) carries only the declared file; round 1's own pre-strike check (call 1)
      // sees the same, unchanged, state — round 1 dispatches normally. Round 2's pre-strike check
      // (call 2) observes round 1's OWN commit having added an out-of-scope instrument path.
      fetchPrDiffFiles: diffFileSequence([["src/foo.ts"], ["src/foo.ts"], ["src/foo.ts", "scripts/claude-md-budget-baseline.json"]]),
    },
  });

  assert.equal(spawnCalls.length, 1, "exactly ONE strike — round 1's; round 2 never dispatches a fix worker");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 1, "strikes never incremented past round 1");
  assert.match(outcome.standDownReason ?? "", /scripts\/claude-md-budget-baseline\.json/, "names the path it observed");
  assert.ok(outcome.issueUrl, "the stand-down escalates — an issue url is returned");

  assert.equal(issues.calls.length, 1, "exactly one needs-human issue opened");
  assert.match(issues.calls[0].body, /scripts\/claude-md-budget-baseline\.json/);
  assert.match(issues.calls[0].body, /## Options/, "an actionable choice is present — never a bare alert");

  const stoodDown = logs.filter((l) => l.step === "fix.stood_down");
  assert.equal(stoodDown.length, 1);
  assert.equal(stoodDown[0].extra?.site, "rung.scope");
  assert.equal(stoodDown[0].extra?.strike, 2, "named as the strike that was about to be spent");
  assert.equal(stoodDown[0].extra?.scope_kind, "files");
  assert.deepEqual(stoodDown[0].extra?.out_of_scope_paths, ["scripts/claude-md-budget-baseline.json"]);
});

test("runFixRung (criterion 3): on a plan-only task, a fix worker's non-plan addition stands the rung down for the PLAN-SCOPE reason (never the files-scope reason)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const issues = fakeIssueStore();
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "PR-2527X", title: "correct a filing's criteria", files: ["plan/tasks.d/PR-2527X.yaml"] }),
    strikeCap: 3,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...failing, headSha: "sha-1" }),
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      fetchPrDiffFiles: diffFileSequence([
        ["plan/tasks.d/PR-2527X.yaml"],
        ["plan/tasks.d/PR-2527X.yaml"],
        ["plan/tasks.d/PR-2527X.yaml", "test/w1-t187-benchmark.test.ts"],
      ]),
    },
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(outcome.outcome, "stood_down");
  assert.match(outcome.standDownReason ?? "", /plan-only/);
  assert.match(outcome.standDownReason ?? "", /test\/w1-t187-benchmark\.test\.ts/);

  const stoodDown = logs.filter((l) => l.step === "fix.stood_down" && l.extra?.site === "rung.scope");
  assert.equal(stoodDown.length, 1);
  assert.equal(stoodDown[0].extra?.scope_kind, "plan");
});

test("runFixRung (criterion 4): a repair confined to the declared file(s) dispatches BOTH strikes normally — strike accounting, spawn count and outcome all unchanged by this guard", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  let round = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T1227Y", title: "fix flaky check", files: ["src/foo.ts"] }),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => {
        round++;
        return round === 1
          ? { ...failing, headSha: "sha-1" }
          : { ...failing, state: "success", headSha: "sha-2", criteria: [criterion({ claim: "criterion A merges cleanly", met: true })] };
      },
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      // Every observation is the SAME declared file, in scope throughout both rounds.
      fetchPrDiffFiles: async () => ["src/foo.ts"],
    },
  });

  assert.equal(spawnCalls.length, 2, "both strikes spent — the scope guard never stands an in-scope repair down");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 2);
});

test("runFixRung: an out-of-scope path from BEFORE this invocation ever ran (tolerated on the implement push) is never re-flagged as the rung's own doing — the rung proceeds and dispatches normally", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T1227Z", title: "fix flaky check", files: ["src/foo.ts"] }),
    strikeCap: 1,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...failing, state: "success", headSha: "sha-1", criteria: [criterion({ claim: "criterion A merges cleanly", met: true })] }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      // The implement diff ALREADY carried an out-of-scope file before this rung ever ran
      // (scopeGuardOutOfScopeFiles's own push-and-flag disposition, rationale 6) — every
      // observation this invocation makes reports the identical, unchanged set.
      fetchPrDiffFiles: async () => ["src/foo.ts", "docs/pre-existing-note.md"],
    },
  });

  assert.equal(spawnCalls.length, 1, "round 1 dispatches normally — a pre-existing violation is not this rung's to re-litigate");
  assert.equal(outcome.outcome, "fixed");
});

test("runFixRung (criterion 5): the scope stand-down never calls updatePrBody — the rung refuses rather than rewrites the PR body or the task record", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  let updatePrBodyCalls = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T1227W", title: "fix the CI baseline", files: ["src/foo.ts"] }),
    strikeCap: 3,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...failing, headSha: "sha-1" }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      updatePrBody: async () => {
        updatePrBodyCalls++;
      },
      fetchPrDiffFiles: diffFileSequence([["src/foo.ts"], ["src/foo.ts"], ["src/foo.ts", "scripts/rogue.json"]]),
    },
  });

  assert.equal(outcome.outcome, "stood_down");
  assert.equal(updatePrBodyCalls, 0, "the stand-down never rewrites the PR body");
});
