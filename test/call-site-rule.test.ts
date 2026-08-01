import assert from "node:assert/strict";
import test from "node:test";
import { callSiteViolations, lintTask } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// ── impl-DO: a task creating a src/ module must prove something CALLS it ──────────────────
//
// Eleven modules merged green and unreached in three days. console-freshness.ts shipped 111 lines
// with 83 lines of tests that serve.ts never imported, and the defect it fixed is still on screen
// eight days later. PR #1066's rung shipped with its producer never wired: 18 passing tests, three
// genuine diff-coverage blocks, a green review, dead on arrival.
//
// Every gate asks whether the code WORKS. This is the one that asks whether anything CALLS it.

const BASE: Task = {
  id: "W1-T999",
  title: "a task that creates a module",
  repo: "remudero",
  depends_on: [],
  type: "implement",
  verify: "auto",
  files: ["src/lib/brand-new.ts"],
  acceptance: [],
} as never;

/** Nothing exists — every named module is being CREATED. */
const nothingExists = () => false;
/** Everything exists — every named module is being EDITED. */
const allExists = () => true;

function withProofs(proofs: string[], files = BASE.files): Task {
  return { ...BASE, files, acceptance: proofs.map((p, i) => ({ claim: `c${i}`, proof: p })) } as never;
}

test("a task creating a new src module with NO call-site criterion is FLAGGED", () => {
  const task = withProofs(["unit test: brand new module does the thing"]);

  const v = callSiteViolations(task, { moduleExists: nothingExists });

  assert.equal(v.length, 1, "exactly one violation");
  assert.equal(v[0].check, "call-site", "the check names itself");
  assert.equal(v[0].severity, "warn", "default severity");
  assert.match(v[0].message, /no acceptance criterion proves a CALL SITE/);
  assert.match(v[0].message, /src\/lib\/brand-new\.ts/, "and names the module it is about");
});

test("the same task WITH a call-site criterion passes", () => {
  const task = withProofs([
    "unit test: brand new module does the thing",
    "grep: brandNewThing( in src/lib/serve.ts",
  ]);

  assert.deepEqual(callSiteViolations(task, { moduleExists: nothingExists }), []);
});

test("TRAP LOCK: a MENTION proof does not satisfy the rule -- only a CALL does", () => {
  // This is the reflexive hazard. `grep: foo in x.ts` matches a COMMENT mentioning foo, which is
  // exactly how W1-T267's proof exited 0 against entirely unbuilt work. The open paren is the whole
  // distinction, and it is mechanically decidable on the PROOF.
  const mention = withProofs(["grep: brandNewThing in src/lib/serve.ts"]);
  const call = withProofs(["grep: brandNewThing( in src/lib/serve.ts"]);

  assert.equal(
    callSiteViolations(mention, { moduleExists: nothingExists }).length,
    1,
    "a bare-symbol proof is NOT a call-site proof -- it passes on a comment",
  );
  assert.deepEqual(
    callSiteViolations(call, { moduleExists: nothingExists }),
    [],
    "the same proof with the open paren IS one",
  );

  // WHAT THIS CHECK CANNOT DO, asserted so the limit is recorded rather than implied: it validates
  // the SHAPE OF THE PROOF, not the eventual grep hit. A comment reading `// brandNewThing(x)` in
  // the consumer would satisfy the proof when it runs. Verifying that would mean executing the grep
  // against a tree that does not exist at lint time. This is the honest weaker version.
  const selfReferential = withProofs(["grep: brandNewThing( in src/lib/brand-new.ts"]);
  assert.equal(
    callSiteViolations(selfReferential, { moduleExists: nothingExists }).length,
    1,
    "a call site INSIDE the new module proves nothing about the program reaching it",
  );
});

test("a task touching only EXISTING files is not flagged", () => {
  const task = withProofs(["unit test: an existing module keeps working"]);

  assert.deepEqual(
    callSiteViolations(task, { moduleExists: allExists }),
    [],
    "editing a module carries no call-site obligation -- it already has callers or does not need one",
  );
});

test("without a moduleExists predicate the check is SILENT rather than guessing", () => {
  // The linter is pure. A wrong guess about existence would flag every task that merely edits.
  assert.deepEqual(callSiteViolations(withProofs([]), {}), []);
});

test("a glob or a non-src path never triggers the rule", () => {
  const globbed = withProofs(["unit test: x"], ["src/lib/**/*.ts"]);
  const planOnly = withProofs(["unit test: x"], ["plan/tasks.d/W1-T999-x.yaml"]);
  const testOnly = withProofs(["unit test: x"], ["test/x.test.ts"]);

  for (const t of [globbed, planOnly, testOnly]) {
    assert.deepEqual(callSiteViolations(t, { moduleExists: nothingExists }), [], t.files?.join());
  }
});

test("the violation reaches lintTask, so lint-plan and the relint prompt both see it", () => {
  // Wiring, not logic: a check nothing calls is the very defect this rule exists to prevent.
  const task = withProofs(["unit test: brand new module does the thing"]);

  const result = lintTask(task, { moduleExists: nothingExists });

  assert.ok(
    result.violations.some((v) => v.check === "call-site"),
    "lintTask must surface the call-site violation, not just callSiteViolations directly",
  );
  // NOT asserting result.ok here: this minimal synthetic task trips other blocking checks
  // (proof-shape, provenance) for unrelated reasons. The property that matters is that the
  // call-site violation itself is a WARN and so contributes nothing to the blocking set.
  assert.equal(
    result.violations.find((v) => v.check === "call-site")?.severity,
    "warn",
    "call-site defaults to warn, so it cannot block a plan authored before the rule existed",
  );
});

test("severity is promotable to block without touching the logic", () => {
  const task = withProofs(["unit test: brand new module does the thing"]);

  const result = lintTask(task, { moduleExists: nothingExists, callSite: "block" });

  assert.equal(result.ok, false, "at block severity the task fails the lint");
  assert.equal(result.violations.find((v) => v.check === "call-site")?.severity, "block");
});
