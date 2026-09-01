import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, readdirSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readlineAsk, type GitRunner, materializeOriginShards, escalateCommand, digestCommand, pushDrainRundown,
  armAutoMerge,
  armFailureAction,
  armAndLogOutcome,
  armIfVerdictPermits,
  type ArmOutcome,
  buildEscalationCloser,
  buildEscalationReconcileCandidates,
  sweepEscalationReconcile,
  sweepCommand,
  buildSweepHook,
  buildSweepEffects,
  buildFixRungDispatchArgs,
  buildSweepLightHook,
  daemonCommand,
  daemonPlistCommand,
  deployPlistCommand,
  digestPlistCommand,
  servePlistCommand,
  realArmDeps,
  type ArmDeps,
  DEFAULT_BUDGET_USD,
  GitFetchError,
  buildInboxDraftHook,
  checkPrOwnership,
  scopeGuardOutOfScopeFiles,
  ciGateFromRollup,
  commitsAhead,
  degradedReasonLedgerFields,
  deriveFixMode,
  detectReviewFalseBlock,
  fetchPrBodyViaGh,
  deriveStrikeHistory,
  dispatchFixPreflightStandDown,
  drainCommand,
  escalateCircuitBreak,
  FIX_MODE_RULES,
  isTransientResult,
  materializeReviewWorktree,
  renderFixPrompt,
  reviewPostedDescription,
  reviewTaskIdFromBody,
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
  priorStrikesFor,
  currentStrikeRegimeFor,
  ghPrCreateFillCommand,
  reviewCommand,
  onboardCommand,
  reconCommand,
  defaultReconRunLens,
  serviceFreshnessGate,
  ensureInstallFresh,
  hashInstallInputs,
  installHashMarkerPath,
  sessionCommand,
  synthesizeCommand,
  defaultSynthesizeDraft,
  lintPlanCommand,
  type LintPlanStatusDeps,
  main,
  alertFixCommand,
  dispatchAlertFixRun,
  type AlertFixCommandDeps,
  type AlertFixDispatchDeps,
  runTask,
  buildOpenPrViews,
  STALL_WINDOW, resolveAlreadySatisfiedWithRetry, ALREADY_SATISFIED_VERIFY_ATTEMPTS, type AlreadySatisfiedClaim, type AlreadySatisfiedResolution,
} from "../src/run-task.js";
import { requestStop } from "../src/lib/fleet-control.js";
import { LaunchdPlistError } from "../src/lib/launchd.js";
import type { AlertLaneAlert } from "../src/lib/alert-lane.js";
import type { AlertGateway } from "../src/lib/ops.js";
import { realOnboardFsDeps, type Inventory, type OnboardGhGateway } from "../src/lib/onboard/inventory.js";
import type { Candidate } from "../src/lib/onboard/recon.js";
import { realReconFsDeps, type ReconGhGateway } from "../src/lib/onboard/recon.js";
import { generateOnboardQuestions, realSessionFsDeps, type OnboardAnswer, type OnboardQuestion } from "../src/lib/onboard/session.js";
import {
  realSynthesizeFsDeps,
  type SynthesizeDraftFn,
  type SynthesizeDraftInput,
  type SynthesizeGhGateway,
  type SynthesizeGitGateway,
} from "../src/lib/onboard/synthesize.js";
import { SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";
import type { recordDecision } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { judgeReview } from "../src/lib/review.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import { buildBatchedGithub, type GitHub, type StatusProjection } from "../src/lib/status.js";
import type { AcceptanceCriterion, Plan, Task } from "../src/lib/plan.js";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  strikeCapForAnswer,
  terminalStateReason,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type MergeConflictEvidence,
  type OpenPrView,
  type RepairFilingCapture,
} from "../src/lib/sweep.js";
import type { Mount } from "../src/lib/mounts.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { feedbackEntryPath, readFeedbackEntry } from "../src/lib/feedback.js";
import { worktreesDir } from "../src/lib/worker.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { loadPlan } from "../src/lib/plan.js";
import { loadPlanIndex, renderPlanIndex } from "../src/lib/plan-index.js";
import { changedTaskIds } from "../src/lib/task-linter.js";

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

// ── W1-T105 BEHAVIORAL: the REAL runTask dispatch path reaches BOTH follow-up harvest
// call sites — recon's (right after recon.done, no PR yet) and the implement worker's
// (right after `pr.opened`, once ownership is proven) — mirroring
// test/containment-wiring.test.ts's / test/isolation-wiring.test.ts's own
// injected-preflight technique for driving `runTask` end to end with zero network, zero
// real `gh`/Claude spawn, and a REAL local git repo standing in for `origin`. ──────────

const FOLLOWUP_FIXTURE_PLAN = [
  "- id: T-FOLLOWUP",
  "  title: follow-up harvest wiring probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

/** An offline GitHub gateway: projectPlan runs with zero network round-trips. */
const FOLLOWUP_OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** A containmentExec that reports the outside-cwd write OS-DENIED — containment PASSES
 *  (mirrors test/isolation-wiring.test.ts's `holdingContainmentExec`). */
const followupHoldingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

/** An isolationExec reporting zero inherited operator aliases/functions — isolation PASSES. */
const followupCleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

/** A real, throwaway BARE "origin" + a real clone at `repoDir` — `worktreeAdd`'s own
 *  `git fetch origin`/`git worktree add ... origin/main` and the run's later
 *  `git push origin HEAD` all run for real, entirely offline. */
function followupGitFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "runtask-followup-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "runtask-followup-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "followup-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "followup-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "followup-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "followup-test"]);
  return { repoDir };
}

/** A fake `gh` on PATH answering ONLY the handful of subcommands this run reaches:
 *  `pr view --json headRefName` (checkPrOwnership), `--json body` + `pr edit`
 *  (ensureTaskTrailer — best-effort either way), and `--json statusCheckRollup`
 *  (waitForCiGreen) — answered RED on the very first poll so the run reaches its
 *  terminal blocked_ci verdict immediately, with no sleep and no review spawn. */
function followupFakeGh(branch: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "runtask-followup-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "fi",
      // W1-T2268: `waitForCiGreen` now reads REST (`gh api …`), never `gh pr view --json
      // statusCheckRollup`. RED on the composed check-run, on the very first poll — same
      // "no sleep, no review spawn" shape as before.
      "if [[ \"$1\" == 'api' ]]; then",
      "  case \"$2\" in",
      "    */pulls/*) echo '{\"number\":1,\"state\":\"open\",\"merged\":false,\"merged_at\":null,\"head\":{\"sha\":\"deadbeef\"}}'; exit 0 ;;",
      "    */check-runs*) echo '{\"check_runs\":[{\"name\":\"ci\",\"status\":\"completed\",\"conclusion\":\"failure\"}]}'; exit 0 ;;",
      "    */status) echo '{\"statuses\":[]}'; exit 0 ;;",
      "  esac",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

test(
  "BEHAVIORAL (W1-T105): a real runTask run harvests BOTH the recon report's and the implement " +
    "report's optional '## Follow-ups' sections into distinct report.followups ledger lines — " +
    "recon's carrying no pr_url, the implement one carrying the real PR url",
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "runtask-followup-root-"));
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
    const config: Config = { claudeBin: "/bin/true", root };

    const { repoDir } = followupGitFixture(root);
    void repoDir; // runTask derives the identical path itself from config.root + task.repo

    const FIXED_TS = 1785000000000;
    const branch = `run-T-FOLLOWUP-${FIXED_TS}`;
    const fakeBinDir = followupFakeGh(branch);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${savedPath}`;
    const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

    const spawnCalls: SpawnWorkerArgs[] = [];
    const spawn: typeof spawnWorker = async (args) => {
      spawnCalls.push(args);
      if (spawnCalls.length === 1) {
        // Recon — no PR yet, so its harvest ledger line must carry no pr_url.
        return result({
          sessionId: "s-recon",
          text: "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n\n## Follow-ups\nresearch: a recon-discovered idea, out of scope for this task\n",
        });
      }
      // Implement — declares its own PR_URL (never reaches `gh pr create`) plus its
      // OWN follow-ups section (§2 OUTPUT CONTRACT).
      return result({
        sessionId: "s-implement",
        text:
          "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n\n" +
          "## Follow-ups\naction: rotate the fixture's throwaway token, out of scope for this task\n",
      });
    };

    try {
      // A REAL runTask() on followupGitFixture's throwaway bare TMPDIR origin: recon,
      // implement, the squash and `git push origin HEAD` all run for real, entirely offline,
      // with a fake gh on PATH and an offline `github` gateway. Exempted because the guard
      // checks the CALL, not the destination — this run never touches the live repo.
      const res = await withLiveWritesAllowed(() =>
        runTask("T-FOLLOWUP", {
          skipGitSync: true,
          planPath,
          config,
          github: FOLLOWUP_OFFLINE_GITHUB,
          spawn,
          containmentExec: followupHoldingContainmentExec,
          isolationExec: followupCleanIsolationExec,
        }),
      );

      // ci is answered RED on the very first poll (followupFakeGh above) — the run
      // reaches its terminal verdict right after the implement harvest, with no
      // review spawn and no sleep.
      assert.equal(res.verdict, "blocked_ci");
      assert.equal(spawnCalls.length, 2, "exactly recon then implement — no resume, no review spawn");

      const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const harvests = ledger.filter((l) => l.step === "report.followups");
      assert.equal(harvests.length, 2, "both the recon AND the implement follow-ups sections are harvested");

      const reconHarvest = harvests[0];
      assert.equal(reconHarvest.pr_url, undefined, "recon never opens a PR — no pr_url on its harvest line");
      assert.deepEqual(reconHarvest.entries, [
        { type: "research", text: "a recon-discovered idea, out of scope for this task" },
      ]);

      const implementHarvest = harvests[1];
      assert.equal(implementHarvest.pr_url, "https://github.com/acme/remudero/pull/1");
      assert.deepEqual(implementHarvest.entries, [
        { type: "action", text: "rotate the fixture's throwaway token, out of scope for this task" },
      ]);
    } finally {
      dateNowSpy.mock.restore();
      process.env.PATH = savedPath;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// ── W1-T319 (fb-1784773321502-86793d): a BY-ID `rmd run-task <id>` REFUSES an
// ALREADY-MERGED task at zero cost, instead of dispatching straight through and
// (deterministically) claiming the wrong PR. `skipGitSync: true` reads the fixture plan
// literally (no git needed at all) -- the guard fires immediately after the projection is
// built and BEFORE the inflight lock, the §5C linter, worktree materialization, or any
// spawn, so none of those need a fixture here either. ──────────────────────────────────

const MERGED_FIXTURE_PLAN = [
  "- id: T-MERGED",
  "  title: already-merged by-id kick probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  depends_on: []",
  "  status: queued",
  "",
].join("\n");

const MERGED_PR_URL = "https://github.com/acme/remudero/pull/491";

/** A GitHub gateway reporting T-MERGED already merged via `findMergedByTrailer` (the
 *  `source: "trailer"` rung `deriveStatus` resolves before ever looking at dependents) --
 *  the exact shape the W1-T112 incident's `state/status.json` carried (source:ledger,
 *  merged=true, via a real PR). Counts calls so a test can prove `projectPlan` (and this
 *  gateway) ran exactly ONCE, never twice. */
function mergedGithubFixture(): { github: GitHub; findMergedByTrailerCalls: string[] } {
  const findMergedByTrailerCalls: string[] = [];
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: (taskId) => {
      findMergedByTrailerCalls.push(taskId);
      return taskId === "T-MERGED" ? { number: 491, url: MERGED_PR_URL, state: "MERGED" } : null;
    },
    // Rung (c)'s ownership-assert (creditsByAnchoredTrailer, status.ts) requires BOTH an
    // anchored `Remudero-Task:` trailer in the body AND a readable head ref that does not
    // claim a DIFFERENT task — a merged-but-unowned hit would be REJECTED (not credited),
    // exactly the W1-T20c false-credit class that assert exists to catch.
    headRefName: (url) => (url === MERGED_PR_URL ? "run-T-MERGED-1700000000000" : undefined),
    prBody: (url) => (url === MERGED_PR_URL ? "REPORT\n\nRemudero-Task: T-MERGED\n" : undefined),
  };
  return { github, findMergedByTrailerCalls };
}

function mergedFixtureRoot(planYaml: string = MERGED_FIXTURE_PLAN): { root: string; planPath: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), "runtask-already-merged-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, planYaml);
  return { root, planPath, config: { claudeBin: "/bin/true", root } };
}

function readLedgerLinesFor(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("W1-T319 ACCEPTANCE: runTask on an already-merged task refuses with verdict task_already_merged at zero cost -- no lock, no worktree, no worker spawn", async () => {
  const { root, planPath, config } = mergedFixtureRoot();
  const { github, findMergedByTrailerCalls } = mergedGithubFixture();
  const spawn: typeof spawnWorker = async () => {
    throw new Error("spawnWorker must never be called for an already-merged by-id kick");
  };

  try {
    const res = await runTask("T-MERGED", { skipGitSync: true, planPath, config, github, spawn });

    assert.equal(res.verdict, "task_already_merged");
    assert.equal(res.merged, false, "this run produced no PR of its own");
    assert.equal(res.costUsd, 0);
    // The projection is built exactly ONCE (one task in the plan) -- proves no SECOND
    // projectPlan call and no second gateway instance were spun up for the refusal.
    assert.deepEqual(findMergedByTrailerCalls, ["T-MERGED"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T319 ACCEPTANCE: the refusal is ledgered as dispatch.refused_already_merged, naming the merged PR, never a silent decline", async () => {
  const { root, planPath, config } = mergedFixtureRoot();
  const { github } = mergedGithubFixture();

  try {
    await runTask("T-MERGED", { skipGitSync: true, planPath, config, github });

    const refusals = readLedgerLinesFor(root).filter((l) => l.step === "dispatch.refused_already_merged");
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].task_id, "T-MERGED");
    assert.equal(refusals[0].pr_url, MERGED_PR_URL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T319 ACCEPTANCE: the merged refusal fires BEFORE assertRunnable, so an already-merged task with an ALSO-unmet dependency still names the merged reason, not a dependency one", async () => {
  const planYaml = [
    "- id: T-DEP",
    "  title: unmet dep",
    "  repo: remudero",
    "  type: implement",
    "  depends_on: []",
    "  status: queued",
    "- id: T-MERGED",
    "  title: already-merged by-id kick probe, with an unmet dependency",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  depends_on: [T-DEP]", // T-DEP is NOT merged -- assertRunnable would refuse on this alone
    "  status: queued",
    "",
  ].join("\n");
  const { root, planPath, config } = mergedFixtureRoot(planYaml);
  const { github } = mergedGithubFixture(); // only T-MERGED reports merged; T-DEP does not

  try {
    const res = await runTask("T-MERGED", { skipGitSync: true, planPath, config, github });
    // Had assertRunnable run first, this would throw an "unmerged dependencies" PlanError
    // instead (an uncaught throw, not a RunResult) -- reaching a clean task_already_merged
    // RunResult proves the merged-refusal short-circuits BEFORE that call.
    assert.equal(res.verdict, "task_already_merged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T319 ACCEPTANCE: --rerun is accepted by the run-task arg validator, proceeds with dispatch exactly as before this guard existed, and the override is ledgered", async () => {
  // (a) THE CLI ARG VALIDATOR: `--rerun` is a recognized boolean flag, same as `--allow-stale`.
  assert.equal(unknownArgError("run-task", ["--rerun"], [], ["--allow-stale", "--rerun"]), null);
  assert.equal(unknownArgError("run-task", ["--allow-stale", "--rerun"], [], ["--allow-stale", "--rerun"]), null);

  // (b) THE DISPATCH: with `rerun: true`, an already-merged task proceeds past the guard
  // into `assertRunnable` exactly as it did before this guard existed -- proven here by an
  // UNMET dependency surfacing as assertRunnable's own `PlanError`, not a silent bypass.
  const planYaml = [
    "- id: T-DEP",
    "  title: unmet dep",
    "  repo: remudero",
    "  type: implement",
    "  depends_on: []",
    "  status: queued",
    "- id: T-MERGED",
    "  title: already-merged by-id kick probe, rerun",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  depends_on: [T-DEP]",
    "  status: queued",
    "",
  ].join("\n");
  const { root, planPath, config } = mergedFixtureRoot(planYaml);
  const { github } = mergedGithubFixture();

  try {
    await assert.rejects(
      () => runTask("T-MERGED", { skipGitSync: true, planPath, config, github, rerun: true }),
      /unmerged dependencies/,
      "rerun:true reaches the SAME assertRunnable refusal an unguarded dispatch always hit -- proceeds exactly as before this guard existed",
    );

    const overrides = readLedgerLinesFor(root).filter((l) => l.step === "dispatch.rerun_override");
    assert.equal(overrides.length, 1, "the deliberate override is ledgered, never a silent bypass");
    assert.equal(overrides[0].task_id, "T-MERGED");
    assert.equal(overrides[0].pr_url, MERGED_PR_URL);

    const refusals = readLedgerLinesFor(root).filter((l) => l.step === "dispatch.refused_already_merged");
    assert.equal(refusals.length, 0, "rerun:true must never ALSO log the refusal it overrode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T191: DECISION_REQUEST auto-choose no longer appends to THIS checkout's own
// DECISIONS.md (a real working-tree write that made checkCliFreshness refuse every
// non-exempt `rmd` verb once the checkout also fell behind origin/main) — it calls the
// injectable `recordDecision` (feedback-landing.js), which lands a per-resolution shard via
// the SAME commit-bridge mechanism W1-T243 proved for `plan/feedback/**`, WITHOUT ever
// writing to repoRoot's real working tree. These drive the REAL runTask() through the REAL
// DECISION_REQUEST branch (never a unit test of the branch's code in isolation) — only
// `recordDecision` itself is faked, so this proves the WIRING (right fields, right gating),
// while feedback-landing.test.ts proves the real git/gh mechanics recordDecision performs. ──

test("W1-T191: runTask's DECISION_REQUEST branch calls the injectable recordDecision with the right fields for a medium-risk decision, and its landed status reaches the decision.autochoose ledger line", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-decision-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000001;
  const branch = `run-T-FOLLOWUP-${FIXED_TS}`;
  const fakeBinDir = followupFakeGh(branch);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({ sessionId: "s-recon", text: "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" });
    }
    if (spawnCalls.length === 2) {
      // Implement's FIRST reply is a DECISION_REQUEST — a schema/migration choice trips
      // shouldRecordDecision's medium-risk signal, so the record gate fires.
      return result({
        sessionId: "s-implement",
        text: "DECISION_REQUEST\n- Add a schema migration column (RECOMMENDED)\n- Do nothing\n",
      });
    }
    // The resumed implement call, after the decision is auto-chosen and (fake-)recorded.
    return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/2\n" });
  };

  const recordDecisionCalls: Array<{ root: string; params: Parameters<typeof recordDecision>[1] }> = [];
  const fakeRecordDecision: typeof recordDecision = (calledRoot, params) => {
    recordDecisionCalls.push({ root: calledRoot, params });
    return { landed: true, files: [`plan/decisions.d/${params.taskId}-${params.runId}.md`], prUrl: "https://github.com/acme/remudero/pull/900" };
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
        recordDecision: fakeRecordDecision,
      }),
    );

    assert.equal(res.verdict, "blocked_ci");
    assert.equal(spawnCalls.length, 3, "recon, implement (DECISION_REQUEST), resumed implement (REPORT+PR)");
    assert.equal(recordDecisionCalls.length, 1, "recordDecision must be called exactly once for a medium-risk decision");

    const call = recordDecisionCalls[0];
    assert.equal(call.params.taskId, "T-FOLLOWUP");
    assert.equal(call.params.runId, `T-FOLLOWUP-${FIXED_TS}`);
    assert.deepEqual(call.params.options, ["Add a schema migration column", "Do nothing"]);
    assert.equal(call.params.chosen, "Add a schema migration column");
    assert.equal(call.params.band, "medium");
    assert.ok(call.root.length > 0, "recordDecision is called with repoRoot, never the worker's own worktree");

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const autochoose = ledger.find((l) => l.step === "decision.autochoose");
    assert.ok(autochoose, "decision.autochoose must still fire — the receipt half never changes");
    assert.equal(autochoose.recorded, true);
    assert.equal(autochoose.risk_band, "medium");
    assert.equal(autochoose.landed, true, "the fake recordDecision's landed:true must reach the ledger line");
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T191: runTask's DECISION_REQUEST branch never calls recordDecision for a trivial, low-risk decision — ledger-only stays ledger-only, no wasted git/gh work", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-decision-lowrisk-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000002;
  const branch = `run-T-FOLLOWUP-${FIXED_TS}`;
  const fakeBinDir = followupFakeGh(branch);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({ sessionId: "s-recon", text: "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" });
    }
    if (spawnCalls.length === 2) {
      // A trivial filename pick — no risk keyword, no reversibility caveat anywhere in it.
      return result({ sessionId: "s-implement", text: "DECISION_REQUEST\n- Name the file utils.ts (RECOMMENDED)\n- Name the file helpers.ts\n" });
    }
    return result({ sessionId: "s-implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/3\n" });
  };

  const recordDecisionCalls: unknown[] = [];
  const fakeRecordDecision: typeof recordDecision = (calledRoot, params) => {
    recordDecisionCalls.push({ calledRoot, params });
    return { landed: true, files: [] };
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
        recordDecision: fakeRecordDecision,
      }),
    );

    assert.equal(res.verdict, "blocked_ci");
    assert.equal(recordDecisionCalls.length, 0, "a trivial low-risk decision must stay ledger-only — recordDecision must never be invoked");

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const autochoose = ledger.find((l) => l.step === "decision.autochoose");
    assert.ok(autochoose, "decision.autochoose must still fire even when ledger-only");
    assert.equal(autochoose.recorded, false);
    assert.equal(autochoose.risk_band, "low");
    assert.equal(autochoose.landed, false);
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T191 acceptance 4: the three already-observed decision records (found 2026-07-21 in a
// dirty operator checkout, uncommitted) are preserved in the repository, not assumed away. ──

test("W1-T191 acceptance 4: the three rescued decision records are present after the fix — the 2026-07-20/21 resolutions in the committed DECISIONS.md", () => {
  const decisionsMd = readFileSync(join(new URL("..", import.meta.url).pathname, "DECISIONS.md"), "utf8");
  assert.match(decisionsMd, /## 2026-07-20T20:36:14\.454Z — W1-T156 \(W1-T156-1784579460422\)/);
  assert.match(decisionsMd, /## 2026-07-20T22:31:09\.231Z — W1-T128 \(W1-T128-1784586484416\)/);
  assert.match(decisionsMd, /## 2026-07-21T01:18:25\.612Z — W1-T136 \(W1-T136-1784596357757\)/);
});

// ── W1-T191 acceptance 7: the fix does not widen the service carve-out or exempt further
// verbs from the freshness gate — the gate is correct, the writers were the defect. ────────

test("W1-T191 acceptance 7: self-sync.ts's service carve-out is untouched — DIRT NEVER BLOCKS A SERVICE still stands, verbatim", () => {
  const selfSyncSrc = readFileSync(fileURLToPath(new URL("../src/lib/self-sync.ts", import.meta.url)), "utf8");
  assert.match(selfSyncSrc, /DIRT NEVER BLOCKS A SERVICE/);
});

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

test("wiring: the recon worker's spawn prompt is built via renderReconPrompt(planIndexBlock, ...), not a hardcoded literal", () => {
  const reconIdx = runTaskSrc.indexOf('"recon worker"');
  const promptCallIdx = runTaskSrc.indexOf("prompt: renderReconPrompt(planIndexBlock,");
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
    0,
  );
  assert.equal(v.verdict, "no_pr");
  assert.equal(v.ledger.verdict, "no_pr");
  assert.equal(v.ledger.reason, "worker completed without opening a PR");
  assert.equal(v.ledger.commits_ahead, 0);
  assert.equal(v.ledger.report_excerpt, undefined);
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
  assert.equal(noPrVerdict(result({ subtype: "success" }), 1, "implement", 0).verdict, "no_pr");
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

// ── scopeGuardOutOfScopeFiles: the SCOPE-GUARDED BRANCH REFRESH pure guard (W1-T142,
// the `reset --soft` phantom-revert near-miss) — a refresh/collapse/squash whose diff
// touches files outside the task's declared `files` must be flagged so the push site
// can refuse it, named. ──────────────────────────────────────────────────────────────

test("scopeGuardOutOfScopeFiles: the exact reset --soft near-miss shape — a diff touching one declared and one undeclared file names ONLY the undeclared one", () => {
  const out = scopeGuardOutOfScopeFiles(["test/foo.ts", "src/lib/issues-intake.ts"], ["test/foo.ts"]);
  assert.deepEqual(out, ["src/lib/issues-intake.ts"]);
});

test("scopeGuardOutOfScopeFiles: a diff that stays entirely within the declared files returns empty — no false positive on an in-scope squash", () => {
  const out = scopeGuardOutOfScopeFiles(
    ["src/run-task.ts", "test/run-task.test.ts"],
    ["src/run-task.ts", "test/run-task.test.ts", "docs/unused.md"],
  );
  assert.deepEqual(out, []);
});

test("scopeGuardOutOfScopeFiles: is PURE — no injected git/network dependency, and identical input always yields an identical, freshly-allocated result", () => {
  const diff = ["a.ts", "b.ts"];
  const declared = ["a.ts"];
  const first = scopeGuardOutOfScopeFiles(diff, declared);
  const second = scopeGuardOutOfScopeFiles(diff, declared);
  assert.deepEqual(first, ["b.ts"]);
  assert.deepEqual(second, ["b.ts"]);
  assert.notEqual(first, second, "each call returns its own array, never a shared/mutated reference");
  // The inputs themselves are never mutated by the guard.
  assert.deepEqual(diff, ["a.ts", "b.ts"]);
  assert.deepEqual(declared, ["a.ts"]);
});

test("scopeGuardOutOfScopeFiles: FAIL-CLOSED — an undefined declared-files scope refuses a non-empty diff wholesale, never waved through", () => {
  const out = scopeGuardOutOfScopeFiles(["src/lib/issues-intake.ts", "test/foo.ts"], undefined);
  assert.deepEqual(out, ["src/lib/issues-intake.ts", "test/foo.ts"]);
});

test("scopeGuardOutOfScopeFiles: FAIL-CLOSED — an EMPTY declared-files array refuses a non-empty diff exactly like undefined", () => {
  const out = scopeGuardOutOfScopeFiles(["src/lib/issues-intake.ts"], []);
  assert.deepEqual(out, ["src/lib/issues-intake.ts"]);
});

test("scopeGuardOutOfScopeFiles: an EMPTY diff is always clean, even with an undefined/empty declared scope — nothing staged, nothing to refuse", () => {
  assert.deepEqual(scopeGuardOutOfScopeFiles([], undefined), []);
  assert.deepEqual(scopeGuardOutOfScopeFiles([], []), []);
  assert.deepEqual(scopeGuardOutOfScopeFiles([], ["src/run-task.ts"]), []);
});

// ── FIXTURE: a REAL git repro of the `reset --soft` phantom-revert near-miss itself —
// a stale worktree's `git reset --soft origin/main` forges a merge-base whose diff
// silently reverts a file an unrelated, already-merged PR had touched. The guard is fed
// the REAL `git diff --name-only origin/main...HEAD` this produces (never a hand-typed
// fixture), proving it catches the actual failure shape, not just a synthetic one. ────
test("scopeGuardOutOfScopeFiles: fed the REAL diff from a reconstructed reset --soft phantom-revert branch, refuses and names the reverted file", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-scope-guard-phantom-revert-"));
  const g = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const origin = join(root, "origin");
  mkdirSync(origin, { recursive: true });
  g(origin, ["init", "--quiet", "-b", "main"]);
  g(origin, ["config", "user.email", "test@example.com"]);
  g(origin, ["config", "user.name", "Test"]);
  mkdirSync(join(origin, "src", "lib"), { recursive: true });
  writeFileSync(join(origin, "src", "lib", "issues-intake.ts"), "original\n");
  g(origin, ["add", "."]);
  g(origin, ["commit", "--quiet", "-m", "c1: issues-intake.ts merged"]);

  // The worker's stale worktree: forked at c1, made its OWN legitimate change to a
  // declared file, and committed it — before main advanced any further.
  const worker = join(root, "worker");
  execFileSync("git", ["clone", "--quiet", origin, worker], { encoding: "utf8" });
  g(worker, ["config", "user.email", "test@example.com"]);
  g(worker, ["config", "user.name", "Test"]);
  mkdirSync(join(worker, "test"), { recursive: true });
  writeFileSync(join(worker, "test", "foo.ts"), "worker-change\n");
  g(worker, ["add", "."]);
  g(worker, ["commit", "--quiet", "-m", "worker: test/foo.ts"]);

  // Meanwhile origin/main ADVANCES — a different, already-merged PR (#310/#314-shaped)
  // touches the SAME file the stale worker checkout still has the OLD content for.
  writeFileSync(join(origin, "src", "lib", "issues-intake.ts"), "newer-content-from-a-merged-pr\n");
  g(origin, ["commit", "-a", "--quiet", "-m", "c2: issues-intake.ts advanced by another merged PR"]);

  // The near-miss itself: an operator "refreshes" the stale worker branch onto the new
  // origin/main tip via `git reset --soft` — this moves HEAD but leaves the INDEX/working
  // tree exactly as they were (still the OLD issues-intake.ts + the worker's test/foo.ts),
  // then collapses that into one commit. The new commit's diff vs origin/main now silently
  // reverts issues-intake.ts alongside the legitimate test/foo.ts change.
  g(worker, ["fetch", "--quiet", "origin"]);
  g(worker, ["reset", "--soft", "origin/main"]);
  g(worker, ["commit", "--quiet", "-m", "refresh: collapsed onto origin/main"]);

  // THREE-DOT, mirroring production after the merge-base fix. The phantom revert is STILL caught:
  // `reset --soft origin/main` makes origin/main the parent, hence the merge base, so the two dot
  // forms agree here — which is exactly why the fix does not weaken the case the guard was built
  // for. This assertion passing under three-dot is that proof.
  const diffFiles = g(worker, ["diff", "--name-only", "origin/main...HEAD"])
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  assert.deepEqual(
    diffFiles.sort(),
    ["src/lib/issues-intake.ts", "test/foo.ts"].sort(),
    "the forged refresh's real diff touches BOTH the legit change and the phantom revert",
  );

  const outOfScope = scopeGuardOutOfScopeFiles(diffFiles, ["test/foo.ts"]);
  assert.deepEqual(outOfScope, ["src/lib/issues-intake.ts"], "the guard names ONLY the phantom-reverted file");

  rmSync(root, { recursive: true, force: true });
});

// ── W1-T268 BEHAVIORAL: the ledger ACCOUNT DIMENSION (billing_mode derived off
// childEnvKeys, account_label off WorkerResult.accountLabel — never a hardcoded
// "subscription" literal) threaded through EVERY runTask verdict site, including
// the ones an ordinary run rarely reaches: blocked_transient, the "no PR opened"
// failed verdict, the fix rung's exhausted/stood-down blocked verdicts, a real
// MERGED verdict (past the risk judge + pollToGate), and the terminal (post-poll)
// blocked_ci verdict. Reuses the W1-T105 FOLLOWUP fixture harness above (a real
// throwaway git origin, zero network, zero real Claude/gh spawn). ─────────────

/** A stateful, Node-based fake `gh` (mirrors buildSweepEffects.dispatchFix's own
 *  counter-file fixture below) — unlike {@link followupFakeGh}'s fixed-per-run
 *  answer, each `--json` FIELD answers from its OWN ordered sequence (a per-field
 *  call counter, the last entry repeating forever after), so a single run's
 *  MULTIPLE reads of the same field — the outer pre-review ci gate vs. the fix
 *  rung's own per-strike polls, or `pollToGate`'s merge-state read — can each
 *  answer differently. `gh issue create` answers `issueUrl`; everything else this
 *  run might invoke (`gh label create`, the `gh api` read inside escalate's
 *  dedup search, `gh pr merge --auto`) exits non-zero — every one of those call
 *  sites already tolerates/ignores a failure (see followupFakeGh's own doc). */
function statefulFakeGh(opts: {
  branch: string;
  /** `--json statusCheckRollup` rollup arrays, in call order (last repeats). */
  ciSeq: Array<{ name: string; conclusion: string }[]>;
  /** `--json state` values, in call order (last repeats). Default: always "OPEN". */
  stateSeq?: string[];
  /** `--json state,statusCheckRollup` (pollToGate), in call order (last repeats). */
  pollSeq?: Array<{ state: string; statusCheckRollup?: { name: string; conclusion: string }[] }>;
  issueUrl?: string;
}): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "runtask-stateful-gh-bin-"));
  const counterDir = mkdtempSync(join(tmpdir(), "runtask-stateful-gh-counters-"));
  const script = [
    "#!/usr/bin/env node",
    'const fs = require("fs");',
    "const args = process.argv.slice(2);",
    `const counterDir = ${JSON.stringify(counterDir)};`,
    "function next(name, values) {",
    '  const f = counterDir + "/" + name;',
    "  let n = 0;",
    '  try { n = parseInt(fs.readFileSync(f, "utf8") || "0", 10); } catch (e) {}',
    "  fs.writeFileSync(f, String(n + 1));",
    "  return values[Math.min(n, values.length - 1)];",
    "}",
    'const idx = args.indexOf("--json");',
    "const field = idx >= 0 ? args[idx + 1] : undefined;",
    'if (args[0] === "pr" && args[1] === "view") {',
    `  if (field === "headRefName") { process.stdout.write(JSON.stringify({ headRefName: ${JSON.stringify(opts.branch)} })); process.exit(0); }`,
    '  if (field === "body") { process.stdout.write(JSON.stringify({ body: "" })); process.exit(0); }',
    "}",
    // W1-T2268: `waitForCiGreen`/`pollToGate` now read REST (`gh api …`), never `gh pr view
    // --json statusCheckRollup`/`state,statusCheckRollup`. Both loops' composed-rollup reads
    // (the outer pre-review gate, every fix-rung strike's own poll, AND `pollToGate`'s own
    // merge-gate poll) share the SAME `commits/{sha}/check-runs` endpoint a real GitHub would
    // answer identically regardless of caller — so `ciSeq` drives the first `ciSeq.length`
    // reads (the pre-review/fix-rung phase) and `pollSeq`'s rollups (if given) drive every read
    // after that (the pollToGate phase, which chronologically always follows). No test drives
    // both a multi-strike `ciSeq` AND a `pollSeq` at once, so this ordering is never ambiguous.
    'if (args[0] === "api" && typeof args[1] === "string" && /^repos\\/[^/]+\\/[^/]+\\/commits\\/[^/]+\\/check-runs/.test(args[1])) {',
    `  const ciSeq = ${JSON.stringify(opts.ciSeq)};`,
    `  const pollRollups = ${JSON.stringify((opts.pollSeq ?? []).map((p) => p.statusCheckRollup ?? []))};`,
    "  const f = counterDir + \"/ci\";",
    "  let seen = 0;",
    '  try { seen = parseInt(fs.readFileSync(f, "utf8") || "0", 10); } catch (e) {}',
    "  fs.writeFileSync(f, String(seen + 1));",
    "  const roll = seen < ciSeq.length || pollRollups.length === 0",
    "    ? ciSeq[Math.min(seen, ciSeq.length - 1)]",
    "    : pollRollups[Math.min(seen - ciSeq.length, pollRollups.length - 1)];",
    '  process.stdout.write(JSON.stringify({ check_runs: roll.map((c) => ({ name: c.name, status: "completed", conclusion: c.conclusion })) }));',
    "  process.exit(0);",
    "}",
    'if (args[0] === "api" && typeof args[1] === "string" && /^repos\\/[^/]+\\/[^/]+\\/commits\\/[^/]+\\/status/.test(args[1])) {',
    '  process.stdout.write(JSON.stringify({ statuses: [] }));',
    "  process.exit(0);",
    "}",
    // W1-T511/W1-T2268: `ghLiveState` (the fix rung's terminal-state reader) AND
    // `pollToGate`/`waitForCiGreen`'s own PR-row read now share this SAME
    // `repos/{o}/{r}/pulls/{n}` REST endpoint — a real GitHub reports one current state
    // regardless of which caller asks. `pollSeq`'s states drive it when given (the pollToGate
    // tests, none of which also drive the fix rung); `stateSeq` drives it otherwise (the fix
    // rung tests, none of which also reach pollToGate) — never both in the same run.
    'if (args[0] === "api" && typeof args[1] === "string" && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(args[1])) {',
    `  const pollStates = ${JSON.stringify((opts.pollSeq ?? []).map((p) => p.state))};`,
    `  const v = pollStates.length > 0 ? next("state", pollStates) : next("state", ${JSON.stringify(opts.stateSeq ?? ["OPEN"])});`,
    '  const merged = v === "MERGED";',
    '  process.stdout.write(JSON.stringify({ number: 1, state: merged ? "closed" : v.toLowerCase(), merged, merged_at: merged ? "2026-01-01T00:00:00Z" : null, head: { sha: "deadbeef" } }));',
    "  process.exit(0);",
    "}",
    // W1-T1031: the risk judge's own `changeView` reads a PR's ACTUAL changed-file list over
    // REST (`gh api repos/{o}/{r}/pulls/{n}/files`) right before its spawn — answered here
    // with an empty file list, same shape as every other fixture's generic `api` catch.
    'if (args[0] === "api" && typeof args[1] === "string" && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+\\/files/.test(args[1])) {',
    '  process.stdout.write("[]");',
    "  process.exit(0);",
    "}",
    'if (args[0] === "pr" && args[1] === "edit") { process.exit(0); }',
    'if (args[0] === "issue" && args[1] === "create") {',
    `  process.stdout.write(${JSON.stringify(opts.issueUrl ?? "https://github.com/acme/remudero/issues/1")} + "\\n");`,
    "  process.exit(0);",
    "}",
    "process.exit(1);",
    "",
  ].join("\n");
  writeFileSync(join(fakeBinDir, "gh"), script);
  chmodSync(join(fakeBinDir, "gh"), 0o755);
  return fakeBinDir;
}

