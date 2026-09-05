import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { defaultPreflightSpawn, spawnFailureDetail, typecheckStep, type PreflightSpawn } from "./commit-message.js";

/**
 * lib/ci-parity.ts — `rmd preflight --ci-parity` (W1-T294, MASTER-PLAN §5/§5C).
 *
 * THE GAP THIS CLOSES. The shipped `rmd preflight` (W1-T221) runs three hand-route steps —
 * commitlint, `tsc --noEmit`, the emitter's header/body checks — none of which is any of the
 * thirteen jobs .github/workflows/ci.yml actually gates a merge on. Everything a coverage,
 * plan-lint, claims, fitness or drift job would say is discoverable only after a push. This
 * module is a SECOND, ADDITIVE mode on the same verb (never a second command, never a change to
 * the default no-flag behaviour): `runCiParity` mirrors CI's own check set, one named step per
 * job, computed against the SAME merge-base and the SAME coverage flags the workflow uses.
 *
 * THE STEP LIST IS DATA (`CI_PARITY_TABLE`, one entry per ci.yml job, keyed by job name so
 * `runCiParity`'s drift check can line them up against the real file). A job that is
 * deliberately not reproduced locally carries `mirrored: false` and a `reason` rather than being
 * omitted — an absent entry and a considered exclusion must never look the same. `runCiParity`
 * parses .github/workflows/ci.yml itself (the `yaml` package, same tool test/ci-gate-required-
 * format.test.ts already uses against ci-gate.yml) and fails a dedicated `ci-parity:drift` step
 * the moment a job exists in the workflow with neither a table entry nor a recorded exclusion —
 * a job added to ci.yml with no parity entry turns this red instead of silently under-covering.
 *
 * MERGE-BASE PARITY. ci.yml's coverage/lint-plan/mutation-ratchet/containment-probe jobs diff
 * against `github.event.pull_request.base.sha` from a `fetch-depth: 0` checkout — effectively
 * the base branch's freshly-synced tip. A local checkout's `origin/main` can be stale, and a
 * stale base silently changes which lines a three-dot diff counts as added (the #585 fixture
 * this task was filed from). Every step below that needs a diff refreshes `origin/main` first
 * (`git fetch origin main`) and only then computes a three-dot range against it — never a
 * whatever-was-last-fetched ref. `refreshOriginMain`/`changedFilesListPath` memoize that refresh
 * and the changed-files listing PER (spawn, repoRoot) pair, so the several entries below that
 * both need it (coverage-ratchet + lint-plan; mutation-ratchet + containment-probe) share one
 * `git fetch`/`git diff` instead of each re-issuing it.
 *
 * COST. Steps whose CI job is UNCONDITIONAL just run — they always execute in CI too. Steps
 * whose CI job is diff- or trigger-scoped (mutation-ratchet, containment-probe) call the SAME
 * predicate script CI's own trigger step calls, so a diff that cannot move that job's score
 * skips the expensive part locally for the identical reason CI would skip it — both are built
 * on {@link runTriggerScopedJob}, the ONE shared shape for "run a trigger, only run the
 * follow-up step(s) when it says REQUIRED."
 *
 * EACH STEP REPORTS INDEPENDENTLY. `runStep` never lets one job's step throw out of the run —
 * an unavailable toolchain (a missing binary, a bad revision) is caught and reported as that
 * step's OWN named failure via {@link toolchainFailure}, exactly like the hand-route steps in
 * lib/commit-message.ts, so a check that could not run is never legible as a passing one.
 */

/** One `--ci-parity` step's outcome — named in both directions, same shape as
 *  {@link import("./commit-message.js").PreflightStepResult} but keyed by an open `name`
 *  (one job can produce several named steps, e.g. `coverage-ratchet:test-with-coverage`). */
export interface CiParityStepResult {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * W1-T2862: bounded stdout retained only when a fast-step descriptor explicitly opts in.
   * Ordinary successful steps remain terse; a truncated payload is never treated as complete.
   */
  successOutput?: { text: string; truncated: boolean };
}

/** BACKSTOP: the durable summary must not grow with an unbounded child stdout stream. */
export const MAX_RETAINED_SUCCESS_OUTPUT_CHARS = 65_536;
/**
 * Where a preflight run writes its verdict so the RESULT SURVIVES THE CONTAINER THAT PRODUCED IT.
 *
 * MEASURED, twice in one day: an operator ran `preflight --ci-parity` in a container, watched it
 * reach test 5,371 of ~5,600, and then LOST THE RESULT — the container was removed before its
 * summary was read. Eight minutes of measurement whose only artifact was a terminal buffer, and
 * `host-update.sh` correctly refused to reclaim disk while that container was alive, so the choice
 * was between keeping a result that could not be read and reclaiming the disk.
 *
 * `<repoRoot>/coverage/` rather than the ledger or a new config key, and each of those is a
 * deliberate NO:
 *  - NOT THE LEDGER. `preflightCommand` is a hand-route verb with no log function wired into it,
 *    and the ledger exists for fleet DECISIONS. A preflight verdict decides nothing; it informs a
 *    human. (Rotation would not have been the obstacle, incidentally: `rotateLedger` keeps the 200
 *    NEWEST rows per step, and "what did my last run say" is a newest-row question. The
 *    `DECISION_RELEVANT_LEDGER_STEPS` requirement bites steps whose COUNT is load-bearing, which a
 *    verdict is not — so the retention argument does not force the set membership here, and adding
 *    it there would misrepresent what that set means.)
 *  - NOT `config.root`, tempting though it is as "the state volume". `loadConfig` CREATES its
 *    config file and calls `resolveClaudeBin()`, which throws where no claude binary exists — a
 *    preflight that is meant to run anywhere must not acquire that dependency.
 *  - `coverage/` IS ALREADY THE PERSISTENCE PATH ON THIS ROUTE. The coverage-ratchet step already
 *    writes `coverage/lcov.info` there, the directory is gitignored, and in a container the
 *    checkout itself lives under the mounted state volume (`TREE="$CONFIG_ROOT/remudero"` in
 *    deploy/entrypoint.sh), so a file written here outlives `docker rm` with no new mount, no new
 *    flag to remember, and no new config surface.
 */
export function preflightSummaryPath(repoRoot: string): string {
  return join(repoRoot, "coverage", "preflight-summary.json");
}

/** One preflight run's machine-readable verdict — every field the terminal already showed. */
export interface PreflightSummary {
  ok: boolean;
  /** ISO timestamp, stamped by the caller so this stays pure. */
  finishedAt: string;
  durationMs: number;
  /** The head sha the run measured, or `"unknown"` when it could not be read. */
  headSha: string;
  /** The argv the operator actually passed, so a summary names the run that produced it. */
  args: string[];
  passed: number;
  failed: number;
  /** Every step, in order — the failing ones are the reason to keep this file at all. */
  steps: CiParityStepResult[];
  /**
   * W1-T2810 — which tree this run measured and under what load. Carried here as well as on the
   * terminal verdict line so the durable summary and the sentence a human read cannot drift:
   * `headSha` above was already in this file and already absent from that line, which is the
   * defect this field's siblings close. Optional so every pre-existing summary still parses.
   */
  runContext?: RunContext;
}

/**
 * Build the durable summary. PURE — no clock, no filesystem, no process state — so a test can
 * assert the shape without running an eight-minute suite, and so the caller stamps the one piece
 * of ambient data (the time) rather than this reaching for it.
 *
 * WRITTEN IN BOTH DIRECTIONS BY CONSTRUCTION: nothing here is conditional on `ok`. A FAILING run's
 * summary is the one an operator most needs to survive, so there is no branch that could skip it.
 */
export function buildPreflightSummary(input: {
  steps: CiParityStepResult[];
  finishedAt: string;
  durationMs: number;
  headSha: string;
  args: string[];
  runContext?: RunContext;
}): PreflightSummary {
  const failed = input.steps.filter((s) => !s.ok);
  return {
    ok: failed.length === 0,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    headSha: input.headSha,
    args: input.args,
    passed: input.steps.length - failed.length,
    failed: failed.length,
    steps: input.steps,
    ...(input.runContext ? { runContext: input.runContext } : {}),
  };
}

/**
 * The worker's OWN preflight verdict, read back out of the worktree it ran in — or `undefined`
 * when there is nothing worth saying.
 *
 * WHY THE ORCHESTRATOR READS A FILE. A worker that runs `rmd preflight` and is refused prints the
 * failing step into ITS transcript and nowhere else. The orchestrator sees only the terminal
 * verdict — `no_pr`, `failed` — so the single most diagnostic fact about the run ("commitlint
 * rejected the header", "coverage-ratchet blocked 10 lines") never reaches the phase log or the
 * ledger, and an operator reconstructs it by hand. {@link preflightSummaryPath} already persists
 * exactly that verdict, written UNCONDITIONALLY on fail as well as pass, so surfacing it costs one
 * read.
 *
 * READING IT IS SAFE BECAUSE THE WORKTREE OUTLIVES THE SPAWN. `runTask` calls `worktreeAdd` before
 * its try block and `worktreeRemove` only inside a verdict branch — `failOnWorkerError`,
 * `blocked_transient`, `already_satisfied`, `no_pr`, `merged`, and the `run.error` catch — every one
 * of which is BELOW the implement dispatch. The `finally` drops the run lock only. `spawnWorker`'s
 * own `finally` reaps its per-spawn HOME, never `args.cwd`. So at the moment the implement spawn
 * returns, the worktree is still on disk on every exit path.
 *
 * AND THE FILE CANNOT BE STALE. `coverage/` is gitignored and the worktree is cut fresh from
 * `origin/main`, so a summary found there was written by THIS worker. Several preflight runs
 * overwrite one another, which is the wanted semantics: a worker that failed, fixed it and re-ran
 * leaves an `ok` summary and this stays silent.
 *
 * SILENT IN THREE CASES, and all three are "nothing to report" rather than errors: the worker never
 * ran preflight (no file), the file is unreadable or not JSON, or the run PASSED. Only a failure
 * speaks, because a phase line on every dispatch is noise that gets filtered out and then missed.
 *
 * `readFile` is injectable and appended LAST so no positional caller shifts; the default really
 * reads the filesystem.
 */
export function preflightFailureNotice(
  repoRoot: string,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(preflightSummaryPath(repoRoot)));
  } catch {
    // No summary, or one that cannot be read/parsed. A worker is not required to run preflight,
    // so absence is the ordinary case and must never become an exception on the dispatch path.
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const summary = parsed as Partial<PreflightSummary>;
  const steps = Array.isArray(summary.steps) ? summary.steps : [];
  const failedSteps = steps.filter((s): s is CiParityStepResult => !!s && typeof s === "object" && s.ok === false);
  // `ok === false` is honoured even with no failing step recorded — a run that called itself failed
  // is reported as failed, never silently dropped for want of a name to print.
  if (summary.ok !== false && failedSteps.length === 0) return undefined;

  const names = failedSteps.map((s) => (typeof s.name === "string" && s.name ? s.name : "(unnamed step)"));
  const total = steps.length;
  const sha = typeof summary.headSha === "string" && summary.headSha ? summary.headSha : "unknown";
  const argv = Array.isArray(summary.args) && summary.args.length ? ` (rmd preflight ${summary.args.join(" ")})` : "";
  const named = names.length ? `: ${names.join(", ")}` : "";
  const counted = total ? `${names.length || summary.failed || "?"} of ${total} step(s) failed` : "the run reported FAIL";
  return `worker preflight FAILED at ${sha} — ${counted}${named}${argv}`;
}

/** A step leaf's outcome before it is named — `matched` is set only by a trigger leaf (see
 *  {@link triggerLeaf}), and ignored by every ordinary leaf. */
interface CiParityLeafResult {
  ok: boolean;
  detail: string;
  matched?: boolean;
  successOutput?: CiParityStepResult["successOutput"];
}

/** One ci.yml job's parity entry. `mirrored: false` entries MUST carry a `reason` — that is
 *  what makes an exclusion recorded rather than an entry silently missing. */
interface CiParityEntry {
  job: string;
  mirrored: boolean;
  reason?: string;
  run?: (repoRoot: string, spawn: PreflightSpawn) => CiParityStepResult[];
}

/** Parse ci.yml's top-level job keys — the set `runCiParity`'s drift check compares the table
 *  against. Pure text-in/array-out so a falsifier test can hand it a synthetic document with an
 *  extra job and prove the drift step goes red without editing the real workflow file. */
export function parseCiJobNames(ciYamlText: string): string[] {
  const doc = parseYaml(ciYamlText) as { jobs?: Record<string, unknown> } | null;
  return Object.keys(doc?.jobs ?? {});
}

/** The ONE "toolchain unavailable" failure line — a missing binary, a bad revision, an ENOENT —
 *  shared by every catch site below so the phrasing can only drift by editing one place. */
function toolchainFailure(name: string, e: unknown): CiParityStepResult {
  return { name, ok: false, detail: `${name}: FAIL — toolchain unavailable: ${String((e as Error)?.message ?? e)}` };
}

/**
 * Wraps one job's leaf check so a thrown error is caught and reported as THIS step's own
 * failure ({@link toolchainFailure}) — never allowed to abort the run or read as a passing
 * step. `fn`'s own `detail` is prefixed with `name:` here so every printed line names itself in
 * both directions, matching the hand-route steps' convention. The returned `matched` (present
 * only for a {@link triggerLeaf}) lets a caller decide whether to run a follow-up step, without
 * this generic wrapper needing to know what "matched" means for any particular job.
 */
function runStep(name: string, fn: () => CiParityLeafResult): CiParityStepResult & { matched?: boolean } {
  try {
    const r = fn();
    return {
      name,
      ok: r.ok,
      detail: `${name}: ${r.detail}`,
      matched: r.matched,
      ...(r.successOutput ? { successOutput: r.successOutput } : {}),
    };
  } catch (e) {
    return { ...toolchainFailure(name, e), matched: false };
  }
}

function excludedStep(job: string, reason: string): CiParityStepResult {
  const name = `${job}:excluded`;
  return { name, ok: true, detail: `${name}: EXCLUDED — ${reason}` };
}

/** The suite's per-process temp-dir reaper (W1-T131) — REQUIRED on both direct `node --test`
 * spawns in this table (coverage-ratchet's full-glob run and containment-probe's scoped run),
 * neither of which routes through package.json's protected `test`/`test:ci` scripts. Without it
 * each local preflight leaked one OS-tmpdir dir per fixture in the loaded files — part of the
 * 53,310-dir ENOSPC of 2026-08-03 (plan/feedback/fb-1785807201821-e4c9dc.yaml). ci.yml's own
 * coverage and containment jobs still omit it: harmless THERE (ephemeral runners), and mirroring
 * that omission locally is what leaked HERE. Relative, resolved from the spawn's `cwd: repoRoot`,
 * exactly like package.json's own scripts; must ride AFTER `--import tsx` (tsx parses the .ts). */
const TMP_HYGIENE_IMPORT = "./test/setup/tmp-hygiene.ts";

/** An ordinary leaf: run a command, PASS iff it exits 0, and only echo its output on FAIL —
 *  the shape every straightforward job (leak-grep, the npm-script jobs, the coverage/lint-plan
 *  sub-steps) uses. */
