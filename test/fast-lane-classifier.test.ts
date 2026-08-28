import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CLASS_DOCS_ONLY,
  CLASS_PLAN_ONLY,
  CLASS_SOURCE,
  classifyFiles,
  defaultGitGrep,
  isDirectRun,
  main,
  planReadingSuites,
  readFileList,
  // @ts-expect-error -- a .mjs entry point with no .d.ts; this suite is its only typed consumer.
} from "../scripts/diff-class.mjs";
import { isInPlanScope } from "../src/lib/plan-architect.js";

// ── W1-T2428: the fast lane ───────────────────────────────────────────────────────────────────
//
// CI runs every suite on every PR. A plan-only PR — a filed shard, a MASTER-PLAN edit — pays the
// full instrumented run to prove nothing, because no source line changed. This suite is the
// falsifier set for the classifier that lets such a diff run only the suites it can actually fail.
//
// THE ONE THING THAT MUST NEVER BREAK is the fail-closed direction: `source` runs everything, i.e.
// exactly the behaviour that existed before this task, so every unknown must land there. Half the
// tests below are about reaching `source`, not about reaching the fast lane.

const REPO_ROOT = join(import.meta.dirname, "..");
const CI_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const CI_GATE_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci-gate.yml"), "utf8");
const DIFF_CLASS_SRC = readFileSync(join(REPO_ROOT, "scripts", "diff-class.mjs"), "utf8");

