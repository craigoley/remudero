import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { judgeReview } from "../src/lib/review.js";
import { findExportDefinition, isExportReachable, scanUnreachedExports } from "../src/lib/reachability.js";
import { scopeGuardOutOfScopeFiles } from "../src/run-task.js";

// W1-T322 — SHIPS-UNWIRED advisory floor. ONE reachability scan (lib/reachability.ts),
// consumed at review time (judgeReview's `unwiredAdvisories`, ADVISORY ONLY — never touches
// `state`/`floorState`/`capped`) so the eventual blocking decision (W1-T323) is made on a
// MEASURED false-positive rate, not a guess. Five fixtures below cover the task's five
// acceptance criteria in order.

const SIMPLE_CRITERIA: AcceptanceCriterion[] = [
  { claim: "the change is safe", proof: "widget frobnicate implemented" },
];
const SIMPLE_REPORT = `
REPORT
- widget frobnicate implemented and verified.
PR_URL: https://github.com/o/r/pull/1
`.trim();

/** A throwaway checkout — every fixture below writes its own files under it. */
function makeCheckout(): string {
  return mkdtempSync(join(tmpdir(), "ships-unwired-"));
}

function writeFile(checkoutDir: string, relPath: string, content: string): void {
  const abs = join(checkoutDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// ── ACCEPTANCE #1 ────────────────────────────────────────────────────────────────────────
// "a diff adding an unreached export with neither marker in the body yields exactly one
// ledgered advisory and an unchanged verdict"

test("ACCEPTANCE #1: an unreached export with no marker yields exactly one advisory, grouping every offending symbol, and leaves `state` unchanged", () => {
  const checkoutDir = makeCheckout();
  try {
    // Two SEPARATE unreached exports in two separate files — proves "exactly one ledgered
    // advisory" means ONE grouped entry (symbols: [...]), not one line per symbol.
    writeFile(checkoutDir, "src/lib/orphan.ts", "export function orphanFn(): number {\n  return 1;\n}\n");
    writeFile(checkoutDir, "src/lib/orphan2.ts", "export function orphanFn2(): number {\n  return 2;\n}\n");
    const diff = `
diff --git a/src/lib/orphan.ts b/src/lib/orphan.ts
+++ b/src/lib/orphan.ts
@@
+export function orphanFn(): number {
+  return 1;
+}
diff --git a/src/lib/orphan2.ts b/src/lib/orphan2.ts
+++ b/src/lib/orphan2.ts
@@
+export function orphanFn2(): number {
+  return 2;
+}
`.trim();

    const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, headCheckoutDir: checkoutDir });

    assert.equal(v.state, "success", "the advisory must never flip the verdict — ADVISORY ONLY");
    assert.equal(v.unwiredAdvisories?.length, 1, "exactly one advisory entry, however many symbols it names");
    const advisory = v.unwiredAdvisories?.[0];
    assert.equal(advisory?.reasonCode, "unwired_export");
    assert.deepEqual(
      [...(advisory?.symbols ?? [])].sort(),
      ["src/lib/orphan.ts::orphanFn", "src/lib/orphan2.ts::orphanFn2"].sort(),
    );

    // Control: no `headCheckoutDir` at all ⇒ the export scan is skipped (nothing to read), same
    // degradation contract `execCtx`/proof execution already has — never a false "nothing to advise".
    const noCheckout = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT });
    assert.equal(noCheckout.unwiredAdvisories?.length ?? 0, 0);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE #2 ────────────────────────────────────────────────────────────────────────
// "a SHIPS-UNWIRED marker naming a missing or merged task id is flagged, one naming a real
// open task is honoured"

test("ACCEPTANCE #2: SHIPS-UNWIRED naming a missing/merged task id still flags; naming a real OPEN task honours it", () => {
  const checkoutDir = makeCheckout();
  try {
    writeFile(checkoutDir, "src/lib/orphan.ts", "export function orphanFn(): number {\n  return 1;\n}\n");
    const diff = `
diff --git a/src/lib/orphan.ts b/src/lib/orphan.ts
+++ b/src/lib/orphan.ts
@@
+export function orphanFn(): number {
+  return 1;
+}
`.trim();

    // A marker naming an id that is not in the loaded plan's open set at all (never filed, or
    // already merged/done) — the marker does NOT excuse the advisory.
    const reportMissingId = `${SIMPLE_REPORT}\n\nSHIPS-UNWIRED: W1-T999`;
    const flaggedMissing = judgeReview(SIMPLE_CRITERIA, {
      diff,
      report: reportMissingId,
      headCheckoutDir: checkoutDir,
      openTaskIds: new Set(["W1-T322"]), // W1-T999 is not among the OPEN ids
    });
    assert.equal(flaggedMissing.unwiredAdvisories?.length, 1);
    assert.equal(flaggedMissing.unwiredAdvisories?.[0].reasonCode, "unwired_export");

    // A merged/done task id behaves identically to a missing one: it is simply absent from the
    // caller-supplied `openTaskIds` set (openTaskIdsFromPlan filters merged/done out).
    const reportMergedId = `${SIMPLE_REPORT}\n\nSHIPS-UNWIRED: W1-T100`;
    const flaggedMerged = judgeReview(SIMPLE_CRITERIA, {
      diff,
      report: reportMergedId,
      headCheckoutDir: checkoutDir,
      openTaskIds: new Set(["W1-T322"]), // W1-T100 is (simulated) merged — not in the open set
    });
    assert.equal(flaggedMerged.unwiredAdvisories?.length, 1);

    // No `openTaskIds` supplied at all ⇒ fail-closed: nothing can ever be honoured.
    const flaggedNoPlan = judgeReview(SIMPLE_CRITERIA, { diff, report: reportMissingId, headCheckoutDir: checkoutDir });
    assert.equal(flaggedNoPlan.unwiredAdvisories?.length, 1);

    // A marker naming a REAL, OPEN task id is honoured — the advisory does not fire.
    const reportOpenId = `${SIMPLE_REPORT}\n\nSHIPS-UNWIRED: W1-T322`;
    const honoured = judgeReview(SIMPLE_CRITERIA, {
      diff,
      report: reportOpenId,
      headCheckoutDir: checkoutDir,
      openTaskIds: new Set(["W1-T322"]),
    });
    assert.equal(honoured.unwiredAdvisories?.length ?? 0, 0);
    assert.equal(honoured.state, "success");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE #3 ────────────────────────────────────────────────────────────────────────
// "a PR whose task declares files it never touched yields the inverse-scope advisory — the
// direction the scope guard cannot see"

test("ACCEPTANCE #3: a task declaring a file the diff never touched yields the inverse-scope advisory — {@link scopeGuardOutOfScopeFiles} cannot see this direction", () => {
  const diff = `
diff --git a/src/lib/a.ts b/src/lib/a.ts
+++ b/src/lib/a.ts
@@
-const x = 1;
+const x = 2;
`.trim();
  const declaredFiles = ["src/lib/a.ts", "src/lib/b.ts"]; // b.ts declared, never touched

  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, taskDeclaredFiles: declaredFiles });

  assert.equal(v.state, "success", "inverse-scope is ADVISORY ONLY — never fails the review");
  assert.equal(v.unwiredAdvisories?.length, 1);
  assert.equal(v.unwiredAdvisories?.[0].reasonCode, "inverse_scope");
  assert.deepEqual(v.unwiredAdvisories?.[0].symbols, ["src/lib/b.ts"]);

  // THE CONTRAST: the existing (one-directional) scope guard walks diff → declared and is blind
  // to this exact shape — the SAME two file lists yield NO out-of-scope files from that guard,
  // because every file the diff actually touched (`a.ts`) IS declared. That silence is exactly
  // the gap this advisory closes.
  assert.deepEqual(scopeGuardOutOfScopeFiles(["src/lib/a.ts"], declaredFiles), []);

  // Control: no declared scope at all ⇒ nothing to compare, the advisory never fires.
  const undeclared = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT });
  assert.equal(undeclared.unwiredAdvisories?.length ?? 0, 0);
});

