import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  extractAssertedUnbuiltTaskIds,
  planStateTruthRung,
  renderPlanStateTruth,
  type PlanStateTruthResolver,
} from "../src/lib/retro.js";
import { planStateTruthSectionFor } from "../src/run-task.js";

// W1-T410 (split from W1-T392) — THE PLAN-STATE TRUTH RUNG. Re-derives every task id
// MASTER-PLAN.md asserts unbuilt against a merge resolver (the same resolver the retro gather
// already holds in production — src/run-task.ts's `planStateTruthSectionFor`). Every fixture
// below is hand-authored, NEVER the live MASTER-PLAN.md (design (vi)) — the suite must not go
// red just because the plan text changed.
//
// THE NEGATIVE-CONTROL SHAPE (PROPOSAL_SUBJECT_LINE) mirrors the real defect measured at
// 0503802: MASTER-PLAN.md's own line
//   "rejections are SIBLING (T342 ×2, T349, T350, T353, T356) — P29(i), unbuilt for an EIGHTH cycle."
// carries five task ids that are sibling REJECTION COUNTS, not the unbuilt subject (the
// proposal P29(i), on the far side of the em-dash, is). A line-scoped extractor reports five
// contradictions that are not contradictions; the clause-scoped extractor here must not.

const PROPOSAL_SUBJECT_LINE =
  "rejections are SIBLING (T900 ×2, T901, T902) — P90(i), unbuilt for a THIRD cycle.";

/** A clean bind — id and phrase share one clause, nothing between them. */
const TARGET_LINE = 'antecedent *"W1-T500 did not ship"*, so the correction stands.';

/** A second, independent bind — used to keep an extraction non-empty when {@link TARGET_LINE}
 *  is deliberately omitted from a fixture (the "assertion removed" falsifier, design (vi)).
 *  Deliberately no em-dash/semicolon: id and phrase share one clause, same as TARGET_LINE. */
const STABLE_LINE = "the receipts obligation (W1-T501) remains unbuilt this cycle.";

function resolverOf(entries: Record<string, { merged: boolean; prUrl?: string } | undefined>): PlanStateTruthResolver {
  return (taskId) => entries[taskId];
}

// ── ACCEPTANCE #1 ────────────────────────────────────────────────────────────────────────
// "an id the plan asserts unbuilt while the merge resolver reports it merged becomes a
// blocking finding naming the id, both states and the crediting PR"

test("ACCEPTANCE #1: asserted-unbuilt id resolved MERGED becomes a blocking finding naming the id, both states and the PR", () => {
  const md = [TARGET_LINE, STABLE_LINE].join("\n");
  const resolve = resolverOf({
    "W1-T500": { merged: true, prUrl: "https://github.com/o/r/pull/500" },
    "W1-T501": { merged: false },
  });
  const report = planStateTruthRung(md, resolve);
  assert.equal(report.kind, "findings");
  if (report.kind !== "findings") return;
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].taskId, "W1-T500");
  assert.equal(report.findings[0].prUrl, "https://github.com/o/r/pull/500");

  const rendered = renderPlanStateTruth(report);
  assert.match(rendered, /BLOCKING/);
  assert.match(rendered, /W1-T500/);
  assert.match(rendered, /UNBUILT/);
  assert.match(rendered, /MERGED/);
  assert.match(rendered, /https:\/\/github\.com\/o\/r\/pull\/500/);
});

// ── ACCEPTANCE #2 (design (vi), 1st and 3rd falsifiers) ─────────────────────────────────
// "the same assertion yields no finding when the resolver agrees the id is unmerged, so the
// rung reads the claim's truth rather than its phrasing"

test("ACCEPTANCE #2: the SAME asserted-unbuilt id resolved UNMERGED yields no finding — truth, not phrasing", () => {
  const md = [TARGET_LINE, STABLE_LINE].join("\n");
  const resolve = resolverOf({
    "W1-T500": { merged: false },
    "W1-T501": { merged: false },
  });
  const report = planStateTruthRung(md, resolve);
  assert.equal(report.kind, "clean");
  if (report.kind !== "clean") return;
  assert.equal(report.idsChecked, 2);

  const rendered = renderPlanStateTruth(report);
  assert.doesNotMatch(rendered, /BLOCKING/);
  assert.match(rendered, /No contradiction/);
});

test("design (vi) falsifier: the same fixture with the assertion REMOVED also passes (nothing left to contradict)", () => {
  // TARGET_LINE dropped entirely — only the always-present STABLE_LINE remains, so the
  // extraction stays non-empty (proving this differs from the empty-extraction failure mode
  // acceptance #4 covers) but carries no W1-T500 assertion at all.
  const md = STABLE_LINE;
  const resolve = resolverOf({ "W1-T501": { merged: false } });
  const report = planStateTruthRung(md, resolve);
  assert.equal(report.kind, "clean");
  const ids = extractAssertedUnbuiltTaskIds(md).ids;
  assert.deepEqual(ids, ["W1-T501"]);
});

// ── ACCEPTANCE #3 ────────────────────────────────────────────────────────────────────────
// "ids that merely co-occur on a line whose unbuilt subject is a proposal yield zero
// findings"

test("ACCEPTANCE #3: ids co-occurring on a proposal-subject line (the measured P29(i) shape) yield ZERO — extraction level", () => {
  const extraction = extractAssertedUnbuiltTaskIds(PROPOSAL_SUBJECT_LINE);
  assert.deepEqual(extraction.ids, []);
  assert.equal(extraction.examinedLines, 1);
  assert.equal(extraction.proposalOnlyLines, 1);
});

