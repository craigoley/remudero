import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import { PlanError, loadPlan, loadPlanFromYaml, validateAcceptanceShape } from "../src/lib/plan.js";

/**
 * test/plan-acceptance-shape.test.ts — W1-T2908.
 *
 * `acceptance:` was the one plan field CAST rather than checked — `e.acceptance as
 * AcceptanceCriterion[]` — while `id`, `title`, `repo` and `type` all go through the loader's own
 * `req()` in the same loop. YAML has no obligation to honour a type assertion, so a malformed
 * criterion reached the first consumer that called `.trim()` or `.slice()` on it and threw a BARE
 * TypeError naming no shard, no criterion and no field.
 *
 * MEASURED at this head BEFORE the fix, by loading each shape and driving its first consumer:
 *   claim: 123          -> lintTask: `(c.claim ?? "").slice is not a function`
 *   claim: true         -> the same
 *   acceptance: "text"  -> lintTask: `(task.acceptance ?? []).map is not a function`
 *   proof: (empty)      -> lints CLEAN, then the reviewer's own parser throws
 *                          `Cannot read properties of null (reading 'trim')`
 *
 * THE FILING'S OWN EXAMPLE IS CORRECTED HERE RATHER THAN REPEATED: it names `claim: yes` as the
 * boolean case, and in this loader's YAML 1.2 `yes` is the STRING "yes" and lints clean. The real
 * boolean is `claim: true`. A fixture built on the filing's wording would have proved nothing
 * while looking like it covered the case — so both are asserted, each for what it actually is.
 */

const SHARD = (acceptanceBlock: string): string => `- id: W1-T9001
  title: "a task"
  repo: remudero
  type: implement
  verify: auto
  status: queued
  attempts: 0
${acceptanceBlock}`;

const load = (block: string) => loadPlanFromYaml(SHARD(block), "plan/tasks.d/fixture.yaml");

function refusal(block: string): PlanError {
  try {
    load(block);
  } catch (err) {
    assert.ok(err instanceof PlanError, `expected a PlanError, got ${(err as Error).name}: ${(err as Error).message}`);
    return err;
  }
  throw new assert.AssertionError({ message: `expected a refusal, but the shard loaded:\n${block}` });
}

// ── the four shapes the audit named, each refused BY NAME ──────────────────────────────────────

test("W1-T2908: a numeric claim is refused with the shard, index and field, not a bare TypeError", () => {
  const err = refusal('  acceptance:\n    - claim: 123\n      proof: "grep: x in src/a.ts"\n');
  assert.match(err.message, /plan\/tasks\.d\/fixture\.yaml/, "names the shard");
  assert.match(err.message, /W1-T9001/, "names the task");
  assert.match(err.message, /acceptance\[0\]/, "names the criterion index");
  assert.match(err.message, /'claim'/, "names the field");
  assert.match(err.message, /got number/, "and the actual YAML type");
});

test("W1-T2908: a genuinely BOOLEAN claim is refused — and `yes` is a string here, not a boolean", () => {
  const err = refusal('  acceptance:\n    - claim: true\n      proof: "grep: x in src/a.ts"\n');
  assert.match(err.message, /'claim'.*got boolean/);

  // The correction, asserted rather than asserted-about: YAML 1.2 gives `yes` as a STRING, so this
  // shard is WELL-FORMED and must still load. The filing named it as the boolean case; it is not.
  const plan = load('  acceptance:\n    - claim: yes\n      proof: "grep: x in src/a.ts"\n');
  assert.equal(plan.tasks[0]!.acceptance![0]!.claim, "yes");
});

test("W1-T2908: an EMPTY proof is refused at LOAD — the shape that used to survive the linter and detonate in review", () => {
  const err = refusal('  acceptance:\n    - claim: "a claim"\n      proof:\n');
  assert.match(err.message, /acceptance\[0\]/);
  assert.match(err.message, /'proof'.*got null/);
  assert.match(err.message, /satisfied_by/, "and points at the one legal alternative");
});

test("W1-T2908: a scalar where the criteria LIST belongs is refused naming the type it got", () => {
  const err = refusal('  acceptance: "not an array"\n');
  assert.match(err.message, /'acceptance' must be a list of criteria, got string/);
  assert.match(err.message, /W1-T9001/);
});

