// test/followup-settled-question-arm.test.ts — W1-T2645.
//
// THE DEFECT THIS CLOSES (this task's own rationale): `routeFollowupsToRegistry` (src/lib/retro.ts)
// had FOUR refusal arms at this task's own recon read — "title-dedup" (lexical word-overlap,
// measured recall 3-in-32), "type-not-plan-shaped", "self-referential", and "dispatch-only" — and
// NONE of them asked whether a candidate's REMEDY contradicts a question the plan has already, on
// record, decided. The occasioning proposal
// (followup:DAEMON-1788107419932:2026-08-30T16:56:33.630Z:1) asked to hand-sync a task's yaml
// `status:` field — a question DECISIONS.md has already answered three times (W1-T1, W1-T12a,
// W1-T99), each on the same ground W1-T367 measured: the field is decorative and never drives
// dispatch. Neither existing lexical guard catches it: `followupMatchesTitle` needs an open task
// TITLE to overlap with (there is none), and W1-T2638's harvest-time `decorativeStatusFlipReason`
// requires the literal word "field" immediately after `status:` (`STATUS_FIELD_RE`), which this
// exact phrasing lacks.
//
// This file proves, in order:
//   (1) the verbatim occasioning follow-up is declined with arm "settled-question" and a reason
//       naming the deciding record, and the candidate is still HARVESTED, never dropped;
//   (2) the false-positive falsifier: a candidate that merely mentions "status", or that proposes
//       work on a status BOARD, still routes and mints its proposal;
//   (3) the settled-question rows are DATA: adding a row declines a fresh candidate with no
//       change to the router, and an empty table routes every candidate exactly as the pre-change
//       function did;
//   (4) the two pre-existing arms (title-dedup, type-not-plan-shaped) are unchanged, and a second
//       routing pass over an already-routed candidate adds nothing;
//   (5) "settled-question" is a named member of the routing outcome (grep-provable directly).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSettledQuestion,
  mineFollowups,
  routeFollowupsToRegistry,
  SETTLED_QUESTIONS,
  TASK_STATUS_FIELD_WRITE_RE,
  type FollowupCandidate,
  type LedgerRecord,
  type SettledQuestionRow,
} from "../src/lib/retro.js";
import type { Proposal } from "../src/lib/inbox.js";

/** Same in-memory `updateProposalRegistry`-shaped fake the other followup-family test files use —
 *  read-current/apply-update/return-next-or-null, never touching disk. */
function fakeRegistry(initial: Proposal[] = []) {
  let state: Proposal[] = initial;
  let calls = 0;
  return {
    calls: () => calls,
    state: () => state,
    updateRegistry: (_path: string, update: (current: Proposal[]) => Proposal[] | null) => {
      calls += 1;
      const next = update(state);
      if (next !== null) state = next;
      return next;
    },
  };
}

// The occasioning proposal's OWN literal remedy text (this task's rationale, verbatim) — the
// regression corpus the new arm must decline.
const OCCASIONING_TEXT =
  "sync plan/tasks.d/W1-T2473-*.yaml status: from queued to shipped (PR #3304 already merged it), " +
  "stale status could cause a scheduler to re-offer completed work";

const SETTLED_QUESTION_CANDIDATE: FollowupCandidate = {
  entryId: "DAEMON-1788107419932:2026-08-30T16:56:33.630Z:1",
  type: "task",
  text: OCCASIONING_TEXT,
  runId: "DAEMON-1788107419932",
  taskId: "W1-T2477",
};

// A candidate that merely MENTIONS status, with no proposed field write — must still route.
const MENTIONS_STATUS_CANDIDATE: FollowupCandidate = {
  entryId: "run-mention:2026-08-30T00:00:00Z:0",
  type: "research",
  text: "why does the run status stay stale in the dashboard even after a merge",
  runId: "run-mention",
  taskId: "W1-T9101",
};

// A candidate proposing work ON the status board itself (a different artifact from the yaml
// `status:` field) — must still route, per the fail-open scope fence (design note (iii)).
const STATUS_BOARD_CANDIDATE: FollowupCandidate = {
  entryId: "run-board:2026-08-30T00:01:00Z:0",
  type: "task",
  text: "add a new column to the operator status board: move cards from queued to in-review",
  runId: "run-board",
  taskId: "W1-T9102",
};

// An ordinary candidate unrelated to any settled question, naming a different task entirely —
// the routing baseline every arm must leave untouched.
const ORDINARY_CANDIDATE: FollowupCandidate = {
  entryId: "run-ordinary:2026-08-30T00:02:00Z:0",
  type: "research",
  text: "why does the flaky test fail only under load",
  runId: "run-ordinary",
  taskId: "W1-T9103",
};

// A title-dedup candidate — arrives pre-declined via `harvest.deduped`, never touched by the type
// or settled-question checks.
const TITLE_DEDUP_CANDIDATE: FollowupCandidate = {
  entryId: "run-dedup:2026-08-30T00:03:00Z:0",
  type: "task",
  text: "add fuzzy search to the board",
  runId: "run-dedup",
  taskId: "W1-T9104",
};

