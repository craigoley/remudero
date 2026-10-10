import assert from "node:assert/strict";
// W1-T5902 — the REAL-RUN half of test/retro-marker-atomic.test.ts. Every test here drives the real
// `retroCommand` through `setupFakeRetroFixture` (a real bare git origin + clones + a PATH-shimmed
// `gh`, with only the Architect spawn injected) and is the slow half of the old suite. It is split
// out so the half that reads the repo's own plan stays in seconds; this file never loads the plan
// (the daemon test below hands `runDaemon` a literal empty plan), so it is not a plan-reading
// candidate and a plan-only diff no longer waits on it. No assertion was dropped or weakened.
import fsDefault from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { evaluateRetroTrigger, resolveMarkerForGather, type RetroMarker, type RetroTriggerDecision } from "../src/lib/retro.js";
import { configPath } from "../src/lib/config.js";
import { resolveRepoRoot, retroCommand } from "../src/run-task.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { runDaemon } from "../src/lib/daemon.js";
// W1-T2981 — the retro is DETACHED, so `runDaemon` returns while it is still in flight. A test
// asserting on what the retro DID must drain that action first; the assertions are unchanged.
import { drainDetachedSweepActions } from "../src/lib/sweep.js";
import type { Plan } from "../src/lib/plan.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { offlineGithub } from "./setup/offline-github.js";
import { withHealthyRetroProbeGh } from "./helpers/w4226-g1-retro-probe-gh.js";
import type { RunRetroPrepublishPreflightOptions, RetroPrepublishResult } from "../src/lib/retro-preflight.js";

/** ONE offline gateway for every `retroCommand` call in this file; see test/retro-marker-atomic.test.ts. */
const offlineGh = offlineGithub();

// Resolved the SAME way production does (see the identical note in test/retro-marker-atomic.test.ts).
const REPO_ROOT_FOR_FIXTURES = resolveRepoRoot(process.argv.slice(2), process.cwd());

// ── W1-T242 round 2: retroCommand's SUCCESS path reaches the atomic marker-advance ──
//
// The corrupt-marker test above proves the fail-closed branch. The tests below prove the
// OTHER half stays correct: a clean retro run still reaches `saveMarker` at the tail of the
// real success path -- the exact call site round 1 made atomic -- and actually lands a real,
// valid marker on disk. Every git/gh boundary is a REAL local git repo or a PATH-shimmed `gh`
// script (never a reimplementation of retroCommand's own logic); only the Architect spawn
// itself is injected (retroCommand's `opts.spawn`, mirroring runTask's existing
// `opts.spawn` DI). `setupFakeRetroFixture` is the shared scaffolding three variant tests
// below drive through DIFFERENT branches of the same success path (a valid PRE-EXISTING
// marker; an ownership mismatch; a diff that touches code) without re-authoring the whole
// fixture per branch.
interface FakeRetroFixture {
  root: string;
  branch: string;
  fakeSpawn: (args?: SpawnWorkerArgs) => Promise<WorkerResult>;
  spawnArgs: SpawnWorkerArgs[];
  prepublishPreflight: (opts: RunRetroPrepublishPreflightOptions) => Promise<RetroPrepublishResult>;
  publicationGateCalls: () => string[];
  /** Swaps HOME/PATH/Date.now in, runs `body`, and ALWAYS restores them after -- even on throw. */
  run<T>(body: () => Promise<T>): Promise<T>;
}

