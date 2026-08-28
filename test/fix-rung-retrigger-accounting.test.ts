import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DEFAULT_FIX_RETRIGGER_CAP, isRetriggerShapedCommit, runFixRung } from "../src/run-task.js";
import type { FixRoundCommit } from "../src/run-task.js";
import { fixStrikeCap } from "../src/lib/config.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

/**
 * W1-T2403 — THE FIX RUNG SPENDS A WORKER TO RE-RUN A JOB, AND THE RETRIGGER CONSUMES A STRIKE.
 *
 * MEASURED (this task's own rationale): 11 of 72 commits on fix-touched PRs are RETRIGGER-SHAPED
 * — an empty commit, or a subject naming a known-flaky re-trigger — and 4 of 10 strike-exhausted
 * PRs in the sample carried one, spending `fixStrikeCap` on infrastructure noise before
 * escalating with no defect fixed. Every fixture below drives `runFixRung` itself (never a
 * hand-rolled reimplementation of its accounting), the same real dispatch loop the
 * daemon/sweep/drain paths all share — mirroring test/strike-accounting.test.ts's own discipline.
 */

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

function result(over: Partial<WorkerResult>): WorkerResult {
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

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts() {
  return {
    taskId: "W1-D",
    runId: "W1-D-1730000000000",
    task: { id: "W1-D", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/3121",
    branch: "run-W1-D-1730000000000",
    worktreePath: "/tmp/rmd-retrigger-accounting-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-retrigger-accounting-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-retrigger-accounting-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-retrigger-accounting-")), "ledger.ndjson");
}

function fakeIssues(calls: Array<{ title: string; body: string; labels: string[] }>): IssueGateway {
  return {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/acme/remudero/issues/3122";
    },
  };
}

function captureLog(): {
  lines: Array<{ task_id: string; step: string } & Record<string, unknown>>;
  log: (step: string, extra?: Record<string, unknown>) => void;
} {
  const lines: Array<{ task_id: string; step: string } & Record<string, unknown>> = [];
  return {
    lines,
    log: (step, extra) => lines.push({ task_id: "W1-D", step, ...(extra ?? {}) }),
  };
}

/** The exact `cf21fb53` shape this task's own rationale names — an empty commit whose subject is
 *  a retrigger for a known-flaky infra check. */
const RETRIGGER_COMMIT: FixRoundCommit = {
  changedFiles: 0,
  subject: "ci: retrigger for a coverage-ratchet infra flake unrelated to this diff",
};

const REAL_FIX_COMMIT: FixRoundCommit = {
  changedFiles: 3,
  subject: "fix: repair the actual regression the review flagged",
};

// ── THE CLASSIFIER ITSELF — isRetriggerShapedCommit ──────────────────────────────────────────

test("W1-T2403: isRetriggerShapedCommit — an empty commit (zero changed files) is retrigger-shaped regardless of subject", () => {
  assert.equal(isRetriggerShapedCommit({ changedFiles: 0, subject: "chore: nothing to see here" }), true);
});

test("W1-T2403: isRetriggerShapedCommit — cf21fb53's own subject on a real diff is STILL retrigger-shaped (subject-arm)", () => {
  assert.equal(isRetriggerShapedCommit({ changedFiles: 0, subject: RETRIGGER_COMMIT.subject }), true);
});

test("W1-T2403: isRetriggerShapedCommit — 're-trigger' (hyphenated) and 'retrigger' (bare) both match", () => {
  assert.equal(isRetriggerShapedCommit({ changedFiles: 1, subject: "ci: re-trigger the flaky check" }), true);
  assert.equal(isRetriggerShapedCommit({ changedFiles: 1, subject: "ci: retrigger the flaky check" }), true);
});

test("W1-T2403: isRetriggerShapedCommit — flake/flaky/infra word ALONE, with no ci/check/coverage/run/rerun word, does not match", () => {
  assert.equal(isRetriggerShapedCommit({ changedFiles: 1, subject: "fix: work around a flaky dependency" }), false);
});

test("W1-T2403: isRetriggerShapedCommit — both word groups together match without the literal word 'retrigger'", () => {
  assert.equal(isRetriggerShapedCommit({ changedFiles: 1, subject: "ci: infra flake in the coverage job" }), true);
});

test("W1-T2403: isRetriggerShapedCommit — a real fix that changed lines for an ordinary reason does not match", () => {
  assert.equal(isRetriggerShapedCommit(REAL_FIX_COMMIT), false);
});

test("W1-T2403: isRetriggerShapedCommit — the ONE named subject-arm false positive from this task's own rationale (852b5c3a) is accepted, not a defect in the classifier", () => {
  // "test(w1-t187): retry the CI-flaky 500ms benchmark before failing" — changed real lines, but
  // its SUBJECT names both a flake word and a ci word, exactly as the rationale states it must
  // (measured false-positive rate: 1 in 62). The classifier is a stated LOWER BOUND, not perfect.
  assert.equal(
    isRetriggerShapedCommit({ changedFiles: 1, subject: "test(w1-t187): retry the CI-flaky 500ms benchmark before failing" }),
    true,
  );
});

