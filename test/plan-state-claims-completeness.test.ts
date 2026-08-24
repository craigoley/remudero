import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { loadPlan } from "../src/lib/plan.js";

// ── W1-T2223: plan-state-claims reports EVERY not-shipped site per id, not only the first ─────────
//
// `firstNotShippedLine` (test/plan-state-claims.test.ts's suite covers scripts/plan-state-claims.mjs
// end-to-end via its CLI surface) RETURNED ON THE FIRST LINE matching both the not-shipped phrase
// vocabulary and the id, so a contradiction record carried exactly one `notShippedLineNumber` --  a
// second, independent not-shipped citation for the same id contributed nothing to the report and
// cost a full CI cycle to discover (rationale (1)/(3)). Design (i) fixes this at the RECORD, not the
// name: `firstNotShippedLine` keeps its honest name and behaviour (still returns only the first --
// see the last test below), and a new `notShippedLines` export is the contradiction record's actual
// citation source, carrying every site.
//
// Design (ii): when the shipped and not-shipped sides resolve to the SAME physical line (a line
// reading "SHIPPED ... though previously unbuilt" satisfies both independently-run lookups), the
// report must say so explicitly -- one combined "SHIPPED AND NOT-SHIPPED on the SAME LINE" entry --
// rather than naming the same line number twice under two different labels and leaving the reader to
// notice, which is exactly what made the #2718 account read as a single-site problem.
//
// Design (iii): reporting more sites per id must never change WHICH ids contradict or the gate's
// exit-code decision -- only the detail printed under an already-contradicting id grows.
//
// This suite drives the real exported functions directly (checkPlanStateConsistency, renderReport,
// notShippedLines, firstNotShippedLine) against throwaway corpora built for the purpose -- never the
// live MASTER-PLAN.md -- mirroring test/plan-state-claims.test.ts's own throwaway-fixture discipline
// so this suite never goes red just because the plan was edited. It imports the plain .mjs module
// directly (not spawnSync) because these are genuinely UNIT-level claims about the exported
// functions' return shapes, distinct from the sibling suite's CLI-surface end-to-end coverage.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT_URL = pathToFileURL(join(REPO_ROOT, "scripts", "plan-state-claims.mjs")).href;
const FIXTURES = join(__dirname, "fixtures", "plan-state-claims");

type Mod = {
  checkPlanStateConsistency: (masterPlanMd: string, knownIds: string[]) => {
    shippedExamined: number;
    notShippedExamined: number;
    notShippedLinesExamined: number;
    contradictions: Array<{
      id: string;
      shippedLineNumber: number;
      shippedLineText: string;
      notShippedRefs: Array<{ lineNumber: number | undefined; lineText: string }>;
    }>;
  };
  renderReport: (result: ReturnType<Mod["checkPlanStateConsistency"]>) => string;
  notShippedLines: (masterPlanMd: string, id: string) => Array<{ lineNumber: number; lineText: string }>;
  firstNotShippedLine: (masterPlanMd: string, id: string) => { lineNumber: number; lineText: string } | undefined;
};

async function loadMod(): Promise<Mod> {
  return (await import(SCRIPT_URL)) as Mod;
}

test("plan-state-claims completeness: every not-shipped citation site for a contradicting id is named, not only the first", async () => {
  const { checkPlanStateConsistency, renderReport } = await loadMod();
  const masterPlanMd = [
    "## SHIPPED log",
    "",
    "- Governor pair (W1-T71/#100) -> $1.000",
    "",
    "## Other section",
    "",
    "First correction: W1-T71 is not shipped after all.",
    "",
    "Second, independent correction: W1-T71 remains unbuilt as of this writing.",
  ].join("\n");

  const result = checkPlanStateConsistency(masterPlanMd, ["W1-T71"]);
  assert.equal(result.contradictions.length, 1);
  const [c] = result.contradictions;
  assert.equal(c.id, "W1-T71");
  // Both independent not-shipped sites survive on the record -- not only the first (line 7).
  assert.deepEqual(
    c.notShippedRefs.map((r) => r.lineNumber),
    [7, 9],
  );

  const report = renderReport(result);
  assert.match(report, /\[W1-T71\] NOT-SHIPPED at MASTER-PLAN\.md:7: ".*is not shipped after all.*"/);
  assert.match(report, /\[W1-T71\] NOT-SHIPPED at MASTER-PLAN\.md:9: ".*remains unbuilt.*"/);
});