// A not-plan-shaped ("action") candidate — the existing type-not-plan-shaped arm's own baseline.
const ACTION_CANDIDATE: FollowupCandidate = {
  entryId: "run-action:2026-08-30T00:04:00Z:0",
  type: "action",
  text: "an operator should flip the canary flag once merged",
  runId: "run-action",
  taskId: "W1-T9105",
};

// ── acceptance 1: the verbatim occasioning follow-up is declined, named, and still harvested ────

test("mineFollowups harvests the occasioning follow-up rather than deduping it at harvest time", () => {
  const records: LedgerRecord[] = [
    {
      run_id: "DAEMON-1788107419932",
      ts: "2026-08-30T16:56:33.630Z",
      task_id: "W1-T2477",
      step: "report.followups",
      entries: [{ type: "task", text: OCCASIONING_TEXT }],
    },
  ];
  const harvest = mineFollowups(records, []);
  assert.equal(harvest.candidates.length, 1, "not caught by W1-T2638's STATUS_FIELD_RE (no literal 'field')");
  assert.equal(harvest.deduped.length, 0);
  assert.equal(harvest.candidates[0]!.text, OCCASIONING_TEXT);
  assert.ok(
    harvest.harvestLines.some((l) => l.step === "followup.harvested"),
    "ledgered as harvested, not deduped",
  );
});

test("routeFollowupsToRegistry declines the occasioning follow-up with arm settled-question, naming the deciding record", () => {
  const reg = fakeRegistry();
  const harvest = { candidates: [SETTLED_QUESTION_CANDIDATE], deduped: [], harvestLines: [] };

  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.equal(outcome.routed, false);
  assert.ok(!outcome.routed);
  assert.equal(outcome.arm, "settled-question");
  assert.match(outcome.reason, /decorative/i);
  assert.match(outcome.reason, /TASK_STATUSES|plan\.ts/);
  assert.match(outcome.reason, /W1-T367/);

  assert.equal(reg.calls(), 0, "no routable candidate at all — the writer is never even invoked");
  assert.equal(reg.state().length, 0, "no proposal minted for a settled-question entry");
});

test("the candidate carried on the declined outcome is the SAME candidate the harvest already harvested — never dropped", () => {
  const records: LedgerRecord[] = [
    {
      run_id: "DAEMON-1788107419932",
      ts: "2026-08-30T16:56:33.630Z",
      task_id: "W1-T2477",
      step: "report.followups",
      entries: [{ type: "task", text: OCCASIONING_TEXT }],
    },
  ];
  const harvest = mineFollowups(records, []);
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });
  assert.equal(outcomes.length, 1);
  const outcome = outcomes[0]!;
  assert.ok(!outcome.routed);
  assert.equal(outcome.arm, "settled-question");
  assert.equal(outcome.candidate.text, OCCASIONING_TEXT);
  assert.equal(outcome.candidate.entryId, "DAEMON-1788107419932:2026-08-30T16:56:33.630Z:0");
});

// test/negative-reachability-ratchet.test.ts (W1-T2317) requires a module-scope `_RE` regex to be
// driven through BOTH arms directly by identifier, mirroring how `STATUS_FIELD_RE` is exercised
// just below in this same file's sibling assertions.
test("TASK_STATUS_FIELD_WRITE_RE: matches a proposed status: field write, and rejects a bare mention or a status-board ask", () => {
  assert.equal(TASK_STATUS_FIELD_WRITE_RE.test(OCCASIONING_TEXT), true);
  assert.equal(TASK_STATUS_FIELD_WRITE_RE.test("set `status:` field from queued to done in the shard"), true);
  assert.equal(TASK_STATUS_FIELD_WRITE_RE.test(MENTIONS_STATUS_CANDIDATE.text), false);
  assert.equal(TASK_STATUS_FIELD_WRITE_RE.test(STATUS_BOARD_CANDIDATE.text), false);
});

// ── acceptance 2: the false-positive falsifier — mere mention or a status BOARD still routes ────

test("findSettledQuestion is undefined for a candidate that merely mentions status, with no proposed field write", () => {
  assert.equal(findSettledQuestion(MENTIONS_STATUS_CANDIDATE.text), undefined);
});

test("findSettledQuestion is undefined for a candidate proposing work on a status BOARD, not the yaml field", () => {
  assert.equal(findSettledQuestion(STATUS_BOARD_CANDIDATE.text), undefined);
});

test("routeFollowupsToRegistry still routes and mints a proposal for a mere status mention and a status-board ask", () => {
  const reg = fakeRegistry();
  const harvest = {
    candidates: [MENTIONS_STATUS_CANDIDATE, STATUS_BOARD_CANDIDATE],
    deduped: [],
    harvestLines: [],
  };

  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.equal(outcome.routed, true, `expected ${outcome.candidate.entryId} to route`);
  }
  assert.equal(reg.calls(), 1);
  assert.equal(reg.state().length, 2);
});

// ── acceptance 3: the table is DATA — a row is an addition, an empty table is the pre-change ────

