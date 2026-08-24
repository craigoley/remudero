/**
 * test/fix-rung-authorship-stand-down.test.ts — W1-T296.
 *
 * THE DEFECT. The fix rung's pre-strike gate (`fixRungStandDownReason`, site `rung.strike` in
 * run-task.ts) read ONLY the PR's terminal GitHub state (merged/closed, W1-T177). A PR that is
 * still OPEN but whose head moved under a human's or a sibling session's hands reads exactly like
 * a PR nobody touched, so the rung struck anyway — dispatching a fix worker that either CLOBBERS
 * or DUPLICATES in-flight manual work.
 *
 * THE FIX. `branchAuthorshipStandDownReason` (pure) compares the PR's freshly-read live head sha
 * against the sha THIS invocation's own most recent strike produced. A first round has no such
 * reference and is never read as foreign (standing down on it would disable the fix rung
 * entirely). A live head equal to the rung's own is not foreign either. Any OTHER live head means
 * the branch moved under the rung — and unlike a terminal-state stand-down (which ledgers only:
 * a merged/closed PR carries no decidable question), this stands down AND escalates, naming the
 * foreign head sha and its author, per §4's "never a bare alert" discipline. An unreadable head
 * read fails OPEN, exactly like every other stand-down source in this file (W1-T177's own
 * contract) — a `gh` outage must never become a silent fleet-wide halt.
 *
 * This is composed into the EXISTING `fixRungStandDownReason` gate at site `rung.strike` — not a
 * second early-return path — so every test below that drives the full rung asserts exactly ONE
 * `fix.stood_down` ledger line per stand-down, carrying the SAME `{site, strike, reason}` shape
 * the pre-existing terminal-state stand-down already wrote (plus `issue_url` only when this new
 * reason escalates).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung, branchAuthorshipStandDownReason, type LiveHeadResult } from "../src/run-task.js";
import { stillRedRequiredNames, type RollupCheckEntry } from "../src/lib/sweep.js";
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

/** Shared, injectable base options for `runFixRung` — mirrors run-task.test.ts's own helper. */
function fixRungBaseOpts() {
  return {
    taskId: "W1-T296X",
    runId: "W1-T296X-1730000000000",
    task: { id: "W1-T296X", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/1",
    branch: "run-W1-T296X-1730000000000",
    worktreePath: "/tmp/rmd-fixrung-authorship-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-authorship-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-authorship-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-authorship-")), "ledger.ndjson");
}

/** A real dedup-capable issue gateway fake (create + listOpen + comment), so the W1-T195
 *  dedup-shape claim (criterion 5) is driven through `escalate()`'s REAL dedup logic, not
 *  asserted by hand. */
function fakeIssueStore(): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
  comments: Array<{ url: string; body: string }>;
} {
  let seq = 900;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const comments: Array<{ url: string; body: string }> = [];
  return {
    calls,
    comments,
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
    comment(url, body) {
      comments.push({ url, body });
    },
  };
}

// ── branchAuthorshipStandDownReason — the pure boundary (criteria 3, 4, 6) ──────────────────────

test("branchAuthorshipStandDownReason: a FIRST round (no rung-produced head yet) is never read as foreign, no matter what the live head is", () => {
  const live: LiveHeadResult = { ok: true, headSha: "totally-different-sha", author: "some-human" };
  assert.equal(branchAuthorshipStandDownReason(undefined, live), undefined);
});

test("branchAuthorshipStandDownReason: a live head equal to the rung's own last-pushed head is NOT foreign", () => {
  const live: LiveHeadResult = { ok: true, headSha: "sha-1", author: "rung-bot" };
  assert.equal(branchAuthorshipStandDownReason("sha-1", live), undefined);
});

test("branchAuthorshipStandDownReason: a live head DIFFERENT from the rung's own last-pushed head is foreign, naming both the observed sha and its author", () => {
  const live: LiveHeadResult = { ok: true, headSha: "sha-2-foreign", author: "human-x" };
  const got = branchAuthorshipStandDownReason("sha-1", live);
  assert.ok(got, "a differing live head must be detected");
  assert.equal(got.headSha, "sha-2-foreign");
  assert.equal(got.author, "human-x");
  assert.match(got.reason, /sha-2-foreign/);
  assert.match(got.reason, /human-x/);
});

