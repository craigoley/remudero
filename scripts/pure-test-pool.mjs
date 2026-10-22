// scripts/pure-test-pool.mjs — which test files may share ONE node process (W1-T6085).
//
// WHY: `node --test` gives every file its own child, so every file pays node + tsx start and loads
// ~437 src modules. A "pure" file — one that writes no env, never chdirs, spawns nothing and patches
// no global — cannot tell whether it shares a process, so a shard can run all of them in one child
// under --experimental-test-isolation=none (measured 1.53 -> 0.74 s plain, 4.15 -> 1.56 s under
// coverage on 4 files, identical line hits).
//
// THE CENSUS IS STATIC AND CONSERVATIVE: a file is admitted only when its source is READABLE and
// matches none of the {@link POOL_REFUSALS}. Anything the census cannot read is refused, never
// admitted — a false refusal costs one process start, a false admission costs a cross-file leak.
//
// Plain .mjs on purpose: ci runs scripts/test-tier-manifest.mjs under plain node, with no tsx.

import { globSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The node flag that makes `node --test` run every file in the runner's own process. */
export const POOL_ISOLATION_FLAG = "--experimental-test-isolation=none";

const ASSIGN_OP = String.raw`(?:\?\?|\|\||&&|\*\*|<<|>>>?|[-+*/%&|^])?=(?!=)`;

/** Each refusal: a stable `name` (what the census reports) and the `pattern` that triggers it. */
export const POOL_REFUSALS = [
  {
    name: "process.env write",
    pattern: new RegExp(
      String.raw`process\.env\b(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])?\s*${ASSIGN_OP}` +
        String.raw`|process\.env\b(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])?\s*(?:\+\+|--)` +
        String.raw`|\bdelete\s+process\.env\b` +
        String.raw`|\b(?:Object\.(?:assign|defineProperty|defineProperties|setPrototypeOf)|Reflect\.(?:set|defineProperty|deleteProperty))\s*\(\s*process\.env\b` +
        String.raw`|=\s*process\.env\s*(?:;|$)`,
      "m",
    ),
  },
  { name: "process.chdir", pattern: /\bchdir\s*\(/ },
  {
    name: "child_process / spawn / exec",
    pattern: /child_process|\b(?:spawnSync|execSync|execFileSync|execFile)\s*\(|(?<![.\w$])(?:spawn|exec|fork)\s*\(/,
  },
  {
    name: "global or prototype assignment",
    pattern: new RegExp(
      String.raw`\b(?:globalThis|global|window|self)\b(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])\s*${ASSIGN_OP}` +
        String.raw`|\.prototype\b(?:\s*\.\s*[\w$]+|\s*\[[^\]]*\])?\s*${ASSIGN_OP}` +
        String.raw`|\b(?:process|console|Date|Math|JSON|Object|Array|Promise|Buffer|Intl|Reflect|Symbol|Error)\s*\.\s*(?!env\b)[\w$.]+\s*${ASSIGN_OP}` +
        String.raw`|\bObject\.(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\(\s*(?:globalThis|global|process|console|[\w$.]*\.prototype)\b` +
        String.raw`|\bReflect\.(?:set|defineProperty|deleteProperty|setPrototypeOf)\s*\(\s*(?:globalThis|global|process|console)\b` +
        String.raw`|=\s*(?:globalThis|global)\s*(?:;|$)` +
        String.raw`|\bprocess\s*\[`,
      "m",
    ),
  },
  {
    name: "module mock",
    pattern: /\bmock\s*\.\s*(?:module|method|getter|setter|property)\s*\(|\bmock\.module\b|\bregister\s*\(\s*["'`]/,
  },
  {
    name: "timer fake",
    pattern: /\bmock\s*\.\s*timers\b|\buseFakeTimers\b|\bFakeTimers\b|\bsinon\b|\bjest\b/,
  },
  {
    name: "process-level listener",
    pattern:
      /\bprocess\s*\.\s*(?:on|once|off|addListener|prependListener|prependOnceListener|removeListener|removeAllListeners|setUncaughtExceptionCaptureCallback|setSourceMapsEnabled|umask|exit|abort|kill|emitWarning)\s*\(/,
  },
];

/**
 * Judge ONE test file's source. `source` that is not a non-empty string is unreadable and refused.
 * @returns {{ admitted: boolean, reasons: string[] }}
 */
export function censusSource(source) {
  if (typeof source !== "string" || source.trim() === "") {
    return { admitted: false, reasons: ["unreadable (census refuses what it cannot read)"] };
  }
  const reasons = POOL_REFUSALS.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name);
  return { admitted: reasons.length === 0, reasons };
}

/** Read `file` under `root` and judge it. A read error is a refusal, never an admission. */
export function censusFile(file, { root = ".", readFile = (path) => readFileSync(path, "utf8") } = {}) {
  let source;
  try {
    source = readFile(join(root, file));
  } catch (error) {
    return { admitted: false, reasons: [`unreadable: ${error && error.message ? error.message : String(error)}`] };
  }
  return censusSource(source);
}

/**
 * Split a shard's `files` into the pool and everything else. A file is pooled only when it is in the
 * fast tier (`fast` is the tier's file list) AND the census admits it. Order is preserved.
 * @returns {{ pooled: string[], isolated: string[], refusals: Record<string, string[]> }}
 */
export function partitionPool(files, { fast, root = ".", readFile } = {}) {
  const fastSet = new Set(fast ?? []);
  const pooled = [];
  const isolated = [];
  const refusals = {};
  for (const file of files) {
    if (!fastSet.has(file)) {
      isolated.push(file);
      refusals[file] = ["not in the fast tier"];
      continue;
    }
    const verdict = censusFile(file, { root, readFile });
    if (verdict.admitted) pooled.push(file);
    else {
      isolated.push(file);
      refusals[file] = verdict.reasons;
    }
  }
  return { pooled, isolated, refusals };
}

/**
 * Run a shard: the pool in ONE child, everything else as the caller runs it today.
 *
 * `run(files, { pool, quiet, role })` spawns one `node --test` child over `files` (isolation=none when
 * `pool`) and returns its exit status. A pool of fewer than two files is not worth a pool.
 *
 * A pool child that FAILS is re-run isolated once. If that passes, the failure was the pool's own
 * (a cross-file leak), not a test failure: the leaking file is located and named, the shard is green
 * and the defect is reported. If it fails isolated too, the failure is the tests' own and is returned.
 *
 * ORDER (2026-10-11 hang): the isolated rest runs BEFORE the leak is located. Location is a diagnostic
 * of quiet pool re-runs; it ran first and, with a linear search over a 224-file pool at ~30 s a probe,
 * held three ci-shards silent until the job's 35-minute cancel, after every test had passed and with
 * the rest never run. The shard's verdict is now complete before any probe starts, and every probe
 * logs a line, so a slow location reads as progress, never as a hang.
 *
 * BOUNDED BY WHAT THE SHARD MEASURED (W1-T9426, 2026-10-14 #11629): with the verdict final, one
 * locate probe still ran 18 minutes and the job's 35-minute cancel turned a 1358/1358 green shard
 * into SHARD HANG. So each probe's `deadlineMs` is the full pool run's own measured wall time (a probe
 * runs a subset of it), and a probe starts only while the job's remaining time ({@link jobCancelAtMs})
 * holds one average probe plus as much again for the job to finish. A probe past its deadline, or one
 * the budget cannot fit, ends location at once: the leak is reported not isolated, with the files the
 * search had narrowed to, and the shard's final status is returned unchanged.
 *
 * @returns {{ status: number, poolDefect: null | { leaker: string | null, victim: string | null, stopped?: true, narrowed?: string[] } }}
 */
export function runShardWithPool(files, { fast, root = ".", readFile, run, log = (line) => console.error(line), now = Date.now, env = process.env }) {
  const { pooled, isolated } = partitionPool(files, { fast, root, readFile });
  if (pooled.length < 2) return { status: run(files, { pool: false, role: "rest" }), poolDefect: null };

  let status = 0;
  let leaked = false;
  const poolStarted = now();
  const poolStatus = run(pooled, { pool: true, role: "pool" });
  const poolMs = Math.max(1, now() - poolStarted);
  if (poolStatus !== 0) {
    log(`pure-test-pool: the pool of ${pooled.length} file(s) failed (status ${poolStatus}); re-running them isolated once.`);
    const again = run(pooled, { pool: false, role: "rerun" });
    if (again !== 0) {
      status = again;
      log("pure-test-pool: the pooled files also fail isolated — a test failure, not a pool defect.");
    } else {
      leaked = true;
    }
  }
  if (isolated.length > 0) {
    const rest = run(isolated, { pool: false, role: "rest" });
    if (status === 0) status = rest;
  }
  let poolDefect = null;
  if (leaked) {
    log(`pure-test-pool: every pooled file passes isolated; locating the leak among ${pooled.length} file(s) (shard status ${status} is already final).`);
    const cancelAtMs = jobCancelAtMs(env);
    const seconds = (ms) => Math.round(ms / 1000);
    let probes = 0;
    let probeMsTotal = 0;
    poolDefect = locateLeak(pooled, (subset) => {
      const ending = `${subset.length} file(s) ending ${subset.at(-1)}`;
      const averageMs = probes > 0 ? probeMsTotal / probes : poolMs;
      const leftMs = cancelAtMs === undefined ? Infinity : cancelAtMs - now();
      const deadlineMs = Math.min(poolMs, leftMs - averageMs);
      if (deadlineMs < averageMs) {
        log(
          `pure-test-pool: locate probe ${probes + 1} NOT STARTED (${ending}): the job has ${seconds(leftMs)}s left, ` +
            `and a probe needs ~${seconds(averageMs)}s plus as much again for the job to finish — location stops.`,
        );
        return null;
      }
      probes += 1;
      const started = now();
      const probeStatus = run(subset, { pool: true, quiet: true, role: "locate", deadlineMs: Math.ceil(deadlineMs) });
      probeMsTotal += now() - started;
      if (probeStatus === RUN_PAST_DEADLINE) {
        log(
          `pure-test-pool: locate probe ${probes} HUNG (${ending}): killed at its ${seconds(deadlineMs)}s deadline ` +
            `(the full pool run took ${seconds(poolMs)}s) — location stops.`,
        );
        return null;
      }
      log(`pure-test-pool: locate probe ${probes}: ${ending} -> status ${probeStatus}`);
      return probeStatus;
    });
    const narrowed = poolDefect.narrowed
      ? `; location stopped, the leak lies among these ${poolDefect.narrowed.length} file(s): ${poolDefect.narrowed.join(" ")}`
      : "";
    log(
      `pure-test-pool: POOL DEFECT — every pooled file passes isolated but the pool failed; ` +
        `leaking file: ${poolDefect.leaker ?? "not isolated to one file"}` +
        (poolDefect.victim ? ` (first failing alongside it: ${poolDefect.victim})` : "") +
        ` after ${probes} probe(s)${narrowed}. Add the leak to the census in scripts/pure-test-pool.mjs.`,
    );
  }
  return { status, poolDefect };
}

/**
 * Name the file that leaks, in O(log n) pool runs. `runPool(subset)` returns a status.
 *
 * The smallest failing PREFIX ends at the victim (the file that trips over the leak, or the leaker
 * itself). The leaker is then the last file of the shortest run of the victim's predecessors that
 * still fails with the victim appended; a victim that fails pooled ALONE is its own leaker. Both are
 * binary searches: the linear "drop one file at a time" search this replaced cost up to one full pool
 * run per predecessor (2026-10-11: past 33 minutes on one shard).
 *
 * A `runPool` that returns `null` was stopped (W1-T9426): the search ends there and reports, as
 * `narrowed`, the fewest files it had seen fail together, which still hold the leak.
 * @returns {{ leaker: string | null, victim: string | null, stopped?: true, narrowed?: string[] }}
 */
export function locateLeak(pooled, runPool) {
  const stoppedAt = (narrowed) => ({ leaker: null, victim: null, stopped: true, narrowed });
  let lo = 1;
  let hi = pooled.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const probe = runPool(pooled.slice(0, mid));
    if (probe === null) return stoppedAt(pooled.slice(0, hi));
    if (probe !== 0) hi = mid;
    else lo = mid + 1;
  }
  const prefix = pooled.slice(0, hi);
  const reproduced = runPool(prefix);
  if (reproduced === null) return stoppedAt(prefix);
  if (reproduced === 0) return { leaker: null, victim: null }; // the failure did not reproduce
  const victim = prefix[prefix.length - 1];
  const before = prefix.slice(0, -1);
  const alone = runPool([victim]);
  if (alone === null) return stoppedAt(prefix);
  if (alone !== 0) return { leaker: victim, victim };
  // With every predecessor it is the failing prefix itself; find the fewest that still fail.
  let low = 1;
  let high = before.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const probe = runPool([...before.slice(0, mid), victim]);
    if (probe === null) return stoppedAt([...before.slice(0, high), victim]);
    if (probe !== 0) high = mid;
    else low = mid + 1;
  }
  return { leaker: before[high - 1], victim };
}

/** What a run killed at its `deadlineMs` returns in place of an exit status (W1-T9426). */
export const RUN_PAST_DEADLINE = "past-deadline";

/**
 * The epoch ms at which this CI job is cancelled: ci.yml hands the job's start (RMD_JOB_STARTED_MS,
 * the admission step's stamp) and its own timeout-minutes (RMD_JOB_TIMEOUT_MINUTES) in as env.
 * `undefined` when either is absent or unreadable — outside CI nothing bounds the job, so only each
 * probe's own deadline applies.
 */
export function jobCancelAtMs(env = process.env) {
  const started = Number(env.RMD_JOB_STARTED_MS);
  const minutes = Number(env.RMD_JOB_TIMEOUT_MINUTES);
  if (!env.RMD_JOB_STARTED_MS || !env.RMD_JOB_TIMEOUT_MINUTES) return undefined;
  if (!Number.isFinite(started) || started <= 0 || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  return started + minutes * 60_000;
}

/**
 * A RUN THAT ENDS WITHOUT A SUMMARY IS NOT A PASS (2026-10-11, ci-shard 1/8 of #10765).
 *
 * The pool runs ~240 files in ONE process, so a test that reaches the real `process.exit(0)` — serve's
 * stale-code recycle, armed by a test that gave serve a fake boot sha — ends every file after it, and
 * the run exits 0 with no `# tests` line. Exit status alone read that as green: shard 1 ran 92 of its
 * 244 pooled files and passed. So a pool-ladder run (the pool, its isolated re-run and every
 * leak-locating probe) passes only when:
 *   - the child exits 0;
 *   - it reached its end-of-run summary (`# tests`, `# pass`, `# fail 0`), read from
 *     scripts/pool-run-tally.mjs, which writes only once the event stream has ended;
 *   - EVERY file it was given reported: pooled, a test from the file ran or reported; isolated, the
 *     file's own child reached its per-file summary (a child that exits 0 part-way reports the file as
 *     `ok` with the rest of its tests never run, so a per-file `ok` is not enough);
 *   - `# tests` is at least the number of files given.
 * Anything else fails by name: the last test that started and, when the real `process.exit` was
 * called, its call site (scripts/pool-run-marker.mjs records both synchronously).
 */
export const POOL_RUN_MARKER_ENV = "RMD_POOL_RUN_MARKER";

const MARKER_MODULE = fileURLToPath(new URL("./pool-run-marker.mjs", import.meta.url));
const TALLY_REPORTER = fileURLToPath(new URL("./pool-run-tally.mjs", import.meta.url));

/** The extra `node --test` arguments and env one judged run needs, and how to read what it left. */
export function prepareJudgedRun({ makeDir = () => mkdtempSync(join(tmpdir(), "rmd-pool-run-")), files, root = process.cwd() } = {}) {
  const dir = makeDir();
  const markerPath = join(dir, "marker.tsv");
  const tallyPath = join(dir, "tally.json");
  writeFileSync(markerPath, "");
  const diagnosticEnv = {};
  if (Array.isArray(files)) {
    // Separate, opt-in observation input; never consumed by the completion judge.
    try {
      const diagnosticPath = join(dir, "file-diagnostics.json");
      writeFileSync(diagnosticPath, JSON.stringify({ version: 1, attemptId: randomUUID(), root: realpathSync(root), files: files.map(file => realpathSync(resolve(root, file))) }));
      diagnosticEnv.RMD_TEST_FILE_DIAGNOSTICS = diagnosticPath;
    } catch {
      // Observation availability cannot change the run's verdict or selection.
    }
  }
  const readOrEmpty = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return {
    args: ["--import", pathToFileURL(MARKER_MODULE).href, `--test-reporter=${TALLY_REPORTER}`, `--test-reporter-destination=${tallyPath}`],
    env: { [POOL_RUN_MARKER_ENV]: markerPath, ...diagnosticEnv },
    read: () => ({ tallyText: readOrEmpty(tallyPath), markerText: readOrEmpty(markerPath) }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** How an inline tally line begins on stdout (see {@link inlineJudgedArgs}). */
const INLINE_TALLY_PREFIX = '{"version":1,';

/**
 * The judge's tally reporter for a run whose child cannot see this checkout: the review's proof child
 * runs sandboxed with only the PR head bound, and with a declared env that carries no marker path. So
 * the reporter rides the argv as a `data:` URL and writes its one tally line to stdout, after the
 * run's own reporter output; {@link splitInlineTally} takes it back off.
 */
export function inlineJudgedArgs() {
  const source = Buffer.from(readFileSync(TALLY_REPORTER, "utf8")).toString("base64");
  return [`--test-reporter=data:text/javascript;base64,${source}`, "--test-reporter-destination=stdout"];
}

/** True when a `node --test` argv already carries {@link inlineJudgedArgs}'s reporter. */
export function hasInlineJudge(args) {
  return args.some((arg) => arg.startsWith("--test-reporter=data:text/javascript;base64,"));
}

/** An {@link inlineJudgedArgs} run's stdout split into the reporters' own output and the tally line ("" when absent). */
export function splitInlineTally(stdout) {
  const lines = String(stdout).split("\n");
  const at = lines.findLastIndex((line) => line.startsWith(INLINE_TALLY_PREFIX));
  if (at < 0) return { output: String(stdout), tallyText: "" };
  return { output: [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n"), tallyText: lines[at] };
}

const realOrResolved = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Judge one finished run. `status` is the child's exit status; `pool` says whether the files shared
 * one process. `tallyText`/`markerText` are what {@link prepareJudgedRun}'s files hold afterwards.
 * @returns {{ status: number, childStatus: number, complete: boolean, given: number, reported: number, missing: string[],
 *   tests: number | null, failed: number | null, lastStarted: string | null, exitSite: string | null,
 *   problems: string[] }}
 */
export function judgeRun(files, { status, pool, root = ".", tallyText = "", markerText = "" }) {
  let tally = null;
  try {
    const line = tallyText.trim().split("\n").at(-1);
    if (line) tally = JSON.parse(line);
  } catch {
    tally = null;
  }
  let lastStart = null;
  let lastExit = null;
  const started = [];
  const lastStartByFile = new Map();
  const exitByFile = new Map();
  for (const line of markerText.split("\n")) {
    const [kind, first, second, third] = line.split("\t");
    if (kind === "start") {
      lastStart = { file: first, name: second };
      lastStartByFile.set(realOrResolved(first), lastStart);
      started.push(first);
    } else if (kind === "exit") {
      lastExit = `process.exit(${first}) from ${second}`;
      if (third) exitByFile.set(realOrResolved(third), lastExit);
    }
  }
  const summary = tally && typeof tally.summary === "object" ? tally.summary : null;
  const seen = new Set(
    (pool ? [...(tally?.testFiles ?? []), ...started] : tally?.fileSummaries ?? []).map(realOrResolved),
  );
  const missing = files.filter((file) => !seen.has(realOrResolved(resolve(root, file))));
  // Isolated, every file has its own child, so the useful "where" is the first unreported file's own
  // last test and exit, not whichever child happened to write last.
  const firstMissing = !pool && missing.length > 0 ? realOrResolved(resolve(root, missing[0])) : null;
  const whereStart = (firstMissing && lastStartByFile.get(firstMissing)) || lastStart;
  const exitSite = (firstMissing && exitByFile.get(firstMissing)) || lastExit;
  const tests = Number.isFinite(summary?.tests) ? summary.tests : null;
  const failed = Number.isFinite(summary?.failed) ? summary.failed : null;
  // A timed-out test is counted `cancelled`, not `fail`, and --test-force-exit then exits 0: CI
  // 38972373415's pool read "# fail 0" over seven tests that never finished.
  const cancelled = Number.isFinite(summary?.cancelled) ? summary.cancelled : 0;
  const problems = [];
  if (!summary) problems.push("no end-of-run test summary (the process ended before its tests did)");
  else {
    if (failed !== 0) problems.push(`# fail ${failed}`);
    if (cancelled > 0) problems.push(`# cancelled ${cancelled}: a test that timed out or was cut short never finished`);
    if (files.length === 0 && tests === 0) problems.push("# tests 0: the run tested nothing");
    else if (tests === null || tests < files.length) problems.push(`# tests ${tests} is fewer than the ${files.length} file(s) given`);
  }
  if (missing.length > 0) problems.push(`${missing.length} of ${files.length} file(s) never reported (first: ${missing[0]})`);
  const complete = problems.length === 0;
  const rel = (path) => {
    const base = realOrResolved(resolve(root));
    const real = realOrResolved(path);
    return real.startsWith(`${base}/`) ? real.slice(base.length + 1) : path;
  };
  return {
    status: status !== 0 ? status : complete ? 0 : 1,
    childStatus: status,
    complete,
    given: files.length,
    reported: files.length - missing.length,
    missing,
    tests,
    failed,
    lastStarted: whereStart ? `${rel(whereStart.file)} > ${whereStart.name}` : null,
    exitSite,
    problems,
  };
}

/** The line prefix naming one file an isolated judged run never heard finish (see {@link unreportedFilesIn}). */
export const UNREPORTED_FILE_PREFIX = "test-judge: UNREPORTED FILE ";

/**
 * The positive control, one line per judged run: files given, files that reported, `# tests`. An
 * isolated run that is incomplete adds one {@link UNREPORTED_FILE_PREFIX} line per file that never
 * reached its own summary, so a wrapper (scripts/test-with-retry.mjs) can re-run exactly those.
 * `prefix` names the runner; the pool ladder keeps its own.
 */
export function describeJudgedRun(role, verdict, { prefix = "pure-test-pool", pool = false } = {}) {
  const counts = `${verdict.reported}/${verdict.given} file(s) reported, # tests ${verdict.tests ?? "none"}, # fail ${verdict.failed ?? "none"}`;
  if (verdict.complete) return `${prefix}: ${role} run complete — ${counts}.`;
  // The child's own non-zero exit is an ordinary red; an exit 0 the judge overrules is the silent kind.
  const headline = verdict.childStatus === 0 ? "INCOMPLETE — its exit 0 is counted as FAILED" : `FAILED (status ${verdict.childStatus})`;
  const unreported = pool ? [] : verdict.missing.map((file) => `\n${UNREPORTED_FILE_PREFIX}${file}`);
  return (
    `${prefix}: ${role.toUpperCase()} RUN ${headline}: ${verdict.problems.join("; ")}. ` +
    `${counts}. Last test started: ${verdict.lastStarted ?? "none"}` +
    (verdict.exitSite ? `. The real ${verdict.exitSite}` : "") +
    "." +
    unreported.join("")
  );
}

/** The files an output's {@link UNREPORTED_FILE_PREFIX} lines name, in order, without repeats. */
export function unreportedFilesIn(output) {
  const files = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    if (line.startsWith(UNREPORTED_FILE_PREFIX)) files.add(line.slice(UNREPORTED_FILE_PREFIX.length).trim());
  }
  return [...files].filter(Boolean);
}

/**
 * Spawn ONE judged `node --test` child: `args` are the runner arguments up to the file list (reporters
 * included); the judge's marker and tally are appended. Returns the judged status, which is non-zero
 * for a child that exited 0 without completing every file. Given `deadlineMs`, a child still running
 * then is SIGKILLed (a pooled file spawns nothing, so the child is the whole tree) and the run returns
 * {@link RUN_PAST_DEADLINE}.
 */
export function spawnJudgedRun(files, { spawn, cwd, args, pool, quiet = false, role, prefix = "pure-test-pool", log = (line) => console.error(line), env = process.env, deadlineMs }) {
  const judged = prepareJudgedRun({ files, root: cwd });
  try {
    const result = spawn(process.execPath, [...args, ...judged.args, ...files], {
      cwd,
      stdio: quiet ? "ignore" : "inherit",
      env: { ...env, ...judged.env },
      ...(deadlineMs > 0 ? { timeout: deadlineMs, killSignal: "SIGKILL" } : {}),
    });
    const status = result.status ?? (result.signal ? 1 : 0);
    const verdict = judgeRun(files, { status, pool, root: cwd, ...judged.read() });
    log(describeJudgedRun(role, verdict, { prefix, pool }));
    if (deadlineMs > 0 && result.error?.code === "ETIMEDOUT") return RUN_PAST_DEADLINE;
    return verdict.status;
  } finally {
    judged.cleanup();
  }
}

/**
 * EVERY TEST RUN IS JUDGED, NOT ONLY THE POOL'S (2026-10-11 follow-up to #10894). An isolated
 * `node --test` run reports a file whose own child exits 0 part-way as `ok`, with the rest of its
 * tests never run and `# tests` still at least the file count — so the fast tier's isolated rest, the
 * slow tier, the coverage shards, the failed-file retries and the author preflight all read it green.
 * Each of those runners now inserts the same judge into its `node --test` argv and judges the run by
 * {@link judgeRun}: every file it was given must reach its own per-file summary.
 */

const REPORTER_FLAG = "--test-reporter";
const DESTINATION_FLAG = "--test-reporter-destination";

/**
 * `args` (a `node --test` argv) with the judge's `judgedArgs` inserted after its last reporter flag
 * (or after `--test`), so reporters and destinations still pair in order. A run that named no
 * reporter keeps node's default `spec` on stdout, and a lone reporter with no destination keeps
 * stdout: adding the judge's own reporter would otherwise silence or unpair them.
 * An argv without `--test` is returned unchanged.
 */
export function judgedNodeTestArgs(args, judgedArgs) {
  const testAt = args.indexOf("--test");
  if (testAt < 0) return [...args];
  let reporters = 0;
  let destinations = 0;
  let after = testAt + 1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const flag of [REPORTER_FLAG, DESTINATION_FLAG]) {
      if (arg !== flag && !arg.startsWith(`${flag}=`)) continue;
      if (flag === REPORTER_FLAG) reporters += 1;
      else destinations += 1;
      const end = arg === flag ? i + 2 : i + 1;
      if (end > after) after = end;
    }
  }
  const keep =
    reporters === 0 && destinations === 0
      ? [`${REPORTER_FLAG}=spec`, `${DESTINATION_FLAG}=stdout`]
      : reporters === 1 && destinations === 0
        ? [`${DESTINATION_FLAG}=stdout`]
        : [];
  return [...args.slice(0, after), ...keep, ...judgedArgs, ...args.slice(after)];
}

const TEST_FILE = /\.test\.(?:[cm]?[jt]s)$/;
const GLOB_CHARS = /[*?[\]]/;

/**
 * The test files a `node --test` argv names: each `*.test.*` path as given, and each glob expanded
 * under `cwd` (node_modules excluded, as node's own runner does). These are the files a judged run
 * must hear finish.
 */
export function testFilesInArgv(args, cwd = ".") {
  const files = [];
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (GLOB_CHARS.test(arg) && /\.test\./.test(arg)) {
      for (const match of globSync(arg, { cwd, exclude: (path) => /(?:^|[\\/])node_modules(?:[\\/]|$)/.test(String(path)) }).sort()) {
        files.push(match);
      }
    } else if (TEST_FILE.test(arg)) files.push(arg);
  }
  return [...new Set(files)];
}

/**
 * Judge a finished run that {@link prepareJudgedRun} set up, log its line and remove its files.
 * `status` is the child's own exit status; the returned `status` is non-zero for a child that exited
 * 0 without every file reaching its summary.
 */
export function closeJudgedRun(judged, files, { status, pool = false, root = ".", role, prefix = "test-judge", log = (line) => console.error(line) }) {
  try {
    const verdict = judgeRun(files, { status, pool, root, ...judged.read() });
    const line = describeJudgedRun(role, verdict, { prefix, pool });
    log(line);
    return { verdict, line, status: verdict.status };
  } finally {
    judged.cleanup();
  }
}
