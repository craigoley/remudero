/**
 * test/lint-plan-fast-scopes-to-the-merge-base.test.ts — W1-T4381.
 *
 * `lint-plan:fast` ran `lint-plan --base origin/main`, which diffs the checkout against main's TIP.
 * A plan record main changed after a branch forked therefore read as changed IN THE BRANCH, and was
 * linted in the branch's older copy: PR #6737 went red twice naming W1-T115 and W1-T67, records
 * main had just reconciled and the PR never touched. `--merge-base` scopes to the fork point.
 *
 * Each test builds a real repo (fork commit, a later main commit, a branch checked out) and drives
 * the real `lintPlanCommand` with `repoRoot` pointed at it. The network seams are stubbed exactly as
 * test/base-lint-attributes-pre-existing-violations.test.ts stubs them.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { declaresDesignInvariant } from "#src/lib/task-linter.js";
import { lintPlanCommand, lintScopeMergeBase } from "#src/run-task.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const LINT_DEPS = {
  offline: true,
  loadConfig: (() => ({ root: "/synthetic" })) as never,
  resolveOwnerRepo: (() => ({ owner: "o", repo: "r" })) as never,
  ghGateway: (() => ({})) as never,
  projectPlan: ((plan: { tasks: { id: string }[] }) =>
    new Map(plan.tasks.map((t) => [t.id, { merged: false }]))) as never,
};

// A vibe proof trips proof-shape and proof-dialect, both BLOCK; a `unit test:` proof trips neither.
const BROKEN_PROOF = "works";
const CLEAN_PROOF = "unit test: test/w1-t4381-fixture.test.ts";

const task = (id: string, title: string, proof: string) =>
  [
    `- id: ${id}`,
    `  title: "${title}"`,
    `  repo: remudero`,
    `  depends_on: []`,
    `  type: implement`,
    `  verify: human`,
    `  risk: high`,
    `  status: queued`,
    `  origin: "W1-T4381 test fixture"`,
    `  design: "NO-INVARIANTS: synthetic lint fixture with no inherited behavior to preserve"`,
    `  acceptance:`,
    `    - claim: "something is proven"`,
    `      proof: "${proof}"`,
    ``,
  ].join("\n");

function writePlan(repo: GitRepo, records: string[]): void {
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), records.join(""), "utf8");
}

function commitPlan(repo: GitRepo, records: string[], message: string): void {
  writePlan(repo, records);
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "-q", "-m", message);
}

/** main: the fork commit carries ZZ-Landmine BROKEN, then main fixes it. The branch forks before
 *  the fix and is checked out, so it still carries the broken copy it never touched. */
function planFork(): GitRepo {
  const repo = gitRepo({ kind: "w1-t4381" });
  mkdirSync(join(repo.dir, "plan"));
  commitPlan(repo, [task("ZZ-Landmine", "landmine", BROKEN_PROOF), task("ZZ-Clean", "clean", CLEAN_PROOF)], "fork");
  repo.git("branch", "feature");
  commitPlan(repo, [task("ZZ-Landmine", "landmine", CLEAN_PROOF), task("ZZ-Clean", "clean", CLEAN_PROOF)], "main fixes the landmine");
  repo.git("checkout", "-q", "feature");
  return repo;
}

async function lint(repo: GitRepo, args: string[]): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    const code = await lintPlanCommand(args, { ...LINT_DEPS, repoRoot: repo.dir } as never);
    return { code, out };
  } finally {
    Object.assign(console, orig);
  }
}

test("W1-T4381: a record main changed after the fork is not linted as this branchs change", async () => {
  const repo = planFork();
  commitPlan(repo, [task("ZZ-Landmine", "landmine", BROKEN_PROOF), task("ZZ-Clean", "clean, edited on the branch", CLEAN_PROOF)], "branch edit");

  // CONTROL: the tip diff is the defect this task fixes, so it must still reproduce it.
  const tip = await lint(repo, ["--base", "main"]);
  assert.equal(tip.code, 1, `the tip diff must still blame the branch:\n${tip.out.join("\n")}`);
  assert.ok(tip.out.some((l) => l.startsWith("✗ ZZ-Landmine:")), tip.out.join("\n"));

  const scoped = await lint(repo, ["--base", "main", "--merge-base"]);
  assert.equal(scoped.code, 0, `a record only main changed must not fail the branch:\n${scoped.out.join("\n")}`);
  assert.ok(!scoped.out.some((l) => l.includes("ZZ-Landmine")), scoped.out.join("\n"));
  const forkSha = repo.git("merge-base", "main", "HEAD");
  const summary = scoped.out.find((l) => /new\/changed vs main at merge-base /.test(l));
  assert.ok(summary, `the run must name its merge-base scope:\n${scoped.out.join("\n")}`);
  assert.match(summary!, new RegExp(`1 new/changed vs main at merge-base ${forkSha.slice(0, 12)}`));
});

