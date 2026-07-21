import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUDGET_USD,
  GitFetchError,
  checkPrOwnership,
  ciGateFromRollup,
  commitsAhead,
  deriveFixMode,
  deriveStrikeHistory,
  dispatchFixPreflightStandDown,
  drainCommand,
  FIX_MODE_RULES,
  isTransientResult,
  materializeReviewWorktree,
  renderFixPrompt,
  resolveReviewTarget,
  withMaterializedWorktree,
  resolveDaemonTarget,
  routeFix,
  runFixRung,
  syncPlanFromOrigin,
  syncPlanOrRefuse,
  unknownArgError,
  noPrVerdict,
  renderReconPrompt,
  softBudgetWarning,
  workerErrorVerdict,
  type FixDeps,
  type FixEvidence,
  type PrHeadGateway,
  type ReviewWorktreeDeps,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import { judgeReview } from "../src/lib/review.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { GitHub } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  strikeCapForAnswer,
  terminalStateReason,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
} from "../src/lib/sweep.js";
import type { Mount } from "../src/lib/mounts.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { worktreesDir } from "../src/lib/worker.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { loadPlanIndex, renderPlanIndex } from "../src/lib/plan-index.js";

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

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
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

// ── W1-T37: the plan is RETRIEVED, not injected — the recon prompt carries a PLAN INDEX, never the
// plan body (MASTER-PLAN §8A Tier 2). ────────────────────────────────────────────────────────────

test("renderReconPrompt: with an index block, the rendered prompt carries the fixed recon instructions THEN the index, verbatim", () => {
  const prompt = renderReconPrompt('PLAN INDEX — MASTER-PLAN.md is retrieved, not injected.\n- "Mission" (line 31): x');
  assert.match(prompt, /You are a RECON worker\. Do NOT modify anything\./);
  assert.match(prompt, /RECON REPORT/);
  assert.match(prompt, /PLAN INDEX — MASTER-PLAN\.md is retrieved, not injected\./);
  assert.match(prompt, /"Mission" \(line 31\): x/);
  // The recon instructions precede the index (stable-ish fixed text first).
  assert.ok(prompt.indexOf("RECON worker") < prompt.indexOf("PLAN INDEX"));
});

test("renderReconPrompt: an EMPTY index block (fresh checkout, before the first `npm run plan-index`) never crashes — just the fixed recon instructions", () => {
  const prompt = renderReconPrompt("");
  assert.match(prompt, /You are a RECON worker\./);
  assert.doesNotMatch(prompt, /PLAN INDEX/);
});

test("renderReconPrompt: the REAL committed plan/plan-index.json renders a prompt orders of magnitude smaller than MASTER-PLAN.md itself — the index is injected, the plan body is not", () => {
  const repoRoot = join(new URL("..", import.meta.url).pathname);
  const masterPlan = readFileSync(join(repoRoot, "MASTER-PLAN.md"), "utf8");
  const index = loadPlanIndex(join(repoRoot, "plan", "plan-index.json"));
  assert.ok(index, "plan/plan-index.json must exist and parse (run `npm run plan-index`)");
  const planIndexBlock = renderPlanIndex(index!);
  const prompt = renderReconPrompt(planIndexBlock);
  // Char-count proof: the rendered prompt is a small fraction of the full plan body's size.
  assert.ok(
    prompt.length < masterPlan.length / 10,
    `rendered recon prompt (${prompt.length} chars) should be well under 1/10th of MASTER-PLAN.md (${masterPlan.length} chars)`,
  );
  // The index carries the §4A heading (a grep target)...
  assert.match(prompt, /"4A\. Workspace containment \(fleet-wide\)"/);
  // ...but NOT the plan body prose that lives under it in MASTER-PLAN.md (a worker who needs it
  // must grep MASTER-PLAN.md itself, per the index's own instruction).
  assert.doesNotMatch(prompt, /Hooks <1s\. Craig overlay/);
});

test("wiring: the recon worker's spawn prompt is built via renderReconPrompt(planIndexBlock), not a hardcoded literal", () => {
  const reconIdx = runTaskSrc.indexOf('"recon worker"');
  const promptCallIdx = runTaskSrc.indexOf("prompt: renderReconPrompt(planIndexBlock)");
  assert.ok(reconIdx >= 0, "the recon worker section must exist");
  assert.ok(promptCallIdx > reconIdx, "the recon spawn must build its prompt via renderReconPrompt, after the recon worker say()");
});

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
  const v = noPrVerdict(
    result({ isError: false, subtype: "success", numTurns: 10, tokens: { input: 400, output: 40, cacheRead: 350, cacheCreation: 0 } }),
    5.05,
    "implement",
  );
  assert.equal(v.verdict, "no_pr");
  assert.equal(v.ledger.verdict, "no_pr");
  assert.equal(v.ledger.reason, "worker completed without opening a PR");
  assert.equal(v.ledger.subtype, "success");
  assert.equal(v.ledger.num_turns, 10);
  assert.equal(v.ledger.cost_usd, 5.05);
  // the exact incoherent string from run W1-T12a-1784117152056 must never appear:
  assert.doesNotMatch(v.ledger.reason, /error: success/);
  assert.doesNotMatch(v.ledger.reason, /worker error/);
  // W1-T35: cache tokens are ALSO ledgered as flat named columns on this line.
  assert.equal(v.ledger.cache_read_input_tokens, 350);
  assert.equal(v.ledger.cache_creation_input_tokens, 0);
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
    tokens: { input: 900, output: 100, cacheRead: 300, cacheCreation: 20 },
  });
  const v = workerErrorVerdict(r, 1.73, "implement");
  assert.ok(v);
  assert.equal(v.ledger.model, "claude-opus-4");
  assert.equal(v.ledger.effort, "high");
  assert.deepEqual(v.ledger.tokens, { input: 900, output: 100, cacheRead: 300, cacheCreation: 20 });
  // W1-T35: the same cache tokens are ALSO ledgered as flat named columns.
  assert.equal(v.ledger.cache_read_input_tokens, 300);
  assert.equal(v.ledger.cache_creation_input_tokens, 20);
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

// ── W1-T185 (Gap 2): `rmd review` materializes a worktree at the PR head so ──
// whitelisted proofs actually EXECUTE, mirroring the fix rung's own
// `git worktree add origin/<branch>` pattern (reuse, not new machinery).

test("ACCEPTANCE (criterion 4, unit slice): materializeReviewWorktree fetches then adds a worktree at origin/<headRefName>, returning a path under worktreesDir(config)", () => {
  const config = drainFixtureConfig();
  const calls: string[] = [];
  const deps: ReviewWorktreeDeps = {
    fetch: (repoDir) => calls.push(`fetch:${repoDir}`),
    addWorktree: (repoDir, worktreePath, branch) => calls.push(`add:${repoDir}:${worktreePath}:${branch}`),
  };
  const path = materializeReviewWorktree(config, "/repo", 411, "run-W1-T185-123", deps);
  assert.ok(path, "materialization reports success");
  assert.ok(path!.startsWith(join(config.root, "worktrees")), "path lives under worktreesDir(config)");
  assert.ok(path!.includes("review-PR411-"), "path is scoped to the PR number");
  assert.deepEqual(calls, [`fetch:/repo`, `add:/repo:${path}:run-W1-T185-123`]);
});

test("materializeReviewWorktree returns undefined (never throws) when fetch fails — network unavailable is a FALLBACK trigger, not a crash", () => {
  const config = drainFixtureConfig();
  const deps: ReviewWorktreeDeps = {
    fetch: () => {
      throw new Error("network unreachable");
    },
    addWorktree: () => assert.fail("addWorktree must not be reached when fetch already failed"),
  };
  assert.equal(materializeReviewWorktree(config, "/repo", 391, "some-branch", deps), undefined);
});

test("materializeReviewWorktree returns undefined (never throws) when the worktree add fails — a detached/deleted head is a FALLBACK trigger, not a crash", () => {
  const config = drainFixtureConfig();
  const deps: ReviewWorktreeDeps = {
    fetch: () => {},
    addWorktree: () => {
      throw new Error("fatal: invalid reference: origin/deleted-branch");
    },
  };
  assert.equal(materializeReviewWorktree(config, "/repo", 397, "deleted-branch", deps), undefined);
});

test("ACCEPTANCE (criterion 4, full chain): an operator-path review over a PR whose proofs are executable reports a NON-EMPTY executed set — materialize -> headCheckoutDir -> judgeReview EXECUTES, exactly the fix rung's own wiring for the same PR/proofs", () => {
  const config = drainFixtureConfig();
  // `addWorktree` here plays the role `git worktree add` + `checkout` really
  // does: it makes the PR head's CONTENT show up on disk at `worktreePath`.
  // Faking the git calls (never touching real git/network — this environment
  // has neither) while keeping the FILESYSTEM EFFECT real is what lets
  // `judgeReview`'s whitelisted executor genuinely run against it below.
  const deps: ReviewWorktreeDeps = {
    fetch: () => {},
    addWorktree: (_repoDir, worktreePath) => {
      mkdirSync(worktreePath, { recursive: true });
      writeFileSync(join(worktreePath, "fixture.txt"), "REMUDERO_W1_T185_MARKER\n");
    },
  };
  const worktreePath = materializeReviewWorktree(config, "/repo", 411, "run-W1-T185-fixture", deps);
  assert.ok(worktreePath, "materialization succeeded");
  try {
    const criteria = [
      { claim: "the marker is present", proof: "grep: REMUDERO_W1_T185_MARKER in fixture.txt" },
    ];
    const v = judgeReview(criteria, { diff: "", report: "unrelated", headCheckoutDir: worktreePath });
    // The SAME observed-execution outcome the fix rung records for a real PR
    // (#411's own criteria 2/4 recorded executed_fail on the SAME proofs a
    // keyword-only `rmd review` had read 0/N for) — here, executed_PASS,
    // because the marker genuinely IS on disk. Either way: EXECUTED, not
    // not_executable — the operator path is no longer keyword-only by
    // construction.
    assert.equal(v.criteria[0].proof_exec, "executed_pass");
    assert.equal(v.keywordOnly, false);
    assert.equal(v.capped, false);
  } finally {
    rmSync(worktreePath!, { recursive: true, force: true });
  }
});

