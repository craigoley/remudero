import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { defaultPreflightSpawn, spawnFailureDetail, typecheckStep, type PreflightSpawn } from "./commit-message.js";
// W1-T3099: the judge's own two primitives, imported rather than re-derived.
import { criterionFieldTampered, planOnlyDiff } from "./review.js";

const require = createRequire(import.meta.url);

/** BACKSTOP (W1-T1266) — it cannot fire on a healthy run, only on one that has already stopped
 * making progress, and the measurement is why: the two full local suites completed in 1,024,664 ms
 * (17.1 minutes) on 2026-09-09. Thirty minutes leaves nearly thirteen minutes of headroom while
 * still refusing a stalled suite. Naming the kind is what stops a later resize from quietly
 * promoting this into the thing that normally stops the run, which is the defect W1-T1266 exists
 * for. THE SIBLING TAG IS DELIBERATELY NOT SPELLED HERE: the census matches either kind word
 * anywhere in the block, so naming the other one would leave this declaration ambiguous and
 * satisfied by the wrong tag. This is deliberately LOCAL: CI keeps its independently configured
 * 35-minute job timeouts. */
export const LOCAL_FULL_SUITE_TIMEOUT_MS = 30 * 60 * 1_000;

const BOUNDED_SUITE_OUTPUT_TAIL_CHARS = 4_096;
const BOUNDED_SUITE_SPAWN_MAX_BUFFER = 64 * 1024 * 1024;
const SELF_SYNC_GUARD_ENV_NAME = "RMD_SELF_SYNC_DONE";
const TSX_LOADER_PATH = require.resolve("tsx");
const WORKER_CONTAINMENT_URL = new URL("./worker-containment.ts", import.meta.url).href;

/** The isolated supervisor for {@link runBoundedSuite}. It imports the established detached-group
 * spawn and negative-pgid SIGKILL helpers instead of copying either mechanism into ci-parity. The
 * parent stays synchronous (as the preflight API requires); this child owns the timer so it can
 * kill the group while the parent is waiting. */
function boundedSuiteSupervisorProgram(workerContainmentUrl: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `import { killProcessGroup, spawnDetachedGroup } from ${JSON.stringify(workerContainmentUrl)};`,
    "const [timeoutFile, timeoutMsText, label, file, ...args] = process.argv.slice(1);",
    "const timeoutMs = Number(timeoutMsText);",
    "let outputTail = \"\";",
    "let timedOut = false;",
    "const appendOutput = (chunk) => {",
    "  const text = String(chunk);",
    `  outputTail = (outputTail + text).slice(-${BOUNDED_SUITE_OUTPUT_TAIL_CHARS});`,
    "  return text;",
    "};",
    "try {",
    "  const contained = spawnDetachedGroup(",
    "    { command: file, args, cwd: process.cwd(), env: process.env },",
    "    (chunk) => process.stderr.write(appendOutput(chunk)),",
    "  );",
    "  contained.process.stdout.on(\"data\", (chunk) => process.stdout.write(appendOutput(chunk)));",
    "  const timer = setTimeout(() => {",
    "    timedOut = true;",
    "    writeFileSync(timeoutFile, JSON.stringify({ label, lastOutput: outputTail }), \"utf8\");",
    "    process.stderr.write(`SUITE TIMEOUT — ${label} exceeded ${timeoutMs}ms; killing its process group with SIGKILL.\\n`);",
    "    killProcessGroup(contained.pid);",
    "  }, timeoutMs);",
    "  contained.process.once(\"error\", (error) => {",
    "    clearTimeout(timer);",
    "    process.stderr.write(`SUITE SPAWN FAILURE — ${label}: ${error.message}\\n`);",
    "    process.exitCode = 70;",
    "  });",
    "  contained.process.once(\"close\", (code, signal) => {",
    "    clearTimeout(timer);",
    "    if (timedOut) { process.exitCode = 124; return; }",
    "    process.exitCode = typeof code === \"number\" ? code : 1;",
    "    if (signal) process.stderr.write(`SUITE SIGNAL — ${label}: ${signal}\\n`);",
    "  });",
    "} catch (error) {",
    "  process.stderr.write(`SUITE SPAWN FAILURE — ${label}: ${error instanceof Error ? error.message : String(error)}\\n`);",
    "  process.exitCode = 70;",
    "}",
  ].join("\n");
}

export interface BoundedSuiteRunOptions {
  /** Human-readable suite identity carried into the timeout verdict. */
  label: string;
  /** Explicit caller-owned wall-clock ceiling. */
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Matches {@link PreflightSpawn}'s streaming contract. */
  stream?: boolean;
}

export interface BoundedSuiteRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  signal?: string;
  /** Present only when the supervisor's clock, rather than the suite's exit code, ended the run. */
  timeout?: { label: string; lastOutput: string };
}

/**
 * Run a full suite under a hard wall-clock ceiling without changing the synchronous preflight
 * contract. The supervisor starts the actual suite with `spawnDetachedGroup`, then uses that
 * module's `killProcessGroup` on timeout; therefore a descendant cannot survive after its direct
 * parent is killed. A timeout flag is a file rather than an exit-code convention, so a healthy
 * command that itself exits 124 is never misclassified as a timeout.
 */
export function runBoundedSuite(file: string, args: string[], opts: BoundedSuiteRunOptions): BoundedSuiteRunResult {
  const timeoutDir = mkdtempSync(join(tmpdir(), "rmd-bounded-suite-"));
  const timeoutFile = join(timeoutDir, "timeout.json");
  const env = { ...process.env, ...opts.env };
  delete env[SELF_SYNC_GUARD_ENV_NAME];
  try {
    const res = spawnSync(
      process.execPath,
      [
        "--import",
        TSX_LOADER_PATH,
        "--input-type=module",
        "--eval",
        boundedSuiteSupervisorProgram(WORKER_CONTAINMENT_URL),
        timeoutFile,
        String(opts.timeoutMs),
        opts.label,
        file,
        ...args,
      ],
      {
        cwd: opts.cwd,
        env,
        encoding: "utf8",
        maxBuffer: BOUNDED_SUITE_SPAWN_MAX_BUFFER,
        ...(opts.stream ? { stdio: ["ignore", "inherit", "inherit"] as const } : {}),
      },
    );
    let timeout: BoundedSuiteRunResult["timeout"];
    if (existsSync(timeoutFile)) {
      try {
        const parsed = JSON.parse(readFileSync(timeoutFile, "utf8")) as { label?: unknown; lastOutput?: unknown };
        if (typeof parsed.label === "string" && typeof parsed.lastOutput === "string") {
          timeout = { label: parsed.label, lastOutput: parsed.lastOutput };
        }
      } catch {
        // A missing or malformed flag is not evidence of a timeout. The supervisor's nonzero
        // result still fails normally, without claiming a reason it could not record.
      }
    }
    return {
      status: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      error: res.error?.message,
      signal: res.signal ?? undefined,
      ...(timeout ? { timeout } : {}),
    };
  } finally {
    rmSync(timeoutDir, { recursive: true, force: true });
  }
}

/**
 * lib/ci-parity.ts — `rmd preflight --ci-parity` (W1-T294, MASTER-PLAN §5/§5C): a second,
 * additive mode on the `preflight` verb that runs CI's own gate set locally. Never a second
 * command, never a change to the default route. CLAUDE.md's "Before you push" bullet states the
 * rule it serves; docs/forensics/ci-parity.md holds the design record.
 *
 * INVARIANTS
 * - ONE ENTRY PER ci.yml JOB. {@link CI_PARITY_TABLE} is data keyed by job name. A job not
 *   mirrored carries `mirrored: false` and a `reason`, so an absent entry and a considered
 *   exclusion never look alike.
 * - CI'S OWN COMMAND, NEVER A PROXY. Each mirrored step shells the argv ci.yml invokes.
 * - MERGE-BASE PARITY. `origin/main` is fetched ONCE per run and immediately RESOLVED TO A SHA
 *   ({@link pinnedBase}); every diff-consuming step diffs three-dot against that SHA, never the
 *   ref. A stale base silently changes what counts as added (#585), and a base moved mid-run by a
 *   sibling worktree sharing the clone does the same in the other direction — which memoizing the
 *   fetch cannot prevent, because refs are clone-scoped (W1-T3017).
 * - EACH STEP REPORTS INDEPENDENTLY. {@link runStep} never lets one job throw out of the run.
 *
 * TRAP: a job added to ci.yml with no entry would under-cover in silence; `ci-parity:drift` fails
 * on it. FALSIFIER: test/preflight-ci-parity.test.ts, test/ci-parity-contract.test.ts.
 */

/** One `--ci-parity` step's outcome, keyed by an open `name`: one job can produce several steps. */
export interface CiParityStepResult {
  name: string;
  ok: boolean;
  detail: string;
  /** W1-T2862: bounded stdout, kept only where a fast step opts in; a truncated payload is never complete. */
  successOutput?: { text: string; truncated: boolean };
}

/** BACKSTOP: the durable summary must not grow with an unbounded child stdout stream. */
export const MAX_RETAINED_SUCCESS_OUTPUT_CHARS = 65_536;
/**
 * Where a preflight run writes its verdict, so the result survives the container that produced it.
 * TRAP: an operator lost an eight-minute run's verdict twice in one day, the container removed
 * before its summary was read.
 *
 * INVARIANT: `<repoRoot>/coverage/` — this route's gitignored artefact directory, and on a
 * container host inside the mounted state volume. Never the ledger (a verdict decides nothing),
 * never `config.root` (`loadConfig` would acquire a claude-binary dependency).
 * Why: docs/forensics/ci-parity.md — the two lost runs, and the two paths ruled out.
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
  /** W1-T2810 — which tree this run measured and under what load, so summary and verdict line cannot drift. */
  runContext?: RunContext;
}

/** Build the durable summary. PURE, and never conditional on `ok`: a FAILING run's summary is the
 *  wanted one. Why: docs/forensics/ci-parity.md. */
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
 * The worker's own preflight verdict, read back out of the worktree it ran in — `undefined` when
 * there is nothing worth saying.
 *
 * INVARIANT: the file cannot be stale. `coverage/` is gitignored, the worktree is cut fresh from
 * `origin/main`, and `runTask` removes it only below the implement dispatch, so a summary found
 * there was written by THIS worker on every exit path.
 *
 * TRAP: silence must stay silence. No file, unreadable JSON, or a PASS all report nothing — a
 * phase line on every dispatch is noise that gets filtered out and then missed.
 * Why: why the orchestrator reads a file at all — docs/forensics/ci-parity.md.
 */
export function preflightFailureNotice(
  repoRoot: string,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(preflightSummaryPath(repoRoot)));
  } catch {
    // Absence is the ordinary case — a worker need not run preflight — so it must never become an exception.
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const summary = parsed as Partial<PreflightSummary>;
  const steps = Array.isArray(summary.steps) ? summary.steps : [];
  const failedSteps = steps.filter((s): s is CiParityStepResult => !!s && typeof s === "object" && s.ok === false);
  // `ok === false` is honoured with no failing step recorded: never dropped for want of a name to print.
  if (summary.ok !== false && failedSteps.length === 0) return undefined;

  const names = failedSteps.map((s) => (typeof s.name === "string" && s.name ? s.name : "(unnamed step)"));
  const total = steps.length;
  const sha = typeof summary.headSha === "string" && summary.headSha ? summary.headSha : "unknown";
  const argv = Array.isArray(summary.args) && summary.args.length ? ` (rmd preflight ${summary.args.join(" ")})` : "";
  const named = names.length ? `: ${names.join(", ")}` : "";
  const counted = total ? `${names.length || summary.failed || "?"} of ${total} step(s) failed` : "the run reported FAIL";
  return `worker preflight FAILED at ${sha} — ${counted}${named}${argv}`;
}

/** A step leaf's outcome before it is named. `matched` is set only by {@link triggerLeaf}. */
interface CiParityLeafResult {
  ok: boolean;
  detail: string;
  matched?: boolean;
  successOutput?: CiParityStepResult["successOutput"];
}

/** One ci.yml job's parity entry. A `mirrored: false` entry MUST carry a `reason` — that is what records it. */
interface CiParityEntry {
  job: string;
  mirrored: boolean;
  reason?: string;
  run?: (repoRoot: string, spawn: PreflightSpawn) => CiParityStepResult[];
}

/** Parse ci.yml's top-level job keys. Pure text-in/array-out, so a falsifier hands it a synthetic document. */
export function parseCiJobNames(ciYamlText: string): string[] {
  const doc = parseYaml(ciYamlText) as { jobs?: Record<string, unknown> } | null;
  return Object.keys(doc?.jobs ?? {});
}

/** The ONE "toolchain unavailable" line, shared by every catch site so the phrasing cannot drift. */
function toolchainFailure(name: string, e: unknown): CiParityStepResult {
  return { name, ok: false, detail: `${name}: FAIL — toolchain unavailable: ${String((e as Error)?.message ?? e)}` };
}

/** Wraps one job's leaf so a thrown error reports as THIS step's own {@link toolchainFailure} —
 *  never aborting the run, never reading as a pass. `fn`'s `detail` is prefixed with `name:`; a
 *  trigger leaf's `matched` rides through untouched. */
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

/** The suite's per-process temp-dir reaper (W1-T131), REQUIRED on both direct `node --test`
 *  spawns here — neither routes through package.json's protected scripts. TRAP: without it each
 *  local preflight leaked one OS-tmpdir directory per fixture. Must ride AFTER `--import tsx`.
 *  Why: the 53,310-directory ENOSPC — docs/forensics/ci-parity.md (W1-T131). */
const TMP_HYGIENE_IMPORT = "./test/setup/tmp-hygiene.ts";