export function shellOut(
  spawn: PreflightSpawn,
  label: string,
  file: string,
  args: string[],
  opts?: { cwd?: string; input?: string; stream?: boolean; env?: NodeJS.ProcessEnv; retainSuccessOutput?: boolean },
): CiParityLeafResult {
  const res = spawn(file, args, opts);
  // A child that produced NO exit status is not an ordinary failure, and rendering it as
  // `FAIL — <label>` with whatever (often empty) output came back is how a ci:test ENOBUFS once
  // read as a real red test with no visible cause.
  //
  // DELEGATED to {@link spawnFailureDetail} rather than read here, and that is the point of this
  // change. The comment this replaced claimed the reading covered "a signal kill" — it did not:
  // the old code rendered `res.error ?? "…no exit status and no error message"`, and a signalled
  // child reports `status: null` with NO error, so every kill landed in that fallback unnamed. A
  // second, independent implementation of the same three-state logic is exactly what drifts
  // (measured in this repo: emitter-checks versus commitlint, documented as unable to drift and
  // already diverged), so this now calls the ONE implementation. It returns `undefined` precisely
  // when `status !== null`, which is the guard this block used to spell out.
  const spawnFailed = spawnFailureDetail(label, res);
  if (spawnFailed) return { ok: false, detail: spawnFailed };
  const ok = res.status === 0;
  if (ok) {
    const output = res.stdout.trim();
    return {
      ok,
      detail: `PASS — ${label}`,
      ...(opts?.retainSuccessOutput
        ? {
            successOutput: {
              text: output.slice(0, MAX_RETAINED_SUCCESS_OUTPUT_CHARS),
              truncated: output.length > MAX_RETAINED_SUCCESS_OUTPUT_CHARS,
            },
          }
        : {}),
    };
  }
  // A STREAMED step has no captured text to quote — its output already went to the terminal, in
  // order, as it happened. Say so rather than rendering `FAIL — <label>` followed by an empty
  // line, which is the shape that made an ENOBUFS read as a real red test with no visible cause.
  const captured = (res.stdout + res.stderr).trim();
  const body = opts?.stream ? "(output streamed above as it ran — not re-captured here)" : captured;
  return { ok, detail: `FAIL — ${label}\n${body}` };
}

/**
 * A trigger leaf: the underlying script (mutation-ratchet.mjs's `--changed-files` mode,
 * containment-diff-trigger.ts) exits 0 in EITHER verdict and communicates matched/skip only
 * through its stdout text (`REQUIRED` vs. `skip`/`not required`) — unlike {@link shellOut},
 * this always folds stdout into the reported detail (never only on failure) and sets `matched`
 * from it, so {@link runTriggerScopedJob} can decide whether to run the expensive step after it.
 */
function triggerLeaf(spawn: PreflightSpawn, file: string, args: string[], opts?: { cwd?: string }): CiParityLeafResult {
  const res = spawn(file, args, opts);
  const ok = res.status === 0;
  const text = (res.stdout + res.stderr).trim();
  return { ok, detail: `${ok ? "PASS" : "FAIL"} — ${text}`, matched: /REQUIRED/.test(res.stdout) };
}

/**
 * The shared shape behind mutation-ratchet and containment-probe: run a named trigger step: a
 * REQUIRED verdict runs `buildFollowUps()`'s step(s) after it, a skip verdict (or a thrown
 * spawn) returns just the trigger step, and the expensive follow-up path never even gets asked
 * to build its steps. `buildFollowUps` is a thunk (not a plain array) so a skip pays the cost of
 * constructing exactly zero follow-up steps.
 */
function runTriggerScopedJob(
  triggerName: string,
  spawn: PreflightSpawn,
  triggerFile: string,
  triggerArgs: string[],
  opts: { cwd?: string } | undefined,
  buildFollowUps: () => CiParityStepResult[],
): CiParityStepResult[] {
  const trigger = runStep(triggerName, () => triggerLeaf(spawn, triggerFile, triggerArgs, opts));
  if (!trigger.matched) return [trigger];
  return [trigger, ...buildFollowUps()];
}

/** `git fetch origin main` — the merge-base-parity refresh every diff-consuming step below
 *  runs before it diffs, so a stale local `origin/main` can never silently narrow or widen what
 *  counts as an added line. Memoized per (spawn, repoRoot) — coverage-ratchet and lint-plan
 *  both need it in the same `runCiParity` run, and a second `git fetch` would be pure repeat
 *  network I/O against the same remote/ref. */
const originMainRefreshCache = new WeakMap<PreflightSpawn, Map<string, CiParityLeafResult>>();
function refreshOriginMain(repoRoot: string, spawn: PreflightSpawn): CiParityLeafResult {
  let byRoot = originMainRefreshCache.get(spawn);
  if (!byRoot) {
    byRoot = new Map();
    originMainRefreshCache.set(spawn, byRoot);
  }
  const cached = byRoot.get(repoRoot);
  if (cached) return cached;
  const result = shellOut(spawn, "git fetch origin main (merge-base refresh)", "git", ["fetch", "origin", "main"], { cwd: repoRoot });
  byRoot.set(repoRoot, result);
  return result;
}

/** The three-dot diff CI's own diff-scoped jobs compute, always against the just-refreshed
 *  `origin/main` — never a stale ref, never a two-dot range. */
function mergeBaseDiffText(repoRoot: string, spawn: PreflightSpawn): string {
  const res = spawn("git", ["diff", "origin/main...HEAD"], { cwd: repoRoot });
  return res.stdout;
}

/** The changed-files list mutation-ratchet's and containment-probe's trigger scripts each
 *  consume, written once to a temp file and memoized per (spawn, repoRoot) — both jobs diff the
 *  identical `origin/main...HEAD` range in the same `runCiParity` run, so they share one `git
 *  diff --name-only` and one temp file instead of each computing their own. */
const changedFilesPathCache = new WeakMap<PreflightSpawn, Map<string, string>>();
function changedFilesListPath(repoRoot: string, spawn: PreflightSpawn): string {
  let byRoot = changedFilesPathCache.get(spawn);
  if (!byRoot) {
    byRoot = new Map();
    changedFilesPathCache.set(spawn, byRoot);
  }
  const cached = byRoot.get(repoRoot);
  if (cached) return cached;
  const res = spawn("git", ["diff", "--name-only", "origin/main...HEAD"], { cwd: repoRoot });
  const dir = mkdtempSync(join(tmpdir(), "rmd-ci-parity-"));
  const path = join(dir, "changed-files.txt");
  writeFileSync(path, res.stdout, "utf8");
  byRoot.set(repoRoot, path);
  return path;
}

/**
 * The full-suite-with-coverage leaf — ONE `node --test` run, instrumented, source-mapped,
 * `test/**` excluded from the ratio, lcov written to `lcovPath` — shared by BOTH callers that
 * need it: `--ci-parity`'s `coverage-ratchet` job entry above, and `--coverage`'s
 * {@link runPreflightCoverage} below (W1-T1074). Factored out so the ONE expensive invocation
 * both modes shell cannot drift between them the way a second hand-copied argv always does.
 *
 * Routed through scripts/test-with-retry.mjs, exactly as ci.yml's own coverage-ratchet job is
 * (W1-T255) — a flaky test gets the SAME one-shot retry locally that CI gives it, instead of
 * failing a local run on a flake CI itself would have gone green on.
 */
export function coverageScratchDir(repoRoot: string): string {
  return join(repoRoot, "coverage", "tmp");
}

function testWithCoverageLeaf(repoRoot: string, spawn: PreflightSpawn, lcovPath: string): CiParityLeafResult {
  try {
    mkdirSync(join(repoRoot, "coverage"), { recursive: true });
    // CLEARED, NOT JUST CREATED. The runner removes its scratch on a normal exit; this is what
    // bounds the ABNORMAL one, so a killed run's leftovers cannot accumulate across runs.
    rmSync(coverageScratchDir(repoRoot), { recursive: true, force: true });
    mkdirSync(coverageScratchDir(repoRoot), { recursive: true });
  } catch {
    // best-effort — a spawn injected by a test may point repoRoot at a fixture that
    // doesn't need a real coverage/ directory at all.
  }
  return shellOut(
    spawn,
    "node scripts/test-with-retry.mjs node --enable-source-maps --experimental-test-coverage --test-coverage-exclude=test/** --test --import tsx --import ./test/setup/tmp-hygiene.ts test/**/*.test.ts",
    process.execPath,
    [
      join(repoRoot, "scripts", "test-with-retry.mjs"),
      process.execPath,
      "--enable-source-maps",
      "--experimental-test-coverage",
      "--test-coverage-exclude=test/**",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcovPath}`,
      "--test",
      "--import",
      "tsx",
      "--import",
      TMP_HYGIENE_IMPORT,
      "test/**/*.test.ts",
    ],
    // `stream: true` — the multi-minute step. This one already asks for
    // `--test-reporter=spec --test-reporter-destination=stdout` EXPLICITLY, so it has been
    // writing per-file progress lines the whole time and a non-streamed call would buffer every
    // one of them. Nothing reads this step's stdout as data: the lcov it produces goes to
    // `lcovPath` on disk, which every caller's later steps read from there.
    // KEEP THE RUNNER'S OWN COVERAGE SCRATCH INSIDE THE REPO. `--experimental-test-coverage` makes
    // the test runner allocate `mkdtemp(join(tmpdir(), "node-coverage-"))` for its children and
    // remove it only on a NORMAL exit, so every killed run leaks one. Measured on this host: 6.0G
    // in a single leaked directory, and enough of them filled a 29G root to 100% — which then
    // corrupted a later gate that died on ENOSPC with no `# tests` summary while reporting four
    // failures that were artefacts of the full disk rather than of any diff.
    //
    // ⚠ `NODE_V8_COVERAGE` DOES NOT MOVE IT, and that is worth stating because it is the obvious
    // guess and it is wrong: MEASURED, with the variable set to a repo path the runner STILL wrote
    // under `/tmp` and never created the named directory — it overrides the variable for the
    // children it spawns. `TMPDIR` is the lever that actually relocates it (same probe, control on
    // both sides: without it 1 directory under /tmp and 0 under the target; with it, 0 and 1).
    //
    // Pointed at `coverage/` — already gitignored, already this step's artefact directory — a leak
    // lands somewhere bounded, visible and owned by the repo instead of on the host's root
    // filesystem, and `coverageScratchDir` clears it before each run so leaks cannot accumulate.
    { cwd: repoRoot, stream: true, env: { TMPDIR: coverageScratchDir(repoRoot) } },
  );
}

/** `npm run --silent <script>` — the shared shape for every job whose CI step is exactly an
 *  npm script, byte-identical to what ci.yml itself invokes (no re-derived argv to drift). */
function npmScriptEntry(job: string, script: string): CiParityEntry {
  return {
    job,
    mirrored: true,
    run: (repoRoot, spawn) => [runStep(job, () => shellOut(spawn, `npm run --silent ${script}`, "npm", ["run", "--silent", script], { cwd: repoRoot }))],
  };
}

// ── host-caused suite reds (W1-T2234) ──────────────────────────────────────────────────────
//
// THE GAP THIS CLOSES. `ci:test` above shells the FULL `npm run test:ci` suite, and every
// `runs-on:` in .github/workflows/ci.yml is `ubuntu-latest` (0 `macos` occurrences against a
// control of 29 `ubuntu` ones), so a darwin machine's OWN quirks — a bash shipped at 3.2 with
// no `declare -A`, an unprovisioned keychain, a BSD `date` without `-d`, no `/proc`, macOS's
// own `__CF_USER_TEXT_ENCODING` env injection — have never once been seen by a required check.
// Measured on darwin at `origin/main = 0c71906a`, unmodified: 26 of the suite's reds trace to
// exactly those six causes, one of them (`declare -A CAPTURED=()`, deploy/recycle-container.sh
// line 198, on a host whose `/bin/bash` is 3.2.57(1)-release) alone accounting for 17 — the
// largest cluster by far, and shaped exactly like a catastrophic diff to a reader who does not
// already know the host. A lane running `--ci-parity` on such a machine cannot tell which of
// its reds are its own diff's and which are the machine's.
//
// WHAT THIS DOES NOT DO (design v of the task record — read it before extending this table).
// It does not fix `deploy/recycle-container.sh` (a real, one-line, bounded portability defect,
// left for its own task), does not rewrite the two platform-fact assertions (`/proc/meminfo`,
// the CoreFoundation env leak) that need a different KIND of assertion rather than a workaround,
// does not diagnose the `recovery-drill` pair (carried here as UNDIAGNOSED, not guessed at), and
// does not add a macOS CI runner (a real cost against `WAIT_CAP_SECONDS`, for a set that is
// mostly fixable without one). And it never skips a test on any platform to get there — a
// skipped test is a green that proves nothing, and a darwin skip here would suppress 26 of them.
//
// NOT A REWRITE OF `lib/host-parity.ts`, and the overlap with it (two of its
// `HOST_PARITY_BASELINE` entries name the SAME `fleet-heartbeat`/`worker-credential-preflight`
// darwin divergences this registry does) is real and deliberately not merged. That module diffs
// an ACTUAL captured TAP stream (`readTapFailures`) against declared test IDENTITIES, for the
// mini-vs-ci review-judge comparison — it needs a caller who captured the run's text. This step
// runs INSIDE `ci:test`'s own `stream: true` leaf, which by construction never has that text
// (see above), so it predicts from host FACTS instead of diffing observed failures — a
// different mechanism for a different input availability, not a second copy of the same one.
// Their two darwin entries corroborate each other's counts rather than one copying the other.
//
// SO THE SHAPE IS SEPARATION, NOT SUPPRESSION: `ci:test`'s own PASS/FAIL is untouched by any of
// this — same command, same argv, same `stream: true` (this module cannot capture that child's
// output without reintroducing the "container ran for an hour with zero output" defect
// `stream` was added to fix, and doing so would need an async spawn rippling through every
// entry in this table — out of scope, same as it was the last time this file said so). Instead,
// `HOST_CAUSED_SUITE_REDS` is a registry of what THIS host is independently known to produce,
// keyed by cheap, dependency-injected HOST FACTS (bash's major version, `process.platform`,
// whether `/proc/meminfo` exists) rather than by re-parsing `ci:test`'s own swallowed text — so
// the report is available EVERY run, not only the ones where a caller happens to have captured
// output lying around. `ci:host-caused-suite-reds` runs alongside `ci:test`, always reports
// `ok: true` (it is informational, never a verdict of its own — the day this table gates a
// merge on a HOST FACT rather than on a test result is the day it stops testing the diff), and
// NAMES every cluster this host is expected to produce. Anything else `ci:test` fails on is, by
// construction, never matched here — an undeclared or new red is never absorbed into the
// host-caused set, and `ci:test`'s own loud FAIL is exactly as loud, on exactly the same set of
// reds, as it was before this table gained a step.
//
// THE CORRECTED COUNT. 17 (bash) + 2 (keychain) + 2 (BSD date) + 2 (recovery-drill, undiagnosed)
// + 1 (procfs) + 1 (CoreFoundation) + 1 (the W1-T2205 e2e) = 26 — the task record's own
// falsifier: an earlier carried figure of 16 for the bash cluster summed to 25, one short of the
// run's `# fail 26`; the per-file recount that produces 17 is what closes the gap.

/** Cheap, host-scoped facts {@link HOST_CAUSED_SUITE_REDS} entries key off — never a live
 *  `ci:test` result, which `stream: true` (above) makes structurally unavailable here. Every
 *  field is dependency-injectable via {@link computeHostFacts} so a test proves this registry's
 *  logic without needing an actual darwin/bash-3.2 machine to run on. */
export interface HostFacts {
  platform: NodeJS.Platform;
  /** `undefined` when no `bash` was found or its version text didn't parse — treated as "does
   *  not apply" by every entry that keys off it, never as "applies": a probe that cannot tell
   *  must not guess a verdict either way. */
  bashMajorVersion: number | undefined;
  hasProcMeminfo: boolean;
  /**
   * W1-T2770: THIS PROCESS's own Node version string (`process.versions.node`), and the version
   * `.nvmrc` pins. Both carried, so `appliesTo` predicates can decide EXACTLY the "running
   * differs from pinned" question the merge-lcov cluster keys off — never a proxy like "not
   * exactly 22.22.3" that would rot the day `.nvmrc` moves.
   *
   * `pinnedNodeVersion` is `undefined` when `.nvmrc` is absent or unreadable: a probe that
   * cannot tell must not guess "differs" and cannot guess "matches", and every predicate that
   * keys off this field must handle the absent case the same way — "does not apply, silently".
   * Same discipline as `bashMajorVersion`'s undefined case above.
   */
  nodeVersion: string;
  pinnedNodeVersion: string | undefined;
}

/** The leading `\d+` before the first `.` in either `$BASH_VERSION` shape ("3.2.57(1)-release")
 *  or `bash --version`'s prose shape ("GNU bash, version 3.2.57(1)-release ...") — `undefined`
 *  on anything else, deliberately, rather than a guessed 0. */
