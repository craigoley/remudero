import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendLedger } from "#src/lib/ledger.js";
import {
  acquireReviewStatusLock,
  claimReviewDecision,
  judgeReview,
  lastReviewDecisionTerminal,
  postReviewStatusGuarded,
  refreshReviewPublisherToken,
  reviewDecisionDigest,
  reviewEvidenceStrength,
  reviewLedgerLegibilityFields,
  type PlanLintOutcome,
  type ReviewVerdict,
} from "#src/lib/review.js";
import { lintPlanForReview, planLintOutcomeFromOutput } from "#src/run-task.js";
import { readRequiredStatusCheckContextsAsync } from "#src/lib/status.js";
import { discriminateReviewReuse } from "#src/lib/sweep.js";
import { fixedClock, systemClock } from "#src/lib/clock.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

/**
 * W1-T4423 — A CONSUMER FILING PASSED REVIEW AS "GATED BY LINT-PLAN" WHEN NO LINT-PLAN RAN.
 *
 * remudero-site #133 filed PORTAL-T27 with a Rule 19 sizing violation and four proofs naming a
 * test outside its `files:`, and review posted "PASS — plan-only PR ... gated deterministically
 * (lint-plan + ...)". Those gates are core CI jobs; the site has none of them. The review now
 * runs lint-plan's changed-task pass itself, on the target repo's plan at the PR head.
 *
 * The fixture is consumer-shaped on purpose: a monolith `plan/tasks.yaml`, no `plan/tasks.d/`,
 * a bare `origin` whose `main` is the merge base, and PORTAL-T27's record verbatim as filed.
 */

const HEADER = "# fixture consumer plan\n\n";

/** A LEGACY ill-formed record already on main: 4 concerns at risk:medium. It must not fail an unrelated filing. */
const LEGACY_ILLFORMED = `- id: PORTAL-T22
  title: "a legacy record that sat ill-formed on main"
  repo: remudero-site
  depends_on: []
  type: implement
  verify: auto
  principles: {tdd: strict}
  budget_usd: 20.00
  risk: medium
  origin: "fixture"
  files: [instrumentation.ts, app/api/errors/route.ts, app/error.tsx, app/global-error.tsx]
  status: queued
  rationale: "a legacy record"
  acceptance:
    - claim: "a legacy claim"
      proof: "unit test: a legacy claim"
  falsifier: "CLOSE IF never."
`;

/** PORTAL-T27 as remudero-site #133 filed it (2e64e39), rationale and design abridged. */
const PORTAL_T27 = `- id: PORTAL-T27
  title: "A SITE ERROR DIES IN THE VISITOR'S BROWSER OR IN VERCEL'S LOGS — report server and client errors to core's incident ingest"
  repo: remudero-site
  depends_on: []
  priority: 2
  type: implement
  verify: auto
  principles: {tdd: strict}
  budget_usd: 20.00
  risk: medium
  band_meaning: span
  origin: "operator request 2026-09-23: an SRE gardener fed by console, site and daemon errors"
  plan_refs: ["core W1-T4383", "console CONSOLE-T58"]
  files: [instrumentation.ts, app/api/errors/route.ts, app/error.tsx, app/global-error.tsx]
  status: queued
  rationale: "Operator ruling 2026-09-23: no paid APM. The public site had no error reporting at all."
  design: "Server: instrumentation.ts onRequestError posts to core. Client: app/error.tsx and app/global-error.tsx post to POST /api/errors."
  acceptance:
    - claim: "a server error reaches the incident ingest with its route pattern and deploy sha"
      proof: "grep: a server error reaches the incident ingest with its route pattern and deploy sha in tests/unit/site-errors-reach-the-sre-gardener.test.ts"
    - claim: "a client error is forwarded without a query string, cookie or email"
      proof: "grep: a client error is forwarded without a query string, cookie or email in tests/unit/site-errors-reach-the-sre-gardener.test.ts"
    - claim: "a cross-origin or over-limit report is refused and never forwarded"
      proof: "grep: a cross-origin or over-limit report is refused and never forwarded in tests/unit/site-errors-reach-the-sre-gardener.test.ts"
    - claim: "an unprovisioned ingest token makes reporting a silent no-op, not a broken page"
      proof: "grep: an unprovisioned ingest token makes reporting a silent no-op in tests/unit/site-errors-reach-the-sre-gardener.test.ts"
  falsifier: "CLOSE IF the site already reports server and client errors to core."
`;

/** A well-formed filing: one concern, its test inside its own files:. */
const CLEAN_FILING = `- id: PORTAL-T90
  title: "the footer names the deploy sha"
  repo: remudero-site
  depends_on: []
  priority: 2
  type: implement
  verify: auto
  principles: {tdd: strict}
  budget_usd: 5.00
  risk: low
  origin: "fixture"
  files: [app/footer.tsx, tests/unit/footer.test.ts]
  status: queued
  rationale: "An operator cannot tell which deploy is serving."
  design: "Render VERCEL_GIT_COMMIT_SHA's first seven characters in the footer."
  acceptance:
    - claim: "the footer renders the deploy sha"
      proof: "grep: the footer renders the deploy sha in tests/unit/footer.test.ts"
  falsifier: "CLOSE IF the footer already names the deploy sha."
`;

/** A consumer repo whose origin/main holds the legacy plan, with `filing` committed on a branch at HEAD. */
function consumerWithFiling(filing: string): { repo: GitRepo; diff: string } {
  const origin = gitRepo({ bare: true, kind: "w4423-origin" });
  const repo = gitRepo({ kind: "w4423-consumer" });
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), HEADER + LEGACY_ILLFORMED, "utf8");
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "--quiet", "-m", "chore(plan): the legacy plan");
  repo.git("remote", "add", "origin", origin.dir);
  repo.git("push", "--quiet", "origin", "HEAD:main");
  repo.git("checkout", "--quiet", "-b", "chore/file-it");
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), `${HEADER}${LEGACY_ILLFORMED}\n${filing}`, "utf8");
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "--quiet", "-m", "chore(plan): file it");
  return { repo, diff: repo.git("diff", "origin/main...HEAD") };
}

