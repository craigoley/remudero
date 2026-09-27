// W1-T4602: #5031 made Standing rule 25 (instrument entanglement) advisory, but failSummary kept checking it ahead
// of every blocking reason. On 2026-09-26 #7365's review FAILED on an unmarked DECISIONS.md entry alone, yet its
// summary said "entangled: … split it" — which sweep.ts reads as an unsatisfiable gate needing a split worker.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { failSummary, judgeReview } from "../src/lib/review.js";

const CLEAN_PLAN_LINT = { ran: true as const, label: "fixture", checked: 1, violations: [] };
const CRITERIA: AcceptanceCriterion[] = [{ claim: "the change is safe", proof: "widget frobnicate implemented" }];
const REPORT = "REPORT\n- widget frobnicate implemented and verified.\nPR_URL: https://github.com/o/r/pull/1";
const ENTANGLEMENT = { instrumentPaths: ["scripts/coverage-ratchet.mjs"], srcPaths: ["src/lib/widget.ts"] };

// #7365's shape: an instrument edited beside src/, plus a new DECISIONS.md entry with no provenance mark.
const ENTANGLED_WITH_UNMARKED_DECISION = `
diff --git a/scripts/coverage-ratchet.mjs b/scripts/coverage-ratchet.mjs
+++ b/scripts/coverage-ratchet.mjs
@@
-const FLOOR = 89.64;
+const FLOOR = 82.75;
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
diff --git a/DECISIONS.md b/DECISIONS.md
+++ b/DECISIONS.md
@@
+## 2026-09-26 — W1-T4583: the in-repo ratchet is RETIRED
+
+This entry records a binding change with no provenance mark anywhere in it.
`.trim();

test("W1-T4602: a failing review with an advisory entanglement and an unprovenanced DECISIONS entry or an unmet criterion names the blocking cause, while an entanglement alone is still named", () => {
  const v = judgeReview(CRITERIA, { planLint: CLEAN_PLAN_LINT, diff: ENTANGLED_WITH_UNMARKED_DECISION, report: REPORT });
  assert.equal(v.state, "failure");
  assert.equal(v.instrumentEntangled, true, "the advisory is still recorded on the verdict");
  assert.match(v.summary, /DECISIONS\.md entry added with no provenance mark/, "the summary names the real blocker");
  assert.doesNotMatch(v.summary, /entangled: instrument path/, "and never the advisory the sweep would route to a split worker");

  // Every blocking reason outranks the advisory, not only the DECISIONS mark.
  assert.match(failSummary(["the change is safe"], false, false, false, 0, [], ENTANGLEMENT), /unmet: the change is safe/);
  assert.match(failSummary([], false, false, false, 1, [], ENTANGLEMENT), /holdout criterion unmet/);
  assert.match(failSummary([], true, false, false, 0, [], ENTANGLEMENT), /test theater/);

  // W1-T297's taught resolution survives when the entanglement is the only thing to name.
  const alone = failSummary([], false, false, false, 0, [], ENTANGLEMENT);
  assert.match(alone, /entangled: instrument path\(s\) scripts\/coverage-ratchet\.mjs/);
  assert.match(alone, /own PR/);
});
