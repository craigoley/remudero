#!/usr/bin/env node
// scripts/test-with-retry.mjs — ONE bounded, evidence-preserving failed-file retry (W1-T255,
// W1-T2904).
//
// WHY: the merge gate runs the SAME ~90-file suite in TWO required check runs per PR (the `ci`
// job's `npm test`, and the `coverage-ratchet` job's same test/**/*.test.ts glob under
// --experimental-test-coverage) -- BOTH required, and `node --test` has no native retry facility.
// One nondeterministic (flaky) test therefore gets two independent chances to red an otherwise-
// unrelated PR's required checks, and today's only remedy -- a manual re-run -- OVERWRITES the
// job's own conclusion, so the flake's evidence disappears with it and the flake rate is
// unmeasurable (the gap W1-T220 deliberately left unfiled).
//
// THIS WRAPPER spawns the command it is given, inheriting stdio (the CI log sees exactly
// what a direct invocation would show, live, in order) while also capturing that same output for
// parsing. A ZERO exit does nothing further -- the command is spawned EXACTLY ONCE on green, so a
// healthy PR pays no extra wall-time. A NON-ZERO exit:
//   1. parses the failing test names out of the first attempt's combined stdout+stderr,
//   2. prints ONE greppable, machine-countable line to stdout --
//      `FLAKE-RETRY: first attempt failed — <names>` -- and appends the same line to
//      $GITHUB_STEP_SUMMARY when that env var is set (CI), so the flake leaves a record instead
//      of erasing it,
//   3. uses Node's TAP `location:` evidence to re-run only failed test files. If the child is not
//      a recognized Node test command, or emitted no trustworthy file location, it fails safe to
//      the identical whole command. The final exit code is the SECOND run's.
//
// W1-T4398: the coverage lane uses it as `--coverage-first-pass <raw-dir>`. Pass 1 is the instrumented
// run, the only process given NODE_V8_COVERAGE=<raw-dir> (not this wrapper, which would otherwise
// write its own raw report), and the ONLY source of coverage figures; a failed file is re-run once
// UNINSTRUMENTED (no coverage flags, no reporter files), so a retry can never move the lcov. A failure
// no file can be named for keeps its verdict, except W1-T6592's all-pass empty-coverage failure:
// drop empty reports, rebuild lcov, or retry coverage once. Recovery prints FLAKE-RETRY-RECOVERED.
//
// A deterministic failure fails BOTH attempts -- red is unchanged, the retry cannot mask a real
// break. TEST_RETRY=0 disables the retry entirely (the first attempt's exit code is final) -- a
// kill switch for when the retry mechanism itself is suspected of hiding something real.
//
// W1-T4112: A FLAKE WAS PRINTED, NEVER RECORDED. `recordFlakeEvidence`'s FLAKE-RETRY line has
// always been stdout-only (plus $GITHUB_STEP_SUMMARY in CI), so nothing could ever ask "which
// file flakes the most" without hand-reading logs. Every FLAKE-RETRY headline now ALSO appends one
// `test.flake_retry` row per named `{file, test}` pair into the fleet's own ledger (`appendFlakeLedger`,
// default `<root>/state/ledger.ndjson`) -- the same ledger `src/lib/test-gardener.ts` reads back
// through the union resolver to retier a repeat flaker into the slow tier.
//
// W1-T2433: DO NOT START A PASS YOU CANNOT FINISH. The wrapper already knows how long pass 1
// took, because it waited for it. When $TEST_RETRY_BUDGET_SECONDS is set, pass 2 is spawned only
// when the remaining budget (budget minus pass 1's elapsed time) is at least what pass 1 itself
// consumed -- otherwise a second pass would be truncated by the job's own timeout, which returns
// a cancellation that names nothing rather than pass 1's real, already-diagnosed red. A declined
// retry still records pass 1's failing-test evidence and exits with pass 1's own code. This reads
// NO job bound (no timeout-minutes, no WAIT_CAP_SECONDS) -- only the budget the caller supplies
// via that one env var; when it is unset, behavior is byte-for-byte unchanged from before this
// task (the retry always fires on a non-zero first attempt, same as today).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitOrThrow } from "./lib/git.mjs";
import { newTestCoverage, renderCoverageSummary } from "./coverage-merge-ratchet.mjs";
import { topLevelTapFailures } from "../src/lib/base-reproduction.ts";
import { closeJudgedRun, judgedNodeTestArgs, POOL_ISOLATION_FLAG, prepareJudgedRun, testFilesInArgv, unreportedFilesIn } from "./pure-test-pool.mjs";
import { boundedNodeTestArgs, COVERAGE_HANG_MANIFEST_ENV, NODE_EXIT_DEADLOCK_WORKAROUND_ARGS, withCoverageHangBound } from "./test-tier-manifest.mjs";