const FILING_CRITERIA = [{ claim: "the task is filed", proof: "the task is filed in the plan" }];
const FILING_REPORT = "The task is filed in the plan: filed, task, plan.";

test("a consumer plan-only pull request with a lint-plan violation fails review with the violation named", async () => {
  const { repo, diff } = consumerWithFiling(PORTAL_T27);
  const lint = await lintPlanForReview(repo.dir);

  assert.equal(lint.ran, true, `the lint must actually run: ${JSON.stringify(lint)}`);
  const ran = lint as Extract<PlanLintOutcome, { ran: true }>;
  assert.equal(ran.checked, 1, "only the filed task is linted — PORTAL-T22's legacy failure is not this PR's");
  assert.ok(ran.violations.some((v) => v.startsWith("PORTAL-T27 [sizing]") && /risk:medium/.test(v)), ran.violations.join("\n"));
  assert.ok(ran.violations.some((v) => v.startsWith("PORTAL-T27 [proof-scope]")), "the out-of-files test is named too");
  assert.ok(!ran.violations.some((v) => v.includes("PORTAL-T22")), "a legacy failure elsewhere never fails this filing");
  assert.ok(!ran.violations.some((v) => v.includes("[monolith-filing]")), "a repo with no plan/tasks.d is not told to shard");
  assert.match(ran.skipped ?? "", /monolith-filing skipped/, "and the skip is named, not silent");

  const verdict = judgeReview(FILING_CRITERIA, { diff, report: FILING_REPORT, planLint: lint });
  assert.equal(verdict.planOnly, true, "fixture assumption: the diff is plan-only");
  assert.equal(verdict.criteria[0].met, true, "fixture assumption: the criterion itself passes, so only the lint can fail it");
  assert.equal(verdict.state, "failure");
  assert.equal(verdict.floorState, "failure", "verdict stability can never forgive it");
  assert.match(verdict.summary, /^remudero-review: FAIL — lint-plan: PORTAL-T27 \[sizing\] spans 4 distinct/);
  assert.match(verdict.summary, /\(\+\d+ more\)$/, "the rest are counted on the status");
  assert.ok(verdict.summary.length <= 140, `status cap: ${verdict.summary.length}`);
  assert.deepEqual(verdict.planLint, lint, "the full list rides the ledgered verdict");

  // PAIRED CONTROL: the SAME repo shape with a well-formed filing passes, and the status names what ran.
  const clean = consumerWithFiling(CLEAN_FILING);
  const cleanLint = await lintPlanForReview(clean.repo.dir);
  assert.deepEqual(cleanLint.ran && cleanLint.violations, [], JSON.stringify(cleanLint));
  const pass = judgeReview(FILING_CRITERIA, { diff: clean.diff, report: FILING_REPORT, planLint: cleanLint });
  assert.equal(pass.state, "success");
  assert.equal(
    pass.summary,
    "remudero-review: PASS — plan-only PR (1 criteria); lint-plan ran on its changed tasks (1 checked, 0 failing, shard rule n/a); no proof run",
  );
  assert.ok(pass.summary.length <= 140, `status cap: ${pass.summary.length}`);
});

test("a plan-only review whose lint cannot run withholds the pass", async () => {
  const { repo, diff } = consumerWithFiling(CLEAN_FILING);
  const withheld = (lint: PlanLintOutcome | undefined) =>
    judgeReview(FILING_CRITERIA, { diff, report: FILING_REPORT, planLint: lint });

  // No lint at all: the status would otherwise name a gate that never ran.
  const none = withheld(undefined);
  assert.equal(none.state, "failure");
  assert.equal(none.floorState, "failure");
  assert.match(none.summary, /^remudero-review: FAIL — plan-only PASS withheld, lint-plan could not run: no lint was run$/);

  // No PR-head checkout.
  const noHead = await lintPlanForReview(undefined);
  assert.deepEqual(noHead, { ran: false, reason: "no PR-head checkout" });
  assert.match(withheld(noHead).summary, /withheld, lint-plan could not run: no PR-head checkout/);

  // No origin to fetch and no origin/main: no merge base, so no changed-task selection.
  repo.git("remote", "remove", "origin");
  const noBase = await lintPlanForReview(repo.dir);
  assert.equal(noBase.ran, false);
  assert.match(noBase.ran ? "" : noBase.reason, /^no merge base: /);
  assert.equal(withheld(noBase).state, "failure");

  // A head plan that does not load: lint-plan exits 2 and that is never a pass.
  const broken = consumerWithFiling(CLEAN_FILING);
  writeFileSync(join(broken.repo.dir, "plan", "tasks.yaml"), "- id: [unterminated\n", "utf8");
  const unloadable = await lintPlanForReview(broken.repo.dir);
  assert.equal(unloadable.ran, false, JSON.stringify(unloadable));
  const v = withheld(unloadable);
  assert.equal(v.state, "failure");
  assert.match(v.summary, /^remudero-review: FAIL — plan-only PASS withheld, lint-plan could not run: /);
  assert.ok(v.summary.length <= 140, `status cap: ${v.summary.length}`);

  // A lint that THROWS is an unknown too, and the console it borrowed is handed back.
  const consoleError = console.error;
  const threw = await lintPlanForReview(broken.repo.dir, undefined, async () => {
    throw new Error("linter crashed");
  });
  assert.deepEqual(threw, { ran: false, reason: "lint-plan threw: linter crashed" });
  assert.equal(console.error, consoleError, "the captured console is restored");
});

test("the lint report parser fails closed on output it cannot read", () => {
  const summary = "\nrmd lint-plan: 2 task(s) checked (2 new/changed vs abc) — 1 failing, 0 warning(s)";
  // No summary line: the pass cannot be shown to have completed.
  assert.deepEqual(planLintOutcomeFromOutput(0, [], "abc", true), { ran: false, reason: "lint-plan exited 0 with no summary" });
  // A non-zero exit with nothing it can name is still a violation, never a pass.
  const unnamed = planLintOutcomeFromOutput(1, [summary], "abc", true);
  assert.deepEqual(unnamed.ran && unnamed.violations, ["lint-plan exited 1 with no violation it could name"]);
  // A policy violation names no task and is kept whole.
  const policy = planLintOutcomeFromOutput(1, ["✗ plan/policy.yaml: bad value", summary], "abcdef0123456789", true);
  assert.deepEqual(policy.ran && policy.violations, ["plan/policy.yaml: bad value"]);
  assert.equal(policy.ran && policy.label, "lint-plan changed-task pass (offline) vs merge base abcdef012345");
  // In a repo that DOES keep plan/tasks.d, monolith-filing is a real violation and is kept.
  const sharded = planLintOutcomeFromOutput(1, ["✗ X-T1: 1 violation(s)", "    [monolith-filing] shard it", summary], "abc", true);
  assert.deepEqual(sharded.ran && sharded.violations, ["X-T1 [monolith-filing] shard it"]);
});

