import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";

import type { Config } from "#src/lib/config.js";
import { findDuplicateEscalation, openEscalationStandDownReason, taskContractRevision, type IssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import { reviewerFailureDigest } from "#src/lib/fix-progress-judge.js";
import { actOnParkedPr, openEscalationRelease, PARKED_PR_REMEDY_STEP, parkedPrFacts, parkedPrRemedy, type ParkedPrContext, type ParkedPrHost,
  type ParkedPrSubject } from "#src/lib/parked-pr-remedy.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, prBodyDigest, renderClarificationQuestion, runSweep, type FixDispatchEvidence,
  type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

// W1-T12709: 106 needs-human issues named an open pull request, on 66 pull requests, for 390.5 PR-hours
// (2026-11-11 to 2026-11-14). The console does not deliver them. The operator ruled: fix the pull request, split
// out a held follow-up, or close it and file a held rebuild. Never wait on a person.

const TASK = "W1-T12709-FIXTURE";
const PR = 12709;
const PR_URL = `https://github.com/o/r/pull/${PR}`;
const HEAD = "head-0";
const NOW = Date.parse("2026-11-15T12:00:00Z");
const CLAIMS = ["the first criterion holds", "the second criterion needs a design answer", "the third criterion needs a design answer"];
const SHARD_REL = `plan/tasks.d/${TASK}-a-fixture-task.yaml`;
const shardOf = (claims: readonly string[]) => [`- id: ${TASK}`, "  title: \"A fixture task\"", "  repo: remudero",
  "  depends_on: [W1-T1]", "  files:", "    - src/x.ts", "  status: queued", "  attempts: 0", "  acceptance:",
  ...claims.flatMap(c => [`    - claim: "${c}"`, `      proof: "grep: ${c} in src/x.ts"`]),
  "  rationale: |", "    WHY: a fixture.", "  note: |", "    a note", ""].join("\n");
const CONTINUE = { verdict: "continue", reason: "the judge permits another round" } as const;

function host(over: { claims?: readonly string[]; landError?: string } = {}) {
  const landed: { relPath: string; content: string }[][] = [];
  const closed: { prUrl: string; comment: string; afterLanding: boolean }[] = [];
  let next = 99000;
  const h: ParkedPrHost = {
    readTaskShard: (id) => id === TASK ? { relPath: SHARD_REL, text: shardOf(over.claims ?? CLAIMS) } : undefined,
    reserveTaskId: () => `W1-T${++next}`,
    landTaskFiles: async (files) => {
      landed.push(files.map(f => ({ relPath: f.relPath, content: f.content })));
      return over.landError === undefined ? { prUrl: "https://github.com/o/r/pull/99999" } : { error: over.landError };
    },
    closePr: async (prUrl, comment) => { closed.push({ prUrl, comment, afterLanding: landed.length > 0 }); },
  };
  return { h, landed, closed };
}

const yamlTask = (content: string) => (parse(content) as Record<string, unknown>[])[0]!;

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber: PR, prUrl: PR_URL, taskId: TASK, headSha: HEAD, headRefName: `run-${TASK}-1`, autoMergeArmed: false,
    priorStrikes: 0, lastActivityAt: new Date(NOW).toISOString(), checksState: "green", reviewState: "failure",
    unmetCriteria: [], ...over } as OpenPrView;
}

const refusedPr = () => view({ unmetCriteria: [{ claim: CLAIMS[1]!, proof: `grep: ${CLAIMS[1]} in src/x.ts`, met: false,
  reason: "the worker refused it", proof_exec: "executed_fail", refusal: { class: "premise-rotted", detail: "the premise moved" } }] as OpenPrView["unmetCriteria"] });

function world(rows: Record<string, unknown>[], parked?: ParkedPrHost) {
  const dispatched: FixDispatchEvidence[] = [], escalated: string[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/parked-ledger", runId: "parked-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    fixProgressJudge: async () => CONTINUE, arm: () => {}, close: () => {},
    escalate: (_pr, reason) => { escalated.push(reason); },
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence); },
    ...(parked ? { parkedPr: parked } : {}),
  };
  const remedies = () => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP);
  const disposed = () => rows.filter(r => r.step === "sweep.disposed");
  return { deps, dispatched, escalated, remedies, disposed };
}