/**
 * W1-T2715 — A TEST THAT WRITES INTO THE TRACKED TREE IS OBSERVED BY EVERY OTHER WORKER, and the
 * check for it belongs HERE, around the whole suite, rather than inside each test-file process.
 *
 * MEASURED, THREE INSTANCES IN ONE SESSION (2026-09-02), each found by accident rather than by a
 * gate: the shipped-tree check ran the REAL source-size ratchet against the REAL baseline and that
 * script RECORDS a newly-seen source file, so it wrote twice and left the tree dirty (worse than
 * debris — a test that writes a gate's own baseline MOVES the gate); a probe shard under
 * test/fixtures/ removed only in a `finally` survived a killed run and made the NEXT run fail that
 * suite's own "the probe shard must not already exist" assertion, READING AS A REGRESSION; and a
 * fixture task file was left modified in a third worktree.
 *
 * WHY NOT PER-PROCESS, WHICH IS WHAT THE SHARD FIRST DESCRIBED. That design was built and MEASURED
 * UNSOUND. `node --test` runs test files in parallel, so a per-process before/after snapshot sees
 * OTHER workers' in-flight fixtures and blames whoever happens to exit while they exist. Over the
 * full 13,961-test suite it fired three times and every one was a MISATTRIBUTION — the blamed
 * processes were not the creators, and run alone all four files involved were clean. The shard's
 * own falsifier names exactly that outcome: "Re-design rather than build if the check proves
 * unable to attribute a path to the process that made it under parallel execution."
 *
 * ONE WRAPPER, ONE BEFORE, ONE AFTER. This wrapper owns the suite and its optional failed-file
 * retry, so there is no concurrent wrapper snapshot to confuse it and no attribution to get wrong. It
 * also SEES CHILD-PROCESS WRITES — instance 1 was a spawned ratchet, which no in-process `fs`
 * wrapper could ever observe. Cost is two `git status` calls per WRAPPER (~104ms measured) against
 * ~2,148 for the per-process design (~112s).
 *
 * WHAT IS GIVEN UP, STATED: this names the PATH but not the test file that wrote it. Criterion 1
 * asks for the path, and finding the writer from it is one `git grep` — measured at under a minute
 * for all three instances above. A check that is right beats one that is precise and wrong.
 *
 * SNAPSHOT-AND-COMPARE, NEVER A BARE `git status`: a checkout may legitimately be dirty when a run
 * starts (an operator's own edits), and only paths absent BEFORE and present AFTER are the suite's.
 */

/** `git status --porcelain` as a sorted line set, or `null` when git could not be read at all —
 *  not a repo, no git binary, a permission error. `null`, never `[]`: "could not look" and "looked
 *  and found nothing" must not collapse into the same value. */
export function readTrackedTreeState(cwd = process.cwd(), runGit = defaultStatusReader) {
  try {
    return runGit(cwd).split("\n").filter(Boolean).sort();
  } catch {
    return null;
  }
}

