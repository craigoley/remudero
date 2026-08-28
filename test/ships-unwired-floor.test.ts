import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AcceptanceCriterion, Plan, Task } from "../src/lib/plan.js";
import { judgeReview } from "../src/lib/review.js";
import { findExportDefinition, isExportReachable, scanUnreachedExports } from "../src/lib/reachability.js";
import { netStateCapabilityAdvisories, renderNetStateUnwiredAdvisories } from "../src/lib/retro.js";
import { netStateAdvisorySectionFor, openTaskIdsFromPlan, runReview, scopeGuardOutOfScopeFiles } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";
import type { StatusProjection } from "../src/lib/status.js";

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

// ── W1-T367 ──────────────────────────────────────────────────────────────────────────────
// "the open-task id set the review floor consumes excludes ids whose PRs have merged, so a
// SHIPS-UNWIRED marker naming a merged task is flagged rather than honoured" AND "an
// unavailable projection degrades toward flagging rather than toward honouring an
// unwired-export exemption". `openTaskIdsFromPlan` (run-task.ts) used to read the DECORATIVE
// yaml `status:` field directly — MEASURED at cdf885a: 248 of 359 tasks carry a stale
// non-merged status despite a long-merged PR, so that reading wrongly credited 248 merged
// tasks as "open", which meant a `SHIPS-UNWIRED:` marker naming any one of them was HONOURED
// instead of flagged. These tests drive the real exported function directly against a
// synthetic `Plan` + `StatusProjection` map — no GitHub, no fixture repo.

/** A minimal, otherwise-valid Task fixture. */
function planTask(id: string, status: Task["status"] = "queued"): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status,
    attempts: 0,
  };
}

