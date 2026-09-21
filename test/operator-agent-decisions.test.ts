import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptOperatorDecisionRows, type OperatorDecisionLedgerRow } from "../src/lib/operator-agent-decisions.js";

test("W1-T3796 criterion 1: explicit decisions and automatic merge events are separate populations", () => {
  const rows: OperatorDecisionLedgerRow[] = [
    { step: "panel.manual_approved", task_id: "W1-T1", task_class: "chore", origin: "operator-1" },
    { step: "panel.proposal_accepted", task_id: "W1-T2", task_class: "chore", origin: "operator-1" },
    { step: "panel.proposal_rejected", task_id: "W1-T3", task_class: "feature", origin: "operator-1" },
    { step: "automerge.armed", task_id: "W1-T4", task_class: "chore" },
    { step: "automerge.clean_status_direct_merge", task_id: "W1-T5", task_class: "chore" },
  ];

  const signal = adaptOperatorDecisionRows(rows);

  assert.equal(signal.status, "measured");
  assert.equal(signal.explicitDecisions.length, 3);
  assert.equal(signal.automaticMergeEvents.length, 2);
  assert.equal(signal.classes.find((item) => item.taskClass === "chore")?.approvalDenominator, 2);
  assert.equal(signal.classes.find((item) => item.taskClass === "chore")?.approvedCount, 1);
  assert.equal(signal.classes.find((item) => item.taskClass === "chore")?.acceptedCount, 1);
  assert.equal(signal.classes.find((item) => item.taskClass === "chore")?.approvalRate, 1);
});

test("W1-T3796 criterion 2: approval rates carry a denominator and missing class or actor is unmeasurable", () => {
  const signal = adaptOperatorDecisionRows([
    { step: "panel.manual_approved", task_id: "W1-T10", task_class: "chore", origin: "operator-1" },
    { step: "panel.proposal_rejected", task_id: "W1-T11", task_class: "chore", origin: "operator-1" },
    { step: "automerge.hold_engaged", task_id: "W1-T12", task_class: "chore", by: "operator-1" },
    { step: "panel.manual_approved", task_id: "W1-T13", origin: "operator-1" },
    { step: "panel.proposal_rejected", task_id: "W1-T14", task_class: "feature" },
    { step: "panel.manual_approved", origin: "operator-1", task_class: "docstring" },
  ]);

  const chore = signal.classes.find((item) => item.taskClass === "chore");
  assert.deepEqual(chore, {
    taskClass: "chore",
    approvedCount: 1,
    acceptedCount: 0,
    rejectedCount: 1,
    heldCount: 1,
    releasedCount: 0,
    approvalDenominator: 2,
    approvalRate: 0.5,
    taskIds: ["W1-T10", "W1-T11", "W1-T12"],
    actorIds: ["operator-1"],
  });
  assert.equal(signal.unmeasurable.length, 3);
  assert.deepEqual(signal.unmeasurable.map((item) => item.cause), ["missing-task-class", "missing-actor", "missing-task-id"]);
});

test("W1-T3796 criterion 3: accepted and rejected decisions preserve task-class identity", () => {
  const signal = adaptOperatorDecisionRows([
    { step: "panel.proposal_accepted", task_id: "W1-T20", task_type: "chore", origin: "operator-1" },
    { step: "panel.proposal_rejected", task_id: "W1-T21", class: "feature", origin: "operator-1" },
  ]);

  assert.deepEqual(signal.explicitDecisions.map((item) => ({ decision: item.decision, taskId: item.taskId, taskClass: item.taskClass })), [
    { decision: "accepted", taskId: "W1-T20", taskClass: "chore" },
    { decision: "rejected", taskId: "W1-T21", taskClass: "feature" },
  ]);
  assert.deepEqual(signal.classes.map((item) => item.taskClass), ["chore", "feature"]);
});

test("operator-agent decisions are not collected when every explicit decision lacks a usable join", () => {
  const signal = adaptOperatorDecisionRows([
    { step: "panel.manual_approved", task_id: "W1-T30", origin: "operator-1" },
    { step: "panel.proposal_rejected", task_id: "W1-T31", task_class: "feature" },
  ]);

  assert.equal(signal.status, "not-collected");
  assert.equal(signal.classes.length, 0);
  assert.equal(signal.automaticMergeEvents.length, 0);
});

test("unit test: operator-agent adapters preserve aggregate evidence while bounding repeated detail arrays", () => {
  const rows: OperatorDecisionLedgerRow[] = [
    ...Array.from({ length: 150 }, (_, index) => ({
      step: "panel.proposal_accepted",
      task_id: `W1-T${index}`,
      task_class: "chore",
      origin: "operator-1",
    })),
    ...Array.from({ length: 150 }, (_, index) => ({
      step: "automerge.armed",
      task_id: `W1-T-auto-${index}`,
      task_class: "chore",
    })),
    ...Array.from({ length: 150 }, () => ({
      step: "panel.proposal_rejected",
      task_id: "W1-T-unmeasurable",
      task_class: "feature",
    })),
  ];

  const signal = adaptOperatorDecisionRows(rows);

  assert.equal(signal.explicitDecisionCount, 150);
  assert.equal(signal.explicitDecisions.length, 100);
  assert.equal(signal.automaticMergeEventCount, 150);
  assert.equal(signal.automaticMergeEvents.length, 100);
  assert.equal(signal.unmeasurableCount, 150);
  assert.equal(signal.unmeasurable.length, 100);
  assert.equal(signal.classes[0]?.approvalDenominator, 150);
  assert.equal(signal.classes[0]?.taskIds.length, 100);
});