test("W1-T4381: a record the branch changed is still in scope", async () => {
  const repo = planFork();
  commitPlan(repo, [task("ZZ-Landmine", "landmine", BROKEN_PROOF), task("ZZ-Clean", "clean, broken on the branch", BROKEN_PROOF)], "branch breaks clean");

  const scoped = await lint(repo, ["--base", "main", "--merge-base"]);
  assert.equal(scoped.code, 1, `the branch's own violation must still fail:\n${scoped.out.join("\n")}`);
  const line = scoped.out.find((l) => l.startsWith("✗ ZZ-Clean:"));
  assert.ok(line, scoped.out.join("\n"));
  assert.match(line!, /\(0 pre-existing on base main at merge-base [0-9a-f]{12}\)/);
  assert.ok(!scoped.out.some((l) => l.startsWith("✗ ZZ-Landmine:")), scoped.out.join("\n"));
});

test("W1-T4381: with no merge-base the scope stays at the ref itself and says so", () => {
  const out: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    const got = lintScopeMergeBase("/nowhere", "origin/main", () => {
      throw new Error("fatal: no merge base\nsecond line");
    });
    assert.equal(got, "origin/main");
  } finally {
    console.error = orig;
  }
  assert.equal(out.length, 1);
  assert.match(out[0]!, /no merge-base of origin\/main and HEAD \(fatal: no merge base\) — scoping to origin\/main itself/);
});

test("W1-T4381: the default git seam really answers the merge-base", () => {
  const repo = planFork();
  assert.equal(lintScopeMergeBase(repo.dir, "main"), repo.git("merge-base", "main", "HEAD"));
});

const invariantRecord = (id: string, note: string, design?: string): string =>
  [
    `- id: ${id}`, `  title: "invariant pass fixture ${id}"`, "  repo: remudero", "  depends_on: []",
    "  type: implement", "  verify: human", "  risk: high", "  status: queued", '  origin: "W1-T11746 test fixture"',
    `  note: "${note}"`,
    ...(design === undefined ? [] : [`  design: ${JSON.stringify(design)}`]),
    "  acceptance:",
    '    - claim: "invariant:keep-a — a stays"', '      proof: "unit test: test/w1-t11746-fixture.test.ts"',
    "",
  ].join("\n");

test("unit test: the changed-task lint refuses an unmapped design and leaves an unchanged historical task valid", async () => {
  const repo = gitRepo({ kind: "w1-t11746" });
  mkdirSync(join(repo.dir, "plan"));
  // The historical task has no design at all and carries a dangling invariant claim: it must stay untouched.
  commitPlan(repo, [invariantRecord("ZZ-Old", "old"), invariantRecord("ZZ-Edit", "before")], "base");
  repo.git("checkout", "-q", "-b", "work");
  commitPlan(repo, [invariantRecord("ZZ-Old", "old"), invariantRecord("ZZ-Edit", "after", "prose that declares neither form")], "edit one record");
  const refused = await lint(repo, ["--base", "main"]);
  assert.equal(refused.code, 1, refused.out.join("\n"));
  assert.ok(refused.out.some((l) => l.startsWith("✗ ZZ-Edit:")), refused.out.join("\n"));
  assert.match(refused.out.join("\n"), /\[design-invariant-proof\] task ZZ-Edit: design declares neither/);
  assert.ok(!refused.out.some((l) => l.includes("ZZ-Old")), `unchanged history must not be named:\n${refused.out.join("\n")}`);

  commitPlan(repo, [invariantRecord("ZZ-Old", "old"), invariantRecord("ZZ-Edit", "after", "INVARIANT keep-a: a stays")], "declare it");
  const accepted = await lint(repo, ["--base", "main"]);
  assert.equal(accepted.code, 0, accepted.out.join("\n"));
});

// ── W1-T12832: the changed-task pass asks for a declaration only of authored contract text ─────────────────────────
// These are the real `lintPlanCommand` runs for criteria 1 to 3. The two decisions they exercise are pinned as pure
// functions in test/plan/a-metadata-only-edit-to-a-task-filed-before-the-invariant-rule-is-not-refused.test.ts.
const SCOPE_PROSE = "Change the thing in the usual place; nothing here declares an invariant form.";
const SCOPE_FIXTURE_TESTS = ["test/w1-t12832-fixture.test.ts", "test/w1-t12832-second.test.ts", "test/w1-t12832-other.test.ts"];
const SCOPE_CRITERIA: Array<[string, string]> = [["the thing is changed", `unit test: ${SCOPE_FIXTURE_TESTS[0]}`]];