/** A minimal StatusProjection fixture — only the fields `openTaskIdsFromPlan` reads. */
function proj(taskId: string, over: Partial<StatusProjection> = {}): StatusProjection {
  return { taskId, status: "queued", merged: false, source: "none", ...over };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

test("openTaskIdsFromPlan: a task whose yaml status is still 'queued' but whose projection says merged is EXCLUDED (the measured 248/359 defect)", () => {
  const plan = planOf([planTask("W1-T-STALE-MERGED", "queued")]);
  const projection = new Map([["W1-T-STALE-MERGED", proj("W1-T-STALE-MERGED", { merged: true, status: "merged" })]]);
  const open = openTaskIdsFromPlan(plan, projection);
  assert.deepEqual([...open], [], "the projection says merged — never trust the stale yaml 'queued' over it");
});

test("openTaskIdsFromPlan: a task whose yaml status says 'merged' but whose projection says NOT merged is INCLUDED (open)", () => {
  const plan = planOf([planTask("W1-T-STALE-OPEN", "merged")]);
  const projection = new Map([["W1-T-STALE-OPEN", proj("W1-T-STALE-OPEN", { merged: false })]]);
  const open = openTaskIdsFromPlan(plan, projection);
  assert.deepEqual([...open], ["W1-T-STALE-OPEN"], "the projection says NOT merged — the yaml 'merged' row is never trusted either");
});

test("openTaskIdsFromPlan: an INDETERMINATE (github-unreachable) task is EXCLUDED — degrades toward flagging, never honouring", () => {
  const plan = planOf([planTask("W1-T-DOWN", "queued")]);
  const projection = new Map([
    ["W1-T-DOWN", proj("W1-T-DOWN", { merged: false, indeterminate: true, unavailableReason: "transport" })],
  ]);
  const open = openTaskIdsFromPlan(plan, projection);
  assert.deepEqual(
    [...open],
    [],
    "merged=false but indeterminate=true (a genuinely failed GitHub read) must NOT be treated as a confirmed-open id",
  );

  // Contrast: the SAME task resolved cleanly to merged:false (no outage) IS open.
  const resolved = new Map([["W1-T-DOWN", proj("W1-T-DOWN", { merged: false })]]);
  assert.deepEqual([...openTaskIdsFromPlan(plan, resolved)], ["W1-T-DOWN"]);
});

test("openTaskIdsFromPlan: with NO projection supplied at all, degrades to the EMPTY set (no call site may fall back to the yaml field)", () => {
  const plan = planOf([planTask("W1-T-ANY", "queued"), planTask("W1-T-OTHER", "merged")]);
  assert.deepEqual([...openTaskIdsFromPlan(plan)], [], "no projection in hand ⇒ nothing is known open ⇒ every marker flags");
});

test("openTaskIdsFromPlan: a task id absent from the projection map entirely is EXCLUDED, same safe direction as indeterminate", () => {
  const plan = planOf([planTask("W1-T-MISSING", "queued")]);
  const emptyProjection = new Map<string, StatusProjection>();
  assert.deepEqual([...openTaskIdsFromPlan(plan, emptyProjection)], []);
});

test("W1-T367 end-to-end: judgeReview flags a SHIPS-UNWIRED marker naming a task the yaml says 'queued' but the projection says merged", () => {
  const checkoutDir = mkdtempSync(join(tmpdir(), "ships-unwired-w1t367-"));
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
    // W1-T322 is (simulated) merged despite carrying yaml status 'queued' — the exact
    // W1-T367 shape. The plan's own `openTaskIdsFromPlan(plan, projection)` output feeds
    // `judgeReview` here, mirroring exactly what runTask's dispatch path wires through.
    const plan = planOf([planTask("W1-T322", "queued")]);
    const projection = new Map([["W1-T322", proj("W1-T322", { merged: true, status: "merged" })]]);
    const openTaskIds = openTaskIdsFromPlan(plan, projection);

    const report = `${SIMPLE_REPORT}\n\nSHIPS-UNWIRED: W1-T322`;
    const v = judgeReview(SIMPLE_CRITERIA, { diff, report, headCheckoutDir: checkoutDir, openTaskIds });
    assert.equal(v.unwiredAdvisories?.length, 1, "a merged task's marker is flagged, never honoured, despite its yaml status");
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

// W1-T458 — the fourth SHIPS-UNWIRED reason code, `unresolved_task_scope` (the #1731 near-miss:
// a PR merged with no `Remudero-Task:` trailer, neither credit path resolved, and the daemon
// re-dispatched the task it had just merged). Full acceptance coverage lives in
// test/review-trailer-absent-advisory.test.ts; this is a sanity check that it shares this floor's
// machinery (unwiredAdvisories, the same fail-closed/advisory-only discipline) cleanly.
test("W1-T458: unresolved_task_scope fires only when NO task is resolved AND an open task's declared src/test scope overlaps the diff — always ADVISORY ONLY", () => {
  const diff = `
diff --git a/src/lib/c.ts b/src/lib/c.ts
+++ b/src/lib/c.ts
@@
-const x = 1;
+const x = 2;
`.trim();
  const openTaskDeclaredFiles = new Map([["W1-T452", ["src/lib/c.ts"]]]);

  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, openTaskDeclaredFiles });

  assert.equal(v.state, "success", "unresolved_task_scope is ADVISORY ONLY — never fails the review");
  const advisory = v.unwiredAdvisories?.find((a) => a.reasonCode === "unresolved_task_scope");
  assert.ok(advisory);
  assert.deepEqual(advisory?.symbols, ["src/lib/c.ts"]);

  // Resolved (taskDeclaredFiles present) ⇒ silent, even with the same overlapping open task.
  const resolved = judgeReview(SIMPLE_CRITERIA, {
    diff,
    report: SIMPLE_REPORT,
    taskDeclaredFiles: ["src/lib/c.ts"],
    openTaskDeclaredFiles,
  });
  assert.equal(resolved.unwiredAdvisories?.filter((a) => a.reasonCode === "unresolved_task_scope").length, 0);
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
    assert.deepEqual(scanUnreachedExports(diff, checkoutDir), { unreached: [], examined: 1 });

    const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT, headCheckoutDir: checkoutDir });
    assert.equal(v.unwiredAdvisories?.length ?? 0, 0);
    assert.equal(v.reachabilityScanned, 1, "examined=1 even though it cleared — a HEALTHY CLEAR, not silence");

    // FALSIFIER: strip the in-file reference — now it IS the true-orphan shape and must flag.
    writeFile(checkoutDir, "src/lib/seam.ts", ["export function seamFn(): number {", "  return 1;", "}"].join("\n"));
    assert.equal(isExportReachable("seamFn", "src/lib/seam.ts", checkoutDir), false);
    assert.deepEqual(scanUnreachedExports(diff, checkoutDir), {
      unreached: [{ name: "seamFn", file: "src/lib/seam.ts" }],
      examined: 1,
    });
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── W1-T1118 (reachabilityScanned) ─────────────────────────────────────────────────────────
// "the ships-unwired scan's silence is three states in one" — this floor's own OWN acceptance
// criteria, driven end to end through `judgeReview`: (a) no checkout ⇒ `null`, never a fake 0;
// (b) examined N and cleared all N ⇒ `N`, distinguishable from (a); (c) the diff added no
// exported function at all ⇒ `0`, distinguishable from both (a) and (b); and the field changes
// NOTHING about the advisories/reasonCode/state that already fired before it existed.

test("W1-T1118: reachabilityScanned separates 'never ran' (null) from 'examined N and cleared all N' (N) from 'added no export at all' (0) — three distinct renders, never one silence", () => {
  const checkoutDir = makeCheckout();
  try {
    writeFile(checkoutDir, "src/lib/cleared.ts", "export function clearedFn(): number {\n  return 1;\n}\n");
    writeFile(checkoutDir, "src/lib/caller.ts", "import { clearedFn } from './cleared.js';\nexport const n = clearedFn();\n");
    const diffWithReachedExport = `
diff --git a/src/lib/cleared.ts b/src/lib/cleared.ts
+++ b/src/lib/cleared.ts
@@
+export function clearedFn(): number {
+  return 1;
+}
`.trim();
    const diffWithNoExport = `
diff --git a/src/lib/plain.ts b/src/lib/plain.ts
+++ b/src/lib/plain.ts
@@
-const x = 1;
+const x = 2;
`.trim();

    // (a) NO CHECKOUT — the `if (checkoutDir)` skip: the scan never ran, so `null`, never 0.
    const neverRan = judgeReview(SIMPLE_CRITERIA, { diff: diffWithReachedExport, report: SIMPLE_REPORT });
    assert.equal(neverRan.reachabilityScanned, null, "no checkout ⇒ null — the scan did not run, not a count");

    // (b) SCANNED 1, CLEARED IT — a healthy clear. Distinguishable from (a): a real number, not null.
    const clearedAll = judgeReview(SIMPLE_CRITERIA, {
      diff: diffWithReachedExport,
      report: SIMPLE_REPORT,
      headCheckoutDir: checkoutDir,
    });
    assert.equal(clearedAll.reachabilityScanned, 1);
    assert.equal(
      clearedAll.unwiredAdvisories?.length ?? 0,
      0,
      "cleared ⇒ no advisory, yet reachabilityScanned still records the 1 export it examined",
    );
    assert.notEqual(
      clearedAll.reachabilityScanned,
      neverRan.reachabilityScanned,
      "ACCEPTANCE #1: scanned-and-cleared must render differently from never-ran",
    );

    // (c) THE DIFF ADDED NO EXPORTED FUNCTION AT ALL — 0 is the honest answer, never an absent scan.
    const addedNone = judgeReview(SIMPLE_CRITERIA, {
      diff: diffWithNoExport,
      report: SIMPLE_REPORT,
      headCheckoutDir: checkoutDir,
    });
    assert.equal(addedNone.reachabilityScanned, 0, "0 is real — the diff added none — never coerced to null");
    assert.notEqual(
      addedNone.reachabilityScanned,
      neverRan.reachabilityScanned,
      "ACCEPTANCE #3: added-none (0) must render differently from never-ran (null)",
    );
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("W1-T1118 (ACCEPTANCE #5): reachabilityScanned changes NOTHING about the advisories, their reason codes, or the verdict state a case already fired before this field existed", () => {
  const checkoutDir = makeCheckout();
  try {
    writeFile(checkoutDir, "src/lib/orphan3.ts", "export function orphanFn3(): number {\n  return 1;\n}\n");
    const diffUnreached = `
diff --git a/src/lib/orphan3.ts b/src/lib/orphan3.ts
+++ b/src/lib/orphan3.ts
@@
+export function orphanFn3(): number {
+  return 1;
+}
`.trim();
    const flagged = judgeReview(SIMPLE_CRITERIA, { diff: diffUnreached, report: SIMPLE_REPORT, headCheckoutDir: checkoutDir });

    // Same shape ACCEPTANCE #1 already asserts: ADVISORY ONLY, one grouped entry, the same
    // reason code and symbols — unchanged by reachabilityScanned riding alongside it.
    assert.equal(flagged.state, "success", "still ADVISORY ONLY — reachabilityScanned never touches state");
    assert.equal(flagged.unwiredAdvisories?.length, 1);
    assert.equal(flagged.unwiredAdvisories?.[0].reasonCode, "unwired_export");
    assert.deepEqual(flagged.unwiredAdvisories?.[0].symbols, ["src/lib/orphan3.ts::orphanFn3"]);

    // And the fourth readable state design (ii) names: N WITH an advisory.
    assert.equal(flagged.reachabilityScanned, 1, "N with an advisory fires — the fourth of the four readable states");
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

// ── DIFF-COVERAGE FIXTURES ───────────────────────────────────────────────────────────────
// The four groups below cover the lines `diff-coverage` flagged on this PR's first push
// (reachability's unreadable-file arm, retro's `snippetAround`/render-non-empty branch, the
// review path's advisory ledger loop, and the retro scan's degradation arm). Each drives the
// REAL exported function — none asserts against a hand-built stand-in for what production does.

test("an unreadable candidate file is skipped, never treated as a file that failed to match", () => {
  const checkoutDir = makeCheckout();
  try {
    // `isExportReachable` always reads `definingFile`, even outside SCAN_ROOTS — so a
    // definingFile that does not exist is the one deterministic way into the shared
    // unreadable-file arm. Everything `listCandidateFiles` yields is a real readable file.
    assert.equal(
      isExportReachable("ghostFn", "src/lib/does-not-exist.ts", checkoutDir),
      false,
      "an unreadable definingFile yields 'not reachable' — it must not throw, and must not report reachable",
    );

    // FALSIFIER: with a REAL caller present, the same call returns true — proving the skip above
    // is the unreadable path and not a blanket false.
    writeFile(checkoutDir, "src/lib/ghost.ts", "export function ghostFn(): number {\n  return 1;\n}\n");
    writeFile(checkoutDir, "src/lib/caller.ts", "import { ghostFn } from './ghost.js';\nexport const v = ghostFn();\n");
    assert.equal(isExportReachable("ghostFn", "src/lib/ghost.ts", checkoutDir), true);

    // And the resolver shares that arm: an empty tree resolves nothing rather than throwing.
    assert.equal(findExportDefinition("ghostFn", join(checkoutDir, "no-such-subtree")), undefined);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("a NET STATE sentence naming an unreached symbol becomes an advisory carrying a collapsed snippet, and renders as a section", () => {
  const checkoutDir = makeCheckout();
  try {
    writeFile(checkoutDir, "src/lib/claimed.ts", "export function claimedFeature(): number {\n  return 1;\n}\n");
    const netStateText = [
      "\n## NET STATE",
      "",
      "- The console   ships   `claimedFeature` end to end,",
      "  and it is wired into the daemon.",
    ].join("\n");

    const advisories = netStateCapabilityAdvisories(netStateText, checkoutDir);

    assert.equal(advisories.length, 1, "one advisory for the one unreached symbol the sentence names");
    assert.equal(advisories[0].symbol, "claimedFeature");
    assert.equal(advisories[0].file, "src/lib/claimed.ts");
    assert.match(advisories[0].snippet, /claimedFeature/, "the snippet quotes the claim it is about");
    assert.doesNotMatch(advisories[0].snippet, /\s\s/, "whitespace is collapsed — never the raw multi-line bullet");
    assert.ok(advisories[0].snippet.length <= 300, "and it is a window, not the whole section");

    const rendered = renderNetStateUnwiredAdvisories(advisories);
    assert.match(rendered, /ADVISORY ONLY/, "the non-empty section states it decides nothing");
    assert.match(rendered, /`claimedFeature` \(src\/lib\/claimed\.ts\)/, "and names the symbol with its file");

    // The empty branch is a DIFFERENT sentence, not the same one with nothing in it.
    const empty = renderNetStateUnwiredAdvisories([]);
    assert.match(empty, /No NET STATE claim names a symbol this scan finds unreached/);
    assert.doesNotMatch(empty, /ADVISORY ONLY/);

    // A symbol that is REACHED yields no advisory at all — the falsifier for the above.
    writeFile(checkoutDir, "src/lib/uses.ts", "import { claimedFeature } from './claimed.js';\nexport const n = claimedFeature();\n");
    assert.deepEqual(netStateCapabilityAdvisories(netStateText, checkoutDir), []);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

test("the retro's NET STATE scan degrades to an empty section when MASTER-PLAN.md exists but cannot be read", () => {
  const root = makeCheckout();
  try {
    // A DIRECTORY at MASTER-PLAN.md: `existsSync` says yes, `readFileSync` throws EISDIR — the
    // exists-but-unreadable shape the degradation arm is written for.
    mkdirSync(join(root, "MASTER-PLAN.md"), { recursive: true });
    assert.equal(netStateAdvisorySectionFor(root), "", "an unreadable MASTER-PLAN.md degrades to no section, never a throw");

    // Absent file: also empty, and by the OTHER path (existsSync false) — so the two
    // degradations are not the same branch wearing two hats.
    assert.equal(netStateAdvisorySectionFor(join(root, "nope")), "");

    // A readable MASTER-PLAN.md with no NET STATE heading is still empty...
    writeFileSync(join(root, "other.md"), "# nothing\n", "utf8");
    rmSync(join(root, "MASTER-PLAN.md"), { recursive: true, force: true });
    writeFileSync(join(root, "MASTER-PLAN.md"), "# Plan\n\n## SOMETHING ELSE\n\nno net state here\n", "utf8");
    assert.equal(netStateAdvisorySectionFor(root), "");

    // ...and one WITH the heading produces a real section, proving the empty results above are
    // the degradation and not the function simply never working.
    writeFile(root, "src/lib/claimed.ts", "export function claimedFeature(): number {\n  return 1;\n}\n");
    writeFileSync(
      join(root, "MASTER-PLAN.md"),
      "# Plan\n\n## NET STATE\n\n- ships `claimedFeature` today\n\n## AFTER\n\ntail\n",
      "utf8",
    );
    const section = netStateAdvisorySectionFor(root);
    assert.match(section, /SHIPS-UNWIRED — NET STATE capability claims/);
    assert.match(section, /claimedFeature/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReview ledgers one review.unwired_advisory line per advisory, and none when the scan finds nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-unwired-review-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-unwired-gh-"));
  const checkoutDir = makeCheckout();
  const oldPath = process.env.PATH;
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const ledgerPath = join(root, "state", "ledger.ndjson");
    writeFileSync(join(root, "settings.json"), "{}", "utf8");

    // The head checkout carries an ADDED export nothing reaches — the `unwired_export` shape.
    writeFile(checkoutDir, "src/lib/stranded.ts", "export function strandedFn(): number {\n  return 1;\n}\n");
    const diff = [
      "diff --git a/src/lib/stranded.ts b/src/lib/stranded.ts",
      "+++ b/src/lib/stranded.ts",
      "@@",
      "+export function strandedFn(): number {",
      "+  return 1;",
      "+}",
    ].join("\n");

    // `gh` stub: the diff above is what the review path scans.
    writeFileSync(
      join(binDir, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "api "*)
    # runReview reads the head sha over REST now, not pr view --json headRefOid.
    # Answered in REST's own shape (mapRestPr reads head.sha), same sha as below.
    # No backticks in here: this script sits inside a JS template literal.
    case "$*" in
      *pulls/*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"deadbeefcafe01"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"deadbeefcafe01"}' ;;
      *state*) echo '{"state":"OPEN"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") cat <<'DIFF'
${diff}
DIFF
    ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${oldPath}`;

    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const runOnce = async (headCheckoutDir?: string) => {
      lines.length = 0;
      await runReview({
        owner: "acme",
        repo: "remudero",
        prUrl: "https://github.com/acme/remudero/pull/1292",
        task: { id: "W1-T322", acceptance: SIMPLE_CRITERIA },
        report: SIMPLE_REPORT,
        settingsFile: join(root, "settings.json"),
        config: { claudeBin: "/bin/true", root } as Config,
        log: (step: string, extra: Record<string, unknown> = {}) => void lines.push({ step, extra: extra ?? {} }),
        say: () => {},
        account: (r: WorkerResult) => r,
        spawnReviewer: false,
        reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 },
        headCheckoutDir,
        ledgerPath,
        runId: "REVIEW-UNWIRED-1",
        // W1-T2347: this fixture is about the SHIPS-UNWIRED advisory, not arming — it never
        // asserted on arm/disarm before and does not now. `disarm` is supplied explicitly so
        // `withdrawArmIfVerdictRefuses`'s refused-verdict branch never falls through to the real
        // `disarmAutoMerge` default, which armAutoMergeDetailed's own new seam requirement (see
        // requireExplicitArmSeam) now refuses to reach from a test with no seam.
        disarm: () => "not-armed" as const,
      });
      return {
        advised: lines.filter((l) => l.step === "review.unwired_advisory"),
        posted: lines.find((l) => l.step === "review.posted"),
      };
    };

    const withCheckout = await runOnce(checkoutDir);

    assert.equal(withCheckout.advised.length, 1, "one ledger line for the one advisory the scan produced");
    assert.equal(
      withCheckout.advised[0].extra.reason_code,
      "unwired_export",
      "the line carries the reason code W1-T323 will measure",
    );
    assert.deepEqual(withCheckout.advised[0].extra.symbols, ["src/lib/stranded.ts::strandedFn"], "and the offending symbol");
    assert.equal(withCheckout.advised[0].extra.head_sha, "deadbeefcafe01", "attributed to the head sha it scanned");
    assert.equal(withCheckout.advised[0].extra.pr_url, "https://github.com/acme/remudero/pull/1292");
    // W1-T1118: the SAME already-existing review.posted row now names what the scan examined —
    // no second ledger line. One export was examined, and it was flagged (not cleared).
    assert.equal(
      withCheckout.posted?.extra.reachability_scanned,
      1,
      "review.posted carries the examined count alongside the advisory it just ledgered above",
    );

    // CONTROL: no headCheckoutDir -> no scan -> the loop body never runs. Without this, a test
    // asserting only the presence of lines could pass on a loop that ran unconditionally.
    const withoutCheckout = await runOnce(undefined);
    assert.deepEqual(withoutCheckout.advised, [], "no checkout to scan ledgers no advisory at all");
    // W1-T1118: this is exactly the state the reporting entry could not tell apart from "scanned
    // 0" — `null`, never a fake 0, on the SAME review.posted row the case above also populated.
    assert.equal(
      withoutCheckout.posted?.extra.reachability_scanned,
      null,
      "no checkout ⇒ null on review.posted, never a count of zero",
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});