function setupFakeRetroFixture(
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

  // This fixture owns the marker/publication protocol, not the harness's gate checks.
  // The hardened push leaf now runs its harness-owned hook explicitly. Give that
  // existing fixture seam an observable hook; retain the real local Git push and
  // all production guardrails. Gate execution/security is covered by host-push tests.
  const harnessHooks = join(fakeBinDir, "harness-hooks");
  mkdirSync(harnessHooks);
  const gateCallsPath = join(fakeBinDir, "publication-gate-calls");
  writeFileSync(join(harnessHooks, "pre-push"),
    `#!/bin/sh\nwhile IFS= read -r push_ref; do :; done\nprintf '%s\\n' 'fixture-owned-harness-gate' >> ${JSON.stringify(gateCallsPath)}\n`, { mode: 0o755 });
  const publicationGateCalls = () => existsSync(gateCallsPath)
    ? readFileSync(gateCallsPath, "utf8").trim().split("\n") : [];

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
    const savedHarnessHooks = process.env.RMD_HARNESS_HOOKS_DIR;
    const errorSpy = t.mock.method(console, "error", () => {});
    const logSpy = t.mock.method(console, "log", () => {});
    const dateNowSpy = t.mock.method(Date, "now", () => FIXED_TS);
    process.env.HOME = fakeHome;
    process.env.PATH = `${fakeBinDir}:${savedPath}`;
    process.env.RMD_HARNESS_HOOKS_DIR = harnessHooks;
    const cfgPath = configPath();
    mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");
    try {
      return await body();
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      process.env.PATH = savedPath;
      if (savedHarnessHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
      else process.env.RMD_HARNESS_HOOKS_DIR = savedHarnessHooks;
      dateNowSpy.mock.restore?.();
      void errorSpy;
      void logSpy;
    }
  }

  return { root, branch, fakeSpawn, spawnArgs, prepublishPreflight, publicationGateCalls, run };
}

// W1-T968 — retro's gated report answers about the PULL REQUEST, not the call. Every other variant
// here stops at a red CI poll, so retro's gated tail was reached by no test at all. This one lets
// CI read green and seeds a standing REVIEW-lane arm on the fixture's head; the review this run
// makes refuses and its withdrawal fails (the fake `gh` refuses every `pr merge`), and this lane's
// own arm is refused. The old phrase, a function of that last outcome alone, printed "NOT armed".
test("W1-T968: a retro PR reports a standing prior arm as armed although its own arm was refused", async (t) => {
  const fx = setupFakeRetroFixture(t, { ciGreen: true, priorArm: true });
  await fx.run(async () => {
    await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    const said = (console.log as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock.calls.map((c) =>
      c.arguments.map(String).join(" "),
    );
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const steps = JSON.stringify(ledgerLines.map((l) => l.step));

    assert.ok(!ledgerLines.some((l) => l.step === "retro.error"), `the run must reach its gate; steps=${steps}`);
    assert.ok(ledgerLines.some((l) => l.step === "automerge.disarm_skipped"), `the withdrawal failed, so the arm stands; steps=${steps}`);
    const ownArm = ledgerLines.filter((l) => l.lane === "operator" && String(l.step).startsWith("automerge."));
    assert.ok(ownArm.length > 0 && ownArm.every((l) => l.step !== "automerge.armed"), `this lane's own arm armed nothing; steps=${steps}`);

    const gated = said.filter((line) => line.includes("retro PR gated — "));
    assert.equal(gated.length, 1, `exactly one gated report line; console=${JSON.stringify(said)}`);
    assert.match(gated[0], /retro PR gated — armed \(/, "the pull request is armed, whatever this lane's own call returned");
  });
});

test("retroCommand: a clean run advances its marker without an index artifact", async (t) => {
  const fx = setupFakeRetroFixture(t);
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    // ci went "red" on the first poll (fake gh above) -> retroCommand returns 1 right
    // after the marker-advance line, without ever reaching reviewCommand/armAutoMerge.
    assert.equal(exitCode, 1, "a red ci gate leaves the PR open (exit 1) -- but ONLY after the marker already advanced");

    const markerRaw = readFileSync(join(fx.root, "state", "last-retro.json"), "utf8");
    const marker = JSON.parse(markerRaw) as RetroMarker;
    assert.ok(marker.ts, "the REAL saveMarker call (run-task.ts's success-path call site) must have landed a valid marker");
    assert.equal(marker.runs_seen, 0, "an empty ledger's gather sees zero runs -- this run itself is not ledger-recorded");

    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(
      ledgerLines.some((l) => l.step === "retro.marker.advanced"),
      "retro.marker.advanced must be ledgered once the marker is actually saved",
    );
    assert.ok(!ledgerLines.some((l) => String(l.step).startsWith("plan_index.")), "retro no longer regenerates or commits an index artifact");
    assert.equal(fsDefault.existsSync(join(fx.root, "repos", "remudero", "plan", "plan-index.json")), false);
    const preflightIndex = ledgerLines.findIndex((l) => l.step === "retro.preflight_passed");
    const openedIndex = ledgerLines.findIndex((l) => l.step === "pr.opened");
    const markerIndex = ledgerLines.findIndex((l) => l.step === "retro.marker.advanced");
    assert.ok(preflightIndex >= 0, "the production retro path must call the prepublish preflight");
    assert.ok(preflightIndex < openedIndex, "preflight must pass before pr.opened is emitted");
    assert.ok(preflightIndex < markerIndex, "preflight must pass before the retro marker advances");
  });
});

