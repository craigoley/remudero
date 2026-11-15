/**
 * W1-T12832 — the plan lint asks for a design invariant declaration only on authored contract text.
 *
 * W1-T11746 made the changed-task pass of `rmd lint-plan --base` demand INVARIANT/NO-INVARIANTS of every
 * task in the diff, so a priority re-rank, a risk_ruling pin or a note on a task filed before the rule was
 * refused for text the edit never touched (568 of 640 plan preflight refusals in the week measured). The
 * demand now applies to a task that is new, whose design or acceptance differs from the base, or that
 * already declares. Each real-path test builds a git repo and drives the real `lintPlanCommand`.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Task } from "#src/lib/plan.js";
import { declaresDesignInvariant, designContractChanged } from "#src/lib/task-linter.js";
import { lintPlanCommand } from "#src/run-task.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const LINT_DEPS = {
  offline: true,
  loadConfig: (() => ({ root: "/synthetic" })) as never,
  resolveOwnerRepo: (() => ({ owner: "o", repo: "r" })) as never,
  ghGateway: (() => ({})) as never,
  projectPlan: ((plan: { tasks: { id: string }[] }) =>
    new Map(plan.tasks.map((t) => [t.id, { merged: false }]))) as never,
};

const PROSE = "Change the thing in the usual place; nothing here declares an invariant form.";
const FIXTURE_TESTS = ["test/w1-t12832-fixture.test.ts", "test/w1-t12832-second.test.ts", "test/w1-t12832-other.test.ts"];
const CRITERIA: Array<[string, string]> = [["the thing is changed", `unit test: ${FIXTURE_TESTS[0]}`]];

interface Fixture {
  design?: string;
  acceptance?: Array<[string, string]>;
  /** Raw YAML lines for the bookkeeping fields, so a test edits exactly the bytes it names. */
  meta?: string[];
}

const BASE_META = ["  verify: human", "  status: queued", "  attempts: 0", "  depends_on: []"];

function record(id: string, f: Fixture = {}): string {
  return [
    `- id: ${id}`, `  title: "invariant scope fixture ${id}"`, "  repo: remudero", "  type: implement", "  risk: high",
    '  origin: "W1-T12832 test fixture"',
    ...(f.meta ?? BASE_META),
    ...(f.design === undefined ? [] : [`  design: ${JSON.stringify(f.design)}`]),
    "  acceptance:",
    ...(f.acceptance ?? CRITERIA).flatMap(([claim, proof]) => [`    - claim: ${JSON.stringify(claim)}`, `      proof: ${JSON.stringify(proof)}`]),
    "",
  ].join("\n");
}

function commitPlan(repo: GitRepo, records: string[], message: string): void {
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), records.join(""), "utf8");
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "-q", "-m", message);
}

/** A repo whose `main` carries `base`, with a `work` branch checked out and carrying `head`. */
function planDiff(base: string[], head: string[]): GitRepo {
  const repo = gitRepo({ kind: "w1-t12832" });
  mkdirSync(join(repo.dir, "plan"));
  commitPlan(repo, base, "base");
  repo.git("checkout", "-q", "-b", "work");
  commitPlan(repo, head, "edit");
  return repo;
}

async function lint(repo: GitRepo): Promise<{ code: number; out: string[]; text: string }> {
  const out: string[] = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    const code = await lintPlanCommand(["--base", "main"], { ...LINT_DEPS, repoRoot: repo.dir } as never);
    return { code, out, text: out.join("\n") };
  } finally {
    Object.assign(console, orig);
  }
}

const refusedFor = (text: string, id: string): boolean =>
  text.includes(`[design-invariant-proof] task ${id}: design declares neither`);

// The base is verify: auto and the edit parks it at human, so no build-verification check joins the verdict.
const AUTO_META = ["  verify: auto", ...BASE_META.slice(1)];
const EDITED_META = [
  "  verify: human", "  status: prompted", "  attempts: 2", "  depends_on: [ZZ-Dep]", "  priority: 0.4",
  '  note: "re-ranked and pinned by a machine lane; the contract text is untouched"',
  "  risk_ruling:", '    verdict: "high"', "    action: escalate", "    confidence: 1",
  '    reasons: ["deterministic backstop"]', '    judged_at: "2026-11-15T14:02:00.000Z"',
  '    pin: "5c507e80db1036f349883ccc34322036b98cb467f783da87a9c393ce33bed043"',
];