test("BEHAVIORAL (W1-T268): a real runTask run that transients across every retry reaches blocked_transient carrying billing_mode + account_label off the LAST attempt, never guessed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-transient-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000010;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async () => {
    spawnCalls.push({} as SpawnWorkerArgs);
    if (spawnCalls.length === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    // Every implement attempt is a transient server_error — MAX_TRANSIENT_RETRIES
    // (3) retries, then the 4th attempt (still transient) falls to blocked_transient.
    return result({
      sessionId: "s-implement",
      apiError: true,
      subtype: "success",
      accountLabel: "acct-transient",
      childEnvKeys: [],
    });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
      }),
    );

    assert.equal(res.verdict, "blocked_transient");
    assert.equal(spawnCalls.length, 5, "recon + 4 transient implement attempts (3 retries then give up)");

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const verdict = ledger.find((l) => l.step === "verdict" && l.verdict === "blocked_transient");
    assert.ok(verdict, "the blocked_transient verdict is ledgered");
    assert.equal(verdict.billing_mode, "subscription", "no ANTHROPIC_API_KEY in childEnvKeys ⇒ subscription");
    assert.equal(verdict.account_label, "acct-transient", "the LAST transient attempt's accountLabel, never guessed");
  } finally {
    dateNowSpy.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T7B: runDiagnoseThenRetry's LIVE call site (Standing rule 14 — the call site is the
// deliverable). W1-T7 (PR #48) shipped classify.ts's classifier + state machine with ZERO call
// site in the run path, so the two-strikes DIAGNOSE dispatch was UNREACHABLE. These two
// BEHAVIORAL tests drive a REAL runTask() run (no real Claude/gh spawn — the injected `spawn`
// stands in for both, exactly like the transient test above) through two genuine strikes and
// prove the driver is actually wired: a diagnose run lands in the ledger, and the third attempt
// is diagnose-INFORMED, never blind. ──────────────────────────────────────────────────────────

test("BEHAVIORAL (W1-T7B): two real implement strikes dispatch a DIAGNOSE worker (evidence-only, model steps up) BEFORE any third patch attempt — never a third blind patch", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-diagnose-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000020;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    if (spawnCalls.length === 2 || spawnCalls.length === 3) {
      // Two REAL (deterministic, non-transient) implement failures — a strike each. Neither
      // is retried forever blind: the 2nd (DIAGNOSE_AT_STRIKES) must dispatch a DIAGNOSE
      // worker before any 3rd attempt.
      return result({
        sessionId: `s-implement-strike-${spawnCalls.length - 1}`,
        isError: true,
        subtype: "error_max_turns",
        text: "AssertionError: expected 1 to equal 2 — a real, deterministic failure",
      });
    }
    if (spawnCalls.length === 4) {
      // The evidence-only DIAGNOSE worker — never touches the diff, only reports.
      return result({
        sessionId: "s-diagnose",
        text: "DIAGNOSE REPORT\nROOT CAUSE: the assertion expects a 1-indexed count; code emits 0-indexed.\n",
      });
    }
    // The 3rd (diagnose-informed) implement attempt — a clean success with nothing committed,
    // so the run's own terminal verdict is the ordinary no_pr path, unrelated to this task.
    return result({ sessionId: "s-implement-informed", text: "REPORT\nno PR opened yet\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
      }),
    );

    assert.equal(spawnCalls.length, 5, "recon + strike 1 + strike 2 + diagnose + the diagnose-informed 3rd attempt");
    assert.equal(res.verdict, "no_pr", "the diagnose-informed 3rd attempt succeeded — nothing left to merge");

    // "never a third blind patch": the 3rd attempt's prompt must carry the diagnose worker's
    // own findings verbatim; the first two (blind) attempts carry none.
    assert.doesNotMatch(String(spawnCalls[1]?.prompt ?? ""), /DIAGNOSE FINDINGS/, "1st attempt is blind");
    assert.doesNotMatch(String(spawnCalls[2]?.prompt ?? ""), /DIAGNOSE FINDINGS/, "2nd attempt (blind retry after strike 1) is still blind");
    const thirdAttemptPrompt = String(spawnCalls[4]?.prompt ?? "");
    assert.match(thirdAttemptPrompt, /DIAGNOSE FINDINGS/, "3rd attempt must be diagnose-informed");
    assert.match(thirdAttemptPrompt, /ROOT CAUSE: the assertion expects a 1-indexed count/, "carrying the report VERBATIM");

    // "a seeded double-failure produces a diagnose run in the ledger" (acceptance #1's proof) —
    // classify.js's runDiagnoseThenRetry ledgers diagnose.spawn/diagnose.done itself; this run's
    // own diagnose worker dispatch is ledgered too (diagnose.worker_done, run-task.ts).
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(ledger.some((l) => l.step === "diagnose.spawn"), "ledger must show diagnose.spawn");
    assert.ok(ledger.some((l) => l.step === "diagnose.done"), "ledger must show diagnose.done");
    assert.ok(ledger.some((l) => l.step === "diagnose.worker_done"), "the diagnose worker's own spawn is ledgered");
    assert.equal(
      ledger.filter((l) => l.step === "implement.done").length,
      3,
      "two blind strikes + the diagnose-informed 3rd attempt — bounded, no forever-loop",
    );
  } finally {
    dateNowSpy.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL (W1-T7B): a run that never strikes twice (a clean first attempt) never dispatches DIAGNOSE at all — exactly one implement spawn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-diagnose-clean-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000021;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    return result({ sessionId: "s-implement", text: "REPORT\nno PR opened yet\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
      }),
    );

    assert.equal(res.verdict, "no_pr");
    assert.equal(spawnCalls.length, 2, "recon + exactly ONE clean implement attempt — no strike, no diagnose");

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(ledger.filter((l) => l.step === "diagnose.spawn").length, 0, "a clean run never dispatches diagnose");
    assert.equal(ledger.filter((l) => l.step === "diagnose.worker_done").length, 0);
  } finally {
    dateNowSpy.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL (W1-T7B): error_max_budget_usd is NEVER retried — dollars are the hard backstop, even inside the new diagnose-then-retry driver", async (t) => {
  // The pre-W1-T7B implement loop never spent a strike (or a diagnose dispatch) on a budget
  // breach; wiring runDiagnoseThenRetry as the live driver must not change that — a breach
  // exits the loop immediately via ImplementBudgetBreach, never reaching planRetry's strike
  // counter at all.
  const root = mkdtempSync(join(tmpdir(), "runtask-diagnose-budget-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000022;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    return result({
      sessionId: "s-implement-budget",
      isError: true,
      subtype: "error_max_budget_usd",
      numTurns: 12,
      costUsd: 3.14,
      accountLabel: "acct-budget",
      childEnvKeys: [],
    });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
      }),
    );

    assert.equal(res.verdict, "blocked_budget");
    assert.equal(spawnCalls.length, 2, "recon + exactly ONE implement attempt — a budget breach is NEVER retried");

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(ledger.filter((l) => l.step === "diagnose.spawn").length, 0, "a budget breach never dispatches diagnose");
    const verdict = ledger.find((l) => l.step === "verdict" && l.verdict === "blocked_budget");
    assert.ok(verdict, "the blocked_budget verdict is ledgered");
    assert.match(verdict.reason, /not retried/i);
  } finally {
    dateNowSpy.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL (W1-T268): a real runTask run whose implement worker commits IN-SCOPE but the REST create's own response never parses to a url reaches the 'no PR opened' failed verdict carrying billing_mode + account_label", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-noprurl-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN); // declares files: [src/lib/daemon.ts]
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000011;
  const branch = `run-T-FOLLOWUP-${FIXED_TS}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  // W1-T1202: the REST create (`gh api --method POST repos/.../pulls`) succeeds (exit 0)
  // but its JSON response carries no `html_url` — the orchestrator's parsed-response read
  // finds nothing usable, so `prUrl` stays undefined even though the push itself succeeded.
  const fakeBinDir = mkdtempSync(join(tmpdir(), "runtask-noprurl-bin-"));
  writeFileSync(
    join(fakeBinDir, "gh"),
    [
      "#!/bin/bash",
      "if [[ \"$1\" == 'api' && \"$2\" == '--method' && \"$3\" == 'POST' ]]; then echo '{\"message\":\"no url in this response\"}'; exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBinDir, "gh"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  let spawnCalls = 0;
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls++;
    if (spawnCalls === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    const g = (a: string[]) => execFileSync("git", ["-C", args.cwd, ...a], { encoding: "utf8" });
    mkdirSync(join(args.cwd, "src", "lib"), { recursive: true });
    writeFileSync(join(args.cwd, "src", "lib", "daemon.ts"), "in-scope-edit\n");
    g(["add", "."]);
    g(["commit", "--quiet", "-m", "in-scope change, no PR_URL declared"]);
    return result({ sessionId: "s-implement", accountLabel: "acct-nopr", text: "REPORT\nno PR opened yet\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
      }),
    );

    assert.equal(res.verdict, "failed");
    assert.equal(res.merged, false);
    assert.equal(res.prUrl, undefined, "the REST create's response never parsed to a url");

    // The branch DID reach origin — the push succeeded; only PR creation failed to parse.
    execFileSync("git", ["-C", join(root, "repos", "remudero"), "ls-remote", "--exit-code", "origin", branch], {
      stdio: "pipe",
    });

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const verdict = ledger.find((l) => l.step === "verdict" && l.reason === "no PR opened");
    assert.ok(verdict, "the 'no PR opened' failed verdict is ledgered");
    assert.equal(verdict.verdict, "failed");
    assert.equal(verdict.billing_mode, "subscription");
    assert.equal(verdict.account_label, "acct-nopr");
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL (W1-T268): a real runTask run whose fix rung burns every strike against a `ci` that never goes green reaches 'fix rung exhausted', ledgered with billing_mode + account_label", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-fixrung-exhausted-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000012;
  const branch = `run-T-FOLLOWUP-${FIXED_TS}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const fakeBinDir = statefulFakeGh({
    branch,
    // read #1: the OUTER pre-review ci gate (must be green to ever reach the review).
    // reads #2+: every fix-rung strike's OWN waitForCiGreen/fetchCiFailures poll —
    // stay red for both strikes (strikeCap defaults to 2), so `deps.runReview` (the
    // REAL runReview, un-injectable at this call site) is never reached.
    ciSeq: [[{ name: "ci", conclusion: "SUCCESS" }], [{ name: "ci", conclusion: "FAILURE" }]],
    stateSeq: ["OPEN"], // never terminal — no stand-down
    issueUrl: "https://github.com/acme/remudero/issues/900",
  });
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    if (spawnCalls.length === 2) {
      // Implement declares its own PR — never dereferenced beyond ownership/ci/review.
      return result({
        sessionId: "s-implement",
        accountLabel: "acct-fixrung",
        text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/500\n",
      });
    }
    // The fix rung's own strike dispatches (2, at the default strikeCap) — nothing
    // they say matters here (ci stays red every round via the fake gh above).
    return result({ sessionId: `s-fix-${spawnCalls.length}`, text: "REPORT\nfix attempted\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
        runReview: async () => fakeReview("failure", [criterion({ claim: "x", met: false })]),
      }),
    );

    assert.equal(res.verdict, "blocked");
    assert.equal(spawnCalls.length, 4, "recon, implement, and exactly 2 fix-rung strikes (the default strikeCap)");

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const verdict = ledger.find((l) => l.step === "verdict" && /fix rung exhausted/.test(String(l.reason ?? "")));
    assert.ok(verdict, "the fix-rung-exhausted blocked verdict is ledgered");
    assert.equal(verdict.billing_mode, "subscription");
    assert.equal(verdict.account_label, "acct-fixrung", "the IMPLEMENT worker's accountLabel, never the fix worker's");
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL (W1-T268): a real runTask run whose PR goes MERGED before the fix rung's FIRST strike stands down, ledgered with billing_mode + account_label", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-fixrung-stooddown-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000013;
  const branch = `run-T-FOLLOWUP-${FIXED_TS}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const fakeBinDir = statefulFakeGh({
    branch,
    ciSeq: [[{ name: "ci", conclusion: "SUCCESS" }]], // green on the outer pre-review gate
    stateSeq: ["MERGED"], // the rung's VERY FIRST terminal-state read, before any strike
    issueUrl: "https://github.com/acme/remudero/issues/901",
  });
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    return result({
      sessionId: "s-implement",
      accountLabel: "acct-stooddown",
      text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/501\n",
    });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
        runReview: async () => fakeReview("failure", [criterion({ claim: "x", met: false })]),
      }),
    );

    assert.equal(res.verdict, "blocked");
    assert.equal(spawnCalls.length, 2, "recon + implement only — the rung stood down before spending its FIRST strike");

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const verdict = ledger.find((l) => l.step === "verdict" && /stood down/.test(String(l.reason ?? "")));
    assert.ok(verdict, "the stood-down blocked verdict is ledgered");
    assert.equal(verdict.billing_mode, "subscription");
    assert.equal(verdict.account_label, "acct-stooddown");
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL (W1-T268): a real runTask run all the way to a real MERGED verdict — risk judge PROCEEDS, pollToGate reads MERGED — ledgered with billing_mode + account_label", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-merged-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000014;
  const branch = `run-T-FOLLOWUP-${FIXED_TS}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const fakeBinDir = statefulFakeGh({
    branch,
    ciSeq: [[{ name: "ci", conclusion: "SUCCESS" }]],
    pollSeq: [{ state: "MERGED" }],
  });
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    if (spawnCalls.length === 2) {
      return result({
        sessionId: "s-implement",
        accountLabel: "acct-merged",
        text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/600\n",
      });
    }
    // The risk judge's own spawn (the cheapest configured mount, resolved fresh from
    // THIS repo's real mounts.yaml) — a confident low-risk verdict PROCEEDS.
    return result({
      sessionId: "s-risk-judge",
      text: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.95\nRISK_REASON: a small, well-tested fixture change\n",
    });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
        runReview: async () => fakeReview("success", []),
      }),
    );

    assert.equal(res.verdict, "merged");
    assert.equal(res.merged, true);
    assert.equal(
      spawnCalls.length,
      3,
      "recon, implement, and the risk judge — no fix rung, no reviewer LLM spawn (review was injected)",
    );

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const verdict = ledger.find((l) => l.step === "verdict" && l.verdict === "merged");
    assert.ok(verdict, "the merged verdict is ledgered");
    assert.equal(verdict.billing_mode, "subscription");
    assert.equal(verdict.account_label, "acct-merged", "the IMPLEMENT worker's accountLabel, never the risk judge's");
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL (W1-T382): a real runTask run whose merge poll never moves reaches blocked_ci via pollToGate's OWN stall branch, naming the still-pending check", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-pollgate-stall-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000015;
  const branch = `run-T-FOLLOWUP-${FIXED_TS}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  // `pollSeq`'s single entry repeats forever (statefulFakeGh's own per-field counter) —
  // the PR sits OPEN with `ci` still IN_PROGRESS on every read, byte-identical, so
  // `pollToGate`'s OWN checkWaitStalled integration (not just the pure predicate,
  // covered separately in test/check-wait-progress.test.ts) must conclude stalled after
  // STALL_WINDOW consecutive polls and return blocked, never merged.
  const fakeBinDir = statefulFakeGh({
    branch,
    ciSeq: [[{ name: "ci", conclusion: "SUCCESS" }]],
    pollSeq: [{ state: "OPEN", statusCheckRollup: [{ name: "ci", conclusion: "IN_PROGRESS" }] }],
  });
  // pollToGate's own poll cadence (everySec, not injectable from a runTask caller) is real
  // seconds — stub `sleep` too so this test costs no wall-clock time instead of
  // (STALL_WINDOW - 1) * 6s of real waiting.
  writeFileSync(join(fakeBinDir, "sleep"), ["#!/bin/bash", "exit 0", ""].join("\n"));
  chmodSync(join(fakeBinDir, "sleep"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    if (spawnCalls.length === 2) {
      return result({
        sessionId: "s-implement",
        accountLabel: "acct-pollstall",
        text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/601\n",
      });
    }
    return result({
      sessionId: "s-risk-judge",
      text: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.95\nRISK_REASON: a small, well-tested fixture change\n",
    });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
        runReview: async () => fakeReview("success", []),
      }),
    );

    assert.equal(res.verdict, "blocked_ci", "a merge poll that never moves must never resolve as merged");
    assert.equal(res.merged, false);

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const stalledLog = ledger.find((l) => l.step === "pr.stalled");
    assert.ok(stalledLog, "pollToGate's stall branch must itself log pr.stalled, not just return silently");
    assert.deepEqual(stalledLog.pending, ["ci"], "names the check that was still pending, not just STALL_WINDOW elapsed");
    const verdict = ledger.find((l) => l.step === "verdict" && l.verdict === "blocked_ci");
    assert.ok(verdict, "the blocked_ci verdict is ledgered");
    assert.match(
      verdict.reason,
      new RegExp(`no progress for ${STALL_WINDOW} consecutive polls`),
      "the blocked reason names the stall, never an elapsed-poll count",
    );
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL (recon-GK): a real runTask run whose fetchPrBody THROWS falls back to the worker's REPORT text for the implementation review, ledgers review.body_fetch_error, and still reaches a MERGED verdict", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-bodyfetcherr-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000016;
  const branch = `run-T-FOLLOWUP-${FIXED_TS}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const fakeBinDir = statefulFakeGh({
    branch,
    ciSeq: [[{ name: "ci", conclusion: "SUCCESS" }]],
    pollSeq: [{ state: "MERGED" }],
  });
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  const IMPLEMENT_TEXT = "REPORT\nWORKER-CHAT-FALLBACK-TEXT\nPR_URL: https://github.com/acme/remudero/pull/602\n";
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    if (spawnCalls.length === 2) {
      return result({ sessionId: "s-implement", accountLabel: "acct-bodyfetcherr", text: IMPLEMENT_TEXT });
    }
    return result({
      sessionId: "s-risk-judge",
      text: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.95\nRISK_REASON: a small, well-tested fixture change\n",
    });
  };

  const reviewReports: string[] = [];

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
        fetchPrBody: async () => {
          throw new Error("gh pr view unavailable");
        },
        runReview: async (args) => {
          reviewReports.push(args.report);
          return fakeReview("success", []);
        },
      }),
    );

    assert.equal(res.verdict, "merged", "a throwing fetchPrBody must never block the run — it degrades, not crashes");
    assert.equal(res.merged, true);
    assert.equal(reviewReports.length, 1);
    assert.match(
      reviewReports[0],
      /WORKER-CHAT-FALLBACK-TEXT/,
      "the review must fall back to the worker's REPORT text when fetchPrBody throws",
    );

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const fetchErr = ledger.find((l) => l.step === "review.body_fetch_error");
    assert.ok(fetchErr, "the throwing fetchPrBody must be ledgered, not silently swallowed");
    assert.match(String(fetchErr.error ?? ""), /gh pr view unavailable/);
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL (W1-T268): a real runTask run past the risk judge whose FINAL poll reads a red required check reaches the terminal (post-poll) blocked_ci verdict, ledgered with billing_mode + account_label", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "runtask-blockedci-final-root-"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FOLLOWUP_FIXTURE_PLAN);
  const config: Config = { claudeBin: "/bin/true", root };
  followupGitFixture(root);

  const FIXED_TS = 1785000000015;
  const branch = `run-T-FOLLOWUP-${FIXED_TS}`;
  const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);

  const fakeBinDir = statefulFakeGh({
    branch,
    ciSeq: [[{ name: "ci", conclusion: "SUCCESS" }]],
    pollSeq: [{ state: "OPEN", statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] }],
  });
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls.push(args);
    if (spawnCalls.length === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    if (spawnCalls.length === 2) {
      return result({
        sessionId: "s-implement",
        accountLabel: "acct-blockedci-final",
        text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/601\n",
      });
    }
    return result({
      sessionId: "s-risk-judge",
      text: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.95\nRISK_REASON: a small, well-tested fixture change\n",
    });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-FOLLOWUP", {
        skipGitSync: true,
        planPath,
        config,
        github: FOLLOWUP_OFFLINE_GITHUB,
        spawn,
        containmentExec: followupHoldingContainmentExec,
        isolationExec: followupCleanIsolationExec,
        runReview: async () => fakeReview("success", []),
      }),
    );

    assert.equal(res.verdict, "blocked_ci");
    assert.equal(res.merged, false);

    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const verdict = ledger.find(
      (l) => l.step === "verdict" && l.verdict === "blocked_ci" && /required check red/.test(String(l.reason ?? "")),
    );
    assert.ok(verdict, "the terminal (post-poll) blocked_ci verdict is ledgered — distinct from the pre-review one");
    assert.equal(verdict.billing_mode, "subscription");
    assert.equal(verdict.account_label, "acct-blockedci-final");
  } finally {
    dateNowSpy.mock.restore();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
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

test("ACCEPTANCE (criterion 4, unit slice): materializeReviewWorktree fetches, adds a worktree at origin/<headRefName>, then reads its tip — returning a path under worktreesDir(config) when the tip matches the PR head", () => {
  const config = drainFixtureConfig();
  const calls: string[] = [];
  const deps: ReviewWorktreeDeps = {
    fetch: (repoDir) => calls.push(`fetch:${repoDir}`),
    addWorktree: (repoDir, worktreePath, branch) => calls.push(`add:${repoDir}:${worktreePath}:${branch}`),
    revParseHead: (worktreePath) => {
      calls.push(`rev-parse:${worktreePath}`);
      return "cafef00d";
    },
  };
  const result = materializeReviewWorktree(config, "/repo", 411, "run-W1-T185-123", "cafef00d", deps);
  const path = result.worktreePath;
  assert.ok(path, "materialization reports success");
  assert.equal(result.failure, undefined, "a success carries no failure");
  assert.ok(path!.startsWith(join(config.root, "worktrees")), "path lives under worktreesDir(config)");
  assert.ok(path!.includes("review-PR411-"), "path is scoped to the PR number");
  assert.deepEqual(calls, [`fetch:/repo`, `add:/repo:${path}:run-W1-T185-123`, `rev-parse:${path}`]);
});

test("materializeReviewWorktree returns a NAMED fetch-failure reason (never throws) when fetch fails — network unavailable is a FALLBACK trigger, not a crash", () => {
  const config = drainFixtureConfig();
  const deps: ReviewWorktreeDeps = {
    fetch: () => {
      throw new Error("network unreachable");
    },
    addWorktree: () => assert.fail("addWorktree must not be reached when fetch already failed"),
    revParseHead: () => assert.fail("revParseHead must not be reached when fetch already failed"),
  };
  const result = materializeReviewWorktree(config, "/repo", 391, "some-branch", "cafef00d", deps);
  assert.equal(result.worktreePath, undefined);
  assert.equal(result.failure?.errorClass, "fetch-failure");
  assert.equal(result.failure?.message, "network unreachable");
});

test("materializeReviewWorktree returns a NAMED (\"other\") reason (never throws) when the worktree add fails — a detached/deleted head is a FALLBACK trigger, not a crash", () => {
  const config = drainFixtureConfig();
  const deps: ReviewWorktreeDeps = {
    fetch: () => {},
    addWorktree: () => {
      throw new Error("fatal: invalid reference: origin/deleted-branch");
    },
    revParseHead: () => assert.fail("revParseHead must not be reached when addWorktree already failed"),
  };
  const result = materializeReviewWorktree(config, "/repo", 397, "deleted-branch", "cafef00d", deps);
  assert.equal(result.worktreePath, undefined);
  assert.equal(result.failure?.errorClass, "other");
  assert.match(result.failure?.message ?? "", /deleted-branch/);
});

test("materializeReviewWorktree classifies a worktree-collision distinctly from other add failures, by the git error text", () => {
  const config = drainFixtureConfig();
  const deps: ReviewWorktreeDeps = {
    fetch: () => {},
    addWorktree: () => {
      throw new Error("fatal: 'held-branch' is already used by worktree at '/repo/../holding-worktree'");
    },
    revParseHead: () => assert.fail("revParseHead must not be reached when addWorktree already failed"),
  };
  const result = materializeReviewWorktree(config, "/repo", 398, "held-branch", "cafef00d", deps);
  assert.equal(result.worktreePath, undefined);
  assert.equal(result.failure?.errorClass, "worktree-collision");
});

// W1-T233, acceptance criterion 1: "an injected failure occurring AFTER
// worktree creation leaves zero new worktrees registered" — a step-2-class
// throw (addWorktree succeeds, then revParseHead fails) must clean up the
// worktree addWorktree already registered, not strand it (the 39-leaked-
// worktree defect: withMaterializedWorktree's own teardown never runs here,
// because this function never returns a path for it to key on).
test("W1-T233 (criterion 1): a failure AFTER worktree creation (revParseHead throws) removes the just-created worktree before returning the named failure", () => {
  const config = drainFixtureConfig();
  const removeCalls: string[] = [];
  const deps: ReviewWorktreeDeps = {
    fetch: () => {},
    addWorktree: () => {},
    revParseHead: () => {
      throw new Error("fatal: not a git repository");
    },
    removeWorktree: (repoDir, worktreePath) => removeCalls.push(`${repoDir}:${worktreePath}`),
  };
  const result = materializeReviewWorktree(config, "/repo", 399, "some-branch", "cafef00d", deps);
  assert.equal(result.worktreePath, undefined);
  assert.equal(result.failure?.errorClass, "other");
  assert.match(result.failure?.message ?? "", /not a git repository/);
  assert.equal(removeCalls.length, 1, "the worktree step 1 created is torn down exactly once");
  assert.ok(removeCalls[0].startsWith("/repo:"), "cleanup targets the SAME repoDir/worktreePath step 1 used");
});

test("W1-T233: a fetch failure never attempts a removal — nothing was created for step 1 to have registered", () => {
  const config = drainFixtureConfig();
  const removeCalls: string[] = [];
  const deps: ReviewWorktreeDeps = {
    fetch: () => {
      throw new Error("network unreachable");
    },
    addWorktree: () => assert.fail("addWorktree must not be reached when fetch already failed"),
    revParseHead: () => assert.fail("revParseHead must not be reached when fetch already failed"),
    removeWorktree: (repoDir, worktreePath) => removeCalls.push(`${repoDir}:${worktreePath}`),
  };
  materializeReviewWorktree(config, "/repo", 400, "some-branch", "cafef00d", deps);
  assert.deepEqual(removeCalls, []);
});

test("W1-T233: a removal failure during cleanup is swallowed (logged), never masking the original materialization failure it was cleaning up after", () => {
  const config = drainFixtureConfig();
  const originalConsoleError = console.error;
  const errors: string[] = [];
  console.error = (msg: string) => errors.push(msg);
  try {
    const deps: ReviewWorktreeDeps = {
      fetch: () => {},
      addWorktree: () => {},
      revParseHead: () => {
        throw new Error("original failure: rev-parse exploded");
      },
      removeWorktree: () => {
        throw new Error("removal also failed");
      },
    };
    const result = materializeReviewWorktree(config, "/repo", 401, "some-branch", "cafef00d", deps);
    assert.equal(result.worktreePath, undefined);
    assert.match(result.failure?.message ?? "", /original failure: rev-parse exploded/);
    assert.ok(
      errors.some((e) => /removal also failed/.test(e)),
      "the removal failure is still surfaced somewhere (console), not silently dropped",
    );
  } finally {
    console.error = originalConsoleError;
  }
});

// W1-T232, acceptance: "a tip mismatch after fetch fails materialization loudly
// rather than reviewing stale code" — a stale fetch or a moved ref must never
// degrade to the ordinary keyword-only fallback; it must THROW, uncaught, so
// `reviewCommand` posts no verdict at all rather than a false one.
test("materializeReviewWorktree THROWS (does not return undefined) when the materialized tip does not match the PR head SHA — a stale fetch must fail loudly, never quietly review the wrong tree", () => {
  const config = drainFixtureConfig();
  const deps: ReviewWorktreeDeps = {
    fetch: () => {},
    addWorktree: () => {},
    revParseHead: () => "stale0ld",
  };
  assert.throws(
    () => materializeReviewWorktree(config, "/repo", 402, "moved-branch", "cafef00d", deps),
    /stale0ld.*cafef00d|cafef00d.*stale0ld/s,
  );
});

// W1-T233 (criterion 1 also covers the THROW path): a tip-mismatch throw is
// not an "ordinary" failure, but the worktree it discards was created just as
// really — it must be torn down before the throw, too.
test("W1-T233: a tip-mismatch throw ALSO removes the just-created worktree before throwing — the discarded tree never strands either", () => {
  const config = drainFixtureConfig();
  const removeCalls: string[] = [];
  const deps: ReviewWorktreeDeps = {
    fetch: () => {},
    addWorktree: () => {},
    revParseHead: () => "stale0ld",
    removeWorktree: (repoDir, worktreePath) => removeCalls.push(`${repoDir}:${worktreePath}`),
  };
  assert.throws(() => materializeReviewWorktree(config, "/repo", 403, "moved-branch", "cafef00d", deps));
  assert.equal(removeCalls.length, 1, "the mismatched worktree is torn down exactly once before the throw");
});

// W1-T233, acceptance criterion 2: "the verdict description and the
// review.posted record name the error class and message verbatim" — these two
// pure helpers are what `runReview` composes both surfaces through, so a unit
// test on them IS a unit test on what gets posted/ledgered, without spawning
// `gh`/a reviewer.
test("W1-T233 (criterion 2): reviewPostedDescription appends the error class + message VERBATIM to a CAPPED verdict's description", () => {
  const verdict = { summary: "remudero-review: CAPPED — 0/3 proofs executed", capped: true };
  const failure = { errorClass: "worktree-collision" as const, message: "fatal: 'x' is already used by worktree at '/y'" };
  const description = reviewPostedDescription(verdict, failure);
  assert.match(description, /^remudero-review: CAPPED — 0\/3 proofs executed/);
  assert.match(description, /worktree-collision/);
  assert.match(description, /fatal: 'x' is already used by worktree at '\/y'/);
});

test("W1-T233: reviewPostedDescription leaves the summary UNCHANGED when the verdict is not capped, even with a materialization failure present", () => {
  const verdict = { summary: "remudero-review: PASS", capped: false };
  const failure = { errorClass: "fetch-failure" as const, message: "network unreachable" };
  assert.equal(reviewPostedDescription(verdict, failure), "remudero-review: PASS");
});

test("W1-T233: reviewPostedDescription leaves the summary UNCHANGED when there is no materialization failure at all (capped for an unrelated reason)", () => {
  const verdict = { summary: "remudero-review: CAPPED — 0/3 proofs executed", capped: true };
  assert.equal(reviewPostedDescription(verdict, undefined), "remudero-review: CAPPED — 0/3 proofs executed");
});

// W1-T70, 4th instance of the first-match parser class: `rmd review` used to
// extract `Remudero-Task:` with an UNANCHORED, first-match regex, so a PR body
// quoting the trailer format mid-prose (increasingly common on plan/ratify
// PRs, which routinely discuss the trailer contract itself) was captured
// ahead of the genuine, final trailer line. reviewTaskIdFromBody replaces it
// with the W1-T62 discipline (anchoredPrUrl's idiom): line-anchored, last-
// line-wins.
test("W1-T70 (acceptance 1): a body quoting a valid-looking trailer mid-prose with the genuine trailer as the last line extracts the genuine id (the #119 shape)", () => {
  const body = [
    "## Summary",
    "This PR files a plan task. Note the contract requires a line reading",
    "'Remudero-Task: W1-T20c' as the final trailer, per the worker prompt.",
    "",
    "Remudero-Task: W1-T70",
  ].join("\n");
  assert.equal(reviewTaskIdFromBody(body), "W1-T70");
});

test("W1-T70 (acceptance 2): a body with ONLY mid-prose quotations (no anchored trailer line) extracts nothing", () => {
  const body = [
    "## Summary",
    "The contract says to write 'Remudero-Task: W1-T20c' as the last line, but",
    "this manual plan PR intentionally carries no trailer of its own.",
  ].join("\n");
  assert.equal(reviewTaskIdFromBody(body), undefined);
});

test("W1-T70 (acceptance 3): the plain contract case (trailer as the last line, nothing else mentioning it) is unchanged", () => {
  const body = ["## Summary", "Implements the thing.", "", "Remudero-Task: W1-T1D"].join("\n");
  assert.equal(reviewTaskIdFromBody(body), "W1-T1D");
});

test("W1-T70: multiple anchored trailer lines — the LAST one wins, per the contract's own phrasing", () => {
  const body = ["Remudero-Task: W1-T1", "some notes", "Remudero-Task: W1-T2"].join("\n");
  assert.equal(reviewTaskIdFromBody(body), "W1-T2");
});

test("W1-T70: a trailing-whitespace trailer line still matches (anchored on trimmed content, not exact EOL)", () => {
  const body = "Remudero-Task: W1-T70   ";
  assert.equal(reviewTaskIdFromBody(body), "W1-T70");
});

test("W1-T70: an empty body extracts nothing", () => {
  assert.equal(reviewTaskIdFromBody(""), undefined);
});

// W1-T70 (end-to-end): `reviewCommand` itself is where the bug actually lived — the pure
// `reviewTaskIdFromBody` fixture above proves the REGEX is right, but not that `rmd review`
// ever calls it correctly. `reviewCommand`'s injectable `deps` (fetchView/loadConfig/
// materialize/runReview) let this drive the REAL taskId/criteria-resolution codepath, the
// ledger writes, and the console/override wiring downstream of it, without a live `gh` auth,
// a real `~/.config/remudero/config.json` touch, or a worktree/LLM spawn.
test("W1-T70 (end-to-end): reviewCommand resolves the LAST-LINE trailer id (not a mid-prose quote) and threads it to runReview's task.id and the ledger", async () => {
  const body = [
    "## Summary",
    "This PR files a plan task. Note the contract requires a line reading",
    "'Remudero-Task: W1-T20c' as the final trailer, per the worker prompt.",
    "",
    "Remudero-Task: W1-T70",
  ].join("\n");
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-review-e2e-"));
  // W1-T913: REST-SHAPED (`html_url`/`head.{ref,sha}`/`updated_at`), not the gh-cli shape this
  // fixture carried before — `prArg` ("999") is bare-numeric, so `reviewCommand` takes the REST
  // arm (`reviewPrNumber` resolves it) and runs this raw row through `mapRestPr`, which reads
  // exactly these REST field names. Before this task nothing downstream synchronously
  // dereferenced the mapped `url`/`headRefOid`/`headRefName` in a way a wrong-shaped fixture would
  // surface; `postReviewPending`'s own `fetchLifecycle` (reviewCommand's new pending-post call)
  // is the first thing that does, which is what caught this fixture/production shape mismatch.
  const view = {
    body,
    html_url: "https://github.com/acme/remudero/pull/999",
    head: { ref: "run-W1-T70-e2e", sha: "deadbeefcafe" },
    updated_at: new Date(0).toISOString(),
    number: 999,
  };
  let seenTaskId: string | undefined;
  const exitCode = await reviewCommand("999", ["--override-capped-by", "op", "--override-capped-reason", "manual"], {
    fetchView: () => view,
    loadConfig: () => ({ claudeBin: "/bin/true", root: configRoot }) as Config,
    materialize: () => ({
      worktreePath: undefined,
      failure: { errorClass: "fetch-failure", message: "e2e fixture: never actually attempted" },
    }),
    runReview: async (args) => {
      seenTaskId = args.task.id;
      return { ...fakeReview("success", []), capped: true };
    },
  });
  // The genuine LAST line ("W1-T70"), never the mid-prose quotation ("W1-T20c").
  assert.equal(seenTaskId, "W1-T70");
  assert.equal(exitCode, 0);
  const ledgerLines = readFileSync(join(configRoot, "state", "ledger.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const overrideLine = ledgerLines.find((l) => l.step === "automerge.capped_override_granted");
  assert.equal(overrideLine?.task_id, "W1-T70");
});

test("W1-T233 (criterion 2): degradedReasonLedgerFields names the error class and message verbatim for the review.posted ledger line", () => {
  const failure = { errorClass: "fetch-failure" as const, message: "network unreachable" };
  assert.deepEqual(degradedReasonLedgerFields(failure), {
    degraded_reason: "network unreachable",
    degraded_reason_class: "fetch-failure",
  });
});

test("W1-T233: degradedReasonLedgerFields yields both fields undefined (absent once ledgered) when materialization was never attempted", () => {
  const fields = degradedReasonLedgerFields(undefined);
  assert.equal(fields.degraded_reason, undefined);
  assert.equal(fields.degraded_reason_class, undefined);
});

test("ACCEPTANCE (criterion 4, full chain): an operator-path review over a PR whose proofs are executable reports a NON-EMPTY executed set — materialize -> headCheckoutDir -> judgeReview EXECUTES, exactly the fix rung's own wiring for the same PR/proofs", () => {
  const config = drainFixtureConfig();
  // `addWorktree` here plays the role `git worktree add` really does: it
  // makes the PR head's CONTENT show up on disk at `worktreePath`, DETACHED
  // (W1-T232: no `checkout -B` — nothing downstream needs a branch name).
  // Faking the git calls (never touching real git/network — this environment
  // has neither) while keeping the FILESYSTEM EFFECT real is what lets
  // `judgeReview`'s whitelisted executor genuinely run against it below.
  const deps: ReviewWorktreeDeps = {
    fetch: () => {},
    addWorktree: (_repoDir, worktreePath) => {
      mkdirSync(worktreePath, { recursive: true });
      writeFileSync(join(worktreePath, "fixture.txt"), "REMUDERO_W1_T185_MARKER\n");
    },
    revParseHead: () => "cafef00d",
  };
  const worktreePath = materializeReviewWorktree(config, "/repo", 411, "run-W1-T185-fixture", "cafef00d", deps)
    .worktreePath;
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

// W1-T232: real-git integration tests — no faked git deps — proving the
// DEFAULT `realReviewWorktreeDeps` (not just an injected fixture) actually
// produces a detached worktree, never collides with another worktree already
// holding the branch, and still executes proofs there (detached parity).

test("W1-T232: realReviewWorktreeDeps.addWorktree yields a DETACHED worktree at the branch tip (proof there is no checkout -B, which would leave HEAD symbolic)", () => {
  const { localDir } = gitFixture();
  execFileSync("git", ["-C", localDir, "checkout", "-q", "-b", "feature-x"]);
  writeFileSync(join(localDir, "plan", "feature.txt"), "on the feature branch\n", "utf8");
  execFileSync("git", ["-C", localDir, "add", "."]);
  execFileSync("git", ["-C", localDir, "commit", "--quiet", "-m", "feature work"]);
  execFileSync("git", ["-C", localDir, "push", "--quiet", "origin", "feature-x"]);
  const headSha = execFileSync("git", ["-C", localDir, "rev-parse", "feature-x"], { encoding: "utf8" }).trim();

  const config = drainFixtureConfig();
  const worktreePath = materializeReviewWorktree(config, localDir, 500, "feature-x", headSha).worktreePath;
  assert.ok(worktreePath, "materialization succeeded against real git");
  try {
    // `checkout -B <branch>` would leave HEAD as a SYMBOLIC ref to
    // refs/heads/<branch>; a plain `worktree add origin/<branch>` leaves it
    // DETACHED, so `symbolic-ref HEAD` has nothing to resolve and errors.
    assert.throws(() => execFileSync("git", ["-C", worktreePath!, "symbolic-ref", "-q", "HEAD"], { stdio: "pipe" }));
    assert.equal(
      execFileSync("git", ["-C", worktreePath!, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      headSha,
    );
  } finally {
    execFileSync("git", ["-C", localDir, "worktree", "remove", "--force", worktreePath!]);
  }
});

test("W1-T232: materialization SUCCEEDS (no collision) while another real worktree already holds the PR's branch — the exact defect this task removes", () => {
  const { localDir } = gitFixture();
  execFileSync("git", ["-C", localDir, "checkout", "-q", "-b", "held-branch"]);
  // At the repo ROOT, not under plan/ — the grep proof's recursive default
  // excludes plan/ (W1-T72, to keep a proof from self-matching its own
  // description in plan/tasks.yaml), and this test passes an explicit
  // "in held.txt" path resolved relative to the checkout root.
  writeFileSync(join(localDir, "held.txt"), "held elsewhere\n", "utf8");
  execFileSync("git", ["-C", localDir, "add", "."]);
  execFileSync("git", ["-C", localDir, "commit", "--quiet", "-m", "held work"]);
  execFileSync("git", ["-C", localDir, "push", "--quiet", "origin", "held-branch"]);
  const headSha = execFileSync("git", ["-C", localDir, "rev-parse", "held-branch"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", localDir, "checkout", "-q", "main"]);

  // Seed a SECOND worktree that already holds `held-branch` — this is exactly
  // what made every operator-lane `checkout -B` collide on 2026-07-21.
  const holdingWorktree = join(localDir, "..", "holding-worktree");
  execFileSync("git", ["-C", localDir, "worktree", "add", holdingWorktree, "held-branch"]);

  const config = drainFixtureConfig();
  let worktreePath: string | undefined;
  try {
    worktreePath = materializeReviewWorktree(config, localDir, 501, "held-branch", headSha).worktreePath;
    assert.ok(worktreePath, "materialization succeeds even though another worktree holds the branch");

    const criteria = [{ claim: "the held marker is present", proof: "grep: held elsewhere in held.txt" }];
    const v = judgeReview(criteria, { diff: "", report: "unrelated", headCheckoutDir: worktreePath });
    assert.equal(v.criteria[0].proof_exec, "executed_pass");
    assert.equal(v.keywordOnly, false, "no collision means no keyword-only fallback");
    assert.equal(v.capped, false);
  } finally {
    if (worktreePath) execFileSync("git", ["-C", localDir, "worktree", "remove", "--force", worktreePath]);
    execFileSync("git", ["-C", localDir, "worktree", "remove", "--force", holdingWorktree]);
  }
});

test("W1-T232: a stale origin ref (materialized tip != PR head SHA) throws loudly through real git too — no verdict would ever be posted", () => {
  const { localDir } = gitFixture();
  execFileSync("git", ["-C", localDir, "checkout", "-q", "-b", "moving-branch"]);
  execFileSync("git", ["-C", localDir, "push", "--quiet", "origin", "moving-branch"]);
  execFileSync("git", ["-C", localDir, "checkout", "-q", "main"]);

  const config = drainFixtureConfig();
  // Claim a PR head SHA that does NOT match what's actually on origin/moving-branch —
  // simulating a fetch that raced a force-push/rebase after the PR view was read.
  assert.throws(() => materializeReviewWorktree(config, localDir, 502, "moving-branch", "0000000000000000000000000000000000000000"));
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

test("syncPlanFromOrigin: a shard-only task under origin/main's plan/tasks.d/ is NOT shard-blind — it dispatches alongside the monolith", () => {
  const { originDir, localDir } = gitFixture();
  mkdirSync(join(originDir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(
    join(originDir, "plan", "tasks.d", "T2-shard.yaml"),
    "- id: T2\n  title: \"SHARD-ONLY\"\n  repo: remudero\n  type: implement\n",
    "utf8",
  );
  execFileSync("git", ["-C", originDir, "add", "."]);
  execFileSync("git", ["-C", originDir, "commit", "--quiet", "-m", "add shard"]);

  const { plan, staleDispatch } = syncPlanFromOrigin(localDir, "plan/tasks.yaml");

  assert.equal(staleDispatch, false);
  const ids = plan.tasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ["T1", "T2"], "both the monolith task and the tasks.d/ shard task must be visible");
  assert.equal(plan.byId.get("T2")?.title, "SHARD-ONLY");
});

test("syncPlanFromOrigin: no plan/tasks.d/ at origin/main is a plain no-shards case, not an error", () => {
  const { localDir } = gitFixture(); // origin never gets a tasks.d/ directory
  const { plan, staleDispatch } = syncPlanFromOrigin(localDir, "plan/tasks.yaml");
  assert.equal(staleDispatch, false);
  assert.deepEqual(plan.tasks.map((t) => t.id), ["T1"]);
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

/**
 * Build a `ReviewVerdict` (+ the runReview augmentation) from a criteria list.
 * `headSha` defaults to a fixed placeholder for tests that never dispatch more
 * than one real strike; a test that models MULTIPLE genuine fix-worker
 * attempts (a real commit landing each round, W1-T168) must pass a DISTINCT
 * `headSha` per round — see {@link detectReviewFalseBlock}, which reads an
 * UNCHANGED head sha across rounds as "no diff change".
 */
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

// ── W1-T226 (corrects W1-T224's overstated diagnosis — see the task's own
// rationale). VERIFIED AT SOURCE, three named fixtures from the seven-PR jam:
//   - PR 449 (posted remudero-review=failure, checks red): the rung still
//     chose ci-log, PROVING `evidence.review` is the rung's OWN computed
//     evidence for a pass, never the posted commit status — DISPOSITION_RULES
//     row 5 (`isBlockedCi`, sweep.ts) and `routeFix`'s dispatch both key off
//     `checksState`, never `reviewState`, when deciding whether to construct
//     `evidence.ciFailures` at all (see the `routeFix` test below). NOT masked.
//   - PR 479 (review-failed AND CI-red) / PR 485 (CI-red, review
//     success-capped): by the time these were observed, W1-T138 (PR #345,
//     merged BEFORE this task or W1-T224 was even filed — `git log` shows
//     e306b33/cc8abe4 predating db37cb6/a9ef3b9) had already made
//     `DISPOSITION_RULES` and `routeFix`/`runSweep`'s `dispatchFix` pick
//     `ciFailures`-only evidence whenever `isBlockedCi(pr)`, regardless of
//     `reviewState` — so neither fixture's shape is reproducible through
//     those callers today (branch (a) NEVER DISPATCHED does not apply either:
//     `deriveDisposition` positively routes a review-failed+CI-red PR to
//     `blocked-fixable` via row 5, ordered ahead of the review-failing rows).
//     The mask these two fixtures name is real, but it lived ONE LAYER DEEPER
//     than the callers: in `FIX_MODE_RULES` itself (branch (c), confirmed).
//     Every caller above avoids ever exercising it only by a DISCIPLINE of
//     constructing `review`/`ciFailures` mutually exclusively — the table's
//     own `when` predicate, gated on `review === undefined`, would still
//     mis-route the moment ANY evidence carried both (which the two-line
//     `FixEvidence` type always allowed) — exactly this test. This is why the
//     proof lives here, at the table, rather than only at `routeFix`.
//   - Branch (b) UNABLE TO ACT (flake) is orthogonal to the mask and is not
//     itself demonstrated by any of the three named fixtures here; it neither
//     strengthens nor weakens this correction — W1-T224's flake-disposition
//     criterion (bounded re-runs before a code fix) stands unchanged, per the
//     task's own design note, and is untouched by this diff. ─────────────────

test("deriveFixMode: a PR that is BOTH review-failed (real unmet criteria) AND CI-red derives ci-log, never reviewer-unmet — PR 479's shape, the W1-T226 mask closed at the table itself", () => {
  const evidence: FixEvidence = {
    review: {
      unmetCriteria: [criterion({ claim: "criterion A merges cleanly", met: false, reason: "executed and failed: assertion mismatch" })],
      summary: "remudero-review: FAIL",
    },
    ciFailures: [{ name: "commitlint", logTail: "header must not exceed 100 characters" }],
  };
  assert.equal(
    deriveFixMode(evidence),
    "ci-log",
    "a required check red outranks ANY review verdict sitting beside it — pass, fail, or (as here) a real unmet set",
  );
});

test("deriveFixMode: CI-red still outranks a body-coverage-shaped review (matched N/M proof keywords, no executed_fail) — PR 485's shape, review success-capped alongside CI-red", () => {
  const evidence: FixEvidence = {
    review: {
      unmetCriteria: [
        criterion({ claim: "criterion A is documented", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
      ],
      summary: "remudero-review: CAPPED",
    },
    ciFailures: [{ name: "osv-scanner", logTail: "HIGH severity vulnerability found in dep@1.2.3" }],
  };
  assert.equal(deriveFixMode(evidence), "ci-log", "a red required check wins over EVERY review-shaped row, not only reviewer-unmet");
});

test("deriveFixMode: THE REGRESSION GUARD survives the table change — an OBSERVED executed_fail, with no ciFailures at all, is still never body-coverage (the #157/#143 lesson, unaffected by W1-T226)", () => {
  const evidence: FixEvidence = {
    review: {
      unmetCriteria: [
        criterion({ claim: "criterion A is documented", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
        criterion({ claim: "criterion B runs", met: false, reason: "executed and failed", proof_exec: "executed_fail" }),
      ],
      summary: "remudero-review: FAIL",
    },
  };
  assert.equal(deriveFixMode(evidence), "reviewer-unmet");
});

test("renderFixPrompt: a PR that is BOTH review-failed AND CI-red renders the ci-log remedy (naming the failing check), never the review's unmet-criteria text, and never falsely claims no review has run", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: {
      review: {
        unmetCriteria: [criterion({ claim: "criterion A merges cleanly", met: false, reason: "executed and failed: assertion mismatch" })],
        summary: "remudero-review: FAIL",
      },
      ciFailures: [{ name: "commitlint", logTail: "header must not exceed 100 characters" }],
    },
  });
  assert.match(prompt, /MODE: ci-log/, "reaches a remedy for the failing CHECK, not a criteria-shaped mode");
  assert.match(prompt, /check: commitlint/);
  assert.match(prompt, /header must not exceed 100 characters/);
  assert.doesNotMatch(prompt, /criterion A merges cleanly/, "the review's unmet-criteria text never rides the ci-log prompt — one remedy, not a mix");
  assert.doesNotMatch(prompt, /NO review has run yet/i, "a review verdict DOES exist here beside the red check — the prompt must never claim otherwise");
  assert.match(prompt, /GitHub will not merge past a red required check/, "the prompt still explains WHY the check wins over any review verdict beside it");
});

// W1-T106 (the #170 DIRTY strand): fixture merge-conflict evidence — a
// pure-concurrent-addition conflict, both sides' log since merge-base.
function mergeConflictFixture(): MergeConflictEvidence {
  return {
    files: [{ path: "src/x.ts", oursDeleted: 0, theirsDeleted: 0 }],
    oursLog: "abc1234 add entry A",
    theirsLog: "def5678 add entry B",
  };
}

test("deriveFixMode: a conflicted dispatch (evidence.mergeConflict set, no review verdict) derives merge-conflict — checked BEFORE ci-log even though `review` is undefined on both", () => {
  const evidence: FixEvidence = { mergeConflict: mergeConflictFixture() };
  assert.equal(deriveFixMode(evidence), "merge-conflict");
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

// W1-T106 acceptance 2 — dedicated proof: "the rendered prompt names the mode,
// the conflicting files, and the union-with-merge-base discipline."
test("renderFixPrompt: merge-conflict mode names the mode, the conflicting file(s), and the union-with-merge-base discipline (never a review/ci-log mix)", () => {
  const mergeConflict = mergeConflictFixture();
  const prompt = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: { mergeConflict },
  });
  assert.match(prompt, /MODE: merge-conflict/, "the rendered prompt names its derived mode");
  assert.match(prompt, /src\/x\.ts/, "names the conflicting file");
  assert.match(prompt, /UNION/i, "states the union-toward-both-sides discipline");
  assert.match(prompt, /merge-base/i, "states the merge-base analysis it must be gated on");
  assert.match(prompt, /PURE CONCURRENT ADDITION/i, "names the safe-to-resolve condition");
  assert.match(prompt, /REFUSE/i, "states the refuse-into-escalate discipline for a deletion/semantic conflict");
  assert.match(prompt, /never rebase/i, "states merge, never rebase-force");
  assert.match(prompt, /add entry A/, "carries OUR side's log since merge-base");
  assert.match(prompt, /add entry B/, "carries THEIR side's log since merge-base");
  assert.doesNotMatch(prompt, /making CI GREEN/, "merge-conflict must not carry ci-log's instruction");
  assert.doesNotMatch(prompt, /PR BODY's Acceptance block/, "merge-conflict must not carry body-coverage's instruction");
  assert.doesNotMatch(prompt, /crit-reviewer|crit-coverage/, "merge-conflict must not carry any review-mode criteria");
});

// W1-T2540 — THE UNION IS ALWAYS WRONG FOR A REGENERABLE ARTIFACT, and the prompt used to say only
// "resolve toward the UNION". MEASURED on this repo, three conflicts on scripts/source-size-
// baseline.json: the true merged values were 3230, 32818 and 32748 against sides of 3136/3138,
// 32692/32713 and 32743/32718 — neither side, and never the larger of the two. Both sides ADD
// lines, so the merged file is longer than either recorded; only re-running the generator answers
// it. A worker following the old instruction shipped a false ceiling every time.

test("W1-T2540: the merge-conflict prompt refuses a TEXTUAL merge of a regenerable artifact and says to re-run its generator", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: { mergeConflict: mergeConflictFixture() },
  });
  assert.match(prompt, /REGENERABLE ARTIFACTS ARE THE EXCEPTION/, "the carve-out is named, not implied");
  assert.match(prompt, /do NOT merge it textually at all, in either/, "and it is a refusal, not a preference");
  assert.match(prompt, /RE-RUN THE COMMAND/, "names the action that actually resolves it");
  assert.match(prompt, /FUNCTION of the MERGED tree/, "and WHY, so the rule generalises past the examples");
});

test("W1-T2540: the prompt carries the measurement, so the rule is not merely asserted", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: { mergeConflict: mergeConflictFixture() },
  });
  // The three real values and their three real pairs. A worker told "the union is wrong" without
  // evidence will reasonably take the larger side; these numbers are what rule that out.
  for (const n of ["3230", "32818", "32748", "3136/3138", "32692/32713", "32743/32718"]) {
    assert.ok(prompt.includes(n), `the prompt must carry the measured value ${n}`);
  }
  assert.match(prompt, /or the larger of the two, would have shipped a false ceiling/);
});

test("W1-T2540: the pre-existing merge discipline is PRESERVED, not replaced by the carve-out", () => {
  // The regression lock. This adds an exception for one file class; ordinary source must still be
  // resolved toward the union, and a deletion or semantic conflict must still refuse into escalate.
  const prompt = renderFixPrompt({
    task: { id: "W1-TX", title: "T" },
    round: 1,
    branch: "run-W1-TX-1",
    evidence: { mergeConflict: mergeConflictFixture() },
  });
  assert.match(prompt, /PURE CONCURRENT ADDITION/i, "the union condition survives");
  assert.match(prompt, /REFUSE to resolve it yourself and escalate/i, "the refuse-into-escalate arm survives");
  assert.match(prompt, /never rebase, never force-push/i, "the merge-not-rebase discipline survives");
  // and the carve-out must come AFTER the general rule, so a worker reads the default first.
  assert.ok(
    prompt.indexOf("PURE CONCURRENT ADDITION") < prompt.indexOf("REGENERABLE ARTIFACTS"),
    "the exception must be stated after the rule it excepts, never before it",
  );
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

// ── W1-T166: holdout acceptance criteria — reviewer-visible, WORKER-hidden.
// The fix rung dispatches an actual coding worker, so its unmet-criteria block
// is a worker-facing prompt exactly like the initial implement prompt — a
// holdout criterion's claim/proof text must never reach it, even though the
// SAME holdout criterion being unmet still counts toward the block (judgeReview
// already folds it into `state`; these are the run-task.ts dispatch-site proofs).

test("runFixRung (W1-T166 criterion 1): a mix of visible + holdout unmet criteria dispatches a fix prompt carrying the VISIBLE one only — the holdout claim/proof/reason never appear", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const failing = fakeReview("failure", [
    criterion({ claim: "visible criterion merges cleanly", met: false, reason: "reason-visible-missing" }),
    criterion({
      claim: "HOLDOUT-SECRET-CRITERION-never-shown",
      proof: "HOLDOUT-SECRET-PROOF-never-shown",
      met: false,
      reason: "HOLDOUT-SECRET-REASON-never-shown",
      holdout: true,
    }),
  ]);
  const passing = fakeReview("success", [
    criterion({ claim: "visible criterion merges cleanly", met: true }),
    criterion({ claim: "HOLDOUT-SECRET-CRITERION-never-shown", met: true, holdout: true }),
  ]);

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-holdout" });
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
  const prompt = spawnCalls[0].prompt;
  assert.match(prompt, /visible criterion merges cleanly/);
  assert.match(prompt, /reason-visible-missing/);
  assert.doesNotMatch(prompt, /HOLDOUT-SECRET-CRITERION/, "the holdout claim must never reach the fix worker's prompt");
  assert.doesNotMatch(prompt, /HOLDOUT-SECRET-PROOF/, "the holdout proof must never reach the fix worker's prompt");
  assert.doesNotMatch(prompt, /HOLDOUT-SECRET-REASON/, "the holdout reviewer reason must never reach the fix worker's prompt");
  assert.equal(outcome.outcome, "fixed");
});

test("runFixRung (W1-T166): when EVERY unmet criterion is holdout, the fix prompt still names the block (via the review's redacted summary) but never the holdout claim/proof text — never a silently-empty, unexplained prompt", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  // A REAL judgeReview verdict (not the fakeReview() shortcut) so `summary` is
  // computed by the actual failSummary redaction path this task adds.
  const criteria: AcceptanceCriterion[] = [
    { claim: "visible criterion merges cleanly", proof: "alpha-widget-check" },
    { claim: "HOLDOUT-SECRET-CRITERION-never-shown", proof: "HOLDOUT-ZQXJK-MARKER-SECRET", holdout: true },
  ];
  const computed = judgeReview(criteria, { diff: "", report: "REPORT: alpha widget check done." });
  assert.equal(computed.state, "failure", "sanity: the holdout-only gap still fails the verdict");
  const failing: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    ...computed,
    headSha: "deadbeef",
    reviewerOutcome: "success",
  };
  const passing = fakeReview("success", [
    criterion({ claim: "visible criterion merges cleanly", met: true }),
    criterion({ claim: "HOLDOUT-SECRET-CRITERION-never-shown", met: true, holdout: true }),
  ]);

  await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: failing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-holdout-only" });
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

  assert.equal(spawnCalls.length, 1);
  const prompt = spawnCalls[0].prompt;
  assert.doesNotMatch(prompt, /HOLDOUT-SECRET-CRITERION|HOLDOUT-ZQXJK-MARKER-SECRET/, "the holdout claim/proof must never reach the fix worker");
  assert.match(prompt, /1 holdout criterion unmet/i, "the redacted summary still names the honest, non-leaking reason the gate is red");
  assert.match(prompt, /not disclosed to the worker/i);
});

test("runFixRung (W1-T256): in body-coverage mode the re-review judges the FRESH PR BODY (fetchPrBody), never the fix worker's chat text — a body the worker substantiated can actually heal the block", async () => {
  const reviewReports: string[] = [];
  // body-coverage block: the unmet reason is a keyword-coverage gap (not an executed_fail).
  const failing = fakeReview("failure", [
    criterion({ claim: "criterion A is documented", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
  ]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A is documented", met: true })]);
  const SUBSTANTIATED_BODY = "PR BODY: criterion A is documented — matched 12/12 proof keywords";

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: failing,
    deps: {
      // The fix worker edits the PR BODY (gh pr edit); its OWN chat text never echoes the proof.
      spawn: async () => result({ sessionId: "fix-1", text: "edited the PR body; nothing here echoes the proof keywords" }),
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => SUBSTANTIATED_BODY,
      runReview: async (args) => {
        reviewReports.push(args.report);
        // The floor passes ONLY when the report actually is the substantiated body.
        return args.report.includes("matched 12/12 proof keywords") ? passing : failing;
      },
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(reviewReports.length, 1, "exactly one re-review after the single strike");
  assert.equal(reviewReports[0], SUBSTANTIATED_BODY, "the re-review judged the fresh PR body, never the worker's chat text");
  assert.equal(outcome.outcome, "fixed", "the worker's body substantiation healed the keyword-floor block");
  assert.equal(outcome.strikes, 1);
});

test("fetchPrBodyViaGh (W1-T256): returns the PR body via the injected gh reader, and empty string when the body is absent", async () => {
  assert.equal(await fetchPrBodyViaGh("https://github.com/acme/remudero/pull/1", () => ({ body: "the current PR body" })), "the current PR body");
  assert.equal(await fetchPrBodyViaGh("https://github.com/acme/remudero/pull/1", () => ({})), "");
});

test("runFixRung (W1-T256): a THROWING fetchPrBody falls back to the worker text and never crashes the rung", async () => {
  const reviewReports: string[] = [];
  const failing = fakeReview("failure", [
    criterion({ claim: "criterion A is documented", met: false, reason: "proof unmet: report does not substantiate it (matched 4/12 proof keywords)" }),
  ]);
  const passing = fakeReview("success", [criterion({ claim: "criterion A is documented", met: true })]);

  await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: failing,
    deps: {
      spawn: async () => result({ sessionId: "fix-1", text: "WORKER-CHAT-FALLBACK" }),
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => {
        throw new Error("gh unavailable");
      },
      runReview: async (args) => {
        reviewReports.push(args.report);
        return passing;
      },
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.match(reviewReports[0], /WORKER-CHAT-FALLBACK/, "a throwing fetchPrBody must fall back to the worker text, not crash the rung");
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
  const failing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })], "sha-0");
  // Strike 1's fix worker DOES push a genuine (if incomplete) commit — a
  // different head sha than the review that triggered the rung — before
  // strike 2 finally resolves it (W1-T168: an unchanged head sha would read
  // as no-progress; this models a real, still-failing attempt instead).
  const stillFailingAfterStrike1 = fakeReview(
    "failure",
    [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })],
    "sha-1",
  );
  const passing = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })], "sha-2");
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
        return reviewCalls === 1 ? stillFailingAfterStrike1 : passing; // still broken after strike 1, fixed after strike 2
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
  const stillFailing = fakeReview(
    "failure",
    [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })],
    "sha-0",
  );
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ledgerPath = tmpLedgerPath();
  let reviewCalls = 0;

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
      // Never resolves — but a GENUINE deficiency: each strike's push lands a
      // real (distinct) commit that still fails the identical criterion
      // (W1-T168 criterion 3: a changed diff whose floor also fails strikes
      // normally, never escaping as a false-block).
      runReview: async () => {
        reviewCalls++;
        return { ...stillFailing, headSha: `sha-${reviewCalls}` };
      },
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

// ── W1-T58 (ratifies P3 via P8/RETRO-1784058021334, Standing rule 15): the
// blocked_review golden — a run either ADDS THE WORK or ESCALATES, NEVER
// edits its own criteria. T3E's guard covers the REVIEWER side (a worker-
// authored satisfied_by is flagged at judge time); these two fixtures cover
// the RUN-LOOP side runFixRung owns. ───────────────────────────────────────

test("runFixRung (W1-T58 acceptance 1): an ORDINARY seeded blocked_review (no criteria tampering) routes to add-the-work or escalate — the run makes NO write to plan/tasks.yaml, and neither the fix worker's prompt nor the escalation issue ever references the plan file", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const stillFailing = fakeReview("failure", [
    criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" }),
  ]);
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ledgerPath = tmpLedgerPath();

  // ADD-THE-WORK path: strike 1 resolves the review — a normal fix dispatch.
  const passing = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })]);
  const fixed = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: stillFailing,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => passing,
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath,
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });
  assert.equal(fixed.outcome, "fixed", "ADD-THE-WORK: an ordinary blocked_review dispatches a fix worker");
  assert.equal(spawnCalls.length, 1);
  assert.doesNotMatch(
    spawnCalls[0].prompt,
    /plan\/tasks\.yaml/,
    "the fix worker is never directed at plan/tasks.yaml — the work it adds is never a plan edit",
  );
  assert.equal(issueCalls.length, 0);

  // ESCALATE path: strikes exhaust without resolving — no third spawn, no
  // rule-15 refusal (this is an ORDINARY exhaustion, not a tampered diff).
  const escSpawnCalls: SpawnWorkerArgs[] = [];
  const escIssueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const escLedgerPath = tmpLedgerPath();
  let escReviewCalls = 0;
  const escalated = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: stillFailing,
    deps: {
      spawn: async (args) => {
        escSpawnCalls.push(args);
        return result({ sessionId: `fix-session-${escSpawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      // Never resolves — but a GENUINE deficiency: each strike lands a real,
      // distinct commit that still fails the same criterion (W1-T168
      // criterion 3 — never escaped as a false-block).
      runReview: async () => {
        escReviewCalls++;
        return { ...stillFailing, headSha: `esc-sha-${escReviewCalls}` };
      },
      push: () => {},
      issues: fakeIssues(escIssueCalls),
      ledgerPath: escLedgerPath,
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });
  assert.equal(escalated.outcome, "escalated", "ESCALATE: exhaustion routes to the SAME two-outcome taxonomy");
  assert.equal(escSpawnCalls.length, 2, "strikeCap spawns — an ordinary exhaustion, not a rule-15 short-circuit");
  assert.equal(escIssueCalls.length, 1);
  assert.doesNotMatch(
    escIssueCalls[0].body,
    /plan\/tasks\.yaml/,
    "an ordinary exhaustion escalation never mentions the plan file either",
  );
  const escLedgerLines = readFileSync(escLedgerPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(
    !escLedgerLines.some((l) => l.step === "fix.rule15_violation"),
    "an ordinary blocked_review never trips the rule-15 refusal path",
  );
});

test("runFixRung (W1-T58 acceptance 2, the negative control): a blocked_review verdict whose diff TAMPERS with plan/tasks.yaml's own criteria is REFUSED — zero fix-worker spawns, an immediate escalation naming Standing rule 15 (proves the assertion above is not vacuous)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ledgerPath = tmpLedgerPath();

  // A worker-authored diff that edited plan/tasks.yaml's OWN criteria — the
  // review verdict `runReview`/`judgeReview` would compute for such a diff
  // (ReviewVerdict.criteriaTampered, review.ts, W1-T58).
  const tampered = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: true })]);
  tampered.criteriaTampered = true;
  tampered.summary = "remudero-review: FAIL — diff edits plan/tasks.yaml's own acceptance criteria — Standing rule 15";
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: tampered,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "should-never-spawn" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => tampered,
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath,
      log: (step, extra) => logged.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 0, "a tampered diff is NEVER eligible for an ordinary add-the-work fix dispatch");
  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.strikes, 0, "no strike is spent on a diff the rung refuses to act on");
  assert.equal(issueCalls.length, 1);
  assert.ok(issueCalls[0].labels.includes("escalation-blocked"));
  assert.match(issueCalls[0].body, /Standing rule 15/);
  assert.match(issueCalls[0].body, /plan\/tasks\.yaml/);
  assert.ok(
    logged.some((l) => l.step === "fix.rule15_violation"),
    "the refusal is ledgered distinctly from an ordinary exhaustion",
  );
  const ledgerLines = readFileSync(ledgerPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.ok(
    ledgerLines.some((l) => l.step === "escalation.issue_opened"),
    "the escalation itself is still ledgered via the SAME escalate() machinery every other exhaustion uses",
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

// ── W1-T106 (the #170 DIRTY strand): `runFixRung` itself must derive
// merge-conflict evidence, mirroring ci-log's own dedicated proofs above. ──

test("runFixRung: a seeded conflicted dispatch (mergeConflict, no review posted yet) dispatches ONE fix worker in merge-conflict mode, carrying the conflicting file(s) — never reviewer criteria (W1-T106, the #170 DIRTY strand)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []); // conflicted's own placeholder — no reviewer verdict exists yet
  const passing = fakeReview("success", []);
  const mergeConflict: MergeConflictEvidence = {
    files: [{ path: "src/x.ts", oursDeleted: 0, theirsDeleted: 0 }],
    oursLog: "abc1234 add entry A",
    theirsLog: "def5678 add entry B",
  };

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    mergeConflict,
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
  assert.match(spawnCalls[0].prompt, /MODE: merge-conflict/, "the rendered prompt names merge-conflict mode");
  assert.match(spawnCalls[0].prompt, /src\/x\.ts/, "the conflicting file rides the prompt");
  assert.doesNotMatch(spawnCalls[0].prompt, /UNMET acceptance criterion/i, "never reviewer-mode criteria — conflicted has none");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1);
});

test("runFixRung: a conflicted dispatch that exhausts its strikes without the merge state EVER resolving escalates naming the conflicting file(s), never an empty/misleading 'Unmet criteria:' list", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const noReviewYet = fakeReview("failure", []);
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const mergeConflict: MergeConflictEvidence = {
    files: [{ path: "src/y.ts", oursDeleted: 0, theirsDeleted: 0 }],
    oursLog: "abc1234 add entry A",
    theirsLog: "def5678 add entry B",
  };

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: noReviewYet,
    mergeConflict,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red", // merge state never resolves — no check ever runs, no review is ever reached
      runReview: async () => {
        throw new Error("runReview must never be called — the merge state never resolved");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 2, "exactly strikeCap merge-conflict spawns");
  assert.equal(outcome.outcome, "escalated");
  assert.equal(issueCalls.length, 1);
  assert.match(issueCalls[0].title, /conflicted fix rung exhausted/, "the escalation names conflicted, not blocked_ci/blocked_review");
  assert.match(issueCalls[0].body, /Conflicting file/i);
  assert.match(issueCalls[0].body, /src\/y\.ts/, "the conflicting file name is carried");
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
      // Still failing — heads toward exhaustion — but a GENUINE deficiency:
      // the strike lands a real, distinct commit (W1-T168: an identical head
      // sha would instead read as no-progress and escalate as a false-block).
      runReview: async () => ({ ...failing, headSha: "sha-1" }),
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
      // A GENUINE deficiency: the strike lands a real, distinct commit that
      // still fails (W1-T168: an identical head sha would instead read as
      // no-progress and escalate as a false-block, never reaching this
      // test's own exhaustion-check assertions).
      runReview: async () => ({ ...failing, headSha: "sha-1" }),
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

// ── W1-T168 (the #349/#360 stuck class): the fix rung must ESCAPE a review
// false-block it structurally cannot fix — no-progress across strikes
// escalates for re-judgment, never silent strike-exhaustion. ────────────────

test("detectReviewFalseBlock: an UNCHANGED head sha whose review re-fails the SAME criterion is a false-block (no diff change this strike)", () => {
  const priorHeadSha = "sha-0";
  const priorUnmetClaims = new Set(["criterion A merges cleanly"]);
  const current = fakeReview(
    "failure",
    [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })],
    "sha-0", // identical to priorHeadSha — no new commit landed this round
  );
  const reason = detectReviewFalseBlock({ priorHeadSha, priorUnmetClaims, current });
  assert.ok(reason, "an unchanged head sha re-blocking the identical criterion is detected as a false-block");
});

test("detectReviewFalseBlock (the falsifier): a fix-rung round that STRIKES TO EXHAUSTION on unchanged code never happens — the SAME unresolved input is never treated as ordinary progress", () => {
  // The falsifier named in the task's own acceptance criterion 1: a review
  // whose head sha AND unmet criteria are byte-identical to the round before
  // it must NEVER be classified as "no signal" (which would let the rung
  // strike again toward exhaustion instead of escalating).
  const priorHeadSha = "sha-0";
  const priorUnmetClaims = new Set(["criterion A merges cleanly"]);
  const current = fakeReview(
    "failure",
    [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })],
    "sha-0",
  );
  assert.notEqual(
    detectReviewFalseBlock({ priorHeadSha, priorUnmetClaims, current }),
    undefined,
    "unchanged head sha + identical unmet criterion must NOT read as ordinary (strikeable) progress",
  );
});

test("detectReviewFalseBlock: the DETERMINISTIC floor passing while the spawned reviewer blocks is a false-block — the SHARPEST signal, independent of whether the head sha changed", () => {
  const priorHeadSha = "sha-0";
  const priorUnmetClaims = new Set(["criterion A merges cleanly"]);
  // The head sha DID change (a real commit landed) — yet the floor observed
  // every proof pass while the advisory reviewer still downgraded it. This is
  // the #349/#360 shape and must escalate regardless of (a).
  const current = {
    ...fakeReview(
      "failure",
      [criterion({ claim: "criterion A merges cleanly", met: false, reason: "semantic downgrade", proof_exec: "executed_pass" })],
      "sha-1",
    ),
    floorState: "success" as const,
  };
  const reason = detectReviewFalseBlock({ priorHeadSha, priorUnmetClaims, current });
  assert.ok(reason, "floor-passes-but-reviewer-blocks is detected as a false-block even on a changed head sha");
});

test("detectReviewFalseBlock: a GENUINE deficiency (changed head sha, floor ALSO failing) trips NEITHER signal — the escape never weakens the rung for real work still owed", () => {
  const priorHeadSha = "sha-0";
  const priorUnmetClaims = new Set(["criterion A merges cleanly"]);
  const current = {
    ...fakeReview(
      "failure",
      [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken", proof_exec: "executed_fail" })],
      "sha-1", // a real, changed commit
    ),
    floorState: "failure" as const, // the floor ALSO fails — a real deficiency
  };
  assert.equal(
    detectReviewFalseBlock({ priorHeadSha, priorUnmetClaims, current }),
    undefined,
    "a genuine deficiency (changed diff, floor also failing) is never mis-escaped as a false-block",
  );
});

test("detectReviewFalseBlock: a passing review is never a false-block, regardless of head sha or criteria", () => {
  const current = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })], "sha-0");
  assert.equal(
    detectReviewFalseBlock({ priorHeadSha: "sha-0", priorUnmetClaims: new Set(["criterion A merges cleanly"]), current }),
    undefined,
  );
});

test("runFixRung: a fix round with NO diff change that re-fails the SAME criterion ESCALATES as a false-block, not another silent strike toward exhaustion", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const initialReview = fakeReview(
    "failure",
    [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })],
    "sha-0",
  );

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2, // TWO strikes available — the escape must fire on strike 1 alone
    initialReview,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      // The fix worker's push added NOTHING — the review re-runs against the
      // IDENTICAL head sha and re-fails the IDENTICAL criterion.
      runReview: async () => initialReview,
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(
    spawnCalls.length,
    1,
    "the falsifier: a fix rung that strikes to EXHAUSTION (2 spawns) on unchanged code must never happen — it escalates after strike 1",
  );
  assert.equal(outcome.strikes, 1, "only ONE strike was spent — the escape fires before the cap is ever approached");
  assert.equal(issueCalls.length, 1);
  assert.match(issueCalls[0].body, /false-block/i);
  assert.match(issueCalls[0].body, /criterion A merges cleanly/);
});

test("runFixRung: when the DETERMINISTIC floor passes but the spawned reviewer blocks, the disagreement ESCALATES naming the floor-vs-reviewer disagreement — the #349/#360 shape resolves without a human re-review loop", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const initialReview = fakeReview(
    "failure",
    [criterion({ claim: "criterion A merges cleanly", met: false, reason: "reviewer disagreed with the floor" })],
    "sha-0",
  );

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      // A real commit landed (a DIFFERENT head sha) — the deterministic floor
      // now observes every proof PASS, yet the advisory reviewer's semantic
      // layer still downgrades the verdict.
      runReview: async () => ({
        ...fakeReview(
          "failure",
          [
            criterion({
              claim: "criterion A merges cleanly",
              met: false,
              reason: "reviewer disagreed with the floor",
              proof_exec: "executed_pass",
            }),
          ],
          "sha-1",
        ),
        floorState: "success" as const,
      }),
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(spawnCalls.length, 1, "escalates on the FIRST strike whose floor passes but reviewer blocks — never exhausts");
  assert.equal(issueCalls.length, 1);
  assert.match(issueCalls[0].body, /floor/i);
  assert.match(issueCalls[0].title, /false-block/i);
});

test("runFixRung: a GENUINE deficiency — a fix round that ADDS work (changed head sha) and still fails a criterion whose deterministic floor ALSO fails — strikes NORMALLY toward the cap (the escape never weakens the rung for real work still owed)", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  let reviewCalls = 0;
  const initialReview = fakeReview(
    "failure",
    [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken", proof_exec: "executed_fail" })],
    "sha-0",
  );

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      // Every strike lands a genuinely new commit (a distinct head sha) that
      // still fails — and the deterministic floor ALSO fails, never passing —
      // a real, unresolved deficiency, never a false-block.
      runReview: async () => {
        reviewCalls++;
        return {
          ...fakeReview(
            "failure",
            [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken", proof_exec: "executed_fail" })],
            `sha-${reviewCalls}`,
          ),
          floorState: "failure" as const,
        };
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
  assert.equal(spawnCalls.length, 2, "the escape never fires on a genuine deficiency — both strikes are spent, exactly as before this task");
  assert.equal(outcome.strikes, 2);
  assert.equal(issueCalls.length, 1);
  assert.doesNotMatch(issueCalls[0].body, /false-block/i, "an ordinary exhaustion escalation is never mislabeled a false-block");
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
  // W1-T193: the batch call is now injected (`draftBatch`, a test seam — see the hook's own
  // doc) rather than calling draftProposalBatch by name directly, but the seam's DEFAULT is
  // still the SAME draftProposalBatch, and the hook body actually invokes it via that
  // parameter — never a re-derived spawn loop.
  assert.match(hookBody, /= draftProposalBatch,/, "buildInboxDraftHook's draftBatch seam must default to the SAME draftProposalBatch");
  assert.match(hookBody, /await draftBatch\(due,/, "buildInboxDraftHook must actually invoke the (possibly-injected) batch function");
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

// ── W1-T193: the console must never render nothing for a proposal legitimately mid-draft ──

test("W1-T193: buildInboxDraftHook writes state/inbox-draft-inflight.json BEFORE spawning the draft batch, and clears it in a `finally` regardless of outcome", () => {
  const hookBody = extractFunctionBody(runTaskSrc, "function buildInboxDraftHook(");
  assert.match(hookBody, /inbox-draft-inflight\.json/, "must write the in-flight cache the console's GET /v1/inbox reads");
  const writeIdx = hookBody.indexOf("inbox-draft-inflight.json");
  const spawnIdx = hookBody.indexOf("await draftBatch(due,");
  const finallyIdx = hookBody.indexOf("} finally {");
  assert.ok(writeIdx >= 0 && spawnIdx > writeIdx, "the in-flight file must be written BEFORE the batch spawns, not after");
  assert.ok(finallyIdx > spawnIdx, "the in-flight file must be cleared in a finally AFTER the spawn, whether it throws or not");
});

// The two tests above prove the SHAPE (reachability + ordering) from source text; the two
// below actually EXECUTE buildInboxDraftHook end to end, injecting a fake `draftBatch` in
// place of the real draftProposalBatch (which clones a real worktree and spawns a real
// Architect worker — far too heavy for a unit test) via the seam added for exactly this
// purpose (buildInboxDraftHook's own doc).
function seedDueProposal(root: string, proposalId: string): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: proposalId, summary: "s", evidenceAnchors: [] }] }));
}

test("W1-T193: buildInboxDraftHook — a REAL execution proves the in-flight file names every due proposal's id BEFORE the batch runs, and is left EMPTY once it resolves successfully", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-inbox-hook-"));
  seedDueProposal(root, "P1");
  const config = { root } as Config;
  const inflightPath = join(root, "state", "inbox-draft-inflight.json");
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => logs.push({ step, extra });

  let inflightDuringBatch: unknown;
  const hook = buildInboxDraftHook("owner", "repo", config, "RUN-1", log, async (due) => {
    inflightDuringBatch = JSON.parse(readFileSync(inflightPath, "utf8"));
    return due.map((p) => ({
      proposalId: p.id,
      ok: true as const,
      candidate: { proposalId: p.id, fragmentYaml: "- id: X\n  title: t\n", stampLine: "stamp", anchorFingerprint: "" },
    }));
  });

  await hook();

  assert.deepEqual(Object.keys(inflightDuringBatch as Record<string, string>), ["P1"], "the in-flight file must name exactly the due proposal(s) before the batch runs");
  assert.match((inflightDuringBatch as Record<string, string>).P1, /^\d{4}-\d{2}-\d{2}T/, "the spawn timestamp must be a real ISO string");
  assert.deepEqual(JSON.parse(readFileSync(inflightPath, "utf8")), {}, "the in-flight file must be cleared once the batch resolves");
  const drafts = JSON.parse(readFileSync(join(root, "state", "inbox-drafts.json"), "utf8"));
  assert.ok(drafts.P1, "a successful outcome must land in the draft cache");
  assert.deepEqual(logs, [], "a clean run never ledgers inbox.draft_rung.error");
});

test("W1-T193: buildInboxDraftHook — the in-flight file is cleared even when the injected batch THROWS, and the failure is caught and ledgered, never thrown up to the caller", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-inbox-hook-"));
  seedDueProposal(root, "P2");
  const config = { root } as Config;
  const inflightPath = join(root, "state", "inbox-draft-inflight.json");
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => logs.push({ step, extra });

  const hook = buildInboxDraftHook("owner", "repo", config, "RUN-2", log, async () => {
    throw new Error("simulated worktree failure");
  });

  await assert.doesNotReject(hook(), "a batch failure must be caught, never thrown up into the sweep/daemon loop");
  assert.deepEqual(JSON.parse(readFileSync(inflightPath, "utf8")), {}, "the in-flight file must still be cleared on failure");
  assert.deepEqual(logs, [{ step: "inbox.draft_rung.error", extra: { error: "simulated worktree failure" } }]);
});

test("W1-T193: rmd serve leaves panelGraph.ratify UNSET in its own CLI wiring — buildServeServer (lib/serve.ts) owns defaulting it to a real ratifyCliGateway, proven behaviorally in test/serve.test.ts; the console's APPROVE/REFRAME routes are reachable from the real CLI, never left with no gateway", () => {
  const serveBody = extractFunctionBody(runTaskSrc, "async function serveCommand(");
  assert.match(serveBody, /panelGraph: \{/, "serveCommand must still assemble a panelGraph deps object");
  assert.doesNotMatch(
    serveBody,
    /ratify:/,
    "serveCommand must NOT construct its own ratify gateway — that would bypass buildServeServer's " +
      "single default-construction site (lib/serve.ts), the same 'one assembler, not two divergent " +
      "wiring sites' discipline inboxRoot's own auto-fill already follows",
  );
});

// W1-T192 review-floor proof-text fixture (composite, additive alongside the two granular
// tests above — same convention W1-T185's review round 3 established): the review floor's
// `unit test:` dialect name-filters the WHOLE suite using a criterion's proof body VERBATIM,
// so this criterion is only mechanically provable by a test whose NAME literally is that text.
test("inboxCommand still classifies and still forces a draft on demand after the daemon rung exists. FALSIFIER: moving the trigger and removing the manual one leaves an operator unable to force a redraft when they want one — the CLI is demoted from sole trigger, not deleted", () => {
  const inboxBody = extractFunctionBody(runTaskSrc, "async function inboxCommand(");
  assert.match(inboxBody, /classifyProposal\(/, "inboxCommand must still CLASSIFY every proposal — the viewer role is preserved");
  assert.match(
    inboxBody,
    /proposalsNeedingDraft\(/,
    "inboxCommand must still be able to FORCE a draft via the unthrottled predicate — the manual-trigger role is preserved",
  );
  assert.match(
    inboxBody,
    /draftProposalBatch\(/,
    "inboxCommand must still actually SPAWN the draft on demand, not merely decide one is due — a real manual trigger, not a stub",
  );
  assert.doesNotMatch(
    inboxBody,
    /draftsDueOnDaemon/,
    "the daemon-only idempotence throttle must never gate inboxCommand's manual force — an operator can always force a redraft",
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
      // Strike 1 lands a real, distinct (still-failing) commit before strike
      // 2 resolves it — W1-T168: an identical head sha across rounds would
      // instead read as no-progress and escalate before strike 2 ever runs.
      runReview: async () => {
        reviewCalls++;
        return reviewCalls === 1 ? { ...failing, headSha: "sha-1" } : passing; // resolved on the SECOND strike
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
    // A RECENT-activity fixture, not a date-specific one: routeFix has no injectable clock,
    // so deriveDisposition sees the real Date.now(). A fixed 2026-07-16 literal here silently
    // aged past DEFAULT_SWEEP_POLICY.staleDays (14) and flipped every routeFix disposition to
    // "stale" on 2026-07-30T12:00:00Z. Relative, like this file's other OpenPrView helpers.
    lastActivityAt: new Date().toISOString(),
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

test("routeFix: a POSTED review=failure alongside checks-red (PR 479's shape) still dispatches ci-log evidence — proves the rung's OWN evidence (keyed off checksState) is distinct from the posted reviewState (W1-T226 acceptance 5, the PR 449 disagreement)", async () => {
  const deps = fakeFixDeps();
  const ciFailures = [{ name: "osv-scanner", logTail: "HIGH severity vulnerability found in dep@1.2.3" }];
  const unmet = [criterion({ claim: "criterion A merges cleanly", met: false, reason: "executed and failed" })];
  // A real, posted FAILING review verdict sits beside a red required check —
  // exactly the shape the W1-T226 rationale names as PR 479's. `isBlockedCi`
  // (checksState-only) decides the dispatch shape, never `reviewState`.
  const pr = fixPr({ reviewState: "failure", checksState: "red", priorStrikes: 0, unmetCriteria: unmet, ciFailures });

  const result = await routeFix("OPEN", pr, deps);

  assert.equal(result.outcome, "fixed");
  assert.equal(deps.fixed.length, 1);
  assert.equal(deps.escalated.length, 0);
  assert.deepEqual(
    deps.fixed[0].evidence.ciFailures,
    ciFailures,
    "the CHECK still gets a remedy — never routed only to a criteria-shaped mode while it goes unaddressed",
  );
  assert.deepEqual(
    deps.fixed[0].evidence.unmetCriteria,
    [],
    "the dispatched evidence carries NO reviewer criteria even though pr.unmetCriteria (from the posted review) was non-empty",
  );
});

test("routeFix: a conflicted PR (mergeState dirty, pure concurrent addition) dispatches merge-conflict evidence — the SAME dispatch shape runSweep uses (W1-T106, the #170 DIRTY strand)", async () => {
  const deps = fakeFixDeps();
  const mergeConflict: MergeConflictEvidence = {
    files: [{ path: "src/x.ts", oursDeleted: 0, theirsDeleted: 0 }],
    oursLog: "abc1234 add entry A",
    theirsLog: "def5678 add entry B",
  };
  const pr = fixPr({ reviewState: "success", checksState: "green", mergeState: "dirty", mergeConflict });

  // W1-T984: the `conflicted` row now carries a `mergeConflictAdmissionEnabled` conjunct (default
  // FALSE — a real REST evidence producer landed alongside the flag, and the predicate cannot
  // tell a genuine pure-concurrent-addition from an add/add collision). This test exercises the
  // row's DISPATCH mechanics, which W1-T106 already owns and this task does not change, so it
  // opts the fixture IN via policy — the same explicit shape `supersessionDisposalEnabled`'s own
  // tests already use — rather than asserting on the new default.
  const result = await routeFix("OPEN", pr, deps, { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: true });

  assert.equal(result.outcome, "fixed");
  assert.equal(deps.fixed.length, 1);
  assert.equal(deps.escalated.length, 0, "the safely-fixable half never escalates");
  assert.deepEqual(deps.fixed[0].evidence.mergeConflict, mergeConflict);
  assert.deepEqual(deps.fixed[0].evidence.unmetCriteria, []);
});

// ── W1-T106: `buildFixRungDispatchArgs` is the pure arg-builder extracted out
// of `buildSweepEffects.dispatchFix` (the git/gh/worker-spawn boundary around
// it is untestable by design) — these are its dedicated proofs, covering the
// evidence-classification + initial-verdict reconstruction directly. ────────

function dispatchArgsBase() {
  return {
    task: { id: "W1-TX", title: "Some task" },
    runId: "SWEEP-1730000000000",
    prUrl: "https://github.com/acme/remudero/pull/9",
    branch: "run-W1-TX-1730000000000",
    worktreePath: "/tmp/rmd-dispatch-wt",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-dispatch-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    strikeCap: 2,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-dispatch-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

test("buildFixRungDispatchArgs: a merge-conflict dispatch (evidence.mergeConflict set) seeds a failing, criteria-less initialReview naming the conflict — checked BEFORE ciFailures even when both are present", () => {
  const mergeConflict: MergeConflictEvidence = {
    files: [{ path: "src/x.ts", oursDeleted: 0, theirsDeleted: 0 }],
    oursLog: "abc1234 add entry A",
    theirsLog: "def5678 add entry B",
  };
  const evidence: FixDispatchEvidence = {
    unmetCriteria: [],
    mergeConflict,
    ciFailures: [{ name: "ci", logTail: "should be ignored" }],
  };
  const pr = { headSha: "deadbeef", reviewSummary: "should be ignored" };

  const args = buildFixRungDispatchArgs({ ...dispatchArgsBase(), evidence, pr });

  assert.equal(args.initialReview.state, "failure");
  assert.deepEqual(args.initialReview.criteria, []);
  assert.match(args.initialReview.summary, /merge state dirty/);
  assert.equal(args.initialReview.reviewerOutcome, "sweep-reconstructed-merge-conflict");
  assert.equal(args.initialReview.headSha, "deadbeef");
  assert.deepEqual(args.mergeConflict, mergeConflict);
  assert.deepEqual(args.ciFailures, evidence.ciFailures, "ciFailures still rides through unchanged for the rung's own reversion logic");
  assert.equal(args.initialSessionId, "", "a cold PR: strike 1 degrades to fresh (adapter lives beside deps)");
});

test("buildFixRungDispatchArgs: a ci-log dispatch (evidence.ciFailures set, no mergeConflict) seeds a failing, criteria-less initialReview naming the failing checks (W1-T100)", () => {
  const ciFailures = [{ name: "typecheck", logTail: "tsc: error TS2322" }];
  const evidence: FixDispatchEvidence = { unmetCriteria: [], ciFailures };
  const pr = { headSha: "cafe1234" };

  const args = buildFixRungDispatchArgs({ ...dispatchArgsBase(), evidence, pr });

  assert.equal(args.initialReview.state, "failure");
  assert.deepEqual(args.initialReview.criteria, []);
  assert.match(args.initialReview.summary, /required checks red/);
  assert.equal(args.initialReview.reviewerOutcome, "sweep-reconstructed-ci-log");
  assert.equal(args.mergeConflict, undefined);
  assert.deepEqual(args.ciFailures, ciFailures);
});

test("buildFixRungDispatchArgs: an ordinary blocked_review dispatch (neither mergeConflict nor ciFailures) seeds the unmet criteria + reviewSummary verbatim", () => {
  const unmet: CriterionVerdict[] = [{ claim: "criterion A", met: false, reason: "r", proof_exec: "not_executable" } as never];
  const evidence: FixDispatchEvidence = { unmetCriteria: unmet };
  const pr = { headSha: "f00d1234", reviewSummary: "the real failing review summary" };

  const args = buildFixRungDispatchArgs({ ...dispatchArgsBase(), evidence, pr });

  assert.deepEqual(args.initialReview.criteria, unmet);
  assert.equal(args.initialReview.summary, "the real failing review summary");
  assert.equal(args.initialReview.reviewerOutcome, "sweep-reconstructed");
  assert.equal(args.mergeConflict, undefined);
  assert.equal(args.ciFailures, undefined);
});

test("buildFixRungDispatchArgs: a pendingAnswer's constraint rides the constraint field verbatim; absent otherwise", () => {
  const evidence: FixDispatchEvidence = { unmetCriteria: [] };
  const withAnswer = buildFixRungDispatchArgs({
    ...dispatchArgsBase(),
    evidence,
    pr: { headSha: "a", pendingAnswer: { constraint: "operator said: keep it" } },
  });
  assert.equal(withAnswer.constraint, "operator said: keep it");

  const withoutAnswer = buildFixRungDispatchArgs({ ...dispatchArgsBase(), evidence, pr: { headSha: "a" } });
  assert.equal(withoutAnswer.constraint, undefined);
});

// ── W1-T106: `buildSweepEffects.dispatchFix` end-to-end over REAL git + a
// PATH-stubbed `gh` — the whole cold-PR reconstruction path (creditable-head
// check, worktree materialization, buildFixRungDispatchArgs, the runFixRung
// call itself) executes for real. `gh pr view --json state` reports OPEN on
// its FIRST call (dispatchFix's own preflight) and MERGED from the SECOND
// call on (runFixRung's site-(i) terminal check, at the top of its strike
// loop) — so the rung stands down on its very first round, BEFORE ever
// spending a strike, and no real worker is ever spawned (spawnWorker is the
// codebase's own untested-by-design process boundary; this proof exercises
// every line up to, but never including, that boundary). ───────────────────
test("buildSweepEffects.dispatchFix: a conflicted cold PR runs the REAL git-worktree + arg-building path end to end, then stands down (merged mid-flight) before spawning any worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-dispatchfix-e2e-"));
  const config = { claudeBin: "/bin/true", root } as Config;
  const owner = "acme";
  const repo = "scratch-dispatchfix-repo"; // must NOT be this checkout's own real repo name
  const taskId = "W1-TX";
  const branch = `run-${taskId}-${Date.now()}`;
  const prUrl = "https://github.com/acme/scratch-dispatchfix-repo/pull/42";

  const originDir = join(root, "gh-origin");
  mkdirSync(originDir, { recursive: true });
  const g = (dir: string, args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g(originDir, ["init", "--quiet", "-b", "main"]);
  g(originDir, ["config", "user.email", "t@example.com"]);
  g(originDir, ["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "README.md"), "x\n");
  g(originDir, ["add", "."]);
  g(originDir, ["commit", "--quiet", "-m", "init"]);
  g(originDir, ["branch", branch]); // the creditable head, at the SAME commit as main

  // repoDir MUST land exactly where buildSweepEffects computes it for a repo
  // name that is NOT this checkout's own (join(config.root, "repos", repo)).
  const repoDir = join(root, "repos", repo);
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", originDir, repoDir]);
  g(repoDir, ["config", "user.email", "t@example.com"]);
  g(repoDir, ["config", "user.name", "Test"]);
  mkdirSync(worktreesDir(config), { recursive: true });

  // A stateful `gh` stub: `--json headRefName` always answers this PR's real
  // creditable branch; the live-state read answers OPEN once (dispatchFix's
  // own preflight, BEFORE any git side effect) then MERGED forever after (so
  // runFixRung's site-(i) check stands the rung down on its first round).
  // W1-T511: that live-state read is `ghLiveState`, which now goes over REST
  // (`gh api repos/{o}/{r}/pulls/{n}`, singlePrRestArgs's own shape) rather
  // than `gh pr view --json state` (GraphQL) — so the stub answers the REST
  // argv, composing MERGED/OPEN via the SAME `state`+`merged` fold
  // `prStateFromRest` uses (a merged PR reads `{state:"closed",merged:true}`
  // on REST, never a bare "MERGED" token).
  const bin = mkdtempSync(join(tmpdir(), "gh-dispatchfix-"));
  const counterFile = join(bin, "state-calls");
  writeFileSync(counterFile, "0");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const idx = args.indexOf("--json");
const field = idx >= 0 ? args[idx + 1] : undefined;
if (args[0] === "pr" && args[1] === "view" && field && field.startsWith("headRefName")) {
  process.stdout.write(JSON.stringify({ headRefName: ${JSON.stringify(branch)}, body: "" }));
} else if (args[0] === "api" && typeof args[1] === "string" && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(args[1])) {
  const n = parseInt(fs.readFileSync(${JSON.stringify(counterFile)}, "utf8") || "0", 10);
  fs.writeFileSync(${JSON.stringify(counterFile)}, String(n + 1));
  process.stdout.write(n === 0 ? JSON.stringify({ state: "open", merged: false }) : JSON.stringify({ state: "closed", merged: true }));
} else {
  process.stdout.write("{}");
}
`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;

  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const plan = {
    tasks: [{ id: taskId, title: "t", repo, depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 }],
    byId: new Map(),
  } as unknown as Plan;

  try {
    const effects = buildSweepEffects(
      owner, repo, config, join(root, "ledger.ndjson"), "SWEEP-1",
      plan,
      (step, extra) => { logs.push({ step, extra }); },
      DEFAULT_SWEEP_POLICY,
    );
    const mergeConflict: MergeConflictEvidence = {
      files: [{ path: "src/x.ts", oursDeleted: 0, theirsDeleted: 0 }],
      oursLog: "abc1234 add entry A",
      theirsLog: "def5678 add entry B",
    };
    const pr: OpenPrView = {
      prNumber: 42,
      prUrl,
      taskId,
      reviewState: "none",
      checksState: "pending",
      unmetCriteria: [],
      priorStrikes: 0,
      lastActivityAt: new Date().toISOString(),
      headSha: "deadbeef",
      autoMergeArmed: false,
      mergeConflict,
    };

    await effects.dispatchFix(pr, { unmetCriteria: [], mergeConflict });

    // The rung reached its FIRST round, stood down (MERGED, second gh read) —
    // never spent a strike, never dispatched a worker, never crashed dispatchFix.
    assert.ok(!logs.some((l) => l.step === "sweep.fix.no_task"), "the task WAS found");
    assert.ok(!logs.some((l) => l.step === "sweep.fix.uncreditable_head"), "the branch WAS creditable");
    assert.ok(!logs.some((l) => l.step === "sweep.fix.error"), "the real git/arg-building path never threw");
    assert.ok(logs.some((l) => l.step === "fix.stood_down"), "runFixRung's OWN terminal check fired — reached past dispatchFix's arg-building");
    assert.equal(parseInt(readFileSync(counterFile, "utf8"), 10), 2, "exactly two `--json state` reads: dispatchFix's preflight, then runFixRung's site-(i) check");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
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

// ── W1-T199: strike regime tagging ──────────────────────────────────────────
//
// A strike counter that cannot tell noise from evidence blocks the loop exactly
// where it now works. FIXTURE (2026-07-21): PR #457 converged executed_fail ->
// fix worker -> executed_pass x3 -> merged, while #449/#452 were refused at 2/2
// by the SAME rung, carrying executed_fail verdicts of their own — because their
// two strikes had been spent in the keyword-only era.

test("W1-T199: keyword-era strikes do NOT count under the executed regime", () => {
  const ledger = [
    { step: "fix.dispatch", task_id: "W1-T900" }, // untagged => pre-executor
    { step: "fix.dispatch", task_id: "W1-T900" },
  ];
  assert.equal(priorStrikesFor(ledger, "W1-T900", "executed"), 0);
});

test("W1-T199: a rung refusing SOLELY on pre-regime strikes is not reachable — 2 untagged strikes leave the cap unexhausted", () => {
  const ledger = [
    { step: "fix.dispatch", task_id: "W1-T900" },
    { step: "fix.dispatch", task_id: "W1-T900" },
  ];
  const cap = 2;
  const counted = priorStrikesFor(ledger, "W1-T900", "executed");
  assert.ok(counted < cap, `expected < ${cap} counted strikes, got ${counted}`);
});

test("W1-T199: the bound stays REAL — strikes spent under the CURRENT regime still exhaust", () => {
  const ledger = [
    { step: "fix.dispatch", task_id: "W1-T900", verdict_regime: "executed" },
    { step: "fix.dispatch", task_id: "W1-T900", verdict_regime: "executed" },
  ];
  assert.equal(priorStrikesFor(ledger, "W1-T900", "executed"), 2);
});

test("W1-T199: under the keyword_only regime EVERY strike counts — the bound never silently vanishes", () => {
  const ledger = [
    { step: "fix.dispatch", task_id: "W1-T900" },
    { step: "fix.dispatch", task_id: "W1-T900", verdict_regime: "executed" },
  ];
  assert.equal(priorStrikesFor(ledger, "W1-T900", "keyword_only"), 2);
});

test("W1-T199: the current regime is READ from the latest review.posted proof_exec", () => {
  const keywordOnly = [
    { step: "review.posted", task_id: "W1-T900", proof_exec: ["not_executable", "not_executable"] },
  ];
  const executed = [
    { step: "review.posted", task_id: "W1-T900", proof_exec: ["not_executable", "not_executable"] },
    { step: "review.posted", task_id: "W1-T900", proof_exec: ["not_executable", "executed_fail"] },
  ];
  assert.equal(currentStrikeRegimeFor(keywordOnly, "W1-T900"), "keyword_only");
  assert.equal(currentStrikeRegimeFor(executed, "W1-T900"), "executed");
});

test("W1-T199: the ledger is never mutated — regime is derived at READ time from untouched lines", () => {
  const ledger = [{ step: "fix.dispatch", task_id: "W1-T900" }];
  const snapshot = JSON.stringify(ledger);
  priorStrikesFor(ledger, "W1-T900", "executed");
  currentStrikeRegimeFor(ledger, "W1-T900");
  assert.equal(JSON.stringify(ledger), snapshot, "reading strikes must not mutate ledger lines");
});

// ── the circuit-break dedup marker survives a FAILED delivery (R-1) ─────────
// The cross-boot dedup was already ledger-derived and already the right shape.
// Its defect was ORDERING: the marker was written only after escalate() RETURNED,
// so a throwing `gh` recorded nothing and the next boot retried the same
// escalation — which is how a transport failure became an unbounded relaunch
// loop. The ledger showed 1 such marker against 460 boots.

test("escalateCircuitBreak: a THROWING gh gateway still writes the dedup marker, so the next boot does not retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-circuit-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const task = { id: "W1-TQ", title: "t", repo: "remudero", type: "implement", depends_on: [], status: "queued" };
  const boom = {
    create() {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };

  // BOOT 1: delivery fails. It must not throw, and it must leave a marker.
  assert.doesNotThrow(() =>
    escalateCircuitBreak(task as never, { owner: "craigoley", repo: "remudero", ledgerPath, runId: "RUN-1", issues: boom }),
  );
  const afterFirst = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const markers = afterFirst.filter((l) => l.step === "dispatch.circuit_broken.escalated");
  assert.equal(markers.length, 1, "FALSIFIER: pre-fix the marker was written only on SUCCESS, so this was 0");
  assert.equal(markers[0].delivered, false, "and it records that delivery did NOT happen (claimed vs evidenced)");
  assert.equal(
    afterFirst.filter((l) => l.step === "escalation.failed").length,
    1,
    "the failure is legible on its own step",
  );

  // BOOT 2: a fresh process over the SAME ledger must dedup on that marker and
  // not call the gateway again. This is the loop, reproduced across boots.
  let calls = 0;
  const counting = {
    create() {
      calls += 1;
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  escalateCircuitBreak(task as never, { owner: "craigoley", repo: "remudero", ledgerPath, runId: "RUN-2", issues: counting });
  assert.equal(calls, 0, "the second boot never re-attempted — the dedup is durable across the process death");
});

test("ghPrCreateFillCommand: plan/triage PR-create runs gh with cwd pinned to the run worktree, not the process cwd", () => {
  // The harness opens plan/triage/retro PRs itself (no worker step). W1-T1202 moved this
  // builder off `gh pr create --fill` (GraphQL) onto `gh api --method POST
  // repos/{owner}/{repo}/pulls` (REST) — the REST create itself needs no local ref
  // resolution (head/base are explicit strings), but the builder now ALSO reads the
  // worktree's own git history locally (fillDerivedBody/lastCommitSubject), and the head
  // branch is a local ref only inside its run worktree — so cwd still MUST be the
  // worktree, not the rmd process's own dir, or those local reads see the wrong repo.
  const worktree = "/Users/x/Remudero/repos/remudero/worktrees/run-TRIAGE-fb-abc-123";
  // Builds the argv only — nothing is executed here — but the guard fires on the PR-create
  // boundary itself, so the builder needs the exemption to be reachable at all.
  const built = withLiveWritesAllowed(() =>
    ghPrCreateFillCommand(worktree, "craigoley", "remudero", "run-TRIAGE-fb-abc-123"),
  );
  assert.equal(built.options.cwd, worktree, "cwd MUST be the run worktree — this is the whole fix");
  assert.notEqual(built.options.cwd, process.cwd(), "cwd must NOT default to the process cwd, where the branch is unresolvable");
  assert.equal(built.command, "gh");
  assert.deepEqual(built.args.slice(0, 4), ["api", "--method", "POST", "repos/craigoley/remudero/pulls"]);
  assert.ok(!built.args.includes("pr"), "no `gh pr create` subcommand — GraphQL is never issued (W1-T1202)");
  const headIdx = built.args.indexOf("head=run-TRIAGE-fb-abc-123");
  assert.notEqual(headIdx, -1, "the REST create's head field carries the branch");
  assert.ok(built.args.includes("base=main"), "the REST create's base field is main");
});

// ── armAutoMerge: the clean-status arm no-op (20 acted lines, zero arms) ─────

function armDeps(over: Partial<ArmDeps> = {}): ArmDeps & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    headSha: () => "abc1234",
    // A ledgered SUCCESS review with EXECUTED proof for this head — the W1-T230
    // gate's arm-permitting shape (decideArmFromLedgerVerdict).
    ledgerLines: () => [
      { step: "review.posted", task_id: "W1-TX", state: "success", head_sha: "abc1234", proof_exec: ["executed_pass"] },
    ],
    armAuto: () => {},
    mergeDirect: () => {},
    disableAuto: () => {},
    say: (m) => { said.push(m); },
    ...over,
  };
}
const cleanStatusErr = () => {
  const e = new Error("gh failed") as Error & { stderr: string };
  e.stderr = "X Pull request #591 is in clean status; auto-merge cannot be enabled";
  return e;
};

test("armFailureAction: GitHub's 'clean status' refusal (already-mergeable PR) resolves to an immediate direct merge, not a silent no-op", () => {
  assert.equal(
    armFailureAction('X Pull request #591 is in clean status; auto-merge cannot be enabled'),
    "direct-merge",
  );
});

test("armFailureAction: a genuine transient gh/network signature classifies as transient — the next sweep pass retries", () => {
  // W1-T1079: armFailureAction no longer folds every non-clean-status failure into one "ignore"
  // bucket (that was the defect — a permanent refusal and a network blip read identically). A
  // recognizable network signature still lands on "transient"; an unrecognized/empty one now
  // defaults to "unknown" rather than assuming transience — W1-T1117 renamed the catch-all from
  // "permanent" (a certainty this string-only classifier never actually had) to "unknown".
  assert.equal(armFailureAction("connect ETIMEDOUT api.github.com"), "transient");
  assert.equal(armFailureAction(""), "unknown");
});

test("armAutoMerge: a clean-status refusal COMPLETES as a direct merge — the gated-green state that made --auto refuse is exactly the mergeable state", () => {
  const merged: string[] = [];
  const deps = armDeps({
    armAuto: () => { throw cleanStatusErr(); },
    mergeDirect: (u) => { merged.push(u); },
  });
  assert.equal(armAutoMerge("url/591", "W1-TX", deps), "direct-merged");
  assert.deepEqual(merged, ["url/591"]);
  assert.ok(deps.said.some((m) => m.includes("clean_status_direct_merge")), "the completion is said, never silent");
});

test("armAutoMerge: a transient arm failure stays ignored (retried by the next sweep pass) — no direct merge fires", () => {
  const merged: string[] = [];
  const deps = armDeps({
    armAuto: () => { throw new Error("connect ETIMEDOUT api.github.com"); },
    mergeDirect: (u) => { merged.push(u); },
  });
  assert.equal(armAutoMerge("url/1", "W1-TX", deps), "arm-error-ignored");
  assert.deepEqual(merged, []);
});

test("armAutoMerge: a failing direct merge is SAID with its reason, never thrown and never silent", () => {
  const deps = armDeps({
    armAuto: () => { throw cleanStatusErr(); },
    mergeDirect: () => { throw new Error("merge conflict appeared"); },
  });
  assert.equal(armAutoMerge("url/2", "W1-TX", deps), "direct-merge-failed");
  assert.ok(deps.said.some((m) => m.includes("direct_merge_failed") && m.includes("merge conflict appeared")));
});

test("armAutoMerge: the happy arm path still arms — the fallback changes nothing when --auto succeeds", () => {
  const deps = armDeps();
  assert.equal(armAutoMerge("url/3", "W1-TX", deps), "armed");
});

test("armAutoMerge: the W1-T230 guards are untouched — no task id and a ledger-refused verdict still withhold arming", () => {
  assert.equal(armAutoMerge("url/4", undefined, armDeps()), "no-task-id");
  const refused = armDeps({ ledgerLines: () => [] });
  assert.equal(armAutoMerge("url/5", "W1-TX", refused), "ledger-refused");
  const headless = armDeps({ headSha: () => { throw new Error("gh down"); } });
  assert.equal(armAutoMerge("url/6", "W1-TX", headless), "head-unavailable");
});

test("realArmDeps: the real gh/config wiring executes against a PATH-stubbed gh — every dep body runs, none is guessed", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-stub-"));
  writeFileSync(
    join(bin, "gh"),
    // `headSha` reads over REST now (`gh api repos/{o}/{r}/pulls/{n}`), so the stub answers on
    // $1=api and in REST's own shape — mapRestPr reads head.sha. `pr merge` still falls through
    // to the exit-0 arm below, exactly as before.
    '#!/bin/sh\ncase "$1" in api) echo "{\\"number\\":1,\\"html_url\\":\\"u\\",\\"updated_at\\":\\"t\\",\\"head\\":{\\"ref\\":\\"b\\",\\"sha\\":\\"stub1234\\"}}";; *) exit 0;; esac\n',
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const d = realArmDeps();
    // A REAL PR URL: the REST path resolves owner/repo/number from it, and refuses anything it
    // cannot address rather than falling back to a gh --json read.
    assert.equal(
      d.headSha("https://github.com/craigoley/remudero/pull/1"),
      "stub1234",
      "headSha reads head.sha off the REST single-PR response",
    );
    // These three reach `gh pr merge` for real, against the PATH-stubbed `gh` written above —
    // never the live repo. Each is exempted individually because the guard checks the CALL,
    // not the destination, and running the real dep body IS the assertion.
    assert.doesNotThrow(() => withLiveWritesAllowed(() => d.armAuto("url/x")), "armAuto reaches gh pr merge --auto");
    // W1-T1255: `mergeDirect` is the REST merge endpoint now, so it PARSES its PR URL to build
    // `repos/{o}/{r}/pulls/{n}/merge` and refuses a placeholder rather than shelling out blind.
    // A real URL keeps this probe's point intact — the dep body still runs against the stub.
    assert.doesNotThrow(
      () => withLiveWritesAllowed(() => d.mergeDirect("https://github.com/craigoley/remudero/pull/1")),
      "mergeDirect reaches the REST merge endpoint",
    );
    assert.doesNotThrow(() => withLiveWritesAllowed(() => d.disableAuto("url/x")), "disableAuto (W1-T125) reaches gh pr merge --disable-auto");
    assert.doesNotThrow(() => d.say("realArmDeps coverage probe"));
    try {
      d.ledgerLines();
    } catch {
      // a machine with no config root yet — the dep line still executed, which is the assertion
    }
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("buildSweepEffects.arm: the sweep's real arm wrapper reaches armAutoMerge (safe no-task-id path, no gh spawned)", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-arm-"));
  const effects = buildSweepEffects(
    "craigoley",
    "remudero",
    { root } as never,
    join(root, "ledger.ndjson"),
    "RUN-ARM-1",
    { tasks: [] } as never,
    () => {},
  );
  // W1-T2347: `taskId: undefined` deliberately drives armAutoMergeDetailed's REAL default all
  // the way to its own no-task-id short-circuit ("safe ... no gh spawned", per this test's own
  // name) — a deliberate real-dependency exercise, not a forgotten seam, so it takes the
  // withLiveWritesAllowed escape hatch requireExplicitArmSeam's own message names.
  await withLiveWritesAllowed(() =>
    effects.arm({
      prNumber: 1,
      prUrl: "url/1",
      taskId: undefined,
      reviewState: "none",
      checksState: "green",
      unmetCriteria: [],
      priorStrikes: 0,
      lastActivityAt: new Date().toISOString(),
      headSha: "x",
      autoMergeArmed: false,
    } as never),
  );
  rmSync(root, { recursive: true, force: true });
});

// ── W1-T449: arm/merge-site attribution — pr_number, pr_url and a lane on every arm/merge
// ── ledger line, so a sweep-armed merge and a hand-armed merge are told apart. ──────────

test("buildSweepEffects.arm: a SUCCESSFUL sweep arm writes automerge.armed with pr_number, pr_url and a sweep lane — not only the sweep.disposed row (W1-T449)", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-arm-attrib-"));
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const armImplFake = (): ArmOutcome => "armed";
  // Driven THROUGH the returned adapter (effects.arm), never armAndLogOutcome directly —
  // the seam that matters is buildSweepEffects's own `arm` member, wired to armAutoMerge
  // bare before this task.
  const effects = buildSweepEffects(
    "craigoley",
    "remudero",
    { root } as never,
    join(root, "ledger.ndjson"),
    "RUN-ARM-2",
    { tasks: [] } as never,
    (step, extra) => { logs.push({ step, extra }); },
    DEFAULT_SWEEP_POLICY,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    armImplFake,
  );
  const outcome = await effects.arm({
    prNumber: 501,
    prUrl: "https://github.com/craigoley/remudero/pull/501",
    taskId: undefined,
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date().toISOString(),
    headSha: "x",
    autoMergeArmed: false,
  } as never);
  assert.equal(outcome, "armed");
  const armed = logs.filter((l) => l.step === "automerge.armed");
  assert.equal(armed.length, 1, "the sweep's own arm effect must write its own automerge.armed line");
  assert.equal(armed[0].extra?.pr_number, 501);
  assert.equal(armed[0].extra?.pr_url, "https://github.com/craigoley/remudero/pull/501");
  assert.equal(armed[0].extra?.lane, "sweep");
  assert.equal(armed[0].extra?.task_id, undefined, "the trailerless case this attribution exists for");
  rmSync(root, { recursive: true, force: true });
});

test("armAndLogOutcome (sweep lane) vs armIfVerdictPermits (review lane): two different PRs' arm lines are told apart from the ledger alone via pr_number + lane, with no informative task id on either (W1-T449)", () => {
  const sweepLogs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const sweepOutcome = armAndLogOutcome(
    "https://github.com/craigoley/remudero/pull/601",
    undefined, // the sweep's real case — no trailer at all
    (step, extra) => { sweepLogs.push({ step, extra }); },
    () => "armed",
    "sweep",
  );
  const reviewLogs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const verdict = { state: "success", capped: false, planOnly: false } as const;
  const reviewOutcome = armIfVerdictPermits(
    verdict,
    {
      prUrl: "https://github.com/craigoley/remudero/pull/602",
      // Every real armIfVerdictPermits caller already resolves this to `taskId ?? "PR-<n>"`
      // (armIfVerdictPermits's own doc) — a SYNTHETIC label naming nothing beyond the PR
      // number itself, i.e. no independently informative task id either.
      taskId: "PR-602",
      headSha: "cafef00d",
      ledgerPath: "/dev/null",
      log: (step, extra) => { reviewLogs.push({ step, extra }); },
    },
    { arm: () => "armed" },
  );
  assert.equal(sweepOutcome, "armed");
  assert.equal(reviewOutcome, "armed");
  const sweepArmed = sweepLogs.find((l) => l.step === "automerge.armed");
  const reviewArmed = reviewLogs.find((l) => l.step === "automerge.armed");
  assert.ok(sweepArmed && reviewArmed);
  assert.equal(sweepArmed!.extra?.pr_number, 601);
  assert.equal(reviewArmed!.extra?.pr_number, 602);
  assert.equal(sweepArmed!.extra?.lane, "sweep");
  assert.equal(reviewArmed!.extra?.lane, "review");
  assert.notEqual(sweepArmed!.extra?.lane, reviewArmed!.extra?.lane);
});

test("armAndLogOutcome: a clean-status direct merge writes automerge.clean_status_direct_merge with pr_number and pr_url — not stdout alone (W1-T449)", () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const outcome = armAndLogOutcome(
    "https://github.com/craigoley/remudero/pull/591",
    "W1-TX",
    (step, extra) => { logs.push({ step, extra }); },
    () => "direct-merged",
  );
  assert.equal(outcome, "direct-merged");
  const directMerge = logs.find((l) => l.step === "automerge.clean_status_direct_merge");
  assert.ok(directMerge, "the completion must reach the ledger, not only deps.say -> stdout");
  assert.equal(directMerge!.extra?.pr_number, 591);
  assert.equal(directMerge!.extra?.pr_url, "https://github.com/craigoley/remudero/pull/591");
  // direct-merged still reads as armed (armOutcomeArmed treats it as a genuine success) — the
  // new step is ADDITIONAL, not a replacement of the generic armed line.
  assert.ok(logs.some((l) => l.step === "automerge.armed" && l.extra?.outcome === "direct-merged"));
});

test("armAndLogOutcome and armIfVerdictPermits: a refused arm still logs automerge.arm_skipped — the added pr/lane fields never turn a refusal into an armed line (W1-T449)", () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const outcome = armAndLogOutcome(
    "https://github.com/craigoley/remudero/pull/700",
    "W1-TY",
    (step, extra) => { logs.push({ step, extra }); },
    () => "ledger-refused",
    "sweep",
  );
  assert.equal(outcome, "ledger-refused");
  assert.equal(logs.length, 1, "a refusal writes exactly one line — never the direct-merge step too");
  assert.equal(logs[0].step, "automerge.arm_skipped");
  assert.equal(logs[0].extra?.pr_number, 700);
  assert.equal(logs[0].extra?.lane, "sweep");

  const reviewLogs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const verdict = { state: "success", capped: false, planOnly: false } as const;
  const reviewOutcome = armIfVerdictPermits(
    verdict,
    {
      prUrl: "https://github.com/craigoley/remudero/pull/701",
      taskId: "PR-701",
      headSha: "cafef00d",
      ledgerPath: "/dev/null",
      log: (step, extra) => { reviewLogs.push({ step, extra }); },
    },
    { arm: () => "head-unavailable" },
  );
  assert.equal(reviewOutcome, "head-unavailable");
  const skip = reviewLogs.find((l) => l.step === "automerge.arm_skipped");
  assert.ok(skip);
  assert.equal(skip!.extra?.pr_number, 701);
  assert.equal(skip!.extra?.lane, "review");
  assert.ok(!reviewLogs.some((l) => l.step === "automerge.armed"));
});

// ── pushDrainRundown: the extracted post-drain push glue (W1-T144, #606 discipline) ──

test("pushDrainRundown builds the classified rundown, prints it, and pushes ONE message through the injected channel — each non-merged line carrying its console deep link", () => {
  const sent: string[] = [];
  const printed: string[] = [];
  const channel = { send: (msg: string) => { sent.push(msg); return true; } };
  const root = mkdtempSync(join(tmpdir(), "push-rundown-"));
  const ledgerPath = join(root, "ledger.ndjson");
  // A ledger line the classifier reads to mark W1-B escalated (BLOCKED) with its issue URL.
  writeFileSync(
    ledgerPath,
    JSON.stringify({ step: "escalation.issue_opened", task_id: "W1-B", issue_url: "https://github.com/craigoley/remudero/issues/9", class: "BLOCKED" }) + "\n",
  );
  const summary = {
    attempted: ["W1-A", "W1-B"],
    merged: ["W1-A"],
    stopReason: "blocked" as const,
    costUsd: 1.25,
    resumeCommand: "rmd drain",
  };
  const config = { root, consoleUrl: "http://100.64.1.2:4317" } as never;
  try {
    const text = pushDrainRundown(summary, [{ step: "escalation.issue_opened", task_id: "W1-B", issue_url: "https://github.com/craigoley/remudero/issues/9", class: "BLOCKED" }], config, {
      channel: channel as never,
      ledgerPath,
      runId: "DRAIN-TEST",
      print: (s) => { printed.push(s); },
    });
    assert.equal(sent.length, 1, "exactly ONE push through the channel — one transport, not two");
    assert.equal(sent[0], text, "the returned text is exactly what was sent");
    assert.ok(printed.length >= 1, "the rundown is also printed to the terminal");
    // The deep link consoleUrl(config) + consoleCardUrl builds for the blocked task.
    assert.match(text, /http:\/\/100\.64\.1\.2:4317\/#task=W1-B/, "the escalated line carries ITS OWN console deep link");
    rmSync(root, { recursive: true, force: true });
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
});

// ── W1-T144: the three CLI command call-sites that thread the console URL, behaviorally ──
// covered with a temp config root + a PATH-stubbed osascript so notify() is a no-op. An empty
// plan reaches drainCommand's post-drain push WITHOUT spawning any worker.

function withStubbedNotify<T>(fn: () => T): T {
  const bin = mkdtempSync(join(tmpdir(), "osa-stub-"));
  writeFileSync(join(bin, "osascript"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("drainCommand (W1-T144): a completed drain over an empty plan reaches the post-drain rundown push — the pushDrainRundown call site executes, no worker spawned", async () => {
  const config = { claudeBin: "/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-drain-push-")), consoleUrl: "http://100.64.1.2:4317" } as Config;
  const planPath = join(mkdtempSync(join(tmpdir(), "rmd-drain-push-plan-")), "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const sent: string[] = [];
  const code = await drainCommand([], {
    config, planPath, skipGitSync: true, githubFactory: () => OFFLINE_GITHUB,
    // The default headroom source now opens a real SDK session (SDK-preferred, CLI fallback), so
    // this behavioral test injects one — the same reason it already injects github and notify.
    readUsage: () => undefined,
    notifyChannel: { send: (m: string) => { sent.push(m); return true; } } as never,
  });
  assert.equal(code, 0, "an empty plan is a clean drain (nothing runnable) — exit 0, and the rundown push ran");
  assert.equal(sent.length, 1, "the post-drain rundown pushed exactly once through the injected channel");
  rmSync(config.root, { recursive: true, force: true });
});

test("digestCommand (W1-T144): --dry-run threads consoleUrl(config) into buildDigest and prints", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-digest-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "rmd-digest-home-"));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root, consoleUrl: "http://100.64.1.2:4317" }));
  process.env.HOME = home;
  try {
    const sent: string[] = [];
    const chan = { send: (m: string) => { sent.push(m); return true; } } as never;
    const dry = await digestCommand(["--dry-run"], { notifyChannel: chan });
    assert.equal(dry, 0, "--dry-run prints buildDigest with the console URL, sends nothing");
    const code = await digestCommand([], { notifyChannel: chan });
    assert.equal(sent.length, 1, "the real digest send threads consoleUrl through the injected channel");
    assert.equal(code, 0);
  } finally {
    process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("digestCommand (W1-T163): an EXPLICIT --since is an operator override that bypasses the marker entirely -- both --dry-run and a real send take the pre-existing explicit-since path, and the marker store is never touched", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-digest-since-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "rmd-digest-since-home-"));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root, consoleUrl: "http://100.64.1.2:4317" }));
  process.env.HOME = home;
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sent: string[] = [];
    const chan = { send: (m: string) => { sent.push(m); return true; } } as never;
    const dry = await digestCommand(["--since", since, "--dry-run"], { notifyChannel: chan });
    assert.equal(dry, 0, "an explicit --since with --dry-run still just prints, sends nothing");
    assert.equal(sent.length, 0, "--dry-run sends nothing even on the explicit-since path");
    const code = await digestCommand(["--since", since], { notifyChannel: chan });
    assert.equal(code, 0);
    assert.equal(sent.length, 1, "the explicit-since path still sends through the injected channel");
    // The marker store lives at <root>/state/last-seen.json (lib/last-seen.ts) -- an explicit
    // --since must never create or touch it (module header: "deliberately never touches the
    // marker, so a one-off 'show me since <date>' never resets the shared push/pull window").
    assert.equal(existsSync(join(root, "state", "last-seen.json")), false, "explicit --since never writes the marker store");
  } finally {
    process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("escalateCommand (W1-T144): a MANUAL escalation's real-time ping threads the console deep link (notify no-op via stub), issue open is best-effort", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-esc-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "rmd-esc-home-"));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root, consoleUrl: "http://100.64.1.2:4317" }));
  process.env.HOME = home;
  try {
    // gh issue open will fail offline; the console-link ping line executes before/around it.
    // The assertion is that the command runs its console-threading path without throwing here.
    const sent: string[] = [];
    const code = await escalateCommand(
      ["--class", "MANUAL", "--task", "W1-TX", "--summary", "probe", "--option", "fix-it|do the fix", "--recommendation", "fix-it"],
      {
        issues: { create: () => "https://github.com/craigoley/remudero/issues/1" } as never,
        notifyChannel: { send: (m: string) => { sent.push(m); return true; } } as never,
      },
    );
    assert.equal(code, 0);
    assert.equal(sent.length, 1, "the MANUAL ping fired once through the injected channel");
    assert.match(sent[0], /#task=W1-TX/, "the ping carries the console deep link for the escalated task");
  } finally {
    process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── materializeOriginShards: the two defensive git-failure paths (W1-T245, injected runner) ──

test("materializeOriginShards: a failing ls-tree (no tasks.d/ at origin/main) is the plain no-shards case — returns [], writes nothing", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "shard-nolist-"));
  const runGit: GitRunner = (args) => {
    if (args[0] === "ls-tree") throw new Error("fatal: not a tree object");
    return "";
  };
  const got = materializeOriginShards("/repo", "plan", tmpDir, runGit);
  assert.deepEqual(got, [], "a throwing ls-tree yields no shards, never propagates");
  assert.equal(existsSync(join(tmpDir, "tasks.d")), false, "no shard dir is created when there are none");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("materializeOriginShards: a shard that LISTS but fails to `git show` throws GitFetchError loudly — a torn read never silently drops a task", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "shard-torn-"));
  const runGit: GitRunner = (args) => {
    if (args[0] === "ls-tree") return "plan/tasks.d/W1-T9.yaml\n";
    throw new Error("fatal: bad object origin/main:plan/tasks.d/W1-T9.yaml");
  };
  assert.throws(
    () => materializeOriginShards("/repo", "plan", tmpDir, runGit),
    /git show origin\/main:plan\/tasks\.d\/W1-T9\.yaml failed/,
  );
  rmSync(tmpDir, { recursive: true, force: true });
});