/** invariant:no-parked-pr, read off the ledger: every row that parks an open pull request has a remedy row. */
function parkedWithoutRemedy(rows: readonly Record<string, unknown>[]): number[] {
  return rows.filter(r => r.step === "sweep.disposed" && (r.disposition === "refused-escalate" || r.blocker === "escalated"))
    .map(r => r.pr_number as number)
    .filter(pr => !rows.some(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === pr &&
      ["fix-on-pr", "split-follow-up", "close-and-rebuild"].includes(String(r.remedy))));
}

/** The two calls the sweep makes where it would set refused-escalate. */
async function remedyParkedPr(pr: ParkedPrSubject, input: Parameters<typeof parkedPrFacts>[1], rows: Record<string, unknown>[],
  h: ParkedPrHost, context: ParkedPrContext) {
  const facts = parkedPrFacts(pr, input, rows, h);
  return actOnParkedPr(pr, parkedPrRemedy(facts), facts, rows, h, context);
}

const ctx = (rows: Record<string, unknown>[], cause = "needs-design") => ({ runId: "parked-test", ledgerTaskId: TASK,
  nowIso: new Date(NOW).toISOString(), cause, text: "fix needs design at this exact head: which store?", append: (row: Record<string, unknown>) => { rows.push(row); } });

