/**
 * test/a-body-repair-proof-safety-is-enforced-at-the-write-boundary.test.ts — W1-T3506.
 *
 * THE GAP THIS CLOSES. W1-T3389 (lib/body-repair.ts) shipped `repairedProofsAreSafeToPush` — a
 * pure refusal that runs every `grep:` proof a repaired PR body is about to carry and reports
 * `false` the instant one cannot parse or execute. That PR's own diff never touched
 * `src/run-task.ts`: `runFixRung`'s acceptance-gate body-repair site (the ONE place a repaired
 * body actually reaches GitHub, via `updatePrBody`) kept writing `acceptanceGateBodyRepair`'s
 * output unchecked. A safety helper nobody calls protects nothing.
 *
 * THIS FILE proves the write boundary now calls it: a repaired body carrying an authored `grep:`
 * proof that cannot parse (criterion 1) or cannot execute (criterion 2) is refused before
 * `updatePrBody` ever runs and the live PR body is left exactly as fetched; a repaired body whose
 * authored proofs are runnable still reaches `updatePrBody`, unmodified in its claim text
 * (criterion 3). The FALSIFIER: delete the write-boundary call to `repairedProofsAreSafeToPush`
 * and criteria 1/2 must fail — `updatePrBody` would then be observed called — while criterion 3
 * stays green, since a safe repair was never the thing this task changed.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { execGrepProofInWorktree, runFixRung } from "../src/run-task.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

// ── Fixtures — byte-identical in shape to test/acceptance-gate-body-repair.test.ts's own ───────

/**
 * `## Acceptance`/`Acceptance:` header present, one bullet whose claim and proof are joined by an
 * em dash rather than ` | ` — `parseAcceptanceBlock` reads the whole line as the CLAIM with an
 * EMPTY proof (W1-T3028), so `acceptanceAuthorTimeCheck` reports `empty-proofs` and
 * `acceptanceGateBodyRepair` attempts a repair. `ensureJudgeableBody`'s `recoverableCriteria`
 * (W1-T3038) then splits this exact bullet back apart via `emDashSeparatedProof`, so the AUTHOR'S
 * OWN malformed proof — the doubled-dialect shape measured on PR 5108, `grep:` wearing a second
 * dialect's text with no `in <path>` clause — survives verbatim into the repaired body. Nothing
 * about this fixture is generic-fallback text: the whole point is that a repair can recover and
 * ship an AUTHORED proof that never had a chance of running.
 */
const MALFORMED_GREP_PROOF_BODY = "Acceptance:\n- a claim that matters — grep: unit test: test/x.test.ts\n";

/** Same recoverable shape, but the proof PARSES (has an `in <path>` clause) and is only caught by
 *  actually RUNNING it — the exec_error arm, never the pure parse-shape arm. */
const EXEC_ERROR_GREP_PROOF_BODY =
  "Acceptance:\n- a claim that matters — grep: SOMETHING in src/does/not/exist.ts\n";

/** Same recoverable shape again, with a proof that both parses AND (per the injected executor
 *  below) executes cleanly — the safe case, criterion 3. */
const RUNNABLE_GREP_PROOF_BODY =
  "Acceptance:\n- a claim that matters — grep: SOMETHING in src/lib/body-repair.ts\n";

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
    taskId: "PR-3506",
    runId: "PR-3506-1730000000000",
    task: { id: "PR-3506", title: "PR #3506" },
    prUrl: "https://github.com/acme/remudero/pull/3506",
    branch: "fix/some-descriptive-branch",
    worktreePath: "/tmp/rmd-fixrung-write-boundary-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-write-boundary-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-write-boundary-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-write-boundary-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 4000;
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

const AUTHOR_GATE_CI_FAILURE: CiFailure = { name: "acceptance-author-gate", logTail: "REFUSED (empty-proofs)" };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("W1-T3506 criterion 1: a repaired acceptance body with an authored malformed grep proof is refused before updatePrBody, and the prior body remains unchanged", async () => {
  const noReviewYet = fakeReview("failure", [], "original-head-sha");
  const spawnCalls: SpawnWorkerArgs[] = [];
  const updateCalls: Array<{ prUrl: string; body: string }> = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: noReviewYet,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "may-run-once-the-repair-is-refused" });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => MALFORMED_GREP_PROOF_BODY,
      updatePrBody: async (prUrl, body) => {
        updateCalls.push({ prUrl, body });
      },
      // No executor needed to catch this one — GREP_PROOF_RE never matches a proof with no
      // `in <path>` clause at all, exactly like W1-T3389's own first test.
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(updateCalls.length, 0, "a body carrying an authored proof that cannot parse must never reach updatePrBody");
  assert.equal(outcome.review.headSha, "original-head-sha", "the prior body/head is never disturbed by a refused repair");
  const refusals = logs.filter((l) => l.step === "fix.body_gate_repair_proof_unsafe");
  assert.equal(refusals.length, 1, "the refusal must be ledgered with the criterion reason");
  assert.match(String(refusals[0].extra?.reason), /no `in <path>` clause/);
});

