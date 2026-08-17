import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkDrillCoverage, judgeRubric } from "../src/lib/review.js";

// W1-T939 — DRILL COVERAGE. Mirrors src/lib/review.ts's TROUBLESHOOTING COVERAGE
// (W1-T50, checkTroubleshootingCoverage) one field over: a new
// `learnings/failures.yaml` entry marked `drill_obligating: true` must be
// accompanied, in the SAME diff, by a touch to `scripts/recovery-drill.mjs`
// (the RECOVERY_PATHS table W1-T366/W1-T938 built) naming that entry's id — or
// the report must state why not.

// A diff that adds a NEW drill-obligating failures entry, with NO accompanying
// scripts/recovery-drill.mjs touch.
const NEW_DRILL_FAILURE_NO_TABLE_DIFF = [
  "diff --git a/learnings/failures.yaml b/learnings/failures.yaml",
  "+++ b/learnings/failures.yaml",
  "@@",
  "+- id: new-guard-survived-incident",
  "+  subsystem: containment",
  "+  lifecycle: active",
  "+  drill_obligating: true",
  "+  files: [src/lib/worker-containment.ts]",
  '+  fact: "some new incident a guard carried the fleet through"',
  "+  src: PR#999",
].join("\n");

// The SAME new entry, but scripts/recovery-drill.mjs is updated in the same
// diff, naming the new entry's id (e.g. in a comment tying the table entry
// back to its postmortem).
const NEW_DRILL_FAILURE_WITH_TABLE_DIFF = [
  NEW_DRILL_FAILURE_NO_TABLE_DIFF,
  "diff --git a/scripts/recovery-drill.mjs b/scripts/recovery-drill.mjs",
  "+++ b/scripts/recovery-drill.mjs",
  "@@",
  "+  {",
  "+    // learnings#new-guard-survived-incident",
  '+    key: "new-guard-fault",',
  '+    label: "new guard fault",',
  "+    exercise: exerciseNewGuardFault,",
  "+  },",
].join("\n");

// A new failures entry WITHOUT drill_obligating: true — the ordinary case
// (most postmortems are dev-time, with no guard to inject). Never triggers the
// item — THE FALSE-POSITIVE FALSIFIER, half 1.
const NEW_NON_DRILL_FAILURE_DIFF = [
  "diff --git a/learnings/failures.yaml b/learnings/failures.yaml",
  "+++ b/learnings/failures.yaml",
  "@@",
  "+- id: internal-only-postmortem",
  "+  subsystem: reviewer",
  "+  lifecycle: active",
  "+  files: [src/lib/review.ts]",
  '+  fact: "an internal-only detail, no guard involved"',
  "+  src: PR#999",
].join("\n");

// An EXISTING entry gains a field (drill_obligating: true) — the `- id:` line
// itself is unchanged CONTEXT, not an add, so this is a MODIFICATION, not a
// new entry, and must never trip the item (mirrors checkTroubleshootingCoverage's
// EXISTING_FAILURE_GAINS_FLAG_DIFF case exactly).
const EXISTING_FAILURE_GAINS_DRILL_FLAG_DIFF = [
  "diff --git a/learnings/failures.yaml b/learnings/failures.yaml",
  "+++ b/learnings/failures.yaml",
  "@@",
  " - id: reviewer-floor-casing-blind",
  "   subsystem: reviewer",
  "   lifecycle: active",
  "+  drill_obligating: true",
  "   files: [src/lib/review.ts]",
].join("\n");

// A diff touching neither learnings/failures.yaml nor scripts/recovery-drill.mjs.
const CLEAN_DIFF = [
  "diff --git a/src/lib/greet.ts b/src/lib/greet.ts",
  "+++ b/src/lib/greet.ts",
  "@@",
  "+export function greet(name) {",
  '+  return "hi " + name;',
  "+}",
].join("\n");

test("checkDrillCoverage: a new drill_obligating:true failure with no scripts/recovery-drill.mjs touch FAILS, naming the drill table", () => {
  const noTable = checkDrillCoverage(NEW_DRILL_FAILURE_NO_TABLE_DIFF, "Added a new failure learning.");
  assert.equal(noTable.pass, false);
  assert.match(noTable.reason, /new-guard-survived-incident/);
  assert.match(noTable.reason, /scripts\/recovery-drill\.mjs/);
});

test("checkDrillCoverage: the identical new entry WITH a scripts/recovery-drill.mjs touch naming its id PASSES", () => {
  assert.equal(
    checkDrillCoverage(NEW_DRILL_FAILURE_WITH_TABLE_DIFF, "Added a new failure learning.").pass,
    true,
  );
});

