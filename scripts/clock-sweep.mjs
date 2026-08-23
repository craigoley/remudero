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
 * cost. The theoretical price of a large shift is flagging a fixture with a legitimate multi-year
 * expiry; measured across all 42 candidates, that produced ZERO false flags, so it is not paid here.
 *
 * ── WHAT IT RUNS, AND WHAT IT MUST NEVER RUN ────────────────────────────────────────────────────
 * It runs ONE FILE PER INVOCATION over a derived candidate list. It never passes a glob to
 * `node --test`, and {@link SPAWN_REACHING} is subtracted from the candidate set before anything is
 * spawned — those six reach the real worker spawn primitive with no stub, and one has already cost
 * real money, ghost branches and PRs. A shifted clock does not make a paid spawn cheaper.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(REPO, "test");
const BASELINE_PATH = join(REPO, "scripts", "clock-sweep-baseline.json");

/** The one shift. See the header for why one, and why this size. */
export const SWEEP_SHIFT_DAYS = 400;

/**
 * Shifts used to BOUND THE FUSE of a suite that drifted — smallest-first, so the report can say
 * "fails by +N days" rather than only "fails at +400". Only ever run for an already-failing suite,
 * so this costs nothing on a green sweep.
 */
export const FUSE_LADDER_DAYS = [7, 14, 30, 90, 180, 400];

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
  // W1-T1104: `emissions` REMOVED — measured PASSING at +400d by the sweep running in CI, which is
  // the only environment whose verdict this gate acts on. Its stated mechanism ("reads the REAL
  // on-disk ledger through a Date.now()-derived window cutoff") no longer holds there.
  //
  // IT WAS BRIEFLY RESTORED ON A LOCAL MEASUREMENT THAT WAS NOT EVIDENCE, and the mistake is
  // recorded because the next person will be tempted the same way: in a dev container the suite
  // fails at +400d — twice, reproducibly — but it ALSO fails UNSHIFTED there, so the failure has
  // nothing to do with the clock and says nothing about this exclusion. Two runs in one container
  // are one measurement taken twice. THE CONTROL THAT SETTLES IT IS THE UNSHIFTED RUN, not a
  // repeat of the shifted one:
  //   node --test --import tsx test/emissions.test.ts            # must PASS, or your box is the
  //   FK_SHIFT_DAYS=400 node --test --import tsx \               # variable, not the clock
  //     --import "$PWD/scripts/clock-shift.mjs" test/emissions.test.ts
  // (the absolute `--import` matters — a bare `scripts/clock-shift.mjs` resolves as a PACKAGE and
  // dies with ERR_MODULE_NOT_FOUND, which reads as a clock failure and is not one.)
  //
  // Re-excluding it needs a mechanism measured where the gate runs, not a restored copy of this one.
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
 * @param results Map<suite, {failed: boolean}>
 */
export function classifySweep(results, artifacts = CLOCK_ARTIFACTS, ceiling = DRIFT_CEILING) {
  const drifted = [];
  const staleExclusions = [];
  for (const [suite, r] of results) {
    if (artifacts.has(suite)) {
      // An artifact that now PASSES shifted means its stated mechanism no longer applies.
      if (!r.failed) staleExclusions.push({ suite, reason: artifacts.get(suite) });
      continue;
    }
    if (r.failed) drifted.push({ suite, ...r });
  }
  return {
    drifted,
    staleExclusions,
    ceiling,
    ok: drifted.length <= ceiling && staleExclusions.length === 0,
  };
}

