/**
 * W1-T2246 — THE HOLD SET IS MOSTLY MISLABELLED.
 *
 * `planBranchReap`'s (`src/lib/status.ts`) `deletable` predicate is
 * `prState === "merged" || prState === "closed" || (prState === "none" && tipInMain)`. Measured
 * against a COMPLETE PR corpus read (`gh api --paginate`, 2,233 rows) on 2026-08-24: of 74
 * branches the fleet's own dry run (`rmd reap-branches`, `reapBranchesCommand` in
 * `src/run-task.ts`) reported held "because no PR", 41 actually have a PR head this predicate
 * would call deletable (17 merged, 24 closed-unmerged) — because `prState` came from a
 * DATE-DESCENDING PAGINATED WALK CAPPED AT 8 PAGES (800 rows), and an old PR outside that window
 * reads identically to a branch that never had one. The true hold set is 33 (29 genuinely no-PR
 * plus 4 open), not 74, and the manifest could not tell an operator which was which.
 *
 * A SECOND, INDEPENDENT SOURCE OF THE SAME MISLABEL: `tipInMain` came from
 * `git merge-base --is-ancestor origin/<name> origin/main` against a LOCAL remote-tracking ref.
 * On a checkout that never fetched that ref the command fails with
 * `fatal: Not a valid object name`, and the old `catch` collapsed that into `tipInMain = false` —
 * indistinguishable from a tip genuinely NOT an ancestor of main.
 *
 * THIS TASK DOES NOT ADD DELETION. It fixes the two reads and separates "confirmed no PR" from
 * "could not tell" within the (unchanged) `hold` disposition, so a later, separate proposal about
 * deleting has something trustworthy to act on (design (iii)/(iv)).
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

// ── CLAIM: undetermined vs confirmed no-PR are different reasons for the same disposition ─────

test("a branch whose PR state could not be determined is held and flagged undetermined, not held as 'no PR'", () => {
  const plan = planBranchReap(
    [f("could-not-tell", { prState: "unknown" }), f("confirmed-no-pr", { prState: "none", tipInMain: false })],
    DECLARED_BRANCH_GUARDS,
  );
  // Same disposition — neither is swept.
  assert.deepEqual(plan.hold.sort(), ["confirmed-no-pr", "could-not-tell"]);
  assert.deepEqual(plan.deletable, []);
  // Different reason — only the unproven one is flagged, so an operator can tell them apart.
  assert.deepEqual(
    plan.undetermined,
    ["could-not-tell"],
    "the confirmed no-PR branch must NOT be reported as undetermined, and vice versa",
  );
});

test("prState 'none' paired with an unreadable tip is held and ALSO flagged undetermined", () => {
  // The third disjunct's own precondition (tipInMain === true) was never provable here either
  // way — collapsing that into a decided 'false' is exactly the §6 defect this task closes.
  const plan = planBranchReap([f("unreadable-tip", { prState: "none", tipInMain: "unknown" })], DECLARED_BRANCH_GUARDS);
  assert.deepEqual(plan.hold, ["unreadable-tip"]);
  assert.deepEqual(plan.undetermined, ["unreadable-tip"]);
  assert.deepEqual(plan.deletable, [], "an unproven tip must never satisfy the third disjunct");
});

// ── CLAIM: a merged PR outside the bulk paginated window is classified from a complete read ────

test("a merged PR head the bulk paginated walk missed is found by the per-head follow-up and reported deletable", () => {
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return "a1\trefs/heads/main\nb2\trefs/heads/old-merged-outside-window\n";
    if (cmd === "gh") {
      // The bulk `pulls?state=all&...` walk (no `head=` filter) finds nothing in its window;
      // the per-head `pulls?head=owner:branch&...` follow-up proves this ONE branch's own PR
      // history directly and finds the merged PR the bulk walk's window missed.
      const endpoint = args[1] ?? "";
      return endpoint.includes("head=") ? "closed\ttrue" : "";
    }
    if (args[0] === "merge-base") throw new Error("not an ancestor"); // irrelevant: prState alone deletes it
    if (args[0] === "rev-parse") return "deadbeef00\n";
    // Reverse-drift citation scan (`-o`) answered as fully cited so this stays about the PR read.
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
  assert.match(out.join("\n"), /deletable: 1/, "a merged head outside the bulk window must not default to held");
  assert.match(out.join("\n"), /deadbeef00\told-merged-outside-window/, "and the manifest still prints sha with name");
  assert.match(out.join("\n"), /hold: *0/);
});

// ── CLAIM: an unreadable local ref does not silently become "commits not in main" ──────────────

test("an origin ref never fetched on this checkout is reported undetermined, never a decided 'not in main'", () => {
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return "a1\trefs/heads/main\nb2\trefs/heads/never-fetched\n";
    if (cmd === "gh") return ""; // confirmed no PR anywhere — bulk walk AND per-head follow-up both empty
    // Real git: `--is-ancestor` against a ref this checkout never fetched fails this way, and
    // `execFileSync` folds the child's stderr into the thrown Error's message.
    if (args[0] === "merge-base") throw new Error("fatal: Not a valid object name origin/never-fetched\n");
    if (args[0] === "rev-parse") return "b2b2b2\n";
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
  assert.match(out.join("\n"), /deletable: 0/, "an unproven tip must never be swept as deletable");
  assert.match(out.join("\n"), /hold: *1/);
  assert.match(out.join("\n"), /1 state undetermined/, "the unreadable ref must be flagged apart from a confirmed no-PR hold");
  assert.match(out.join("\n"), /undetermined: never-fetched/);
});

// ── CLAIM: an open PR is still never deletable and still lands in hold ─────────────────────────

test("an open PR is still never deletable and still lands in hold — and is NOT reported undetermined", () => {
  const plan = planBranchReap([f("still-open", { prState: "open" })], DECLARED_BRANCH_GUARDS);
  assert.deepEqual(plan.hold, ["still-open"]);
  assert.deepEqual(plan.deletable, []);
  assert.deepEqual(
    plan.undetermined,
    [],
    "an open PR is a DECIDED reason to hold (in use), not an unproven read",
  );
});

// ── CLAIM: protection is still evaluated first and still wins over every delete disjunct ───────

test("protection is evaluated first and wins outright, even over a merged PR head with its tip in main", () => {
  const plan = planBranchReap(
    [f("guarded-but-mergeable", { prState: "merged", tipInMain: true, namedInSource: true })],
    DECLARED_BRANCH_GUARDS,
  );
  assert.deepEqual(plan.guarded, ["guarded-but-mergeable"]);
  assert.deepEqual(plan.deletable, [], "guarded wins outright, whatever the delete predicate would say");
  assert.deepEqual(plan.hold, []);
  assert.deepEqual(plan.undetermined, []);
});

// ── CLAIM: the manifest still prints sha with name on stdout, and the run still deletes nothing ─

test("the manifest prints sha with name for every deletable branch, and the run issues no delete call", () => {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "ls-remote") return "a1\trefs/heads/main\nb2\trefs/heads/merged-elsewhere\n";
    if (cmd === "gh") {
      const endpoint = args[1] ?? "";
      return endpoint.includes("head=") ? "closed\ttrue" : "";
    }
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    if (args[0] === "rev-parse") return "deadbeef00\n";
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
  assert.match(
    out.join("\n"),
    /deadbeef00\tmerged-elsewhere/,
    "sha and name printed together — the only thing that makes a later hand delete reversible",
  );
  const destructive = calls.filter(
    (c) => c.includes("--delete") || c.includes("push") || c.includes("-D") || c.includes("--force"),
  );
  assert.deepEqual(destructive, [], "still a dry run — nothing here issues a delete");
});
