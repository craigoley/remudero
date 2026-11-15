import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import { gitRepo } from "#test/helpers/git-repo.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { classifyNeedsDesign, type NeedsDesignKind } from "#src/cli/commands/fix.js";
import { draftRefusalAmendment, extractRefusal, noPrVerdictRowsFromLedger } from "#src/lib/refusal-amendment.js";
import { fixLedgerRowsForHead, runSweep, type OpenPrView, type ProofDiscriminationEvidence, type SweepDeps } from "#src/lib/sweep.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

// 33 needs-design hand-offs on 11 pull requests cost 53 PR-hours (2026-11-11 to 2026-11-14), and only two were design
// questions. These tests drive the fix rung's production entry with a stub worker and read the rows it writes.

const TASK = "W1-T18060-FIXTURE";
const PR_URL = "https://github.com/acme/remudero/pull/18060";
const CLAIM = "the sweep reads the routed row";
const PROOF = "grep: needs_design_routed in src/lib/sweep.ts";

const REPORTS: Record<string, string> = {
  environment: "FIX_OUTCOME: NEEDS_DESIGN Not a design blocker: the sandbox failed to start, so no command ran",
  body: "FIX_OUTCOME: NEEDS_DESIGN this no-shell round has no gh or REST access to fix the PR body",
  commit: "FIX_OUTCOME: NEEDS_DESIGN the fix is a commit-metadata rewrite, which is prohibited in this round",
  plan: "FIX_OUTCOME: NEEDS_DESIGN this round prohibits plan changes, and the criterion needs one",
  id: "FIX_OUTCOME: NEEDS_DESIGN renumbering the follow-up needs a reserved ID first",
  contract: "FIX_OUTCOME: NEEDS_DESIGN criterion 3 conflicts with another task's test in test/sweep/x.test.ts",
  design: "FIX_OUTCOME: NEEDS_DESIGN the cause of the timeouts is unknown; which of two retry designs should hold?",
};

type Row = { step: string } & Record<string, unknown>;

function worker(text: string, n: number): WorkerResult {
  return {
    sessionId: `fix-session-${n}`, costUsd: 1, numTurns: 2, text, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
  };
}

function failedReview(headSha: string) {
  return { state: "failure" as const, capped: false, reviewerOutcome: "fixture", testTheater: false, summary: "1 unmet",
    floorDegraded: false, keywordOnly: false, planOnly: false, headSha,
    criteria: [{ claim: CLAIM, proof: PROOF, met: false, reason: "no routed row", proof_exec: "executed_fail" as const }] };
}

/** One fix rung on a real repository. The stub worker answers each report in turn, then repeats the last. */
async function rung(reports: string[], rows: Row[] = [], repo = gitRepo({ kind: "needs-design-routing" }),
  options: { body?: string; proofDiscrimination?: ProofDiscriminationEvidence } = {}) {
  let body = options.body ?? "body";
  const writes: string[] = [];
  const spawns: Array<{ resumeSessionId?: string; prompt: string; body: string }> = [];
  const issues: string[] = [];
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
  const failed = failedReview(repo.git("rev-parse", "HEAD"));
  const review = options.proofDiscrimination ? { ...failed, capped: true,
    criteria: options.proofDiscrimination.proofs.map((p) => ({ claim: p.claim, proof: p.proof, met: true,
      reason: "capped proof requires discrimination", proof_exec: "executed_stale" as const })) } : failed;
  const outcome = await runFixRung({
    taskId: TASK, runId: "needs-design-run", task: { id: TASK, title: "needs-design routing", files: ["src/lib/sweep.ts"] },
    prUrl: PR_URL, branch: `run-${TASK}-1`, worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 3, initialReview: review, proofDiscrimination: options.proofDiscrimination,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      spawn: async (args) => {
        spawns.push({ resumeSessionId: args.resumeSessionId, prompt: String(args.prompt), body });
        return worker(reports[Math.min(spawns.length, reports.length) - 1]!, spawns.length);
      },
      waitForCiGreen: async () => "green", runReview: async () => review,
      fetchPrBody: async () => body, updatePrBody: async (_url, next) => { body = next; writes.push(next); },
      push: () => { throw new Error("a needs-design round never pushes"); },
      issues: { create: () => { issues.push("created"); return "https://github.com/acme/remudero/issues/1"; }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: TASK, run_id: "needs-design-run", ts: new Date().toISOString(), ...extra }), say: () => {}, account: (r) => r,
    },
  });
  return { outcome, rows, spawns, issues, repo, writes };
}

