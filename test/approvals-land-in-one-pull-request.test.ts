import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  approveProposal,
  approveRunBranch,
  mostRecentApprovePr,
  priorApproveRunBranch,
  type DraftedCandidate,
  type InboxClassification,
  type RatifyGateway,
} from "../src/lib/inbox.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { approveCommand } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

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

// ── The REAL gateway's join hooks (run-task.ts's approveCommand) ─────────────────────────────
// Every test above injects a RatifyGateway, which replaces approveCommand's own gateway object
// wholesale — so its real `findJoinablePr` (ledger candidate -> live PR probe -> live head read ->
// arm check) and `joinRatificationBranch` (checkout at the open PR's OWN tip, mint, commit, push)
// never execute. These drive the un-injected gateway offline: a bare throwaway origin that already
// carries a PRIOR approve run's pushed branch, a ledger holding that run's `ratify.approved` row,
// and a `gh` shim on PATH answering the REST reads. The shim names the PRIOR branch as the PR's head,
// so only a JOINED run clears the run-ownership guard (an approval on its own branch is refused right
// after the gateway returns), and its CI answers red on the first poll — no wait, no review.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIOR_RUN_ID = "APPROVE-P-FIRST-1790000000000";
const PRIOR_PR_URL = "https://github.com/craigoley/remudero/pull/4437";
const OWN_PR_URL = "https://github.com/craigoley/remudero/pull/4438";

function planTask(id: string, title: string): string {
  return `- id: ${id}\n  title: "${title}"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n`;
}

interface RealJoinDrive {
  priorBranch: string;
  priorSha: string;
  /** The prior branch's tip on the origin AFTER the drive. */
  priorTipAfter: string;
  /** Every `run-*` branch on the origin after the drive. */
  runBranches: string[];
  /** Commits the prior branch carries beyond `main` after the drive. */
  priorAheadOfMain: number;
  ledger: Array<Record<string, unknown>>;
}

/** One `rmd approve P-JOIN` through the REAL gateway, while P-FIRST's approve PR is (per the shim) open.
 *  `headRead: "fails"` makes the single-PR REST read exit non-zero; `armedOnHead` ledgers an
 *  `automerge.armed` row on the prior PR's current head before the drive. */
async function driveRealGatewayApprove(opts: { headRead?: "fails"; armedOnHead?: boolean } = {}): Promise<RealJoinDrive> {
  const origin = gitRepo({ bare: true, kind: "t4437-origin" });
  const seed = gitRepo({ kind: "t4437-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), planTask("W1-T4", "a seed task the plan loader accepts"));
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed plan");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  // The FIRST approval of the pass: its branch is already pushed and its PR (per the shim) open.
  const priorBranch = approveRunBranch(PRIOR_RUN_ID);
  seed.git("checkout", "--quiet", "-b", priorBranch);
  appendFileSync(join(seed.dir, "plan", "tasks.yaml"), planTask("W1-T50", "filed by the first approval of the pass"));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore(plan): ratify P-FIRST via rmd approve");
  seed.git("push", "--quiet", "origin", priorBranch);
  const priorSha = seed.git("rev-parse", "HEAD");

  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4437-root-`));
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4437-home-`));
  // The clone the real gateway worktrees from, at the path resolveOwnerRepo() derives, with its
  // own identity — the gateway's `git commit` inherits it.
  const remoteUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  const checkoutDir = join(root, "repos", remoteUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2]);
  mkdirSync(dirname(checkoutDir), { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin.dir, checkoutDir]);
  execFileSync("git", ["-C", checkoutDir, "config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name]);
  execFileSync("git", ["-C", checkoutDir, "config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email]);

  const config = { claudeBin: "/usr/bin/true", root, installRoot: REPO_ROOT };
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(config));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: [{ id: "P-JOIN", summary: "the second approval of the pass", evidenceAnchors: [] }] }),
  );
  writeFileSync(
    join(root, "state", "inbox-drafts.json"),
    JSON.stringify({
      "P-JOIN": {
        proposalId: "P-JOIN",
        fragmentYaml:
          "- id: NEW-1\n  title: second approval joins the open pass\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n  files: [src/lib/example.ts]\n",
        stampLine: "- P-JOIN (plan) — RATIFIED -> NEW-1.",
        anchorFingerprint: "",
      },
    }),
  );
  const ledgerFile = join(root, "state", "ledger.ndjson");
  const seeded: Array<Record<string, unknown>> = [
    { run_id: PRIOR_RUN_ID, task_id: "P-FIRST", step: "ratify.approved", branch: priorBranch, pr_url: PRIOR_PR_URL, pr_number: 4437 },
  ];
  if (opts.armedOnHead) seeded.push({ step: "automerge.armed", lane: "review", pr_url: PRIOR_PR_URL, head_sha: priorSha });
  writeFileSync(ledgerFile, seeded.map((r) => JSON.stringify(r) + "\n").join(""));

  // The PR's head is the PRIOR branch, so only a JOINED run clears the run-ownership guard; its CI
  // answers red on the first poll. `--method POST` is first because the create call's argv carries
  // the whole PR body, which may name any of the other routes' substrings.
  const shim = ghShim(
    [
      { when: "--method POST", stdout: JSON.stringify({ html_url: OWN_PR_URL, number: 4438 }) },
      { when: "headRefName", stdout: JSON.stringify({ headRefName: priorBranch }) },
      { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }) },
      { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
      { when: "pulls?state=open", stdout: "[]" },
      { when: "pulls?head=", stdout: JSON.stringify([{ html_url: PRIOR_PR_URL, number: 4437 }]) },
      opts.headRead === "fails"
        ? { when: "/pulls/", stderr: "gh: HTTP 502 (fixture)", exit: 1 }
        : {
            when: "/pulls/",
            stdout: JSON.stringify({ number: 4437, html_url: PRIOR_PR_URL, state: "open", merged_at: null, head: { ref: priorBranch, sha: priorSha } }),
          },
    ],
    { kind: "t4437-gh" },
  );

  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    process.env.HOME = home;
    process.env.PATH = `${shim.dir}:${savedPath}`;
    await withLiveWritesAllowed(() => approveCommand(["P-JOIN"], { config: config as never })).catch(() => undefined);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
  }

  return {
    priorBranch,
    priorSha,
    priorTipAfter: origin.git("rev-parse", priorBranch),
    runBranches: origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads/run-*").split("\n").filter(Boolean),
    priorAheadOfMain: Number(origin.git("rev-list", "--count", `main..${priorBranch}`)),
    ledger: readLedger(ledgerFile),
  };
}

