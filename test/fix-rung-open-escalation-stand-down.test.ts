/**
 * test/fix-rung-open-escalation-stand-down.test.ts — W1-T2799.
 *
 * THE DEFECT. The fix rung's review false-block escape (`detectReviewFalseBlock` -> `escalate`,
 * run-task.ts) opens a needs-human issue and returns `escalated`. NOTHING RECORDS THAT IT FIRED.
 * The next level-triggered sweep builds a FRESH `runFixRung` with `strikes` reset, re-reads the
 * same still-failing review on the same unchanged head, and spends a fix worker BEFORE the escape
 * can fire again — which it then does, appending to the very issue already open and waiting on a
 * human. MEASURED from issue #3889's own comment stream: ten escalations across four heads —
 * f28ac5e (x2), a115088, then d8fa22b EIGHT CONSECUTIVE TIMES between 03:17:14Z and 05:14:39Z.
 * The head did not move across seven of those eight, so seven fix workers ran and pushed nothing.
 *
 * THE DEDUP THAT EXISTS IS AT THE WRONG LAYER, WHICH IS THE WHOLE DEFECT. `escalate()` already
 * consults `findDuplicateEscalation` and correctly appended all ten to ONE issue rather than
 * opening ten siblings (W1-T104/W1-T345) — but it runs INSIDE `escalate()`, by which time the
 * strike is already spent. The right predicate, consulted at the wrong moment.
 *
 * THE FIX, IN TWO HALVES THAT ARE NOT SEPARABLE. (A) `openEscalationStandDownReason` (pure) is
 * composed into the EXISTING `fixRungStandDownReason` gate at site `rung.strike` as its SIXTH
 * reason source, resolving through that SAME `findDuplicateEscalation` — never a second opinion
 * about which issues are duplicates — but STRICTER than it: a candidate carrying no `**Head:**`
 * line, or a different one, never refuses a worker. (B) the review false-block `escalate()` starts
 * passing `headSha`/`cause`, the two W1-T195 dimensions it was the ONLY fix-rung producer to omit.
 * Without (B) the key cannot tell a new push from a repeat, and the counter-falsifier below fails
 * `1 !== 3` — three genuinely new heads collapsing into one issue.
 *
 * THE FIXTURE IS THE PRODUCTION ONE, NOT A SYNTHETIC. #3889's shape is reproduced directly: eight
 * sweeps at head d8fa22b7 (one worker expected), and the real f28ac5e -> a115088 -> d8fa22b
 * sequence (three workers, three issues expected).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung, openEscalationStandDownReason } from "../src/run-task.js";
import { escalationHeadSha, findDuplicateEscalation, type EscalationDedupKey } from "../src/lib/escalate.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

// #3889's own four heads, in the order its comment stream recorded them.
const HEAD_1 = "f28ac5ecfe469bccea54297c9e809c41e4447023";
const HEAD_2 = "a115088bc0f9b60fceb936088d87b270dbca6b5f";
const HEAD_3 = "d8fa22b7d0137cdccf30d2f6c74a5fce9b0a7f03";

const PR_URL = "https://github.com/craigoley/remudero/pull/3887";
const TASK_ID = "W1-T2799X";

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

function criterion(claim: string): CriterionVerdict {
  return { claim, met: false, proof: "proof", reason: "reviewer downgraded it", proof_exec: "executed_pass" };
}

/**
 * The #3887 verdict shape verbatim: the deterministic floor PASSES while the spawned reviewer
 * blocks — `detectReviewFalseBlock`'s signal (b), the sharpest one, and the one that fired ten
 * times on #3889.
 */
