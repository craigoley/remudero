/**
 * W1-T2228 — THE DECLARED-BUT-NOT-NAMED DIRECTION HAD NO DETECTOR.
 *
 * `planBranchReap` (`src/lib/status.ts`) computed only `undeclaredGuards` — a branch the name
 * grep protects that `DECLARED_BRANCH_GUARDS` omits. The inverse direction — a DECLARED guard
 * that has gone quiet — has two distinct dead forms, and neither had a detector before this
 * task:
 *
 *   (i)  CITATION REMOVED, BRANCH ALIVE. Already caught by `orphanDeclarations`
 *        (`planReverseBranchDrift`, W1-T2226/#2773): a declared name cited nowhere outside its
 *        own declaration is reported, regardless of whether its branch still exists.
 *   (ii) BRANCH DELETED. `facts` (`reapBranchesCommand`) is built only from branches that EXIST
 *        on origin, so a declared name whose branch is gone is never even VISITED by the forward
 *        loop — not merely unreported, structurally invisible. Nothing caught this before.
 *
 * THIS TASK ADDS FORM (ii): `BranchReapPlan.missingBranches` (status.ts) is the pure, RAW
 * candidate — every declared name (bar `main`) absent from `facts` — computed against the
 * declared list directly because `facts` has no row to iterate for a branch that isn't there.
 * It is deliberately UNCONDITIONAL and citation-blind, because `planBranchReap` has no citation
 * information to work with.
 *
 * THAT RAW SIGNAL CANNOT BE THE REPORT BY ITSELF (design (v)): `feedback-landing` and
 * `decisions-landing` are declared, cited (`LANDING_BRANCH`/`DECISIONS_LANDING_BRANCH`), and
 * routinely absent from origin between landings — reading "no branch on origin" alone as drift
 * would fire on a healthy, expected condition, the exact "bound that fired on a healthy
 * condition" defect this repo keeps re-deriving. So `reapBranchesCommand` (run-task.ts) — which
 * already has the citation scan behind `orphanDeclarations` — only escalates the intersection:
 * a declared name is reported as a DEAD guard iff its branch is gone from origin AND it is ALSO
 * uncited anywhere outside its own declaration. `feedback-landing`/`decisions-landing` are cited,
 * so they never reach that intersection; a name with neither a branch nor a citation has nothing
 * left pointing to it at all.
 *
 * NOTHING ABOUT THIS CHANGES WHAT IS DELETED: `reap-branches` still only ever reports (W1-T447).
 * It does not change the three existing buckets (`deletable`/`guarded`/`hold`) or what
 * `undeclaredGuards` reports today.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { planBranchReap, type BranchFacts } from "../src/lib/status.js";
import { DECLARED_BRANCH_GUARDS, reapBranchesCommand } from "../src/run-task.js";

const f = (name: string, over: Partial<BranchFacts> = {}): BranchFacts => ({
  name,
  prState: "none",
  tipInMain: false,
  namedInSource: false,
  ...over,
});

const shaFor = (name: string): string => `${name.replace(/[^a-z0-9]/gi, "")}sha`;
const lsRemoteLine = (name: string): string => `${shaFor(name)}\trefs/heads/${name}`;

/** Run `reapBranchesCommand` against a synthetic remote + citation world, capturing stdout/stderr
 * and the exit code without touching the real console or process. */
function runReap(exec: (cmd: string, args: string[]) => string): { code: number; out: string; err: string } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void outLines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void errLines.push(a.map(String).join(" "));
  let code: number;
  try {
    code = reapBranchesCommand([], { exec });
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  return { code, out: outLines.join("\n"), err: errLines.join("\n") };
}

// ── THE PURE PREDICATE (status.ts): the raw, citation-blind (2)(ii) candidate ────────────────

test("planBranchReap: a declared guard absent from facts is reported in missingBranches", () => {
  const plan = planBranchReap([f("main")], ["main", "gone-branch"]);
  assert.deepEqual(plan.missingBranches, ["gone-branch"]);
});

test("planBranchReap: main is never reported as missing even with no facts at all", () => {
  const plan = planBranchReap([], ["main"]);
  assert.deepEqual(plan.missingBranches, [], "main is guarded structurally and excluded from every drift check");
});

test("planBranchReap: a declared guard with a live branch on origin is not reported as missing", () => {
  const plan = planBranchReap([f("feedback-landing", { prState: "merged" })], ["feedback-landing"]);
  assert.deepEqual(plan.missingBranches, []);
});

// ── CRITERION 5: the three reap buckets are unchanged by the new signal ──────────────────────

test("the three reap buckets are unchanged by the new signal", () => {
  const facts = [
    f("merged-into-main", { tipInMain: true }),
    f("has-unique-work", { tipInMain: false }),
    f("decisions-landing", { prState: "merged", namedInSource: true }),
  ];
  // An extra declared name with no matching fact at all, guaranteeing `missingBranches` fires.
  const declaredWithGaps = [...DECLARED_BRANCH_GUARDS, "run-W1-T0000-9999999999"];
  const plan = planBranchReap(facts, declaredWithGaps);
  assert.ok(plan.missingBranches.length > 0, "sanity: the new signal actually fired for this input");
  assert.deepEqual(plan.deletable, ["merged-into-main"]);
  assert.deepEqual(plan.hold, ["has-unique-work"]);
  assert.deepEqual(plan.guarded, ["decisions-landing"]);
});

// ── CRITERION 1: a declared guard with no source citation is reported ────────────────────────