// ── W1-T185 (Gap 2, criterion 6): a materialized worktree is torn down on ──
// EVERY exit path, including failure.

// W1-T185 acceptance criterion 6's own proof text (plan/tasks.yaml, verbatim
// from "unit test:" onward) IS this test's name — the mechanical floor's
// `unit test:` dialect name-filters the whole suite on exactly that text
// (parseTestTarget in src/lib/review.ts), so this criterion's own proof only
// counts as OBSERVED when a real test is titled to match it byte-for-byte
// (case-insensitive). See the identical note on criterion 1's renamed test in
// test/review.test.ts.
test("after a review that throws mid-execution, no worktree remains under the worktrees root. FALSIFIER: a teardown only on the success path reproduces the W1-T175 leak class, which exists precisely because run worktrees already strand on disk", async () => {
  const config = drainFixtureConfig();
  const worktreePath = join(worktreesDir(config), "review-PR411-fixture");
  mkdirSync(worktreePath, { recursive: true });
  assert.ok(existsSync(worktreePath), "sanity: the fixture worktree exists before the run");

  await assert.rejects(
    withMaterializedWorktree(
      worktreePath,
      "/repo",
      async () => {
        throw new Error("mid-execution failure");
      },
      (_repoDir, wt) => rmSync(wt, { recursive: true, force: true }),
    ),
    /mid-execution failure/,
  );

  assert.equal(existsSync(worktreePath), false, "the worktree was torn down despite the throw");
});

test("withMaterializedWorktree tears down on the SUCCESS path too, and returns body's result unmodified", async () => {
  const config = drainFixtureConfig();
  const worktreePath = join(worktreesDir(config), "review-PR418-fixture");
  mkdirSync(worktreePath, { recursive: true });

  const result = await withMaterializedWorktree(
    worktreePath,
    "/repo",
    async () => "verdict-shaped-result",
    (_repoDir, wt) => rmSync(wt, { recursive: true, force: true }),
  );

  assert.equal(result, "verdict-shaped-result");
  assert.equal(existsSync(worktreePath), false);
});

test("withMaterializedWorktree is a no-op finally when worktreePath is undefined (materialization never happened) — remove is never called", async () => {
  let removeCalled = false;
  const result = await withMaterializedWorktree(
    undefined,
    "/repo",
    async () => "keyword-only-result",
    () => {
      removeCalled = true;
    },
  );
  assert.equal(result, "keyword-only-result");
  assert.equal(removeCalled, false);
});

test("withMaterializedWorktree's teardown failure never masks body's own throw", async () => {
  await assert.rejects(
    withMaterializedWorktree(
      "/some/worktree",
      "/repo",
      async () => {
        throw new Error("the real failure");
      },
      () => {
        throw new Error("teardown also failed");
      },
    ),
    /the real failure/,
  );
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

// ── W1-T53 CRITERION 1 (BEHAVIORAL, injected-gateway): `rmd drain --repo` must scope the
// merged-status gateway to the NAMED repo, not the hardcoded "remudero" literal drainCommand
// used to carry (the same self-target hazard fix/daemon-repo-targeting already fixed for the
// daemon). This drives the REAL drainCommand dispatch path through injected seams
// (skipGitSync + githubFactory) — not a source grep — proving which (owner, repo) it actually
// builds its gateway for.

/** An offline GitHub gateway: projectPlan runs with zero network round-trips. */
const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function drainFixtureConfig(): Config {
  return { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-drain-gw-root-")) };
}

function drainFixturePlanPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-gw-plan-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // empty plan: refreshMerged still builds the gateway eagerly
  return planPath;
}

test("drainCommand: `--repo remudero-sandbox --dry-run` builds the merged-status gateway for remudero-sandbox, not 'remudero'", async () => {
  const calls: Array<{ owner: string; repo: string }> = [];
  const githubFactory = (owner: string, repo: string): GitHub => {
    calls.push({ owner, repo });
    return OFFLINE_GITHUB;
  };

  const code = await drainCommand(["--repo", "remudero-sandbox", "--dry-run"], {
    config: drainFixtureConfig(),
    planPath: drainFixturePlanPath(),
    skipGitSync: true, // fixture plan read literally, no git fetch (mirrors runTask's escape hatch)
    githubFactory,
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1, "the gateway is built exactly once for a --dry-run preview");
  assert.equal(calls[0].repo, "remudero-sandbox", "the gateway targets the --repo flag's value");
  assert.notEqual(calls[0].repo, "remudero", "never the hardcoded literal, regardless of --repo");
});

test("drainCommand: no --repo flag defaults the gateway to THIS checkout's own repo (not a hardcoded literal)", async () => {
  const calls: Array<{ owner: string; repo: string }> = [];
  const githubFactory = (owner: string, repo: string): GitHub => {
    calls.push({ owner, repo });
    return OFFLINE_GITHUB;
  };

  const code = await drainCommand(["--dry-run"], {
    config: drainFixtureConfig(),
    planPath: drainFixturePlanPath(),
    skipGitSync: true,
    githubFactory,
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  // This checkout's own origin is craigoley/remudero (see resolveOwnerRepo) — the default,
  // not an independent hardcoded literal that would silently diverge from it.
  assert.equal(calls[0].owner, "craigoley");
  assert.equal(calls[0].repo, "remudero");
});

// ── W1-T140: drain preview + curation panel — `--curated <path>` threading ─────────────────
// The curated dispatch mechanics themselves (order, unselected-never-dispatched, skip-merged/
// in-flight) are proven at the drain.ts level (test/drain.test.ts, over a runOne recorder, per
// this task's own acceptance bar). These tests prove the CLI EDGE: a malformed --curated input
// fails loud BEFORE any config/lock/spawn (the daemon-install hazard class), and a valid one
// actually reaches `runDrain` via `applyCuratedSelection` — proven through --dry-run's own
// curated-order rendering, since drainCommand has no injectable runOne for a live dispatch.

function drainChainPlanPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-curated-plan-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(
    planPath,
    [
      "- id: A",
      "  title: a",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "- id: B",
      "  title: b",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: [A]",
      "- id: C",
      "  title: c",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: [B]",
      "",
    ].join("\n"),
  );
  return planPath;
}

function curatedFile(dir: string, body: unknown): string {
  const p = join(dir, "curated.json");
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

test("drainCommand: --curated naming a missing file fails loud (exit 2) BEFORE any config/lock/spawn", async () => {
  const code = await drainCommand(["--curated", "/no/such/file.json", "--dry-run"], {
    config: drainFixtureConfig(),
    planPath: drainChainPlanPath(),
    skipGitSync: true,
    githubFactory: () => OFFLINE_GITHUB,
  });
  assert.equal(code, 2);
});

test("drainCommand: --curated naming a file that is not valid JSON fails loud (exit 2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-curated-bad-"));
  const badJsonPath = curatedFile(dir, "{ not json");
  const code = await drainCommand(["--curated", badJsonPath, "--dry-run"], {
    config: drainFixtureConfig(),
    planPath: drainChainPlanPath(),
    skipGitSync: true,
    githubFactory: () => OFFLINE_GITHUB,
  });
  assert.equal(code, 2);
});

test("drainCommand: --curated naming a JSON file with the wrong shape fails loud (exit 2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-curated-shape-"));
  const wrongShapePath = curatedFile(dir, { taskIds: "not-an-array", depth: 2 });
  const code = await drainCommand(["--curated", wrongShapePath, "--dry-run"], {
    config: drainFixtureConfig(),
    planPath: drainChainPlanPath(),
    skipGitSync: true,
    githubFactory: () => OFFLINE_GITHUB,
  });
  assert.equal(code, 2);
});

test("drainCommand: `--dry-run --curated <file>` previews EXACTLY the curated order, never the natural DAG order it overrides", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-drain-curated-ok-"));
  const selectionPath = curatedFile(dir, { taskIds: ["B", "A"], depth: 2 });
  const logSpy = t.mock.method(console, "log", () => {});

  const code = await drainCommand(["--curated", selectionPath, "--dry-run"], {
    config: drainFixtureConfig(),
    planPath: drainChainPlanPath(),
    skipGitSync: true,
    githubFactory: () => OFFLINE_GITHUB,
  });

  assert.equal(code, 0);
  const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printed, /--dry-run --curated/);
  assert.match(printed, /1\. B/);
  assert.match(printed, /2\. A/);
  assert.doesNotMatch(printed, /1\. A/, "the natural DAG order (A first) must NOT appear -- --curated overrides it entirely");
});

// ── W1-T60: the runner self-syncs git state — fetch origin + dispatch from origin/main,
// never the operator's working tree. Real, throwaway git repos (no mocking) so the
// fetch/show plumbing is genuinely exercised.

function planYaml(title: string): string {
  return `- id: T1\n  title: "${title}"\n  repo: remudero\n  type: implement\n`;
}