test("W1-T4437: the real gateway lands a later approval as a new commit on the open approve pull request's own branch", async () => {
  const d = await driveRealGatewayApprove();
  const steps = JSON.stringify(d.ledger.map((l) => l.step));

  assert.deepEqual(d.runBranches, [d.priorBranch], `no second approve branch may reach the origin; steps=${steps}`);
  assert.equal(d.priorAheadOfMain, 2, "the joining approval added exactly ONE commit of its own on top of the first approval's");
  assert.notEqual(d.priorTipAfter, d.priorSha, "the open branch moved forward");
  assert.equal(d.ledger.filter((l) => l.step === "approve.joined" && l.branch === d.priorBranch).length, 1, `approve.joined names the open branch; steps=${steps}`);
  const row = d.ledger.find((l) => l.step === "ratify.approved" && l.task_id === "P-JOIN");
  assert.equal(row?.joined, true, `the joining approval keeps its own ledger line; steps=${steps}`);
  assert.equal(row?.branch, d.priorBranch);
  assert.equal(row?.pr_url, PRIOR_PR_URL, "it names the ALREADY-OPEN pull request, never a new one");
  const opened = d.ledger.find((l) => l.step === "pr.opened");
  assert.equal(opened?.joined, true, `the joined PR clears the ownership guard as this run's own; steps=${steps}`);
  assert.equal(opened?.adopted, false);
});

test("W1-T4437: the real gateway never joins a pull request whose head it cannot read — it opens its own", async () => {
  const d = await driveRealGatewayApprove({ headRead: "fails" });
  const steps = JSON.stringify(d.ledger.map((l) => l.step));

  assert.equal(d.priorTipAfter, d.priorSha, "the unconfirmed pull request's branch is never written to");
  assert.equal(d.runBranches.length, 2, `this approval pushed a branch of its own; branches=${JSON.stringify(d.runBranches)}`);
  assert.ok(!d.ledger.some((l) => l.step === "approve.joined"), `nothing was joined; steps=${steps}`);
  const row = d.ledger.find((l) => l.step === "ratify.approved" && l.task_id === "P-JOIN");
  assert.ok(row, `the approval still succeeded on its own branch; steps=${steps}`);
  assert.equal(row?.joined, undefined);
  assert.notEqual(row?.branch, d.priorBranch);
});

test("W1-T4437: the real gateway never joins a pull request already queued to merge on its current head", async () => {
  const d = await driveRealGatewayApprove({ armedOnHead: true });
  const steps = JSON.stringify(d.ledger.map((l) => l.step));

  assert.equal(d.priorTipAfter, d.priorSha, "a pull request on its way to main is never given another commit");
  assert.equal(d.runBranches.length, 2, `this approval pushed a branch of its own; branches=${JSON.stringify(d.runBranches)}`);
  assert.ok(!d.ledger.some((l) => l.step === "approve.joined"), `nothing was joined; steps=${steps}`);
  const row = d.ledger.find((l) => l.step === "ratify.approved" && l.task_id === "P-JOIN");
  assert.equal(row?.joined, undefined, `the approval opened its own pull request; steps=${steps}`);
  assert.equal(row?.pr_url, "https://github.com/craigoley/remudero/pull/4438");
});