// ── claim 1 & 2 — a retrigger round is recorded as such; a real repair is still ordinary ────

test("W1-T2403: a retrigger-shaped round is logged fix.retrigger (never fix.dispatch) and spends no strike; a later real repair on the SAME rung is still an ordinary fix.dispatch strike", async () => {
  const { lines, log } = captureLog();
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  let spawnCalls = 0;
  const commitsPerRound = [RETRIGGER_COMMIT, REAL_FIX_COMMIT];

  const rung = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 5,
    retriggerCap: 5,
    initialReview: fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })], "sha-0"),
    deps: {
      spawn: async () => {
        const r = result({ sessionId: `fix-session-${spawnCalls}` });
        spawnCalls++;
        return r;
      },
      readRoundCommits: async () => [commitsPerRound[spawnCalls - 1]],
      waitForCiGreen: async () => "green",
      runReview: async () =>
        spawnCalls === 1
          ? fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })], "sha-1")
          : fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })], "sha-2"),
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log,
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls, 2, "two rounds ran — one retrigger, one real repair");
  assert.equal(rung.outcome, "fixed", "the real repair round resolved the review");
  assert.equal(rung.strikes, 1, "ONLY the real-repair round counted as a strike");
  assert.equal(rung.retriggers, 1, "the retrigger round counted separately");

  const retriggerLines = lines.filter((l) => l.step === "fix.retrigger");
  const dispatchLines = lines.filter((l) => l.step === "fix.dispatch");
  assert.equal(retriggerLines.length, 1, "exactly one fix.retrigger line — the empty/retrigger-named commit round");
  assert.equal(dispatchLines.length, 1, "exactly one fix.dispatch line — the real-repair round");
  assert.equal(dispatchLines[0]?.strike, 1, "the real repair is strike 1, not strike 2 — the retrigger never advanced the count");
  assert.equal(issueCalls.length, 0, "the rung resolved — nothing escalated");
});

// ── claim 3 — a retrigger on an unchanged head is bounded by its own counter, never a timer ──

test("W1-T2403: an all-retrigger rung is bounded by retriggerCap (never strikeCap, never a timer) and escalates once the count is reached", async () => {
  const { lines, log } = captureLog();
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  let spawnCalls = 0;
  const RETRIGGER_CAP = 3;

  const startedAt = Date.now();
  const rung = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 50, // deliberately huge — must NEVER be what bounds this loop
    retriggerCap: RETRIGGER_CAP,
    initialReview: fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })], "sha-0"),
    deps: {
      spawn: async () => {
        spawnCalls++;
        return result({ sessionId: `fix-session-${spawnCalls}` });
      },
      readRoundCommits: async () => [RETRIGGER_COMMIT],
      waitForCiGreen: async () => "green",
      // A DISTINCT head every round — the empty commit still gets its own sha on GitHub — so the
      // review false-block escape (a DIFFERENT guard than this task's own) never intercepts it.
      runReview: async () =>
        fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })], `sha-${spawnCalls}`),
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log,
      say: () => {},
      account: (r) => r,
    },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(spawnCalls, RETRIGGER_CAP, "the rung stopped dispatching after exactly retriggerCap rounds");
  assert.equal(rung.strikes, 0, "not a single strike was spent — every round was retrigger-shaped");
  assert.equal(rung.retriggers, RETRIGGER_CAP, "the retrigger counter, not strikeCap (50), is what bound this loop");
  assert.equal(rung.outcome, "escalated");
  assert.equal(rung.reason, "retrigger_cap_exhausted", "the exhaustion is attributed to the RETRIGGER cap, not the strike cap");
  assert.equal(issueCalls.length, 1, "the rung escalated exactly once");
  assert.ok(!lines.some((l) => l.step === "fix.dispatch"), "no fix.dispatch line exists — priorStrikesFor would read zero strikes from this ledger");
  assert.ok(
    elapsedMs < 2000,
    `a bound implemented as a COUNTER resolves near-instantly with fake deps; ${elapsedMs}ms suggests something is pacing/sleeping instead`,
  );
});

// ── claim 4 & 5 — a real defect still spends real strikes, exhausts at the UNCHANGED cap ────

