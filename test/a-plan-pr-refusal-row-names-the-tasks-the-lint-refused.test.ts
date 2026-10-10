// 2026-10-10: the live ledger kept 29 `plan_pr.preflight_refused` rows for lane machine-judge, and every one carried only
// `lint-plan-precheck: ... REFUSES it [proof-test-only-discrimination]` — the first line. The task the lint refused
// (W1-T7532) appears only on the lines after it, so naming the culprit meant reproducing the landing locally. The row
// now names the refused task ids and carries the reading from that first line on, cut to a bounded size.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// @ts-expect-error -- test executes the untyped executable module directly.
import { lintPlanPrecheckVerdict } from "../scripts/lint-plan-precheck.mjs";
import { FAILURE_DETAIL_CHARS, planPrPreflight, planPrPreflightAllows, type PlanPrPreflightReading } from "../src/lib/plan-pr-emitter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const green: PlanPrPreflightReading = { status: 0, output: "" };

/** What the in-tree precheck prints when lint-plan refuses `lintOutput`, through the script's own formatter. */
function precheckRefusal(lintOutput: string): PlanPrPreflightReading {
  const verdict = lintPlanPrecheckVerdict({ changedFiles: ["plan/tasks.d/w1-t9887-flake-incident.yaml"], subjects: [], lint: () => ({ status: 1, output: lintOutput }) });
  assert.equal(verdict.exit, 1, "the fixture is a refusal");
  return { status: 1, output: (verdict.lines as string[]).join("\n") };
}

function refusalRow(t: { after: (fn: () => void) => void }, lintPlan: PlanPrPreflightReading): Record<string, unknown> {
  const cwd = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}refusal-row-`));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const result = planPrPreflight({ cwd, title: "chore(plan): the machine-filing judge rules on 1 machine-filed task(s)", body: "" }, {
    lintPlan: () => lintPlan, taskIdExistence: () => green, shardCensus: () => green, checkProof: () => 0,
  });
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  assert.equal(planPrPreflightAllows(result, { lane: "machine-judge", branch: "machine-judge-garden-1", log: (step, extra) => void rows.push({ step, extra }) }), false);
  const refused = rows.filter((r) => r.step === "plan_pr.preflight_refused");
  assert.equal(refused.length, 1);
  return refused[0]!.extra!;
}

test("a plan-PR refusal row names the tasks the plan lint refused and carries the lines that say why", (t) => {
  const message = "task W1-T9887 declares only test/ files (test/x.test.ts) and every judged criterion is a `unit test:` proof (W1-T5527 #9103, W1-T5622 #9120)";
  const row = refusalRow(t, precheckRefusal(`✗ W1-T9887: 1 violation(s) (0 pre-existing on base origin/main)\n    [proof-test-only-discrimination] ${message}\n`));

  assert.deepEqual(row.task_ids, ["W1-T9887"], "the refused task, not the ids its message cites");
  const [failure] = row.failures as Array<{ check: string; firstLine: string; lines?: string[]; task_ids?: string[] }>;
  assert.equal(failure!.check, "lint-plan");
  assert.match(failure!.firstLine, /REFUSES it \[proof-test-only-discrimination\]/, "the first line is unchanged");
  assert.deepEqual(failure!.task_ids, ["W1-T9887"]);
  assert.ok(failure!.lines?.includes(`[proof-test-only-discrimination] ${message}`), "the rule's message is on the row");
  assert.ok(failure!.lines?.some((l) => l.startsWith("✗ W1-T9887:")));
});

test("a long refusal reading is cut to a bounded size that still names every refused task", (t) => {
  const tasks = Array.from({ length: 60 }, (_, i) => `W1-T${9000 + i}`);
  const lint = tasks.map((id) => `✗ ${id}: 1 violation(s)\n    [shard-shape] task ${id} ${"is missing a field the plan requires; ".repeat(4)}`).join("\n");
  const row = refusalRow(t, precheckRefusal(lint));

  assert.deepEqual(row.task_ids, tasks, "an id past the cut is still named");
  const [failure] = row.failures as Array<{ lines: string[] }>;
  const kept = failure!.lines.slice(0, -1);
  assert.ok(kept.join("").length <= FAILURE_DETAIL_CHARS, "the kept lines fit the bound");
  assert.match(failure!.lines.at(-1)!, /^… \d+ more line\(s\)$/, "and the row says it dropped the rest");
});