/** An ordinary leaf: run a command, PASS iff it exits 0, echo its output only on FAIL. */
export function shellOut(
  spawn: PreflightSpawn,
  label: string,
  file: string,
  args: string[],
  opts?: { cwd?: string; input?: string; stream?: boolean; env?: NodeJS.ProcessEnv; retainSuccessOutput?: boolean },
): CiParityLeafResult {
  const res = spawn(file, args, opts);
  // TRAP: a child with NO exit status is not an ordinary failure. DELEGATED to
  // {@link spawnFailureDetail}, the ONE implementation of that three-state read — a signalled
  // child reports `status: null` with no error, and a second copy is what drifts.
  // Why: the ENOBUFS that read as a real red test — docs/forensics/ci-parity.md.
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
  // A STREAMED step has no captured text to quote; its output already went to the terminal. Say so,
  // rather than a `FAIL — <label>` and an empty line — the shape an ENOBUFS once wore.
  const captured = (res.stdout + res.stderr).trim();
  const body = opts?.stream ? "(output streamed above as it ran — not re-captured here)" : captured;
  return { ok, detail: `FAIL — ${label}\n${body}` };
}

/** The full-suite leaf. Production takes the contained, hard-bounded route; injected spawns are
 * deterministic test seams and retain their existing synchronous command/argv contract. */
export function boundedSuiteLeaf(
  spawn: PreflightSpawn,
  label: string,
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stream?: boolean },
  timeoutMs = LOCAL_FULL_SUITE_TIMEOUT_MS,
): CiParityLeafResult {
  if (spawn !== defaultPreflightSpawn) return shellOut(spawn, label, file, args, opts);
  const res = runBoundedSuite(file, args, { label, timeoutMs, ...opts });
  if (res.timeout) {
    const lastOutput = res.timeout.lastOutput.trim();
    return {
      ok: false,
      detail:
        `FAIL — ${res.timeout.label} exceeded its ${timeoutMs}ms wall-clock ceiling; its process group was killed with SIGKILL. ` +
        `The suite's failure set is UNVERIFIED.${lastOutput ? ` Last output before termination:\n${lastOutput}` : " No suite output arrived before termination."}`,
    };
  }
  const spawnFailed = spawnFailureDetail(label, res);
  if (spawnFailed) return { ok: false, detail: spawnFailed };
  if (res.status === 0) return { ok: true, detail: `PASS — ${label}` };
  const captured = (res.stdout + res.stderr).trim();
  return { ok: false, detail: `FAIL — ${label}\n${opts.stream ? "(output streamed above as it ran — not re-captured here)" : captured}` };
}

/** A trigger leaf: both trigger scripts exit 0 in EITHER verdict and say matched/skip only in
 *  stdout text, so unlike {@link shellOut} this always folds stdout into the detail and sets
 *  `matched` from it. */
function triggerLeaf(spawn: PreflightSpawn, file: string, args: string[], opts?: { cwd?: string }): CiParityLeafResult {
  const res = spawn(file, args, opts);
  const ok = res.status === 0;
  const text = (res.stdout + res.stderr).trim();
  return { ok, detail: `${ok ? "PASS" : "FAIL"} — ${text}`, matched: /REQUIRED/.test(res.stdout) };
}

/** Run the trigger step, then `buildFollowUps()` only on REQUIRED. A thunk, so a skip builds zero steps. */
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

/** `git fetch origin main` — the merge-base-parity refresh, run ONCE per (spawn, repoRoot) and
 *  reused, so a stale `origin/main` cannot narrow or widen what counts as an added line. The
 *  fetch alone pins nothing: {@link pinnedBase} resolves it to a sha, which is what every diff
 *  site then uses. */
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
  // PIN IMMEDIATELY, while the fetched value is still the fetched value. Every second between the
  // fetch and the resolve is a window in which a sibling can move the ref, so the two belong
  // together rather than at each diff site.
  if (result.ok) pinnedBase(repoRoot, spawn);
  return result;
}

/**
 * W1-T3017 — the base this run diffs against, RESOLVED TO A SHA and cached per (spawn, repoRoot).
 *
 * WHY A SHA AND NOT THE REF. A ref is CLONE-scoped, not process-scoped: any worktree sharing this
 * clone moves `origin/main` for every process at once the moment it fetches, and
 * {@link refreshOriginMain} is itself such a fetch — test/moving-base-changed-files.test.ts states
 * the mechanism outright ("the fleet moves the ref on itself"). So memoizing the FETCH cannot make
 * a run self-consistent; only naming a sha can. What moves is what counts as an ADDED line, so a
 * base that shifts mid-run makes `diff-coverage` gain or lose lines it must cover, and the red
 * names the author's own file.
 *
 * REFUSES, NEVER FALLS BACK TO THE REF NAME. The `lint-plan` entry below previously read
 * `rev-parse origin/main` and fell back with `|| "origin/main"` — which silently restores the
 * moving-ref behaviour at exactly the moment the pin is most needed. {@link runPreflightCoverage}
 * already refuses outright on a base-refresh failure, so refusing here follows the precedent
 * standing beside it rather than inventing a policy.
 */
export type BasePin = { sha: string } | { failure: string };

const basePinCache = new WeakMap<PreflightSpawn, Map<string, BasePin>>();

/** Resolve (and cache) this run's base. A cached FAILURE is returned as-is: within one run the
 *  base must not change its mind, and a retry that succeeded would split the run across two bases. */
export function pinnedBase(repoRoot: string, spawn: PreflightSpawn): BasePin {
  let byRoot = basePinCache.get(spawn);
  if (!byRoot) {
    byRoot = new Map();
    basePinCache.set(spawn, byRoot);
  }
  const cached = byRoot.get(repoRoot);
  if (cached) return cached;
  let pin: BasePin;
  try {
    const res = spawn("git", ["rev-parse", "origin/main"], { cwd: repoRoot });
    const sha = (res.stdout ?? "").trim();
    pin =
      res.status === 0 && /^[0-9a-f]{40}$/.test(sha)
        ? { sha }
        : {
            failure: `could not resolve origin/main to a commit (git rev-parse exited ${res.status}, output ${JSON.stringify(sha)})`,
          };
  } catch (e) {
    // RECORDS, NEVER ERASES — a throw and an unresolvable ref are different facts.
    pin = { failure: `could not resolve origin/main to a commit: ${String((e as Error)?.message ?? e)}` };
  }
  byRoot.set(repoRoot, pin);
  return pin;
}

/** The pin IF ONE WAS TAKEN, resolving nothing. A run with no diff-consuming step has no base, and
 *  reporting one it never used would be the guess the stamp exists to remove. */
export function peekPinnedBase(repoRoot: string, spawn: PreflightSpawn): BasePin | undefined {
  return basePinCache.get(spawn)?.get(repoRoot);
}

/** Test seam only: the cache is process-lifetime by design, so a suite driving several bases
 *  through one spawn needs a way to start clean. Never called from production paths. */
export function clearPinnedBaseForTest(spawn: PreflightSpawn, repoRoot?: string): void {
  const byRoot = basePinCache.get(spawn);
  if (!byRoot) return;
  if (repoRoot === undefined) byRoot.clear();
  else byRoot.delete(repoRoot);
}

/** The pinned sha, or a THROW that {@link runStep} turns into a named failing step. */
function requirePinnedBase(repoRoot: string, spawn: PreflightSpawn): string {
  const pin = pinnedBase(repoRoot, spawn);
  if ("failure" in pin) throw new Error(`REFUSED — ${pin.failure}; refusing to diff against the moving ref instead`);
  return pin.sha;
}

/** The three-dot diff CI's own diff-scoped jobs compute, against this run's PINNED base sha. */
function mergeBaseDiffText(repoRoot: string, spawn: PreflightSpawn): string {
  const res = spawn("git", ["diff", `${requirePinnedBase(repoRoot, spawn)}...HEAD`], { cwd: repoRoot });
  return res.stdout;
}

/**
 * W1-T3013 — THE ONE REFUSAL BOTH COVERAGE MODES REACH when there is no diff to measure.
 *
 * Lifted to a constant rather than written twice: {@link runPreflightCoverage}'s
 * `coverage-mode:diff-scope` arm already refused in these words, and the coverage-ratchet entry
 * needed the same sentence. Two hand-written copies of one refusal are two things to drift.
 */
export const EMPTY_DIFF_COVERAGE_REFUSAL = "origin/main...HEAD (freshly refreshed) is an empty diff; there is no diff to assert coverage over";

/**
 * W1-T3013 — THE THREE-DOT DIFF, CHECKED, because feeding an unchecked one to `diff-coverage.mjs`
 * produces a gate that cannot fail.
 *
 * THE DEFECT THIS EXISTS FOR, and both halves are correct in isolation. {@link mergeBaseDiffText}
 * returns `res.stdout` without reading `res.status`, so a failed `git diff` yields "".
 * `scripts/diff-coverage.mjs` over an empty added-line set reports OK — rightly, since the claim
 * is vacuously true. Composed through the entry's `input:`, a git failure renders as a clean green
 * `diff-coverage` step: the vacuous-pass family CLAUDE.md's coverage section already names,
 * reached from the diff side rather than the lcov side.
 *
 * BOTH CONDITIONS ARE READ BECAUSE THEY CATCH DIFFERENT FAULTS, and neither subsumes the other:
 * a non-zero or null `status` is git ERRORING; an empty `stdout` on a zero status is git
 * SUCCEEDING over a PR that diffs nothing. The second is equally not a coverage result, and is
 * exactly what `coverage-mode:diff-scope` refuses on the other path.
 *
 * REFUSES, NEVER REPAIRS: no retry, no fallback ref, no synthesised diff. A gate that cannot
 * measure says so in its own step.
 *
 * THE DETAIL OPENS WITH `FAIL`, NOT `REFUSED`, and that is this table's contract rather than a
 * preference: test/preflight-ci-parity.test.ts asserts every step detail matches
 * `^<name>: (PASS|FAIL|EXCLUDED)`. {@link runPreflightCoverage} builds its steps by hand, outside
 * that contract, so it keeps its own `REFUSED —` opening. The SENTENCE is what is shared
 * ({@link EMPTY_DIFF_COVERAGE_REFUSAL}); the opening word belongs to each mode's own vocabulary.
 */
function mergeBaseDiffForCoverage(
  repoRoot: string,
  spawn: PreflightSpawn,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly detail: string } {
  const res = spawn("git", ["diff", `${requirePinnedBase(repoRoot, spawn)}...HEAD`], { cwd: repoRoot });
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    return {
      ok: false,
      detail:
        `FAIL — could not compute the origin/main...HEAD diff: \`git diff\` exited ${res.status ?? "null"}` +
        `${stderr ? `: ${stderr.slice(0, 200)}` : ""} — the DIFF could not be measured, so this step is not a coverage result`,
    };
  }
  if ((res.stdout ?? "").trim() === "") return { ok: false, detail: `FAIL — ${EMPTY_DIFF_COVERAGE_REFUSAL}` };
  return { ok: true, text: res.stdout };
}

/** The changed-files list both trigger scripts consume, written once and memoized per (spawn, repoRoot). */
const changedFilesPathCache = new WeakMap<PreflightSpawn, Map<string, string>>();
function changedFilesListPath(repoRoot: string, spawn: PreflightSpawn): string {
  let byRoot = changedFilesPathCache.get(spawn);
  if (!byRoot) {
    byRoot = new Map();
    changedFilesPathCache.set(spawn, byRoot);
  }
  const cached = byRoot.get(repoRoot);
  if (cached) return cached;
  const res = spawn("git", ["diff", "--name-only", `${requirePinnedBase(repoRoot, spawn)}...HEAD`], { cwd: repoRoot });
  const dir = mkdtempSync(join(tmpdir(), "rmd-ci-parity-"));
  const path = join(dir, "changed-files.txt");
  writeFileSync(path, res.stdout, "utf8");
  byRoot.set(repoRoot, path);
  return path;
}

/** The full-suite-with-coverage leaf — ONE instrumented, source-mapped `node --test` run,
 *  `test/**` excluded from the ratio. INVARIANT: shared by BOTH callers (coverage-ratchet and
 *  {@link runPreflightCoverage}), so the one expensive invocation cannot drift the way a
 *  hand-copied argv does. Retried as ci.yml retries (W1-T255).
 *  Why: docs/forensics/ci-parity.md. */
export function coverageScratchDir(repoRoot: string): string {
  return join(repoRoot, "coverage", "tmp");
}

function testWithCoverageLeaf(repoRoot: string, spawn: PreflightSpawn, lcovPath: string): CiParityLeafResult {
  try {
    mkdirSync(join(repoRoot, "coverage"), { recursive: true });
    // CLEARED, NOT JUST CREATED: the runner clears its scratch on a normal exit, so this bounds the abnormal one.
    rmSync(coverageScratchDir(repoRoot), { recursive: true, force: true });
    mkdirSync(coverageScratchDir(repoRoot), { recursive: true });
  } catch {
    // best-effort — an injected spawn may point repoRoot at a fixture needing no coverage/ directory.
  }
  return boundedSuiteLeaf(
    spawn,
    "coverage-ratchet:test-with-coverage (test/**/*.test.ts)",
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

const CI_TEST_SHARD_COUNT = 4;
const CI_DIFF_CLASSES = new Set(["PLAN_ONLY", "DOCS_ONLY", "SOURCE"]);

type CiTestPlan =
  | { kind: "tier-shards"; base: string; diffClass: string }
  | { kind: "source-skip"; reason: string }
  | { kind: "full-suite-fallback"; reason: string };

function ciChangedFilesListPath(
  repoRoot: string,
  spawn: PreflightSpawn,
): { ok: true; path: string; base: string } | { ok: false; reason: string } {
  let base: string;
  try {
    base = requirePinnedBase(repoRoot, spawn);
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message ?? e) };
  }
  const res = spawn("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: repoRoot });
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    return {
      ok: false,
      reason:
        `could not compute changed files for diff classification: git diff exited ${res.status ?? "null"}` +
        `${stderr ? `: ${stderr.slice(0, 200)}` : ""}`,
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "rmd-ci-parity-ci-"));
  const path = join(dir, "changed-files.txt");
  writeFileSync(path, res.stdout, "utf8");
  return { ok: true, path, base };
}