test("SETTLED_QUESTIONS is seeded with exactly the one row this task's rationale justifies", () => {
  assert.equal(SETTLED_QUESTIONS.length, 1);
  assert.equal(SETTLED_QUESTIONS[0]!.id, "task-status-field-is-decorative");
  assert.match(SETTLED_QUESTIONS[0]!.decidedIn, /TASK_STATUSES|plan\.ts/);
});

test("adding a row to a custom table declines a fresh candidate with no change to the router", () => {
  const FRESH_TEXT = "flip the retirement: field on W1-T9200 from open to closed";
  // Not matched by the seeded row (it targets `status:`, not `retirement:`) or by the pre-change
  // router at all — proving the row, not the router, is what does the declining.
  assert.equal(findSettledQuestion(FRESH_TEXT), undefined);

  const customRow: SettledQuestionRow = {
    id: "retirement-field-is-also-decorative-TEST-ONLY",
    matches: (text) => /retirement:\s*field/i.test(text),
    decidedIn: "TEST FIXTURE ONLY",
    reason: "test fixture row proving the table is data",
  };
  const customTable = [...SETTLED_QUESTIONS, customRow];
  assert.equal(findSettledQuestion(FRESH_TEXT, customTable)?.id, customRow.id);

  const reg = fakeRegistry();
  const freshCandidate: FollowupCandidate = {
    entryId: "run-fresh:2026-09-04T00:00:00Z:0",
    type: "task",
    text: FRESH_TEXT,
    runId: "run-fresh",
    taskId: "W1-T9200",
  };
  const outcomes = routeFollowupsToRegistry(
    { candidates: [freshCandidate], deduped: [], harvestLines: [] },
    { registryPath: "/state/inbox-proposals.json", updateRegistry: reg.updateRegistry, settledQuestions: customTable },
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.routed, false);
  assert.ok(!outcomes[0]!.routed);
  assert.equal(outcomes[0]!.arm, "settled-question");
  assert.equal(outcomes[0]!.reason, "test fixture row proving the table is data (decided in: TEST FIXTURE ONLY)");
});

test("an empty settled-question table routes the seeded candidate exactly as the pre-change function did", () => {
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(
    { candidates: [SETTLED_QUESTION_CANDIDATE], deduped: [], harvestLines: [] },
    { registryPath: "/state/inbox-proposals.json", updateRegistry: reg.updateRegistry, settledQuestions: [] },
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.routed, true, "with no settled-question rows, the arm never fires");
  assert.equal(reg.calls(), 1);
  assert.equal(reg.state().length, 1);
});

// ── acceptance 4: the two pre-existing arms are unchanged, and idempotence holds ────────────────

test("a title-dedup candidate still produces its current outcome, untouched by the new arm", () => {
  const reg = fakeRegistry();
  const harvest = { candidates: [], deduped: [TITLE_DEDUP_CANDIDATE], harvestLines: [] };
  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.routed, false);
  assert.ok(!outcomes[0]!.routed);
  assert.equal(outcomes[0]!.arm, "title-dedup");
});

test("a not-plan-shaped (action) candidate still produces its current outcome, untouched by the new arm", () => {
  const reg = fakeRegistry();
  const harvest = { candidates: [ACTION_CANDIDATE], deduped: [], harvestLines: [] };
  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.routed, false);
  assert.ok(!outcomes[0]!.routed);
  assert.equal(outcomes[0]!.arm, "type-not-plan-shaped");
});

test("a mixed harvest routes only the ordinary candidate, declining title-dedup/type/settled-question each by name", () => {
  const reg = fakeRegistry();
  const harvest = {
    candidates: [SETTLED_QUESTION_CANDIDATE, ACTION_CANDIDATE, ORDINARY_CANDIDATE],
    deduped: [TITLE_DEDUP_CANDIDATE],
    harvestLines: [],
  };
  const outcomes = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(reg.calls(), 1, "exactly one registry write for the whole pass");
  assert.equal(reg.state().length, 1, "only the ordinary candidate routes");

  const arms = new Map(outcomes.filter((o) => !o.routed).map((o) => [o.candidate.entryId, (o as { arm: string }).arm]));
  assert.equal(arms.get(TITLE_DEDUP_CANDIDATE.entryId), "title-dedup");
  assert.equal(arms.get(ACTION_CANDIDATE.entryId), "type-not-plan-shaped");
  assert.equal(arms.get(SETTLED_QUESTION_CANDIDATE.entryId), "settled-question");

  const routed = outcomes.find((o) => o.routed);
  assert.ok(routed);
  assert.equal(routed!.candidate.entryId, ORDINARY_CANDIDATE.entryId);
});

test("a second routing pass over an already-routed candidate adds nothing (idempotence unchanged)", () => {
  const reg = fakeRegistry();
  const harvest = { candidates: [ORDINARY_CANDIDATE], deduped: [], harvestLines: [] };

  const first = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });
  assert.equal(first[0]!.routed, true);
  assert.equal(reg.state().length, 1);

  const second = routeFollowupsToRegistry(harvest, {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });
  assert.equal(second.length, 1);
  assert.equal(second[0]!.routed, true, "still reported as routed (already present), never as a decline");
  assert.equal(reg.state().length, 1, "no duplicate added");
});
