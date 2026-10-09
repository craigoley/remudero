/**
 * W1-T6434. W1-T6362 preserves a dead fix owner's staged work in an immutable
 * refs/rmd-recovery/fix-dirty/... ref and reclaims its checkout, but the NEXT fix round used to start
 * blind. These fixtures use a REAL git repository for the recovery ref and drive the real
 * `runFixRung`, capturing the prompt it hands the worker.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "../src/run-task.js";
import { PRIOR_PARTIAL_WORK_EXCERPT_CAP, readPreservedOwnerPatch } from "../src/lib/sweep.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const PR = 6434;
const STAGED = "src/staged-fix.ts";
const WITHHELD = "config/.env.local";
const TOKEN = `ghp_${"A1b2C3d4".repeat(5)}`;
const PASSWORD_LINE = `const password = "${"hunter2".repeat(3)}";`;

function worker(): WorkerResult {
  return {
    sessionId: "fix-session",
    costUsd: 1,
    numTurns: 2,
    text: "REPORT\nno anchored commit line",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

function failedReview(headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const criterion: CriterionVerdict = {
    claim: "the fix lands",
    proof: "unit test: the fix lands",
    met: false,
    reason: "still blocked",
    proof_exec: "not_executable",
  };
  return {
    state: "failure",
    criteria: [criterion],
    testTheater: false,
    summary: "blocked",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "failure",
  };
}

function issues(): IssueGateway {
  return { create: () => "https://github.com/acme/remudero/issues/1", listOpen: (): OpenIssue[] => [], comment: () => {} };
}

interface Preserved {
  repo: GitRepo;
  /** The owner's HEAD, which is also the PR's head the row is stamped with. */
  head: string;
  recoveryRef: string;
}

/** Build a dead owner's staged residue the way W1-T6362 preserves it: a commit whose tree is the owner's
 *  index and whose parent is the owner's HEAD, held by an immutable ref under refs/rmd-recovery/fix-dirty. */
function preservedResidue(extraBody = ""): Preserved {
  const repo = gitRepo({ kind: "w1t6434", seedCommit: true, branch: "main" });
  writeFileSync(join(repo.dir, "base.ts"), "export const base = 1;\n");
  repo.git("add", "-A");
  repo.git("commit", "-m", "seed base");
  const head = repo.git("rev-parse", "HEAD");
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  mkdirSync(join(repo.dir, "config"), { recursive: true });
  writeFileSync(join(repo.dir, STAGED), `export const staged = 2;\n${PASSWORD_LINE}\n// ${TOKEN}\n${extraBody}`);
  writeFileSync(join(repo.dir, WITHHELD), "SECRET_ONLY_IN_ENV=" + "z9".repeat(12) + "\n");
  repo.git("add", "-A");
  const tree = repo.git("write-tree");
  const commit = repo.git("commit-tree", tree, "-p", head, "-m", "chore(recovery): preserve dirty fix owner");
  const recoveryRef = `refs/rmd-recovery/fix-dirty/run-W1-T6434-fixture/${head}/${tree}`;
  repo.git("update-ref", recoveryRef, commit);
  repo.git("reset", "-q", "--hard", head);
  repo.git("clean", "-fdq");
  return { repo, head, recoveryRef };
}

function preservedRow(p: Preserved, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    step: "sweep.fix.owner_residue_preserved",
    pr_number: PR,
    task_id: "W1-T6434",
    head_sha: p.head,
    staged_paths: [STAGED, WITHHELD],
    staged_more: 0,
    recovery_ref: p.recoveryRef,
    ...over,
  };
}

/** Run the real fix rung once and return the prompt it handed the worker. */
async function promptFor(head: string, priorPartialWork: ReturnType<typeof readPreservedOwnerPatch>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t6434-"));
  const prompts: string[] = [];
  await runFixRung({
    taskId: "W1-T6434",
    runId: "W1-T6434-run",
    task: { id: "W1-T6434", title: "preserved patch", files: ["src/lib/sweep.ts"] },
    prUrl: `https://github.com/acme/remudero/pull/${PR}`,
    branch: "run-W1-T6434-1",
    worktreePath: process.cwd(),
    initialSessionId: "",
    mount: MOUNT,
    settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10,
    strikeCap: 1,
    initialReview: failedReview(head),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: MOUNT },
    ...(priorPartialWork ? { priorPartialWork } : {}),
    deps: {
      spawn: async (args: SpawnWorkerArgs) => {
        prompts.push(args.prompt);
        return worker();
      },
      waitForCiGreen: async () => "green" as const,
      runReview: async () => failedReview(head),
      fetchPrBody: async () => "REPORT",
      push: () => {},
      issues: issues(),
      ledgerPath: join(root, "ledger.ndjson"),
      log: () => {},
      say: () => {},
      account: (result: WorkerResult) => result,
      worktreeHasUncommittedChanges: () => false,
    },
  } as never);
  assert.ok(prompts.length >= 1, "the fix rung spawned a worker");
  return prompts[0]!;
}

