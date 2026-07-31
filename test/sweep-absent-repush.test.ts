import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ABSENT_REPUSH_CAP,
  DEFAULT_SWEEP_POLICY,
  absentChecksRepushDecision,
  observedBlockerState,
  runSweep,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { gitPushEmptyCommit } from "../src/lib/git-push.js";
import { readLedgerLines } from "../src/lib/status.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

// ── Fixture clock. Pinned, and every age-sensitive assertion passes it explicitly: the
// ABSENT remedy is time-gated, so a wall-clock read here would make these tests rot exactly
// the way the 2026-07-30 staleDays time bomb did.
const NOW = Date.parse("2026-07-30T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-absent-repush-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 921,
    prUrl: "https://github.com/craigoley/remudero/pull/921",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "none",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: minsAgo(60),
    headSha: "35d636d454cc",
    headRefName: "run-W1-T253-1785378652634",
    autoMergeArmed: false,
    ...over,
  };
}

const NO_PRIOR = { count: 0, shas: new Set<string>() };

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
  repushed: OpenPrView[];
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
} {
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  const repushed: OpenPrView[] = [];
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  return {
    escalated,
    repushed,
    fixed,
    arm: () => {},
    close: () => {},
    dispatchFix: (p, evidence) => {
      fixed.push({ pr: p, evidence });
    },
    escalate: (p, reason, question) => {
      escalated.push({ pr: p, reason, question });
    },
    repushAbsent: async (p) => {
      repushed.push(p);
      return "fffnew1";
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-ABSENT-1",
    now: () => NOW,
    ...overrides,
  };
}

// ── THE DISCRIMINATOR: the three real cases the trap names ──────────────────────────────────

test("ABSENT discriminator: #921's genuinely-absent head re-pushes, a merely-starting PR does not, and a red PR is untouched", () => {
  // 1. #921's recorded shape: zero check runs, an hour old, no review yet.
  const absent = pr({ checksState: "none", lastActivityAt: minsAgo(60) });
  assert.equal(observedBlockerState(absent), "ABSENT");
  const d1 = absentChecksRepushDecision(absent, DEFAULT_SWEEP_POLICY, NOW, NO_PRIOR);
  assert.equal(d1.repush, true, "#921's shape is the one the remedy exists for");
  assert.match(d1.reason, /no check-suite/);

  // 2. A normal PR whose checks are merely starting. Two independent facts stop it, and the
  //    test asserts BOTH so neither can silently become the only guard.
  const startingByStructure = pr({ checksState: "pending", lastActivityAt: minsAgo(60) });
  assert.equal(observedBlockerState(startingByStructure), "PENDING");
  assert.equal(
    absentChecksRepushDecision(startingByStructure, DEFAULT_SWEEP_POLICY, NOW, NO_PRIOR).repush,
    false,
    "PENDING is never re-pushed — checksStateFromRollup already separates it from an empty rollup",
  );
  const startingByClock = pr({ checksState: "none", lastActivityAt: minsAgo(2) });
  const d2b = absentChecksRepushDecision(startingByClock, DEFAULT_SWEEP_POLICY, NOW, NO_PRIOR);
  assert.equal(d2b.repush, false, "an empty rollup 2 minutes after the push may just be starting");
  assert.match(d2b.reason, /may still be starting/);

  // 3. A PR whose checks completed RED. Not ABSENT at all — the fix rung owns it.
  const red = pr({ checksState: "red", lastActivityAt: minsAgo(60) });
  assert.equal(observedBlockerState(red), "FAILING");
  assert.equal(
    absentChecksRepushDecision(red, DEFAULT_SWEEP_POLICY, NOW, NO_PRIOR).repush,
    false,
    "a red check needs a code fix, never a re-trigger",
  );
});

test("ABSENT discriminator excludes the W1-T176 review-only shape — that is the post-review lane's job", () => {
  // checksState green, only remudero-review missing. observedBlockerState calls this ABSENT too,
  // but its rollup is NOT empty: re-pushing would throw away a green CI run.
  const reviewOnly = pr({ checksState: "green", reviewState: "none", lastActivityAt: minsAgo(60) });
  assert.equal(observedBlockerState(reviewOnly), "ABSENT", "it IS ABSENT by W1-T186's definition");
  const d = absentChecksRepushDecision(reviewOnly, DEFAULT_SWEEP_POLICY, NOW, NO_PRIOR);
  assert.equal(d.repush, false, "but the re-push remedy must not claim it");
  assert.match(d.reason, /post-review lane owns this/);
});

test("ABSENT with no observed head branch stands down rather than guessing where to push", () => {
  const noBranch = pr({ headRefName: undefined, lastActivityAt: minsAgo(60) });
  const d = absentChecksRepushDecision(noBranch, DEFAULT_SWEEP_POLICY, NOW, NO_PRIOR);
  assert.equal(d.repush, false);
  assert.match(d.reason, /head branch name not observed/);
});

test("ABSENT with an undatable head stands down — never re-push on state we cannot date", () => {
  const undatable = pr({ lastActivityAt: "not-a-timestamp" });
  const d = absentChecksRepushDecision(undatable, DEFAULT_SWEEP_POLICY, NOW, NO_PRIOR);
  assert.equal(d.repush, false);
  assert.match(d.reason, /unreadable/);
});

// ── TRAP 2: a passing review must never be discarded ────────────────────────────────────────

test("a PR whose review already PASSED is NOT re-pushed even when it reads ABSENT", () => {
  // remudero-review is posted per head sha, so a fresh sha throws the certification away.
  const reviewed = pr({ reviewState: "success", checksState: "none", lastActivityAt: minsAgo(60) });
  const d = absentChecksRepushDecision(reviewed, DEFAULT_SWEEP_POLICY, NOW, NO_PRIOR);
  assert.equal(d.repush, false, "a passing review outranks the missing suite");
  assert.match(d.reason, /discard the certification/);
});

// ── THE BOUND ───────────────────────────────────────────────────────────────────────────────

test("the ABSENT remedy is bounded per PR — a second observation escalates instead of re-pushing forever", () => {
  const p = pr({ lastActivityAt: minsAgo(60) });
  // Same head already re-pushed: sha-keyed idempotence, the shape prior.fixed/prior.armed use.
  const sameHead = absentChecksRepushDecision(p, DEFAULT_SWEEP_POLICY, NOW, {
    count: 1,
    shas: new Set([`${p.prNumber}@${p.headSha}`]),
  });
  assert.equal(sameHead.repush, false);
  assert.match(sameHead.reason, /already re-pushed this head/);

  // A NEW head (the re-push minted one) with the cap already spent: the sha key would allow it,
  // the per-PR count must not — this is the case that would otherwise chain commits forever.
  const newHead = pr({ headSha: "fffnew1", lastActivityAt: minsAgo(60) });
  const capped = absentChecksRepushDecision(newHead, DEFAULT_SWEEP_POLICY, NOW, {
    count: ABSENT_REPUSH_CAP,
    shas: new Set([`${newHead.prNumber}@35d636d454cc`]),
  });
  assert.equal(capped.repush, false, "the per-PR cap is what bounds a remedy that mints new shas");
  assert.match(capped.reason, /cap reached/);
});

// ── END TO END THROUGH runSweep ─────────────────────────────────────────────────────────────

test("runSweep: an ABSENT PR gets exactly ONE empty-commit re-push, ledgered with both shas and the reason", async () => {
  const deps = fakeDeps();
  await runSweep([pr({ lastActivityAt: minsAgo(60) })], deps, DEFAULT_SWEEP_POLICY);

  assert.equal(deps.repushed.length, 1, "the remedy fired exactly once");
  assert.equal(deps.escalated.length, 0, "and it fired INSTEAD OF this pass's escalation");

  const line = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.absent_repush");
  assert.ok(line, "the re-push must be ledgered — a fire-and-forget action nobody records is invisible state");
  assert.equal(line!.pr_number, 921, "names WHICH pr");
  assert.equal(line!.old_head, "35d636d454cc", "names the OLD head");
  assert.equal(line!.new_head, "fffnew1", "names the NEW head");
  assert.match(String(line!.reason), /no check-suite/, "and WHY");
});

test("runSweep: a second pass over the SAME ABSENT PR escalates instead of re-pushing again", async () => {
  const first = fakeDeps();
  const subject = pr({ lastActivityAt: minsAgo(60) });
  await runSweep([subject], first, DEFAULT_SWEEP_POLICY);
  assert.equal(first.repushed.length, 1);

  // Same ledger (so the prior re-push is visible), and the PR now shows the NEW head — exactly
  // what the next real pass would observe if the fresh sha ALSO got no suites.
  const second = fakeDeps({ ledgerPath: first.ledgerPath });
  await runSweep([pr({ headSha: "fffnew1", lastActivityAt: minsAgo(60) })], second, DEFAULT_SWEEP_POLICY);
  assert.equal(second.repushed.length, 0, "bounded — no second empty commit");
  assert.equal(second.escalated.length, 1, "and the ordinary escalation takes over, as today");
});

test("runSweep: a PENDING PR is never re-pushed — the regression lock against churn", async () => {
  const deps = fakeDeps();
  await runSweep([pr({ checksState: "pending", lastActivityAt: minsAgo(60) })], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.repushed.length, 0, "re-pushing a PR whose checks are running would cancel them");
});

test("runSweep: a RED PR still routes to the existing fix rung, unchanged by this remedy", async () => {
  const deps = fakeDeps();
  await runSweep(
    [pr({ checksState: "red", reviewState: "failure", unmetCriteria: [], lastActivityAt: minsAgo(60) })],
    deps,
    DEFAULT_SWEEP_POLICY,
  );
  assert.equal(deps.repushed.length, 0, "a red check is a code fix, not a re-trigger");
  assert.equal(deps.fixed.length, 1, "and the fix rung still owns it");
});

test("runSweep: with no repushAbsent dep wired the lane stands down to the ordinary escalation, never silently", async () => {
  const deps = fakeDeps({ repushAbsent: undefined });
  await runSweep([pr({ lastActivityAt: minsAgo(60) })], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(deps.escalated.length, 1, "the pre-existing behaviour is what an unwired dep falls back to");
  const disposed = readLedgerLines(deps.ledgerPath).find((l) => l.step === "sweep.disposed");
  assert.match(String(disposed!.stand_down_reason), /ABSENT re-push not wired/, "and it says so on the ledger line");
});

// ── THE PUSH LEAF: real argv, real guard, no remote ─────────────────────────────────────────

test("gitPushEmptyCommit builds an empty commit from the head's OWN tree and fast-forwards the branch", () => {
  const seen: Array<string[]> = [];
  const pushed: Array<string[]> = [];
  const newSha = withLiveWritesAllowed(() =>
    gitPushEmptyCommit("/repo", "run-W1-T253-1785378652634", "35d636d454cc", "chore(ci): re-trigger", {
      capture: (_file, args) => {
        seen.push(args);
        return args[2] === "rev-parse" ? "treeabc\n" : "newsha1\n";
      },
      exec: (_file, args) => {
        pushed.push(args);
      },
    }),
  );

  assert.equal(newSha, "newsha1");
  // The tree comes from the head itself, which is what makes the commit empty by construction.
  assert.deepEqual(seen[0], ["-C", "/repo", "rev-parse", "35d636d454cc^{tree}"]);
  assert.deepEqual(seen[1], ["-C", "/repo", "commit-tree", "treeabc", "-p", "35d636d454cc", "-m", "chore(ci): re-trigger"]);
  // A fast-forward onto the PR's own branch — no --force anywhere.
  assert.deepEqual(pushed[0], ["-C", "/repo", "push", "origin", "newsha1:refs/heads/run-W1-T253-1785378652634"]);
  assert.ok(!pushed[0]!.includes("--force"), "never a force-push — the new commit's parent is the current head");
  // No working-tree verb: the daemon's own checkout must not move (W1-T191).
  const verbs = seen.flat().concat(pushed.flat());
  for (const forbidden of ["commit", "checkout", "add", "reset", "merge"]) {
    assert.ok(!verbs.includes(forbidden), `must never run a working-tree verb (${forbidden})`);
  }
});

test("gitPushEmptyCommit is refused by the live-write guard when not explicitly allowed", () => {
  assert.throws(
    () => gitPushEmptyCommit("/repo", "b", "sha", "m", { capture: () => "x\n", exec: () => {} }),
    /live-write-guard: REFUSED git-push/,
    "the remedy goes through the existing leaf, so the guard covers it by construction",
  );
});

// ── REPLAY: #921's recorded shape ───────────────────────────────────────────────────────────

test("REPLAY #921: the recorded shape re-pushes once where the live sweep escalated 244 times", async () => {
  // #921's own observed facts: zero Actions check-runs on 35d636d, no review posted, and the
  // sweep re-deriving the same blocked-ambiguous disposition every ~64s for 7h45m.
  const observed = pr({ prNumber: 921, headSha: "35d636d454cc", checksState: "none", reviewState: "none" });
  let repushes = 0;
  let escalations = 0;
  const prior = { count: 0, shas: new Set<string>() };
  let head = observed.headSha;

  // 244 passes, exactly as recorded.
  for (let pass = 0; pass < 244; pass++) {
    const view = pr({ headSha: head, lastActivityAt: minsAgo(60) });
    const d = absentChecksRepushDecision(view, DEFAULT_SWEEP_POLICY, NOW, prior);
    if (d.repush) {
      repushes++;
      prior.count += 1;
      prior.shas.add(`${view.prNumber}@${head}`);
      head = `fresh${repushes}`; // the mint
    } else {
      escalations++;
    }
  }

  assert.equal(repushes, 1, "ONE empty commit, not 244");
  assert.equal(escalations, 243, "every later pass falls through to the ordinary escalation");
  assert.equal(prior.count, ABSENT_REPUSH_CAP, "and the bound is what stopped it");
});
