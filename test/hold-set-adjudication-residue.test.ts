/**
 * W1-T2247 — THE HOLD SET HAS NEVER BEEN READ.
 *
 * `rmd reap-branches` holds every branch with no PR and commits not in main and nothing has ever
 * asked what the work is. Two mechanical passes shrink that set before any judgement is needed
 * (design (i)): patch-id equivalence (`git cherry -v origin/main origin/<branch>`) resolves a
 * held branch whose commits are already content-identical to something in main, and PR state
 * resolves a closed-unmerged PR (already declined) and a squash-merged PR (`git cherry`'s own
 * blind spot — a squash collapses commits into one new diff on main, so patch-id alone would
 * misreport the branch as absent). What survives BOTH passes is the residue that actually needs
 * an operator's judgement, and W1-T2247 rationale §4 measures that residue at 20 branches against
 * a naively-held 75.
 *
 * This file proves each acceptance claim against `src/lib/status.ts`'s `planBranchReap` (the
 * three-disjoint-bucket classifier, now four disjuncts wide) and its new adjudication-verdict
 * gate, `admitAdjudicationVerdict`. Nothing here deletes a branch or calls `git cherry` itself —
 * `BranchFacts.patchIdEquivalentInMain` is the caller-supplied FACT (W1-T447's own seam: the
 * caller gathers facts, this module only classifies them), same shape as `tipInMain` and
 * `prState` already are.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitAdjudicationVerdict,
  planBranchReap,
  type AdjudicationVerdict,
  type BranchFacts,
} from "../src/lib/status.js";
import { DECLARED_BRANCH_GUARDS, reapBranchesCommand } from "../src/run-task.js";

const f = (name: string, over: Partial<BranchFacts> = {}): BranchFacts => ({
  name,
  prState: "none",
  tipInMain: false,
  namedInSource: false,
  ...over,
});

// ── CLAIM: a held branch whose commits are patch-equivalent in main needs no judgement ──────────

test("a held branch whose commits are patch-equivalent in main is resolved without any judgement step", () => {
  const plan = planBranchReap(
    [f("cherry-picked-by-hand", { prState: "none", tipInMain: false, patchIdEquivalentInMain: true })],
    DECLARED_BRANCH_GUARDS,
  );
  assert.deepEqual(plan.deletable, ["cherry-picked-by-hand"], "resolved, not left in the hold set");
  assert.deepEqual(plan.hold, []);
  assert.deepEqual(plan.undetermined, [], "a resolved branch is not also flagged as unproven");
  assert.equal(plan.reasons["cherry-picked-by-hand"], "patch_id_equivalent");
});

test("patch-id equivalence never fires when tipInMain already decided it — no double-counting the disjuncts", () => {
  // The ancestor disjunct alone already resolves this; the reason names the disjunct that fired.
  const plan = planBranchReap(
    [f("already-ancestor", { prState: "none", tipInMain: true, patchIdEquivalentInMain: false })],
    DECLARED_BRANCH_GUARDS,
  );
  assert.deepEqual(plan.deletable, ["already-ancestor"]);
  assert.equal(plan.reasons["already-ancestor"], "tip_in_main");
});

test("a mixed patch-id result (some commits equivalent, some not) is NOT resolved — still needs judgement", () => {
  const plan = planBranchReap(
    [f("half-landed", { prState: "none", tipInMain: false, patchIdEquivalentInMain: false })],
    DECLARED_BRANCH_GUARDS,
  );
  assert.deepEqual(plan.hold, ["half-landed"]);
  assert.deepEqual(plan.deletable, []);
  assert.equal(plan.reasons["half-landed"], "no_pr_ever");
});

// ── CLAIM: a squash-merged PR is not reported absent merely because its patch id differs ────────

test("a branch whose PR squash-merged is not reported as absent merely because its patch id differs", () => {
  // `git cherry` reads every commit `+` (absent) after a squash collapses them into one new diff
  // on main — VERIFIED shape from rationale §3 (run-W1-T404, PR #1709). `prState` still proves it
  // landed, and that proof must never be overridden by the patch-id read.
  const plan = planBranchReap(
    [f("squash-landed", { prState: "merged", tipInMain: false, patchIdEquivalentInMain: false })],
    DECLARED_BRANCH_GUARDS,
  );
  assert.deepEqual(plan.deletable, ["squash-landed"], "merged still wins outright over a differing patch id");
  assert.deepEqual(plan.hold, []);
  assert.equal(
    plan.reasons["squash-landed"],
    "merged_squash_patch_id_differs",
    "the reason names the squash blind spot rather than collapsing it into the plain 'merged' reason",
  );
});

test("an ordinary merged PR whose patch id was never measured still reads as plain 'merged'", () => {
  const plan = planBranchReap([f("plain-merge", { prState: "merged" })], DECLARED_BRANCH_GUARDS);
  assert.deepEqual(plan.deletable, ["plain-merge"]);
  assert.equal(plan.reasons["plain-merge"], "merged");
});

// ── CLAIM: a closed-unmerged PR is reported as already declined, not as unknown ──────────────────

test("a branch whose PR was closed unmerged is reported as already declined rather than as unknown", () => {
  const plan = planBranchReap([f("declined", { prState: "closed" })], DECLARED_BRANCH_GUARDS);
  assert.deepEqual(plan.deletable, ["declined"]);
  assert.deepEqual(plan.undetermined, [], "a closed-unmerged PR is a DECIDED human ruling, not an unproven read");
  assert.equal(plan.reasons["declined"], "closed_unmerged");
  assert.notEqual(plan.reasons["declined"], "state_undetermined");
});

// ── CLAIM: each bucket names the test that placed it there, never one shared reason string ───────

test("each bucket names the test that placed it there rather than sharing one reason string", () => {
  const plan = planBranchReap(
    [
      f("guarded-one", { namedInSource: true }),
      f("merged-one", { prState: "merged" }),
      f("squash-one", { prState: "merged", patchIdEquivalentInMain: false }),
      f("closed-one", { prState: "closed" }),
      f("ancestor-one", { tipInMain: true }),
      f("patch-equiv-one", { patchIdEquivalentInMain: true }),
      f("open-one", { prState: "open" }),
      f("no-pr-one"),
      f("unproven-one", { prState: "unknown" }),
    ],
    DECLARED_BRANCH_GUARDS,
  );
  const reasonsSeen = new Set(Object.values(plan.reasons));
  assert.ok(
    reasonsSeen.size >= 8,
    `expected at least 8 distinct reasons across 9 branches, saw ${reasonsSeen.size}: ${[...reasonsSeen].join(", ")}`,
  );
  // Every declared reason is one of the typed vocabulary — never a free-form or shared string.
  const vocabulary = new Set([
    "protected",
    "merged",
    "merged_squash_patch_id_differs",
    "closed_unmerged",
    "tip_in_main",
    "patch_id_equivalent",
    "open",
    "no_pr_ever",
    "state_undetermined",
  ]);
  for (const [branch, reason] of Object.entries(plan.reasons)) {
    assert.ok(vocabulary.has(reason), `${branch} carries an undeclared reason: ${reason}`);
  }
});

// ── CLAIM: an adjudication verdict citing neither a plan task nor a tree symbol is refused ───────

test("an adjudication verdict that cites neither a plan task nor a current tree symbol is refused", () => {
  const verdict: AdjudicationVerdict = { branch: "diag/resume-spawn-enoent", verdict: "still needed" };
  const admission = admitAdjudicationVerdict(verdict);
  assert.equal(admission.admissible, false);
  assert.match(admission.refusalReason ?? "", /cites neither/);
  assert.match(admission.refusalReason ?? "", /refused/);
});

test("an adjudication verdict citing a plan task id is admitted", () => {
  const verdict: AdjudicationVerdict = {
    branch: "diag/resume-spawn-enoent",
    verdict: "still needed",
    citation: { kind: "plan_task", taskId: "W1-T2247" },
  };
  const admission = admitAdjudicationVerdict(verdict);
  assert.equal(admission.admissible, true);
  assert.equal(admission.refusalReason, undefined);
});

test("an adjudication verdict citing a current tree symbol is admitted", () => {
  const verdict: AdjudicationVerdict = {
    branch: "diag/resume-spawn-enoent",
    verdict: "no longer needed",
    citation: { kind: "tree_symbol", path: "src/lib/status.ts", exists: true },
  };
  const admission = admitAdjudicationVerdict(verdict);
  assert.equal(admission.admissible, true);
});

test("a tree-symbol citation with an empty path is refused just as an absent citation is", () => {
  const verdict: AdjudicationVerdict = {
    branch: "diag/resume-spawn-enoent",
    verdict: "still needed",
    citation: { kind: "tree_symbol", path: "  ", exists: false },
  };
  const admission = admitAdjudicationVerdict(verdict);
  assert.equal(admission.admissible, false);
});

// ── CLAIM: the run still deletes nothing and still prints the manifest with sha and name ─────────

test("the run still deletes nothing and still prints the manifest with sha and name on stdout", () => {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "ls-remote") {
      return "a1\trefs/heads/main\nb2\trefs/heads/patch-equivalent-branch\nc3\trefs/heads/held-branch\n";
    }
    if (cmd === "gh") return ""; // confirmed no PR anywhere, for both branches
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    if (args[0] === "rev-parse") return "cafef00d00\n";
    if (args[0] === "grep" && args.includes("-o")) {
      return DECLARED_BRANCH_GUARDS.map((n) => `src/run-task.ts:1:${n}`).join("\n");
    }
    if (args[0] === "grep") throw new Error("exit 1: no match");
    return "";
  };
  const realLog = console.log;
  const out: string[] = [];
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  let code: number;
  try {
    code = reapBranchesCommand([], { exec });
  } finally {
    console.log = realLog;
  }
  assert.equal(code, 0);
  // `reapBranchesCommand` itself never sets `patchIdEquivalentInMain` (that fact is gathered by a
  // caller this task does not wire up — see the PR body), so both branches read as confirmed
  // no-PR holds here; the point of this test is the invariant that never changes: no delete call,
  // manifest still sha+name on stdout, dry run still announced.
  assert.match(out.join("\n"), /hold: *2/);
  assert.match(out.join("\n"), /DRY RUN — nothing was deleted\./);
  const destructive = calls.filter(
    (c) => c.includes("--delete") || c.includes("push") || c.includes("-D") || c.includes("--force"),
  );
  assert.deepEqual(destructive, [], "still a dry run — nothing here issues a delete");
});

test("planBranchReap itself never mutates its input facts and never issues a delete-shaped call", () => {
  const facts: BranchFacts[] = [
    f("a", { patchIdEquivalentInMain: true }),
    f("b", { prState: "merged", patchIdEquivalentInMain: false }),
    f("c", { prState: "closed" }),
  ];
  const before = JSON.stringify(facts);
  planBranchReap(facts, DECLARED_BRANCH_GUARDS);
  assert.equal(JSON.stringify(facts), before, "facts are read, never rewritten");
});