test("branchAuthorshipStandDownReason: an UNREADABLE live head (ok:false, or ok:true with no headSha) fails OPEN — never read as foreign", () => {
  assert.equal(branchAuthorshipStandDownReason("sha-1", { ok: false }), undefined);
  assert.equal(branchAuthorshipStandDownReason("sha-1", { ok: true }), undefined, "ok but missing headSha is still unreadable");
});

test("branchAuthorshipStandDownReason: a missing author on an otherwise-successful foreign read still reports, naming 'unknown author' rather than throwing or going silent", () => {
  const got = branchAuthorshipStandDownReason("sha-1", { ok: true, headSha: "sha-2-foreign" });
  assert.ok(got);
  assert.equal(got.author, "unknown author");
});

// ── the full rung, behaviorally (criteria 1, 2, 3, 4, 5) ─────────────────────────────────────────

test("runFixRung (criteria 1+2): a still-OPEN PR whose head is moved by a non-rung author after round 1 stands down before round 2's strike, spends ZERO further strikes, and ESCALATES naming the foreign head sha + author (never a bare alert)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const issues = fakeIssueStore();
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      // Round 1's own strike lands sha-1, still failing — the loop heads to round 2.
      runReview: async () => ({ ...failing, headSha: "sha-1" }),
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // Every pre-strike read observes a head the rung never pushed — round 1
      // discards this (no rung-produced head to compare against yet); round 2
      // reads it as foreign and stands down before ever reaching round 2's strike.
      readLiveHead: async () => ({ ok: true, headSha: "sha-2-foreign", author: "human-x" }),
    },
  });

  assert.equal(spawnCalls.length, 1, "exactly ONE strike — round 1's; round 2 never dispatches a fix worker");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 1, "strikes never incremented past round 1");
  assert.match(outcome.standDownReason ?? "", /sha-2-foreign/);
  assert.match(outcome.standDownReason ?? "", /human-x/);
  assert.ok(outcome.issueUrl, "the stand-down escalates — an issue url is returned");

  assert.equal(issues.calls.length, 1, "exactly one needs-human issue opened");
  assert.match(issues.calls[0].body, /sha-2-foreign/, "the issue names the foreign head sha");
  assert.match(issues.calls[0].body, /human-x/, "the issue names the foreign head's author");
  assert.match(issues.calls[0].body, /## Options/, "an actionable choice is present — never a bare alert (§4)");

  // Composed into the EXISTING gate, not a parallel early-return: exactly ONE
  // fix.stood_down line, in the SAME {site, strike, reason} shape the pre-existing
  // terminal-state stand-down writes, now also carrying issue_url.
  const stoodDown = logs.filter((l) => l.step === "fix.stood_down");
  assert.equal(stoodDown.length, 1);
  assert.equal(stoodDown[0].extra?.site, "rung.strike");
  assert.equal(stoodDown[0].extra?.strike, 2, "named as the strike that was about to be spent");
  assert.equal(stoodDown[0].extra?.reason, outcome.standDownReason);
  assert.equal(stoodDown[0].extra?.issue_url, outcome.issueUrl);
});

test("runFixRung (criterion 3, first half): a FIRST round against a PR the rung has never pushed to proceeds normally, even though the live head already reads as 'foreign' by sha — standing down here would disable the fix rung entirely", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
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
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // No rung-produced head exists yet, so this "foreign-looking" answer must
      // be ignored on round 1 — there is nothing yet to compare it against.
      readLiveHead: async () => ({ ok: true, headSha: "some-pre-existing-head", author: "whoever-opened-it" }),
    },
  });

  assert.equal(spawnCalls.length, 1, "round 1's strike is dispatched — never suppressed by the authorship check");
  assert.equal(outcome.outcome, "fixed");
});

