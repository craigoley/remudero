/**
 * scripts/clock-sweep.mjs — run the suite IN THE FUTURE, on a schedule, and say what drifted.
 *
 * WHY. `main` went red at exactly 2026-08-02T12:00:00Z and EVERY OPEN PR inherited it, because `ci`
 * runs the whole suite and `ci-gate` aggregates. A fixture hardcoded `lastActivityAt` as
 * `2026-07-19T12:00:00Z`; `staleDays` is 14; fourteen days later the disposition flipped from
 * `mergeable` to `stale` and three tests began asserting the wrong value. A PR whose `ci` ran at
 * 09:30Z passed; one at 13:40Z did not. Nothing changed but the wall clock, and it cost a session of
 * misattributed debugging.
 *
 * `scripts/clock-shift.mjs` (already committed, with its own guarding suite) is the instrument. This
 * is the scheduler around it: derive the population, exclude what cannot be measured, run the rest
 * shifted, and produce output an operator can act on months from now with no context.
 *
 * ── NOT A PR GATE, DELIBERATELY ─────────────────────────────────────────────────────────────────
 * A shifted run on every PR would roughly double CI cost for a defect that surfaces every few
 * months, and a red shifted run on an unrelated PR is exactly the noise that gets a check disabled.
 * Weekly matches the measured hazard: the real bomb had a 14-day fuse, so a weekly sweep at +400d
 * would have named it with ~2 weeks of warning.
 *
 * ── THE SHIFT VALUE ─────────────────────────────────────────────────────────────────────────────
 * ONE shift, +400 days. A larger shift strictly dominates a smaller one for detection — anything a
 * +30d sweep catches, +400d also catches — so a second shorter shift buys no signal and doubles the
 * cost. The theoretical price, a false flag on a legitimate multi-year expiry, was measured at zero.
 *
 * ── WHAT IT RUNS, AND WHAT IT MUST NEVER RUN ────────────────────────────────────────────────────
 * It runs ONE FILE PER INVOCATION over a derived candidate list. It never passes a glob to
 * `node --test`, and {@link SPAWN_REACHING} is subtracted from the candidate set before anything is
 * spawned — those six reach the real worker spawn primitive with no stub, and one has already cost
 * real money, ghost branches and PRs. A shifted clock does not make a paid spawn cheaper.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

const REPO = REPO_ROOT;
const TEST_DIR = join(REPO, "test");
const BASELINE_PATH = join(REPO, "scripts", "clock-sweep-baseline.json");

/** The one shift. See the header for why one, and why this size. */
export const SWEEP_SHIFT_DAYS = 400;

/** PRIMARY CONTROL on how long one sweep may spend running suites; the workflow's 30-minute timeout is the BACKSTOP. */
export const SWEEP_BUDGET_MS = 27 * 60 * 1000;

/**
 * Shifts used to BOUND THE FUSE of a suite that drifted — smallest-first, so the report can say
 * "fails by +N days" rather than only "fails at +400". Only ever run for an already-failing suite,
 * so this costs nothing on a green sweep.
 */
export const FUSE_LADDER_DAYS = [0, 7, 14, 30, 90, 180, 400];

/**
 * NEVER RUN. These reach the real worker spawn primitive with no stub.
 *
 * This is not a "flaky" list and its entries are not opinions: `mounts-wiring` alone spent real
 * money and left pushed branches and open PRs before it was contained. They are excluded BY NAME and
 * BEFORE the run loop, so no code path in this script can reach them.
 */
export const SPAWN_REACHING = new Map([
  ["mounts-wiring", "calls the real runTask with zero stubs — measured at $1.42 of model spend, plus pushed branches and opened PRs, in a single run"],
  ["containment-wiring", "drives the real containment preflight through a real worker spawn"],
  ["isolation-wiring", "drives the real isolation probe through a real worker spawn"],
  ["task-linter-wiring", "dispatches a real run to exercise the pre-dispatch linter"],
  ["wipe-test", "the A/B learning harness spawns a PAIR of paid runs by design"],
  ["diff-coverage", "shells out to the real coverage path and can reach a spawn"],
]);

