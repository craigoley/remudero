/**
 * W1-T2765 — THE PROMPT MANIFEST WAS WRITTEN ON EVERY RUN AND READ BY NOTHING.
 *
 * W1-T2297 fingerprints every prompt part by name, sha256 and byte count into a `prompt.manifest`
 * ledger row on every run. Across src/, scripts/ and docs/ the step name appeared only in its
 * writer, its unit test and `buildBundle`'s independent producer — no verb, report or panel read a
 * row. The fleet's own dialect had a meter with no dial, and a compaction decision taken without
 * one is a guess.
 *
 * This is a REPORT. No gate, no threshold, no ceiling, and the manifest's own shape and step are
 * unchanged — asserted below, because "what did not change" is half the claim.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDigest, renderPromptParts, summarize, summarizePromptParts } from "../src/lib/digest.js";

const SINCE = "2026-09-07T00:00:00.000Z";

function manifest(ts: string, parts: Array<{ name: string; present?: boolean; bytes?: number | null }>): Record<string, unknown> {
  return {
    ts,
    run_id: "R",
    task_id: "W1-T1",
    step: "prompt.manifest",
    parts: parts.map((p) => ({ name: p.name, present: p.present ?? true, sha256: "deadbeef", bytes: p.bytes ?? null })),
  };
}

// ── criterion 1 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2765: the digest summarises manifest rows per part with p50 and p90 bytes over its window", () => {
  const lines = [
    manifest("2026-09-07T01:00:00.000Z", [{ name: "doctrine", bytes: 100 }, { name: "learnings", bytes: 8000 }]),
    manifest("2026-09-07T02:00:00.000Z", [{ name: "doctrine", bytes: 300 }, { name: "learnings", bytes: 8100 }]),
    manifest("2026-09-07T03:00:00.000Z", [{ name: "doctrine", bytes: 200 }, { name: "learnings", bytes: 8148 }]),
  ];
  const s = summarizePromptParts(lines, SINCE);
  assert.ok(s, "three rows in the window must summarise");
  assert.equal(s.rows, 3);
  // Sorted by p50 descending, so the part dominating the prompt reads first.
  assert.deepEqual(s.parts.map((p) => p.name), ["learnings", "doctrine"]);
  const learnings = s.parts[0];
  assert.equal(learnings.bytesP50, 8100, "nearest-rank p50 over 8000/8100/8148");
  assert.equal(learnings.bytesP90, 8148);
  assert.equal(learnings.presentRuns, 3);
  assert.equal(learnings.observedRuns, 3);
});

test("W1-T2765: the summary names the part that grew most against the prior window", () => {
  const lines = [
    manifest("2026-09-06T01:00:00.000Z", [{ name: "doctrine", bytes: 100 }, { name: "learnings", bytes: 2000 }]),
    manifest("2026-09-07T01:00:00.000Z", [{ name: "doctrine", bytes: 120 }, { name: "learnings", bytes: 8000 }]),
  ];
  const s = summarizePromptParts(lines, SINCE);
  assert.ok(s);
  assert.equal(s.priorRows, 1, "the row before sinceIso is the comparison window");
  assert.deepEqual(s.grewMost, { name: "learnings", fromP50: 2000, toP50: 8000 }, "6000B beats doctrine's 20B");
});

test("W1-T2765: a part with no prior observation is never reported as growth from zero", () => {
  const lines = [
    manifest("2026-09-06T01:00:00.000Z", [{ name: "doctrine", bytes: 100 }]),
    manifest("2026-09-07T01:00:00.000Z", [{ name: "doctrine", bytes: 110 }, { name: "brand-new-part", bytes: 9999 }]),
  ];
  const s = summarizePromptParts(lines, SINCE);
  assert.equal(s?.grewMost?.name, "doctrine", "the new part has nothing to be compared against");
});

test("W1-T2765: an ABSENT part is counted as observed but its bytes are not folded into the figures", () => {
  const lines = [
    manifest("2026-09-07T01:00:00.000Z", [{ name: "operator-notes", present: false, bytes: null }]),
    manifest("2026-09-07T02:00:00.000Z", [{ name: "operator-notes", present: true, bytes: 400 }]),
  ];
  const p = summarizePromptParts(lines, SINCE)?.parts[0];
  assert.equal(p?.observedRuns, 2);
  assert.equal(p?.presentRuns, 1, "folding the absent run in would report a smaller prompt than the fleet sends");
  assert.equal(p?.bytesP50, 400, "the one present run is the whole population");
});

// ── criterion 2 ──────────────────────────────────────────────────────────────────────────────

test("W1-T2765: a window with NO manifest rows renders `not observed` and never a zero", () => {
  assert.equal(summarizePromptParts([], SINCE), undefined, "undefined, not an empty summary");
  assert.equal(summarizePromptParts([{ ts: "2026-09-07T01:00:00.000Z", step: "verdict" }], SINCE), undefined);
  const rendered = renderPromptParts(undefined);
  assert.match(rendered, /not observed/);
  assert.doesNotMatch(rendered, /\b0B\b/, "a naked zero would claim the prompt was empty, not unmeasured (P48)");
});

test("W1-T2765: rows OUTSIDE the window do not create a summary on their own", () => {
  assert.equal(summarizePromptParts([manifest("2026-09-06T01:00:00.000Z", [{ name: "doctrine", bytes: 1 }])], SINCE), undefined);
});

test("W1-T2765: a window with rows but NO prior window says so rather than reporting no growth", () => {
  const s = summarizePromptParts([manifest("2026-09-07T01:00:00.000Z", [{ name: "doctrine", bytes: 100 }])], SINCE);
  assert.equal(s?.priorRows, 0);
  assert.match(renderPromptParts(s), /no prior window read/, "'(none)' would assert a comparison that was never made");
});

// ── the section reaches the rendered digest ──────────────────────────────────────────────────

test("W1-T2765: renderDigest carries the section — the manifest now reaches a reader", () => {
  const lines = [manifest("2026-09-07T01:00:00.000Z", [{ name: "learnings", bytes: 8148 }])];
  const out = renderDigest(summarize(lines, SINCE));
  assert.match(out, /prompt parts \(1 run\(s\)\): learnings p50 8148B/, "the figure must appear in the digest a human actually reads");
});

test("W1-T2765: renderDigest says `not observed` on a window with no manifest row, rather than omitting the line", () => {
  const out = renderDigest(summarize([{ ts: "2026-09-07T01:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged" }], SINCE));
  assert.match(out, /prompt parts: \(not observed this window\)/, "an absent line would read as a quiet window rather than an unread meter");
});

// ── what did NOT change ──────────────────────────────────────────────────────────────────────

test("W1-T2765: this is a report — the summary carries no threshold, ceiling or verdict", () => {
  const lines = [manifest("2026-09-07T01:00:00.000Z", [{ name: "learnings", bytes: 999999 }])];
  const s = summarizePromptParts(lines, SINCE);
  assert.ok(s);
  assert.deepEqual(Object.keys(s).sort(), ["parts", "priorRows", "rows"], "no pass/fail, no cap, no breach flag");
  assert.doesNotMatch(renderPromptParts(s), /BLOCKED|over|cap|exceed|breach/i, "a report must not read as a gate");
});

test("W1-T2765: every other digest section is unchanged by the addition", () => {
  const lines = [{ ts: "2026-09-07T01:00:00.000Z", step: "verdict", task_id: "W1-T9", verdict: "merged", cost_usd: 1.5 }];
  const out = renderDigest(summarize(lines, SINCE));
  for (const expected of [/merged: W1-T9/, /blocked: \(none\)/, /escalations: \(none\)/, /notional cost: \$1\.50/]) {
    assert.match(out, expected);
  }
});