// Driven for BOTH open-weight spellings, and W1-T3607 is why. This case existed to catch exactly
// the leak that rename introduced, and it did not: it pinned the literal `openweight`, so when the
// canonical id became `cash` the case went on guarding a spelling production normalises away and
// passed while `cash` flowed straight into the provenance shape. A test that names one id guards
// one id; `WorkerProviderId` admits both, so both are named here.
for (const openWeightId of ["cash", "openweight"] as const) {
  test(`retroCommand: a ${openWeightId} worker result is omitted from the Claude/Codex-only prepublish provenance`, async (t) => {
    const fx = setupFakeRetroFixture(t, { workerProvider: openWeightId });
    await fx.run(async () => {
      const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
        spawn: fx.fakeSpawn,
        github: offlineGh,
        prepublishPreflight: fx.prepublishPreflight,
      }));
      assert.equal(exitCode, 1, "the fixture's red CI exits only after the prepublish boundary is crossed");
      const rows = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const preflight = rows.find((row) => row.step === "retro.preflight_passed");
      assert.equal(
        Object.hasOwn(preflight, "provider"),
        false,
        `${openWeightId} must not enter retro's historical Claude/Codex provenance shape`,
      );
    });
  });
}

test("retroCommand: a claude worker result DOES reach the prepublish provenance", async (t) => {
  // The positive control for the pair above. Without it the two cases are satisfied by a boundary
  // that drops EVERY provider -- including the two it is supposed to keep -- and the assertion
  // "provider is absent" cannot tell a working allow-list from a broken one.
  const fx = setupFakeRetroFixture(t, { workerProvider: "claude" });
  await fx.run(async () => {
    await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    const rows = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const preflight = rows.find((row) => row.step === "retro.preflight_passed");
    assert.equal(preflight.provider, "claude", "an allowed provider must still be recorded");
  });
});

test("retroCommand: a clean run with a PRE-EXISTING valid marker still resolves it 'ok' and scopes the gather to it", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 2, runs_seen: 3 },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(new Date(marker.ts).getTime() > new Date("2026-01-01T00:00:00.000Z").getTime(), "the marker really advanced past the seeded one");
  });
});

test("retroCommand: the one repair resumes the producing session and reruns preflight", async (t) => {
  const fx = setupFakeRetroFixture(t, { preflightExercisesRepair: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    assert.equal(exitCode, 1, "the fixture's public CI is red only after the repaired prepublish passes");
    const repairSpawns = fx.spawnArgs.filter((args) => args.resumeSessionId !== undefined);
    assert.equal(repairSpawns.length, 1, "promotion judges are fresh; exactly one spawn resumes a session");
    assert.equal(repairSpawns[0].resumeSessionId, "s-retro-fixture", "the repair resumes the producing session");
    assert.deepEqual(
      repairSpawns[0].config?.workerProviders?.enabled,
      ["claude"],
      "the per-call config pins the resume to the producing backend without mutating host config",
    );
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      ledgerLines.filter((l) => l.step === "retro.preflight_failed" || l.step === "retro.preflight_passed").map((l) => l.step),
      ["retro.preflight_failed", "retro.preflight_passed"],
    );
    const repair = ledgerLines.find((l) => l.step === "retro.preflight_repair");
    assert.equal(repair?.provider, "claude");
    assert.equal(repair?.resumed_session_id, "s-retro-fixture");
  });
});

test("retroCommand: a repair worker that changes identity, provider, or returns an error fails closed before publication", async (t) => {
  const variants: Array<{ name: string; result: Partial<WorkerResult> }> = [
    { name: "session identity", result: { sessionId: "different-session" } },
    { name: "provider", result: { provider: "codex" } },
    { name: "worker outcome", result: { isError: true, subtype: "error_during_execution" } },
  ];

  for (const variant of variants) {
    await t.test(variant.name, async (t) => {
      const fx = setupFakeRetroFixture(t, {
        preflightExercisesRepair: true,
        repairWorkerResult: variant.result,
      });
      await fx.run(async () => {
        const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
          spawn: fx.fakeSpawn,
          github: offlineGh,
          prepublishPreflight: fx.prepublishPreflight,
        }));
        assert.equal(exitCode, 1, "a rejected repair cannot publish or advance the marker");
        assert.equal(existsSync(join(fx.root, "state", "last-retro.json")), false);
      });
    });
  }
});

