import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aggregateLearningsInjection, type LearningsInjectionTotals } from "../src/lib/digest.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";

// ── W1-T940: THE INJECTION DROP LIST IS LEDGER-ONLY ─────────────────────────────────────────
//
// run-task.ts's promptsmith block already logs `matched`/`matched_ids`/`dropped`/`budget_chars`/
// `global_refused_reason` on a `learnings.injected` ledger row every spawn — 13 of 16 matched
// learnings can be dropped per spawn and nothing on `rmd status` says so (status-board.ts had
// ZERO occurrences of "learnings" before this task). This file proves the three acceptance
// criteria:
//   1. the status surface reports matched/dropped/budget totals off the ledger, not a re-derived
//      guess.
//   2. a global-artifact refusal is named verbatim on its own line, never folded into the drop
//      count, and an empty window renders explicit absence rather than a fabricated zero.
//   3. status-board.ts calls digest.ts's aggregateLearningsInjection — ONE traversal, not a
//      second ledger read (grep proof lives in the PR body, this file exercises the behaviour).

/** One `learnings.injected` ledger row, matching exactly what run-task.ts's promptsmith block
 *  logs (src/run-task.ts, the `log("learnings.injected", {...})` call). */
function injectedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-08-10T09:00:00.000Z",
    step: "learnings.injected",
    matched: 3,
    matched_ids: ["a", "b", "c"],
    dropped: ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10", "d11", "d12", "d13"],
    budget_chars: 4000,
    masked: false,
    ...overrides,
  };
}

// The task's OWN numbers: 3 matched / 13 dropped of 16 total, with a global-artifact refusal.
const REFUSAL_ROW = injectedRow({
  run_id: "R1",
  global_refused_reason: "global artifact not found",
});
// A second spawn, same window: fewer drops, no refusal, and a DIFFERENT budget_chars — proves
// `budgetChars` keeps every distinct value seen rather than collapsing to one number.
const CLEAN_ROW = injectedRow({
  run_id: "R2",
  matched: 10,
  matched_ids: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
  dropped: ["d1", "d2"],
  budget_chars: 5000,
});
// A non-injection line in the SAME window — must never be mistaken for a row.
const VERDICT_LINE = { ts: "2026-08-10T09:05:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged" };

const MIXED_LINES = [REFUSAL_ROW, CLEAN_ROW, VERDICT_LINE];

// ── Acceptance 1 + digest-side aggregation ──────────────────────────────────────────────────

test("aggregateLearningsInjection: totals matched/dropped/rows across every learnings.injected row in the window", () => {
  const totals = aggregateLearningsInjection(MIXED_LINES) as LearningsInjectionTotals;
  assert.ok(totals, "the window carries two learnings.injected rows");
  assert.equal(totals.rows, 2);
  assert.equal(totals.matched, 3 + 10);
  assert.equal(totals.dropped, 13 + 2);
});

test("aggregateLearningsInjection: budgetChars keeps every DISTINCT value seen, sorted, rather than one summary number", () => {
  const totals = aggregateLearningsInjection(MIXED_LINES) as LearningsInjectionTotals;
  assert.deepEqual(totals.budgetChars, [4000, 5000]);
});

test("aggregateLearningsInjection: a non-injection ledger line (verdict) never inflates rows/matched/dropped", () => {
  const totals = aggregateLearningsInjection(MIXED_LINES) as LearningsInjectionTotals;
  assert.equal(totals.rows, 2, "the verdict line must not count as a third row");
});

// ── Acceptance 2: refusal named verbatim, never folded into dropped; empty window is explicit ──

test("aggregateLearningsInjection: global_refused_reason is named verbatim with a count, deduped across rows", () => {
  const totals = aggregateLearningsInjection(MIXED_LINES) as LearningsInjectionTotals;
  assert.deepEqual(totals.globalRefusedReasons, { "global artifact not found": 1 });
  // The refusal never inflates `dropped` — it's a layer contributing zero entries, not a
  // ranked entry losing a tie (design note (iii)).
  assert.equal(totals.dropped, 15, "13 (R1) + 2 (R2) — the refusal itself adds nothing here");
});

test("aggregateLearningsInjection: a window with NO learnings.injected rows is undefined, never a fabricated zero", () => {
  const totals = aggregateLearningsInjection([VERDICT_LINE]);
  assert.equal(totals, undefined);
});

// ── Acceptance 3 (behavioural half): rmd status renders off the SAME aggregate ──────────────

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-learnings-injection-board-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "learnings-injection-board-root-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => Date.parse("2026-08-10T12:00:00.000Z"),
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

