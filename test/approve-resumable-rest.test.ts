import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approveProposal, approveRunBranch, describeApproveGatewayError, priorApproveRunBranch, type DraftedCandidate, type InboxClassification, type RatifyGateway } from "../src/lib/inbox.js";
import { createPlanPrRest, probeExistingPlanPr, ratifyPrCreateRestArgs, ratifyPrProbeRestArgs } from "../src/lib/plan-pr-emitter.js";

// W1-T903: `rmd approve` used to commit + push the ratification branch and only THEN shell
// `gh pr create` (GraphQL) — an exhausted GraphQL budget stranded a pushed branch with no PR,
// and a naive re-run pushed a SECOND branch rather than finishing the first. This file proves,
// over an INJECTED RatifyGateway and a seeded ledger (no operator, no network, no real git),
// that a re-run ADOPTS an existing PR or COMPLETES a pushed-but-PR-less branch, never re-pushes
// or re-mints, that the ratification PR now opens over REST, and that a throttled create reads
// as throttled rather than as a bare, silent failure.

// ── Fixtures ─────────────────────────────────────────────────────────────────

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-approve-resumable-rest-")), "ledger.ndjson");
}

function readLedger(path: string): Array<Record<string, unknown>> {
  // A run that ledgers NOTHING (design vii: a thrown gateway error appends no ratify.* line at
  // all) never creates the file — mirrors lib/status.ts's own readLedgerLines, which treats an
  // absent ledger as zero lines rather than an error.
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const CACHED_DRAFT: DraftedCandidate = {
  proposalId: "P-READY",
  fragmentYaml: "- id: W1-T900\n  title: candidate task\n  repo: remudero\n",
  stampLine: "- P-READY (plan) — RATIFIED 2026-07-20 -> W1-T900.",
  anchorFingerprint: "landed::MASTER-PLAN.md",
};

function readyClassification(): InboxClassification {
  return { proposalId: "P-READY", state: "ready", reasons: [], draft: CACHED_DRAFT, draftStale: false };
}

const RESUMED_BRANCH = "run-APPROVE-P-READY-1784800000000";

/** A fake gateway whose every method is call-counted, mirroring test/inbox-approve.test.ts's
 *  own `fakeGateway` convention (closure counters, exposed live via getters) — extended with
 *  W1-T903's three OPTIONAL resumption methods. */
function fakeGateway(opts: {
  resumeBranch?: string;
  existingPr?: { prUrl: string; prNumber: number };
  openPlanPrThrows?: unknown;
} = {}): RatifyGateway & {
  branchCalls: number;
  completeCalls: number;
  findPushedBranchCalls: number;
  findExistingPrCalls: number;
  prCalls: Array<{ branch: string; proposalId: string }>;
} {
  let branchCalls = 0;
  let completeCalls = 0;
  let findPushedBranchCalls = 0;
  let findExistingPrCalls = 0;
  const prCalls: Array<{ branch: string; proposalId: string }> = [];
  return {
    get branchCalls() {
      return branchCalls;
    },
    get completeCalls() {
      return completeCalls;
    },
    get findPushedBranchCalls() {
      return findPushedBranchCalls;
    },
    get findExistingPrCalls() {
      return findExistingPrCalls;
    },
    prCalls,
    findPushedBranch() {
      findPushedBranchCalls++;
      return opts.resumeBranch;
    },
    findExistingPr() {
      findExistingPrCalls++;
      return opts.existingPr;
    },
    completeRatificationBranch(branch) {
      completeCalls++;
      return branch;
    },
    createRatificationBranch(payload) {
      branchCalls++;
      return `run-APPROVE-${payload.proposalId}-9999999999999`;
    },
    openPlanPr(branch, proposalId) {
      if (opts.openPlanPrThrows) throw opts.openPlanPrThrows;
      prCalls.push({ branch, proposalId });
      return "https://github.com/craigoley/remudero/pull/500";
    },
  };
}

// ── Acceptance #1/#3: COMPLETE — a re-run whose prior push has no PR finishes it, never
//    re-pushes and never re-mints (createRatificationBranch is never called) ────────────────

test("approveProposal COMPLETEs a branch a prior run already pushed: completeRatificationBranch runs, createRatificationBranch never does, and exactly one PR is opened", () => {
  const gateway = fakeGateway({ resumeBranch: RESUMED_BRANCH, existingPr: undefined });
  const path = ledgerPath();

  const result = approveProposal(readyClassification(), gateway, { ledgerPath: path, runId: "RUN-1" });

  assert.equal(gateway.findPushedBranchCalls, 1);
  assert.equal(gateway.findExistingPrCalls, 1);
  assert.equal(gateway.completeCalls, 1, "COMPLETE must finish the pushed branch");
  assert.equal(gateway.branchCalls, 0, "createRatificationBranch must NEVER run on a resumed branch — no second push, no re-mint");
  assert.equal(gateway.prCalls.length, 1, "exactly one PR create for the missing PR");
  assert.equal(gateway.prCalls[0].branch, RESUMED_BRANCH);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.branch, RESUMED_BRANCH);
    assert.equal(result.adopted, undefined, "COMPLETE is not ADOPT — this run did open a PR");
  }

  const lines = readLedger(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "ratify.approved");
  assert.equal(lines[0].branch, RESUMED_BRANCH);
  assert.equal(lines[0].pr_number, 500, "acceptance #4: the ledger line carries the PR's number");
});