/** A tiny real "origin" repo + a real clone of it, both with a committed plan/tasks.yaml. */
function gitFixture(): { originDir: string; localDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-git-sync-"));
  const originDir = join(root, "origin");
  const localDir = join(root, "local");
  mkdirSync(join(originDir, "plan"), { recursive: true });
  const git = (dir: string, args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(originDir, ["init", "--quiet", "-b", "main"]);
  git(originDir, ["config", "user.email", "test@example.com"]);
  git(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("origin-title"), "utf8");
  git(originDir, ["add", "."]);
  git(originDir, ["commit", "--quiet", "-m", "init"]);
  execFileSync("git", ["clone", "--quiet", originDir, localDir], { encoding: "utf8" });
  git(localDir, ["config", "user.email", "test@example.com"]);
  git(localDir, ["config", "user.name", "Test"]);
  return { originDir, localDir };
}

test("syncPlanFromOrigin: dispatches from the origin/main BLOB (a real fetch), never a dirty local working tree", () => {
  const { originDir, localDir } = gitFixture();
  // Dirty, UNCOMMITTED local edit — must never win.
  writeFileSync(join(localDir, "plan", "tasks.yaml"), planYaml("DIRTY-LOCAL"), "utf8");
  // Publish a NEW commit on origin AFTER the clone — proves an actual fetch happens, not a
  // remote-tracking ref cached from clone time.
  writeFileSync(join(originDir, "plan", "tasks.yaml"), planYaml("PUBLISHED"), "utf8");
  execFileSync("git", ["add", "."], { cwd: originDir });
  execFileSync("git", ["commit", "--quiet", "-m", "update"], { cwd: originDir });

  const localMainBefore = execFileSync("git", ["-C", localDir, "rev-parse", "main"], { encoding: "utf8" }).trim();

  const { plan, staleDispatch } = syncPlanFromOrigin(localDir, "plan/tasks.yaml");

  assert.equal(staleDispatch, false);
  assert.equal(plan.tasks[0].title, "PUBLISHED");
  // The operator's dirty working-tree file survives untouched — never `git pull`/checkout.
  assert.equal(readFileSync(join(localDir, "plan", "tasks.yaml"), "utf8"), planYaml("DIRTY-LOCAL"));
  // `fetch` only moves the remote-tracking ref — the local `main` branch is never touched.
  const localMainAfter = execFileSync("git", ["-C", localDir, "rev-parse", "main"], { encoding: "utf8" }).trim();
  assert.equal(localMainAfter, localMainBefore);
});

// ── W1-T64: the retro no-op guard's predicate, BEHAVIORALLY (real git, both branches) ──────
// The retro (and implement) no-op path branches on `commitsAhead(worktreePath, "origin/main") === 0`:
// 0 commits ahead ⇒ the worker produced NOTHING, so retroCommand logs `retro.no_op` + worktreeRemove and
// NEVER calls `gh pr create` (a `--fill` on an empty branch throws); >= 1 commit ⇒ it still opens the PR.
// This exercises those two paths against a REAL repo, not a source grep — the behavioral gap #113 missed.
test("commitsAhead: a worktree with 0 commits ahead of origin/main returns 0 (the retro no-op path — never gh pr create)", () => {
  const { localDir } = gitFixture();
  // A fresh clone's HEAD == origin/main: nothing to PR. This is the empty-branch case the guard catches.
  assert.equal(commitsAhead(localDir, "origin/main"), 0);
});

test("commitsAhead: a worktree with >= 1 commit ahead of origin/main returns > 0 (the retro still opens the PR)", () => {
  const { localDir } = gitFixture();
  writeFileSync(join(localDir, "plan", "tasks.yaml"), planYaml("A-REAL-RETRO-EDIT"), "utf8");
  execFileSync("git", ["-C", localDir, "add", "."]);
  execFileSync("git", ["-C", localDir, "commit", "--quiet", "-m", "retro synthesized a real change"]);
  // One commit ahead of origin/main ⇒ there IS a diff, so the guard falls through to gh pr create.
  assert.equal(commitsAhead(localDir, "origin/main"), 1);
});

test("commitsAhead: an unreadable/absent base ref degrades to 0 (treated as nothing-to-PR, never a throw)", () => {
  const { localDir } = gitFixture();
  // A base that does not resolve must not crash the guard — it fails closed to the no-op (0), never throws.
  assert.equal(commitsAhead(localDir, "origin/no-such-branch"), 0);
});

test("syncPlanFromOrigin: a fetch failure FAILS CLOSED; --allow-stale proceeds on the last-fetched refs and reports staleDispatch", () => {
  const { localDir } = gitFixture();
  execFileSync("git", ["-C", localDir, "remote", "set-url", "origin", "/no/such/path"]);

  assert.throws(() => syncPlanFromOrigin(localDir, "plan/tasks.yaml"), GitFetchError);

  const { plan, staleDispatch } = syncPlanFromOrigin(localDir, "plan/tasks.yaml", { allowStale: true });
  assert.equal(staleDispatch, true);
  assert.equal(plan.tasks[0].title, "origin-title"); // the last-known (clone-time) origin/main
});

test("syncPlanFromOrigin: --allow-stale still fails closed when origin/main has never been resolved (nothing to fall back to)", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-git-sync-never-fetched-"));
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "/no/such/path"], { cwd: root });
  assert.throws(() => syncPlanFromOrigin(root, "plan/tasks.yaml", { allowStale: true }), GitFetchError);
});

test("syncPlanOrRefuse: a hard fetch failure ledgers a NAMED git_fetch_failed error and refuses (no plan, no spawn) unless allowStale", () => {
  const { localDir } = gitFixture();
  execFileSync("git", ["-C", localDir, "remote", "set-url", "origin", "/no/such/path"]);
  const planPath = join(localDir, "plan", "tasks.yaml");
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const said: string[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => logged.push({ step, extra });
  const say = (msg: string) => said.push(msg);

  const refused = syncPlanOrRefuse(planPath, { allowStale: false, log, say });
  assert.ok("error" in refused, "no plan is returned on a hard fetch failure");
  assert.ok(logged.some((l) => l.step === "git_fetch_failed"), "a NAMED ledger error is emitted");

  logged.length = 0;
  const proceeded = syncPlanOrRefuse(planPath, { allowStale: true, log, say }) as {
    plan: { tasks: Array<{ title: string }> };
    staleDispatch: boolean;
  };
  assert.equal("error" in proceeded, false);
  assert.equal(proceeded.staleDispatch, true);
  assert.ok(
    logged.some((l) => l.step === "git.stale_dispatch" && l.extra?.stale_dispatch === true),
    "stale_dispatch=true is ledgered when --allow-stale carries a run through a fetch failure",
  );
});

// ── W1-T76 (absorbs P21): the blocked_review FIX RUNG ───────────────────────
// GROUND TRUTH: a mounted reviewer posts FAILURE with specific unmet_criteria
// + reasons; the manual path used to leave the PR OPEN and drop them. A fresh
// re-run patched whichever criterion the LAST block named and dropped the
// other, ping-ponging forever across #111/#113. This rung dispatches ONE
// bounded fix worker per strike, ALWAYS the FULL unmet set at once, amending
// the SAME branch/PR — never a fresh PR, never a `fix/*` branch.

/** Build a minimal `CriterionVerdict`; only the fields the rung reads matter. */
function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

/** Build a `ReviewVerdict` (+ the runReview augmentation) from a criteria list. */
function fakeReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    headSha: "deadbeef",
    reviewerOutcome: "success",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

/** Shared, injectable base options for `runFixRung` — each test overrides `initialReview`/`strikeCap`/`deps`. */
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
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-")), "ledger.ndjson");
}

function fakeIssues(calls: Array<{ title: string; body: string; labels: string[] }>): IssueGateway {
  return {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/acme/remudero/issues/9";
    },
  };
}

test("renderFixPrompt: renders the FULL unmet set at once — both criteria + both reviewer reasons, never one at a time", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-TX", title: "Some task" },
    round: 1,
    branch: "run-W1-TX-1730000000000",
    evidence: {
      review: {
        unmetCriteria: [
          criterion({ claim: "criterion A merges cleanly", proof: "proof A", met: false, reason: "reason-A-missing" }),
          criterion({ claim: "criterion B has a test", proof: "proof B", met: false, reason: "reason-B-missing" }),
        ],
        summary: "remudero-review: FAIL — 2 criteria unmet",
      },
    },
  });
  assert.match(prompt, /criterion A merges cleanly/);
  assert.match(prompt, /reason-A-missing/);
  assert.match(prompt, /criterion B has a test/);
  assert.match(prompt, /reason-B-missing/);
  assert.match(prompt, /run-W1-TX-1730000000000/);
  assert.match(prompt, /do NOT open a new PR/i);
  assert.match(prompt, /fix\/\*/, "must explicitly warn off a fix/* branch — only a run-<taskId>-<epochMs> head is creditable");
  assert.match(prompt, /MODE: reviewer-unmet/, "the rendered prompt names its derived mode");
});

test("renderFixPrompt: a testTheater/noCriteria failure (EMPTY unmetCriteria) still carries the review's summary — never an empty, unexplained prompt", () => {
  // judgeReview can fail the overall state on testTheater/noCriteria alone,
  // even when every NAMED criterion is met — unmetCriteria is then empty, but
  // the fix worker must still learn WHY the gate is red.
  const prompt = renderFixPrompt({
    task: { id: "W1-TX", title: "Some task" },
    round: 1,
    branch: "run-W1-TX-1730000000000",
    evidence: {
      review: { unmetCriteria: [], summary: "remudero-review: FAIL — test theater detected (assertion-free tests)" },
    },
  });
  assert.match(prompt, /test theater detected/);
});

// ── W1-T94: the fix-rung failure-mode taxonomy — MODE derives deterministically
// from the block evidence (a table, never an if/else chain); the rendered
// prompt names its mode and carries ONLY that mode's inputs. ────────────────

test("deriveFixMode: a reviewer failure verdict + unmet set (no coverage-only reasons) derives reviewer-unmet", () => {
  const evidence: FixEvidence = {
    review: {
      unmetCriteria: [criterion({ claim: "criterion A", met: false, reason: "executed and failed: assertion mismatch" })],
      summary: "remudero-review: FAIL",
    },
  };
  assert.equal(deriveFixMode(evidence), "reviewer-unmet");
});

test("deriveFixMode: a 'matched N/M proof keywords' coverage reason with no executed_fail derives body-coverage", () => {
  const evidence: FixEvidence = {
    review: {
      unmetCriteria: [
        criterion({
          claim: "criterion A is documented",
          met: false,
          reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)",
        }),
      ],
      summary: "remudero-review: FAIL",
    },
  };
  assert.equal(deriveFixMode(evidence), "body-coverage");
});

