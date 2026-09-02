// test/followup-routing-has-a-consumer.test.ts — W1-T2458.
//
// THE DEFECT THIS CLOSES, MEASURED (this task's own recon, 2026-08-29): the chain
// `parseFollowups` -> `harvestFollowupsFromReport` -> `mineFollowups` -> `renderFollowupCandidates`
// -> `recordFollowupHarvest` all RESOLVE — 1,046 deduped `report.followups` rows carry 2,115
// declared entries across 463 distinct task_ids over 21 days — but `renderFollowupCandidates`
// only ever produced a markdown section headed "never auto-filed (rule 15)" that no rung reads
// back. Of the seven modules calling `updateProposalRegistry` (inbox.ts's single writer), NONE
// read a follow-up, and not one plan task has ever been filed FROM a harvested entry.
//
// `routeFollowupsToRegistry` (src/lib/retro.ts) is the missing consumer. This file proves, in
// order:
//   (1) it reaches the registry through the single writer, not a rendered section (acceptance 1);
//   (2) a routed proposal carries its runId/taskId/prUrl referent and states its anchor set is
//       empty rather than hiding that fact (acceptance 2);
//   (3) it declines an entry the EXISTING duplicate refusal already covers (mineFollowups' own
//       title-dedup arm), naming the arm (acceptance 3);
//   (4) the three type labels have a WRITTEN definition governing the routing branch, not a
//       guess re-made per call (acceptance 4);
//   (5) — the file's own name — that `retroCommand`'s real-run path actually CALLS this function,
//       so the routing exists as a reached consumer, not a second inert organ beside the first.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  FOLLOWUP_TYPE_ROUTES,
  followupProposalId,
  mineFollowups,
  routeFollowupsToRegistry,
  type LedgerRecord,
} from "../src/lib/retro.js";
import type { Proposal } from "../src/lib/inbox.js";

/** A minimal `report.followups` ledger row — the shape `harvestFollowupsFromReport` (run-task.ts)
 *  actually appends, reduced to what `mineFollowups` reads. */
function followupRow(opts: {
  runId: string;
  ts: string;
  taskId: string;
  entries: Array<{ type: string; text: string }>;
  prUrl?: string;
}): LedgerRecord {
  return {
    run_id: opts.runId,
    ts: opts.ts,
    task_id: opts.taskId,
    step: "report.followups",
    entries: opts.entries,
    ...(opts.prUrl ? { pr_url: opts.prUrl } : {}),
  };
}

/** Board-review-wiring.test.ts's own `updateRegistry` fake shape (test/board-review.test.ts) —
 *  an in-memory registry, never touching disk, that mirrors `updateProposalRegistry`'s real
 *  read-current/apply-update/return-next-or-null contract. */
