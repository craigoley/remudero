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

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * @returns {{ status: number, poolDefect: null | { leaker: string | null, victim: string | null } }}
 */
export function runShardWithPool(files, { fast, root = ".", readFile, run, log = (line) => console.error(line) }) {
  const { pooled, isolated } = partitionPool(files, { fast, root, readFile });
  if (pooled.length < 2) return { status: run(files, { pool: false, role: "rest" }), poolDefect: null };

  let status = 0;
  let leaked = false;
  const poolStatus = run(pooled, { pool: true, role: "pool" });
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
    let probes = 0;
    poolDefect = locateLeak(pooled, (subset) => {
      probes += 1;
      const probeStatus = run(subset, { pool: true, quiet: true, role: "locate" });
      log(`pure-test-pool: locate probe ${probes}: ${subset.length} file(s) ending ${subset.at(-1)} -> status ${probeStatus}`);
      return probeStatus;
    });
    log(
      `pure-test-pool: POOL DEFECT — every pooled file passes isolated but the pool failed; ` +
        `leaking file: ${poolDefect.leaker ?? "not isolated to one file"}` +
        (poolDefect.victim ? ` (first failing alongside it: ${poolDefect.victim})` : "") +
        ` after ${probes} probe(s). Add the leak to the census in scripts/pure-test-pool.mjs.`,
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
 * @returns {{ leaker: string | null, victim: string | null }}
 */
export function locateLeak(pooled, runPool) {
  let lo = 1;
  let hi = pooled.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (runPool(pooled.slice(0, mid)) !== 0) hi = mid;
    else lo = mid + 1;
  }
  const prefix = pooled.slice(0, hi);
  if (runPool(prefix) === 0) return { leaker: null, victim: null }; // the failure did not reproduce
  const victim = prefix[prefix.length - 1];
  const before = prefix.slice(0, -1);
  if (runPool([victim]) !== 0) return { leaker: victim, victim };
  // With every predecessor it is the failing prefix itself; find the fewest that still fail.
  let low = 1;
  let high = before.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (runPool([...before.slice(0, mid), victim]) !== 0) high = mid;
    else low = mid + 1;
  }
  return { leaker: before[high - 1], victim };
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

/** The pool-ladder roles a run is judged in; "rest" is the shard's ordinary isolated run. */
export const JUDGED_ROLES = Object.freeze(["pool", "rerun", "locate"]);

const MARKER_MODULE = fileURLToPath(new URL("./pool-run-marker.mjs", import.meta.url));
const TALLY_REPORTER = fileURLToPath(new URL("./pool-run-tally.mjs", import.meta.url));

/** The extra `node --test` arguments and env one judged run needs, and how to read what it left. */
export function prepareJudgedRun({ makeDir = () => mkdtempSync(join(tmpdir(), "rmd-pool-run-")) } = {}) {
  const dir = makeDir();
  const markerPath = join(dir, "marker.tsv");
  const tallyPath = join(dir, "tally.json");
  writeFileSync(markerPath, "");
  const readOrEmpty = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return {
    args: ["--import", pathToFileURL(MARKER_MODULE).href, `--test-reporter=${TALLY_REPORTER}`, `--test-reporter-destination=${tallyPath}`],
    env: { [POOL_RUN_MARKER_ENV]: markerPath },
    read: () => ({ tallyText: readOrEmpty(tallyPath), markerText: readOrEmpty(markerPath) }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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
  let exitSite = null;
  const started = [];
  for (const line of markerText.split("\n")) {
    const [kind, first, second] = line.split("\t");
    if (kind === "start") {
      lastStart = { file: first, name: second };
      started.push(first);
    } else if (kind === "exit") exitSite = `process.exit(${first}) from ${second}`;
  }
  const summary = tally && typeof tally.summary === "object" ? tally.summary : null;
  const seen = new Set(
    (pool ? [...(tally?.testFiles ?? []), ...started] : tally?.fileSummaries ?? []).map(realOrResolved),
  );
  const missing = files.filter((file) => !seen.has(realOrResolved(resolve(root, file))));
  const tests = Number.isFinite(summary?.tests) ? summary.tests : null;
  const failed = Number.isFinite(summary?.failed) ? summary.failed : null;
  const problems = [];
  if (!summary) problems.push("no end-of-run test summary (the process ended before its tests did)");
  else {
    if (failed !== 0) problems.push(`# fail ${failed}`);
    if (tests === null || tests < files.length) problems.push(`# tests ${tests} is fewer than the ${files.length} file(s) given`);
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
    lastStarted: lastStart ? `${rel(lastStart.file)} > ${lastStart.name}` : null,
    exitSite,
    problems,
  };
}

/** The positive control, one line per judged run: files given, files that reported, `# tests`. */
export function describeJudgedRun(role, verdict) {
  const counts = `${verdict.reported}/${verdict.given} file(s) reported, # tests ${verdict.tests ?? "none"}, # fail ${verdict.failed ?? "none"}`;
  if (verdict.complete) return `pure-test-pool: ${role} run complete — ${counts}.`;
  // The child's own non-zero exit is an ordinary red; an exit 0 the judge overrules is the silent kind.
  const headline = verdict.childStatus === 0 ? "INCOMPLETE — its exit 0 is counted as FAILED" : `FAILED (status ${verdict.childStatus})`;
  return (
    `pure-test-pool: ${role.toUpperCase()} RUN ${headline}: ${verdict.problems.join("; ")}. ` +
    `${counts}. Last test started: ${verdict.lastStarted ?? "none"}` +
    (verdict.exitSite ? `. The real ${verdict.exitSite}` : "") +
    "."
  );
}

/**
 * Spawn ONE judged `node --test` child: `args` are the runner arguments up to the file list (reporters
 * included); the judge's marker and tally are appended. Returns the judged status, which is non-zero
 * for a child that exited 0 without completing every file.
 */
export function spawnJudgedRun(files, { spawn, cwd, args, pool, quiet = false, role, log = (line) => console.error(line), env = process.env }) {
  const judged = prepareJudgedRun();
  try {
    const result = spawn(process.execPath, [...args, ...judged.args, ...files], {
      cwd,
      stdio: quiet ? "ignore" : "inherit",
      env: { ...env, ...judged.env },
    });
    const status = result.status ?? (result.signal ? 1 : 0);
    const verdict = judgeRun(files, { status, pool, root: cwd, ...judged.read() });
    log(describeJudgedRun(role, verdict));
    return verdict.status;
  } finally {
    judged.cleanup();
  }
}