function ciTestPlan(repoRoot: string, spawn: PreflightSpawn): CiTestPlan {
  const changed = ciChangedFilesListPath(repoRoot, spawn);
  if (!changed.ok) return { kind: "full-suite-fallback", reason: changed.reason };
  let res: ReturnType<PreflightSpawn>;
  try {
    res = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "scripts", "diff-class.mjs"), "--changed-files", changed.path], {
      cwd: repoRoot,
    });
  } catch (e) {
    return { kind: "full-suite-fallback", reason: `diff class unavailable: ${String((e as Error)?.message ?? e)}` };
  }
  const spawnFailed = spawnFailureDetail("ci:test diff-class", res);
  if (spawnFailed) return { kind: "full-suite-fallback", reason: `diff class unavailable: ${spawnFailed}` };
  const diffClass = (res.stdout ?? "").trim();
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    return {
      kind: "full-suite-fallback",
      reason: `diff class unavailable: diff-class.mjs exited ${res.status}${stderr ? `: ${stderr.slice(0, 200)}` : ""}`,
    };
  }
  if (!CI_DIFF_CLASSES.has(diffClass)) {
    return { kind: "full-suite-fallback", reason: `diff class unavailable: unrecognised class ${JSON.stringify(diffClass)}` };
  }
  if (diffClass === "SOURCE") {
    return {
      kind: "source-skip",
      reason:
        "W1-T3207: coverage-ratchet owns the single instrumented full-suite run; ci skips the quieter second harness on SOURCE diffs",
    };
  }
  return { kind: "tier-shards", base: changed.base, diffClass };
}

function ciTestSteps(repoRoot: string, spawn: PreflightSpawn): CiParityStepResult[] {
  const plan = ciTestPlan(repoRoot, spawn);
  if (plan.kind === "source-skip") {
    return [runStep("ci:test", () => ({ ok: true, detail: `PASS — SKIPPED — ${plan.reason}` }))];
  }
  if (plan.kind === "full-suite-fallback") {
    return [
      runStep("ci:test", () =>
        boundedSuiteLeaf(
          spawn,
          `ci:test FULL suite fallback (diff class could not be determined — ${plan.reason}; shard 1 owns the FULL suite fallback)`,
          "npm",
          ["run", "test:ci"],
          { cwd: repoRoot, stream: true },
        ),
      ),
    ];
  }
  const shardSteps = Array.from({ length: CI_TEST_SHARD_COUNT }, (_, idx) => {
    const shard = `${idx + 1}/${CI_TEST_SHARD_COUNT}`;
    return runStep(`ci:test:shard-${idx + 1}`, () =>
      boundedSuiteLeaf(
        spawn,
        `ci:test ${plan.diffClass} fast-tier shard ${shard}`,
        process.execPath,
        [
          join(repoRoot, "scripts", "test-with-retry.mjs"),
          process.execPath,
          join(repoRoot, "scripts", "test-tier-manifest.mjs"),
          "--run",
          "fast",
          "--shard",
          shard,
          "--base",
          plan.base,
        ],
        { cwd: repoRoot, stream: true },
      ),
    );
  });
  return [
    runStep("ci:test", () => {
      const ok = shardSteps.every((s) => s.ok);
      return {
        ok,
        detail: `${ok ? "PASS" : "FAIL"} — ${plan.diffClass} fast tier split across ${CI_TEST_SHARD_COUNT} shard(s)`,
      };
    }),
    ...shardSteps,
  ];
}

/** The shared shape for a job whose CI step is exactly an npm script — no re-derived argv to drift. */
function npmScriptEntry(job: string, script: string): CiParityEntry {
  return {
    job,
    mirrored: true,
    run: (repoRoot, spawn) => [runStep(job, () => shellOut(spawn, `npm run --silent ${script}`, "npm", ["run", "--silent", script], { cwd: repoRoot }))],
  };
}

// ── host-caused suite reds (W1-T2234) ──────────────────────────────────────────────────────
//
// INVARIANT — SEPARATION, NEVER SUPPRESSION. `ci:test`'s command, argv and `stream: true` are
// untouched. `ci:host-caused-suite-reds` runs beside it, always reports `ok: true`, and names
// which registered clusters THIS host is expected to produce so a reader can subtract them.
// Anything `ci:test` failed on that is not named here is new or diff-caused, and just as loud.
//
// INVARIANT — HOST FACTS, NEVER `ci:test`'s TEXT, which `stream: true` makes structurally
// unavailable here; that is also why this is not a second `lib/host-parity.ts`.
//
// TRAP: 26 of the suite's reds on a darwin host trace to six machine causes, and no `runs-on:` in
// ci.yml is macos, so no required check has ever seen one.
// Why: the census, its corrected count and the exclusions — docs/forensics/ci-parity.md (W1-T2234).

/** Cheap, host-scoped facts {@link HOST_CAUSED_SUITE_REDS} keys off — never a live `ci:test`
 *  result, which `stream: true` makes unavailable. Every field is injectable, so a test proves
 *  this logic with no darwin machine. */
export interface HostFacts {
  platform: NodeJS.Platform;
  /** `undefined` when `bash` was absent or its version text did not parse: never read as "applies". */
  bashMajorVersion: number | undefined;
  hasProcMeminfo: boolean;
  /** W1-T2770: this process's Node version and the one `.nvmrc` pins, both carried, so a predicate
   *  asks exactly "running differs from pinned" rather than a proxy that rots when `.nvmrc` moves.
   *  `undefined` when `.nvmrc` is absent — "cannot tell, does not apply".
 *  Why: docs/forensics/ci-parity.md (W1-T2770). */
  nodeVersion: string;
  pinnedNodeVersion: string | undefined;
}

/** The leading `\d+` of either `$BASH_VERSION` shape — `undefined` on anything else, never a guessed 0. */
export function parseBashMajorVersion(bashVersionText: string): number | undefined {
  const m = /(\d+)\./.exec(bashVersionText);
  return m ? Number(m[1]) : undefined;
}

/** PURE, on {@link buildPreflightSummary}'s precedent: raw strings in, derived facts out, no spawn. */
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

/** The impure edge: reads `process.platform`, spawns `bash` through the SAME injectable
 *  `PreflightSpawn` seam every step uses, and checks `/proc/meminfo` via an injectable `hasFile`.
 *  An unspawnable `bash` reads as `undefined`, never a thrown error. */
export function detectHostFacts(repoRoot: string, spawn: PreflightSpawn, hasFile: (path: string) => boolean = existsSync): HostFacts {
  let bashVersionText = "";
  try {
    const res = spawn("bash", ["-c", "echo $BASH_VERSION"], { cwd: repoRoot });
    bashVersionText = res.stdout ?? "";
  } catch {
    bashVersionText = "";
  }
  // W1-T2770: `.nvmrc` is a plain file read, so it stays off the `spawn` seam; absent is `undefined`.
  let nvmrcText: string | undefined;
  try {
    nvmrcText = readFileSync(join(repoRoot, ".nvmrc"), "utf8");
  } catch {
    // `undefined` reads as "cannot tell, does not apply". Never guess from a read that did not happen.
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
// {@link HostFacts} answers WHICH MACHINE; this pair answers WHICH TREE and UNDER WHAT LOAD — the
// facts that make a verdict interpretable and that the verdict line did not carry. Same shape as
// its sibling: a pure builder, an impure edge on the one seam, a rendered line (hazard (h)).
// Why: what the verdict line did not carry — docs/forensics/ci-parity.md (W1-T2810).

/** PRIMARY CONTROL: core-normalised 1-minute loadavg at or above which a run is LABELLED loaded.
 *  1.0 means runnable work equals the core count. It GATES NOTHING — it changes a word on a
 *  report, never a verdict — so a round conventional value is right and a measured one would be
 *  false precision. DATA, and exported, so moving it is a data edit.
 *  Why: why PRIMARY and not a wider gate — docs/forensics/ci-parity.md (W1-T2810). */
export const LOADED_RUN_THRESHOLD = 1;

/** One gate run's context. RUN-SCOPED: never an individual assertion's contract (W1-T2811 owns that). */
export interface RunContext {
  /** The head this run measured, or `"unknown"`. */
  headSha: string;
  /** Commits behind `origin/main`; `undefined` when unreadable — NEVER 0, which means "up to date". */
  behindCount: number | undefined;
  /** Why {@link behindCount} is `undefined`, so the reader is told rather than left to guess. */
  behindUnknownReason: string | undefined;
  /** When this checkout last FETCHED `origin/main`, from the reflog — NOT the tip date, which tracks main. */
  originFetchedAt: string | undefined;
  /** W1-T3017 — the base sha every diff-consuming step in this run measured against. ABSENT, never
   *  guessed, when no step pinned a base: a run that took no diff has no base to name, and a
   *  plausible-looking sha it never used is worse than silence. */
  baseSha?: string;
  /** True when the ref moved AFTER this run pinned it — a sibling worktree sharing the clone
   *  fetched mid-run. INFORMATION, NOT A VERDICT: the run's own diffs are unaffected precisely
   *  because they named the sha, and a gate that failed because someone else fetched would be a
   *  bound firing on a healthy condition. `undefined` when there was no pin to compare. */
  baseMovedDuringRun?: boolean;
  /** What the ref points at NOW, present only when it differs from {@link baseSha}. */
  baseShaAtEnd?: string;
  /** Core-normalised 1-minute loadavg at the START of the run; `undefined` when unavailable. */
  loadStart: number | undefined;
  /** The same reading at the END. Both, because one sample answers neither question: a start
   *  sample decays (measured [0.69, 2.37, 2.29] on 4 cpus after a heavy run), and an end-only
   *  sample cannot separate "already busy" from "this gate WAS the load". */
  loadEnd: number | undefined;
  cpuCount: number;
}

/** `undefined` unless every element is finite and one is non-zero: an all-zero triple is not an idle machine. */
export function normalisedLoad(loadavg: readonly number[] | undefined, cpuCount: number): number | undefined {
  if (!loadavg || loadavg.length < 3 || cpuCount <= 0) return undefined;
  if (!loadavg.every((n) => Number.isFinite(n))) return undefined;
  if (loadavg.every((n) => n === 0)) return undefined;
  return loadavg[0] / cpuCount;
}

/** The `origin/main@{<iso>}` selector a `git reflog show --format=%gd` line carries — never a guessed stamp. */
export function parseReflogFetchStamp(reflogText: string | undefined): string | undefined {
  if (reflogText === undefined) return undefined;
  const m = /@\{([^}]+)\}/.exec(reflogText.trim());
  return m ? m[1] : undefined;
}

/** PURE, same precedent as {@link computeHostFacts}: the caller owns every impure read. */
export function computeRunContext(input: {
  headSha: string;
  /** stdout of `git rev-list --count HEAD..origin/main`, or `undefined` when that read FAILED. */
  behindText: string | undefined;
  /** What went wrong, CARRIED rather than assumed: a shallow clone is common but not the only cause. */
  behindFailure?: string | undefined;
  /** stdout of `git reflog show --date=iso-strict --format=%gd -n 1 origin/main`, or undefined. */
  reflogText: string | undefined;
  loadavgStart: readonly number[] | undefined;
  loadavgEnd: readonly number[] | undefined;
  cpuCount: number;
  /** The sha this run's diff steps pinned, or `undefined` when none did. */
  baseSha?: string;
  /** What `origin/main` resolves to at the END of the run, for the drift comparison. */
  baseShaAtEnd?: string;
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
    // ABSENT, NOT FALSE. `baseMovedDuringRun` is a comparison, so with nothing to compare it has
    // no answer — and `false` would assert the base held still, which is a stronger claim than the
    // evidence supports.
    ...(input.baseSha !== undefined ? { baseSha: input.baseSha } : {}),
    ...(input.baseSha !== undefined && input.baseShaAtEnd !== undefined
      ? {
          baseMovedDuringRun: input.baseShaAtEnd !== input.baseSha,
          ...(input.baseShaAtEnd !== input.baseSha ? { baseShaAtEnd: input.baseShaAtEnd } : {}),
        }
      : {}),
    loadStart: normalisedLoad(input.loadavgStart, input.cpuCount),
    loadEnd: normalisedLoad(input.loadavgEnd, input.cpuCount),
    cpuCount: input.cpuCount,
  };
}

/** The stamp, on BOTH verdict branches. The PASSING one is the point: a stale GREEN is never questioned. */
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
  // W1-T3017 — WHICH base, not just how far from it. `behind=` is a distance that decays the
  // moment main advances; the sha is what makes a verdict reproducible, and the drift clause is
  // the only place a mid-run move is ever reported.
  const base =
    ctx.baseSha === undefined
      ? ""
      : ctx.baseMovedDuringRun === true
        ? `, base=${ctx.baseSha} (origin/main moved to ${ctx.baseShaAtEnd ?? "unknown"} during this run; the diffs above are unaffected — they named the sha)`
        : `, base=${ctx.baseSha}`;
  return `context: sha=${ctx.headSha}${base}, ${behind}, ${fetched}, ${load}`;
}

const MERGE_BASE_RELATIVE_STEP_NAMES = new Set([
  "coverage-ratchet:diff-coverage",
  "comment-load-ratchet",
  "source-size",
  "coverage-mode:diff-coverage",
]);

