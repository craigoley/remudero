/**
 * test/fix-rung-open-escalation-stand-down.test.ts
 *
 * THE DEFECT — A CIRCUIT BREAKER THAT DOES NOT REMEMBER IT FIRED IS A LOOP. The fix rung's
 * review false-block escape (`detectReviewFalseBlock` → `escalate`, run-task.ts) opens a
 * needs-human issue and returns `escalated`. Nothing records that it fired. The next
 * level-triggered sweep constructs a FRESH `runFixRung` invocation with `strikes` reset, re-reads
 * the same still-failing review on the same unchanged head, and spends another fix worker before
 * `detectReviewFalseBlock` can fire again — which it then does, appending to the very issue that
 * is already open and waiting on a human.
 *
 * MEASURED on PR #3887 / issue #3889 (2026-09-04): ten escalations across four heads, EIGHT of
 * them consecutive on the identical head `d8fa22b` over ~2 hours. Seven of those eight dispatched
 * a fix worker that pushed nothing at all — the head did not move between them.
 *
 * WHY THE EXISTING GUARDS DO NOT COVER IT, each checked at source rather than assumed:
 *
 *  - `applyVerdictStability` (W1-T178, lib/review.ts) is the nearest-looking guard and CANNOT
 *    help: it requires `prior.state === "success"` on the same head before it will suppress a
 *    downgrade. Here the FIRST review on each head is already a failure, so there is no prior
 *    success to protect. It guards green→red on one head; this is red repeating on one head.
 *  - `unchangedTreeStandDownReason` (W1-T1284) compares against `lastGateSnapshot`, which lives
 *    in ONE `runFixRung` invocation's own local scope. Every sweep is a new invocation, so its
 *    memory is gone before the second escalation is ever reached.
 *  - `findDuplicateEscalation` (lib/escalate.ts) does dedup — but INSIDE `escalate()`, by which
 *    time the strike is already spent. It is the right predicate consulted at the wrong moment.
 *
 * THE FIX, two halves that only work together:
 *
 *  (A) `openEscalationStandDownReason` — a SIXTH reason source composed into the existing
 *      `fixRungStandDownReason` gate at site `rung.strike` (never a parallel early return),
 *      alongside terminal PR state, foreign head, red-check supersession, merge conflict and
 *      W1-T1284's unchanged tree. It consults `findDuplicateEscalation` — the SAME matcher
 *      `escalate()` uses, never a second opinion — BEFORE the strike is spent.
 *
 *  (B) The review false-block producer now passes `headSha` and `cause`. It was the ONLY
 *      fix-rung `escalate()` call opting into neither dimension of W1-T195's composite key; its
 *      own ci-log sibling (`ci_false_block`) already passes both. Without (B) the key is
 *      (taskId, PR) alone and (A) would stand the rung down on a GENUINELY NEW head too — the
 *      too-eager direction, in which a stand-down silently stops fixing things.
 *
 * AND (A) IS DELIBERATELY STRICTER THAN `findDuplicateEscalation` ITSELF. That matcher's
 * `matchesOptionalDimension` is permissive when either side omits a dimension, so a probe
 * carrying a head matches a legacy issue carrying none. That permissiveness is right for its own
 * purpose — it fails toward APPENDING to an open issue, which is cheap and visible. Reusing it to
 * REFUSE A FIX WORKER inverts the risk: it would fail toward NOT FIXING. So the stand-down fires
 * only on a candidate whose body carries a `**Head:**` line EQUAL to the head about to be struck
 * against. Same predicate, one extra qualification, stated where the polarity flips.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung, openEscalationStandDownReason } from "../src/run-task.js";
import {
  escalationHeadSha,
  findDuplicateEscalation,
  renderIssueBody,
  type Escalation,
  type EscalationDedupKey,
  type IssueGateway,
  type OpenIssue,
} from "../src/lib/escalate.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const PR_URL = "https://github.com/acme/remudero/pull/3887";

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

/** A review shaped like #3887's: the deterministic floor PASSES while the spawned reviewer blocks
 *  — `detectReviewFalseBlock`'s signal (b), the sharper of the two and the one #3889 fired on. */