// ── Acceptance #1: ADOPT — a PR that already exists on the resumed branch is adopted; NOTHING
//    is opened (zero branch calls, zero PR-create calls) ───────────────────────────────────

test("approveProposal ADOPTs an existing PR on a resumed branch: createRatificationBranch, completeRatificationBranch and openPlanPr are ALL never called — it opens nothing", () => {
  const existingPr = { prUrl: "https://github.com/craigoley/remudero/pull/777", prNumber: 777 };
  const gateway = fakeGateway({ resumeBranch: RESUMED_BRANCH, existingPr });
  const path = ledgerPath();

  const result = approveProposal(readyClassification(), gateway, { ledgerPath: path, runId: "RUN-1" });

  assert.equal(gateway.branchCalls, 0);
  assert.equal(gateway.completeCalls, 0);
  assert.equal(gateway.prCalls.length, 0, "ADOPT opens NOTHING — no gh pull create of any kind");

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.branch, RESUMED_BRANCH);
    assert.equal(result.prUrl, existingPr.prUrl);
    assert.equal(result.prNumber, 777);
    assert.equal(result.adopted, true);
  }

  const lines = readLedger(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "ratify.approved");
  assert.equal(lines[0].pr_url, existingPr.prUrl);
  assert.equal(lines[0].pr_number, 777);
  assert.equal(lines[0].branch, RESUMED_BRANCH);
});

// ── Control: no resumption evidence at all — today's PROCEED path is unaffected ─────────────

test("approveProposal PROCEEDs exactly as before when findPushedBranch reports no evidence", () => {
  const gateway = fakeGateway({ resumeBranch: undefined });
  const path = ledgerPath();

  const result = approveProposal(readyClassification(), gateway, { ledgerPath: path, runId: "RUN-1" });

  assert.equal(gateway.branchCalls, 1);
  assert.equal(gateway.completeCalls, 0);
  assert.equal(gateway.prCalls.length, 1);
  assert.equal(result.ok, true);
});

// ── Acceptance #5: a throttled create surfaces as throttled and leaves the proposal
//    approvable again — no ratify.approved line, the branch is described as pushed ──────────