test("W1-T12832 criterion 1: a metadata-only edit to an undeclared task filed before the rule is not refused", async () => {
  const dep = record("ZZ-Dep");
  const repo = planDiff(
    [dep, record("ZZ-Old", { design: PROSE, meta: AUTO_META }), record("ZZ-Bare")],
    // ZZ-Old keeps its prose design and ZZ-Bare has none at all; both change bookkeeping fields only.
    [dep, record("ZZ-Old", { design: PROSE, meta: EDITED_META }), record("ZZ-Bare", { meta: [...BASE_META, "  priority: 0.1"] })],
  );
  const got = await lint(repo);
  // CONTROL: both records were in the changed-task scope, so the silence below is a verdict and not a skip.
  assert.match(got.text, /2 task\(s\) checked/, got.text);
  assert.ok(!got.text.includes("design-invariant-proof"), `a metadata-only edit must not be asked to declare:\n${got.text}`);
  assert.equal(got.code, 0, got.text);
});

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

test("W1-T12832 criterion 2: a new task and a task with edited design or acceptance text still declare", async () => {
  const dep = record("ZZ-Dep");
  const ids = ["ZZ-Design", "ZZ-NewDesign", "ZZ-Claim", "ZZ-Proof", "ZZ-Added", "ZZ-Removed"];
  const two: Array<[string, string]> = [...CRITERIA, ["a second thing holds", `unit test: ${FIXTURE_TESTS[1]}`]];
  const repo = planDiff(
    [dep, record("ZZ-Meta", { design: PROSE }), record("ZZ-Design", { design: PROSE }), record("ZZ-NewDesign"), record("ZZ-Claim"),
      record("ZZ-Proof"), record("ZZ-Added"), record("ZZ-Removed", { acceptance: two })],
    [
      dep,
      record("ZZ-Meta", { design: PROSE, meta: [...BASE_META, "  priority: 0.4"] }),
      record("ZZ-Design", { design: `${PROSE} One more sentence.` }),
      record("ZZ-NewDesign", { design: PROSE }),
      record("ZZ-Claim", { acceptance: [["the thing is changed and logged", CRITERIA[0]![1]]] }),
      record("ZZ-Proof", { acceptance: [[CRITERIA[0]![0], `unit test: ${FIXTURE_TESTS[2]}`]] }),
      record("ZZ-Added", { acceptance: two }),
      record("ZZ-Removed"),
      record("ZZ-New", { design: PROSE }),
    ],
  );
  const got = await lint(repo);
  assert.equal(got.code, 1, got.text);
  for (const id of [...ids, "ZZ-New"]) {
    assert.ok(refusedFor(got.text, id), `${id} authored contract text without a declaration and must be refused:\n${got.text}`);
    assert.ok(got.out.some((l) => l.startsWith(`✗ ${id}:`)), got.text);
  }
  // The narrowing reaches only the record whose design and acceptance are identical to the base.
  assert.ok(!refusedFor(got.text, "ZZ-Meta"), got.text);
  assert.ok(!got.out.some((l) => l.startsWith("✗ ZZ-Meta:")), got.text);
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

test("W1-T12832 criterion 3: a task that declares is checked in full even on a metadata-only edit", async () => {
  const repriced = [...BASE_META, "  priority: 0.4"];
  const fixtures: Record<string, Fixture> = {
    "ZZ-Orphan": { design: "NO-INVARIANTS: nothing inherited", acceptance: [["invariant:ghost — nothing declares me", CRITERIA[0]![1]]] },
    "ZZ-Dup": { design: "INVARIANT dup: first\nINVARIANT dup: second", acceptance: [["invariant:dup — it stays", CRITERIA[0]![1]]] },
    "ZZ-Twice": {
      design: "INVARIANT keep-a: a stays",
      acceptance: [["invariant:keep-a — once", CRITERIA[0]![1]], ["invariant:keep-a — twice", `unit test: ${FIXTURE_TESTS[1]}`]],
    },
    "ZZ-Both": { design: "NO-INVARIANTS: nothing inherited\nINVARIANT keep-a: a stays", acceptance: [["invariant:keep-a — a stays", CRITERIA[0]![1]]] },
    "ZZ-Good": { design: "INVARIANT keep-a: a stays", acceptance: [["invariant:keep-a — a stays", CRITERIA[0]![1]]] },
  };
  const names = Object.keys(fixtures);
  const repo = planDiff(
    names.map((id) => record(id, fixtures[id])),
    names.map((id) => record(id, { ...fixtures[id], meta: repriced })),
  );
  const got = await lint(repo);
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