const routed = (rows: Row[]) => rows.filter((row) => row.step === "fix.needs_design_routed");
const holds = (rows: Row[]) => rows.filter((row) => row.step === "fix.needs_design");

describe("a needs-design outcome is sorted by its kind and gets its remedy", () => {
  test("W1-T12714 criterion 1: each measured report sorts into exactly one kind, and an unsortable one is design", () => {
    const expected: Array<[string, NeedsDesignKind, string | undefined]> = [
      ["environment", "environment", undefined], ["body", "capability", "body-edit"], ["commit", "capability", "commit-message"],
      ["plan", "capability", "plan-edit"], ["id", "capability", "id-reservation"], ["contract", "contract", undefined],
      ["design", "design", undefined],
    ];
    for (const [name, kind, capability] of expected) {
      const sorted = classifyNeedsDesign(REPORTS[name]!.replace("FIX_OUTCOME: NEEDS_DESIGN ", ""), REPORTS[name]);
      assert.deepEqual([sorted.kind, sorted.capability], [kind, capability], name);
    }
    assert.equal(classifyNeedsDesign("stale plan proof requires a parent-owned amendment").kind, "contract");
    assert.equal(classifyNeedsDesign("x", "REFUSED:\n2. [contradicts-another-criterion] 2 and 4 cannot both hold\n").kind, "contract");
    assert.equal(classifyNeedsDesign("x", "REFUSED:\n1. [needs-operator-input] which budget applies?\n").kind, "design");
    assert.equal(classifyNeedsDesign("").kind, "design");
    assert.equal(classifyNeedsDesign("a long answer that names no kind at all").kind, "design");
  });

  test("W1-T12714 criterion 2: an environment report runs the round again on a fresh worker, refunds it and holds nothing", async () => {
    const { rows, spawns, repo } = await rung([REPORTS.environment!, REPORTS.design!]);
    assert.equal(spawns.length, 2, "the same round is dispatched again");
    assert.equal(spawns[1]!.resumeSessionId, undefined, "the second worker is fresh, not the first one resumed");
    const refunded = rows.filter((row) => row.step === "fix.strike_refunded");
    assert.deepEqual(refunded.map((row) => row.reason), ["needs-design-environment"]);
    const counted = fixLedgerRowsForHead(rows, TASK, repo.git("rev-parse", "HEAD")).filter((row) => row.step === "fix.dispatch");
    assert.equal(counted.length, 1, "only the second round counts toward the strike cap");
    assert.deepEqual(holds(rows).map((row) => row.needs_design_kind), ["design"], "the environment round writes no design hold");
    assert.deepEqual(routed(rows).map((row) => [row.kind, row.remedy]),
      [["environment", "redispatch-fresh-worker"], ["design", "escalate"]]);
  });

  test("W1-T12714 criterion 3: a capability report runs its action through the owner, and the next round starts on it", async () => {
    const commit = await rung([REPORTS.commit!, REPORTS.design!]);
    assert.equal(commit.spawns.length, 2, "the next round runs at once");
    assert.match(commit.spawns[1]!.prompt, /the harness makes this round's commit from your COMMIT line/);
    assert.deepEqual(routed(commit.rows).map((row) => [row.kind, row.capability, row.remedy]),
      [["capability", "commit-message", "harness-commit"], ["design", undefined, "escalate"]]);

    for (const name of ["plan", "body"] as const) {
      const { outcome, rows } = await rung([REPORTS[name]!]);
      assert.equal(outcome.outcome, "needs_design", name);
      const [hold] = holds(rows);
      assert.deepEqual([hold?.needs_design_kind, hold?.needs_design_remedy], ["capability", "amendment-proposed"], name);
      const nominated = noPrVerdictRowsFromLedger(rows, Date.now());
      assert.equal(nominated.length, 1, `${name}: the amendment writer is handed the report`);
      assert.equal(extractRefusal(nominated[0]!.reportExcerpt)[0]?.refusalClass, "outside-declared-files");
    }
  });

  test("W1-T12714 criterion 3: the reservation owner claims an id before the next worker receives it", async () => {
    const origin = gitRepo({ kind: "needs-design-id-origin", bare: true });
    const repo = gitRepo({ kind: "needs-design-id" });
    repo.addRemote("origin", origin.dir);
    repo.git("config", "user.name", "reservation fixture");
    repo.git("config", "user.email", "reservation@fixture.invalid");
    mkdirSync(join(repo.dir, "plan"));
    writeFileSync(join(repo.dir, "plan/tasks.yaml"), "tasks:\n  - id: W1-T18060\n");
    repo.git("add", "plan/tasks.yaml");
    repo.git("commit", "-qm", "plan");
    const { rows, spawns } = await rung([REPORTS.id!, REPORTS.design!], [], repo);
    assert.equal(spawns.length, 2, "a reservation releases the next round immediately");
    const [receipt] = routed(rows);
    assert.deepEqual([receipt?.kind, receipt?.capability, receipt?.remedy],
      ["capability", "id-reservation", "id-reservation"]);
    assert.equal(receipt?.reserved_task_id, "W1-T18061");
    const ref = `refs/rmd-id/${receipt?.reserved_task_id}`;
    assert.match(origin.git("show-ref", "--verify", ref), /^[a-f0-9]{40} refs\/rmd-id\/W1-T18061$/);
    assert.match(origin.git("log", "-1", "--format=%B", ref), new RegExp(`branch=run-${TASK}-1`));
    assert.match(spawns[1]!.prompt, /reserved W1-T18061/);
    assert.deepEqual(holds(rows).map((row) => row.needs_design_kind), ["design"]);
    assert.equal(noPrVerdictRowsFromLedger(rows, Date.now()).length, 0, "no files amendment is proposed for an id");
  });

  test("W1-T12714 criterion 3: a failed reservation names the failure and supplies no unreserved id", async () => {
    const repo = gitRepo({ kind: "needs-design-id-unreachable" });
    repo.git("config", "user.name", "reservation fixture");
    repo.git("config", "user.email", "reservation@fixture.invalid");
    mkdirSync(join(repo.dir, "plan"));
    writeFileSync(join(repo.dir, "plan/tasks.yaml"), "tasks: []\n");
    const { rows, spawns, outcome } = await rung([REPORTS.id!], [], repo);
    assert.equal(outcome.outcome, "stood_down");
    assert.match(outcome.reason ?? "", /reservation.*failed/i);
    assert.match(outcome.reason ?? "", /origin/);
    assert.equal(spawns.length, 1);
    assert.equal(holds(rows).length, 0, "a reservation fault is not a design hold");
    assert.equal(routed(rows)[0]?.outcome, "refused");
    assert.equal(routed(rows)[0]?.reserved_task_id, undefined);
  });

  test("W1-T12714 criterion 3: body repair validates proof evidence and writes before the next round", async () => {
    const repo = gitRepo({ kind: "needs-design-body" });
    const oldProof = "grep: ^export const routed = in src/route.ts";
    const newProof = "grep: ^export const routed = true; in src/route.ts";
    mkdirSync(join(repo.dir, "src"));
    writeFileSync(join(repo.dir, "src/route.ts"), "export const routed = false;\n");
    repo.git("add", "src/route.ts");
    repo.git("commit", "-qm", "base");
    repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(repo.dir, "src/route.ts"), "export const routed = true;\n");
    repo.git("commit", "-qam", "route");
    const body = `Acceptance:\n- ${CLAIM} | ${oldProof}\n`;
    const proposal = `PROOF_AMENDMENT:\n1. claim: ${CLAIM}\n   old_proof: ${oldProof}\n   new_proof: ${newProof}\n\n${REPORTS.body}`;
    const { rows, spawns, writes } = await rung([proposal, REPORTS.design!], [], repo, {
      body, proofDiscrimination: { bodyRepair: true, proofs: [{ claim: CLAIM, proof: oldProof, proofExec: "executed_stale" }] },
    });
    assert.deepEqual(writes, [body.replace(oldProof, newProof)], "the shared proof validator permits the body write");
    assert.equal(spawns.length, 2);
    assert.equal(spawns[1]!.body, writes[0], "the next round runs after the body write completes");
    assert.deepEqual(routed(rows).map((row) => row.remedy), ["body-repair", "escalate"]);
    assert.ok(rows.findIndex((row) => row.step === "fix.body_proof_repaired") <
      rows.findIndex((row) => row.step === "fix.needs_design_routed"));
  });

  test("W1-T12714 criterion 4: a contract report opens an acceptance amendment proposal through the refusal writer", async () => {
    const { rows, repo } = await rung([REPORTS.contract!]);
    const [hold] = holds(rows);
    assert.deepEqual([hold?.needs_design_kind, hold?.needs_design_remedy], ["contract", "amendment-proposed"]);
    const [candidate] = noPrVerdictRowsFromLedger(rows, Date.now());
    const refusals = extractRefusal(candidate!.reportExcerpt);
    assert.deepEqual(refusals.map((r) => [r.criterion, r.refusalClass]), [[3, "contradicts-another-criterion"]]);
    const opened: string[] = [];
    const result = await draftRefusalAmendment({ ...candidate!, refusals }, {
      readShard: () => ({ relPath: `plan/tasks.d/${TASK}.yaml`, text: `- id: ${TASK}\n  status: queued\n` }),
      probeExisting: () => undefined, nowIso: () => "2026-11-14T00:00:00.000Z",
      openAmendmentPr: (input) => { opened.push(input.amendedText); return { prUrl: "https://github.com/acme/remudero/pull/9002" }; },
    });
    assert.equal(result.outcome, "drafted");
    assert.match(opened[0]!, /criteria 3|criterion 3 \[contradicts-another-criterion\]/);

    // The next rung at this head waits on the amendment and asks no one.
    const again = await rung([REPORTS.design!], rows, repo);
    assert.equal(again.outcome.outcome, "stood_down");
    assert.equal(again.spawns.length, 0);
    assert.equal(again.issues.length, 0);
  });

  test("W1-T12714 criterion 5: a design report holds the head and asks a person once, as before", async () => {
    const first = await rung([REPORTS.design!]);
    assert.equal(first.outcome.outcome, "needs_design");
    assert.deepEqual(holds(first.rows).map((row) => [row.needs_design_kind, row.needs_design_remedy]), [["design", "escalate"]]);
    const second = await rung([REPORTS.design!], first.rows, first.repo);
    const third = await rung([REPORTS.design!], first.rows, first.repo);
    assert.equal(second.outcome.outcome, "needs_design");
    assert.equal(third.outcome.outcome, "needs_design");
    assert.equal(second.issues.length + third.issues.length, 1, "one question, not one per pass");
    assert.equal(second.spawns.length + third.spawns.length, 0);
  });

  test("W1-T12714 criterion 6: every fix.needs_design row is followed in its pass by one routed row that is not a wait", async () => {
    for (const reports of [[REPORTS.environment!, REPORTS.design!], [REPORTS.commit!, REPORTS.contract!], [REPORTS.plan!], [REPORTS.design!]]) {
      const { rows } = await rung(reports);
      const done = rows.filter((row) => row.step === "fix.done" && row.fix_outcome === "NEEDS_DESIGN");
      assert.equal(routed(rows).length, done.length, "one routed row per needs-design round");
      for (const hold of holds(rows)) {
        const after = routed(rows).filter((row) => rows.indexOf(row) > rows.indexOf(hold) && row.head_sha === hold.head_sha &&
          row.kind === hold.needs_design_kind);
        assert.equal(after.length, 1, JSON.stringify(rows.map((row) => row.step)));
        assert.notEqual(after[0]!.remedy, "wait");
      }
    }
  });
});

