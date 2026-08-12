import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  aggregateCitationEvidence,
  mineGitLogCitations,
  mineLedgerCitations,
  stampCitations,
  type CitationEvidence,
  type LedgerRecord,
} from "../src/lib/retro.js";
import type { LearningEntry } from "../src/lib/learnings.js";

// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/learnings-budget-ratchet.mjs"` is a TS7016 — the same reason
// test/clock-sweep.test.ts reaches its script through a runtime import rather than a typed one.
// A dynamic specifier is not statically resolved, so this loads the REAL module with no shadow
// copy to drift from it.
const RATCHET_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "learnings-budget-ratchet.mjs"),
).href;
const { compressionCandidates, leastEvidencedFirst, renderCandidateLine } = (await import(RATCHET_URL)) as {
  compressionCandidates: (entries: unknown[], count?: number) => string[];
  leastEvidencedFirst: (entries: unknown[]) => Array<{ id: string }>;
  renderCandidateLine: (entry: unknown) => string;
};

// ── W1-T419: the learnings corpus has votes with no voters ─────────────────────────────────────
//
// selectLearnings (learnings.ts) already tiebreaks on `cited` after file-relevance/layer, but the
// signal feeding it was dead: hand-stamped dates, no ids logged at injection, and a mute ratchet
// message on overage. This file exercises the three mined pieces this task adds:
//   (1) mineLedgerCitations + aggregateCitationEvidence + stampCitations (retro.ts) -- the
//       ledger-side half of the miner, including old-format-row tolerance (design iv).
//   (2) mineGitLogCitations (retro.ts) -- the git-log-side half.
//   (3) the ratchet's compressionCandidates naming the least-evidenced entries, never omitting a
//       no-evidence entry (rendered `never-cited`), over the real CLI subprocess.

function entry(id: string, overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id,
    subsystem: "test",
    lifecycle: "active",
    files: ["x"],
    fact: `fact for ${id}`,
    src: "test",
    ...overrides,
  };
}

// ── (1) mineLedgerCitations: three injections of A -> count 3; B absent ────────────────────────

test("mineLedgerCitations: 3 `learnings.injected` rows carrying A in matched_ids stamp A's count 3 and leave B absent", () => {
  const records: LedgerRecord[] = [
    { ts: "2026-07-01T00:00:00.000Z", step: "learnings.injected", matched: 1, matched_ids: ["A"] },
    { ts: "2026-07-05T00:00:00.000Z", step: "learnings.injected", matched: 1, matched_ids: ["A"] },
    { ts: "2026-07-10T00:00:00.000Z", step: "learnings.injected", matched: 1, matched_ids: ["A"] },
  ];
  const evidence = mineLedgerCitations(records);
  assert.equal(evidence.filter((e) => e.id === "A").length, 3);
  assert.equal(evidence.filter((e) => e.id === "B").length, 0);

  const stamps = aggregateCitationEvidence(evidence);
  assert.deepEqual(stamps.get("A"), { citedCount: 3, cited: "2026-07-10T00:00:00.000Z" });
  assert.equal(stamps.has("B"), false);

  const entries = [entry("A"), entry("B")];
  const stamped = stampCitations(entries, stamps);
  const stampedA = stamped.find((e) => e.id === "A")!;
  const stampedB = stamped.find((e) => e.id === "B")!;
  assert.equal(stampedA.citedCount, 3);
  assert.equal(stampedA.cited, "2026-07-10T00:00:00.000Z");
  // B never appeared in matched_ids anywhere -- absent evidence must leave it untouched, not
  // stamped to zero.
  assert.equal(stampedB.citedCount, undefined);
  assert.equal(stampedB.cited, undefined);
});

// ── (1b) old-format (pre-task) rows contribute nothing, never crash ────────────────────────────