function falseBlockedReview(headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure",
    criteria: [criterion("the rung has a LIVE call site in the retro")],
    testTheater: false,
    summary: "unmet criteria",
    floorState: "success",
    floorDegraded: false,
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
    taskId: TASK_ID,
    runId: `${TASK_ID}-1730000000000`,
    task: { id: TASK_ID, title: "Some task" },
    prUrl: PR_URL,
    branch: `run-${TASK_ID}-1730000000000`,
    worktreePath: "/tmp/rmd-fixrung-open-escalation-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-open-escalation-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: {
      owner: "craigoley",
      repo: "remudero",
      headCheckoutDir: "/tmp/rmd-fixrung-open-escalation-wt",
      reviewerMount: FIX_RUNG_MOUNT,
    },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-open-escalation-")), "ledger.ndjson");
}

type IssueStore = IssueGateway & {
  created: Array<{ number: number; url: string; title: string; body: string }>;
  comments: Array<{ url: string; body: string }>;
  /** Seed an issue the fleet opened before this task existed — no `**Head:**` line at all. */
  seedLegacy(title: string, body: string): string;
};

/** A real, in-memory `IssueGateway`. `withListOpen: false` models a gateway that cannot search at
 *  all — the "behaves exactly as before this task" control criterion 5 asks for. */
function fakeIssueStore(withListOpen = true): IssueStore {
  let seq = 3889;
  const created: IssueStore["created"] = [];
  const comments: IssueStore["comments"] = [];
  const store: IssueStore = {
    created,
    comments,
    seedLegacy(title, body) {
      const number = seq++;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      created.push({ number, url, title, body });
      return url;
    },
    create(title, body) {
      const number = seq++;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      created.push({ number, url, title, body });
      return url;
    },
    comment(url, body) {
      comments.push({ url, body });
    },
  };
  if (withListOpen) {
    store.listOpen = (): OpenIssue[] =>
      created.map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
  }
  return store;
}

/** ONE level-triggered sweep: a fresh `runFixRung` with `strikes` reset, exactly as the daemon
 *  builds it — sharing only the issue store and ledger, which is all that survives a sweep. */