test("runFixRung (criterion 3, second half): a head the RUNG ITSELF pushed in round 1 is not read as foreign in round 2 — the rung proceeds and spends round 2's strike normally", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  let round = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
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
          ? { ...failing, headSha: "sha-1" } // round 1: still failing, real progress (distinct head)
          : { ...failing, state: "success", headSha: "sha-2", criteria: [criterion({ claim: "criterion A merges cleanly", met: true })] };
      },
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // Reports back EXACTLY the head round 1 itself produced — its own work,
      // not a foreign takeover.
      readLiveHead: async () => ({ ok: true, headSha: "sha-1", author: "rung-bot" }),
    },
  });

  assert.equal(spawnCalls.length, 2, "both strikes spent — round 2 is never suppressed by its own prior push");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 2);
});

test("runFixRung (criterion 4): an UNREADABLE live-head read PROCEEDS exactly as before this check existed, and ledgers the indeterminate read under its OWN step name (distinct from the terminal-state read's)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let round = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
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
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // A `gh` outage on every attempt — never treated as terminal or foreign.
      readLiveHead: async () => ({ ok: false }),
    },
  });

  assert.equal(spawnCalls.length, 2, "an unreadable head read never stands the rung down — every strike still spends");
  assert.equal(outcome.outcome, "fixed");
  const indeterminate = logs.filter((l) => l.step === "fix.live_head_indeterminate");
  assert.equal(indeterminate.length, 2, "ledgered at both rounds' pre-strike checks — never a silent swallow");
  assert.equal(indeterminate[0].extra?.site, "rung.strike");
  assert.equal(
    logs.filter((l) => l.step === "fix.live_state_indeterminate").length,
    0,
    "distinct step name from the terminal-state read's own indeterminate ledger line — the two causes stay legible apart",
  );
  assert.equal(logs.filter((l) => l.step === "fix.stood_down").length, 0);
});

test("runFixRung (criterion 5): repeated invocations that observe the SAME foreign head escalate ONCE — the second appends a comment on the first's issue rather than opening a sibling (W1-T195's dedup shape)", async () => {
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const issues = fakeIssueStore();

  async function driveOneInvocation() {
    const spawnCalls: SpawnWorkerArgs[] = [];
    return runFixRung({
      ...fixRungBaseOpts(),
      strikeCap: 3,
      initialReview: failing,
      deps: {
        spawn: async (args) => {
          spawnCalls.push(args);
          return result({ sessionId: `s-${spawnCalls.length}` });
        },
        waitForCiGreen: async () => "green",
        // Round 1 always lands the SAME head sha in both invocations (a fresh
        // sweep-triggered dispatch re-attempting the identical, still-unresolved PR).
        runReview: async () => ({ ...failing, headSha: "sha-1" }),
        push: () => {},
        issues,
        ledgerPath: tmpLedgerPath(),
        log: () => {},
        say: () => {},
        account: (r) => r,
        readLiveState: async () => ({ ok: true, state: "OPEN" }),
        // Both invocations' round-2 checks observe the SAME foreign takeover —
        // nobody has resolved it between sweep passes.
        readLiveHead: async () => ({ ok: true, headSha: "sha-foreign-shared", author: "human-x" }),
      },
    });
  }

  const first = await driveOneInvocation();
  const second = await driveOneInvocation();

  assert.equal(first.outcome, "stood_down");
  assert.equal(second.outcome, "stood_down");
  assert.equal(issues.calls.length, 1, "exactly ONE needs-human issue created across both invocations");
  assert.equal(issues.comments.length, 1, "the second observation appends a comment instead of opening a sibling");
  assert.equal(first.issueUrl, second.issueUrl, "both invocations report the identical issue url");
});

// ── W1-T1278 — THE FIX RUNG RE-READS THE STATE BEFORE SPENDING A STRIKE ─────────────────────────
//
// Condition A: a `blocked_ci`-shaped strike is about to target the ONLY required check name it
// believes is red, but a FRESH read shows a later attempt on that SAME name already running —
// declining buys nothing wrong (criterion 1), a genuinely-still-red name still gets its strike
// (criterion 2), and a second, genuinely-still-red name keeps the rung dispatching even though a
// FIRST name was superseded (criterion 3). Condition B: a FRESH merge-facts read shows the PR is
// actually dirty (`mergeable_state: dirty`) — a state that registers no new check runs at all, so
// no strike (however spent) can observe progress; the rung declines and defers (criterion 4), and
// the decline is legible on the ledger with nothing repaired by the rung itself (criterion 5).