function defaultStatusReader(cwd) {
  // UNTRACKED ENTRIES INCLUDED (no `-uno`): instance 2 was an untracked probe shard and it still
  // broke the next run. Measured cost of the two forms here: 52ms with untracked, 9ms without —
  // and the cheap one is blind to the instance that cost the most diagnosis.
  return gitOrThrow(["status", "--porcelain"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

/** Porcelain lines present after the suite and absent before it. `null` on either side ⇒ `[]`:
 *  an unreadable snapshot attributes nothing and must never render as "everything is new". A line
 *  that DISAPPEARED is not dirt either — a fixture cleaning up after itself is the healthy case. */
export function newTrackedTreeDirt(before, after) {
  if (before === null || after === null) return [];
  const seen = new Set(before);
  return after.filter((line) => !seen.has(line));
}

/** The message a dirty run prints, naming every path — a gate that reported only a count would
 *  cost the diagnosis the debris already costs. `null` when there is nothing to report. */
export function trackedTreeDirtReport(dirt) {
  if (dirt.length === 0) return null;
  return (
    `TRACKED-TREE DIRT: the suite left ${dirt.length} change(s) in the tracked tree, which every ` +
    `other worker in a concurrent run observes and the NEXT run reads as a regression:\n` +
    dirt.map((d) => `  ${d}`).join("\n") +
    `\nWrite fixtures under mkdtemp, never into the tracked tree. ` +
    `Find the writer with: git grep -n '<the path above>' -- test/ scripts/`
  );
}

/**
 * Extracts failing test names from a Node test-runner run's combined output. Handles both
 * reporter shapes this repo's CI actually emits: TAP (`node --test`'s default when stdout is not
 * a TTY -- true for every CI invocation) and `spec` (explicitly requested by the coverage job's
 * dual-reporter step). Best-effort: a run whose output matches neither shape still retries, just
 * with an unnamed "(no test name parsed from output)" placeholder rather than failing to retry.
 */
export function parseFailingTestNames(output) {
  const names = new Set();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const tap = line.match(/^not ok \d+ - (.+)$/);
    if (tap) {
      names.add(tap[1].trim());
      continue;
    }
    const spec = line.match(/^\s*✖\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)$/);
    if (spec) {
      names.add(spec[1].trim());
    }
  }
  return [...names];
}

/** Extracts test-file paths from TAP failure diagnostic blocks. Test titles are not identities:
 * two files may contain the same title, while Node's `location:` field names the file that must
 * be retried. Paths outside `cwd` are ignored rather than granting a retry access to another
 * checkout. */
export function parseFailingTestFiles(output, cwd = process.cwd()) {
  return [...new Set(parseFailingTestEntries(output, cwd).map((entry) => entry.file))].sort();
}

/**
 * W1-T4112 (design note i) — the SAME TAP scan as {@link parseFailingTestFiles}, paired with the failing test's
 * own title, so each failure becomes one `{ file, test }` pair the ledger can carry. W1-T13790: both read only the
 * column-0 blocks' own `location:` keys (`topLevelTapFailures`), never a path a failure's message quotes.
 */
export function parseFailingTestEntries(output, cwd = process.cwd()) {
  const entries = [];
  for (const failure of topLevelTapFailures(output)) {
    if (failure.location === undefined || !/\.test\.(?:[cm]?[jt]s)$/.test(failure.location)) continue;
    let path = failure.location;
    if (path.startsWith("file://")) path = fileURLToPath(path);
    const rel = (isAbsolute(path) ? relative(cwd, path) : path).split(sep).join("/");
    if (rel !== ".." && !rel.startsWith("../")) entries.push({ test: failure.test, file: rel });
  }
  return entries;
}

/**
 * W1-T4112 (design note i) — THE SAME LEDGER EVERY OTHER FLEET STEP WRITES INTO, not a bespoke
 * file this wrapper invents. `test.flake_retry` is a step name like any other (grep it from
 * source with `git grep -oh '"test\\.[a-z_.]+"'`, per this repo's own "step names come from
 * source" lesson), so `src/lib/test-gardener.ts` reads it back through the ledger UNION resolver
 * (`readLedgerUnionRecordsSync`), never a glob over `state/ledger.*` that only names one rotation
 * form. Defaults to `ledgerPathFor`'s own path (`<root>/state/ledger.ndjson`) under this
 * process's own cwd, which is the repo root in every caller (package.json's `test:ci`, ci.yml's
 * direct invocations) -- overridable for a fixture that must not touch a real checkout's state.
 * `state/` is gitignored, so a run with nothing to retry never dirties the tracked tree.
 */
export function flakeLedgerPath(env = process.env, cwd = process.cwd()) {
  return env.RMD_TEST_FLAKE_LEDGER ?? join(cwd, "state", "ledger.ndjson");
}

/** One ledger row per failing `{ file, test }` pair -- a RECORD, not only the console/step-summary
 *  line `recordFlakeEvidence` already prints. `headline` carries which attempt produced it (first
 *  attempt failed / retry ALSO failed), so a reader can tell a healed flake from one still red on
 *  its own retry, matching `recordFlakeEvidence`'s own two headlines. */
export function flakeLedgerLines(entries, headline) {
  return entries.map((e) => JSON.stringify({ ts: new Date().toISOString(), step: "test.flake_retry", file: e.file, test: e.test, headline }));
}

/** Appends one ledger line per entry. Best-effort, matching `recordFlakeEvidence`'s own posture:
 *  a ledger write that cannot be made must never fail the suite it is only recording evidence
 *  about, so a failure here is reported to stderr and otherwise swallowed. A run with no named
 *  failing file (no TAP `location:` evidence) writes nothing rather than a placeholder row. */
export function appendFlakeLedger(entries, headline, { path = flakeLedgerPath(), append = appendFileSync, mkdir = mkdirSync } = {}) {
  if (entries.length === 0) return;
  try {
    mkdir(dirname(path), { recursive: true });
    for (const line of flakeLedgerLines(entries, headline)) append(path, line + "\n");
  } catch (error) {
    console.error(`test-with-retry: warning: could not append the flake ledger (${error.message})`);
  }
}

function isNodeCommand(cmd) {
  return basename(cmd) === "node" || basename(cmd).startsWith("node.");
}

/** The failure parsers above read TAP only. Node 22 defaulted a piped `node --test` to TAP; Node 24
 *  defaults to `spec` on every stream, which would leave a failing run with no attributable file, no
 *  scoped retry and no flake-ledger row. So a Node test command that names no reporter is given TAP
 *  explicitly; one that names its own reporter is left as written. */
export function withTapReporter(cmd, args) {
  if (!isNodeCommand(cmd) || !args.includes("--test") || args.some((arg) => arg.startsWith("--test-reporter"))) return [...args];
  const at = args.indexOf("--test") + 1;
  return [...args.slice(0, at), "--test-reporter=tap", ...args.slice(at)];
}

function isTestFileSelector(arg) {
  return /\.test\.(?:[cm]?[jt]s)$/.test(arg) || (/[*?[\]]/.test(arg) && /\.test\./.test(arg));
}

/** Builds pass two. Known Node test invocations are narrowed to the exact failed files; unknown
 * commands retain the old whole-command retry as a fail-safe. A shard selector is removed because
 * exact files have already been attributed to this shard and Node could otherwise hash them out. */
export function retryInvocationForFailedFiles(cmd, args, failedFiles) {
  if (failedFiles.length === 0 || !isNodeCommand(cmd)) return { cmd, args: [...args], scoped: false };

  if (args[0]?.endsWith("scripts/test-tier-manifest.mjs")) {
    return {
      cmd,
      args: ["--test", "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", ...failedFiles],
      scoped: true,
    };
  }

  if (args.includes("--test")) {
    const retained = args.filter((arg) => !arg.startsWith("--test-shard=") && !isTestFileSelector(arg));
    return { cmd, args: [...retained, ...failedFiles], scoped: true };
  }

  return { cmd, args: [...args], scoped: false };
}

/** Flags that make a Node test run write coverage or reporter files; a value-taking one also
 *  owns the argument after it when it is not written `--flag=value`. */
const COVERAGE_FLAGS = new Set(["--experimental-test-coverage"]);
const COVERAGE_VALUE_FLAGS = new Set([
  "--test-coverage-exclude",
  "--test-coverage-include",
  "--test-reporter",
  "--test-reporter-destination",
]);

/** Node's compile cache can reduce V8 coverage precision, including branch detail. W1-T12415: the
 *  hang-bound manifest is this wrapper's own input, so no test process gets it. A test that runs a copy
 *  of this wrapper in a fixture directory would otherwise look for the manifest there, and fail. */
export function coverageChildEnvironment(env) {
  const childEnv = { ...env, NODE_DISABLE_COMPILE_CACHE: "1" };
  delete childEnv.NODE_COMPILE_CACHE;
  delete childEnv[COVERAGE_HANG_MANIFEST_ENV];
  return childEnv;
}

/** W1-T4398 — pass two of the coverage lane: the same Node test command narrowed to the failed files,
 *  with every coverage and reporter flag removed and NODE_V8_COVERAGE emptied in the environment,
 *  so the retry writes nothing the coverage gates read. `null` when there is no file to retry or
 *  the command is not a Node test run: the coverage lane then keeps pass one's verdict. */
export function coverageRetryInvocation(cmd, args, failedFiles, env = process.env) {
  if (failedFiles.length === 0 || !isNodeCommand(cmd) || !args.includes("--test")) return null;
  const retained = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const flag = arg.split("=")[0];
    if (COVERAGE_FLAGS.has(arg) || isTestFileSelector(arg)) continue;
    if (COVERAGE_VALUE_FLAGS.has(flag)) {
      if (!arg.includes("=")) i += 1;
      continue;
    }
    retained.push(arg);
  }
  // EMPTY, NOT DELETED: Node copies its own NODE_V8_COVERAGE into any child whose env lacks the
  // key, so a deleted key still hands an enclosing coverage run's directory to the retry.
  const retryEnv = { ...env, NODE_V8_COVERAGE: "" };
  delete retryEnv[COVERAGE_HANG_MANIFEST_ENV];
  return { cmd, args: [...withTapReporter(cmd, retained), ...failedFiles], env: retryEnv };
}