// The sweep half: the hold it reads at one head.
const HEAD = "1806060".padEnd(40, "6");
const NOW = Date.now();
const sweepPr = (): OpenPrView => ({
  prNumber: 18060, prUrl: PR_URL, taskId: TASK, headSha: HEAD, checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  ciFailures: [{ name: "ci-shard (1/8)", logTail: "not ok 1 - criterion 3 conflicts" }],
});

function sweepRows(hold: Record<string, unknown>): Record<string, unknown>[] {
  const common = { task_id: TASK, head_sha: HEAD, run_id: "ROUTED-ROUND", host: "fixture-host", actor_pid: 777 };
  const round = { ...common, round_id: "ROUTED-ROUND:1", repair_pr_url: PR_URL };
  return [
    { ...round, step: "fix.dispatch", ts: new Date(NOW - 3000).toISOString(), mode: "ci-log" },
    { ...common, step: "fix.needs_design", ts: new Date(NOW - 2000).toISOString(), contract_revision: "contract-A",
      reason: "criterion 3 conflicts with another task's test", ...hold },
    { ...round, step: "fix.done", ts: new Date(NOW - 1000).toISOString(), fix_outcome: "NEEDS_DESIGN", subtype: "success" },
  ];
}

async function sweepOnce(rows: Record<string, unknown>[], contract = "contract-A", pr: Partial<OpenPrView> = {}) {
  const state = { escalated: 0, dispatched: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/needs-design-routing-ledger", runId: "W1-T12714-test", now: () => NOW,
    readLedger: () => rows, readHeadContractRefreshHistory: async () => ({ complete: true, lines: rows }),
    appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => ({ verdict: "continue", reason: "fixture" }),
    readTaskContractRevision: () => contract, readMainTip: async () => "a".repeat(40), behindMainByPr: new Map([[18060, 0]]),
    arm: () => {}, close: () => {},
    escalate: () => { state.escalated++; }, dispatchFix: () => { state.dispatched++; },
    claimFixAdmission: () => ({ admitted: true }),
  };
  await runSweep([{ ...sweepPr(), ...pr }], deps);
  return { state, disposed: rows.findLast((row) => row.step === "sweep.disposed" && row.pr_number === 18060)! };
}