test("review reuse never re-issues a plan-only verdict without re-running its lint", async () => {
  const { repo, diff } = consumerWithFiling(CLEAN_FILING);
  const prior = judgeReview(FILING_CRITERIA, { diff, report: FILING_REPORT, planLint: await lintPlanForReview(repo.dir) });
  assert.equal(prior.state, "success", "fixture assumption: the prior verdict passed");
  const reused = discriminateReviewReuse({
    prior,
    diff,
    report: FILING_REPORT,
    headCheckoutDir: repo.dir,
    baseCheckoutDir: repo.dir,
  });
  assert.deepEqual(reused, { ok: false, reason: "a plan-only verdict needs a full review to re-run lint-plan" });
});

/**
 * W1-T11390 — AN INCOMPLETE LINT CAN BE RE-EVALUATED ONCE, ON REQUEST, AND NOWHERE ELSE.
 *
 * The seeded terminal is a real judgeReview verdict over the consumer fixture, with its proof executed on the head,
 * so `capped` and `keywordOnly` are false because the judge said so. Every read past the ledger is an injected seam
 * except the checkout's HEAD, which really shells out. `review()` is the shape a future caller takes: claim, lint only
 * when owned, judge, publish.
 */
const RETRY_PR = "https://github.com/acme/portal/pull/133";
const RETRY_TASK = "PORTAL-T90";
const INCOMPLETE: PlanLintOutcome = { ran: false, reason: "lint-plan exited 1 with no summary" };
const RETRY_CRITERIA = [{ claim: "the filing names its repo", proof: "grep: remudero-site in plan/tasks.yaml" }];
const NO_SUCH_PROOF = [{ claim: "the filing names its repo", proof: "grep: nothing-matches-this in plan/tasks.yaml" }];
const TTL_PAST_MS = 3 * 60 * 60 * 1000;

interface SeedOptions {
  planLint?: PlanLintOutcome;
  criteria?: typeof RETRY_CRITERIA;
  verdict?: (verdict: ReviewVerdict) => unknown;
  row?: Record<string, unknown>;
  omitRecordedBase?: boolean;
}

/** One process-wide credential: the exchange is faked, and the publisher proof it leaves is the real one. */
async function usablePublisher(t: TestContext): Promise<void> {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  delete process.env.REMUDERO_REVIEWER_TOKEN;
  delete process.env.REMUDERO_REVIEWER_LOGIN;
  process.env.GH_APP_ID = "42";
  process.env.GH_APP_INSTALLATION_ID = "7";
  process.env.GH_APP_PRIVATE_KEY_PATH = "/fixture/key";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const refreshed = await refreshReviewPublisherToken({
    readKey: () => privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    fetchImpl: (async () => new Response(JSON.stringify({
      token: "fixture-native-token", expires_at: new Date(Date.now() + 600_000).toISOString(),
    }))) as typeof fetch,
  });
  assert.equal(refreshed.ok, true, "fixture assumption: the native exchange succeeded");
}

