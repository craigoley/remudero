import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── W1-T2248: the operator guide documents the files: correction exit ───────────────────────
//
// RECON, REPRODUCED BY EXPERIMENT: a merged shard's `files:` can be provably wrong (W1-T2218's
// build touched an undeclared test file whose omission was proven live-breaking) and nothing
// catches it before the risk judge does, after the fact, at PR time on some LATER task
// (#2773/W1-T2226). `postMergeAmendmentViolations` (src/lib/task-linter.ts, Standing rule 21)
// computes violations from `criteriaAdded(baseAcceptance, acceptance)` alone — it never reads
// `files:`, `title`, or `status:` — so a plan-only, human-authored edit correcting a merged
// shard's `files:` line passes every gate today. The exit already exists; what was missing is a
// written procedure an author would actually read, stating that the correction is legal, what
// evidence it must carry, and what stays off-limits (acceptance, self-application).
//
// This suite is that falsifier, in the same shape test/docs-claims.test.ts already holds
// docs/operator-guide.md to: one exported pure check per acceptance claim, each proven to
// actually turn RED against stale/missing wording, not merely proven to parse today.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/** Markdown prose wraps at ~80 cols, so a literal multi-word phrase can straddle a line break
 *  in the real file even though it reads as one phrase. Collapse all whitespace runs (including
 *  the newline) to a single space before matching a literal phrase, so the check follows prose
 *  reflow instead of breaking on it. */
function norm(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The guide must state a merged shard's `files:` is correctable and name the gate
 *  (`postMergeAmendmentViolations`, the Rule 21 guard) that does not block the correction. */
export function checkCorrectableAndGateNamed(guideText: string): { ok: boolean; reason?: string } {
  const text = norm(guideText);
  if (!/`files:`[\s\S]{0,200}\b(can be wrong|correctable|correcting it is allowed)\b/i.test(text)) {
    return {
      ok: false,
      reason: "operator-guide.md never states that a merged shard's `files:` declaration is correctable",
    };
  }
  if (!/postMergeAmendmentViolations/.test(text)) {
    return {
      ok: false,
      reason: "operator-guide.md never names postMergeAmendmentViolations as the gate that does not block it",
    };
  }
  if (!/no gate blocks it/i.test(text)) {
    return {
      ok: false,
      reason: "operator-guide.md never states plainly that no gate blocks the files: correction",
    };
  }
  return { ok: true };
}

/** The guide must state acceptance remains guarded and is NOT made correctable by the same route. */
export function checkAcceptanceStaysGuarded(guideText: string): { ok: boolean; reason?: string } {
  const text = norm(guideText);
  if (!/acceptance stays guarded/i.test(text)) {
    return { ok: false, reason: "operator-guide.md never states that acceptance stays guarded" };
  }
  if (!/does not[\s\S]{0,120}make acceptance correctable by the same route/i.test(text)) {
    return {
      ok: false,
      reason:
        "operator-guide.md never states that a files: correction does not make acceptance " +
        "correctable by the same route",
    };
  }
  return { ok: true };
}

/** The guide must require a correction to carry a reproducible failure, not merely an assertion. */
export function checkReproducibleFailureRequired(guideText: string): { ok: boolean; reason?: string } {
  const text = norm(guideText);
  if (!/reproducible failure, not an assertion/i.test(text)) {
    return {
      ok: false,
      reason: "operator-guide.md never requires a correction to carry a reproducible failure, not an assertion",
    };
  }
  return { ok: true };
}

/** The guide must state the amendment is plan-only and human-authored. */
export function checkPlanOnlyHumanAuthored(guideText: string): { ok: boolean; reason?: string } {
  const text = norm(guideText);
  if (!/amendment must be plan-only and human-authored/i.test(text)) {
    return {
      ok: false,
      reason: "operator-guide.md never states the amendment must be plan-only and human-authored",
    };
  }
  return { ok: true };
}

/** The guide must record that no rung applies a correction to its own declaration. */
export function checkNoRungSelfApplies(guideText: string): { ok: boolean; reason?: string } {
  const text = norm(guideText);
  if (!/no rung applies a correction to its own declaration/i.test(text)) {
    return {
      ok: false,
      reason: "operator-guide.md never records that no rung applies a correction to its own declaration",
    };
  }
  return { ok: true };
}

// ── The real guide: each check currently holds ───────────────────────────────────────────────

test("declared-files-correction-exit: the guide states files: is correctable and names the gate that does not block it", async () => {
  const guide = await readFile(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  const result = checkCorrectableAndGateNamed(guide);
  assert.ok(result.ok, result.reason);
});

test("declared-files-correction-exit: the guide states acceptance stays guarded and is not correctable by the same route", async () => {
  const guide = await readFile(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  const result = checkAcceptanceStaysGuarded(guide);
  assert.ok(result.ok, result.reason);
});

test("declared-files-correction-exit: the guide requires a reproducible failure, not an assertion", async () => {
  const guide = await readFile(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  const result = checkReproducibleFailureRequired(guide);
  assert.ok(result.ok, result.reason);
});

test("declared-files-correction-exit: the guide states the amendment must be plan-only and human-authored", async () => {
  const guide = await readFile(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  const result = checkPlanOnlyHumanAuthored(guide);
  assert.ok(result.ok, result.reason);
});

test("declared-files-correction-exit: the guide records that no rung applies a correction to its own declaration", async () => {
  const guide = await readFile(join(REPO_ROOT, "docs", "operator-guide.md"), "utf8");
  const result = checkNoRungSelfApplies(guide);
  assert.ok(result.ok, result.reason);
});

// ── Falsifiers: each check must actually go RED, not just parse ─────────────────────────────

test("declared-files-correction-exit falsifier: a guide never mentioning correctability turns the gate-named check RED", () => {
  const stale = "The operator guide says nothing about files: declarations at all.\n";
  assert.equal(checkCorrectableAndGateNamed(stale).ok, false);
});

test("declared-files-correction-exit falsifier: correctable wording present but the gate unnamed turns the gate-named check RED", () => {
  const missingGate = "A merged shard's `files:` can be wrong; correcting it is allowed. No gate blocks it.\n";
  assert.equal(checkCorrectableAndGateNamed(missingGate).ok, false);
});

test("declared-files-correction-exit falsifier: a guide silent on acceptance turns the acceptance-guarded check RED", () => {
  const stale = "Nothing here discusses acceptance criteria on a merged task.\n";
  assert.equal(checkAcceptanceStaysGuarded(stale).ok, false);
});

test("declared-files-correction-exit falsifier: a guide that widens acceptance correctability turns the acceptance-guarded check RED", () => {
  const stale = "Acceptance stays guarded, but a files: correction also makes acceptance freely editable.\n";
  assert.equal(checkAcceptanceStaysGuarded(stale).ok, false);
});

test("declared-files-correction-exit falsifier: a guide allowing an assertion-only correction turns the evidence check RED", () => {
  const stale = "A correction just needs the author's word that files: was wrong.\n";
  assert.equal(checkReproducibleFailureRequired(stale).ok, false);
});

test("declared-files-correction-exit falsifier: a guide silent on authorship turns the plan-only check RED", () => {
  const stale = "Corrections happen somehow; the guide does not say who or where.\n";
  assert.equal(checkPlanOnlyHumanAuthored(stale).ok, false);
});

test("declared-files-correction-exit falsifier: a guide silent on self-application turns the no-self-apply check RED", () => {
  const stale = "The guide never says whether a rung can apply its own correction.\n";
  assert.equal(checkNoRungSelfApplies(stale).ok, false);
});
