import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BUDGET_USD,
  checkPrOwnership,
  isTransientResult,
  resolveReviewTarget,
  resolveDaemonTarget,
  unknownArgError,
  noPrVerdict,
  softBudgetWarning,
  workerErrorVerdict,
  type PrHeadGateway,
} from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";

/** An injected {@link PrHeadGateway} fixture — no `gh` exec, a fixed answer per PR url. */
function fakeGateway(headRefName: string | undefined): PrHeadGateway {
  return { headRefName: () => headRefName };
}

/** Build a minimal WorkerResult for the verdict-mapping tests. */
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
    ...over,
  };
}

test("workerErrorVerdict: a non-error result maps to null (caller proceeds)", () => {
  assert.equal(workerErrorVerdict(result({ isError: false, subtype: "success" }), 1.2, "implement"), null);
});

// ── The W1-T12a bug: a worker that reaches a SUCCESS subtype but whose SDK iterator
// throws AFTER the envelope (collectWorkerResult sets isError=true, keeps subtype) must
// NOT be mislabeled a worker error. It was stamped "worker error at implement: success". ──
test("workerErrorVerdict: a SUCCESS subtype is NEVER a worker error, even if isError is set (SDK post-success throw)", () => {
  const v = workerErrorVerdict(result({ isError: true, subtype: "success" }), 5.0, "implement");
  assert.equal(v, null, "a success subtype must not map to a failed/worker-error verdict");
});

test("noPrVerdict: a terminal-SUCCESS worker with NO PR yields verdict 'no_pr' with a truthful reason — never 'error: success'", () => {
  const v = noPrVerdict(result({ isError: false, subtype: "success", numTurns: 10 }), 5.05, "implement");
  assert.equal(v.verdict, "no_pr");
  assert.equal(v.ledger.verdict, "no_pr");
  assert.equal(v.ledger.reason, "worker completed without opening a PR");
  assert.equal(v.ledger.subtype, "success");
  assert.equal(v.ledger.num_turns, 10);
  assert.equal(v.ledger.cost_usd, 5.05);
  // the exact incoherent string from run W1-T12a-1784117152056 must never appear:
  assert.doesNotMatch(v.ledger.reason, /error: success/);
  assert.doesNotMatch(v.ledger.reason, /worker error/);
});

// ── The W1-T12a REFRAME (PR #59 collapsed two OPPOSITE cases): a server_error mid-response
// is a TRANSIENT (retry), NOT a no-op. isTransientResult DISTINGUISHES them: an api-error
// result is transient; a clean terminal-success with zero commits is the real no_pr no-op. ──
test("isTransientResult: a server_error/<synthetic>/isApiErrorMessage result is TRANSIENT (→ retry, NOT no_pr, NOT block, NOT strike)", () => {
  assert.equal(isTransientResult(result({ apiError: true, subtype: "success" })), true);
  // a network-blip error subtype with a transient text signature is also transient (the classifier, now wired)
  assert.equal(
    isTransientResult(result({ isError: true, subtype: "error_during_execution", text: "Error: socket hang up" })),
    true,
  );
});

test("isTransientResult: a CLEAN terminal-success (no api-error) is NOT transient → it flows to the no_pr/no-op path", () => {
  assert.equal(isTransientResult(result({ subtype: "success", apiError: false })), false);
  // and that clean-success no-op still maps to the honest no_pr verdict (the OPPOSITE of a transient):
  assert.equal(noPrVerdict(result({ subtype: "success" }), 1, "implement").verdict, "no_pr");
});

test("isTransientResult: a real task failure (error_max_turns) is NOT transient — it is a strike → failed", () => {
  assert.equal(isTransientResult(result({ isError: true, subtype: "error_max_turns" })), false);
});

test("REGRESSION: the real-error path is unchanged — error_max_turns still → failed with its own reason", () => {
  const v = workerErrorVerdict(result({ isError: true, subtype: "error_max_turns", numTurns: 81 }), 1.73, "implement");
  assert.ok(v);
  assert.equal(v!.verdict, "failed");
  assert.equal(v!.ledger.reason, "worker error at implement: error_max_turns");
  assert.doesNotMatch(v!.ledger.reason, /error: success/);
});