async function retryFixture(t: TestContext, seed: SeedOptions = { planLint: INCOMPLETE }, filing = CLEAN_FILING) {
  await usablePublisher(t);
  const { repo, diff } = consumerWithFiling(filing);
  const headSha = repo.git("rev-parse", "HEAD").trim();
  const mergeBaseSha = repo.git("merge-base", "origin/main", "HEAD").trim();
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-lint-retry-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const digest = reviewDecisionDigest({ headSha, diff, report: FILING_REPORT, acceptance: RETRY_CRITERIA });
  const judged = (planLint: PlanLintOutcome | undefined, criteria = RETRY_CRITERIA) =>
    judgeReview(criteria, { diff, report: FILING_REPORT, planLint, headCheckoutDir: repo.dir });
  const seedTerminal = (options: SeedOptions = { planLint: INCOMPLETE }): string => {
    const real = { ...judged("planLint" in options ? options.planLint : INCOMPLETE, options.criteria), mergeBaseSha };
    const verdict = (options.verdict ?? ((v: ReviewVerdict) => v))(real) as ReviewVerdict;
    const { merge_base_sha: _base, ...legibility } = reviewLedgerLegibilityFields(real);
    if (options.omitRecordedBase) delete verdict.mergeBaseSha;
    appendLedger(ledgerPath, {
      run_id: "first-review", task_id: RETRY_TASK, step: "review.posted", pr_url: RETRY_PR, head_sha: headSha,
      review_decision_digest: digest, state: real.state, decision_verdict: verdict, reviewer_outcome: "reviewer_completed",
      ...legibility, ...(options.omitRecordedBase ? {} : { merge_base_sha: mergeBaseSha }), ...options.row,
    });
    return readFileSync(ledgerPath, "utf8").trimEnd().split("\n").at(-1)!;
  };
  const f = {
    repo, diff, headSha, mergeBaseSha, stateDir, ledgerPath, digest, judged, seedTerminal,
    lintRuns: 0,
    posts: [] as Array<{ state: string; description?: string }>,
    lifecycle: { merged: false, closed: false, baseRef: "main" } as { merged: boolean; closed: boolean; baseRef: string; reviewInputDigest?: string },
    observed: undefined as unknown,
    observe: async (): Promise<never> => (typeof f.observed === "function" ? f.observed() : f.observed) as never,
    binding: { contexts: ["remudero-review"], checks: [{ context: "remudero-review", app_id: 42 }] } as unknown,
    fetchPublisher: (args: string[]) => {
      if (f.binding instanceof Error) throw f.binding;
      if (args[1]?.endsWith("required_status_checks")) return f.binding;
      throw new Error(`unexpected read ${args.join(" ")}`);
    },
    healthy: () => ({
      headSha, mergeBaseSha, baseRef: "main", checks: { headSha, fresh: true, complete: true, passing: true },
    }),
    request: (over: Record<string, unknown> = {}) => ({
      attemptId: "attempt-1", runId: "retry-run", owner: "acme", repo: "portal", headSha, mergeBaseSha, observe: f.observe,
      fetchPublisher: f.fetchPublisher, readRequiredContexts: readRequiredStatusCheckContextsAsync, ...over,
    }),
    claim: (over: Record<string, unknown> = {}, claimOver: Record<string, unknown> = {}) => claimReviewDecision({
      ledgerPath, taskId: RETRY_TASK, prUrl: RETRY_PR, digest, headCheckoutDir: repo.dir,
      planLintRetry: f.request(over), ...claimOver,
    }),
    post: (retry: { attemptId?: string; outcome?: PlanLintOutcome } | undefined, verdict: Pick<ReviewVerdict, "state" | "summary" | "criteria">, over: Record<string, unknown> = {}) =>
      postReviewStatusGuarded({
        owner: "acme", repo: "portal", sha: headSha, state: verdict.state, description: verdict.summary, taskId: RETRY_TASK,
        evidence: reviewEvidenceStrength(verdict.criteria), ledgerPath, runId: "retry-run", prUrl: RETRY_PR,
        reviewDecisionDigest: digest, reopenedDegradedTerminal: true, fetchLifecycle: () => f.lifecycle,
        fetchPublisher: f.fetchPublisher, readRequiredContexts: readRequiredStatusCheckContextsAsync,
        post: (o) => { f.posts.push({ state: o.state, description: o.description }); },
        // W1-T11443: a SUCCESS reads the head's status history first; this head has no reproduced prior FAILURE.
        readReviewStatusHistory: async () => ({ kind: "readable", failures: [] }),
        ...(retry ? { planLintRetry: { attemptId: "attempt-1", observe: f.observe, ...retry } } : {}), ...over,
      }),
    /** The whole pipeline a caller drives. `release` always runs, so one attempt never blocks the next. */
    review: async (lint: () => Promise<PlanLintOutcome | undefined>, over: Record<string, unknown> = {}) => {
      const claim = await f.claim(over);
      if (claim.kind !== "owned") return { claim, result: undefined };
      try {
        f.lintRuns += 1;
        const outcome = await lint();
        return { claim, outcome, result: await f.post({ outcome, attemptId: String(over.attemptId ?? "attempt-1") }, judged(outcome)) };
      } finally {
        claim.release();
      }
    },
    rows: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
    retryRows: () => f.rows().filter((row) => row.step === "review.plan_lint_retry"),
    lastRetryRow: () => f.retryRows().at(-1)!,
    terminal: () => lastReviewDecisionTerminal(f.rows(), RETRY_TASK, RETRY_PR, digest),
    /** A fresh decision on the same fixture: the seeded row, and nothing else, in a new ledger. */
    reset: (options?: SeedOptions): string => {
      rmSync(ledgerPath, { force: true });
      f.lintRuns = 0;
      f.posts.length = 0;
      f.observed = f.healthy();
      return seedTerminal(options);
    },
  };
  f.observed = f.healthy();
  const seeded = seedTerminal(seed);
  return { f, seeded };
}

async function assertRefused(
  f: Awaited<ReturnType<typeof retryFixture>>["f"],
  reason: RegExp,
  over: Record<string, unknown> = {},
  claimOver: Record<string, unknown> = {},
): Promise<void> {
  const before = f.terminal();
  const claim = await f.claim(over, claimOver);
  assert.equal(claim.kind, "replay", `expected a replay for ${reason}: ${JSON.stringify(f.lastRetryRow())}`);
  assert.deepEqual(claim.kind === "replay" && claim.terminal, before, "the prior terminal replays unchanged");
  const row = f.lastRetryRow();
  assert.equal(row.outcome, "refused");
  assert.match(String(row.reason), reason);
  assert.equal(f.posts.length, 0, "a refusal posts nothing");
  assert.equal(f.lintRuns, 0, "a refusal runs no lint");
}