test("materializeOriginShards: a listed shard is copied into <tmpDir>/tasks.d verbatim from the origin blob", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "shard-ok-"));
  const runGit: GitRunner = (args) =>
    args[0] === "ls-tree" ? "plan/tasks.d/W1-T9.yaml\n" : "- id: W1-T9\n  title: shard task\n";
  const got = materializeOriginShards("/repo", "plan", tmpDir, runGit);
  assert.deepEqual(got, ["plan/tasks.d/W1-T9.yaml"]);
  assert.equal(readFileSync(join(tmpDir, "tasks.d", "W1-T9.yaml"), "utf8"), "- id: W1-T9\n  title: shard task\n");
  rmSync(tmpDir, { recursive: true, force: true });
});

test("materializeOriginShards: an explicit `ref` is used INSTEAD of origin/main in both the ls-tree and git-show invocations (W1-T246)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "shard-ref-"));
  const seenArgs: string[][] = [];
  const runGit: GitRunner = (args) => {
    seenArgs.push(args);
    return args[0] === "ls-tree" ? "plan/tasks.d/W1-T9.yaml\n" : "- id: W1-T9\n  title: shard task\n";
  };
  const got = materializeOriginShards("/repo", "plan", tmpDir, runGit, "abc123def");
  assert.deepEqual(got, ["plan/tasks.d/W1-T9.yaml"]);
  assert.ok(seenArgs.some((a) => a[0] === "ls-tree" && a.includes("abc123def")), "ls-tree must target the given ref, not origin/main");
  assert.ok(
    seenArgs.some((a) => a[0] === "show" && a[1] === "abc123def:plan/tasks.d/W1-T9.yaml"),
    "git show must target <ref>:<shard>, not origin/main:<shard>",
  );
  assert.ok(
    seenArgs.every((a) => !a.some((tok) => tok.includes("origin/main"))),
    "origin/main must never appear when an explicit ref is given",
  );
  rmSync(tmpDir, { recursive: true, force: true });
});

