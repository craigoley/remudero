import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadPlan } from "../src/lib/plan.js";
import { auditMergedTaskClaims } from "../src/lib/review.js";
import type { ProofExecutor, WhitelistedProof } from "../src/lib/review.js";

/**
 * W1-T302: a claim-level audit over MERGED tasks. Merge credit is derived per TASK,
 * never per CRITERION — so a task whose PR satisfied only SOME of its acceptance
 * criteria reads identically to one that satisfied all of them once it is merged.
 * `auditMergedTaskClaims` (src/lib/review.ts) reuses the reviewer's OWN
 * parser+executor (`parseWhitelistedProof`/`judgeCriterion` — the same machinery
 * `rmd check-proof` runs) rather than a second, independently-written matcher.
 */

const REAL_PLAN = loadPlan(fileURLToPath(new URL("../plan/tasks.yaml", import.meta.url)));

test("auditMergedTaskClaims runs every executable proof through the injected executor and lists a merged task's unresolved/failing claims (acceptance 1)", () => {
  const tasks = [
    {
      id: "T-pass",
      acceptance: [{ claim: "a shipped thing", proof: "grep: keepMe in src/lib/bar.ts" }],
    },
    {
      id: "T-fail",
      acceptance: [{ claim: "a claim the repo state refutes", proof: "grep: neverLanded in src/lib/bar.ts" }],
    },
    {
      id: "T-unresolved",
      acceptance: [
        { claim: "a stale/renamed test", proof: "unit test: the retry loop backs off, waiting longer each time" },
      ],
    },
  ];
  const seen: WhitelistedProof[] = [];
  const exec: ProofExecutor = (w) => {
    seen.push(w);
    if (w.label.includes("neverLanded")) return "fail";
    if (w.label.includes("retry loop")) return "no-match";
    return "pass";
  };

  const report = auditMergedTaskClaims(tasks, "/tmp/does-not-matter", exec);

  // Every executable proof actually ran through the injected executor — the SAME
  // parser/executor seam the reviewer's own gate uses, never a re-implemented matcher.
  assert.equal(seen.length, 3);
  assert.equal(report.tasksAudited, 3);
  assert.equal(report.executableClaimsChecked, 3);

  // Only the unresolved-or-failing claims are reported; a cleanly passing proof is
  // never listed as a finding.
  const findingIds = report.findings.map((f) => f.taskId).sort();
  assert.deepEqual(findingIds, ["T-fail", "T-unresolved"]);
  assert.ok(!findingIds.includes("T-pass"));

  const failFinding = report.findings.find((f) => f.taskId === "T-fail");
  assert.equal(failFinding?.proofExec, "executed_fail");
  assert.match(failFinding!.reason, /FAILED/);

  const unresolvedFinding = report.findings.find((f) => f.taskId === "T-unresolved");
  assert.equal(unresolvedFinding?.proofExec, "not_executable");
  assert.match(unresolvedFinding!.reason, /matches nothing on the current checkout/);
});

test("auditMergedTaskClaims reports a prose proof as uncheckable, never as passing (acceptance 2)", () => {
  const tasks = [
    {
      id: "T-prose",
      acceptance: [
        { claim: "the retry loop backs off sensibly", proof: "the worker waits longer each time it retries" },
      ],
    },
  ];
  // A prose proof must never even reach the executor — `parseWhitelistedProof`
  // refuses it (null) before any exec is attempted, so an executor that throws
  // when called proves the uncheckable bucket is populated WITHOUT execution,
  // never by running something and discarding a pass.
  const exec: ProofExecutor = () => {
    throw new Error("must not execute a prose proof");
  };

  const report = auditMergedTaskClaims(tasks, "/tmp/does-not-matter", exec);

  assert.equal(report.uncheckable.length, 1);
  assert.equal(report.uncheckable[0].taskId, "T-prose");
  assert.equal(report.findings.length, 0);
  // Not silently counted toward "checked" either — uncheckable is its own bucket,
  // never folded into the executable-claims count.
  assert.equal(report.executableClaimsChecked, 0);
});

test("auditMergedTaskClaims marks BOTH of W1-T64's real acceptance claims uncheckable — nothing in the system can see whether its commitsAhead guard claim shipped (acceptance 3)", () => {
  const w1t64 = REAL_PLAN.tasks.find((t) => t.id === "W1-T64");
  assert.ok(w1t64, "W1-T64 must still be a real task in plan/tasks.yaml");
  assert.ok(w1t64!.acceptance && w1t64!.acceptance.length === 2, "W1-T64 carries exactly two acceptance claims");

  const guardClaim = w1t64!.acceptance!.find((c) => c.claim.includes("commitsAhead"));
  assert.ok(guardClaim, "W1-T64's second claim (the commitsAhead guard) must be present");

  const exec: ProofExecutor = () => {
    throw new Error("must not execute a prose proof");
  };
  const report = auditMergedTaskClaims([w1t64!], "/tmp/does-not-matter", exec);

  // BOTH of W1-T64's claims are prose (no `grep:`/`unit test:` dialect prefix) —
  // the audit cannot resolve either one, pass or fail. It reports them uncheckable
  // rather than mis-reporting the merged task as fully verified.
  assert.equal(report.uncheckable.length, 2);
  assert.equal(report.findings.length, 0);
  assert.equal(report.executableClaimsChecked, 0);
  assert.ok(
    report.uncheckable.some((u) => u.claim === guardClaim!.claim),
    "the commitsAhead guard claim specifically must be in the uncheckable bucket, never silently counted as passing",
  );
});
