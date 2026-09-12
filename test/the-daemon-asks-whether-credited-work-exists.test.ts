import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DaemonDeps } from "../src/lib/daemon.js";
import type { CreditTruthAudit, CreditTruthFinding } from "../src/lib/credit-truth-rung.js";

// ── the rung must be REACHED from the tick, not only unit-tested ─────────────────────────────────
//
// A reconciler nothing calls is the defect it was written to fix. These tests drive the real
// `runDaemon` loop and assert on the rows it emits.

async function creditRows(deps: Partial<DaemonDeps>): Promise<Array<{ step: string; extra?: Record<string, unknown> }>> {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-ctr-"));
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    let stopChecks = 0;
    let dispatches = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      // ONE LINE on purpose. A fake that is never called still contributes its BODY as added lines
      // that no test enters, which `diff-coverage` flags — correctly, and a throwing body or a counter
      // body are both flagged the same way. A single-expression arrow is covered by the object
      // literal's own evaluation, and `dispatches` below still proves it was never entered.
      runOne: async () => ((dispatches += 1), undefined as never),
      checkStop: () => {
        stopChecks += 1;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
      ...deps,
    });
    assert.equal(dispatches, 0, "these cycles dispatch no task, so the credit rung is what the rows describe");
    return rows.filter((r) => r.step.startsWith("credit_truth"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIRES = { fire: true as const, reason: "no prior credit-truth audit recorded" };
const BROKEN: CreditTruthFinding = {
  taskId: "W1-T2924",
  verdict: "unshipped",
  declared: ["src/run-task.ts", "src/lib/audit.ts"],
  missing: ["src/lib/audit.ts"],
  creditedBy: "c8892b5b6",
};
const audit = (over: Partial<CreditTruthAudit> = {}): CreditTruthAudit => ({
  findings: [BROKEN],
  unshipped: [BROKEN],
  creditElsewhere: [],
  counts: { shipped: 802, "credit-elsewhere": 5, unshipped: 14, "plan-only": 4, undeterminable: 0, checked: 825 },
  ...over,
});

test("a firing decision audits once and escalates the bounded slice, carrying THAT decision's reason", async () => {
  const delivered: string[] = [];
  let audits = 0;
  const rows = await creditRows({
    checkCreditTruth: () => FIRES,
    runCreditTruthAudit: async () => {
      audits += 1;
      return audit();
    },
    onBrokenCredit: (f) => {
      delivered.push(...f.map((x) => x.taskId));
    },
  });
  assert.equal(audits, 1, "a firing decision must invoke the audit exactly once per cycle");
  assert.deepEqual(delivered, ["W1-T2924"], "the actionable finding must reach the deliverer");
  assert.deepEqual(rows.map((r) => r.step), ["credit_truth.fired", "credit_truth.ran", "credit_truth.escalated"]);
  const ran = rows[1].extra ?? {};
  assert.equal(ran.reason, FIRES.reason, "the reason travels with the outcome, never re-derived");
  assert.equal(ran.checked, 825, "the healthy counts are recorded too, not just the findings");
  assert.equal(ran.shipped, 802);
  assert.equal(ran.unshipped, 14);
  assert.deepEqual(rows[2].extra?.task_ids, ["W1-T2924"]);
});

test("a CLEAN audit is logged, so 'nothing broken' is distinguishable from 'never ran'", async () => {
  let deliveries = 0;
  const rows = await creditRows({
    checkCreditTruth: () => FIRES,
    runCreditTruthAudit: async () =>
      audit({ findings: [], unshipped: [], counts: { shipped: 825, "credit-elsewhere": 0, unshipped: 0, "plan-only": 0, undeterminable: 0, checked: 825 } }),
    onBrokenCredit: () => void (deliveries += 1),
  });
  assert.equal(deliveries, 0, "nothing actionable must reach the deliverer at all");
  assert.deepEqual(rows.map((r) => r.step), ["credit_truth.fired", "credit_truth.ran", "credit_truth.clean"]);
  assert.equal(rows[2].extra?.checked, 825);
});

test("the tick applies the escalation BOUND, not the whole unshipped set", async () => {
  // M3 CAUGHT A REAL GAP HERE. With a single-finding fixture, `slice(0, 3)` and the full list are
  // identical, so replacing the bounded call with `audit.unshipped` killed nothing and the tick-side
  // bound was asserted by nothing. The fixture must exceed the bound for this to mean anything.
  const { DEFAULT_CREDIT_TRUTH_TRIGGER } = await import("../src/lib/credit-truth-rung.js");
  const many: CreditTruthFinding[] = Array.from({ length: 9 }, (_, i) => ({
    ...BROKEN,
    taskId: `W1-T90${i}`,
  }));
  const delivered: string[] = [];
  const rows = await creditRows({
    checkCreditTruth: () => FIRES,
    runCreditTruthAudit: async () => audit({ findings: many, unshipped: many }),
    onBrokenCredit: (f) => {
      delivered.push(...f.map((x) => x.taskId));
    },
  });
  assert.equal(
    delivered.length,
    DEFAULT_CREDIT_TRUTH_TRIGGER.maxEscalationsPerFire,
    "the tick must deliver the BOUNDED slice, or the first run buries the 17-issue steady state under 14",
  );
  assert.ok(delivered.length < many.length, "the bound must actually bind at the tick level");
  assert.equal(rows[2].extra?.delivered, DEFAULT_CREDIT_TRUTH_TRIGGER.maxEscalationsPerFire);
  assert.equal(rows[2].extra?.of_unshipped, 14, "the row still names the full population, not just the slice");
});

test("a throttled tick says so, and never audits", async () => {
  let audits = 0;
  const rows = await creditRows({
    checkCreditTruth: () => ({ fire: false, reason: "throttled — last credit-truth audit 60s ago, interval 21600s" }),
    runCreditTruthAudit: async () => ((audits += 1), audit()),
  });
  assert.equal(audits, 0);
  assert.deepEqual(rows.map((r) => r.step), ["credit_truth.skipped"]);
  assert.match(String(rows[0].extra?.reason), /throttled/);
});

test("a failed escalation keeps the finding on the record instead of discarding it", async () => {
  // THE POINT: the next tick is throttled for hours, so a swallowed delivery failure loses the finding
  // entirely. The row must name what was pending and which tasks.
  const rows = await creditRows({
    checkCreditTruth: () => FIRES,
    runCreditTruthAudit: async () => audit(),
    onBrokenCredit: () => {
      throw new Error("issue API refused");
    },
  });
  assert.deepEqual(rows.map((r) => r.step), ["credit_truth.fired", "credit_truth.ran", "credit_truth.escalation_failed"]);
  assert.equal(rows[2].extra?.pending, 1);
  assert.deepEqual(rows[2].extra?.task_ids, ["W1-T2924"]);
  assert.match(String(rows[2].extra?.error), /refused/);
  assert.equal(rows[1].step, "credit_truth.ran", "the audit result survives a delivery fault");
});

test("a throwing check is a row, not a crash — the rung can never take the daemon down", async () => {
  const rows = await creditRows({
    checkCreditTruth: () => {
      throw new Error("plan unreadable");
    },
    runCreditTruthAudit: async () => audit(),
  });
  assert.deepEqual(rows.map((r) => r.step), ["credit_truth.check_failed"]);
  assert.match(String(rows[0].extra?.error), /plan unreadable/);
});

test("an undeterminable audit is its own row, never silence or a false clean", async () => {
  const rows = await creditRows({
    checkCreditTruth: () => FIRES,
    runCreditTruthAudit: async () => undefined,
  });
  assert.deepEqual(rows.map((r) => r.step), ["credit_truth.fired", "credit_truth.undeterminable"]);
});

test("a host that wires nothing behaves exactly as before — no rows at all", async () => {
  assert.deepEqual(await creditRows({}), []);
});