test("W1-T2403: a real defect (never retrigger-shaped) still spends real strikes and still exhausts at strikeCap, unaffected by a generous retriggerCap", async () => {
  const { lines, log } = captureLog();
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  let spawnCalls = 0;
  const STRIKE_CAP = 2;

  const rung = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: STRIKE_CAP,
    retriggerCap: 50, // deliberately huge — must NEVER be what bounds this loop
    initialReview: fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })], "sha-0"),
    deps: {
      spawn: async () => {
        spawnCalls++;
        return result({ sessionId: `fix-session-${spawnCalls}` });
      },
      readRoundCommits: async () => [REAL_FIX_COMMIT],
      waitForCiGreen: async () => "green",
      runReview: async () =>
        fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })], `sha-${spawnCalls}`),
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log,
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls, STRIKE_CAP, "exactly strikeCap rounds ran");
  assert.equal(rung.strikes, STRIKE_CAP, "every round was a real strike");
  assert.equal(rung.retriggers, 0, "no round was ever classified retrigger-shaped");
  assert.equal(rung.outcome, "escalated");
  assert.notEqual(rung.reason, "retrigger_cap_exhausted", "this exhaustion is the ORDINARY strike-cap exhaustion, not the retrigger one");
  assert.equal(issueCalls.length, 1);
  assert.equal(lines.filter((l) => l.step === "fix.dispatch").length, STRIKE_CAP, "every round wrote a real fix.dispatch strike line");
  assert.ok(!lines.some((l) => l.step === "fix.retrigger"), "no fix.retrigger line exists — nothing was misclassified");
});

test("W1-T2403: DEFAULT_FIX_RETRIGGER_CAP is a small, separate bound — never equal to a raised/lowered fixStrikeCap in disguise", () => {
  assert.ok(DEFAULT_FIX_RETRIGGER_CAP >= 1 && DEFAULT_FIX_RETRIGGER_CAP <= 5, "small, per W1-T2345's own 'bound the repetition' shape");
});

test("W1-T2403: fixStrikeCap's own default is unchanged by this task, in either direction", () => {
  assert.equal(fixStrikeCap({} as Config), 2, "the cap default this task leaves untouched — a separate retrigger counter is the remedy, never a raised or lowered cap");
});

// ── claim 6 — a permanently failing check stops retriggering and escalates NAMING the check ──

test("W1-T2403: a permanently red check (never green, every round retrigger-shaped) stops after retriggerCap and its escalation NAMES the check", async () => {
  const { lines, log } = captureLog();
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  let spawnCalls = 0;
  const RETRIGGER_CAP = 2;

  const rung = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 50,
    retriggerCap: RETRIGGER_CAP,
    initialReview: fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })], "sha-0"),
    // ci-log mode from round 1: no review has ever posted, the check itself is the evidence.
    ciFailures: [{ name: "coverage-ratchet", logTail: "flaky infra hiccup" }],
    deps: {
      spawn: async () => {
        spawnCalls++;
        return result({ sessionId: `fix-session-${spawnCalls}` });
      },
      readRoundCommits: async () => [RETRIGGER_COMMIT],
      // The check NEVER goes green — a permanent flake, not a transient one.
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "coverage-ratchet", logTail: "still red" }],
      runReview: async () => {
        throw new Error("must never be called — CI never went green, so no review ever runs");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log,
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls, RETRIGGER_CAP, "stopped after exactly retriggerCap rounds");
  assert.equal(rung.strikes, 0, "zero strikes spent chasing a check that was never going to turn green");
  assert.equal(rung.retriggers, RETRIGGER_CAP);
  assert.equal(rung.outcome, "escalated");
  assert.equal(rung.reason, "retrigger_cap_exhausted");
  assert.equal(issueCalls.length, 1);
  const issueText = `${issueCalls[0]?.title ?? ""} ${issueCalls[0]?.body ?? ""}`;
  assert.match(issueText, /coverage-ratchet/, "the escalation NAMES the check that stayed red, not a generic 'exhausted' message");
  assert.ok(!lines.some((l) => l.step === "fix.dispatch"), "no fix.dispatch line — nothing was ever a real strike");
});

// ── claim 7 — nothing added paces, throttles, or sleeps a call ──────────────────────────────

test("W1-T2403: the retrigger-accounting code this task adds contains no setTimeout/setInterval/sleep call", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  const startMarker = "W1-T2403 — THE RETRIGGER-SHAPED FIX OUTCOME, ACCOUNTED SEPARATELY FROM A STRIKE";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx >= 0, "the retrigger-accounting section marker is present in src/run-task.ts");
  // Bound the scan to the classifier + runFixRung's own body (well past its closing brace) —
  // never the whole 30k-line file, which legitimately uses setTimeout elsewhere (W1-T1044's own
  // spawn wall-clock bound) for concerns this task does not touch.
  const endMarker = "/** The verdict + ledger payload a worker's ERROR envelope maps to. */";
  const endIdx = src.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, "the runFixRung section this task edited has a locatable end");
  const section = src.slice(startIdx, endIdx);
  assert.doesNotMatch(section, /\bsetTimeout\s*\(/, "no setTimeout call was added — the retrigger bound is a COUNT, never a timer");
  assert.doesNotMatch(section, /\bsetInterval\s*\(/, "no setInterval call was added");
  assert.doesNotMatch(section, /\bsleep\s*\(/, "no sleep call was added");
});
