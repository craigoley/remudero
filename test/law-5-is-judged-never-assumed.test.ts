/**
 * W1-T2977 — LAW 5 IS JUDGED, NEVER ASSUMED.
 *
 * `machineAuthorVerifyViolation` refused EVERY `author_class: machine` record at `verify: auto`,
 * so a drafted shard repairing a comment typo was parked exactly as hard as one rewriting a merge
 * gate. This suite pins the NARROWED arm: the refusal stands unless a RECORDED risk-judge ruling
 * clears the record, and the ruling is PINNED to the record it judged.
 *
 * WHAT THIS SUITE MUST NEVER BECOME: a green that means "the gate was relaxed". Its first test is
 * the unruled case, which must keep blocking, and
 * test/a-machine-filed-shard-reads-as-an-operator-ruling.test.ts keeps every assertion it had.
 * A change that makes an UNRULED machine record dispatch is the outcome W1-T2977 exists to refuse.
 *
 * THE LINTER IS PURE AND SYNCHRONOUS. The judge runs at FILING time and records its verdict; the
 * linter only reads what was recorded. The "no LLM call" test pins that split — it is not a
 * stylistic preference, it is why lint-plan can run per-task in a hot loop with no budget and no
 * network.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { machineAuthorVerifyViolation, lintTask, taskRulingPin } from "../src/lib/task-linter.js";
import type { Task, TaskRiskRuling } from "../src/lib/plan.js";

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test test/foo.test.ts asserts the thing" }],
    ...over,
  };
}

/** A ruling that CLEARS the task it is handed — pinned to that exact record. */
function proceedRuling(t: Task, over: Partial<TaskRiskRuling> = {}): TaskRiskRuling {
  return {
    verdict: "low",
    action: "proceed",
    confidence: 0.9,
    reasons: ["touches one comment in a test fixture", "no gate, schema or CI surface in files"],
    judged_at: "2026-09-06T20:00:00.000Z",
    pin: taskRulingPin(t),
    ...over,
  };
}

// ── THE DEFAULT IS TODAY'S BEHAVIOUR ──────────────────────────────────────────────────────────

test("W1-T2977 an UNRULED machine record at verify:auto is refused exactly as it is today", () => {
  // The load-bearing test in this file. Absence of a ruling is never read as a pass — the same
  // doctrine risk-judge.ts states for its own unavailable case (W1-T130: escalate, never proceed).
  const v = machineAuthorVerifyViolation(task({ id: "W1-T9001", author_class: "machine", verify: "auto" }));
  assert.ok(v, "no ruling on the record must still block");
  assert.equal(v.severity, "block");
  assert.equal(v.check, "machine-author-verify");
  assert.match(v.message, /W1-T9001/);
  assert.match(v.message, /verify: human/, "the message must still name the remedy");
});

test("W1-T2977 a machine record at verify:auto whose ruling CLEARS it, pinned to that record, passes", () => {
  const t = task({ id: "W1-T9010", author_class: "machine", verify: "auto" });
  assert.equal(
    machineAuthorVerifyViolation({ ...t, risk_ruling: proceedRuling(t) }),
    undefined,
    "a judged-safe record is the one row this task adds",
  );
});

// ── THE PIN: A RULING BELONGS TO THE RECORD IT JUDGED ─────────────────────────────────────────

test("W1-T2977 a ruling whose pin does not match the record is refused as DRIFT", () => {
  // The attack this closes: file something benign, earn the pass, then rewrite the record under a
  // ruling that judged different text. W1-T2694's ratification-pin doctrine, applied to one record.
  const judged = task({ id: "W1-T9011", author_class: "machine", verify: "auto" });
  const ruling = proceedRuling(judged);
  const rewritten: Task = { ...judged, files: ["src/lib/review.ts"], risk_ruling: ruling };

  const v = machineAuthorVerifyViolation(rewritten);
  assert.ok(v, "a record edited after being judged must not keep its pass");
  assert.equal(v.severity, "block");
  assert.match(v.message, /drift|pin/i, "the refusal must name WHY, not merely refuse");
});