export function parseBashMajorVersion(bashVersionText: string): number | undefined {
  const m = /(\d+)\./.exec(bashVersionText);
  return m ? Number(m[1]) : undefined;
}

/** PURE — see {@link buildPreflightSummary}'s own precedent for why: a test hands this raw
 *  strings/booleans and asserts the derived facts, no spawn or filesystem involved. */
export function computeHostFacts(input: {
  platform: NodeJS.Platform;
  bashVersionText: string;
  hasProcMeminfo: boolean;
  nodeVersion: string;
  nvmrcText: string | undefined;
}): HostFacts {
  return {
    platform: input.platform,
    bashMajorVersion: parseBashMajorVersion(input.bashVersionText),
    hasProcMeminfo: input.hasProcMeminfo,
    // W1-T2770: STRIP A LEADING `v`. `process.versions.node` reads `"22.22.3"` while `.nvmrc`
    // may carry either shape; the compare must not read them as different for that reason
    // alone. Trailing whitespace stripped too — a trailing newline in `.nvmrc` is normal.
    nodeVersion: input.nodeVersion.replace(/^v/, "").trim(),
    pinnedNodeVersion:
      input.nvmrcText === undefined ? undefined : input.nvmrcText.replace(/^v/, "").trim() || undefined,
  };
}

/** The impure edge: reads `process.platform`, spawns `bash` (via the SAME injectable
 *  `PreflightSpawn` seam every other step in this table uses — never a second spawn
 *  mechanism), and checks `/proc/meminfo` via an injectable `hasFile` (default `existsSync`).
 *  A `bash` that cannot be spawned at all is caught locally and reads as `bashMajorVersion:
 *  undefined`, exactly like unparseable version text — never a thrown error out of this step. */
export function detectHostFacts(repoRoot: string, spawn: PreflightSpawn, hasFile: (path: string) => boolean = existsSync): HostFacts {
  let bashVersionText = "";
  try {
    const res = spawn("bash", ["-c", "echo $BASH_VERSION"], { cwd: repoRoot });
    bashVersionText = res.stdout ?? "";
  } catch {
    bashVersionText = "";
  }
  // W1-T2770: `.nvmrc` read directly here rather than via the `spawn` seam because it is a
  // plain file read, not a subprocess — same shape as `hasFile` two lines up. Absent/unreadable
  // is `undefined`, NOT the empty string: the field's contract is "the pin, if we could read
  // it", and `undefined` is what every predicate that consults it already treats as "cannot
  // tell — silently skip".
  let nvmrcText: string | undefined;
  try {
    nvmrcText = readFileSync(join(repoRoot, ".nvmrc"), "utf8");
  } catch {
    // Absent-or-unreadable is REPRESENTED as `undefined` — every predicate keying off
    // `pinnedNodeVersion` (see the merge-lcov cluster's `appliesTo`) treats undefined as
    // "cannot tell, does not apply", the same discipline `bashMajorVersion: undefined` already
    // establishes. Never guess "matches" or "differs" from a read that did not happen.
    nvmrcText = undefined;
  }
  return computeHostFacts({
    platform: process.platform,
    bashVersionText,
    hasProcMeminfo: hasFile("/proc/meminfo"),
    nodeVersion: process.versions.node,
    nvmrcText,
  });
}

// ── RUN CONTEXT (W1-T2810) ───────────────────────────────────────────────────────────────────
//
// {@link HostFacts} above answers WHICH MACHINE. This pair answers WHICH TREE and UNDER WHAT
// LOAD — the two facts that make a gate verdict interpretable and that the verdict line did not
// carry. Same shape as its sibling on purpose: a pure builder over raw inputs, an impure edge
// that reads them through the one `PreflightSpawn` seam this module already uses, and a rendered
// line a caller prints. Same `undefined`-never-a-guessed-value discipline too — see
// `parseBashMajorVersion`'s own doc, which this deliberately copies rather than restates.
//
// WHY THE VERDICT LINE AND NOT A SUBCOMMAND: a gate that will tell you its conditions IF YOU ASK
// has the same defect, because nobody asks. Measured (CLAUDE.md hazard (h)): a ratchet run in a
// checkout 465 commits behind printed `60965 bytes (cap 61046) OK`, exit 0, with BOTH the file it
// measured and the cap it measured against already moved, and nothing in the output said so.

/**
 * PRIMARY CONTROL: core-normalised 1-minute loadavg at or above which a run is LABELLED loaded.
 * 1.0 means runnable work equals the core count — the standard reading of a saturated machine.
 *
 * PRIMARY rather than BACKSTOP because nothing else decides this: no second signal labels a run
 * loaded, and no wider gate catches a mislabelled one. It also GATES NOTHING — it changes a word
 * on a report, never a verdict — so the cost of it being slightly wrong is a reader who has to
 * read the two numbers printed beside it, which is why a round, conventional value is right here
 * and a measured one would be false precision.
 *
 * DATA, deliberately, and exported: the same treatment {@link HOST_CAUSED_SUITE_REDS} and
 * `PROOF_PAYLOAD_SHAPES` get, so moving this line is a data edit rather than an engine edit.
 */
export const LOADED_RUN_THRESHOLD = 1;

/**
 * One gate run's own context. RUN-SCOPED BY CONSTRUCTION — exactly one of these per run,
 * describing the RUN's conditions, never an individual assertion's contract. That boundary is
 * load-bearing: W1-T2811 owns EXPRESSION (a test declaring that its own bound is wall-clock
 * dependent) and would be wrongly closed as already-shipped if this grew a per-assertion surface.
 */
export interface RunContext {
  /** The head this run measured, or `"unknown"`. */
  headSha: string;
  /**
   * Commits this checkout is behind `origin/main`. `undefined` when it could not be computed —
   * NEVER 0, because 0 is the one value that means "you are up to date", and rendering an
   * unreadable comparison as 0 is hazard (h) recreated wearing this feature's own fix.
   */
  behindCount: number | undefined;
  /** Why {@link behindCount} is `undefined`, so the reader is told rather than left to guess. */
  behindUnknownReason: string | undefined;
  /**
   * When this checkout last FETCHED `origin/main`, from the reflog — NOT the tip commit's date.
   * The two differ by construction and diverge without bound: a checkout last fetched days ago
   * still shows a recent tip date, because the tip date tracks whatever main last did. Without
   * this, a behind-count computed against a stale ref reads exactly like a current one.
   */
  originFetchedAt: string | undefined;
  /** Core-normalised 1-minute loadavg at the START of the run; `undefined` when unavailable. */
  loadStart: number | undefined;
  /** The same reading at the END. Both, because one sample cannot answer both questions: a start
   *  sample decays (measured: [0.69, 2.37, 2.29] on 4 cpus moments after a heavy run stopped, so
   *  the 1-minute figure already read idle while the 5-minute one did not), and an end-only
   *  sample cannot separate "the machine was already busy" from "this gate WAS the load". */
  loadEnd: number | undefined;
  cpuCount: number;
}

/** `undefined` unless every element is a finite number and at least one is non-zero. An all-zero
 *  triple is what a platform without loadavg reports, and reading that as an idle machine is the
 *  same guessed-zero this module refuses everywhere else. */
export function normalisedLoad(loadavg: readonly number[] | undefined, cpuCount: number): number | undefined {
  if (!loadavg || loadavg.length < 3 || cpuCount <= 0) return undefined;
  if (!loadavg.every((n) => Number.isFinite(n))) return undefined;
  if (loadavg.every((n) => n === 0)) return undefined;
  return loadavg[0] / cpuCount;
}

/** The `origin/main@{<iso>}` selector a `git reflog show --format=%gd` line carries, or
 *  `undefined` on anything else — never a guessed timestamp. */
export function parseReflogFetchStamp(reflogText: string | undefined): string | undefined {
  if (reflogText === undefined) return undefined;
  const m = /@\{([^}]+)\}/.exec(reflogText.trim());
  return m ? m[1] : undefined;
}

/** PURE — same precedent as {@link computeHostFacts} and {@link buildPreflightSummary}: the caller
 *  owns every impure read, so a test drives every branch without a git tree or a busy machine. */
export function computeRunContext(input: {
  headSha: string;
  /** stdout of `git rev-list --count HEAD..origin/main`, or `undefined` when that read FAILED. */
  behindText: string | undefined;
  /**
   * What actually went wrong, when it did. CARRIED rather than assumed: the shallow-clone case is
   * the COMMON reason a behind-count is unreadable, but it is not the only one — a missing git, a
   * permission error and a corrupt ref all land here too, and naming the common case for all of
   * them is the same guess this module refuses everywhere else. `undefined` when the read
   * succeeded, or when the caller had no detail to give.
   */
  behindFailure?: string | undefined;
  /** stdout of `git reflog show --date=iso-strict --format=%gd -n 1 origin/main`, or undefined. */
  reflogText: string | undefined;
  loadavgStart: readonly number[] | undefined;
  loadavgEnd: readonly number[] | undefined;
  cpuCount: number;
}): RunContext {
  const trimmed = (input.behindText ?? "").trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
  return {
    headSha: input.headSha,
    behindCount: parsed,
    behindUnknownReason:
      parsed !== undefined
        ? undefined
        : input.behindFailure && input.behindFailure.trim() !== ""
          ? input.behindFailure.trim()
          : "no origin/main ref — shallow or unfetched clone",
    originFetchedAt: parseReflogFetchStamp(input.reflogText),
    loadStart: normalisedLoad(input.loadavgStart, input.cpuCount),
    loadEnd: normalisedLoad(input.loadavgEnd, input.cpuCount),
    cpuCount: input.cpuCount,
  };
}

/** The rendered stamp, appended to BOTH verdict branches. The PASSING one is the point: a stale
 *  red gets investigated anyway, while a stale GREEN is a confident wrong answer nobody questions
 *  — which is exactly the shape hazard (h) measured. */
export function runContextLine(ctx: RunContext): string {
  const behind =
    ctx.behindCount === undefined
      ? `behind=unknown (${ctx.behindUnknownReason ?? "unreadable"})`
      : `behind=${ctx.behindCount}`;
  const fetched =
    ctx.originFetchedAt === undefined
      ? "origin/main fetch age unknown"
      : `origin/main fetched ${ctx.originFetchedAt}`;
  const load =
    ctx.loadStart === undefined && ctx.loadEnd === undefined
      ? "load=unavailable"
      : `load=${fmtLoad(ctx.loadStart)}->${fmtLoad(ctx.loadEnd)} of ${ctx.cpuCount} cpu${
          isLoadedRun(ctx) ? " (LOADED)" : ""
        }`;
  return `context: sha=${ctx.headSha}, ${behind}, ${fetched}, ${load}`;
}

function fmtLoad(v: number | undefined): string {
  return v === undefined ? "?" : v.toFixed(2);
}

/** TRUE when either sample reached {@link LOADED_RUN_THRESHOLD}. EITHER, not both: a run that was
 *  loaded at any point could have produced a wall-clock red, and the stamp exists to make that
 *  red interpretable rather than to characterise the whole run precisely. */
export function isLoadedRun(ctx: RunContext): boolean {
  return (ctx.loadStart ?? 0) >= LOADED_RUN_THRESHOLD || (ctx.loadEnd ?? 0) >= LOADED_RUN_THRESHOLD;
}

/**
 * The impure edge. Reads git through the SAME injectable `PreflightSpawn` seam every other step in
 * this module uses (never a second spawn mechanism — `detectHostFacts`'s own rule), and the load
 * through injectable `loadavg`/`cpuCount` so a test drives the threshold without a busy machine.
 *
 * NEVER FETCHES. A local gate must not acquire a network dependency: `preflightSummaryPath`'s doc
 * already refuses `config.root` on the grounds that a preflight "meant to run anywhere must not
 * acquire that dependency", and a fetch would add a hang path to the one command every session is
 * told to run before its first push. The fetch AGE is reported instead; the reader decides.
 *
 * A NON-ZERO `status` IS THE UNKNOWN SIGNAL AND IS READ FROM THE SPAWN RESULT, never from a
 * pipeline. Measured while this was designed: `git rev-list --count HEAD..origin/main | head -2`
 * reports the PIPE's status, not git's, so the very invocation that had failed with 128 read as
 * success — which would render the unknown case as `behind=0`.
 */
export function detectRunContext(input: {
  repoRoot: string;
  headSha: string;
  spawn: PreflightSpawn;
  loadavgStart: readonly number[] | undefined;
  loadavgEnd: readonly number[] | undefined;
  cpuCount: number;
}): RunContext {
  // RECORDS, NEVER ERASES. A catch that returned the same `undefined` an empty read produces would
  // fold "the read failed" and "there was nothing to read" into one value — the erasure shape
  // `test/catch-erasure-ratchet.test.ts` exists to stop, and the reason this returns a tagged
  // union rather than a bare string. The detail it carries is what lets `behindUnknownReason`
  // report the OBSERVED cause instead of assuming the common one.
  const read = (args: string[]): { text: string } | { reason: string } => {
    try {
      const res = input.spawn("git", ["-C", input.repoRoot, ...args], { cwd: input.repoRoot });
      if (res.status === 0) return { text: res.stdout ?? "" };
      const stderr = (res.stderr ?? "").split("\n")[0]!.trim();
      return { reason: stderr !== "" ? stderr : `git exited ${res.status}` };
    } catch (e) {
      return { reason: String((e as Error)?.message ?? e) };
    }
  };
  const behind = read(["rev-list", "--count", "HEAD..origin/main"]);
  const reflog = read(["reflog", "show", "--date=iso-strict", "--format=%gd", "-n", "1", "origin/main"]);
  return computeRunContext({
    headSha: input.headSha,
    behindText: "text" in behind ? behind.text : undefined,
    behindFailure: "reason" in behind ? behind.reason : undefined,
    reflogText: "text" in reflog ? reflog.text : undefined,
    loadavgStart: input.loadavgStart,
    loadavgEnd: input.loadavgEnd,
    cpuCount: input.cpuCount,
  });
}

/** One of the census's six causes (the `recovery-drill` pair is its own entry, undiagnosed,
 *  per design (i) of the task record — named here rather than guessed at) — `count` and `file`
 *  are the MEASURED census figures, `appliesTo` is the cheap host-fact predicate that decides
 *  whether THIS host is expected to reproduce it. Never a test NAME: matching by name would
 *  need real `ci:test` output this module cannot capture (see the file comment above), and
 *  matching this coarsely is exactly why `appliesTo` reads host facts rather than guessing from
 *  the file alone — a diff-caused break in one of these files still reads as `ci:test`'s own
 *  loud, unaffected FAIL; nothing here ever inspects (or could inspect) which test actually
 *  failed. */
export interface HostCausedSuiteRedEntry {
  file: string;
  cause: string;
  count: number;
  note: string;
  appliesTo: (facts: HostFacts) => boolean;
}

