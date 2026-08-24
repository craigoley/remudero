/**
 * W1-T2226 — THE BRANCH-GUARD DRIFT ALARM COMPARES IN ONE DIRECTION FROM ONE ENUMERATION.
 *
 * `reapBranchesCommand`'s existing drift alarm (`plan.undeclaredGuards`, W1-T447) only ever asks
 * its question about branches that still exist on origin, because `facts = names.map(...)` is
 * built from the REMOTE listing. That is one blind spot at each end: a citation naming a branch
 * that has since been deleted never enumerates (it was never in `names`), and a declaration that
 * outlives its citation never expires (nothing iterates `DECLARED_BRANCH_GUARDS` looking for
 * orphans). `planReverseBranchDrift` is the fix: ONE citation enumeration feeds TWO comparisons,
 * `citations − remote − declared` (dangling) and `declared − citations` (orphaned).
 *
 * THE DECLARATION BLOCK EXCLUSION IS THE LOAD-BEARING HALF of the orphan direction (rationale
 * (5)): `DECLARED_BRANCH_GUARDS` lives in a grepped root, so every declared name is
 * `namedInSource: true` by virtue of its own declaration. A reverse check that reuses that
 * predicate without excluding the block can never report an orphan — it would read the
 * declaration's own line as a citation of the name it declares.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DECLARED_BRANCH_GUARDS,
  planReverseBranchDrift,
  reapBranchesCommand,
  type BranchCitationHit,
} from "../src/run-task.js";

const hit = (file: string, line: number, name: string): BranchCitationHit => ({ file, line, name });

const BLOCK = { file: "src/run-task.ts", start: 100, end: 120 };

// ── CRITERION 1: a dangling citation ──────────────────────────────────────────────────────────

test("a source citation naming a branch absent from the remote is reported", () => {
  const citations = [hit("src/lib/dispatch-claim.ts", 42, "run-W1-T1265-1787503092377")];
  const drift = planReverseBranchDrift(citations, ["main"], ["main"], BLOCK);
  assert.deepEqual(
    drift.danglingCitations,
    ["run-W1-T1265-1787503092377"],
    "cited, absent from origin, and not declared — exactly the (2)/(3) shape",
  );
});

// ── CRITERION 2 & 3: an orphan declaration, and the exclusion that makes it visible ──────────

test("a declared guard no longer cited outside its own declaration is reported", () => {
  // The ONLY hit is inside the declaration block itself (line 110, within [100, 120]) — i.e. the
  // guard's own entry, and nothing else anywhere cites it.
  const citations = [hit("src/run-task.ts", 110, "run-W1-T1265-1787503038601")];
  const drift = planReverseBranchDrift(
    citations,
    ["main"],
    ["run-W1-T1265-1787503038601"],
    BLOCK,
  );
  assert.deepEqual(
    drift.orphanDeclarations,
    ["run-W1-T1265-1787503038601"],
    "declared, and its only citation anywhere is the declaration's own line",
  );
});

test("the declaration block itself never counts as a citation of the name it declares", () => {
  // Two hits on the SAME name: one inside the block (its own declaration), one outside. Only the
  // outside hit should count, so the name is NOT orphaned.
  const insideOnly = planReverseBranchDrift(
    [hit("src/run-task.ts", 105, "heartbeat-azure")],
    ["main"],
    ["heartbeat-azure"],
    BLOCK,
  );
  assert.deepEqual(
    insideOnly.orphanDeclarations,
    ["heartbeat-azure"],
    "a hit ONLY inside the block must not satisfy the citation requirement",
  );

  const insideAndOutside = planReverseBranchDrift(
    [hit("src/run-task.ts", 105, "heartbeat-azure"), hit(".github/workflows/fleet-heartbeat-watch.yml", 7, "heartbeat-azure")],
    ["main"],
    ["heartbeat-azure"],
    BLOCK,
  );
  assert.deepEqual(
    insideAndOutside.orphanDeclarations,
    [],
    "a SECOND hit outside the block is a real citation, so this one is not orphaned",
  );

  // A naive reverse check that skips the exclusion entirely (no declarationBlock passed) reports
  // this name as cited by virtue of its own declaration line, which is precisely the bug: it can
  // never find an orphan.
  const noExclusion = planReverseBranchDrift(
    [hit("src/run-task.ts", 105, "heartbeat-azure")],
    ["main"],
    ["heartbeat-azure"],
    undefined,
  );
  assert.deepEqual(
    noExclusion.orphanDeclarations,
    [],
    "measured: WITHOUT the exclusion the declaration satisfies the very grep meant to test it",
  );
});

// ── CRITERION 4: the ephemeral-guard false positive design (iii)/(iv) guards against ─────────

test("a declared branch that is legitimately absent from the remote is not reported as a dangling citation", () => {
  // `feedback-landing` is exactly this on the real repo: recreated by `landFeedback`, routinely
  // absent from origin between landings, and cited outside the declaration block by its own
  // header comment.
  const citations = [hit("src/lib/feedback.ts", 12, "feedback-landing")];
  const drift = planReverseBranchDrift(
    citations,
    ["main"], // feedback-landing is NOT on the remote right now
    DECLARED_BRANCH_GUARDS, // but it IS declared
    BLOCK,
  );
  assert.deepEqual(
    drift.danglingCitations,
    [],
    "declared names are subtracted from the dangling-citation arm too — design (iii)",
  );
});

// ── CRITERION 6: an unreadable declaration-span source excludes nothing, rather than aborting ─

test("a readFile failure while locating the declaration block degrades to no exclusion, not a crash", () => {
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return "a1\trefs/heads/main\n";
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-parse") return "a1a1a1\n";
    if (args[0] === "grep" && args.includes("-o")) {
      // Cite every declared name (all at src/run-task.ts:1, where the un-excluded declaration
      // itself lives) so drift stays at zero regardless of whether the exclusion applied — this
      // test is about the readFile failure being caught, not about the exclusion's effect.
      return DECLARED_BRANCH_GUARDS.map((n) => `src/run-task.ts:1:${n}`).join("\n");
    }
    if (args[0] === "grep") throw new Error("exit 1: no match");
    if (cmd === "gh") return "[]";
    return "";
  };
  const readFile = (): string => {
    throw new Error("ENOENT: simulated unreadable src/run-task.ts");
  };
  const realLog = console.log;
  const realErr = console.error;
  console.log = () => {};
  console.error = () => {};
  let code: number;
  try {
    code = reapBranchesCommand([], { exec, readFile });
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  assert.equal(
    code,
    0,
    "a readFile failure is caught and degrades to declarationBlock=undefined, never an uncaught throw",
  );
});

// ── CRITERION 5: the report changes what is REPORTED, never what is deleted or withheld ──────

test("the set of branches deleted and the set withheld are unchanged by the added report", () => {
  const runWithCitationGrep = (citationRaw: string): { code: number; out: string[] } => {
    const exec = (cmd: string, args: string[]): string => {
      if (args[0] === "ls-remote") return "a1\trefs/heads/main\nb2\trefs/heads/gone-to-main\nc3\trefs/heads/held-branch\n";
      if (args[0] === "merge-base") {
        if (args.includes("origin/gone-to-main")) return ""; // ancestor: deletable
        throw new Error("not an ancestor"); // held-branch: unique commits
      }
      if (args[0] === "rev-parse") return "b2b2b2\n";
      if (args[0] === "grep" && args.includes("-o")) return citationRaw;
      if (args[0] === "grep") throw new Error("exit 1: no match"); // forward check: nothing named
      if (cmd === "gh") return "[]";
      return "";
    };
    const realLog = console.log;
    const realErr = console.error;
    const out: string[] = [];
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    console.error = () => {};
    let code: number;
    try {
      code = reapBranchesCommand([], { exec });
    } finally {
      console.log = realLog;
      console.error = realErr;
    }
    return { code, out };
  };

  // Run A: the citation scan finds every declared name cited outside the block, plus nothing
  // extra — no reverse drift of either kind.
  const clean = runWithCitationGrep(DECLARED_BRANCH_GUARDS.map((n) => `src/run-task.ts:1:${n}`).join("\n"));
  // Run B: the SAME remote/PR/merge-base facts, but the citation scan ALSO turns up a dangling
  // citation (a deleted branch's name, still mentioned somewhere) — pure reverse-drift noise.
  const withDangling = runWithCitationGrep(
    [...DECLARED_BRANCH_GUARDS.map((n) => `src/run-task.ts:1:${n}`), "src/lib/dispatch-claim.ts:9:run-W1-T99-1700000000000"].join(
      "\n",
    ),
  );

  assert.equal(clean.code, 0, "no drift of any kind — exits clean");
  assert.equal(withDangling.code, 1, "a dangling citation alone is enough to fail the run");

  const deletableLine = (out: string[]): string | undefined => out.find((l) => l.startsWith("deletable:"));
  const holdLine = (out: string[]): string | undefined => out.find((l) => l.startsWith("hold:"));
  assert.equal(
    deletableLine(clean.out),
    deletableLine(withDangling.out),
    "the deletable bucket is identical whether or not the reverse report fires",
  );
  assert.equal(
    holdLine(clean.out),
    holdLine(withDangling.out),
    "the held bucket is identical too — this task changes what is REPORTED, never what is deleted or withheld",
  );
});