// ── W1-T160: the INTEGRITY GATE — a HARD precondition INSIDE the automated
// (daemon-triggered) path only. `opts.automated` claims the TRIGGER observed real
// merge activity since the marker; this fixture's ledger/gh evidence is empty, so
// buildGather's real `shippedSince` naturally credits ZERO -- exactly the R8-class
// mismatch (trigger saw merges, the real gather found none) the gate exists to catch.

test(
  "retroCommand: the INTEGRITY GATE aborts an AUTOMATED run when the trigger saw real merges but the " +
    "real gather credits ZERO -- no PR, no marker advance, no follow-up harvest, Architect never spawned",
  async (t) => {
    const fx = setupFakeRetroFixture(t, {
      seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 0, runs_seen: 0 },
    });
    await fx.run(async () => {
      let spawnCalls = 0;
      const spawn = async () => {
        spawnCalls++;
        return fx.fakeSpawn();
      };
      const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      github: offlineGh,
        spawn,
        automated: { reason: "merges", mergesSinceMarker: 5, daysSinceMarker: 1 },
        startTokenRefresh: ({ log }) => {
          log?.("github_app.token_refreshed", { source: "retro-test" });
          return { armed: true, ready: Promise.resolve() };
        },
      }));
      assert.equal(exitCode, 1);
      assert.equal(spawnCalls, 0, "the integrity gate must abort BEFORE the Architect is ever spawned");

      const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
      assert.equal(marker.ts, "2026-01-01T00:00:00.000Z", "the marker must NOT advance past the seeded one");

      const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const abortLine = ledgerLines.find((l) => l.step === "retro_aborted_integrity");
      assert.ok(ledgerLines.some((l) => l.step === "github_app.token_refreshed" && l.lane === "retro"),
        "the automated child records its own token refresh before the integrity gate");
      assert.ok(abortLine, "a loud retro_aborted_integrity ledger line must be written");
      assert.equal(abortLine.merges_since_marker, 5);
      assert.equal(abortLine.gather_shipped, 0);
      assert.equal(abortLine.trigger_reason, "merges");
      assert.equal(ledgerLines.some((l) => l.step === "pr.opened"), false, "no PR may open on an integrity-gate abort");
      assert.equal(
        ledgerLines.some((l) => l.step === "retro.marker.advanced"),
        false,
        "the marker must never advance on an integrity-gate abort",
      );
    });
  },
);

test("retroCommand: an OPERATOR-run retro (opts.automated absent) is NOT integrity-gated -- a zero-credit gather still proceeds exactly as before", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 0, runs_seen: 0 },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight })); // no `automated` -- same shape as every other test in this file
    assert.equal(exitCode, 1, "same red-ci exit as the ordinary success path -- unaffected by the integrity gate");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(
      new Date(marker.ts).getTime() > new Date("2026-01-01T00:00:00.000Z").getTime(),
      "an operator-run retro still advances the marker even though the gather credited zero -- a human is watching",
    );
  });
});

test("retroCommand: an automated run whose gather DOES credit merges passes the integrity gate and proceeds", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    seedMarker: { ts: "2026-01-01T00:00:00.000Z", learnings_count: 0, runs_seen: 0 },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      github: offlineGh,
      spawn: fx.fakeSpawn,
      automated: { reason: "days", mergesSinceMarker: 0, daysSinceMarker: 8 },
      startTokenRefresh: () => ({ armed: false }),
      prepublishPreflight: fx.prepublishPreflight,
    }));
    // mergesSinceMarker: 0 -> checkRetroIntegrity's `priorMergesSinceMarker > 0` guard
    // never trips, regardless of what the real gather credits -- same red-ci exit 1 as
    // every other success-path variant, but reached THROUGH the gate, not around it.
    assert.equal(exitCode, 1);
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(new Date(marker.ts).getTime() > new Date("2026-01-01T00:00:00.000Z").getTime(), "the marker advanced -- the gate passed");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(ledgerLines.some((l) => l.step === "retro_aborted_integrity"), false);
  });
});