export const HOST_CAUSED_SUITE_REDS: HostCausedSuiteRedEntry[] = [
  {
    file: "test/recycle-container.test.ts",
    cause: "bash-3.2-no-associative-arrays",
    count: 17,
    note: "deploy/recycle-container.sh:198 `declare -A CAPTURED=()` is bash-4 syntax; this host's /bin/bash has no associative-array support",
    appliesTo: (f) => f.bashMajorVersion !== undefined && f.bashMajorVersion < 4,
  },
  // ── W1-T2776: SEVEN MORE FILES IN THE SAME CLUSTER, all measured 2026-09-03 on the mini ──────
  // The entry above is not the whole cluster and never was. `deploy/recycle-container.sh` is the
  // repo's ONLY bash-4-only script (`declare -A`), and TEN tracked tests reference it in code;
  // the eight that spawn it through the PATH `bash` — which is 3.2 on darwin — all red, and the
  // registry named exactly one of them. The remaining two spawn it through a version-resolved
  // binary (`test/container-config-mount.test.ts`'s `BASH_BIN`) or never spawn it at all, and
  // both measure `# fail 0`; they are deliberately NOT registered, because an entry for a file
  // that does not fail would let a real break there read as expected.
  //
  // Each `count` below is a MEASURED `# fail` from running that one file on this host at this
  // sha, not a guess or a share of a total. The scope widening past the single file the shard's
  // note named is forced by, and validated against, the discovery test in
  // `test/host-parity-azure-pole.test.ts`: its predicate agrees with the measured pass/fail set
  // on all ten files, so registering fewer would ship a test that reds on main.
  //
  // ONE FIGURE DELIBERATELY LEFT ALONE. `test/recycle-container.test.ts` measures `# fail 18`
  // today against the 17 the entry above carries — the file gained a test since the W1-T2234
  // census. That figure is NOT corrected here: the count table in
  // `test/host-caused-suite-reds.test.ts` exists to stop exactly this number being silently
  // rebased, and the drift errs in the SAFE direction (a registry that under-counts leaves one
  // red unexplained and loud; one that over-counts absorbs a real failure). Filed as an
  // observation rather than fixed in passing.
  {
    file: "test/a-lock-whose-container-is-gone-is-reclaimed-not-waited-on.test.ts",
    cause: "bash-3.2-no-associative-arrays",
    count: 8,
    note: "spawns deploy/recycle-container.sh via the PATH `bash`; same `declare -A` refusal and same error text as test/recycle-container.test.ts — measured 8 of 9",
    appliesTo: (f) => f.bashMajorVersion !== undefined && f.bashMajorVersion < 4,
  },
  {
    file: "test/a-recycle-refuses-a-state-dir-that-is-not-a-checkout.test.ts",
    cause: "bash-3.2-no-associative-arrays",
    count: 5,
    note: "same script, same PATH `bash`, same refusal — measured 5",
    appliesTo: (f) => f.bashMajorVersion !== undefined && f.bashMajorVersion < 4,
  },
  {
    file: "test/app-auth-satisfies-the-recycle-credential-refusal.test.ts",
    cause: "bash-3.2-no-associative-arrays",
    count: 6,
    note: "same script, same PATH `bash`, same refusal — measured 6 of 6 (every test in the file)",
    appliesTo: (f) => f.bashMajorVersion !== undefined && f.bashMajorVersion < 4,
  },
  {
    file: "test/daemon-default-credential.test.ts",
    cause: "bash-3.2-no-associative-arrays",
    count: 1,
    note: "only its one spawning test reds; its readFileSync source-assertions over the same script pass — measured 1",
    appliesTo: (f) => f.bashMajorVersion !== undefined && f.bashMajorVersion < 4,
  },
  {
    file: "test/recycle-capture-falls-back-to-the-shell.test.ts",
    cause: "bash-3.2-no-associative-arrays",
    count: 3,
    note: "same script, same PATH `bash`, same refusal — measured 3",
    appliesTo: (f) => f.bashMajorVersion !== undefined && f.bashMajorVersion < 4,
  },
  {
    file: "test/the-recovery-path-merges-into-a-shared-checkout.test.ts",
    cause: "bash-3.2-no-associative-arrays",
    count: 8,
    note: "same script, same PATH `bash`, same refusal — measured 8",
    appliesTo: (f) => f.bashMajorVersion !== undefined && f.bashMajorVersion < 4,
  },
  {
    file: "test/the-recycle-wait-is-sized-under-the-run-it-waits-on.test.ts",
    cause: "bash-3.2-no-associative-arrays",
    count: 5,
    note: "same script, same PATH `bash`, same refusal — measured 5",
    appliesTo: (f) => f.bashMajorVersion !== undefined && f.bashMajorVersion < 4,
  },
  {
    file: "test/worker-credential-preflight.test.ts",
    cause: "darwin-keychain-unprovisioned",
    count: 2,
    note: "ensureWorkerKeychain refuses headlessly on an unprovisioned darwin keychain — correct (W1-T235), not a defect",
    appliesTo: (f) => f.platform === "darwin",
  },
  {
    file: "test/fleet-heartbeat.test.ts",
    cause: "bsd-date-control-arm",
    count: 2,
    note: "the test's GNU control arm inherits this host's real `date`, which is BSD on darwin, so the control is not a control",
    appliesTo: (f) => f.platform === "darwin",
  },
  {
    file: "test/fleet-heartbeat-supervisor-tick.test.ts",
    cause: "bsd-date-control-arm",
    count: 1,
    // THE PATH, NOT THE FLAG — the step that actually dies. The FIXED_NOW_DATE stub execs
    // `/usr/bin/date`, and on macOS that path DOES NOT EXIST (date ships at /bin/date), so the
    // exec fails 127 before `-d` is ever parsed. `-d` being a GNU extension is a real second
    // darwin fact and the one the sibling entry above is worded around, but it is not what bites
    // here; naming it would send the next reader to flag compatibility instead of to the path.
    note: "the FIXED_NOW_DATE stub execs /usr/bin/date, which does not exist on darwin (date is /bin/date), so the exec dies before `-d` is parsed",
    appliesTo: (f) => f.platform === "darwin",
  },
  {
    file: "test/recovery-drill.test.ts",
    cause: "undiagnosed-ps-orphan-sweep",
    count: 2,
    note: "UNDIAGNOSED — carried from the census, not re-derived here (W1-T2234 design i); named honestly rather than guessed at",
    appliesTo: (f) => f.platform === "darwin",
  },
  {
    file: "test/dispatch-memory-governor.test.ts",
    cause: "linux-procfs-absent",
    count: 1,
    note: "the probe's cgroup-limit read expects /proc/meminfo, which does not exist on darwin — a platform fact, not a defect",
    appliesTo: (f) => !f.hasProcMeminfo,
  },
  {
    file: "test/proof-spawner-env-isolation.test.ts",
    cause: "macos-corefoundation-env-leak",
    count: 1,
    note: "macOS injects __CF_USER_TEXT_ENCODING into every child env below Node's own env; no allowlist can keep it out",
    appliesTo: (f) => f.platform === "darwin",
  },
  {
    file: "test/worker.test.ts",
    cause: "w1-t2205-e2e-darwin-keychain-asymmetry",
    count: 1,
    note: "the e2e's CLAUDE_CODE_OAUTH_TOKEN determinism bypass (worker-home.ts) exists only on non-darwin; darwin has no token bypass at all",
    appliesTo: (f) => f.platform === "darwin",
  },
  {
    // W1-T2770: `test/merge-lcov.test.ts`'s six coverage-merge-CLI tests call
    // `scripts/coverage-merge-ratchet.mjs` with `--expose-internals`, and its
    // `assertPinnedNodeVersion` throws `raw coverage merge requires the repository-pinned Node
    // <.nvmrc>; running <process.versions.node>` on ANY string-mismatch — the tests catch that
    // throw and read it as their own failure. The cause is not the diff, and it is not the pin
    // being wrong; it is that Node's built-in test-runner coverage internals moved between
    // patch versions and this ratchet reaches into them, so a rebuild whose base tag
    // (`node:22-bookworm-slim`) resolved to a newer 22.x than `.nvmrc` produces this exact
    // six-test bloom until either the pin advances or the image is aligned to it. THE FIX IS
    // IMAGE-SIDE: pin `deploy/Dockerfile`'s FROM to the exact `.nvmrc` version, and dispatch
    // `.github/workflows/acr-build.yml`. Until it lands this cluster keeps a diff-caused break
    // in these files from reading as this cluster instead — the cluster's `appliesTo` self-
    // expires the moment the running Node matches the pin, so there is no window in which real
    // failures here are suppressed. The image is 30 commits behind at time of writing but zero
    // of those touch `deploy/Dockerfile`; 22.23.2 arrived through the floating base tag with
    // no edit to any file, which is why "an unrelated rebuild can move Node silently" belongs
    // in the filing itself.
    file: "test/merge-lcov.test.ts",
    cause: "node-version-drift-from-pin",
    count: 6,
    note: "scripts/coverage-merge-ratchet.mjs's assertPinnedNodeVersion throws when process.versions.node !== .nvmrc string — same shape whether Node is ahead or behind the pin",
    appliesTo: (f) =>
      // W1-T2770: A guarded self-expiring predicate. Every clause must be true for the cluster
      // to apply, and any one absent/matching turns it off silently — the mirror of
      // bashMajorVersion's undefined-does-not-apply discipline above.
      //
      // (a) The RUNNING Node was read (`process.versions.node` never returns an empty string in
      //     practice, but the field's type admits a bare read failure — never trust it blindly).
      // (b) The pinned Node was READABLE. A missing `.nvmrc` is `pinnedNodeVersion === undefined`
      //     — treat that as "cannot tell", not as "matches". `!!` narrows the type from
      //     `string | undefined` to `string` for the compare below without duplicating the
      //     check; TypeScript reads the truthy pass-through as narrowing.
      // (c) They DIFFER. The failure is an exact string mismatch, so the appliesTo check is
      //     the same exact string mismatch — no numeric-range guess, no "close enough".
      //
      // THIS IS THE SELF-EXPIRY MECHANISM. The moment the image lands at .nvmrc's version, (c)
      // becomes false and the cluster stops applying with no follow-up edit here — a cluster
      // that outlives its cause is a permanent suppression of six working tests, which reads
      // exactly like six tests that broke. The design comment at the top of this file inviting
      // readers to "subtract them" is what makes that suppression harmful; the guard here is
      // what stops it from being possible.
      Boolean(f.nodeVersion) && Boolean(f.pinnedNodeVersion) && f.nodeVersion !== f.pinnedNodeVersion,
  },
];

/** The subset of {@link HOST_CAUSED_SUITE_REDS} this host's `facts` predict. */
export function hostCausedSuiteRedsForFacts(facts: HostFacts): HostCausedSuiteRedEntry[] {
  return HOST_CAUSED_SUITE_REDS.filter((e) => e.appliesTo(facts));
}

/** Builds the `ci:host-caused-suite-reds` leaf — ALWAYS `ok: true` (design: informational, not
 *  a verdict; see the file comment above for why this table must never gate a merge on a host
 *  fact) and always names, by file/cause/count, exactly which registered clusters this host is
 *  expected to produce, so a reader of `ci:test`'s FAIL can subtract them and know the rest is
 *  the diff's own — loudly, by omission: anything `ci:test` failed on that is not named here is
 *  necessarily new or diff-caused. */
export function hostCausedSuiteRedsStep(facts: HostFacts): CiParityLeafResult {
  const applicable = hostCausedSuiteRedsForFacts(facts);
  const factsLine = `platform=${facts.platform}, bash-major=${facts.bashMajorVersion ?? "unknown"}, /proc/meminfo=${facts.hasProcMeminfo}`;
  if (applicable.length === 0) {
    return {
      ok: true,
      detail:
        `PASS — 0 of ${HOST_CAUSED_SUITE_REDS.length} known host-caused suite-red cluster(s) apply on this host (${factsLine}); ` +
        "any ci:test failure here is this diff's own",
    };
  }
  const total = applicable.reduce((sum, e) => sum + e.count, 0);
  const lines = applicable.map((e) => `  - ${e.file} — ${e.cause} (~${e.count} test(s)): ${e.note}`);
  return {
    ok: true,
    detail:
      `PASS — ${applicable.length} of ${HOST_CAUSED_SUITE_REDS.length} known host-caused suite-red cluster(s) apply on this host (${factsLine}), ` +
      `~${total} red(s) attributable to the machine, not this diff:\n${lines.join("\n")}\n` +
      "any ci:test failure NOT matching one of these clusters is this diff's own and must be treated as blocking (W1-T2234)",
  };
}

/**
 * `CI_PARITY_TABLE` — one entry per .github/workflows/ci.yml job.
 * `runCiParity`'s drift step fails the moment `parseCiJobNames` finds a job this table does not
 * name at all; a listed `mirrored: false` job is a considered, reasoned exclusion, not a gap.
 */
export const CI_PARITY_TABLE: CiParityEntry[] = [
  { job: "ci-required", mirrored: false, reason: "GitHub-only stable-name aggregator; the ci entry below runs the equivalent complete test surface locally" },
  {
    job: "ci",
    mirrored: true,
    run: (repoRoot, spawn) => [
      runStep("ci:typecheck", () => {
        const step = typecheckStep(repoRoot, spawn);
        return { ok: step.ok, detail: step.detail.replace(/^typecheck: /, "") };
      }),
      // W1-T373: cli-reference:check is the "ci" job's own gate on docs/cli-reference.md
      // staleness (test/cli-reference.test.ts, run as part of `npm run test:ci` below) — but
      // buried inside that full-suite step it surfaces only as a numbered TAP line (#1352's
      // `not ok 449 - generate-cli-reference --check`), never as a named parity step. This is
      // the parity fix (design v): give it its OWN step here, one list, one truth, rather than
      // leaving it discoverable only by reading ci:test's raw output.
      runStep("ci:cli-reference-check", () => shellOut(spawn, "npm run --silent cli-reference:check", "npm", ["run", "--silent", "cli-reference:check"], { cwd: repoRoot })),
      // `stream: true` — this is the multi-minute step, and the one that produced an HOUR of
      // total silence in a container. `npm run test:ci` routes through scripts/test-with-retry.mjs,
      // which ALREADY tees (`stdio: ["inherit","pipe","pipe"]`, writing each chunk to
      // process.stdout while accumulating it); the only thing swallowing that stream was this
      // process capturing it. Its `FLAKE-RETRY:` line — the record that a second full pass began —
      // was invisible for the same reason.
      runStep("ci:test", () => shellOut(spawn, "npm run test:ci", "npm", ["run", "test:ci"], { cwd: repoRoot, stream: true })),
      // W1-T2234: named separately from ci:test, never gating it — see the file comment above
      // "ci:host-caused-suite-reds". ci:test's own command/argv/stream mode are untouched by
      // this entry; it only ADDS a report of which known clusters this host is expected to
      // produce, so a red ci:test on a non-CI host can be told apart from this diff's own.
      runStep("ci:host-caused-suite-reds", () => hostCausedSuiteRedsStep(detectHostFacts(repoRoot, spawn))),
    ],
  },
  {
    job: "commitlint",
    mirrored: false,
    reason:
      "this job lints the SQUASH-MERGE PR TITLE (github.event.pull_request.title), which does not exist until the PR is opened; " +
      "rmd preflight's default (no-flag) route already lints the commit-range header/body shape locally via the commitlint and " +
      "emitter-checks steps, which is the closest local proxy available pre-push",
  },
  {
    job: "leak-grep",
    mirrored: true,
    run: (repoRoot, spawn) => [
      runStep("leak-grep", () => shellOut(spawn, "bash .github/scripts/leak-grep.sh", "bash", [join(repoRoot, ".github", "scripts", "leak-grep.sh")], { cwd: repoRoot })),
    ],
  },
  { job: "coverage-ratchet-required", mirrored: false, reason: "GitHub-only LCOV artifact aggregator; the coverage-ratchet entry below evaluates the equivalent complete surface locally" },
  {
    job: "coverage-ratchet",
    mirrored: true,
    run: (repoRoot, spawn) => {
      const lcovPath = join(repoRoot, "coverage", "lcov.info");
      const refresh = runStep("coverage-ratchet:base-refresh", () => refreshOriginMain(repoRoot, spawn));
      const test = runStep("coverage-ratchet:test-with-coverage", () => testWithCoverageLeaf(repoRoot, spawn, lcovPath));
      const ratchet = runStep("coverage-ratchet:ratchet", () =>
        shellOut(spawn, "coverage-ratchet.mjs", process.execPath, [join(repoRoot, "scripts", "coverage-ratchet.mjs"), "--lcov", lcovPath, "--baseline", join(repoRoot, "scripts", "coverage-baseline.json")], {
          cwd: repoRoot,
        }),
      );
      const diffCoverage = runStep("coverage-ratchet:diff-coverage", () => {
        const diffText = mergeBaseDiffText(repoRoot, spawn);
        return shellOut(spawn, "diff-coverage.mjs (origin/main...HEAD, refreshed base)", process.execPath, [join(repoRoot, "scripts", "diff-coverage.mjs"), "--lcov", lcovPath], {
          cwd: repoRoot,
          input: diffText,
        });
      });
      return [refresh, test, ratchet, diffCoverage];
    },
  },
  {
    job: "mutation-ratchet",
    mirrored: true,
    run: (repoRoot, spawn) =>
      runTriggerScopedJob(
        "mutation-ratchet:trigger",
        spawn,
        process.execPath,
        [join(repoRoot, "scripts", "mutation-ratchet.mjs"), "--changed-files", changedFilesListPath(repoRoot, spawn)],
        { cwd: repoRoot },
        () => [
          runStep("mutation-ratchet:stryker", () => shellOut(spawn, "npx stryker run", join(repoRoot, "node_modules", ".bin", "stryker"), ["run"], { cwd: repoRoot })),
          runStep("mutation-ratchet:ratchet", () =>
            shellOut(
              spawn,
              "mutation-ratchet.mjs --report",
              process.execPath,
              [join(repoRoot, "scripts", "mutation-ratchet.mjs"), "--report", join(repoRoot, "reports", "mutation", "mutation.json"), "--baseline", join(repoRoot, "scripts", "mutation-baseline.json")],
              { cwd: repoRoot },
            ),
          ),
        ],
      ),
  },
  npmScriptEntry("learnings-budget-ratchet", "learnings-budget-ratchet"),
  npmScriptEntry("jscpd-gate", "jscpd"),
  npmScriptEntry("claims", "claims"),
  {
    job: "lint-plan",
    mirrored: true,
    run: (repoRoot, spawn) => {
      const refresh = runStep("lint-plan:base-refresh", () => refreshOriginMain(repoRoot, spawn));
      const baseRes = spawn("git", ["rev-parse", "origin/main"], { cwd: repoRoot });
      const base = baseRes.stdout.trim() || "origin/main";
      const lint = runStep("lint-plan:ci-parity", () =>
        shellOut(spawn, "npm run --silent lint-plan -- --base <refreshed origin/main>", "npm", ["run", "--silent", "lint-plan", "--", "--base", base], { cwd: repoRoot }),
      );
      return [refresh, lint];
    },
  },
  // W1-T1051: the assertion-discrimination gate is a deterministic npm-script gate that reads only
  // the checked-out tree — the test sources plus the files their assertions name — so it needs no
  // PR-specific input and mirrors exactly, the same class as the entries around it.
  npmScriptEntry("assertion-discrimination", "assertion-discrimination"),
  npmScriptEntry("depcruise", "depcruise"),
  {
    job: "containment-probe",
    mirrored: true,
    run: (repoRoot, spawn) =>
      runTriggerScopedJob(
        "containment-probe:trigger",
        spawn,
        process.execPath,
        ["--import", "tsx", join(repoRoot, ".github", "scripts", "containment-diff-trigger.ts"), changedFilesListPath(repoRoot, spawn)],
        { cwd: repoRoot },
        () => [
          runStep("containment-probe:test", () =>
            shellOut(
              spawn,
              "node --test --import tsx --import ./test/setup/tmp-hygiene.ts test/containment.test.ts",
              process.execPath,
              ["--test", "--import", "tsx", "--import", TMP_HYGIENE_IMPORT, join(repoRoot, "test", "containment.test.ts")],
              { cwd: repoRoot },
            ),
          ),
        ],
      ),
  },
  npmScriptEntry("api-client-drift", "api-client:check"),
  npmScriptEntry("no-hand-rolled-fetch", "no-hand-rolled-fetch:check"),
  // W1-T1048: the task-id existence gate is exactly the shared npm-script shape — deterministic,
  // unconditional on every PR, and measured at ~1.1s, so it is mirrored rather than excluded.
  npmScriptEntry("task-id-existence", "task-id-existence:check"),
];
export interface CiParityDeps {
  spawn?: PreflightSpawn;
  /** Test seam for the drift check — production reads the real ci.yml off disk. */
  ciYamlText?: string;
}

