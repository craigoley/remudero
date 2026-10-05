/**
 * test/helpers/retro-fake-fixture.ts — W1-T5902. The git + `gh` fixture the real-run retro marker
 * suite (test/retro-marker-atomic-real-run.test.ts) drives `retroCommand` over. It lives under
 * test/helpers/ (never scanned as a suite) so the suite's own text does not name the plan paths the
 * fixture seeds: that is what lets test/retro-marker-atomic.test.ts keep ONLY the cheap marker
 * assertions while the multi-spawn retro runs move out of the plan-reading set.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { type RetroMarker } from "../../src/lib/retro.js";
import { configPath } from "../../src/lib/config.js";
import { resolveRepoRoot } from "../../src/run-task.js";
import type { SpawnWorkerArgs, WorkerResult } from "../../src/lib/worker.js";
import type { RunRetroPrepublishPreflightOptions, RetroPrepublishResult } from "../../src/lib/retro-preflight.js";

// Resolved the SAME way production's run-task.ts does (see the note atop the suites that import this).
export const REPO_ROOT_FOR_FIXTURES = resolveRepoRoot(process.argv.slice(2), process.cwd());

export interface FakeRetroFixture {
  root: string;
  branch: string;
  fakeSpawn: (args?: SpawnWorkerArgs) => Promise<WorkerResult>;
  spawnArgs: SpawnWorkerArgs[];
  prepublishPreflight: (opts: RunRetroPrepublishPreflightOptions) => Promise<RetroPrepublishResult>;
  /** Swaps HOME/PATH/Date.now in, runs `body`, and ALWAYS restores them after -- even on throw. */
  run<T>(body: () => Promise<T>): Promise<T>;
}