/** A trivial empty plan for `runDaemon` — nothing is ever runnable, so the retro-trigger
 *  branch (checked BEFORE task dispatch, W1-T160) owns every tick in the test below,
 *  never racing a real task dispatch. */
function minimalDaemonPlan(): Plan {
  // A literal empty plan (what loading `[]` yields), so this file never reads a plan file.
  return { tasks: [], byId: new Map() };
}

// ── W1-T160 FULL INTEGRATION: the daemon's own scheduling contract driving the REAL
// retroCommand (W1-T136's mergeable-PR path), not a stand-in. The two halves of
// criterion 3 — "runs end to end ... and advances the marker" AND "a second poll does
// not re-fire" — are proven TOGETHER, in ONE pass, against the SAME on-disk marker:
// `runDaemon`'s `checkRetroTrigger`/`runRetroTrigger` hooks are wired to the real
// `evaluateRetroTrigger` (over the real marker file) and the real `retroCommand`
// (over `setupFakeRetroFixture`'s real git/gh fixture) respectively — exactly the
// wiring run-task.ts's `daemonCommand`/`retroTriggerCheck` use in production, not a
// fake `runRetroTrigger` standing in for it.

test(
  "W1-T160 INTEGRATION: runDaemon fires the retro trigger, runs the REAL retroCommand (W1-T136's " +
    "mergeable-PR path) through to a real pr.opened + marker advance, and does NOT re-fire on the very next poll",
  async (t) => {
    const fx = setupFakeRetroFixture(t); // fresh fixture, NO seeded marker -- absent marker fires via reason=days (Infinity)
    await fx.run(async () => {
      const markerPath = join(fx.root, "state", "last-retro.json");
      const plan = minimalDaemonPlan();
      // merges effectively disabled (this fixture's ledger/gh evidence is empty anyway);
      // ANY elapsed time fires via "days" -- the absent-marker case is Infinity days.
      const policy = { mergesThreshold: 999999, daysThreshold: 1 };

      const triggerDecisions: RetroTriggerDecision[] = [];

      const checkRetroTrigger = (): RetroTriggerDecision => {
        const resolution = resolveMarkerForGather(markerPath);
        const marker = resolution.kind === "ok" ? resolution.marker : undefined;
        const decision = evaluateRetroTrigger(0, marker?.ts, new Date(), policy);
        triggerDecisions.push(decision);
        return decision;
      };

      let retroRuns = 0;
      let retroCompletion: Promise<void> | undefined;
      const runRetroTrigger = (decision: Extract<RetroTriggerDecision, { fire: true }>) => {
        retroRuns++;
        // THE REAL retroCommand -- W1-T136's mergeable-PR path (Architect spawn -> push
        // -> gh pr create -> ownership assert -> pr.opened -> marker save), gated by
        // opts.automated exactly as the real daemon wiring (run-task.ts's daemonCommand
        // / retroTriggerCheck) invokes it in production. Never a stand-in.
        retroCompletion = withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, automated: decision,
          startTokenRefresh: () => ({ armed: false }), github: offlineGh, prepublishPreflight: fx.prepublishPreflight }))
          .then(() => undefined);
        return retroCompletion;
      };

      const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
      let stopChecks = 0;
      const summary = await runDaemon(plan, {
        refreshMerged: () => () => true, // nothing to dispatch -- the retro-trigger branch owns every tick
        runOne: async (id) => {
          throw new Error(`runOne must never be called in this fixture (task ${id})`);
        },
        checkStop: () => {
          stopChecks++;
          return stopChecks > 2 ? "test bound reached" : undefined;
        },
        // The NEXT evaluated poll must be after the real marker advance, not a
        // second rapid tick while the detached retro is still in flight. Keep
        // HOME/PATH owned by this fixture until its own completion, not a drain
        // timeout that silently resumes assertions and restores them too early.
        sleep: async () => { if (retroCompletion) await retroCompletion; },
        checkRetroTrigger,
        runRetroTrigger,
        log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      });

      assert.deepEqual(await drainDetachedSweepActions({ boundMs: 20000 }), [], "the owned retro has really settled");
      assert.equal(summary.stopReason, "stopped");
      assert.equal(triggerDecisions.length, 2);
      assert.equal(triggerDecisions[0].fire, true);
      assert.equal(triggerDecisions[1].fire, false, "the real marker suppresses the poll after completion");
      assert.equal(retroRuns, 1, "the REAL retroCommand ran exactly once across the two evaluated ticks");

      const fired = lines.filter((l) => l.step === "retro_triggered");
      assert.equal(fired.length, 1, "retro_triggered ledgered exactly once, naming the fire");
      assert.equal(fired[0].extra.reason, "days");

      // W1-T136's mergeable-PR path: a REAL PR opened (never a stub), plan-only-asserted.
      const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(
        ledgerLines.some((l) => l.step === "pr.opened" && l.plan_only === true),
        "the retro reached a real, plan-only, opened PR -- W1-T136's mergeable-PR path; " +
          JSON.stringify({ ledger: ledgerLines, daemon: lines }),
      );
      assert.deepEqual(fx.publicationGateCalls(), ["fixture-owned-harness-gate", "fixture-owned-harness-gate"],
        "both real local pushes run the fixture-owned harness gate, including the trailer amend");
      assert.ok(
        ledgerLines.some((l) => l.step === "retro.marker.advanced"),
        "the marker advance is the retro's own real saveMarker call, not asserted-away",
      );
      assert.equal(
        ledgerLines.some((l) => l.step === "retro_aborted_integrity"),
        false,
        "the integrity gate passed -- an integrity-passing gather never aborts",
      );

      const markerAfter = JSON.parse(readFileSync(markerPath, "utf8")) as RetroMarker;
      assert.ok(markerAfter.ts, "state/last-retro.json now holds a real, valid, advanced marker");

      // The SECOND poll: re-derived FRESH off the marker THIS run just wrote to disk --
      // not a mock returning a canned "don't fire" answer.
      const secondDecision = checkRetroTrigger();
      assert.equal(secondDecision.fire, false, "the advanced marker's own re-derived state does not cross either threshold again");
    });
  },
);