test("materializeOriginShards: ref defaults to origin/main when omitted (back-compat, unchanged from W1-T245)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "shard-default-ref-"));
  const seenArgs: string[][] = [];
  const runGit: GitRunner = (args) => {
    seenArgs.push(args);
    return args[0] === "ls-tree" ? "" : "";
  };
  materializeOriginShards("/repo", "plan", tmpDir, runGit);
  assert.ok(seenArgs.some((a) => a[0] === "ls-tree" && a.includes("origin/main")));
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── W1-T246: `rmd lint-plan --base <ref>` must reconstruct the BASE plan the same shard-aware
// way loadPlan/syncPlanFromOrigin do — a plain `git show <base>:tasks.yaml` alone is shard-blind
// (the exact W1-T245 defect, but on the CI/--base path instead of the dispatch/sync path): every
// shard-only task looked "new/changed" on EVERY PR regardless of whether it touched the plan,
// silently harmless only because no check ever failed on a shard task before proof-dialect.

test("rmd lint-plan --base scoping: a shard present at BOTH base and head is NOT reported changed (the regression this fix closes)", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-lintplan-shard-"));
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "- id: T1\n  title: monolith\n  repo: remudero\n  type: implement\n", "utf8");
  writeFileSync(join(root, "plan", "tasks.d", "T2-shard.yaml"), "- id: T2\n  title: shard\n  repo: remudero\n  type: implement\n", "utf8");
  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "base"]);
  const baseSha = git(["rev-parse", "HEAD"]).trim();

  // Reconstruct the BASE plan exactly the way lintPlanCommand's --base branch does: the
  // monolith blob via `git show`, plus shards via materializeOriginShards(ref=baseSha).
  const oldRaw = git(["show", `${baseSha}:plan/tasks.yaml`]);
  const tmpDir = mkdtempSync(join(tmpdir(), "lint-plan-base-test-"));
  const tmpFile = join(tmpDir, "tasks.yaml");
  writeFileSync(tmpFile, oldRaw, "utf8");
  materializeOriginShards(root, "plan", tmpDir, undefined, baseSha);
  const oldPlan = loadPlan(tmpFile);
  const newPlan = loadPlan(join(root, "plan", "tasks.yaml"));

  assert.deepEqual(
    [...changedTaskIds(oldPlan.tasks, newPlan.tasks)],
    [],
    "T2 lives in a shard identical at base and head — it must NOT be reported as changed",
  );
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("rmd lint-plan --base HEAD: the reconstruct-base-plan branch (tmpDir, git show, materializeOriginShards, loadPlan, cleanup) runs end to end against this real checkout without throwing", async () => {
  // Unlike the fixture test above (which replicates lintPlanCommand's --base logic against a
  // synthetic repo), this drives the actual exported command: `repoRoot` inside run-task.ts is
  // fixed to THIS checkout, so `--base` only ever resolves against a real ref of it. `HEAD` is
  // always a valid, side-effect-free choice (base plan == working-copy plan, so scope is empty
  // and no task is re-linted) while still exercising every line of the try/finally that
  // reconstructs the base plan (tmpDir creation, `git show HEAD:plan/tasks.yaml`, the shard
  // materialization call, `loadPlan`, and the `finally` tmpDir cleanup).
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  let exitCode: number;
  try {
    exitCode = await lintPlanCommand(["--base", "HEAD"]);
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
  assert.equal(exitCode, 0, "HEAD vs working-copy plan/tasks.yaml has no diff — scope is empty, nothing fails");
});

// ── W1-T180 round 2 (coverage-ratchet): `lintPlanCommand`'s derived-merge-status wiring ─────
// (the try/catch around `loadConfig`/`resolveOwnerRepo`/`ghGateway`/`projectPlan`, and the
// per-task `opts.postMergeAmendment` build in the lint loop) had zero covering tests — every
// existing `--base` test above drives `scope.size === 0` (HEAD vs itself), which short-circuits
// BOTH blocks before a single line of either runs. `LintPlanStatusDeps` (this same commit) is
// the injection seam: real callers (the CLI dispatch) omit it and get the real `gh`-shelling
// functions unchanged; these tests supply fixtures so the whole wiring runs with zero network
// I/O, against a REAL `--base` diff on a dedicated fixture plan file
// (test/fixtures/lint-plan-status-di/tasks.yaml, committed with ONE criterion) whose on-disk
// copy each test temporarily rewrites with an ADDED criterion (restored in `finally`, no matter
// how the test exits) — exactly the "PR amends a merged task's acceptance criteria" shape the
// whole feature exists to catch.

const LINT_DI_FIXTURE = fileURLToPath(new URL("./fixtures/lint-plan-status-di/tasks.yaml", import.meta.url));
const LINT_DI_BASE_YAML = readFileSync(LINT_DI_FIXTURE, "utf8");
const LINT_DI_AMENDED_YAML =
  LINT_DI_BASE_YAML +
  '    - claim: "the fixture\'s amended criterion"\n' +
  '      proof: "unit test: test/run-task.test.ts::LINTDI-1 amended criterion proof"\n';

/** Runs `lintPlanCommand(["--plan", LINT_DI_FIXTURE, "--base", "HEAD"], deps)` with the fixture's
 *  on-disk copy temporarily amended (an added criterion vs the committed HEAD blob), console
 *  output captured, and the fixture restored byte-for-byte in `finally` regardless of outcome. */
async function runLintDiCase(deps: LintPlanStatusDeps): Promise<{ exitCode: number; errText: string }> {
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const errLines: string[] = [];
  console.log = () => {};
  console.error = (...args: unknown[]) => {
    errLines.push(args.map(String).join(" "));
  };
  console.warn = () => {};
  writeFileSync(LINT_DI_FIXTURE, LINT_DI_AMENDED_YAML, "utf8");
  try {
    const exitCode = await lintPlanCommand(["--plan", LINT_DI_FIXTURE, "--base", "HEAD"], deps);
    return { exitCode, errText: errLines.join("\n") };
  } finally {
    writeFileSync(LINT_DI_FIXTURE, LINT_DI_BASE_YAML, "utf8");
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

function lintDiStatusMap(merged: boolean): Map<string, StatusProjection> {
  return new Map([["LINTDI-1", { taskId: "LINTDI-1", status: merged ? "merged" : "queued", merged, source: "none" }]]);
}

test("rmd lint-plan --base HEAD: status resolution SUCCEEDS via injected deps — a MERGED task's amended criterion with no follow-up BLOCKS", async () => {
  const { exitCode, errText } = await runLintDiCase({
    loadConfig: () => ({ root: "/tmp/rmd-lint-di-unused" }) as Config,
    resolveOwnerRepo: () => ({ owner: "acme-corp", repo: "widget-fixture" }),
    ghGateway: () => ({}) as GitHub,
    projectPlan: () => lintDiStatusMap(true),
  });
  assert.equal(exitCode, 1, "LINTDI-1 is MERGED, its criterion was amended, and no follow-up task was filed — BLOCK");
  assert.match(errText, /\[post-merge-amendment\]/);
  assert.match(errText, /LINTDI-1/);
});

test("rmd lint-plan --base HEAD: status resolution SUCCEEDS via injected deps — a NOT-merged task's amended criterion never blocks", async () => {
  const { exitCode, errText } = await runLintDiCase({
    loadConfig: () => ({ root: "/tmp/rmd-lint-di-unused" }) as Config,
    resolveOwnerRepo: () => ({ owner: "acme-corp", repo: "widget-fixture" }),
    ghGateway: () => ({}) as GitHub,
    projectPlan: () => lintDiStatusMap(false),
  });
  assert.equal(exitCode, 0, "LINTDI-1 has not merged yet — the post-merge-amendment check is a no-op for it");
  assert.doesNotMatch(errText, /\[post-merge-amendment\]/);
});

test("rmd lint-plan --base HEAD: status resolution FAILS (loadConfig throws) — the catch path fails OPEN, never blocking on an unresolvable status", async () => {
  const { exitCode, errText } = await runLintDiCase({
    loadConfig: () => {
      throw new Error("simulated: $HOME unreadable, exactly the CI `loadConfig` trap this catch exists for");
    },
    resolveOwnerRepo: () => ({ owner: "acme-corp", repo: "widget-fixture" }),
    ghGateway: () => ({}) as GitHub,
    projectPlan: () => lintDiStatusMap(true), // would BLOCK if reached — proves it never is
  });
  assert.equal(exitCode, 0, "statusResolvable never became true — fail OPEN, not a spurious block");
  assert.doesNotMatch(errText, /\[post-merge-amendment\]/);
});

// ── W1-T245 remaining criteria: deep-compare vs real checkout, dup-id through synced, temp cleanup ──

test("syncPlanFromOrigin: the synced plan's task-id SEQUENCE equals loadPlan over a real checkout of origin/main — monolith entries first, shards appended", () => {
  const { originDir, localDir } = gitFixture();
  mkdirSync(join(originDir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(originDir, "plan", "tasks.d", "T2-shard.yaml"), "- id: T2\n  title: shard\n  repo: remudero\n  type: implement\n", "utf8");
  writeFileSync(join(originDir, "plan", "tasks.d", "T3-shard.yaml"), "- id: T3\n  title: shard3\n  repo: remudero\n  type: implement\n", "utf8");
  execFileSync("git", ["-C", originDir, "add", "."]);
  execFileSync("git", ["-C", originDir, "commit", "--quiet", "-m", "shards"]);
  // A real checkout of origin/main: clone + loadPlan over its on-disk plan/tasks.yaml.
  const checkout = mkdtempSync(join(tmpdir(), "rmd-checkout-"));
  execFileSync("git", ["clone", "--quiet", originDir, checkout], { encoding: "utf8" });
  const viaCheckout = loadPlan(join(checkout, "plan", "tasks.yaml")).tasks.map((t) => t.id);
  const viaSync = syncPlanFromOrigin(localDir, "plan/tasks.yaml").plan.tasks.map((t) => t.id);
  assert.deepEqual(viaSync, viaCheckout, "the synced view must byte-equal a real checkout's loadPlan id sequence");
  rmSync(checkout, { recursive: true, force: true });
});

test("syncPlanFromOrigin: a duplicate id across tasks.yaml and a shard on origin/main still FAILS loudly through the synced path — the W1-T122 uniqueness guard is intact", () => {
  const { originDir, localDir } = gitFixture();
  mkdirSync(join(originDir, "plan", "tasks.d"), { recursive: true });
  // T1 already exists in the monolith fixture; a shard re-declaring it must fail loadPlan.
  writeFileSync(join(originDir, "plan", "tasks.d", "dup.yaml"), "- id: T1\n  title: dup\n  repo: remudero\n  type: implement\n", "utf8");
  execFileSync("git", ["-C", originDir, "add", "."]);
  execFileSync("git", ["-C", originDir, "commit", "--quiet", "-m", "dup shard"]);
  assert.throws(() => syncPlanFromOrigin(localDir, "plan/tasks.yaml"), /duplicate task id 'T1'/);
});

test("syncPlanFromOrigin: the rmd- temp dir (holding tasks.yaml AND tasks.d) is removed even when loadPlan THROWS (duplicate-id fixture)", () => {
  const { originDir, localDir } = gitFixture();
  mkdirSync(join(originDir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(originDir, "plan", "tasks.d", "dup.yaml"), "- id: T1\n  title: dup\n  repo: remudero\n  type: implement\n", "utf8");
  execFileSync("git", ["-C", originDir, "add", "."]);
  execFileSync("git", ["-C", originDir, "commit", "--quiet", "-m", "dup"]);
  const before = readdirSync(tmpdir()).filter((d) => d.startsWith("rmd-plan"));
  assert.throws(() => syncPlanFromOrigin(localDir, "plan/tasks.yaml"));
  const after = readdirSync(tmpdir()).filter((d) => d.startsWith("rmd-plan"));
  assert.deepEqual(after, before, "no rmd-plan temp dir survives a loadPlan failure — cleaned on every exit path");
});

// ── W1-T82: `rmd onboard <target-dir> --phase inventory` CLI wrapper ────────────────────
// onboardCommand's own logic is thin (parse args -> resolve owner/repo -> delegate to
// runOnboardInventory -> print a summary); these tests exercise that wrapper itself
// (exit codes, the fail-loud arg-parse and OnboardError paths, and the success summary
// printed to console.log) via its injectable `deps` seam, the same shape reviewCommand's
// ReviewCommandDeps/drainCommand's deps already use elsewhere in this file.

const ONBOARD_FIXTURE_REPO_DIR = fileURLToPath(new URL("./fixtures/onboard/repo/", import.meta.url));

/** A fixture OnboardGhGateway — canned, resolved facts, no `gh` exec. */
function fixtureOnboardGhGateway(): OnboardGhGateway {
  return {
    repoInfo: () => ({ known: true, value: { exists: true, defaultBranch: "main" } }),
    branchProtection: () => ({ known: true, value: true }),
    openIssueCount: () => ({ known: true, value: 3 }),
    milestoneCount: () => ({ known: true, value: 1 }),
  };
}

test("onboardCommand: a bad --phase value (or missing target dir) fails loud — exit 2, zero fs/gh work attempted", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const code = await onboardCommand(["/some/dir", "--phase", "synthesis"], {
    fs: realOnboardFsDeps,
    gh: fixtureOnboardGhGateway(),
    resolveOwnerRepo: () => {
      throw new Error("must not be called — arg parsing must fail before any resolution work");
    },
  });
  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /--phase must be one of/);
});

// ── W1-T83: `rmd onboard <target-dir> --phase recon` CLI wrapper ────────────────────────
// onboardCommand routes `--phase recon` straight to reconCommand (before inventory.ts's own
// parser ever sees it — that parser keeps rejecting "recon" exactly as W1-T82 committed it,
// proven separately in test/onboard-inventory.test.ts). These tests exercise reconCommand's
// own thin wrapper (parse args -> resolve owner/repo -> delegate to runOnboardRecon -> print
// a summary) via its injectable deps seam, the same shape onboardCommand's own tests use.

const ONBOARD_RECON_FIXTURE_REPO_DIR = fileURLToPath(new URL("./fixtures/onboard-recon/repo/", import.meta.url));

function fixtureReconGhGateway(): ReconGhGateway {
  return {
    listOpenIssues: () => ({ known: true, value: [{ number: 1, title: "widget catalog missing SKUs" }] }),
  };
}

test("onboardCommand: --phase recon routes to reconCommand — a missing target dir fails loud through reconCommand's OWN parser, not inventory.ts's", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const code = await onboardCommand(["--phase", "recon"]);
  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /<target-dir> is required/);
});

test("reconCommand: a target directory that does not exist fails loud through the caught ReconError — exit 2", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const parentDir = mkdtempSync(join(tmpdir(), "rmd-onboard-recon-cmd-missing-"));
  const missingTargetDir = join(parentDir, "does-not-exist");

  const code = await reconCommand([missingTargetDir, "--phase", "recon"], {
    fs: realReconFsDeps,
    gh: fixtureReconGhGateway(),
    resolveOwnerRepo: () => ({ owner: "acme-corp", repo: "widget-fixture" }),
    runLens: async () => "",
  });

  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /does not exist/);
});