function floorPassesReview(headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure",
    criteria: [criterion({ claim: "the rung has a LIVE CALL SITE in the retro", met: false, floorMet: true })],
    testTheater: false,
    summary: "unmet criteria",
    floorDegraded: false,
    floorState: "success",
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts() {
  return {
    taskId: "W1-T2795X",
    runId: "W1-T2795X-1788500000000",
    task: { id: "W1-T2795X", title: "Some task" },
    prUrl: PR_URL,
    branch: "run-W1-T2795X-1788500000000",
    worktreePath: "/tmp/rmd-fixrung-open-escalation-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-open-escalation-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: {
      owner: "acme",
      repo: "remudero",
      headCheckoutDir: "/tmp/rmd-fixrung-open-escalation-wt",
      reviewerMount: FIX_RUNG_MOUNT,
    },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-open-escalation-")), "ledger.ndjson");
}

/** An issue gateway that PERSISTS across `runFixRung` invocations, which is the whole point: each
 *  sweep builds a fresh rung, but GitHub's open-issue list is the one thing that survives. */
function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 3889;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/acme/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen(): OpenIssue[] {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment() {},
  };
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-T2795X",
    runId: "W1-T2795X-1788500000000",
    summary: `review false-block after 1 strike(s) — ${PR_URL}`,
    detail: "detail",
    options: [{ label: "re-judge", detail: "re-judge it" }],
    recommendation: "re-judge",
    ...over,
  };
}

function storeHolding(...escalations: Escalation[]): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  const store = fakeIssueStore();
  for (const e of escalations) store.create(`[${e.class}] ${e.taskId}: ${e.summary}`, renderIssueBody(e), ["needs-human"]);
  return store;
}

// ── escalationHeadSha — ONE parser for the `**Head:**` line, shared with the dedup matcher ──────

test("escalationHeadSha: reads back the exact head renderIssueBody wrote, and is undefined when the producer set none", () => {
  assert.equal(escalationHeadSha(renderIssueBody(escalation({ headSha: "d8fa22b7" }))), "d8fa22b7");
  assert.equal(escalationHeadSha(renderIssueBody(escalation())), undefined, "a producer that never opted in leaves no Head line to read");
  assert.equal(escalationHeadSha(undefined), undefined, "an absent body is never a head");
});

// ── findDuplicateEscalation — now exported, so the pre-strike gate reuses THE matcher ───────────

test("findDuplicateEscalation: an open issue at head A does NOT match a probe at head B — the discrimination the producer fix buys", () => {
  const store = storeHolding(escalation({ headSha: "aaaaaaa" }));
  const probe: EscalationDedupKey = { class: "BLOCKED", taskId: "W1-T2795X", summary: PR_URL, detail: "", headSha: "bbbbbbb" };
  assert.equal(findDuplicateEscalation(probe, { issues: store, ledgerPath: tmpLedgerPath(), runId: "r" }), undefined);
});

test("findDuplicateEscalation: the same head on both sides matches, and the W1-T104 (taskId, PR) dedup is unchanged when neither side names a head", () => {
  const withHead = storeHolding(escalation({ headSha: "aaaaaaa" }));
  const matched = findDuplicateEscalation(
    { class: "BLOCKED", taskId: "W1-T2795X", summary: PR_URL, detail: "", headSha: "aaaaaaa" },
    { issues: withHead, ledgerPath: tmpLedgerPath(), runId: "r" },
  );
  assert.ok(matched, "same task, same PR, same head must match");

  const noHead = storeHolding(escalation());
  assert.ok(
    findDuplicateEscalation({ class: "BLOCKED", taskId: "W1-T2795X", summary: PR_URL, detail: "" }, { issues: noHead, ledgerPath: tmpLedgerPath(), runId: "r" }),
    "neither side naming a head keeps today's (taskId, PR) dedup exactly as before",
  );
});

// ── openEscalationStandDownReason — the pure boundary, and its deliberate extra strictness ──────