/**
 * A PASS IS A RUN THAT FINISHED (2026-10-11 follow-up to #10894). Every attempt this wrapper spawns
 * that is itself a `node --test` run — `test:ci`, the coverage shard's instrumented pass, every
 * failed-file retry — is judged by scripts/pure-test-pool.mjs: it passes only when every test file it
 * names reached its own summary with `# fail 0`. Node reports a file whose child exits 0 part-way as
 * `ok`, so exit 0 alone is not a pass. A file the judge names as unreported is one this wrapper
 * retries, like a file with a `not ok`. A wrapped runner that is not `node --test` itself
 * (scripts/test-tier-manifest.mjs) judges its own children and prints the same lines.
 */
function isNodeTestRun(cmd, args) {
  return isNodeCommand(cmd) && args.includes("--test");
}

async function runOnce(cmd, args, env = process.env) {
  if (!isNodeTestRun(cmd, args)) return runChild(cmd, args, env);
  const files = testFilesInArgv(args, process.cwd());
  const judged = prepareJudgedRun({ files, root: process.cwd() });
  const first = await runChild(cmd, judgedNodeTestArgs(boundedNodeTestArgs(args, process.cwd()), judged.args), { ...env, ...judged.env });
  const lines = [];
  const { status, verdict } = closeJudgedRun(judged, files, {
    status: first.code,
    pool: args.includes(POOL_ISOLATION_FLAG),
    root: process.cwd(),
    role: "node --test",
    log: (line) => {
      lines.push(line);
      process.stderr.write(`${line}\n`);
    },
  });
  return { code: status, output: `${first.output}\n${lines.join("\n")}\n`, unreported: verdict.missing };
}

/**
 * The files a failed attempt names: each `not ok` file, and each file the judge never heard finish.
 * An attempt this wrapper judged itself carries its verdict's `unreported` list, and only that list
 * is trusted: the output also holds what the tests printed, and a test of the judge prints judge lines
 * about its own fixture files. A wrapped runner that judges its own children (the tier manifest) is
 * read from its output, keeping only files that exist here.
 */