test("deriveFixMode: an OBSERVED executed_fail is NEVER body-coverage, even alongside a keyword-coverage reason elsewhere — real code broke", () => {
  const evidence: FixEvidence = {
    review: {
      unmetCriteria: [
        criterion({
          claim: "criterion A is documented",
          met: false,
          reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)",
        }),
        criterion({ claim: "criterion B runs", met: false, reason: "executed and failed", proof_exec: "executed_fail" }),
      ],
      summary: "remudero-review: FAIL",
    },
  };
  assert.equal(deriveFixMode(evidence), "reviewer-unmet");
});

test("deriveFixMode: blocked_ci with no review verdict at all derives ci-log", () => {
  const evidence: FixEvidence = { ciFailures: [{ name: "ci", logTail: "tsc: error TS2322 …" }] };
  assert.equal(deriveFixMode(evidence), "ci-log");
});

test("renderFixPrompt: the three mode fixtures each render a mode-named prompt carrying ONLY that mode's inputs", () => {
  const reviewerUnmet = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: {
      review: {
        unmetCriteria: [criterion({ claim: "crit-reviewer", met: false, reason: "executed and failed" })],
        summary: "s",
      },
    },
  });
  assert.match(reviewerUnmet, /MODE: reviewer-unmet/);
  assert.match(reviewerUnmet, /crit-reviewer/);
  assert.doesNotMatch(reviewerUnmet, /PR BODY's Acceptance block/, "reviewer-unmet must not carry body-coverage's instruction");
  assert.doesNotMatch(reviewerUnmet, /making CI GREEN/, "reviewer-unmet must not carry ci-log's instruction");

  const bodyCoverage = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: {
      review: {
        unmetCriteria: [
          criterion({ claim: "crit-coverage", met: false, reason: "proof unmet (matched 4/12 proof keywords)" }),
        ],
        summary: "s",
      },
    },
  });
  assert.match(bodyCoverage, /MODE: body-coverage/);
  assert.match(bodyCoverage, /crit-coverage/);
  assert.match(bodyCoverage, /PR BODY's Acceptance block/i, "body-coverage states the body-first, code-only-if-false instruction");
  assert.match(bodyCoverage, /code ONLY if the body's claim would actually\s+be FALSE/i);
  assert.doesNotMatch(bodyCoverage, /making CI GREEN/, "body-coverage must not carry ci-log's instruction");

  const ciLog = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: { ciFailures: [{ name: "test", logTail: "AssertionError: expected 1 to equal 2" }] },
  });
  assert.match(ciLog, /MODE: ci-log/);
  assert.match(ciLog, /check: test/);
  assert.match(ciLog, /AssertionError: expected 1 to equal 2/);
  assert.match(ciLog, /making CI GREEN/i, "ci-log states the target is making CI green on the same branch");
  assert.doesNotMatch(ciLog, /PR BODY's Acceptance block/, "ci-log must not carry body-coverage's instruction");
  assert.doesNotMatch(ciLog, /crit-reviewer|crit-coverage/, "ci-log must not carry any review-mode criteria");
});

// Dedicated, narrowly-titled proof for the acceptance claim "body-coverage mode
// instructs body-first, code-only-if-false" (plan/tasks.yaml W1-T94) — the
// review floor's `unit test: <name>` house dialect name-filters the suite by
// this EXACT title text, so the title itself must contain the proof's phrase.
test("renderFixPrompt: the rendered body-coverage prompt contains the body-first instruction verbatim-class text", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: {
      review: {
        unmetCriteria: [criterion({ claim: "crit-coverage", met: false, reason: "proof unmet (matched 4/12 proof keywords)" })],
        summary: "s",
      },
    },
  });
  assert.match(prompt, /MODE: body-coverage/);
  assert.match(prompt, /PR BODY's Acceptance block/i, "the body-first instruction is present, verbatim-class");
  assert.match(prompt, /code ONLY if the body's claim would actually\s+be FALSE/i, "the code-only-if-false instruction is present, verbatim-class");
});

// Dedicated, narrowly-titled proof for the acceptance claim "modes are data"
// (plan/tasks.yaml W1-T94) — same name-filter reasoning as above: the title
// must contain the proof's exact phrase.
test("FIX_MODE_RULES: adding a table row for a new evidence shape derives the new mode with zero dispatch-code changes", () => {
  // Policy-as-data (rule 2), mirroring sweep.ts's DISPOSITION_RULES/policy param:
  // a caller-supplied rules table (never a code branch) picks the mode.
  const withDesignConformanceRow = [
    { mode: "design-conformance", when: (e: FixEvidence) => (e as { designNote?: string }).designNote === "off-design" },
    ...FIX_MODE_RULES,
  ];
  const evidence = {
    review: { unmetCriteria: [], summary: "s" }, // review present -> not the ci-log shape
    designNote: "off-design",
  } as unknown as FixEvidence;
  assert.equal(deriveFixMode(evidence, withDesignConformanceRow), "design-conformance");
  // The SAME evidence with the stock table (no new row) falls through to the
  // terminal reviewer-unmet default — proving the new mode came from the row,
  // not from any change inside deriveFixMode.
  assert.equal(deriveFixMode(evidence), "reviewer-unmet");
});

test("runFixRung: a seeded blocked_review with TWO unmet criteria dispatches ONE fix worker receiving BOTH + the reviewer reasons (P21's golden, verbatim)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [
    criterion({ claim: "criterion A merges cleanly", met: false, reason: "reason-A-missing" }),
    criterion({ claim: "criterion B has a test", met: false, reason: "reason-B-missing" }),
  ]);
  const passing = fakeReview("success", [
    criterion({ claim: "criterion A merges cleanly", met: true }),
    criterion({ claim: "criterion B has a test", met: true }),
  ]);
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 1, "exactly one fix worker spawn");
  assert.match(spawnCalls[0].prompt, /criterion A merges cleanly/);
  assert.match(spawnCalls[0].prompt, /reason-A-missing/);
  assert.match(spawnCalls[0].prompt, /criterion B has a test/);
  assert.match(spawnCalls[0].prompt, /reason-B-missing/);
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1);
  assert.equal(issueCalls.length, 0, "no escalation once the fix resolves the review");
});

test("runFixRung: the fix worker amends the SAME run branch — its spawn's cwd is the blocked run's own worktree, never a fresh checkout", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })]);
  const pushCalls: Array<[string, string]> = [];
  const base = fixRungBaseOpts();

  await runFixRung({
    ...base,
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => passing,
      push: (wt, br) => pushCalls.push([wt, br]),
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls[0].cwd, base.worktreePath, "the fix worker's cwd is THIS run's own worktree");
  assert.deepEqual(pushCalls[0], [base.worktreePath, base.branch], "the fix rung pushes the SAME branch — never opens a fresh PR");
});

test("runFixRung: strike 1 RESUMES the failing implement session; strike 2 is a FRESH worker on the SAME branch — never resumed twice", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })]);
  let reviewCalls = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => {
        reviewCalls++;
        return reviewCalls === 1 ? failing : passing; // still broken after strike 1, fixed after strike 2
      },
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[0].resumeSessionId, "session-0", "strike 1 resumes the ORIGINAL failing implement session");
  assert.equal(spawnCalls[1].resumeSessionId, undefined, "strike 2 is a FRESH worker — never resumed a second time");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 2);
});

test("runFixRung: a second block after N strikes escalates rather than looping (P21's golden, verbatim) — no third spawn", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const stillFailing = fakeReview("failure", [
    criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" }),
  ]);
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ledgerPath = tmpLedgerPath();

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: stillFailing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => stillFailing, // never resolves
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath,
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 2, "exactly strikeCap spawns — NEVER a third");
  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.strikes, 2);
  assert.equal(issueCalls.length, 1, "escalate() is invoked exactly once on exhaustion");
  assert.ok(issueCalls[0].labels.includes("escalation-blocked"), "the BLOCKED escalation class label is applied");
  assert.match(issueCalls[0].body, /criterion A merges cleanly/);
  assert.match(issueCalls[0].body, /still broken/);
  const ledgerLines = readFileSync(ledgerPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(
    ledgerLines.some((l) => l.step === "escalation.issue_opened"),
    "the ledger records exhaustion via the SAME escalation.issue_opened line escalate.ts already emits",
  );
});

test("runFixRung: a CI regression after a fix attempt does not stall the rung — it is treated as still-failing and consumes the next strike", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })]);
  let ciCalls = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => {
        ciCalls++;
        return ciCalls === 1 ? "red" : "green"; // strike 1's fix regresses CI; strike 2 is clean
      },
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 2, "the non-green CI strike still counts — the rung tries again, bounded by strikeCap");
  assert.equal(outcome.outcome, "fixed");
});

// ── W1-T102 (the #177/#178 fix): a body-only strike (e.g. a `gh pr edit` with
// NO new commit) never changes the head sha, so `remudero-review`'s own
// PREVIOUS FAILURE status is still pinned to that sha the next time the ci
// gate polls. `waitForCiGreen`'s scan used to treat ANY red rollup entry —
// including that self-posted, now-stale status — as a reason to skip
// re-review, so the rung exhausted every strike against its OWN pinned
// verdict and never re-judged a fix that had actually already succeeded.
// `ciGateFromRollup` is the extracted, gh-free predicate this bug lived in —
// unit-testable directly against rollup fixtures, no `gh` process needed. ──

test("ciGateFromRollup: a stale remudero-review FAILURE pinned to an unchanged head sha does not veto a green ci check (the #177 stale-status exhaustion)", () => {
  const rollup = [
    { name: "ci", conclusion: "SUCCESS" },
    { name: "remudero-review", conclusion: "FAILURE" }, // the PREVIOUS strike's now-stale verdict
  ];
  assert.equal(ciGateFromRollup(rollup), "green");
});

test("ciGateFromRollup: a genuinely red OTHER check still gates red — a real code-push regression is never masked", () => {
  const rollup = [
    { name: "ci", conclusion: "SUCCESS" },
    { name: "test", conclusion: "FAILURE" }, // an actual required check, not remudero-review
  ];
  assert.equal(ciGateFromRollup(rollup), "red");
});