test("reconCommand: the fixture repo, --owner/--repo flags supplied, a canned lens output, exits 0 and prints a mined+inferred summary", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const targetDir = mkdtempSync(join(tmpdir(), "rmd-onboard-recon-cmd-ok-"));
  cpSync(ONBOARD_RECON_FIXTURE_REPO_DIR, targetDir, { recursive: true });

  const code = await reconCommand([targetDir, "--phase", "recon", "--owner", "acme-corp", "--repo", "widget-fixture"], {
    fs: realReconFsDeps,
    gh: fixtureReconGhGateway(),
    resolveOwnerRepo: () => {
      throw new Error("--owner/--repo were both supplied — resolveOwnerRepo must never be called");
    },
    runLens: async (specialist) => (specialist === "design" ? "RECON_FINDING: no ADR for the cache layer (source: #1)" : ""),
  });

  assert.equal(code, 0);
  const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printed, /rmd onboard .* --phase recon/);
  assert.match(printed, /target: acme-corp\/widget-fixture/);
  assert.match(printed, /lenses consulted: security, testing, design, containment/);
  assert.match(printed, /candidates: \d+ \(\d+ mined, 1 inferred\)/);
  assert.match(printed, /wrote .*findings\.md/);
  assert.match(printed, /wrote .*candidates\.json/);
  assert.ok(existsSync(join(targetDir, "plan", "onboarding", "findings.md")));
  assert.ok(existsSync(join(targetDir, "plan", "onboarding", "candidates.json")));
});