export function failedFilesOf(attempt, cwd = process.cwd()) {
  const named = attempt.unreported ?? unreportedFilesIn(attempt.output).filter((file) => existsSync(resolve(cwd, file)));
  const unreported = named.map((file) => (isAbsolute(file) ? relative(cwd, file) : file).split(sep).join("/"));
  return [...new Set([...parseFailingTestFiles(attempt.output, cwd), ...unreported.filter((rel) => rel !== ".." && !rel.startsWith("../"))])].sort();
}

function runChild(cmd, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], env });
    let combined = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      combined += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      combined += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), output: combined });
    });
  });
}

/**
 * Parses $TEST_RETRY_BUDGET_SECONDS into a positive finite number of seconds, or `undefined` when
 * unset/blank/non-numeric/non-positive -- `undefined` means "no budget given," which preserves
 * this wrapper's pre-W1-T2433 behavior exactly (retry unconditionally on a non-zero first pass).
 * This is the ONLY job-bound-shaped input the wrapper reads; it never inspects `timeout-minutes`,
 * `WAIT_CAP_SECONDS`, or any other GitHub Actions-supplied timing signal.
 */
export function parseBudgetSeconds(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return undefined;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * DO NOT START A PASS YOU CANNOT FINISH. Given how long pass 1 took and the total budget the
 * caller was handed, decides whether pass 2 -- an identical whole-command re-run -- can plausibly
 * finish inside it. With no budget supplied, always retries (unchanged pre-W1-T2433 behavior).
 * With a budget, retries only when what's left (budget minus pass 1's elapsed time) is at least
 * what pass 1 itself consumed -- the same two-pass-at-the-median arithmetic the task is sized
 * against, expressed generically so it never hardcodes this repo's specific job bound.
 */
export function shouldAttemptRetry({ budgetSeconds, firstPassElapsedMs }) {
  if (budgetSeconds === undefined) {
    return true;
  }
  const firstPassSeconds = firstPassElapsedMs / 1000;
  const remainingSeconds = budgetSeconds - firstPassSeconds;
  return remainingSeconds >= firstPassSeconds;
}

/**
 * W1-T7125: the label after `FLAKE-RETRY: <headline> — `. Names are normally joined with ", ", but a
 * test title may itself contain ", " -- a consumer splitting on ", " would read one title as two
 * incidents. So whenever the plain join would be ambiguous (a name containing ", ", or a label
 * that would start with "[" and be mistaken for the array form) the names are written as a JSON
 * string array instead. Consumers parse a "[...]" label as that array and still split the plain
 * form, so logs written before this change stay readable.
 */
export function formatFlakeLabel(names) {
  if (names.length === 0) return "(no test name parsed from output)";
  const plain = names.join(", ");
  return names.some((n) => n.includes(", ")) || plain.startsWith("[") ? JSON.stringify(names) : plain;
}

function recordFlakeEvidence(headline, names) {
  const label = formatFlakeLabel(names);
  const line = `FLAKE-RETRY: ${headline} — ${label}`;
  console.log(line);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, line + "\n");
  }
}

function coverageOptions(args) {
  const values = (flag) => args.flatMap((arg, index) => {
    if (arg === flag) return [args[index + 1]];
    return arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : [];
  });
  const reporters = values("--test-reporter");
  const destinations = values("--test-reporter-destination");
  return {
    output: destinations[reporters.indexOf("lcov")],
    excludeGlobs: values("--test-coverage-exclude"),
    includeGlobs: values("--test-coverage-include"),
    sourceMaps: args.includes("--enable-source-maps"),
  };
}

/** W1-T14306: the argv of the `--rebuild-coverage` repair child, built in one place for both repair sites. The
 *  child builds the whole coverage summary and then exits through process.exit, the shape that can deadlock on
 *  Node 24.22.3 while a concurrent Sparkplug or Maglev compile job waits for a GC (nodejs/node#64274), so it runs
 *  with the shard runner's own NODE_EXIT_DEADLOCK_WORKAROUND_ARGS (#20139). Drop the flags here together with the
 *  shard runner's, once the pinned Node carries the upstream fix 77fdeb6. */
export function rebuildCoverageChildArgs(rawDir, args) {
  return [...NODE_EXIT_DEADLOCK_WORKAROUND_ARGS, "--expose-internals", fileURLToPath(import.meta.url), "--rebuild-coverage", rawDir, ...args];
}

function rebuildCoverage(rawDir, args) {
  try {
    const { output, ...options } = coverageOptions(args);
    const { TestCoverage } = createRequire(import.meta.url)("internal/test_runner/coverage");
    const collector = newTestCoverage(TestCoverage, { cwd: process.cwd(), ...options });
    collector.coverageDirectory = resolve(rawDir);
    const summary = collector.summary();
    if (summary.files.length === 0) throw new Error("no source coverage remains after dropping unreportable files");
    writeFileSync(output, renderCoverageSummary(summary));
    return 0;
  } catch (error) {
    console.error(`test-with-retry: coverage rebuild failed: ${error.message}`);
    return /failed to parse coverage file/.test(error.message) || error instanceof TypeError ? 2 : 1;
  }
}