// ── ACCEPTANCE #4 ────────────────────────────────────────────────────────────────────────
// "the seam-default discount holds: an export referenced in its own file beyond its
// definition is never flagged"

test("ACCEPTANCE #4: an export referenced within its own file beyond its definition (the seam-default shape) is never flagged, even with zero outside callers", () => {
  const checkoutDir = makeCheckout();
  try {
    // Mirrors the real fixture this discount exists for (daemon.ts's `sweepOrphanWorkers`): the
    // export is destructured/used as an optional dependency and called conditionally, IN THE
    // SAME FILE, with NO other file anywhere referencing it.
    writeFile(
      checkoutDir,
      "src/lib/seam.ts",
      [
        "export function seamFn(): number {",
        "  return 1;",
        "}",
        "",
        "const maybeSeamFn: (() => number) | undefined = undefined;",
        "if (maybeSeamFn) {",
        "  seamFn();",
        "}",
      ].join("\n"),
    );
    const diff = `
diff --git a/src/lib/seam.ts b/src/lib/seam.ts
+++ b/src/lib/seam.ts
@@
+export function seamFn(): number {
+  return 1;
+}
`.trim();

    assert.equal(isExportReachable("seamFn", "src/lib/seam.ts", checkoutDir), true);
    assert.deepEqual(scanUnreachedExports(diff, checkoutDir), []);

    const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, headCheckoutDir: checkoutDir });
    assert.equal(v.unwiredAdvisories?.length ?? 0, 0);

    // FALSIFIER: strip the in-file reference — now it IS the true-orphan shape and must flag.
    writeFile(checkoutDir, "src/lib/seam.ts", ["export function seamFn(): number {", "  return 1;", "}"].join("\n"));
    assert.equal(isExportReachable("seamFn", "src/lib/seam.ts", checkoutDir), false);
    assert.deepEqual(scanUnreachedExports(diff, checkoutDir), [{ name: "seamFn", file: "src/lib/seam.ts" }]);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE #5 (grep proof) ───────────────────────────────────────────────────────────
// "the scan is CALLED from the review path, not merely defined" — proof: grep scanUnreachedExports( in
// src/lib/review.ts. Not a unit-test fixture; verified by the grep proof stated on the task's own
// acceptance list. A companion sanity check here: `findExportDefinition` (the retro-time
// consumer's resolver) can find scanUnreachedExports's OWN definition in this repo's real source.

test("sanity: findExportDefinition resolves a real export against the actual repo tree (the retro-time consumer's resolver)", () => {
  const repoRoot = join(import.meta.dirname, "..");
  assert.equal(findExportDefinition("scanUnreachedExports", repoRoot), "src/lib/reachability.ts");
  assert.equal(findExportDefinition("thisSymbolDoesNotExistAnywhere123", repoRoot), undefined);
});