test("W1-T2977 the pin changes when a decision-relevant field changes, and is stable when it does not", () => {
  const base = task({ id: "W1-T9012", author_class: "machine", verify: "auto" });
  assert.equal(taskRulingPin(base), taskRulingPin({ ...base }), "same record, same pin");
  assert.notEqual(
    taskRulingPin(base),
    taskRulingPin({ ...base, files: ["src/lib/review.ts"] }),
    "files: decides what the task may touch, so it must move the pin",
  );
  assert.notEqual(
    taskRulingPin(base),
    taskRulingPin({ ...base, acceptance: [{ claim: "something else", proof: "grep: x in src/y.ts" }] }),
    "acceptance decides what the task must prove, so it must move the pin",
  );
  // A ruling already on the record must NOT feed its own pin, or the pin could never be checked.
  assert.equal(
    taskRulingPin(base),
    taskRulingPin({ ...base, risk_ruling: proceedRuling(base) }),
    "the ruling is not part of what it pins",
  );
});

// ── AN ESCALATING JUDGE STILL BLOCKS, AND SAYS WHY IN THE JUDGE'S OWN WORDS ────────────────────

test("W1-T2977 an ESCALATE ruling blocks and quotes the judge's reasons verbatim", () => {
  const t = task({ id: "W1-T9013", author_class: "machine", verify: "auto" });
  const ruling = proceedRuling(t, {
    verdict: "high",
    action: "escalate",
    reasons: ["rewrites the merge gate's arm condition", "no falsifier for the removed branch"],
  });

  const v = machineAuthorVerifyViolation({ ...t, risk_ruling: ruling });
  assert.ok(v, "a judge that escalated must not clear the record");
  assert.equal(v.severity, "block");
  // W1-T186: OBSERVED reasons, never an inferred symptom — so a refusal is diagnosable without
  // opening the ledger.
  assert.match(v.message, /rewrites the merge gate's arm condition/, "the judge's own words must reach the operator");
});

// ── THE SPLIT THAT MAKES THIS SAFE TO RUN PER-TASK ────────────────────────────────────────────

test("W1-T2977 the linter makes no LLM call and touches no network", () => {
  // If the gate ever calls the judge itself, lint-plan's verdict starts depending on a network and
  // a budget. The judge runs at FILING time; this reads only what was recorded.
  const t = task({ id: "W1-T9014", author_class: "machine", verify: "auto" });
  const exploding = new Proxy(
    {},
    {
      get() {
        throw new Error("the linter must not reach for a judge, a fetch, or a spawn");
      },
    },
  );
  const withTrap = { ...t, risk_ruling: proceedRuling(t), judge: exploding } as unknown as Task;
  assert.doesNotThrow(() => machineAuthorVerifyViolation(withTrap));
});

// ── THE WIRE, NOT ONLY THE UNIT (W1-T365) ─────────────────────────────────────────────────────

test("W1-T2977 lintTask surfaces the narrowed arm in both directions", () => {
  const blocked = task({ id: "W1-T9015", author_class: "machine", verify: "auto" });
  assert.equal(
    lintTask(blocked).violations.some((v) => v.check === "machine-author-verify" && v.severity === "block"),
    true,
    "an unruled machine record must still block THROUGH lintTask, not merely through the unit",
  );

  const cleared = task({ id: "W1-T9016", author_class: "machine", verify: "auto" });
  assert.equal(
    lintTask({ ...cleared, risk_ruling: proceedRuling(cleared) }).violations.filter(
      (v) => v.check === "machine-author-verify",
    ).length,
    0,
    "and a judged-safe record must clear it through lintTask too",
  );
});

// ── A RULING CANNOT LAUNDER A RECORD THAT WAS NEVER THE JUDGE'S TO CLEAR ──────────────────────

test("W1-T2977 a ruling on an OPERATOR record changes nothing — it was never refused", () => {
  const t = task({ id: "W1-T9017", author_class: "operator", verify: "auto" });
  assert.equal(machineAuthorVerifyViolation({ ...t, risk_ruling: proceedRuling(t) }), undefined);
  assert.equal(machineAuthorVerifyViolation(task({ id: "W1-T9018", verify: "auto" })), undefined);
});
