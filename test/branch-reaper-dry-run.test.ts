/**
 * W1-T447 — A DRY-RUN BRANCH REAPER, WHICH DELETES NOTHING BY DESIGN.
 *
 * 105 branches had accumulated on origin and a session purged 55 BY HAND. That is plumbing
 * leaking into view: the harness is the product and GitHub is plumbing, so hand-purging is the
 * GitHub time the fleet exists to remove.
 *
 * THIS IS RESIDUE, NOT AN ABSENT FEATURE: `gh pr merge --squash --delete-branch` already fires at
 * four merge/close sites, so every accumulated branch ESCAPED that path.
 *
 * FOUR BRANCHES A NAIVE SWEEP DESTROYS, and each is why protection is evaluated FIRST:
 * `heartbeat` (live transport, force-pushed PARENTLESS ROOT COMMITS every ~5 min, so ordinary
 * recency heuristics misread it), `decisions-landing` (a code CONSTANT and simultaneously the head
 * of a merged PR — the delete rule matches it), and two `diag/*` branches cited by doc comments as
 * the forensic record behind live guards.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planBranchReap, type BranchFacts } from "../src/lib/status.js";
import { DECLARED_BRANCH_GUARDS, reapBranchesCommand } from "../src/run-task.js";

const f = (name: string, over: Partial<BranchFacts> = {}): BranchFacts => ({
  name,
  prState: "none",
  tipInMain: false,
  namedInSource: false,
  ...over,
});

// ── DIRECTION 1: the third disjunct — already an ancestor of main ─────────────────────────────

test("a no-PR branch whose tip is ALREADY IN MAIN is deletable, and one with unique commits is held", () => {
  const plan = planBranchReap(
    [f("merged-into-main", { tipInMain: true }), f("has-unique-work", { tipInMain: false })],
    DECLARED_BRANCH_GUARDS,
  );
  // The whole safety argument of this disjunct: every commit exists in main, so dropping the ref
  // cannot lose information. The other branch's commits exist nowhere else.
  assert.deepEqual(plan.deletable, ["merged-into-main"]);
  assert.deepEqual(plan.hold, ["has-unique-work"]);
});

test("a merged PR head and a closed-unmerged PR head are both deletable; an OPEN one is never", () => {
  const plan = planBranchReap(
    [f("was-merged", { prState: "merged" }), f("was-closed", { prState: "closed" }), f("still-open", { prState: "open" })],
    DECLARED_BRANCH_GUARDS,
  );
  assert.deepEqual(plan.deletable.sort(), ["was-closed", "was-merged"]);
  assert.deepEqual(plan.hold, ["still-open"], "an open PR is in use — held, not guarded, and never deletable");
});

// ── DIRECTION 2: protection is derived, and it WINS over the delete rule ──────────────────────

test("a branch named in source is guarded even when the delete rule also matches it", () => {
  // `decisions-landing` is exactly this shape on the real repo: the head of a MERGED PR AND a live
  // code constant. Evaluated the other way round the fleet would delete a branch its own src names.
  const plan = planBranchReap(
    [f("decisions-landing", { prState: "merged", namedInSource: true })],
    DECLARED_BRANCH_GUARDS,
  );
  assert.deepEqual(plan.guarded, ["decisions-landing"]);
  assert.deepEqual(plan.deletable, [], "protection is evaluated FIRST and wins outright");
});

test("heartbeat is guarded on the name alone — it carries no PR and no main ancestry to reason from", () => {
  const plan = planBranchReap([f("heartbeat", { prState: "none", tipInMain: false, namedInSource: true })], DECLARED_BRANCH_GUARDS);
  assert.deepEqual(plan.guarded, ["heartbeat"]);
  assert.deepEqual(plan.hold, []);
  assert.deepEqual(plan.deletable, []);
});

test("main is never a candidate, whatever else is true of it", () => {
  const plan = planBranchReap([f("main", { prState: "merged", tipInMain: true })], []);
  assert.deepEqual(plan.guarded, ["main"]);
  assert.deepEqual(plan.deletable, []);
  assert.deepEqual(plan.undeclaredGuards, [], "main is guarded structurally, so it is never drift");
});

// ── DIRECTION 3: the drift alarm — declared list vs the derived one ───────────────────────────

test("a source-named branch MISSING from the declared list is reported as drift, not swept", () => {
  const plan = planBranchReap([f("diag/drain-concurrency", { namedInSource: true })], ["main"]);
  assert.deepEqual(plan.guarded, ["diag/drain-concurrency"], "it is still protected — the grep saw it");
  assert.deepEqual(
    plan.undeclaredGuards,
    ["diag/drain-concurrency"],
    "and the omission is REPORTED, because a declared list that silently disagrees with the grep is the rot this pairs against",
  );
});

test("a declared guard the grep cannot see is still guarded and is NOT drift", () => {
  // `feedback-landing` is exactly this: absent from origin between landings, recreated by
  // LANDING_BRANCH, and referenced only through a variable — nothing for a name grep to find.
  const plan = planBranchReap([f("feedback-landing", { prState: "merged" })], DECLARED_BRANCH_GUARDS);
  assert.deepEqual(plan.guarded, ["feedback-landing"]);
  assert.deepEqual(plan.deletable, []);
  assert.deepEqual(plan.undeclaredGuards, [], "declared-but-ungreppable is the case the list exists for, not a fault");
});

// ── DIRECTION 4: the command deletes nothing, and refuses an unreadable corpus ────────────────

test("the dry run issues NO delete call of any kind", () => {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "ls-remote") return "abc123\trefs/heads/main\ndef456\trefs/heads/stale-one\n";
    if (args[0] === "merge-base") return ""; // ancestor: succeeds
    if (args[0] === "rev-parse") return "def4567890\n";
    // The reverse-drift citation scan (W1-T2226) uses `-o`; the forward per-branch check below
    // doesn't. Answer it as "every declared name is cited outside the declaration block" so this
    // test's synthetic "nothing is named in source" world stays about the FORWARD direction only.
    if (args[0] === "grep" && args.includes("-o")) {
      return DECLARED_BRANCH_GUARDS.map((n) => `src/run-task.ts:1:${n}`).join("\n");
    }
    if (args[0] === "grep") throw new Error("exit 1: no match");
    if (cmd === "gh") return "[]";
    return "";
  };
  const code = reapBranchesCommand([], { exec });
  assert.equal(code, 0);
  const destructive = calls.filter(
    (c) => c.includes("--delete") || c.includes("push") || c.includes("-D") || c.includes("--force"),
  );
  assert.deepEqual(destructive, [], "a dry run that ever issued a delete would be the defect, not the feature");
});

test("an EMPTY branch listing is refused rather than reported as three empty buckets", () => {
  // The positive control: a repo it could not read and a repo with nothing to do produce the same
  // three empty buckets, so the answer must distinguish them.
  const exec = (_cmd: string, args: string[]): string => (args[0] === "ls-remote" ? "" : "");
  const realErr = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  let code: number;
  try {
    code = reapBranchesCommand([], { exec });
  } finally {
    console.error = realErr;
  }
  assert.equal(code, 1, "an unreadable corpus must fail, never report an empty answer");
  assert.match(errs.join("\n"), /returned NO branches/);
});

test("drift exits non-zero — the ci-parity shape, not a note in passing", () => {
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return "a1\trefs/heads/main\nb2\trefs/heads/some-infra-branch\n";
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    if (args[0] === "rev-parse") return "b2b2b2\n";
    if (args[0] === "grep") return "src/lib/somewhere.ts\n"; // named in source, undeclared
    if (cmd === "gh") return "[]";
    return "";
  };
  const realErr = console.error;
  const realLog = console.log;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  console.log = () => {};
  let code: number;
  try {
    code = reapBranchesCommand([], { exec });
  } finally {
    console.error = realErr;
    console.log = realLog;
  }
  assert.equal(code, 1, "an undeclared guard fails the run");
  assert.match(errs.join("\n"), /MISSING from DECLARED_BRANCH_GUARDS/);
  assert.match(errs.join("\n"), /some-infra-branch/, "and names which one");
});

test("an unknown flag is refused before anything is read", () => {
  const realErr = console.error;
  console.error = () => {};
  let code: number;
  try {
    code = reapBranchesCommand(["--force"], { exec: () => { throw new Error("must not read"); } });
  } finally {
    console.error = realErr;
  }
  assert.equal(code, 2, "arg validation runs before the first git call, so a typo cannot start a scan");
});

test("a FAILED PR read makes every branch read OPEN — never 'no PR' (W1-T119)", () => {
  // The conservative direction on purpose: an open PR is never deletable, so an unreadable
  // GitHub can only ever UNDER-reap. Treating the failure as "no PR" would do the opposite.
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return "a1\trefs/heads/main\nb2\trefs/heads/would-be-deletable\n";
    if (cmd === "gh") throw new Error("gh: API rate limit exceeded");
    if (args[0] === "merge-base") return ""; // ancestor — would be deletable if PR state said none
    // See the sibling test above: `-o` is the reverse-drift citation scan (W1-T2226), answered as
    // fully cited so this test stays about the forward PR-read-failure direction only.
    if (args[0] === "grep" && args.includes("-o")) {
      return DECLARED_BRANCH_GUARDS.map((n) => `src/run-task.ts:1:${n}`).join("\n");
    }
    if (args[0] === "grep") throw new Error("exit 1");
    if (args[0] === "rev-parse") return "b2b2b2\n";
    return "";
  };
  const realLog = console.log; const out: string[] = [];
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  let code: number;
  try { code = reapBranchesCommand([], { exec }); } finally { console.log = realLog; }
  assert.equal(code, 0);
  assert.match(out.join("\n"), /deletable: 0/, "an unreadable PR read must not hand back a deletable branch");
  assert.match(out.join("\n"), /hold: *1/);
});

test("the dry run LEDGERS its answer, so a report nobody read is still on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "reap-ledger-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") return "a1\trefs/heads/main\nb2\trefs/heads/gone-to-main\n";
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-parse") return "b2b2b2\n";
    if (args[0] === "grep") throw new Error("exit 1");
    if (cmd === "gh") return "";
    return "";
  };
  const realLog = console.log;
  console.log = () => {};
  try { reapBranchesCommand([], { exec, ledgerPath }); } finally { console.log = realLog; }
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const row = rows.find((r) => r.step === "branch_reap.dry_run");
  assert.ok(row, "the run must leave a ledger row");
  assert.equal(row.branches, 2);
  assert.equal(row.deletable, 1, "and carry the counts, not just the fact that it ran");
  assert.equal(row.guarded, 1);
  rmSync(dir, { recursive: true, force: true });
});