test("ciGateFromRollup: remudero-review alone (ci not reported yet) is pending, never green — a stale status excluded is not the same as a pass", () => {
  const rollup = [{ name: "remudero-review", conclusion: "FAILURE" }];
  assert.equal(ciGateFromRollup(rollup), "pending");
});

test("runFixRung: a stale failing verdict heals in ONE strike once the body edit satisfies the criteria — fresh PASS, no escalation (the #177 fixture)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  // The stale, pinned verdict this rung was seeded with — mirrors the live
  // incident's 7/28-unmet shape (only the count/shape matters here, not 7/28
  // exactly): a real, failing verdict from BEFORE the body-only fix landed.
  const staleFailing = fakeReview("failure", [
    criterion({ claim: "criterion A is documented in the PR body", met: false, reason: "proof unmet (matched 4/12 proof keywords)" }),
  ]);
  const freshPassing = fakeReview("success", [
    criterion({ claim: "criterion A is documented in the PR body", met: true }),
  ]);
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: staleFailing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      // Post-fix, the real ci gate correctly reports green for a body-only
      // strike (the stale remudero-review status no longer vetoes it) —
      // this is what unblocks the re-judge below.
      waitForCiGreen: async () => "green",
      runReview: async () => freshPassing,
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1, "the rung resolves after the ONE strike whose fresh re-judge passes");
  assert.equal(spawnCalls.length, 1);
  assert.equal(issueCalls.length, 0, "no escalation — the fresh verdict is a PASS, never the stale one");
});

// ── W1-T100 (the #170 fix): route blocked_ci to the ci-log fix path — fix
// FIRST, ask after exhaustion. The intent-wiring W1-T93/W1-T94 left as a seam
// (a checks-red/review-none PR carried NO reviewer unmet-criteria at all, so
// the rung's ONE prompt shape had nothing to render for it) is closed here:
// `runFixRung` itself must derive ci-log evidence, not just deriveFixMode. ──

test("runFixRung: a seeded blocked_ci (ciFailures, no review posted yet) dispatches ONE fix worker in ci-log mode, carrying failing check names + log tails, not reviewer criteria (W1-T100, the #170 fix)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []); // blocked_ci's own placeholder — no reviewer verdict exists yet
  const passing = fakeReview("success", []);
  const ciFailures = [{ name: "test", logTail: "AssertionError: expected 1 to equal 2" }];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 1, "exactly one fix worker spawn");
  assert.match(spawnCalls[0].prompt, /MODE: ci-log/, "the rendered prompt names ci-log mode");
  assert.match(spawnCalls[0].prompt, /check: test/);
  assert.match(spawnCalls[0].prompt, /AssertionError: expected 1 to equal 2/, "the failing check's log tail rides the prompt");
  assert.doesNotMatch(spawnCalls[0].prompt, /UNMET acceptance criterion/i, "never reviewer-mode criteria — blocked_ci has none");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1);
});

test("runFixRung: once CI goes green and a real review posts (even a failing one), the NEXT strike reverts to reviewer-unmet mode — never ci-log again", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const stillFailingReview = fakeReview("failure", [
    criterion({ claim: "criterion A merges cleanly", met: false, reason: "executed and failed" }),
  ]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })]);
  let reviewCalls = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures: [{ name: "ci", logTail: "tsc: error TS2322" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => {
        reviewCalls++;
        return reviewCalls === 1 ? stillFailingReview : passing;
      },
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 2);
  assert.match(spawnCalls[0].prompt, /MODE: ci-log/, "strike 1: no review has run yet");
  assert.match(spawnCalls[1].prompt, /MODE: reviewer-unmet/, "strike 2: a real (failing) review now exists — never ci-log again");
  assert.match(spawnCalls[1].prompt, /criterion A merges cleanly/);
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 2);
});

test("runFixRung: a blocked_ci dispatch that exhausts its strikes without CI EVER going green escalates naming the failing checks, never an empty/misleading 'Unmet criteria:' list", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ciFailures = [{ name: "typecheck", logTail: "tsc: error TS2322" }];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    ciFailures,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red", // CI never goes green — no review is ever reached
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

  assert.equal(spawnCalls.length, 2, "exactly strikeCap ci-log spawns");
  assert.equal(outcome.outcome, "escalated");
  assert.equal(issueCalls.length, 1);
  assert.match(issueCalls[0].title, /blocked_ci/, "the escalation names blocked_ci, not blocked_review");
  assert.match(issueCalls[0].body, /Failing check\(s\)/);
  assert.match(issueCalls[0].body, /typecheck/, "the failing check name is carried");
  assert.doesNotMatch(issueCalls[0].body, /Unmet criteria:/, "never the review-mode framing for a dispatch that never had a review");
});

// ── W1-T138 (the #303/#305/#292/#315 fix): a fix-rung strike that started in
// reviewer-unmet mode but whose OWN push leaves a required check red (the
// strike's commit broke commitlint/CodeQL, or a required check was already
// red and the review verdict beside it is now stale) must route the NEXT
// strike to ci-log mode against the check that is ACTUALLY still failing —
// never keep re-dispatching the same stale review criteria while the real
// merge-blocker sits untouched. Before this fix `noReviewYet` only ever went
// false, never back to true, so every remaining strike stayed reviewer-unmet
// no matter what CI did. ──────────────────────────────────────────────────

test("runFixRung: a strike whose OWN push leaves a required check red routes the NEXT strike to ci-log mode against the check that is ACTUALLY still failing, not the stale review criteria (the #303/#305 fix)", async () => {
  const prompts: string[] = [];
  const modes: unknown[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const commitlintFailure = { name: "commitlint", logTail: "header-max-length: 108 chars exceeds the 100 cap" };

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing, // strike 1 starts in reviewer-unmet mode — no ciFailures at dispatch time
    deps: {
      spawn: async (args) => {
        prompts.push(args.prompt);
        return result({ sessionId: `fix-session-${prompts.length}` });
      },
      // Strike 1's fix pushes a commit that breaks commitlint — CI never
      // reaches green, so no fresh review can run for strike 2 either.
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [commitlintFailure],
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => {
        if (step === "fix.dispatch") modes.push(extra?.mode);
      },
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(prompts.length, 2, "strikeCap spawns — the rung never stalls");
  assert.equal(outcome.outcome, "escalated", "CI never went green — strikes exhaust");

  // Strike 1: reviewer-unmet, carrying the ORIGINAL criterion (checks were
  // GREEN at dispatch time — no ciFailures were seeded).
  assert.equal(modes[0], "reviewer-unmet");
  assert.match(prompts[0], /MODE: reviewer-unmet/);
  assert.match(prompts[0], /criterion A merges cleanly/);

  // Strike 2: the strike's OWN push left commitlint red — the NEXT strike
  // must target THAT check, never re-litigate strike 1's (now-stale) criterion.
  assert.equal(modes[1], "ci-log");
  assert.match(prompts[1], /MODE: ci-log/);
  assert.match(prompts[1], /commitlint/);
  assert.match(prompts[1], /header-max-length: 108 chars exceeds the 100 cap/);
  assert.doesNotMatch(
    prompts[1],
    /criterion A merges cleanly/,
    "strike 2 must NOT re-dispatch the stale review criterion — the real blocker is the red check",
  );
});

test("runFixRung: the same mid-rung regression escalates naming the SPECIFIC check + finding, never the generic 'blocked_review fix rung exhausted' framing (the #292/#315 fix)", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const codeqlFailure = {
    name: "CodeQL",
    logTail: "js/incomplete-url-substring-sanitization @ test/worker.test.ts:318 — Incomplete URL substring sanitization",
  };
  let call = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-session" }),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => {
        call++;
        // Strike 1's push introduces the CodeQL finding; it is still unresolved
        // going into strike 2 — the SAME finding, fetched fresh each time.
        return [codeqlFailure];
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

  assert.equal(call, 2, "the failing checks are refreshed on every non-green strike");
  assert.equal(outcome.outcome, "escalated");
  assert.equal(issueCalls.length, 1);
  assert.match(issueCalls[0].title, /blocked_ci/, "names blocked_ci, never 'blocked_review fix rung exhausted'");
  assert.doesNotMatch(issueCalls[0].title, /blocked_review/);
  assert.match(
    issueCalls[0].body,
    /CodeQL — js\/incomplete-url-substring-sanitization @ test\/worker\.test\.ts:318/,
    "the escalation names the SPECIFIC check + finding, not just the bare check name",
  );
  assert.doesNotMatch(issueCalls[0].body, /Unmet criteria:/, "never the stale review-mode framing once ci-log took over");
});

test("runFixRung: fetchCiFailures is optional — a strike that goes non-green still corrects its MODE even when the caller cannot refresh failing-check content", async () => {
  const modes: unknown[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-session" }),
      waitForCiGreen: async () => "red",
      // fetchCiFailures deliberately omitted.
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => {
        if (step === "fix.dispatch") modes.push(extra?.mode);
      },
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(modes[0], "reviewer-unmet");
  assert.equal(modes[1], "ci-log", "the mode still corrects itself without a fetchCiFailures dep — content just stays unrefreshed");
});

// ── W1-T177: TERMINAL-STATE CHECK AT EVERY SPENDING SITE — the fix rung's own
// two internal checks (top of round; immediately before the exhaustion
// escalate()). FIXTURE: PR #388 merged at 20:24:44Z; fix.dispatch strike 2
// still fired at 20:25:04, fix.done at 20:29:05 (cost_usd 1.2405, 38 turns),
// then a needs-human issue at 20:30:48 — a strike AND an escalation spent on
// an already-merged PR. ─────────────────────────────────────────────────────

test("runFixRung: a seeded MERGED PR produces ZERO fix-rung strikes — no strike is spent, no worker spawned (the #388 falsifier)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const stoodDown: unknown[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => {
        throw new Error("runReview must never be called — the rung must stand down before dispatching a strike");
      },
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => {
        if (step === "fix.stood_down") stoodDown.push(extra);
      },
      say: () => {},
      account: (r) => r,
      // Round 1's live read is already MERGED — the #388 fixture's exact shape
      // (merged BEFORE the rung's first check this round, not mid-round).
      readLiveState: async () => ({ ok: true, state: "MERGED" }),
    },
  });

  assert.equal(spawnCalls.length, 0, "zero fix worker spawns — no strike is SPENT on a merged PR");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 0, "strikes never incremented — the check runs BEFORE strikes++");
  assert.match(outcome.standDownReason ?? "", /MERGED/);
  assert.equal(stoodDown.length, 1, "exactly one fix.stood_down ledger line, naming the site and the state");
  assert.deepEqual(stoodDown[0], { site: "rung.strike", strike: 1, reason: outcome.standDownReason });
});