async function sweep(opts: {
  issues: IssueStore;
  ledgerPath: string;
  headSha: string;
  spawnCalls: SpawnWorkerArgs[];
  logs?: Array<{ step: string; extra?: Record<string, unknown> }>;
}) {
  const review = falseBlockedReview(opts.headSha);
  return await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: review,
    deps: {
      spawn: async (args) => {
        opts.spawnCalls.push(args);
        return result({ sessionId: `s-${opts.spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      // The worker pushed nothing that changes the verdict — the same review comes back, which is
      // what makes this a false block rather than a genuine deficiency.
      runReview: async () => review,
      push: () => {},
      issues: opts.issues,
      ledgerPath: opts.ledgerPath,
      log: (step, extra) => opts.logs?.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
    },
  });
}

// ── criterion 4 (and the strictness half of criterion 1): the PURE boundary ────────────────────

test("openEscalationStandDownReason: no open candidate at all is never a stand-down — the ordinary path", () => {
  assert.equal(openEscalationStandDownReason(HEAD_3, undefined), undefined);
});

test("openEscalationStandDownReason: an open candidate naming the SAME head stands down, naming the issue and the head", () => {
  const got = openEscalationStandDownReason(HEAD_3, {
    number: 3889,
    url: "https://github.com/craigoley/remudero/issues/3889",
    body: `**Task:** ${TASK_ID}\n**Head:** ${HEAD_3}\n`,
  });
  assert.ok(got, "a human has already been asked about this exact head");
  assert.match(got.reason, new RegExp(HEAD_3));
  assert.match(got.reason, /issues\/3889/);
  assert.match(got.reason, /already/i);
});

test("openEscalationStandDownReason (criterion 4): a candidate carrying NO **Head:** line never refuses a worker — #3889's own shape, and the fail-open direction", () => {
  const legacy = {
    number: 3889,
    url: "https://github.com/craigoley/remudero/issues/3889",
    body: `**Task:** ${TASK_ID}\n**Class:** BLOCKED\n`,
  };
  assert.equal(escalationHeadSha(legacy.body), undefined, "sanity: the fixture really carries no Head line");
  assert.equal(
    openEscalationStandDownReason(HEAD_3, legacy),
    undefined,
    "matchesOptionalDimension would MATCH this permissively; a gate whose failure direction is 'stop fixing' must not inherit that",
  );
});

test("openEscalationStandDownReason (criterion 4): a candidate naming a DIFFERENT head never refuses a worker — a new push may carry real new work", () => {
  assert.equal(
    openEscalationStandDownReason(HEAD_3, {
      number: 3889,
      url: "https://github.com/craigoley/remudero/issues/3889",
      body: `**Task:** ${TASK_ID}\n**Head:** ${HEAD_1}\n`,
    }),
    undefined,
  );
});

// ── criterion 1: eight consecutive sweeps on ONE head — #3889's own d8fa22b run ────────────────

test("criterion 1: eight consecutive sweeps observing the SAME (task, PR, head, cause) spend exactly ONE worker and open exactly ONE issue", async () => {
  const issues = fakeIssueStore();
  const ledgerPath = tmpLedgerPath();
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcomes = [];
  for (let i = 0; i < 8; i++) {
    outcomes.push(await sweep({ issues, ledgerPath, headSha: HEAD_3, spawnCalls, logs }));
  }

  assert.equal(spawnCalls.length, 1, "SEVEN of #3889's eight sweeps dispatched a worker that pushed nothing; exactly one may now");
  assert.equal(issues.created.length, 1, "one issue, not eight — and not eight comments appended to it either");
  assert.equal(issues.comments.length, 0, "no sweep after the first ever reached escalate() at all, so nothing was appended");

  assert.equal(outcomes[0].outcome, "escalated", "the FIRST sweep still escalates exactly as before this task");
  for (const outcome of outcomes.slice(1)) {
    assert.equal(outcome.outcome, "stood_down");
    assert.equal(outcome.strikes, 0, "the strike is never SPENT — the gate refuses before `strikes++`");
    assert.match(outcome.standDownReason ?? "", /ALREADY OPEN/);
    assert.match(outcome.standDownReason ?? "", new RegExp(HEAD_3));
  }

  const stoodDown = logs.filter((l) => l.step === "fix.stood_down");
  assert.equal(stoodDown.length, 7);
  assert.equal(stoodDown[0].extra?.site, "rung.strike", "criterion 5: the EXISTING pre-strike gate, not a parallel early return");
  assert.equal(stoodDown[0].extra?.strike, 1, "named as the strike that was about to be spent");
});

// ── criterion 2 + the counter-falsifier for half (B): three genuinely NEW heads ────────────────

test("criterion 2: a genuinely NEW head still spends its strike with the previous head's escalation still open, and opens its OWN issue", async () => {
  const issues = fakeIssueStore();
  const ledgerPath = tmpLedgerPath();
  const spawnCalls: SpawnWorkerArgs[] = [];

  // #3889's real head sequence. Every sweep here is a genuinely new push.
  for (const head of [HEAD_1, HEAD_2, HEAD_3]) {
    const outcome = await sweep({ issues, ledgerPath, headSha: head, spawnCalls });
    assert.equal(outcome.outcome, "escalated", `head ${head.slice(0, 7)} carries new work — its strike must spend`);
  }

  // THE COUNTER-FALSIFIER. With half (B) removed (the producer omitting headSha/cause), all three
  // issues carry no `**Head:**` line, `findDuplicateEscalation` collapses them into one, and this
  // reports `1 !== 3`. That is the measurement proving the two halves are not separable.
  assert.equal(spawnCalls.length, 3, "three new heads, three strikes — the too-eager direction is the one this must never take");
  assert.equal(issues.created.length, 3, "three heads must open THREE issues, not collapse into one");
  assert.equal(issues.comments.length, 0, "no sweep deduped into an earlier head's issue");
});

// ── criterion 3: the producer carries the two W1-T195 dimensions it was the only one to omit ───

test("criterion 3: the review false-block escalation carries **Head:** and **Cause:**", async () => {
  const issues = fakeIssueStore();
  const spawnCalls: SpawnWorkerArgs[] = [];
  await sweep({ issues, ledgerPath: tmpLedgerPath(), headSha: HEAD_3, spawnCalls });

  assert.equal(issues.created.length, 1);
  const body = issues.created[0].body;
  assert.match(body, /^\*\*Head:\*\* d8fa22b7d0137cdccf30d2f6c74a5fce9b0a7f03\s*$/m, "the dimension that tells a new push from a repeat");
  assert.match(body, /^\*\*Cause:\*\* review\s*$/m, "review mode, derived by the SAME escalationCause expression its siblings use");
  assert.equal(escalationHeadSha(body), HEAD_3, "and it round-trips through the parser the gate reads it back with");
});

// ── criterion 5: composed into the EXISTING gate; no listOpen behaves exactly as before ────────

test("criterion 5: a gateway with NO listOpen at all behaves exactly as before this task — every strike still spends", async () => {
  const issues = fakeIssueStore(false);
  const ledgerPath = tmpLedgerPath();
  const spawnCalls: SpawnWorkerArgs[] = [];

  assert.equal(issues.listOpen, undefined, "sanity: this gateway genuinely cannot search open issues");

  for (let i = 0; i < 3; i++) {
    const outcome = await sweep({ issues, ledgerPath, headSha: HEAD_3, spawnCalls });
    assert.equal(outcome.outcome, "escalated", "no search means no probe, and no probe means no stand-down — fail open");
  }
  assert.equal(spawnCalls.length, 3, "the pre-task behaviour, unchanged: every sweep spends its strike");
  assert.equal(issues.created.length, 3, "and without listOpen, escalate()'s own dedup cannot collapse them either — also unchanged");
});

test("criterion 5: a listOpen that THROWS never manufactures a stand-down — the same fail-open contract every other reason source keeps", async () => {
  const issues = fakeIssueStore();
  issues.listOpen = () => {
    throw new Error("gh: API rate limit exceeded");
  };
  const spawnCalls: SpawnWorkerArgs[] = [];
  const outcome = await sweep({ issues, ledgerPath: tmpLedgerPath(), headSha: HEAD_3, spawnCalls });
  assert.equal(outcome.outcome, "escalated");
  assert.equal(spawnCalls.length, 1, "an unreadable issue list must never silently stop the rung fixing things");
});

// ── criterion 6: probe and producer round-trip through the SAME predicate ──────────────────────

test("criterion 6: the issue escalate() files on one sweep is exactly the one the next sweep's probe finds — round-tripped through both paths, never asserted", async () => {
  const issues = fakeIssueStore();
  const spawnCalls: SpawnWorkerArgs[] = [];

  // Sweep 1 files the issue through the REAL escalate() inside runFixRung.
  const first = await sweep({ issues, ledgerPath: tmpLedgerPath(), headSha: HEAD_3, spawnCalls });
  assert.equal(first.outcome, "escalated");
  const filedUrl = issues.created[0].url;

  // The probe key the pre-strike gate builds, assembled here through the SAME exported
  // `EscalationDedupKey` shape the gate uses — and resolved through the SAME
  // `findDuplicateEscalation` escalate() itself deduped with.
  const probeKey: EscalationDedupKey = {
    class: "BLOCKED",
    taskId: TASK_ID,
    summary: `review false-block — ${PR_URL}`,
    detail: "",
    headSha: HEAD_3,
    cause: "review",
  };
  const found = findDuplicateEscalation(probeKey, { issues });
  assert.ok(found, "the probe must find the issue escalate() just filed");
  assert.equal(found.url, filedUrl, "and it must be THAT issue, not merely some issue");

  // The two can never disagree in the other direction either: a probe on a head nobody has
  // escalated for finds nothing, so the next real push is never silently suppressed.
  assert.equal(findDuplicateEscalation({ ...probeKey, headSha: HEAD_1 }, { issues }), undefined);
});
