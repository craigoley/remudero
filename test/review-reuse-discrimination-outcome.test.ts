import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  judgeReview,
  type ProofExecutor,
  type ReviewVerdict,
} from "#src/lib/review.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { buildSweepEffects } from "#src/run-task.js";
import { discriminateReviewReuse, type OpenPrView, type ReviewReuseInputs } from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";

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
    // expiring-fixture: exempt -- direct postReview adapterFixture bypasses stale-days disposition.
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

test("W1-T4739 direct adapter review path is independent of stale-days disposition", async () => {
  const fixture = adapterFixture();
  try {
    fixture.pr.lastActivityAt = "2026-08-01T00:00:00Z";
    await withLiveWritesAllowed(() => fixture.effects.postReview!(fixture.pr, { kind: "discriminate-only", judgedHeadSha: fixture.priorHead }));
    const posted = readLedgerLines(fixture.ledgerPath).filter((line) => line.step === "review.posted").at(-1);
    assert.equal(posted?.effective_review_mode, "proof-only-discrimination", "expiring-fixture: exempt -- direct postReview adapterFixture bypasses stale-days disposition");
  } finally {
    fixture.cleanup();
  }
});

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
  const rejected = adapterFixture({
    execProof: () => {
      throw new Error("proof evidence disappeared");
    },
  });
  try {
    await withLiveWritesAllowed(() => rejected.effects.postReview!(rejected.pr, { kind: "discriminate-only", judgedHeadSha: rejected.priorHead }));
    assert.equal(rejected.calls.includes("fallback-review"), true);
    assert.equal(rejected.calls.includes("sweep.review_reuse_discrimination_fallback"), true);
  } finally {
    rejected.cleanup();
  }

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
      // expiring-fixture: exempt -- direct postReview run-task adapter fixture bypasses stale-days disposition.
      lastActivityAt: "2026-09-22T00:00:00Z",
      headSha: head,
      autoMergeArmed: false,
      body: BODY,
      currentOwnDiffDigest: "sha256:current",
      currentMergeBaseSha: "base-current",
    } as OpenPrView & Partial<ReviewReuseInputs>;

    pr.lastActivityAt = "2026-08-01T00:00:00Z";
    await withLiveWritesAllowed(() =>
      effects.postReview!(pr, { kind: "discriminate-only", judgedHeadSha: priorHead }),
    );

    assert.equal(calls.includes("fallback-review"), false);
    assert.deepEqual(calls.filter((call) => call.startsWith("cleanup:")), ["cleanup:/base", "cleanup:/head"]);
    const posted = readLedgerLines(ledgerPath).filter((line) => line.step === "review.posted").at(-1);
    assert.equal(posted?.effective_review_mode, "proof-only-discrimination", "expiring-fixture: exempt -- direct postReview run-task adapter fixture bypasses stale-days disposition");
    assert.equal(posted?.requested_review_mode, "discriminate-only");
    assert.equal(posted?.review_discriminated, true);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