test("retroCommand: an ownership mismatch (claimed PR head branch != this run's own branch) fails CLOSED before the marker ever advances", async (t) => {
  const fx = setupFakeRetroFixture(t, { headRefName: () => "some-other-branch-entirely" });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "pr_attribution_failed is a fail-closed exit 1, same as any other refused retro");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "an ownership mismatch must NEVER advance the marker");
  });
});

test("retroCommand: a terminal second prepublish failure preserves the diagnostic branch and posts no PR, marker, review, or merge arm", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    preflightResult: { ok: false, attempts: 2, suiteCount: 158, repaired: true },
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    assert.equal(exitCode, 1);
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a second failure must leave the marker unchanged");
    assert.ok(fsDefault.existsSync(join(fx.root, "worktrees", fx.branch)), "the committed diagnostic worktree/branch stays available");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(ledgerLines.filter((l) => l.step === "retro.preflight_failed").length, 2);
    for (const forbidden of ["pr.opened", "review.posted", "automerge.armed", "retro.marker.advanced"]) {
      assert.equal(ledgerLines.some((l) => l.step === forbidden), false, `${forbidden} must not occur after terminal preflight failure`);
    }
  });
});

test("retroCommand: a diff that touches src/ fails the plan-only guard before the marker ever advances", async (t) => {
  const fx = setupFakeRetroFixture(t, {
    diff: "diff --git a/src/lib/retro.ts b/src/lib/retro.ts\n--- a/src/lib/retro.ts\n+++ b/src/lib/retro.ts\n+// not plan-only\n",
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "a code-touching retro PR is left OPEN for inspection -- exit 1");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a plan-only violation must NEVER advance the marker");
  });
});

test("retroCommand: a PR body missing an Acceptance block gets the harness-side repair pass (W1-T136)", async (t) => {
  // No `## Acceptance` block -- only the trailer -- so ensureTaskTrailer's own check is
  // still satisfied but the acceptance-repair pass's `parseAcceptanceBlock(...).length === 0`
  // branch fires and `gh pr edit` is invoked to fix it up (our fake `gh` accepts any `edit`).
  const fx = setupFakeRetroFixture(t, { body: "Remudero-Task: RETRO\n" });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants -- the repair itself never blocks the retro");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the repair pass is best-effort -- it must never prevent the marker from advancing");
  });
});