/**
 * RUN, BUT EXPECTED TO FAIL SHIFTED. Each of these compares a shifted `Date.now()` against a clock
 * this probe cannot shift, so it fails for a reason that is not a fixture bomb. Each reason names
 * the MECHANISM, because "flaky" is not a reason and would rot into a silent mute.
 *
 * They are still RUN — that is the point. If one starts PASSING shifted, its stated mechanism no
 * longer holds, the entry has rotted, and {@link classifySweep} surfaces it as STALE rather than
 * letting the list quietly grow. Same idiom the producer-completeness, route-registration and
 * config-reader-seam checks already use.
 */
export const CLOCK_ARTIFACTS = new Map([
  ["prune-liveness", "compares a real FILESYSTEM MTIME against the shifted clock — mtimes are not shiftable, so a just-created directory reads as 400 days old. Its fixture is already derived; there is no literal to convert"],
  ["serve.glance", "drives a Playwright page whose BROWSER clock is unshifted, so server-rendered shifted times disagree with it (observed: `was \"in 9600h1m\"`)"],
]);

/** Tokens that mark a suite as touching an age-judging surface — the population's own criterion. */
const AGE_SURFACE_RE =
  /staleDays|livenessBound|MAX_AGE_MS|RETENTION_WINDOW|minIntervalMinutes|lastActivityAt|ageMs|resets_at|\bstale\b/;
/** A date literal: an ISO-ish date, which is what a bomb is built from. */
const DATE_LITERAL_RE = /\d{4}-\d{2}-\d{2}/;

/** `test/foo.test.ts` -> `foo`. */
export function suiteName(file) {
  return file.replace(/\.test\.ts$/, "");
}

/**
 * The candidate population, DERIVED from source rather than listed — a hand-maintained copy of
 * "which suites matter" is the second registration list that has hidden defects in this repo before.
 * A suite that grows its first date literal tomorrow is swept the next run, with no edit here.
 */
export function deriveCandidates(testDir = TEST_DIR) {
  return readdirSync(testDir)
    .filter((n) => n.endsWith(".test.ts"))
    .filter((n) => {
      const text = readFileSync(join(testDir, n), "utf8");
      return AGE_SURFACE_RE.test(text) && DATE_LITERAL_RE.test(text);
    })
    .map(suiteName)
    .sort();
}

