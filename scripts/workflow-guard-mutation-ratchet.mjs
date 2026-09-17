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
//   node scripts/workflow-guard-mutation-ratchet.mjs            # gate: non-baselined guards must be COVERED
//   node scripts/workflow-guard-mutation-ratchet.mjs --all      # measure every guard, report only, exit 0
//   node scripts/workflow-guard-mutation-ratchet.mjs --list     # enumerate the guards and exit
//   node scripts/workflow-guard-mutation-ratchet.mjs --seed     # record every currently-UNCOVERED guard
//   node scripts/workflow-guard-mutation-ratchet.mjs --base <ref>  # judge inherited-vs-caused against <ref> (default origin/main)
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// W1-T3703: reuses comment-load-ratchet's own caused-vs-inherited rule (see
// splitCoverageViolations below) rather than restating it, the way W1-T3701 reused it for
// repo-layout's house-literal counts.
import { splitBaseInheritedViolations as splitCommentLoadViolations } from "./comment-load-ratchet.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI_YML = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const BASELINE = join(REPO_ROOT, "scripts", "workflow-guard-mutation-baseline.json");
/** Excluded from the corpus - see {@link ciReadingSuites}. */
export const OWN_SUITE = "test/a-ci-skip-guard-can-fire-unconditionally.test.ts";

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
 * THIS RATCHET'S OWN SUITE IS EXCLUDED, and the reason generalises. It asserts the guard
 * INVENTORY - that every baselined key still exists in ci.yml - so it fails under ANY mutation of
 * any guard, including a correct edit. Left in, it "distinguishes" every mutant without testing
 * one behaviour: MEASURED, a re-seed with it in the corpus read 14 covered / 2 uncovered where the
 * honest figure was 5 / 11. That is the general hazard - a purely STRUCTURAL suite over ci.yml's
 * text reacts to the edit, not to what the guard does - and it is stated here rather than
 * detected, because only this one suite is guaranteed to have the property.
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
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".test.ts") && l !== OWN_SUITE);
}

/**
 * THE VERDICT A RUN'S OUTPUT CARRIES — split from the spawn so the rule is testable without one.
 *
 * A run with no `# fail` summary is NOT a result: a killed or timed-out run prints the assertions
 * it reached and no totals, and reading that as "no failures" is how a truncated run gets mistaken
 * for a green one. Absent totals answer `undefined`, never `false`.
 */
export function suiteVerdictFrom(out) {
  const summary = /^# fail (\d+)$/m.exec(out);
  if (!summary) return undefined;
  return Number(summary[1]) > 0;
}