test("W1-T12709 criterion 1: a pull request the fix lane would stand down on gets a fix round, not a needs-human issue", async () => {
  const legacy = world([]);
  await runSweep([refusedPr()], legacy.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(legacy.disposed()[0]!.disposition, "refused-escalate", "without the remedy the pull request waits on a person");
  assert.equal(legacy.escalated.length, 1);

  const { h, landed, closed } = host();
  const w = world([], h);
  await runSweep([refusedPr()], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.escalated.length, 0, "no needs-human issue is opened");
  assert.deepEqual(w.remedies().map(r => [r.pr_number, r.head_sha, r.remedy, r.outcome]), [[PR, HEAD, "fix-on-pr", "taken"]]);
  const row = w.disposed()[0]!;
  assert.equal(row.disposition, "blocked-fixable", "the sweep dispatches the fix lane on the pull request");
  assert.equal(w.dispatched.length, 1, "a fix round is dispatched on the pull request");
  assert.equal(landed.length + closed.length, 0, "a fixable criterion files nothing and closes nothing");
});

test("W1-T12709 criterion 2: when only some criteria need input, one held follow-up is filed and an amendment moves them out", async () => {
  const rows: Record<string, unknown>[] = [];
  const { h, landed, closed } = host();
  const pr = view({ unmetCriteria: [CLAIMS[1]!, CLAIMS[2]!].map(claim => ({ claim, proof: `grep: ${claim} in src/x.ts`, met: false,
    reason: `${claim} is not met`, proof_exec: "executed_fail" })) as OpenPrView["unmetCriteria"] });
  const out = await remedyParkedPr(pr, { redChecks: [], designQuestion: "fix needs design: which store?", fixModelOrder: ["fix", "step_up"] },
    rows, h, ctx(rows));
  assert.equal(out.remedy, "split-follow-up");
  assert.equal(out.heldTaskId, "W1-T99001");
  assert.equal(closed.length, 0, "the pull request stays open and merges on the rest");
  assert.equal(landed.length, 1, "one landing carries the follow-up and the amendment");
  const [followUp, amended] = landed[0]!;
  const held = yamlTask(followUp!.content);
  assert.equal(held.id, "W1-T99001");
  assert.deepEqual((held.acceptance as { claim: string }[]).map(c => c.claim), [CLAIMS[1], CLAIMS[2]]);
  const input = held.needs_input as { question: string; source_pr: string; asked_at: string };
  assert.equal(input.source_pr, PR_URL);
  assert.match(input.question, /which store\?/);
  assert.equal(held.status, "queued");
  assert.deepEqual(held.depends_on, [TASK, "W1-T1"], "the follow-up waits for the pull request's task");
  assert.equal(amended!.relPath, SHARD_REL, "the acceptance amendment edits the pull request's own task file");
  const rest = yamlTask(amended!.content);
  assert.deepEqual((rest.acceptance as { claim: string }[]).map(c => c.claim), [CLAIMS[0]]);
  assert.match(String(rest.rationale), /MOVED to W1-T99001/);
  assert.equal(rows.filter(r => r.step === PARKED_PR_REMEDY_STEP && r.remedy === "split-follow-up" && r.held_task_id === "W1-T99001").length, 1);
  assert.equal(out.disposition, "wait", "nothing fixable is left, so the pull request waits on the amendment, not on a person");
});

test("W1-T12709 criterion 3: when nothing can merge without the input, the pull request is closed and a held rebuild is filed", async () => {
  const ladder = (claim: string) => [
    { step: "fix.stall_remedy", pr_number: PR, criterion: `review:${claim}`, remedy: "stronger-worker", outcome: "taken", rounds: 3, mount: "step_up" },
    { step: "fix.stall_remedy", pr_number: PR, criterion: `review:${claim}`, remedy: "amend-criterion", outcome: "taken", rounds: 4 }];
  const pr = view({ unmetCriteria: CLAIMS.map(claim => ({ claim, proof: `grep: ${claim} in src/x.ts`, met: false,
    reason: `finding: ${claim} failed`, proof_exec: "executed_fail" })) as OpenPrView["unmetCriteria"] });
  const rows: Record<string, unknown>[] = [...ladder(CLAIMS[1]!)];
  const { h, landed, closed } = host();
  const out = await remedyParkedPr(pr, { redChecks: [], designQuestion: "fix needs design: which store?", fixModelOrder: ["fix", "step_up"] },
    rows, h, ctx(rows));
  assert.equal(out.remedy, "close-and-rebuild");
  assert.equal(landed.length, 1);
  const rebuild = yamlTask(landed[0]![0]!.content);
  assert.equal(rebuild.id, out.heldTaskId);
  assert.deepEqual((rebuild.acceptance as { claim: string }[]).map(c => c.claim), CLAIMS, "the rebuild keeps the same criteria");
  assert.deepEqual(rebuild.files, ["src/x.ts"], "the rebuild keeps the same files");
  assert.match((rebuild.needs_input as { question: string }).question, /which store\?/);
  assert.match(String(rebuild.rationale), /FINDINGS of the pull request:\n- the first criterion holds: finding: the first criterion holds failed/);
  assert.equal(rebuild.note, undefined);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.prUrl, PR_URL);
  assert.ok(closed[0]!.afterLanding, "the rebuild is filed before the pull request is closed");
  assert.match(closed[0]!.comment, new RegExp(String(out.heldTaskId)));

  const failed = host({ landError: "the landing preflight refused" });
  const failedRows: Record<string, unknown>[] = [...ladder(CLAIMS[1]!)];
  const refused = await remedyParkedPr(pr, { redChecks: [], designQuestion: "which store?", fixModelOrder: ["fix", "step_up"] },
    failedRows, failed.h, ctx(failedRows));
  assert.equal(failed.closed.length, 0, "a pull request is never closed without its rebuild filed");
  assert.equal(refused.disposition, "wait");
  assert.equal(failedRows.findLast(r => r.step === PARKED_PR_REMEDY_STEP)!.outcome, "refused");
});