// ── stillRedRequiredNames — the pure boundary for condition A ───────────────────────────────────

test("stillRedRequiredNames: a red name whose fresh latest attempt is a NON-TERMINAL (still running) status with an observed startedAt is dropped — superseded", () => {
  const rollup: RollupCheckEntry[] = [{ name: "coverage-ratchet", state: "IN_PROGRESS", startedAt: "2026-08-24T00:10:00Z" }];
  assert.deepEqual(stillRedRequiredNames(["coverage-ratchet"], rollup), []);
});

test("stillRedRequiredNames: a red name whose fresh latest attempt is STILL a terminal failure stays red", () => {
  const rollup: RollupCheckEntry[] = [{ name: "coverage-ratchet", state: "FAILURE", startedAt: "2026-08-24T00:10:00Z" }];
  assert.deepEqual(stillRedRequiredNames(["coverage-ratchet"], rollup), ["coverage-ratchet"]);
});

test("stillRedRequiredNames: a name absent from the fresh rollup, or present with no observed startedAt, fails OPEN — stays red, never manufactures a stand-down", () => {
  assert.deepEqual(stillRedRequiredNames(["coverage-ratchet"], []), ["coverage-ratchet"]);
  assert.deepEqual(
    stillRedRequiredNames(["coverage-ratchet"], [{ name: "coverage-ratchet", state: "IN_PROGRESS" }]),
    ["coverage-ratchet"],
    "present but no startedAt is still unreadable — never treated as an observed later attempt",
  );
});

test("stillRedRequiredNames: of TWO red names, only the one with an observed pending later attempt is dropped — the other stays red", () => {
  const rollup: RollupCheckEntry[] = [
    { name: "coverage-ratchet", state: "IN_PROGRESS", startedAt: "2026-08-24T00:10:00Z" },
    { name: "ci", state: "FAILURE", startedAt: "2026-08-24T00:05:00Z" },
  ];
  assert.deepEqual(stillRedRequiredNames(["coverage-ratchet", "ci"], rollup), ["ci"]);
});

// ── the full rung, behaviorally — the five acceptance criteria ──────────────────────────────────

test("runFixRung (W1-T1278 criterion 1): a strike is DECLINED when the only red required name has a later attempt already in flight on the same head", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures: [{ name: "coverage-ratchet", logTail: "mutation survivor at line 12" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...noReviewYet, state: "success", headSha: "sha-1" }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // A FRESH read shows the ONE believed-red required check now has a later attempt
      // executing right now — an OBSERVED fact, never inferred from a timestamp or a name.
      readCiRollup: async () => [{ name: "coverage-ratchet", state: "IN_PROGRESS", startedAt: "2026-08-24T00:10:00Z" }],
    },
  });

  assert.equal(spawnCalls.length, 0, "no fix worker is dispatched — the strike is declined before it is spent");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 0, "the strike counter never moved");
  assert.match(outcome.standDownReason ?? "", /coverage-ratchet/);
  assert.match(outcome.standDownReason ?? "", /already in flight/);
  const stoodDown = logs.filter((l) => l.step === "fix.stood_down");
  assert.equal(stoodDown.length, 1);
  assert.equal(stoodDown[0].extra?.site, "rung.strike");
  assert.equal(stoodDown[0].extra?.strike, 1, "named as the strike that was about to be spent");
});

