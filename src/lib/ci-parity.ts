import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { defaultPreflightSpawn, typecheckStep, type PreflightSpawn } from "./commit-message.js";

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
function shellOut(spawn: PreflightSpawn, label: string, file: string, args: string[], opts?: { cwd?: string; input?: string }): CiParityLeafResult {
  const res = spawn(file, args, opts);
  if (res.status === null) {
    // The child never produced an exit status at all — a signal kill, a buffer ceiling hit,
    // ENOENT, etc. This is NOT an ordinary test failure, and rendering it as `FAIL — <label>`
    // with whatever (often empty/truncated) output happened to come back is exactly how a
    // ci:test ENOBUFS previously read as a real red test with no visible cause. Name the spawn
    // failure as its own outcome instead.
    const why = res.error ?? "spawn produced no exit status and no error message";
    return { ok: false, detail: `SPAWN FAILURE — ${label}: ${why}` };
  }
  const ok = res.status === 0;
  return { ok, detail: ok ? `PASS — ${label}` : `FAIL — ${label}\n${(res.stdout + res.stderr).trim()}` };
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

/** `npm run --silent <script>` — the shared shape for every job whose CI step is exactly an
 *  npm script, byte-identical to what ci.yml itself invokes (no re-derived argv to drift). */
function npmScriptEntry(job: string, script: string): CiParityEntry {
  return {
    job,
    mirrored: true,
    run: (repoRoot, spawn) => [runStep(job, () => shellOut(spawn, `npm run --silent ${script}`, "npm", ["run", "--silent", script], { cwd: repoRoot }))],
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
      runStep("ci:test", () => shellOut(spawn, "npm run test:ci", "npm", ["run", "test:ci"], { cwd: repoRoot })),
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
      const test = runStep("coverage-ratchet:test-with-coverage", () => {
        try {
          mkdirSync(join(repoRoot, "coverage"), { recursive: true });
        } catch {
          // best-effort — a spawn injected by a test may point repoRoot at a fixture that
          // doesn't need a real coverage/ directory at all.
        }
        // Routed through scripts/test-with-retry.mjs, exactly as ci.yml's own coverage-ratchet
        // job is (W1-T255) — a flaky test gets the SAME one-shot retry locally that CI gives it,
        // instead of failing --ci-parity on a flake CI itself would have gone green on.
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
          { cwd: repoRoot },
        );
      });
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
// WHAT THIS MUST NOT BECOME (design iii): `npm test`. Growing this list to include anything
// that spawns `node --test`, touches the network, or is not sub-second-to-low-single-digit-
// second is the ONE mistake this mode exists to prevent — it would make the fast mode the
// expensive mode wearing a cheaper name, and the habit it exists to create unaffordable.
// `runPreflightFast` below never shells `npm run test:ci` (or any bare `npm test`) — it only
// ever invokes `npm run --silent <script>` for a script named in `FAST_GATE_STEPS`.
export const FAST_GATE_STEPS: { job: string; script: string; reason: string }[] = [
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
}

export interface PreflightFastResult {
  steps: CiParityStepResult[];
  ok: boolean;
}

/**
 * `rmd preflight --fast`'s engine. One step per `FAST_GATE_STEPS` entry, run and reported
 * independently (same discipline as {@link runCiParity} and
 * {@link import("./commit-message.js").runPreflight}: one failure never blocks a later step's
 * chance to report, and `ok` is the AND of all of them). A script that is not in
 * `package.json`'s "scripts" is reported as `SCRIPT MISSING` — distinct from `FAIL`, which
 * means the script ran and its gate failed — so a renamed or removed script goes loud, never
 * quiet (design vi).
 */
export function runPreflightFast(repoRoot: string, deps: PreflightFastDeps = {}): PreflightFastResult {
  const spawn = deps.spawn ?? defaultPreflightSpawn;
  const scriptNames = fastGateScriptNames(repoRoot, deps.packageJsonText);
  const steps = FAST_GATE_STEPS.map(({ job, script }) =>
    runStep(job, () => {
      if (!scriptNames.has(script)) {
        return { ok: false, detail: `SCRIPT MISSING — "${script}" is not defined in package.json's "scripts"; this step did not run` };
      }
      return shellOut(spawn, `npm run --silent ${script}`, "npm", ["run", "--silent", script], { cwd: repoRoot });
    }),
  );
  return { steps, ok: steps.every((s) => s.ok) };
}