describe("the sweep reads the routed kind at the hold", () => {
  test("W1-T12714 criterion 4: a head routed to an amendment waits on it, asks no one, and a changed contract releases it", async () => {
    const rows = sweepRows({ needs_design_kind: "contract", needs_design_remedy: "amendment-proposed" });
    const held = await sweepOnce(rows);
    assert.equal(held.disposed.disposition, "wait");
    assert.notEqual(held.disposed.blocker, "escalated");
    assert.equal(held.state.escalated, 0);
    assert.match(String(held.disposed.reason), /task contract amendment at this exact head/);
    const released = await sweepOnce(rows, "contract-B");
    assert.equal(released.disposed.disposition, "blocked-fixable");
  });

  test("W1-T12714 criterion 5: a design hold still escalates through the sweep", async () => {
    const { state, disposed } = await sweepOnce(sweepRows({ needs_design_kind: "design", needs_design_remedy: "escalate" }));
    assert.equal(disposed.disposition, "refused-escalate");
    assert.equal(state.escalated, 1);
  });

  test("an amendment wait permits conflict repair and still waits on the amendment at the pushed head", async () => {
    const rows = sweepRows({ needs_design_kind: "contract", needs_design_remedy: "amendment-proposed" });
    rows.push(
      { step: "sweep.disposed", ts: new Date(NOW - 800).toISOString(), run_id: "EARLIER-SWEEP",
        pr_number: 18060, head_sha: HEAD, disposition: "blocked-fixable", acted: true },
      { step: "fix.stood_down", ts: new Date(NOW - 700).toISOString(), run_id: "AMENDMENT-WAIT", task_id: TASK,
        head_sha: HEAD, read_head_sha: HEAD, read_contract_revision: "contract-A", site: "rung.needs_design_amendment",
        reason: "awaiting the proposed task contract amendment" },
    );
    const conflicted = await sweepOnce(rows, "contract-A", {
      headRefName: `run-${TASK}-1`,
      mergeState: "dirty", mergeConflict: { files: [{ path: "src/lib/sweep.ts", oursDeleted: 2, theirsDeleted: 59 }],
        oursLog: "needs-design routing", theirsLog: "conflict rounds under holds" },
    });
    assert.equal(conflicted.disposed.disposition, "conflicted");
    assert.equal(conflicted.state.dispatched, 1);
    assert.equal(conflicted.state.escalated, 0);
    assert.equal(conflicted.disposed.design_hold_kept, true);

    const pushedHead = "b".repeat(40);
    const round = { task_id: TASK, head_sha: HEAD, run_id: "CONFLICT-ROUND", round_id: "CONFLICT-ROUND:1",
      repair_pr_url: PR_URL, host: "fixture-host", actor_pid: 778 };
    rows.push(
      { ...round, step: "fix.dispatch", ts: new Date(NOW - 500).toISOString(), mode: "merge-conflict" },
      { ...round, step: "fix.done", ts: new Date(NOW - 100).toISOString(), fix_outcome: "FIXED",
        subtype: "success", pushed_head_sha: pushedHead },
    );
    const merged = await sweepOnce(rows, "contract-A", { headSha: pushedHead });
    assert.equal(merged.disposed.disposition, "wait");
    assert.equal(merged.disposed.hold_head_sha, HEAD);
    assert.equal(merged.state.dispatched, 0);
    assert.equal(merged.state.escalated, 0);

    const amended = await sweepOnce(rows, "contract-B", { headSha: pushedHead });
    assert.equal(amended.disposed.disposition, "blocked-fixable", "the changed contract releases the carried wait");
  });
});
