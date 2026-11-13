/**
 * W1-T11746 — a declared compatibility invariant needs its own executable acceptance proof.
 *
 * PR #17212 carried "legacy outcome counts stay unchanged" in design prose only, and acceptance could pass
 * without preserving it. `invariantSlugViolations` now demands, for each new/changed implementation task,
 * either `NO-INVARIANTS: <reason>` or one `INVARIANT <slug>:` line per guarantee, each slug mapped to exactly
 * one `invariant:<slug>` acceptance claim with a distinct non-empty proof. The pure helper is driven directly;
 * test/lint-plan-fast-scopes-to-the-merge-base.test.ts drives the real changed-task pass over a git repo.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INVARIANT_CLAIM_RE, INVARIANT_DECL_RE, NO_INVARIANTS_RE, invariantSlugViolations, lintTask,
  type LintOpts,
} from "#src/lib/task-linter.js";
import type { Task } from "#src/lib/plan.js";
import { validateAcceptanceShape } from "#src/lib/plan.js";

const ON = { requireDesignInvariantDeclaration: true };

function task(design: string | undefined, acceptance: Array<[string, string]>, type: Task["type"] = "implement"): Task {
  return {
    id: "ZZ-INV", title: "invariant fixture", repo: "remudero", depends_on: [], type, verify: "auto", risk: "medium",
    status: "queued", attempts: 0, design,
    acceptance: acceptance.map(([claim, proof]) => ({ claim, proof })),
  } as Task;
}

const messages = (t: Task, opts: LintOpts = ON): string[] => invariantSlugViolations(t, opts).map((v) => v.message);

test("unit test: a mapped invariant with its own proof passes and NO-INVARIANTS with a reason passes", () => {
  const mapped = task("INVARIANT keep-buckets: legacy buckets keep their counts", [
    ["invariant:keep-buckets — legacy buckets keep their counts", "unit test: test/a.test.ts"],
    ["the new behavior works", "unit test: test/b.test.ts"],
  ]);
  assert.deepEqual(messages(mapped), []);
  assert.deepEqual(messages(task("NO-INVARIANTS: entirely new surface", [["works", "unit test: test/a.test.ts"]])), []);
});

test("unit test: a design declaring neither form is refused with a blocking violation", () => {
  const got = invariantSlugViolations(task("just prose about the change", [["works", "unit test: test/a.test.ts"]]), ON);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.check, "design-invariant-proof");
  assert.equal(got[0]!.severity, "block");
  assert.match(got[0]!.message, /neither `INVARIANT <slug>: <statement>` nor `NO-INVARIANTS: <reason>`/);
  assert.equal(messages(task(undefined, [])).length, 1, "an absent design is also refused");
});

test("unit test: a NO-INVARIANTS line needs a real reason and cannot sit beside an INVARIANT", () => {
  assert.match(messages(task("NO-INVARIANTS:", [["w", "unit test: t.test.ts"]]))[0]!, /neither/);
  assert.match(messages(task("NO-INVARIANTS: <reason>", [["w", "unit test: t.test.ts"]]))[0]!, /neither/);
  const both = messages(task("NO-INVARIANTS: new\nINVARIANT a: keep a", [
    ["invariant:a — keep a", "unit test: a.test.ts"],
  ]));
  assert.deepEqual(both, ["task ZZ-INV: design declares both INVARIANT lines and NO-INVARIANTS; declare exactly one form"]);
});

test("unit test: a declared invariant with no acceptance claim is a missing slug", () => {
  const got = messages(task("INVARIANT keep-a: keep a", [["works", "unit test: a.test.ts"]]));
  assert.equal(got.length, 1);
  assert.match(got[0]!, /invariant "keep-a" has no acceptance claim `invariant:keep-a` \(missing\)/);
});

test("unit test: an invariant claim without a design declaration is an orphaned slug", () => {
  const got = messages(task("NO-INVARIANTS: new", [["invariant:ghost — nothing declares me", "unit test: a.test.ts"]]));
  assert.equal(got.length, 1);
  assert.match(got[0]!, /invariant:ghost has no matching `INVARIANT ghost:` declaration in the design \(orphaned\)/);
});

test("unit test: a slug declared twice in the design is a duplicate", () => {
  const got = messages(task("INVARIANT dup: first\nINVARIANT dup: second", [["invariant:dup — it", "unit test: a.test.ts"]]));
  assert.deepEqual(got, ['task ZZ-INV: invariant slug "dup" is declared more than once in the design']);
});

test("unit test: a slug mapped by two claims, or two slugs in one claim, is multiply mapped", () => {
  const twice = messages(task("INVARIANT a: keep a", [
    ["invariant:a — once", "unit test: a.test.ts"], ["invariant:a — twice", "unit test: b.test.ts"],
  ]));
  assert.deepEqual(twice, ['task ZZ-INV: invariant "a" is mapped by 2 acceptance claims; map it exactly once']);
  const one = messages(task("INVARIANT a: keep a\nINVARIANT b: keep b", [
    ["invariant:a invariant:b — both", "unit test: a.test.ts"],
  ]));
  assert.ok(one.some((m) => /claim 1 maps more than one invariant \(a, b\)/.test(m)), one.join("\n"));
});

test("unit test: an invariant claim needs a non-empty proof distinct from another invariant's", () => {
  const empty = messages(task("INVARIANT a: keep a", [["invariant:a — it", "  "]]));
  assert.deepEqual(empty, ["task ZZ-INV: acceptance claim invariant:a has an empty proof"]);
  const shared = messages(task("INVARIANT a: keep a\nINVARIANT b: keep b", [
    ["invariant:a — a", "unit test: same.test.ts"], ["invariant:b — b", "unit test: same.test.ts"],
  ]));
  assert.deepEqual(shared, ['task ZZ-INV: invariants "a" and "b" share one proof; each needs its own distinct proof']);
});

test("unit test: satisfied_by cannot exempt an invariant from an executable proof dialect", () => {
  for (const verify of ["auto", "human"] as const) {
    for (const proof of ["not executable", "grep: missing target", "unit test: ../escape.test.ts", "demonstration: inspect output"]) {
      const credited = task("INVARIANT keep-a: keep a", [["invariant:keep-a — keep a", proof]]);
      credited.origin = "fixture";
      credited.files = ["src/lib/subject.ts"];
      credited.verify = verify;
      credited.acceptance![0]!.satisfied_by = "PR #1";
      assert.deepEqual(validateAcceptanceShape(credited.acceptance, "fixture", credited.id), credited.acceptance);
      const result = lintTask(credited, ON);
      assert.equal(result.ok, false, `${verify}: ${proof}`);
      assert.ok(result.violations.some((v) => v.check === "design-invariant-proof" && v.severity === "block"),
        JSON.stringify(result.violations));
      assert.deepEqual(messages(credited, {}), [], "legacy credit is unchanged outside the changed-task pass");
      assert.equal(lintTask(credited, {}).ok, true, "ordinary prior-credit behavior stays unchanged");
    }
  }
  for (const proof of ["unit test: test/plan/design-invariants-have-executable-acceptance-proofs.test.ts", "grep: keep a in src/lib/subject.ts"]) {
    const credited = task("INVARIANT keep-a: keep a", [["invariant:keep-a — keep a", proof]]);
    credited.origin = "fixture";
    credited.files = ["src/lib/subject.ts"];
    credited.acceptance![0]!.satisfied_by = "PR #1";
    assert.deepEqual(messages(credited), [], "executable dialects remain valid with prior credit");
    assert.deepEqual(messages(credited, { ...ON, taskRepoOwner: "craigoley" }), []);
    assert.equal(lintTask(credited, ON).ok, true);
  }
});

test("unit test: mapping an invariant preserves ordinary proof resolution and base discrimination", () => {
  const mapped = task("INVARIANT keep-a: keep a", [["invariant:keep-a — keep a", "unit test: a missing invariant title"]]);
  mapped.origin = "fixture";
  mapped.files = ["test/subject.test.ts"];
  const unresolved = lintTask(mapped, { ...ON, resolveNameFilteredCandidates: () => ({ status: "absent" }) });
  assert.equal(unresolved.ok, false);
  assert.ok(unresolved.violations.some((v) => v.check === "proof-unit-test-unresolvable" && v.severity === "block"));
  assert.deepEqual(messages(mapped), [], "a valid mapping does not establish that its proof resolves");
  mapped.acceptance![0]!.proof = "unit test: test/subject.test.ts";
  const existing = lintTask(mapped, { ...ON, pathExistsAtBase: () => true });
  assert.ok(existing.violations.some((v) => v.check === "proof-base-discrimination"));
  assert.ok(!lintTask(mapped, { ...ON, pathExistsAtBase: () => false }).violations.some((v) => v.check === "proof-base-discrimination"));
});

test("unit test: the rule is silent outside the changed-task pass and for non-implementation tasks", () => {
  const bare = task("just prose", []);
  assert.deepEqual(invariantSlugViolations(bare, {}), [], "whole-plan and dispatch never set the option");
  assert.deepEqual(invariantSlugViolations(bare, { requireDesignInvariantDeclaration: false }), []);
  assert.deepEqual(invariantSlugViolations(task("just prose", [], "research" as Task["type"]), ON), []);
  assert.ok(!lintTask(bare, {}).violations.some((v) => v.check === "design-invariant-proof"));
  assert.ok(lintTask(bare, ON).violations.some((v) => v.check === "design-invariant-proof" && v.severity === "block"));
});

test("unit test: the declaration grammars accept the structured forms and reject prose and placeholders", () => {
  assert.equal(INVARIANT_DECL_RE.test("INVARIANT keep-a: legacy stays"), true);
  assert.equal(INVARIANT_DECL_RE.test("  INVARIANT keep-a: legacy stays"), true);
  assert.equal(INVARIANT_DECL_RE.test("INVARIANT <slug>: <statement>"), false);
  assert.equal(INVARIANT_DECL_RE.test("see the INVARIANT keep-a: mid-line"), false);
  assert.equal(INVARIANT_DECL_RE.test("INVARIANT Keep-A: upper-case slug"), false);
  assert.equal(NO_INVARIANTS_RE.test("NO-INVARIANTS: brand-new surface"), true);
  assert.equal(NO_INVARIANTS_RE.test("NO-INVARIANTS: <reason>"), false);
  assert.equal(NO_INVARIANTS_RE.test("NO-INVARIANTS:"), false);
  assert.equal(INVARIANT_CLAIM_RE.test("invariant:keep-a — it stays"), true);
  assert.equal(INVARIANT_CLAIM_RE.test("an ordinary claim"), false);
  assert.equal(INVARIANT_CLAIM_RE.test("invariant:<slug>"), false);
});