// diff-cov: process-boundary — running a suite in a child node cannot carry a DA hit without
// forking; everything this decides lives in suiteVerdictFrom above, unit-tested against the
// truncated, green and failing shapes, and every caller takes it as an injectable `runSuite`.
function suiteFails(suite) {
  const res = spawnSync(
    process.execPath,
    ["--test", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", suite],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { failed: suiteVerdictFrom(out), out };
}

/** An unreadable or unparseable baseline is an EMPTY one, never a crash: a ratchet that dies on
 *  its own record file cannot report the thing it exists to report. */
export function readBaseline(path = BASELINE, read = readFileSync) {
  try {
    return JSON.parse(read(path, "utf8"));
  } catch {
    return { guards: {} };
  }
}

/** Restore the workflow whatever happens - a crashed run must never leave a mutant on disk. */
export function withMutant(guard, original, fn, io = { path: CI_YML, write: writeFileSync }) {
  io.write(io.path, mutateGuardLine(original, guard));
  const restore = () => io.write(io.path, original);
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
/**
 * THE POSITIVE CONTROL, AND IT IS NOT OPTIONAL. {@link classifyGuard} calls a guard COVERED the
 * moment any suite fails under the mutant, and it cannot tell "failed BECAUSE of the mutant" from
 * "was already failing". So a single red suite anywhere in the corpus makes EVERY guard read
 * covered and this whole ratchet reports a clean tree it never measured.
 *
 * MEASURED while building this, which is why it exists: a stale entry left this ratchet's own
 * suite red, that suite sorted first in the corpus, and a full re-seed reported "0 uncovered"
 * against a tree with eleven. A vacuous pass, produced by the gate written to refuse them.
 *
 * A run with no `# fail` summary counts as red too: a killed or timed-out suite proves nothing,
 * and treating "no totals" as green is the same mistake one level down.
 */
export function redCorpus(suites, runSuite = suiteFails) {
  return suites.flatMap((suite) => {
    const { failed } = runSuite(suite);
    if (failed === false) return [];
    return [{ suite, why: failed === undefined ? "produced no `# fail` summary" : "is already failing" }];
  });
}

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

/**
 * W1-T3703 — split UNCOVERED, non-baselined guards into ones THIS DIFF CAUSED and ones it
 * INHERITED from the merge base, built on comment-load-ratchet's own caused-vs-inherited rule
 * (design note i) instead of restating it. A guard's boolean verdict is modelled as the same
 * "count" shape that rule already compares: uncovered is `comments: 1`, covered is `0`, so "this
 * diff's count is no worse than the merge base already carried" decides both gates identically.
 *
 * A guard absent from `baseGuardsByKey` is unconditionally CAUSED — design note iii, the guard's
 * direction never changes, a genuinely new guarded mutation is still refused. `classifyAtBase` is
 * injected so this is testable with no real mutation run; the real caller re-runs `classifyGuard`
 * against the merge base's own ci.yml text, and only for a guard whose key matches something
 * already there, mirroring the sibling's "only breaching entries pay for the base read".
 */
export function splitCoverageViolations(uncovered, baseGuardsByKey, classifyAtBase) {
  const violations = uncovered.map((guard) => ({ path: guard.key, comments: 1, baseline: 0, guard }));
  const baseComments = {};
  for (const v of violations) {
    const baseGuard = baseGuardsByKey.get(v.path);
    if (baseGuard !== undefined) baseComments[v.path] = classifyAtBase(baseGuard).covered ? 0 : 1;
  }
  const split = splitCommentLoadViolations(violations, baseComments);
  return { caused: split.caused.map((v) => v.guard), inherited: split.inherited.map((v) => v.guard) };
}

/** Design note iv: a recorded exemption whose guard key no longer names a live guard in ci.yml is
 *  dropped whenever the ledger is REWRITTEN — a renamed job or a removed guard must not leave a
 *  permanent, unreachable exemption sitting in the file forever. */
export function pruneStaleBaselineGuards(guards, liveKeys) {
  const out = {};
  for (const [key, entry] of Object.entries(guards)) {
    if (liveKeys.has(key)) out[key] = entry;
  }
  return out;
}

/** The reason recorded for a guard the merge-base split found ALREADY uncovered there — worded
 *  like comment-load-ratchet's own inherited-growth line (design note ii) so a reader who already
 *  knows that phrase reads this one the same way. */
export function inheritedGuardReason(mergeBase) {
  return (
    `RECORDED by the merge-base split: this guard was already UNCOVERED at ${mergeBase.slice(0, 12)} -- ` +
    "inherited, not this diff's growth; the ledger is updated. Replace this reason once someone covers it."
  );
}

/**
 * `io` EXISTS SO THIS FUNCTION IS TESTABLE, and that is not a courtesy: every refusal below is a
 * verdict about the tree, and a verdict nothing can drive is a verdict nobody has shown works —
 * the same argument git-push.ts's own leaf makes for its `exec` seam. Omitted, every field is the
 * real one and the behaviour is byte-identical.
 */
export function main(argv, io = {}) {
  const readCi = io.readCi ?? (() => readFileSync(CI_YML, "utf8"));
  const baselineOf = io.readBaseline ?? (() => readBaseline());
  const suitesOf = io.suites ?? (() => ciReadingSuites());
  const classify = io.classify ?? classifyGuard;
  const corpusCheck = io.redCorpus ?? redCorpus;
  const writeBaseline = io.writeBaseline ?? ((text) => writeFileSync(BASELINE, text));
  // W1-T3703: the merge-base a "caused vs inherited" split is judged against, resolved fresh each
  // run (never a stored number) — same shape as comment-load-ratchet's own readBaseDiff.
  const resolveMergeBase = io.resolveMergeBase ?? ((ref) => {
    const out = execFileSync("git", ["-C", REPO_ROOT, "merge-base", ref, "HEAD"], { encoding: "utf8" }).trim();
    if (!/^[0-9a-f]{40}$/i.test(out)) throw new Error(`git did not return a commit identity for ${ref}`);
    return out;
  });
  const readCiAtBase = io.readCiAtBase ?? ((base) => {
    const res = spawnSync("git", ["-C", REPO_ROOT, "show", `${base}:.github/workflows/ci.yml`], { encoding: "utf8" });
    return res.status === 0 ? res.stdout : undefined;
  });
  const log = io.log ?? console.log;
  const err = io.err ?? console.error;
  const list = argv.includes("--list");
  const all = argv.includes("--all");
  const seed = argv.includes("--seed");
  const baseFlagIndex = argv.indexOf("--base");
  const mergeBaseRef = baseFlagIndex !== -1 && argv[baseFlagIndex + 1] !== undefined ? argv[baseFlagIndex + 1] : "origin/main";
  const original = readCi();
  const guards = enumerateSkipGuards(original);
  if (guards.length === 0) {
    err("workflow-guard-mutation: NO skip-shaped guards found in ci.yml - the enumerator sees nothing, which is a defect in this script, not a clean tree. FAILING.");
    return 1;
  }
  const currentKeys = new Set(guards.map((g) => g.key));
  if (list) {
    for (const g of guards) log(`${String(g.line).padStart(5)}  ${g.key}`);
    log(`\nworkflow-guard-mutation: ${guards.length} skip-shaped guard(s).`);
    return 0;
  }
  const baseline = baselineOf();
  const suites = suitesOf();
  if (suites.length === 0) {
    err("workflow-guard-mutation: no ci.yml-reading suites found - every guard would read UNCOVERED for want of a corpus, not for want of coverage. FAILING.");
    return 1;
  }
  // THE CONTROL RUNS FIRST, BEFORE A SINGLE MUTANT IS WRITTEN - see redCorpus.
  const red = corpusCheck(suites);
  if (red.length > 0) {
    err(
      "workflow-guard-mutation: REFUSING to measure - the corpus is not green on the UNMUTATED tree:\n" +
        red.map((r) => `  - ${r.suite} ${r.why}`).join("\n") +
        "\nA guard is called covered when a suite fails under its mutant, and that cannot be told apart\n" +
        "from a suite that was already failing. Every guard would read COVERED and this ratchet would\n" +
        "report a clean tree it never measured. Fix the corpus, then re-run.",
    );
    return 1;
  }
  const uncovered = [];
  const measured = [];
  for (const g of guards) {
    const recorded = baseline.guards?.[g.key];
    if (recorded && !all && !seed) {
      log(`BASELINED  ${g.key}\n           reason: ${recorded.reason}`);
      continue;
    }
    const { covered, by } = classify(g, original, suites);
    measured.push({ guard: g, covered, by });
    if (covered) log(`COVERED    ${g.key}\n           distinguished by ${by}`);
    else {
      log(`UNCOVERED  ${g.key}`);
      uncovered.push(g);
    }
  }
  if (seed) {
    // Design note iv: prune a stale exemption here too — --seed is also "the ledger is rewritten".
    const guardsOut = pruneStaleBaselineGuards(baseline.guards ?? {}, currentKeys);
    for (const g of uncovered) {
      guardsOut[g.key] = guardsOut[g.key] ?? {
        reason: "RECORDED UNMEASURED by --seed: no test distinguishes this skip firing unconditionally. Replace this line with why that is acceptable, or cover it.",
      };
    }
    writeBaseline(`${JSON.stringify({ guards: guardsOut }, null, 2)}\n`);
    log(`\nworkflow-guard-mutation: recorded ${uncovered.length} uncovered guard(s) in ${BASELINE}.`);
    return 0;
  }

  // W1-T3703: a diff is refused only for what IT added — design note i. Only the violating guards
  // pay for a read of the merge base, so a clean run (the common case) costs nothing extra.
  let caused = uncovered;
  let inherited = [];
  if (!all && uncovered.length > 0) {
    let mergeBase;
    let baseText;
    try {
      mergeBase = resolveMergeBase(mergeBaseRef);
      baseText = readCiAtBase(mergeBase);
    } catch (e) {
      err(
        `workflow-guard-mutation: could not resolve the merge base against ${mergeBaseRef} to split caused-vs-inherited violations: ${String(e.message ?? e)}`,
      );
      return 1;
    }
    // ci.yml did not exist at the base at all (a brand-new workflow): nothing to inherit, so every
    // guard is CAUSED — the empty map falls through splitCoverageViolations' own "absent" arm.
    const baseGuardsByKey = baseText === undefined
      ? new Map()
      : new Map(enumerateSkipGuards(baseText).map((bg) => [bg.key, bg]));
    const split = splitCoverageViolations(uncovered, baseGuardsByKey, (bg) => classify(bg, baseText, suites));
    caused = split.caused;
    inherited = split.inherited;
    if (inherited.length > 0) {
      const guardsOut = pruneStaleBaselineGuards(baseline.guards ?? {}, currentKeys);
      for (const g of inherited) guardsOut[g.key] = { reason: inheritedGuardReason(mergeBase) };
      writeBaseline(`${JSON.stringify({ guards: guardsOut }, null, 2)}\n`);
      for (const g of inherited) {
        log(
          `${g.key} is UNCOVERED, but was already UNCOVERED at the merge base -- inherited, not this diff's growth; the ledger is updated.`,
        );
      }
    }
  }

  log(
    `\nworkflow-guard-mutation: ${measured.filter((m) => m.covered).length} covered, ${caused.length} uncovered, ` +
      `${inherited.length} inherited, ${guards.length - measured.length} baselined, across ${guards.length} guard(s) and ${suites.length} ci.yml-reading suite(s).`,
  );
  if (caused.length > 0 && !all) {
    err(
      `workflow-guard-mutation: BLOCKED -- ${caused.length} skip guard(s) can fire UNCONDITIONALLY with every test still green:\n` +
        caused.map((g) => `  - ci.yml:${g.line}  ${g.key}`).join("\n") +
        "\nA guard no test can distinguish turns a required check into a green no-op. Add a case that\n" +
        `asserts the skip does NOT fire on the other side, or record it in ${BASELINE} with the reason.`,
    );
    return 1;
  }
  return 0;
}

// diff-cov: process-boundary — CLI dispatch: process.exit(main(...)) cannot carry a DA hit without
// forking the process; main's own verdicts — the no-guards and empty-corpus refusals, the red-corpus
// refusal, the uncovered block, the baselined skip, --list, --all and --seed — are unit-tested
// through its `io` seam in test/a-ci-skip-guard-can-fire-unconditionally.test.ts.
if (process.argv[1] && process.argv[1].endsWith("workflow-guard-mutation-ratchet.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
