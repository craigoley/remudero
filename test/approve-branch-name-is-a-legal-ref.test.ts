import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approveProposal, approveRunBranch, priorApproveRunBranch, type DraftedCandidate, type InboxClassification, type RatifyGateway } from "../src/lib/inbox.js";
import { ruleEfficacyProposalId } from "../src/lib/rule-efficacy.js";

// MEASURED on the fleet host 2026-08-28T20:24:45Z and again at :46Z:
//   fatal: 'run-APPROVE-board-review:escalation:#3039-1787948684350' is not a valid branch name
// `approveCommand` mints `APPROVE-<proposalId>-<ms>`, `createRatificationBranch` built
// `run-<runId>` from it verbatim, and lib/board-review.ts mints ids containing COLONS — which
// git refuses in a ref. These tests pin the branch-name boundary: every id shape the codebase
// MINTS must produce a ref `git check-ref-format` accepts, two distinct ids must never land on
// one branch (they would share a worktree), and the sanitising must happen at the branch, never
// on the proposal id (a registry key and a ledger `task_id` value).

// ── The POPULATION: every proposal-id shape this codebase mints, by producing symbol ─────────

const MINTED_ID_SHAPES: Array<{ id: string; producer: string; legalUnslugged: boolean }> = [
  // lib/board-review.ts — the two live shapes; all 17 open proposals are one of these.
  { id: "board-review:stale:#3025", producer: "board-review.ts stale", legalUnslugged: false },
  { id: "board-review:escalation:#3039", producer: "board-review.ts escalation", legalUnslugged: false },
  // lib/rule-efficacy.ts — LATENT today (no such proposal is open) and equally illegal.
  { id: ruleEfficacyProposalId("R-12"), producer: "ruleEfficacyProposalId", legalUnslugged: false },
  // lib/feedback-docket.ts — already slugged at the mint, so legal before and after.
  { id: "FD-2026-08-28-claude-md-rule", producer: "feedback-docket idFor", legalUnslugged: true },
  // The registry's own prose ids (Proposal.id's documented example, e.g. "P25").
  { id: "P25", producer: "MASTER-PLAN registry prose", legalUnslugged: true },
];