test("a rate-limit-classified openPlanPr failure surfaces as THROTTLED, names the pushed branch and the resume verb, and ledgers NO ratify.approved line", () => {
  const rateLimited = Object.assign(new Error("Command failed: gh api ... pulls"), {
    status: 1,
    stderr: "GraphQL: API rate limit already exceeded for user ID 4397075.",
  });
  const gateway = fakeGateway({ resumeBranch: RESUMED_BRANCH, existingPr: undefined, openPlanPrThrows: rateLimited });
  const path = ledgerPath();

  assert.throws(
    () => approveProposal(readyClassification(), gateway, { ledgerPath: path, runId: "RUN-1" }),
    (e: Error) => {
      assert.match(e.message, /throttled/i);
      assert.match(e.message, /pushed/i);
      assert.match(e.message, new RegExp(RESUMED_BRANCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(e.message, /rmd approve P-READY/, "must name the resume verb, not a bare failure");
      return true;
    },
  );

  // Acceptance #4's other half: NOTHING is ledgered on a thrown gateway error — the proposal
  // is exactly as READY as it was before this call (approveCommand's own catch, unchanged by
  // this task, is what appends approve.error — see run-task.ts).
  assert.deepEqual(readLedger(path), []);
});

test("describeApproveGatewayError leaves a non-rate-limit failure's own message unchanged", () => {
  const plain = new Error("rmd approve: refusing to materialize task id(s) for P-READY — degraded mint");
  assert.equal(describeApproveGatewayError(plain, "P-READY", "run-x"), plain.message);
});

// ── priorApproveRunBranch: pure ledger-evidence derivation ──────────────────────────────────

test("priorApproveRunBranch names the MOST RECENT APPROVE-<id>-<ms> run's branch for this proposal, ignoring other proposals and non-approve run_ids", () => {
  const lines = [
    { run_id: "APPROVE-P-READY-100", task_id: "P-READY", step: "approve.id_materialized" },
    { run_id: "APPROVE-P-OTHER-999999999999", task_id: "P-OTHER", step: "approve.error" },
    { run_id: "DRAIN-1234", task_id: "P-READY", step: "run.start" },
    { run_id: "APPROVE-P-READY-200", task_id: "P-READY", step: "approve.error" },
  ];
  // The branch name is derived through `approveRunBranch` (the ONE branch-name boundary, so
  // resume and creation can never drift) — asserted against the derivation of the MOST RECENT
  // run id, and asserted NOT to equal the older one, which is the discrimination this test owns.
  assert.equal(priorApproveRunBranch(lines, "P-READY"), approveRunBranch("APPROVE-P-READY-200"));
  assert.notEqual(priorApproveRunBranch(lines, "P-READY"), approveRunBranch("APPROVE-P-READY-100"));
  assert.equal(priorApproveRunBranch(lines, "P-NEVER-APPROVED"), undefined);
  assert.equal(priorApproveRunBranch([], "P-READY"), undefined);
});

// ── Acceptance #2: the ratification PR is created over REST — the argv never shells
//    `gh pr create`, and the resumption probe never shells `gh pr list` ─────────────────────

test("ratifyPrCreateRestArgs shells `gh api --method POST .../pulls` — never `pr create`", () => {
  const args = ratifyPrCreateRestArgs("craigoley", "remudero", { title: "t", body: "b", head: "run-x", base: "main" });
  assert.equal(args[0], "api");
  assert.ok(args.includes("--method"));
  assert.ok(args.includes("POST"));
  assert.ok(args.some((a) => a === "repos/craigoley/remudero/pulls"));
  assert.ok(!args.includes("pr"), "must never shell the `pr` subcommand at all");
  assert.ok(!args.includes("create"), "must never shell `create` as a bare gh subcommand");
});

test("ratifyPrProbeRestArgs shells `gh api repos/.../pulls?head=...` — never `pr list`", () => {
  const args = ratifyPrProbeRestArgs("craigoley", "remudero", "run-x");
  assert.equal(args[0], "api");
  assert.ok(!args.includes("pr"));
  assert.ok(!args.includes("list"));
  assert.match(args[1], /^repos\/craigoley\/remudero\/pulls\?head=craigoley:run-x&state=open$/);
});

test("createPlanPrRest reads number+html_url off ONE fetch call — no second call to learn the number", () => {
  const calls: string[][] = [];
  const fetch = (args: string[]) => {
    calls.push(args);
    return { html_url: "https://github.com/craigoley/remudero/pull/42", number: 42 };
  };
  const ref = createPlanPrRest(fetch, "craigoley", "remudero", { title: "t", body: "b", head: "run-x", base: "main" });
  assert.deepEqual(ref, { prUrl: "https://github.com/craigoley/remudero/pull/42", prNumber: 42 });
  assert.equal(calls.length, 1);
});

test("createPlanPrRest throws loud on a malformed create response, never silently ledgers nothing as success", () => {
  const fetch = () => ({});
  assert.throws(() => createPlanPrRest(fetch, "craigoley", "remudero", { title: "t", body: "b", head: "run-x", base: "main" }));
});

test("probeExistingPlanPr resolves the first matching row, or undefined for an empty list", () => {
  const found = (args: string[]) => [{ html_url: "https://github.com/craigoley/remudero/pull/9", number: 9 }];
  assert.deepEqual(probeExistingPlanPr(found, "craigoley", "remudero", "run-x"), {
    prUrl: "https://github.com/craigoley/remudero/pull/9",
    prNumber: 9,
  });
  const empty = () => [];
  assert.equal(probeExistingPlanPr(empty, "craigoley", "remudero", "run-x"), undefined);
});
