import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T409: PLAN-STATE SELF-CONSISTENCY gate (the offline half of W1-T392's split) ────────────
//
// W1-T392's own design note draws the seam: THIS half reads MASTER-PLAN.md against ITSELF (no
// network, no live GitHub state) and, by its own admission, is the half that would NOT have caught
// the W1-T149 incident -- a consistency check over two lists cannot see an id absent from BOTH.
// It is filed anyway because a document asserting a task both landed (the "## SHIPPED log" section)
// and did not land (a "not shipped"/"unbuilt"/"did not ship" line elsewhere) is a decidable defect.
//
// This suite proves, against throwaway fixtures (never the live MASTER-PLAN.md, so it never goes
// red just because the plan was edited):
//   1. an id recorded landed in the SHIPPED log while another line asserts it did not land is
//      refused offline, naming the id and both citation lines (contradiction.md);
//   2. removing the not-shipped assertion clears the contradiction, and the scan still counts as
//      having examined both sides (removed-assertion.md);
//   3. an id recorded ONLY in the SHIPPED log's compressed-pair notation (`T<n>/#<pr>`, no
//      long-form `W<n>-T<n>` anywhere) is still matched -- proving the extractor is not blind to
//      the log's house style, which a long-form-only regex would be (compressed-only.md);
//   4. an examined set that is empty on the shipped side, or a not-shipped side with NO
//      phrase-bearing line at all, exits non-zero as UNEXAMINED rather than rendering as a clean
//      pass (empty-shipped-log.md / empty-not-shipped.md);
//   4a. (W1-T1232) a not-shipped side the extractor DID read but bound no task id in -- every
//      phrase-bearing clause named a proposal or nothing -- is an honest empty result, not a
//      broken scan, and is reported OK, never UNEXAMINED (not-shipped-honest-empty.md). This is
//      the fact `checkPlanStateConsistency` used to compute and discard: MASTER-PLAN.md's rule 9
//      tells an author to DELETE a corrected id from this region rather than annotate it, which
//      empties the region BY CONSTRUCTION, and the gate must not refuse that honest emptiness.
//   5. a short-form number the fixture plan does not know (T999) is never resolved into an id, so
//      no contradiction is invented even when the not-shipped side separately asserts it unbuilt
//      (unresolvable-short-form.md).
//
// (scripts/plan-state-claims.mjs is a plain .mjs file outside tsconfig's `include` that also
// imports directly from .ts modules -- src/lib/plan.ts's loadPlan, src/lib/retro.ts's
// extractAssertedUnbuiltTaskIds (W1-T410's reused extractor) -- so, mirroring
// test/capability-snapshot.test.ts's convention for scripts/generate-capability-snapshot.mjs, every
// scenario above is exercised via `spawnSync` against its CLI surface, run under `node --import tsx`
// the same way this task's claims.yaml entry invokes it. ONE exception: firstNotShippedLine's
// "no citation line found" fallback has no CLI-reachable trigger -- it can only fire for an id
// checkPlanStateConsistency already decided IS asserted not-shipped, and that decision guarantees
// the citation text is present on some line -- so that one case imports the exported function
// directly instead of manufacturing an unreachable CLI scenario.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "plan-state-claims.mjs");
const FIXTURES = join(__dirname, "fixtures", "plan-state-claims");
const FIXTURE_PLAN = join(FIXTURES, "tasks.yaml");

function run(fixtureMd: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, "--master-plan", join(FIXTURES, fixtureMd), "--plan", FIXTURE_PLAN],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
}

test("plan-state-claims: a task id recorded landed in the SHIPPED log while another line asserts it did not land is refused offline, naming the id and both lines", () => {
  const result = run("contradiction.md");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /DOCUMENT CONTRADICTS ITSELF/);
  assert.match(output, /\[W1-T149\] SHIPPED at MASTER-PLAN\.md:\d+: ".*W1-T149\/#349.*"/);
  assert.match(output, /\[W1-T149\] NOT-SHIPPED at MASTER-PLAN\.md:\d+: ".*W1-T149 did not ship.*"/);
  // W1-T1232: a contradiction is refused with both citation lines unchanged, and the report still
  // names how many not-shipped-phrase-bearing lines were read.
  assert.match(output, /1 not-shipped-phrase-bearing line\(s\) read/);
});

test("plan-state-claims: removing the not-shipped assertion clears the contradiction, and both sides still count as examined (never a vacuous pass)", () => {
  const result = run("removed-assertion.md");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /plan-state-claims: OK/);
  assert.match(output, /3 shipped-log id\(s\) examined/);
  assert.match(output, /1 not-shipped-phrase-bearing line\(s\) read/);
  assert.match(output, /1 not-shipped id\(s\) examined/);
  assert.match(output, /0 contradiction\(s\)/);
  assert.doesNotMatch(output, /W1-T149/);
});

