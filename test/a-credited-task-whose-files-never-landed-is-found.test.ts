import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditCreditTruth,
  classifyCreditTruth,
  creditTruthEscalations,
  decideCreditTruthAudit,
  DEFAULT_CREDIT_TRUTH_TRIGGER,
  formatCreditTruthFinding,
  type CreditedTaskDeclaration,
} from "../src/lib/credit-truth-rung.js";

// ── the loss this rung exists to find ────────────────────────────────────────────────────────────
//
// W1-T2924 reads MERGED on main today and was never built: PR 4941 carried the implementation and was
// closed unmerged, PR 4975 (two scripts/ files and one test, no src/lib/audit.ts) carried
// `Remudero-Task: W1-T2924` and merged, and both declared deliverables are absent. The shard still
// reads `status: queued`, which is not a completion signal. Nothing noticed for days.
//
// The real shard's declared files, verbatim, so this fixture cannot drift into something easier:
const W1_T2924: CreditedTaskDeclaration = {
  taskId: "W1-T2924",
  files: ["src/run-task.ts", "src/lib/audit.ts", "docs/audits/README.md", "test/audit-command.test.ts"],
  creditedBy: "c8892b5b6 (#4975)",
  // What #4975 actually touched: two scripts/ files and one test, none of them declared by the task.
  shippedByCredit: [],
};

/** The tree as it actually is: run-task.ts exists, the audit verb never landed. */
const realTree = (p: string) => p === "src/run-task.ts";

test("the real W1-T2924 case escalates, even though a shared declared file exists", () => {
  // THE REGRESSION THIS PINS. Classifying on existence alone, this came out merely `partial`: the
  // shard names `src/run-task.ts`, which exists no matter what, and almost every shard names one like
  // it. The rung would have been silent on the exact loss it was written for. What makes it actionable
  // is that the crediting commit shipped NONE of the declared files.
  const f = classifyCreditTruth(W1_T2924, realTree);
  assert.equal(f.verdict, "unshipped", "a shared declared file existing must not mask the loss");
  assert.deepEqual(f.missing, ["src/lib/audit.ts", "docs/audits/README.md", "test/audit-command.test.ts"]);
  assert.ok(f.declared.includes("src/run-task.ts"), "the shared file is still examined, just not exculpatory");
});

test("the same tree, but the credit DID ship a declared file, is reported and never escalated", () => {
  // A rename or a restructure looks exactly like this, and escalating it is how a rung gets muted.
  const renamed = { ...W1_T2924, shippedByCredit: ["src/lib/audit.ts"] };
  const f = classifyCreditTruth(renamed, realTree);
  assert.equal(f.verdict, "credit-elsewhere");
  assert.ok(f.missing.length > 0, "files are still missing — it is the credit that is not suspect");
});

test("an UNKNOWN credit changeset is undeterminable, not unshipped", () => {
  // Absent evidence about what the credit shipped must not manufacture a finding, for the same reason
  // a throwing existence check does not.
  const unknown: CreditedTaskDeclaration = { taskId: "W1-T2924", files: W1_T2924.files };
  assert.equal(classifyCreditTruth(unknown, realTree).verdict, "undeterminable");
});

test("a credit whose files are all present is silent — the rung must not fire on a healthy tree", () => {
  const f = classifyCreditTruth(W1_T2924, () => true);
  assert.equal(f.verdict, "shipped");
  assert.deepEqual(f.missing, []);
});

test("a task declaring only plan paths is never a finding, because a plan-only PR really does build it", () => {
  // 99 of the 105 measured false-credit commits were plan-only diffs. If this arm were wrong the rung
  // would escalate the entire filing lane on its first tick.
  const filing: CreditedTaskDeclaration = {
    taskId: "W1-T9001",
    files: ["plan/tasks.d/W1-T9001-something.yaml", "MASTER-PLAN.md"],
  };
  const f = classifyCreditTruth(filing, () => false);
  assert.equal(f.verdict, "plan-only");
  assert.deepEqual(f.missing, [], "a plan path is filtered before the existence check, not reported absent");
});