test("runFixRung (W1-T1278 criterion 2): a red required name with NO later attempt still gets its strike, and the strike cap is unchanged", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: noReviewYet,
    ciFailures: [{ name: "coverage-ratchet", logTail: "mutation survivor at line 12" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      // CI never goes green — the check genuinely stays broken every round.
      waitForCiGreen: async () => "red",
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // A FRESH read confirms the SAME check is STILL red — no superseding attempt exists.
      readCiRollup: async () => [{ name: "coverage-ratchet", state: "FAILURE", startedAt: "2026-08-24T00:05:00Z" }],
    },
  });

  assert.equal(spawnCalls.length, 1, "the ONE strike this strikeCap allows is spent — never declined");
  assert.equal(outcome.outcome, "escalated", "strikeCap=1 exhausts after that ONE strike — the cap itself is unmoved by this task");
  assert.equal(outcome.strikes, 1);
});

test("runFixRung (W1-T1278 criterion 3): a SECOND red required name with nothing pending keeps the rung dispatching, even though the first has a later attempt in flight", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures: [
      { name: "coverage-ratchet", logTail: "mutation survivor at line 12" },
      { name: "ci", logTail: "tsc: error TS2322" },
    ],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...noReviewYet, state: "success", headSha: "sha-1" }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // coverage-ratchet is superseded, but "ci" is genuinely, still red — real work remains.
      readCiRollup: async () => [
        { name: "coverage-ratchet", state: "IN_PROGRESS", startedAt: "2026-08-24T00:10:00Z" },
        { name: "ci", state: "FAILURE", startedAt: "2026-08-24T00:05:00Z" },
      ],
    },
  });

  assert.equal(spawnCalls.length, 1, "the rung still dispatches — one red name still needs real work");
  assert.match(spawnCalls[0].prompt, /MODE: ci-log/);
  assert.equal(outcome.outcome, "fixed");
});

test("runFixRung (W1-T1278 criterion 4): a PR whose merge state is dirty DECLINES the strike and defers — never retries, never holds open indefinitely", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const updateBranchCalls: number[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: noReviewYet,
    // Dispatched believing CI is red (ci-log mode) — the #2605 shape: the TRUE state is a merge
    // conflict, which registers no new check runs at all.
    ciFailures: [{ name: "ci", logTail: "" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...noReviewYet, state: "success", headSha: "sha-1" }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      readMergeFacts: async () => ({ mergeable: "CONFLICTING" }),
      updateBranch: async (n) => {
        updateBranchCalls.push(n);
        return { ok: true };
      },
    },
  });

  assert.equal(spawnCalls.length, 0, "no fix worker is dispatched against a state that cannot be observed making progress");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 0, "declined, not spent — the strike is never charged");
  assert.match(outcome.standDownReason ?? "", /dirty/);
  assert.equal(updateBranchCalls.length, 0, "the rung never attempts to resolve the conflict itself (design note v)");
});

test("runFixRung (W1-T1278 criterion 5): the declined strike is NAMED in the ledger, and no conflict is resolved by the rung", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const updateBranchCalls: number[] = [];
  const pushCalls: string[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: noReviewYet,
    ciFailures: [{ name: "ci", logTail: "" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...noReviewYet, state: "success", headSha: "sha-1" }),
      push: (wt) => pushCalls.push(wt),
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      readMergeFacts: async () => ({ mergeable: "CONFLICTING" }),
      updateBranch: async (n) => {
        updateBranchCalls.push(n);
        return { ok: true };
      },
    },
  });

  assert.equal(outcome.outcome, "stood_down");
  const stoodDown = logs.filter((l) => l.step === "fix.stood_down");
  assert.equal(stoodDown.length, 1, "exactly ONE ledger line names the declined strike");
  assert.equal(stoodDown[0].extra?.site, "rung.strike");
  assert.equal(stoodDown[0].extra?.strike, 1, "names the strike that was about to be spent");
  assert.equal(stoodDown[0].extra?.reason, outcome.standDownReason);
  assert.match(String(stoodDown[0].extra?.reason ?? ""), /dirty/);

  assert.equal(spawnCalls.length, 0, "no fix worker ran — nothing attempted a repair");
  assert.equal(updateBranchCalls.length, 0, "no branch update — the rung never resolves the conflict itself");
  assert.equal(pushCalls.length, 0, "no push — nothing was committed on the rung's behalf");
});