test("retroCommand: a transient `gh pr diff` failure is caught by the outer catch, logged, and rethrown -- the marker never advances", async (t) => {
  const fx = setupFakeRetroFixture(t, { diffFails: true });
  await fx.run(async () => {
    await assert.rejects(
      () => withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight })),
      /transient failure/,
      "the outer catch re-throws (never swallows) an unexpected mid-flight gh failure",
    );
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a mid-flight failure must NEVER leave a half-advanced marker");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "retro.error"), "the outer catch must ledger retro.error before rethrowing");
  });
});

test("retroCommand: no PR_URL in the Architect's report falls back to `gh pr create --fill` and still reaches the marker advance", async (t) => {
  const fx = setupFakeRetroFixture(t, { noPrUrl: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the gh-pr-create-fill fallback must still reach the real saveMarker call");
  });
});

test("retroCommand: an exact-head PR omitted from the report is recovered and reused before preflight", async (t) => {
  const fx = setupFakeRetroFixture(t, { noPrUrl: true, existingPrWithoutReport: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], {
      spawn: fx.fakeSpawn,
      github: offlineGh,
      prepublishPreflight: fx.prepublishPreflight,
    }));
    assert.equal(exitCode, 1, "the fixture reaches its intentional red public-CI gate");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const recovered = ledgerLines.find((l) => l.step === "retro.pr.recovered");
    assert.equal(recovered?.pr_url, "https://github.com/craigoley/remudero/pull/434343");
    assert.equal(recovered?.head_branch, fx.branch);
    assert.equal(
      ledgerLines.find((l) => l.step === "retro.preflight_passed")?.remote_pr_existed,
      true,
      "preflight telemetry records that publication had already happened",
    );
    assert.equal(
      ledgerLines.find((l) => l.step === "pr.opened")?.pr_url,
      "https://github.com/craigoley/remudero/pull/434343",
      "the same exact-head PR survives validation and publication; no replacement is created",
    );
  });
});

test("retroCommand: an UNRESOLVED head ref (gh cannot say what branch the PR is on) fails CLOSED, distinctly from a resolved-but-wrong one", async (t) => {
  const fx = setupFakeRetroFixture(t, { unresolvedHeadRef: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "an unresolved head ref is treated as NOT owned -- fail closed, same as a resolved mismatch");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "an unresolved head ref must NEVER advance the marker");
  });
});

test("retroCommand: the removed plan-index generator is not required to advance the marker", async (t) => {
  const fx = setupFakeRetroFixture(t);
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the marker advances without invoking a plan-index generator");
    assert.equal(fsDefault.existsSync(join(fx.root, "repos", "remudero", "plan", "plan-index.json")), false);
  });
});

test("retroCommand: a malformed plan/tasks.yaml degrades the best-effort 'next runnable task' lookup gracefully and still reaches the marker advance", async (t) => {
  const fx = setupFakeRetroFixture(t, { badPlan: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "a best-effort next-task lookup failure must never prevent the marker from advancing");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "orientation.next_task.error"), "the malformed plan must be ledgered, not silently swallowed");
  });
});

test("retroCommand: a PR body with NO body field at all (not merely empty) still gets trailer-stamped and repaired", async (t) => {
  const fx = setupFakeRetroFixture(t, { omitBody: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "a missing body field is best-effort (ensureTaskTrailer/the repair pass) -- never blocks the marker advance");
  });
});

test("retroCommand: repoDir absent triggers a REAL `gh repo clone` and still reaches the marker advance", async (t) => {
  const fx = setupFakeRetroFixture(t, { missingRepoDir: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "the gh-repo-clone fallback must still reach the real saveMarker call");
    assert.ok(fsDefault.existsSync(join(fx.root, "repos", "remudero", ".git")), "gh repo clone must have actually materialized repoDir");
  });
});

test("retroCommand: a transient `gh pr edit` failure during the acceptance-repair pass is caught by ITS OWN best-effort catch, not the outer one", async (t) => {
  // No Acceptance block (forces the repair attempt) AND the repair's own `gh pr edit`
  // fails -- distinct from `diffFails` (which fails a DIFFERENT gh call, caught by the
  // outer catch and rethrown instead).
  const fx = setupFakeRetroFixture(t, {
    body: "Remudero-Task: RETRO\n",
    repairEditFails: true,
    diff: [
      "diff --git a/plan/retro-proof.txt b/plan/retro-proof.txt",
      "--- /dev/null",
      "+++ b/plan/retro-proof.txt",
      "@@ -0,0 +1 @@",
      "+fixture repair edit failure",
      "",
    ].join("\n"),
  });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "the repair failure is best-effort -- it must NOT propagate as an uncaught rejection");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "a failed repair attempt must never prevent the marker from advancing");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "acceptance.repair.error"), "the repair failure must be ledgered by its OWN catch");
  });
});

