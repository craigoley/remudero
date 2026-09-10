/**
 * W1-T3327 — A FIRING THE OPERATOR CANNOT SEE.
 *
 * The scheduled CI-learning rung is report-only by construction: it prints its drafts to a stdout
 * nobody reads. MEASURED 2026-09-10: the daemon's stdout logs are 0 bytes (dated Aug 13), the
 * container log for the 2026-09-09 firing carried no draft lines, and the ONLY durable trace of
 * that firing was its own cadence marker. The counts reached the ledger; WHAT IT FOUND did not.
 *
 * This stages one proposal per firing into `state/inbox-proposals.json` — the registry `rmd inbox`
 * tiers and the console renders — on the precedent `escalateRepeatingRules` (rule-efficacy.ts)
 * already sets for the same problem.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { makeTempDir } from "../src/lib/tmp.js";
import { stageCiLearningReport, ciLearningReportProposalId } from "../src/lib/measurement-cadence.js";

function registry(root: string): Array<{ id: string; summary: string }> {
  const p = join(root, "inbox-proposals.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8")) as { proposals?: Array<{ id: string; summary: string }> };
  return raw.proposals ?? [];
}

const FIRING = {
  firedAt: "2026-09-10T12:00:00.000Z",
  status: "backlog" as const,
  draftCount: 3,
  filedCount: 3,
  skippedCount: 0,
  refusedCount: 0,
  excludedCount: 30,
  unreadableCount: 0,
  filedTaskIds: ["W1-T9001", "W1-T9002", "W1-T9003"],
  topCauses: [
    { gate: "ci-gate", prs: 26 },
    { gate: "ci", prs: 20 },
    { gate: "coverage-ratchet", prs: 19 },
  ],
};

test("W1-T3327: a firing stages ONE proposal carrying what it found, not just that it ran", () => {
  const root = makeTempDir("w1t3327-");
  const path = join(root, "inbox-proposals.json");

  stageCiLearningReport(FIRING, path);

  const rows = registry(root);
  assert.equal(rows.length, 1, "exactly one proposal per firing");
  const s = rows[0]!.summary;
  // The counts alone are what the ledger already had. The VALUE is the causes and the ids.
  assert.ok(/ci-gate/.test(s), `the summary must name the top cause, got: ${s}`);
  assert.ok(/26/.test(s), "and how many pull requests it refused");
  assert.ok(/W1-T9001/.test(s), "and the records it actually filed, so the operator can open one");
  assert.ok(/30/.test(s), "and what the ceiling excluded, named rather than dropped");
});

test("W1-T3327: a second firing at the same instant is idempotent — no duplicate proposal", () => {
  const root = makeTempDir("w1t3327-");
  const path = join(root, "inbox-proposals.json");

  stageCiLearningReport(FIRING, path);
  stageCiLearningReport(FIRING, path);

  assert.equal(registry(root).length, 1, "the id keys on the firing, so a retry cannot duplicate it");
});

test("W1-T3327: a LATER firing stages its own proposal, so the inbox is a history and not a single slot", () => {
  const root = makeTempDir("w1t3327-");
  const path = join(root, "inbox-proposals.json");

  stageCiLearningReport(FIRING, path);
  stageCiLearningReport({ ...FIRING, firedAt: "2026-09-10T18:00:00.000Z" }, path);

  const rows = registry(root);
  assert.equal(rows.length, 2, "two firings, two reports");
  assert.notEqual(rows[0]!.id, rows[1]!.id, "and distinct ids");
});

test("W1-T3327: a firing that FILED NOTHING still reports, and says so", () => {
  // The condition that ran silently for two days: drafts minted, nothing landed. A reporter that
  // only spoke on success would have hidden exactly the case worth seeing.
  const root = makeTempDir("w1t3327-");
  const path = join(root, "inbox-proposals.json");

  stageCiLearningReport({ ...FIRING, filedCount: 0, refusedCount: 3, filedTaskIds: [] }, path);

  const rows = registry(root);
  assert.equal(rows.length, 1, "a barren firing is still reported");
  assert.ok(/0 filed|filed 0|none filed/i.test(rows[0]!.summary), `the summary must say nothing landed, got: ${rows[0]!.summary}`);
});

test("W1-T3327: the proposal id is derived from the firing instant, never from a counter", () => {
  // A counter would renumber on restart and re-stage every report. The instant is stable.
  const a = ciLearningReportProposalId("2026-09-10T12:00:00.000Z");
  const b = ciLearningReportProposalId("2026-09-10T12:00:00.000Z");
  const c = ciLearningReportProposalId("2026-09-10T18:00:00.000Z");
  assert.equal(a, b, "the same firing yields the same id");
  assert.notEqual(a, c, "a different firing yields a different id");
  assert.ok(a.startsWith("ci-learning-report:"), `the id must be namespaced, got: ${a}`);
});
