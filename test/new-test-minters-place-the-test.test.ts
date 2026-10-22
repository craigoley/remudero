/**
 * W1-T9875 (test restructure, letter E part 2): every minter of a NEW test puts it in the folder `placeTest` computes
 * (W1-T9874), never directly under test/. These suites drive the real minters and the real drafting lint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ciFrictionShardStem, ciFrictionShardYaml, type CiFrictionDraft } from "#src/lib/ci-friction-gardener.js";
import { flowFollowUpStem, renderFlowFollowUp, type FlowStageStat } from "#src/lib/flow-gardener.js";
import { draftShard, FLOW_LADDER, type FlowAction } from "#src/lib/flow-remedy-gardener.js";
import { hotFileShardStem, hotFileShardYaml } from "#src/lib/hot-file-gardener.js";
import { lintDraftedFragment } from "#src/lib/inbox.js";
import {
  computedTestFolder, isPlacedTestPath, loadPlanFromYaml, newTestPath, placementImports, placementSubsystemMap,
} from "#src/lib/plan.js";
import { scoutShard } from "#src/lib/scout-gardener.js";
import { selectorShadowStructuralTask, selectorShadowStructuralTestPath } from "#src/lib/selector-shadow-gardener.js";
import { placeTest } from "#src/lib/test-placement.js";

/** The test a rendered shard names last in files: — every machine minter appends its new test there (or before .gitattributes). */
function newTestOf(yaml: string): string {
  const files = loadPlanFromYaml(yaml, "minted").tasks[0]!.files ?? [];
  const tests = files.filter((f) => f.startsWith("test/"));
  assert.equal(tests.length, 1, `exactly one new test in ${files.join(", ")}`);
  return tests[0]!;
}

function assertPlaced(path: string, slug: string, srcFiles: readonly string[]): void {
  assert.ok(isPlacedTestPath(path), `${path} sits directly under test/ or in a folder the map does not name`);
  const computed = placeTest({ imports: placementImports(srcFiles), name: slug, kind: "unit" }, placementSubsystemMap());
  if (computed.confidence !== "none") assert.equal(path, `test/${computed.folder}/${slug}.test.ts`);
  assert.ok(path.endsWith(`/${slug}.test.ts`), `${path} keeps its slug ${slug}`);
}

const draftFragment = (files: string[], extra = "") => `- id: NEW-1
  title: check the placement of a new test
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  files: [${files.join(", ")}]
  design: |
    A change.${extra}
  acceptance:
    - claim: the placement is checked
      proof: "unit test: the placement is checked"
`;

const exists = (path: string): boolean => path === "src/lib/plan.ts" || path === "src/lib/inbox.ts";
const lint = (files: string[], extra = "") =>
  lintDraftedFragment(draftFragment(files, extra), "p-1", undefined, new Set(["remudero"]), exists, () => undefined, () => false, () => false);

test("W1-T9875: the drafting lint accepts a new test in its computed folder", () => {
  const slug = "check-the-placement-of-a-new-test";
  const folder = placeTest({ imports: placementImports(["src/lib/plan.ts"]), name: slug, kind: "unit" }, placementSubsystemMap()).folder;
  const path = `test/${folder}/${slug}.test.ts`;
  assert.ok(isPlacedTestPath(path));
  const checks = lint(["src/lib/plan.ts", path]).map((v) => v.check);
  assert.ok(!checks.includes("draft-path-missing"), checks.join(","));
  assert.ok(!checks.includes("draft-test-unplaced"), checks.join(","));
});

test("W1-T9875: the drafting lint refuses a flat or unmapped new test path", () => {
  const flat = lint(["src/lib/plan.ts", "test/check-the-placement-of-a-new-test.test.ts"]);
  assert.ok(flat.some((v) => v.check === "draft-test-unplaced" && v.severity === "block"), JSON.stringify(flat));
  const unmapped = lint(["src/lib/plan.ts", "test/not-a-folder/check-the-placement-of-a-new-test.test.ts"]);
  assert.ok(unmapped.some((v) => v.check === "draft-test-unplaced"), JSON.stringify(unmapped));
  // A CREATES: declaration does not launder a flat path.
  const created = lint(["src/lib/plan.ts", "test/a-flat-created-test.test.ts"], "\n    CREATES: test/a-flat-created-test.test.ts");
  assert.ok(created.some((v) => v.check === "draft-test-unplaced"), JSON.stringify(created));
});