// W1-T8585: the run's OWN summary is the TAP summary block after the LAST `# tests` line. A nested
// `node --test` prints a bare summary of its own earlier. Only summary lines are read, so interleaved
// spec lines do not split the block; a label missing or repeated in it means no summary (null).
const SUMMARY_LINE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)$/;

function finalSummary(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd().match(SUMMARY_LINE)).filter(Boolean);
  const start = lines.findLastIndex(([, label]) => label === "tests");
  if (start < 0) return null;
  const counts = {};
  for (const [, label, value] of lines.slice(start)) {
    if (label in counts) return null;
    counts[label] = Number(value);
  }
  return ["tests", "pass", "fail", "cancelled"].every((label) => label in counts) ? counts : null;
}

function finalSummaryAllPass(output) {
  const counts = finalSummary(output);
  return counts !== null && counts.pass > 0 && counts.tests === counts.pass + (counts.skipped ?? 0) &&
    counts.fail === 0 && counts.cancelled === 0 && (counts.todo ?? 0) === 0;
}

function emptyCoverageFailure(cmd, args, output) {
  return isNodeCommand(cmd) && args.includes("--test") && args.includes("--experimental-test-coverage") &&
    /ERR_OPERATION_FAILED[^\n]*(?:coverage file is empty:|failed to parse coverage file )/.test(output) &&
    finalSummaryAllPass(output);
}

// A child killed mid-write leaves a truncated report; it moves beside rawDir as evidence, never deleted.
function unparseableCoverage(path) {
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return false;
  } catch {
    return true;
  }
}

async function recoverEmptyCoverage(treeBefore, first, cmd, args, rawDir) {
  const dropped = [];
  try {
    for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^coverage-\d+-\d{13}-\d+\.json$/.test(entry.name)) continue;
      const path = join(rawDir, entry.name);
      if (statSync(path).size === 0) {
        unlinkSync(path);
        dropped.push(path);
      } else if (unparseableCoverage(path)) {
        const aside = `${resolve(rawDir)}-unparseable`;
        mkdirSync(aside, { recursive: true });
        renameSync(path, join(aside, entry.name));
        dropped.push(`${path} (truncated, kept in ${aside})`);
      }
    }
  } catch (error) {
    console.error(`test-with-retry: could not drop empty or truncated coverage files: ${error.message}`);
    return reportTrackedTreeDirt(treeBefore, first.code);
  }
  if (dropped.length === 0 || !coverageOptions(args).output) return reportTrackedTreeDirt(treeBefore, first.code);
  const env = coverageChildEnvironment({ ...process.env, NODE_V8_COVERAGE: "" });
  // The rebuild is this script, not a test run, even though the coverage command's own args ride along.
  const rebuilt = await runChild(process.execPath, rebuildCoverageChildArgs(rawDir, args), env);
  let code = rebuilt.code;
  if (code === 1) {
    console.log(`FLAKE-RETRY: coverage rebuild failed — retrying the coverage shard once — ${dropped.join(", ")}`);
    const second = await runOnce(cmd, args, { ...env, NODE_V8_COVERAGE: rawDir });
    code = second.code;
    if (code !== 0) recordFlakeEvidence("retry ALSO failed", parseFailingTestNames(second.output));
  }
  if (code === 0) {
    const line = `FLAKE-RETRY-RECOVERED: dropped unreportable coverage file(s) — ${dropped.join(", ")}`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
  }
  // W1-T8585: the rebuild repairs coverage only; a run whose own summary is not all-pass keeps its code.
  return reportTrackedTreeDirt(treeBefore, code === 0 && finalSummaryAllPass(first.output) ? 0 : first.code || 1);
}

