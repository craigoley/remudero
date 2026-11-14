/**
 * test/a-capped-pr-advances-to-a-corrected-task-contract.test.ts — W1-T3830.
 *
 * PR #6153 was reviewed CAPPED against W1-T3817's old proof. The plan-only correction #6169 merged,
 * but the PR head still held the old task record, so the reviewer rightly kept the old contract and
 * the sweep only escalated. The full sweep now reads the task contract at a capped head and, when
 * main's contract differs, asks GitHub to update the branch once with the `task-contract` reason.
 *
 * The head contract is read by the production reader over a real git repository.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { taskContractRevision } from "#src/lib/escalate.js";
import {
  DEFAULT_SWEEP_POLICY,
  readTaskContractAtHeadViaGit,
  refreshOverlapOf,
  runSweep,
  type ArmedStalledPr,
  type OpenPrView,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const ID = "W1-T9830";
const NOW = Date.parse("2026-09-20T01:10:00.000Z");
const ASOF = new Date(NOW).toISOString();
const FILES = ["src/lib/example.ts"];
const CLAIM = "only synthesis.inbox_draft declares provider openweight";
const OLD_PROOF = "unit test: only synthesis.inbox_draft declares provider openweight";
const NEW_PROOF = 'grep: cwd: join(root, "worktree") in src/lib/example.ts';
const HEAD_TASK = { id: ID, files: FILES, acceptance: [{ claim: CLAIM, proof: OLD_PROOF }] };
const MAIN_TASK = { id: ID, files: FILES, acceptance: [{ claim: CLAIM, proof: NEW_PROOF }] };

/** A real repository whose last commit holds the task record the PR head carries. */
function committedHead(t: TestContext): { dir: string; headSha: string } {
  const repo = gitRepo({ kind: "w1t3830" });
  t.after(() => repo.cleanup());
  const dir = repo.dir;
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), [
    `- id: ${ID}`, "  title: the capped fixture task", "  repo: remudero", "  type: implement", "  depends_on: []",
    "  verify: auto", "  status: queued", "  attempts: 0", `  files: [${FILES.join(", ")}]`, "  acceptance:",
    `    - claim: "${CLAIM}"`, `      proof: "${OLD_PROOF}"`, "",
  ].join("\n"));
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "head");
  return { dir, headSha: repo.git("rev-parse", "HEAD") };
}

function cappedView(headSha: string, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 6153, prUrl: "https://github.com/craigoley/remudero/pull/6153", taskId: ID, headSha,
    headRefName: `run-${ID}-1789866911000`, reviewState: "success", checksState: "green", armRefusalIsTerminal: true,
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    autoMergeArmed: false, mergeState: "clean", mergeable: true, changedFiles: FILES, ...over,
  };
}

function harness(dir: string, mainRevision: string | undefined, over: Partial<SweepDeps> = {}) {
  const rows: Record<string, unknown>[] = [];
  const updates: ArmedStalledPr[] = [];
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const headReads: number[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/nonexistent-rmd-w1-t3830/ledger.ndjson", runId: "W1-T3830-sweep", now: () => NOW,
    readLedger: () => rows.slice(),
    appendLine: (_path, row) => { rows.push({ ...row, ts: ASOF }); },
    log: (step, extra) => { logs.push([step, extra]); },
    readTaskContractRevision: () => mainRevision,
    readTaskContractAtHead: (pr) => { headReads.push(pr.prNumber); return readTaskContractAtHeadViaGit(dir, pr); },
    updateBranch: (c) => { updates.push(c); return "updated"; },
    ...over,
  };
  return { rows, updates, logs, headReads, run: (prs: OpenPrView[]) => runSweep(prs, deps, DEFAULT_SWEEP_POLICY) };
}

test("W1-T3830 criterion 1: a capped PR whose main task contract differs from its head contract is selected once for branch advance", async (t) => {
  const { dir, headSha } = committedHead(t);
  assert.deepEqual(await readTaskContractAtHeadViaGit(dir, cappedView(headSha)), { revision: taskContractRevision(HEAD_TASK) },
    "the production reader resolves the contract committed at the head");

  const h = harness(dir, taskContractRevision(MAIN_TASK));
  await h.run([cappedView(headSha)]);
  assert.deepEqual(h.updates.map((u) => [u.prNumber, u.headSha, u.updateReason]), [[6153, headSha, "task-contract"]]);
  const attempted = h.rows.filter((r) => r.step === "sweep.update_branch.attempted");
  assert.deepEqual(attempted.map((r) => [r.pr_number, r.head_sha, r.update_reason]), [[6153, headSha, "task-contract"]]);
  assert.equal(h.rows.filter((r) => r.step === "sweep.update_branch.updated").length, 1);

  // The same head is never pressed twice: a second pass reads the spent head from the ledger.
  await h.run([cappedView(headSha)]);
  assert.equal(h.updates.length, 1, "one branch advance per capped head");

  // The refresh value gate reads the advance as a repair, as it reads a stale gate.
  assert.equal(refreshOverlapOf({ updateReason: "task-contract" }, { changedFiles: FILES }, undefined).repairNeeded, true);
});

test("W1-T3830 criterion 2: an unchanged contract, an unrelated plan amendment, an unreadable head contract, and a draft or in-flight PR cannot trigger the task-contract branch advance", async (t) => {
  const { dir, headSha } = committedHead(t);

  const unchanged = harness(dir, taskContractRevision(HEAD_TASK));
  await unchanged.run([cappedView(headSha)]);
  assert.deepEqual(unchanged.updates, [], "an unchanged contract does not advance the branch");
  assert.deepEqual(unchanged.headReads, [6153], "the head contract was read and compared");

  // An amendment that rewrites only the task's prose leaves its execution contract unchanged.
  const prose = harness(dir, taskContractRevision({ ...HEAD_TASK, design: "reworded design", title: "a new title" } as typeof HEAD_TASK));
  await prose.run([cappedView(headSha)]);
  assert.deepEqual(prose.updates, [], "an unrelated plan amendment does not advance the branch");

  // The head object is absent and the repository has no origin, so the head contract is unreadable.
  const absentHead = "e".repeat(40);
  const unreadable = harness(dir, taskContractRevision(MAIN_TASK));
  await unreadable.run([cappedView(absentHead)]);
  assert.deepEqual(unreadable.updates, [], "an unreadable head contract is never a difference");
  assert.deepEqual(unreadable.logs.filter(([step]) => step === "sweep.task_contract_advance.unreadable")
    .map(([, extra]) => [extra?.pr_number, extra?.head_sha]), [[6153, absentHead]]);

  const draft = harness(dir, taskContractRevision(MAIN_TASK));
  await draft.run([cappedView(headSha, { isDraft: true })]);
  assert.deepEqual(draft.updates, [], "a draft PR does not advance");
  assert.deepEqual(draft.headReads, [], "a draft head is not read");

  const inFlight = harness(dir, taskContractRevision(MAIN_TASK), { inFlightTaskIds: new Set([ID]) });
  await inFlight.run([cappedView(headSha)]);
  assert.deepEqual(inFlight.updates, [], "a PR whose task has a live worker does not advance");

  const uncapped = harness(dir, taskContractRevision(MAIN_TASK));
  await uncapped.run([cappedView(headSha, { armRefusalIsTerminal: false, reviewState: "failure" })]);
  assert.deepEqual(uncapped.updates, [], "only a capped head takes this advance");
  assert.deepEqual(uncapped.headReads, [], "an uncapped head is not read");
});
