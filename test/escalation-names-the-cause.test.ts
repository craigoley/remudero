/**
 * test/escalation-names-the-cause.test.ts — W1-T1279.
 *
 * THE DEFECT (issues/2624, verbatim). `fetchCiFailures` shells `gh run view --job <id>
 * --log-failed`, whose extract is lines shaped `<job>\t<step>\t<timestamp> <content>` — and the
 * FIRST such line is, BY CONSTRUCTION, the failing step's own `##[group]Run <cmd>` invocation
 * banner for every `run:` step GitHub Actions executes. `summarizeCiFailure` reduced `logTail` to
 * `.find((l) => l.length > 0)` — the first non-empty line — so the exhaustion escalation's
 * "Failing check(s):" section named the COMMAND that ran, never the diagnostic that failed it.
 * The diagnostic the rung had *already parsed into its fix prompt* (`renderFixPrompt`, which
 * renders the SAME `logTail` in full) was dropped from the one artifact an operator reads.
 *
 * THE FIX is a SELECTION change inside `summarizeCiFailure` only (src/run-task.ts) — no new
 * fetch, no new field, no new call — plus one added TRAJECTORY line on the exhaustion escalation
 * body, naming what earlier strikes repaired even when a later, different check is what finally
 * exhausted the rung (issues/2642's "two wasted attempts" reading, which the branch behind it
 * contradicts). NO GATEWAY IS REACHED HERE: `deps.spawn`/`deps.issues`/`deps.waitForCiGreen`/
 * `deps.fetchCiFailures` are all injected fakes; nothing on this file's path shells out to `gh`
 * or a worker.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "../src/run-task.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

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

function fixRungBaseOpts() {
  return {
    taskId: "W1-TX",
    runId: "W1-TX-1730000000000",
    task: { id: "W1-TX", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/1",
    branch: "run-W1-TX-1730000000000",
    worktreePath: "/tmp/rmd-fixrung-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escname-")), "ledger.ndjson");
}

function fakeIssues(calls: Array<{ title: string; body: string; labels: string[] }>): IssueGateway {
  return {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/acme/remudero/issues/9";
    },
  };
}

// The real `gh run view --job <id> --log-failed` shape: `<job>\t<step>\t<timestamp> <content>`.
const RUN_BANNER = "ci\tTypecheck\t2026-08-23T16:01:14.5196266Z ##[group]Run npx tsc -p tsconfig.json --noEmit";
const TS_DIAGNOSTIC =
  "ci\tTypecheck\t2026-08-23T16:01:15.0000000Z test/sandbox-subject-generator.test.ts(90,9): error TS2741: " +
  "Property 'bySubsystem' is missing but required in type 'LearningsIndex'";
const END_GROUP = "ci\tTypecheck\t2026-08-23T16:01:16.0000000Z ##[endgroup]";
const GATE_SECTION_BANNER = "ci-gate\tAggregate sibling check results\t2026-08-23T16:12:44.8447744Z --- gated check runs ---";

// ── (1)/(2) THE CAUSE: summarizeCiFailure names the diagnostic, never the invocation ─────────

test("runFixRung: a blocked_ci exhaustion whose failing check's log BEGINS WITH A RUN BANNER names the diagnostic line, not the invocation", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ciFailures: CiFailure[] = [{ name: "ci", logTail: [RUN_BANNER, TS_DIAGNOSTIC, END_GROUP].join("\n") }];
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", []),
    ciFailures,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => ciFailures,
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(issueCalls.length, 1);
  const body = issueCalls[0].body;
  assert.match(
    body,
    /Failing check\(s\):\n\n- ci — test\/sandbox-subject-generator\.test\.ts\(90,9\): error TS2741: Property 'bySubsystem'/,
    "the summary line carries the tsc diagnostic, stripped of the <job>\\t<step>\\t<timestamp> prefix",
  );
  assert.doesNotMatch(
    body,
    /##\[group\]Run npx tsc/,
    "the invocation banner — structurally always the extract's first line — is never what gets rendered",
  );
});

test("runFixRung: a blocked_ci exhaustion whose failing check's log carries NO diagnostic-shaped line still renders a summary, not an empty entry", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  // Every line is structural preamble — a run banner, its endgroup, and a section banner — the
  // exact shape a `ci-gate` aggregator's log tail carries (issues/2624's second entry).
  const ciFailures: CiFailure[] = [{ name: "ci-gate", logTail: [RUN_BANNER, END_GROUP, GATE_SECTION_BANNER].join("\n") }];
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", []),
    ciFailures,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => ciFailures,
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(issueCalls.length, 1);
  const body = issueCalls[0].body;
  // The W1-T487 empty-evidence floor's wording is untouched — this is a NON-empty list (one real
  // CiFailure), so it renders the fallback line rather than "(no evidence — ...)".
  assert.doesNotMatch(body, /no evidence/, "a real (if diagnostic-less) entry is never mistaken for an empty list");
  assert.match(
    body,
    /Failing check\(s\):\n\n- ci-gate — ci\tTypecheck\t2026-08-23T16:01:14\.5196266Z ##\[group\]Run npx tsc/,
    "when nothing looks like a diagnostic, this falls back to exactly today's selection — the raw first line — rather than to nothing",
  );
});

// ── (3) ONE LINE PER CHECK, NEVER A LOG DUMP ──────────────────────────────────────────────────

test("runFixRung: a blocked_ci exhaustion with MULTIPLE failing checks still renders exactly one line per check", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ciFailures: CiFailure[] = [
    { name: "ci", logTail: [RUN_BANNER, TS_DIAGNOSTIC, END_GROUP].join("\n") },
    { name: "ci-gate", logTail: [RUN_BANNER, END_GROUP, GATE_SECTION_BANNER].join("\n") },
  ];
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", []),
    ciFailures,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => ciFailures,
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  const body = issueCalls[0].body;
  const block = body.match(/Failing check\(s\):\n\n([\s\S]*?)\n\n/)?.[1];
  assert.ok(block, "the evidence block must be present");
  const bulletLines = (block as string).split("\n");
  assert.equal(bulletLines.length, 2, "exactly one rendered line per failing check — never a wrapped/multi-line dump");
  assert.ok(
    bulletLines.every((l) => l.startsWith("- ")),
    "every line is its own bullet, never a continuation of the previous one",
  );
});

// ── (4) THE TRAJECTORY: earlier strikes' repairs are visible, not only the final outcome ─────

test("runFixRung: an exhaustion after MULTIPLE strikes states what an EARLIER strike repaired, even though a DIFFERENT check is what finally exhausted the rung", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  let fetchCalls = 0;
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: fakeReview("failure", []),
    // Round 1 dispatches against TWO red checks.
    ciFailures: [
      { name: "typecheck", logTail: "irrelevant — round 1 dispatches on this" },
      { name: "lint", logTail: "irrelevant — round 1 dispatches on this" },
    ],
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => {
        fetchCalls++;
        // Strike 1's push repaired `typecheck` — only `lint` is still red afterward — and it
        // STAYS the only one still red through strike 2 as well (the rung still exhausts).
        return [{ name: "lint", logTail: "eslint: still broken" }];
      },
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.strikes, 2, "both strikes were spent before exhaustion");
  assert.equal(fetchCalls, 2, "the failing-check evidence was refreshed after each of the two strikes");
  const body = issueCalls[0].body;
  assert.match(
    body,
    /Failing check\(s\):\n\n- lint — eslint: still broken/,
    "the final Failing check(s) list names only what is STILL red at exhaustion",
  );
  assert.match(
    body,
    /Earlier strike\(s\) already repaired: typecheck\./,
    "a trajectory line credits the earlier strike for a real repair, even though the rung still exhausted on a different check",
  );
});

test("runFixRung: an exhaustion after a SINGLE strike (nothing was ever repaired) renders no trajectory line at all", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ciFailures: CiFailure[] = [{ name: "typecheck", logTail: "tsc: error TS2322" }];
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", []),
    ciFailures,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => ciFailures,
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.doesNotMatch(
    issueCalls[0].body,
    /Earlier strike\(s\) already repaired/,
    "the ordinary single-strike exhaustion — nothing to report a trajectory about — stays exactly as short as before",
  );
});

// ── (5) THE W1-T487 EMPTY-EVIDENCE WORDING KEEPS ITS TWO DISTINGUISHABLE FORMS ────────────────

test("runFixRung: a blocked_ci exhaustion whose failing-check list was CHECKED AND IS EMPTY still says so in words, unchanged by the diagnostic-selection fix", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", []),
    ciFailures: [{ name: "ci", logTail: "irrelevant — round 1 dispatches on this" }],
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [],
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.match(
    issueCalls[0].body,
    /Failing check\(s\):\n\n\(no evidence — this was checked and is empty\)/,
    "checked-and-empty still reads distinctly from never-collected",
  );
});

test("runFixRung: a blocked_ci exhaustion whose failing-check list was NEVER COLLECTED still says so in words, unchanged by the diagnostic-selection fix", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })]),
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      runReview: async () => {
        throw new Error("runReview must never be called — CI regressed before any review could run");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.match(
    issueCalls[0].body,
    /Failing check\(s\):\n\n\(no evidence — this was never collected for this rung\)/,
    "never-collected still reads distinctly from checked-and-empty",
  );
  assert.doesNotMatch(issueCalls[0].body, /Earlier strike\(s\) already repaired/, "nothing was ever red, so no trajectory to state");
});
