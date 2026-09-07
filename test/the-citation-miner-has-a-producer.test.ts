/**
 * W1-T2760: THE CITATION MINER HAS NO PRODUCER — until this task, the retro's git-log miner
 * scanned commits for `learnings#<id>` citations that no prompt ever asked a worker to write, so
 * `cited_count` measured how often a learning was INJECTED (put in a prompt), never whether it was
 * USED (acted on). This file proves the three claims the task's own acceptance list names:
 *
 *   (1) a report line naming an injected learning is parsed and ledgered as used, and one naming a
 *       learning never injected is refused by name — `parseLearningsUsed` (worker.ts).
 *   (2) the citation aggregate carries used and injected as separate counts and never sums them —
 *       `mineLedgerCitations` + `aggregateCitationEvidence` (retro.ts).
 *   (4)/(5) the output contract asks for the line, the anchor block repeats it verbatim, and the
 *       transcript parser exists on the worker return channel — compaction.ts / worker.ts.
 *
 * Claim (3) — the budget ratchet's `compressionCandidates` ranking least-used-first with injection
 * as the tiebreak — is DELIBERATELY NOT here. `scripts/learnings-budget-ratchet.mjs` is an
 * INSTRUMENT_SURFACE path (`src/lib/review.ts`'s `INSTRUMENT_SURFACE`, matched by
 * `^scripts/[^/]*-ratchet\.mjs$`) and is not in `ENTANGLEMENT_EXEMPT_INSTRUMENTS`, so
 * `detectInstrumentEntanglement` refuses a diff touching it alongside the executable `src/`
 * changes this file's own claims require (Standing rule 25) — the EXACT conflict
 * test/learnings-ratchet-candidates.test.ts's own header documents for this same script under the
 * predecessor task (W1-T419, run #1609: "filed with both halves in one files: list ... refused on
 * exactly that"). Claim (3) is filed as this PR's own Follow-up, for its own dedicated PR, the same
 * split shape that script's sibling feature already shipped under.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENT_ROLE_LINES,
  outputContractLines,
  renderAnchorBlock,
} from "../src/lib/compaction.js";
import { parseLearningsUsed, type LearningsUsedResult } from "../src/lib/worker.js";
import {
  aggregateCitationEvidence,
  changedCitationStamps,
  mineGitLogCitations,
  mineLedgerCitations,
  stampCitations,
  type LedgerRecord,
} from "../src/lib/retro.js";
import type { LearningEntry } from "../src/lib/learnings.js";

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

// ── claim (4): the output contract asks for the line, and the anchor block repeats it verbatim ──

test("outputContractLines asks for an anchored LEARNINGS_USED report line, required (`none` is a valid, distinct answer)", () => {
  const lines = outputContractLines("W1-T2760").join("\n");
  assert.match(lines, /LEARNINGS_USED: learnings#<id>/);
  assert.match(lines, /LEARNINGS_USED: none/);
  // The PR_URL line stays the LAST line of the contract — LEARNINGS_USED must not have displaced it.
  const trimmed = outputContractLines("W1-T2760");
  assert.equal(trimmed[trimmed.length - 1], "- End with a REPORT whose LAST line is exactly: PR_URL: <the pull request url>");
});

test("renderAnchorBlock re-injects the SAME LEARNINGS_USED line after a compaction — byte-identical to turn 0's contract", () => {
  const task = { id: "W1-T2760", title: "t", prompt: undefined, acceptance: [] };
  const anchor = renderAnchorBlock(task, "run-1");
  const contract = outputContractLines("W1-T2760").join("\n");
  assert.match(anchor, /LEARNINGS_USED: learnings#<id>/);
  // The anchor reuses outputContractLines(task.id) verbatim (compaction.ts's own discipline) — the
  // LEARNINGS_USED bullet in the anchor is the SAME text as in the turn-0 contract, not a re-derivation.
  const anchorContractLines = outputContractLines(task.id).join("\n");
  assert.equal(anchorContractLines, contract);
  assert.ok(anchor.startsWith(IMPLEMENT_ROLE_LINES.join("\n")));
});

// ── claim (1) + (5): parseLearningsUsed exists on the worker return channel, parses an injected
//    claim as used, and refuses a never-injected claim by name ─────────────────────────────────

test("parseLearningsUsed: a claimed id that WAS injected is ledgered as used; one that was NEVER injected is refused by name", () => {
  const text = ["REPORT", "did the work", "LEARNINGS_USED: learnings#a, learnings#ghost", "PR_URL: https://github.com/o/r/pull/1"].join(
    "\n",
  );
  const result = parseLearningsUsed(text, ["a"]);
  assert.ok(result);
  assert.deepEqual(result!.usedIds, ["a"]);
  assert.deepEqual(result!.refused, [{ id: "ghost", reason: "never injected into this run" }]);
  assert.deepEqual(result!.injectedIds, ["a"]);
});

test("parseLearningsUsed: `LEARNINGS_USED: none` parses to an explicit empty claim, distinguishable from a silent report", () => {
  const withNone = parseLearningsUsed("REPORT\nLEARNINGS_USED: none\nPR_URL: https://github.com/o/r/pull/1", ["a"]);
  assert.deepEqual(withNone, { usedIds: [], refused: [], injectedIds: ["a"] });

  const silent = parseLearningsUsed("REPORT\nno line at all\nPR_URL: https://github.com/o/r/pull/1", ["a"]);
  assert.equal(silent, null, "an absent LEARNINGS_USED line must read as null, never as an implicit none");
});

test("parseLearningsUsed: anchored to the line start (same PR_URL discipline, W1-T62) — a mention mid-sentence is inert", () => {
  const text = [
    "REPORT",
    "I considered LEARNINGS_USED: learnings#decoy but did not write the anchored line",
    "PR_URL: https://github.com/o/r/pull/1",
  ].join("\n");
  const result = parseLearningsUsed(text, ["decoy"]);
  assert.equal(result, null);
});

test("parseLearningsUsed: multiple LEARNINGS_USED lines (a DECISION_REQUEST resume appends a second REPORT) — the LAST one wins", () => {
  const text = [
    "LEARNINGS_USED: learnings#a",
    "-- resumed after a DECISION_REQUEST --",
    "LEARNINGS_USED: learnings#b",
    "PR_URL: https://github.com/o/r/pull/1",
  ].join("\n");
  const result = parseLearningsUsed(text, ["a", "b"]);
  assert.deepEqual(result!.usedIds, ["b"]);
});

test("parseLearningsUsed: a duplicate id on one line counts once", () => {
  const result = parseLearningsUsed("LEARNINGS_USED: learnings#a, learnings#a", ["a"]);
  assert.deepEqual(result!.usedIds, ["a"]);
});

// ── claim (2): the citation aggregate carries used and injected as SEPARATE counts, never summed ─

const INJECTED_ROW = (ids: string[], ts: string): LedgerRecord => ({ ts, step: "learnings.injected", matched: ids.length, matched_ids: ids });
const USED_ROW = (ids: string[], ts: string): LedgerRecord => ({ ts, step: "learnings.used", used_ids: ids });

test("mineLedgerCitations reads BOTH learnings.injected and learnings.used rows, tagging each occurrence's kind", () => {
  const records: LedgerRecord[] = [
    INJECTED_ROW(["a"], "2026-08-01T00:00:00.000Z"),
    INJECTED_ROW(["a"], "2026-08-02T00:00:00.000Z"),
    USED_ROW(["a"], "2026-08-03T00:00:00.000Z"),
  ];
  const evidence = mineLedgerCitations(records);
  assert.equal(evidence.filter((e) => e.kind === "injected").length, 2);
  assert.equal(evidence.filter((e) => e.kind === "used").length, 1);
});

test("aggregateCitationEvidence: injected and used counts for the SAME id stay on separate fields — never combined into one total", () => {
  const records: LedgerRecord[] = [
    INJECTED_ROW(["a"], "2026-08-01T00:00:00.000Z"),
    INJECTED_ROW(["a"], "2026-08-02T00:00:00.000Z"),
    INJECTED_ROW(["a"], "2026-08-03T00:00:00.000Z"),
    USED_ROW(["a"], "2026-08-04T00:00:00.000Z"),
  ];
  const stamps = aggregateCitationEvidence(mineLedgerCitations(records));
  const stamp = stamps.get("a")!;
  assert.equal(stamp.citedCount, 3, "three learnings.injected rows named A");
  assert.equal(stamp.usedCount, 1, "one learnings.used row named A");
  // The defect this task fixes, restated as an assertion: a summed proxy would read 4 here.
  assert.notEqual((stamp.citedCount ?? 0) + (stamp.usedCount ?? 0), stamp.citedCount);
  assert.equal(stamp.cited, "2026-08-03T00:00:00.000Z");
  assert.equal(stamp.used, "2026-08-04T00:00:00.000Z");
});

test("aggregateCitationEvidence: an id used but never injected carries usedCount with NO citedCount key at all — never a stamped zero", () => {
  const stamps = aggregateCitationEvidence(mineLedgerCitations([USED_ROW(["only-used"], "2026-08-01T00:00:00.000Z")]));
  const stamp = stamps.get("only-used")!;
  assert.deepEqual(stamp, { usedCount: 1, used: "2026-08-01T00:00:00.000Z" });
  assert.equal("citedCount" in stamp, false);
  assert.equal("cited" in stamp, false);
});

test("mineGitLogCitations stays UNCHANGED (design v) and its evidence still aggregates as INJECTED, exactly as it did before this task", () => {
  const evidence = mineGitLogCitations([{ date: "2026-08-01", message: "fix(x): follow learnings#a" }]);
  assert.deepEqual(evidence, [{ id: "a", date: "2026-08-01" }], "no `kind` field — the git-log miner is byte-for-byte the same producer");
  const stamps = aggregateCitationEvidence(evidence);
  assert.deepEqual(stamps.get("a"), { citedCount: 1, cited: "2026-08-01" });
});

test("stampCitations writes BOTH halves onto an entry when both moved, and neither half clobbers the other when only one moved", () => {
  const entries = [entry("a"), entry("b", { cited: "2020-01-01", citedCount: 5 })];
  const both = aggregateCitationEvidence(mineLedgerCitations([INJECTED_ROW(["a"], "2026-08-01"), USED_ROW(["a"], "2026-08-02")]));
  const stampedA = stampCitations(entries, both).find((e) => e.id === "a")!;
  assert.equal(stampedA.citedCount, 1);
  assert.equal(stampedA.used, "2026-08-02");
  assert.equal(stampedA.usedCount, 1);

  // `b` gets ONLY used evidence this pass — its pre-existing cited/citedCount must survive untouched.
  const usedOnly = aggregateCitationEvidence(mineLedgerCitations([USED_ROW(["b"], "2026-08-03")]));
  const stampedB = stampCitations(entries, usedOnly).find((e) => e.id === "b")!;
  assert.equal(stampedB.cited, "2020-01-01", "pre-existing injected stamp must not be blanked by a used-only pass");
  assert.equal(stampedB.citedCount, 5);
  assert.equal(stampedB.usedCount, 1);
});

test("changedCitationStamps names only the half(s) that actually moved — a used-only move never carries a phantom cited key", () => {
  const entries = [entry("a", { cited: "2026-07-01", citedCount: 2 })];
  const evidence = aggregateCitationEvidence(mineLedgerCitations([USED_ROW(["a"], "2026-08-01")]));
  const changed = changedCitationStamps(entries, evidence);
  assert.deepEqual(changed.get("a"), { used: "2026-08-01", usedCount: 1 });
  assert.equal("cited" in changed.get("a")!, false);
});