export function setupFakeRetroFixture(
  t: TestContext,
  opts: {
    /** Seed a valid marker BEFORE the run (exercises the "ok" marker-resolution branch). */
    seedMarker?: RetroMarker;
    /** `gh pr view --json headRefName` response -- default is this run's OWN branch. */
    headRefName?: (branch: string) => string;
    /** `gh pr diff` response -- default is an empty (plan-only) diff. */
    diff?: string;
    /** `gh pr diff` EXITS NON-ZERO instead of returning a diff -- a transient `gh` failure
     *  partway through the success path, exercising retroCommand's outer catch. */
    diffFails?: boolean;
    /** `gh pr view --json body` response -- default already carries the trailer AND a
     *  valid Acceptance block so neither repair path fires. */
    body?: string;
    /** The Architect's fabricated REPORT carries NO `PR_URL:` line -- forces the REST
     *  create fallback path (`gh api --method POST repos/.../pulls`, W1-T1202; our fake
     *  `gh` answers it with a fresh `html_url`). */
    noPrUrl?: boolean;
    /** The worker omitted PR_URL even though this exact run branch already has an open PR.
     *  The harness must recover and reuse it, never create a replacement. */
    existingPrWithoutReport?: boolean;
    /** `gh pr view --json headRefName` returns no `headRefName` at all (an UNRESOLVED
     *  head ref, distinct from a resolved-but-wrong one) -- checkPrOwnership's `?? null`
     *  fallback. */
    unresolvedHeadRef?: boolean;
    /** Omit MASTER-PLAN.md from the fixture repo -- regenerateOrientation throws (ENOENT),
     *  exercising its best-effort catch. */
    missingMasterPlan?: boolean;
    /** Seed a malformed plan/tasks.yaml -- loadPlan throws inside the best-effort
     *  "next runnable task" lookup, exercising ITS catch. */
    badPlan?: boolean;
    /** `gh pr view --json body` returns NO `body` field at all (as opposed to an empty
     *  string) -- the `view.body ?? ""` fallback, both in ensureTaskTrailer and the
     *  acceptance-repair pass. */
    omitBody?: boolean;
    /** repoDir is NOT pre-cloned -- retroCommand's own `gh repo clone` fires (our fake
     *  `gh` performs a REAL local clone of the same origin, never a stub). */
    missingRepoDir?: boolean;
    /** `gh pr edit` (the acceptance-repair pass's own repair write-back) fails -- its
     *  OWN best-effort catch, distinct from the outer catch `diffFails` exercises. */
    repairEditFails?: boolean;
    /** Pre-register a REAL, lockless `run-*` git worktree well past pruneStaleRuns'
     *  grace window -- exercises its force-remove branch (`pruned.worktrees.length`). */
    staleWorktree?: boolean;
    /** Terminal prepublish result used to prove marker/review/arm atomicity. Default passes. */
    preflightResult?: RetroPrepublishResult;
    /** Drive the production repair callback once before returning a passing second attempt. */
    preflightExercisesRepair?: boolean;
    /** Override only the resumed repair worker result; the initial Architect result stays valid. */
    repairWorkerResult?: Partial<WorkerResult>;
    /** Simulate a future provider result reaching retro's historical provenance boundary. Carries
     *  BOTH open-weight spellings: W1-T3607 made `cash` canonical and kept `openweight` as a
     *  deprecated alias, and `WorkerProviderId` still admits each, so each must be refused here. */
    workerProvider?: "claude" | "codex" | "cash" | "openweight";
    /** CI reads GREEN on the first poll instead of red, so the run goes on past the marker advance
     *  into review, the arm and the gated report line (W1-T968). */
    ciGreen?: boolean;
    /** Seed the ledger with the `automerge.armed` row a REVIEW-lane arm writes for this fixture's
     *  PR on the head its `/pulls/*` answer reports (W1-T968). The fake `gh` fails every
     *  `pr merge`, so the review's own withdrawal is ledgered `disarm_skipped` and the arm stands. */
    priorArm?: boolean;
  } = {},
): FakeRetroFixture {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-success-home-"));
  // realpathSync: macOS's tmpdir() is a symlink (/var -> /private/var); `git worktree
  // list --porcelain` reports the RESOLVED path, so a prefix check against the
  // unresolved one (pruneStaleRuns' `curPath.startsWith(worktreesRoot)`) would never
  // match and silently skip every worktree under it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-retro-success-root-")));
  // `staleWorktree` mocks Date.now WELL INTO THE FUTURE relative to the real wall clock
  // (rather than a fixed 2026-07-14-ish constant) so pruneStaleRuns' `now() - mtimeMs`
  // age check -- which reads the SAME mocked Date.now -- sees the worktree this fixture
  // creates at REAL "now" (below) as comfortably past DEFAULT_PRUNE_GRACE_MS (120s).
  const FIXED_TS = opts.staleWorktree
    ? Date.now() + 10 * 60_000
    : 1784000000000 + Math.floor(Math.random() * 1_000_000); // distinct per fixture instance
  const branch = `run-RETRO-${FIXED_TS}`;

  if (opts.seedMarker) {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "last-retro.json"), JSON.stringify(opts.seedMarker, null, 2) + "\n");
  }
  if (opts.priorArm) {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "state", "ledger.ndjson"),
      JSON.stringify({
        ts: "2026-08-16T00:00:00.000Z",
        step: "automerge.armed",
        pr_url: "https://github.com/craigoley/remudero/pull/999999",
        head_sha: "deadbeef",
        lane: "review",
        outcome: "armed",
      }) + "\n",
    );
  }

  // ── a real local "origin" (bare) + a pre-cloned repoDir (skips `gh repo clone`) ──
  const originGit = mkdtempSync(join(tmpdir(), "rmd-retro-success-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "rmd-retro-success-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "retro-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "retro-test"]);
  if (!opts.missingMasterPlan) writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n\n## 1. Intro\n\nfixture.\n");
  mkdirSync(join(seed, "plan"), { recursive: true });
  // zero tasks -> the best-effort "next runnable task" lookup makes NO gh calls; a
  // deliberately-malformed plan instead makes loadPlan throw, exercising its own catch.
  writeFileSync(join(seed, "plan", "tasks.yaml"), opts.badPlan ? "not_a_task_list: true\n" : "[]\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "chore: fixture seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  if (!opts.missingRepoDir) {
    execFileSync("git", ["clone", "-q", originGit, repoDir]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "retro-test@example.invalid"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "retro-test"]);
  }
  if (opts.staleWorktree) {
    // A REAL, registered `git worktree` (pruneStaleRuns reads `git worktree list
    // --porcelain`, not just directory names) on a `run-*` branch, with no run.lock --
    // exactly the "crashed before cleanup" shape pruneStaleRuns exists to reap.
    mkdirSync(join(root, "worktrees"), { recursive: true });
    execFileSync("git", [
      "-C", repoDir, "worktree", "add", "-b", "run-STALE-leftover",
      join(root, "worktrees", "run-STALE-leftover"), "main",
    ]);
  }

  // ── a fake `gh` on PATH: only the handful of subcommands this success path invokes ──
  const fakeGhBody = opts.body ?? "Remudero-Task: RETRO\n\n## Acceptance\n- fixture claim | fixture proof\n";
  const headRefNameOut = opts.unresolvedHeadRef ? undefined : (opts.headRefName ?? ((b: string) => b))(branch);
  const fakeBinDir = mkdtempSync(join(tmpdir(), "rmd-retro-success-bin-"));
  // The diff body rides in its OWN file (never inlined into the script's shell text) --
  // real newlines matter here (codeFilesInDiff needs a literal `+++ b/...` LINE), and a
  // shell-quoted/`printf`-escaped inline string would mangle them.
  const diffPath = join(fakeBinDir, "diff-body.txt");
  writeFileSync(diffPath, opts.diff ?? "");
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      // Matched on POSITIONAL args ($1 subcommand, $2 verb, $5 the --json field name),
      // NEVER a substring of the whole "$*" -- a `--body <repaired text>` value can
      // itself legitimately contain words like "diff" (ensureJudgeableBody's own proof
      // text does), which a whole-string substring match would misfire on.
      // repo clone <slug> <dest>  (repoDir absent) -- a REAL local clone, never a stub.
      `if [[ "$1" == 'repo' && "$2" == 'clone' ]]; then git clone -q ${JSON.stringify(originGit)} "$4"; git -C "$4" config user.email retro-test@example.invalid; git -C "$4" config user.name retro-test; exit 0; fi`,
      // pr view <url> --json <field>
      `if [[ "$1" == 'pr' && "$2" == 'view' ]]; then`,
      // --json body  (ensureTaskTrailer + the acceptance-repair check) -- or a response
      // with NO `body` field at all (`view.body ?? ""`'s fallback side).
      opts.omitBody
        ? `  if [[ "$5" == 'body' ]]; then echo '{}'; exit 0; fi`
        : `  if [[ "$5" == 'body' ]]; then echo '{"body":${JSON.stringify(fakeGhBody)}}'; exit 0; fi`,
      // --json headRefName  (checkPrOwnership) -- or NO headRefName field at all, an
      // UNRESOLVED head ref (distinct from a resolved-but-wrong one).
      headRefNameOut === undefined
        ? `  if [[ "$5" == 'headRefName' ]]; then echo '{}'; exit 0; fi`
        : `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${headRefNameOut}"}'; exit 0; fi`,
      `fi`,
      // W1-T2268: `waitForCiGreen` now reads REST (`gh api …`), never `gh pr view --json
      // statusCheckRollup`. RED on the first poll (via the composed check-run), so
      // retroCommand exits right after the marker-advance line with no further gh calls.
      `if [[ "$1" == 'api' ]]; then`,
      `  case "$2" in`,
      `    */pulls?state=open*) echo '[]'; exit 0 ;;`,
      opts.existingPrWithoutReport
        ? `    */pulls?head=*) echo '[{"html_url":"https://github.com/craigoley/remudero/pull/434343","number":434343}]'; exit 0 ;;`
        : `    */pulls?head=*) echo '[]'; exit 0 ;;`,
      // A green run goes on into review, which reads the PR's own url off this row the way every real
      // REST pulls response carries it; the red-CI variants never get that far and keep the old shape.
      opts.ciGreen
        ? `    */pulls/*) echo '{"number":999999,"html_url":"https://github.com/craigoley/remudero/pull/999999","state":"open","merged":false,"merged_at":null,"head":{"sha":"deadbeef"}}'; exit 0 ;;`
        : `    */pulls/*) echo '{"number":999999,"state":"open","merged":false,"merged_at":null,"head":{"sha":"deadbeef"}}'; exit 0 ;;`,
      `    */check-runs*) echo '{"check_runs":[{"name":"ci","status":"completed","conclusion":"${opts.ciGreen ? "success" : "failure"}"}]}'; exit 0 ;;`,
      `    */status) echo '{"statuses":[]}'; exit 0 ;;`,
      `  esac`,
      `fi`,
      // the REST create (the no-PR_URL-in-report fallback, W1-T1202)
      `if [[ "$1" == 'api' && "$2" == '--method' && "$3" == 'POST' ]]; then echo '{"html_url":"https://github.com/craigoley/remudero/pull/424242","number":424242}'; exit 0; fi`,
      // pr diff <url>  (the plan-only guard, codeFilesInDiff) -- or a transient `gh`
      // FAILURE, to exercise retroCommand's outer catch (W1-T242 round 2 sweep).
      opts.diffFails
        ? `if [[ "$1" == 'pr' && "$2" == 'diff' ]]; then echo 'fixture: gh pr diff transient failure' >&2; exit 1; fi`
        : `if [[ "$1" == 'pr' && "$2" == 'diff' ]]; then cat ${JSON.stringify(diffPath)}; exit 0; fi`,
      // pr edit <url> --body <text>  (ensureTaskTrailer / the acceptance-repair path) --
      // or a transient failure, to exercise the acceptance-repair pass's OWN best-effort
      // catch (distinct from the outer catch `diffFails` exercises).
      opts.repairEditFails
        ? `if [[ "$1" == 'pr' && "$2" == 'edit' ]]; then echo 'fixture: gh pr edit transient failure' >&2; exit 1; fi`
        : `if [[ "$1" == 'pr' && "$2" == 'edit' ]]; then exit 0; fi`,
      // Anything else (api rate_limit / pr list ...) this path might probe: fail
      // closed -- every one of those callers already tolerates a `gh` failure.
      'exit 1',
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);

  const spawnArgs: SpawnWorkerArgs[] = [];
  const fakeSpawn = async (args?: SpawnWorkerArgs): Promise<WorkerResult> => {
    if (args) spawnArgs.push(args);
    const result: WorkerResult = {
    provider: opts.workerProvider ?? "claude",
    sessionId: "s-retro-fixture",
    costUsd: 0.01,
    numTurns: 1,
    text: opts.noPrUrl ? "REPORT\n(no PR_URL -- the harness must open the PR itself)\n" : `REPORT\nPR_URL: https://github.com/craigoley/remudero/pull/999999\n`,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "opus",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    };
    return args?.resumeSessionId ? { ...result, ...opts.repairWorkerResult } : result;
  };

  const prepublishPreflight = async (preflight: RunRetroPrepublishPreflightOptions): Promise<RetroPrepublishResult> => {
    if (opts.preflightExercisesRepair) {
      preflight.log("retro.preflight_failed", {
        attempt: 1, outcome: "failed", suite_count: 2, elapsed_ms: 1,
        remote_pr_existed: preflight.remotePrExisted,
        provider: preflight.provenance.provider, model: preflight.provenance.model,
        effort: preflight.provenance.effort, session_id: preflight.provenance.sessionId,
      });
      try {
        await preflight.repair("bounded fenced fixture evidence");
      } catch (error) {
        preflight.log("retro.preflight_failed", {
          attempt: 2, outcome: "failed", suite_count: 2, elapsed_ms: 1,
          exit_class: "repair_spawn_failed", stderr_excerpt: String((error as Error)?.message ?? error),
          remote_pr_existed: preflight.remotePrExisted,
          provider: preflight.provenance.provider, model: preflight.provenance.model,
          effort: preflight.provenance.effort, session_id: preflight.provenance.sessionId,
        });
        return { ok: false, attempts: 2, suiteCount: 2, repaired: false };
      }
      await preflight.regenerateHarnessArtifacts();
      preflight.log("retro.preflight_passed", {
        attempt: 2, outcome: "passed", suite_count: 2, elapsed_ms: 1,
        remote_pr_existed: preflight.remotePrExisted,
        provider: preflight.provenance.provider, model: preflight.provenance.model,
        effort: preflight.provenance.effort, session_id: preflight.provenance.sessionId,
      });
      return { ok: true, attempts: 2, suiteCount: 2, repaired: true };
    }
    const result = opts.preflightResult ?? { ok: true, attempts: 1, suiteCount: 2, repaired: false };
    for (let attempt = 1; attempt <= result.attempts; attempt += 1) {
      preflight.log(result.ok && attempt === result.attempts ? "retro.preflight_passed" : "retro.preflight_failed", {
        attempt,
        outcome: result.ok && attempt === result.attempts ? "passed" : "failed",
        suite_count: result.suiteCount,
        elapsed_ms: 1,
        remote_pr_existed: preflight.remotePrExisted,
        provider: preflight.provenance.provider,
        model: preflight.provenance.model,
        effort: preflight.provenance.effort,
        session_id: preflight.provenance.sessionId,
      });
    }
    return result;
  };

  async function run<T>(body: () => Promise<T>): Promise<T> {
    const savedHome = process.env.HOME;
    const savedPath = process.env.PATH;
    const errorSpy = t.mock.method(console, "error", () => {});
    const logSpy = t.mock.method(console, "log", () => {});
    const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);
    process.env.HOME = fakeHome;
    process.env.PATH = `${fakeBinDir}:${savedPath}`;
    const cfgPath = configPath();
    mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");
    try {
      return await body();
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      process.env.PATH = savedPath;
      dateNowSpy.mock.restore?.();
      void errorSpy;
      void logSpy;
    }
  }

  return { root, branch, fakeSpawn, spawnArgs, prepublishPreflight, run };
}
