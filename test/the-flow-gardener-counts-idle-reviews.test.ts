// W1-T9048 — a review re-run on a head reached only by a base merge is an idle review.
import assert from "node:assert/strict";
import { test } from "node:test";

import { flowPrs, flowSamples } from "#src/lib/flow-gardener.js";

const T0 = Date.parse("2026-10-06T00:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const URL = "https://github.com/acme/remudero/pull/7";
type Row = Record<string, unknown>;

const review = (min: number, head: string, extra: Row = {}): Row =>
  ({ ts: at(min), task_id: "W1-T7", step: "review.posted", state: "success", pr_url: URL, head_sha: head, review_contract_digest: "c1", own_diff_digest: "d1", ...extra });
const update = (min: number, expected: string, via: string): Row =>
  ({ ts: at(min), task_id: "W1-T7", step: "sweep.update_branch.updated", pr_number: 7, pr_url: URL, expected_head_sha: expected, via });
const base = (): Row[] => [
  { ts: at(0), task_id: "W1-T7", step: "pr.opened", pr_url: URL, head_sha: "h0" },
  { ts: at(500), task_id: "W1-T7", step: "pr.terminal", state: "merged", merged_at: at(500), pr_url: URL },
];
const idle = (rows: Row[]) => flowSamples(flowPrs(rows), () => undefined).filter((s) => s.key.includes("idle_reviews"));

test("W1-T9048: idle_reviews counts reviews across base merges with an unchanged own diff", () => {
  const rows = [...base(), review(10, "h0"), update(20, "h0", "sweep"), review(30, "h1"), update(40, "h1", "sweep"), review(50, "h2")];
  const out = idle(rows);
  assert.equal(out.find((s) => s.key === "code:idle_reviews:all")?.value, 2);
  assert.equal(out.find((s) => s.key === "code:idle_reviews:via:sweep")?.value, 2);
});

test("W1-T9048: a review after a fix push is not idle", () => {
  const rows = [...base(), review(10, "h0"), { ts: at(15), task_id: "W1-T7", step: "fix.done", pushed_head_sha: "h1" },
    update(20, "h0", "sweep"), review(30, "h1", { own_diff_digest: "d2", review_contract_digest: "c2" })];
  const out = idle(rows);
  assert.equal(out.find((s) => s.key === "code:idle_reviews:all")?.value, 0);
  assert.equal(out.filter((s) => s.key.includes(":via:")).length, 0);
});