test("ACCEPTANCE #3: the proposal-subject line yields zero findings even when its co-occurring ids WOULD resolve merged", () => {
  const md = [PROPOSAL_SUBJECT_LINE, STABLE_LINE].join("\n");
  // A resolver that would flag every rejection-count id merged, IF the extractor (wrongly)
  // bound them — proves the rung does not over-match on this line.
  const resolve = resolverOf({
    "W1-T900": { merged: true, prUrl: "https://github.com/o/r/pull/900" },
    "W1-T901": { merged: true, prUrl: "https://github.com/o/r/pull/901" },
    "W1-T902": { merged: true, prUrl: "https://github.com/o/r/pull/902" },
    "W1-T501": { merged: false },
  });
  const report = planStateTruthRung(md, resolve);
  assert.equal(report.kind, "clean");
  if (report.kind !== "clean") return;
  assert.equal(report.proposalOnlyLines, 1);
  assert.equal(report.idsChecked, 1); // only STABLE_LINE's W1-T501 — never the sibling counts
});

// ── ACCEPTANCE #4 ────────────────────────────────────────────────────────────────────────
// "an extraction yielding no ids fails loudly and reports the size of the set it examined, so
// an empty scan cannot render as a clean result"

test("ACCEPTANCE #4: a fixture with zero phrase-bearing lines fails as UNEXAMINED, not clean, and reports the examined count", () => {
  const md = "Nothing to see here. Every task is on track.";
  const resolve = resolverOf({});
  const report = planStateTruthRung(md, resolve);
  assert.equal(report.kind, "unexamined");
  if (report.kind !== "unexamined") return;
  assert.equal(report.examinedLines, 0);
  assert.match(report.reason, /zero task ids/);

  const rendered = renderPlanStateTruth(report);
  assert.match(rendered, /UNEXAMINED/);
  assert.doesNotMatch(rendered, /No contradiction/);
  assert.doesNotMatch(rendered, /BLOCKING/);
});

test("ACCEPTANCE #4 (design (iii), positive control's 2nd clause): ids extracted but NONE resolve also fails as UNEXAMINED", () => {
  const md = [TARGET_LINE, STABLE_LINE].join("\n");
  const resolve = resolverOf({}); // the resolver has an opinion on neither id
  const report = planStateTruthRung(md, resolve);
  assert.equal(report.kind, "unexamined");
  if (report.kind !== "unexamined") return;
  assert.match(report.reason, /none resolved/);
});

// ── ACCEPTANCE #5 ────────────────────────────────────────────────────────────────────────
// "an absent merge resolver renders as unavailable, distinct from both a clean result and a
// finding, and the retro still completes"

test("ACCEPTANCE #5: an absent resolver renders UNAVAILABLE, distinct from clean and findings, without throwing", () => {
  const md = [TARGET_LINE, STABLE_LINE, PROPOSAL_SUBJECT_LINE].join("\n");
  const report = planStateTruthRung(md, undefined);
  assert.equal(report.kind, "unavailable");

  const rendered = renderPlanStateTruth(report);
  assert.match(rendered, /UNAVAILABLE/);
  assert.doesNotMatch(rendered, /No contradiction/);
  assert.doesNotMatch(rendered, /BLOCKING/);
  assert.doesNotMatch(rendered, /UNEXAMINED/);
});

// ── Extractor-level regression: bare vs. full ids normalize to the same key ──────────────

test("extractor normalizes a bare `T\\d+` id to its full `W1-T\\d+` form, and dedups across both spellings", () => {
  const md = 'antecedent *"T500 did not ship"*, and elsewhere *"W1-T500 did not ship"* again.';
  const extraction = extractAssertedUnbuiltTaskIds(md);
  assert.deepEqual(extraction.ids, ["W1-T500"]);
});

// ── run-task.ts wiring: planStateTruthSectionFor (the file-reading wrapper) ──────────────
// Mirrors ships-unwired-floor.test.ts's coverage of the sibling
// `netStateAdvisorySectionFor`/`planHealthSweepSectionFor` wrappers: a real repoRoot read,
// and the exists-but-unreadable degrade arm (a directory in place of the file — `existsSync`
// says yes, `readFileSync` throws EISDIR).

function makeCheckout(): string {
  return mkdtempSync(join(tmpdir(), "plan-state-truth-"));
}

test("planStateTruthSectionFor reads MASTER-PLAN.md off repoRoot and renders a real section", () => {
  const root = makeCheckout();
  writeFileSync(join(root, "MASTER-PLAN.md"), TARGET_LINE + "\n", "utf8");
  const resolve = resolverOf({ "W1-T500": { merged: true, prUrl: "https://github.com/o/r/pull/500" } });
  const section = planStateTruthSectionFor(root, resolve);
  assert.match(section, /BLOCKING/);
  assert.match(section, /W1-T500/);
});

test("planStateTruthSectionFor degrades to \"\" (never throws) when MASTER-PLAN.md exists but cannot be read", () => {
  const root = makeCheckout();
  // A DIRECTORY at MASTER-PLAN.md: `existsSync` says yes, `readFileSync` throws EISDIR — the
  // same exists-but-unreadable shape the sibling sections' degrade arm is written for.
  mkdirSync(join(root, "MASTER-PLAN.md"), { recursive: true });
  const resolve = resolverOf({ "W1-T500": { merged: true } });
  assert.equal(planStateTruthSectionFor(root, resolve), "");
});

test("planStateTruthSectionFor renders UNAVAILABLE when no resolver is passed at all, off a real repoRoot read", () => {
  const root = makeCheckout();
  writeFileSync(join(root, "MASTER-PLAN.md"), TARGET_LINE + "\n", "utf8");
  const section = planStateTruthSectionFor(root, undefined);
  assert.match(section, /UNAVAILABLE/);
});
