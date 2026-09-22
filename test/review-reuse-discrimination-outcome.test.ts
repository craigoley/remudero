import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  judgeReview,
  type ProofExecutor,
  type ReviewVerdict,
} from "../src/lib/review.js";
import { appendLedger } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { buildSweepEffects } from "../src/run-task.js";
import { discriminateReviewReuse, type OpenPrView, type ReviewReuseInputs } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

const CRITERION = {
  claim: "W1-T3901 proof discrimination observes the current head",
  proof: "grep: W1-T3901 in src/review-reuse.ts",
};
const DIFF = "diff --git a/src/review-reuse.ts b/src/review-reuse.ts\n+W1-T3901\n";
const BODY = "W1-T3901 proof discrimination observes the current head.";
const TEST_CRITERION = {
  claim: "W1-T3901 executable test proof observes the current head",
  proof: "unit test: observes current head, and reports it",
};

function priorVerdict(execProof: ProofExecutor, semantic?: boolean): ReviewVerdict {
  return judgeReview([CRITERION], {
    diff: DIFF,
    report: BODY,
    headCheckoutDir: "/head",
    execProof,
    semantic: semantic === undefined ? undefined : [semantic],
  });
}

test("W1-T3901 base-only review runs proof discrimination without semantic spawn", () => {
  // W1-T3901 base-only review runs proof discrimination without semantic spawn in test/review-reuse-discrimination-outcome.test.ts
  const calls: string[] = [];
  const prior = priorVerdict((_proof, cwd) => {
    calls.push(`prior:${cwd}`);
    return "pass";
  });
  calls.length = 0;

  const result = discriminateReviewReuse({
    prior,
    diff: DIFF,
    report: BODY,
    headCheckoutDir: "/head",
    baseCheckoutDir: "/base",
    baseIsCheckout: true,
    execProof: (_proof, cwd) => {
      calls.push(cwd);
      return cwd === "/head" ? "pass" : "fail";
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.verdict.state, "success");
  assert.equal(result.verdict.criteria[0]?.proof_exec, "executed_pass");
  assert.deepEqual(calls, ["/head", "/base"]);
});

test("W1-T3901 discrimination preserves criteria and failure semantics", () => {
  // W1-T3901 discrimination preserves criteria and failure semantics in test/review-reuse-discrimination-outcome.test.ts
  const prior = priorVerdict(() => "fail");
  assert.equal(prior.state, "failure");
  assert.equal(prior.criteria[0]?.met, false);

  const result = discriminateReviewReuse({
    prior,
    diff: DIFF,
    report: BODY,
    headCheckoutDir: "/head",
    baseCheckoutDir: "/base",
    baseIsCheckout: true,
    execProof: (_proof, cwd) => (cwd === "/head" ? "pass" : "fail"),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.verdict.state, "failure");
  assert.equal(result.verdict.criteria[0]?.met, false);
  assert.equal(result.verdict.criteria[0]?.claim, prior.criteria[0]?.claim);
  assert.equal(result.verdict.criteria[0]?.proof, prior.criteria[0]?.proof);
});

test("W1-T3901 unreadable evidence falls back with a durable reason", () => {
  // W1-T3901 unreadable evidence falls back with a durable reason in test/review-reuse-discrimination-outcome.test.ts
  const prior = priorVerdict(() => "pass");
  const result = discriminateReviewReuse({
    prior,
    diff: DIFF,
    report: BODY,
    headCheckoutDir: "/head",
    baseCheckoutDir: "/base",
    baseIsCheckout: true,
    execProof: () => {
      throw new Error("proof executor unavailable");
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /proof evidence unreadable/);
  assert.match(result.reason, /exec-error/);
});

test("W1-T3901 discrimination rejects unreadable criteria, missing trees, test bases, and unobserved proofs", () => {
  const prior = priorVerdict(() => "pass");
  const unreadableCriterion = { ...prior, criteria: [{ ...prior.criteria[0], claim: "", proof: "" }] } as ReviewVerdict;
  const unreadable = discriminateReviewReuse({
    prior: unreadableCriterion,
    diff: DIFF,
    report: BODY,
    headCheckoutDir: "/head",
    baseCheckoutDir: "/base",
  });
  assert.equal(unreadable.ok, false);
  if (!unreadable.ok) assert.match(unreadable.reason, /unreadable criterion/);

  const empty = discriminateReviewReuse({
    prior: { ...prior, criteria: [] },
    diff: DIFF,
    report: BODY,
    headCheckoutDir: "/head",
    baseCheckoutDir: "/base",
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /no criteria/);

  const missingTree = discriminateReviewReuse({
    prior,
    diff: DIFF,
    report: BODY,
    headCheckoutDir: "/head",
    baseCheckoutDir: "",
  });
  assert.equal(missingTree.ok, false);
  if (!missingTree.ok) assert.match(missingTree.reason, /checkout is unavailable/);

  const testPrior = judgeReview([TEST_CRITERION], {
    diff: DIFF,
    report: "current head observation",
    headCheckoutDir: "/head",
    execProof: () => "pass",
  });
  const unavailableTestBase = discriminateReviewReuse({
    prior: testPrior,
    diff: DIFF,
    report: "current head observation",
    headCheckoutDir: "/head",
    baseCheckoutDir: "/base",
    baseIsCheckout: false,
    execProof: () => "pass",
  });
  assert.equal(unavailableTestBase.ok, false);
  if (!unavailableTestBase.ok) assert.match(unavailableTestBase.reason, /unit-test base discrimination/);

  const unobserved = discriminateReviewReuse({
    prior: testPrior,
    diff: DIFF,
    report: "current head observation",
    headCheckoutDir: "/head",
    baseCheckoutDir: "/base",
    baseIsCheckout: true,
    execProof: () => "no-match",
  });
  assert.equal(unobserved.ok, false);
  if (!unobserved.ok) assert.match(unobserved.reason, /did not produce an observed result/);
});

type AdapterFixtureOptions = {
  lifecycle?: "open" | "closed";
  materialize?: () => unknown;
  baseProof?: () => unknown;
  execProof?: ProofExecutor;
  remove?: (_repoDir: string, path: string) => void;
};

function adapterFixture(options: AdapterFixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-reuse-w1-t3901-adapter-"));
  const bin = mkdtempSync(join(tmpdir(), "rmd-review-reuse-w1-t3901-adapter-gh-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const oldPath = process.env.PATH;
  const taskId = "W1-T3901";
  const head = "cafef00dcafef00dcafef00dcafef00dcafef00d";
  const priorHead = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";
  const calls: string[] = [];
  const lifecycle = options.lifecycle === "closed" ? '{"state":"closed","merged":false}' : '{"state":"open","merged":false}';
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      `  *"pulls/3704"*) printf '${lifecycle}\\n' ;;`,
      '  *"pr diff"*) printf \'diff --git a/src/review-reuse.ts b/src/review-reuse.ts\\n+W1-T3901\\n\' ;;',
      "  *) printf '{}\\n' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const prior = priorVerdict(() => "pass");
  appendLedger(ledgerPath, {
    run_id: "prior",
    task_id: taskId,
    step: "review.posted",
    state: prior.state,
    head_sha: priorHead,
    pr_url: "https://github.com/acme/scratch/pull/3704",
    decision_verdict: prior,
  });
  process.env.PATH = `${bin}:${oldPath}`;
  const effects = buildSweepEffects({
    owner: "acme",
    repo: "scratch",
    localRepoName: "not-scratch",
    config: { root } as never,
    ledgerPath,
    runId: "reuse-adapter",
    plan: { tasks: [], byId: new Map([[taskId, { id: taskId, files: [] }]]) } as never,
    log: (step) => calls.push(step),
    reviewRunner: async () => {
      calls.push("fallback-review");
      return 0;
    },
    materializeReviewWorktreeImpl: options.materialize ?? (() => ({ worktreePath: "/head" })),
    buildBaseProofDirImpl:
      options.baseProof ??
      (() => ({
        baseCheckoutDir: "/base",
        baseUnreadablePaths: new Set<string>(),
        baseIsCheckout: true,
        addedTestFiles: new Set<string>(),
      })),
    reviewReuseExecProofImpl: options.execProof ?? ((_proof, cwd) => (cwd === "/head" ? "pass" : "fail")),
    worktreeRemoveImpl: options.remove ?? ((_repoDir, path) => calls.push(`cleanup:${path}`)),
  });
  const pr = {
    prNumber: 3704,
    prUrl: "https://github.com/acme/scratch/pull/3704",
    taskId,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-22T00:00:00Z",
    headSha: head,
    autoMergeArmed: false,
    body: BODY,
    currentOwnDiffDigest: "sha256:current",
    currentMergeBaseSha: "base-current",
  } as OpenPrView & Partial<ReviewReuseInputs>;
  return {
    effects,
    pr,
    calls,
    ledgerPath,
    priorHead,
    cleanup: () => {
      process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    },
  };
}

test("W1-T3901 adapter falls back when the PR-head or merge-base worktree is unavailable", async () => {
  for (const [label, overrides] of [
    ["head", { materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "head unavailable" } }) }],
    ["base", { baseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set<string>(), baseIsCheckout: false, baseWorktreeFailure: "base unavailable", addedTestFiles: new Set<string>() }) }],
  ] as const) {
    const fixture = adapterFixture(overrides);
    try {
      await withLiveWritesAllowed(() => fixture.effects.postReview!(fixture.pr, { kind: "discriminate-only", judgedHeadSha: fixture.priorHead }));
      assert.equal(fixture.calls.includes("fallback-review"), true, `${label} failure must use the full-review fallback`);
      assert.equal(fixture.calls.includes("sweep.review_reuse_discrimination_fallback"), true);
    } finally {
      fixture.cleanup();
    }
  }
});

test("W1-T3901 adapter contains discrimination errors and cleanup errors", async () => {
  const errored = adapterFixture({
    materialize: () => {
      throw new Error("materializer exploded");
    },
  });
  try {
    await withLiveWritesAllowed(() => errored.effects.postReview!(errored.pr, { kind: "discriminate-only", judgedHeadSha: errored.priorHead }));
    assert.equal(errored.calls.includes("fallback-review"), true);
    assert.equal(errored.calls.includes("sweep.review_reuse_discrimination_error"), true);
  } finally {
    errored.cleanup();
  }

  const cleanupErrors = adapterFixture({
    baseProof: () => ({
      baseCheckoutDir: "/base",
      baseUnreadablePaths: new Set<string>(),
      baseIsCheckout: false,
      addedTestFiles: new Set<string>(),
    }),
    remove: () => {
      throw new Error("cleanup exploded");
    },
  });
  try {
    await withLiveWritesAllowed(() => cleanupErrors.effects.postReview!(cleanupErrors.pr, { kind: "discriminate-only", judgedHeadSha: cleanupErrors.priorHead }));
    assert.equal(cleanupErrors.calls.includes("sweep.review_reuse_discrimination_cleanup_error"), true);
  } finally {
    cleanupErrors.cleanup();
  }
});

test("W1-T3901 adapter records guarded-post refusal and unknown-mode fallback", async () => {
  const refused = adapterFixture({ lifecycle: "closed" });
  try {
    await withLiveWritesAllowed(() => refused.effects.postReview!(refused.pr, { kind: "discriminate-only", judgedHeadSha: refused.priorHead }));
    assert.equal(refused.calls.includes("fallback-review"), false);
    assert.equal(readLedgerLines(refused.ledgerPath).some((line) => line.step === "review.post_refused"), true);
  } finally {
    refused.cleanup();
  }

  const unknown = adapterFixture();
  try {
    await withLiveWritesAllowed(() => unknown.effects.postReview!(unknown.pr, { kind: "unexpected" } as never));
    assert.equal(unknown.calls.includes("fallback-review"), true);
  } finally {
    unknown.cleanup();
  }
});

test("W1-T3901 public dispatcher keeps full-review mode on the default review runner", async () => {
  const fixture = adapterFixture();
  try {
    await withLiveWritesAllowed(() => fixture.effects.postReview!(fixture.pr, { kind: "full-review" }));
    assert.equal(fixture.calls.includes("fallback-review"), true);
  } finally {
    fixture.cleanup();
  }
});

test("W1-T3901 run-task adapter posts proof-only discrimination and records effective_review_mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-reuse-w1-t3901-"));
  const bin = mkdtempSync(join(tmpdir(), "rmd-review-reuse-w1-t3901-gh-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const oldPath = process.env.PATH;
  const taskId = "W1-T3901";
  const head = "cafef00dcafef00dcafef00dcafef00dcafef00d";
  const priorHead = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";
  const calls: string[] = [];
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"pulls/3704"*) printf \'{"state":"open","merged":false,"head":{"sha":"cafef00dcafef00dcafef00dcafef00dcafef00d"},"body":"W1-T3901 proof discrimination observes the current head."}\\n\' ;;',
      '  *"pr diff"*) printf \'diff --git a/src/review-reuse.ts b/src/review-reuse.ts\\n+W1-T3901\\n\' ;;',
      "  *) printf '{}\\n' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const prior = priorVerdict(() => "pass");
  appendLedger(ledgerPath, {
    run_id: "prior",
    task_id: taskId,
    step: "review.posted",
    state: prior.state,
    head_sha: priorHead,
    pr_url: "https://github.com/acme/scratch/pull/3704",
    decision_verdict: prior,
  });
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const effects = buildSweepEffects({
      owner: "acme",
      repo: "scratch",
      localRepoName: "not-scratch",
      config: { root } as never,
      ledgerPath,
      runId: "reuse-adapter",
      plan: { tasks: [], byId: new Map([[taskId, { id: taskId, files: [] }]]) } as never,
      log: (step) => calls.push(step),
      reviewRunner: async () => {
        calls.push("fallback-review");
        return 0;
      },
      materializeReviewWorktreeImpl: () => ({ worktreePath: "/head" }),
      buildBaseProofDirImpl: () => ({
        baseCheckoutDir: "/base",
        baseUnreadablePaths: new Set<string>(),
        baseIsCheckout: true,
        addedTestFiles: new Set<string>(),
      }),
      reviewReuseExecProofImpl: (_proof, cwd) => (cwd === "/head" ? "pass" : "fail"),
      worktreeRemoveImpl: (_repoDir, path) => calls.push(`cleanup:${path}`),
    });
    const pr = {
      prNumber: 3704,
      prUrl: "https://github.com/acme/scratch/pull/3704",
      taskId,
      reviewState: "none",
      checksState: "green",
      unmetCriteria: [],
      priorStrikes: 0,
      lastActivityAt: "2026-09-22T00:00:00Z",
      headSha: head,
      autoMergeArmed: false,
      body: BODY,
      currentOwnDiffDigest: "sha256:current",
      currentMergeBaseSha: "base-current",
    } as OpenPrView & Partial<ReviewReuseInputs>;

    await withLiveWritesAllowed(() =>
      effects.postReview!(pr, { kind: "discriminate-only", judgedHeadSha: priorHead }),
    );

    assert.equal(calls.includes("fallback-review"), false);
    assert.deepEqual(calls.filter((call) => call.startsWith("cleanup:")), ["cleanup:/base", "cleanup:/head"]);
    const posted = readLedgerLines(ledgerPath).filter((line) => line.step === "review.posted").at(-1);
    assert.equal(posted?.effective_review_mode, "proof-only-discrimination");
    assert.equal(posted?.requested_review_mode, "discriminate-only");
    assert.equal(posted?.review_discriminated, true);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
