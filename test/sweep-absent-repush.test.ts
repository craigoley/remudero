import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { buildOpenPrViews, buildSweepEffects } from "../src/run-task.js";
import { readLedgerLines } from "../src/lib/status.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
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

test("gitPushEmptyCommit builds an empty commit from the head's OWN tree and leases the push on that head", () => {
  const seen: Array<string[]> = [];
  const pushed: Array<string[]> = [];
  const newSha = withLiveWritesAllowed(() =>
    gitPushEmptyCommit("/repo", "run-W1-T253-1785378652634", "35d636d454cc", "chore(ci): re-trigger", {
      capture: (_file, args) => {
        seen.push(args);
        if (args[2] === "rev-parse") return "treeabc\n";
        if (args[2] === "ls-remote") return "newsha1\trefs/heads/run-W1-T253-1785378652634\n";
        return "newsha1\n";
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
  // The new commit's parent is the believed head, so this IS a fast-forward — but the push also
  // (W1-T1288) carries `--force-with-lease` naming that SAME head, so a foreign/absent ref is
  // refused rather than silently created or replaced (see git-push.ts's doc comment).
  assert.deepEqual(pushed[0], [
    "-C",
    "/repo",
    "push",
    "--force-with-lease=refs/heads/run-W1-T253-1785378652634:35d636d454cc",
    "origin",
    "newsha1:refs/heads/run-W1-T253-1785378652634",
  ]);
  assert.ok(!pushed[0]!.includes("--force"), "the lease is a precondition, not the bare permission flag");
  // The resulting ref value is re-read rather than trusted from the exit code alone (the
  // measured elision trap: a lease git elides still exits 0 without ever checking it).
  assert.deepEqual(seen[2], ["-C", "/repo", "ls-remote", "origin", "refs/heads/run-W1-T253-1785378652634"]);
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

// ── THE REAL WIRING (buildSweepEffects), driven with a recorder ─────────────────────────────
// Imports run-task.ts but dispatches NOTHING: only the repushAbsent closure is invoked, and its
// push goes to an injected recorder. No worker, no runTask, no remote.

test("buildSweepEffects wires repushAbsent to the push leaf with the PR's own branch, head, and a self-describing message", async () => {
  const calls: Array<{ repoDir: string; branch: string; head: string; message: string }> = [];
  const effects = buildSweepEffects(
    "craigoley",
    "remudero",
    { claudeBin: "/bin/true", root: "/nonexistent-bh-root" } as never,
    join(mkdtempSync(join(tmpdir(), "rmd-bh-eff-")), "ledger.ndjson"),
    "SWEEP-EFF-1",
    { tasks: [], byId: new Map() } as never,
    () => {},
    DEFAULT_SWEEP_POLICY,
    async () => 0,
    undefined,
    (repoDir, branch, head, message) => {
      calls.push({ repoDir, branch, head, message });
      return "mintedsha";
    },
  );

  const minted = await effects.repushAbsent!(pr({ headRefName: "run-W1-T253-1785378652634", headSha: "35d636d454cc" }));
  assert.equal(minted, "mintedsha", "the freshly minted sha is returned to the sweep for its ledger line");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.branch, "run-W1-T253-1785378652634", "pushes to the PR's OWN branch");
  assert.equal(calls[0]!.head, "35d636d454cc", "parented on the CURRENT head — a fast-forward");
  assert.match(calls[0]!.message, /re-trigger checks on #921/, "the commit says why it exists");
  assert.match(calls[0]!.message, /no Actions check-suite/, "and names the condition it is remedying");
});

test("buildSweepEffects' repushAbsent stands down when the head branch was never observed", async () => {
  let pushes = 0;
  const effects = buildSweepEffects(
    "craigoley",
    "remudero",
    { claudeBin: "/bin/true", root: "/nonexistent-bh-root" } as never,
    join(mkdtempSync(join(tmpdir(), "rmd-bh-eff2-")), "ledger.ndjson"),
    "SWEEP-EFF-2",
    { tasks: [], byId: new Map() } as never,
    () => {},
    DEFAULT_SWEEP_POLICY,
    async () => 0,
    undefined,
    () => {
      pushes++;
      return "never";
    },
  );
  assert.equal(await effects.repushAbsent!(pr({ headRefName: undefined })), undefined);
  assert.equal(pushes, 0, "no branch name means nothing to push to — never a guess");
});

// ── The gateway end of the same wire: `headRefName` only exists on an OpenPrView because
//    buildOpenPrViews reads it off the REST payload's `head.ref`. Without it the remedy's
//    no-branch stand-down above would fire on EVERY pr and the feature would be inert, so
//    the gateway read is locked here rather than left to the aggregate suite. Driven over a
//    PATH-stub `gh` answering only the four REST calls buildOpenPrViews issues — no
//    `gh pr view`/`gh issue`, so no effect (arm/escalate/push) is reachable from this test.
function ghStubForHeadRef(sha: string, taskId: string, branch: string): string {
  return `#!/usr/bin/env node
const a = process.argv.slice(2).join(" ");
if (a.includes("required_status_checks")) { process.stdout.write(JSON.stringify({ contexts: ["ci-gate"] })); process.exit(0); }
if (a.includes("pulls?state=open")) {
  process.stdout.write(JSON.stringify([{
    number: 900,
    html_url: "https://github.com/o/r/pull/900",
    state: "open",
    body: "Remudero-Task: ${taskId}\\n",
    updated_at: "2026-07-30T00:00:00Z",
    head: { ref: "${branch}", sha: "${sha}" },
    auto_merge: null,
  }]));
  process.exit(0);
}
if (a.includes("check-runs")) { process.stdout.write(JSON.stringify({ check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] })); process.exit(0); }
if (a.includes("/status")) { process.stdout.write(JSON.stringify({ statuses: [] })); process.exit(0); }
process.stdout.write("{}");
`;
}

test("buildOpenPrViews carries the PR's head.ref through as headRefName — the branch the ABSENT remedy pushes its empty commit to", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-bh-headref-"));
  writeFileSync(join(bin, "gh"), ghStubForHeadRef("deadbeef0000000000000000000000000000000", "W1-T900", "run-W1-T900-1"), {
    mode: 0o755,
  });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const views = buildOpenPrViews("o", "r", ledgerPath());
    assert.equal(views.length, 1);
    assert.equal(
      views[0].headRefName,
      "run-W1-T900-1",
      "the REST payload's head.ref reaches the view verbatim — the remedy never reconstructs a branch name from the task id",
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

// ── The bound lives in the LEDGER, so rotation must never archive it away. Caught by CI's
//    "derived from consumers, not hardcoded" invariant, locked here from the remedy's own
//    side: priorActionsFromLedger counts `sweep.absent_repush` lines to enforce the cap, so
//    a rotation that drops them resets the count to zero and re-earns every PR another
//    empty commit, forever — the unbounded loop the cap exists to prevent.
test("the ABSENT re-push ledger step is decision-relevant — rotation must never archive the line that IS the bound", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("sweep.absent_repush"),
    "sweep.absent_repush must survive ledger rotation or ABSENT_REPUSH_CAP silently stops binding",
  );
});
