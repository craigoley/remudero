import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgeReview, type PlanLintOutcome } from "../src/lib/review.js";
import { lintPlanForReview, planLintOutcomeFromOutput } from "../src/run-task.js";
import { discriminateReviewReuse } from "../src/lib/sweep.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

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