// `exec` is injected LAST with the real default so a test can drive the whole orchestration
// without spawning node once. That is not just for speed: every suite this script runs is a REAL
// test file, so an un-injectable runner would make covering main() cost a full sweep.
export function runSuite(suite, days, exec = execFileSync) {
  try {
    exec(
      process.execPath,
      ["--test", "--import", "tsx", "--import", join(REPO, "scripts", "clock-shift.mjs"), join("test", `${suite}.test.ts`)],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FK_SHIFT_DAYS: String(days) } },
    );
    return { failed: false, output: "" };
  } catch (e) {
    return { failed: true, output: String(e.stdout ?? "") + String(e.stderr ?? "") };
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

/**
 * TEMPORARY DIAGNOSTIC (W1-T1104 round 2): the report's own `failingTitles` names WHICH test
 * failed but never WHY, and this task hit a suite (four of them, in fact) that failed
 * deterministically in CI across three separate runs while passing every local repro attempted —
 * `failingTitles` alone gave no way to tell an assertion mismatch from an unrelated throw. This
 * captures the first raw TAP diagnostic block (the YAML under the first `not ok` line) so a report
 * read on a machine nobody can log into still carries the actual failure, not just its title.
 */
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

// Every collaborator injected LAST with a real default, so the CLI call stays `main()` while a
// test can exercise the list / pass / drift / stale-exclusion paths without spawning anything.
// Returns the exit code rather than calling process.exit, so assertions read a value.
export function main({
  argv = process.argv.slice(2),
  run = runSuite,
  derive = deriveCandidates,
  ceiling = DRIFT_CEILING,
  log = console.log,
  write = (s) => process.stdout.write(s),
} = {}) {
  const listOnly = argv.includes("--list");
  // `--only <suite>` re-checks ONE suite — what the report's own reproduce line points an operator
  // at, and what makes this script's falsifier cheap. Still routed through runnableCandidates, so
  // even an explicit `--only mounts-wiring` cannot reach a spawn.
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : undefined;
  const candidates = only ? [only] : derive();
  const runnable = runnableCandidates(candidates);

  log(`clock-sweep — shift +${SWEEP_SHIFT_DAYS}d`);
  log(`  candidates derived : ${candidates.length}`);
  log(`  never run (spawn)  : ${candidates.length - runnable.length}  [${[...SPAWN_REACHING.keys()].filter((s) => candidates.includes(s)).join(", ") || "none in candidate set"}]`);
  log(`  will run           : ${runnable.length}`);
  if (listOnly) {
    for (const s of runnable) log(`    ${CLOCK_ARTIFACTS.has(s) ? "artifact" : "        "}  ${s}`);
    return 0;
  }

  // PER-SUITE PROGRESS, written as it goes. The full sweep runs for tens of minutes; a job that
  // prints nothing until the end is indistinguishable from a stalled one (and `tee`'s block
  // buffering makes that worse), so each line lands as its suite finishes.
  const results = new Map();
  let done = 0;
  for (const suite of runnable) {
    const r = run(suite, SWEEP_SHIFT_DAYS);
    results.set(suite, r);
    done++;
    const verdict = r.failed ? (CLOCK_ARTIFACTS.has(suite) ? "fail (known artifact)" : "FAIL") : "ok";
    write(`  [${String(done).padStart(3)}/${runnable.length}] ${verdict.padEnd(21)} ${suite}\n`);
  }
  const { drifted, staleExclusions, ok } = classifySweep(results, CLOCK_ARTIFACTS, ceiling);

  log("");
  // ── THE REPORT. An operator reads this months from now with no context, so it names the suite,
  // the failing test, the fuse, and what to do — never just "the shifted run failed". Printed
  // whenever there IS drift, even a run that stays under the ceiling and therefore still exits
  // 0 — a ratchet that hides its own number is not actionable (W1-T1128 design iv).
  if (drifted.length) {
    log(`WALL-CLOCK DRIFT — ${drifted.length} suite(s) pass today and FAIL in the future.`);
    log(`This is the shape that took main red on 2026-08-02 and blocked every open PR at once.`);
    for (const d of drifted) {
      const fuse = bisectFuse(d.suite, run);
      log(`\n  test/${d.suite}.test.ts`);
      log(`    fails by      : +${fuse ?? SWEEP_SHIFT_DAYS} days from now${fuse ? "" : " (only at the full shift)"}`);
      for (const t of failingTitles(d.output)) log(`    failing test  : ${t}`);
      log(`    reproduce     : FK_SHIFT_DAYS=${fuse ?? SWEEP_SHIFT_DAYS} node --test --import tsx --import scripts/clock-shift.mjs test/${d.suite}.test.ts`);
      log(`    likely fix    : the fixture holds a DATE LITERAL compared against a real clock. Derive it at run time and assert its margin against the policy that judges it (PR #1116 is the shape).`);
      const detail = firstFailureDetail(d.output);
      if (detail) {
        log(`    detail        :`);
        for (const line of detail.split("\n")) log(`      ${line}`);
      }
    }
    // A RATCHET, not absolute cleanliness (W1-T1128): the verdict compares against the recorded
    // ceiling, and each of the three relations gets its own line so an operator can tell "still
    // broken, unchanged", "just got worse" and "just got better -- lower the ceiling" apart.
    if (drifted.length > ceiling) {
      log(`\nOVER CEILING — ${drifted.length} drifting suite(s) exceeds the recorded ceiling of ${ceiling}.`);
      log(`This is a REGRESSION against scripts/clock-sweep-baseline.json: fix the new drift, or if a`);
      log(`bump is a deliberate, reviewed decision, raise driftCeiling there and say why.`);
    } else if (drifted.length < ceiling) {
      log(`\nBELOW CEILING — ${drifted.length} drifting suite(s) is under the recorded ceiling of ${ceiling}.`);
      log(`Drift genuinely improved; lower driftCeiling in scripts/clock-sweep-baseline.json to lock it in.`);
    } else {
      log(`\nAT CEILING — ${drifted.length} drifting suite(s) matches the recorded ceiling of ${ceiling} exactly.`);
    }
  }
  if (staleExclusions.length) {
    log(`\nSTALE EXCLUSIONS — ${staleExclusions.length} suite(s) listed as clock artifacts now PASS shifted.`);
    log(`Their stated mechanism no longer holds; remove them from CLOCK_ARTIFACTS in scripts/clock-sweep.mjs.`);
    log(`A stale exclusion is never forgiven by the drift ceiling -- it always fails the sweep.`);
    for (const s of staleExclusions) log(`  test/${s.suite}.test.ts — was excluded because: ${s.reason}`);
  }
  if (ok) {
    // Counted from what actually RAN, never `runnable.length - CLOCK_ARTIFACTS.size` — that goes
    // NEGATIVE under `--only`, and a summary line that prints "-2 suites immune" is worse than
    // none. `drifted.length` is ALSO subtracted here (W1-T1128): under the ceiling ratchet, `ok`
    // no longer implies zero drift, and a suite that just failed shifted is not "immune" merely
    // because the run stayed under the ceiling -- that would misreport the very thing the WALL-
    // CLOCK DRIFT section above just named.
    const artifactsRun = runnable.filter((s) => CLOCK_ARTIFACTS.has(s)).length;
    const immune = runnable.length - artifactsRun - drifted.length;
    const notes = [];
    if (artifactsRun) notes.push(`${artifactsRun} known artifact(s) still failing as expected`);
    if (drifted.length) notes.push(`${drifted.length} drifting suite(s) within the ceiling (see above)`);
    log(`\nPASS — ${immune} suite(s) immune at +${SWEEP_SHIFT_DAYS}d` + (notes.length ? `; ${notes.join("; ")}.` : "."));
    return 0;
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