/** Real `git check-ref-format --branch`, never a re-implementation of git's rules. */
function gitAcceptsBranch(name: string): boolean {
  try {
    execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** The derivation `approveCommand` performs, mirrored exactly: run id, then branch. */
function runIdFor(proposalId: string, ms = 1787948684350): string {
  return `APPROVE-${proposalId}-${ms}`;
}

test("git check-ref-format accepts the slugged branch for EVERY minted proposal-id shape, and the control proves the check discriminates", () => {
  const rejectedUnslugged: string[] = [];
  for (const shape of MINTED_ID_SHAPES) {
    const runId = runIdFor(shape.id);
    const slugged = approveRunBranch(runId);
    assert.equal(gitAcceptsBranch(slugged), true, `git rejected the slugged branch for ${shape.producer}: ${slugged}`);

    // CONTROL, the other direction: the PRE-FIX derivation, on the same names, through the same
    // check. Without this the assertion above would pass vacuously for a check that accepts
    // everything.
    const preFix = `run-${runId}`;
    assert.equal(
      gitAcceptsBranch(preFix),
      shape.legalUnslugged,
      `pre-fix branch for ${shape.producer} should be ${shape.legalUnslugged ? "LEGAL" : "ILLEGAL"}: ${preFix}`,
    );
    if (!shape.legalUnslugged) rejectedUnslugged.push(shape.producer);
  }
  assert.deepEqual(
    rejectedUnslugged,
    ["board-review.ts stale", "board-review.ts escalation", "ruleEfficacyProposalId"],
    "three minted shapes carry a colon and are illegal — this is NOT a board-review-only defect",
  );
});

test("the offending character is the COLON alone — `#` is legal in a git ref, so the fix must not strip it as if it were the cause", () => {
  assert.equal(gitAcceptsBranch("run-APPROVE-board-review-escalation-#3039-1"), true, "`#` is legal in a ref");
  assert.equal(gitAcceptsBranch("run-APPROVE-board-review:escalation-3039-1"), false, "`:` is what git refuses");
});

// ── INJECTIVITY: two distinct ids must never share one branch (and hence one worktree) ───────

test("two ids the readable slug alone WOULD collide land on different branches, and the collision is proven real rather than assumed", () => {
  // These differ only in a character the slug maps to "-", so the readable half is identical.
  const a = runIdFor("board-review:escalation:#3039");
  const b = runIdFor("board-review-escalation-#3039");
  assert.notEqual(a, b, "the two run ids really are distinct");

  // The FALSIFIER for the digest: prove the readable half alone collides, so the digest is
  // load-bearing rather than decoration.
  const readableOnly = (s: string) =>
    s
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/\.{2,}/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
  assert.equal(readableOnly(a), readableOnly(b), "without the digest these two ids DO collide");

  assert.notEqual(approveRunBranch(a), approveRunBranch(b), "with the digest they must not");
});

test("every open proposal in the live registry's own id shapes maps to a distinct, git-legal branch", () => {
  // The 17 ids the fleet host's state/inbox-proposals.json actually held on 2026-08-28.
  const live = [
    "board-review:escalation:#2971", "board-review:escalation:#3030", "board-review:escalation:#3039",
    "board-review:escalation:#3043", "board-review:escalation:#3059", "board-review:escalation:#3054",
    "board-review:stale:#3025", "board-review:escalation:#3063", "board-review:stale:#3043",
    "board-review:stale:#3039", "board-review:escalation:#3194", "board-review:escalation:#3189",
    "board-review:escalation:#3199", "board-review:escalation:#3205", "board-review:stale:#3185",
    "board-review:stale:#3175", "board-review:escalation:#3227",
  ];
  const branches = live.map((id) => approveRunBranch(runIdFor(id)));
  for (const b of branches) assert.equal(gitAcceptsBranch(b), true, `git rejected ${b}`);
  assert.equal(new Set(branches).size, live.length, "17 distinct proposals must produce 17 distinct branches");
  // Same proposal, different run: still distinct, because the digest covers the whole run id.
  assert.notEqual(approveRunBranch(runIdFor(live[0], 1)), approveRunBranch(runIdFor(live[0], 2)));
});

test("the derivation is deterministic — the same run id always yields the same branch, which is what makes resumption possible at all", () => {
  const runId = runIdFor("board-review:escalation:#3039");
  assert.equal(approveRunBranch(runId), approveRunBranch(runId));
});

// ── CALLER 1: priorApproveRunBranch (lib/inbox.ts) — the RESUME derivation ───────────────────

test("priorApproveRunBranch routes through the same slug, so a resumed board-review branch is a legal ref and matches what creation would have produced", () => {
  const proposalId = "board-review:escalation:#3039";
  const runId = runIdFor(proposalId);
  const resumed = priorApproveRunBranch([{ run_id: runId, task_id: proposalId }], proposalId);
  assert.notEqual(resumed, undefined);
  assert.equal(gitAcceptsBranch(resumed as string), true, "a resume candidate git cannot name is unusable");
  assert.equal(resumed, approveRunBranch(runId), "resume and creation must derive the SAME name or a pushed branch is never found");
});

// ── CALLER 2: approveProposal reaching branch creation for a board-review id ─────────────────

const BOARD_REVIEW_ID = "board-review:escalation:#3039";

const CACHED_DRAFT: DraftedCandidate = {
  proposalId: BOARD_REVIEW_ID,
  fragmentYaml: "- id: W1-T900\n  title: candidate task\n  repo: remudero\n",
  stampLine: "- board-review:escalation:#3039 (plan) — RATIFIED 2026-08-28 -> W1-T900.",
  anchorFingerprint: "landed::MASTER-PLAN.md",
};

test("a driven approveProposal for a board-review id reaches createRatificationBranch and hands on a branch git accepts, where the pre-fix derivation is refused", () => {
  const runId = runIdFor(BOARD_REVIEW_ID);
  let created = 0;
  const gateway: RatifyGateway = {
    createRatificationBranch(payload) {
      created++;
      // The production wiring, mirrored: run-task.ts's createRatificationBranch now calls
      // approveRunBranch(runId) where it used to build `run-${runId}`.
      assert.equal(payload.proposalId, BOARD_REVIEW_ID);
      return approveRunBranch(runId);
    },
    openPlanPr(branch) {
      assert.equal(gitAcceptsBranch(branch), true, `approveProposal handed a branch git cannot create: ${branch}`);
      return "https://github.com/craigoley/remudero/pull/9001";
    },
  };

  const classification: InboxClassification = {
    proposalId: BOARD_REVIEW_ID,
    state: "ready",
    reasons: [],
    draft: CACHED_DRAFT,
    draftStale: false,
  };
  const path = join(mkdtempSync(join(tmpdir(), "rmd-approve-branch-name-")), "ledger.ndjson");
  const result = approveProposal(classification, gateway, { ledgerPath: path, runId });

  assert.equal(created, 1, "branch creation must actually be reached for a board-review proposal");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(gitAcceptsBranch(result.branch), true);
    // REGRESSION: the exact name the fleet host died on.
    assert.equal(gitAcceptsBranch(`run-${runId}`), false, "the pre-fix branch name must still be refused by git");
  }
});

// ── Q3: the same string becomes a WORKTREE DIRECTORY, so prove git really creates both ───────

test("git worktree add succeeds with the slugged branch, and the directory it creates carries neither a colon nor a hash", () => {
  const repo = mkdtempSync(join(tmpdir(), "rmd-approve-branch-repo-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"], { stdio: "pipe", env });
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"], { stdio: "pipe", env });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "pipe", env });
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", repo, "add", "seed.txt"], { stdio: "pipe", env });
  execFileSync("git", ["-C", repo, "commit", "-qm", "seed"], { stdio: "pipe", env });

  const branch = approveRunBranch(runIdFor(BOARD_REVIEW_ID));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "rmd-approve-branch-wt-"));
  const worktreePath = join(worktreeRoot, branch); // the SAME join(worktreesDir(config), branch)
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, "--no-track", worktreePath, "main"], { stdio: "pipe", env });

  assert.equal(existsSync(worktreePath), true, "the worktree directory must exist");
  const created = readdirSync(worktreeRoot);
  assert.deepEqual(created, [branch]);
  assert.equal(created[0].includes(":"), false, "a colon in a worktree directory name is hostile in shell");
  assert.equal(created[0].includes("#"), false, "so is a hash");
});