export interface CiParityResult {
  steps: CiParityStepResult[];
  ok: boolean;
}

/**
 * `rmd preflight --ci-parity`'s engine. Prepends a `ci-parity:drift` step (red the moment
 * ci.yml names a job this table doesn't) to one or more named steps per `CI_PARITY_TABLE`
 * entry, running EVERY entry regardless of an earlier one's outcome — same independent-step
 * discipline as {@link import("./commit-message.js").runPreflight}. `ok` is the AND of every
 * step; a caller prints every `detail` unconditionally and exits non-zero only once every step
 * has had the chance to report.
 */
export function runCiParity(repoRoot: string, deps: CiParityDeps = {}): CiParityResult {
  const spawn = deps.spawn ?? defaultPreflightSpawn;
  const ciYamlText = deps.ciYamlText ?? readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const ciJobs = parseCiJobNames(ciYamlText);
  const tableJobs = new Set(CI_PARITY_TABLE.map((e) => e.job));
  const missing = ciJobs.filter((j) => !tableJobs.has(j));
  const driftStep: CiParityStepResult = {
    name: "ci-parity:drift",
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `ci-parity:drift: PASS — every ci.yml job (${ciJobs.length}) has a parity entry (mirrored or excluded-with-reason)`
        : `ci-parity:drift: FAIL — ci.yml job(s) with no parity entry: ${missing.join(", ")}`,
  };

  const jobSteps = CI_PARITY_TABLE.flatMap((entry): CiParityStepResult[] => {
    if (!entry.mirrored) return [excludedStep(entry.job, entry.reason ?? "no reason recorded")];
    try {
      return entry.run!(repoRoot, spawn);
    } catch (e) {
      return [toolchainFailure(`${entry.job}:error`, e)];
    }
  });

  const steps = [driftStep, ...jobSteps];
  return { steps, ok: steps.every((s) => s.ok) };
}

// ── `rmd preflight --fast` (W1-T373) — deterministic npm-script gates, nothing else ──────────
//
// THE GAP THIS CLOSES. `--ci-parity`'s `ci` job entry shells `npm run test:ci`, the FULL
// `test/**/*.test.ts` glob — so the only way to reach a two-second check like `claims`, or the
// now-added `ci:cli-reference-check` above, is to run everything else too. `--ci-parity` cannot
// be run habitually (test/mounts-wiring.test.ts alone has MEASURED $1.42 of real worker spend
// per run of that suite); a mode that cannot be run habitually does not make its cheap checks
// reachable. This is a THIRD, ADDITIVE mode on the same `preflight` verb (never a second verb,
// following `--ci-parity`'s own precedent): it runs ONLY the curated list below.
//
// THE CURATION CRITERION (design ii) — stated here because `FAST_GATE_STEPS` below IS its
// enforcement, not a preference next to it. A step qualifies ONLY if it is deterministic, runs
// in seconds, and has demonstrably blocked a PR (or is the identical shape as one that has).
// Ordinarily it also needs no network. W1-T2734 is the explicit exception: its source-size signal
// refreshes origin/main so the merge-base measurement cannot silently use a stale ref; it makes
// no other network call, and inability to refresh is reported as a measurement failure.
// `required-core` marks the two steps #1352 itself was blocked by; `same-class` marks the rest,
// admitted because each is the identical shape (a deterministic npm-script gate CI runs
// unconditionally) and costs well under half a second.
//
// WHAT THIS MUST NOT BECOME (design iii): `npm test`. Growing this list to include a step whose
// OWN command is the full `test/**/*.test.ts` glob (`npm run test:ci`, a bare `npm test`) is the
// ONE mistake this mode exists to prevent — it would make the fast mode the expensive mode
// wearing a cheaper name, and the habit it exists to create unaffordable. `runPreflightFast`
// below never shells `npm run test:ci` (or any bare `npm test`) — it only ever invokes
// `npm run --silent <script>` for a script named in `FAST_GATE_STEPS`, and every such script
// runs AT MOST one named file, never a glob.
//
// ── W1-T2478: THE CENSUS CLASS, ADMITTED UNDER A MEASURED BOUND, NOT EXCLUDED BY MECHANISM ────
//
// THE PROXY THIS REPLACES. Design (iii) used to read "never spawns `node --test`" — a MECHANISM
// proxy for the real concern (cost), and wrong for exactly one class: a CENSUS SUITE (a pure
// source scan over `src/**` plus a written baseline/exemption table — structurally identical to
// `claims`/`jscpd`/`depcruise` above, which this mode already runs) differs from those only in
// which test runner it happens to have been authored in. `test/bound-kind-declared.test.ts`
// blocked #3304 on a single undeclared bound-shaped constant, with a clean fast run immediately
// before it — the fast gate could not see the one suite built to catch exactly that shape.
//
// THE BOUND IS THE PRIMARY CONTROL THAT REPLACES IT. `boundMs` below (present ONLY on the four
// census entries this task adds) is a measured wall-clock ceiling: `runPreflightFast` times each
// such step's OWN `npm run --silent <script>` invocation and refuses it — `BOUND EXCEEDED`, named,
// never a bare non-zero exit — the moment it runs over `boundMs`, REGARDLESS of whether the
// script itself would have exited zero. This is a PRIMARY CONTROL, not a backstop (W1-T1266's own
// distinction): it decides admission on THIS ordinary run, before anything has failed, the same
// way a speed limit governs every trip rather than only the one after a crash. It replaces the
// mechanism proxy with the cost bound the proxy was always standing in for — a step is admitted
// because it is CHEAP on THIS run, never because of which runner authored it, and refused by that
// same measurement, never by a written exception naming it.
//
// WHY ONLY THESE FOUR, STATED AS A PREDICATE SO THE LIST CANNOT DRIFT. A census entry qualifies
// iff it (a) walks the tracked `src/` population via `git ls-files`, (b) asserts something about
// EVERY file it walks, (c) carries a baseline/exemption table so only NEW violations bite, and
// (d) measures comfortably under `boundMs` when run alone. `test/bound-kind-declared.test.ts`,
// `test/catch-erasure-ratchet.test.ts`, `test/negative-reachability-ratchet.test.ts` and
// `test/no-shallowing-of-the-canonical-checkout.test.ts` each satisfy all four and are wired
// through their own `census:*` npm script (package.json) — one `node --test` invocation of that
// ONE file, never the suite glob. A suite that fits shape (a)-(c) but fails (d) is not added here
// and is not exempted either — it stays out until it is made cheaper or its own cost is argued
// separately (out of scope for this task), refused by the same predicate a future entry would be.
//
// `boundMs` is `undefined` on the seven pre-existing entries below — this task does not re-audit
// them. Each already states its OWN admission basis in its own `reason` (an explicit measured
// time for `same-class`, or a demonstrated PR block for `required-core`, e.g. `claims`, whose
// assertions shell out per-claim and cost seconds, not the sub-second `boundMs` governs) and nothing
// here changes how any of the seven runs or is judged.
//
// W1-T2643 — THE PREDICATE ABOVE IS NOW ENFORCED, NOT JUST STATED. `CENSUS_POPULATION` below is
// the enumerated set every test file the recognizer (`discoverSrcFilteredLsFilesCallers`, shared
// with W1-T2523's `censusSuiteMembershipFor` — one recognizer, never a second) finds census-shaped
// gets exactly one entry in, carrying a verdict: ADMITTED, REFUSED for cost (a re-measured number),
// or REFUSED for failing (a)/(b)/(c) outright (named). The four `boundMs` entries below are no
// longer hand-written here — they are `CENSUS_ADMITTED_MEMBERS`'s own projection, so a hand-added
// census step with no population member, or an admitted population member missing its step, is
// impossible rather than merely discouraged.

/** THE PRIMARY CONTROL (W1-T2478): the measured wall-clock ceiling every census entry's own
 *  `npm run --silent <script>` invocation is timed against in {@link runPreflightFast}. 2000ms
 *  because every census suite this task admits measures well under it alone, and the number is
 *  the enforcement — not a documented figure a step is separately trusted to honour, but the
 *  literal value `runPreflightFast` compares an actual `Date.now()` delta against on every run. */
export const FAST_GATE_CENSUS_BOUND_MS = 2000;

/**
 * W1-T2545 — THE BOUND ABOVE IS NOW THE *SOFT* ONE, AND THE REFUSAL IS RELATIVE.
 *
 * WHY THE ABSOLUTE CEILING COULD NOT HOLD. A census entry qualifies for this gate precisely
 * BECAUSE it walks the tracked `src/` population and asserts over every file in it — so its cost
 * is a monotonic function of a corpus that only grows. A fixed millisecond ceiling against a
 * monotonically growing cost is a gate that ejects its own entries over time, and ejection is
 * silent in the direction that matters: `runPreflightFast` refused the step, so the fast gate
 * stopped running a census suite CI still enforces — restoring exactly the blindness W1-T2478
 * existed to close. MEASURED at origin/main 05dcb050, `rmd preflight --fast` on a clean tree:
 * `negative-reachability-census: BOUND EXCEEDED — took 2509ms`, own result "would have PASSed",
 * with the whole gate reporting FAIL. On GitHub runners the same entry measured 2268ms and
 * 2250ms while main's own `ci` passed, so the distribution STRADDLED the ceiling: a coin flip
 * per run, decided by runner speed rather than by anything about the tree.
 *
 * THAT LAST OBSERVATION IS THE FIX. A wall-clock number conflates two things — how much work the
 * suite does, and how fast the machine is — and only the first is a property of the repo. So the
 * refusal is now measured against the SAME RUN's own cheapest census entry: a slow machine slows
 * every entry together, leaving the ratio stable, while a suite genuinely doing far more work
 * than its siblings stands out on any machine. The bound is derived from the measured population
 * rather than written down, which is what keeps it from being outgrown.
 *
 * THE SOFT BOUND STILL EARNS ITS KEEP: an entry over it is REPORTED, with its cost, so growth is
 * visible long before it is refused — the warning the absolute ceiling could only deliver by
 * failing the gate.
 */

/** The same-run reference is floored here, so an unusually cheap entry cannot make the ratio
 *  harsh for its siblings — with one very fast census suite, 4x its cost is not a meaningful
 *  ceiling for a suite that legitimately walks more. */
export const FAST_GATE_CENSUS_REFERENCE_FLOOR_MS = 1000;

/** How many times the same run's cheapest census entry an entry may cost before it is refused as
 *  RUNAWAY. Sized against the measured spread (2026-08-31, one container: 960 / 1128 / 2344 /
 *  2615ms — a 2.7x spread across four healthy entries), so a merely-grown suite passes and one
 *  doing several times the work of its cheapest sibling does not. */
export const FAST_GATE_CENSUS_RUNAWAY_MULTIPLE = 4;

/**
 * The refusal threshold for THIS run, derived from the census durations THIS run measured.
 * Returns `undefined` when no census entry ran — there is no population to derive a bound from,
 * and inventing one would be the constant this task is removing.
 */
export function censusRunawayThresholdMs(durationsMs: readonly number[]): number | undefined {
  if (durationsMs.length === 0) return undefined;
  const reference = Math.max(FAST_GATE_CENSUS_REFERENCE_FLOOR_MS, Math.min(...durationsMs));
  return reference * FAST_GATE_CENSUS_RUNAWAY_MULTIPLE;
}