// W1-T9681: the runner wiring for a PR with no task id. The lookup itself is proven in
// test/a-cheap-review-finds-its-prior-verdict-by-pr-url.test.ts, which may not import src/run-task.ts.
{
  const PR_NUMBER = 11882;
  const PR_URL = `https://github.com/acme/scratch/pull/${PR_NUMBER}`;
  const SHARD = "plan/tasks.d/W1-T9681-a-cheap-review.yaml";
  const SRC = "src/lib/test-setup.ts";
  const CODE_DIFF = `diff --git a/${SRC} b/${SRC}\n+export const inherited = false;\n`;
  const PLAN_DIFF = `diff --git a/${SHARD} b/${SHARD}\n+- id: W1-T9681\n`;
  const BODY = "The shared test setup ignores an inherited transport floor.";
  const HEAD = "cafef00dcafef00dcafef00dcafef00dcafef00d";
  const PRIOR_HEAD = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";

  const priorVerdict = (planFiling: boolean): ReviewVerdict =>
    planFiling
      ? judgeReview([{ claim: "the shard is filed", proof: `grep: W1-T9681 in ${SHARD}` }], {
        diff: PLAN_DIFF, report: BODY, headCheckoutDir: "/head", execProof: () => "pass",
        planLint: { ran: true, label: "fixture", checked: 1, violations: [] },
      })
      : judgeReview([{ claim: "the setup ignores the floor", proof: `grep: inherited in ${SRC}` }], {
        diff: CODE_DIFF, report: BODY, headCheckoutDir: "/head", execProof: () => "pass",
      });

  type Options = {
    planFiling?: boolean;
    prior?: "live" | "archive" | "none";
    verdict?: (v: ReviewVerdict) => unknown;
    pr?: Partial<OpenPrView & ReviewReuseInputs>;
  };

  function cheapReviewRun(options: Options = {}) {
    const root = mkdtempSync(join(tmpdir(), "rmd-t9681-"));
    const bin = mkdtempSync(join(tmpdir(), "rmd-t9681-gh-"));
    const ledgerPath = join(root, "ledger.ndjson");
    const oldPath = process.env.PATH;
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *"pulls/${PR_NUMBER}"*) printf '{"state":"open","merged":false}\\n' ;;`,
        `  *"pr diff"*) printf '%s' '${options.planFiling ? PLAN_DIFF : CODE_DIFF}' ;;`,
        "  *) printf '{}\\n' ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const prior = priorVerdict(options.planFiling === true);
    const row = {
      run_id: "prior", task_id: `PR-${PR_NUMBER}`, step: "review.posted", state: prior.state, head_sha: PRIOR_HEAD, pr_url: PR_URL,
      decision_verdict: options.verdict ? options.verdict(prior) : prior,
    };
    appendLedger(ledgerPath, { run_id: "other", task_id: "PR-1", step: "review.posted", state: "failure", pr_url: "https://github.com/acme/scratch/pull/1", decision_verdict: { ...prior, state: "failure" } });
    if ((options.prior ?? "live") === "live") appendLedger(ledgerPath, row);
    if (options.prior === "archive") writeFileSync(join(root, "ledger.2026-10-14T00-00-00-000Z.ndjson"), `${JSON.stringify({ ts: "2026-10-14T00:00:00.000Z", ...row })}\n`);
    const steps: Array<{ step: string; fields: Record<string, unknown> }> = [];
    process.env.PATH = `${bin}:${oldPath}`;
    const effects = buildSweepEffects({
      owner: "acme",
      repo: "scratch",
      localRepoName: "not-scratch",
      config: { root } as never,
      ledgerPath,
      runId: "t9681",
      plan: { tasks: [], byId: new Map() } as never,
      log: (step, fields) => steps.push({ step, fields: (fields ?? {}) as Record<string, unknown> }),
      reviewRunner: async () => {
        steps.push({ step: "full-review", fields: {} });
        return 0;
      },
      materializeReviewWorktreeImpl: () => ({ worktreePath: "/head" }),
      buildBaseProofDirImpl: () => ({ baseCheckoutDir: "/base", baseUnreadablePaths: new Set<string>(), baseIsCheckout: true, addedTestFiles: new Set<string>() }),
      reviewReuseExecProofImpl: (_proof, cwd) => (cwd === "/head" ? "pass" : "fail"),
      worktreeRemoveImpl: () => {},
    });
    const pr = {
      prNumber: PR_NUMBER, prUrl: PR_URL, isPlanFiling: options.planFiling === true, reviewState: "none", checksState: "green", unmetCriteria: [],
      priorStrikes: 0, lastActivityAt: "2026-10-15T00:00:00Z", headSha: HEAD, autoMergeArmed: false, body: BODY,
      currentOwnDiffDigest: "sha256:current", currentMergeBaseSha: "base-current", ...options.pr,
    } as OpenPrView & Partial<ReviewReuseInputs>;
    const run = (kind: "discriminate-only" | "reuse") =>
      withLiveWritesAllowed(() => effects.postReview!(pr, { kind, judgedHeadSha: PRIOR_HEAD }));
    return {
      run,
      steps,
      posted: () => readLedgerLines(ledgerPath).filter((l) => l.step === "review.posted" && l.head_sha === HEAD),
      fallbacks: () => steps.filter((s) => s.step === "sweep.review_reuse_discrimination_fallback").map((s) => s.fields.fallback_reason),
      cleanup: () => {
        process.env.PATH = oldPath;
        rmSync(root, { recursive: true, force: true });
        rmSync(bin, { recursive: true, force: true });
      },
    };
  }

  test("W1-T9681: a hand PR with no task id runs its cheap review from the verdict its url names", async () => {
    const f = cheapReviewRun();
    try {
      await f.run("discriminate-only");
      assert.deepEqual(f.fallbacks(), [], "no fallback to a full review");
      assert.equal(f.steps.some((s) => s.step === "full-review"), false);
      const [posted, ...rest] = f.posted();
      assert.equal(rest.length, 0);
      assert.equal(posted?.effective_review_mode, "proof-only-discrimination");
      assert.equal(posted?.task_id, `PR-${PR_NUMBER}`, "keyed by the PR number, as every unfiled review is");
      assert.equal(posted?.pr_url, PR_URL);
    } finally {
      f.cleanup();
    }
  });

  test("W1-T9681: a plan filing with no task id finds its verdict by url, then names why it needs a full review", async () => {
    const f = cheapReviewRun({ planFiling: true });
    try {
      await f.run("discriminate-only");
      assert.deepEqual(f.fallbacks(), ["a plan-only verdict needs a full review to re-run lint-plan"], "W1-T4423's own reason, not a lumped unreadable");
    } finally {
      f.cleanup();
    }
  });

  test("W1-T9681: each discriminate-only fallback row names the fact it could not read", async () => {
    const cases: Array<[string, Options]> = [
      ["no-prior-verdict", { prior: "none" }],
      ["prior-not-terminal", { verdict: (v) => ({ ...v, state: "pending" }) }],
      ["criteria-unreadable", { verdict: (v) => ({ ...v, criteria: undefined }) }],
      ["own-diff-digest-unread", { pr: { currentOwnDiffDigest: undefined } }],
      ["merge-base-unread", { pr: { currentMergeBaseSha: undefined } }],
    ];
    for (const [fact, options] of cases) {
      const f = cheapReviewRun(options);
      try {
        await f.run("discriminate-only");
        assert.deepEqual(f.fallbacks(), [fact], fact);
        assert.equal(f.steps.some((s) => s.step === "full-review"), true, `${fact}: the full review still runs`);
      } finally {
        f.cleanup();
      }
    }
  });

  test("W1-T9681: an exact reuse of a PR with no task id re-posts the verdict its url names", async () => {
    const f = cheapReviewRun();
    try {
      await f.run("reuse");
      assert.equal(f.steps.some((s) => s.step === "sweep.review_reuse_unreadable" || s.step === "full-review"), false);
      assert.equal(f.posted()[0]?.effective_review_mode, "verdict-reuse");
    } finally {
      f.cleanup();
    }
  });
}