/** Newest-touched first; ties and files with no history by name. `touchedAt` is Map<suite, epochSeconds>. */
export function orderNewestFirst(suites, touchedAt) {
  return [...suites].sort((a, b) => (touchedAt.get(b) ?? 0) - (touchedAt.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Last commit time of each suite's file from ONE `git log` (the first mention is the newest). Throws when history is unreadable. */
export function readTouchedAt(cwd = REPO, exec = execFileSync) {
  const out = exec("git", ["-C", cwd, "log", "--format=%ct", "--name-only", "--", "test/"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const touched = new Map();
  let when = 0;
  for (const line of String(out).split("\n")) {
    const file = /^test\/([^/]+)\.test\.ts$/.exec(line);
    if (/^\d+$/.test(line)) when = Number(line);
    else if (file && !touched.has(file[1])) touched.set(file[1], when);
  }
  return touched;
}

/** The candidates this sweep will actually execute: derived, minus the never-run set. */
export function runnableCandidates(candidates) {
  return candidates.filter((s) => !SPAWN_REACHING.has(s));
}

/**
 * The recorded drift CEILING (W1-T1128, scripts/clock-sweep-baseline.json). `classifySweep` used
 * to require `drifted.length === 0` -- ABSOLUTE cleanliness -- a bound the real workflow has never
 * once satisfied across its whole run history (9 runs: 4 failure / 5 cancelled / 0 success, both
 * triggers). This is a RATCHET like `scripts/coverage-baseline.json` and
 * `scripts/mutation-baseline.json`: it fails on REGRESSION above the recorded figure, never on
 * absolute cleanliness. See the baseline file's own `_comment` for the never-raise rule.
 */
export const DRIFT_BASELINE = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
export const DRIFT_CEILING = DRIFT_BASELINE.driftCeiling;

/**
 * Turn raw per-suite results into the two things an operator needs: what DRIFTED, and where the
 * exclusion list has ROTTED. Pure, so both are unit-testable without running a single suite.
 *
 * `ceiling` is the RATCHET (W1-T1128): a sweep is `ok` when `drifted.length` does not exceed it,
 * never only when it is zero -- but a STALE EXCLUSION is not a drift and is NEVER forgiven by any
 * ceiling, however generous, because it is a silently SHRINKING exclusion list, not a suite that
 * merely hasn't been fixed yet.
 *
 * W1-T3276 -- AND NEITHER IS *NEW* DRIFT: the ceiling forgave by COUNT alone, so a new bomb hid
 * behind a repaired one (`clock-sweep` reported SUCCESS on 2026-09-07 over the fixture that took
 * `main` red two days later, W1-T3270). A drifting suite whose NAME is not in
 * `driftingSuitesAtCapture` is a regression at ANY count; the ceiling forgives only the RECORDED backlog.
 *
 * @param results Map<suite, {failed: boolean}>
 */
export function classifySweep(
  results,
  artifacts = CLOCK_ARTIFACTS,
  ceiling = DRIFT_CEILING,
  recorded = DRIFT_BASELINE.driftingSuitesAtCapture ?? [],
) {
  const known = new Set(recorded);
  const drifted = [];
  const newDrift = [];
  const staleExclusions = [];
  for (const [suite, r] of results) {
    if (artifacts.has(suite)) {
      // An artifact that now PASSES shifted means its stated mechanism no longer applies.
      if (!r.failed) staleExclusions.push({ suite, reason: artifacts.get(suite) });
      continue;
    }
    if (r.failed) {
      const row = { suite, ...r };
      drifted.push(row);
      // A name the baseline never recorded is a suite that STARTED drifting since it was captured.
      if (!known.has(suite)) newDrift.push(row);
    }
  }
  return {
    drifted,
    newDrift,
    staleExclusions,
    ceiling,
    ok: newDrift.length === 0 && drifted.length <= ceiling && staleExclusions.length === 0,
  };
}

// `exec` is injected LAST with the real default so a test can drive the whole orchestration
// without spawning node once. That is not just for speed: every suite this script runs is a REAL
// test file, so an un-injectable runner would make covering main() cost a full sweep.
export function runSuite(suite, days, exec = execFileSync) {
  const isolatedTmp = mkdtempSync(join(tmpdir(), "rmd-clock-sweep-"));
  try {
    exec(
      process.execPath,
      ["--test", "--test-reporter=tap", "--import", "tsx", "--import", join(REPO, "scripts", "clock-shift.mjs"), join("test", `${suite}.test.ts`)],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: isolatedTmp, FK_SHIFT_DAYS: String(days) } },
    );
    return { failed: false, output: "" };
  } catch (e) {
    return { failed: true, output: String(e.stdout ?? "") + String(e.stderr ?? "") };
  } finally {
    rmSync(isolatedTmp, { recursive: true, force: true });
  }
}

/** The smallest ladder rung at which `suite` already fails — the fuse bound for the report. */
export function bisectFuse(suite, run = runSuite) {
  for (const days of FUSE_LADDER_DAYS) {
    if (run(suite, days).failed) return days;
  }
  return null;
}

/** The failing test titles, so the report names them rather than saying "a suite failed". */
export function failingTitles(output) {
  return [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).slice(0, 5);
}

/** W1-T1104: the first raw TAP diagnostic block under the first `not ok`, so a report read where nobody can log in carries WHY, not only the title. */
export function firstFailureDetail(output) {
  const lines = String(output).split("\n");
  const start = lines.findIndex((l) => /^not ok \d+ - /.test(l));
  if (start === -1) return "";
  const out = [];
  for (let i = start; i < lines.length && out.length < 30; i++) {
    if (i > start && /^(not ok|ok) \d+ - /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trimEnd();
}

/** W1-T5102: `i/n` as `{i, n}` with integers 1 <= i <= n <= 64, else null. */
export function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec ?? ""));
  if (!m) return null;
  const i = Number(m[1]);
  const n = Number(m[2]);
  return i >= 1 && i <= n && n <= 64 ? { i, n } : null;
}

/** W1-T5102: shard i of n takes name-sorted positions k with k % n === i - 1, never the git-history order. */
export function shardSlice(suites, i, n) {
  return [...suites].sort().filter((_, k) => k % n === i - 1);
}

const BROWSER_RE = /chromium\.launch\(|browser-absence/;

function readSuiteText(suite) {
  const path = join(TEST_DIR, `${suite}.test.ts`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** W1-T5102: the suites that launch a browser, which no sweep job installs. */
export function browserSuites(suites, read = readSuiteText) {
  return suites.filter((s) => BROWSER_RE.test(read(s)));
}

/** The report row for one drifting suite: its fuse bound, failing titles and first TAP detail. */
export function describeDrift(row, run = runSuite) {
  const output = row.output ?? "";
  return { suite: row.suite, fuse: bisectFuse(row.suite, run), titles: failingTitles(output), detail: firstFailureDetail(output) };
}

/** The population header a single sweep, a shard and the W1-T5102 merge all print first. */
export function headerLines(candidates, runnable) {
  return [
    `clock-sweep — shift +${SWEEP_SHIFT_DAYS}d`,
    `  candidates derived : ${candidates.length}`,
    `  never run (spawn)  : ${candidates.length - runnable.length}  [${[...SPAWN_REACHING.keys()].filter((s) => candidates.includes(s)).join(", ") || "none in candidate set"}]`,
    `  will run           : ${runnable.length}`,
  ];
}

/** The report a single sweep and the W1-T5102 merge both print, as log lines. Pure. */
export function renderReport({ drift, newDrift, staleExclusions, unreached, browsers = [], ceiling, ok, runnable }) {
  const out = [""];
  if (unreached.length) {
    out.push(`UNREACHED — ${unreached.length} suite(s) not run inside the ${SWEEP_BUDGET_MS / 60000}-minute budget (oldest-touched last): ${unreached.slice(0, 10).join(", ")}${unreached.length > 10 ? ` + ${unreached.length - 10} more` : ""}`);
    out.push("");
  }
  // ── THE REPORT. An operator reads this months from now with no context, so it names the suite,
  // the failing test, the fuse, and what to do — never just "the shifted run failed". Printed
  // whenever there IS drift, even a run that stays under the ceiling and therefore still exits
  // 0 — a ratchet that hides its own number is not actionable (W1-T1128 design iv).
  if (drift.length) {
    out.push(`WALL-CLOCK DRIFT — ${drift.length} suite(s) pass today and FAIL in the future.`);
    out.push(`This is the shape that took main red on 2026-08-02 and blocked every open PR at once.`);
    for (const d of drift) {
      const fuse = d.fuse;
      out.push(`\n  test/${d.suite}.test.ts`);
      out.push(fuse === 0 ? "    fails by      : +0 days - NOT CLOCK DRIFT: fails with no shift (a runner or environment defect, for example a missing browser)" : `    fails by      : +${fuse ?? SWEEP_SHIFT_DAYS} days from now${fuse ? "" : " (only at the full shift)"}`);
      for (const t of d.titles) out.push(`    failing test  : ${t}`);
      out.push(`    reproduce     : FK_SHIFT_DAYS=${fuse ?? SWEEP_SHIFT_DAYS} node --test --import tsx --import scripts/clock-shift.mjs test/${d.suite}.test.ts`);
      out.push(`    likely fix    : the fixture holds a DATE LITERAL compared against a real clock. Derive it at run time and assert its margin against the policy that judges it (PR #1116 is the shape).`);
      if (d.detail) {
        out.push(`    detail        :`);
        for (const line of d.detail.split("\n")) out.push(`      ${line}`);
      }
    }
    // A RATCHET, not absolute cleanliness (W1-T1128): the verdict compares against the recorded
    // ceiling, and each of the three relations gets its own line so an operator can tell "still
    // broken, unchanged", "just got worse" and "just got better -- lower the ceiling" apart.
    // W1-T3276 -- NEW DRIFT LEADS, because "12 suites drifted" is not actionable and "one NEW
    // suite drifted" is. A run that stays under the ceiling still fails when this list is non-empty.
    if (newDrift.length) {
      out.push(`\nNEW DRIFT — ${newDrift.length} suite(s) NOT in scripts/clock-sweep-baseline.json's recorded set:`);
      for (const d of newDrift) out.push(`  test/${d.suite}.test.ts`);
      out.push(`A suite that STARTED drifting is a regression at any count, and is never forgiven by the`);
      out.push(`ceiling -- the ceiling exists to forgive the recorded backlog, not a stranger. Fix it, or`);
      out.push(`record it deliberately in driftingSuitesAtCapture and say why in the same PR.`);
    }
    if (drift.length > ceiling) {
      out.push(`\nOVER CEILING — ${drift.length} drifting suite(s) exceeds the recorded ceiling of ${ceiling}.`);
      out.push(`This is a REGRESSION against scripts/clock-sweep-baseline.json: fix the new drift, or if a`);
      out.push(`bump is a deliberate, reviewed decision, raise driftCeiling there and say why.`);
    } else if (drift.length < ceiling) {
      out.push(`\nBELOW CEILING — ${drift.length} drifting suite(s) is under the recorded ceiling of ${ceiling}.`);
      out.push(`Drift genuinely improved; lower driftCeiling in scripts/clock-sweep-baseline.json to lock it in.`);
    } else {
      out.push(`\nAT CEILING — ${drift.length} drifting suite(s) matches the recorded ceiling of ${ceiling} exactly.`);
    }
  }
  if (staleExclusions.length) {
    out.push(`\nSTALE EXCLUSIONS — ${staleExclusions.length} suite(s) listed as clock artifacts now PASS shifted.`);
    out.push(`Their stated mechanism no longer holds; remove them from CLOCK_ARTIFACTS in scripts/clock-sweep.mjs.`);
    out.push(`A stale exclusion is never forgiven by the drift ceiling -- it always fails the sweep.`);
    for (const s of staleExclusions) out.push(`  test/${s.suite}.test.ts — was excluded because: ${s.reason}`);
  }
  if (browsers.length) {
    out.push(`\nBROWSER SUITES IN THE POPULATION — ${browsers.length} suite(s) launch a browser, and no sweep job installs one:`);
    for (const s of browsers) out.push(`  test/${s}.test.ts`);
    out.push(`Add \`npx playwright install chromium\` (no --with-deps, W1-T1027) to the shard job in clock-sweep.yml.`);
  }
  if (ok) {
    // Counted from what actually RAN, never `runnable.length - CLOCK_ARTIFACTS.size` (negative under
    // `--only`); drifting suites within the ceiling are not "immune" either (W1-T1128).
    const artifactsRun = runnable.filter((s) => CLOCK_ARTIFACTS.has(s)).length;
    const immune = runnable.length - artifactsRun - drift.length;
    const notes = [];
    if (artifactsRun) notes.push(`${artifactsRun} known artifact(s) still failing as expected`);
    if (drift.length) notes.push(`${drift.length} drifting suite(s) within the ceiling (see above)`);
    out.push(`\nPASS — ${immune} suite(s) immune at +${SWEEP_SHIFT_DAYS}d` + (notes.length ? `; ${notes.join("; ")}.` : "."));
  }
  return out;
}

const writeJsonFile = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

// Every collaborator injected LAST with a real default, so the CLI call stays `main()` while a
// test can exercise the list / pass / drift / stale-exclusion paths without spawning anything.
// Returns the exit code rather than calling process.exit, so assertions read a value.
export function main({
  argv = process.argv.slice(2),
  run = runSuite,
  derive = deriveCandidates,
  ceiling = DRIFT_CEILING,
  // W1-T3276 — injected beside `ceiling` and for the same reason: the suite must be able to state
  // a recorded set without rewriting the shipped baseline.
  recorded = DRIFT_BASELINE.driftingSuitesAtCapture ?? [],
  touchedAt = readTouchedAt,
  now = Date.now,
  readSuite = readSuiteText,
  writeJson = writeJsonFile,
  log = console.log,
  write = (s) => process.stdout.write(s),
} = {}) {
  const listOnly = argv.includes("--list");
  // `--only <suite>` re-checks ONE suite — what the report's own reproduce line points an operator
  // at, and what makes this script's falsifier cheap. Still routed through runnableCandidates, so
  // even an explicit `--only mounts-wiring` cannot reach a spawn.
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : undefined;
  const shardIdx = argv.indexOf("--shard");
  const shard = shardIdx === -1 ? { i: 1, n: 1 } : parseShard(argv[shardIdx + 1]);
  const outIdx = argv.indexOf("--results-out");
  const resultsOut = outIdx === -1 ? undefined : argv[outIdx + 1];
  if (!shard) {
    log(`clock-sweep: --shard wants i/n with integers 1 <= i <= n <= 64, got ${JSON.stringify(argv[shardIdx + 1] ?? "")}`);
    return 2;
  }
  // A slice classified against the GLOBAL ceiling would be wrong, so a sharded sweep must hand its raw results to the merge.
  if ((outIdx !== -1 && !resultsOut) || (shard.n > 1 && !resultsOut && !listOnly)) {
    log(`clock-sweep: --shard ${shard.i}/${shard.n} needs --results-out <path>; only scripts/clock-sweep-aggregate.mjs classifies a shard`);
    return 2;
  }
  const candidates = only ? [only] : derive();
  const runnable = runnableCandidates(candidates);
  const sharded = shard.n > 1 || resultsOut !== undefined;
  const slice = sharded ? shardSlice(runnable, shard.i, shard.n) : runnable;

  for (const line of headerLines(candidates, runnable)) log(line);
  if (sharded) log(`  shard ${shard.i}/${shard.n}          : ${slice.length} suites`);
  if (listOnly) {
    for (const s of slice) log(`    ${CLOCK_ARTIFACTS.has(s) ? "artifact" : "        "}  ${s}`);
    return 0;
  }

  let touched;
  let order = "name (git history unreadable)";
  try {
    touched = touchedAt();
    order = "newest-touched first";
  } catch {
    touched = new Map();
  }
  log(`  order: ${order}`);
  const ordered = orderNewestFirst(slice, touched);

  // PER-SUITE PROGRESS, written as it goes. The full sweep runs for tens of minutes; a job that
  // prints nothing until the end is indistinguishable from a stalled one (and `tee`'s block
  // buffering makes that worse), so each line lands as its suite finishes.
  const results = new Map();
  let done = 0;
  const started = now();
  for (const suite of ordered) {
    if (now() - started >= SWEEP_BUDGET_MS) break;
    const r = run(suite, SWEEP_SHIFT_DAYS);
    results.set(suite, r);
    done++;
    const verdict = r.failed ? (CLOCK_ARTIFACTS.has(suite) ? "fail (known artifact)" : "FAIL") : "ok";
    write(`  [${String(done).padStart(3)}/${slice.length}] ${verdict.padEnd(21)} ${suite}\n`);
  }
  const unreached = ordered.slice(done);

  if (sharded) {
    const drift = [...results].filter(([s, r]) => r.failed && !CLOCK_ARTIFACTS.has(s)).map(([suite, r]) => describeDrift({ suite, ...r }, run));
    writeJson(resultsOut, {
      version: 1, shard: shard.i, of: shard.n, candidates: candidates.length, runnable: runnable.length, order,
      elapsedMs: now() - started, ran: [...results.keys()], unreached,
      results: [...results].map(([suite, r]) => ({ suite, failed: r.failed })), drift,
    });
    if (unreached.length) log(`\nUNREACHED — ${unreached.length} suite(s) not run inside the ${SWEEP_BUDGET_MS / 60000}-minute budget: ${unreached.slice(0, 10).join(", ")}${unreached.length > 10 ? ` + ${unreached.length - 10} more` : ""}`);
    log(`\nshard ${shard.i}/${shard.n} wrote ${resultsOut}: ${results.size} run, ${drift.length} failing; the merge classifies them.`);
    return unreached.length ? 1 : 0;
  }

  const { drifted, newDrift, staleExclusions, ok: classified } = classifySweep(results, CLOCK_ARTIFACTS, ceiling, recorded);
  const browsers = browserSuites(runnable, readSuite);
  const ok = classified && unreached.length === 0 && browsers.length === 0;
  const drift = drifted.map((d) => describeDrift(d, run));
  for (const line of renderReport({ drift, newDrift, staleExclusions, unreached, browsers, ceiling, ok, runnable })) log(line);
  return ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exit(main());
