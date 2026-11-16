/**
 * W1-T12832 — the plan lint asks for a design invariant declaration only on authored contract text.
 *
 * W1-T11746 made the changed-task pass of `rmd lint-plan --base` demand INVARIANT/NO-INVARIANTS of every
 * task in the diff, so a priority re-rank, a risk_ruling pin or a note on a task filed before the rule was
 * refused for text the edit never touched (568 of 640 plan preflight refusals in the week measured). The
 * demand now applies to a task that is new, whose design or acceptance differs from the base, or that
 * already declares. This file pins the two decisions the command composes. The real `lintPlanCommand` runs for the
 * same three criteria are in test/lint-plan-fast-scopes-to-the-merge-base.test.ts, which already imports
 * src/run-task.ts: the reach ratchet lets that importer set only shrink.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Task } from "#src/lib/plan.js";
import { declaresDesignInvariant, designContractChanged } from "#src/lib/task-linter.js";

const PROSE = "Change the thing in the usual place; nothing here declares an invariant form.";

test("W1-T12832 criterion 1: each bookkeeping field alone leaves the contract unchanged", () => {
  const base = { id: "ZZ-P", design: PROSE, acceptance: [{ claim: "c", proof: "unit test: t.test.ts" }], depends_on: [] } as unknown as Task;
  const edits: Array<Partial<Task>> = [
    { priority: 0.4 }, { verify: "auto" }, { status: "prompted" }, { attempts: 3 }, { note: "re-ranked" }, { depends_on: ["ZZ-Dep"] },
    { risk_ruling: { verdict: "high", action: "escalate", confidence: 1, reasons: [], judged_at: "2026-11-15T00:00:00Z", pin: "p" } },
  ];
  for (const edit of edits) {
    assert.equal(designContractChanged(base, { ...base, ...edit }), false, JSON.stringify(edit));
  }
  // A criterion's bookkeeping (prior credit) is not its claim or proof, and an absent list equals an empty one.
  assert.equal(designContractChanged(base, { ...base, acceptance: [{ ...base.acceptance![0]!, satisfied_by: "PR #1" }] }), false);
  const bare = { ...base, design: undefined, acceptance: undefined } as Task;
  assert.equal(designContractChanged(bare, { ...bare, acceptance: [] }), false);
  assert.equal(declaresDesignInvariant(base), false);
  assert.equal(declaresDesignInvariant(bare), false);
  // The templates in prose are not declarations, exactly as invariantSlugViolations reads them.
  assert.equal(declaresDesignInvariant({ design: "INVARIANT: prose convention\nINVARIANT <slug>: <statement>\nNO-INVARIANTS: <reason>" }), false);
});

test("W1-T12832 criterion 2: the contract comparison reads design text and every claim and proof", () => {
  const base = { id: "ZZ-P", design: PROSE, acceptance: [{ claim: "a", proof: "unit test: a.test.ts" }, { claim: "b", proof: "unit test: b.test.ts" }] } as unknown as Task;
  const [first, second] = base.acceptance!;
  assert.equal(designContractChanged(undefined, base), true, "a task absent at the base is new");
  assert.equal(designContractChanged(base, { ...base }), false);
  assert.equal(designContractChanged(base, { ...base, design: `${PROSE}\n` }), true, "design text is compared byte for byte");
  assert.equal(designContractChanged(base, { ...base, design: undefined }), true);
  assert.equal(designContractChanged(base, { ...base, acceptance: [first!, { ...second!, claim: "b2" }] }), true);
  assert.equal(designContractChanged(base, { ...base, acceptance: [first!, { ...second!, proof: "unit test: c.test.ts" }] }), true);
  assert.equal(designContractChanged(base, { ...base, acceptance: [first!] }), true);
  assert.equal(designContractChanged(base, { ...base, acceptance: [first!, second!, first!] }), true);
  assert.equal(designContractChanged(base, { ...base, acceptance: [second!, first!] }), true, "a reorder changes the list");
  assert.equal(designContractChanged(base, { ...base, acceptance: undefined }), true);
});

test("W1-T12832 criterion 3: a design that declares in either form is asked for the full check on every pass", () => {
  const declared = [
    "NO-INVARIANTS: nothing inherited", "INVARIANT dup: first\nINVARIANT dup: second", "INVARIANT keep-a: a stays",
    "NO-INVARIANTS: nothing inherited\nINVARIANT keep-a: a stays", `${PROSE}\nINVARIANT keep-a: a stays`,
  ];
  for (const design of declared) assert.equal(declaresDesignInvariant({ design }), true, design);
  // The demand is the disjunction the command passes: a declaring task is in even when its contract is unchanged.
  const base = { id: "ZZ-D", design: declared[2], acceptance: [{ claim: "invariant:keep-a — a stays", proof: "unit test: t.test.ts" }] } as unknown as Task;
  const repriced = { ...base, priority: 0.4 } as Task;
  assert.equal(designContractChanged(base, repriced), false);
  assert.equal(designContractChanged(base, repriced) || declaresDesignInvariant(repriced), true);
});