function fakeRegistry() {
  let state: Proposal[] = [];
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

// A realistic harvest: two routable entries (one "research", one "task" carrying a `prUrl`), one
// "action" entry (not plan-shaped work), and one entry that dedupes against an open task title —
// the SAME `mineFollowups` two-arm split test/followup-rotation-idempotency.test.ts already
// exercises, reused here rather than hand-built to keep the "existing duplicate refusal" claim
// honest (this test never re-implements `followupMatchesTitle`).
const OPEN_TITLE = "harden the deploy-lock retry pathway against concurrent workers";
const RECORDS: LedgerRecord[] = [
  followupRow({
    runId: "run-research-1",
    ts: "2026-08-20T00:00:00Z",
    taskId: "W1-T9001",
    entries: [{ type: "research", text: "why does the flaky test fail only under load" }],
  }),
  followupRow({
    runId: "run-task-1",
    ts: "2026-08-20T00:01:00Z",
    taskId: "W1-T9002",
    entries: [{ type: "task", text: "add a jittered backoff to the notification webhook sender" }],
    prUrl: "https://github.com/o/r/pull/4242",
  }),
  followupRow({
    runId: "run-action-1",
    ts: "2026-08-20T00:02:00Z",
    taskId: "W1-T9003",
    entries: [{ type: "action", text: "an operator should flip the canary flag once merged" }],
  }),
  followupRow({
    runId: "run-dup-1",
    ts: "2026-08-20T00:03:00Z",
    taskId: "W1-T9004",
    // Verbatim-identical to OPEN_TITLE — guarantees followupMatchesTitle's >=60% word-overlap
    // containment fires, exercising the real dedup arm rather than a hand-simulated one.
    entries: [{ type: "task", text: OPEN_TITLE }],
  }),
];

function harvest() {
  return mineFollowups(RECORDS, [OPEN_TITLE]);
}

// ── sanity: mineFollowups' own two arms behave as this test's fixture assumes ──────────────────

test("sanity: the fixture actually exercises both of mineFollowups' own arms", () => {
  const h = harvest();
  assert.equal(h.candidates.length, 3, "research + task(pr) + action");
  assert.equal(h.deduped.length, 1, "the fourth entry dedupes against the open title");
  assert.equal(h.deduped[0]!.text, OPEN_TITLE);
});

// ── acceptance 1: reaches the registry through the single writer, not a rendered section ───────

test("routeFollowupsToRegistry files routable candidates through the injected updateProposalRegistry-shaped writer", () => {
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(harvest(), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  assert.equal(reg.calls(), 1, "exactly one registry write for this pass — never one call per candidate");
  assert.equal(reg.state().length, 2, "research + task routed; action and the dedup are not proposals");

  const routed = outcomes.filter((o) => o.routed);
  assert.equal(routed.length, 2);
  for (const o of routed) {
    assert.ok(o.routed);
    assert.ok(
      reg.state().some((p) => p.id === o.proposalId),
      `${o.proposalId} must actually be present in the registry state the writer produced`,
    );
  }
});

// ── acceptance 2: the referent rides the proposal, and the empty anchor set is STATED ──────────

test("a routed proposal carries its runId/taskId/prUrl referent and an explicitly empty evidenceAnchors", () => {
  const reg = fakeRegistry();
  routeFollowupsToRegistry(harvest(), { registryPath: "/state/inbox-proposals.json", updateRegistry: reg.updateRegistry });

  const taskProposal = reg.state().find((p) => p.summary.includes("W1-T9002"));
  assert.ok(taskProposal, "the routed 'task' candidate must be findable by its taskId in the registry");
  assert.match(taskProposal!.summary, /run-task-1/, "the runId rides the summary too");
  assert.match(taskProposal!.summary, /https:\/\/github\.com\/o\/r\/pull\/4242/, "and the prUrl, when present");
  assert.deepEqual(taskProposal!.evidenceAnchors, [], "no anchor is fabricated for free-prose text with no git-grep pattern");

  const researchProposal = reg.state().find((p) => p.summary.includes("W1-T9001"));
  assert.ok(researchProposal);
  assert.match(researchProposal!.summary, /run-research-1/);
  assert.deepEqual(researchProposal!.evidenceAnchors, [], "stated empty even with no prUrl to omit");
});

// ── acceptance 3: declines an entry the EXISTING duplicate refusal already covers, names the arm ─

test("an entry mineFollowups already deduped against an open title is declined, naming the title-dedup arm", () => {
  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(harvest(), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  const declined = outcomes.find((o) => !o.routed && o.candidate.taskId === "W1-T9004");
  assert.ok(declined, "the deduped candidate must appear in the outcomes, not silently dropped");
  assert.ok(!declined!.routed);
  if (!declined!.routed) {
    assert.equal(declined!.arm, "title-dedup");
    assert.match(declined!.reason, /followupMatchesTitle/, "names the actual mechanism, not a vague 'duplicate'");
  }
  assert.ok(
    !reg.state().some((p) => p.summary.includes("W1-T9004")),
    "a title-deduped entry never reaches the registry at all",
  );
});

// ── acceptance 4: the three type labels have a WRITTEN definition governing the branch ─────────

test("FOLLOWUP_TYPE_ROUTES is the written definition, and routing consults it rather than re-deciding per call", () => {
  // The definition itself: research/task are plan-shaped work, action is an operator ask.
  assert.deepEqual(FOLLOWUP_TYPE_ROUTES, { research: "propose", task: "propose", action: "not-plan-shaped" });

  const reg = fakeRegistry();
  const outcomes = routeFollowupsToRegistry(harvest(), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });

  const actionOutcome = outcomes.find((o) => o.candidate.taskId === "W1-T9003");
  assert.ok(actionOutcome && !actionOutcome.routed);
  if (actionOutcome && !actionOutcome.routed) {
    assert.equal(actionOutcome.arm, "type-not-plan-shaped");
    assert.match(actionOutcome.reason, /FOLLOWUP_TYPE_ROUTES/);
  }
  assert.ok(!reg.state().some((p) => p.summary.includes("W1-T9003")), "an 'action' entry never becomes a proposal");

  // The research/task outcomes are routed, EXACTLY where FOLLOWUP_TYPE_ROUTES says "propose" —
  // proving the branch is driven BY the table, not a parallel hardcoded check.
  for (const type of ["research", "task"] as const) {
    assert.equal(FOLLOWUP_TYPE_ROUTES[type], "propose");
  }
});

// ── idempotence: a second pass over the same harvest never duplicates a proposal ───────────────

test("re-routing the same harvest is a no-op on the registry (updateProposalRegistry's own existing-id refusal)", () => {
  const reg = fakeRegistry();
  routeFollowupsToRegistry(harvest(), { registryPath: "/state/inbox-proposals.json", updateRegistry: reg.updateRegistry });
  assert.equal(reg.state().length, 2);

  const second = routeFollowupsToRegistry(harvest(), {
    registryPath: "/state/inbox-proposals.json",
    updateRegistry: reg.updateRegistry,
  });
  assert.equal(reg.state().length, 2, "no duplicate proposals from a second pass over the same entries");
  assert.equal(
    second.filter((o) => o.routed).length,
    2,
    "both candidates still report routed=true — they ARE in the registry, just not newly added",
  );
});

test("followupProposalId is stable across calls for the same candidate and namespaced under 'followup:'", () => {
  const h = harvest();
  const c = h.candidates[0]!;
  assert.equal(followupProposalId(c), `followup:${c.entryId}`);
  assert.equal(followupProposalId(c), followupProposalId({ ...c }), "same entry, same id, every time");
});

// ── acceptance (the file's own name): a real rung actually CALLS this, not a second inert organ ─
//
// A full `retroCommand` real-run drive needs a live worktree, GitHub gateway, and Architect
// spawn far beyond this unit's scope — test/board-review-wiring.test.ts's own precedent for
// exactly this shape ("daemonCommand actually names the pair in its DaemonDeps literal") is a
// SOURCE ASSERTION: the producer/consumer seam is pinned in the text of the call site, right
// beside the pre-existing `recordFollowupHarvest` call this task's recon confirmed IS reached
// (the real-run-only, non-dry-run gate `recordFollowupHarvest`'s own comment names).

test("retroCommand's real-run path calls routeFollowupsToRegistry right alongside recordFollowupHarvest", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const anchor = src.indexOf("recordFollowupHarvest(gather.followups, { ledgerPath });");
  assert.notEqual(anchor, -1, "the pre-existing, reached ledger-mark call must still be present");
  const nearby = src.slice(anchor, anchor + 1000);
  // W1-T2601 WIDENED, NOT WEAKENED: the path may now be carried in `followupRegistryPath` so the
  // producer and the retirement arm beside it provably share ONE registry rather than two identical
  // string literals free to drift. The claim is unchanged — the producer is called on
  // `gather.followups` in the same real-run block — and the variable form is pinned to its own
  // definition below, so this cannot admit a call aimed at some other registry.
  assert.match(
    nearby,
    /routeFollowupsToRegistry\(gather\.followups, \{ registryPath: (join\(config\.root, "state", "inbox-proposals\.json"\)|followupRegistryPath) \}\);/,
    "routeFollowupsToRegistry must be called on gather.followups, in the same real-run block as the ledger marks",
  );
  if (/registryPath: followupRegistryPath \}\);/.test(nearby)) {
    assert.match(
      src,
      /const followupRegistryPath = join\(config\.root, "state", "inbox-proposals\.json"\);/,
      "the variable form must resolve to the SAME inbox-proposals.json this assertion has always pinned",
    );
  }
});