test("openEscalationStandDownReason: no head to qualify on is never a stand-down", () => {
  const issue: OpenIssue = { number: 1, url: "u", body: renderIssueBody(escalation({ headSha: "aaaaaaa" })) };
  assert.equal(openEscalationStandDownReason(undefined, issue), undefined);
});

test("openEscalationStandDownReason: no open escalation found is never a stand-down", () => {
  assert.equal(openEscalationStandDownReason("aaaaaaa", undefined), undefined);
});

test("openEscalationStandDownReason: STRICTER THAN THE MATCHER — a candidate carrying NO head never refuses a worker", () => {
  const legacy: OpenIssue = { number: 3889, url: "u", body: renderIssueBody(escalation()) };
  assert.equal(
    openEscalationStandDownReason("d8fa22b7", legacy),
    undefined,
    "matchesOptionalDimension is permissive so a NEW escalation is never suppressed into a stale issue; reused here it would fail toward NOT FIXING",
  );
});

test("openEscalationStandDownReason: a candidate carrying a DIFFERENT head never refuses a worker", () => {
  const other: OpenIssue = { number: 3889, url: "u", body: renderIssueBody(escalation({ headSha: "aaaaaaa" })) };
  assert.equal(openEscalationStandDownReason("d8fa22b7", other), undefined);
});

test("openEscalationStandDownReason: the SAME head stands down, naming the issue and the head so the operator can act", () => {
  const url = "https://github.com/acme/remudero/issues/3889";
  const same: OpenIssue = { number: 3889, url, body: renderIssueBody(escalation({ headSha: "d8fa22b7" })) };
  const got = openEscalationStandDownReason("d8fa22b7", same);
  assert.ok(got, "an open escalation already naming this exact head must refuse the strike");
  assert.match(got.reason, /3889/, "names the issue the operator must act on");
  assert.match(got.reason, /d8fa22b/, "names the head it is qualified against");
});

// ── the producer (B): the review false-block escalation opts into BOTH dedup dimensions ─────────