// ── W1-T2643: THE CENSUS POPULATION IS AN ENUMERATED SET WITH A VERDICT, NEVER A COMMENT ───────
//
// THE GAP THIS CLOSES. Before this task the four `boundMs` entries below were the ONLY artifact
// recording census-class admission, and the one refusal anyone had actually made —
// `test/enforcement-data-carveout.test.ts`, named in test/fast-gate-admits-the-census-class.test.ts's
// own header as "measured ~2.1s alone... deliberately NOT added" — existed ONLY as prose in that
// comment, never as a structured artifact a later reader (or a test) can check. A refusal stated
// in prose and evidenced nowhere is indistinguishable from a suite nobody remembered.
//
// `CENSUS_POPULATION` is that artifact. Every file `discoverSrcFilteredLsFilesCallers` (below —
// the SAME recognizer W1-T2523 already shipped as part of `censusSuiteMembershipFor`, reused
// rather than re-derived: "ONE CENSUS PREDICATE, NEVER TWO") finds — every `test/*.test.ts` file
// mentioning `ls-files` whose own text also filters on `src/` — gets exactly one entry, carrying
// a verdict:
//   ADMITTED         — present in FAST_GATE_STEPS with boundMs, via the projection below (never
//                       hand-added there directly)
//   REFUSED, cost     — satisfies (a)-(c) but its own solo `node --test <file>` run measured over
//                       FAST_GATE_CENSUS_BOUND_MS; the reason is the NUMBER, dated and reproducible
//   REFUSED, predicate — does not actually satisfy the predicate; names WHICH of (a)/(b)/(c) fails
//                       and why, so "considered and excluded" is never confused with "never looked at"
//
// RE-MEASURED, NOT COPIED (design mandate — distrust the prompt over the installed version,
// standing rule 7). Every `measuredMs` below was run at this task's own HEAD, 2026-09-04:
// `node --test --import tsx --import ./test/setup/tmp-hygiene.ts <file>`, alone, three times, the
// median kept. None of W1-T2478's filing-time numbers, nor this task's OWN filing rationale's
// numbers, are reused — re-run the same command against the same file to re-derive or refute any
// entry below.
//
// ONLY ONE REFUSED-FOR-COST MEMBER WAS FOUND, AND THAT IS REPORTED RATHER THAN PADDED TO TWO.
// This task's filing rationale — drafted from W1-T2478's PRE-implementation filing text, by its
// own admission ("HONEST LIMITS OF THIS FILING") — describes a "sixth" suite at 6371ms distinct
// from a "fifth" at ~2.1s. W1-T2478's own SHIPPED artifact (the test header above, and PR #3323's
// own body) names only ONE excluded suite. This task's own re-application of the predicate against
// every recognizer candidate in the CURRENT tree (24 at this task's own HEAD, 25 after W1-T2644
// below adds its own proof file, which the recognizer's text-substring heuristic also
// self-matches — see that task's own section) finds no second suite satisfying (a)-(c) — the
// closest calls, `test/mkdtemp-callsite-check.test.ts` and
// `test/state-citation-check.test.ts`, each delegate their real per-file walk to an external
// script and assert only its aggregate "clean" exit from the `.test.ts` file itself, the same
// shape `claims`/`jscpd` already have as ordinary `same-class` entries, never the census's own
// in-file per-item loop. Re-measured here, `enforcement-data-carveout.test.ts` alone costs
// 3686-3769ms across three runs (this sandbox is slower than either prior measurement) —
// consistent with ONE suite whose cost is a property of the tree AND the machine it runs on, not
// with two distinct suites. The DRIFT GUARD below (`censusPopulationDrift`) is what makes this
// claim checkable rather than asserted: if a real second census-shaped suite exists, or one is
// added later, the recognizer surfaces it and it is UNKNOWN until this population is updated —
// never silently absorbed into "no change needed".

/** Which clause of the census predicate (WHY ONLY THESE FOUR, above) a candidate fails, for a
 *  member REFUSED on the predicate itself rather than on cost. */
export type CensusPredicateClause = "a" | "b" | "c";

export type CensusVerdict =
  | { readonly status: "ADMITTED"; readonly measuredMs: number }
  | {
      readonly status: "REFUSED";
      readonly reason: { readonly kind: "cost"; readonly measuredMs: number; readonly detail: string };
    }
  | {
      readonly status: "REFUSED";
      readonly reason: { readonly kind: "predicate"; readonly clause: CensusPredicateClause; readonly detail: string };
    };

/** One test file the census recognizer finds, carrying its verdict. `job`/`script`/`walks` are
 *  only meaningful for an ADMITTED member — they are what {@link FAST_GATE_STEPS}'s census
 *  section, and {@link KNOWN_CENSUS_SUITES}, are DERIVED from, never hand-duplicated onto. */
export interface CensusPopulationMember {
  readonly testFile: string;
  readonly job: string;
  readonly script?: string;
  readonly walks?: readonly string[];
  readonly reason: string;
  readonly verdict: CensusVerdict;
}

/** Job-name slug for a REFUSED member — never used for an ADMITTED entry, whose `job` names the
 *  real FAST_GATE_STEPS step it projects into. */
function censusJobSlug(testFile: string): string {
  return `${testFile.replace(/^test\//, "").replace(/\.test\.ts$/, "")}-census`;
}

/** A population member refused for failing the predicate itself, never for cost — `clause` names
 *  WHICH of (a)/(b)/(c) it fails first. */
function refusedForPredicate(testFile: string, clause: CensusPredicateClause, detail: string): CensusPopulationMember {
  return {
    testFile,
    job: censusJobSlug(testFile),
    reason: `fails predicate clause (${clause}): ${detail}`,
    verdict: { status: "REFUSED", reason: { kind: "predicate", clause, detail } },
  };
}