test("retroCommand: the Architect commits NOTHING when no PR_URL and no MASTER-PLAN are available -- marker stays untouched", async (t) => {
  const fx = setupFakeRetroFixture(t, { noPrUrl: true, missingMasterPlan: true });
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "0 commits ahead of origin/main means nothing to PR -- retro.no_op, exit 1");
    assert.ok(!fsDefault.existsSync(join(fx.root, "state", "last-retro.json")), "a no-op retro (nothing committed) must NEVER advance the marker");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "retro.no_op"), "the no-op path must be ledgered");
  });
});

test("retroCommand: a stale lockless leftover worktree is force-removed by pruneStaleRuns before this run's own worktree is added", async (t) => {
  const fx = setupFakeRetroFixture(t, { staleWorktree: true });
  const stalePath = join(fx.root, "worktrees", "run-STALE-leftover");
  assert.ok(fsDefault.existsSync(stalePath), "sanity: the stale worktree must exist BEFORE retroCommand runs");
  await fx.run(async () => {
    const exitCode = await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.equal(exitCode, 1, "same red-ci exit as the other success-path variants");
    const marker = JSON.parse(readFileSync(join(fx.root, "state", "last-retro.json"), "utf8")) as RetroMarker;
    assert.ok(marker.ts, "pruning a stale sibling worktree must never prevent THIS run's own marker advance");
    assert.ok(!fsDefault.existsSync(stalePath), "the stale worktree must actually be gone -- pruneStaleRuns really ran, not just logged");
    const ledgerLines = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(ledgerLines.some((l) => l.step === "worktree.prune"), "the prune must be ledgered");
  });
});

// THE FAKE MUST BE REACHED. A dep injected into a path that ignores it looks exactly like one that
// works — both go green — so this is the assertion that discriminates them.
//
// SELF-CONTAINED ON PURPOSE. An earlier revision asserted on the SHARED `offlineGh`'s accumulated
// calls, which passed in a full-file run and FAILED under `--test-name-pattern` — the reviewer's own
// proof executor runs exactly that way, so the guard would have been red at review while green
// locally. It now drives its own retroCommand with its own fake and depends on no sibling test.
test("the injected offline gateway is consulted by retroCommand, so no real one is opened", async (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rmd-retro-ghdep-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-retro-ghdep-root-"));
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  mkdirSync(join(fakeHome, ".config", "remudero"), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT_FOR_FIXTURES }, null, 2) + "\n");
  t.mock.method(console, "log", () => {});
  const github = offlineGithub();
  try {
    // W1-T4226: the gather's throttle probe reads a scripted, healthy `gh`, never the refused real one.
    const exitCode = await withHealthyRetroProbeGh(() => withLiveWritesAllowed(() => retroCommand(["--dry-run"], { github })));
    assert.equal(exitCode, 0, "--dry-run never fails a genuinely-first-ever retro");
    assert.ok(
      github.calls.length > 0,
      `the production path must consult the injected gateway; recorded ${github.calls.length} calls`,
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("retroCommand: a real retro spawns no learnings promotion judge (retired 2026-09-29)", async (t) => {
  // The pass re-judged the same four learnings 352 times in 14 days and nothing read its output.
  // Each judge was a fresh spawn with an EMPTY tool list; the Architect's own spawn never is.
  const fx = setupFakeRetroFixture(t);
  await fx.run(async () => {
    await withLiveWritesAllowed(() => retroCommand([], { spawn: fx.fakeSpawn, github: offlineGh, prepublishPreflight: fx.prepublishPreflight }));
    assert.ok(fx.spawnArgs.length > 0, "the Architect itself was spawned, so an empty count below is not vacuous");
    const judgeSpawns = fx.spawnArgs.filter((args) => Array.isArray(args.tools) && args.tools.length === 0);
    assert.equal(judgeSpawns.length, 0, "no tool-less promotion judge is spawned");
  });
});
