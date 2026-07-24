import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildGather,
  gatherRuns,
  loadMastMapping,
  mastCategoryDistribution,
  mastDistributionTable,
  mastRowFor,
  MastMappingError,
  parseLedger,
  parseMastMapping,
  type MastMapping,
} from "../src/lib/retro.js";

// The REAL, committed table (plan/mast-mapping.yaml) — every test below that asserts an
// exact category distribution reads THIS, not a hand-copied stand-in, so a future edit to
// the file itself is exercised by these tests rather than silently drifting from them.
const REAL_MAPPING: MastMapping = loadMastMapping(join(process.cwd(), "plan", "mast-mapping.yaml"));

// A seeded ledger fixture covering every mapped verdict class ONCE, plus a `merged` run
// (out of scope — success, never counted) and two DELIBERATELY unmapped classes
// (`blocked_transient`, bare `blocked`) that plan/mast-mapping.yaml documents as left out
// on purpose. Mirrors run-task.ts's real ledger line shapes (test/retro.test.ts's own LEDGER
// fixture style).
function line(runId: string, taskId: string, verdict: string, extra: Record<string, unknown> = {}): string[] {
  return [
    `{"ts":"2026-02-01T00:00:00.000Z","run_id":"${runId}","task_id":"${taskId}","step":"run.start","type":"implement"}`,
    `{"ts":"2026-02-01T00:01:00.000Z","run_id":"${runId}","task_id":"${taskId}","step":"verdict","verdict":"${verdict}","cost_usd":1${
      Object.keys(extra).length ? "," + Object.entries(extra).map(([k, v]) => `"${k}":${JSON.stringify(v)}`).join(",") : ""
    }}`,
  ];
}

const SEEDED_LEDGER = [
  ...line("A", "TA", "blocked_illformed"),
  ...line("B", "TB", "blocked_budget"),
  ...line("C", "TC", "failed", { subtype: "error_max_turns" }),
  ...line("D", "TD", "blocked_review"),
  ...line("E", "TE", "blocked_ci"),
  ...line("F", "TF", "no_pr"),
  ...line("G", "TG", "pr_attribution_failed"),
  ...line("H", "TH", "blocked_inflight"),
  ...line("I", "TI", "blocked_containment"),
  ...line("J", "TJ", "blocked_isolation"),
  ...line("K", "TK", "merged"),
  ...line("L", "TL", "blocked_transient"),
  ...line("M", "TM", "blocked"),
].join("\n");

const EXPECTED_CATEGORY_DISTRIBUTION = {
  "inter-agent": 1,
  specification: 3,
  verification: 6,
};

const EXPECTED_UNMAPPED = {
  blocked: 1,
  blocked_transient: 1,
};

test("W1-T89 ACCEPTANCE: a seeded ledger fixture of known verdicts produces the expected category distribution", () => {
  const runs = gatherRuns(parseLedger(SEEDED_LEDGER));
  const dist = mastCategoryDistribution(runs, REAL_MAPPING);
  assert.deepEqual(dist.byCategory, EXPECTED_CATEGORY_DISTRIBUTION);
  // `merged` (run K) is a success — it must never appear anywhere in the distribution,
  // not even as a zero-count category, and never inside `unmapped` either.
  assert.equal("success" in dist.byCategory, false);
  assert.equal("merged" in dist.unmapped, false);
});

test("W1-T89 ACCEPTANCE: unmapped classes surface as unmapped, named, never silently dropped or guessed", () => {
  const runs = gatherRuns(parseLedger(SEEDED_LEDGER));
  const dist = mastCategoryDistribution(runs, REAL_MAPPING);
  assert.deepEqual(dist.unmapped, EXPECTED_UNMAPPED);
  // A genuinely novel verdict class (one that will never exist in RunResult's own union)
  // must ALSO surface named under unmapped, never thrown away or coded as a guess.
  const novel = gatherRuns(parseLedger(line("Z", "TZ", "blocked_solar_flare").join("\n")));
  const novelDist = mastCategoryDistribution(novel, REAL_MAPPING);
  assert.deepEqual(novelDist.unmapped, { blocked_solar_flare: 1 });
  assert.deepEqual(novelDist.byCategory, {});
  // The rendered table names the class too, not just the returned data structure.
  const rendered = mastDistributionTable(novelDist);
  assert.match(rendered, /blocked_solar_flare: 1/);
});

test("W1-T89 ACCEPTANCE: the mapping is DATA — adding a row to a temp mapping codes a previously-unmapped verdict with ZERO code changes", () => {
  const runs = gatherRuns(parseLedger(line("Z", "TZ", "blocked_git_fetch").join("\n")));
  // Before: blocked_git_fetch has no row in the shipped table (documented as intentionally
  // left out) — it reports unmapped.
  const before = mastCategoryDistribution(runs, REAL_MAPPING);
  assert.deepEqual(before.unmapped, { blocked_git_fetch: 1 });
  assert.deepEqual(before.byCategory, {});

  // A hand-authored temp mapping — same parser, same distribution function, ONE new row —
  // flips the outcome. No branch of mastRowFor/mastCategoryDistribution changed.
  const tempMapping = parseMastMapping(`
rows:
  - verdict: blocked_git_fetch
    mast_mode: "FM-2.4 Information Withholding"
    category: inter-agent
`);
  const after = mastCategoryDistribution(runs, tempMapping);
  assert.deepEqual(after.byCategory, { "inter-agent": 1 });
  assert.deepEqual(after.unmapped, {});
});