test("checkDrillCoverage: no scripts/recovery-drill.mjs touch, but the report STATES why not, PASSES", () => {
  assert.equal(
    checkDrillCoverage(
      NEW_DRILL_FAILURE_NO_TABLE_DIFF,
      "Added a new failure learning. no drill entry because the guard cannot be faithfully reproduced in CI.",
    ).pass,
    true,
  );
  // A bare "no drill entry" with nothing stated after it is NOT an excuse — still fails.
  assert.equal(
    checkDrillCoverage(NEW_DRILL_FAILURE_NO_TABLE_DIFF, "Added a new failure learning. no drill entry.").pass,
    false,
  );
});

test("checkDrillCoverage — THE FALSE-POSITIVE FALSIFIER: an ordinary unmarked entry, and a marked entry whose diff DOES touch the drill table, both clear the rung silently", () => {
  // Half 1: an ordinary failures.yaml entry with no drill_obligating flag at all.
  assert.equal(checkDrillCoverage(NEW_NON_DRILL_FAILURE_DIFF, "").pass, true);
  // Half 2: a marked entry whose diff DOES touch the drill table (the WITH_TABLE
  // fixture above already proves this, restated here under the falsifier's own name).
  assert.equal(checkDrillCoverage(NEW_DRILL_FAILURE_WITH_TABLE_DIFF, "").pass, true);
  // Adding drill_obligating: true to an EXISTING entry (not a new one) never trips it.
  assert.equal(checkDrillCoverage(EXISTING_FAILURE_GAINS_DRILL_FLAG_DIFF, "").pass, true);
  // A diff touching neither file never trips it.
  assert.equal(checkDrillCoverage(CLEAN_DIFF, "").pass, true);
});

test("checkDrillCoverage derives its verdict from the diff alone, never from the corpus on disk", () => {
  // `new-guard-survived-incident` is NOT a real id in learnings/failures.yaml on disk (it is a
  // synthetic fixture id invented for this test) — if the rung read the corpus off the working
  // tree instead of the diff, it could not possibly find this id there and the behaviour would
  // diverge from what the diff itself says. It doesn't: the diff alone is authoritative.
  const failuresYamlOnDisk = readFileSync(
    fileURLToPath(new URL("../learnings/failures.yaml", import.meta.url)),
    "utf8",
  );
  assert.equal(failuresYamlOnDisk.includes("new-guard-survived-incident"), false);
  assert.equal(checkDrillCoverage(NEW_DRILL_FAILURE_NO_TABLE_DIFF, "").pass, false);
  assert.equal(checkDrillCoverage(NEW_DRILL_FAILURE_WITH_TABLE_DIFF, "").pass, true);

  // And the converse: an id that DOES exist on disk today, marked drill_obligating: true only in
  // the DIFF's context (not a real on-disk flag), is judged purely off what the diff shows was
  // ADDED — a diff that never adds a `- id:` line for it is not "a new entry" no matter what the
  // corpus on disk says about that id.
  assert.equal(failuresYamlOnDisk.includes("reviewer-floor-casing-blind"), true);
  assert.equal(checkDrillCoverage(EXISTING_FAILURE_GAINS_DRILL_FLAG_DIFF, "").pass, true);
});

test("checkDrillCoverage is wired into judgeRubric as its own item", () => {
  const clean = judgeRubric({ diff: CLEAN_DIFF, report: "" });
  assert.ok(clean.items.some((i) => i.key === "drill-coverage" && i.pass));

  const dirty = judgeRubric({ diff: NEW_DRILL_FAILURE_NO_TABLE_DIFF, report: "added a new failure learning" });
  assert.ok(dirty.failures.some((f) => f.key === "drill-coverage"));
  assert.equal(dirty.pass, false);
});

test("the new field is documented where an author will meet it: learnings/failures.yaml's header, and LearningEntry's own doc comment in src/lib/learnings.ts", () => {
  const failuresYamlHeader = readFileSync(
    fileURLToPath(new URL("../learnings/failures.yaml", import.meta.url)),
    "utf8",
  );
  // The header block documents the field name, its sibling relationship to operator_impact, and
  // what `true` obligates (a matching drill-table touch).
  assert.match(failuresYamlHeader, /drill_obligating/);
  assert.match(failuresYamlHeader, /recovery-drill\.mjs/);

  const learningsSrc = readFileSync(fileURLToPath(new URL("../src/lib/learnings.ts", import.meta.url)), "utf8");
  assert.match(learningsSrc, /drillObligating\?:\s*boolean/);
  // The doc comment above the field states what `true` costs (a drill-table touch), the same way
  // operatorImpact's does for docs/troubleshooting.md.
  const fieldIdx = learningsSrc.indexOf("drillObligating?:");
  assert.ok(fieldIdx > 0, "drillObligating field not found in learnings.ts");
  const docComment = learningsSrc.slice(Math.max(0, fieldIdx - 700), fieldIdx);
  assert.match(docComment, /recovery-drill\.mjs/);
  assert.match(docComment, /obligates|obligating/i);
});