test("mineLedgerCitations: a pre-task row carrying only `matched` (no matched_ids) contributes nothing and does not throw", () => {
  const records: LedgerRecord[] = [
    // The shape every row before this task shipped: a bare count, no id list at all.
    { ts: "2026-06-01T00:00:00.000Z", step: "learnings.injected", matched: 4 },
    // A malformed matched_ids (not an array) must be tolerated the same way.
    { ts: "2026-06-02T00:00:00.000Z", step: "learnings.injected", matched: 2, matched_ids: "not-an-array" },
    // A row for an unrelated step must never be mistaken for injection evidence.
    { ts: "2026-06-03T00:00:00.000Z", step: "verdict", matched_ids: ["C"] },
  ];
  assert.doesNotThrow(() => mineLedgerCitations(records));
  const evidence = mineLedgerCitations(records);
  assert.deepEqual(evidence, []);

  // Stamping a corpus over zero evidence must leave every active entry exactly as it was.
  const entries = [entry("A", { cited: "2026-01-01", citedCount: 5 }), entry("B")];
  const stamped = stampCitations(entries, aggregateCitationEvidence(evidence));
  assert.deepEqual(stamped, entries);
});

// ── (2) mineGitLogCitations: dedupes within a commit, unions across commits ─────────────────────

test("mineGitLogCitations: `learnings#<id>` mentions in commit subject+body count once per commit, unioned across commits", () => {
  const evidence = mineGitLogCitations([
    { date: "2026-08-01", message: "fix(x): follow learnings#A\n\nAlso cites learnings#A again and learnings#B." },
    { date: "2026-08-05", message: "feat(y): apply learnings#A" },
  ]);
  const stamps = aggregateCitationEvidence(evidence);
  // Commit 1 cites A twice but counts once -- only commit 2's mention pushes A to 2.
  assert.deepEqual(stamps.get("A"), { citedCount: 2, cited: "2026-08-05" });
  assert.deepEqual(stamps.get("B"), { citedCount: 1, cited: "2026-08-01" });
});

// ── Ledger + git-log evidence union onto one stamp ──────────────────────────────────────────────

test("aggregateCitationEvidence: ledger and git-log evidence for the same id combine into one stamp", () => {
  const ledgerEvidence: CitationEvidence[] = mineLedgerCitations([
    { ts: "2026-07-01", step: "learnings.injected", matched_ids: ["A"] },
  ]);
  const gitEvidence = mineGitLogCitations([{ date: "2026-08-01", message: "learnings#A" }]);
  const stamps = aggregateCitationEvidence([...ledgerEvidence, ...gitEvidence]);
  assert.deepEqual(stamps.get("A"), { citedCount: 2, cited: "2026-08-01" });
});

// ── (3) the ratchet names the least-evidenced candidates, `never-cited` explicit ────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "learnings-budget-ratchet.mjs");
const FIXTURES = join(__dirname, "fixtures", "learnings-citation-loop");

test("compressionCandidates: entry A (cited_count 9) vs never-cited entry B -- B is named, not A, at count 1", () => {
  const a = entry("A", { cited: "2026-07-01", citedCount: 9 });
  const b = entry("B"); // no cited/citedCount at all -- never-cited
  const candidates = compressionCandidates([a, b], 1);
  assert.deepEqual(candidates, ["B: never-cited"]);
  assert.equal(leastEvidencedFirst([a, b])[0].id, "B");
  assert.equal(renderCandidateLine(b), "B: never-cited");
  assert.equal(renderCandidateLine(a), "A: cited 9x, last 2026-07-01");
});

test("learnings-budget-ratchet CLI: over-cap corpus names the never-cited entry as a compression candidate, never omits it", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--dir", join(FIXTURES, "corpus"), "--baseline", join(FIXTURES, "over-baseline.json")],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /BLOCKED/);
  assert.match(result.stderr, /Least-evidenced active entries/);
  assert.match(result.stderr, /beta-never-cited: never-cited/);
  assert.match(result.stderr, /alpha-cited: cited 9x, last 2026-07-01/);
  // The never-cited entry sorts before the evidenced one in the candidate list.
  const neverCitedLine = result.stderr.indexOf("beta-never-cited");
  const citedLine = result.stderr.indexOf("alpha-cited: cited");
  assert.ok(neverCitedLine > 0 && citedLine > 0 && neverCitedLine < citedLine, result.stderr);
});