test("W1-T11390: an incomplete first lint retries once and keeps the prior terminal", async (t) => {
  const { f, seeded } = await retryFixture(t);
  const prior = f.terminal()!;
  assert.deepEqual(
    [prior.state, prior.verdict.capped, prior.verdict.keywordOnly, prior.verdict.planOnly, prior.verdict.criteria[0].met],
    ["failure", false, false, true, true],
    "fixture assumption: the judge itself produced the shape the predicate admits",
  );

  const { claim, outcome, result } = await f.review(() => lintPlanForReview(f.repo.dir));
  assert.equal(claim.kind, "owned");
  assert.equal(claim.kind === "owned" && claim.reopenedDegradedTerminal, true);
  assert.equal(f.lintRuns, 1, "lint-plan ran again");
  assert.deepEqual(outcome?.ran && outcome.violations, [], JSON.stringify(outcome));
  assert.equal(result?.posted, true, result?.reason);
  assert.deepEqual(f.posts.map((post) => post.state), ["success"]);
  assert.match(f.posts[0].description ?? "", /lint-plan ran on its changed tasks \(1 checked, 0 failing/);

  const [admitted, published] = f.retryRows();
  assert.deepEqual(
    [admitted.attempt_id, admitted.pr_url, admitted.head_sha, admitted.merge_base_sha, admitted.review_decision_digest, admitted.prior_run_id, admitted.outcome],
    ["attempt-1", RETRY_PR, f.headSha, f.mergeBaseSha, f.digest, "first-review", "admitted"],
  );
  assert.deepEqual([published.attempt_id, published.merge_base_sha, published.outcome], ["attempt-1", f.mergeBaseSha, "published"]);
  assert.equal(f.retryRows().length, 2);

  // The caller's existing review.posted write. The failure stays where it was, byte for byte, beside it.
  const fresh = f.judged(outcome);
  appendLedger(f.ledgerPath, {
    run_id: "retry-run", task_id: RETRY_TASK, step: "review.posted", pr_url: RETRY_PR, head_sha: f.headSha,
    review_decision_digest: f.digest, state: fresh.state, decision_verdict: fresh,
  });
  const lines = readFileSync(f.ledgerPath, "utf8").trim().split("\n");
  assert.ok(lines.includes(seeded), "the prior terminal row is byte-identical");
  assert.equal(f.rows().filter((row) => row.step === "review.posted").length, 2);
  assert.equal(f.terminal()?.state, "success", "the last row reads as the terminal, as it always has");
  f.lintRuns = 0;
  f.posts.length = 0;
  await assertRefused(f, /not a lone lint-plan failure/, { attemptId: "attempt-2" });
});

test("W1-T11390: a retry publishes real findings, and only what its lint earned", async (t) => {
  const { f } = await retryFixture(t, { planLint: INCOMPLETE }, PORTAL_T27);
  const { result, outcome } = await f.review(() => lintPlanForReview(f.repo.dir));
  assert.equal(outcome?.ran, true, JSON.stringify(outcome));
  assert.equal(result?.posted, true, "a failure replacing a failure is a publication, not a replay");
  assert.equal(result?.conflict, undefined);
  assert.deepEqual(f.posts.map((post) => post.state), ["failure"]);
  assert.match(f.posts[0].description ?? "", /lint-plan: PORTAL-T27 \[sizing\]/);
  assert.equal(f.lastRetryRow().outcome, "published");

  const clean: PlanLintOutcome = { ran: true, label: "fixture", checked: 1, violations: [] };
  const dirty: PlanLintOutcome = { ...clean, violations: ["PORTAL-T27 [sizing] too wide"] };
  for (const [outcome, state] of [[clean, "failure"], [dirty, "success"]] as const) {
    f.reset();
    const claim = await f.claim();
    assert.equal(claim.kind, "owned");
    const refused = await f.post({ outcome }, { ...f.judged(outcome), state });
    if (claim.kind === "owned") claim.release();
    assert.equal(refused.posted, false);
    assert.match(refused.reason ?? "", /cannot publish/);
    assert.deepEqual(f.posts, []);
    assert.equal(f.lastRetryRow().outcome, "refused");
  }
  f.reset();
  const claim = await f.claim();
  const failing = await f.post({ outcome: clean }, f.judged(clean), { post: () => { throw new Error("status write refused"); } });
  if (claim.kind === "owned") claim.release();
  assert.equal(failing.posted, false);
  assert.equal(f.lastRetryRow().outcome, "post_failed");
  assert.equal(f.lastRetryRow().reason, "status write refused");
  const pendingRetry = await f.post({ outcome: clean }, { ...f.judged(clean), state: "pending" });
  assert.equal(pendingRetry.posted, false, "a settled attempt publishes nothing further");
});

test("W1-T11390: real lint findings never retry", async (t) => {
  const { f } = await retryFixture(t);
  const findings: PlanLintOutcome = { ran: true, label: "fixture", checked: 1, violations: ["PORTAL-T90 [sizing] too wide"] };
  f.reset({ planLint: findings });
  assert.equal(f.terminal()?.state, "failure", "fixture assumption: the findings failed the verdict");
  await assertRefused(f, /not a lone lint-plan failure/);

  for (const reason of [
    "no PR-head checkout", "no merge base: unrelated histories", "lint-plan aborted", "lint-plan killed by SIGKILL",
    "lint-plan could not start: spawn ENOENT", "lint-plan exited without a status", "lint-plan threw: linter crashed",
    "plan/tasks.yaml failed to load", "lint-plan exited 1 with no violation it could name",
    "lint-plan exited 1 with no summary, and more", "lint-plan exited 1 with no summary; it said: x",
    "x lint-plan exited 1 with no summary", "lint-plan exited with no summary", "lint-plan exited -1 with no summary",
  ]) {
    f.reset({ planLint: { ran: false, reason } });
    await assertRefused(f, /not a lone lint-plan failure/);
  }

  // PAIRED CONTROL: both reason forms W1-T11225's landing can leave behind are admitted, so the table above is the match.
  for (const reason of ["lint-plan exited 1 with no summary", "lint-plan exited 137 with no summary; it printed: fatal\nheap out of memory"]) {
    f.reset({ planLint: { ran: false, reason } });
    const claim = await f.claim();
    assert.equal(claim.kind, "owned", JSON.stringify(f.lastRetryRow()));
    if (claim.kind === "owned") claim.release();
  }
});

test("W1-T11390: a malformed terminal or missing checkout refuses", async (t) => {
  const { f } = await retryFixture(t);
  const shapes: Array<[string, (verdict: ReviewVerdict) => unknown]> = [
    ["no planLint", ({ planLint: _lint, ...verdict }) => verdict],
    ["null planLint", (verdict) => ({ ...verdict, planLint: null })],
    ["string planLint", (verdict) => ({ ...verdict, planLint: "lint-plan exited 1 with no summary" })],
    ["no reason", (verdict) => ({ ...verdict, planLint: { ran: false } })],
    ["numeric reason", (verdict) => ({ ...verdict, planLint: { ran: false, reason: 1 } })],
    ["a truthy ran", (verdict) => ({ ...verdict, planLint: { ran: 0, reason: "lint-plan exited 1 with no summary" } })],
    ["capped", (verdict) => ({ ...verdict, capped: true })],
    ["keyword-only", (verdict) => ({ ...verdict, keywordOnly: true })],
    ["capped keyword-only", (verdict) => ({ ...verdict, capped: true, keywordOnly: true })],
    ["no capped field", ({ capped: _capped, ...verdict }) => verdict],
    ["not plan-only", (verdict) => ({ ...verdict, planOnly: false })],
    ["a passing state", (verdict) => ({ ...verdict, state: "success" })],
    ["a summary that is not the lint's", (verdict) => ({ ...verdict, summary: "remudero-review: FAIL — test theater" })],
  ];
  for (const [name, verdict] of shapes) {
    await t.test(name, async () => {
      f.reset({ planLint: INCOMPLETE, verdict });
      await assertRefused(f, /not a lone lint-plan failure/);
    });
  }

  // The same lint reason, but a criterion failed too: the lint is not why this terminal failed.
  f.reset({ planLint: INCOMPLETE, criteria: NO_SUCH_PROOF });
  assert.equal(f.terminal()?.verdict.criteria[0].met, false, "fixture assumption: the criterion failed on its own");
  await assertRefused(f, /not a lone lint-plan failure/);

  f.reset({ planLint: INCOMPLETE, omitRecordedBase: true });
  await assertRefused(f, /no merge base/);
  f.reset({ planLint: INCOMPLETE, row: { merge_base_sha: "0".repeat(40) } });
  await assertRefused(f, /different merge base/);
  f.reset({ planLint: INCOMPLETE, verdict: (verdict) => ({ ...verdict, mergeBaseSha: "0".repeat(40) }) });
  await assertRefused(f, /different merge base/);
  f.reset({ planLint: INCOMPLETE, row: { head_sha: "0".repeat(40) } });
  await assertRefused(f, /judged head/);
  // A replay's review.posted row carries no top-level base, and its verdict still records the one judged.
  f.reset({ planLint: INCOMPLETE, row: { merge_base_sha: undefined } });
  const fromVerdict = await f.claim();
  assert.equal(fromVerdict.kind, "owned", JSON.stringify(f.lastRetryRow()));
  if (fromVerdict.kind === "owned") fromVerdict.release();

  f.reset();
  await assertRefused(f, /no PR-head checkout/, {}, { headCheckoutDir: undefined });
  f.reset();
  await assertRefused(f, /a retry read failed/, {}, { headCheckoutDir: join(f.stateDir, "no-such-checkout") });
  f.reset();
  const elsewhere = gitRepo({ kind: "w11390-other-checkout" });
  writeFileSync(join(elsewhere.dir, "a"), "a", "utf8");
  elsewhere.git("add", "a");
  elsewhere.git("commit", "--quiet", "-m", "chore: another head");
  await assertRefused(f, /the checkout is at/, {}, { headCheckoutDir: elsewhere.dir });

  // Nothing to re-evaluate: an ordinary first review keeps its claim, and the retry's publication refuses.
  rmSync(f.ledgerPath, { force: true });
  const first = await f.claim();
  assert.equal(first.kind, "owned");
  assert.equal(first.kind === "owned" && first.reopenedDegradedTerminal, undefined);
  if (first.kind === "owned") first.release();
  assert.match(String(f.lastRetryRow().reason), /no terminal exists/);
  const unadmitted = await f.post({ outcome: { ran: true, label: "x", checked: 1, violations: [] } }, f.judged(INCOMPLETE));
  assert.equal(unadmitted.posted, false);
  assert.match(unadmitted.reason ?? "", /no admitted lint retry/);
});

test("W1-T11390: a changed head or base refuses", async (t) => {
  const { f } = await retryFixture(t);
  const moved = "f".repeat(40);
  const clean: PlanLintOutcome = { ran: true, label: "fixture", checked: 1, violations: [] };

  f.observed = { ...f.healthy(), headSha: moved };
  await assertRefused(f, /PR head moved/);
  f.reset();
  f.observed = { ...f.healthy(), mergeBaseSha: moved };
  await assertRefused(f, /merge base moved/);
  f.reset();
  await assertRefused(f, /a retry read failed: Error: transport down/, { observe: () => { throw new Error("transport down"); } });
  f.reset();
  await assertRefused(f, /judged a different|different merge base/, { mergeBaseSha: moved });
  f.reset();
  await assertRefused(f, /judged head/, { headSha: moved });

  // The same movement seen only by the re-check at publication: admitted, then nothing posted, the terminal unmoved.
  const atPublication: Array<[string, () => void, RegExp, Record<string, unknown>?]> = [
    ["head", () => { f.observed = { ...f.healthy(), headSha: moved }; }, /PR head moved/],
    ["base", () => { f.observed = { ...f.healthy(), mergeBaseSha: moved }; }, /merge base moved/],
    ["unreadable", () => { f.observed = () => { throw new Error("transport down"); }; }, /a retry read failed/],
    ["closed", () => { f.lifecycle = { ...f.lifecycle, closed: true }; }, /already closed/],
    ["merged", () => { f.lifecycle = { ...f.lifecycle, merged: true }; }, /already merged/],
    ["body", () => { f.lifecycle = { ...f.lifecycle, reviewInputDigest: "v2:other" }; }, /review input changed/, { reviewInputDigest: "v2:judged" }],
    ["identity", () => { process.env.GH_TOKEN = "another-token"; }, /cannot publish as App 42/],
    ["unpinned", () => { f.binding = { contexts: [], checks: [{ context: "remudero-review", app_id: null }] }; }, /no pinned App id/],
  ];
  for (const [name, change, reason, over] of atPublication) {
    await t.test(`at publication: ${name}`, async () => {
      const token = process.env.GH_TOKEN;
      const binding = f.binding;
      const prior = f.reset();
      f.lifecycle = { merged: false, closed: false, baseRef: "main" };
      const claim = await f.claim();
      assert.equal(claim.kind, "owned", JSON.stringify(f.lastRetryRow()));
      change();
      const refused = await f.post({ outcome: clean }, f.judged(clean), over);
      if (claim.kind === "owned") claim.release();
      process.env.GH_TOKEN = token;
      f.binding = binding;
      assert.equal(refused.posted, false);
      assert.match(refused.reason ?? "", reason);
      assert.deepEqual(f.posts, [], "nothing is posted");
      assert.equal(f.lastRetryRow().outcome, "refused");
      assert.equal(f.lastRetryRow().merge_base_sha, f.mergeBaseSha);
      assert.equal(f.rows().filter((row) => row.step === "review.post_refused").length, 1, "the refusal is ledgered through withholdReplay");
      assert.equal(f.rows().filter((row) => row.step === "review.verdict_conflict").length, 0);
      assert.ok(readFileSync(f.ledgerPath, "utf8").includes(prior));
      assert.equal(f.terminal()?.state, "failure");
    });
  }
  f.lifecycle = { merged: false, closed: false, baseRef: "main" };
});

test("W1-T11390: failing checks or an unpinned identity refuse", async (t) => {
  const { f } = await retryFixture(t);
  const checks = f.healthy().checks;
  const refusedChecks: Array<[string, unknown]> = [
    ["a failing check", { ...checks, passing: false }],
    ["a pending check", { ...checks, complete: false }],
    ["a stale read", { ...checks, fresh: false }],
    ["another head's checks", { ...checks, headSha: "f".repeat(40) }],
    ["truthy, not true", { ...checks, passing: "yes" }],
  ];
  for (const [name, value] of refusedChecks) {
    await t.test(name, async () => {
      f.reset();
      f.observed = { ...f.healthy(), checks: value };
      await assertRefused(f, /not fresh, complete and passing/);
    });
  }
  f.reset();
  const { checks: _missing, ...noChecks } = f.healthy();
  f.observed = noChecks;
  await assertRefused(f, /a retry read failed/);

  const refusedIdentities: Array<[string, unknown, RegExp]> = [
    ["an unpinned context", { contexts: [], checks: [{ context: "remudero-review", app_id: null }] }, /no pinned App id/],
    ["no review binding", { contexts: [], checks: [] }, /no pinned App id/],
    ["an ambiguous binding", { contexts: [], checks: [{ context: "remudero-review", app_id: 42 }, { context: "remudero-review", app_id: 43 }] }, /a retry read failed/],
    ["another App", { contexts: ["remudero-review"], checks: [{ context: "remudero-review", app_id: 43 }] }, /cannot publish as App 43/],
    ["an unreadable binding", new Error("HTTP 403 forbidden"), /a retry read failed/],
  ];
  for (const [name, binding, reason] of refusedIdentities) {
    await t.test(name, async () => {
      const pinned = f.binding;
      f.reset();
      f.binding = binding;
      await assertRefused(f, reason);
      f.binding = pinned;
    });
  }
  f.reset();
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "another-token";
  await assertRefused(f, /cannot publish as App 42/);
  process.env.GH_TOKEN = token;
  f.reset();
  f.observed = { ...f.healthy(), baseRef: "" };
  await assertRefused(f, /base branch is unreadable/);
  f.reset();
  await assertRefused(f, /a retry read failed: Error: no required-status-contexts reader/, { readRequiredContexts: undefined });

  // PAIRED CONTROL: the same fixture, healthy, is admitted.
  f.reset();
  const claim = await f.claim();
  assert.equal(claim.kind, "owned", JSON.stringify(f.lastRetryRow()));
  if (claim.kind === "owned") claim.release();
});

test("W1-T11390: a concurrent owner refuses", async (t) => {
  const { f } = await retryFixture(t);
  const lockPath = join(dirname(f.ledgerPath), "review-decision-claims", `${f.digest.replace(":", "-")}.lock`);
  mkdirSync(dirname(lockPath), { recursive: true });
  const held = await acquireReviewStatusLock(lockPath, { timeoutMs: 0 });
  const standDown = await f.claim();
  held.release();
  assert.deepEqual(standDown, { kind: "in_flight" });
  assert.equal(f.lastRetryRow().outcome, "refused");
  assert.match(String(f.lastRetryRow().reason), /holds the decision lock/);

  const pending = (run: string, extra: Record<string, unknown> = {}) => appendLedger(f.ledgerPath, {
    run_id: run, task_id: RETRY_TASK, step: "review.pending_posted", pr_url: RETRY_PR, head_sha: f.headSha, ...extra,
  });
  f.reset();
  pending("another-run");
  await assertRefused(f, /run another-run holds a live pending claim/, { assessPendingOwner: () => "active" });
  f.reset();
  pending("another-run");
  await assertRefused(f, /run another-run holds a live pending claim/, { assessPendingOwner: () => "unknown" });
  f.reset();
  appendFileSync(f.ledgerPath, `${JSON.stringify({ ts: "garbled", run_id: "another-run", task_id: RETRY_TASK, step: "review.pending_posted", pr_url: RETRY_PR, head_sha: f.headSha })}\n`);
  await assertRefused(f, /run another-run holds a live pending claim/);
  f.reset();
  pending("another-run", { head_sha: undefined });
  await assertRefused(f, /run another-run holds a live pending claim/);
  // Default assessment: this process is alive on this host, so its own young claim is proof of a live owner.
  f.reset();
  pending("another-run", { owner_pid: process.pid, owner_started_at: new Date().toISOString() });
  await assertRefused(f, /run another-run holds a live pending claim/);

  // PAIRED CONTROLS: what is not a live foreign claim does not refuse.
  const admits = async (name: string, arrange: () => void, over: Record<string, unknown> = {}) => {
    f.reset();
    arrange();
    const claim = await f.claim(over);
    assert.equal(claim.kind, "owned", `${name}: ${JSON.stringify(f.lastRetryRow())}`);
    if (claim.kind === "owned") claim.release();
  };
  await admits("this run's own claim", () => pending("retry-run"));
  await admits("a proven-dead owner", () => pending("another-run"), { assessPendingOwner: () => "dead" });
  await admits("an expired claim", () => pending("another-run"), {
    assessPendingOwner: () => "active", clock: fixedClock(systemClock.now() + TTL_PAST_MS),
  });
  await admits("another PR's claim", () => pending("another-run", { pr_url: "https://github.com/acme/portal/pull/134" }));
  rmSync(f.ledgerPath, { force: true });
  pending("another-run");
  f.seedTerminal();
  const earlier = await f.claim();
  assert.equal(earlier.kind, "owned", `a claim before the terminal is over: ${JSON.stringify(f.lastRetryRow())}`);
  if (earlier.kind === "owned") earlier.release();
});

test("W1-T11390: a second incomplete retry keeps the prior failure", async (t) => {
  const { f, seeded } = await retryFixture(t);
  const prior = f.terminal();
  const { claim, result } = await f.review(async () => ({ ran: false, reason: "lint-plan exited 1 with no summary" }));
  assert.equal(claim.kind, "owned");
  assert.equal(f.lintRuns, 1);
  assert.equal(result?.posted, false);
  assert.equal(result?.conflict, undefined, "never the conflicting-verdicts arm");
  assert.match(result?.reason ?? "", /did not finish: lint-plan exited 1 with no summary/);
  assert.deepEqual(f.posts, [], "no status at all, so the conflict arm's own failure never fires");
  assert.equal(f.rows().filter((row) => row.step === "review.verdict_conflict").length, 0);
  assert.equal(f.rows().filter((row) => row.step === "review.post_refused").length, 1, "withholdReplay records the refusal");
  assert.deepEqual(f.retryRows().map((row) => row.outcome), ["admitted", "incomplete"]);
  assert.deepEqual(f.terminal(), prior, "the previous failure stays the terminal");
  assert.ok(readFileSync(f.ledgerPath, "utf8").includes(seeded));

  // The admitted row is the whole bound: a further request for this head, base and digest refuses, under any id.
  f.lintRuns = 0;
  await assertRefused(f, /already spent their retry/, { attemptId: "attempt-2" });
  assert.deepEqual(f.posts, []);

  // The attempt cannot be resurrected by publishing a clean result under the id it already settled.
  const clean: PlanLintOutcome = { ran: true, label: "fixture", checked: 1, violations: [] };
  const late = await f.post({ outcome: clean }, f.judged(clean));
  assert.equal(late.posted, false);
  assert.match(late.reason ?? "", /already settled/);
  assert.deepEqual(f.posts, []);

  // The same bound survives rotation: this step is archived away while a replay keeps a terminal row live.
  const live = readFileSync(f.ledgerPath, "utf8").split("\n").filter(Boolean);
  const archived = join(dirname(f.ledgerPath), "ledger.2026-08-27T20-18-33-155Z.ndjson");
  writeFileSync(archived, `${live.filter((line) => line.includes("review.plan_lint_retry")).join("\n")}\n`, "utf8");
  writeFileSync(f.ledgerPath, `${live.filter((line) => !line.includes("review.plan_lint_retry")).join("\n")}\n`, "utf8");
  const rotated = await f.claim({ attemptId: "attempt-3" });
  assert.equal(rotated.kind, "replay", JSON.stringify(f.retryRows()));
  assert.match(String(f.lastRetryRow().reason), /already spent their retry/);

  // An archive that cannot be read might hold the bound, so it refuses rather than admits.
  renameSync(archived, join(dirname(f.ledgerPath), "ledger.2026-08-27T20-18-33-155Z.ndjson.gz"));
  await assertRefused(f, /a retry read failed: Error: ledger unreadable/, { attemptId: "attempt-4" });
  assert.equal(existsSync(archived), false);

  // An absent outcome is incomplete too.
  f.reset();
  rmSync(join(dirname(f.ledgerPath), "ledger.2026-08-27T20-18-33-155Z.ndjson.gz"));
  const absent = await f.review(async () => undefined);
  assert.equal(absent.result?.posted, false);
  assert.match(absent.result?.reason ?? "", /did not finish: no lint was run/);
  assert.equal(f.lastRetryRow().outcome, "incomplete");
  assert.deepEqual(f.posts, []);

  // An admitted retry whose terminal changed under it is no longer the failure it was admitted against.
  f.reset();
  const claimed = await f.claim();
  f.seedTerminal({ planLint: clean });
  const superseded = await f.post({ outcome: clean }, f.judged(clean));
  if (claimed.kind === "owned") claimed.release();
  assert.equal(superseded.posted, false);
  assert.match(superseded.reason ?? "", /no longer a lint-plan failure/);
  assert.deepEqual(f.posts, []);
});

test("W1-T11390: without a request the terminal still replays", async (t) => {
  const { f, seeded } = await retryFixture(t);
  const prior = f.terminal();
  const claim = await f.claim({}, { planLintRetry: undefined });
  assert.deepEqual(claim, { kind: "replay", terminal: prior });
  assert.deepEqual(f.retryRows(), [], "no request, no attempt row");

  // Nothing but the option reaches the replacement: the same fresh success goes to the conflict arm it always did.
  const clean: PlanLintOutcome = { ran: true, label: "fixture", checked: 1, violations: [] };
  const conflict = await f.post(undefined, f.judged(clean));
  assert.equal(conflict.conflict, true);
  assert.deepEqual(f.posts.map((post) => post.state), ["failure"]);
  assert.match(f.posts[0].description ?? "", /conflicting verdicts/);
  assert.ok(readFileSync(f.ledgerPath, "utf8").includes(seeded));

  // W1-T3835's reopening is the one request-free path, and it is unchanged either way round.
  f.reset({ planLint: INCOMPLETE, verdict: (verdict) => ({ ...verdict, capped: true, keywordOnly: true }) });
  const reopened = await f.claim({}, { planLintRetry: undefined });
  assert.equal(reopened.kind, "owned");
  assert.equal(reopened.kind === "owned" && reopened.reopenedDegradedTerminal, true);
  if (reopened.kind === "owned") reopened.release();
  const noCheckout = await f.claim({}, { planLintRetry: undefined, headCheckoutDir: undefined });
  assert.equal(noCheckout.kind, "replay");
  assert.deepEqual(f.retryRows(), []);
});

test("a plan-only review whose lint cannot run withholds the pass", async () => {
  const { repo } = consumerWithFiling(CLEAN_FILING);
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>): void => { rows.push({ step, extra }); };
  const secret = "ghp_" + "a".repeat(36);
  const dies = async () => ({ status: 1, signal: null, stdout: `token ${secret}\n`, stderr: "boom: cannot open store\n\n" });
  const out = await lintPlanForReview(repo.dir, undefined, dies, { log });
  assert.equal(out.ran, false);
  assert.match(out.ran ? "" : out.reason, /^lint-plan exited 1 with no summary; it printed: boom: cannot open store$/);
  const row = rows.find((r) => r.step === "review.plan_lint_unreadable");
  assert.ok(row, "one unreadable row");
  assert.equal(row.extra?.status, 1);
  assert.match(String(row.extra?.tail), /boom: cannot open store/);
  assert.ok(!JSON.stringify(rows).includes(secret), "secret never ledgered");
  assert.ok(!(out.ran ? "" : out.reason).includes(secret));
  const quiet = await lintPlanForReview(repo.dir, undefined, async () => ({ status: 1, signal: null, stdout: "", stderr: "" }));
  assert.deepEqual(quiet, { ran: false, reason: "lint-plan exited 1 with no summary" });
});
