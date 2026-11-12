/**
 * W1-T11746 — a declared compatibility invariant needs its own executable acceptance proof.
 *
 * PR #17212 carried "legacy outcome counts stay unchanged" in design prose only, and acceptance could pass
 * without preserving it. `invariantSlugViolations` now demands, for each new/changed implementation task,
 * either `NO-INVARIANTS: <reason>` or one `INVARIANT <slug>:` line per guarantee, each slug mapped to exactly
 * one `invariant:<slug>` acceptance claim with a distinct non-empty proof. The pure helper is driven directly;
 * the real `lintPlanCommand --base` pass is driven over a real git repo to prove the changed-task scope.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  INVARIANT_CLAIM_RE, INVARIANT_DECL_RE, NO_INVARIANTS_RE, invariantSlugViolations, lintTask,
} from "#src/lib/task-linter.js";
import type { Task } from "#src/lib/plan.js";
import { lintPlanCommand } from "#src/run-task.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const ON = { requireDesignInvariantDeclaration: true };

function task(design: string | undefined, acceptance: Array<[string, string]>, type: Task["type"] = "implement"): Task {
  return {
    id: "ZZ-INV", title: "invariant fixture", repo: "remudero", depends_on: [], type, verify: "auto", risk: "medium",
    status: "queued", attempts: 0, design,
    acceptance: acceptance.map(([claim, proof]) => ({ claim, proof })),
  } as Task;
}

const messages = (t: Task, opts = ON): string[] => invariantSlugViolations(t, opts).map((v) => v.message);

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

test("unit test: the rule is silent outside the changed-task pass and for non-implementation tasks", () => {
  const bare = task("just prose", []);
  assert.deepEqual(invariantSlugViolations(bare, {}), [], "whole-plan and dispatch never set the option");
  assert.deepEqual(invariantSlugViolations(bare, { requireDesignInvariantDeclaration: false }), []);
  assert.deepEqual(invariantSlugViolations(task("just prose", [], "research" as Task["type"]), ON), []);
  assert.ok(!lintTask(bare, {}).violations.some((v) => v.check === "design-invariant-proof"));
  assert.ok(lintTask(bare, ON).violations.some((v) => v.check === "design-invariant-proof" && v.severity === "block"));
});

// ---- the real changed-task pass over a real repo ------------------------------------------------

const LINT_DEPS = {
  offline: true,
  loadConfig: (() => ({ root: "/synthetic" })) as never,
  resolveOwnerRepo: (() => ({ owner: "o", repo: "r" })) as never,
  ghGateway: (() => ({})) as never,
  projectPlan: ((plan: { tasks: { id: string }[] }) =>
    new Map(plan.tasks.map((t) => [t.id, { merged: false }]))) as never,
};

const record = (id: string, note: string, design?: string): string =>
  [
    `- id: ${id}`, `  title: "invariant pass fixture ${id}"`, "  repo: remudero", "  depends_on: []",
    "  type: implement", "  verify: human", "  risk: high", "  status: queued", '  origin: "W1-T11746 test fixture"',
    `  note: "${note}"`,
    ...(design === undefined ? [] : [`  design: ${JSON.stringify(design)}`]),
    "  acceptance:",
    '    - claim: "invariant:keep-a — a stays"', '      proof: "unit test: test/w1-t11746-fixture.test.ts"',
    "",
  ].join("\n");

function commitPlan(repo: GitRepo, records: string[], message: string): void {
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), records.join(""), "utf8");
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "-q", "-m", message);
}

async function lint(repo: GitRepo): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    const code = await lintPlanCommand(["--base", "main"], { ...LINT_DEPS, repoRoot: repo.dir } as never);
    return { code, out };
  } finally {
    Object.assign(console, orig);
  }
}

test("unit test: the changed-task lint refuses an unmapped design and leaves an unchanged historical task valid", async () => {
  const repo = gitRepo({ kind: "w1-t11746" });
  mkdirSync(join(repo.dir, "plan"));
  // The historical task has no design at all and carries a dangling invariant claim: it must stay untouched.
  commitPlan(repo, [record("ZZ-Old", "old"), record("ZZ-Edit", "before")], "base");
  repo.git("checkout", "-q", "-b", "work");
  commitPlan(repo, [record("ZZ-Old", "old"), record("ZZ-Edit", "after")], "edit one record");
  const refused = await lint(repo);
  assert.equal(refused.code, 1, refused.out.join("\n"));
  assert.ok(refused.out.some((l) => l.startsWith("✗ ZZ-Edit:")), refused.out.join("\n"));
  assert.match(refused.out.join("\n"), /\[design-invariant-proof\] task ZZ-Edit: design declares neither/);
  assert.ok(!refused.out.some((l) => l.includes("ZZ-Old")), `unchanged history must not be named:\n${refused.out.join("\n")}`);

  commitPlan(repo, [record("ZZ-Old", "old"), record("ZZ-Edit", "after", "INVARIANT keep-a: a stays")], "declare it");
  const accepted = await lint(repo);
  assert.equal(accepted.code, 0, accepted.out.join("\n"));
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