test("W1-T9875: each gardener mints its test in the computed folder", () => {
  const hot = hotFileShardYaml({ file: "scripts/source-size-baseline.json", minutes: 90, recordedMinutes: 90, inferredMinutes: 0, rounds: 4, prs: 3 }, "W1-T99001");
  assertPlaced(newTestOf(hot), hotFileShardStem("scripts/source-size-baseline.json"), []);

  const key = "check:lint-plan";
  const draft: CiFrictionDraft = {
    price: { cause: { kind: "check", name: "lint-plan" }, minutes: 40, rounds: 3, prs: 2 } as CiFrictionDraft["price"],
    rung: 1, owner: { files: ["src/lib/task-linter.ts"], why: ["src/lib/task-linter.ts: names lint-plan"] }, rounds: [],
  };
  assertPlaced(newTestOf(ciFrictionShardYaml(draft, "W1-T99002")), ciFrictionShardStem(key), ["src/lib/task-linter.ts"]);

  const stat = { key: "code:time_to_merge:all", cls: "code", stage: "time_to_merge", surface: "all", unit: "minutes", current: { n: 9, p50: 30, p90: 50 },
    baseline: { p50: 10, source: "seed" }, regressed: true, slowest: [{ pr: 1, value: 40 }] } as unknown as FlowStageStat;
  const flow = renderFlowFollowUp(stat, "W1-T99003", [20]);
  assert.equal(flow.refused, undefined);
  assertPlaced(newTestOf(flow.text), flowFollowUpStem(stat), []);

  const action = { class: "draft", target: "x", origin: "flow-remedy:blocker:ci", rung: 1, reason: "r", charges: [], population: [3],
    price: { key: "blocker:inbox-owner", hours: 3, prs: 2, owners: ["src/lib/inbox-owner.ts"] } } as unknown as FlowAction;
  const search = { filesContaining: () => [{ file: "src/lib/inbox-owner.ts", hits: 2 }], fileExists: () => true };
  assertPlaced(newTestOf(draftShard(action, "W1-T99004", search, FLOW_LADDER)), `${FLOW_LADDER.stem}-blocker-inbox-owner`, ["src/lib/inbox-owner.ts"]);

  const scout = scoutShard({ step: "review.parse_failed", older: 2, newer: 3, total: 5, files: ["src/lib/review.ts"] }, "W1-T99005", [5]);
  assert.equal(scout.refused, undefined);
  assertPlaced(newTestOf(scout.text), "scout-review-parse-failed", ["src/lib/review.ts"]);

  const structural = selectorShadowStructuralTask("test/foo.test.ts", "W1-T99006", ["a -> b"], "W1-T99000");
  const structuralTest = newTestOf(structural);
  assert.equal(structuralTest, selectorShadowStructuralTestPath("test/foo.test.ts"));
  assertPlaced(structuralTest, "affected-suites-selects-foo", ["src/lib/affected-suites.ts"]);

  // The subject fallback: a slug and files that place nothing still land in a mapped folder, never flat.
  assert.ok(isPlacedTestPath(newTestPath("zzz-qqq", [], "hot-file-gardener")));
  assert.equal(computedTestFolder("zzz-qqq", [], "hot-file-gardener"), "gardeners");
});

test("W1-T9875: a nested scout test is still recognised as a scout shape", () => {
  const scout = scoutShard({ step: "review.parse_failed", older: 2, newer: 3, total: 5, files: ["src/lib/review.ts"] }, "W1-T99005", [5]);
  const [task] = loadPlanFromYaml(scout.text, "scout").tasks;
  assert.match(task!.files!.at(-1)!, /^test\/[\w-]+(?:\/[\w-]+)?\/scout-/);
  // A scout draft is parked for the judge only when its shape is recognised: the shard survives machine-filing lint.
  assert.equal(scout.refused, undefined);
});