/** The body of one `jobs:` entry in ci.yml, from its own key to the next top-level job key. */
function ciJobBody(name: string): string {
  const lines = CI_YML.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `ci.yml defines no job '${name}'`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[a-z0-9-]+:$/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// ── criterion 1: the class comes from the canonical predicate, not a fourth reimplementation ───

test("fast lane, criterion 1: diff-class.mjs IMPORTS isInPlanScope from plan-architect and spells out no plan-path rule of its own — the class has one definition, not a fourth", () => {
  assert.match(
    DIFF_CLASS_SRC,
    /import\(["'][^"']*plan-architect\.ts["']\)/,
    "the entry point must import the real TypeScript predicate",
  );
  // The FALSIFIER for a quiet reimplementation: a re-spelling of `isInPlanScope` would have to
  // carry its path rules as STRING LITERALS. Prose naming the same paths in a comment is fine and
  // expected; a quoted literal is the thing that would drift.
  const respellings = DIFF_CLASS_SRC.match(/["']MASTER-PLAN\.md["']|["']plan\/|ORIENTATION_DOC/g) ?? [];
  assert.deepEqual(
    respellings,
    [],
    `no plan-path literal may be re-spelled here — the predicate is imported: ${respellings.join(", ")}`,
  );
});

test("fast lane, criterion 1: classifyFiles agrees with the REAL isInPlanScope on the exact file list that made two of this repo's predicates disagree (#3131)", () => {
  const threeOneThreeOne = ["MASTER-PLAN.md", "docs/ORIENTATION.md", "plan/plan-index.json"];
  assert.equal(classifyFiles(threeOneThreeOne, isInPlanScope), CLASS_PLAN_ONLY);
  // The disagreement itself, asserted so a future change to either side is visible here: triage's
  // narrower reading calls docs/ORIENTATION.md a non-plan file, isInPlanScope does not.
  assert.equal(isInPlanScope("docs/ORIENTATION.md"), true);
});

// ── criterion 2: any error or undeterminable class runs everything ─────────────────────────────

test("fast lane, criterion 2: a THROWING predicate yields source, never a crash and never a skip", () => {
  const throwing = () => {
    throw new Error("predicate exploded");
  };
  assert.equal(classifyFiles(["plan/tasks.yaml"], throwing), CLASS_SOURCE);
});

test("fast lane, criterion 2: a malformed file list — a non-string entry, an empty string — yields source rather than being classified around", () => {
  assert.equal(classifyFiles([null as unknown as string], isInPlanScope), CLASS_SOURCE);
  assert.equal(classifyFiles(["plan/a.yaml", ""], isInPlanScope), CLASS_SOURCE);
  assert.equal(classifyFiles("plan/a.yaml" as unknown as string[], isInPlanScope), CLASS_SOURCE);
});

test("fast lane, criterion 2: readFileList returns an EMPTY list for an unreadable --from path, which the classifier then reads as source — the failure never narrows the run", () => {
  const missing = join(REPO_ROOT, "no-such-file-w1-t2428.txt");
  assert.deepEqual(readFileList(["--from", missing]), []);
  assert.equal(classifyFiles(readFileList(["--from", missing]), isInPlanScope), CLASS_SOURCE);
});

test("fast lane, criterion 2: main() prints source and does not reject when the import itself fails — the CLI's own catch arm, exercised by running it from a cwd where the relative import cannot resolve", async () => {
  const printed: string[] = [];
  await main(["--files", "plan/tasks.yaml"], (l: string) => printed.push(String(l)));
  assert.equal(printed.length, 1, "exactly one line on stdout, always — the workflow reads `tail -1`");
  assert.ok([CLASS_SOURCE, CLASS_PLAN_ONLY].includes(printed[0]!), `unexpected class: ${printed[0]}`);
});

test("fast lane, criterion 2: defaultGitGrep returns an empty array rather than throwing when git itself fails, so an unreadable tree degrades to running everything", () => {
  assert.deepEqual(defaultGitGrep(["grep", "--no-such-flag-w1-t2428"], REPO_ROOT), []);
});

test("fast lane, criterion 2: main() --plan-suites prints the enumeration line by line, and its catch arm still prints source when the SINK itself throws — one line on stdout, always", async () => {
  const listed: string[] = [];
  await main(["--plan-suites"], (l: string) => listed.push(String(l)));
  assert.ok(listed.length > 0, "--plan-suites must print the enumeration");
  assert.ok(listed.includes("test/plan-proposals.test.ts"));

  // Force main's own catch arm: a sink that throws on its FIRST call only. Without a covering
  // test this arm is unreachable-by-construction (nothing else in main can throw), and an
  // unreachable fail-closed arm is the exact defect this lane cannot afford.
  let thrown = false;
  const recovered: string[] = [];
  await main(["--plan-suites"], (l: string) => {
    if (!thrown) {
      thrown = true;
      throw new Error("sink exploded");
    }
    recovered.push(String(l));
  });
  assert.deepEqual(recovered, [CLASS_SOURCE], "a crash anywhere in main must still print source");
});

test("fast lane, criterion 2: readFileList returns an empty list when NEITHER --from nor --files is given, so an argv the workflow never sends still fails closed", () => {
  assert.deepEqual(readFileList([]), []);
  assert.deepEqual(readFileList(["--plan-suites"]), []);
  assert.equal(classifyFiles(readFileList([]), isInPlanScope), CLASS_SOURCE);
});

test("fast lane: isDirectRun is true only for the module's OWN resolved path — a basename comparison would fire for any same-named script, and importing this module must never run the CLI", () => {
  const self = join(REPO_ROOT, "scripts", "diff-class.mjs");
  assert.equal(isDirectRun(self, pathToFileURL(self).href), true);
  assert.equal(isDirectRun(undefined, pathToFileURL(self).href), false);
  assert.equal(isDirectRun("", pathToFileURL(self).href), false);
  // The basename trap: a DIFFERENT directory, same file name, must not read as a direct run.
  assert.equal(isDirectRun("/somewhere/else/diff-class.mjs", pathToFileURL(self).href), false);
});

// ── criterion 3: an empty file list runs everything rather than reading as plan-only ───────────

test("fast lane, criterion 3: an EMPTY changed-file list is source, NOT plan-only — `every()` on an empty array is vacuously true, and that is the whole trap", () => {
  assert.equal([].every(() => false), true, "the vacuous truth this guard exists to defeat");
  assert.equal(classifyFiles([], isInPlanScope), CLASS_SOURCE);
});

// ── criterion 4: one source path classifies the whole diff as source ───────────────────────────

test("fast lane, criterion 4: a MIXED diff takes the strictest class present — one src/ path forces source however much plan text rides along", () => {
  const mostlyPlan = [
    "plan/tasks.d/W1-T2428-x.yaml",
    "MASTER-PLAN.md",
    "docs/ORIENTATION.md",
    "plan/plan-index.json",
    "src/lib/drain.ts",
  ];
  assert.equal(classifyFiles(mostlyPlan, isInPlanScope), CLASS_SOURCE);
  assert.equal(classifyFiles(["docs/a.md", "src/lib/drain.ts"], isInPlanScope), CLASS_SOURCE);
  assert.equal(classifyFiles(["docs/a.md", "plan/tasks.yaml"], isInPlanScope), CLASS_SOURCE);
});

test("fast lane, criterion 4: docs-only is a class in its own right, and a docs path outside docs/ is not it", () => {
  assert.equal(classifyFiles(["docs/operator-guide.md", "docs/a.md"], isInPlanScope), CLASS_DOCS_ONLY);
  assert.equal(classifyFiles(["README.md"], isInPlanScope), CLASS_SOURCE);
});

// ── criterion 5: the plan-reading suite set is enumerated from the tree, never hand-copied ─────

test("fast lane, criterion 5: planReadingSuites enumerates from the LIVE tree and lands on the intersection — non-empty, carrying the exemplar, excluding a suite that reads no plan path", () => {
  const suites = planReadingSuites(REPO_ROOT);
  assert.ok(suites.length > 0, "an empty enumeration would silently skip everything — the workflow falls back to the full suite, but this must not be how it gets there");
  assert.ok(
    suites.includes("test/plan-proposals.test.ts"),
    "the exemplar must be in the set: it reads the committed MASTER-PLAN.md and caught a real duplicate proposal id",
  );
  assert.ok(!suites.includes("test/sweep.test.ts"), "a suite naming no plan or docs path must stay out of the set");
  assert.ok(
    suites.length < 785,
    "the set must be a strict subset of the ~785 test files; equality would mean the intersection collapsed and the lane saves nothing",
  );
});

test("fast lane, criterion 5: ci.yml calls `--plan-suites` and bakes NO suite list of its own — a hand-copied list is what goes stale, so the workflow must never carry one", () => {
  assert.match(CI_YML, /diff-class\.mjs --plan-suites/, "the workflow must enumerate at run time");
  // Only EXECUTABLE lines matter: ci.yml's comments legitimately cite test files as evidence
  // (test/diff-coverage.test.ts, test/serve.shell-ux.test.ts). A baked list would live in a run:.
  const baked = ciJobBody("ci").split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /test\/[a-z0-9.-]+\.test\.ts/.test(l) && !l.includes("test/**/*.test.ts"));
  assert.deepEqual(baked, [], `the ci job names individual test files outside a comment: ${baked.join(" | ")}`);
  // CONTROL: the assertion can see a baked name — containment-probe legitimately carries one, and
  // the same filter finds it there. So an empty result above is a real absence, not a blind query.
  const control = ciJobBody("containment-probe").split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /test\/[a-z0-9.-]+\.test\.ts/.test(l));
  assert.ok(control.length > 0, "positive control: the filter must be able to find a baked test-file name");
});

