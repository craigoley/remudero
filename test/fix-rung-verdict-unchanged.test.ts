/**
 * test/fix-rung-verdict-unchanged.test.ts — W1-T2328.
 *
 * THE DEFECT. The fix rung's ci-log mode re-reads the failing check(s) every round
 * (`deps.fetchCiFailures`, refreshed after every push) but never COMPARES what it just re-read
 * against what the strike that just ran was dispatched to fix. The gate key it derives is the
 * sorted failing check NAMES — a check still failing for exactly the same reason produces an
 * identical key, reads as "the same gate", and the rung proceeds to spend the next strike
 * discovering, again, what the first strike's own re-read already showed. With `strikeCap` at 2
 * (measured, plan/policy.yaml), one inert fix burns half the budget.
 *
 * THE FIX. `detectCiLogVerdictUnchanged` (pure) is the ci-log SIBLING of `detectReviewFalseBlock`:
 * it compares the ANNOTATION MESSAGE SET (`CiFailure.tailSource === "annotations"`, normalised,
 * order-insensitive) the strike was dispatched against, to the freshly refetched evidence after
 * that strike's push landed and CI re-ran. On anything short of two directly comparable annotation
 * sets for every still-failing check name shared between the two rounds, it ABSTAINS (`undefined`)
 * and the rung strikes normally — never a false stand-down. `runFixRung` wires this at the SAME
 * site the ci-log evidence is already refreshed (right after `deps.fetchCiFailures`, on a
 * `waitForCiGreen !== "green"` round): when it fires, the rung escalates immediately, carrying the
 * evidence, WITHOUT spending the round it would otherwise have dispatched next — composing the
 * SAME two outcomes `unchangedTreeStandDownReason` (no strike spent) and `detectReviewFalseBlock`
 * (escalate carrying the evidence) already established, never inventing a third disposition. The
 * strike cap itself, `unchangedTreeStandDownReason`, and `detectReviewFalseBlock` are all
 * untouched — this is an additive sibling, not a retune.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { runFixRung, detectCiLogVerdictUnchanged } from "../src/run-task.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

// ── shared fixtures (mirror test/fix-rung-unchanged-tree-stand-down.test.ts's own conventions) ──

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
    taskId: "W1-T2328X",
    runId: "W1-T2328X-1730000000000",
    task: { id: "W1-T2328X", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/1",
    branch: "run-W1-T2328X-1730000000000",
    worktreePath: "/tmp/rmd-fixrung-verdict-unchanged-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-verdict-unchanged-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-verdict-unchanged-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-verdict-unchanged-")), "ledger.ndjson");
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
    comment() {},
  };
}

function annotated(name: string, messages: string[]): CiFailure {
  return {
    name,
    logTail: messages.join("\n"),
    tailSource: "annotations",
    annotationFallback: { outcome: "recovered" },
  };
}

// ── detectCiLogVerdictUnchanged — the pure comparison boundary (criteria 1, 2, 3, 5) ────────────

test("detectCiLogVerdictUnchanged: IDENTICAL annotation sets, reordered, are detected as unchanged (order-insensitive)", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [annotated("ci", ["finding A", "finding B"])],
    currentFailures: [annotated("ci", ["finding B", "finding A"])],
  });
  assert.ok(got, "a reordered but identical finding set must still read as unchanged");
  assert.match(got, /ci-log false-block/);
  assert.match(got, /ci/);
});

test("detectCiLogVerdictUnchanged: a GENUINELY different finding set is real progress — never 'unchanged'", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [annotated("ci", ["finding A"])],
    currentFailures: [annotated("ci", ["finding A", "finding C (new)"])],
  });
  assert.equal(got, undefined);
});

test("detectCiLogVerdictUnchanged: the failing check NAME SET itself moving abstains, even with identical text on the shared name", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [annotated("check-a", ["x"])],
    currentFailures: [annotated("check-a", ["x"]), annotated("check-b", ["y"])],
  });
  assert.equal(got, undefined, "a newly-red check alongside an unchanged one is real ground moving, not an inert fix");
});

test("detectCiLogVerdictUnchanged: a check resolving (dropping out of the failing set) abstains", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [annotated("check-a", ["x"]), annotated("check-b", ["y"])],
    currentFailures: [annotated("check-b", ["y"])],
  });
  assert.equal(got, undefined);
});

test("detectCiLogVerdictUnchanged: a READABLE LOG tail (tailSource 'log', not annotations) is never comparable — abstains, strikes normally", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [{ name: "ci", logTail: "same tsc error\n", tailSource: "log" }],
    currentFailures: [{ name: "ci", logTail: "same tsc error\n", tailSource: "log" }],
  });
  assert.equal(got, undefined, "a log-sourced tail must never be keyed on, even when byte-identical");
});

test("detectCiLogVerdictUnchanged: an UNREADABLE log with NO tailSource at all (no-job-id / fetch-failed / empty-log) abstains rather than reading two empty strings as equal", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [{ name: "ci", logTail: "", logUnavailable: { kind: "fetch-failed", detail: "boom" } }],
    currentFailures: [{ name: "ci", logTail: "", logUnavailable: { kind: "fetch-failed", detail: "boom" } }],
  });
  assert.equal(got, undefined, "two unreadable logs must never collapse into a false 'unchanged' match");
});

test("detectCiLogVerdictUnchanged: an annotation fallback that came back EMPTY on either side abstains", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [{ name: "ci", logTail: "", annotationFallback: { outcome: "empty" } }],
    currentFailures: [annotated("ci", ["a real finding, now"])],
  });
  assert.equal(got, undefined);
});

test("detectCiLogVerdictUnchanged: an annotation fallback that FAILED on either side abstains", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [annotated("ci", ["a finding"])],
    currentFailures: [{ name: "ci", logTail: "", annotationFallback: { outcome: "failed", detail: "403" } }],
  });
  assert.equal(got, undefined);
});

test("detectCiLogVerdictUnchanged: EMPTY prior or current evidence (first round / unrefreshed fetch) abstains rather than matching vacuously", () => {
  assert.equal(detectCiLogVerdictUnchanged({ priorFailures: [], currentFailures: [annotated("ci", ["x"])] }), undefined);
  assert.equal(detectCiLogVerdictUnchanged({ priorFailures: [annotated("ci", ["x"])], currentFailures: [] }), undefined);
  assert.equal(detectCiLogVerdictUnchanged({ priorFailures: [], currentFailures: [] }), undefined);
});

test("detectCiLogVerdictUnchanged: MULTIPLE still-failing checks all comparable and all identical still reads as unchanged", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [annotated("check-a", ["x"]), annotated("check-b", ["y"])],
    currentFailures: [annotated("check-b", ["y"]), annotated("check-a", ["x"])],
  });
  assert.ok(got);
  assert.match(got, /check-a/);
  assert.match(got, /check-b/);
});

test("detectCiLogVerdictUnchanged: one comparable-and-equal check ALONGSIDE one non-comparable check abstains overall — never a partial verdict", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [annotated("check-a", ["x"]), { name: "check-b", logTail: "raw log", tailSource: "log" }],
    currentFailures: [annotated("check-a", ["x"]), { name: "check-b", logTail: "raw log", tailSource: "log" }],
  });
  assert.equal(got, undefined, "a non-comparable sibling check must sink the whole round's verdict to 'strike normally'");
});

// ── runFixRung, behaviorally — the six acceptance criteria ──────────────────────────────────────

test("runFixRung (criterion 1 + 4): an inert fix escalates immediately after ONE strike, spending no second strike, and the escalation carries the evidence", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const issues = fakeIssueStore();

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures: [annotated("ci", ["boom: assertion failed at line 12"])],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      // The push landed (a real commit), but the check still fails with the EXACT same finding.
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [annotated("ci", ["boom: assertion failed at line 12"])],
      runReview: async () => noReviewYet,
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
    },
  });

  assert.equal(spawnCalls.length, 1, "only ONE strike is ever spent — the second is never dispatched to re-discover the same finding");
  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.strikes, 1, "the strike counter stops at the one genuine strike that ran; no strike is granted to pay for the detection itself");
  assert.equal(outcome.reason, "ci_false_block");
  assert.ok(outcome.issueUrl, "an inert fix costs no strike but still carries the evidence, via an escalation");
  assert.equal(issues.calls.length, 1);
  assert.match(issues.calls[0].body, /identical annotation finding set/);
  assert.match(issues.calls[0].body, /boom: assertion failed at line 12/);
});

test("runFixRung (criterion 2): a fix that GENUINELY moved the findings every round still strikes normally, all the way to the cap", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const issues = fakeIssueStore();
  // Each refetch names a DIFFERENT finding than the one before it — every round's own fix genuinely
  // moved the annotation set forward, so the comparison must never fire, no matter how many rounds
  // run. (A single one-time "moved once, then repeats" fixture would legitimately trip the NEXT
  // round's own detector — that is not this criterion's claim; this fixture proves the case where
  // progress is real on EVERY round.)
  let fetchCall = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: noReviewYet,
    ciFailures: [annotated("ci", ["boom: assertion failed at line 12 (v0)"])],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => {
        fetchCall++;
        return [annotated("ci", [`boom: assertion failed at line ${12 + fetchCall * 10} (v${fetchCall})`])];
      },
      runReview: async () => noReviewYet,
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
    },
  });

  assert.equal(spawnCalls.length, 3, "ALL THREE strikes spend — a finding that moves every round must never be mistaken for an inert fix");
  assert.equal(outcome.outcome, "escalated", "strikeCap exhausted after three genuine strikes, exactly as before this task");
  assert.equal(outcome.strikes, 3);
  assert.notEqual(outcome.reason, "ci_false_block", "the ordinary exhaustion path fires, never the new false-block one, when findings keep moving");
});

test("runFixRung (criterion 3): an ABSENT/unreadable annotation makes the comparison abstain and the rung strike, never stand down", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const issues = fakeIssueStore();

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    // No annotations at all — a plain log-tail-shaped failure, as most fixtures in this repo are.
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      // Byte-identical logTail every round, and STILL no tailSource — never comparable.
      fetchCiFailures: async () => [{ name: "ci", logTail: "tsc: error TS2322" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
    },
  });

  assert.equal(spawnCalls.length, 2, "with no comparable annotation evidence, both strikes spend — the comparison abstains rather than standing the rung down");
  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.strikes, 2);
  assert.notEqual(outcome.reason, "ci_false_block", "the ordinary exhaustion path fires, never the new false-block one, on non-comparable evidence");
  assert.equal(issues.calls.length, 1, "exactly one issue — the ordinary strike-exhaustion escalation");
});

test("runFixRung (criterion 5): the strike ceiling stays at 2 — an inert fix under strikeCap 2 never lets a third strike run, and never lowers the cap for a genuine case either", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);

  // Same findings every round: the FIRST detection fires after strike 1, so strikes never even
  // approaches the cap — proving no strike is ever "saved up" or granted back for having detected
  // this. The cap itself is passed through completely unmodified (still 2, read verbatim below).
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures: [annotated("ci", ["identical every round"])],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [annotated("ci", ["identical every round"])],
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
    },
  });

  assert.equal(spawnCalls.length, 1, "never more than one strike, and never a strike beyond strikeCap either");
  assert.ok(spawnCalls.length <= 2, "strikeCap (2) is never exceeded");
  assert.equal(outcome.strikes, 1);
});

test("runFixRung (criterion 6a): the UNCHANGED-TREE stand-down (W1-T1284) still fires exactly as before this task, in the SAME ci-log shape its own test suite pins", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const unchangedSnapshot = { status: "M file.ts\0", diff: "diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n", untrackedHash: "h1" };

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: noReviewYet,
    // No `tailSource` at all — the new ci-log false-block comparison abstains on every round here
    // (criterion 3's own shape), so this test isolates the PRE-EXISTING unchanged-tree gate.
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `s-${spawnCalls.length}` });
      },
      // The SAME required check stays red every round — the worker's own push landed nothing new.
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "ci", logTail: "tsc: error TS2322" }],
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      // Byte-identical worktree content on every round — nothing was ever committed.
      captureWorktreeSnapshot: async () => unchangedSnapshot,
    },
  });

  assert.equal(spawnCalls.length, 1, "round 2 is refused before it ever dispatches — the unchanged-tree gate, untouched by this task");
  assert.equal(outcome.outcome, "stood_down");
  assert.match(outcome.standDownReason ?? "", /byte-identical/);
});

test("runFixRung (criterion 6b): the REVIEW FALSE-BLOCK escape still fires exactly as before this task, unaffected by the new ci-log sibling", async () => {
  const issues = fakeIssueStore();
  const dispatchedReview = fakeReview("failure", [criterion({ claim: "does the thing", met: false })], "sha-1");
  // The re-review posts against the SAME head sha with the SAME unmet criterion — no new work was
  // even offered (this is `detectReviewFalseBlock`'s own "no-progress" signal (a), untouched).
  const reReview = fakeReview("failure", [criterion({ claim: "does the thing", met: false })], "sha-1");

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: dispatchedReview,
    deps: {
      spawn: async () => result({ sessionId: "s-1" }),
      waitForCiGreen: async () => "green",
      runReview: async () => reReview,
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.reason, "false_block", "the pre-existing review false-block reason, never the new ci_false_block one");
  assert.equal(outcome.strikes, 1);
});