test("runFixRung: a PR that goes MERGED mid-rung (after round 1's strike, before the exhaustion escalate()) stands down rather than filing a needs-human issue", async () => {
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  let reads = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1, // one strike, then straight to the exhaustion check
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-session-1" }),
      waitForCiGreen: async () => "green",
      runReview: async () => failing, // still failing — heads toward exhaustion
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      // Round 1's PRE-STRIKE read is still OPEN (the strike is legitimately
      // spent); the PR merges by the time the exhaustion check runs.
      readLiveState: async () => {
        reads++;
        return reads === 1 ? { ok: true, state: "OPEN" } : { ok: true, state: "MERGED" };
      },
    },
  });

  assert.equal(outcome.outcome, "stood_down");
  assert.match(outcome.standDownReason ?? "", /MERGED/);
  assert.equal(issueCalls.length, 0, "zero needs-human issues opened on a PR that no longer carries a live block");
});

test("runFixRung: a FAILED/INDETERMINATE read at the EXHAUSTION check (site ii) does NOT stand down — the needs-human issue still files as before, AND the indeterminate read is ledgered distinctly from site (i)'s", async () => {
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const indeterminateLogs: unknown[] = [];
  let reads = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-session-1" }),
      waitForCiGreen: async () => "green",
      runReview: async () => failing,
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => {
        if (step === "fix.live_state_indeterminate") indeterminateLogs.push(extra);
      },
      say: () => {},
      account: (r) => r,
      // Round 1's PRE-STRIKE read (site i) succeeds OPEN; the EXHAUSTION
      // check (site ii) hits a genuine read failure.
      readLiveState: async () => {
        reads++;
        return reads === 1 ? { ok: true, state: "OPEN" } : { ok: false };
      },
    },
  });

  assert.equal(outcome.outcome, "escalated", "an unreadable state at the exhaustion check must NOT stand down — escalation proceeds exactly as today");
  assert.equal(issueCalls.length, 1, "the needs-human issue still files — a read failure is never treated as terminal");
  assert.equal(indeterminateLogs.length, 1, "site (ii)'s indeterminate read is ledgered exactly once");
  assert.deepEqual(indeterminateLogs[0], { site: "rung.exhaustion" });
});

test("runFixRung: readLiveState omitted ⇒ behaves EXACTLY as before this check existed — the rung dispatches normally", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })]);

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      // readLiveState deliberately omitted.
    },
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(outcome.outcome, "fixed");
});

test("runFixRung: a FAILED/INDETERMINATE live-state read does NOT stand down — it proceeds exactly as today (fail OPEN, never fail-closed-to-stand-down) — AND the indeterminate read is ledgered, never a silent swallow", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })]);
  const indeterminateLogs: unknown[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => {
        if (step === "fix.live_state_indeterminate") indeterminateLogs.push(extra);
      },
      say: () => {},
      account: (r) => r,
      // A genuine read failure (rate-limited/network/auth) — ok:false.
      readLiveState: async () => ({ ok: false }),
    },
  });

  assert.equal(spawnCalls.length, 1, "the strike still fires — an unreadable state is never treated as terminal");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(indeterminateLogs.length, 1, "the failed/indeterminate read is LEDGERED — never a silent swallow");
  assert.deepEqual(indeterminateLogs[0], { site: "rung.strike" });
});

// ── Round-2 fix, W1-T177 SITE (v): the cold/sweep `dispatchFix` pre-flight
// previously folded its terminal-state read into the SAME `gh pr view` round
// trip it also used to resolve `headRefName` — so a read failure there threw
// straight past the `ok:false` fail-open branch entirely (it never got to run)
// and the caller's own outer try/catch logged `sweep.fix.error` with NO
// dispatch — a silent fail-CLOSED-to-stand-down on a `gh` hiccup, exactly the
// falsifier the reviewer's proof harness seeded. `dispatchFixPreflightStandDown`
// is now the ONE place this site's read happens, decoupled from the
// headRefName fetch, so it is unit-testable in isolation with a fake
// `readLiveState` that never throws (mirroring sites i/ii's `LiveStateResult`
// contract) — proving the SAME fail-open behavior every other site already had. ──

test("dispatchFixPreflightStandDown: a seeded state-read ERROR (ok:false) does NOT stand down — proceeds exactly as today, AND ledgers the indeterminate read via sweep.fix.indeterminate, never treating unreadable as terminal", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const reason = await dispatchFixPreflightStandDown(
    async () => ({ ok: false }), // a genuine gh outage/rate-limit/auth failure
    { prUrl: "https://github.com/o/r/pull/9", prNumber: 9 },
    (step, extra) => logs.push({ step, extra }),
  );

  assert.equal(reason, undefined, "an unreadable state must NEVER stand the dispatch down — it must proceed exactly as before this check existed");
  const indeterminate = logs.filter((l) => l.step === "sweep.fix.indeterminate");
  assert.equal(indeterminate.length, 1, "the failed/indeterminate read is LEDGERED — never a silent swallow");
  assert.deepEqual(indeterminate[0].extra, { pr_number: 9 });
  assert.equal(logs.some((l) => l.step === "sweep.fix.not_open"), false, "an indeterminate read must never ALSO log a terminal stand-down");
});

for (const terminalState of ["MERGED", "CLOSED"]) {
  test(`dispatchFixPreflightStandDown: a seeded ${terminalState} PR stands down naming the state via sweep.fix.not_open — the SAME terminalStateReason predicate every other site shares`, async () => {
    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

    const reason = await dispatchFixPreflightStandDown(
      async () => ({ ok: true, state: terminalState }),
      { prUrl: "https://github.com/o/r/pull/9", prNumber: 9 },
      (step, extra) => logs.push({ step, extra }),
    );

    const expected = terminalStateReason(terminalState);
    assert.equal(reason, expected, "the stand-down reason must come from the ONE shared predicate, not a re-derived copy");
    const notOpen = logs.filter((l) => l.step === "sweep.fix.not_open");
    assert.equal(notOpen.length, 1);
    assert.deepEqual(notOpen[0].extra, { pr_number: 9, state: terminalState, reason: expected });
  });
}

test("dispatchFixPreflightStandDown: a live OPEN read does NOT stand down and logs nothing — dispatch proceeds to resolve headRefName exactly as today", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const reason = await dispatchFixPreflightStandDown(
    async () => ({ ok: true, state: "OPEN" }),
    { prUrl: "https://github.com/o/r/pull/9", prNumber: 9 },
    (step, extra) => logs.push({ step, extra }),
  );

  assert.equal(reason, undefined);
  assert.equal(logs.length, 0, "an OPEN PR is the ordinary path — it must not ledger anything at this preflight");
});

// ── Wiring: ONE call site, both entry points (drain + manual `rmd run-task`
// both call the SAME `runTask`, so there is exactly one place to gate) ──────