export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [
  {
    testFile: "test/bound-kind-declared.test.ts",
    job: "bound-kind-census",
    script: "census:bound-kind",
    walks: ["src/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/*.ts, asserts every bound-shaped constant declares BACKSTOP or " +
      "PRIMARY CONTROL against the scripts/bound-kind-baseline.json grandfather list, structurally identical to claims/jscpd/depcruise; " +
      "measured well under the PRIMARY CONTROL bound below. Blocked #3304 on a single undeclared bound-shaped constant with a clean " +
      "fast run immediately before it — this is the required-core reason the class exists, restated for this one member (design iv)",
    verdict: { status: "ADMITTED", measuredMs: 470 },
  },
  {
    testFile: "test/catch-erasure-ratchet.test.ts",
    job: "catch-erasure-census",
    script: "census:catch-erasure",
    walks: ["src/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/*.ts, asserts every bare-erasing catch site stays within its " +
      "per-file baseline count, structurally identical to claims/jscpd/depcruise; measured well under the bound below",
    verdict: { status: "ADMITTED", measuredMs: 803 },
  },
  {
    testFile: "test/negative-reachability-ratchet.test.ts",
    job: "negative-reachability-census",
    script: "census:negative-reachability",
    walks: ["src/", "test/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/**/*.ts and test/**/*.ts, asserts every _RE/DEFAULT_FIX_CLASSES " +
      "surface's unhealthy arm is exercised, against its own embedded baseline tables; measured well under the bound below",
    verdict: { status: "ADMITTED", measuredMs: 1201 },
  },
  {
    testFile: "test/no-shallowing-of-the-canonical-checkout.test.ts",
    job: "no-shallowing-census",
    script: "census:no-shallowing",
    walks: ["src/", "scripts/", "deploy/", ".github/workflows/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/, scripts/, deploy/ and .github/workflows/, asserts no unexempted " +
      "depth-limiting git flag against its own EXEMPTIONS table; measured well under the bound below",
    verdict: { status: "ADMITTED", measuredMs: 526 },
  },
  {
    testFile: "test/enforcement-data-carveout.test.ts",
    job: "enforcement-data-carveout-census",
    walks: ["src/", "scripts/"],
    reason:
      "satisfies (a)-(c): deriveEnforcementDataCandidates() walks the whole tracked tree via git ls-files, filters to src/ and " +
      "scripts/ readers to build a text corpus, and the suite's own completeness test asserts findUnexplainedGaps() is empty against " +
      "ENFORCEMENT_DATA/ENFORCEMENT_DATA_EXCLUSIONS, a real baseline/exemption table — the same suite W1-T2478's own shipped test " +
      "named as its fifth ('measured ~2.1s alone... deliberately NOT added'); refused by cost, never by mechanism",
    verdict: {
      status: "REFUSED",
      reason: {
        kind: "cost",
        measuredMs: 3755,
        detail:
          "node --test --import tsx --import ./test/setup/tmp-hygiene.ts test/enforcement-data-carveout.test.ts, alone, " +
          "measured 2026-09-04: 3686/3755/3769ms across three runs (median kept) — over FAST_GATE_CENSUS_BOUND_MS; re-run the " +
          "same command to re-derive or refute this number",
      },
    },
  },
  refusedForPredicate(
    "test/a-census-suite-is-unreachable-from-the-symbols-a-diff-changes.test.ts",
    "a",
    "W1-T2680's own suite. Its single ls-files call is `git ls-files test/*.test.ts`, used as a CONTROL to size the test " +
      "directory (so the verb under test can be shown not to return the whole of it) — it walks test/, never src/, and asserts " +
      "nothing about every file it counts. The `src/` strings the recognizer also sees are FIXTURE changed-file lists fed to the " +
      "verb, not a population it reads. Carries no baseline table either",
  ),
  refusedForPredicate(
    "test/a-count-assertion-names-its-members.test.ts",
    "a",
    "walks git ls-files scoped to test/*.test.ts only — never src/ — so it is not a src-population walk; its own header states " +
      "it carries no baseline/grandfather table either",
  ),
  refusedForPredicate(
    "test/a-landed-feedback-file-remains-in-the-boot-checkout.test.ts",
    "a",
    "its sole ls-files call is `--error-unmatch <one file>` against a synthetic fixture repo — a single tracked-path check, not a " +
      "population walk",
  ),
  refusedForPredicate(
    "test/a-suite-is-not-a-second-concern.test.ts",
    "b",
    "walks `git ls-files src/*.ts src/lib/*.ts` for real, but asserts an aggregate percentage threshold (pct > 60) rather than a " +
      "property of every file walked, and carries no baseline/exemption table",
  ),
  refusedForPredicate(
    "test/acceptance-block-diagnostics.test.ts",
    "b",
    "`git ls-files` (whole repo, includes src/) is used only to copy the tracked tree into a mutation-testing shadow checkout — " +
      "no per-file assertion is made anywhere in the suite",
  ),
  refusedForPredicate(
    "test/checkout-writers.test.ts",
    "a",
    "`git ls-files -- ee-open.json` checks exactly one named path is untracked; not a population walk",
  ),
  refusedForPredicate(
    "test/config-fixture-path-parity.test.ts",
    "a",
    "`git ls-files test` is scoped to test/ only, never src/",
  ),
  refusedForPredicate(
    "test/coverage-session-blanking.test.ts",
    "a",
    "listTrackedTestFiles shells `git ls-files -- test` — test/ only, never src/",
  ),
  refusedForPredicate(
    "test/host-parity-azure-pole.test.ts",
    "a",
    "trackedFiles is only ever called with deploy/*.sh and test/*.test.ts patterns — never src/",
  ),
  refusedForPredicate(
    "test/instrument-surface-completeness.test.ts",
    "b",
    "`git(['ls-files'])` enumerates the whole tracked tree (includes src/), but isProductOrTestPath explicitly EXCLUDES src/, " +
      "apps/, packages/ and test/ paths from the derived candidate set the suite asserts about — the walked-and-asserted " +
      "population is deliberately everything BUT src/",
  ),
  refusedForPredicate(
    "test/ledger-read-intent.test.ts",
    "a",
    "`git ls-files src/lib/status.ts` checks exactly one file is tracked, and a dedicated test pins the enforced corpus stays " +
      "exactly that one file — not a population walk",
  ),
  refusedForPredicate(
    "test/licence-boundary.test.ts",
    "a",
    "`git(['ls-files'])` output is filtered to root-only files (`!f.includes('/')`), which excludes src/ entirely by construction",
  ),
  refusedForPredicate(
    "test/mkdtemp-callsite-check.test.ts",
    "b",
    "the underlying scripts/mkdtemp-callsite-check.mjs genuinely walks src/scripts/test via git ls-files with its own baseline " +
      "(hooks/mkdtemp-allowlist.txt), but the .test.ts file's OWN body never loops+asserts over that real population itself — most " +
      "of its tests exercise the pure classifier against synthetic fixtures, and its one real-repo check asserts a single " +
      "aggregate subprocess 'clean' match, the same same-class shape claims/jscpd already have, never the census's own in-file " +
      "per-item loop",
  ),
  refusedForPredicate(
    "test/moving-base-changed-files.test.ts",
    "a",
    "\"ls-files\" appears only in a comment; the suite tests git-diff-based changed-file derivation against synthetic fixture " +
      "repos and never shells ls-files itself",
  ),
  refusedForPredicate(
    "test/no-raw-nul.test.ts",
    "c",
    "`git ls-files -z` (whole repo, includes src/) drives a real per-file loop asserting zero raw-NUL bytes, but the suite's own " +
      "header explicitly rejects an allowlist by design (\"WHY EXTENSION FILTERING, NOT AN ALLOWLIST\") — no baseline/exemption " +
      "table exists, so a single new violation anywhere reddens it rather than only a NEW one",
  ),
  refusedForPredicate(
    "test/nothing-tells-you-which-census-suites-your-change-joins.test.ts",
    "a",
    "a meta-test of censusSuiteMembership(For) itself — its one 'git grep -l ls-files' shape is answered entirely by an injected " +
      "mock PreflightSpawn in every test; the real command is never shelled from this file",
  ),
  refusedForPredicate(
    "test/operator-gated-default-reachability.test.ts",
    "a",
    "`execFileSync('git', ['ls-files', 'test'])` is scoped to test/ only, never src/",
  ),
  refusedForPredicate(
    "test/state-citation-check.test.ts",
    "b",
    "the underlying scripts/state-citation-check.mjs walks git ls-files from the repo root (includes src/) with a real baseline " +
      "(scripts/state-citation-baseline.json), but the .test.ts file's only real-repo assertion is an aggregate subprocess " +
      "exit-status-0 check, never a per-file loop/assert inside the test file itself",
  ),
  refusedForPredicate(
    "test/tracked-source-write-guard.test.ts",
    "a",
    "listTrackedTestFiles shells `git ls-files -- test` — test/ only; src/ is the PROTECTED target this suite guards, not the " +
      "population it walks and asserts over",
  ),
  // W1-T2643's OWN proof file. Its prose and its own recognizer-exercising tests inevitably
  // mention "ls-files" and "src/" (the same self-reference test/nothing-tells-you-which-census-
  // suites-your-change-joins.test.ts already has above), which trips the text-substring
  // recognizer — proven by the drift-guard test below catching itself before this entry existed.
  // It never shells `git ls-files` itself (only `git grep`, via censusPopulationDrift), so it
  // fails clause (a) exactly like its W1-T2523 sibling.
  refusedForPredicate(
    "test/the-census-admission-set-is-derived-not-enumerated.test.ts",
    "a",
    "this file — meta-tests CENSUS_POPULATION/censusPopulationDrift/FAST_GATE_STEPS themselves; its one real git call is " +
      "`git grep`, never `git ls-files`, so it is not itself a src-population walk",
  ),
  // W1-T2644's OWN proof file, the same self-reference shape its sibling directly above already
  // has: it discusses (and, for the UNCLASSIFIED test, fabricates fixture text containing) both
  // "ls-files" and "src/", which trips the recognizer's text-substring match. It never shells
  // `git ls-files` itself — only `censusPopulationDrift`'s own `git grep` seam, under a mock —
  // so it fails clause (a) exactly like the entry above it.
  refusedForPredicate(
    "test/the-census-roster-is-named-not-numbered.test.ts",
    "a",
    "this file — asserts CENSUS_SUITE_ROSTER/CENSUS_POPULATION/censusPopulationDrift/FAST_GATE_STEPS stay one consistent " +
      "source; every git call it makes is through a mocked PreflightSpawn, never a real `git ls-files`, so it is not itself " +
      "a src-population walk",
  ),
  // W1-T2647's OWN proof file — self-reference shape as its siblings above; only real git call
  // is `git grep`, never `git ls-files`, so it fails clause (a).
  refusedForPredicate("test/census-population-is-derived-not-counted.test.ts", "a", "this file — W1-T2647's falsifier; its one real git call is `git grep`, never `git ls-files`"),
];

// W1-T2644: THE ROSTER IS THE POPULATION, RE-EXPORTED UNDER THE NAME THIS TASK'S OWN ACCEPTANCE
// CRITERION NAMES ("the roster is stated once, as data, beside the step table it governs" —
// grep: CENSUS_SUITE_ROSTER). An alias, deliberately never a second array: W1-T2523's own
// rationale already paid for the "two-derivations" defect once ("RE-DERIVE RATHER THAN TRUST THE
// TWO"), and this task's own note says the same thing about itself — "whichever lands second
// should READ the roster rather than growing a second derivation". `CENSUS_POPULATION` keeps its
// name (existing callers — test/the-census-admission-set-is-derived-not-enumerated.test.ts,
// shipped by W1-T2643 and out of this task's own file list — read it directly, by that name,
// today); `CENSUS_SUITE_ROSTER` is the identical array under the label this task's acceptance
// text specifies, so a reader who greps either name finds the SAME data, never two.
export const CENSUS_SUITE_ROSTER: typeof CENSUS_POPULATION = CENSUS_POPULATION;

export const CENSUS_ADMITTED_MEMBERS: readonly (CensusPopulationMember & {
  readonly script: string;
  readonly verdict: { readonly status: "ADMITTED"; readonly measuredMs: number };
})[] = CENSUS_POPULATION.filter(
  (m): m is CensusPopulationMember & { script: string; verdict: { status: "ADMITTED"; measuredMs: number } } =>
    m.verdict.status === "ADMITTED",
);

/** THE PROJECTION (design: "the step table becomes a projection, not a parallel list"). Every
 *  {@link FAST_GATE_STEPS} census entry below is computed FROM {@link CENSUS_ADMITTED_MEMBERS},
 *  never hand-added beside it — a population member marked ADMITTED with no step, or a step with
 *  no admitted population member, cannot occur because there is only ever this one array to read
 *  either from. */
const CENSUS_FAST_GATE_STEPS: { job: string; script: string; reason: string; boundMs: number }[] = CENSUS_ADMITTED_MEMBERS.map(
  (m) => ({ job: m.job, script: m.script, reason: m.reason, boundMs: FAST_GATE_CENSUS_BOUND_MS }),
);

/** THE RECOGNIZER (W1-T2523's own `censusSuiteMembershipFor`, extracted so this task's drift
 *  guard reuses it rather than re-deriving a second copy of the same heuristic — "ONE CENSUS
 *  PREDICATE, NEVER TWO"). Every `test/*.test.ts` file mentioning `ls-files` whose own text also
 *  filters on `src/` is a census-shaped candidate; a hit this process cannot read back off disk
 *  is KEPT rather than ruled out, the same "unknown stays visible" posture the caller above this
 *  drives takes. */
function discoverSrcFilteredLsFilesCallers(
  repoRoot: string,
  spawn: PreflightSpawn,
  readFile: (path: string) => string,
): string[] {
  const res = spawn("git", ["grep", "-l", "ls-files", "--", "test/*.test.ts"], { cwd: repoRoot });
  const callers = (res.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  return callers.filter((f) => {
    try {
      return /src\//.test(readFile(f));
    } catch {
      // unreadable: kept in, not ruled out — see censusSuiteMembershipFor's own doc comment
      return true;
    }
  });
}

export interface CensusPopulationDriftReport {
  /** A census-shaped file the recognizer found in the tree with no {@link CENSUS_POPULATION}
   *  entry — the drift this whole task exists to catch. Never silently dropped: a caller that
   *  wants a pass/fail reads `unknown.length === 0`. */
  readonly unknown: readonly string[];
  /** A {@link CENSUS_POPULATION} entry the recognizer no longer discovers — e.g. renamed,
   *  deleted, or edited to no longer walk src/. Corrected by editing {@link CENSUS_POPULATION},
   *  never left silently stale. */
  readonly stale: readonly string[];
}

/**
 * THE DRIFT GUARD — "a census of the census" (design). Re-runs the SAME recognizer
 * {@link discoverSrcFilteredLsFilesCallers} against the real tree and diffs it against
 * {@link CENSUS_POPULATION}'s own `testFile` set. Approximate by construction, and says so: a
 * census-shaped suite reachable by a means this recognizer does not model (no literal `ls-files`
 * text, or a `src/` filter this recognizer's own text-match cannot see) is invisible to it,
 * exactly the honesty limit {@link censusSuiteMembershipFor}'s own doc comment already records.
 */
export function censusPopulationDrift(
  repoRoot: string,
  spawn: PreflightSpawn,
  readFile: (path: string) => string = (path) => readFileSync(join(repoRoot, path), "utf8"),
): CensusPopulationDriftReport {
  const discovered = new Set(discoverSrcFilteredLsFilesCallers(repoRoot, spawn, readFile));
  const known = new Set(CENSUS_POPULATION.map((m) => m.testFile));
  const unknown = [...discovered].filter((f) => !known.has(f)).sort();
  const stale = [...known].filter((f) => !discovered.has(f)).sort();
  return { unknown, stale };
}

export interface FastGateStep {
  job: string;
  script: string;
  reason: string;
  boundMs?: number;
  /** Retain bounded stdout on PASS. Only evidence-producing signals may opt in. */
  retainSuccessOutput?: boolean;
}

export const FAST_GATE_STEPS: FastGateStep[] = [
  {
    job: "cli-reference",
    script: "cli-reference:check",
    reason: "required-core — absent from lib/ci-parity.ts and from every workflow file until this task; blocked #1352 (design iv)",
  },
  {
    job: "claims",
    script: "claims",
    reason: "required-core — already a --ci-parity entry but unreachable without shelling test:ci; blocked #1352 twice in one sitting (design iv)",
  },
  {
    job: "learnings-budget-ratchet",
    script: "learnings-budget-ratchet",
    reason: "same-class — deterministic npm-script gate ci.yml's learnings-budget-ratchet job runs unconditionally, measured 0.16s",
  },
  {
    job: "jscpd",
    script: "jscpd",
    reason: "same-class — deterministic npm-script gate ci.yml's jscpd-gate job runs unconditionally, measured 0.17s",
  },
  {
    job: "depcruise",
    script: "depcruise",
    reason: "same-class — deterministic npm-script gate ci.yml's depcruise job runs unconditionally, measured 0.48s",
  },
  {
    job: "api-client-drift",
    script: "api-client:check",
    reason: "same-class — deterministic npm-script gate ci.yml's api-client-drift job runs unconditionally, measured 0.17s",
  },
  {
    job: "no-hand-rolled-fetch",
    script: "no-hand-rolled-fetch:check",
    reason: "same-class — deterministic npm-script gate ci.yml's no-hand-rolled-fetch job runs unconditionally, measured 0.14s",
  },
  {
    job: "source-size",
    script: "source-size-signal",
    retainSuccessOutput: true,
    reason:
      "same-class (W1-T2488/W1-T2734) — a deterministic npm-script signal: refreshes origin/main, measures only changed " +
      "src/**/*.ts files from the merge base to HEAD, and publishes human plus schema-versioned JSON hotspot evidence. " +
      "Positive growth remains PASS because line count is a review-risk signal rather than a correctness verdict; only an " +
      "unreadable base or failed measurement refuses the step. The historical shared baseline is not read or written",
  },
  // W1-T2643: the four census entries are no longer hand-written here — they are
  // CENSUS_ADMITTED_MEMBERS's own projection (see CENSUS_POPULATION above). Editing a census
  // suite's admission means editing CENSUS_POPULATION, never this array directly.
  ...CENSUS_FAST_GATE_STEPS,
  {
    job: "worker-branch-shape",
    script: "worker-branch-shape:check",
    reason:
      "same-class (W1-T2491) — a deterministic, offline, sub-second gate structurally identical to claims/jscpd/depcruise: a " +
      "plain local git+fs read (never node --test, never a network call) that refuses a branch claiming a task (by an anchored " +
      "Remudero-Task trailer, or by filing a plan/tasks.d/ shard) whose head ref does not carry the run-<taskId>-<epochMs> shape " +
      "seven modules read for dispatch visibility and merge credit (scripts/worker-branch-shape.mjs)",
  },
];

// ── W1-T2523: WHICH CENSUS SUITES DOES A CHANGED PATH JOIN? A REPORT, NEVER A GATE ────────────
//
// THE GAP. `git grep -l <symbol>` — the caller sweep this repo mandates before a PR — is BLIND
// to a census suite by construction: it names none of a caller's symbols, only a population
// (`git ls-files`, filtered to `src/`) and a property asserted over every member. A PR that adds
// two constants and a regex to `src/lib/classify.ts` tripped BOTH `bound-kind-declared.test.ts`
// and `negative-reachability-ratchet.test.ts` (2026-08-30) with a correctly-run sweep finding
// neither — they surfaced only from a ~40-minute full-suite diff of both branches. This is the
// missing QUERY: given a set of changed paths, name the known census suites those paths enter.
//
// WHAT THIS MUST NOT BECOME (the task's own rationale, restated here so it cannot drift from the
// code it governs): NOT a new gate. `censusSuiteMembership`/`censusSuiteMembershipFor` below
// return data only — no `ok`, no verdict, nothing a caller could wire into a refusal — the same
// posture `hostCausedSuiteRedsStep` already takes for informational output in this file. And it
// must not claim completeness it cannot have: a suite that walks the tree in some way this
// derivation does not recognise is named in `unknownCoverage` as UNKNOWN COVERAGE, never
// silently dropped, or it rebuilds the very blind spot this task exists to close.
//
// THE DERIVATION IS AN APPROXIMATION, STATED AS ONE (same posture W1-T2317's own text-proximity
// ratchet takes about itself). `KNOWN_CENSUS_SUITES` below is now DERIVED from
// `CENSUS_ADMITTED_MEMBERS` (W1-T2643) rather than hand-carrying its own copy of the same four
// suites — the sequencing fence W1-T2643's own design records for this exact file: "whichever
// lands second reads this population rather than growing a second enumeration". Beyond that
// derived set, `censusSuiteMembershipFor` RE-DERIVES rather than trusts: it runs
// `discoverSrcFilteredLsFilesCallers` (shared with `censusPopulationDrift` above — the SAME
// recognizer, never a second copy of it), and anything that finds beyond the known suites is
// named in `unknownCoverage` rather than swallowed.

/** One census suite this derivation recognises well enough to say WHICH changed paths enter it.
 *  `walks` is the set of tracked-tree path prefixes its own `git ls-files` sweep is scoped to. */
interface KnownCensusSuite {
  readonly job: string;
  readonly testFile: string;
  readonly walks: readonly string[];
}

export const KNOWN_CENSUS_SUITES: readonly KnownCensusSuite[] = CENSUS_ADMITTED_MEMBERS.map((m) => ({
  job: m.job,
  testFile: m.testFile,
  walks: m.walks ?? [],
}));

/** One changed path paired with the {@link KNOWN_CENSUS_SUITES} job names it enters — `suites`
 *  is `[]`, an explicit empty set, when the path joins none; never omitted, never a guess. */
export interface CensusMembershipEntry {
  readonly path: string;
  readonly suites: readonly string[];
}

/** Pure, non-blocking output: no `ok`, no verdict — a report a caller prints, never a gate a
 *  caller can fail a PR with (design constraint above). `unknownCoverage` names every test file
 *  this run's own re-derivation found walking `git ls-files` and filtering on `src/` that
 *  {@link KNOWN_CENSUS_SUITES} does not already model — reported because this derivation cannot
 *  say which prefixes an unrecognised suite walks, so it refuses to guess membership for it
 *  rather than silently omit it. */
export interface CensusMembershipReport {
  readonly entries: readonly CensusMembershipEntry[];
  readonly unknownCoverage: readonly string[];
}

/** PURE core (mirrors {@link computeHostFacts}'s own split from {@link detectHostFacts}): given
 *  the changed paths and the already-discovered, already-`src/`-filtered set of census-suite
 *  callers (see {@link censusSuiteMembershipFor} for how that set is produced for real), decides
 *  membership by plain prefix matching against {@link KNOWN_CENSUS_SUITES} and names every
 *  discovered caller {@link KNOWN_CENSUS_SUITES} doesn't cover. No git, no filesystem, no spawn —
 *  a test hands this arrays of strings directly. */
export function censusSuiteMembership(
  changedPaths: readonly string[],
  srcFilteredCallers: readonly string[],
): CensusMembershipReport {
  const knownTestFiles = new Set(KNOWN_CENSUS_SUITES.map((s) => s.testFile));
  const unknownCoverage = [...new Set(srcFilteredCallers.filter((f) => !knownTestFiles.has(f)))].sort();
  const entries = changedPaths.map((path) => ({
    path,
    suites: KNOWN_CENSUS_SUITES.filter((s) => s.walks.some((prefix) => path.startsWith(prefix))).map((s) => s.job),
  }));
  return { entries, unknownCoverage };
}

/** The impure edge (mirrors {@link detectHostFacts}'s own split from {@link computeHostFacts}):
 *  runs the task record's own re-derivation for real — `git grep -l 'ls-files' --
 *  'test/*.test.ts'` via the injected {@link PreflightSpawn}, the SAME seam every other step in
 *  this file uses (never a second spawn mechanism) — then reads each hit's own text (via the
 *  injectable `readFile`, default a real `readFileSync`) and keeps only the ones that also
 *  filter on `src/`, before handing the result to the pure {@link censusSuiteMembership}. A `git
 *  grep` that matches nothing exits 1 — git's own documented "no match" convention, not a
 *  failure — and reads as zero callers here exactly like everywhere else `PreflightSpawn`'s
 *  `status` is read in this file: never thrown, always reported. A hit this process cannot read
 *  back off disk is kept (not ruled out) rather than silently dropped, the same "unknown stays
 *  visible" posture `unknownCoverage` itself takes. */
export function censusSuiteMembershipFor(
  changedPaths: readonly string[],
  repoRoot: string,
  spawn: PreflightSpawn,
  readFile: (path: string) => string = (path) => readFileSync(join(repoRoot, path), "utf8"),
): CensusMembershipReport {
  const srcFilteredCallers = discoverSrcFilteredLsFilesCallers(repoRoot, spawn, readFile);
  return censusSuiteMembership(changedPaths, srcFilteredCallers);
}

/** The `package.json` "scripts" object's key set — read once per `runPreflightFast` call so a
 *  step whose script has been renamed or removed can be told apart from one that ran and
 *  failed (design vi), without ever spawning `npm` to find that out. `packageJsonText` is a
 *  test seam (a falsifier can hand a synthetic package.json missing one script), mirroring
 *  `CiParityDeps.ciYamlText`'s already-established pattern above; production reads the repo's
 *  real file. */
function fastGateScriptNames(repoRoot: string, packageJsonText?: string): Set<string> {
  const text = packageJsonText ?? readFileSync(join(repoRoot, "package.json"), "utf8");
  const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
  return new Set(Object.keys(pkg.scripts ?? {}));
}

export interface PreflightFastDeps {
  spawn?: PreflightSpawn;
  /** Test seam — production reads the repo's real package.json. */
  packageJsonText?: string;
  /** Test seam for the {@link FAST_GATE_CENSUS_BOUND_MS} wall clock — a falsifier hands a
   *  scripted sequence of timestamps to prove a step is refused purely by an elapsed-time
   *  measurement, with no real slow spawn required. Production always reads `Date.now()`. */
  now?: () => number;
  /** Test seam — production always uses {@link FAST_GATE_STEPS} itself; a falsifier can inject a
   *  narrowed or synthetic list (e.g. with the census entries removed) to prove what a fast run
   *  can and cannot see, without mutating the real exported table. */
  steps?: readonly FastGateStep[];
}

export interface PreflightFastResult {
  steps: CiParityStepResult[];
  ok: boolean;
}

/**
 * Runs `fn` with `NODE_TEST_CONTEXT` and `NODE_OPTIONS` removed from `process.env` for the
 * duration of the call, then restores whatever was there before — the SAME isolation
 * `test/reapable-prefix.test.ts` and `test/route-scope-matrix.test.ts` already establish for a
 * spawned `node --test` CHILD, applied here to a spawned `node --test` GRANDCHILD (`npm run
 * --silent census:*` → the script's own `node --test`, package.json).
 *
 * REQUIRED, MEASURED, NOT SPECULATIVE (W1-T2478): `node --test`'s own recursion guard reads
 * `NODE_TEST_CONTEXT` from its inherited environment — set (as it always is when THIS module's
 * own caller is itself running under `node --test`, e.g. this file's own test suite exercising
 * `runPreflightFast` for real), a nested `node --test` prints "run() is being called recursively
 * ... skipping running files" and exits 0 HAVING ASSERTED NOTHING. `defaultPreflightSpawn`
 * (lib/commit-message.ts) calls `spawnSync` with no `env` override, so it inherits
 * `process.env` exactly as it stands at call time. Without this, a census step's `npm run
 * --silent census:*` would read as a clean PASS while running zero of the suite's own
 * assertions — the exact "clean fast run, no visibility" shape #3304 already demonstrated once,
 * reintroduced by this task's own mechanism if left unguarded.
 */
function withoutNodeTestContext<T>(fn: () => T): T {
  const savedContext = process.env.NODE_TEST_CONTEXT;
  const savedOptions = process.env.NODE_OPTIONS;
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_OPTIONS;
  try {
    return fn();
  } finally {
    if (savedContext !== undefined) process.env.NODE_TEST_CONTEXT = savedContext;
    else delete process.env.NODE_TEST_CONTEXT;
    if (savedOptions !== undefined) process.env.NODE_OPTIONS = savedOptions;
    else delete process.env.NODE_OPTIONS;
  }
}

/**
 * `rmd preflight --fast`'s engine. One step per `FAST_GATE_STEPS` entry, run and reported
 * independently (same discipline as {@link runCiParity} and
 * {@link import("./commit-message.js").runPreflight}: one failure never blocks a later step's
 * chance to report, and `ok` is the AND of all of them). A script that is not in
 * `package.json`'s "scripts" is reported as `SCRIPT MISSING` — distinct from `FAIL`, which
 * means the script ran and its gate failed — so a renamed or removed script goes loud, never
 * quiet (design vi).
 *
 * W1-T2478: an entry that declares `boundMs` (the census class) has its OWN spawn timed
 * ({@link withoutNodeTestContext}-wrapped, since its script spawns `node --test` itself), and a
 * run that takes longer than `boundMs` is refused as `BOUND EXCEEDED` regardless of the script's
 * own exit code — the PRIMARY CONTROL described above `FAST_GATE_STEPS`. An entry with no
 * `boundMs` runs exactly as it always has: no timing, no ceiling, no env stripping, unchanged by
 * this task.
 */
export function runPreflightFast(repoRoot: string, deps: PreflightFastDeps = {}): PreflightFastResult {
  const spawn = deps.spawn ?? defaultPreflightSpawn;
  const scriptNames = fastGateScriptNames(repoRoot, deps.packageJsonText);
  const now = deps.now ?? Date.now;
  const gateSteps = deps.steps ?? FAST_GATE_STEPS;
  // W1-T2545 — PASS ONE: run every step and, for a census entry, keep its measured cost beside
  // its own result. Nothing is refused on cost here, because the threshold is derived from the
  // population and the population is not complete until the last entry has run.
  const censusCosts = new Map<number, number>();
  const steps = gateSteps.map(({ job, script, boundMs, retainSuccessOutput }, i) =>
    runStep(job, () => {
      if (!scriptNames.has(script)) {
        return { ok: false, detail: `SCRIPT MISSING — "${script}" is not defined in package.json's "scripts"; this step did not run` };
      }
      const label = `npm run --silent ${script}`;
      if (boundMs === undefined) {
        return shellOut(spawn, label, "npm", ["run", "--silent", script], { cwd: repoRoot, retainSuccessOutput });
      }
      const startedAt = now();
      const result = withoutNodeTestContext(() => shellOut(spawn, label, "npm", ["run", "--silent", script], { cwd: repoRoot }));
      const elapsedMs = now() - startedAt;
      censusCosts.set(i, elapsedMs);
      // The SOFT bound reports; it never refuses. A census suite's cost grows with the corpus it
      // walks, so crossing a written number is news about the tree, not a fault in this run.
      if (elapsedMs > boundMs && result.ok) {
        return { ok: true, detail: `${result.detail} — COST ${elapsedMs}ms, over the ${boundMs}ms soft bound (reported, not refused)` };
      }
      return result;
    }),
  );

  // PASS TWO: with every census cost measured on the SAME machine in the SAME run, a runaway
  // entry is the one costing several times its cheapest sibling — a ratio a slow runner cannot
  // manufacture, because it slows every entry together. An entry whose own command FAILED is
  // left exactly as it is: a real failure is never restated as a cost refusal.
  const threshold = censusRunawayThresholdMs([...censusCosts.values()]);
  if (threshold !== undefined) {
    for (const [i, elapsedMs] of censusCosts) {
      if (elapsedMs <= threshold || !steps[i].ok) continue;
      const { job, script } = gateSteps[i];
      steps[i] = {
        ...steps[i],
        ok: false,
        detail:
          `${job}: RUNAWAY — npm run --silent ${script} took ${elapsedMs}ms, over ${threshold}ms ` +
          `(${FAST_GATE_CENSUS_RUNAWAY_MULTIPLE}x this run's cheapest census entry, floored at ` +
          `${FAST_GATE_CENSUS_REFERENCE_FLOOR_MS}ms); its own result would have PASSed. Refused by a bound ` +
          `derived from this run's own measurements, never by a written constant a growing corpus outgrows`,
      };
    }
  }
  return { steps, ok: steps.every((s) => s.ok) };
}

// ── `rmd preflight --coverage` (W1-T1074) — diff-coverage, at author-time, on its OWN base ────
//
// THE GAP THIS CLOSES. `scripts/diff-coverage.mjs` is a correct gate that today runs ONLY in
// CI's `coverage-ratchet` job — invisible to the author writing the code until a push, a CI
// cycle and (on a reviewed PR) a spent review orphan have already gone by. `--ci-parity`'s own
// `coverage-ratchet` entry mirrors it locally already, but only as one of fourteen jobs behind a
// flag that is not habitual to run (rationale (6)); `--fast` cannot carry it at all, by design,
// because a coverage lcov needs the full suite (design vi: `--fast` NEVER shells `npm test`).
// This is therefore a FOURTH, ADDITIVE mode on the SAME `preflight` verb — never a new verb,
// never a change to the default, `--ci-parity`, or `--fast` behaviour — dedicated to exactly
// this one gate.
//
// THE HONEST COST. Opt-in and slow BY CONSTRUCTION: it shells the full `test/**/*.test.ts` glob
// with `--experimental-test-coverage`, the same multi-minute run `--ci-parity`'s coverage-ratchet
// job pays (shared via {@link testWithCoverageLeaf} above so the one expensive invocation cannot
// drift between the two callers). A mode whose cost surprises the caller is one they stop
// running, so `preflightCommand`'s own doc states it in minutes-not-seconds terms.
//
// THE RUNNER OWNS THE BASE (design ii), not the caller. `scripts/diff-coverage.mjs` itself takes
// a `--diff` file/stdin and derives no base at all — CI supplies its own correctly, but a local
// caller building that diff by hand can get it wrong in exactly the two ways rationale (9)
// measured: a two-dot `--cached origin/main` diff that reads main's own commits as the caller's,
// or a check run before committing that passes over an empty diff. `runPreflightCoverage` below
// computes the SAME `origin/main...HEAD` three-dot range `--ci-parity` already uses
// ({@link refreshOriginMain}, {@link mergeBaseDiffText}) and REFUSES rather than reports when the
// inputs cannot support a verdict:
//   - an EMPTY diff (`origin/main...HEAD` touches nothing) — there is no "coverage of this diff"
//     to assert at all;
//   - a DIRTY tree in a diffed file — the lcov this run is about to produce and the diff it
//     compares against must come from the SAME tree, and an uncommitted edit to a diffed file
//     means they would not.
// Both refusals are named steps of their own (`coverage-mode:diff-scope`,
// `coverage-mode:tree-clean`) and SHORT-CIRCUIT the run — unlike `--ci-parity`'s many independent
// per-job steps, this mode is one linear pipeline (refuse → run the suite → assert instrumentation
// → compare) where every later step's input depends on the one before it actually having produced
// something trustworthy, so there is nothing honest left to report once an earlier stage refused.
//
// INSTRUMENTATION MUST BE ASSERTED BEFORE A PASS (design iii). `diff-coverage.mjs` reports
// `OK` the instant no ADDED line it INSTRUMENTED reads as uncovered — and that quantifier ranges
// only over what the run's lcov actually saw (rationale (7)/(8)): a changed source file lcov
// never instrumented at all (no `SF:` record for it — no test loaded it) makes the OK verdict
// trivially, vacuously true over an empty set. `coverage-mode:instrumentation` below closes that
// LOCALLY, without touching `scripts/diff-coverage.mjs` itself (design iv: that script is a pure
// lcov-times-diff comparator and CI feeds it correctly; whether it should ALSO refuse this is a
// separate, unscoped question) — for every changed file under `src/` that is not itself a test,
// it requires an `SF:` record in this run's own lcov, and reports `UNPROVEN`, NAMING the files,
// rather than letting the run fall through to `diff-coverage.mjs`'s own vacuous `OK`.
//
// NO WEAKENING (design vi/vii): nothing here exempts an arm, lowers a threshold, or narrows what
// `diff-coverage.mjs`/`coverage-ratchet` refuse — this mode's own `coverage-mode:diff-coverage`
// step shells the REAL, unmodified script, over the SAME refreshed three-dot diff, and only ever
// gets there once every earlier stage has already proven the inputs are trustworthy.

/** Every path `origin/main...HEAD` touches, trimmed and non-empty — the CALLER never supplies
 *  this (design ii): it is always the runner's OWN, freshly refreshed three-dot diff. */
function computeChangedFiles(repoRoot: string, spawn: PreflightSpawn): string[] {
  const res = spawn("git", ["diff", "--name-only", "origin/main...HEAD"], { cwd: repoRoot });
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Of `files`, the ones `git status --porcelain` reports dirty — an uncommitted change to a
 *  diffed file, staged or not. NEVER `.trim()` the raw porcelain STRING before slicing: the
 *  status column can legitimately start with a space (` M path`), and trimming the whole blob
 *  first would eat that leading space off line one, shifting every `slice(3)` by one character
 *  (same trap `lib/operator-sync.ts`'s `parsePorcelain` documents; duplicated locally per this
 *  file's own test-seam convention rather than exported from a module this task does not
 *  declare). Trimming is safe, and done, only PER LINE, after the fixed 3-char slice. */
function dirtyDiffedFiles(repoRoot: string, spawn: PreflightSpawn, files: readonly string[]): string[] {
  if (files.length === 0) return [];
  const res = spawn("git", ["status", "--porcelain", "--", ...files], { cwd: repoRoot });
  return res.stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/** The `SF:` paths an lcov report instruments — same one-line-per-record shape
 *  `scripts/diff-coverage.mjs`'s own `parseLcovHitsByFile` reads, but this only needs the file
 *  SET (not per-line hit data), so it stays a five-line parser rather than importing that
 *  script's internals (design iv: that script is not touched, and not depended on, by this). */
function lcovInstrumentedFiles(lcovText: string): Set<string> {
  const files = new Set<string>();
  for (const line of lcovText.split("\n")) {
    if (line.startsWith("SF:")) files.add(line.slice(3).trim());
  }
  return files;
}

/** A "source file" for the instrumentation assertion (design iii): under `src/`, and not itself
 *  a test — the same `src/` + not-a-test shape `src/lib/review.ts`'s own diff-scoped checks use
 *  for "a change that should carry its own coverage", duplicated locally (that predicate is not
 *  exported, and this task does not declare `src/lib/review.ts`). A file the diff only touches
 *  under `test/`, `scripts/`, `docs/`, etc. makes no coverage claim either way. */
function isChangedSourceFile(path: string): boolean {
  if (!path.startsWith("src/")) return false;
  if (/(^|\/)test(s)?\//.test(path)) return false;
  if (/\.test\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/\.spec\./.test(path)) return false;
  return true;
}

export interface PreflightCoverageDeps {
  spawn?: PreflightSpawn;
  /** Test seam — production reads the lcov this mode's OWN `coverage-mode:test-with-coverage`
   *  step just wrote to disk; a falsifier hands a synthetic lcov instead of actually running the
   *  full suite. */
  lcovText?: string;
}

export interface PreflightCoverageResult {
  steps: CiParityStepResult[];
  ok: boolean;
}

/**
 * `rmd preflight --coverage`'s engine (W1-T1074) — see the file-level comment above for the
 * full design. Unlike {@link runCiParity}/{@link runPreflightFast}'s many-independent-jobs
 * discipline, this is ONE linear pipeline that REFUSES (design ii) rather than reports once an
 * earlier stage cannot support a trustworthy verdict, and only reports a real `OK`/`FAIL` once
 * every earlier stage — base refresh, diff non-empty, tree clean, the full suite, instrumentation
 * — has already succeeded (design iii).
 */
export function runPreflightCoverage(repoRoot: string, deps: PreflightCoverageDeps = {}): PreflightCoverageResult {
  const spawn = deps.spawn ?? defaultPreflightSpawn;
  const steps: CiParityStepResult[] = [];

  const refresh = runStep("coverage-mode:base-refresh", () => refreshOriginMain(repoRoot, spawn));
  steps.push(refresh);
  if (!refresh.ok) return { steps, ok: false };

  const changedFiles = computeChangedFiles(repoRoot, spawn);
  if (changedFiles.length === 0) {
    steps.push({
      name: "coverage-mode:diff-scope",
      ok: false,
      detail:
        "coverage-mode:diff-scope: REFUSED — origin/main...HEAD (freshly refreshed) is an empty diff; there is no diff to assert coverage over",
    });
    return { steps, ok: false };
  }
  steps.push({
    name: "coverage-mode:diff-scope",
    ok: true,
    detail: `coverage-mode:diff-scope: PASS — ${changedFiles.length} file(s) changed against a freshly refreshed origin/main...HEAD`,
  });

  const dirty = dirtyDiffedFiles(repoRoot, spawn, changedFiles);
  if (dirty.length > 0) {
    steps.push({
      name: "coverage-mode:tree-clean",
      ok: false,
      detail:
        `coverage-mode:tree-clean: REFUSED — uncommitted change(s) to diffed file(s), so the lcov this run would produce and the diff it compares against would not come from the same tree: ${dirty.join(", ")}`,
    });
    return { steps, ok: false };
  }
  steps.push({
    name: "coverage-mode:tree-clean",
    ok: true,
    detail: "coverage-mode:tree-clean: PASS — the working tree is clean in every diffed file",
  });

  const lcovPath = join(repoRoot, "coverage", "lcov.info");
  const test = runStep("coverage-mode:test-with-coverage", () => testWithCoverageLeaf(repoRoot, spawn, lcovPath));
  steps.push(test);
  if (!test.ok) return { steps, ok: false };

  let lcovText: string;
  try {
    lcovText = deps.lcovText ?? readFileSync(lcovPath, "utf8");
  } catch (e) {
    steps.push(toolchainFailure("coverage-mode:instrumentation", e));
    return { steps, ok: false };
  }

  const instrumented = lcovInstrumentedFiles(lcovText);
  const sourceFiles = changedFiles.filter(isChangedSourceFile);
  const uninstrumented = sourceFiles.filter((f) => !instrumented.has(f));
  if (uninstrumented.length > 0) {
    steps.push({
      name: "coverage-mode:instrumentation",
      ok: false,
      detail:
        `coverage-mode:instrumentation: UNPROVEN — this run's lcov carries no SF: record for: ${uninstrumented.join(", ")} — ` +
        "no test loaded them, so this run cannot trust ANY coverage verdict about them, positive or negative",
    });
    return { steps, ok: false };
  }
  steps.push({
    name: "coverage-mode:instrumentation",
    ok: true,
    detail: `coverage-mode:instrumentation: PASS — this run's lcov carries an SF: record for every one of the ${sourceFiles.length} changed source file(s)`,
  });

  const diffText = mergeBaseDiffText(repoRoot, spawn);
  const diffCoverage = runStep("coverage-mode:diff-coverage", () =>
    shellOut(spawn, "diff-coverage.mjs (origin/main...HEAD, refreshed base)", process.execPath, [join(repoRoot, "scripts", "diff-coverage.mjs"), "--lcov", lcovPath], {
      cwd: repoRoot,
      input: diffText,
    }),
  );
  steps.push(diffCoverage);

  return { steps, ok: steps.every((s) => s.ok) };
}