test("W1-T3506 criterion 2: a repaired acceptance body whose authored grep proof produces exec_error is refused at the same write boundary and emits a reason", async () => {
  const noReviewYet = fakeReview("failure", [], "original-head-sha-2");
  const updateCalls: Array<{ prUrl: string; body: string }> = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: noReviewYet,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async () => result({ sessionId: "should-not-matter" }),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => EXEC_ERROR_GREP_PROOF_BODY,
      updatePrBody: async (prUrl, body) => {
        updateCalls.push({ prUrl, body });
      },
      // Simulates the reviewer's own exec_error causes (a spawn failure, grep exit 2, a timeout) —
      // the proof PARSES (it carries `in <path>`) but this run never settles a verdict.
      execAcceptanceGateRepairProof: () => undefined,
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(updateCalls.length, 0, "a body carrying an authored proof that raises exec_error must never reach updatePrBody");
  assert.equal(outcome.review.headSha, "original-head-sha-2");
  const refusals = logs.filter((l) => l.step === "fix.body_gate_repair_proof_unsafe");
  assert.equal(refusals.length, 1);
  assert.match(String(refusals[0].extra?.reason), /exec_error/);
});

test("W1-T3506 criterion 3: a candidate whose authored proofs are runnable reaches the existing updatePrBody path without modifying claim text", async () => {
  const noReviewYet = fakeReview("failure", []);
  const updateCalls: Array<{ prUrl: string; body: string }> = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: noReviewYet,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async () => result({ sessionId: "should-never-run" }),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => RUNNABLE_GREP_PROOF_BODY,
      updatePrBody: async (prUrl, body) => {
        updateCalls.push({ prUrl, body });
      },
      // A clean, passing run — the executor a real worktree would report for a proof that
      // genuinely parses and matches.
      execAcceptanceGateRepairProof: () => ({ hits: 3 }),
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(updateCalls.length, 1, "a safe-to-push repair must still reach updatePrBody exactly as before this task");
  assert.match(updateCalls[0].body, /a claim that matters \| grep: SOMETHING in src\/lib\/body-repair\.ts/,
    "the author's own claim text is carried through untouched — this gate may refuse a push, never author or edit a claim");
  const refusals = logs.filter((l) => l.step === "fix.body_gate_repair_proof_unsafe");
  assert.equal(refusals.length, 0, "a safe repair must never be logged as refused");
});

// ── execGrepProofInWorktree — the adaptER ITSELF, exercised directly ────────────────────────────
//
// The three tests above all inject a fake `execAcceptanceGateRepairProof`, exactly like
// test/acceptance-gate-body-repair.test.ts's own suite does — none of them ever run
// `execGrepProofInWorktree`'s own body (the real production adapter wired at runFixRung's one call
// site, `execGrepProofInWorktree(worktreePath)`). These two tests call it directly, against this
// checkout's own real files, so its parse-exec-catch shape is proven rather than merely declared.

test("W1-T3506: execGrepProofInWorktree runs a real, parseable grep proof end-to-end and reports genuine hits", () => {
  const exec = execGrepProofInWorktree(REPO_ROOT);
  // The pattern is `repairedProofsAreSafeToPush`'s own declaration in the file W1-T3389 shipped it
  // in — guaranteed present, so this proves the pass path (parse ⇒ execWhitelistedProof ⇒ hits > 0)
  // without depending on any fixture that could drift.
  const outcome = exec("grep: export function repairedProofsAreSafeToPush in src/lib/body-repair.ts");
  assert.ok(outcome !== undefined, "a proof that parses and executes cleanly must never report undefined");
  assert.ok(outcome && outcome.hits > 0, "the searched-for declaration must match at least once");
});

test("W1-T3506: execGrepProofInWorktree collapses an exec_error (a target absent from the checkout) to undefined, never throwing", () => {
  const exec = execGrepProofInWorktree(REPO_ROOT);
  // Parses (it carries `in <path>`) but the target does not exist on disk — grep's own exit 2 makes
  // `execWhitelistedProof` throw, and this adapter's `catch` must swallow it into `undefined` rather
  // than letting the exception escape into `repairedProofsAreSafeToPush`'s caller.
  const outcome = exec("grep: SOMETHING in src/does/not/exist.ts");
  assert.equal(outcome, undefined, "a target absent from the checkout must collapse to undefined, not throw");
});