test("W1-T12709 criterion 4: invariant:no-parked-pr, no sweep.disposed row parks an open pull request without a remedy row", async () => {
  const prs = [refusedPr(), view({ prNumber: PR + 1, prUrl: `${PR_URL}1`, isPlanFiling: true, taskId: undefined, checksState: "red",
    reviewState: "pending", headRefName: "plan-filing-1", ciFailures: [{ name: "lint-plan", logTail: "task-linter: block" }] })];
  const legacyRows: Record<string, unknown>[] = [];
  await runSweep(prs, world(legacyRows).deps, DEFAULT_SWEEP_POLICY);
  assert.ok(parkedWithoutRemedy(legacyRows).length > 0, "the check finds a parked pull request when the remedy is not wired");

  const rows: Record<string, unknown>[] = [];
  const { h } = host();
  for (let pass = 0; pass < 2; pass++) await runSweep(prs, world(rows, h).deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(parkedWithoutRemedy(rows), []);
  assert.equal(rows.filter(r => r.step === "sweep.disposed" && r.disposition === "refused-escalate").length, 0);
  assert.equal(rows.filter(r => r.step === PARKED_PR_REMEDY_STEP && r.pr_number === PR).length, 1,
    "a fix-on-pr row is written once per pull request, head and cause");
});

test("W1-T12709 criterion 5: invariant:one-question, a later pass reuses the held task for the same pull request and cause", async () => {
  const rows: Record<string, unknown>[] = [];
  const { h, landed } = host();
  const pr = view({ unmetCriteria: [{ claim: CLAIMS[2]!, proof: "p", met: false, reason: "r", proof_exec: "executed_fail" }] as OpenPrView["unmetCriteria"] });
  const input = { redChecks: [], designQuestion: "which store?", fixModelOrder: ["fix", "step_up"] };
  const first = await remedyParkedPr(pr, input, rows, h, ctx(rows));
  const second = await remedyParkedPr({ ...pr, headSha: "head-1" }, input, rows, h, ctx(rows));
  assert.equal(landed.length, 1, "one held task for one pull request and cause");
  assert.equal(second.heldTaskId, first.heldTaskId);
  assert.match(second.reason, /reuses it/);
  const other = await remedyParkedPr(pr, input, rows, h, ctx(rows, "stand-down:rung.strike"));
  assert.notEqual(other.heldTaskId, first.heldTaskId, "a different cause asks its own question");
});

test("W1-T12709 criterion 6: a stage-stall escalation for an open pull request becomes a remedy row with its text", async () => {
  const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const pr = view({ prNumber: 18100, prUrl: "https://github.com/o/r/pull/18100", headSha: "a1b2c3d4", reviewState: "success",
    mergeState: "dirty" });
  const rowsFor = () => [
    ...[90, 85, 80, 75, 70, 65, 60, 55, 50].map(m => ({ ts: ago(m), run_id: "old", task_id: TASK, step: "sweep.disposed",
      pr_number: pr.prNumber, head_sha: pr.headSha, disposition: "conflicted", acted: false, blocker: "conflict", blocker_since: ago(90) })),
    { ts: ago(80), run_id: "fix", task_id: TASK, step: "fix.dispatch", pr_number: pr.prNumber, head_sha: pr.headSha },
    { ts: ago(60), run_id: "fix", task_id: TASK, step: "fix.dispatch", pr_number: pr.prNumber, head_sha: pr.headSha }];
  const run = async (parked?: ParkedPrHost) => {
    const ledger = writeLedger(rowsFor());
    const escalations: string[] = [];
    await runSweep([pr], { ledgerPath: ledger.path, runId: "stage-stall", now: () => NOW, arm: () => "hold-refused",
      close: () => {}, dispatchFix: () => {}, postReview: () => {}, actionable: () => false,
      escalate: (_pr, reason) => { escalations.push(reason); }, ...(parked ? { parkedPr: parked } : {}) });
    return { escalations, rows: readLedgerLines(ledger.path) };
  };
  const legacy = await run();
  assert.equal(legacy.escalations.filter(r => r.startsWith("PR stage stalled:")).length, 1, "without the remedy a needs-human issue opens");
  const parked = await run(host().h);
  assert.equal(parked.escalations.length, 0);
  const row = parked.rows.find(r => r.step === PARKED_PR_REMEDY_STEP && r.cause === "stage-stall")!;
  assert.equal(row.remedy, "fix-on-pr");
  assert.match(String(row.text), /^PR stage stalled: #18100 /);
});

test("W1-T12709 criterion 7: a plan-only filing red on a plan gate is not held behind plan-proof-unrunnable", async () => {
  const plan = view({ prNumber: PR + 1, prUrl: `${PR_URL}1`, isPlanFiling: true, taskId: undefined, checksState: "red",
    reviewState: "pending", headRefName: "plan-filing-1", ciFailures: [{ name: "lint-plan", logTail: "task-linter: block" }] });
  const legacy = world([]);
  await runSweep([plan], legacy.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(legacy.disposed()[0]!.disposition, "refused-escalate");
  const w = world([], host().h);
  await runSweep([plan], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.escalated.length, 0);
  assert.deepEqual(w.remedies().map(r => [r.remedy, r.cause]), [["fix-on-pr", "plan-gate"]]);
  assert.notEqual(w.disposed()[0]!.disposition, "refused-escalate");
  assert.match(String(w.disposed()[0]!.reason), /plan-scoped round acts on 0 unmet criteria and 1 red checks/);
  assert.equal(legacy.disposed()[0]!.blocker, "plan-proof-unrunnable", "without the remedy the plan filing is held behind plan-proof-unrunnable");
  assert.notEqual(w.disposed()[0]!.blocker, "plan-proof-unrunnable", "the remedy's own blocker is not overwritten");
  assert.notEqual(w.disposed()[0]!.blocker, "escalated");
  assert.notEqual(w.disposed()[0]!.blocker_owner, "plan-repair");
});

test("W1-T12709 criterion 4: invariant:no-parked-pr, a fix lane stand-down hold keeps its hold, names a remedy and opens no needs-human issue", async () => {
  const head = "c".repeat(40);
  const key = `PR-${PR}`;
  const body = "A taskless pull request.\n";
  const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const rowsFor = (): Record<string, unknown>[] => [
    { step: "sweep.disposed", pr_number: PR, head_sha: head, task_id: "SWEEP", run_id: "hold", disposition: "blocked-fixable", acted: true, ts: at(60) },
    { step: "fix.dispatch", task_id: key, head_sha: head, run_id: "hold", mode: "proof-discrimination", ts: at(59) },
    { step: "fix.stood_down", task_id: key, head_sha: head, run_id: "hold", site: "rung.empty_review_evidence",
      reason: "the review read no evidence the worker could act on", read_head_sha: head, read_body_sha256: prBodyDigest(body), ts: at(50) }];
  const heldPr = () => view({ taskId: undefined, headRefName: undefined, headSha: head, checksState: "red", reviewState: "pending", priorStrikes: 1,
    body, ciFailures: [{ name: "test-shard (1/8)", logTail: "not ok 1 - the fixture" }] } as Partial<OpenPrView>);
  const claimed = { claimFixAdmission: () => ({ admitted: true as const }) };

  const legacyRows = rowsFor();
  const legacy = world(legacyRows);
  await runSweep([heldPr()], { ...legacy.deps, ...claimed }, DEFAULT_SWEEP_POLICY);
  assert.equal(legacy.escalated.length, 1, "without the remedy the hold opens a needs-human issue");
  assert.deepEqual(parkedWithoutRemedy(legacyRows), [PR]);

  const rows = rowsFor();
  const w = world(rows, host().h);
  for (let pass = 0; pass < 3; pass++) await runSweep([heldPr()], { ...w.deps, ...claimed }, DEFAULT_SWEEP_POLICY);
  assert.equal(w.dispatched.length, 0, "the hold stays: nothing it read has changed, so no worker is dispatched");
  assert.equal(w.escalated.length, 0, "no needs-human issue is opened for the hold");
  assert.deepEqual(parkedWithoutRemedy(rows), []);
  // W1-T13045: the hold keeps refused-escalate and its escalated blocker, so the held-escalation ladder still reads it;
  // its one remedy row keeps it inside invariant:no-parked-pr.
  assert.equal(rows.filter(r => r.step === "sweep.disposed" && r.run_id === "parked-test" && r.disposition === "refused-escalate").length, 3);
  assert.deepEqual(w.remedies().map(r => [r.pr_number, r.head_sha, r.remedy, r.cause, r.outcome]),
    [[PR, head, "fix-on-pr", "stand-down:rung.empty_review_evidence", "taken"]], "one remedy row for the pull request, head and cause");
  const held = w.disposed().findLast(r => r.stand_down_hold === true)!;
  assert.equal(held.disposition, "refused-escalate");
  assert.equal(held.acted, false);
  assert.equal(held.stand_down_site, "rung.empty_review_evidence");
});

test("W1-T12709 criterion 6: a clarification escalation for an open pull request becomes a remedy row with its text", async () => {
  const stale = () => view({ checksState: "none", reviewState: "none", lastActivityAt: new Date(NOW - 60 * 60_000).toISOString() });
  const legacy = world([]);
  await runSweep([stale()], legacy.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(legacy.disposed()[0]!.disposition, "blocked-ambiguous");
  assert.equal(legacy.escalated.length, 1, "without the remedy the clarification opens a needs-human issue");

  const rows: Record<string, unknown>[] = [];
  const w = world(rows, host().h);
  for (let pass = 0; pass < 2; pass++) await runSweep([stale()], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.escalated.length, 0, "the W1-T78 rung opens no needs-human issue for an open pull request");
  assert.deepEqual(w.remedies().map(r => [r.pr_number, r.remedy, r.cause, r.outcome]), [[PR, "fix-on-pr", "clarification", "taken"]]);
  assert.match(String(w.remedies()[0]!.text), /zero check runs on head .*review none — CI suite recovery owns the bounded re-push/);
});

test("W1-T12709 criterion 9: invariant:never-close-healthy-work, nothing unmet and nothing red is fix-on-pr and never a close", async () => {
  const spent = { needsInput: true, ladderSpent: true };
  assert.equal(parkedPrRemedy({ unmetCriteria: [], redChecks: [], isPlanFiling: false, taskCriteria: 1 }).remedy, "fix-on-pr");
  assert.equal(parkedPrRemedy({ unmetCriteria: [{ claim: "a", ...spent, ladderSpent: false }], redChecks: [], isPlanFiling: false,
    taskCriteria: 1 }).remedy, "fix-on-pr", "a needs-input criterion that has not been through the stall remedies is never closed");
  assert.equal(parkedPrRemedy({ unmetCriteria: [{ claim: "a", ...spent }], redChecks: [], isPlanFiling: false, taskCriteria: 1 }).remedy,
    "close-and-rebuild");
  const rows: Record<string, unknown>[] = [];
  const { h, closed, landed } = host();
  const out = await remedyParkedPr(view({ reviewState: "success" }), { redChecks: [], fixModelOrder: ["fix"] }, rows, h, ctx(rows, "stage-stall"));
  assert.equal(out.remedy, "fix-on-pr");
  assert.equal(out.disposition, "post-review", "the stalled review runs again on the pull request");
  assert.equal(closed.length + landed.length, 0);
});

test("W1-T12709 criterion 10: a fix-on-pr row releases the fix lane's open-escalation stand-down for that pull request and head only", async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}parked-fix-release-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = { id: TASK, title: "A fixture task", files: ["src/x.ts"], acceptance: [] } as unknown as Task;
  const head = "660d92c".padEnd(40, "0");
  const pr: OpenPrView = { ...view(), headSha: head, checksState: "red", reviewState: "none" };
  const open: OpenIssue[] = [];
  const issues: IssueGateway = {
    create(title, body) { const url = "https://github.com/o/r/issues/1"; open.push({ number: 1, url, title, body }); return url; },
    listOpen: () => open, comment: () => {}, closeWithComment: () => assert.fail("the question stays open"),
  };
  const effects = buildSweepEffects({ owner: "o", repo: "r", repoRoot: root, config: { claudeBin: "claude", root } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "parked-release", plan: { tasks: [task], byId: new Map([[task.id, task]]) } as Plan,
    log: () => {}, issuesImpl: issues, reloadPlanForFixImpl: () => undefined, readJsonImpl: async () => assert.fail("no GitHub read") });
  assert.ok(effects.parkedPr, "the production sweep effects wire the remedy");
  const reason = "fix progress loop: operator scope decision";
  await effects.escalate(pr, reason, { ...renderClarificationQuestion(pr, reason), question: reason });
  const revision = taskContractRevision(task);
  const candidate = findDuplicateEscalation({ class: "BLOCKED", taskId: TASK, summary: `review false-block — ${PR_URL}`, detail: "",
    headSha: head, cause: "ci", contractRevision: revision }, { issues });
  assert.ok(candidate, "the open question names this head");
  const remedyRow = (prNumber: number, headSha: string) => ({ step: PARKED_PR_REMEDY_STEP, pr_number: prNumber, head_sha: headSha,
    remedy: "fix-on-pr", outcome: "taken", cause: "open-escalation" });
  const standDown = (rows: Record<string, unknown>[]) =>
    openEscalationStandDownReason(head, candidate, revision, undefined, undefined, openEscalationRelease(undefined, rows, PR, head));
  assert.match(standDown([])!.reason, /ALREADY OPEN/, "with no remedy row the fix lane stands down");
  for (const other of [remedyRow(PR + 1, head), remedyRow(PR, "another-head"), { ...remedyRow(PR, head), outcome: "refused" },
    { ...remedyRow(PR, head), remedy: "split-follow-up" }]) {
    assert.match(standDown([other])!.reason, /ALREADY OPEN/, `${JSON.stringify(other)} releases nothing`);
  }
  assert.equal(standDown([remedyRow(PR, head)]), undefined, "the fix-on-pr row for this pull request and head releases it");
  assert.deepEqual(open, [candidate], "the release closes no issue");
  const answered = { spent: true as const };
  assert.equal(openEscalationRelease(answered, [remedyRow(PR, head)], PR, head), answered, "an operator's answer keeps its meaning");
});

// The state production reaches once the fix lane stood down on an already-open needs-human escalation: the pull request is
// red, the open issue names its exact head, and the sweep holds the dispatch behind it.
const OPEN_HEAD = "a".repeat(40);
const openEscalation = (head = OPEN_HEAD) => [{ number: 1, title: "[BLOCKED] repair", url: "https://github.com/o/r/issues/1",
  body: `**Task:** ${TASK}\n**Class:** BLOCKED\n${PR_URL}\n**Head:** ${head}\n**Cause:** ci\n` }];
const redOpenPr = (over: Partial<OpenPrView> = {}) => view({ headSha: OPEN_HEAD, checksState: "red", reviewState: "pending",
  ciFailures: [{ name: "test-shard (1/8)", logTail: "not ok 1 - the fixture" }], ...over });

test("W1-T12709 criterion 1: a pull request held behind an already-open escalation is dispatched the fix round, once", async () => {
  const legacy = world([]);
  legacy.deps.readOpenEscalations = () => openEscalation();
  await runSweep([redOpenPr()], legacy.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(legacy.dispatched.length, 0, "without the remedy the open escalation holds the pull request");

  const rows: Record<string, unknown>[] = [];
  const { h, landed, closed } = host();
  const w = world(rows, h);
  w.deps.readOpenEscalations = () => openEscalation();
  await runSweep([redOpenPr()], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.dispatched.length, 1, "the fix round runs on the pull request instead of standing down");
  assert.equal(w.escalated.length, 0);
  assert.deepEqual(w.remedies().map(r => [r.pr_number, r.head_sha, r.remedy, r.cause, r.outcome]),
    [[PR, OPEN_HEAD, "fix-on-pr", "open-escalation", "taken"]]);
  assert.equal(landed.length + closed.length, 0);

  await runSweep([redOpenPr()], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.remedies().length, 1, "a later pass at the same head writes no second remedy row");
  assert.equal(openEscalationStandDownReason(OPEN_HEAD, openEscalation()[0] as OpenIssue,
    undefined, undefined, undefined, openEscalationRelease(undefined, rows, PR, OPEN_HEAD)), undefined,
  "the fix lane's stand-down is released for this pull request and head");
});

test("W1-T12709 criterion 4: invariant:no-parked-pr, a pull request behind an open escalation never carries a refused-escalate row", async () => {
  const rows: Record<string, unknown>[] = [];
  const w = world(rows, host().h);
  w.deps.readOpenEscalations = () => openEscalation();
  for (let pass = 0; pass < 2; pass++) await runSweep([redOpenPr()], w.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(parkedWithoutRemedy(rows), []);
  assert.equal(rows.filter(r => r.step === "sweep.disposed" && r.disposition === "refused-escalate").length, 0);
  assert.equal(rows.filter(r => r.step === "sweep.disposed" && r.blocker === "escalated").length, 0);
  assert.equal(w.remedies().length, 1);
});

test("W1-T12709 criterion 11: the stall ladder's operator-input step becomes a split, or a close and rebuild when a split is impossible", async () => {
  const claim = CLAIMS[1]!;
  const key = `review:${claim}`;
  const round = (i: number, red: string): Record<string, unknown>[] => [
    { task_id: TASK, pr_number: PR, step: "fix.dispatch", round_id: `r${i}`, head_sha: `head-${i}`,
      ...(red.startsWith("review:") ? { unmet_claims: [claim], reviewer_proof_failures: [{ claim, digest: reviewerFailureDigest("same") }] }
        : { ci_failures: [{ check: red }] }) },
    { task_id: TASK, pr_number: PR, step: "fix.done", round_id: `r${i}`, head_sha: `head-${i}`, pushed_head_sha: `head-${i + 1}`,
      subtype: "success", fix_outcome: "FIXED" }];
  const tried = (criterion: string) => [
    { step: "fix.stall_remedy", pr_number: PR, criterion, remedy: "stronger-worker", outcome: "taken", rounds: 3, mount: "step_up" },
    { step: "fix.stall_remedy", pr_number: PR, criterion, remedy: "amend-criterion", outcome: "taken", rounds: 3 }];
  const review = { task_id: TASK, step: "review.posted", pr_url: PR_URL, head_sha: "head-4",
    decision_verdict: { criteria: CLAIMS.map(c => ({ claim: c })) } };
  const reviewPr = view({ headSha: "head-4", priorStrikes: 1, unmetCriteria: [{ claim, proof: `grep: ${claim} in src/x.ts`, met: false,
    reason: "still unmet", proof_exec: "executed_fail" }] as OpenPrView["unmetCriteria"] });
  const stalled = () => [...[0, 1, 2, 3].flatMap(i => round(i, key)), ...tried(key), review];

  const legacy = world(stalled());
  await runSweep([reviewPr], legacy.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(legacy.escalated.length, 1, "without the remedy the ladder escalates and holds");

  const split = host();
  const splitRows: Record<string, unknown>[] = stalled();
  const w = world(splitRows, split.h);
  await runSweep([reviewPr], w.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(w.escalated.length, 0);
  assert.equal(w.dispatched.length, 0);
  const step = splitRows.findLast(r => r.step === "fix.stall_remedy")!;
  assert.deepEqual([step.remedy, step.parked_pr_remedy, step.held_task_id], ["operator-input", "split-follow-up", "W1-T99001"]);
  assert.deepEqual((yamlTask(split.landed[0]![0]!.content).acceptance as { claim: string }[]).map(c => c.claim), [claim]);
  assert.ok(yamlTask(split.landed[0]![0]!.content).needs_input, "the follow-up is held with a needs_input question");
  assert.deepEqual((yamlTask(split.landed[0]![1]!.content).acceptance as { claim: string }[]).map(c => c.claim), [CLAIMS[0], CLAIMS[2]]);
  assert.equal(split.closed.length, 0, "the pull request merges once its other criteria pass");

  const only = host({ claims: [claim] });
  const solo = world(stalled(), only.h);
  await runSweep([reviewPr], solo.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(only.closed.length, 1, "the task's only criterion cannot leave it, so the pull request is closed and rebuilt");
  assert.equal(only.landed[0]!.length, 1);
  assert.equal(solo.escalated.length, 0);
});