test("plan-state-claims completeness: a shipped and a not-shipped trigger sharing one line is reported as one line, not two findings", async () => {
  const { checkPlanStateConsistency, renderReport, notShippedLines } = await loadMod();
  const masterPlanMd = [
    "## SHIPPED log",
    "",
    "- Governor pair (W1-T71/#100) landed though previously unbuilt.",
    "",
    "## Other section",
  ].join("\n");

  // Control: the not-shipped re-scan itself finds exactly the shipped line, proving the collapse
  // below is rendering behaviour, not an artefact of a lookup that only ever saw one line.
  assert.deepEqual(
    notShippedLines(masterPlanMd, "W1-T71").map((r) => r.lineNumber),
    [3],
  );

  const result = checkPlanStateConsistency(masterPlanMd, ["W1-T71"]);
  assert.equal(result.contradictions.length, 1);
  assert.equal(result.contradictions[0].shippedLineNumber, 3);
  assert.deepEqual(
    result.contradictions[0].notShippedRefs.map((r) => r.lineNumber),
    [3],
  );

  const report = renderReport(result);
  assert.match(report, /\[W1-T71\] SHIPPED AND NOT-SHIPPED on the SAME LINE at MASTER-PLAN\.md:3: ".*"/);
  // The line-3 citation appears exactly once in the contradiction block, never twice under two
  // separate SHIPPED / NOT-SHIPPED labels.
  const occurrences = report.split("MASTER-PLAN.md:3").length - 1;
  assert.equal(occurrences, 1);
  assert.doesNotMatch(report, /\[W1-T71\] NOT-SHIPPED at MASTER-PLAN\.md:3:/);
  assert.doesNotMatch(report, /\[W1-T71\] SHIPPED at MASTER-PLAN\.md:3:/);
});

test("plan-state-claims completeness: the set of contradicting ids and the gate's exit-code decision are unchanged by the richer per-site report", async () => {
  const { checkPlanStateConsistency } = await loadMod();
  const knownIds = ["W1-T71", "W1-T80"];
  const shippedBlock = [
    "## SHIPPED log",
    "",
    "- Governor pair (W1-T71/#100) -> $1.000",
    "- Unrelated clean id (W1-T80/#200) -> $2.000",
    "",
    "## Other section",
    "",
  ];

  const oneSiteMd = [...shippedBlock, "W1-T71 is not shipped after all."].join("\n");
  const twoSiteMd = [
    ...shippedBlock,
    "W1-T71 is not shipped after all.",
    "",
    "Separately, W1-T71 remains unbuilt.",
  ].join("\n");

  const oneSite = checkPlanStateConsistency(oneSiteMd, knownIds);
  const twoSite = checkPlanStateConsistency(twoSiteMd, knownIds);

  // Same contradicting id set both times (W1-T80 never asserted not-shipped, so it never
  // contradicts) -- adding a second citation SITE must not add a second contradiction RECORD.
  assert.deepEqual(
    oneSite.contradictions.map((c) => c.id),
    ["W1-T71"],
  );
  assert.deepEqual(
    twoSite.contradictions.map((c) => c.id),
    ["W1-T71"],
  );
  assert.equal(oneSite.contradictions.length, twoSite.contradictions.length);
  // The gate's would-be exit-code decision (scripts/plan-state-claims.mjs's main(): non-zero iff
  // contradictions.length > 0) is identical in both.
  assert.equal(oneSite.contradictions.length > 0, twoSite.contradictions.length > 0);
  assert.equal(oneSite.shippedExamined, twoSite.shippedExamined);

  // Richness lives only in the per-id detail: two sites recorded where there was one.
  assert.equal(oneSite.contradictions[0].notShippedRefs.length, 1);
  assert.equal(twoSite.contradictions[0].notShippedRefs.length, 2);
});

