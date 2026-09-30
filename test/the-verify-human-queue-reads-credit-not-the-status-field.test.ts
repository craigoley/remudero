/**
 * W1-T4860: the verify-human queue reads CREDIT, not the decorative yaml `status:`.
 *
 * `parkedVerifyHumanShards` filtered on the raw `status: queued` and judged dependencies by
 * `status === "merged"`, so W1-T3102/W1-T3103 — executed and credited (`pr:`) on 2026-09-22 — were
 * re-judged daily. The queue and its `depsAllMerged` now read the same landed-ness the dispatcher does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkedVerifyHumanShards } from "../src/run-task.js";
import { loadPlan } from "../src/lib/plan.js";

const clock = { now: () => Date.UTC(2026, 8, 30), date: () => new Date(Date.UTC(2026, 8, 30)), iso: () => "2026-09-30T00:00:00.000Z" };

function shard(id: string, extra: string[] = [], status = "queued", verify = "human"): string[] {
  return [
    `- id: ${id}`,
    `  title: "ruling ${id}"`,
    "  repo: remudero",
    "  type: implement",
    `  verify: ${verify}`,
    "  files: [DECISIONS.md]",
    `  status: ${status}`,
    "  depends_on: []",
    ...extra,
  ];
}

function planOf(blocks: string[][]) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t4860-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), blocks.flat().join("\n") + "\n", "utf8");
  return { root, plan: loadPlan(join(root, "plan", "tasks.yaml")) };
}

test("W1-T4860: a credited ruling shard is not judged again", () => {
  const { root, plan } = planOf([shard("W1-T9101", ["  pr: 6561"]), shard("W1-T9102"), shard("W1-T9103")]);
  const ids = parkedVerifyHumanShards(plan, root, clock, new Set(["W1-T9103"])).map((s) => s.id);
  assert.ok(!ids.includes("W1-T9101"), "a shard credited by `pr:` must not be queued for judgement");
  assert.ok(!ids.includes("W1-T9103"), "a shard credited by a ledger merge must not be queued for judgement");
  assert.ok(ids.includes("W1-T9102"), "an uncredited queued ruling is still judged");
});

test("W1-T4860: a done dependency counts as landed", () => {
  const dependent = shard("W1-T9111");
  dependent[dependent.length - 1] = "  depends_on: [W1-T9110, W1-T9112]";
  const { root, plan } = planOf([shard("W1-T9110", [], "done", "auto"), shard("W1-T9112", ["  pr: 6561"], "queued", "auto"), dependent]);
  const s = parkedVerifyHumanShards(plan, root, clock).find((x) => x.id === "W1-T9111");
  assert.ok(s, "the dependent ruling is queued");
  assert.equal(s.depsAllMerged, true, "a `done` dependency and a `pr:`-credited dependency both count as landed");
});

test("W1-T4860: an uncredited queued dependency is still not landed", () => {
  const dependent = shard("W1-T9121");
  dependent[dependent.length - 1] = "  depends_on: [W1-T9120]";
  const { root, plan } = planOf([shard("W1-T9120", [], "queued", "auto"), dependent]);
  const s = parkedVerifyHumanShards(plan, root, clock).find((x) => x.id === "W1-T9121");
  assert.equal(s?.depsAllMerged, false);
});