test("mastRowFor: an exact (verdict, subtype) row wins over that verdict's bare-verdict sibling", () => {
  const mapping = parseMastMapping(`
rows:
  - verdict: failed
    mast_mode: "bare failed"
    category: unmapped-bucket
  - verdict: failed
    subtype: error_max_turns
    mast_mode: "qualified failed"
    category: specification
`);
  const qualified = mastRowFor(mapping, { verdict: "failed", subtype: "error_max_turns" });
  assert.equal(qualified?.mastMode, "qualified failed");
  const bare = mastRowFor(mapping, { verdict: "failed", subtype: "error_output_length" });
  assert.equal(bare?.mastMode, "bare failed");
  const noMatch = mastRowFor(mapping, { verdict: "no_such_verdict" });
  assert.equal(noMatch, undefined);
});

test("parseMastMapping: fails LOUDLY on a structurally invalid file, never silently drops a bad row", () => {
  assert.throws(() => parseMastMapping("not_rows: true"), MastMappingError);
  assert.throws(() => parseMastMapping("rows:\n  - mast_mode: x\n    category: y\n"), /verdict/);
  assert.throws(() => parseMastMapping("rows:\n  - verdict: x\n    category: y\n"), /mast_mode/);
  assert.throws(() => parseMastMapping("rows:\n  - verdict: x\n    mast_mode: y\n"), /category/);
  assert.throws(() => parseMastMapping("rows:\n  - verdict: x\n    mast_mode: y\n    category: z\n    provisional: yes\n"), /provisional/);
});

test("plan/mast-mapping.yaml (the real committed file) parses cleanly and every row is well-formed", () => {
  assert.ok(REAL_MAPPING.rows.length > 0, "the committed table must not be empty");
  for (const row of REAL_MAPPING.rows) {
    assert.equal(typeof row.verdict, "string");
    assert.equal(typeof row.mastMode, "string");
    assert.equal(typeof row.category, "string");
  }
  // No duplicate (verdict, subtype) row — a duplicate would make matching order-dependent
  // (silently non-deterministic which row "wins") rather than a genuine data conflict.
  const seen = new Set<string>();
  for (const row of REAL_MAPPING.rows) {
    const key = `${row.verdict}:::${row.subtype ?? ""}`;
    assert.equal(seen.has(key), false, `duplicate row for ${key}`);
    seen.add(key);
  }
});

test("mastDistributionTable: renders a trend column against a prior cycle's counts, and '(none)' when nothing is unmapped", () => {
  const dist = { byCategory: { specification: 2, verification: 1 }, unmapped: {} };
  const rendered = mastDistributionTable(dist, { specification: 1, verification: 1, "inter-agent": 3 });
  assert.match(rendered, /\| specification \| 2 \| \+1 \|/);
  assert.match(rendered, /\| verification \| 1 \| ±0 \|/);
  assert.match(rendered, /\| inter-agent \| 0 \| -3 \|/);
  assert.match(rendered, /Unmapped verdict classes: \(none\)/);
});

test("buildGather wires mastMapping + priorMastCategoryCounts into RetroGather.mast", () => {
  const g = buildGather({
    ledgerNdjson: SEEDED_LEDGER,
    learningsMd: "# L\n",
    mastMapping: REAL_MAPPING,
    priorMastCategoryCounts: { specification: 1 },
  });
  assert.deepEqual(g.mast.byCategory, EXPECTED_CATEGORY_DISTRIBUTION);
  assert.deepEqual(g.mast.unmapped, EXPECTED_UNMAPPED);
  assert.deepEqual(g.priorMastCategoryCounts, { specification: 1 });
});

test("buildGather with NO mastMapping (an omitted caller) degrades to an empty table — every failure reports unmapped, never a crash", () => {
  const g = buildGather({ ledgerNdjson: SEEDED_LEDGER, learningsMd: "# L\n" });
  assert.deepEqual(g.mast.byCategory, {});
  assert.equal(g.mast.unmapped.blocked_illformed, 1);
  assert.equal(g.priorMastCategoryCounts, undefined);
});

test("loadMastMapping surfaces a real read error for a missing file (fail loud, not undefined)", () => {
  assert.throws(() => loadMastMapping(join(process.cwd(), "plan", "no-such-mast-mapping.yaml")));
});

test("readFileSync sanity: plan/mast-mapping.yaml is valid UTF-8 text on disk", () => {
  const text = readFileSync(join(process.cwd(), "plan", "mast-mapping.yaml"), "utf8");
  assert.ok(text.includes("rows:"));
});
