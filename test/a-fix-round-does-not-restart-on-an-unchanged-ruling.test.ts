import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { taskContractRevision } from "#src/lib/escalate.js";
import { classifyScannerBlocker, rollupForAsync } from "#src/lib/open-prs-rest.js";
import type { Task } from "#src/lib/plan.js";
import { buildBatchedGithub, readLedgerLines } from "#src/lib/status.js";
import { buildFixProgressInput, priorRoundHold, PRIOR_ROUND_HOLD_FIELD, resolveFixProgress, scopeAmendmentsWithoutMergeTime }
  from "#src/lib/fix-progress-judge.js";
import { buildFixDispatchEnvelope, buildSweepEffects, closedPrFromRef, runFixDispatchChild, runPrTerminalReconcile, runSweep,
  type OpenPrView, type SweepDeps, type BuildSweepEffectsDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T13865: 53 fix rounds ($10.56) started at a head whose last round had ruled NEEDS_SCOPE or FLAKE.
const TASK = "W1-T13865";
const HEAD = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const PR_URL = "https://github.com/o/remudero/pull/13865";
const AMENDMENT_URL = "https://github.com/o/plan/pull/900";
// The completion reader takes required checks from the PR's own base branch, read from the PR.
const PR_READ = "repos/o/remudero/pulls/13865";
type Row = Record<string, unknown>;

const round = (outcome: string, over: Row = {}): Row[] => [
  { step: "fix.dispatch", task_id: TASK, round_id: "R1", head_sha: HEAD, ts: at(60_000), mode: "ci-log",
    ci_failures: [{ check: "ci-shard (1/8)" }] },
  { step: "fix.done", task_id: TASK, round_id: "R1", head_sha: HEAD, ts: at(30_000), fix_outcome: outcome,
    subtype: "success", ...over },
];
const facts = (over: Partial<Parameters<typeof priorRoundHold>[1]> = {}) =>
  ({ taskId: TASK, headSha: HEAD, contractRevision: "contract-A", checkCompletions: [], ...over });

const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 13865, prUrl: PR_URL, taskId: TASK, headSha: HEAD, checksState: "red", reviewState: "pending",
  unmetCriteria: [], priorStrikes: 1, autoMergeArmed: false, lastActivityAt: at(0),
  ciFailures: [{ name: "ci-shard (1/8)", logTail: "not ok 1 - a flaky timeout", completedAt: at(45_000) }], ...over,
});

function fixture(rows: Row[]) {
  const state = { dispatched: 0, escalated: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/prior-round-hold", runId: "W1-T13865-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    readHeadContractRefreshHistory: async () => ({ complete: true, lines: rows }),
    fixProgressJudge: async () => ({ verdict: "continue", reason: "the red names one failing test" }),
    readTaskContractRevision: () => "contract-A",
    arm: () => {}, close: () => {},
    escalate: () => { state.escalated++; },
    dispatchFix: () => { state.dispatched++; },
  };
  return { deps, state };
}
// The no-commit gateway already reran the failed job at this head before the round, so the pass reaches the fix rung.
const rerunDone: Row = { step: "sweep.disposed", task_id: TASK, pr_number: 13865, head_sha: HEAD, ts: at(90_000),
  disposition: "wait", acted: true, no_commit_rerun_attempted: true };
const swept = (rows: Row[]): Row[] => [rerunDone, ...rows];
const lastDisposed = (rows: Row[]) => rows.findLast(row => row.step === "sweep.disposed" && row.pr_number === 13865)!;
const pendingAmendment: Row = { step: "fix.scope_amendment", task_id: TASK, head_sha: HEAD, outcome: "created",
  amendmentNumber: 900, amendment_url: AMENDMENT_URL, paths: ["src/lib/newly-admitted.ts"], ts: at(20_000) };
const mergedAmendment: Row = { step: "pr.terminal", task_id: "SWEEP", pr_number: 900, pr_url: AMENDMENT_URL, state: "merged",
  merged_at: at(10_000), ts: at(5_000) };

const HEAD_REF = `run-${TASK}-1795126095000`;
const PLAN_TASK: Task = { id: TASK, title: "repair", repo: "fixture", type: "implement", risk: "low", verify: "auto",
  status: "queued", attempts: 0, depends_on: [], files: ["src/lib/fixture.ts"], acceptance: [] };
const atNewHead = (rows: Row[]) => rows.map(row => ({ ...row, head_sha: NEW_HEAD }));
// The sweep's real dispatchFix, whose live PR head is NEW_HEAD; `ledgerRows` is the ledger file it reads.
function movedHeadEffects(t: { after: (fn: () => void) => void }, rows: Row[], ledgerRows: Row[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13865-moved-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["state/inflight", "repos/fixture", "tmp"]) mkdirSync(join(root, dir), { recursive: true });
  const ledgerPath = join(root, "state/ledger.ndjson");
  writeFileSync(ledgerPath, ledgerRows.map(row => JSON.stringify(row) + "\n").join(""));
  const rungs: string[] = [];
  const failure = { name: "ci-shard (1/8)", logTail: "failed at the moved head" };
  const effects = buildSweepEffects({ owner: "o", repo: "fixture", repoRoot: REPO_ROOT, config: { root } as Config, runId: "moved-head",
    ledgerPath, plan: { tasks: [PLAN_TASK], byId: new Map([[TASK, PLAN_TASK]]) }, ciGateRequired: [],
    log: (step, fields) => rows.push({ step, ...fields }), issuesImpl: { create: () => assert.fail("unexpected issue") },
    dispatchFixPreflightStandDownImpl: async () => undefined, registeredWorktreeOwnerImpl: () => undefined,
    createFixRungWorktreeImpl: () => undefined, captureWorktreeSnapshotImpl: () => ({ headSha: NEW_HEAD }),
    ghJsonImpl: (args: string[]) => args[0] === "pr" ? { headRefName: HEAD_REF, headRefOid: NEW_HEAD, body: "", files: [] }
      : { state: "open", head: { sha: NEW_HEAD }, mergeable_state: "clean" },
    readPackageScriptsImpl: () => ({}), readPreservedOwnerPatchImpl: () => undefined, worktreeRemoveImpl: () => {},
    fixBranchClaimKeyImpl: () => "t13865-moved-head", buildFixRungDispatchArgsImpl: ({ task }) => ({ task }),
    openTaskIdsFromPlanImpl: () => new Set([TASK]),
    resolveTaskContractAtHeadImpl: () => ({ criteria: [], taskDeclaredFiles: PLAN_TASK.files }),
    restRollupForImpl: async () => [{ name: failure.name, status: "COMPLETED", conclusion: "FAILURE" }],
    readRequiredContextsImpl: () => [failure.name], fetchCiFailuresImpl: () => [failure],
    readJsonImpl: async () => [],
    runFixRungImpl: (args: { task: Task }) => { rungs.push(args.task.id); return { outcome: "stood_down" }; },
  } as Partial<BuildSweepEffectsDeps> as BuildSweepEffectsDeps);
  return { dispatchFix: effects.dispatchFix!, rungs };
}
const deferredAtHold = (rows: Row[]) => rows.filter(row => row.step === "sweep.fix.head_moved_deferred")
  .map(row => [row.to_head, row.reason, row[PRIOR_ROUND_HOLD_FIELD]]);