test("plan-state-claims completeness: the report still names the claim, the section, the id, the file and the line for every site", async () => {
  const { checkPlanStateConsistency, renderReport } = await loadMod();
  const masterPlanMd = [
    "## SHIPPED log",
    "",
    "- Governor pair (W1-T71/#100) -> $1.000",
    "",
    "## Other section",
    "",
    "First correction: W1-T71 is not shipped after all.",
    "",
    "Second, independent correction: W1-T71 remains unbuilt as of this writing.",
  ].join("\n");

  const report = renderReport(checkPlanStateConsistency(masterPlanMd, ["W1-T71"]));
  // The id, the file, the line, and the quoted source text (which carries the section's prose) are
  // all present for the SHIPPED claim and for BOTH not-shipped claims -- nothing about the existing
  // per-site detail is dropped by carrying more than one site.
  assert.match(report, /\[W1-T71\] SHIPPED at MASTER-PLAN\.md:3: ".*Governor pair \(W1-T71\/#100\).*"/);
  assert.match(report, /\[W1-T71\] NOT-SHIPPED at MASTER-PLAN\.md:7: ".*W1-T71 is not shipped after all.*"/);
  assert.match(
    report,
    /\[W1-T71\] NOT-SHIPPED at MASTER-PLAN\.md:9: ".*W1-T71 remains unbuilt as of this writing.*"/,
  );
});

test("plan-state-claims completeness: an id with exactly one citation site reports exactly as it does today", async () => {
  const { checkPlanStateConsistency, renderReport } = await loadMod();
  // Reuse the sibling suite's own golden fixture (test/plan-state-claims.test.ts's contradiction.md)
  // rather than a fresh corpus, so "reports exactly as it does today" is checked against the exact
  // scenario that suite already pins end-to-end via the CLI, not a hand-picked lookalike.
  const masterPlanMd = readFileSync(join(FIXTURES, "contradiction.md"), "utf8");
  const knownIds = loadPlan(join(FIXTURES, "tasks.yaml")).tasks.map((t) => t.id);

  const result = checkPlanStateConsistency(masterPlanMd, knownIds);
  const [c] = result.contradictions.filter((x) => x.id === "W1-T149");
  assert.ok(c, "W1-T149 must still contradict");
  // Exactly one not-shipped site, unchanged from before this fix.
  assert.equal(c.notShippedRefs.length, 1);

  const report = renderReport(result);
  // Byte-identical to the format the pre-existing CLI suite already pins for this fixture: a plain
  // SHIPPED line and a plain NOT-SHIPPED line, never the "SAME LINE" collapsed wording (the two
  // sides are on different lines here) and never more than one NOT-SHIPPED line for this id.
  assert.match(report, /\[W1-T149\] SHIPPED at MASTER-PLAN\.md:\d+: ".*W1-T149\/#349.*"/);
  assert.match(report, /\[W1-T149\] NOT-SHIPPED at MASTER-PLAN\.md:\d+: ".*W1-T149 did not ship.*"/);
  assert.doesNotMatch(report, /SHIPPED AND NOT-SHIPPED on the SAME LINE/);
  const notShippedLineCount = (report.match(/\[W1-T149\] NOT-SHIPPED/g) ?? []).length;
  assert.equal(notShippedLineCount, 1);
});

test("plan-state-claims completeness: firstNotShippedLine keeps returning only the first site (its name's own promise), while notShippedLines carries every site", async () => {
  const { firstNotShippedLine, notShippedLines } = await loadMod();
  const masterPlanMd = [
    "## SHIPPED log",
    "",
    "- Governor pair (W1-T71/#100) -> $1.000",
    "",
    "## Other section",
    "",
    "First correction: W1-T71 is not shipped after all.",
    "",
    "Second, independent correction: W1-T71 remains unbuilt as of this writing.",
  ].join("\n");

  const first = firstNotShippedLine(masterPlanMd, "W1-T71");
  assert.equal(first?.lineNumber, 7);
  const all = notShippedLines(masterPlanMd, "W1-T71");
  assert.deepEqual(all.map((r) => r.lineNumber), [7, 9]);
  assert.deepEqual(first, all[0]);

  // No citation anywhere -- both still report cleanly empty (control, matching the pre-existing
  // firstNotShippedLine test in the sibling suite).
  const noCitation = [
    "## SHIPPED log",
    "",
    "- W1-T1/#1 landed.",
    "",
    "## Other",
    "",
    "Nothing here mentions the not-shipped vocabulary at all.",
  ].join("\n");
  assert.equal(firstNotShippedLine(noCitation, "W1-T1"), undefined);
  assert.deepEqual(notShippedLines(noCitation, "W1-T1"), []);
});