test("W1-T6434: a preserved fix-owner patch is offered to the next fix round as prior partial work", async () => {
  const p = preservedResidue();
  const work = readPreservedOwnerPatch({ repoDir: p.repo.dir, prNumber: PR, headSha: p.head, ledgerLines: [preservedRow(p)] });
  assert.ok(work, "the preserved row at this head yields prior partial work");

  const prompt = await promptFor(p.head, work);

  assert.match(prompt, /PRIOR PARTIAL WORK/);
  assert.ok(prompt.includes(`RECOVERY REF: ${p.recoveryRef}`), "names the recovery ref");
  assert.ok(prompt.includes(STAGED), "names the staged path");
  assert.match(prompt, /export const staged = 2;/, "carries a diff excerpt");
  assert.match(prompt, /UNVERIFIED/);
  assert.match(prompt, /never apply it blindly/);
});

test("W1-T6434: the excerpt never carries a secret and never reads a secret-bearing path", () => {
  const p = preservedResidue();
  const work = readPreservedOwnerPatch({ repoDir: p.repo.dir, prNumber: PR, headSha: p.head, ledgerLines: [preservedRow(p)] });
  assert.ok(work);
  assert.ok(!work.excerpt.includes(TOKEN), "the token is scrubbed");
  assert.ok(!work.excerpt.includes("hunter2hunter2"), "the credential assignment is scrubbed");
  assert.ok(!work.excerpt.includes("SECRET_ONLY_IN_ENV"), "a .env file's bytes are withheld");
  assert.ok(work.excerpt.includes("export const staged = 2;"));
});

test("W1-T6434: the excerpt is size-capped and says it was truncated", () => {
  const p = preservedResidue("// padding line to push the diff past the cap\n".repeat(400));
  const work = readPreservedOwnerPatch({ repoDir: p.repo.dir, prNumber: PR, headSha: p.head, ledgerLines: [preservedRow(p)] });
  assert.ok(work);
  assert.equal(work.excerpt.length, PRIOR_PARTIAL_WORK_EXCERPT_CAP);
  assert.equal(work.excerptTruncated, true);
  const prompt = renderFixPrompt({
    task: { id: "W1-T6434", title: "t" },
    round: 1,
    branch: "b",
    evidence: { review: { unmetCriteria: [], summary: "s" }, priorPartialWork: work },
  });
  assert.match(prompt, /TRUNCATED/);
});

test("W1-T6434: a head with no preserved row prompts exactly as before", async () => {
  const p = preservedResidue();
  // A row for another head, another PR, and the sibling superseded-head step: none applies.
  const lines = [
    preservedRow(p, { head_sha: "f".repeat(40) }),
    preservedRow(p, { pr_number: PR + 1 }),
    preservedRow(p, { step: "sweep.fix.checkout_owner_dirty_preserved" }),
  ];
  const work = readPreservedOwnerPatch({ repoDir: p.repo.dir, prNumber: PR, headSha: p.head, ledgerLines: lines });
  assert.equal(work, undefined);

  const withNone = await promptFor(p.head, work);
  const baseline = await promptFor(p.head, undefined);
  assert.equal(withNone, baseline);
  assert.ok(!/PRIOR PARTIAL WORK|rmd-recovery/.test(withNone));
});

test("W1-T6434: an unreadable or out-of-namespace recovery ref yields no prior work and reports why", () => {
  const p = preservedResidue();
  const reasons: string[] = [];
  const onUnreadable = (why: { reason: string }) => reasons.push(why.reason);
  const missing = readPreservedOwnerPatch({
    repoDir: p.repo.dir, prNumber: PR, headSha: p.head, onUnreadable,
    ledgerLines: [preservedRow(p, { recovery_ref: `refs/rmd-recovery/fix-dirty/gone/${p.head}/${"0".repeat(40)}` })],
  });
  const outside = readPreservedOwnerPatch({
    repoDir: p.repo.dir, prNumber: PR, headSha: p.head, onUnreadable,
    ledgerLines: [preservedRow(p, { recovery_ref: "refs/heads/main" })],
  });
  assert.equal(missing, undefined);
  assert.equal(outside, undefined);
  assert.equal(reasons.length, 2);
});
