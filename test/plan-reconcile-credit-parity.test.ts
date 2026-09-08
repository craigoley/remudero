import assert from "node:assert/strict";
import { test } from "node:test";

import { creditIsReconcilable } from "../src/run-task.js";
import { reconcilePlan } from "../src/lib/plan-reconcile.js";

// W1-T3084 — the sweep's credit rung declines `creditIsImplementation !== true` (sweep.ts:1347).
// `defaultCreditedMergedIds` filtered on `.merged` alone, so the verb that WRITES `status: merged`
// was strictly more permissive than the read-only rung auditing it. MEASURED on the real plan:
// 1036 shards as shipped, 953 with this rule — 83 apart, every one a write.

test("W1-T3084: the writing rung is not more permissive than the reading one", () => {
  assert.equal(creditIsReconcilable({ merged: true, creditIsImplementation: true }), true);
  assert.equal(creditIsReconcilable({ merged: true, creditIsImplementation: false }), false);
});

test("W1-T3084: undefined and false both decline", () => {
  // `undefined` means the merge subject fell outside the scanned window — nothing is known — and
  // reading it as a credit is how #4461 was closed against a `chore(plan)`.
  // NOT ASSERTED HERE, because it is not true: a `!!` mutation passes all of these, since for
  // `boolean | undefined` truthiness and `=== true` coincide. The strict form is intent, not a
  // guard, and the control run for this task recorded that rather than claiming a falsifier it has
  // no right to.
  assert.equal(creditIsReconcilable({ merged: true, creditIsImplementation: undefined }), false, "unknown is not yes");
  assert.equal(creditIsReconcilable({ merged: true, creditIsImplementation: false }), false, "a filing is not an implementation");
  assert.equal(creditIsReconcilable({ merged: true }), false, "an absent field is unknown, not yes");
});

test("W1-T3084: an implementation credit still reconciles — the fix narrows the set, never empties it", () => {
  assert.equal(creditIsReconcilable({ merged: true, creditIsImplementation: true }), true);
  // ...and `.merged` still has to hold: a non-merged implementation is not a credit.
  assert.equal(creditIsReconcilable({ merged: false, creditIsImplementation: true }), false);
  assert.equal(creditIsReconcilable({ creditIsImplementation: true }), false, "absent merged is not merged");
});

test("W1-T3084: the W1-T3043 guarantees survive the stricter credit set", () => {
  // Re-asserted against the STRICTER set rather than assumed to survive it. One-way (queued only),
  // retirement untouchable, and darkness declines — driven through the real reconcilePlan.
  const shard = (id: string, status: string) => ({ taskId: id, text: `- id: ${id}\n  status: ${status}\n` });
  const strict = (id: string) => creditIsReconcilable(
    id === "W1-T1" ? { merged: true, creditIsImplementation: true } :
    id === "W1-T2" ? { merged: true, creditIsImplementation: false } :
    { merged: true },
  );
  const r = reconcilePlan(
    [shard("W1-T1", "queued"), shard("W1-T2", "queued"), shard("W1-T3", "queued"), shard("W1-T4", "retired")],
    strict,
  );
  assert.deepEqual(r.writes.map((w) => w.taskId), ["W1-T1"], "only the implementation credit flips");
  assert.match(r.writes[0].text, /status: merged/);
  // ONE-WAY: a retired shard is never touched, whatever the credit says.
  assert.equal(r.writes.some((w) => w.taskId === "W1-T4"), false);
  // DARKNESS DECLINES: W1-T3's credit is unknown under the strict rule and it stays queued.
  assert.equal(r.writes.some((w) => w.taskId === "W1-T3"), false);
});

test("W1-T3084: the permissive rule would have flipped the two the strict rule declines", () => {
  // THE POSITIVE CONTROL: without it, the four assertions above could pass against a reconcilePlan
  // that flips nothing at all. This drives the SAME shards through the OLD `.merged`-only rule.
  const shard = (id: string, status: string) => ({ taskId: id, text: `- id: ${id}\n  status: ${status}\n` });
  const permissive = () => true; // what `.filter((c) => c.merged)` amounted to for a merged candidate
  const r = reconcilePlan(
    [shard("W1-T1", "queued"), shard("W1-T2", "queued"), shard("W1-T3", "queued")],
    permissive,
  );
  assert.deepEqual(r.writes.map((w) => w.taskId).sort(), ["W1-T1", "W1-T2", "W1-T3"],
    "all three — which is the 83-shard gap, in miniature");
});
