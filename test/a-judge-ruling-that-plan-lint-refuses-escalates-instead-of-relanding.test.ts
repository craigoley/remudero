// MEASURED 2026-10-10 on the fleet host: every machine-judge landing of six reused rulings was refused by the plan-PR
// preflight with lint-plan [proof-test-only-discrimination]: all 29 refusals the live ledger kept. The culprit was W1-T7532, a flake
// incident: it declares only its test file and proves itself with one `unit test:` criterion. At `verify: human` that
// check is silent; at the `verify: auto` a proceed writes it WARNs, and lint-plan --base promotes a warning a plan-only
// diff introduces to BLOCK (W1-T3814). The judge's own lint read only `severity: block`, so it never saw the refusal.
// A proceed lint-plan would refuse must become the escalation that names the rule, landed once, never a retried PR.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import type { Proposal } from "../src/lib/inbox.js";
import { renderMachineShard } from "../src/lib/machine-filing.js";
import { renderRuledShard, runMachineFilingJudge } from "../src/lib/machine-filing-judge.js";
import { loadPlan, parseTasksFromYaml, type Task } from "../src/lib/plan.js";
import type { FilingRiskRuling } from "../src/lib/risk-judge.js";
import { lintTask, promoteIntroducedPlanOnlyDiagnostics, taskRulingPin } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const CLOCK = fixedClock(Date.parse("2026-10-10T16:00:00Z"));
const FLAKY = "test/catch-erasure-ratchet.test.ts";

/** A flake incident in the shape the flake-incident gardener files it: its one test file and one `unit test:` proof. */
function flakeIncident(id: string, extraProof?: string): string {
  const rendered = renderMachineShard({
    taskId: id,
    title: `FLAKE INCIDENT — ${FLAKY} failed CI on 3 pull requests whose diffs do not touch it`,
    origin: `flake-incident:${FLAKY}`,
    files: [FLAKY],
    cost: 3,
    acceptance: [
      { claim: `the cause of ${FLAKY}'s intermittent failure is fixed, pinned by a test that forces the failing order`, proof: `unit test: ${id} pins the cause of the intermittent failure` },
      ...(extraProof === undefined ? [] : [{ claim: "the new test names the forced order", proof: extraProof }]),
    ],
  });
  assert.equal(rendered.refused, undefined, "the filer's own lint admits it at verify: human");
  return rendered.text;
}

/** What `rmd lint-plan --base` blocks on a plan-only diff that rewrites `before` into `after`. */
function planOnlyBlocks(before: Task, after: Task): string[] {
  return promoteIntroducedPlanOnlyDiagnostics(lintTask(after).violations, lintTask(before).violations, false)
    .filter((v) => v.severity === "block")
    .map((v) => v.check);
}

const ruling = (action: "proceed" | "escalate"): FilingRiskRuling =>
  ({ verdict: "low", action, confidence: 0.95, reasons: ["a test-only repair of a measured flake"], judgedAt: CLOCK.iso() });

test("the ruled-shard rewrite refuses a proceed whose verify auto flip lint-plan's plan-only filing check would block", () => {
  const rel = "plan/tasks.d/w1-t9810-flake-incident.yaml";
  const text = flakeIncident("W1-T9810");
  const record = parseTasksFromYaml(text, rel)[0]!;
  const pin = taskRulingPin({ ...record, verify: "auto" });

  const proceed = renderRuledShard(text, rel, pin, ruling("proceed"));
  assert.ok("refused" in proceed, "a proceed lint-plan would refuse is not rendered");
  assert.equal(proceed.lint, true, "and it is refused as a lint finding, which the pass turns into an escalation");
  assert.match(proceed.refused, /proof-test-only-discrimination/);

  const escalate = renderRuledShard(text, rel, pin, ruling("escalate"));
  assert.ok("contents" in escalate, "the escalation it becomes renders");
  assert.deepEqual(planOnlyBlocks(record, parseTasksFromYaml(escalate.contents, rel)[0]!), [], "and lint-plan admits it");

  // A test-only record that also carries a grep criterion discriminates, so the judge still releases it.
  const grepped = flakeIncident("W1-T9811", `grep: W1-T9811 forces the failing order in ${FLAKY}`);
  const gRecord = parseTasksFromYaml(grepped, rel)[0]!;
  const released = renderRuledShard(grepped, rel, taskRulingPin({ ...gRecord, verify: "auto" }), ruling("proceed"));
  assert.ok("contents" in released, "a discriminating test-only record is released");
  assert.equal(parseTasksFromYaml(released.contents, rel)[0]!.verify, "auto");
});

test("a judge pass escalates a proceed that plan lint refuses, naming the rule, and lands what lint-plan admits", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-plan-lint-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const shard = join(root, "plan", "tasks.d", "w1-t9812-flake-incident.yaml");
  writeFileSync(shard, flakeIncident("W1-T9812"));
  const before = loadPlan(join(root, "plan", "tasks.yaml")).byId.get("W1-T9812")!;

  const proposals: Proposal[] = [];
  const steps: { step: string; extra?: Record<string, unknown> }[] = [];
  const report = await runMachineFilingJudge({
    stateDir: root,
    plan: () => loadPlan(join(root, "plan", "tasks.yaml")),
    riskJudge: async () => ({ verdict: "low", confidence: 0.95, reasons: ["a test-only repair of a measured flake"] }),
    writeRoot: root,
    stageProposal: (p) => void proposals.push(p),
    log: (step, extra) => void steps.push({ step, extra }),
    clock: CLOCK,
  });

  assert.deepEqual(report.proceeded, [], "the proceed lint-plan would refuse is never offered for landing");
  assert.deepEqual(report.escalated, ["W1-T9812"]);
  assert.equal(proposals.length, 1);
  assert.match(proposals[0]!.summary, /the judge said proceed, but W1-T9812: at verify: auto it fails lint \(proof-test-only-discrimination\)/);
  const after = loadPlan(join(root, "plan", "tasks.yaml")).byId.get("W1-T9812")!;
  assert.equal(after.verify, "human");
  assert.equal(after.risk_ruling?.action, "escalate");
  assert.deepEqual(planOnlyBlocks(before, after), [], "the rewrite the pass wrote is one lint-plan admits");
  assert.match(readFileSync(shard, "utf8"), /proof-test-only-discrimination/, "the record names the rule it would have broken");
});