test("runFixRung is REUSED, never reimplemented — one dispatch from runTask's blocked_review branch, one from the W1-T77 sweep real-wiring; no duplicated fix-dispatch logic", () => {
  const dispatchSites = runTaskSrc.match(/await runFixRung\(/g) ?? [];
  // Two CALL sites, ONE implementation: (1) runTask's blocked_review branch (the
  // live-run path — drain + manual `rmd run-task` both reach it via the SAME
  // runTask), and (2) the W1-T77 level-triggered sweep's real wiring, which
  // reconciles a PR discovered COLD by REUSING runFixRung (the sanctioned design:
  // "only CALL it, NOT reimplement"). Neither duplicates the rung's logic.
  assert.equal(dispatchSites.length, 2, "runFixRung must be REUSED (called), never reimplemented");
  // runTask itself is defined exactly once — the drain path (runOne) and the
  // manual CLI path both call this SAME function, so the one dispatch site
  // above already covers both entry points; grep confirms no second runTask.
  const runTaskDefs = runTaskSrc.match(/^async function runTask\(/gm) ?? [];
  assert.equal(runTaskDefs.length, 1, "there must be exactly one runTask implementation for both callers to share");
});

// ── W1-T192: the draft rung runs DAEMON-SIDE, not CLI-pull ─────────────────────────────────
//
// The decision logic (which proposals are due, the idempotence throttle, the fail-soft
// per-proposal draft loop) is pure and unit-tested exhaustively over fixtures in
// test/inbox.test.ts, with the LLM stubbed out entirely — mirroring how this file already
// treats runFixRung above. What ONLY belongs here is WIRING: is the rung actually reachable
// from the daemon's own `deps.sweep()` seam (daemon.ts:274), not merely from `rmd inbox`?
// That is a real regression risk this codebase already tests via source-text reachability
// (see `runFixRung is REUSED...` above), so the same technique applies here.

/** Extract one top-level `function`/`async function` declaration's source text, from its
 *  signature to the start of the NEXT top-level function declaration (or EOF) — good enough
 *  for a reachability grep; this file has no nested top-level function of the same shape. */
function extractFunctionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected to find '${signature}' in run-task.ts`);
  const nextFn = src.indexOf("\nfunction ", start + 1);
  const nextAsyncFn = src.indexOf("\nasync function ", start + 1);
  const nextExportAsyncFn = src.indexOf("\nexport async function ", start + 1);
  const boundaries = [nextFn, nextAsyncFn, nextExportAsyncFn].filter((i) => i > start);
  const end = boundaries.length ? Math.min(...boundaries) : src.length;
  return src.slice(start, end);
}

test("W1-T192: buildSweepHook (the daemon's OWN deps.sweep() wiring) reaches the draft rung — the rung is on the DAEMON path, not only inboxCommand", () => {
  const sweepHookBody = extractFunctionBody(runTaskSrc, "function buildSweepHook(");
  assert.match(
    sweepHookBody,
    /buildInboxDraftHook/,
    "buildSweepHook must invoke the W1-T192 draft rung — riding the SAME seam the W1-T150 " +
      "credit-backfill rung already occupies. A rung added to the CLI path alone would " +
      "silently never run unattended (the exact defect this task fixes).",
  );
});

test("W1-T192: `rmd inbox` (inboxCommand) and the daemon's draft rung (buildInboxDraftHook) both drive the SAME draftProposalBatch — one shared drafting loop, never two divergent ones", () => {
  const inboxBody = extractFunctionBody(runTaskSrc, "async function inboxCommand(");
  assert.match(inboxBody, /draftProposalBatch\(/, "inboxCommand must call the shared draftProposalBatch");

  const hookBody = extractFunctionBody(runTaskSrc, "function buildInboxDraftHook(");
  assert.match(hookBody, /draftProposalBatch\(/, "buildInboxDraftHook must call the SAME draftProposalBatch, never a re-derived spawn loop");
});

test("W1-T192: buildInboxDraftHook is wrapped in its own try/catch, distinct from buildSweepHook's — a draft-rung hiccup never halts the sweep or the daemon", () => {
  const hookBody = extractFunctionBody(runTaskSrc, "function buildInboxDraftHook(");
  assert.match(hookBody, /try\s*\{/, "the hook must guard its own body");
  assert.match(hookBody, /catch \(e\)/);
  assert.match(hookBody, /inbox\.draft_rung\.error/, "a failure is ledgered under its own step, not silently swallowed");
});

test("W1-T192: `rmd inbox`'s drafting predicate (proposalsNeedingDraft) is UNTHROTTLED — it never consults the daemon-only DraftAttemptCache, preserving the manual-force contract", () => {
  const inboxBody = extractFunctionBody(runTaskSrc, "async function inboxCommand(");
  assert.match(inboxBody, /proposalsNeedingDraft\(/, "inboxCommand must select drafting candidates via the unthrottled predicate");
  assert.doesNotMatch(
    inboxBody,
    /draftsDueOnDaemon/,
    "inboxCommand must NOT apply the daemon's idempotence throttle — a human forcing a redraft must never be silently no-op'd",
  );
});

// ── W1-T78: the CLARIFICATION-QUESTION rung's fix-rung side — an operator's
// answer re-arms `runFixRung` carrying the answer as an added constraint,
// VERBATIM, on every strike; the strike allowance is config policy. ──────────

test("renderFixPrompt: an operator's clarification answer (evidence.constraint) is carried VERBATIM, mode-agnostic, ahead of the mode-specific content", () => {
  const withConstraint = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: {
      review: { unmetCriteria: [criterion({ claim: "crit-A", met: false, reason: "still broken" })], summary: "s" },
      constraint: "use approach X — the reviewer's real requirement is Y, not Z",
    },
  });
  assert.match(withConstraint, /use approach X — the reviewer's real requirement is Y, not Z/);
  assert.match(withConstraint, /OPERATOR CONSTRAINT/i);

  // Absent for an ORIGINAL dispatch (no constraint) — never a spurious block.
  const withoutConstraint = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: { review: { unmetCriteria: [criterion({ claim: "crit-A", met: false, reason: "still broken" })], summary: "s" } },
  });
  assert.doesNotMatch(withoutConstraint, /OPERATOR CONSTRAINT/i);
});

test("runFixRung: an operator's answer is threaded as an added constraint on EVERY strike's prompt, verbatim; the re-dispatch's strike cap is set per config policy (strikeCapForAnswer)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const stillFailing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })]);
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const answer = "the reviewer wants a unit test, not an integration test — add one at test/foo.test.ts";

  // resetStrikeCounterOnAnswer=false -> exactly ONE bounded strike (policy-as-data, W1-T78).
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: strikeCapForAnswer(2, { resetStrikeCounterOnAnswer: false }),
    initialReview: stillFailing,
    constraint: answer,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => stillFailing, // still broken — proves the cap, not luck
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 1, "resetStrikeCounterOnAnswer=false grants exactly ONE strike");
  assert.match(spawnCalls[0].prompt, new RegExp(answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the answer is carried VERBATIM");
  assert.equal(outcome.outcome, "escalated", "the one bounded strike failing still escalates — never loops forever");
  assert.equal(outcome.strikes, 1);
  assert.equal(issueCalls.length, 1);
});

test("runFixRung: resetStrikeCounterOnAnswer=true (default) grants a FRESH full strikeCap for the answer's re-dispatch", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })]);
  let reviewCalls = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: strikeCapForAnswer(2), // default policy — a fresh cap of 2
    initialReview: failing,
    constraint: "try approach Y instead",
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => {
        reviewCalls++;
        return reviewCalls === 1 ? failing : passing; // resolved on the SECOND strike
      },
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 2, "a fresh full strikeCap (2) grants a second strike");
  assert.match(spawnCalls[0].prompt, /try approach Y instead/, "the answer rides EVERY strike's prompt, not just the first");
  assert.match(spawnCalls[1].prompt, /try approach Y instead/);
  assert.equal(outcome.outcome, "fixed");
});

test("deriveStrikeHistory: pairs fix.dispatch (round + unmet count going IN) with its matching fix.review (outcome) BY STRIKE NUMBER, ignoring lines from a DIFFERENT task — the regression a mis-stamped ledger line (e.g. a cold-dispatch log defaulting task_id to \"SWEEP\") would silently starve", () => {
  const lines = [
    { task_id: "W1-D", step: "fix.dispatch", strike: 1, round: "resume", unmet_count: 2 },
    { task_id: "W1-D", step: "fix.review", strike: 1, state: "failure" },
    { task_id: "W1-D", step: "fix.ci_not_green", strike: 1, ci: "red" },
    { task_id: "W1-D", step: "fix.dispatch", strike: 2, round: "fresh", unmet_count: 1 },
    { task_id: "W1-D", step: "fix.review", strike: 2, state: "success" },
    // A DIFFERENT task's strikes on the same shared ledger must never bleed in.
    { task_id: "W1-OTHER", step: "fix.dispatch", strike: 1, round: "resume", unmet_count: 9 },
    // A line stamped with the WRONG task_id (the sweep/fix cold-dispatch bug
    // class) must not be picked up as W1-D's own strike 3.
    { task_id: "SWEEP", step: "fix.dispatch", strike: 3, round: "fresh", unmet_count: 5 },
  ];

  const history = deriveStrikeHistory(lines, "W1-D");

  assert.equal(history.length, 2, "only W1-D's own two strikes — never the other task's, never the mis-stamped one");
  assert.deepEqual(history[0], { strike: 1, round: "resume", unmetCount: 2, ciGreen: true, reviewState: "failure" });
  assert.deepEqual(history[1], { strike: 2, round: "fresh", unmetCount: 1, ciGreen: true, reviewState: "success" });
});

test("deriveStrikeHistory: a strike whose fix.review never arrived (CI never went green) stays ciGreen:false with no reviewState — never crashes on the missing pair", () => {
  const lines = [
    { task_id: "W1-D", step: "fix.dispatch", strike: 1, round: "resume", unmet_count: 3 },
    { task_id: "W1-D", step: "fix.ci_not_green", strike: 1, ci: "red" },
    // A fix.review with NO matching fix.dispatch (e.g. truncated ledger) must
    // be silently ignored, never thrown.
    { task_id: "W1-D", step: "fix.review", strike: 7, state: "success" },
  ];
  const history = deriveStrikeHistory(lines, "W1-D");
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], { strike: 1, round: "resume", unmetCount: 3, ciGreen: false });
  assert.equal(history[0].reviewState, undefined);
});

test("deriveStrikeHistory: an undefined taskId (a PR with no resolvable Remudero-Task trailer) returns [] rather than matching every untagged line", () => {
  assert.deepEqual(deriveStrikeHistory([{ task_id: "W1-D", step: "fix.dispatch", strike: 1 }], undefined), []);
});

// ── `rmd fix <pr>` (W1-T95): the pure routing core, injectable so refusal/
// escalate/dispatch is a unit fixture with zero live `gh`/spawn calls ─────────

/** A minimal, overridable `OpenPrView` fixture for `routeFix` (mirrors sweep.test.ts's `pr()`). */
function fixPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-07-16T12:00:00Z",
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

/** Records calls into the two gated effects `routeFix` may fire; never touches `gh`/spawn. */
function fakeFixDeps(): FixDeps & {
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
} {
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  return {
    fixed,
    escalated,
    dispatchFix: (p, evidence) => {
      fixed.push({ pr: p, evidence });
    },
    escalate: (p, reason, question) => {
      escalated.push({ pr: p, reason, question });
    },
  };
}

test("routeFix: a blocked-fixable PR dispatches via the SAME dispatchFix effect `rmd sweep` wires — one rung, three callers, no duplicated dispatch logic", async () => {
  const deps = fakeFixDeps();
  const unmet = [criterion({ claim: "does the thing", met: false })];
  const pr = fixPr({ reviewState: "failure", priorStrikes: 0, unmetCriteria: unmet });

  const result = await routeFix("OPEN", pr, deps);

  assert.equal(result.outcome, "fixed");
  assert.equal(deps.fixed.length, 1, "dispatchFix must fire exactly once");
  assert.equal(deps.escalated.length, 0, "escalate must not fire on a fixable PR");
  // Identical shape to the drain/sweep dispatch: the SAME pr + the FULL unmet set.
  assert.deepEqual(deps.fixed[0].pr, pr);
  assert.deepEqual(deps.fixed[0].evidence.unmetCriteria, unmet);
});

test("routeFix: a blocked_ci PR (checks red, review none) dispatches ci-log evidence — failing check names + log tails, not an (always-empty) reviewer-unmet array (W1-T100, the #170 fix)", async () => {
  const deps = fakeFixDeps();
  const ciFailures = [{ name: "ci", logTail: "tsc: error TS2322: ..." }];
  const pr = fixPr({ reviewState: "none", checksState: "red", priorStrikes: 0, ciFailures });

  const result = await routeFix("OPEN", pr, deps);

  assert.equal(result.outcome, "fixed");
  assert.equal(deps.fixed.length, 1);
  assert.equal(deps.escalated.length, 0, "fix FIRST — never straight to the question rung while strikes remain");
  assert.deepEqual(deps.fixed[0].evidence.unmetCriteria, [], "no reviewer criteria for a blocked_ci dispatch");
  assert.deepEqual(deps.fixed[0].evidence.ciFailures, ciFailures);
});

test("routeFix: a strike-exhausted blocked_ci PR escalates to the question rung rather than dispatching a further fix — the SAME cap review-failure honors (W1-T100)", async () => {
  const deps = fakeFixDeps();
  const pr = fixPr({
    reviewState: "none",
    checksState: "red",
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    ciFailures: [{ name: "ci", logTail: "..." }],
  });

  const result = await routeFix("OPEN", pr, deps);

  assert.equal(result.outcome, "escalated");
  assert.equal(deps.fixed.length, 0, "an exhausted blocked_ci PR must NOT dispatch another fix strike");
  assert.equal(deps.escalated.length, 1);
});

test("routeFix: a MERGED PR refuses naming the state — zero spawns", async () => {
  const deps = fakeFixDeps();
  const pr = fixPr({ reviewState: "failure", unmetCriteria: [criterion({ claim: "x", met: false })] });

  const result = await routeFix("MERGED", pr, deps);

  assert.equal(result.outcome, "refused");
  assert.match(result.reason, /MERGED/);
  assert.equal(deps.fixed.length, 0);
  assert.equal(deps.escalated.length, 0);
});

test("routeFix: a CLOSED PR refuses naming the state — zero spawns", async () => {
  const deps = fakeFixDeps();
  const pr = fixPr();

  const result = await routeFix("CLOSED", pr, deps);

  assert.equal(result.outcome, "refused");
  assert.match(result.reason, /CLOSED/);
  assert.equal(deps.fixed.length, 0);
  assert.equal(deps.escalated.length, 0);
});

// ── W1-T177 acceptance 4: "the automated paths stand down exactly as the
// operator verb does, via ONE shared predicate" — mirrors the EXISTING
// operator-verb tests directly above (routeFix: MERGED/CLOSED refuse naming
// the state, zero spawns) at the SWEEP-DRIVEN entry (runFixRung/runSweep,
// reached via buildSweepEffects.dispatchFix — never routeFix), PLUS a
// same-input equality proof that both paths' reasons come from the identical
// predicate, not two independently-hardcoded conditions. ───────────────────

for (const terminalState of ["MERGED", "CLOSED"]) {
  test(`runFixRung (the sweep-driven entry): a seeded ${terminalState} PR produces ZERO fix-rung strikes — no strike spent, no worker spawned — mirroring routeFix's ${terminalState} refusal (run-task.test.ts:1814/1826)`, async () => {
    const spawnCalls: SpawnWorkerArgs[] = [];
    const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);

    const outcome = await runFixRung({
      ...fixRungBaseOpts(),
      strikeCap: 2,
      initialReview: failing,
      deps: {
        spawn: async (args) => {
          spawnCalls.push(args);
          return result({ sessionId: "fix-session-1" });
        },
        waitForCiGreen: async () => "green",
        runReview: async () => {
          throw new Error("runReview must never be called — the rung must stand down before dispatching a strike");
        },
        push: () => {},
        issues: fakeIssues([]),
        ledgerPath: tmpLedgerPath(),
        log: () => {},
        say: () => {},
        account: (r) => r,
        readLiveState: async () => ({ ok: true, state: terminalState }),
      },
    });

    assert.equal(spawnCalls.length, 0, `zero fix worker spawns on a ${terminalState} PR`);
    assert.equal(outcome.outcome, "stood_down");
    assert.match(outcome.standDownReason ?? "", new RegExp(terminalState));
  });

  test(`runSweep (the sweep-driven entry): a seeded ${terminalState} PR produces ZERO dispositions ACTED — zero dispatchFix calls — mirroring routeFix's ${terminalState} refusal (run-task.test.ts:1814/1826)`, async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), "rmd-sweep-t177-"));
    const ledgerP = join(ledgerDir, "ledger.ndjson");
    const fixed: unknown[] = [];
    const pr: OpenPrView = {
      prNumber: 1,
      prUrl: "https://github.com/o/r/pull/1",
      taskId: "W1-TX",
      reviewState: "failure",
      checksState: "pending",
      unmetCriteria: [criterion({ claim: "does the thing", met: false })],
      priorStrikes: 0,
      lastActivityAt: new Date().toISOString(),
      headSha: "aaaa111",
      autoMergeArmed: false,
    };
    const summary = await runSweep(
      [pr],
      {
        arm: () => {},
        close: () => {},
        dispatchFix: (p, evidence) => {
          fixed.push({ p, evidence });
        },
        escalate: () => {},
        ledgerPath: ledgerP,
        runId: "SWEEP-T177",
        readLiveState: async () => ({ ok: true, state: terminalState }),
      },
      DEFAULT_SWEEP_POLICY,
    );
    assert.equal(fixed.length, 0, `dispatchFix is called ZERO times on a ${terminalState} PR`);
    assert.equal(summary.actionsTaken, 0);
    assert.equal(summary.actions[0].acted, false);
  });
}