interface ScopeFixture {
  design?: string;
  /** An optional third entry is the criterion's `kind` (W1-T14915: a guarded invariant stays quiet). */
  acceptance?: Array<[string, string] | [string, string, string]>;
  /** Raw YAML lines for the bookkeeping fields, so a test edits exactly the bytes it names. */
  meta?: string[];
}

const SCOPE_BASE_META = ["  verify: human", "  status: queued", "  attempts: 0", "  depends_on: []"];

function scopeRecord(id: string, f: ScopeFixture = {}): string {
  return [
    `- id: ${id}`, `  title: "invariant scope fixture ${id}"`, "  repo: remudero", "  type: implement", "  risk: high",
    '  origin: "W1-T12832 test fixture"',
    ...(f.meta ?? SCOPE_BASE_META),
    ...(f.design === undefined ? [] : [`  design: ${JSON.stringify(f.design)}`]),
    "  acceptance:",
    ...(f.acceptance ?? SCOPE_CRITERIA).flatMap(([claim, proof, kind]) => [`    - claim: ${JSON.stringify(claim)}`, `      proof: ${JSON.stringify(proof)}`,
      ...(kind === undefined ? [] : [`      kind: ${kind}`])]),
    "",
  ].join("\n");
}

/** A repo whose `main` carries `base`, with a `work` branch checked out and carrying `head`. */
function scopePlanDiff(base: string[], head: string[]): GitRepo {
  const repo = gitRepo({ kind: "w1-t12832" });
  mkdirSync(join(repo.dir, "plan"));
  commitPlan(repo, base, "base");
  repo.git("checkout", "-q", "-b", "work");
  commitPlan(repo, head, "edit");
  return repo;
}

async function lintWork(repo: GitRepo): Promise<{ code: number; out: string[]; text: string }> {
  const got = await lint(repo, ["--base", "main"]);
  return { ...got, text: got.out.join("\n") };
}

const invariantRefusedFor = (text: string, id: string): boolean =>
  text.includes(`[design-invariant-proof] task ${id}: design declares neither`);

// The base is verify: auto and the edit parks it at human, so no build-verification check joins the verdict.
const SCOPE_AUTO_META = ["  verify: auto", ...SCOPE_BASE_META.slice(1)];
const SCOPE_EDITED_META = [
  "  verify: human", "  status: prompted", "  attempts: 2", "  depends_on: [ZZ-Dep]", "  priority: 0.4",
  '  note: "re-ranked and pinned by a machine lane; the contract text is untouched"',
  "  risk_ruling:", '    verdict: "high"', "    action: escalate", "    confidence: 1",
  '    reasons: ["deterministic backstop"]', '    judged_at: "2026-11-15T14:02:00.000Z"',
  '    pin: "5c507e80db1036f349883ccc34322036b98cb467f783da87a9c393ce33bed043"',
];

test("W1-T12832 criterion 1: a metadata-only edit to an undeclared task filed before the rule is not refused", async () => {
  const dep = scopeRecord("ZZ-Dep");
  const repo = scopePlanDiff(
    [dep, scopeRecord("ZZ-Old", { design: SCOPE_PROSE, meta: SCOPE_AUTO_META }), scopeRecord("ZZ-Bare")],
    // ZZ-Old keeps its prose design and ZZ-Bare has none at all; both change bookkeeping fields only.
    [dep, scopeRecord("ZZ-Old", { design: SCOPE_PROSE, meta: SCOPE_EDITED_META }), scopeRecord("ZZ-Bare", { meta: [...SCOPE_BASE_META, "  priority: 0.1"] })],
  );
  const got = await lintWork(repo);
  // CONTROL: both records were in the changed-task scope, so the silence below is a verdict and not a skip.
  assert.match(got.text, /2 task\(s\) checked/, got.text);
  assert.ok(!got.text.includes("design-invariant-proof"), `a metadata-only edit must not be asked to declare:\n${got.text}`);
  assert.equal(got.code, 0, got.text);
});