test("reconCommand: owner/repo omitted falls through to the injected resolveOwnerRepo (auto-detection), not a hardcoded default", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const targetDir = mkdtempSync(join(tmpdir(), "rmd-onboard-recon-cmd-resolve-"));
  cpSync(ONBOARD_RECON_FIXTURE_REPO_DIR, targetDir, { recursive: true });
  let sawTargetDir: string | undefined;

  const code = await reconCommand([targetDir, "--phase", "recon"], {
    fs: realReconFsDeps,
    gh: fixtureReconGhGateway(),
    resolveOwnerRepo: (dir) => {
      sawTargetDir = dir;
      return { owner: "resolved-org", repo: "resolved-repo" };
    },
    runLens: async () => "",
  });

  assert.equal(code, 0);
  assert.equal(sawTargetDir, targetDir);
  const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printed, /target: resolved-org\/resolved-repo/);
});

test("reconCommand: a bad --phase value (not \"recon\") or missing target dir fails loud — exit 2, zero fs/gh work attempted", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const code = await reconCommand(["/some/dir", "--phase", "inventory"], {
    fs: realReconFsDeps,
    gh: fixtureReconGhGateway(),
    resolveOwnerRepo: () => {
      throw new Error("must not be called — arg parsing must fail before any resolution work");
    },
    runLens: async () => {
      throw new Error("must not be called — arg parsing must fail before any lens spawn");
    },
  });
  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /--phase must be "recon"/);
});

// ── defaultReconRunLens (the REAL, spawn-backed runLens `reconCommand` falls back to when no
// `deps.runLens` is injected) — driven with a fake `spawn`/`probeExec`/`config` so it never
// touches `loadConfig()` (unavailable in CI) or shells a real Agent SDK spawn, same DI shape
// as `runTask`'s own `opts.spawn ?? spawnWorker` / `opts.config ?? loadConfig()`. ────────────

const RECON_LENS_FAKE_CONFIG: Config = { claudeBin: "/usr/bin/true", root: mkdtempSync(join(tmpdir(), "rmd-recon-lens-config-")) };

/** A probeContainment `exec` that always reports the outside write OS-denied — matches
 *  test/containment.test.ts's own `denyingExec` fixture shape. */
const reconLensDenyingProbeExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

test("defaultReconRunLens: renders settings + probes containment ONCE, then spawns the injected fn per lens, returning its text", async () => {
  let spawnCalls = 0;
  const seenSettingsFiles: string[] = [];
  const runLens = defaultReconRunLens("/some/target-repo", "acme-corp", "widget-fixture", {
    config: RECON_LENS_FAKE_CONFIG,
    probeExec: reconLensDenyingProbeExec,
    spawn: async (opts) => {
      spawnCalls += 1;
      seenSettingsFiles.push(opts.settingsFile);
      return {
        sessionId: "s", costUsd: 0, numTurns: 1,
        text: `RECON_FINDING: found by ${opts.input.specialist} (source: a.ts:1)`,
        blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
        permissionDenials: [], childEnvKeys: [], model: "default", effort: "default",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
        compactionEvents: [], qualitySuspect: false,
      };
    },
  });

  const security = await runLens("security");
  const testing = await runLens("testing");

  assert.match(security, /found by security/);
  assert.match(testing, /found by testing/);
  assert.equal(spawnCalls, 2, "one spawn per lens call");
  assert.equal(seenSettingsFiles[0], seenSettingsFiles[1], "the rendered settings file is prepared ONCE and reused across lenses");
});

test("defaultReconRunLens: a spawn failure is advisory-only — returns '' and logs, never throws", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const runLens = defaultReconRunLens("/some/target-repo", "acme-corp", "widget-fixture", {
    config: RECON_LENS_FAKE_CONFIG,
    probeExec: reconLensDenyingProbeExec,
    spawn: async () => {
      throw new Error("boom — the lens worker died");
    },
  });

  const text = await runLens("design");

  assert.equal(text, "");
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /design lens unavailable \(advisory only, continuing\): boom/);
});

test("onboardCommand: a target directory that does not exist fails loud through the caught OnboardError — exit 2", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const parentDir = mkdtempSync(join(tmpdir(), "rmd-onboard-cmd-missing-"));
  const missingTargetDir = join(parentDir, "does-not-exist");

  const code = await onboardCommand([missingTargetDir, "--phase", "inventory"], {
    fs: realOnboardFsDeps,
    gh: fixtureOnboardGhGateway(),
    resolveOwnerRepo: () => ({ owner: "acme-corp", repo: "widget-fixture" }),
  });

  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /does not exist/);
});

test("onboardCommand: the fixture repo, --owner/--repo flags supplied, resolves phase 1, exits 0, and prints the full inventory summary", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const targetDir = mkdtempSync(join(tmpdir(), "rmd-onboard-cmd-ok-"));
  cpSync(ONBOARD_FIXTURE_REPO_DIR, targetDir, { recursive: true });

  const code = await onboardCommand([targetDir, "--phase", "inventory", "--owner", "acme-corp", "--repo", "widget-fixture"], {
    fs: realOnboardFsDeps,
    gh: fixtureOnboardGhGateway(),
    resolveOwnerRepo: () => {
      throw new Error("--owner/--repo were both supplied — resolveOwnerRepo must never be called");
    },
  });

  assert.equal(code, 0);
  const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printed, /rmd onboard .* --phase inventory/);
  assert.match(printed, /target: acme-corp\/widget-fixture/);
  assert.match(printed, /languages: /);
  assert.match(printed, /build systems: /);
  assert.match(printed, /CI systems: /);
  assert.match(printed, /docs: /);
  assert.match(printed, /test signals: /);
  assert.match(printed, /github: exists=true defaultBranch=main branchProtected=true openIssues=3 milestones=1/);
  assert.match(printed, /wrote .*inventory\.json/);
  assert.ok(existsSync(join(targetDir, "plan", "onboarding", "inventory.json")));
});

test("onboardCommand: owner/repo omitted falls through to the injected resolveOwnerRepo (auto-detection), not a hardcoded default", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const targetDir = mkdtempSync(join(tmpdir(), "rmd-onboard-cmd-resolve-"));
  cpSync(ONBOARD_FIXTURE_REPO_DIR, targetDir, { recursive: true });
  let sawTargetDir: string | undefined;

  const code = await onboardCommand([targetDir, "--phase", "inventory"], {
    fs: realOnboardFsDeps,
    gh: fixtureOnboardGhGateway(),
    resolveOwnerRepo: (dir) => {
      sawTargetDir = dir;
      return { owner: "resolved-org", repo: "resolved-repo" };
    },
  });

  assert.equal(code, 0);
  assert.equal(sawTargetDir, targetDir);
  const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printed, /target: resolved-org\/resolved-repo/);
});

// ── W1-T84: `rmd onboard <target-dir> --phase session` CLI wrapper ──────────────────────
// onboardCommand routes `--phase session` straight to sessionCommand (before inventory.ts's
// own parser ever sees it, mirroring the recon routing above). These tests exercise
// sessionCommand's own thin wrapper (parse args -> load/run the session -> print a summary)
// via its injectable deps seam, INCLUDING the no-TTY-never-blocks path (Standing rule 18).

function writeSessionInventory(targetDir: string): void {
  mkdirSync(join(targetDir, "plan", "onboarding"), { recursive: true });
  writeFileSync(
    join(targetDir, "plan", "onboarding", "inventory.json"),
    JSON.stringify({
      generatedAt: "2026-07-23T00:00:00.000Z",
      target: { owner: "acme-corp", repo: "widget-fixture" },
      languages: [],
      buildSystems: [],
      ciSystems: [],
      docs: {},
      testSignals: [],
      github: { repoExists: "unknown", defaultBranch: "unknown", branchProtected: "unknown", openIssueCount: "unknown", milestoneCount: "unknown" },
    }),
  );
}

test("onboardCommand: --phase session routes to sessionCommand — a missing target dir fails loud through sessionCommand's OWN parser", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const code = await onboardCommand(["--phase", "session"]);
  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /<target-dir> is required/);
});

test("sessionCommand: a bad --phase value (not \"session\") fails loud — exit 2, zero fs work attempted", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const code = await sessionCommand(["/some/dir", "--phase", "recon"], {
    fs: {
      existsSync: () => {
        throw new Error("must not be called — arg parsing must fail before any fs work");
      },
    } as never,
  });
  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /--phase must be "session"/);
});

test("sessionCommand: the phase-1 inventory artifact missing fails loud through the caught SessionError — exit 2", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const targetDir = mkdtempSync(join(tmpdir(), "rmd-onboard-session-cmd-missing-inventory-"));
  const code = await sessionCommand([targetDir, "--phase", "session"], { fs: realSessionFsDeps, isTTY: true, ask: async () => "x" });
  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /--phase inventory/);
});

test("sessionCommand: no TTY previews the unanswered backlog without ever calling ask, exits 0", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const targetDir = mkdtempSync(join(tmpdir(), "rmd-onboard-session-cmd-notty-"));
  writeSessionInventory(targetDir);

  const code = await sessionCommand([targetDir, "--phase", "session"], {
    fs: realSessionFsDeps,
    isTTY: false,
    ask: async () => {
      throw new Error("must not be called — no-TTY must never block on an operator");
    },
  });

  assert.equal(code, 0);
  const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printed, /no TTY on stdin/);
  assert.match(printed, /unanswered/);
  assert.ok(!existsSync(join(targetDir, "plan", "onboarding", "answers.json")), "no-TTY preview writes nothing");
});

test("sessionCommand: an interactive (TTY) session answers every question, writes answers.json + ledger.ndjson, exits 0", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const targetDir = mkdtempSync(join(tmpdir(), "rmd-onboard-session-cmd-tty-"));
  writeSessionInventory(targetDir);

  const code = await sessionCommand([targetDir, "--phase", "session"], {
    fs: realSessionFsDeps,
    isTTY: true,
    ask: async (q) => `operator answer for ${q.id}`,
  });

  assert.equal(code, 0);
  const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printed, /rmd onboard .* --phase session/);
  assert.match(printed, /answered this session/);
  assert.match(printed, /wrote .*answers\.json/);
  assert.match(printed, /wrote .*ledger\.ndjson/);
  assert.ok(existsSync(join(targetDir, "plan", "onboarding", "answers.json")));
  assert.ok(existsSync(join(targetDir, "plan", "onboarding", "ledger.ndjson")));
});

// ── W1-T85: `rmd onboard <target-dir> --phase synthesize` CLI wrapper ───────────────────
// onboardCommand routes `--phase synthesize` straight to synthesizeCommand (before
// inventory.ts's own parser ever sees it, mirroring the recon/session routing above).
// synthesizeCommand's own thin wrapper (parse args -> delegate to runOnboardSynthesize ->
// print a summary) is exercised here via its injectable deps seam — the module-level gate/
// draft-loop/git-gh-shape behavior is proven exhaustively in test/onboard-synthesize.test.ts;
// these tests only prove the CLI plumbing (exit codes, routing, the printed summary).

function synthesizeFixtureInventory(): Inventory {
  return {
    generatedAt: "2026-07-23T00:00:00.000Z",
    target: { owner: "acme-corp", repo: "widget-fixture" },
    languages: ["typescript"],
    buildSystems: ["npm"],
    ciSystems: ["github-actions"],
    docs: { readme: true },
    testSignals: ["node:test"],
    github: { repoExists: true, defaultBranch: "main", branchProtected: true, openIssueCount: 3, milestoneCount: 1 },
  };
}

function writeSynthesizeFixtureArtifacts(targetDir: string, answers: Record<string, OnboardAnswer> | undefined): void {
  const dir = join(targetDir, "plan", "onboarding");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "inventory.json"), JSON.stringify(synthesizeFixtureInventory(), null, 2));
  if (answers) writeFileSync(join(dir, "answers.json"), JSON.stringify(answers, null, 2));
}

function completeSynthesizeAnswers(): Record<string, OnboardAnswer> {
  const questions = generateOnboardQuestions(synthesizeFixtureInventory());
  return Object.fromEntries(
    questions.map((q, i) => [q.id, { id: q.id, decision: q.decision, question: q.question, answer: `fixture-answer-${i}` }]),
  );
}

const SYNTHESIZE_CLEAN_TASKS_YAML = `
- id: T-1
  title: "Ship the widget catalog search"
  repo: widget-fixture
  type: implement
  verify: auto
  risk: medium
  origin: "onboard:elicit-priorities"
  files: [src/catalog/search.ts]
  acceptance:
    - claim: "the widget catalog search ships"
      proof: "unit test: widget catalog search returns results"
`.trim();

const alwaysCleanSynthesizeDraft: SynthesizeDraftFn = async () => ({
  masterPlan: "# MASTER-PLAN.md\n",
  tasksYaml: SYNTHESIZE_CLEAN_TASKS_YAML,
  agentsMd: "# AGENTS.md\n",
});

// ── defaultSynthesizeDraft (the REAL, spawn-backed `draft` fn `synthesizeCommand` falls back
// to when no `deps.draft` is injected) — driven with a fake `spawn`/`probeExec`/`config` so it
// never touches `loadConfig()` (unavailable in CI) or shells a real Agent SDK spawn, same DI
// shape as `defaultReconRunLens`'s own test above (RECON_LENS_FAKE_CONFIG/reconLensDenyingProbeExec
// reused). Exercises all three prompt builders (MASTER-PLAN.md / tasks.yaml — with AND without
// redraft feedback / AGENTS.md) plus the settings-file-prepared-once-and-reused behavior. ──────

function synthesizeDraftFixtureInput(): SynthesizeDraftInput {
  return {
    inventory: synthesizeFixtureInventory(),
    candidates: [
      { text: "ship a fuzzy search over the board", source: { kind: "file", path: "ROADMAP.md", line: 3 }, confidence: "mined" },
    ] as Candidate[],
    answers: completeSynthesizeAnswers(),
    findings: "SECURITY_FINDING: none found",
    targetDir: "/some/target-repo",
    owner: "acme-corp",
    repo: "widget-fixture",
  };
}

test("defaultSynthesizeDraft: renders settings + probes containment ONCE, spawns 3 read-only workers (one per document), and returns their text trimmed", async () => {
  const seenPrompts: string[] = [];
  const seenSettingsFiles: string[] = [];
  const seenCwds: string[] = [];
  const draft = defaultSynthesizeDraft({
    config: RECON_LENS_FAKE_CONFIG,
    probeExec: reconLensDenyingProbeExec,
    spawn: async (opts: SpawnWorkerArgs): Promise<WorkerResult> => {
      seenPrompts.push(opts.prompt);
      seenSettingsFiles.push(opts.settingsFile);
      seenCwds.push(opts.cwd);
      return {
        sessionId: "s", costUsd: 0, numTurns: 1,
        text: "  drafted for doc  \n",
        blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
        permissionDenials: [], childEnvKeys: [], model: "default", effort: "default",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
        compactionEvents: [], qualitySuspect: false,
      };
    },
  });

  const input = synthesizeDraftFixtureInput();
  const result = await draft(input);

  assert.equal(result.masterPlan, "drafted for doc");
  assert.equal(result.tasksYaml, "drafted for doc");
  assert.equal(result.agentsMd, "drafted for doc");
  assert.equal(seenPrompts.length, 3, "one spawn per document");
  assert.ok(seenCwds.every((cwd) => cwd === input.targetDir), "each spawn runs against the target checkout");
  assert.equal(seenSettingsFiles[0], seenSettingsFiles[1]);
  assert.equal(seenSettingsFiles[1], seenSettingsFiles[2], "the rendered settings file is prepared ONCE and reused across all three spawns");

  const masterPlanPrompt = seenPrompts.find((p) => p.includes("Write this target repo's MASTER-PLAN.md"))!;
  assert.match(masterPlanPrompt, /acme-corp\/widget-fixture/);
  assert.match(masterPlanPrompt, /READ-ONLY/);
  assert.match(masterPlanPrompt, /SECURITY_FINDING: none found/);
  assert.match(masterPlanPrompt, /"widget-fixture"/, "the JSON-stringified inventory target is inlined verbatim");

  const tasksYamlPrompt = seenPrompts.find((p) => p.includes("Draft a CHANGE-LEVEL plan/tasks.yaml SEED"))!;
  assert.match(tasksYamlPrompt, /fuzzy search over the board/);
  assert.doesNotMatch(tasksYamlPrompt, /YOUR PREVIOUS DRAFT FAILED/, "no feedback block on a first attempt");

  const agentsMdPrompt = seenPrompts.find((p) => p.includes("Write this target repo's AGENTS.md"))!;
  assert.match(agentsMdPrompt, /no-touch zones and verify:human boundaries/);
});

test("defaultSynthesizeDraft: a redraft (feedback present) folds the prior lint-plan violations into the tasks.yaml prompt ONLY", async () => {
  const seenPrompts: string[] = [];
  const draft = defaultSynthesizeDraft({
    config: RECON_LENS_FAKE_CONFIG,
    probeExec: reconLensDenyingProbeExec,
    spawn: async (opts: SpawnWorkerArgs): Promise<WorkerResult> => {
      seenPrompts.push(opts.prompt);
      return {
        sessionId: "s", costUsd: 0, numTurns: 1, text: "doc",
        blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
        permissionDenials: [], childEnvKeys: [], model: "default", effort: "default",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
        compactionEvents: [], qualitySuspect: false,
      };
    },
  });

  await draft(synthesizeDraftFixtureInput(), ["task T-1 origin: is missing", "task T-2 proof: is prose, not executable"]);

  const tasksYamlPrompt = seenPrompts.find((p) => p.includes("Draft a CHANGE-LEVEL plan/tasks.yaml SEED"))!;
  assert.match(tasksYamlPrompt, /YOUR PREVIOUS DRAFT FAILED `rmd lint-plan`/);
  assert.match(tasksYamlPrompt, /task T-1 origin: is missing/);
  assert.match(tasksYamlPrompt, /task T-2 proof: is prose, not executable/);

  const masterPlanPrompt = seenPrompts.find((p) => p.includes("Write this target repo's MASTER-PLAN.md"))!;
  assert.doesNotMatch(masterPlanPrompt, /YOUR PREVIOUS DRAFT FAILED/, "feedback is scoped to the tasks.yaml prompt only");
});

test("onboardCommand: --phase synthesize routes to synthesizeCommand — a missing target dir fails loud through synthesizeCommand's OWN parser", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const code = await onboardCommand(["--phase", "synthesize"]);
  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /<target-dir> is required/);
});

test("synthesizeCommand: a bad --phase value (not \"synthesize\") fails loud — exit 2", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const code = await synthesizeCommand(["/some/dir", "--phase", "session"]);
  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /--phase must be "synthesize"/);
});

test("synthesizeCommand: a partial-answers fixture -> non-zero exit naming the unanswered question ids; no branch, no PR", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const targetDir = mkdtempSync(join(tmpdir(), "rmd-onboard-synth-cmd-partial-"));
  const partial = completeSynthesizeAnswers();
  delete partial["elicit-priorities"];
  writeSynthesizeFixtureArtifacts(targetDir, partial);

  const gitCalls: Array<{ args: string[]; cwd: string }> = [];
  const git: SynthesizeGitGateway = { exec: (args, cwd) => { gitCalls.push({ args, cwd }); return ""; } };
  const ghCalls: unknown[] = [];
  const gh: SynthesizeGhGateway = { openPr: (opts) => { ghCalls.push(opts); return "should-never-be-called"; } };

  const code = await synthesizeCommand([targetDir, "--phase", "synthesize"], {
    fs: realSynthesizeFsDeps,
    git,
    gh,
    draft: async () => {
      throw new Error("must not be called — the completeness gate must refuse before any draft");
    },
  });

  assert.equal(code, 2);
  const printedErr = errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printedErr, /elicit-priorities/);
  assert.match(printedErr, /unanswered question/);
  assert.equal(gitCalls.length, 0);
  assert.equal(ghCalls.length, 0);
});