test("workerErrorVerdict: error_max_budget_usd → blocked_budget, NOT retried, subtype recorded", () => {
  const r = result({ isError: true, subtype: "error_max_budget_usd", numTurns: 3, costUsd: 0.011 });
  const v = workerErrorVerdict(r, 0.011, "implement");
  assert.ok(v, "must produce a verdict");
  assert.equal(v.verdict, "blocked_budget");
  assert.equal(v.budgetBreach, true);
  assert.equal(v.ledger.subtype, "error_max_budget_usd");
  assert.match(v.ledger.reason, /not retried/i);
  // The ledger line must carry turns + cost — a failed run is never free.
  assert.equal(v.ledger.num_turns, 3);
  assert.equal(v.ledger.cost_usd, 0.011);
  assert.equal(v.ledger.billing_mode, "subscription");
});

// ── Budget = a RUNAWAY TRIPWIRE, not an allowance (MASTER-PLAN §9) ──────────

test("DEFAULT_BUDGET_USD is the tripwire default (100), an order of magnitude above observed work", () => {
  // Observed so far: hello-world $0.41 · reviewer $2.26 · gate-wiring $1.28 ·
  // containment ~$2.0 · W1-T3 still working at $3.57. 100 fires only on pathology.
  assert.equal(DEFAULT_BUDGET_USD, 100.0);
});

test("softBudgetWarning: WARNS ONCE at the soft threshold, then CONTINUES (never a kill)", () => {
  const threshold = 25;
  // Below the line: no warning.
  assert.equal(softBudgetWarning(3.57, threshold, false), false);
  // Crossing the line, not yet warned: warn now.
  assert.equal(softBudgetWarning(25, threshold, false), true);
  assert.equal(softBudgetWarning(40, threshold, false), true);
  // Already warned: never warn again (warn-once), even as cost keeps climbing.
  assert.equal(softBudgetWarning(40, threshold, true), false);
  assert.equal(softBudgetWarning(99, threshold, true), false);
});

test("the SOFT warning is independent of the HARD kill: crossing the soft line does NOT block", () => {
  // A soft-threshold crossing is only a visibility signal; the ONLY thing that
  // yields blocked_budget is the worker's error_max_budget_usd envelope (the hard
  // cap), which the run-loop maps via workerErrorVerdict — proven above. The soft
  // predicate returns a boolean to LOG, never a verdict.
  assert.equal(typeof softBudgetWarning(50, 25, false), "boolean");
  const notABreach = result({ isError: false, subtype: "success", costUsd: 50 });
  assert.equal(workerErrorVerdict(notABreach, 50, "implement"), null); // expensive ≠ blocked
});

test("workerErrorVerdict: error_max_turns → failed, still ledgers num_turns AND cost_usd", () => {
  const r = result({ isError: true, subtype: "error_max_turns", numTurns: 60, costUsd: 1.73 });
  const v = workerErrorVerdict(r, 1.73, "implement");
  assert.ok(v);
  assert.equal(v.verdict, "failed");
  assert.equal(v.budgetBreach, false);
  assert.equal(v.ledger.num_turns, 60, "a max-turns run's turn count must be ledgered");
  assert.equal(v.ledger.cost_usd, 1.73, "a max-turns run's spend must be ledgered");
});

test("workerErrorVerdict: cost passed by the caller (accumulated) wins over the single-worker cost", () => {
  // costUsd is the RUN's accumulated notional cost (recon + implement), not just
  // this worker's — the caller threads the running total in.
  const r = result({ isError: true, subtype: "error_during_execution", numTurns: 5, costUsd: 0.5 });
  const v = workerErrorVerdict(r, 0.9, "implement");
  assert.ok(v);
  assert.equal(v.verdict, "failed");
  assert.equal(v.ledger.cost_usd, 0.9);
});