test("buildStatusBoard/renderStatusBoardText: LEARNINGS INJECTION names matched, dropped, budget, and the refusal reason verbatim", () => {
  const ledgerPath = ledgerFile(MIXED_LINES);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  assert.equal(model.learningsInjection.found, true);
  assert.equal(model.learningsInjection.totals?.matched, 13);
  assert.equal(model.learningsInjection.totals?.dropped, 15);
  // Acceptance: "every injection row still carries its global refusal reason verbatim" —
  // aggregateLearningsInjection (digest.ts) is untouched by W1-T1251; the raw reason string
  // keyed here is byte-identical to what run-task.ts logged, regardless of how the board
  // later classifies/renders it.
  assert.deepEqual(model.learningsInjection.totals?.globalRefusedReasons, { "global artifact not found": 1 });

  const text = renderStatusBoardText(model);
  assert.match(text, /── LEARNINGS INJECTION/);
  assert.match(text, /matched: 13 {2}dropped: 15 {2}rows: 2/);
  assert.match(text, /budget_chars: 4000, 5000/);
  // W1-T1251: "global artifact not found" is the ONE designed, §6-deferred-transport absence —
  // it must NOT print behind the word "refused" (that word is reserved for a genuine problem
  // with an artifact that exists), and its own line still carries the reason verbatim.
  assert.doesNotMatch(text, /global artifact refused: global artifact not found/);
  assert.match(text, /global artifact refused: none/);
  assert.match(text, /global artifact deferred \(§6 transport not yet provisioned\): global artifact not found \(1\)/);
});

test("buildStatusBoard: an empty ledger reports learningsInjection.found=false, and the text block says so rather than printing a placeholder zero", () => {
  const model = buildStatusBoard(tmpRoot(), join(tmpdir(), "does-not-exist-learnings-injection.ndjson"), baseDeps());
  assert.equal(model.learningsInjection.found, false);
  assert.equal(model.learningsInjection.totals, undefined);

  const text = renderStatusBoardText(model);
  assert.match(text, /── LEARNINGS INJECTION/);
  assert.match(text, /no injection rows in this window/);
  assert.doesNotMatch(text, /dropped: 0/);
});

test("buildStatusBoard: a window with injection rows but no refusal renders 'global artifact refused: none' AND 'deferred: none', never a stray reason", () => {
  const ledgerPath = ledgerFile([CLEAN_ROW]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  assert.deepEqual(model.learningsInjection.totals?.globalRefusedReasons, {});
  const text = renderStatusBoardText(model);
  assert.match(text, /global artifact refused: none/);
  assert.match(text, /global artifact deferred \(§6 transport not yet provisioned\): none/);
});

// ── W1-T1251: THE DESIGNED ABSENCE IS REPORTED APART FROM A GENUINE REFUSAL ─────────────────
//
// `loadGlobalArtifact` (learnings.ts) returns seven distinct failure reasons, of which exactly
// one ("global artifact not found") is the ruled-on deferred state and six are real problems
// (including the hash-mismatch tamper signal). Before this task every one of them rendered
// behind the single word "refused:" on this board. This block proves the board now reports the
// designed absence in its own words while a genuine refusal (tamper/malformation) keeps the
// word "refused" and stays on the FIRST, prominent line.

const TAMPER_ROW = injectedRow({
  run_id: "R3",
  global_refused_reason: "global artifact hash mismatch (/path/to/artifact.yaml): pinned abc, computed def — refused, not trusted",
});

test("buildStatusBoard/renderStatusBoardText: a designed absence and a genuine (tamper) refusal in the SAME window render on separate, differently-worded lines", () => {
  const ledgerPath = ledgerFile([REFUSAL_ROW, TAMPER_ROW]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  // Both raw reasons are still in the aggregate, verbatim, untouched by the classification.
  assert.deepEqual(model.learningsInjection.totals?.globalRefusedReasons, {
    "global artifact not found": 1,
    "global artifact hash mismatch (/path/to/artifact.yaml): pinned abc, computed def — refused, not trusted": 1,
  });

  const text = renderStatusBoardText(model);
  const refusedLine = text.split("\n").find((l) => l.startsWith("global artifact refused:"));
  const deferredLine = text.split("\n").find((l) => l.startsWith("global artifact deferred"));
  assert.ok(refusedLine, "the refused line must still be present");
  assert.ok(deferredLine, "the deferred line must still be present");
  // The tamper reason is a genuine refusal: named on the "refused:" line, never the deferred one.
  assert.match(refusedLine ?? "", /hash mismatch/);
  assert.doesNotMatch(deferredLine ?? "", /hash mismatch/);
  // The designed absence is named on the deferred line, never the "refused:" line.
  assert.match(deferredLine ?? "", /global artifact not found/);
  assert.doesNotMatch(refusedLine ?? "", /global artifact not found/);
});