test("synthesizeCommand: a complete-answers fixture with an already-clean draft exits 0 and prints branch + PR summary", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const targetDir = mkdtempSync(join(tmpdir(), "rmd-onboard-synth-cmd-ok-"));
  writeSynthesizeFixtureArtifacts(targetDir, completeSynthesizeAnswers());

  const git: SynthesizeGitGateway = { exec: () => "" };
  const gh: SynthesizeGhGateway = { openPr: () => "https://github.com/acme-corp/widget-fixture/pull/7" };

  const code = await synthesizeCommand([targetDir, "--phase", "synthesize"], {
    fs: realSynthesizeFsDeps,
    git,
    gh,
    draft: alwaysCleanSynthesizeDraft,
  });

  assert.equal(code, 0);
  const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printed, /rmd onboard .* --phase synthesize/);
  assert.match(printed, /branch: onboard\/widget-fixture-plan/);
  assert.match(printed, /wrote .*MASTER-PLAN\.md/);
  assert.match(printed, /wrote .*tasks\.yaml/);
  assert.match(printed, /wrote .*AGENTS\.md/);
  assert.match(printed, /opened draft PR: https:\/\/github\.com\/acme-corp\/widget-fixture\/pull\/7/);
});

// ── main()'s CLI dispatch: `cmd === "onboard"` must actually route to onboardCommand (not
// just exist as a registry entry — help-registry.test.ts already proves the latter, statically,
// without ever running main()). Same throwing-process.exit-mock shape wipe-test.test.ts's
// callMain() uses, duplicated locally rather than imported so this file doesn't reach into
// another test file's helper.
class OnboardProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

test("main(): `rmd onboard` with no target-dir dispatches to onboardCommand and exits 2 (fail loud, no fs/gh work)", async (t) => {
  const exitMock = ((code?: number): never => {
    throw new OnboardProcessExitCalled(code);
  }) as typeof process.exit;
  t.mock.method(process, "exit", exitMock);
  const errSpy = t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});

  const originalArgv = process.argv;
  process.argv = ["node", "run-task.js", "onboard"];
  const originalGuardEnv = process.env[SELF_SYNC_GUARD_ENV];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  try {
    let caught: unknown;
    await main().catch((e) => {
      caught = e;
    });
    assert.ok(caught instanceof OnboardProcessExitCalled, "main() must reach process.exit via onboardCommand's return value");
    assert.equal((caught as OnboardProcessExitCalled).code, 2);
    assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /<target-dir> is required/);
  } finally {
    process.argv = originalArgv;
    if (originalGuardEnv === undefined) {
      delete process.env[SELF_SYNC_GUARD_ENV];
    } else {
      process.env[SELF_SYNC_GUARD_ENV] = originalGuardEnv;
    }
  }
});

// ── W1-T84 coverage: the SessionError error branches + the real readlineAsk (injected streams) ──

test("sessionCommand: a MALFORMED inventory.json fails with a named SessionError, exits 2 (no-TTY path)", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const targetDir = mkdtempSync(join(tmpdir(), "rmd-onboard-session-bad-"));
  mkdirSync(join(targetDir, "plan", "onboarding"), { recursive: true });
  writeFileSync(join(targetDir, "plan", "onboarding", "inventory.json"), "{ not valid json", "utf8");
  const code = await sessionCommand([targetDir, "--phase", "session"], { fs: realSessionFsDeps, isTTY: false });
  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /exists but is not valid JSON/);
  rmSync(targetDir, { recursive: true, force: true });
});

test("readlineAsk: a numeric reply resolves to that candidate answer; free text is accepted verbatim — over injected in-memory streams", async () => {
  const { Readable, Writable } = await import("node:stream");
  const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });
  const question = {
    id: "q1",
    prompt: "pick",
    candidateAnswers: ["first-option", "second-option"],
  } as unknown as OnboardQuestion;

  const numeric = await readlineAsk(question, { input: Readable.from(["2\n"]), output: sink() });
  assert.equal(numeric, "second-option", "a numeric reply maps to that candidate's own text");

  const free = await readlineAsk(question, { input: Readable.from(["a custom answer\n"]), output: sink() });
  assert.equal(free, "a custom answer", "non-numeric input is the verbatim free-text answer");

  const outOfRange = await readlineAsk(question, { input: Readable.from(["9\n"]), output: sink() });
  assert.equal(outOfRange, "9", "a numeric out of range is not a candidate index — kept verbatim");
});

// ── W1-T90: dispatchAlertFixRun / alertFixCommand — the alert-fix lane's own CLI wiring, driven ──
// over injected AlertFixDispatchDeps/AlertFixCommandDeps so every branch (success/no-PR/error,
// dry-run/real, bad-arg) is a unit fixture, never a real `git worktree`/`gh`/Agent-SDK spawn —
// the SAME fake-the-boundary shape withMaterializedWorktree's injected `remove` and
// defaultReconRunLens's injected `spawn` already use in this file.

const ALERT_FIX_MEDIUM_ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "301",
  severity: "medium",
  state: "open",
  createdAt: "2026-07-20T00:00:00Z",
  summary: "unused variable",
  url: "https://github.com/craigoley/remudero/security/code-scanning/301",
  path: "src/lib/some-non-critical-file.ts",
};

const ALERT_FIX_CRITICAL_ALERT: AlertLaneAlert = {
  source: "dependabot",
  id: "302",
  severity: "critical",
  state: "open",
  createdAt: "2026-07-20T00:00:00Z",
  summary: "critical dependency vuln",
  url: "https://github.com/craigoley/remudero/security/dependabot/302",
};

function fakeAlertFixWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-alert-fix",
    costUsd: 0.01,
    numTurns: 1,
    text,
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
  } as unknown as WorkerResult;
}

const ALERT_FIX_MOUNT: Mount = { model: "fake-model", effort: "low", maxTurns: 5, contextBudget: 1000 };

function fakeAlertFixDispatchDeps(overrides: Partial<AlertFixDispatchDeps> = {}): {
  deps: AlertFixDispatchDeps;
  calls: { worktreeAdd: unknown[][]; worktreeRemove: unknown[][]; ensureTaskTrailer: unknown[][]; checkAcceptance: unknown[][] };
} {
  const calls = {
    worktreeAdd: [] as unknown[][],
    worktreeRemove: [] as unknown[][],
    ensureTaskTrailer: [] as unknown[][],
    checkAcceptance: [] as unknown[][],
  };
  const deps: AlertFixDispatchDeps = {
    worktreeAdd: (...args) => {
      calls.worktreeAdd.push(args);
    },
    worktreeRemove: (...args) => {
      calls.worktreeRemove.push(args);
    },
    renderWorkerSettings: () => "/tmp/fake-settings.json",
    loadMounts: () => ({}) as never,
    resolveMount: () => ALERT_FIX_MOUNT,
    spawn: async () => fakeAlertFixWorkerResult("REPORT\nPR_URL: https://github.com/craigoley/remudero/pull/999\n"),
    ensureTaskTrailer: (...args) => {
      calls.ensureTaskTrailer.push(args);
    },
    // Default: a healthy body (W1-T952) — most fixture PRs in this suite are not exercising the
    // acceptance-check branch, so the default must never manufacture a false positive there.
    checkAcceptance: (...args) => {
      calls.checkAcceptance.push(args);
      return { ok: true, message: "fixture default: healthy" };
    },
    ...overrides,
  };
  return { deps, calls };
}

test("dispatchAlertFixRun: a successful worker with a PR_URL logs dispatching/dispatched_worker/pr_opened and ensures the task trailer", async () => {
  const root = mkdtempSync(join(tmpdir(), "alert-fix-dispatch-ok-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const { deps, calls } = fakeAlertFixDispatchDeps();
  const config = { root } as Config;

  await dispatchAlertFixRun("craigoley", "remudero", config, ALERT_FIX_MEDIUM_ALERT, ledgerPath, "ALERT-FIX-TEST-1", deps);

  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const steps = lines.map((l) => l.step);
  assert.ok(steps.includes("alert-fix.dispatching"));
  assert.ok(steps.includes("alert-fix.dispatched_worker"));
  assert.ok(steps.includes("alert-fix.pr_opened"));
  assert.equal(calls.worktreeAdd.length, 1, "exactly one worktree add");
  assert.equal(calls.worktreeRemove.length, 1, "the worktree is torn down exactly once");
  assert.equal(calls.ensureTaskTrailer.length, 1);
  assert.equal(calls.ensureTaskTrailer[0][0], "https://github.com/craigoley/remudero/pull/999");
  rmSync(root, { recursive: true, force: true });
});

test("dispatchAlertFixRun: a worker that opens no PR logs alert-fix.no_pr and never calls ensureTaskTrailer", async () => {
  const root = mkdtempSync(join(tmpdir(), "alert-fix-dispatch-nopr-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const { deps, calls } = fakeAlertFixDispatchDeps({
    spawn: async () => fakeAlertFixWorkerResult("no report here, just prose"),
  });
  const config = { root } as Config;

  await dispatchAlertFixRun("craigoley", "remudero", config, ALERT_FIX_MEDIUM_ALERT, ledgerPath, "ALERT-FIX-TEST-2", deps);

  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.step === "alert-fix.no_pr"));
  assert.equal(calls.ensureTaskTrailer.length, 0, "no PR_URL means the trailer helper is never called");
  rmSync(root, { recursive: true, force: true });
});

test("dispatchAlertFixRun: a worktreeAdd failure is caught, logs alert-fix.error, and STILL tears down the worktree (best-effort finally)", async () => {
  const root = mkdtempSync(join(tmpdir(), "alert-fix-dispatch-err-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const { deps, calls } = fakeAlertFixDispatchDeps({
    worktreeAdd: () => {
      throw new Error("worktree add boom");
    },
  });
  const config = { root } as Config;

  await dispatchAlertFixRun("craigoley", "remudero", config, ALERT_FIX_MEDIUM_ALERT, ledgerPath, "ALERT-FIX-TEST-3", deps);

  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const errLine = lines.find((l) => l.step === "alert-fix.error");
  assert.ok(errLine, "the thrown worktreeAdd error is caught and logged");
  assert.match(String(errLine?.error), /worktree add boom/);
  assert.equal(calls.worktreeRemove.length, 1, "teardown still runs even though setup failed");
  rmSync(root, { recursive: true, force: true });
});

test("alertFixCommand: an unknown flag fails loud before any config/gh work — exit 2", async (t) => {
  const errSpy = t.mock.method(console, "error", () => {});
  const code = await alertFixCommand(["--bogus"], {
    resolveOwnerRepo: () => {
      throw new Error("must not be called — arg parsing fails first");
    },
  });
  assert.equal(code, 2);
  assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /--bogus/);
});

function fakeAlertGateway(alerts: AlertLaneAlert[]): AlertGateway {
  return {
    codeScanning: (_o, _r) => alerts.filter((a) => a.source === "code-scanning"),
    dependabot: (_o, _r) => alerts.filter((a) => a.source === "dependabot"),
    secretScanning: (_o, _r) => alerts.filter((a) => a.source === "secret-scanning"),
  };
}

test("alertFixCommand --dry-run: previews every open alert's disposition and dispatches/escalates nothing", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const code = await alertFixCommand(["--dry-run"], {
    config: { root: mkdtempSync(join(tmpdir(), "alert-fix-cmd-cfg-")) } as Config,
    resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    gateway: fakeAlertGateway([ALERT_FIX_MEDIUM_ALERT, ALERT_FIX_CRITICAL_ALERT]),
    dispatch: async () => {
      throw new Error("must not be called in --dry-run");
    },
    escalate: () => {
      throw new Error("must not be called in --dry-run");
    },
  });
  assert.equal(code, 0);
  const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printed, /code-scanning#301 \[medium\] -> act/);
  assert.match(printed, /dependabot#302 \[critical\] -> escalate/);
});

test("alertFixCommand --dry-run: zero open alerts prints 'no open alerts'", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const code = await alertFixCommand(["--dry-run"], {
    config: { root: mkdtempSync(join(tmpdir(), "alert-fix-cmd-cfg-")) } as Config,
    resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    gateway: fakeAlertGateway([]),
  });
  assert.equal(code, 0);
  assert.match(logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /no open alerts/);
});

test("alertFixCommand: a real (non-dry-run) pass dispatches the 'act' alert, escalates the 'escalate' alert, and prints the tally", async (t) => {
  const logSpy = t.mock.method(console, "log", () => {});
  const dispatched: AlertLaneAlert[] = [];
  const escalated: AlertLaneAlert[] = [];
  const root = mkdtempSync(join(tmpdir(), "alert-fix-cmd-real-"));
  const ledgerPath = join(root, "ledger.ndjson");

  const code = await alertFixCommand([], {
    config: { root } as Config,
    resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    gateway: fakeAlertGateway([ALERT_FIX_MEDIUM_ALERT, ALERT_FIX_CRITICAL_ALERT]),
    ledgerPath,
    runId: "ALERT-FIX-CMD-TEST",
    dispatch: async (alert) => {
      dispatched.push(alert);
    },
    escalate: (alert) => {
      escalated.push(alert);
      return "https://github.com/craigoley/remudero/issues/1";
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(dispatched.map((a) => a.id), ["301"]);
  assert.deepEqual(escalated.map((a) => a.id), ["302"]);
  const printed = logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n");
  assert.match(printed, /dispatched 1 · escalated 1/);
  rmSync(root, { recursive: true, force: true });
});

class AlertFixProcessExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

test("main(): `rmd alert-fix` with an unknown flag dispatches to alertFixCommand and exits 2 (fail loud, no fs/gh work)", async (t) => {
  const exitMock = ((code?: number): never => {
    throw new AlertFixProcessExitCalled(code);
  }) as typeof process.exit;
  t.mock.method(process, "exit", exitMock);
  const errSpy = t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});

  const originalArgv = process.argv;
  process.argv = ["node", "run-task.js", "alert-fix", "--bogus"];
  const originalGuardEnv = process.env[SELF_SYNC_GUARD_ENV];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  try {
    let caught: unknown;
    await main().catch((e) => {
      caught = e;
    });
    assert.ok(caught instanceof AlertFixProcessExitCalled, "main() must reach process.exit via alertFixCommand's return value");
    assert.equal((caught as AlertFixProcessExitCalled).code, 2);
    assert.match(errSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /--bogus/);
  } finally {
    process.argv = originalArgv;
    if (originalGuardEnv === undefined) {
      delete process.env[SELF_SYNC_GUARD_ENV];
    } else {
      process.env[SELF_SYNC_GUARD_ENV] = originalGuardEnv;
    }
  }
});

// ── W1-T254 light-sweep glue: the postReview effect (injected runner) + buildSweepLightHook ──

test("buildSweepEffects.postReview: ledgers attempt then done with the review exit — over an injected review runner (no real review spawned)", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const root = mkdtempSync(join(tmpdir(), "rmd-postreview-"));
  const effects = buildSweepEffects(
    "craigoley", "remudero", { root } as never, join(root, "ledger.ndjson"), "RUN-PR-1",
    { tasks: [] } as never,
    (step, extra) => { logs.push({ step, extra }); },
    DEFAULT_SWEEP_POLICY,
    async () => 0, // injected review runner: a clean review
  );
  await effects.postReview!({ prNumber: 720, headSha: "deadbeef" } as never);
  assert.ok(logs.some((l) => l.step === "sweep.post_review.attempt" && l.extra?.pr_number === 720));
  const done = logs.find((l) => l.step === "sweep.post_review.done");
  assert.ok(done, "a completed review ledgers post_review.done");
  assert.equal(done!.extra?.exit, 0);
  rmSync(root, { recursive: true, force: true });
});

test("buildSweepEffects.postReview: a THROWING review runner ledgers post_review.failed and RETHROWS — runSweep's per-PR containment still marks acted:false", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const root = mkdtempSync(join(tmpdir(), "rmd-postreview-fail-"));
  const effects = buildSweepEffects(
    "craigoley", "remudero", { root } as never, join(root, "ledger.ndjson"), "RUN-PR-2",
    { tasks: [] } as never,
    (step, extra) => { logs.push({ step, extra }); },
    DEFAULT_SWEEP_POLICY,
    async () => { throw new Error("review spawn failed"); },
  );
  await assert.rejects(async () => { await effects.postReview!({ prNumber: 721, headSha: "cafe" } as never); }, /review spawn failed/);
  const failed = logs.find((l) => l.step === "sweep.post_review.failed");
  assert.ok(failed, "the failure is ledgered distinctly before the rethrow");
  assert.match(String(failed!.extra?.error), /review spawn failed/);
  rmSync(root, { recursive: true, force: true });
});

// W1-T195: the clarification rung's REAL `escalate` closure (never the mocked
// `deps.escalate` every other sweep.test.ts fixture substitutes) carries the composite
// dedup key's headSha/cause onto the issue it opens — a `gh` shim on PATH captures the
// exact `gh issue create --body ...` args so this proves the values actually reach the
// rendered issue, not merely that the closure was constructed.
test("buildSweepEffects.escalate: the real clarification-rung closure carries pr.headSha and escalationCause(...) onto the created issue's body", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-escalate-"));
  const bin = mkdtempSync(join(tmpdir(), "gh-sweep-escalate-"));
  const callsFile = join(bin, "calls.ndjson");
  writeFileSync(callsFile, "");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "label" && args[1] === "create") {
  process.exit(0);
} else if (args[0] === "api") {
  process.stdout.write("[]");
} else if (args[0] === "issue" && args[1] === "create") {
  process.stdout.write("https://github.com/acme/remudero/issues/999\\n");
} else {
  process.stdout.write("{}");
}
`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const effects = buildSweepEffects(
      "acme", "remudero", { root } as never, join(root, "ledger.ndjson"), "SWEEP-ESC-1",
      { tasks: [] } as never,
      () => {},
      DEFAULT_SWEEP_POLICY,
    );
    const pr = {
      prNumber: 999,
      prUrl: "https://github.com/acme/remudero/pull/999",
      taskId: "W1-TESC",
      headSha: "feedface00112233445566778899aabbccddeef",
      checksState: "red", // isBlockedCi(pr) -> true -> cause "ci"
      mergeState: "clean", // not "dirty" -> conflict is ruled out
    } as never;
    const question = {
      taskId: "W1-TESC",
      prNumber: 999,
      prUrl: "https://github.com/acme/remudero/pull/999",
      question: "which fix should land?",
      criterion: "",
      reviewerRequirement: "",
      specText: "",
      strikeHistory: [],
      resolutions: [
        { label: "hand-fix", detail: "d1" },
        { label: "close", detail: "d2" },
      ],
    } as never;

    withLiveWritesAllowed(() => effects.escalate(pr, "checks are red with no single nameable unmet criterion", question));

    const calls: string[][] = readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const createCall = calls.find((c) => c[0] === "issue" && c[1] === "create");
    assert.ok(createCall, `expected an 'issue create' gh call; calls=${JSON.stringify(calls)}`);
    const body = createCall![createCall!.indexOf("--body") + 1];
    assert.match(
      body,
      /\*\*Head:\*\* feedface00112233445566778899aabbccddeef/,
      "pr.headSha rides the composite dedup key onto the issue body",
    );
    assert.match(body, /\*\*Cause:\*\* ci/, "isBlockedCi(pr) (checksState: red) classifies as the 'ci' cause");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

// W1-T905: `buildSweepEffects`'s `captureRepairFeedbackImpl` default (unlike every other
// injectable dep on this function) closes over the module-level `repoRoot` const directly —
// there is no fixture-root seam for it, the SAME "UNREDIRECTABLE" shape
// test/config-reader-seams.test.ts already documents for `repoRoot`/`loadDefaultPolicy()`
// consumers. So, exactly like test/feedback-landing.test.ts's own "write a REAL entry into
// THIS checkout's own plan/feedback/" precedent, this drives the DEFAULT wiring end to end
// against the real checkout, with a fresh timestamped id so it can never collide, cleaned up
// in `finally` regardless of outcome. `captureFeedback`'s own landing attempt is best-effort
// and NEVER throws (feedback.ts's own doc); its force-push leg is refused outright by the
// live-write guard under the test runner, so this never pushes or opens a PR against the
// real repo — only the local `plan/feedback/<id>.yaml` write (feedback.ts's durable half)
// is observable here, exactly what `readFeedbackEntry` below confirms.
test("buildSweepEffects.captureRepairFeedback: the DEFAULT wiring (no override) runs the real existsSync dedup + real captureFeedback against repoRoot (W1-T905)", () => {
  const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
  const id = `fb-repair-w1t905-coverage-${Date.now()}`;
  const entryPath = feedbackEntryPath(REPO_ROOT, id);
  assert.ok(!existsSync(entryPath), "sanity: this fresh, timestamped id must not already exist in this checkout");
  try {
    const effects = buildSweepEffects(
      "acme", "remudero", { root: REPO_ROOT } as never, join(REPO_ROOT, "ledger.ndjson"), "SWEEP-COV-1",
      { tasks: [] } as never,
      () => {},
    );
    assert.ok(effects.captureRepairFeedback, "the default wiring must expose captureRepairFeedback");
    const filing: RepairFilingCapture = { id, raw: "W1-T905 coverage fixture — repair#coverage-fixture", origin: "repair#coverage-fixture" };

    effects.captureRepairFeedback!(filing);
    assert.ok(existsSync(entryPath), "the DEFAULT captureRepairFeedbackImpl really wrote a real entry under repoRoot");
    const entry = readFeedbackEntry(REPO_ROOT, id);
    assert.equal(entry.status, "new");
    assert.equal(entry.origin, "repair#coverage-fixture");
    assert.equal(entry.raw, filing.raw);

    // A SECOND call at the SAME id must hit the existsSync dedup and return without a second
    // write — proving the guard line itself, not only the write beneath it.
    const before = readFileSync(entryPath, "utf8");
    effects.captureRepairFeedback!({ ...filing, raw: "a second, different raw body that must never land" });
    assert.equal(readFileSync(entryPath, "utf8"), before, "the existsSync dedup must have skipped a second write");
  } finally {
    rmSync(entryPath, { force: true });
  }
});

test("buildSweepLightHook: runs the restricted light sweep over an empty PR set (offline gh) without touching a dangerous lane, best-effort on error", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-lighthook-"));
  const bin = mkdtempSync(join(tmpdir(), "gh-empty-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  try {
    const hook = buildSweepLightHook("craigoley", "remudero", { root } as never, join(root, "ledger.ndjson"), "RUN-LH-1", { tasks: [] } as never, (step, extra) => { logs.push({ step, extra }); });
    await hook(); // empty PR list -> runSweep over nothing; the hook body executes end to end
    // The pass ran to a clean summary (never the error catch) and, over an empty
    // set, took NO action — so no dangerous lane (fix/close/arm/escalate) fired.
    const summary = logs.find((l) => l.step === "sweep.summary");
    assert.ok(summary, "the light pass ran runSweep to its sweep.summary");
    assert.equal(summary!.extra?.total, 0, "no open PRs to reconcile");
    assert.equal(summary!.extra?.actions_taken, 0, "an empty set takes no action");
    assert.ok(!logs.some((l) => l.step === "sweep_light.error"), "the happy path never hit the error catch");
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T463 acceptance 3: "no second review lane ships until criterion one is answered" ──
// The fix this task ships (`runSweepLightPass`, src/lib/sweep.ts) makes `buildSweepLightHook`
// process every open PR's own `runSweep` call CONCURRENTLY instead of the whole snapshot
// sequentially — but it is NOT a second lane: it is the SAME single restricted hook, still
// gated by the SAME `actionable: d => d === "post-review"` predicate. This proves that
// restriction survived the concurrency change over a MIXED-disposition, multi-PR set: a
// mergeable PR and a checks-red PR both stand down ("deferred to full sweep (light pass)")
// exactly as they did before W1-T463, even though both are now dispositioned and processed in
// parallel rather than one after another.
function ghStubForTwoMixedDispositionPrs(): string {
  return `#!/usr/bin/env node
const a = process.argv.slice(2).join(" ");
if (a.includes("required_status_checks")) {
  process.stdout.write(JSON.stringify({ contexts: ["ci-gate", "remudero-review"] }));
  process.exit(0);
}
if (a.includes("pulls?state=open")) {
  process.stdout.write(JSON.stringify([
    {
      number: 900, html_url: "https://github.com/o/r/pull/900", state: "open",
      body: "Remudero-Task: W1-T900\\n", updated_at: "2026-07-30T00:00:00Z",
      head: { ref: "run-W1-T900-1", sha: "aaaa900000000000000000000000000000000a" },
      auto_merge: null,
    },
    {
      number: 901, html_url: "https://github.com/o/r/pull/901", state: "open",
      body: "Remudero-Task: W1-T901\\n", updated_at: "2026-07-30T00:00:00Z",
      head: { ref: "run-W1-T901-1", sha: "bbbb901000000000000000000000000000000b" },
      auto_merge: null,
    },
  ]));
  process.exit(0);
}
if (a.includes("aaaa900") && a.includes("check-runs")) {
  process.stdout.write(JSON.stringify({ check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] }));
  process.exit(0);
}
if (a.includes("aaaa900") && a.includes("/status")) {
  process.stdout.write(JSON.stringify({ statuses: [{ context: "remudero-review", state: "success" }] }));
  process.exit(0);
}
if (a.includes("bbbb901") && a.includes("check-runs")) {
  process.stdout.write(JSON.stringify({ check_runs: [{ name: "ci-gate", status: "completed", conclusion: "failure" }] }));
  process.exit(0);
}
if (a.includes("bbbb901") && a.includes("/status")) {
  process.stdout.write(JSON.stringify({ statuses: [] }));
  process.exit(0);
}
process.stdout.write("{}");
`;
}

test("buildSweepLightHook (W1-T463): the concurrency fix does not widen what fires — a mergeable PR and a checks-red PR both still stand down 'deferred to full sweep (light pass)', processed together, never armed/fixed/escalated", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-lighthook-mixed-"));
  const bin = mkdtempSync(join(tmpdir(), "gh-mixed-"));
  writeFileSync(join(bin, "gh"), ghStubForTwoMixedDispositionPrs(), { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  try {
    const hook = buildSweepLightHook(
      "o", "r", { root } as never, join(root, "ledger.ndjson"), "RUN-LH-MIXED",
      { tasks: [] } as never,
      (step, extra) => { logs.push({ step, extra }); },
    );
    await hook();
    assert.ok(!logs.some((l) => l.step === "sweep_light.error"), `no internal failure; logs=${JSON.stringify(logs)}`);
    const disposed = logs.filter((l) => l.step === "sweep.dispose");
    assert.equal(disposed.length, 2, "both PRs were dispositioned — the concurrency fix still reaches every open PR");
    for (const l of disposed) {
      assert.notEqual(l.extra?.disposition, "post-review", "neither fixture PR is post-review-eligible in this stub");
      assert.equal(l.extra?.acted, false, `PR #${l.extra?.pr_number} (${l.extra?.disposition}) must stand down — not actionable in the light pass`);
    }
    const notOpen = logs.filter((l) => l.step === "sweep.dispose.not_open");
    assert.equal(notOpen.length, 2, "both stand-downs are named on the ledger, never silent");
    assert.ok(
      notOpen.every((l) => /deferred to full sweep \(light pass\)/.test(String(l.extra?.reason))),
      `both PRs deferred to the full sweep, unchanged by the concurrency fix; notOpen=${JSON.stringify(notOpen)}`,
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemonCommand: builds the real daemon deps (sweep + sweepLight wiring) then a present STOP returns exit 0 before any dispatch/sweep/gh (W1-T254)", async () => {
  // loadConfig() takes no injection and reads $HOME, so redirect HOME at a throwaway
  // dir: the REAL daemonCommand then runs entirely against tmp state, never the live
  // daemon's root or drain lock. Pre-write the config so loadConfig takes the read path
  // (no `which claude` shell-out). A present STOP is consulted FIRST in runDaemon, before
  // refreshMerged/sweep/dispatch — so the deps object is CONSTRUCTED (covering the
  // sweep/sweepLight wiring) with zero gh reads and zero spawns.
  const home = mkdtempSync(join(tmpdir(), "rmd-daemoncmd-"));
  const oldHome = process.env.HOME;
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n"); // an empty plan; STOP returns before it is ever scheduled
  // `home` starts with RMD_TMP_PREFIX ("rmd-"), the exact prefix daemonCommand's OWN real
  // boot-time `sweepStaleTempDirs` (lib/tmp.ts) reaps anything under os.tmpdir() matching, by
  // AGE (`now() - mtimeMs > maxAgeMs`, default 24h). Every mkdirSync/writeFileSync above this
  // line updates `home`'s own mtime to the REAL OS clock (mtimes are not shiftable, same
  // mechanism CLOCK_ARTIFACTS' prune-liveness/serve.glance entries cite) — under clock-sweep's
  // future shift that real mtime reads as ancient, so the daemon's own real housekeeping sweep
  // deletes this fixture (the STOP file requestStop is about to write, included) before
  // daemonCommand ever consults it. Stamping `home`'s mtime from the (possibly shifted)
  // injected clock keeps this fixture's own age reading consistent with `Date.now()` regardless
  // of shift, the same "stamp from the injected clock" remedy #2250 established for ledger `ts`.
  utimesSync(home, new Date(), new Date());
  process.env.HOME = home;
  try {
    requestStop(root, "unit test");
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath]);
    assert.equal(code, 0, "a present STOP returns a clean exit 0, nothing dispatched or swept");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── W1-T109: `rmd daemon-plist`'s CLI wiring bakes --allow-self-target consent into the unit ──
// The refuse/bake DECISION itself is proven at the lib/launchd.ts level (test/launchd.test.ts,
// over generateLaunchdPlist directly). These tests prove the CLI EDGE: daemonPlistCommand
// actually computes isSelfTarget/allowSelfTarget from the real --repo arg + resolveOwnerRepo()
// (this checkout's own origin is craigoley/remudero) and threads them through, so a self-target
// invocation really does refuse without the flag and really does succeed with it — not just the
// pure generator in isolation.
// ALSO provisions the default install root (W1-T924's `resolveInstallRoot`: `<root>/daemon-
// install`, unset `config.installRoot`) with a stub `bin/rmd`, so `generateLaunchdPlist`'s
// W1-T925 install-checkout-exists gate never fires ahead of the self-target gate these tests
// are actually exercising — the same provisioning `rmd install-checkout --write` performs for
// real, stood up by hand here since these tests never shell out to git.
function daemonPlistTestHome(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-daemonplist-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "daemon-install", "bin"), { recursive: true });
  writeFileSync(join(root, "daemon-install", "bin", "rmd"), "#!/bin/sh\nexit 0\n");
  return { home, root };
}