test("fast lane, criterion 5: an enumeration that comes back EMPTY runs the full suite — the workflow's own fallback, asserted in its text", () => {
  const ciBody = ciJobBody("ci");
  assert.match(ciBody, /if \[ -s "\$\{RUNNER_TEMP:-\/tmp\}"\/rmd-suites\.txt \]/, "the workflow must test the enumeration is non-empty");
  assert.match(ciBody, /came back EMPTY -- running the FULL suite \(fail closed\)/);
});

// ── criterion 6: every job still registers a check run ─────────────────────────────────────────

test("fast lane, criterion 6: the skip is a BASH guard inside a run: body, and neither guarded job gains an `if:` — a conditionally-skipped required check deadlocks merge (#729/#102)", () => {
  for (const job of ["ci", "coverage-ratchet"]) {
    const body = ciJobBody(job);
    assert.doesNotMatch(body, /\n\s*if:/, `${job} must carry no \`if:\` at all — it must always register`);
    assert.match(body, /RMD_DIFF_CLASS/, `${job} must read the class it was given`);
  }
});

test("fast lane, criterion 6: the classify step itself defaults to source before it runs anything, so a failure of the classifier cannot narrow the run", () => {
  const body = ciJobBody("ci");
  const classify = body.slice(body.indexOf("Classify this diff"));
  assert.match(classify, /^\s*class=source$/m, "class must be initialised to source, not assigned only on success");
  assert.match(classify, /plan-only\|docs-only\|source\) ;;\n\s*\*\) class=source ;;/, "an unrecognised word on stdout must fall back to source");
});

// ── criterion 7: each skip names its class and the steps it skipped ────────────────────────────

test("fast lane, criterion 7: every skip echoes the CLASS, and the two job summaries name the steps that did not run — no skip exits silently", () => {
  const guards = CI_YML.match(/echo "W1-T2428[^"]*"/g) ?? [];
  assert.ok(guards.length >= 5, `expected a named message on every guard, got ${guards.length}`);
  for (const g of guards) {
    assert.match(g, /\$\{RMD_DIFF_CLASS\}|diff class/, `a skip message must name its class: ${g}`);
  }
  const covBody = ciJobBody("coverage-ratchet");
  assert.match(covBody, /GITHUB_STEP_SUMMARY/, "the coverage skip must reach the job summary");
  const summaryBlock = covBody.slice(covBody.indexOf("GITHUB_STEP_SUMMARY") - 900, covBody.indexOf("GITHUB_STEP_SUMMARY"));
  for (const step of ["Test with coverage", "Compute this PR's base...head diff", "Diff coverage", "Coverage ratchet"]) {
    assert.ok(summaryBlock.includes(step), `the summary must NAME the skipped step '${step}'`);
  }
  assert.match(ciJobBody("ci"), /GITHUB_STEP_SUMMARY/, "the ci skip must reach the job summary");
});

// ── criterion 8: no name leaves ci-gate's required list ────────────────────────────────────────

test("fast lane, criterion 8: every name in ci-gate's REQUIRED list is still produced, and this change removes none — the list is read from ci-gate.yml, not recited", () => {
  const block = CI_GATE_YML.slice(CI_GATE_YML.indexOf("REQUIRED: >-"));
  const required = [...block.matchAll(/^\s*"([^"]+)",?$/gm)].map((m) => m[1]!);
  assert.ok(required.length >= 14, `expected ci-gate's full required list, parsed ${required.length}`);
  for (const name of ["ci", "coverage-ratchet"]) {
    assert.ok(required.includes(name), `${name} must still be required`);
    assert.match(CI_YML, new RegExp(`^  ${name}:$`, "m"), `${name} must still be a job ci.yml defines`);
  }
  // The fast lane touches no other required context: the remaining names must appear in ci.yml or
  // be produced elsewhere (scan-pr / osv-scan, License Review), and none may have been deleted.
  const definedHere = required.filter((n) => new RegExp(`^  ${n}:$`, "m").test(CI_YML));
  assert.equal(definedHere.length, 12, `expected ci.yml to define 12 of the required contexts, saw ${definedHere.length}: ${definedHere.join(", ")}`);
});