test("W1-T12832 criterion 2: a new task and a task with edited design or acceptance text still declare", async () => {
  const dep = scopeRecord("ZZ-Dep");
  const ids = ["ZZ-Design", "ZZ-NewDesign", "ZZ-Claim", "ZZ-Proof", "ZZ-Added", "ZZ-Removed"];
  const two: Array<[string, string]> = [...SCOPE_CRITERIA, ["a second thing holds", `unit test: ${SCOPE_FIXTURE_TESTS[1]}`]];
  const repo = scopePlanDiff(
    [dep, scopeRecord("ZZ-Meta", { design: SCOPE_PROSE }), scopeRecord("ZZ-Design", { design: SCOPE_PROSE }), scopeRecord("ZZ-NewDesign"), scopeRecord("ZZ-Claim"),
      scopeRecord("ZZ-Proof"), scopeRecord("ZZ-Added"), scopeRecord("ZZ-Removed", { acceptance: two })],
    [
      dep,
      scopeRecord("ZZ-Meta", { design: SCOPE_PROSE, meta: [...SCOPE_BASE_META, "  priority: 0.4"] }),
      scopeRecord("ZZ-Design", { design: `${SCOPE_PROSE} One more sentence.` }),
      scopeRecord("ZZ-NewDesign", { design: SCOPE_PROSE }),
      scopeRecord("ZZ-Claim", { acceptance: [["the thing is changed and logged", SCOPE_CRITERIA[0]![1]]] }),
      scopeRecord("ZZ-Proof", { acceptance: [[SCOPE_CRITERIA[0]![0], `unit test: ${SCOPE_FIXTURE_TESTS[2]}`]] }),
      scopeRecord("ZZ-Added", { acceptance: two }),
      scopeRecord("ZZ-Removed"),
      scopeRecord("ZZ-New", { design: SCOPE_PROSE }),
    ],
  );
  const got = await lintWork(repo);
  assert.equal(got.code, 1, got.text);
  for (const id of [...ids, "ZZ-New"]) {
    assert.ok(invariantRefusedFor(got.text, id), `${id} authored contract text without a declaration and must be refused:\n${got.text}`);
    assert.ok(got.out.some((l) => l.startsWith(`✗ ${id}:`)), got.text);
  }
  // The narrowing reaches only the record whose design and acceptance are identical to the base.
  assert.ok(!invariantRefusedFor(got.text, "ZZ-Meta"), got.text);
  assert.ok(!got.out.some((l) => l.startsWith("✗ ZZ-Meta:")), got.text);
});

test("W1-T12832 criterion 3: a task that declares is checked in full even on a metadata-only edit", async () => {
  const repriced = [...SCOPE_BASE_META, "  priority: 0.4"];
  const fixtures: Record<string, ScopeFixture> = {
    "ZZ-Orphan": { design: "NO-INVARIANTS: nothing inherited", acceptance: [["invariant:ghost — nothing declares me", SCOPE_CRITERIA[0]![1]]] },
    "ZZ-Dup": { design: "INVARIANT dup: first\nINVARIANT dup: second", acceptance: [["invariant:dup — it stays", SCOPE_CRITERIA[0]![1]]] },
    "ZZ-Twice": {
      design: "INVARIANT keep-a: a stays",
      acceptance: [["invariant:keep-a — once", SCOPE_CRITERIA[0]![1]], ["invariant:keep-a — twice", `unit test: ${SCOPE_FIXTURE_TESTS[1]}`]],
    },
    "ZZ-Both": { design: "NO-INVARIANTS: nothing inherited\nINVARIANT keep-a: a stays", acceptance: [["invariant:keep-a — a stays", SCOPE_CRITERIA[0]![1]]] },
    // W1-T14915: the well-formed control guards its invariant, so the unguarded-invariant warn names it nowhere.
    "ZZ-Good": { design: "INVARIANT keep-a: a stays", acceptance: [SCOPE_CRITERIA[0]!, ["invariant:keep-a — a stays", `unit test: ${SCOPE_FIXTURE_TESTS[1]}`, "guard"]] },
  };
  const names = Object.keys(fixtures);
  const repo = scopePlanDiff(
    names.map((id) => scopeRecord(id, fixtures[id])),
    names.map((id) => scopeRecord(id, { ...fixtures[id], meta: repriced })),
  );
  const got = await lintWork(repo);
  assert.equal(got.code, 1, got.text);
  assert.match(got.text, /\[design-invariant-proof\] task ZZ-Orphan: acceptance claim invariant:ghost has no matching `INVARIANT ghost:` declaration in the design \(orphaned\)/);
  assert.match(got.text, /\[design-invariant-proof\] task ZZ-Dup: invariant slug "dup" is declared more than once in the design/);
  assert.match(got.text, /\[design-invariant-proof\] task ZZ-Twice: invariant "keep-a" is mapped by 2 acceptance claims; map it exactly once/);
  assert.match(got.text, /\[design-invariant-proof\] task ZZ-Both: design declares both INVARIANT lines and NO-INVARIANTS/);
  // CONTROL: a well-formed declaration on the same metadata-only edit is in scope and passes.
  assert.match(got.text, /5 task\(s\) checked/, got.text);
  assert.ok(!got.out.some((l) => l.startsWith("✗ ZZ-Good:") || l.includes("task ZZ-Good:")), got.text);
  for (const id of names) assert.equal(declaresDesignInvariant({ design: fixtures[id]!.design }), true, id);
});