test("an existence check that THROWS is undeterminable, never missing", () => {
  // The direction matters: manufacturing a finding from an I/O fault teaches an operator to ignore
  // this rung, which costs more than one skipped tick.
  const f = classifyCreditTruth(W1_T2924, () => {
    throw new Error("EIO");
  });
  assert.equal(f.verdict, "undeterminable");
  assert.deepEqual(f.missing, [], "an unreadable tree reports nothing missing");
});

test("the audit separates the actionable set from the record, and counts every verdict", () => {
  const audit = auditCreditTruth(
    [
      W1_T2924, // unshipped under realTree
      { taskId: "W1-T1", files: ["src/a.ts"], shippedByCredit: ["src/a.ts"] },
      { taskId: "W1-T2", files: ["src/run-task.ts"], shippedByCredit: [] },
      { taskId: "W1-T3", files: ["plan/tasks.d/x.yaml"], shippedByCredit: [] },
    ],
    realTree,
  );
  assert.equal(audit.counts.checked, 4);
  assert.deepEqual(
    audit.unshipped.map((f) => f.taskId),
    ["W1-T2924"],
    "only the credit that shipped none of its declared files is actionable",
  );
  // W1-T1's file is missing too, but its credit DID ship it — so it is a rename-shaped report, not an
  // escalation. Getting this expectation wrong first is exactly the false-positive the arm prevents.
  assert.deepEqual(audit.creditElsewhere.map((f) => f.taskId), ["W1-T1"]);
  assert.equal(audit.counts.shipped, 1, "W1-T2 declares only a file that exists");
  assert.equal(audit.counts["plan-only"], 1);
  assert.equal(audit.findings.length, 4, "the full record is kept, not just the findings");
});

test("escalations are BOUNDED, so the 105-case backlog cannot bury the 17-issue steady state", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    taskId: `W1-T${i}`,
    files: ["src/gone.ts"],
    shippedByCredit: [] as string[],
  }));
  const audit = auditCreditTruth(many, () => false);
  assert.equal(audit.unshipped.length, 40, "all 40 are findings");
  const out = creditTruthEscalations(audit);
  assert.equal(out.length, DEFAULT_CREDIT_TRUTH_TRIGGER.maxEscalationsPerFire);
  assert.ok(out.length < audit.unshipped.length, "the bound must actually bind");
});

test("the first tick fires, and a recent audit throttles with a reason that says which", () => {
  const now = 1_000_000_000;
  const first = decideCreditTruthAudit(undefined, now);
  assert.equal(first.fire, true);
  assert.match(first.reason, /no prior/);

  const throttled = decideCreditTruthAudit(now - 60_000, now);
  assert.equal(throttled.fire, false);
  assert.match(throttled.reason, /throttled/, "a throttled tick is a DIFFERENT state from nothing to do");

  const due = decideCreditTruthAudit(now - DEFAULT_CREDIT_TRUTH_TRIGGER.minIntervalMs - 1, now);
  assert.equal(due.fire, true);
  assert.match(due.reason, /due/);
});

test("a marker stamped in the FUTURE does not license an audit every tick", () => {
  const now = 1_000_000_000;
  const d = decideCreditTruthAudit(now + 60 * 60_000, now);
  assert.equal(d.fire, false, "a clock problem must read as just-fired, the conservative direction");
});

test("the finding formats into one actionable line naming the task, the credit and the missing files", () => {
  const line = formatCreditTruthFinding(classifyCreditTruth(W1_T2924, () => false));
  assert.match(line, /W1-T2924/);
  assert.match(line, /c8892b5b6 \(#4975\)/, "the line must name WHAT credited it, or nobody can act");
  assert.match(line, /src\/lib\/audit\.ts/);
  assert.match(line, /shipped NONE/, "it must say the credit is not evidence, not merely that files are absent");
  assert.match(line, /requeue/, "and say what to do about it");
});
