import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
}

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
    return { name, ok: r.ok, detail: `${name}: ${r.detail}`, matched: r.matched };
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
  opts?: { cwd?: string; input?: string; stream?: boolean },
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
  if (ok) return { ok, detail: `PASS — ${label}` };
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
function testWithCoverageLeaf(repoRoot: string, spawn: PreflightSpawn, lcovPath: string): CiParityLeafResult {
  try {
    mkdirSync(join(repoRoot, "coverage"), { recursive: true });
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
    { cwd: repoRoot, stream: true },
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
export function computeHostFacts(input: { platform: NodeJS.Platform; bashVersionText: string; hasProcMeminfo: boolean }): HostFacts {
  return {
    platform: input.platform,
    bashMajorVersion: parseBashMajorVersion(input.bashVersionText),
    hasProcMeminfo: input.hasProcMeminfo,
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
  return computeHostFacts({ platform: process.platform, bashVersionText, hasProcMeminfo: hasFile("/proc/meminfo") });
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
 * `CI_PARITY_TABLE` — one entry per .github/workflows/ci.yml job (fourteen, at filing time).
 * `runCiParity`'s drift step fails the moment `parseCiJobNames` finds a job this table does not
 * name at all; a listed `mirrored: false` job is a considered, reasoned exclusion, not a gap.
 */
export const CI_PARITY_TABLE: CiParityEntry[] = [
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
// in seconds, needs no network, and has demonstrably blocked a PR (or is the identical shape as
// one that has). `required-core` marks the two steps #1352 itself was blocked by; `same-class`
// marks the rest, admitted because each is the identical shape (a deterministic npm-script gate
// CI runs unconditionally) and costs well under half a second.
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

/** THE PRIMARY CONTROL (W1-T2478): the measured wall-clock ceiling every census entry's own
 *  `npm run --silent <script>` invocation is timed against in {@link runPreflightFast}. 2000ms
 *  because every census suite this task admits measures well under it alone, and the number is
 *  the enforcement — not a documented figure a step is separately trusted to honour, but the
 *  literal value `runPreflightFast` compares an actual `Date.now()` delta against on every run. */
export const FAST_GATE_CENSUS_BOUND_MS = 2000;

export const FAST_GATE_STEPS: { job: string; script: string; reason: string; boundMs?: number }[] = [
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
    script: "source-size-ratchet",
    reason:
      "same-class (W1-T2488) — a deterministic npm-script gate: walks src/'s own line counts via a plain readdirSync " +
      "sweep against scripts/source-size-baseline.json, spawns no subprocess (no test runner, no git) and opens no " +
      "network connection, measured ~0.2s. src/run-task.ts sat at 32,119 lines against a next-largest source file of " +
      "8,445 with no ratchet watching it, the one drift dimension the CLAUDE.md/coverage/cycle/learnings/mutation " +
      "ratchets did not already cover",
  },
  {
    job: "bound-kind-census",
    script: "census:bound-kind",
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/*.ts, asserts every bound-shaped constant declares BACKSTOP or " +
      "PRIMARY CONTROL against the scripts/bound-kind-baseline.json grandfather list, structurally identical to claims/jscpd/depcruise; " +
      "measured well under the PRIMARY CONTROL bound below. Blocked #3304 on a single undeclared bound-shaped constant with a clean " +
      "fast run immediately before it — this is the required-core reason the class exists, restated for this one member (design iv)",
    boundMs: FAST_GATE_CENSUS_BOUND_MS,
  },
  {
    job: "catch-erasure-census",
    script: "census:catch-erasure",
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/*.ts, asserts every bare-erasing catch site stays within its " +
      "per-file baseline count, structurally identical to claims/jscpd/depcruise; measured well under the bound below",
    boundMs: FAST_GATE_CENSUS_BOUND_MS,
  },
  {
    job: "negative-reachability-census",
    script: "census:negative-reachability",
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/**/*.ts and test/**/*.ts, asserts every _RE/DEFAULT_FIX_CLASSES " +
      "surface's unhealthy arm is exercised, against its own embedded baseline tables; measured well under the bound below",
    boundMs: FAST_GATE_CENSUS_BOUND_MS,
  },
  {
    job: "no-shallowing-census",
    script: "census:no-shallowing",
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/, scripts/, deploy/ and .github/workflows/, asserts no unexempted " +
      "depth-limiting git flag against its own EXEMPTIONS table; measured well under the bound below",
    boundMs: FAST_GATE_CENSUS_BOUND_MS,
  },
];

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
  steps?: readonly { job: string; script: string; reason: string; boundMs?: number }[];
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
  const steps = gateSteps.map(({ job, script, boundMs }) =>
    runStep(job, () => {
      if (!scriptNames.has(script)) {
        return { ok: false, detail: `SCRIPT MISSING — "${script}" is not defined in package.json's "scripts"; this step did not run` };
      }
      const label = `npm run --silent ${script}`;
      if (boundMs === undefined) {
        return shellOut(spawn, label, "npm", ["run", "--silent", script], { cwd: repoRoot });
      }
      const startedAt = now();
      const result = withoutNodeTestContext(() => shellOut(spawn, label, "npm", ["run", "--silent", script], { cwd: repoRoot }));
      const elapsedMs = now() - startedAt;
      if (elapsedMs > boundMs) {
        return {
          ok: false,
          detail:
            `BOUND EXCEEDED — ${label} took ${elapsedMs}ms, over the fast gate's ${boundMs}ms PRIMARY CONTROL bound ` +
            `(own result: ${result.ok ? "would have PASSed" : "also FAILed"}); refused by measured cost, not by a written exception naming it`,
        };
      }
      return result;
    }),
  );
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
