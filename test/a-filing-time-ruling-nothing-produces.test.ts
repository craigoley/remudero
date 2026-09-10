/**
 * W1-T3143 — LAW 5's JUDGE HAD A VERDICT SLOT AND NO WAY TO FILL IT.
 *
 * W1-T2977 shipped the CONSUMER (`machineAuthorVerifyViolation`'s ruling arm), the SCHEMA
 * (`TaskRiskRuling`) and the DRIFT PIN (`taskRulingPin`), and shipped no producer. MEASURED before
 * this task: `risk_ruling` appeared in exactly three files — its type, its one linter read, and its
 * own shard — so the only reachable rows in that refusal ladder were the blocking ones and every
 * machine-filed record parked forever.
 *
 * THE POLARITY IS UPLIFT-ONLY IN THE SAFE DIRECTION. A ruling may RELEASE a record to `verify:
 * auto`; anything the judge cannot read, cannot parse, or scores risky writes NOTHING and the
 * record stays parked. So a judge outage means MORE review, never an unreviewed auto-file — the
 * opposite of the deploy judge's fail-closed, and deliberate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFilingRiskJudgeInput, recordFilingRiskRuling } from "../src/lib/risk-judge.js";
import { machineAuthorVerifyViolation, taskRulingPin } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

/** A machine-authored record at verify:auto — the shape the ladder refuses until a ruling clears it. */
function machineTask(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TFIXTURE",
    title: "a machine-filed lesson",
    repo: "remudero",
    type: "implement",
    verify: "auto",
    risk: "medium",
    depends_on: [],
    files: ["src/lib/x.ts", "test/x.test.ts"],
    acceptance: [{ claim: "a claim", proof: "grep: x in src/lib/x.ts" }],
    author_class: "machine",
    status: "queued",
    ...over,
  } as unknown as Task;
}

test("W1-T3143: a proceed ruling pinned to the record clears it at verify:auto, where an unruled record blocks", () => {
  const task = machineTask();
  // THE CONTROL FIRST: without a ruling this record is refused. A test that only shows the cleared
  // state passes on an implementation that never blocked anything.
  assert.notEqual(machineAuthorVerifyViolation(task), undefined, "an unruled machine record must block");

  const ruled = recordFilingRiskRuling(task, {
    verdict: "low",
    action: "proceed",
    confidence: 0.9,
    reasons: ["declared files are a lib module and its own test"],
    judgedAt: "2026-09-10T12:00:00.000Z",
  });

  assert.equal(ruled.risk_ruling?.action, "proceed");
  assert.equal(ruled.risk_ruling?.pin, taskRulingPin(task), "the pin must come from the shared function, never re-derived");
  assert.equal(machineAuthorVerifyViolation(ruled), undefined, "a pinned proceed ruling must clear the record");
});

test("W1-T3143: an escalate verdict IS recorded and still blocks, quoting the judge's own reasons", () => {
  const task = machineTask();
  const ruled = recordFilingRiskRuling(task, {
    verdict: "high",
    action: "escalate",
    confidence: 0.8,
    reasons: ["touches the merge path", "no falsifier declared"],
    judgedAt: "2026-09-10T12:00:00.000Z",
  });

  assert.equal(ruled.risk_ruling?.action, "escalate");
  const v = machineAuthorVerifyViolation(ruled);
  assert.notEqual(v, undefined, "an escalate ruling must still refuse");
  // W1-T186: the refusal quotes OBSERVED reasons, so it reads without the ledger.
  assert.ok(v!.message.includes("touches the merge path"), `the refusal must quote the judge's reason, got: ${v!.message}`);
});

test("W1-T3143: an unreadable verdict writes NO ruling, so absence keeps meaning unjudged", () => {
  const task = machineTask();
  // The fail-closed arm. `undefined` in, nothing recorded — never a synthesised proceed.
  const unruled = recordFilingRiskRuling(task, undefined);
  assert.equal(unruled.risk_ruling, undefined, "an unreadable verdict must write nothing at all");
  assert.notEqual(machineAuthorVerifyViolation(unruled), undefined, "and the record must still block");
});

test("W1-T3143: editing what the record may DO drifts the pin and re-blocks", () => {
  const task = machineTask();
  const ruled = recordFilingRiskRuling(task, {
    verdict: "low",
    action: "proceed",
    confidence: 0.9,
    reasons: ["ok"],
    judgedAt: "2026-09-10T12:00:00.000Z",
  });
  assert.equal(machineAuthorVerifyViolation(ruled), undefined, "control: the ruling clears the record as judged");

  // Earn a pass on one text, then rewrite what the task may DO. W1-T2694's defeat-by-editing.
  const rewritten = { ...ruled, files: ["src/lib/x.ts", "test/x.test.ts", "src/lib/deployer.ts"] } as Task;
  const v = machineAuthorVerifyViolation(rewritten);
  assert.notEqual(v, undefined, "a drifted pin must re-block — a ruling earned on one record cannot be spent on another");
});

test("W1-T3143: the judge input is built from the RECORD and never carries the static risk: field", () => {
  // W1-T248's constraint: `risk:` is a Rule 19 sizing artifact, so feeding it to the judge would
  // launder a sizing band into a safety verdict. It stays out of the prompt; it stays IN the pin,
  // which asks a different question.
  const input = buildFilingRiskJudgeInput(machineTask({ risk: "high" }));
  const rendered = JSON.stringify(input);
  assert.ok(!/"risk"\s*:\s*"high"/.test(rendered), `the static risk: field must not reach the judge input: ${rendered.slice(0, 200)}`);
  assert.equal(input.planContext.taskId, "W1-TFIXTURE");
  assert.deepEqual(input.change.files, ["src/lib/x.ts", "test/x.test.ts"], "the declared files ARE the change surface here");
  assert.ok(input.change.description.includes("implement"), "the input must carry what the task may DO");
});