// ── W1-T6: a failed worker call is never free OR untelemetered — its
// configured model/effort and its token usage survive onto the verdict ledger
// line too, not just the honest-ledger cost/turns (WS-1's original guarantee).

test("workerErrorVerdict: the ledger payload carries the failing call's model/effort/tokens", () => {
  const r = result({
    isError: true,
    subtype: "error_max_turns",
    numTurns: 60,
    costUsd: 1.73,
    model: "claude-opus-4",
    effort: "high",
    tokens: { input: 900, output: 100, cacheRead: 0, cacheCreation: 0 },
  });
  const v = workerErrorVerdict(r, 1.73, "implement");
  assert.ok(v);
  assert.equal(v.ledger.model, "claude-opus-4");
  assert.equal(v.ledger.effort, "high");
  assert.deepEqual(v.ledger.tokens, { input: 900, output: 100, cacheRead: 0, cacheCreation: 0 });
});

// ── checkPrOwnership: the run-ownership GUARD (W1-T62 backstop) ────────────
// Even if a future parse regression re-admits an evidence URL, a run can never
// merge-credit a PR whose branch it did not create — the guard is checked via an
// injected PrHeadGateway fixture, no `gh` exec, matching run W1-T54b-1784151420811
// where the attributed PR (#80) belonged to Dependabot, not this run.

test("checkPrOwnership: the claimed PR's head branch equals this run's own branch ⇒ null (proceed)", () => {
  const gateway = fakeGateway("run-W1-T62-123");
  const v = checkPrOwnership("https://github.com/acme/remudero/pull/91", "run-W1-T62-123", gateway, 1.5);
  assert.equal(v, null);
});

test("checkPrOwnership: mismatched headRefName ⇒ named pr_attribution_failed, NEVER merged, ledger records claimed-vs-owned", () => {
  // Modeled on W1-T54b-1784151420811: the claimed PR (#80) is Dependabot's own PR,
  // not this run's — the injected gateway reports Dependabot's actual head branch.
  const gateway = fakeGateway("dependabot/npm_and_yarn/anthropic-ai/claude-agent-sdk-0.3.209");
  const v = checkPrOwnership("https://github.com/acme/remudero/pull/80", "run-W1-T54b-1784151420811", gateway, 2.1);
  assert.ok(v, "a branch mismatch must produce a verdict, never a silent pass");
  assert.equal(v.verdict, "pr_attribution_failed");
  assert.notEqual(v.verdict, "merged");
  assert.equal(v.ledger.verdict, "pr_attribution_failed");
  assert.equal(v.ledger.claimed_url, "https://github.com/acme/remudero/pull/80");
  assert.equal(v.ledger.claimed_branch, "dependabot/npm_and_yarn/anthropic-ai/claude-agent-sdk-0.3.209");
  assert.equal(v.ledger.owned_branch, "run-W1-T54b-1784151420811");
  assert.equal(v.ledger.cost_usd, 2.1);
});

test("checkPrOwnership: an UNRESOLVABLE head ref (gateway failure) is NOT owned — fails closed, never assumed honest", () => {
  const gateway = fakeGateway(undefined);
  const v = checkPrOwnership("https://github.com/acme/remudero/pull/12", "run-W1-T99-1", gateway, 0);
  assert.ok(v);
  assert.equal(v.verdict, "pr_attribution_failed");
  assert.equal(v.ledger.claimed_branch, null);
  assert.match(v.ledger.reason, /could not be resolved/i);
});

// ── `rmd review --repo` targets a repo OTHER than the checkout (remudero-sandbox for the
// daemon's live commissioning). Without it the CLI was pinned to repoRoot's origin. ──
test("resolveReviewTarget: no flag ⇒ the checkout default; --repo overrides (bare name keeps owner; owner/name overrides both)", () => {
  const def = { owner: "craigoley", repo: "remudero" };
  assert.deepEqual(resolveReviewTarget(def, []), def);
  assert.deepEqual(resolveReviewTarget(def, ["--repo", "remudero-sandbox"]), { owner: "craigoley", repo: "remudero-sandbox" });
  assert.deepEqual(resolveReviewTarget(def, ["--repo", "other/box"]), { owner: "other", repo: "box" });
  assert.deepEqual(resolveReviewTarget(def, ["5", "--repo", "remudero-sandbox"]), { owner: "craigoley", repo: "remudero-sandbox" });
});