test("a declared guard with no source citation is reported rather than silently honoured", () => {
  const target = "diag/drain-sequential-await";
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return DECLARED_BRANCH_GUARDS.map(lsRemoteLine).join("\n") + "\n";
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-parse") return "deadbeef\n";
    if (args[0] === "grep" && args.includes("-o")) {
      // every declared name is cited outside its own declaration EXCEPT `target`
      return DECLARED_BRANCH_GUARDS.filter((n) => n !== target)
        .map((n) => `src/lib/somewhere.ts:1:${n}`)
        .join("\n");
    }
    if (args[0] === "grep") throw new Error("exit 1: no match");
    if (cmd === "gh") return "[]";
    return "";
  };
  const { code, err } = runReap(exec);
  assert.equal(code, 1, "an uncited declared guard fails the run rather than passing silently");
  assert.match(err, /no longer cited anywhere outside/);
  assert.match(err, new RegExp(target));
});

// ── CRITERION 2: a declared guard whose branch no longer exists on origin is reported ────────

test("a declared guard whose branch no longer exists on origin is reported", () => {
  const target = "diag/drain-sequential-await";
  const remoteNames = DECLARED_BRANCH_GUARDS.filter((n) => n !== target); // target's branch is gone
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return remoteNames.map(lsRemoteLine).join("\n") + "\n";
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-parse") return "deadbeef\n";
    if (args[0] === "grep" && args.includes("-o")) {
      // nobody cites `target` either — the unambiguous double-dead shape (design v): no branch
      // AND no citation, so nothing in the tree still points to it.
      return remoteNames.map((n) => `src/lib/somewhere.ts:1:${n}`).join("\n");
    }
    if (args[0] === "grep") throw new Error("exit 1: no match");
    if (cmd === "gh") return "[]";
    return "";
  };
  const { code, err } = runReap(exec);
  assert.equal(code, 1, "a declared guard whose branch is gone from origin fails the run");
  assert.match(err, /name a branch absent from origin/);
  assert.match(err, new RegExp(target));
});

// ── CRITERION 3: a variable-referenced guard such as feedback-landing is not reported ────────

test("a variable-referenced guard such as feedback-landing is not reported as drift", () => {
  // Exactly the real repo's between-landings shape (git ls-remote confirms it live): declared,
  // cited via LANDING_BRANCH/DECISIONS_LANDING_BRANCH, and absent from origin right now.
  const remoteNames = DECLARED_BRANCH_GUARDS.filter((n) => n !== "feedback-landing" && n !== "decisions-landing");
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return remoteNames.map(lsRemoteLine).join("\n") + "\n";
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-parse") return "deadbeef\n";
    if (args[0] === "grep" && args.includes("-o")) {
      // every declared name — INCLUDING the two absent ones — is cited outside its declaration.
      return DECLARED_BRANCH_GUARDS.map((n) => `src/lib/somewhere.ts:1:${n}`).join("\n");
    }
    if (args[0] === "grep") throw new Error("exit 1: no match");
    if (cmd === "gh") return "[]";
    return "";
  };
  const { code, err } = runReap(exec);
  assert.equal(code, 0, "an ephemeral, still-cited declared guard with no branch right now is healthy, not drift");
  assert.doesNotMatch(err, /feedback-landing/);
  assert.doesNotMatch(err, /decisions-landing/);
});

// ── CRITERION 4: the named-but-undeclared alarm keeps reporting exactly what it reports today ─

test("the named-but-undeclared alarm keeps reporting exactly what it reports today", () => {
  const remoteNames = [...DECLARED_BRANCH_GUARDS, "some-infra-branch"];
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return remoteNames.map(lsRemoteLine).join("\n") + "\n";
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    if (args[0] === "rev-parse") return "deadbeef\n";
    if (args[0] === "grep" && args.includes("-o")) {
      return DECLARED_BRANCH_GUARDS.map((n) => `src/run-task.ts:1:${n}`).join("\n");
    }
    if (args[0] === "grep") return args.includes("some-infra-branch") ? "src/lib/somewhere.ts\n" : (() => {
      throw new Error("exit 1: no match");
    })();
    if (cmd === "gh") return "[]";
    return "";
  };
  const { code, err } = runReap(exec);
  assert.equal(code, 1, "an undeclared guard still fails the run, unchanged by this task");
  assert.match(err, /MISSING from DECLARED_BRANCH_GUARDS/);
  assert.match(err, /some-infra-branch/, "and still names which one");
  assert.doesNotMatch(err, /no longer cited/, "the new signals stay quiet — this is the pre-existing alarm alone");
  assert.doesNotMatch(err, /branch absent from origin/);
});

// ── CRITERION 6: no declaration is removed and no branch is deleted by the reported signal ───

test("no declaration is removed and no branch is deleted by the reported signal", () => {
  const target = "diag/drain-sequential-await";
  const remoteNames = DECLARED_BRANCH_GUARDS.filter((n) => n !== target);
  const before = [...DECLARED_BRANCH_GUARDS];
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "ls-remote") return remoteNames.map(lsRemoteLine).join("\n") + "\n";
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-parse") return "deadbeef\n";
    if (args[0] === "grep" && args.includes("-o")) {
      return remoteNames.map((n) => `src/lib/somewhere.ts:1:${n}`).join("\n");
    }
    if (args[0] === "grep") throw new Error("exit 1: no match");
    if (cmd === "gh") return "[]";
    return "";
  };
  const { code } = runReap(exec);
  assert.equal(code, 1, "sanity: this is the same double-dead drift shape as the branch-deleted test");
  const destructive = calls.filter(
    (c) => c.includes("--delete") || c.includes("push") || c.includes("-D") || c.includes("--force"),
  );
  assert.deepEqual(destructive, [], "reporting a dead declaration never issues a delete");
  assert.deepEqual(DECLARED_BRANCH_GUARDS, before, "and the declared list itself is never mutated by the report");
});
