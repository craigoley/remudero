import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  approveProposal,
  approveRunBranch,
  mostRecentApprovePr,
  priorApproveRunBranch,
  type DraftedCandidate,
  type InboxClassification,
  type RatifyGateway,
} from "../src/lib/inbox.js";

// W1-T4437: six `chore(plan): ratify ...` PRs opened together (one per `rmd approve` invocation
// the console spawns per click) each took 139-144 min and merged origin/main into themselves
// repeatedly, because every approval in the SAME pass opened its OWN branch off origin/main and
// then conflicted with every sibling still open. This file proves, over an INJECTED RatifyGateway
// and a seeded ledger (no operator, no network, no real git), that: (i) approvals queued in one
// pass land on ONE pull request, not one each; (ii) a later approval JOINS that PR with its own
// new commit while it stays open and is not already queued to merge, and opens its own PR again
// once it is; (iii) each approval still keeps its own commit and its own ledger line.

// ── Fixtures ─────────────────────────────────────────────────────────────────

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-approvals-one-pr-")), "ledger.ndjson");
}

function readLedger(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function draft(proposalId: string): DraftedCandidate {
  return {
    proposalId,
    fragmentYaml: `- id: W1-T${proposalId}\n  title: candidate task ${proposalId}\n  repo: remudero\n`,
    stampLine: `- ${proposalId} (plan) — RATIFIED 2026-09-25 -> W1-T${proposalId}.`,
    anchorFingerprint: "landed::MASTER-PLAN.md",
  };
}

function readyClassification(proposalId: string): InboxClassification {
  return { proposalId, state: "ready", reasons: [], draft: draft(proposalId), draftStale: false };
}

/**
 * A fake gateway backing ONE PASS: `openPlanPr` remembers the PR it opened in `pass` (shared,
 * mutable state across successive `approveProposal` calls the way GitHub itself is the shared
 * state two separate `rmd approve` processes actually coordinate through), and `findJoinablePr`
 * answers from it — `undefined` once `pass.queued` is set, mirroring the real gateway's own
 * "already queued to merge" refusal (`priorArmOnHead`, run-task.ts).
 */
interface OnePassState {
  open?: { branch: string; prUrl: string; prNumber: number };
  queued?: boolean;
  createCalls: number;
  openCalls: number;
  joinCalls: number;
  joinedProposalIds: string[];
}

function onePassGateway(pass: OnePassState): RatifyGateway {
  return {
    findPushedBranch: () => undefined,
    findJoinablePr: () => (pass.open && !pass.queued ? pass.open : undefined),
    createRatificationBranch(payload) {
      pass.createCalls++;
      return `run-APPROVE-${payload.proposalId}-branch`;
    },
    openPlanPr(branch) {
      pass.openCalls++;
      pass.open = { branch, prUrl: `https://github.com/craigoley/remudero/pull/${900 + pass.openCalls}`, prNumber: 900 + pass.openCalls };
      return pass.open.prUrl;
    },
    joinRatificationBranch(branch, payload) {
      pass.joinCalls++;
      pass.joinedProposalIds.push(payload.proposalId);
      return branch;
    },
  };
}

function freshPass(): OnePassState {
  return { createCalls: 0, openCalls: 0, joinCalls: 0, joinedProposalIds: [] };
}

// ── Acceptance #1: approvals in one pass open one pull request ─────────────────────────────

test("W1-T4437: approvals in one pass open one pull request", () => {
  const pass = freshPass();
  const path = ledgerPath();

  const r1 = approveProposal(readyClassification("P-A"), onePassGateway(pass), { ledgerPath: path, runId: "RUN-A" });
  const r2 = approveProposal(readyClassification("P-B"), onePassGateway(pass), { ledgerPath: path, runId: "RUN-B" });
  const r3 = approveProposal(readyClassification("P-C"), onePassGateway(pass), { ledgerPath: path, runId: "RUN-C" });

  assert.equal(pass.createCalls, 1, "only the FIRST approval of the pass creates a branch");
  assert.equal(pass.openCalls, 1, "exactly ONE pull request is opened for the whole pass, not one per approval");
  assert.equal(pass.joinCalls, 2, "the other two approvals join the one that is already open");

  assert.ok(r1.ok && r2.ok && r3.ok, "every approval in the pass still succeeds");
  if (r1.ok && r2.ok && r3.ok) {
    assert.equal(r2.prUrl, r1.prUrl, "the second approval lands on the SAME pull request as the first");
    assert.equal(r3.prUrl, r1.prUrl, "the third approval lands on the SAME pull request as the first");
  }

  const ratified = readLedger(path).filter((l) => l.step === "ratify.approved");
  assert.equal(ratified.length, 3, "each approval keeps its own ratify.approved ledger line (design iii)");
  assert.deepEqual(
    new Set(ratified.map((l) => l.pr_url)),
    new Set([r1.ok ? r1.prUrl : undefined]),
    "all three ledger lines name the ONE pull request",
  );
});

// ── Acceptance #2: a later approval joins the open approval pull request ───────────────────

test("W1-T4437: a later approval joins the open approval pull request", () => {
  const pass = freshPass();
  const path = ledgerPath();

  const r1 = approveProposal(readyClassification("P-A"), onePassGateway(pass), { ledgerPath: path, runId: "RUN-A" });
  const r2 = approveProposal(readyClassification("P-B"), onePassGateway(pass), { ledgerPath: path, runId: "RUN-B" });

  assert.ok(r1.ok && r2.ok);
  if (r1.ok && r2.ok) {
    assert.equal(r1.joined, undefined, "the FIRST approval of a pass opens its own PR — it never 'joins'");
    assert.equal(r2.joined, true, "the SECOND approval's own result says it JOINED rather than opened");
  }
  assert.deepEqual(pass.joinedProposalIds, ["P-B"], "joinRatificationBranch ran for the later approval, never the first");

  const lines = readLedger(path);
  const secondRow = lines.find((l) => l.step === "ratify.approved" && l.task_id === "P-B");
  const firstRow = lines.find((l) => l.step === "ratify.approved" && l.task_id === "P-A");
  assert.equal(secondRow?.joined, true, "the joined approval's OWN ledger line records it, distinguishably from the first");
  assert.equal(secondRow?.branch, firstRow?.branch, "the join landed as a new commit on the SAME branch");
  assert.equal(secondRow?.pr_url, firstRow?.pr_url);
});

// ── The "unless already queued to merge" half of design (ii) ───────────────────────────────

test("W1-T4437: once the open pull request is already queued to merge, the next approval opens its own instead of joining it", () => {
  const pass = freshPass();
  const path = ledgerPath();

  approveProposal(readyClassification("P-A"), onePassGateway(pass), { ledgerPath: path, runId: "RUN-A" });
  pass.queued = true; // the gateway's own findJoinablePr refuses once queued, exactly like the real one (priorArmOnHead)
  const r2 = approveProposal(readyClassification("P-B"), onePassGateway(pass), { ledgerPath: path, runId: "RUN-B" });

  assert.equal(pass.createCalls, 2, "a PR already queued to merge is never joined — the next approval starts a fresh pass");
  assert.equal(pass.joinCalls, 0);
  assert.ok(r2.ok);
  if (r2.ok) assert.equal(r2.joined, undefined);
});

// ── A gateway with no findJoinablePr/joinRatificationBranch at all behaves exactly as before ─

test("W1-T4437: a gateway without the join hooks proceeds exactly as before — every approval opens its own PR", () => {
  const path = ledgerPath();
  let createCalls = 0;
  let openCalls = 0;
  const legacyGateway: RatifyGateway = {
    createRatificationBranch(payload) {
      createCalls++;
      return `run-APPROVE-${payload.proposalId}-branch`;
    },
    openPlanPr() {
      openCalls++;
      return `https://github.com/craigoley/remudero/pull/${openCalls}`;
    },
  };
  approveProposal(readyClassification("P-A"), legacyGateway, { ledgerPath: path, runId: "RUN-A" });
  approveProposal(readyClassification("P-B"), legacyGateway, { ledgerPath: path, runId: "RUN-B" });
  assert.equal(createCalls, 2);
  assert.equal(openCalls, 2);
});

// ── mostRecentApprovePr: pure ledger-evidence derivation of the JOIN candidate ──────────────

test("mostRecentApprovePr names the MOST RECENT ratify.approved row's branch/PR, ignoring rows with no branch or pr_url", () => {
  const lines = [
    { step: "ratify.approved", branch: "run-APPROVE-P-A-1", pr_url: "https://github.com/craigoley/remudero/pull/1", pr_number: 1 },
    { step: "worktree.prune" },
    { step: "ratify.approved", branch: "run-APPROVE-P-B-2", pr_url: "https://github.com/craigoley/remudero/pull/2", pr_number: 2 },
    { step: "ratify.approve_refused" },
  ];
  assert.deepEqual(mostRecentApprovePr(lines), {
    branch: "run-APPROVE-P-B-2",
    prUrl: "https://github.com/craigoley/remudero/pull/2",
    prNumber: 2,
  });
  assert.equal(mostRecentApprovePr([]), undefined, "no ratify.approved row at all — nothing to join");
  assert.equal(
    mostRecentApprovePr([{ step: "ratify.approved" }]),
    undefined,
    "a malformed row (no branch/pr_url) is never a joinable candidate",
  );
});

// ── Control: priorApproveRunBranch (a proposal's OWN prior push) and mostRecentApprovePr
//    (anyone's most recent PR) are deliberately DISTINCT lookups over the SAME ledger shape —
//    approveProposal consults the first before ever asking the second (its own ordering is
//    exercised by approve-resumable-rest.test.ts's COMPLETE/ADOPT tests). Named here only so a
//    reader of this file sees the two are never merged into one. ───────────────────────────────

test("priorApproveRunBranch and mostRecentApprovePr answer two different questions over the same ledger", () => {
  const lines = [
    { run_id: "APPROVE-P-A-100", task_id: "P-A", step: "approve.error" },
    { step: "ratify.approved", task_id: "P-A", branch: approveRunBranch("APPROVE-P-A-100"), pr_url: "https://github.com/craigoley/remudero/pull/9", pr_number: 9 },
  ];
  assert.equal(priorApproveRunBranch(lines, "P-A"), approveRunBranch("APPROVE-P-A-100"), "resume looks up ONE proposal's OWN prior branch");
  assert.equal(mostRecentApprovePr(lines)?.branch, approveRunBranch("APPROVE-P-A-100"), "join looks up the most recent branch/PR from ANY proposal");
  assert.equal(priorApproveRunBranch(lines, "P-NEVER-APPROVED"), undefined, "resume finds nothing for a proposal with no push of its own");
});
