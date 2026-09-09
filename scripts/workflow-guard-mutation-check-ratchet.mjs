#!/usr/bin/env node
// W1-T3220 - A ci.yml SKIP GUARD CAN FIRE UNCONDITIONALLY AND EVERY CHECK STAYS GREEN.
//
// ci.yml's skip guards decide whether a required check does its work or returns success having
// done nothing. That is the vacuous-pass family, in the one place where the detector itself is
// what goes quiet. MEASURED 2026-09-08 on #4733: mutating the `ci` job's new source-skip guard to
// a constant-true condition left all 54 assertions across test/workflow-single-suite-run.test.ts,
// test/push-ci-on-main.test.ts and test/fast-lane-classifier.test.ts GREEN - while that mutant
// leaves a push to main with no test run at all, because coverage-ratchet is PR-only (W1-T1033).
//
// Nothing else covers this. `stryker.conf.json`'s `mutate` list is exactly ["src/lib/classify.ts"]
// and Stryker mutates JavaScript, not shell inside YAML. The assertion-discrimination gate does
// not help either: these assertions are real, they simply only test one branch.
//
// WHAT IT DOES. For each skip-shaped guard, rewrite THAT LINE ONLY so the skip always fires, run
// the suites that read ci.yml, and require at least one to fail. A guard no test can distinguish
// is UNCOVERED.
//
// USAGE:
//   node scripts/workflow-guard-mutation-check-ratchet.mjs            # gate: non-baselined guards must be COVERED
//   node scripts/workflow-guard-mutation-check-ratchet.mjs --all      # measure every guard, report only, exit 0
//   node scripts/workflow-guard-mutation-check-ratchet.mjs --list     # enumerate the guards and exit
//   node scripts/workflow-guard-mutation-check-ratchet.mjs --seed     # record every currently-UNCOVERED guard
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI_YML = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const BASELINE = join(REPO_ROOT, "scripts", "workflow-guard-mutation-baseline.json");

// A guard is skip-shaped when its block reaches `exit 0` - that is what makes an always-true
// condition a SILENT PASS rather than a visible failure. The window is deliberately small: a
// distant `exit 0` belongs to some later branch, not to this guard.
const EXIT_LOOKAHEAD_LINES = 8;
const IF_FORM = /^(\s*)if (.+); then\s*$/;
const OR_FORM = /^(\s*)(\[ .+ \]) \|\| (\{.*)$/;

/**
 * ENUMERATED FROM THE TREE, NEVER FROM A LIST - the constraint W1-T2680 and W1-T2521 already
 * impose. A guard added in the same commit is mutated by the run that adds it; a frozen list of
 * twelve rots on the next PR that touches the workflow, which is exactly when this matters.
 */
export function enumerateSkipGuards(text) {
  const lines = text.split("\n");
  const guards = [];
  const seenPerJob = new Map();
  let job = "(top level)";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const jobHeader = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (jobHeader) job = jobHeader[1];
    const form = IF_FORM.test(line) ? "if" : OR_FORM.test(line) ? "or" : undefined;
    if (form === undefined) continue;
    const block = lines.slice(i, i + EXIT_LOOKAHEAD_LINES).join("\n");
    if (!/\bexit 0\b/.test(block)) continue;
    const trimmed = line.trim();
    const nth = (seenPerJob.get(`${job} ${trimmed}`) ?? 0) + 1;
    seenPerJob.set(`${job} ${trimmed}`, nth);
    // The key is job + text + occurrence, never the line number: a guard added above this one
    // shifts every index below it, and a baseline keyed on indexes would silently re-point at a
    // different guard rather than failing.
    guards.push({ key: `${job}#${nth}: ${trimmed}`, job, line: i + 1, text: line, form });
  }
  return guards;
}

/**
 * MUTATE BY LINE INDEX, NEVER BY STRING REPLACE. This is the falsifier's own trap and it fired
 * during the session that filed this task: `[ -n "${GITHUB_BASE_REF}" ]` occurs THREE times in
 * ci.yml, a replace-first mutation hit line 131 instead of line 205, reddened an unrelated
 * fast-lane case, and left the guard under test untouched - so a new test appeared to survive a
 * falsifier it had never been given. Same shape as this repo's whole-file lcov-edit trap.
 *
 * The two forms invert: an `if` guard skips when its condition is TRUE, an `[ .. ] || { .. }`
 * guard skips when its test is FALSE. "Always skip" therefore means different constants.
 */
export function mutateGuardLine(text, guard) {
  const before = text.split("\n");
  const lines = [...before];
  const original = lines[guard.line - 1];
  if (original !== guard.text) {
    throw new Error(`line ${guard.line} is not the guard it was enumerated as: ${JSON.stringify(original)}`);
  }
  const ifMatch = IF_FORM.exec(original);
  const orMatch = OR_FORM.exec(original);
  lines[guard.line - 1] = ifMatch
    ? `${ifMatch[1]}if [ "1" = "1" ]; then`
    : `${orMatch[1]}[ "1" = "0" ] || ${orMatch[3]}`;
  const changed = lines.flatMap((l, i) => (l === before[i] ? [] : [i + 1]));
  if (changed.length !== 1 || changed[0] !== guard.line) {
    throw new Error(`refusing a mutant that touched line(s) ${changed.join(", ")} rather than only ${guard.line}`);
  }
  return lines.join("\n");
}