/** The steps whose verdicts are relative to the merge base, filtered to THIS run's own entries. */
export function mergeBaseRelativeStepNames(steps: readonly CiParityStepResult[]): string[] {
  return [...new Set(steps.map((s) => s.name).filter((name) => MERGE_BASE_RELATIVE_STEP_NAMES.has(name)))].sort();
}

/** Advisory only: a stale or unreadable checkout is reported beside the affected entries, never refused. */
export function runTreeAdvisoryLine(ctx: RunContext, steps: readonly CiParityStepResult[]): string | undefined {
  const names = mergeBaseRelativeStepNames(steps);
  if (names.length === 0) return undefined;
  if (ctx.behindCount === 0) return undefined;
  const distance =
    ctx.behindCount === undefined
      ? `behind=UNKNOWN (${ctx.behindUnknownReason ?? "unreadable"})`
      : `behind=${ctx.behindCount}`;
  return `tree advisory: ${distance}; merge-base-relative entries in this run: ${names.join(", ")}`;
}

function fmtLoad(v: number | undefined): string {
  return v === undefined ? "?" : v.toFixed(2);
}

/** TRUE when EITHER sample reached {@link LOADED_RUN_THRESHOLD} — either, because either can red a bound. */
export function isLoadedRun(ctx: RunContext): boolean {
  return (ctx.loadStart ?? 0) >= LOADED_RUN_THRESHOLD || (ctx.loadEnd ?? 0) >= LOADED_RUN_THRESHOLD;
}

/**
 * The impure edge. Reads git through the SAME injectable `PreflightSpawn` seam, and the load
 * through injectable `loadavg`/`cpuCount` so a test drives the threshold without a busy machine.
 * INVARIANT — NEVER FETCHES: a local gate must not acquire a network dependency, and this is the
 * one command every session runs before its first push; the fetch AGE is reported instead.
 * TRAP: read the unknown signal from the spawn result's `status`, never from a pipeline — a
 * `| head -2` reports the PIPE's status, so a git that failed 128 read as success.
 * Why: docs/forensics/ci-parity.md (W1-T2810).
 */
export function detectRunContext(input: {
  repoRoot: string;
  headSha: string;
  spawn: PreflightSpawn;
  loadavgStart: readonly number[] | undefined;
  loadavgEnd: readonly number[] | undefined;
  cpuCount: number;
  /** The sha this run's diff steps pinned ({@link peekPinnedBase}), or `undefined` when none did. */
  baseSha?: string;
}): RunContext {
  // RECORDS, NEVER ERASES. A catch returning the same `undefined` an empty read produces would
  // fold "the read failed" into "there was nothing to read" — the erasure shape
  // test/catch-erasure-ratchet.test.ts exists to stop.
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
  // W1-T3017 — the END-of-run value of the ref, read ONLY to compare against what this run pinned.
  // A local `rev-parse` is not a fetch, so the NEVER FETCHES invariant above is untouched; and it
  // is read only when there is a pin to compare it with, so an unpinned run spawns nothing extra.
  const pinned = input.baseSha;
  const atEnd = pinned === undefined ? undefined : read(["rev-parse", "origin/main"]);
  return computeRunContext({
    headSha: input.headSha,
    ...(pinned !== undefined ? { baseSha: pinned } : {}),
    ...(atEnd !== undefined && "text" in atEnd && atEnd.text.trim() !== ""
      ? { baseShaAtEnd: atEnd.text.trim() }
      : {}),
    behindText: "text" in behind ? behind.text : undefined,
    behindFailure: "reason" in behind ? behind.reason : undefined,
    reflogText: "text" in reflog ? reflog.text : undefined,
    loadavgStart: input.loadavgStart,
    loadavgEnd: input.loadavgEnd,
    cpuCount: input.cpuCount,
  });
}

/** One of the census's causes — `count` and `file` are MEASURED, `appliesTo` is the cheap
 *  host-fact predicate deciding whether THIS host reproduces it. INVARIANT: never a test NAME,
 *  which would need `ci:test` output this module cannot capture. */
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

/** The `ci:host-caused-suite-reds` leaf — ALWAYS `ok: true`, naming by file/cause/count what this host produces. */
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