function grantedScopeRound() {
  const task_id = "PR-13865";
  const roundRows = round("NEEDS_SCOPE", { contract_revision: "contract-A" }).map(row => ({ ...row, task_id, pr_number: 13865 }));
  const scopeQuestion = { step: "fix.scope_amendment", task_id, pr_number: 13865, head_sha: HEAD, round_id: "R1",
    outcome: "unfiled-escalated", issue_url: "https://github.com/o/remudero/issues/901", paths: ["src/lib/fixture.ts"], ts: at(35_000) };
  const grant = { step: "panel.question_answered", task_id, answer: "revise-pr", authority: "repository-owner",
    bare_option: true, origin: "issue#901:comment:9", ts: at(10_000) };
  return { rows: swept([roundRows[0]!, scopeQuestion, roundRows[1]!]), grant };
}

describe("test/a-fix-round-does-not-restart-on-an-unchanged-ruling.test.ts", () => {
  test("W1-T13865 criterion 1: a NEEDS_SCOPE round holds its head while no amendment merged and the contract is unchanged", () => {
    const rows = round("NEEDS_SCOPE", { contract_revision: "contract-A" });
    const hold = priorRoundHold(rows, facts());
    assert.equal(hold?.hold, "NEEDS_SCOPE");
    assert.equal(hold?.since, at(30_000));
    assert.equal(hold?.contractRevision, "contract-A");
    const pending = [...rows, pendingAmendment];
    assert.equal(priorRoundHold(pending, facts())?.hold, "NEEDS_SCOPE", "a pending amendment has not merged");
    const foreignMerge = { ...mergedAmendment, pr_url: "https://github.com/o/remudero/pull/900" };
    assert.equal(priorRoundHold([...pending, foreignMerge], facts())?.hold, "NEEDS_SCOPE",
      "another repository's PR with the same number cannot answer this scope request");
    const reconciled = [...pending, { ...mergedAmendment, merged_at: at(80_000) }];
    assert.equal(priorRoundHold(reconciled, facts())?.hold, "NEEDS_SCOPE", "a late receipt cannot move the actual merge past the round");
    const adopted = { step: "fix.scope_amendment", task_id: TASK, outcome: "amendment_merged", amendment_number: 900, ts: at(3_000) };
    assert.equal(priorRoundHold([...reconciled, adopted], facts())?.hold, "NEEDS_SCOPE",
      "a late local adoption of the known amendment doesn't change when it merged");
    const latched = [...rows, { step: "sweep.disposed", task_id: TASK, pr_number: 13865, head_sha: HEAD,
      [PRIOR_ROUND_HOLD_FIELD]: "NEEDS_SCOPE", prior_round_hold_since: at(30_000), prior_round_hold_contract_revision: "contract-A" }];
    assert.equal(priorRoundHold(latched, facts())?.hold, "NEEDS_SCOPE");
  });

  test("W1-T13865 criterion 2: a FLAKE round holds its head while no required check has completed since it ended", () => {
    const rows = round("FLAKE");
    const hold = priorRoundHold(rows, facts({ checkCompletions: [{ name: "ci-shard (1/8)", completedAt: at(45_000) }] }));
    assert.equal(hold?.hold, "FLAKE");
    assert.equal(hold?.since, at(30_000));
    assert.equal(priorRoundHold(rows, facts({ checkCompletions: [{ name: "ci-shard (1/8)" }] }))?.hold, "FLAKE",
      "a check with no completion time has not completed");
    for (const flake_claim of ["requeue_deferred", "refuted", "confirmed"]) {
      assert.equal(priorRoundHold(round("FLAKE", { flake_claim }), facts())?.hold, "FLAKE", flake_claim);
    }
  });

  test("W1-T13865 criterion 3: a new head, a new red, a merged amendment, a changed contract or another ruling holds nothing", () => {
    assert.equal(priorRoundHold(round("FLAKE"), facts({ headSha: NEW_HEAD })), undefined);
    assert.equal(priorRoundHold(round("NEEDS_SCOPE"), facts({ headSha: NEW_HEAD })), undefined);
    assert.equal(priorRoundHold(round("FLAKE"), facts({ checkCompletions: [{ name: "ci-shard (1/8)", completedAt: at(10_000) }] })),
      undefined, "a check completed red after the FLAKE round");
    const merged = [...round("NEEDS_SCOPE"), pendingAmendment, mergedAmendment];
    assert.equal(priorRoundHold(merged, facts()), undefined, "a merged scope amendment after the NEEDS_SCOPE round");
    const direct = { step: "fix.scope_amendment", task_id: TASK, outcome: "amendment_merged", amendment_number: 901,
      merged_at: at(10_000), ts: at(10_000) };
    assert.equal(priorRoundHold([...round("NEEDS_SCOPE"), direct], facts()), undefined, "the scope receipt records the merge itself");
    assert.equal(priorRoundHold([...round("NEEDS_SCOPE"), { ...direct, task_id: "W1-T1" }], facts())?.hold, "NEEDS_SCOPE");
    const mergedBefore = [{ ...pendingAmendment, ts: at(90_000) },
      { ...mergedAmendment, merged_at: at(85_000), ts: at(80_000) }, ...round("NEEDS_SCOPE")];
    assert.equal(priorRoundHold(mergedBefore, facts())?.hold, "NEEDS_SCOPE", "an amendment merged before the round answered nothing");
    const latched = [...round("NEEDS_SCOPE"), { step: "sweep.disposed", task_id: TASK, pr_number: 13865, head_sha: HEAD,
      [PRIOR_ROUND_HOLD_FIELD]: "NEEDS_SCOPE", prior_round_hold_since: at(30_000), prior_round_hold_contract_revision: "contract-A" }];
    assert.equal(priorRoundHold(latched, facts({ contractRevision: "contract-B" })), undefined, "a changed contract");
    assert.equal(priorRoundHold(round("NEEDS_SCOPE", { contract_revision: "contract-A" }), facts({ contractRevision: "contract-B" })),
      undefined, "the contract changed before the first sweep");
    for (const outcome of ["FIXED", "NOT_LANDED", "NEEDS_DESIGN"]) {
      assert.equal(priorRoundHold(round(outcome), facts()), undefined, outcome);
    }
    assert.equal(priorRoundHold([...round("FLAKE"), ...round("FIXED").slice(1).map(r => ({ ...r, round_id: "R2", ts: at(1_000) }))],
      facts()), undefined, "the newest round at the head decides");
  });

  test("W1-T13865 criterion 3: a sweep round releases when main takes the revision already at the PR head", async t => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13865-round-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of ["state/inflight", "repos/fixture", "tmp"]) mkdirSync(join(root, dir), { recursive: true });
    const task: Task = { id: TASK, title: "repair", repo: "fixture", type: "implement", risk: "low", verify: "auto",
      status: "queued", attempts: 0, depends_on: [], files: ["src/lib/fixture.ts"], acceptance: [] };
    const headTask = { ...task, files: [...task.files!, "src/lib/newly-admitted.ts"] };
    const rows = swept([]);
    const headRefName = `run-${TASK}-1795126095000`;
    const fixtureDeps: Partial<BuildSweepEffectsDeps> = {
      dispatchFixPreflightStandDownImpl: async () => undefined, registeredWorktreeOwnerImpl: () => undefined,
      createFixRungWorktreeImpl: () => undefined, captureWorktreeSnapshotImpl: () => ({ headSha: HEAD }),
      ghJsonImpl: () => ({ headRefName, headRefOid: HEAD, body: "", files: [] }),
      readPackageScriptsImpl: () => ({}), readPreservedOwnerPatchImpl: () => undefined, worktreeRemoveImpl: () => {},
      fixBranchClaimKeyImpl: () => "fixture-fix-branch", buildFixRungDispatchArgsImpl: ({ task }) => ({ task }),
      openTaskIdsFromPlanImpl: () => new Set([TASK]),
      resolveTaskContractAtHeadImpl: () => ({ criteria: [], taskDeclaredFiles: headTask.files }),
      runFixRungImpl: (args: { task: Task; deps: { log: (step: string, fields: Row) => void } }) => {
        assert.deepEqual(args.task.files, headTask.files);
        args.deps.log("fix.dispatch", round("NEEDS_SCOPE")[0]!);
        args.deps.log("fix.done", round("NEEDS_SCOPE")[1]!);
        return { outcome: "stood_down" };
      },
    };
    const effects = buildSweepEffects({ owner: "o", repo: "fixture", repoRoot: REPO_ROOT, config: { root } as Config, runId: "scope-round",
      ledgerPath: join(root, "state/ledger.ndjson"), plan: { tasks: [task], byId: new Map([[TASK, task]]) }, ciGateRequired: [],
      log: (step, fields) => rows.push({ step, ...fields }), issuesImpl: { create: () => assert.fail("unexpected issue") }, ...fixtureDeps });
    await effects.dispatchFix!(pr({ headRefName }), { unmetCriteria: [], ciFailures: pr().ciFailures });
    const f = fixture(rows);
    f.deps.readTaskContractRevision = effects.readTaskContractRevision;
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "unchanged main holds even when the worker read a different contract at the PR head");
    assert.equal(lastDisposed(rows).prior_round_hold_contract_revision, taskContractRevision(task));
    assert.match(String(lastDisposed(rows).stand_down_reason), /ruled NEEDS_SCOPE/);
    assert.equal(rows.find(row => row.step === "fix.done")?.contract_revision, taskContractRevision(task));

    f.deps.readTaskContractRevision = () => taskContractRevision(headTask);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "changing main to the PR-head revision releases the hold");
  });

  test("W1-T13865 criterion 3: the terminal fallback preserves the amendment's actual merge time", t => {
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13865-terminal-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const github = buildBatchedGithub("o", "plan", { fetchAll: () => [
      { number: 900, url: AMENDMENT_URL, state: "MERGED", mergedAt: at(10_000) },
    ] });
    const ledgerPath = join(root, "ledger.ndjson");
    const rows = [...round("NEEDS_SCOPE"), pendingAmendment,
      { step: "pr.opened", pr_url: AMENDMENT_URL, ts: at(20_000) }];
    writeFileSync(ledgerPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const result = runPrTerminalReconcile(url => closedPrFromRef(github.prByRef(url)), { ledgerPath, runId: "terminal-fallback" });
    assert.equal(result.appended, 1);
    const reconciled = readLedgerLines(ledgerPath);
    assert.equal(reconciled.find(row => row.step === "pr.terminal")?.merged_at, at(10_000));
    assert.equal(priorRoundHold(reconciled, facts()), undefined);
  });

  test("W1-T13865 criterion 3: an in-run fix uses its own progress receipt's contract revision", async () => {
    const input = buildFixProgressInput({ taskId: TASK, headSha: HEAD, currentRed: ["ci"], ledger: [] });
    const { receipt } = await resolveFixProgress(input, [], { firstRound: true, contractRevision: "contract-A" });
    const runId = "initial-task-run";
    const rows = [{ ...receipt, run_id: runId, task_id: TASK, head_sha: HEAD, site: "fix-strike", ts: at(80_000) },
      ...round("NEEDS_SCOPE", { run_id: runId })];
    assert.equal(priorRoundHold(rows, facts())?.hold, "NEEDS_SCOPE");
    assert.equal(priorRoundHold(rows, facts({ contractRevision: "contract-B" })), undefined);
  });

  test("W1-T13865 criterion 4: the sweep stands the fix rung down on the hold and spawns no fix worker", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "no second fix worker at the same head after a FLAKE round");
    const disposed = lastDisposed(rows);
    assert.equal(disposed.acted, false);
    assert.equal(disposed[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
    assert.match(String(disposed.stand_down_reason), /ruled FLAKE .* no required check has completed on this head since/);

    f.deps.readRequiredCheckCompletions = async () => [{ name: "ci", completedAt: at(1_000) }];
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "a check completed after the round releases the hold");

    const scope = swept(round("NEEDS_SCOPE"));
    const s = fixture(scope);
    await runSweep([pr()], s.deps);
    assert.equal(s.state.dispatched, 0);
    assert.equal(lastDisposed(scope)[PRIOR_ROUND_HOLD_FIELD], "NEEDS_SCOPE");
    assert.equal(lastDisposed(scope).prior_round_hold_contract_revision, "contract-A");
    await runSweep([pr({ headSha: NEW_HEAD })], s.deps);
    assert.equal(s.state.dispatched, 1, "a new head starts a round");
  });

  test("W1-T13865 criterion 4: a CodeQL blocker cannot bypass the prior round hold", async () => {
    const mergeCommitSha = "d".repeat(40);
    const merge = { mergeable: true, mergeableState: "blocked", state: "clean" as const, mergeCommitSha, headSha: HEAD };
    const scannerBlocker = classifyScannerBlocker({ number: 13865, headSha: HEAD, merge }, [{
      number: 42, rule: { id: "js/file-system-race" }, tool: { name: "CodeQL" }, most_recent_instance: {
        ref: "refs/pull/13865/merge", commit_sha: mergeCommitSha, location: { path: "src/lib/state.ts", start_line: 8 },
      },
    }], [{ body: "[Show details](https://github.com/o/remudero/security/code-scanning/42)",
      user: { login: "github-advanced-security[bot]", type: "Bot" } }]);
    const candidate = pr({ scannerBlocker, autoMergeArmed: true, checksState: "green", reviewState: "success", ciFailures: [],
      headRefName: `run-${TASK}-1795126095000`, mergeState: "clean", mergeable: true, mergeableState: "blocked" });
    const rows = swept(round("NEEDS_SCOPE", { contract_revision: "contract-A" }));
    const f = fixture(rows);
    await runSweep([candidate], f.deps);
    assert.equal(f.state.dispatched, 0);
    assert.equal(lastDisposed(rows).acted, false);
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "NEEDS_SCOPE");
    assert.match(String(lastDisposed(rows).stand_down_reason), /ruled NEEDS_SCOPE/);
    f.deps.readTaskContractRevision = () => "contract-B";
    await runSweep([candidate], f.deps);
    assert.equal(f.state.dispatched, 1, "the same CodeQL blocker dispatches after a contract change");
  });

  test("W1-T13865 criterion 4: a pending scope amendment keeps the prior-round reason and spawns no fix worker", async () => {
    const rows = swept([...round("NEEDS_SCOPE", { contract_revision: "contract-A" }), pendingAmendment]);
    const f = fixture(rows);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0);
    assert.equal(lastDisposed(rows).acted, false);
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "NEEDS_SCOPE");
    assert.match(String(lastDisposed(rows).stand_down_reason), /ruled NEEDS_SCOPE .*no scope amendment has merged/);
    rows.push(mergedAmendment);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "the amendment's own merge releases the hold");
  });

  test("W1-T13865 criterion 4: a pending scope amendment still refreshes the branch when main's contract changes", async () => {
    const rows = swept([...round("NEEDS_SCOPE", { contract_revision: "contract-A" }), pendingAmendment]);
    const f = fixture(rows);
    let revision = "contract-A";
    const refreshed: string[] = [];
    f.deps.readTaskContractRevision = () => revision;
    f.deps.updateBranch = candidate => { refreshed.push(candidate.headSha); return "updated"; };
    await runSweep([pr()], f.deps);
    assert.deepEqual(refreshed, []);
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "NEEDS_SCOPE");
    const held = lastDisposed(rows);

    revision = "contract-B";
    await runSweep([pr()], f.deps);
    assert.deepEqual(refreshed, [HEAD]);
    assert.equal(held.progress_contract_revision, "contract-A");
    assert.equal(lastDisposed(rows).progress_contract_revision, "contract-B");
    assert.equal(f.state.dispatched, 0, "the refresh runs while the amendment is still pending");
  });

  test("W1-T13865 criterion 2: only the branch-protected App's check completion releases FLAKE", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    let completedAt = at(45_000);
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root: "/unused/prior-round-hold" } as Config,
      ledgerPath: f.deps.ledgerPath, runId: f.deps.runId, plan: { tasks: [], byId: new Map() }, log: () => {},
      ciGateRequired: ["ci", "ci-gate"], restRollupForImpl: rollupForAsync,
      readJsonImpl: async (args) => {
        const endpoint = args[1] ?? "";
        if (endpoint === PR_READ) return { base: { ref: "main" } };
        if (endpoint.endsWith("/protection/required_status_checks")) return {
          contexts: ["ci-gate"], checks: [{ context: "ci-gate", app_id: 15368 }],
        };
        if (endpoint.includes(`/commits/${HEAD}/check-runs`)) {
          const page = { check_runs: [
            { name: "ci", status: "completed", conclusion: "failure", completed_at: at(45_000) },
            { name: "ci-gate", status: "completed", conclusion: "failure", completed_at: completedAt, app: { id: 15368 } },
            { name: "ci-gate", status: "completed", conclusion: "success", completed_at: at(1_000), app: { id: 42 } },
          ] };
          return args.includes("--slurp") ? [page] : page;
        }
        if (endpoint.includes(`/commits/${HEAD}/statuses?`)) return [[
          { context: "ci-gate", state: "success", updated_at: at(1_000) },
        ]];
        assert.fail(`unexpected check read ${endpoint}`);
      },
    });
    f.deps.readRequiredCheckCompletions = effects.readRequiredCheckCompletions;
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "a fresh completion from another App or a name-only status does not release the hold");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
    assert.match(String(lastDisposed(rows).stand_down_reason), /ruled FLAKE/);

    completedAt = at(1_000);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "a fresh failure from the pinned App releases the hold");
  });

  test("W1-T13865 criterion 2: a commit status cannot satisfy a ci-gate requirement", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    let completedAt = at(45_000);
    let readError: Error | undefined;
    const errors: unknown[] = [];
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root: "/unused/prior-round-hold" } as Config,
      ledgerPath: f.deps.ledgerPath, runId: f.deps.runId, plan: { tasks: [], byId: new Map() },
      log: (step, fields) => { if (step === "sweep.ci_gate_rollup.error") errors.push(fields?.error); },
      ciGateRequired: ["ci", "lint-plan"], issuesImpl: { create: () => assert.fail("unexpected issue") },
      restRollupForImpl: rollupForAsync,
      readJsonImpl: async (args) => {
        const endpoint = args[1] ?? "";
        if (endpoint === PR_READ) return { base: { ref: "main" } };
        if (endpoint.endsWith("/protection/required_status_checks")) return { contexts: ["ci-gate"] };
        if (endpoint.includes(`/commits/${HEAD}/check-runs`)) {
          if (readError !== undefined) throw readError;
          const page = { check_runs: [
            { name: "ci", status: "completed", conclusion: "failure", completed_at: at(45_000) },
            { name: "lint-plan", status: "completed", conclusion: "success", completed_at: completedAt },
            { name: "advisory", status: "completed", conclusion: "failure", completed_at: at(1_000) },
          ] };
          return args.includes("--slurp") ? [page] : page;
        }
        if (endpoint.includes(`/commits/${HEAD}/statuses?`)) return [[
          { context: "lint-plan", state: "success", updated_at: at(1_000) },
        ]];
        assert.fail(`unexpected check read ${endpoint}`);
      },
    });
    const deps = { ...f.deps, readRequiredCheckCompletions: effects.readRequiredCheckCompletions };
    const candidate = pr({ ciFailures: [{ name: "advisory", logTail: "optional failure", completedAt: at(1_000) }, ...pr().ciFailures!] });
    await runSweep([candidate], deps);
    assert.equal(f.state.dispatched, 0, "a fresh optional failure and a same-name commit status do not release the hold");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
    completedAt = at(1_000);
    readError = new Error("check-runs page unavailable");
    await runSweep([candidate], deps);
    assert.deepEqual(errors, [String(readError)]);
    assert.equal(f.state.dispatched, 0);
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
    readError = undefined;
    await runSweep([candidate], deps);
    assert.equal(f.state.dispatched, 1, "a fresh green required check releases the hold even while another stays red");
  });

  test("W1-T13865 criterion 3: a new red on a later check-runs page releases FLAKE", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    const first = { check_runs: Array.from({ length: 100 }, (_, i) => ({
      name: `optional-${i}`, status: "completed", conclusion: "success", completed_at: at(1_000),
    })) };
    const second = { check_runs: [{ name: "lint-plan", status: "completed", conclusion: "failure", completed_at: at(30_000) }] };
    let requests: string[][] = [];
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root: "/unused/prior-round-hold" } as Config,
      ledgerPath: f.deps.ledgerPath, runId: f.deps.runId, plan: { tasks: [], byId: new Map() }, log: () => {},
      ciGateRequired: ["lint-plan"], restRollupForImpl: rollupForAsync,
      readJsonImpl: async (args) => {
        const endpoint = args[1] ?? "";
        if (endpoint === PR_READ) return { base: { ref: "main" } };
        if (endpoint.endsWith("/protection/required_status_checks")) return { contexts: ["ci-gate"] };
        if (endpoint.includes(`/commits/${HEAD}/statuses?`)) return [[]];
        assert.match(endpoint, new RegExp(`/commits/${HEAD}/check-runs\\?`));
        requests.push(args);
        return args.includes("--paginate") && args.includes("--slurp") ? [first, second] : first;
      },
    });
    f.deps.readRequiredCheckCompletions = effects.readRequiredCheckCompletions;
    await runSweep([pr()], f.deps);
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "FLAKE", "a completion at the round time is not newer");
    assert.equal(f.state.dispatched, 0);
    second.check_runs[0]!.completed_at = at(1_000);
    requests = [];
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "the required failed check on page two releases the hold");
    assert.equal(requests.length, 1);
    assert.match(requests[0]![1]!, /[?&]filter=all\b/);
  });

  test("W1-T13865 criterion 3: a fresh ci-gate required failure releases FLAKE when branch protection is unreadable", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    let completedAt = at(45_000);
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root: "/unused/prior-round-hold" } as Config,
      ledgerPath: f.deps.ledgerPath, runId: f.deps.runId, plan: { tasks: [], byId: new Map() }, log: () => {},
      ciGateRequired: ["lint-plan"],
      readJsonImpl: async (args) => {
        const endpoint = args[1] ?? "";
        if (endpoint === PR_READ) return { base: { ref: "main" } };
        if (endpoint.endsWith("/protection/required_status_checks")) throw new Error("branch protection unavailable");
        assert.match(endpoint, new RegExp(`/commits/${HEAD}/check-runs\\?`));
        return [{ check_runs: [
          { name: "unlisted", status: "completed", conclusion: "failure", completed_at: at(1_000) },
          { name: "lint-plan", status: "completed", conclusion: "failure", completed_at: completedAt },
        ] }];
      },
    });
    f.deps.readRequiredCheckCompletions = effects.readRequiredCheckCompletions;
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "a fresh completion whose requirement is unknown keeps the hold");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
    completedAt = at(1_000);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "the failed lint-plan check is known to be required through ci-gate");
  });

  test("W1-T13865 criterion 4: a FLAKE hold allows the first retry of a cancelled required check", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    const name = "coverage-ratchet";
    const retried: string[] = [];
    f.deps.requeueCheck = (_pr, check) => { retried.push(String(check.jobId)); return true; };
    await runSweep([pr({ ciFailures: [{ name, logTail: "" }], cancelledRequiredChecks: [{ name, jobId: "80", runAttempt: 1 }] })], f.deps);
    assert.deepEqual(retried, ["80"]);
    assert.equal(f.state.dispatched, 0);
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
    assert.match(String(lastDisposed(rows).stand_down_reason), /ruled FLAKE/);
  });

  test("W1-T13865 criterion 4: a FLAKE hold allows the deferred job retry to produce a new completion", async () => {
    const name = "ci-shard (1/8)";
    const rows = swept([...round("FLAKE", { flake_claim: "requeue_deferred" }),
      { step: "sweep.check_requeue.deferred", task_id: TASK, pr_number: 13865, head_sha: HEAD, check_name: name,
        job_id: "70", refusal: "already_running", outcome: "deferred", ts: at(31_000) }]);
    const f = fixture(rows);
    const retried: string[] = [];
    let retryCompletedAt = at(45_000);
    let runInFlight = true;
    f.deps.readRequiredCheckCompletions = async () => [{ name, completedAt: retryCompletedAt }];
    f.deps.readCiGateRollup = () => [{ name, status: "COMPLETED", conclusion: "FAILURE", jobId: "80", workflowRunId: 900 },
      { name: "ci-shard (2/8)", status: "COMPLETED", conclusion: "FAILURE", jobId: "81" },
      { name: "sibling", status: runInFlight ? "IN_PROGRESS" : "COMPLETED", workflowRunId: 900 }];
    f.deps.requeueCheck = (_pr, check) => { retried.push(String(check.jobId)); return true; };
    const candidate = pr({ ciFailures: [...pr().ciFailures!, { name: "ci-shard (2/8)", logTail: "another red" }] });
    await runSweep([pr()], f.deps);
    assert.deepEqual(retried, [], "the existing retry still waits for its workflow run");
    assert.equal(f.state.dispatched, 0);
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
    assert.match(String(lastDisposed(rows).stand_down_reason), /its run is still in flight/);
    runInFlight = false;
    await runSweep([candidate], f.deps);
    assert.deepEqual(retried, ["80"], "the retry targets the current job before a new round can start");
    assert.equal(f.state.dispatched, 0, "a sibling red cannot start a worker while the retry is pending");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
    assert.match(String(lastDisposed(rows).stand_down_reason), /ruled FLAKE/);
    retryCompletedAt = at(1_000);
    await runSweep([candidate], f.deps);
    assert.deepEqual(retried, ["80"], "the completed retry isn't sent again");
    assert.equal(f.state.dispatched, 1, "the retried job completed red, releasing the hold");
  });

  test("W1-T13865 criterion 1: an unfiled owner grant alone keeps the same-head NEEDS_SCOPE ruling recorded", () => {
    const { rows, grant } = grantedScopeRound();
    assert.equal(priorRoundHold(rows, facts({ taskId: "PR-13865" }))?.hold, "NEEDS_SCOPE");
    rows.push(grant);
    assert.equal(priorRoundHold(rows, facts({ taskId: "PR-13865" }))?.hold, "NEEDS_SCOPE",
      "the grant is neither a merged amendment nor a changed contract");
  });

  test("W1-T13865 criterion 4: an owner revise-pr grant still reaches the granted round at the same head", async () => {
    const { rows, grant } = grantedScopeRound();
    const f = fixture(rows);
    const candidate = pr({ taskId: "unfiled" });
    rows.push({ ...grant, origin: "issue#900:comment:9" });
    await runSweep([candidate], f.deps);
    assert.equal(f.state.dispatched, 0, "a reply on another issue grants nothing");
    assert.match(String(lastDisposed(rows).stand_down_reason), /unfiled scope decision awaits resolution/);
    rows.push(grant);
    await runSweep([candidate], f.deps);
    assert.equal(f.state.dispatched, 1, "the owner's grant authorizes the round the NEEDS_SCOPE ruling asked for");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], undefined);
  });

  test("W1-T13865 criterion 4: the existing NEEDS_DESIGN hold is unchanged", async () => {
    const common = { task_id: TASK, head_sha: HEAD, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
    const designRound = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: PR_URL };
    const rows: Row[] = [rerunDone,
      { ...designRound, step: "fix.dispatch", ts: at(60_000), mode: "ci-log" },
      { ...common, step: "fix.needs_design", ts: at(40_000), contract_revision: "contract-A",
        reason: "authoritative fix for this red lives on main, not in this diff" },
      { ...designRound, step: "fix.done", ts: at(30_000), fix_outcome: "NEEDS_DESIGN", subtype: "success" }];
    const f = fixture(rows);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0);
    const disposed = lastDisposed(rows);
    assert.equal(disposed.needs_design_hold, true);
    assert.equal(disposed[PRIOR_ROUND_HOLD_FIELD], undefined);
    assert.doesNotMatch(String(disposed.stand_down_reason ?? ""), /ruled (FLAKE|NEEDS_SCOPE)/);
  });

  test("W1-T13865 criterion 3: a required commit status completed red after a FLAKE round releases the hold", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    const status = (context: string, state: string, ts: string) => ({ context, state, created_at: ts, updated_at: ts });
    let statuses = [status("remudero-review", "failure", at(45_000))];
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root: "/unused/prior-round-hold" } as Config,
      ledgerPath: f.deps.ledgerPath, runId: f.deps.runId, plan: { tasks: [], byId: new Map() }, log: () => {},
      ciGateRequired: ["ci"], restRollupForImpl: rollupForAsync,
      readJsonImpl: async (args) => {
        const endpoint = args[1] ?? "";
        if (endpoint === PR_READ) return { base: { ref: "main" } };
        if (endpoint.endsWith("/protection/required_status_checks")) return {
          contexts: ["remudero-review", "ci-gate", "security-merge-policy"],
          checks: [{ context: "remudero-review", app_id: null }, { context: "ci-gate", app_id: 15368 },
            { context: "security-merge-policy", app_id: 15368 }],
        };
        if (endpoint.includes(`/commits/${HEAD}/check-runs`)) return [{ check_runs: [
          { name: "ci", status: "completed", conclusion: "failure", completed_at: at(45_000) }] }];
        if (endpoint.includes(`/commits/${HEAD}/statuses?`)) return [statuses];
        assert.fail(`unexpected check read ${endpoint}`);
      },
    });
    f.deps.readRequiredCheckCompletions = effects.readRequiredCheckCompletions;
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "a status posted before the round is not newer");
    statuses = [status("remudero-review", "pending", at(1_000)), status("security-merge-policy", "error", at(1_000)), ...statuses];
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "a pending status, or a status for an App-pinned requirement, does not release the hold");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
    statuses = [status("remudero-review", "failure", at(1_000)), ...statuses];
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "a fresh red remudero-review status releases the hold");
  });

  test("W1-T13865 criterion 1: a late merged receipt without merged_at dates no merge after the round", () => {
    const { merged_at: _unrecorded, ...receipt } = mergedAmendment;
    const scopeRound = round("NEEDS_SCOPE", { contract_revision: "contract-A" });
    const lateReceipt = [...scopeRound, pendingAmendment, receipt];
    assert.equal(priorRoundHold(lateReceipt, facts())?.hold, "NEEDS_SCOPE", "the receipt's ts is not when the amendment merged");
    const live = (mergedAt: string | null) => facts({ amendmentMergedAt: new Map([["o/plan#900", mergedAt]]) });
    assert.equal(priorRoundHold(lateReceipt, live(at(80_000)))?.hold, "NEEDS_SCOPE", "it merged before the round");
    assert.equal(priorRoundHold(lateReceipt, live(null))?.hold, "NEEDS_SCOPE", "it has not merged");
    assert.equal(priorRoundHold(lateReceipt, live(at(10_000))), undefined, "it merged after the round");
    assert.equal(priorRoundHold([...lateReceipt, { ...mergedAmendment, merged_at: at(80_000) }], live(at(10_000)))?.hold,
      "NEEDS_SCOPE", "a recorded merged_at is the merge time");
  });

  test("W1-T13865 criterion 3: an amendment no pr_url row names releases NEEDS_SCOPE by its live merge time", async t => {
    // Filed by an earlier round at another head, so this head's own pending-amendment wait does not apply.
    const earlierAmendment = { ...pendingAmendment, head_sha: "a".repeat(40), ts: at(70_000) };
    const rows = swept([earlierAmendment, ...round("NEEDS_SCOPE", { contract_revision: "contract-A" })]);
    assert.deepEqual(scopeAmendmentsWithoutMergeTime(rows, TASK), [AMENDMENT_URL]);
    const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13865-live-merge-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, rows.map(row => JSON.stringify(row) + "\n").join(""));
    const reconciled = runPrTerminalReconcile(() => assert.fail("reconciliation discovers no amendment URL"),
      { ledgerPath, runId: "terminal-unnamed" });
    assert.equal(reconciled.appended, 0, "no pr_url row names the amendment, so no pr.terminal is ever written");

    let mergedAt: string | null = null;
    const reads: string[] = [];
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root } as Config,
      ledgerPath, runId: "live-merge", plan: { tasks: [], byId: new Map() }, log: () => {}, ciGateRequired: [],
      readJsonImpl: async (args) => {
        reads.push(args[1] ?? "");
        if (args[1] === "repos/o/plan/pulls/900") return { number: 900, merged_at: mergedAt };
        assert.fail(`unexpected read ${args[1]}`);
      },
    });
    const f = fixture(rows);
    f.deps.readAmendmentMergedAt = effects.readAmendmentMergedAt;
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "the amendment is still open");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "NEEDS_SCOPE");
    mergedAt = at(80_000);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "the amendment merged before the round");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "NEEDS_SCOPE");
    mergedAt = at(10_000);
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "the amendment merged after the round");
    assert.deepEqual([...new Set(reads)], ["repos/o/plan/pulls/900"]);
  });

  test("W1-T13865 criterion 3: an unreadable amendment or status App releases nothing", async () => {
    const logged: string[] = [];
    const status = (login: string) => ({ context: "remudero-review", state: "failure", created_at: at(1_000), creator: { login } });
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root: "/unused/prior-round-hold" } as Config,
      ledgerPath: "/unused/prior-round-hold", runId: "unreadable", plan: { tasks: [], byId: new Map() },
      log: (step, fields) => { logged.push(`${step}:${String(fields?.read ?? fields?.amendment_url ?? "")}`); },
      ciGateRequired: [], restRollupForImpl: rollupForAsync,
      readJsonImpl: async (args) => {
        const endpoint = args[1] ?? "";
        if (endpoint === PR_READ) return { base: { ref: "main" } };
        if (endpoint === "repos/o/plan/pulls/901") throw new Error("HTTP 502");
        if (endpoint === "repos/o/plan/pulls/902") return {};
        if (endpoint.endsWith("/protection/required_status_checks")) return {
          contexts: ["remudero-review"], checks: [{ context: "remudero-review", app_id: 2001 }],
        };
        if (endpoint.includes(`/commits/${HEAD}/check-runs`)) return [{ check_runs: [
          { name: "lint", status: "completed", completed_at: at(1_000), app: { id: 2001, slug: "remudero-fleet" } }] }];
        if (endpoint.includes(`/commits/${HEAD}/statuses?`)) {
          return [[status("octocat"), status("broken-app[bot]"), status("remudero-fleet[bot]")]];
        }
        if (endpoint === "apps/broken-app") throw new Error("HTTP 404");
        assert.fail(`unexpected read ${endpoint}`);
      },
    });
    assert.equal(await effects.readAmendmentMergedAt!("not a pull request url"), undefined);
    assert.equal(await effects.readAmendmentMergedAt!("https://github.com/o/plan/pull/901"), undefined);
    assert.equal(await effects.readAmendmentMergedAt!("https://github.com/o/plan/pull/902"), undefined);
    assert.deepEqual(await effects.readRequiredCheckCompletions!(pr()), [{ name: "remudero-review", completedAt: at(1_000) }],
      "only the status whose bot is the pinned App, known from its own check run, counts");
    assert.deepEqual(logged, ["sweep.prior_round_hold.amendment_unreadable:https://github.com/o/plan/pull/901",
      "sweep.ci_gate_rollup.error:status-app"]);
  });

  test("W1-T13865 criterion 3: a red status from the App branch protection pins releases FLAKE", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    const status = (login: string, ts: string) => ({ context: "remudero-review", state: "failure", created_at: ts, updated_at: ts,
      creator: { login, type: "Bot" } });
    let statuses = [status("someone-else[bot]", at(1_000)), status("remudero-fleet[bot]", at(45_000))];
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root: "/unused/prior-round-hold" } as Config,
      ledgerPath: f.deps.ledgerPath, runId: f.deps.runId, plan: { tasks: [], byId: new Map() }, log: () => {},
      ciGateRequired: ["ci"], restRollupForImpl: rollupForAsync,
      readJsonImpl: async (args) => {
        const endpoint = args[1] ?? "";
        if (endpoint === PR_READ) return { base: { ref: "main" } };
        if (endpoint.endsWith("/protection/required_status_checks")) return {
          contexts: ["remudero-review"], checks: [{ context: "remudero-review", app_id: 2001 }],
        };
        if (endpoint.includes(`/commits/${HEAD}/check-runs`)) return [{ check_runs: [
          { name: "ci", status: "completed", conclusion: "failure", completed_at: at(45_000), app: { id: 15368, slug: "github-actions" } }] }];
        if (endpoint.includes(`/commits/${HEAD}/statuses?`)) return [statuses];
        if (endpoint === "apps/remudero-fleet") return { id: 2001, slug: "remudero-fleet" };
        if (endpoint === "apps/someone-else") return { id: 9, slug: "someone-else" };
        assert.fail(`unexpected check read ${endpoint}`);
      },
    });
    f.deps.readRequiredCheckCompletions = effects.readRequiredCheckCompletions;
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "another App's fresh status, or the pinned App's status from before the round, releases nothing");
    statuses = [status("remudero-fleet[bot]", at(1_000)), ...statuses];
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "the pinned App's fresh red status releases the hold");
  });

  test("W1-T13865 criterion 4: a sweep that adopts a moved head stands down on that head's hold", async t => {
    const rows = swept([]);
    const moved = movedHeadEffects(t, rows, atNewHead(round("FLAKE")));
    const f = fixture(rows);
    f.deps.dispatchFix = moved.dispatchFix;
    await runSweep([pr({ headRefName: HEAD_REF })], f.deps);
    assert.deepEqual(moved.rungs, [], "no fix worker at the adopted head");
    assert.deepEqual(deferredAtHold(rows), [[NEW_HEAD, "prior_round_hold", "FLAKE"]]);
    assert.match(String(lastDisposed(rows).stand_down_reason), /no fix round ran: the last fix round at c{7} ruled FLAKE/);

    const free = movedHeadEffects(t, [], []);
    await free.dispatchFix(pr({ headRefName: HEAD_REF }), { unmetCriteria: [], ciFailures: pr().ciFailures });
    assert.deepEqual(free.rungs, [TASK], "with no ruling at the adopted head, the round runs there");
  });

  test("W1-T13865 criterion 4: a conflicted child that adopts the live head stands down on that head's hold", async t => {
    const mergeConflict = { files: [{ path: "src/lib/fixture.ts", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "ours", theirsLog: "theirs" };
    const child = async (ledgerRows: Row[]) => {
      const rows: Row[] = [];
      const moved = movedHeadEffects(t, rows, ledgerRows);
      const envelope = buildFixDispatchEnvelope(pr({ headRefName: HEAD_REF }), { unmetCriteria: [], mergeConflict },
        { fixKey: `${TASK}@${HEAD}`, decidedAtMs: 1 });
      await runFixDispatchChild({ envelope: JSON.parse(JSON.stringify(envelope)) }, {
        hold: () => undefined,
        readLivePr: async () => ({ state: "OPEN", merged: false, headSha: NEW_HEAD }),
        readTask: () => ({ found: true, merged: false, retired: false }),
        readMergeFacts: async () => ({ mergeable: "CONFLICTING", headSha: NEW_HEAD }),
        claimFixAdmission: () => ({ admitted: true }),
        dispatcher: () => ({ dispatchFix: moved.dispatchFix }),
        log: (step, extra) => { rows.push({ step, ...extra }); },
      });
      return { rows, rungs: moved.rungs };
    };
    const held = await child(atNewHead(round("NEEDS_SCOPE", { contract_revision: taskContractRevision(PLAN_TASK) })));
    assert.equal(held.rows.filter(row => row.step === "sweep.fix.child_head_adopted").length, 1);
    assert.deepEqual(held.rungs, [], "no fix worker at the adopted head");
    assert.deepEqual(deferredAtHold(held.rows), [[NEW_HEAD, "prior_round_hold", "NEEDS_SCOPE"]]);

    const free = await child([]);
    assert.deepEqual(deferredAtHold(free.rows), []);
    assert.deepEqual(free.rungs, [TASK], "with no ruling at the adopted head, the round runs there");
  });

  test("W1-T13865 criterion 1: a late local merge receipt does not skip the live merge time of an amendment merged before the round", async () => {
    const earlier = "a".repeat(40);
    const created = { ...pendingAmendment, head_sha: earlier, ts: at(70_000) };
    // Adopted locally after the round, with no merged_at: its ts dates the receipt, not the merge.
    const receipt = { step: "fix.scope_amendment", task_id: TASK, head_sha: earlier, outcome: "merged", amendmentNumber: 900,
      amendment_url: AMENDMENT_URL, ts: at(5_000) };
    const rows = swept([created, ...round("NEEDS_SCOPE", { contract_revision: "contract-A" }), receipt]);
    const f = fixture(rows);
    const reads: string[] = [];
    f.deps.readAmendmentMergedAt = async url => { reads.push(url); return at(50_000); };
    await runSweep([pr()], f.deps);
    assert.deepEqual(reads, [AMENDMENT_URL], "the sweep reads the amendment's live merge time");
    assert.equal(f.state.dispatched, 0, "the amendment merged before the NEEDS_SCOPE ruling, so the ruling stands");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "NEEDS_SCOPE");
  });

  test("W1-T13865 criterion 3: a fresh red required status releases FLAKE when the check-runs read fails", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    const logged: string[] = [];
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root: "/unused/prior-round-hold" } as Config,
      ledgerPath: f.deps.ledgerPath, runId: f.deps.runId, plan: { tasks: [], byId: new Map() },
      log: (step, fields) => { logged.push(`${step}:${String(fields?.read ?? "")}`); },
      ciGateRequired: ["ci"], restRollupForImpl: rollupForAsync,
      readJsonImpl: async (args) => {
        const endpoint = args[1] ?? "";
        if (endpoint === PR_READ) return { base: { ref: "main" } };
        if (endpoint.endsWith("/protection/required_status_checks")) return {
          contexts: ["remudero-review"], checks: [{ context: "remudero-review", app_id: null }],
        };
        if (endpoint.includes(`/commits/${HEAD}/check-runs`)) throw new Error("HTTP 502");
        if (endpoint.includes(`/commits/${HEAD}/statuses?`)) return [[
          { context: "remudero-review", state: "failure", created_at: at(1_000), updated_at: at(1_000) }]];
        assert.fail(`unexpected check read ${endpoint}`);
      },
    });
    assert.deepEqual(await effects.readRequiredCheckCompletions!(pr()), [{ name: "remudero-review", completedAt: at(1_000) }],
      "the statuses response is read on its own");
    assert.deepEqual(logged, ["sweep.ci_gate_rollup.error:check-runs"]);
    f.deps.readRequiredCheckCompletions = effects.readRequiredCheckCompletions;
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "the fresh red status releases the hold");
  });

  test("W1-T13865 criterion 4: a NEEDS_SCOPE ruling made after the owner's revise-pr grant still stands the round down", async () => {
    const { rows, grant } = grantedScopeRound();
    // The granted round ran at this head and ruled NEEDS_SCOPE again after the grant.
    const done = rows.pop()!;
    rows.push({ ...grant, ts: at(32_000) }, done);
    const f = fixture(rows);
    await runSweep([pr({ taskId: "unfiled" })], f.deps);
    assert.equal(f.state.dispatched, 0, "an older grant does not override a newer ruling");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "NEEDS_SCOPE");
  });

  test("W1-T13865 criterion 1: with no live merge time, a merged receipt newer than the ruling releases nothing", async () => {
    // The fix lane's local adoption receipt: no URL, no merged_at; its ts is when it was adopted, not when it merged.
    const adopted = { step: "fix.scope_amendment", task_id: TASK, outcome: "amendment_merged", merged_locally: true,
      amendment_number: 900, ts: at(5_000) };
    const scopeRound = round("NEEDS_SCOPE", { contract_revision: "contract-A" });
    const hold = priorRoundHold([...scopeRound, adopted], facts());
    assert.equal(hold?.hold, "NEEDS_SCOPE", "an undated receipt does not date a merge after the round");
    assert.equal(hold?.undatedAmendmentReceipt, true);
    assert.match(String(hold?.reason), /carries no merge time and none was read live/);
    const known = [{ ...pendingAmendment, head_sha: "a".repeat(40), ts: at(70_000) }, ...scopeRound, adopted];
    assert.equal(priorRoundHold(known, facts())?.hold, "NEEDS_SCOPE", "the live read is unavailable for the known amendment");
    const rows = swept(known);
    const f = fixture(rows);
    f.deps.readAmendmentMergedAt = async () => undefined;
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "an unreadable live merge time keeps the hold");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "NEEDS_SCOPE");
    assert.equal(lastDisposed(rows).prior_round_hold_undated_amendment, true);
  });

  test("W1-T13865 criterion 2: a completion required only by main's protection keeps FLAKE for a PR into another branch", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    const protections: string[] = [];
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root: "/unused/prior-round-hold" } as Config,
      ledgerPath: f.deps.ledgerPath, runId: f.deps.runId, plan: { tasks: [], byId: new Map() }, log: () => {},
      ciGateRequired: ["ci"], restRollupForImpl: rollupForAsync,
      readJsonImpl: async (args) => {
        const endpoint = args[1] ?? "";
        if (endpoint === PR_READ) return { base: { ref: "release/1.0" } };
        if (endpoint.endsWith("/protection/required_status_checks")) {
          protections.push(endpoint);
          return endpoint.includes("/branches/main/") ? { contexts: ["main-only"], checks: [{ context: "main-only", app_id: null }] }
            : { contexts: ["release-gate"], checks: [{ context: "release-gate", app_id: null }] };
        }
        if (endpoint.includes(`/commits/${HEAD}/check-runs`)) return [{ check_runs: [
          { name: "main-only", status: "completed", conclusion: "failure", completed_at: at(1_000) }] }];
        if (endpoint.includes(`/commits/${HEAD}/statuses?`)) return [[]];
        assert.fail(`unexpected check read ${endpoint}`);
      },
    });
    assert.deepEqual(await effects.readRequiredCheckCompletions!(pr()), []);
    assert.deepEqual(protections, ["repos/o/remudero/branches/release%2F1.0/protection/required_status_checks"]);
    f.deps.readRequiredCheckCompletions = effects.readRequiredCheckCompletions;
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 0, "main's requirement is not this PR's");
    assert.equal(lastDisposed(rows)[PRIOR_ROUND_HOLD_FIELD], "FLAKE");
  });

  test("W1-T13865 criterion 3: a fresh red completion the PR's base branch requires releases FLAKE", async () => {
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    const effects = buildSweepEffects({ owner: "o", repo: "remudero", repoRoot: REPO_ROOT, config: { root: "/unused/prior-round-hold" } as Config,
      ledgerPath: f.deps.ledgerPath, runId: f.deps.runId, plan: { tasks: [], byId: new Map() }, log: () => {},
      ciGateRequired: ["ci"], restRollupForImpl: rollupForAsync,
      readJsonImpl: async (args) => {
        const endpoint = args[1] ?? "";
        if (endpoint === PR_READ) return { base: { ref: "release/1.0" } };
        if (endpoint.endsWith("/protection/required_status_checks")) {
          return endpoint.includes("/branches/main/") ? { contexts: ["main-only"] } : { contexts: ["release-gate"] };
        }
        if (endpoint.includes(`/commits/${HEAD}/check-runs`)) return [{ check_runs: [
          { name: "release-gate", status: "completed", conclusion: "failure", completed_at: at(1_000) }] }];
        if (endpoint.includes(`/commits/${HEAD}/statuses?`)) return [[]];
        assert.fail(`unexpected check read ${endpoint}`);
      },
    });
    assert.deepEqual(await effects.readRequiredCheckCompletions!(pr()), [{ name: "release-gate", completedAt: at(1_000) }]);
    f.deps.readRequiredCheckCompletions = effects.readRequiredCheckCompletions;
    await runSweep([pr()], f.deps);
    assert.equal(f.state.dispatched, 1, "the base branch's own requirement completed red after the round");
  });

  test("W1-T13865 criterion 4: a FLAKE hold still runs the worker-free ratchet repair once and spawns no fix worker", async () => {
    const name = "comment-load-ratchet";
    const rows = swept(round("FLAKE"));
    const f = fixture(rows);
    const repaired: string[][] = [];
    f.deps.repairRecordableRatchet = (_pr, scripts) => { repaired.push([...scripts]); return true; };
    f.deps.log = (step, extra) => { rows.push({ step, ...extra }); };
    await runSweep([pr({ redRequiredChecks: [name], ciFailures: [{ name, logTail: `${name}: record it in the baseline` }] })], f.deps);
    assert.deepEqual(repaired, [[name]], "the deterministic repair ran");
    assert.equal(rows.filter(row => row.step === "sweep.ratchet_repaired").length, 1);
    assert.equal(f.state.dispatched, 0, "no fix worker");
  });
});
