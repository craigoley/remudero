import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../src/lib/tmp.js";
// @ts-expect-error -- plain .mjs script, no type declarations
import { ANCHOR_SHAPES, ANCHOR_WINDOW, FIXTURES, census, classifyRecord, findCitations, formatReport, isAnchored, loadCorpus, measurePrecision } from "../scripts/citation-anchor-census.mjs";

// ── W1-T2649: CITATION-ANCHOR CENSUS ─────────────────────────────────────────────────────────
//
// W1-T2648 re-anchors ONE citation (#3305, in W1-T2481's rationale). This suite proves the
// SEPARATE, follow-on measurement: whether that citation was an outlier or the visible edge of
// a class, via a script that enumerates every `#NNNN` PR-number citation across the plan's task
// records and classifies each ANCHORED/ANCHORLESS -- and proves the four things the task's
// acceptance criteria require: (1) enumeration + naming of anchorless citations by record id and
// line, (2) precision declared via a hand-labelled fixture set BEFORE any count is trusted, (3)
// the census reports and never gates, and (4) the anchor forms are a DATA table.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "citation-anchor-census.mjs");

function runCli(args: string[]) {
  // The real corpus's report can run several MB (MASTER-PLAN.md alone carries thousands of
  // `#NNNN` mentions in its SHIPPED log) -- spawnSync's 1MB default maxBuffer would truncate it
  // and report a false ENOBUFS failure, the exact defect class this repo's own corpus names
  // (src/lib/commit-message.ts's defaultPreflightSpawn comment). Matches the 16MB house
  // convention scripts/claims-check.mjs and scripts/learnings-assert-check.mjs already use.
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

/** Builds a minimal on-disk corpus (a MASTER-PLAN.md plus a plan/tasks.d/ shard) so the CLI can
 *  be exercised end to end without depending on the live, ever-changing real corpus. */
function buildFixtureCorpus(masterPlanBody: string, shardYaml: string) {
  const dir = makeTempDir("citation-anchor-census-fixture");
  writeFileSync(join(dir, "MASTER-PLAN.md"), masterPlanBody);
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.d", "W1-T9001-fixture.yaml"), shardYaml);
  return dir;
}

// ── criterion 2: precision is DECLARED before the count is trusted ──────────────────────────────

test("FIXTURES carries hand-labelled cases in BOTH directions, lifted verbatim from the live corpus", () => {
  assert.ok(FIXTURES.some((f: { expected: string }) => f.expected === "anchored"), "no anchored fixture");
  assert.ok(FIXTURES.some((f: { expected: string }) => f.expected === "anchorless"), "no anchorless fixture");
  // The anchorless fixture IS #3305's original citation -- the exact case this task measures.
  assert.ok(FIXTURES.some((f: { text: string }) => f.text.includes("#3305")));
});

test("measurePrecision classifies every hand-labelled fixture correctly (3/3) -- a broken classifier fails THIS test, not silently ships", () => {
  const precision = measurePrecision();
  assert.equal(precision.total, FIXTURES.length);
  assert.equal(precision.correct, precision.total, JSON.stringify(precision.results, null, 2));
  for (const result of precision.results) {
    assert.equal(result.got, result.expected, `${result.label}: expected ${result.expected}, got ${result.got}`);
  }
});

test("measurePrecision uses the SAME classify path the census uses -- corrupting a fixture's expectation flips it to a reported FAIL", () => {
  const brokenFixtures = [{ ...FIXTURES[0], expected: "anchorless" }];
  const precision = measurePrecision(brokenFixtures);
  assert.equal(precision.correct, 0);
  assert.equal(precision.results[0].correct, false);
});

// ── criterion 1: every #NNNN citation is enumerated + classified; anchorless ones are named ──────

test("classifyRecord finds an ANCHORED citation (sha within the window) and an ANCHORLESS one (no anchor) in the same record", () => {
  // The two citations are padded well past ANCHOR_WINDOW apart so #200's window cannot pick up
  // #100's sha by proximity alone -- each classification stands on its OWN nearby prose.
  const filler = "unrelated connective prose that carries no anchor of any shape whatsoever, padding the gap. ";
  const text = `The fix landed on #100 at a1b2c3d, verified end to end. ${filler.repeat(2)}A separate claim cites #200 with nothing beside it.`;
  const results = classifyRecord("W1-T-fixture", text);
  const byPr = Object.fromEntries(results.map((r: { prNumber: string; anchored: boolean }) => [r.prNumber, r.anchored]));
  assert.equal(byPr["100"], true);
  assert.equal(byPr["200"], false);
});

test("census enumerates across MULTIPLE records and names each anchorless citation with its record id and its surrounding line", () => {
  const units = [
    { id: "W1-T-alpha", text: "Measured on #591 at 1f990d2, re-derived rather than assumed." },
    { id: "W1-T-beta", text: "Measured on #3305: applying the retirement ruling reddened lint-plan with 13 failing." },
  ];
  const result = census(units);
  assert.equal(result.total, 2);
  assert.equal(result.anchoredCount, 1);
  assert.equal(result.anchorlessCount, 1);
  assert.equal(result.anchorless.length, 1);
  assert.equal(result.anchorless[0].recordId, "W1-T-beta");
  assert.equal(result.anchorless[0].prNumber, "3305");
  assert.match(result.anchorless[0].line, /Measured on #3305/);
});

test("formatReport's printed text NAMES each anchorless citation by record id and line, not just the count", () => {
  const units = [{ id: "W1-T-gamma", text: "Cited to #777 with no sha, no merge state and no date nearby." }];
  const result = census(units);
  const report = formatReport(measurePrecision(), result);
  assert.match(report, /CITATIONS: 1 total, 0 anchored, 1 anchorless/);
  assert.match(report, /W1-T-gamma #777:.*no sha, no merge state and no date/);
});

test("findCitations reports the single source LINE a citation sits on, trimmed, not the wider anchor window", () => {
  const text = "para one line one\n    #444 sits on this indented line alone\npara one line three";
  const [citation] = findCitations(text);
  assert.equal(citation.prNumber, "444");
  assert.equal(citation.line, "#444 sits on this indented line alone");
});

// ── regression pins for the two measured false-positive shapes the module comment names ─────────

test("the sha shape rejects a bare run of decimal digits (a followup-id epoch) even though every digit is hex-valid", () => {
  assert.equal(isAnchored("epoch 1788101371246 sits nearby, #3305 no real anchor"), false);
});

test("the sha shape rejects an English word confined to a-f letters (\"effaced\") -- must contain a digit too", () => {
  assert.equal(isAnchored("the citation was effaced, referencing #900"), false);
});

test("the sha shape accepts a real mixed digit+letter git sha", () => {
  assert.equal(isAnchored("re-derived at c709493 for #900"), true);
});

test("the merge-state-plus-date shape does not fire on a hyphenated compound like \"false-merged\" (a real MASTER-PLAN.md phrase describing a MIS-attribution)", () => {
  assert.equal(isAnchored("the false-merged W1-T54b attribution (#80 -> #91) on 2026-08-01", ANCHOR_SHAPES), false);
});

test("the merge-state-plus-date shape DOES fire on a genuine 'merged ... date' pairing", () => {
  assert.equal(isAnchored("PR #2029 merged on 2026-08-17 and both filed tasks shipped"), true);
});

test("ANCHOR_WINDOW keeps #3305's real MASTER-PLAN.md followup-log citation ANCHORLESS -- a 'RATIFIED 2026-08-31' trailer 296 characters away, and an unrelated 13-digit followup-id epoch 139 characters away, must NOT anchor a citation whose own text says 'no sha, no merge state and no date'", () => {
  const text =
    "- followup:W1-T2481-1788113218856:2026-08-30T18:09:47.335Z:1 (W1-T2481's rationale cites its " +
    '"13 failing" measurement to PR #3305 — a mutable pointer with no sha, no merge state and no ' +
    "date, so the number can be neither re-derived nor falsified; the figure is load-bearing on no " +
    "shipped criterion, and the departure is from an anchoring convention the plan already keeps in " +
    "54 sha-anchored citations across 51 files) — RATIFIED 2026-08-31 -> NEW-1/NEW-2.";
  const [citation] = findCitations(text);
  assert.equal(citation.prNumber, "3305");
  assert.equal(isAnchored(citation.window), false);
  assert.ok(ANCHOR_WINDOW <= 150, "widening the window past ~150 chars reintroduces this false positive");
});

// ── criterion 4: the anchor forms are a DATA table -- a new row reclassifies with ZERO engine change ──

test("adding one ANCHOR_SHAPES row reclassifies a seeded citation from anchorless to anchored -- isAnchored ITSELF is never touched", () => {
  const window = "the payload for #900 carries no immutable marker, only IMMUTABLE-MARKER-XYZ nearby";
  assert.equal(isAnchored(window), false, "seeded citation must start anchorless under the shipped table");

  const withNewRow = [...ANCHOR_SHAPES, { tag: "test-marker", pattern: /IMMUTABLE-MARKER-XYZ/, reason: "regression fixture row" }];
  assert.equal(isAnchored(window, withNewRow), true, "the SAME isAnchored, one extra data row, reclassifies it");
});

test("the same DATA-row extension reclassifies a full citation end to end through census(), not just isAnchored()", () => {
  const units = [{ id: "W1-T-seed", text: "The payload for #900 carries IMMUTABLE-MARKER-XYZ, a shape no shipped row recognises." }];
  const before = census(units);
  assert.equal(before.anchorlessCount, 1);

  const withNewRow = [...ANCHOR_SHAPES, { tag: "test-marker", pattern: /IMMUTABLE-MARKER-XYZ/, reason: "regression fixture row" }];
  const after = census(units, withNewRow);
  assert.equal(after.anchorlessCount, 0);
  assert.equal(after.anchoredCount, 1);
});

// ── criterion 3: the census REPORTS and never gates, at the process level ───────────────────────

test("CLI: a corpus carrying an anchorless citation still exits 0 -- reports, never gates", () => {
  const masterPlan = "# fixture monolith\nNo PR citations here.\n";
  const shard = [
    "- id: W1-T9001",
    '  title: "fixture"',
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  principles: {tdd: strict}",
    "  budget_usd: 1.00",
    "  risk: low",
    '  files: ["a.ts"]',
    "  status: queued",
    "  attempts: 0",
    "  rationale: |",
    "    Measured on #12345: no sha, no merge state and no date anywhere nearby in this prose.",
  ].join("\n");
  const dir = buildFixtureCorpus(masterPlan, shard);
  try {
    const result = runCli(["--cwd", dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PRECISION \(declared before the count is trusted\)/);
    assert.match(result.stdout, /CITATIONS: 1 total, 0 anchored, 1 anchorless/);
    assert.match(result.stdout, /W1-T9001 #12345:/);
    assert.match(result.stdout, /REPORT, not a gate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a corpus with every citation anchored ALSO exits 0 (the exit code never depends on the split)", () => {
  const masterPlan = "# fixture monolith\nNo PR citations here.\n";
  const shard = [
    "- id: W1-T9002",
    '  title: "fixture"',
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  principles: {tdd: strict}",
    "  budget_usd: 1.00",
    "  risk: low",
    '  files: ["a.ts"]',
    "  status: queued",
    "  attempts: 0",
    "  rationale: |",
    "    Observed on #591 at 1f990d2, re-derived rather than assumed.",
  ].join("\n");
  const dir = buildFixtureCorpus(masterPlan, shard);
  try {
    const result = runCli(["--cwd", dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /CITATIONS: 1 total, 1 anchored, 0 anchorless/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a missing MASTER-PLAN.md is an operational failure to SCAN (loadCorpus's own catch), not a clean pass", () => {
  const dir = makeTempDir("citation-anchor-census-no-monolith");
  try {
    // No MASTER-PLAN.md written at all -- loadCorpus's readFileSync throws ENOENT, which the
    // catch block in main() turns into a distinct "could not read the corpus" message and a
    // non-zero exit, never the "ZERO shards" message (that is a DIFFERENT, later branch).
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    const result = runCli(["--cwd", dir]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /could not read the corpus/);
    assert.doesNotMatch(result.stdout + result.stderr, /scanned ZERO plan\/tasks\.d\/ shards/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a bad --plan-tasks-dir (readdirSync throws) is ALSO the loadCorpus catch's operational failure, not a crash", () => {
  const dir = makeTempDir("citation-anchor-census-bad-shard-dir");
  try {
    writeFileSync(join(dir, "MASTER-PLAN.md"), "# fixture monolith\nNo PR citations here.\n");
    // plan/tasks.d/ is never created -- readdirSync on the missing dir throws ENOENT, exercising
    // the SAME catch as the missing-monolith case above via a different underlying fs call.
    const result = runCli(["--cwd", dir]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /could not read the corpus/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: scanning ZERO plan/tasks.d/ shards is an operational failure (refuses a vacuous report), not a clean pass", () => {
  const dir = makeTempDir("citation-anchor-census-empty");
  try {
    writeFileSync(join(dir, "MASTER-PLAN.md"), "# empty fixture\n");
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    const result = runCli(["--cwd", dir]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /scanned ZERO plan\/tasks\.d\/ shards/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── real corpus smoke test: the actual scan this task exists to run ─────────────────────────────

test("loadCorpus reads the REAL repo's monolith and every plan/tasks.d/ shard without throwing", () => {
  const { units, shardCount } = loadCorpus({ cwd: REPO_ROOT });
  assert.ok(shardCount > 900, `expected >900 plan/tasks.d shards, got ${shardCount}`);
  assert.ok(units.some((u: { id: string }) => u.id === "MASTER-PLAN.md"), "MASTER-PLAN.md unit missing");
  assert.ok(units.length > shardCount, "expects at least one prose unit per shard plus the monolith");
});

test("CLI against the REAL repo root exits 0 and declares its precision (3/3 on today's ANCHOR_SHAPES)", () => {
  const result = runCli(["--cwd", REPO_ROOT]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PRECISION \(declared before the count is trusted\): 3\/3/);
  assert.match(result.stdout, /CITATIONS: \d+ total, \d+ anchored, \d+ anchorless/);
});