test("daemonPlistCommand: --repo omitted (self-default) without --allow-self-target REFUSES — throws before any write", async () => {
  const { home } = daemonPlistTestHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await assert.rejects(
      () => daemonPlistCommand([]),
      (e: unknown) => e instanceof LaunchdPlistError && /--allow-self-target/.test((e as Error).message),
    );
    assert.equal(
      existsSync(join(home, "Library", "LaunchAgents")),
      false,
      "a refused generation must write nothing — no LaunchAgents dir ever created",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("daemonPlistCommand: --repo pointed at THIS checkout's own repo without --allow-self-target also REFUSES (not just the absent-repo default)", async () => {
  const { home } = daemonPlistTestHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await assert.rejects(
      () => daemonPlistCommand(["--repo", "remudero"]),
      (e: unknown) => e instanceof LaunchdPlistError && /--allow-self-target/.test((e as Error).message),
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("daemonPlistCommand: self-target + --allow-self-target succeeds and bakes the flag into the WRITTEN unit", async () => {
  const { home } = daemonPlistTestHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await daemonPlistCommand(["--repo", "remudero", "--allow-self-target", "--write"]);
    assert.equal(code, 0);
    const plistPath = join(home, "Library", "LaunchAgents", "com.remudero.daemon.plist");
    const written = readFileSync(plistPath, "utf8");
    assert.match(written, /--allow-self-target/, "consent must be baked into ProgramArguments, not just accepted");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("daemonPlistCommand: a NON-self --repo needs no --allow-self-target and the flag is never baked in", async () => {
  const { home } = daemonPlistTestHome();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await daemonPlistCommand(["--repo", "remudero-sandbox", "--write"]);
    assert.equal(code, 0);
    const plistPath = join(home, "Library", "LaunchAgents", "com.remudero.daemon.plist");
    const written = readFileSync(plistPath, "utf8");
    assert.doesNotMatch(written, /--allow-self-target/, "a non-self target never carries the self-target flag");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── W1-T925 (fb-1784913390318-1fcb63): "which checkout is production?" must never be answered
// by a `cd` — every generated unit's ProgramArguments[0] comes from the RESOLVED INSTALL ROOT
// (W1-T924's `resolveInstallRoot`, config-derived), never `repoRoot` (the git toplevel of
// whichever tree this CLI process happened to be invoked from). ──────────────────────────────

test("daemonPlistCommand: ProgramArguments[0] is the install root's bin/rmd, never THIS invoking checkout's own repoRoot/bin/rmd (acceptance criterion 1)", async () => {
  const { home, root } = daemonPlistTestHome();
  const installRoot = join(root, "daemon-install"); // resolveInstallRoot's default: config.installRoot unset
  const expectedBin = join(installRoot, "bin", "rmd");
  const printed: string[] = [];
  const oldLog = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.join(" "));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const code = await daemonPlistCommand(["--repo", "remudero-sandbox"]);
    assert.equal(code, 0);
  } finally {
    console.log = oldLog;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
  const out = printed.join("\n");
  assert.match(out, new RegExp(`<string>${expectedBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
  // THIS repo's real toplevel (what `repoRoot` resolves to for this very process) is a
  // COMPLETELY different tree from the throwaway fixture's install root above — proving the
  // generated unit tracks config, never the checkout this test (or `rmd daemon-plist` for real)
  // happened to run from.
  const thisCheckoutRoot = execFileSync("git", ["-C", process.cwd(), "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const cwdDerivedBin = join(thisCheckoutRoot, "bin", "rmd");
  assert.notEqual(cwdDerivedBin, expectedBin, "the fixture's install root must differ from this checkout's own root for the negative assertion below to mean anything");
  assert.doesNotMatch(
    out,
    new RegExp(cwdDerivedBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "never bakes in whichever checkout the generator happened to be invoked from",
  );
});

test("daemon-plist, deploy-plist, digest-plist and serve-plist ALL bake the SAME install-derived rmdBin from the SAME config — no one unit is left on a cwd-derived path (acceptance criterion 3)", async () => {
  const { home, root } = daemonPlistTestHome();
  const expectedBin = join(root, "daemon-install", "bin", "rmd");
  const needle = new RegExp(`<string>${expectedBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`);
  const oldHome = process.env.HOME;
  const oldEnvHost = process.env.RMD_SERVE_HOST;
  process.env.HOME = home;
  delete process.env.RMD_SERVE_HOST;
  const printed: string[] = [];
  const oldLog = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.join(" "));
  try {
    printed.length = 0;
    assert.equal(await daemonPlistCommand(["--repo", "remudero-sandbox"]), 0);
    assert.match(printed.join("\n"), needle, "daemon-plist");

    printed.length = 0;
    assert.equal(await deployPlistCommand([]), 0);
    assert.match(printed.join("\n"), needle, "deploy-plist");

    printed.length = 0;
    assert.equal(await digestPlistCommand([]), 0);
    assert.match(printed.join("\n"), needle, "digest-plist");

    printed.length = 0;
    assert.equal(await servePlistCommand([]), 0);
    assert.match(printed.join("\n"), needle, "serve-plist");
  } finally {
    console.log = oldLog;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldEnvHost !== undefined) process.env.RMD_SERVE_HOST = oldEnvHost;
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildSweepLightHook: an internal failure (malformed gh output) is caught + ledgered sweep_light.error, never propagated — the ticker never kills daemon liveness", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-lighthook-err-"));
  const bin = mkdtempSync(join(tmpdir(), "gh-bad-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "not json {["\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Array<{ step: string }> = [];
  try {
    const hook = buildSweepLightHook("craigoley", "remudero", { root } as never, join(root, "ledger.ndjson"), "RUN-LH-ERR", { tasks: [] } as never, (step) => { logs.push({ step }); });
    await hook(); // buildOpenPrViews throws on malformed gh output -> caught, ledgered, not thrown
    assert.ok(logs.some((l) => l.step === "sweep_light.error"), "the internal failure is ledgered, never propagated");
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T255: serviceFreshnessGate — assess + ledger, NEVER refuse/exit/re-exec ───────────────
import type { ServiceFreshness } from "../src/lib/self-sync.js";

function readSteps(ledgerPath: string): string[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).step as string);
}

test("serviceFreshnessGate: a DIRTY+BEHIND assessment ledgers BOTH daemon.tree_dirty and daemon.stale_code — never a refusal or exit (the daemon crash-loop, now a no-op)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-svc-gate-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const assessed: ServiceFreshness = { status: "assessed", dirty: true, behind: { oldSha: "aaaaaaa", newSha: "bbbbbbb" } };
  // W1-T151: this test is about the dirty/behind ledger lines, not install-freshness —
  // stub ensureInstallFresh so it never shells out to a real `npm ci` against this
  // package.json-less tmp dir (the real default is exercised by its own dedicated tests).
  serviceFreshnessGate("daemon", dir, {} as NodeJS.ProcessEnv, {
    checkServiceFreshness: () => assessed,
    ledgerPath,
    ensureInstallFresh: () => false,
  });
  const steps = readSteps(ledgerPath);
  assert.ok(steps.includes("daemon.tree_dirty"), "dirty tree ledgered daemon.tree_dirty");
  assert.ok(steps.includes("daemon.stale_code"), "behind origin ledgered daemon.stale_code");
});

test("serviceFreshnessGate: an up-to-date clean assessment ledgers NOTHING (a total no-op)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-svc-gate-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  serviceFreshnessGate("serve", dir, {} as NodeJS.ProcessEnv, {
    checkServiceFreshness: () => ({ status: "assessed", dirty: false, behind: null }),
    ledgerPath,
    ensureInstallFresh: () => false,
  });
  assert.deepEqual(readSteps(ledgerPath), []);
});

test("serviceFreshnessGate: a guarded/degraded assessment ledgers nothing and never throws (a service is never blocked)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-svc-gate-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  serviceFreshnessGate("daemon", dir, {} as NodeJS.ProcessEnv, { checkServiceFreshness: () => ({ status: "guarded" }), ledgerPath });
  serviceFreshnessGate("daemon", dir, {} as NodeJS.ProcessEnv, { checkServiceFreshness: () => ({ status: "degraded", reason: "fetch failed" }), ledgerPath });
  assert.deepEqual(readSteps(ledgerPath), []);
});

test("main(): a SERVICE command (daemon) runs the freshness GATE — never the interactive refuse-exit — then dispatches; a bad daemon flag still exits 2, proving the service path was taken without exit-1'ing on tree state", async (t) => {
  const exitMock = ((code?: number): never => {
    throw new OnboardProcessExitCalled(code);
  }) as typeof process.exit;
  t.mock.method(process, "exit", exitMock);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const originalArgv = process.argv;
  process.argv = ["node", "run-task.js", "daemon", "--not-a-real-flag"];
  // Guarded => the service freshness gate is a no-op (no git, no ledger, no loadConfig) — the point
  // of THIS test is only that main() takes the service branch and NEVER exit-1s on tree state.
  const originalGuardEnv = process.env[SELF_SYNC_GUARD_ENV];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  try {
    let caught: unknown;
    await main().catch((e) => {
      caught = e;
    });
    assert.ok(caught instanceof OnboardProcessExitCalled, "main() reached process.exit via daemonCommand — the service path never refused on tree state");
    assert.equal((caught as OnboardProcessExitCalled).code, 2, "a bad daemon flag exits 2 (daemonCommand fail-loud), reached only AFTER the service freshness gate ran");
  } finally {
    process.argv = originalArgv;
    if (originalGuardEnv === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = originalGuardEnv;
  }
});

// ── W1-T151: INSTALL FRESHNESS — a pull that changes package.json/package-lock.json (or adds
// a workspaces layout) triggers npm install BEFORE build/serve proceeds; a matching hash never
// redundantly reinstalls ─────────────────────────────────────────────────────────────────────

function installFixtureDir(pkg: string, lock: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-install-freshness-"));
  writeFileSync(join(dir, "package.json"), pkg);
  writeFileSync(join(dir, "package-lock.json"), lock);
  return dir;
}

test("hashInstallInputs: changes when EITHER package.json or package-lock.json changes; missing files hash deterministically", () => {
  const dir = installFixtureDir('{"name":"x","version":"1.0.0"}', '{"lockfileVersion":3}');
  const h1 = hashInstallInputs(dir);
  assert.equal(hashInstallInputs(dir), h1, "same content -> same hash, deterministic");

  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
  const h2 = hashInstallInputs(dir);
  assert.notEqual(h2, h1, "package-lock.json content change moves the hash");

  writeFileSync(join(dir, "package.json"), '{"name":"x","version":"1.0.0","workspaces":["packages/*"]}');
  const h3 = hashInstallInputs(dir);
  assert.notEqual(h3, h2, "package.json content change (e.g. adding workspaces) ALSO moves the hash");

  const emptyDir = mkdtempSync(join(tmpdir(), "rmd-install-freshness-empty-"));
  assert.doesNotThrow(() => hashInstallInputs(emptyDir), "no package.json/lock yet -> hashes empty content, never throws");
});

test("ensureInstallFresh: no persisted marker (fresh clone) -> installs exactly once and persists the marker hash", () => {
  const dir = installFixtureDir('{"name":"x"}', '{"lockfileVersion":3}');
  let installs = 0;
  const installed = ensureInstallFresh(dir, { install: () => { installs++; } });
  assert.equal(installed, true);
  assert.equal(installs, 1);
  assert.equal(readFileSync(installHashMarkerPath(dir), "utf8"), hashInstallInputs(dir));
});

test("ensureInstallFresh: a MATCHING persisted hash is a total no-op — the no-redundant-install falsifier", () => {
  const dir = installFixtureDir('{"name":"x"}', '{"lockfileVersion":3}');
  let installs = 0;
  ensureInstallFresh(dir, { install: () => { installs++; } }); // primes the marker
  assert.equal(installs, 1);
  const installed = ensureInstallFresh(dir, { install: () => { installs++; } });
  assert.equal(installed, false, "matching hash -> no install triggered");
  assert.equal(installs, 1, "install was NOT called a second time");
});

test("ensureInstallFresh: a package-lock.json change AFTER the marker was primed triggers exactly one more install", () => {
  const dir = installFixtureDir('{"name":"x"}', '{"lockfileVersion":3}');
  let installs = 0;
  ensureInstallFresh(dir, { install: () => { installs++; } });
  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{"a":"1"}}');
  const installed = ensureInstallFresh(dir, { install: () => { installs++; } });
  assert.equal(installed, true);
  assert.equal(installs, 2);
});

test("ensureInstallFresh: the workspace-conversion fixture (CI-green, operator-broke) is caught — a workspaces field added to package.json + a lock change makes the check detect + install", () => {
  const dir = installFixtureDir('{"name":"x","version":"1.0.0"}', '{"lockfileVersion":3}');
  let installs = 0;
  ensureInstallFresh(dir, { install: () => { installs++; } }); // pre-conversion state, marker primed

  // The conversion: package.json gains `workspaces`, package-lock.json regenerates.
  writeFileSync(
    join(dir, "package.json"),
    '{"name":"x","version":"1.0.0","workspaces":["packages/*","apps/*"]}',
  );
  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{"packages/api-client":{}}}');

  const preFixHash = readFileSync(installHashMarkerPath(dir), "utf8");
  assert.notEqual(
    hashInstallInputs(dir),
    preFixHash,
    "the conversion DID change the hash — the pre-fix path (no install call at all) would silently run stale node_modules against the new workspaces layout",
  );

  const installed = ensureInstallFresh(dir, { install: () => { installs++; } });
  assert.equal(installed, true, "the conversion is detected and install runs — the regression this fixture exists to catch");
  assert.equal(installs, 2);
});

test("serviceFreshnessGate: an assessed tick that needs an install ledgers daemon.install_freshness; a matching hash ledgers nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-svc-gate-install-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const assessed: ServiceFreshness = { status: "assessed", dirty: false, behind: null };

  serviceFreshnessGate("daemon", dir, {} as NodeJS.ProcessEnv, {
    checkServiceFreshness: () => assessed,
    ledgerPath,
    ensureInstallFresh: () => true,
  });
  assert.ok(readSteps(ledgerPath).includes("daemon.install_freshness"), "an install that ran is ledgered");

  const ledgerPath2 = join(dir, "ledger2.ndjson");
  serviceFreshnessGate("serve", dir, {} as NodeJS.ProcessEnv, {
    checkServiceFreshness: () => assessed,
    ledgerPath: ledgerPath2,
    ensureInstallFresh: () => false,
  });
  assert.deepEqual(readSteps(ledgerPath2), [], "a matching hash (no install) ledgers nothing — no redundant noise");
});

test("serviceFreshnessGate: guarded/degraded NEVER consults ensureInstallFresh at all — a service is never blocked checking its own deps", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-svc-gate-install-guard-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  let calls = 0;
  serviceFreshnessGate("daemon", dir, {} as NodeJS.ProcessEnv, {
    checkServiceFreshness: () => ({ status: "guarded" }),
    ledgerPath,
    ensureInstallFresh: () => {
      calls++;
      return true;
    },
  });
  assert.equal(calls, 0, "guarded status short-circuits before install-freshness is ever consulted");
});

// ── fb-1784756088300-6a481e: the escalation-lifecycle reconciler's candidate builder + closer ──

function reconLedger(): string {
  const p = join(mkdtempSync(join(tmpdir(), "rmd-recon-")), "ledger.ndjson");
  writeFileSync(p, "");
  return p;
}

function reconPlan(taskId: string): Plan {
  const t = {
    id: taskId, title: taskId, repo: "remudero", depends_on: [], type: "implement",
    verify: "auto", risk: "medium", status: "queued", attempts: 0, origin: "architect", acceptance: [],
  } as unknown as Task;
  return { tasks: [t], byId: new Map([[taskId, t]]) };
}

test("buildEscalationReconcileCandidates: an open needs-human issue whose referenced task is MERGED yields a candidate carrying the derived resolver", () => {
  const issues: IssueGateway = {
    create: () => "",
    listOpen: () => [
      { number: 44, url: "https://github.com/o/r/issues/44", title: "[BLOCKED] W1-T189", body: "**Class:** BLOCKED\n**Task:** W1-T189\n\ndetail" },
    ],
  };
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => [
      { number: 574, url: "https://github.com/o/r/pull/574", state: "MERGED", headRefName: "run-W1-T189-1784000000000", body: "Remudero-Task: W1-T189\n" },
    ],
  });
  const cands = buildEscalationReconcileCandidates("o", "r", reconPlan("W1-T189"), reconLedger(), undefined, { issues, github });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].taskId, "W1-T189");
  assert.equal(cands[0].issueUrl, "https://github.com/o/r/issues/44");
  assert.equal(cands[0].derived.merged, true, "the referenced task's current state is derived MERGED");
  assert.equal(cands[0].derived.prNumber, 574);
});

test("buildEscalationReconcileCandidates (W1-T162): an open needs-human issue whose referenced task's PR is CLOSED WITHOUT MERGING yields a candidate carrying derived.closed=true, derived.merged=false", () => {
  const issues: IssueGateway = {
    create: () => "",
    listOpen: () => [
      { number: 91, url: "https://github.com/o/r/issues/91", title: "[BLOCKED] W1-T190", body: "**Class:** BLOCKED\n**Task:** W1-T190\n\ndetail" },
    ],
  };
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => [
      { number: 580, url: "https://github.com/o/r/pull/580", state: "CLOSED", headRefName: "run-W1-T190-1784000000000", body: "" },
    ],
  });
  const t = {
    id: "W1-T190", title: "W1-T190", repo: "remudero", depends_on: [], type: "implement",
    verify: "auto", risk: "medium", status: "queued", attempts: 0, origin: "architect", acceptance: [], pr: 580,
  } as unknown as Task;
  const plan: Plan = { tasks: [t], byId: new Map([["W1-T190", t]]) };
  const cands = buildEscalationReconcileCandidates("o", "r", plan, reconLedger(), undefined, { issues, github });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].taskId, "W1-T190");
  assert.equal(cands[0].derived.merged, false, "a closed-without-merge referent is not merged");
  assert.equal(cands[0].derived.closed, true, "the referenced PR closed without merging — terminal, not live");
  assert.equal(cands[0].derived.prNumber, 580);
});

test("buildEscalationReconcileCandidates (W1-T162, falsifier): an open needs-human issue whose referenced PR is still OPEN yields derived.merged=false AND derived.closed=false — a live decision stays live", () => {
  const issues: IssueGateway = {
    create: () => "",
    listOpen: () => [
      { number: 92, url: "https://github.com/o/r/issues/92", title: "[BLOCKED] W1-T191", body: "**Class:** BLOCKED\n**Task:** W1-T191\n\ndetail" },
    ],
  };
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => [
      { number: 581, url: "https://github.com/o/r/pull/581", state: "OPEN", headRefName: "run-W1-T191-1784000000000", body: "" },
    ],
  });
  const t = {
    id: "W1-T191", title: "W1-T191", repo: "remudero", depends_on: [], type: "implement",
    verify: "auto", risk: "medium", status: "queued", attempts: 0, origin: "architect", acceptance: [], pr: 581,
  } as unknown as Task;
  const plan: Plan = { tasks: [t], byId: new Map([["W1-T191", t]]) };
  const cands = buildEscalationReconcileCandidates("o", "r", plan, reconLedger(), undefined, { issues, github });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].derived.merged, false);
  assert.equal(cands[0].derived.closed, false, "an OPEN PR must never be derived as closed-without-merge");
});

test("buildEscalationReconcileCandidates: an issue with no `**Task:**` line, or one whose task is not in the plan, yields NO candidate (left to a human)", () => {
  const github = buildBatchedGithub("o", "r", { fetchAll: () => [] });
  const issues: IssueGateway = {
    create: () => "",
    listOpen: () => [
      { number: 1, url: "iss/1", body: "no task line here at all" },
      { number: 2, url: "iss/2", body: "**Task:** W1-T999\n" }, // real task line, but not in THIS plan
    ],
  };
  const cands = buildEscalationReconcileCandidates("o", "r", reconPlan("W1-T189"), reconLedger(), undefined, { issues, github });
  assert.equal(cands.length, 0, "neither a task-less issue nor an out-of-plan task is auto-reconciled");
});

test("buildEscalationReconcileCandidates: a FAILED issue-list read yields [] (do nothing this cycle), never a false 'zero open'", () => {
  const logs: string[] = [];
  const github = buildBatchedGithub("o", "r", { fetchAll: () => [] });
  const issues: IssueGateway = { create: () => "", listOpen: () => { throw new Error("gh: HTTP 502"); } };
  const cands = buildEscalationReconcileCandidates("o", "r", reconPlan("W1-T189"), reconLedger(), (step) => logs.push(step), { issues, github });
  assert.equal(cands.length, 0);
  assert.ok(logs.includes("sweep.escalation_reconcile.list_failed"), "the failed read is logged, not silently treated as zero-open");
});

test("buildEscalationCloser: delegates to the gateway's closeWithComment; throws if the gateway cannot close (so no phantom close is ever ledgered)", () => {
  const calls: Array<{ url: string; comment: string }> = [];
  const closer = buildEscalationCloser("o", "r", { create: () => "", closeWithComment: (url, comment) => calls.push({ url, comment }) });
  closer("iss/44", "cite");
  assert.deepEqual(calls, [{ url: "iss/44", comment: "cite" }]);
  const noClose = buildEscalationCloser("o", "r", { create: () => "" });
  assert.throws(() => noClose("iss/44", "cite"), /cannot close/);
});

test("sweepEscalationReconcile: end-to-end over injected gateways — a resolved referent's issue is closed with a citation; the rung returns its summary", async () => {
  const closed: Array<{ url: string; comment: string }> = [];
  const issues: IssueGateway = {
    create: () => "",
    listOpen: () => [
      { number: 44, url: "https://github.com/o/r/issues/44", body: "**Task:** W1-T189\n" },
      { number: 45, url: "https://github.com/o/r/issues/45", body: "**Task:** W1-T500\n" }, // still live (not merged)
    ],
    closeWithComment: (url, comment) => closed.push({ url, comment }),
  };
  const github = buildBatchedGithub("o", "r", {
    fetchAll: () => [
      { number: 574, url: "https://github.com/o/r/pull/574", state: "MERGED", headRefName: "run-W1-T189-1784000000000", body: "Remudero-Task: W1-T189\n" },
    ],
  });
  const plan: Plan = {
    tasks: [reconPlan("W1-T189").tasks[0], reconPlan("W1-T500").tasks[0]],
    byId: new Map([["W1-T189", reconPlan("W1-T189").tasks[0]], ["W1-T500", reconPlan("W1-T500").tasks[0]]]),
  };
  const summary = await sweepEscalationReconcile("o", "r", plan, reconLedger(), "SWEEP-1", () => {}, { issues, github });
  assert.equal(summary.total, 2, "both open needs-human issues were checked");
  assert.equal(summary.closed, 1, "only the RESOLVED one closed");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].url, "https://github.com/o/r/issues/44");
  assert.match(closed[0].comment, /W1-T189/);
  assert.match(closed[0].comment, /#574/);
});

test("buildSweepHook: the daemon sweep closure runs EVERY rung — incl. the escalation reconciler — end-to-end over offline gh, and never lets a throw escape", async () => {
  // PATH-stub gh to echo [] for every subcommand → every rung (runSweep, escalation reconcile,
  // credit backfill, draft) runs cleanly; the reconciler's own read degrades to [] internally.
  const bin = mkdtempSync(join(tmpdir(), "gh-sweephook-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const root = mkdtempSync(join(tmpdir(), "rmd-sweephook-"));
  try {
    const hook = buildSweepHook(
      "o",
      "r",
      { root, claudeBin: "/bin/true" } as Config,
      join(root, "ledger.ndjson"),
      "SWEEP-1",
      { tasks: [], byId: new Map() },
      () => {},
    );
    await hook(); // must complete without throwing — the reconciler rung rides the seam alongside credit + draft
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepCommand: `rmd sweep --repo <other>` runs the full pipeline incl. the escalation reconciler over offline gh and reports the reconcile count, exit 0", async () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-sweepcmd-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const home = mkdtempSync(join(tmpdir(), "rmd-sweepcmd-home-"));
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root: join(home, "Remudero") }));
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.HOME = home;
  try {
    // --repo <other> so the plan path points into a non-existent clone (best-effort empty plan),
    // never a git op; gh is stubbed to [] so every rung runs cleanly through the reconciler.
    const code = await sweepCommand(["--repo", "remudero-sandbox"]);
    assert.equal(code, 0, "the sweep completes and the reconciler rung runs without stranding it");
  } finally {
    process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── W1-T176: buildOpenPrViews' REAL wiring (not lib/sweep.ts's already-pure-tested ────────
//    predicate) — reviewPostRefusedFor + the two new OpenPrView fields it feeds.
//    Exercised over a REST-shaped PATH-stub `gh`, never touching effects/config/repoRoot.

/** A PATH-stub `gh` answering the exact REST calls `buildOpenPrViews` issues for ONE open
 *  PR (`api repos/.../pulls?state=open...`, its check-runs + combined-status, and the
 *  branch-protection required-contexts read) — no `gh pr view`/`gh issue`/`gh api` beyond
 *  those four, so this never risks a buildSweepEffects side effect (no arm/escalate ridden). */
function ghStubForOpenPrViews(opts: { sha: string; taskId: string; protectionFails?: boolean }): string {
  const protectionBody = opts.protectionFails
    ? `if (a.includes("required_status_checks")) { process.stderr.write("boom"); process.exit(1); }`
    : `if (a.includes("required_status_checks")) { process.stdout.write(JSON.stringify({ contexts: ["ci-gate", "remudero-review"] })); process.exit(0); }`;
  return `#!/usr/bin/env node
const a = process.argv.slice(2).join(" ");
${protectionBody}
if (a.includes("pulls?state=open")) {
  process.stdout.write(JSON.stringify([{
    number: 900,
    html_url: "https://github.com/o/r/pull/900",
    state: "open",
    body: "Remudero-Task: ${opts.taskId}\\n",
    updated_at: "2026-07-30T00:00:00Z",
    head: { ref: "run-${opts.taskId}-1", sha: "${opts.sha}" },
    auto_merge: null,
  }]));
  process.exit(0);
}
if (a.includes("check-runs")) {
  process.stdout.write(JSON.stringify({ check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] }));
  process.exit(0);
}
if (a.includes("/status")) {
  process.stdout.write(JSON.stringify({ statuses: [] }));
  process.exit(0);
}
process.stdout.write("{}");
`;
}

function withGhStub<T>(script: string, fn: () => T): T {
  const bin = mkdtempSync(join(tmpdir(), "gh-openprviews-"));
  writeFileSync(join(bin, "gh"), script, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("buildOpenPrViews: a zero-runs required check (ci-gate green, remudero-review absent) with a PRIOR review.post_refused ledger line for this exact taskId@headSha sets reviewPostRefused true — the second-absence discriminator's real gateway input (W1-T176)", () => {
  const sha = "deadbeef0000000000000000000000000000000";
  const taskId = "W1-T900";
  const root = mkdtempSync(join(tmpdir(), "rmd-openprviews-"));
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(
    ledgerPath,
    JSON.stringify({ ts: "2026-07-30T00:00:00Z", run_id: "SWEEP-0", task_id: taskId, step: "review.post_refused", head_sha: sha }) + "\n",
  );
  try {
    const views = withGhStub(ghStubForOpenPrViews({ sha, taskId }), () => buildOpenPrViews("o", "r", ledgerPath));
    assert.equal(views.length, 1);
    assert.equal(views[0].taskId, taskId);
    assert.equal(views[0].checksState, "green", "ci-gate success, remudero-review absent — every REQUIRED context present reports SUCCESS");
    assert.equal(views[0].reviewState, "none", "no remudero-review entry in either check-runs or the combined status");
    assert.equal(views[0].reviewPostRefused, true, "the ledger already carries a refusal for this exact taskId@headSha");
    assert.equal(views[0].requiredContextsUnreadable, false, "the branch-protection read succeeded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildOpenPrViews: the SAME zero-runs shape with NO ledger line for this head reports reviewPostRefused false — a fresh sighting, not a re-refusal (W1-T176)", () => {
  const sha = "cafefeed0000000000000000000000000000000";
  const taskId = "W1-T901";
  const root = mkdtempSync(join(tmpdir(), "rmd-openprviews-"));
  const ledgerPath = join(root, "ledger.ndjson"); // never written — no matching (or any) line exists
  try {
    const views = withGhStub(ghStubForOpenPrViews({ sha, taskId }), () => buildOpenPrViews("o", "r", ledgerPath));
    assert.equal(views.length, 1);
    assert.equal(views[0].reviewPostRefused, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildOpenPrViews: an UNREADABLE branch-protection read (gh api fails) sets requiredContextsUnreadable true — never assumed permissive (W1-T176 design boundary ii)", () => {
  const sha = "1234567800000000000000000000000000000000";
  const taskId = "W1-T902";
  const root = mkdtempSync(join(tmpdir(), "rmd-openprviews-"));
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const views = withGhStub(ghStubForOpenPrViews({ sha, taskId, protectionFails: true }), () => buildOpenPrViews("o", "r", ledgerPath));
    assert.equal(views.length, 1);
    assert.equal(views[0].requiredContextsUnreadable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W1-T2370 — an unverifiable verification is RE-READ, never re-worked ────────────────────────────
//
// `AlreadySatisfiedResolution` is a genuine three-state union whose `unverifiable` arm fires in
// production (one `already_satisfied.unverified` row: a `spawnSync gh` ETIMEDOUT, reason `transport`,
// on a claim whose PR really was merged). Both that arm and a genuine `refuted` fall to the same
// `no_pr` verdict, which is in `NON_HALTING_VERDICTS`, so the drain hands the task straight back and a
// full build is spent re-deriving an answer the GATEWAY could not give. These pin the fix: re-ask the
// GATEWAY, bounded, and change nothing about what may be CREDITED.

const W2370_TASK = "T-2370";
const w2370Claim = (ref: string): AlreadySatisfiedClaim => ({ raw: "", ref });

/** Records every call, so "how many reads were spent" is observed rather than inferred. */
function w2370Resolver(sequence: AlreadySatisfiedResolution[]): {
  resolve: (c: AlreadySatisfiedClaim, g: GitHub, t: string) => AlreadySatisfiedResolution;
  calls: Array<{ task: string }>;
} {
  const calls: Array<{ task: string }> = [];
  return {
    calls,
    resolve: (_c, _g, t) => {
      calls.push({ task: t });
      // Past the end of the script, keep answering with the last entry — a gateway that stays down.
      return sequence[Math.min(calls.length - 1, sequence.length - 1)]!;
    },
  };
}

const W2370_GATEWAY = {} as GitHub; // never consulted: the resolver seam stands in for it entirely.
const W2370_UNVERIFIABLE: AlreadySatisfiedResolution = { outcome: "unverifiable", reason: "transport" };
const W2370_NOT_FOUND: AlreadySatisfiedResolution = { outcome: "refuted", reason: "not_found" };
const W2370_VERIFIED: AlreadySatisfiedResolution = {
  outcome: "verified",
  number: 42,
  url: "https://github.com/acme/remudero/pull/42",
};

test("W1-T2370: an unverifiable resolution retries the verification before any verdict is reached", () => {
  // First read cannot answer, second can — the 8-of-25 length-1 run the bound exists for.
  const r = w2370Resolver([W2370_UNVERIFIABLE, W2370_VERIFIED]);
  const out = resolveAlreadySatisfiedWithRetry(w2370Claim("#42"), W2370_GATEWAY, W2370_TASK, r.resolve);
  assert.equal(r.calls.length, 2, "the verification was re-asked, not accepted on the first failure");
  assert.equal(out.resolution.outcome, "verified");
  assert.equal(out.attempts, 2);
});

test("W1-T2370: a refuted resolution is never retried, because the gateway already answered", () => {
  const r = w2370Resolver([W2370_NOT_FOUND, W2370_VERIFIED]);
  const out = resolveAlreadySatisfiedWithRetry(w2370Claim("#42"), W2370_GATEWAY, W2370_TASK, r.resolve);
  assert.equal(r.calls.length, 1, "a refusal is evidence; re-asking it would be asking a settled question");
  assert.equal(out.resolution.outcome, "refuted");
  assert.equal(out.attempts, 1);
  // And the same holds for a first-attempt VERIFIED: nothing is re-read once an answer exists.
  const r2 = w2370Resolver([W2370_VERIFIED, W2370_VERIFIED]);
  resolveAlreadySatisfiedWithRetry(w2370Claim("#42"), W2370_GATEWAY, W2370_TASK, r2.resolve);
  assert.equal(r2.calls.length, 1);
});

test("W1-T2370: the retry re-reads the gateway and never re-runs the worker", () => {
  const r = w2370Resolver([W2370_UNVERIFIABLE]);
  const out = resolveAlreadySatisfiedWithRetry(w2370Claim("#42"), W2370_GATEWAY, W2370_TASK, r.resolve);
  // Every attempt is a resolver call carrying the SAME task id — a gateway read. There is no spawn,
  // no worktree, no worker: the only thing this function can do is ask the question again.
  assert.equal(r.calls.length, ALREADY_SATISFIED_VERIFY_ATTEMPTS);
  assert.deepEqual(new Set(r.calls.map((c) => c.task)), new Set([W2370_TASK]));
  assert.equal(out.attempts, ALREADY_SATISFIED_VERIFY_ATTEMPTS);
});

test("W1-T2370: after the third failed attempt the outcome is exactly the present one, still unverifiable", () => {
  const r = w2370Resolver([W2370_UNVERIFIABLE]);
  const out = resolveAlreadySatisfiedWithRetry(w2370Claim("#42"), W2370_GATEWAY, W2370_TASK, r.resolve);
  assert.equal(r.calls.length, 3, "bounded — a gateway that stays down is asked three times, never more");
  assert.equal(out.resolution.outcome, "unverifiable", "the row still says unverifiable, never refused");
  assert.equal(
    (out.resolution as { reason: string }).reason,
    "transport",
    "the classified reason survives the bound rather than being overwritten by exhaustion",
  );
});

test("W1-T2370: an unverified claim is still never credited, so the guard is not weakened", () => {
  const r = w2370Resolver([W2370_UNVERIFIABLE]);
  const out = resolveAlreadySatisfiedWithRetry(w2370Claim("#42"), W2370_GATEWAY, W2370_TASK, r.resolve);
  assert.notEqual(out.resolution.outcome, "verified", "exhausting the bound must never manufacture a credit");
  // The call site credits ONLY on `verified` — this is the predicate it applies, asserted directly so
  // a future change to the union cannot quietly widen what counts as credited.
  const resolved = out.resolution.outcome === "verified" ? out.resolution : undefined;
  assert.equal(resolved, undefined);
});

test("W1-T2370: nothing added paces or throttles or sleeps between attempts", () => {
  // W1-T1066 records a polling loop that locked the operator out of his repository for ninety minutes.
  // The function is SYNCHRONOUS — there is no await to hide a delay in — and three consecutive reads
  // against an instant resolver must therefore cost effectively nothing.
  const r = w2370Resolver([W2370_UNVERIFIABLE]);
  const started = process.hrtime.bigint();
  const out = resolveAlreadySatisfiedWithRetry(w2370Claim("#42"), W2370_GATEWAY, W2370_TASK, r.resolve);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(out.attempts, 3);
  assert.ok(elapsedMs < 50, `three attempts must not pace; took ${elapsedMs.toFixed(3)}ms`);
  // A returned value, not a thenable: an async signature is where a sleep would live.
  assert.notEqual(typeof (out as unknown as { then?: unknown }).then, "function");
});

test("W1-T2370: the bound is derived, and a smaller one still asks the question at least once", () => {
  const r = w2370Resolver([W2370_UNVERIFIABLE]);
  // 0 and negative are not "ask nothing" — the first read always happens; the bound limits RE-reads.
  const out = resolveAlreadySatisfiedWithRetry(w2370Claim("#42"), W2370_GATEWAY, W2370_TASK, r.resolve, 0);
  assert.equal(r.calls.length, 1);
  assert.equal(out.attempts, 1);
  assert.equal(ALREADY_SATISFIED_VERIFY_ATTEMPTS, 3, "N=3 clears 18 of 25 observed failure runs");
});