/** One entry per .github/workflows/ci.yml job. The drift step fails the moment
 *  {@link parseCiJobNames} finds a job this table does not name; `mirrored: false` is a reasoned
 *  exclusion, never a gap. */
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
      ...ciTestSteps(repoRoot, spawn),
      // W1-T2234: named separately from ci:test, never gating it — see the file comment above
      // "ci:host-caused-suite-reds". This only ADDS a report of which known clusters this host is
      // expected to produce, so a red ci:test on a non-CI host can be told apart from this diff's own.
      runStep("ci:host-caused-suite-reds", () => hostCausedSuiteRedsStep(detectHostFacts(repoRoot, spawn))),
    ],
  },
  {
    // W1-T3177 — the dashboard's own job, MIRRORED rather than excluded: it is a deterministic,
    // offline npm-script gate, so the local run can be the same commands rather than an argument
    // that they are equivalent. `dashboard:ci` is the one script the ci.yml job's three steps also
    // run, in the same order, so the job and this mirror cannot diverge without that script
    // changing. Typecheck is separate from the build on purpose: `vite build` transpiles per-file
    // through oxc and does NOT typecheck, so a build-only mirror goes green on a type error.
    job: "dashboard",
    mirrored: true,
    run: (repoRoot, spawn) => [
      runStep("dashboard:ci", () => {
        const r = spawn("npm", ["run", "--silent", "dashboard:ci"], { cwd: repoRoot });
        const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
        return r.status === 0
          ? { ok: true, detail: "PASS -- dashboard typechecks, its Vitest suite passes and the console bundle emits" }
          : { ok: false, detail: `FAIL -- ${out.slice(-400) || `exit ${String(r.status)}`}` };
      }),
    ],
  },
  {
    job: "test-slow",
    mirrored: false,
    reason:
      "W1-T2904 — runs scripts/test-tier-manifest.json's slow-tier subset, already a SUBSET of the complete " +
      "test/**/*.test.ts surface the 'ci' entry above runs locally via npm run test:ci; CI requires the split " +
      "job, while a local dry run gains nothing by re-running part of the complete local surface",
  },
  {
    job: "flake-retry-aggregate",
    mirrored: false,
    reason:
      "W1-T2904 — GitHub-only best-effort aggregation of per-shard FLAKE-RETRY artifacts; " +
      "it changes no test verdict and has no useful local equivalent beyond the unit-tested parser",
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
        // W1-T3013: the diff is CHECKED before it becomes stdin. An unchecked one turns a git
        // failure into a green step, because diff-coverage.mjs is right to pass over an empty
        // added-line set — the gate was asking it a question it cannot refuse.
        const diff = mergeBaseDiffForCoverage(repoRoot, spawn);
        if (!diff.ok) return { ok: false, detail: diff.detail };
        return shellOut(spawn, "diff-coverage.mjs (origin/main...HEAD, refreshed base)", process.execPath, [join(repoRoot, "scripts", "diff-coverage.mjs"), "--lcov", lcovPath], {
          cwd: repoRoot,
          input: diff.text,
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
  npmScriptEntry("comment-load-ratchet", "comment-load-signal"),
  npmScriptEntry("claims", "claims"),
  {
    job: "lint-plan",
    mirrored: true,
    run: (repoRoot, spawn) => {
      const refresh = runStep("lint-plan:base-refresh", () => refreshOriginMain(repoRoot, spawn));
      // OUTSIDE any runStep, DELIBERATELY: a pin failure here must reach runCiParity's TOP-LEVEL
      // catch and report `lint-plan:error`. That is the only production caller exercising that
      // catch, and test/preflight-ci-parity.test.ts asserts it by name — moving this inside a
      // runStep would leave the top-level arm covered by nothing.
      const base = requirePinnedBase(repoRoot, spawn);
      const lint = runStep("lint-plan:ci-parity", () =>
        shellOut(spawn, "npm run --silent lint-plan -- --base <pinned origin/main>", "npm", ["run", "--silent", "lint-plan", "--", "--base", base], { cwd: repoRoot }),
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
  // W1-T3077: the prompt-surface gate, mirrored. Deterministic and offline — it reads a merge-base
  // diff and refuses a prompt/learnings edit that carries no golden evidence; it never shells the
  // network or node --test. Written in the EXPLICIT object form rather than through npmScriptEntry
  // for the same reason the source-size and baseline-monotonic entries below record: Standing rule
  // 25's introducing-commit carve-out (isIntroducingCiYmlJob, review.ts) keys on an ADDED line
  // carrying `job: "<name>"` beside the added ci.yml job key, and THIS PR adds both.
  {
    job: "prompt-surface-gate",
    mirrored: true,
    run: (repoRoot, spawn) => [
      runStep("prompt-surface-gate", () =>
        shellOut(spawn, "npm run --silent prompt-surface-gate", "npm", ["run", "--silent", "prompt-surface-gate"], { cwd: repoRoot }),
      ),
    ],
  },
  // W1-T1048: the task-id existence gate is exactly the shared npm-script shape — deterministic,
  // unconditional on every PR, and measured at ~1.1s, so it is mirrored rather than excluded.
  npmScriptEntry("task-id-existence", "task-id-existence:check"),
  // W1-T2883/W1-T3140: the stable source-size context, mirrored. Written in the EXPLICIT object form rather than
  // through npmScriptEntry because Standing rule 25's introducing-commit carve-out
  // (isIntroducingCiYmlJob, review.ts) keys on an ADDED line carrying `job: "<name>"` beside the
  // added ci.yml job key — the helper's shorthand emits no such line, so the same PR would read
  // instrument-entangled and be refused.
  {
    job: "source-size",
    mirrored: true,
    run: (repoRoot, spawn) => [
      runStep("source-size", () =>
        shellOut(spawn, "npm run --silent source-size-signal", "npm", ["run", "--silent", "source-size-signal"], { cwd: repoRoot }),
      ),
    ],
  },
  // W1-T2906: the baseline-monotonic gate, mirrored. Written in the EXPLICIT object form rather
  // than through npmScriptEntry for the same reason as the source-size entry directly above —
  // Standing rule 25's introducing-commit carve-out (isIntroducingCiYmlJob, review.ts) keys on an
  // ADDED line carrying `job: "<name>"` beside the added ci.yml job key.
  {
    job: "baseline-monotonic",
    mirrored: true,
    run: (repoRoot, spawn) => [
      runStep("baseline-monotonic", () =>
        shellOut(spawn, "node scripts/baseline-monotonic-check.mjs", process.execPath, [join(repoRoot, "scripts", "baseline-monotonic-check.mjs")], { cwd: repoRoot }),
      ),
    ],
  },
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

/** `rmd preflight --ci-parity`'s engine. Prepends `ci-parity:drift` (red the moment ci.yml names
 *  a job this table doesn't) to each entry's steps, running EVERY entry regardless of an earlier
 *  outcome. `ok` is the AND of them all. */
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
// A THIRD, ADDITIVE mode on the same verb: it runs ONLY the curated list below, so a two-second
// check like `claims` is reachable without shelling the full suite `--ci-parity`'s `ci` entry pays.
//
// INVARIANT — THIS MUST NEVER BECOME `npm test` (design iii). {@link runPreflightFast} only ever
// invokes `npm run --silent <script>` for a script named in {@link FAST_GATE_STEPS}, and every
// such script runs AT MOST one named file, never a glob.
//
// INVARIANT — ADMISSION IS A MEASURED COST, NEVER A MECHANISM (W1-T2478). A step qualifies if it
// is deterministic, runs in seconds, and has blocked a PR or is the identical shape as one that
// has. `boundMs` is the PRIMARY CONTROL timing each census step, replacing the old "never spawns
// `node --test`" proxy that was blind to the suite catching #3304's shape.
//
// INVARIANT — THE CENSUS ENTRIES ARE A PROJECTION (W1-T2643) of {@link CENSUS_POPULATION}, so an
// admitted member with no step cannot occur.
// Why: the measured costs and the (a)-(d) predicate in full — docs/forensics/ci-parity.md.

/** THE PRIMARY CONTROL (W1-T2478): the wall-clock ceiling every census entry's own npm-script
 *  invocation is timed against. 2000ms, and the number IS the enforcement — the literal value a
 *  real `Date.now()` delta is compared against on every run. */
export const FAST_GATE_CENSUS_BOUND_MS = 2000;

/**
 * W1-T2545 — THE BOUND ABOVE IS THE SOFT ONE; THE REFUSAL IS RELATIVE.
 *
 * TRAP: a census entry's cost grows with the corpus it walks, so a fixed ceiling ejects its own
 * entries over time, silently restoring the blindness W1-T2478 closed. MEASURED: the same entry
 * read 2509ms locally and 2268/2250ms on GitHub runners while main's `ci` passed.
 *
 * INVARIANT: refusal is measured against the SAME RUN's cheapest census entry, a ratio a slow
 * machine cannot manufacture; the soft bound still REPORTS its cost, so growth is visible first.
 * Why: docs/forensics/ci-parity.md (W1-T2545).
 */

/** The same-run reference is floored, so one unusually cheap entry cannot make the ratio harsh for its siblings. */
export const FAST_GATE_CENSUS_REFERENCE_FLOOR_MS = 1000;

/** How many times the same run's cheapest census entry an entry may cost before it is refused as
 *  RUNAWAY. Sized against the measured spread (2026-08-31: 960/1128/2344/2615ms), so a
 *  merely-grown suite passes and one doing several times its sibling's work does not. */
export const FAST_GATE_CENSUS_RUNAWAY_MULTIPLE = 4;

/** This run's refusal threshold, from this run's own census durations; `undefined` when none ran. */
export function censusRunawayThresholdMs(durationsMs: readonly number[]): number | undefined {
  if (durationsMs.length === 0) return undefined;
  const reference = Math.max(FAST_GATE_CENSUS_REFERENCE_FLOOR_MS, Math.min(...durationsMs));
  return reference * FAST_GATE_CENSUS_RUNAWAY_MULTIPLE;
}

// ── W1-T2643: THE CENSUS POPULATION IS AN ENUMERATED SET WITH A VERDICT, NEVER A COMMENT ───────
//
// Every file the recognizer finds gets exactly one entry carrying a verdict: ADMITTED (projected
// into {@link FAST_GATE_STEPS}, never hand-added there), REFUSED for cost (a dated, reproducible
// NUMBER), or REFUSED on the predicate (naming WHICH of clauses (a)/(b)/(c) it fails, so
// "considered and excluded" is never confused with "never looked at").
//
// INVARIANT: ONE CENSUS PREDICATE, NEVER TWO — `discoverSrcFilteredLsFilesCallers` below is
// W1-T2523's own recognizer, reused rather than re-derived.
//
// TRAP: a refusal stated only in prose is indistinguishable from a suite nobody remembered.
// `censusPopulationDrift` keeps this checkable, so a second census-shaped suite is UNKNOWN until
// this population names it, never silently absorbed.
// Why: every `measuredMs` re-measurement — docs/forensics/ci-parity.md (W1-T2643).

/** Which predicate clause a candidate fails, for a member REFUSED on the predicate rather than on cost. */
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

/** One test file the recognizer found, carrying its verdict. `script` is meaningful only for an
 *  ADMITTED member — what the census step table is DERIVED from, never hand-duplicated onto.
 *  `walks` is broader: a cost-refused suite can still name the population a diff joins. */
export interface CensusPopulationMember {
  readonly testFile: string;
  readonly job: string;
  readonly script?: string;
  readonly walks?: readonly string[];
  readonly reason: string;
  readonly verdict: CensusVerdict;
}

/** Job-name slug for a REFUSED member — an ADMITTED entry's `job` names its real step instead. */
function censusJobSlug(testFile: string): string {
  return `${testFile.replace(/^test\//, "").replace(/\.test\.ts$/, "")}-census`;
}

/** A member refused for failing the predicate, never for cost — `clause` names which of (a)/(b)/(c). */
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
    testFile: "test/ledger-literal-census.test.ts",
    job: "ledger-literal-census",
    script: "census:ledger-literal",
    walks: ["src/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/ via git ls-files, reads each file's text and asserts a " +
      "property EVERY enumerated file must hold (no ledger-filename literal outside its own declared ALLOWED exemptions table), which is " +
      "clause (a) SATISFIED rather than a search for call sites. Structurally identical to the catch-erasure and bound-kind " +
      "members beside it. MEASURED 2026-09-08, three runs alone: 338/452/456ms, median 452ms — well under " +
      "FAST_GATE_CENSUS_BOUND_MS, so neither the predicate nor the cost gave a reason to refuse it. ADMITTED rather than " +
      "refused because the fast lane exists to catch exactly this class before a full CI cycle",
    verdict: { status: "ADMITTED", measuredMs: 452 },
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
    testFile: "test/authority-ratchet.test.ts",
    job: "authority-census",
    script: "census:authority",
    walks: ["src/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/**/*.ts, asserts every file with a detectable external write " +
      "(assertLiveWriteAllowed call, gh REST write-verb argv, gh pr/issue create-merge-comment-close argv, or raw git push argv) " +
      "against its own AUTHORITY_TABLE baseline (src/lib/authority.ts) by module; measured well under the bound below",
    verdict: { status: "ADMITTED", measuredMs: 520 },
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
    "test/comment-load-ratchet.test.ts",
    "a",
    "the comment-load ratchet's own falsifier suite. The recognizer's text heuristic matches it on an `ls-files` mention in its " +
      "header prose plus the `src/` fixture paths in its bodies, but the suite makes no such call over the tracked tree: its own " +
      "git calls build a throwaway fixture repo under mkdtemp, and its baseline-coverage assertion reads the population from the " +
      "script's exported listMeasuredFiles rather than walking src/ itself",
  ),
  refusedForPredicate(
    "test/config-fixture-path-parity.test.ts",
    "a",
    "`git ls-files test` is scoped to test/ only, never src/",
  ),
  refusedForPredicate(
    "test/deploy-scripts-use-mktemp.test.ts",
    "a",
    "W1-T2915's deploy-script census. Its `git ls-files deploy/*.sh` walks the DEPLOY population — shell scripts, never src/*.ts — " +
      "and the `src/` string the recognizer sees is one comment citing src/lib/tmp.ts's sweepStaleTempDirs as the reason the " +
      "`rmd-` prefix is load-bearing",
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
  // W1-T2809's own suite. Same self-reference shape as its siblings: it is ABOUT the recognizer,
  // so it necessarily carries both idiom tokens and `src/` in its own text.
  refusedForPredicate(
    "test/census-discovery-is-blind-to-a-second-idiom.test.ts",
    "a",
    "W1-T2809's own control. Its `git ls-files test/*.test.ts` walks the TEST population as the corpus it re-derives the " +
      "two idiom sets from — never src/ — and it asserts about DISCOVERY, not a property of every src/ file. The `src/` " +
      "strings the recognizer sees are its own fixture bodies and the paths of the PR (#2639) the positive control is " +
      "anchored to",
  ),
  refusedForPredicate(
    "test/an-unmodelled-census-is-named-with-what-it-walks.test.ts",
    "a",
    "W1-T3238's own proof file. It fabricates census-shaped fixture text containing both `ls-files` and dir-walk idioms " +
      "so the membership reporter can prove candidates stay visible, but its real assertions are about that reporter and " +
      "mocked discovery inputs — it never walks the tracked src/ population and asserts no per-src-file property",
  ),
  // W1-T2905's own suite. SCOPE NOTE: the shard's `files:` names only the census test and its
  // baseline; this entry is here because `censusPopulationDrift` REFUSES an undisclosed
  // census-shaped file, and that gate cannot be satisfied from inside the two declared paths. The
  // widening is one refusal row, no behaviour.
  // W1-T2849: same shape as the entry below — this file's SUBJECT is the rule-citation gate's
  // engine portability, and its criterion-3 assertion happens to walk the tree. It is here because
  // `censusPopulationDrift` REFUSES an undisclosed census-shaped file and that gate cannot be
  // satisfied from inside the task's declared paths. One refusal row, no behaviour.
  // W1-T3021: this task's own falsifier. It is here for the reason the two entries below it are —
  // `censusPopulationDrift` refuses an undisclosed census-shaped file — and it was caught by the
  // very widening it ships, LOCALLY and while still untracked, which is the whole point.
  refusedForPredicate(
    "test/census-discovery-sees-the-file-you-are-adding.test.ts",
    "a",
    "W1-T3021's discovery falsifier. It walks NOTHING: every git call it makes runs inside a throwaway fixture " +
      "repository it created, and the `ls-files` the recognizer sees is a FIXTURE BODY string (the census-shaped " +
      "suite text it writes into that fixture), not an enumeration this file performs over the real tree. The " +
      "`src/` strings are its own import paths. Same self-match shape as the two entries below.",
  ),
  refusedForPredicate(
    "test/rule-citation-gate-engine-portable.test.ts",
    "a",
    "W1-T2849's engine-portability suite. Its `git ls-files -- *.ts *.mjs *.sh` does enumerate a set that includes " +
      "src/, and its loop and assertion are in-file, so it satisfies (b). It fails (a) on WHAT IT ASSERTS OVER: the " +
      "property is a fact about `git grep` CALL SITES — one line in the whole tree at the time of writing — not a " +
      "property every enumerated file must hold, so the enumeration is a search for call sites rather than the " +
      "population under test. The `src/` strings the recognizer sees are this file's own pathspec default and its " +
      "assertion messages. NOTE FOR A LATER READER: admission is the defensible alternative and was NOT taken here — " +
      "it is a measured cost decision that changes FAST_GATE_STEPS composition, which a build pass should not make " +
      "unilaterally. If an operator judges (a) satisfied, this row becomes an ADMITTED entry with a measured ms.",
  ),
  refusedForPredicate(
    "test/source-text-assertion-census.test.ts",
    "a",
    "W1-T2905's source-text ratchet. Its `git ls-files test/*.test.ts` walks the TEST population and asserts a per-file " +
      "readFileSync-of-src count against scripts/source-text-assertion-baseline.json — so it satisfies (b) and (c) but " +
      "inverts (a): src/ is what its predicate LOOKS FOR inside test files, never the population it enumerates. The `src/` " +
      "strings the recognizer sees are that predicate's own regexes and its fixture bodies, the same self-match shape as " +
      "test/a-census-suite-is-unreachable-from-the-symbols-a-diff-changes.test.ts above",
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
  // W1-T3272's own census. It DOES shell a real `git ls-files` (unlike the three entries above,
  // which fail clause (a) for making no such call at all) — but the population it walks is
  // `test/*.test.ts`, the TEST corpus, not `src/`. Clause (a) asks whether a candidate is a
  // SRC-population walk, and every ADMITTED member above carries `walks: ["src/"]` for exactly
  // that reason. So this is refused on the same clause by a different route, and the distinction
  // is recorded here because the next reader will see a genuine `git ls-files` and expect ADMITTED.
  // It is also why this suite is NOT projected into FAST_GATE_STEPS: the census it covers runs as
  // a step on `comment-load-ratchet`, and an ADMITTED member with no npm script of its own cannot
  // be projected (CENSUS_ADMITTED_MEMBERS narrows on `script`).
  // W1-T3086's shard-lint ratchet. The recognizer matches it on the `src/` text of its two imports
  // (src/lib/plan.js, src/lib/task-linter.js) plus a real `git ls-files` — but that call is
  // `git ls-files plan/tasks.d/*.yaml plan/tasks.d/*.yml`, the PLAN shard population, and the
  // tracked src/ tree it never reads. Same shape as the deploy-scripts-use-mktemp member above,
  // which walks deploy/*.sh.
  refusedForPredicate(
    "test/every-shard-on-main-is-lintable.test.ts",
    "a",
    "W1-T3086's shard-lint ratchet. Its `git ls-files` is scoped to `plan/tasks.d/*.yaml` and " +
      "`plan/tasks.d/*.yml` — the PLAN shard population, never src/*.ts — so it is not a " +
      "src-population walk. The `src/` strings the recognizer sees are its imports of " +
      "src/lib/plan.js and src/lib/task-linter.js, the code it drives, not a population it reads",
  ),
  refusedForPredicate(
    "test/expiring-fixture-census.test.ts",
    "a",
    "this file — W1-T3272's expiring-fixture census; it shells a real `git ls-files` but over " +
      "`test/*.test.ts`, the TEST corpus, so it is not a src-population walk. Its gate rides the " +
      "`comment-load-ratchet` job as a step rather than a projected fast-gate census entry",
  ),
  // W1-T2916's suite. The recognizer matches it on `src/` text that is its import of
  // src/lib/settings.js plus prose ("src runtime package uses are dependencies"), but the
  // population it actually enumerates is package.json's own dependency maps read against
  // .dependency-cruiser.cjs — two fixed config files. The tracked `src/` population it never reads.
  refusedForPredicate(
    "test/dependency-declarations-match-use.test.ts",
    "a",
    "enumerates package.json's dependency/override maps and .dependency-cruiser.cjs, two fixed config files, " +
      "never the tracked src/ population; the src/ text the recognizer matches is its settings.js import and its prose",
  ),
  // Recon 2026-09-05 R-18's proof file. It shells a REAL `git ls-files` — unlike the four
  // self-referential entries directly above, whose only real git call is `git grep` — but against
  // a THROWAWAY fixture repo it builds in a temp dir, naming ONE path, purely to prove that
  // fixture's `escape` entry is a genuinely COMMITTED symlink (mode 120000) rather than a local
  // filesystem accident. The tracked `src/` population it never reads; the `src/` text the
  // recognizer matches on is its import of src/lib/review.js and its prose. Clause (a).
  refusedForPredicate(
    "test/proof-grep-target-stays-inside-checkout.test.ts",
    "a",
    "`git ls-files -s escape` runs inside a throwaway fixture repo and reads ONE fixture path (asserting mode 120000, i.e. a " +
      "committed symlink) — it is not a walk of the tracked src/ population and asserts nothing over any tree-wide set",
  ),
  refusedForPredicate(
    "test/env-var-registry.test.ts",
    "a",
    "W1-T2900's harness-env registry suite. Its `git ls-files src/**/*.ts` DOES enumerate the tracked src/ population and it " +
      "reads each file's text, so it satisfies (b) and (c). It fails (a) on WHAT IT ASSERTS OVER: the property is a SET " +
      "EQUALITY between the `RMD_`/`REMUDERO_` literals found anywhere in that text and ENV_REGISTRY's names — a fact about " +
      "the tree-wide literal set, not a property each enumerated file must hold. A src file containing no env literal " +
      "contributes nothing and is asserted over in no way, which is the same shape as " +
      "test/rule-citation-gate-engine-portable.test.ts above: the enumeration is a SEARCH for call sites rather than the " +
      "population under test. " +
      "NOTE FOR A LATER READER, and the numbers are supplied so the decision needs no re-measurement: this suite is CHEAP — " +
      "`node --test --import tsx --import ./test/setup/tmp-hygiene.ts test/env-var-registry.test.ts`, alone, measured " +
      "2026-09-07 at 243/215/213ms across three runs (median 215ms), far under FAST_GATE_CENSUS_BOUND_MS. So cost is NOT the " +
      "reason it sits here, and admission is the defensible alternative. It was NOT taken: admission changes FAST_GATE_STEPS " +
      "composition, which the entry above records as a decision a build pass must not make unilaterally. If an operator " +
      "judges (a) satisfied, this row becomes an ADMITTED entry with `script: \"census:env-var-registry\"` and that measured ms.",
  ),
];

// W1-T2644: the roster is the population, re-exported under the name that task's acceptance
// criterion names. An ALIAS, deliberately never a second array — a reader who greps either name
// finds the SAME data. Why: docs/forensics/ci-parity.md (W1-T2644).
export const CENSUS_SUITE_ROSTER: typeof CENSUS_POPULATION = CENSUS_POPULATION;

export const CENSUS_ADMITTED_MEMBERS: readonly (CensusPopulationMember & {
  readonly script: string;
  readonly verdict: { readonly status: "ADMITTED"; readonly measuredMs: number };
})[] = CENSUS_POPULATION.filter(
  (m): m is CensusPopulationMember & { script: string; verdict: { status: "ADMITTED"; measuredMs: number } } =>
    m.verdict.status === "ADMITTED",
);

/** THE PROJECTION: every census step is computed FROM {@link CENSUS_ADMITTED_MEMBERS}, never beside it. */
const CENSUS_FAST_GATE_STEPS: { job: string; script: string; reason: string; boundMs: number }[] = CENSUS_ADMITTED_MEMBERS.map(
  (m) => ({ job: m.job, script: m.script, reason: m.reason, boundMs: FAST_GATE_CENSUS_BOUND_MS }),
);

/** W1-T2809 — WHICH ENUMERATION IDIOM a candidate was recognised BY. TRAP: the recognizer
 *  implemented ONE (`git ls-files`) and was blind to the other; the populations MEASURED disjoint
 *  at 28 and 84 suites sharing one member, hazard (j)'s instance being in the second set only. */
export type CensusEnumerationIdiom = "ls-files" | "dir-walk";

/** One census-shaped candidate and its idiom. `ls-files` takes PRECEDENCE where both tokens appear,
 *  so {@link censusPopulationDrift}'s gated population is byte-for-byte what it was before. */
export interface CensusCandidate {
  readonly testFile: string;
  readonly idiom: CensusEnumerationIdiom;
  readonly walks: readonly string[];
}

function normalizeCensusWalk(raw: string): string | undefined {
  const normalized = raw.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
  const match = /(?:^|\/)(src|test|scripts)(?:\/[^"'`,)\]} ]*)?|(?:^|\/)(plan\/tasks\.d)(?:\/[^"'`,)\]} ]*)?/.exec(
    normalized,
  );
  if (!match) return undefined;
  const walk = match[0].replace(/^\//, "");
  if (walk === "src" || walk === "test" || walk === "scripts" || walk === "plan/tasks.d") return `${walk}/`;
  return walk;
}

function censusWalksFromText(text: string): string[] {
  const walks: string[] = [];
  const joinCall = /\bjoin\s*\(([^)]*)\)/g;
  const quoted = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const match of text.matchAll(quoted)) {
    const walk = normalizeCensusWalk(match[2]);
    if (walk) walks.push(walk);
  }
  for (let call = joinCall.exec(text); call; call = joinCall.exec(text)) {
    const segments = [...call[1].matchAll(quoted)].map((m) => m[2]);
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment === "src" || segment === "test" || segment === "scripts") {
        walks.push(normalizeCensusWalk([segment, ...segments.slice(i + 1)].join("/")) ?? `${segment}/`);
      }
      if (segment === "plan" && segments[i + 1] === "tasks.d") {
        walks.push(normalizeCensusWalk(segments.slice(i, i + 2).join("/")) ?? "plan/tasks.d/");
      }
    }
  }
  return walks;
}

export function censusCandidateWalks(text: string): string[] {
  const walks = new Set<string>();
  const idiom = /ls-files|readdirSync|globSync/g;
  for (let match = idiom.exec(text); match; match = idiom.exec(text)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEnd = text.indexOf("\n", match.index);
    const windowEnd = lineEnd === -1 ? text.length : Math.min(text.length, lineEnd + 1);
    const window = text.slice(lineStart, windowEnd);
    for (const walk of censusWalksFromText(window)) walks.add(walk);
  }
  if (/(?:src\/|["'`]src["'`])/.test(text) && ![...walks].some((walk) => walk.startsWith("src/"))) walks.add("src/");
  return [...walks].sort();
}

/**
 * THE LABEL, EXPORTED RATHER THAN LEFT IN A COMMENT — a comment can be deleted silently; a
 * referenced constant cannot, because the test asserting it would not compile. W1-T2809 mandates
 * the second matcher ship labelled, "never silently, because A STOPGAP THAT SHIPS UNLABELLED
 * BECOMES PERMANENT". TRAP: matcher #2 is blind to idiom #3 exactly as #1 was blind to #2; the
 * successor is THE SEAM (W1-T2790's ratified ordering).
 * Why: docs/forensics/ci-parity.md (W1-T2809).
 */
export const CENSUS_DIR_WALK_STOPGAP =
  "STOPGAP (W1-T2809): the dir-walk matcher is a second text heuristic, blind to the next idiom " +
  "exactly as the ls-files probe was blind to this one. Its successor is the SEAM (W1-T2790's " +
  "ratified ordering): one shared tracked-file enumeration helper every census suite calls, " +
  "making discovery an exact import query that retires both matchers. Adopting the seam across " +
  "the measured ~84 dir-walk suites is its own filing, not a rider on this task.";

/** THE ONE PROBE, exported so a test asserts the real argv rather than restating it. An
 *  ALTERNATION kept to a SINGLE `git grep` spawn: the idiom is decided from each hit's own text,
 *  which the `src/` filter had to read anyway — one recognizer with two idioms. */
export const CENSUS_DISCOVERY_PROBE_ARGV: readonly string[] = [
  "grep",
  // W1-T3021 — `--untracked`, or this probe is blind LOCALLY to the one file a PR is adding.
  //
  // `git grep` searches TRACKED content only. A census-shaped suite that does not yet exist in the
  // index is therefore invisible to `censusPopulationDrift` on the author's machine and visible to
  // it in CI, where the tree is committed — so the drift guard reports a clean zero locally and
  // reds the PR that adds the suite. MEASURED: that is exactly how #4380 failed all four ci-shards
  // on `undisclosed census-shaped file(s): test/rule-citation-gate-engine-portable.test.ts` after a
  // local run of the same guard printed clean.
  //
  // COSTS NOTHING IN CI, WHICH IS WHY IT IS SAFE: a CI checkout has no untracked files, so the
  // discovered set there is byte-identical with and without this flag. It changes only what an
  // author sees before committing.
  //
  // `--exclude-standard` IS NOT NEEDED AND MUST NOT BE ADDED: `git grep --untracked` already
  // honours .gitignore (verified against git 2.39.5 and 2.54.0 — an ignored census-shaped fixture
  // is NOT returned), so scratch files cannot enter the population.
  "--untracked",
  "-lE",
  "ls-files|readdirSync|globSync",
  "--",
  "test/*.test.ts",
];

/** THE RECOGNIZER (W1-T2523's own, extracted so the drift guard reuses it rather than growing a
 *  second copy — ONE CENSUS PREDICATE, NEVER TWO; widened by W1-T2809). Every `test/*.test.ts`
 *  mentioning `ls-files`, `readdirSync` or `globSync` that also names a walked corpus is a candidate;
 *  an unreadable hit is KEPT. */
export function discoverCensusCandidates(
  repoRoot: string,
  spawn: PreflightSpawn,
  readFile: (path: string) => string,
): CensusCandidate[] {
  const res = spawn("git", [...CENSUS_DISCOVERY_PROBE_ARGV], { cwd: repoRoot });
  const hits = (res.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  const out: CensusCandidate[] = [];
  for (const testFile of hits) {
    let text: string;
    try {
      text = readFile(testFile);
    } catch {
      // unreadable: kept in, not ruled out, and tagged with the gated idiom — pre-W1-T2809 behaviour exactly.
      out.push({ testFile, idiom: "ls-files", walks: ["src/"] });
      continue;
    }
    const idiom: CensusEnumerationIdiom | undefined = /ls-files/.test(text)
      ? "ls-files"
      : /readdirSync|globSync/.test(text)
        ? "dir-walk"
        : undefined;
    if (!idiom) continue;
    const walks = censusCandidateWalks(text);
    if (walks.length === 0) continue;
    out.push({ testFile, idiom, walks });
  }
  return out;
}

/** The `ls-files` PROJECTION of {@link discoverCensusCandidates} — the population
 *  {@link censusPopulationDrift} gates on. INVARIANT: the GATE is not widened with the REPORT.
 *  The guard requires every discovered file to carry an entry, and MEASURED the dir-walk idiom
 *  adds 83 with none. Why: docs/forensics/ci-parity.md (W1-T2809). */
function discoverSrcFilteredLsFilesCallers(
  repoRoot: string,
  spawn: PreflightSpawn,
  readFile: (path: string) => string,
): string[] {
  return discoverCensusCandidates(repoRoot, spawn, readFile)
    .filter((c) => c.idiom === "ls-files" && c.walks.some((walk) => walk.startsWith("src/") || walk === "src/"))
    .map((c) => c.testFile);
}

export interface CensusPopulationDriftReport {
  /** A census-shaped file with no {@link CENSUS_POPULATION} entry — the drift this exists to catch. */
  readonly unknown: readonly string[];
  /** An entry the recognizer no longer discovers. Corrected by editing the population, never left stale. */
  readonly stale: readonly string[];
}

/** THE DRIFT GUARD — a census of the census. Re-runs the SAME recognizer against the real tree
 *  and diffs it against {@link CENSUS_POPULATION}. Approximate, and says so: a suite reachable by
 *  a means this recognizer does not model is invisible to it. */
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
  /**
   * W1-T2653 — the path(s) THIS gate's own enforcing job (the ci.yml job named `job`, which may
   * differ from this entry's local `--fast` `script`) prescribes as its remedy when it refuses —
   * e.g. the `"path": N` line `source-size-ratchet.mjs` prints for `scripts/source-size-baseline.json`.
   * Declared here, alongside the entry's own `reason`, so the pairing is a FACT ABOUT THE GATE
   * rather than a hand-list living inside the scope guard (design note i). Read ONLY by
   * {@link remedyFilesForFailingChecks} — never consulted for anything else, and never a blanket
   * scope grant: a remedy file is reachable to a fix rung only while that rung addresses THIS
   * job's own failure (design note ii), never unconditionally.
   */
  remedyFiles?: readonly string[];
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
    job: "comment-load-ratchet",
    script: "comment-load-signal",
    reason:
      "same-class — a deterministic, offline npm-script gate ci.yml's comment-load-ratchet job runs unconditionally. It " +
      "reads the tracked tree plus a local merge-base diff (git ls-files / merge-base / diff; never the network, never " +
      "node --test) and refuses a file whose comment-line count grew past scripts/comment-load-baseline.json or an added " +
      "comment block over 40 lines. Run locally it also records a shrink DOWN into that baseline, which is where an author " +
      "wants that edit made — see docs/comment-standard.md",
    remedyFiles: ["scripts/comment-load-baseline.json"],
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
      "unreadable base or failed measurement refuses the step. The historical shared baseline is not read or written. " +
      "W1-T3140: deliberately no `remedyFiles` — a red here means the base was unreadable or the measurement failed, " +
      "neither of which a baseline edit can repair, so this step must never enter the recordable-ratchet auto-repair rung. " +
      "The absence is a decision, not an omission",
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

/** A single declared remedy path, paired with the gate `job` id that declares it — carried
 *  together so a caller (the fix prompt, W1-T2653 design note iii) can name BOTH: which file, and
 *  which gate says so, rather than a bare path a reader has to trace back to its own gate by hand. */
export interface RemedyFileForGate {
  path: string;
  job: string;
}

/**
 * W1-T2653 — the declared remedy file(s) for a set of CURRENTLY FAILING check names, read off
 * {@link FAST_GATE_STEPS}'s own per-entry `remedyFiles` (never a second hand-list, design note i).
 * A check that is not currently failing contributes nothing, even if it declares `remedyFiles` —
 * this is the SCOPING half (design note ii): a strike addressing an unrelated failure must not
 * inherit a remedy that belongs to a gate it is not repairing. Deduplicated by (path, job) pair
 * and sorted for a deterministic result — callers pass this straight to both
 * {@link "../run-task.js".fixRungScopeStandDownReason}'s 4th parameter (flattened to paths) and
 * {@link "../run-task.js".renderFixPrompt}'s GATE REMEDY clause (which needs the job name too).
 *
 * PURE: reads only its own arguments — `steps` defaults to the real {@link FAST_GATE_STEPS} table,
 * overridable so a caller/test never has to mutate module state to exercise this.
 */
export function remedyFilesForFailingChecks(
  failingCheckNames: readonly string[],
  steps: readonly FastGateStep[] = FAST_GATE_STEPS,
): RemedyFileForGate[] {
  const failing = new Set(failingCheckNames);
  const seen = new Set<string>();
  const out: RemedyFileForGate[] = [];
  for (const step of steps) {
    if (!failing.has(step.job) || !step.remedyFiles) continue;
    for (const path of step.remedyFiles) {
      // The separator is a NUL written as an ESCAPE, never a raw byte: a raw one in tracked
      // source trips test/no-raw-nul.test.ts, and it is what makes this harness's grep skip a
      // whole file silently (CLAUDE.md clause (b)). The value is identical either way.
      const key = `${step.job}\u0000${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path, job: step.job });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.job.localeCompare(b.job));
}

// ── W1-T2523: WHICH CENSUS SUITES DOES A CHANGED PATH JOIN? A REPORT, NEVER A GATE ────────────
//
// TRAP: `git grep -l <symbol>` — the caller sweep this repo mandates — is BLIND to a census suite
// by construction, because such a suite names none of a caller's symbols, only a population and a
// property asserted over it (CLAUDE.md hazard (j)).
//
// INVARIANT — NEVER A GATE. These return data only: no `ok`, no verdict, nothing wireable into a
// refusal. And never a completeness claim they cannot have — a suite this derivation does not
// recognise is named in `unknownCoverage`.
// Why: the sweep this closed — docs/forensics/ci-parity.md (W1-T2523).

/** One recognised census suite; `walks` is the set of tracked-tree prefixes its own sweep is scoped to. */
interface KnownCensusSuite {
  readonly job: string;
  readonly testFile: string;
  readonly walks: readonly string[];
}

/**
 * W1-T2969 — THE REGISTRY-SHAPED CENSUSES. MEASURED 2026-09-06: of four census-baseline CI failures
 * across #4283 and #4290, the derived half named ONE. The other three each pin a REGISTRY (command
 * names, policy keys, source-text reads) and reference no symbol either diff touched, so the
 * mandated caller sweep was blind to all three. Each walks a population as the derived four do, but
 * none is a fast-gate member and none may become one: that admission is a measured COST decision.
 */
const REGISTRY_CENSUS_SUITES: readonly KnownCensusSuite[] = [
  {
    // A fixed list of verb names plus two exact counts; adding a COMMANDS verb moves all three.
    job: "command-registry-census",
    testFile: "test/help-renders-a-summary-not-a-paragraph.test.ts",
    walks: ["src/run-task.ts"],
  },
  {
    // `expectedTopLevelKeys` pins the section set, `NET_NEW` the fields with no source literal to
    // lift from. A new policy row moves both.
    job: "policy-surface-census",
    testFile: "test/policy.test.ts",
    walks: ["src/lib/policy.ts", "plan/policy.yaml"],
  },
  {
    // W1-T2905 ratchets the per-file count of source-text reads in tests, and ANY added test file
    // can trip it — so the whole prefix joins, never one path.
    job: "source-text-census",
    testFile: "test/source-text-assertion-census.test.ts",
    walks: ["test/"],
  },
  {
    // CLAUDE.md's OWN worked example for item (j) — "#2639 added one seamed policy read and reddened
    // test/config-reader-seams.test.ts ... that references nothing it touched." It walks src/ and
    // pins an EXACT count of unredirectable policy reads, so any file gaining one moves it; measured
    // a fifth time when W1-T2971's fourth cadence hook builder took it 25 -> 26.
    job: "config-reader-seams-census",
    testFile: "test/config-reader-seams.test.ts",
    walks: ["src/"],
  },
];

export const KNOWN_CENSUS_SUITES: readonly KnownCensusSuite[] = CENSUS_ADMITTED_MEMBERS.map((m) => ({
  job: m.job,
  testFile: m.testFile,
  walks: m.walks ?? [],
}));

const CENSUS_WALKED_POPULATION_SUITES: readonly KnownCensusSuite[] = CENSUS_POPULATION.flatMap((m) =>
  m.walks && m.walks.length > 0 ? [{ job: m.job, testFile: m.testFile, walks: m.walks }] : [],
);

/**
 * THE MEMBERSHIP SET — WIDER THAN {@link KNOWN_CENSUS_SUITES} AND A SEPARATE SYMBOL, because the two
 * answer different questions: "which suites does this path join" reads THIS, "does this suite carry
 * a verdict row" reads the ADMITTED projection, and `unknownCoverage` comes from THAT. Union them
 * and test/config-reader-seams.test.ts leaves the unknown report holding no verdict row — refused
 * BY NAME by W1-T2809's suite, and by W1-T2523's demanding the exact opposite of anything KNOWN.
 */
export const CENSUS_MEMBERSHIP_SUITES: readonly KnownCensusSuite[] = [
  ...CENSUS_WALKED_POPULATION_SUITES,
  ...REGISTRY_CENSUS_SUITES,
];

/** A changed path and the job names it enters — `suites` is `[]` when it joins none, never omitted. */
export interface CensusMembershipEntry {
  readonly path: string;
  readonly suites: readonly string[];
}

/** Pure, non-blocking output: no `ok`, no verdict — a report a caller prints, never a gate.
 *  `unknownCoverage` names every re-derived caller {@link KNOWN_CENSUS_SUITES} does not carry,
 *  because this cannot say which prefixes an unrecognised suite walks and will not guess. */
export interface CensusMembershipReport {
  readonly entries: readonly CensusMembershipEntry[];
  readonly unknownCoverage: readonly string[];
  readonly candidateCoverage: readonly CensusCandidate[];
}

/** PURE core: membership by prefix match against {@link CENSUS_MEMBERSHIP_SUITES}. No git, filesystem or spawn. */
export function censusSuiteMembership(
  changedPaths: readonly string[],
  srcFilteredCallers: readonly string[],
  candidates: readonly CensusCandidate[] = [],
): CensusMembershipReport {
  // TWO QUESTIONS, TWO SETS (W1-T2969) — see CENSUS_MEMBERSHIP_SUITES for why they cannot be one.
  const knownTestFiles = new Set(KNOWN_CENSUS_SUITES.map((s) => s.testFile));
  const modelledTestFiles = new Set(CENSUS_MEMBERSHIP_SUITES.map((s) => s.testFile));
  const unknownCoverage = [...new Set(srcFilteredCallers.filter((f) => !knownTestFiles.has(f)))].sort();
  const candidateCoverage = candidates
    .filter((c) => !modelledTestFiles.has(c.testFile))
    .filter((c, index, all) => all.findIndex((other) => other.testFile === c.testFile) === index)
    .sort((a, b) => a.testFile.localeCompare(b.testFile));
  const entries = changedPaths.map((path) => ({
    path,
    suites: CENSUS_MEMBERSHIP_SUITES.filter((s) => s.walks.some((prefix) => path.startsWith(prefix))).map((s) => s.job),
  }));
  return { entries, unknownCoverage, candidateCoverage };
}

/** The impure edge: runs the probe through the injected {@link PreflightSpawn}, reads each hit's
 *  text through the injectable `readFile`, then hands the result to {@link censusSuiteMembership}.
 *  A `git grep` matching nothing exits 1 — git's documented "no match" — and reads as zero
 *  callers, never thrown. */
export function censusSuiteMembershipFor(
  changedPaths: readonly string[],
  repoRoot: string,
  spawn: PreflightSpawn,
  readFile: (path: string) => string = (path) => readFileSync(join(repoRoot, path), "utf8"),
): CensusMembershipReport {
  // W1-T2809 — THE WIDENED SET, not the `ls-files` projection. This report's contract is that a
  // suite it cannot place is NAMED rather than omitted, so the honest input is every candidate
  // either idiom finds.
  const candidates = discoverCensusCandidates(repoRoot, spawn, readFile);
  const srcFilteredCallers = candidates.map((c) => c.testFile);
  return censusSuiteMembership(changedPaths, srcFilteredCallers, candidates);
}

// ── W1-T3215: THE CALLER SWEEP MUST WALK PAST ONE HOP ──────────────────────────────────────────
//
// TRAP: CLAUDE.md's mandated sweep is `git grep -l <symbol>` over test/ — ONE hop from the changed
// symbol to the suites naming it BY NAME. MEASURED 2026-09-08 on #4722: that sweep, run on a diff
// changing only `prewarmBoardGithub`'s body, names four suites, all green. CI reddened a FIFTH,
// test/serve-prewarm-clientgate.test.ts, which names ZERO occurrences of `prewarmBoardGithub` — it
// drives `gatePrewarmOnClients`, the only src/ function that calls `prewarmBoardGithub`, and that
// suite has 22 matches on THAT name. One more hop — symbol -> its in-file caller -> the suites
// naming the caller — would have named it.
//
// INVARIANT — NEVER A GATE, same as {@link censusSuiteMembership} above: report-only, no `ok`,
// nothing wireable into a refusal. And bounded to exactly the hop the measured failure needed:
// MEASURED on this same #4722 diff, the one-hop sweep above finds 4 suites, this closure finds 6
// (adding exactly `test/serve-prewarm-clientgate.test.ts` and `test/task-card.test.ts`, both
// genuine `gatePrewarmOnClients` callers), and the whole-file fallback the task rationale rejects
// finds 76 — so this stays two orders of magnitude under the fallback while still repairing the
// miss. An UNBOUNDED walk (callers of callers of callers...) is that "reach most of the tree"
// failure; this stops at exactly one hop past the changed symbol, which is the whole gap the
// mandated sweep had.
// Why: same class as CLAUDE.md hazard (j) — a suite the sweep is structurally blind to — one hop
// further out than a census suite's zero-symbol blindness.

/** One changed symbol and what this walk found for it: `callers` are the `src/` functions whose
 *  body references the symbol — the hop the mandated `git grep -l <symbol>` sweep cannot take —
 *  and `suites` unions the suites naming the symbol directly with the suites naming any of those
 *  callers. `suites` is `[]` when the walk reaches nothing, never omitted. */
export interface CallerReachableEntry {
  readonly symbol: string;
  readonly callers: readonly string[];
  readonly suites: readonly string[];
}

/** Pure, non-blocking output: no `ok`, no verdict — a report a caller prints or runs, never a gate. */
export interface CallerReachableSuitesReport {
  readonly entries: readonly CallerReachableEntry[];
  /** Every suite reached, across every changed symbol, deduplicated and sorted — the list a caller
   *  actually runs. `[]` for an empty `changedSymbols` input: the empty set is never widened into
   *  "every suite". */
  readonly suites: readonly string[];
}

/** A `git grep` hit whose line is prose ABOUT the symbol — `{@link foo}` and its kin — never
 *  counts as a call site: counting it re-admits a false caller. MEASURED: an interface field's own
 *  doc comment, scanned back past the interface (which neither def regex below matches), misattributed
 *  to an unrelated preceding top-level `const`. Filtering the comment line out removes the false
 *  caller entirely rather than papering over it with a third def regex. */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

/** `\`, `.`, `*`, `+`, `?`, `(`, `)`, `[`, `]`, `{`, `}`, `|`, `^`, `$` all need escaping to embed
 *  an arbitrary identifier inside a `RegExp` literally — a bare `$` (legal in a JS identifier) is
 *  the one this repo actually hits, and unescaped it silently turns into an end-of-input anchor. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A hit line counts as a CALL only when the symbol is immediately followed by `(` (optional
 *  whitespace between): `prewarmBoardGithub(github, refreshMs)` is a call, `prewarmBoardGithub's
 *  body` and `{@link prewarmBoardGithub}` are prose ABOUT it. MEASURED: without this, a COMMANDS
 *  registry `detail` string that merely NAMES a symbol in its own doc text — the same prose shape
 *  `git grep -l <symbol>` itself would be blind to reading as a call — resolved to `COMMANDS` as a
 *  false "caller" and pulled in every suite that ever mentions the command table, wiping out the
 *  bound this closure exists to hold. `isCommentLine` above catches the doc-comment shape; this
 *  catches the same prose landing inside an ordinary string literal instead. */
function isCallSite(content: string, symbol: string): boolean {
  return new RegExp(`\\b${escapeForRegExp(symbol)}\\s*\\(`).test(content);
}

/** The nearest UNINDENTED (module-top-level) function/const definition AT OR ABOVE `hitLine`
 *  (1-based, `git grep -n`'s own numbering) — the enclosing declaration whose body the hit sits
 *  inside, by this repo's own convention that only a top-level declaration starts in column 0. A
 *  nested closure (indented, e.g. the `const warm = ...` inside `prewarmBoardGithub`) is never
 *  mistaken for the owner, and the definition line itself resolves to its OWN name (the self-
 *  reference {@link srcCallersOf} then excludes). */
const TOP_LEVEL_FUNCTION_DEF = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
const TOP_LEVEL_CONST_DEF = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/;

function enclosingTopLevelSymbol(lines: readonly string[], hitLine: number): string | undefined {
  for (let i = hitLine - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = TOP_LEVEL_FUNCTION_DEF.exec(line) ?? TOP_LEVEL_CONST_DEF.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** `git grep -l -w -F <symbol> -- test/` — the mandated one-hop sweep itself, factored out so
 *  {@link callerReachableSuites} both replays it (hop 0) and re-runs it per discovered caller
 *  (hop 1). A `git grep` matching nothing exits 1 — git's documented "no match" — and reads as no
 *  suites, never thrown. */
function suitesNamingSymbol(symbol: string, repoRoot: string, spawn: PreflightSpawn): string[] {
  const res = spawn("git", ["grep", "-l", "-w", "-F", "--", symbol, "--", "test/"], { cwd: repoRoot });
  return (res.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
}

/** THE ONE HOP THE MANDATED SWEEP DOES NOT TAKE: every `src/` function whose body CALLS `symbol`,
 *  found by walking every `git grep -n -w -F` hit that is an actual call site
 *  ({@link isCallSite}, never a comment mention — {@link isCommentLine}) back to its nearest
 *  top-level owner, excluding the symbol's own definition (self-reference). ENUMERATED FROM THE
 *  TREE, never a hand list: a caller added in the same commit is walked by the run that adds it,
 *  with no registry to edit. */
function srcCallersOf(
  symbol: string,
  repoRoot: string,
  spawn: PreflightSpawn,
  readFile: (path: string) => string,
): string[] {
  const res = spawn("git", ["grep", "-n", "-w", "-F", "--", symbol, "--", "src/"], { cwd: repoRoot });
  const hits = (res.stdout ?? "").split("\n").filter(Boolean);
  const byFile = new Map<string, number[]>();
  for (const hit of hits) {
    const m = /^(.+?):(\d+):(.*)$/.exec(hit);
    if (!m) continue;
    const [, file, lineStr, content] = m;
    if (isCommentLine(content) || !isCallSite(content, symbol)) continue;
    const lines = byFile.get(file) ?? [];
    lines.push(Number(lineStr));
    byFile.set(file, lines);
  }
  const callers = new Set<string>();
  for (const [file, lineNums] of byFile) {
    let text: string;
    try {
      text = readFile(file);
    } catch {
      continue; // unreadable: no owner can be attributed, same convention as discoverCensusCandidates
    }
    const lines = text.split("\n");
    for (const lineNum of lineNums) {
      const owner = enclosingTopLevelSymbol(lines, lineNum);
      if (owner && owner !== symbol) callers.add(owner);
    }
  }
  return [...callers].sort();
}

/**
 * W1-T3215 — THE SECOND HOP, BESIDE ITS FIRST. {@link censusSuiteMembership} above answers "which
 * population-walking suite does this diff join" for a suite the mandated `git grep -l <symbol>`
 * sweep cannot see because it names NO symbol at all; this answers the other half of the same gap
 * — a suite that names a symbol perfectly well, just not the CHANGED one, because it drives the
 * changed symbol's caller instead. An empty `changedSymbols` walks nothing (no `spawn` call at
 * all) and returns nothing, so the empty set is never widened into "every suite".
 *
 * PURE CONTRACT identical to {@link censusSuiteMembershipFor}: `spawn`/`readFile` injected, no
 * other I/O, `ok`-free, never wireable into a refusal.
 */
export function callerReachableSuites(
  changedSymbols: readonly string[],
  repoRoot: string,
  spawn: PreflightSpawn,
  readFile: (path: string) => string = (path) => readFileSync(join(repoRoot, path), "utf8"),
): CallerReachableSuitesReport {
  const entries: CallerReachableEntry[] = [];
  const allSuites = new Set<string>();
  for (const symbol of changedSymbols) {
    const directSuites = suitesNamingSymbol(symbol, repoRoot, spawn);
    const callers = srcCallersOf(symbol, repoRoot, spawn, readFile);
    const suites = new Set(directSuites);
    for (const caller of callers) {
      for (const s of suitesNamingSymbol(caller, repoRoot, spawn)) suites.add(s);
    }
    const sorted = [...suites].sort();
    entries.push({ symbol, callers, suites: sorted });
    for (const s of sorted) allSuites.add(s);
  }
  return { entries, suites: [...allSuites].sort() };
}

/** The `package.json` "scripts" key set, so a renamed script is told apart from a failing one (design vi). */
function fastGateScriptNames(repoRoot: string, packageJsonText?: string): Set<string> {
  const text = packageJsonText ?? readFileSync(join(repoRoot, "package.json"), "utf8");
  const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
  return new Set(Object.keys(pkg.scripts ?? {}));
}

export interface PreflightFastDeps {
  spawn?: PreflightSpawn;
  /** Test seam — production reads the repo's real package.json. */
  packageJsonText?: string;
  /** Test seam for the wall clock — a falsifier proves a refusal by elapsed time with no slow spawn. */
  now?: () => number;
  /** Test seam — a falsifier injects a narrowed list without mutating {@link FAST_GATE_STEPS}. */
  steps?: readonly FastGateStep[];
}

export interface PreflightFastResult {
  steps: CiParityStepResult[];
  ok: boolean;
}

/**
 * Runs `fn` with `NODE_TEST_CONTEXT` and `NODE_OPTIONS` removed from `process.env`, then restores
 * them — the isolation test/reapable-prefix.test.ts establishes for a spawned `node --test` CHILD,
 * applied here to a GRANDCHILD (`npm run --silent census:*` spawns its own).
 *
 * TRAP, MEASURED (W1-T2478): `node --test`'s recursion guard reads that variable from its
 * inherited environment, and `defaultPreflightSpawn` passes `process.env` through untouched. Set,
 * a nested run skips every file and exits 0 HAVING ASSERTED NOTHING — the #3304 shape again.
 * Why: docs/forensics/ci-parity.md (W1-T2478).
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

/** `rmd preflight --fast`'s engine. One step per {@link FAST_GATE_STEPS} entry, run and reported
 *  independently, the same discipline as {@link runCiParity}. A script absent from
 *  `package.json`'s "scripts" reports `SCRIPT MISSING`, distinct from `FAIL` (the script ran and
 *  its gate failed), so a rename goes loud (design vi). An entry declaring `boundMs` has its own
 *  spawn timed inside {@link withoutNodeTestContext}; one without runs as it always has. */
export function runPreflightFast(repoRoot: string, deps: PreflightFastDeps = {}): PreflightFastResult {
  const spawn = deps.spawn ?? defaultPreflightSpawn;
  const scriptNames = fastGateScriptNames(repoRoot, deps.packageJsonText);
  const now = deps.now ?? Date.now;
  const gateSteps = deps.steps ?? FAST_GATE_STEPS;
  // W1-T2545 — PASS ONE: run every step and keep each census entry's measured cost. Nothing is
  // refused on cost here: the threshold is derived from the population, which is not complete
  // until the last entry has run.
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
      // The SOFT bound reports and never refuses: a census suite's growing cost is news about the tree.
      if (elapsedMs > boundMs && result.ok) {
        return { ok: true, detail: `${result.detail} — COST ${elapsedMs}ms, over the ${boundMs}ms soft bound (reported, not refused)` };
      }
      return result;
    }),
  );

  // PASS TWO: with every census cost measured on the SAME machine in the SAME run, a runaway is
  // the entry costing several times its cheapest sibling — a ratio a slow runner cannot
  // manufacture. An entry whose own command FAILED is left alone.
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
// A FOURTH, ADDITIVE mode on the same verb, dedicated to one gate: `scripts/diff-coverage.mjs`,
// otherwise CI-only and invisible to the author until a push and a CI cycle have gone by. Opt-in
// and slow BY CONSTRUCTION — it shells the full glob via {@link testWithCoverageLeaf}.
//
// INVARIANT — THE RUNNER OWNS THE BASE (design ii). It computes the same refreshed three-dot
// range `--ci-parity` uses, and REFUSES rather than reports when the inputs cannot support a
// verdict: an EMPTY diff, or a DIRTY tree in a diffed file (lcov and diff would come from
// different trees). Both SHORT-CIRCUIT, because this is one linear pipeline.
//
// INVARIANT — INSTRUMENTATION IS ASSERTED BEFORE A PASS (design iii). TRAP: `diff-coverage.mjs`
// reports OK the instant no ADDED line it INSTRUMENTED reads as uncovered, so a changed source
// file with no `SF:` record makes that OK vacuously true over an empty set.
//
// INVARIANT — NO WEAKENING (design vi/vii): nothing exempts an arm or lowers a threshold.
// Why: the refusals and the vacuous-OK argument — docs/forensics/ci-parity.md (W1-T1074).

/** Every path `origin/main...HEAD` touches. The CALLER never supplies this (design ii). */
// THE IDENTICAL UNCHECKED SHAPE AS `mergeBaseDiffForCoverage`, DELIBERATELY LEFT. This one's
// caller converts an empty result into the `coverage-mode:diff-scope` refusal, so the path is
// already fail-closed end to end; checking here would alter a verdict the gate reaches correctly.
// Noted so the resemblance reads as considered rather than missed (W1-T3013).
function computeChangedFiles(repoRoot: string, spawn: PreflightSpawn): string[] {
  const res = spawn("git", ["diff", "--name-only", `${requirePinnedBase(repoRoot, spawn)}...HEAD`], { cwd: repoRoot });
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Of `files`, the ones `git status --porcelain` reports dirty. TRAP: NEVER `.trim()` the raw
 *  porcelain string before slicing — the status column can start with a space (` M path`), so
 *  trimming the blob shifts every `slice(3)` by a character. Trim PER LINE, after the slice. */
function dirtyDiffedFiles(repoRoot: string, spawn: PreflightSpawn, files: readonly string[]): string[] {
  if (files.length === 0) return [];
  const res = spawn("git", ["status", "--porcelain", "--", ...files], { cwd: repoRoot });
  return res.stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/** The `SF:` paths an lcov instruments. Only the file SET is needed, so `diff-coverage.mjs` stays untouched. */
function lcovInstrumentedFiles(lcovText: string): Set<string> {
  const files = new Set<string>();
  for (const line of lcovText.split("\n")) {
    if (line.startsWith("SF:")) files.add(line.slice(3).trim());
  }
  return files;
}

/** A "source file" for the instrumentation assertion (design iii): under `src/`, and not itself a test. */
function isChangedSourceFile(path: string): boolean {
  if (!path.startsWith("src/")) return false;
  if (/(^|\/)test(s)?\//.test(path)) return false;
  if (/\.test\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/\.spec\./.test(path)) return false;
  return true;
}

export interface PreflightCoverageDeps {
  spawn?: PreflightSpawn;
  /** Test seam — production reads the lcov this mode's own step just wrote. */
  lcovText?: string;
}

export interface PreflightCoverageResult {
  steps: CiParityStepResult[];
  ok: boolean;
}

/** `rmd preflight --coverage`'s engine (W1-T1074) — see the banner above. Unlike
 *  {@link runCiParity}/{@link runPreflightFast}'s independent-jobs discipline, this is ONE linear
 *  pipeline that REFUSES once a stage cannot support a trustworthy verdict. */
export function runPreflightCoverage(repoRoot: string, deps: PreflightCoverageDeps = {}): PreflightCoverageResult {
  const spawn = deps.spawn ?? defaultPreflightSpawn;
  const steps: CiParityStepResult[] = [];

  const refresh = runStep("coverage-mode:base-refresh", () => refreshOriginMain(repoRoot, spawn));
  steps.push(refresh);
  if (!refresh.ok) return { steps, ok: false };

  // W1-T3017 — A REFUSAL STEP, NOT A THROW. Everything below runs OUTSIDE `runStep`, so a
  // `requirePinnedBase` throw here would escape this function entirely and crash `preflightCommand`
  // rather than report. This pipeline's contract is to REFUSE with a named step once a stage cannot
  // support a trustworthy verdict, and an unresolvable base is exactly such a stage: without it
  // there is no honest three-dot range to scope coverage over.
  const pin = pinnedBase(repoRoot, spawn);
  if ("failure" in pin) {
    steps.push({
      name: "coverage-mode:base-pin",
      ok: false,
      detail: `coverage-mode:base-pin: REFUSED — ${pin.failure}; refusing to diff against the moving ref instead`,
    });
    return { steps, ok: false };
  }

  const changedFiles = computeChangedFiles(repoRoot, spawn);
  if (changedFiles.length === 0) {
    steps.push({
      name: "coverage-mode:diff-scope",
      ok: false,
      // W1-T3013: the sentence is now a shared constant, so the two coverage modes cannot drift.
      detail: `coverage-mode:diff-scope: REFUSED — ${EMPTY_DIFF_COVERAGE_REFUSAL}`,
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

// ── W1-T3099: Standing rule 15, at author time ────────────────────────────────────────────────

/**
 * THE JUDGE'S REMEDY, COPIED VERBATIM from `checkSatisfiedByGuard` (review.ts). An author who reads
 * one sentence at preflight and another at review must reconcile two texts to learn one rule.
 * review.ts's own comment records why BOTH halves are needed: telling an author only to SPLIT
 * converts one refusal into another (#3626, #3631, #3636, #3669 each split correctly and were
 * refused anyway).
 */
export const RULE_15_SPLIT_REMEDY =
  "REMEDY: file the shard in its own plan-only PR (no src/ or test/ file in that diff), then build " +
  "it in a second PR. In the filing PR's body, substantiate each criterion by NAMING the proof that " +
  "will carry it.";

/** The verdict {@link rule15SplitViolation} returns. `refused: false` carries no reason. */
export interface Rule15SplitVerdict {
  refused: boolean;
  reason?: string;
}

/**
 * W1-T3099 — Standing rule 15 evaluated on a LOCAL diff, so `rmd preflight` and `lint-plan --base`
 * refuse before a push what the judge refuses after a full CI cycle.
 *
 * ONE PREDICATE, TWO VERBS, consuming the JUDGE'S OWN primitives rather than a second notion of
 * either half: {@link criterionFieldTampered} decides "a criterion moved" and {@link planOnlyDiff}
 * decides "this diff is a filing". A local re-implementation of either could disagree with review,
 * and an author-time check that refuses what the judge allows is worse than no check.
 *
 * DELIBERATELY WEAKER THAN THE JUDGE, IN THE SAFE DIRECTION. `checkSatisfiedByGuard` carves out
 * `planOnly && humanAuthored`; authorship is not knowable from a diff, so this carves out
 * `planOnly` alone. Stated rather than hidden: a plan-only WORKER-authored diff passes here and may
 * still be refused at review. That is an UNDER-refusal — it never blocks work the judge would have
 * allowed, which is the only direction an early warning may err in.
 */
export function rule15SplitViolation(diff: string): Rule15SplitVerdict {
  if (!criterionFieldTampered(diff)) return { refused: false };
  // The filing PR's own shape — the judge's derivation, not "no src/ file" spelled a second time.
  if (planOnlyDiff(diff)) return { refused: false };
  return {
    refused: true,
    reason:
      "Standing rule 15: plan/tasks.yaml's (or a plan/tasks.d/ shard's) acceptance criteria were " +
      "added/edited in a diff that also touches non-plan files. " +
      RULE_15_SPLIT_REMEDY,
  };
}

/**
 * The preflight step. REFUSES rather than warns: `rmd preflight` already exits non-zero for parity
 * failures and this joins them, because a warning at author time is a line in a scroll-back and the
 * failure it prevents costs a full CI cycle.
 */
export function rule15SplitStep(diff: string): CiParityStepResult {
  const verdict = rule15SplitViolation(diff);
  return verdict.refused
    ? { name: "rule-15-split", ok: false, detail: verdict.reason ?? "Standing rule 15 violation" }
    : { name: "rule-15-split", ok: true, detail: "no acceptance criterion added or edited beside a non-plan file" };
}
