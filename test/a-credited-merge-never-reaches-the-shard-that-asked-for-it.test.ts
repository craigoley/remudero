// W1-T3043 — 253 of 254 shards carrying a durable merged credit still read `status: queued`,
// because the credit projection is the only completion signal and nothing writes it back. These
// tests drive the reconciler's real decision table; the credit predicate is injected, so every arm
// is exercised without a repo or a GitHub gateway.
//
// THE ONE-WAY PROPERTY IS THE POINT. A symmetric reconciler run during a GitHub outage would read
// every task as uncredited and silently reopen the whole plan.

import assert from "node:assert/strict";
import test from "node:test";

import {
  RECONCILE_TO_STATUS,
  reconcilePlan,
  reconcileShardStatus,
} from "../src/lib/plan-reconcile.js";

/** A shard with the real field order, so the byte-identity assertions mean something. */
function shard(over: { status?: string; retirement?: string; extra?: string } = {}): string {
  return [
    "- id: W1-T1234",
    '  title: "A TASK THAT SHIPPED — with a $ sign and a `backtick` in its prose"',
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  budget_usd: 10.00",
    "  files: [src/lib/x.ts, test/x.test.ts]",
    `  status: ${over.status ?? "queued"}`,
    ...(over.retirement ? [`  retirement: ${over.retirement}`] : []),
    "  attempts: 3",
    "  acceptance:",
    '    - claim: "it works"',
    '      proof: "unit test: test/x.test.ts"',
    "  note: |",
    "    A note mentioning status: queued in prose, which must NOT be rewritten.",
    ...(over.extra ? [`    ${over.extra}`] : []),
    "",
  ].join("\n");
}

const merged = () => true;
const notMerged = () => false;

test("W1-T3043 criterion 1: a queued shard with a positive credit becomes merged", () => {
  const out = reconcileShardStatus(shard(), "W1-T1234", merged);
  assert.ok(out.text, "a credited queued shard must be rewritten");
  assert.match(out.text, /^ {2}status: merged$/m);
  assert.equal(RECONCILE_TO_STATUS, "merged", "the vocabulary matches the ledger verdict");
});

test("W1-T3043 criterion 4: EVERY OTHER BYTE IS UNCHANGED", () => {
  // Not merely "the status line changed" — the whole rest of the shard must be identical, because
  // a criterion edit across a 253-file diff would trip Standing rule 15 on every shard at once.
  const before = shard();
  const after = reconcileShardStatus(before, "W1-T1234", merged).text!;
  assert.equal(after, before.replace("  status: queued", "  status: merged"));
  // and the prose mentioning "status: queued" inside the note survives verbatim
  assert.match(after, /A note mentioning status: queued in prose/);
  assert.match(after, /\$ sign and a `backtick`/, "a $ in prose must survive String.replace");
  assert.match(after, /^ {2}attempts: 3$/m, "attempts must not move");
});

test("W1-T3043 criterion 3 (falsifier): THE REVERSE DIRECTION IS IMPOSSIBLE", () => {
  // THE ROW THAT MATTERS. If this function were symmetric, a GitHub outage reading every task as
  // uncredited would reopen the entire plan.
  const alreadyMerged = shard({ status: "merged" });
  assert.deepEqual(reconcileShardStatus(alreadyMerged, "W1-T1234", notMerged), {
    skipped: "status-not-queued",
  });
  assert.deepEqual(reconcileShardStatus(alreadyMerged, "W1-T1234", merged), {
    skipped: "status-not-queued",
  });
});

test("W1-T3043 criterion 3: blocked and retired shards are never rewritten", () => {
  assert.deepEqual(reconcileShardStatus(shard({ status: "blocked" }), "W1-T1234", merged), {
    skipped: "status-not-queued",
  });
  // A retirement is an operator act; a credit must never overwrite one.
  assert.deepEqual(reconcileShardStatus(shard({ retirement: "retired" }), "W1-T1234", merged), {
    skipped: "retired",
  });
});

test("W1-T3043 criterion 2 (falsifier): DARKNESS IS INERT IN EVERY FORM", () => {
  const s = shard();
  const cases: Array<[string, () => boolean | undefined]> = [
    ["a negative credit", notMerged],
    ["an undefined credit", () => undefined],
    ["a throwing predicate", () => { throw new Error("github unreachable"); }],
  ];
  for (const [label, predicate] of cases) {
    const out = reconcileShardStatus(s, "W1-T1234", predicate);
    assert.equal(out.text, undefined, `${label}: must not rewrite`);
    assert.ok(out.skipped, `${label}: must name why it declined`);
  }
});

test("W1-T3043 criterion 2: a shard with no status field is declined, not defaulted", () => {
  const noStatus = shard().replace(/^ {2}status: queued$/m, "");
  assert.deepEqual(reconcileShardStatus(noStatus, "W1-T1234", merged), { skipped: "no-status-field" });
});

test("W1-T3043: the fold reports what it did and what it declined, per cause", () => {
  const { summary, writes } = reconcilePlan(
    [
      { taskId: "A", text: shard() },
      { taskId: "B", text: shard() },
      { taskId: "C", text: shard({ status: "merged" }) },
      { taskId: "D", text: shard({ retirement: "retired" }) },
    ],
    (id) => id !== "B",
  );
  assert.deepEqual(summary.rewritten, ["A"]);
  assert.equal(writes.length, 1);
  assert.equal(summary.skipped["not-credited-merged"], 1);
  assert.equal(summary.skipped["status-not-queued"], 1);
  assert.equal(summary.skipped.retired, 1);
});

test("W1-T3043: the dry run and the real run share ONE decision path", () => {
  // reconcilePlan is pure and returns the writes rather than performing them, so a preview cannot
  // disagree with what a subsequent apply would do — they are the same call.
  const shards = [{ taskId: "A", text: shard() }];
  const first = reconcilePlan(shards, merged);
  const second = reconcilePlan(shards, merged);
  assert.deepEqual(first.writes, second.writes);
  assert.deepEqual(first.summary, second.summary);
});