/**
 * The suites that READ the workflow - enumerated the same way, so a suite added tomorrow runs.
 *
 * `--untracked` IS LOAD-BEARING, not tidiness. `git grep` reads the index, so a suite added in the
 * very commit that adds a guard is INVISIBLE to it until staged - and this check's whole job is to
 * ask whether the new guard is covered, usually by that same new suite. MEASURED while building
 * this: an unstaged file carrying the search string read 35 without the flag and 36 with it. An
 * under-counted corpus reports UNCOVERED for want of a reader, not for want of coverage, which is
 * the "a zero is not a measurement" law this repo already carries.
 */
export function ciReadingSuites(root = REPO_ROOT) {
  const out = execFileSync("git", ["-C", root, "grep", "-l", "--untracked", "--", "workflows/ci.yml", "test/"], {
    encoding: "utf8",
  });
  return out.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".test.ts"));
}

function suiteFails(suite) {
  const res = spawnSync(
    process.execPath,
    ["--test", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", suite],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  // A run with no `# fail` summary is NOT a result - a killed or timed-out run prints the
  // assertions it reached and no totals, and reading that as "no failures" is how a truncated run
  // gets mistaken for a green one. Absent totals are reported as unknown, never as a pass.
  const summary = /^# fail (\d+)$/m.exec(out);
  if (!summary) return { failed: undefined, out };
  return { failed: Number(summary[1]) > 0, out };
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    return { guards: {} };
  }
}

/** Restore the workflow whatever happens - a crashed run must never leave a mutant on disk. */
function withMutant(guard, original, fn) {
  writeFileSync(CI_YML, mutateGuardLine(original, guard));
  const restore = () => writeFileSync(CI_YML, original);
  process.once("exit", restore);
  try {
    return fn();
  } finally {
    restore();
    process.removeListener("exit", restore);
  }
}

/**
 * COVERED means some suite can tell the mutant from the real thing. `runSuite` is injected so the
 * decision is testable without a four-minute real run -- the seam is the whole reason this is a
 * separate export rather than an inline loop.
 */
export function classifyGuard(guard, original, suites, runSuite = suiteFails, apply = withMutant) {
  return apply(guard, original, () => {
    for (const suite of suites) {
      const { failed } = runSuite(suite);
      // STOP AT THE FIRST SUITE THAT NOTICES. One is the whole question: a guard is COVERED when
      // some test can tell the mutant from the real thing. Running the rest buys nothing and is
      // what would make this too slow to keep.
      if (failed === true) return { covered: true, by: suite };
    }
    return { covered: false, by: undefined };
  });
}

export function main(argv) {
  const list = argv.includes("--list");
  const all = argv.includes("--all");
  const seed = argv.includes("--seed");
  const original = readFileSync(CI_YML, "utf8");
  const guards = enumerateSkipGuards(original);
  if (guards.length === 0) {
    console.error("workflow-guard-mutation: NO skip-shaped guards found in ci.yml - the enumerator sees nothing, which is a defect in this script, not a clean tree. FAILING.");
    return 1;
  }
  if (list) {
    for (const g of guards) console.log(`${String(g.line).padStart(5)}  ${g.key}`);
    console.log(`\nworkflow-guard-mutation: ${guards.length} skip-shaped guard(s).`);
    return 0;
  }
  const baseline = readBaseline();
  const suites = ciReadingSuites();
  if (suites.length === 0) {
    console.error("workflow-guard-mutation: no ci.yml-reading suites found - every guard would read UNCOVERED for want of a corpus, not for want of coverage. FAILING.");
    return 1;
  }
  const uncovered = [];
  const measured = [];
  for (const g of guards) {
    const recorded = baseline.guards?.[g.key];
    if (recorded && !all && !seed) {
      console.log(`BASELINED  ${g.key}\n           reason: ${recorded.reason}`);
      continue;
    }
    const { covered, by } = classifyGuard(g, original, suites);
    measured.push({ guard: g, covered, by });
    if (covered) console.log(`COVERED    ${g.key}\n           distinguished by ${by}`);
    else {
      console.log(`UNCOVERED  ${g.key}`);
      uncovered.push(g);
    }
  }
  if (seed) {
    const guardsOut = { ...(baseline.guards ?? {}) };
    for (const g of uncovered) {
      guardsOut[g.key] = guardsOut[g.key] ?? {
        reason: "RECORDED UNMEASURED by --seed: no test distinguishes this skip firing unconditionally. Replace this line with why that is acceptable, or cover it.",
      };
    }
    writeFileSync(BASELINE, `${JSON.stringify({ guards: guardsOut }, null, 2)}\n`);
    console.log(`\nworkflow-guard-mutation: recorded ${uncovered.length} uncovered guard(s) in ${BASELINE}.`);
    return 0;
  }
  console.log(
    `\nworkflow-guard-mutation: ${measured.filter((m) => m.covered).length} covered, ${uncovered.length} uncovered, ` +
      `${guards.length - measured.length} baselined, across ${guards.length} guard(s) and ${suites.length} ci.yml-reading suite(s).`,
  );
  if (uncovered.length > 0 && !all) {
    console.error(
      `workflow-guard-mutation: BLOCKED -- ${uncovered.length} skip guard(s) can fire UNCONDITIONALLY with every test still green:\n` +
        uncovered.map((g) => `  - ci.yml:${g.line}  ${g.key}`).join("\n") +
        "\nA guard no test can distinguish turns a required check into a green no-op. Add a case that\n" +
        `asserts the skip does NOT fire on the other side, or record it in ${BASELINE} with the reason.`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("workflow-guard-mutation-check-ratchet.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