// W1-T12415 — A FORCE-EXITED FIXTURE MODULE DOES NOT COST THE SHARD ITS LCOV. Under --test-force-exit a
// worker thread's raw coverage can keep the source map of a module a test wrote into its own temp
// directory and has since deleted (read-model-worker.test.ts's restarted-publisher.mjs). Node then
// throws ERR_SOURCE_MAP_MISSING_SOURCE, writes no lcov, and exits 1 although every test passed. Node
// never reports a file outside the working directory, so that source map changes no reported figure.
// Only such an entry is dropped: its script and its missing source are both outside the working
// directory. A missing source inside the tree is never dropped, and the run stays failed.
const MISSING_SOURCE = /Cannot find '([^']+)' imported from the source map for '([^']+)'/g;
const MISSING_SOURCE_ROUNDS = 20;

function outsideTree(url, root) {
  try {
    const path = fileURLToPath(url);
    return !resolve(path).startsWith(root);
  } catch {
    return false;
  }
}

/** The script URLs whose source maps name a deleted source outside `cwd`, from node's coverage warnings in `output`. */
export function missingFixtureSourceMaps(output, cwd = process.cwd()) {
  const root = resolve(cwd) + sep;
  const scripts = new Set();
  for (const [, source, script] of output.matchAll(MISSING_SOURCE)) {
    if (outsideTree(source, root) && outsideTree(script, root) && !existsSync(fileURLToPath(source))) scripts.add(script);
  }
  return [...scripts];
}

/** Removes the source-map-cache entries of `scripts` from the raw reports in `rawDir`. Each changed report's
 *  original moves beside rawDir as evidence. Returns the changed report paths. */
export function dropFixtureSourceMaps(rawDir, scripts) {
  const changed = [];
  const aside = `${resolve(rawDir)}-missing-source`;
  for (const entry of readdirSync(rawDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^coverage-\d+-\d{13}-\d+\.json$/.test(entry.name)) continue;
    const path = join(rawDir, entry.name);
    const text = readFileSync(path, "utf8");
    if (!scripts.some((script) => text.includes(JSON.stringify(script)))) continue;
    const report = JSON.parse(text);
    const cache = report["source-map-cache"];
    const present = cache && typeof cache === "object" ? scripts.filter((script) => Object.hasOwn(cache, script)) : [];
    if (present.length === 0) continue;
    for (const script of present) delete cache[script];
    mkdirSync(aside, { recursive: true });
    renameSync(path, join(aside, entry.name));
    writeFileSync(path, JSON.stringify(report));
    changed.push(path);
  }
  return changed;
}

/** Drops deleted fixtures' source maps from the raw coverage and rebuilds the lcov, round by round, because
 *  node names one missing source per failure. True when the lcov was rebuilt. */
async function repairFixtureSourceMaps(firstOutput, args, rawDir) {
  if (!coverageOptions(args).output) return false;
  const env = coverageChildEnvironment({ ...process.env, NODE_V8_COVERAGE: "" });
  const dropped = new Set();
  let output = firstOutput;
  for (let round = 0; round < MISSING_SOURCE_ROUNDS; round += 1) {
    const scripts = missingFixtureSourceMaps(output).filter((script) => !dropped.has(script));
    if (scripts.length === 0) return false;
    try {
      dropFixtureSourceMaps(rawDir, scripts);
    } catch (error) {
      console.error(`test-with-retry: could not drop deleted fixtures' source maps: ${error.message}`);
      return false;
    }
    for (const script of scripts) dropped.add(script);
    const rebuilt = await runChild(process.execPath, rebuildCoverageChildArgs(rawDir, args), env);
    if (rebuilt.code === 0) {
      const line = `FLAKE-RETRY-RECOVERED: dropped the source maps of deleted fixture module(s) outside the tree and rebuilt lcov — ${[...dropped].join(", ")}`;
      console.log(line);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
      return true;
    }
    output = rebuilt.output;
  }
  return false;
}

export async function main(argv) {
  if (argv[0] === "--rebuild-coverage") return rebuildCoverage(argv[1], argv.slice(2));
  const coverageFirstPass = argv[0] === "--coverage-first-pass";
  const rawCoverageDir = coverageFirstPass ? argv[1] : undefined;
  const [cmd, ...given] = coverageFirstPass ? argv.slice(2) : argv;
  const tapArgs = cmd ? withTapReporter(cmd, given) : given;
  // W1-T12415: the coverage shard names its instrumented duration manifest, so a hung test fails by
  // its name inside the job ceiling. The bound is in `args`, so the failed-file retry keeps it too.
  const hangManifest = coverageFirstPass ? process.env[COVERAGE_HANG_MANIFEST_ENV] : undefined;
  const args = hangManifest && cmd && isNodeCommand(cmd) ? withCoverageHangBound(tapArgs, hangManifest, process.cwd()) : tapArgs;
  if (!cmd || (coverageFirstPass && !rawCoverageDir)) {
    console.error("usage: test-with-retry.mjs <command> [args...]");
    console.error("       test-with-retry.mjs --coverage-first-pass <raw-coverage-dir> <command> [args...]");
    return 2;
  }

  // W1-T2715: the BEFORE half, taken once around the whole suite — see this module's own doc for
  // why this is not per-test-process. Read before anything is spawned, so an operator's own
  // pre-existing edits are never attributed to the run.
  const treeBefore = readTrackedTreeState();

  const startedAt = Date.now();
  const firstEnv = coverageFirstPass
    ? coverageChildEnvironment({ ...process.env, NODE_V8_COVERAGE: rawCoverageDir })
    : process.env;
  const first = await runOnce(cmd, args, firstEnv);
  if (first.code === 0) {
    return reportTrackedTreeDirt(treeBefore, 0);
  }

  if (coverageFirstPass) reportUnparseableCoverage(first, rawCoverageDir);

  if (process.env.TEST_RETRY === "0") {
    return reportTrackedTreeDirt(treeBefore, first.code);
  }

  const firstPassElapsedMs = Date.now() - startedAt;
  const firstNames = parseFailingTestNames(first.output);
  const failedFiles = failedFilesOf(first);
  recordFlakeEvidence("first attempt failed", firstNames);
  appendFlakeLedger(parseFailingTestEntries(first.output), "first attempt failed");

  const budgetSeconds = parseBudgetSeconds(process.env.TEST_RETRY_BUDGET_SECONDS);
  if (!shouldAttemptRetry({ budgetSeconds, firstPassElapsedMs })) {
    const firstPassSeconds = (firstPassElapsedMs / 1000).toFixed(1);
    const remainingSeconds = (budgetSeconds - firstPassElapsedMs / 1000).toFixed(1);
    recordFlakeEvidence(
      `declined retry — pass 1 took ${firstPassSeconds}s, leaving ${remainingSeconds}s of a ` +
        `${budgetSeconds}s budget, not enough for another pass`,
      firstNames,
    );
    return reportTrackedTreeDirt(treeBefore, first.code);
  }

  // W1-T8585: a run that names a failing test or file is never recovered by dropping coverage.
  const namedFailure = firstNames.length > 0 || failedFiles.length > 0;
  // W1-T12415: the lcov is repaired first, so a failed-file retry that passes still leaves the gates a report.
  if (coverageFirstPass && isNodeCommand(cmd) && /Could not report code coverage/.test(first.output) &&
      await repairFixtureSourceMaps(first.output, args, rawCoverageDir) && !namedFailure && finalSummaryAllPass(first.output)) {
    return reportTrackedTreeDirt(treeBefore, 0);
  }
  if (coverageFirstPass && !namedFailure && emptyCoverageFailure(cmd, args, first.output)) return recoverEmptyCoverage(treeBefore, first, cmd, args, rawCoverageDir);
  if (coverageFirstPass) return coverageRetry(treeBefore, first.code, coverageRetryInvocation(cmd, args, failedFiles), failedFiles, firstNames);

  const retry = retryInvocationForFailedFiles(cmd, args, failedFiles);
  if (retry.scoped) {
    console.log(`FLAKE-RETRY-FILES: retrying ${failedFiles.length} failed file(s) — ${failedFiles.join(", ")}`);
  }
  const second = await runOnce(retry.cmd, retry.args);
  // Evidence-preserving on non-recovery too: a retry that ALSO fails (a deterministic break, or a
  // double flake) must leave its own greppable record rather than only the first attempt's — so a
  // break the retry did NOT paper over is just as countable as one it did.
  if (second.code !== 0) {
    recordFlakeEvidence("retry ALSO failed", parseFailingTestNames(second.output));
    appendFlakeLedger(parseFailingTestEntries(second.output), "retry ALSO failed");
  }
  return reportTrackedTreeDirt(treeBefore, second.code);
}

/**
 * W1-T5767: pass 1 failed with zero test failures and node warned it "Could not report code
 * coverage" -- a raw V8 file was unparseable (e.g. cut at 64 KiB). Names each such file (name,
 * bytes, pid) on stdout and $GITHUB_STEP_SUMMARY. Reports only: the exit code is untouched and
 * nothing is retried.
 */
function reportUnparseableCoverage(first, rawDir) {
  if (!/Could not report code coverage/.test(first.output)) return;
  if (Number(first.output.match(/^# fail (\d+)$/m)?.[1]) !== 0) return;
  let names;
  try {
    names = readdirSync(rawDir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const m = name.match(/^coverage-(\d+)-.*\.json$/);
    if (!m) continue;
    const path = join(rawDir, name);
    try {
      JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      let bytes = -1;
      try {
        bytes = statSync(path).size;
      } catch {
        /* vanished between read and stat */
      }
      const line = `COVERAGE-REPORT-FAILED: ${name} bytes=${bytes} pid=${m[1]} (${err instanceof Error ? err.message : String(err)})`;
      console.log(line);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
    }
  }
}

/** W1-T4398 — the coverage lane's pass two. Pass one's code stands when nothing can be retried. */
async function coverageRetry(treeBefore, firstCode, retry, failedFiles, firstNames) {
  if (retry === null) {
    console.log("FLAKE-RETRY-FILES: no failed test file could be named — the instrumented run is not repeated, and its verdict stands");
    return reportTrackedTreeDirt(treeBefore, firstCode);
  }
  console.log(`FLAKE-RETRY-FILES: retrying ${failedFiles.length} failed file(s) uninstrumented — ${failedFiles.join(", ")}`);
  const second = await runOnce(retry.cmd, retry.args, retry.env);
  if (second.code !== 0) {
    recordFlakeEvidence("retry ALSO failed", parseFailingTestNames(second.output));
    appendFlakeLedger(parseFailingTestEntries(second.output), "retry ALSO failed");
  } else {
    const line = `FLAKE-RETRY-RECOVERED: a flake, not a pass — coverage figures are pass one's — ${firstNames.join(", ") || "(no test name parsed from output)"}`;
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
  }
  return reportTrackedTreeDirt(treeBefore, second.code);
}

/**
 * W1-T2715: the AFTER half. Called on EVERY return path, so a run that failed its tests still says
 * whether it also dirtied the tree — the two are independent facts and a red suite must not hide a
 * leak. Never LOWERS an exit code: a failing suite keeps its own code, and only a green-but-dirty
 * run is turned red by this. Reads git; writes nothing.
 */
function reportTrackedTreeDirt(treeBefore, code) {
  const report = trackedTreeDirtReport(newTrackedTreeDirt(treeBefore, readTrackedTreeState()));
  if (report === null) return code;
  process.stderr.write(`${report}\n`);
  recordFlakeEvidence("tracked-tree dirt", []);
  return code === 0 ? 1 : code;
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