test("plan-state-claims: a not-shipped region the extractor read but bound no task id in is reported OK, not UNEXAMINED (honestly empty, not a broken scan)", () => {
  const result = run("not-shipped-honest-empty.md");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /plan-state-claims: OK/);
  assert.doesNotMatch(output, /UNEXAMINED/);
  assert.match(output, /2 shipped-log id\(s\) examined/);
  // The fixture's one not-shipped-phrase-bearing line binds a proposal id (P12), not a task id --
  // the extractor READ it (examinedLines > 0) but bound zero task ids, which must read as an
  // honest empty result, never as a broken scan.
  assert.match(output, /1 not-shipped-phrase-bearing line\(s\) read/);
  assert.match(output, /0 not-shipped id\(s\) examined/);
  assert.match(output, /0 contradiction\(s\)/);
});

test("plan-state-claims: an id recorded ONLY in the compressed pair notation (T<n>/#<pr>, no long-form anywhere) is still matched -- the extractor is not blind to the log's house style", () => {
  const result = run("compressed-only.md");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /DOCUMENT CONTRADICTS ITSELF/);
  assert.match(output, /\[W1-T148\]/);
  // The fixture's SHIPPED log carries T148 ONLY as `T148/#839` -- confirm the long form never
  // appears anywhere in the fixture, so a long-form-only extractor could not have found this id.
  const fixtureText = readFileSync(join(FIXTURES, "compressed-only.md"), "utf8");
  assert.doesNotMatch(fixtureText, /\bW1-T148\b/);
});

test("plan-state-claims: an examined set empty on the SHIPPED-log side exits non-zero as UNEXAMINED, never a clean result", () => {
  const result = run("empty-shipped-log.md");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /UNEXAMINED/);
  assert.match(output, /0 shipped-log id\(s\) examined/);
  // The not-shipped side is fine here (one phrase-bearing line, one bound id) -- shippedExamined
  // alone triggers UNEXAMINED, and the report still names the phrase-bearing line count.
  assert.match(output, /1 not-shipped-phrase-bearing line\(s\) read/);
  assert.doesNotMatch(output, /plan-state-claims: OK/);
});

test("plan-state-claims: a not-shipped region with NO phrase-bearing line at all is still reported UNEXAMINED (a broken scan, not an honest empty result)", () => {
  const result = run("empty-not-shipped.md");
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /UNEXAMINED/);
  assert.match(output, /0 not-shipped-phrase-bearing line\(s\) read/);
  assert.match(output, /0 not-shipped id\(s\) examined/);
  assert.doesNotMatch(output, /plan-state-claims: OK/);
});

test("plan-state-claims: a short-form number the fixture plan does not know is not resolved into an id, so no contradiction is invented", () => {
  const result = run("unresolvable-short-form.md");
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /plan-state-claims: OK/);
  // T999 appears in the SHIPPED log's compressed-pair form AND is separately asserted "unbuilt" --
  // if the runner guessed/invented a W1-T999 id instead of refusing an unknown number, this would
  // read as a contradiction. It must not: the fixture plan (tasks.yaml/tasks.d/shard.yaml) carries
  // no id ending -T999, so it is dropped from the shipped-log side entirely.
  assert.match(output, /2 shipped-log id\(s\) examined/);
  assert.doesNotMatch(output, /T999/);
  assert.doesNotMatch(output, /DOCUMENT CONTRADICTS ITSELF/);
});

test("plan-state-claims: the real MASTER-PLAN.md and plan/tasks.yaml are self-consistent right now (the CLI's default invocation, exactly as plan/claims.yaml wires it)", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /plan-state-claims: OK/);
});

test("plan-state-claims: an unreadable --master-plan path is refused with a named error, never an uncaught crash", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, "--master-plan", join(FIXTURES, "does-not-exist.md"), "--plan", FIXTURE_PLAN],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /plan-state-claims: cannot read/);
  assert.match(output, /does-not-exist\.md/);
});

test("plan-state-claims: an unreadable --plan path is refused with a named error, never an uncaught crash", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      SCRIPT,
      "--master-plan",
      join(FIXTURES, "removed-assertion.md"),
      "--plan",
      join(FIXTURES, "does-not-exist.yaml"),
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /plan-state-claims: cannot load plan/);
  assert.match(output, /does-not-exist\.yaml/);
});

test("plan-state-claims: firstNotShippedLine returns no citation when the id is never asserted not-shipped anywhere in the document", async () => {
  const { firstNotShippedLine } = await import(pathToFileURL(SCRIPT).href);
  const masterPlanMd = [
    "## SHIPPED log",
    "",
    "- W1-T1/#1 landed.",
    "",
    "## Other",
    "",
    "Nothing here mentions the not-shipped vocabulary at all.",
  ].join("\n");
  assert.equal(firstNotShippedLine(masterPlanMd, "W1-T1"), undefined);
});