test("W1-T177 acceptance 4: routeFix (the operator verb) and runFixRung (the sweep-driven entry) stand down IDENTICALLY on the SAME terminal states — proven by EQUAL reason strings from the ONE shared terminalStateReason predicate, not two independently-hardcoded conditions", async () => {
  for (const state of ["MERGED", "CLOSED"]) {
    // The operator verb: routeFix's own terminal check.
    const fixDeps = fakeFixDeps();
    const pr = fixPr({ reviewState: "failure", unmetCriteria: [criterion({ claim: "x", met: false })] });
    const routeResult = await routeFix(state, pr, fixDeps);
    assert.equal(routeResult.outcome, "refused");
    assert.equal(fixDeps.fixed.length, 0);

    // The automated, sweep-driven path: runFixRung's own internal live-state check.
    const failing = fakeReview("failure", [criterion({ claim: "criterion A", met: false, reason: "r" })]);
    const rungOutcome = await runFixRung({
      ...fixRungBaseOpts(),
      strikeCap: 2,
      initialReview: failing,
      deps: {
        spawn: async () => result({ sessionId: "s" }),
        waitForCiGreen: async () => "green",
        runReview: async () => {
          throw new Error("must not be called");
        },
        push: () => {},
        issues: fakeIssues([]),
        ledgerPath: tmpLedgerPath(),
        log: () => {},
        say: () => {},
        account: (r) => r,
        readLiveState: async () => ({ ok: true, state }),
      },
    });
    assert.equal(rungOutcome.outcome, "stood_down");

    // BOTH reasons equal the SAME imported predicate's output — literal
    // equality, not a keyword/grep proxy, so a future edit to one condition
    // without the other would fail this test immediately.
    const expected = terminalStateReason(state);
    assert.equal(routeResult.reason, expected);
    assert.equal(rungOutcome.standDownReason, expected);
    assert.equal(routeResult.reason, rungOutcome.standDownReason, "the operator verb and the automated path must produce the IDENTICAL reason string");
  }
});

test("routeFix: an OPEN PR with no block evidence (review success) refuses — zero spawns", async () => {
  const deps = fakeFixDeps();
  const pr = fixPr({ reviewState: "success", checksState: "green" });

  const result = await routeFix("OPEN", pr, deps);

  assert.equal(result.outcome, "refused");
  assert.equal(deps.fixed.length, 0);
  assert.equal(deps.escalated.length, 0);
});

test("routeFix: strikes already at the cap escalate (naming the count) rather than dispatching another fix — the cap is honored, never bypassed", async () => {
  const deps = fakeFixDeps();
  const pr = fixPr({
    reviewState: "failure",
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap,
    unmetCriteria: [criterion({ claim: "x", met: false })],
  });

  const result = await routeFix("OPEN", pr, deps);

  assert.equal(result.outcome, "escalated");
  assert.match(result.reason, new RegExp(`${DEFAULT_SWEEP_POLICY.strikeCap}/${DEFAULT_SWEEP_POLICY.strikeCap}`));
  assert.equal(deps.fixed.length, 0, "an exhausted PR must NOT dispatch another fix strike");
  assert.equal(deps.escalated.length, 1, "escalate must fire exactly once");
  // W1-T78: `rmd fix` renders the SAME clarification question the sweep does —
  // one rung, one implementation, three callers.
  assert.match(deps.escalated[0].question.question, /x/, "the question names the unmet criterion");
  assert.equal(deps.escalated[0].question.resolutions.length, 2);
});

test("the terminal blocked_review return (no fix rung) is gone — a failing review always enters the fix rung before any terminal verdict", () => {
  // Before W1-T76: `if (review.state !== "success") { ... return {..., verdict: "blocked_review"}; }`
  // right after the review call, with NOTHING in between. Guard against that
  // shape reappearing (a regression that silences the rung).
  assert.doesNotMatch(
    runTaskSrc,
    /if \(review\.state !== "success"\) \{\s*log\("verdict"/,
    "a failing review must route through runFixRung, never straight back to a blocked_review verdict",
  );
});