test("W1-T2908: the index names the OFFENDING criterion, not always the first", () => {
  const err = refusal(
    '  acceptance:\n' +
      '    - claim: "fine"\n      proof: "grep: a in src/a.ts"\n' +
      '    - claim: "also fine"\n      proof: "grep: b in src/b.ts"\n' +
      '    - claim: "bad"\n      proof: 7\n',
  );
  assert.match(err.message, /acceptance\[2\]/, "the third criterion is the one at fault");
  assert.match(err.message, /got number/);
});

// ── what must STILL load: the direction is unchanged ────────────────────────────────────────────

test("W1-T2908: a well-formed shard loads, and an ABSENT acceptance stays legal", () => {
  const ok = load('  acceptance:\n    - claim: "a claim"\n      proof: "grep: x in src/a.ts"\n');
  assert.equal(ok.tasks[0]!.acceptance!.length, 1);
  assert.equal(ok.tasks[0]!.acceptance![0]!.proof, "grep: x in src/a.ts");

  // Whether a task NEEDS criteria is the linter's question, not the loader's — answering it here
  // would reject shards the plan is full of.
  assert.equal(load("").tasks[0]!.acceptance, undefined);
  assert.equal(load("  acceptance:\n").tasks[0]!.acceptance, undefined, "an explicitly null acceptance is absence, not a malformed list");
});

test("W1-T2908: satisfied_by stands IN PLACE OF a proof, and is itself shape-checked", () => {
  // Architect-only (§12 rule 16): judged MET by citing an earlier PR, so it has no proof text.
  const ok = load('  acceptance:\n    - claim: "already shipped"\n      satisfied_by: "#1234"\n');
  assert.equal(ok.tasks[0]!.acceptance![0]!.satisfied_by, "#1234");

  const err = refusal('  acceptance:\n    - claim: "already shipped"\n      satisfied_by: 1234\n');
  assert.match(err.message, /'satisfied_by' must be a non-empty string, got number/);
});

test("W1-T2908: every shard the repo actually ships still loads — the validator rejects nothing real", () => {
  // THE CONTROL THAT MATTERS MOST: a shape check tightened past what the plan already contains
  // would fail every verb at once. Driven through the real entry point over the WHOLE corpus —
  // plan/tasks.yaml is only the root file, and the bulk of the plan lives in plan/tasks.d/ shards,
  // so asserting on the root alone would have measured a fraction and called it the plan.
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const plan = loadPlan(join(root, "plan", "tasks.yaml"));
  assert.ok(plan.tasks.length > 1000, `the real plan must load in full (got ${plan.tasks.length} tasks)`);

  const withCriteria = plan.tasks.filter((t) => (t.acceptance?.length ?? 0) > 0);
  assert.ok(withCriteria.length > 500, `and most of it carries criteria the validator just accepted (${withCriteria.length})`);
  // Non-vacuity: every accepted criterion really is the shape the validator claims to enforce, so
  // "it all loaded" is a statement about the criteria and not just about the file count.
  for (const t of withCriteria) {
    for (const [i, c] of t.acceptance!.entries()) {
      assert.equal(typeof c.claim, "string", `${t.id} acceptance[${i}].claim`);
      assert.ok(typeof c.proof === "string" || typeof c.satisfied_by === "string", `${t.id} acceptance[${i}] has neither proof nor satisfied_by`);
    }
  }
});

// ── the validator called directly, so a caller can be tested without a YAML round trip ──────────

test("W1-T2908: validateAcceptanceShape returns the criteria unchanged when they are well-formed", () => {
  const input = [{ claim: "a", proof: "grep: x in src/a.ts" }];
  assert.equal(validateAcceptanceShape(input, "f.yaml", "W1-T1"), input, "the SAME array, not a copy");
  assert.equal(validateAcceptanceShape(undefined, "f.yaml", "W1-T1"), undefined);
  assert.equal(validateAcceptanceShape(null, "f.yaml", "W1-T1"), undefined);
});

test("W1-T2908: a criterion that is not a mapping at all is refused naming what it was", () => {
  for (const [bad, type] of [
    ["a string", "string"],
    [7, "number"],
    [null, "null"],
    [["nested"], "array"],
  ] as [unknown, string][]) {
    assert.throws(
      () => validateAcceptanceShape([bad], "f.yaml", "W1-T1"),
      (e: Error) => e instanceof PlanError && new RegExp(`acceptance\\[0\\].*got ${type}`).test(e.message),
      `a ${type} criterion must be refused by name`,
    );
  }
});