// ── BUG 1 (fix/cli-safe-control-surface): a spawning subcommand must FAIL LOUD on junk
// args, never silently drain. `rmd daemon install --dry-run` drained W1-T15 unattended. ──
test("unknownArgError: a bare positional (bogus subcommand) is rejected — the daemon-install hazard", () => {
  const err = unknownArgError("daemon", ["install", "--dry-run"], ["--max", "--poll-ms"], []);
  assert.ok(err, "an unexpected argument must produce an error");
  assert.match(err!, /unexpected argument 'install'/);
});

test("unknownArgError: an unknown --flag is rejected", () => {
  assert.match(unknownArgError("daemon", ["--dry-run"], ["--max", "--poll-ms"], [])!, /unexpected argument '--dry-run'/);
});

test("unknownArgError: recognized flags (value + bool) pass, returning null", () => {
  assert.equal(unknownArgError("daemon", ["--max", "5", "--poll-ms", "1000"], ["--max", "--poll-ms"], []), null);
  assert.equal(unknownArgError("drain", ["--until", "W1-T3", "--dry-run"], ["--until", "--max"], ["--dry-run"]), null);
  assert.equal(unknownArgError("drain", [], ["--until", "--max"], ["--dry-run"]), null);
});

// ── The daemon must target its repo EXPLICITLY and never silently drain its own source repo
// (fix/daemon-repo-targeting). resolveDaemonTarget is the pure resolver. ──
const dEnv = { selfOwner: "craigoley", selfRepo: "remudero", repoRoot: "/repo", reposDir: "/root/repos" };

test("resolveDaemonTarget: --repo remudero-sandbox targets the sandbox (gateway repo + plan from the clone)", () => {
  const r = resolveDaemonTarget(dEnv, ["--repo", "remudero-sandbox"]) as { target: any };
  assert.ok(r.target);
  assert.equal(r.target.repo, "remudero-sandbox");
  assert.equal(r.target.owner, "craigoley");
  assert.equal(r.target.isSelf, false);
  assert.equal(r.target.planPath, "/root/repos/remudero-sandbox/plan/tasks.yaml");
});

test("resolveDaemonTarget: bare `daemon` REFUSES to drain its own source repo unattended (no silent self-default)", () => {
  const r = resolveDaemonTarget(dEnv, []) as { error: string };
  assert.ok(r.error, "self-target without acknowledgement is an error");
  assert.match(r.error, /own source repo/i);
  assert.match(r.error, /remudero-sandbox/); // points the operator at the commissioning target
});

test("resolveDaemonTarget: --allow-self-target permits deliberate self-hosting; plan from the checkout", () => {
  const r = resolveDaemonTarget(dEnv, ["--allow-self-target"]) as { target: any };
  assert.ok(r.target);
  assert.equal(r.target.repo, "remudero");
  assert.equal(r.target.isSelf, true);
  assert.equal(r.target.planPath, "/repo/plan/tasks.yaml");
});

test("resolveDaemonTarget: --dry-run against self is allowed (harmless preview, spawns nothing)", () => {
  const r = resolveDaemonTarget(dEnv, ["--dry-run"]) as { target: any };
  assert.ok(r.target, "a dry-run self preview is not refused");
  assert.equal(r.target.dryRun, true);
  assert.equal(r.target.isSelf, true);
});

test("resolveDaemonTarget: --plan <path> overrides the plan source", () => {
  const r = resolveDaemonTarget(dEnv, ["--repo", "remudero-sandbox", "--plan", "/tmp/sbx.yaml"]) as { target: any };
  assert.equal(r.target.planPath, "/tmp/sbx.yaml");
});