test("runFixRung: the review false-block escalation carries **Head:** and **Cause:** — the dimensions its ci-log sibling already passed", async () => {
  const issues = fakeIssueStore();
  const review = floorPassesReview("d8fa22b7");

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: review,
    deps: {
      spawn: async () => result({ sessionId: "s-1" }),
      waitForCiGreen: async () => "green",
      runReview: async () => review,
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(outcome.reason, "false_block");
  assert.equal(issues.calls.length, 1);
  assert.match(issues.calls[0].body, /^\*\*Head:\*\* d8fa22b7$/m, "without a head the pre-strike gate's key is too coarse to tell a new push from a repeat");
  assert.match(issues.calls[0].body, /^\*\*Cause:\*\* review$/m, "a review block and a red-CI block on the same head are different operator asks");
});

// ── THE FALSIFIER: #3889's own shape — ten escalations across four heads ────────────────────────

test("runFixRung: a SECOND sweep on the SAME head stands down BEFORE spawning — the eighth consecutive d8fa22b escalation never dispatches a worker", async () => {
  const issues = fakeIssueStore();
  const review = floorPassesReview("d8fa22b7");
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const deps = () => ({
    spawn: async (args: SpawnWorkerArgs) => {
      spawnCalls.push(args);
      return result({ sessionId: `s-${spawnCalls.length}` });
    },
    waitForCiGreen: async () => "green" as const,
    runReview: async () => review,
    push: () => {},
    issues,
    ledgerPath: tmpLedgerPath(),
    log: (step: string, extra?: Record<string, unknown>) => logs.push({ step, extra }),
    say: () => {},
    account: (r: WorkerResult) => r,
    readLiveState: async () => ({ ok: true, state: "OPEN" }) as const,
  });

  // Sweep 1 — nothing is open yet, so the strike spends and the false-block escape escalates.
  const first = await runFixRung({ ...fixRungBaseOpts(), strikeCap: 3, initialReview: review, deps: deps() });
  assert.equal(first.outcome, "escalated");
  assert.equal(spawnCalls.length, 1, "the FIRST observation genuinely earns its worker");
  assert.equal(issues.calls.length, 1);

  // Sweeps 2..8 — a fresh rung each time (strikes reset), same head, same issue still open.
  for (let sweep = 2; sweep <= 8; sweep++) {
    const again = await runFixRung({ ...fixRungBaseOpts(), strikeCap: 3, initialReview: review, deps: deps() });
    assert.equal(again.outcome, "stood_down", `sweep ${sweep} must not spend a worker on a question already waiting on a human`);
    assert.equal(again.strikes, 0, `sweep ${sweep} spends no strike`);
    assert.match(again.standDownReason ?? "", /3889/);
  }

  assert.equal(spawnCalls.length, 1, "ONE worker across eight sweeps — seven of #3889's ten escalations bought nothing");
  assert.equal(issues.calls.length, 1, "and no sibling issue is opened either");

  const stoodDown = logs.filter((l) => l.step === "fix.stood_down");
  assert.equal(stoodDown.length, 7);
  assert.equal(stoodDown[0].extra?.site, "rung.strike", "composed into the EXISTING pre-strike gate, never a parallel early return");
});

// ── THE COUNTER-FALSIFIER: the one that matters — a stand-down that is too eager stops fixing ───

test("runFixRung: a genuinely NEW head still spends its strike, even with the previous head's escalation still open", async () => {
  const issues = fakeIssueStore();
  const spawnCalls: SpawnWorkerArgs[] = [];

  const deps = (review: ReviewVerdict & { headSha: string; reviewerOutcome: string }) => ({
    spawn: async (args: SpawnWorkerArgs) => {
      spawnCalls.push(args);
      return result({ sessionId: `s-${spawnCalls.length}` });
    },
    waitForCiGreen: async () => "green" as const,
    runReview: async () => review,
    push: () => {},
    issues,
    ledgerPath: tmpLedgerPath(),
    log: () => {},
    say: () => {},
    account: (r: WorkerResult) => r,
    readLiveState: async () => ({ ok: true, state: "OPEN" }) as const,
  });

  // #3887's real head sequence: f28ac5e → a115088 → d8fa22b, each a genuine push.
  for (const head of ["f28ac5e7", "a1150881", "d8fa22b7"]) {
    const review = floorPassesReview(head);
    const outcome = await runFixRung({ ...fixRungBaseOpts(), strikeCap: 3, initialReview: review, deps: deps(review) });
    assert.equal(outcome.outcome, "escalated", `head ${head} is a NEW observation and must be judged on its own merits`);
  }

  assert.equal(spawnCalls.length, 3, "three distinct heads, three strikes — the stand-down must never suppress real progress");
  assert.equal(issues.calls.length, 3, "and each genuinely new head opens its OWN issue (W1-T195's stated intent)");
});

// ── fail open, exactly like every other reason source in fixRungStandDownReason ─────────────────

test("runFixRung: a gateway with no listOpen at all behaves EXACTLY as before this task — every strike still spends", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const review = floorPassesReview("d8fa22b7");
  const created: string[] = [];
  const noListOpen: IssueGateway = {
    create(_t, _b, _l) {
      created.push("x");
      return "https://github.com/acme/remudero/issues/1";
    },
  };

  for (let sweep = 1; sweep <= 2; sweep++) {
    const outcome = await runFixRung({
      ...fixRungBaseOpts(),
      strikeCap: 3,
      initialReview: review,
      deps: {
        spawn: async (args) => {
          spawnCalls.push(args);
          return result({ sessionId: `s-${spawnCalls.length}` });
        },
        waitForCiGreen: async () => "green",
        runReview: async () => review,
        push: () => {},
        issues: noListOpen,
        ledgerPath: tmpLedgerPath(),
        log: () => {},
        say: () => {},
        account: (r) => r,
        readLiveState: async () => ({ ok: true, state: "OPEN" }),
      },
    });
    assert.equal(outcome.outcome, "escalated", `sweep ${sweep} proceeds unchanged when the gateway cannot list open issues`);
  }

  assert.equal(spawnCalls.length, 2, "no reader wired ⇒ the un-wired contract, never a manufactured stand-down");
});
