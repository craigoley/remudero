import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/lib/daemon.js";
import { runnableCandidates } from "../src/lib/drain.js";
import { preDispatchContractRevision, terminalPreDispatchRefusalRevisions, writePriorRefusal } from "../src/lib/dispatch-repair.js";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { extractRefusal, holdTaskForRefusal, noPrVerdictRowsFromLedger, refusalHoldVerdict } from "../src/lib/refusal-amendment.js";
import { projectPlan, type GitHub, type StatusProjection } from "../src/lib/status.js";

const report = "REFUSED:\n1. [outside-declared-files] AgentView needs its published contract and file scope";
const sourceRun = "t100-refused";
const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined,
  prBody: () => undefined, issueByUrl: () => ({ state: "CLOSED" }) };

function fixture() {
  const state = mkdtempSync(join(tmpdir(), "rmd-corrected-refusal-"));
  const ledgerPath = join(state, "ledger.ndjson");
  const old: Task = { id: "CONSOLE-T100", title: "publish facade", repo: "console", depends_on: [],
    type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0, files: ["src/facade.ts"] };
  const corrected = { ...old, files: [...old.files!, "src/AgentView.ts"] };
  const append = (row: Record<string, unknown>) => appendLedger(ledgerPath, row as LedgerLine);
  append({ task_id: old.id, run_id: sourceRun, step: "run.start" });
  append({ task_id: old.id, run_id: sourceRun, step: "verdict", verdict: "no_pr",
    terminal_class: "harness_commit_refused", report_excerpt: report });
  append({ task_id: old.id, run_id: sourceRun, step: "dispatch.blocked_independent", verdict: "no_pr",
    terminal_class: "harness_commit_refused" });
  append({ task_id: old.id, run_id: "sweep", step: "refusal_amendment.drafted",
    source_run_id: sourceRun, outcome: "drafted" });
  append({ task_id: old.id, run_id: "sweep", step: "escalation.issue_opened", issue_url: "https://example.test/issues/100" });
  writePriorRefusal(state, old.id, { verdict: refusalHoldVerdict(extractRefusal(report)), attempts: 1,
    escalated: true, preDispatchContractRevision: preDispatchContractRevision(old) });
  const plan = (task: Task): Plan => ({ tasks: [task], byId: new Map([[task.id, task]]) });
  const project = (task: Task) => projectPlan(plan(task), { ledgerPath, github, skipUncreditedBuildWarning: true });
  const select = (task: Task) => {
    const projected = project(task);
    const held = terminalPreDispatchRefusalRevisions(state);
    return runnableCandidates(plan(task), () => false, 1, {
      isIndependentFailureBlocked: (id) => projected.get(id)?.independentFailureBlocked === true,
      isTerminalPreDispatchRefusalHeld: (t) => held.get(t.id) === preDispatchContractRevision(t),
    });
  };
  return { state, ledgerPath, old, corrected, append, plan, project, select };
}

test("a corrected categorized worker refusal rejoins dispatch once", async () => {
  const f = fixture();
  assert.deepEqual(f.select(f.old), []);
  assert.deepEqual(f.select(f.corrected).map((t) => t.id), [f.old.id]);
  assert.deepEqual(f.select(f.corrected).map((t) => t.id), [f.old.id], "projection does not spend the opportunity");
  const projection = f.project(f.corrected).get(f.old.id)!;
  assert.equal(projection.independentFailureBlocked, undefined);
  assert.equal(projection.needsHuman, undefined);
  assert.equal(projection.categorizedRefusalRejoin?.sourceRunId, sourceRun);
  assert.equal(projection.categorizedRefusalRejoin?.refusedContractRevision, preDispatchContractRevision(f.old));
  assert.equal(projection.categorizedRefusalRejoin?.contractRevision, preDispatchContractRevision(f.corrected));
  const delayed = fixture();
  holdTaskForRefusal(delayed.state, delayed.corrected, extractRefusal(report), sourceRun, preDispatchContractRevision(delayed.old));
  holdTaskForRefusal(delayed.state, delayed.corrected, extractRefusal(report), sourceRun);
  assert.equal(delayed.project(delayed.corrected).get(delayed.old.id)?.categorizedRefusalRejoin?.refusedContractRevision,
    preDispatchContractRevision(delayed.old), "a repeated sweep preserves the source's refused contract");
  const sourceRows = [{ task_id: f.old.id, run_id: sourceRun, step: "verdict", verdict: "no_pr", report_excerpt: report,
    pre_dispatch_contract_revision: preDispatchContractRevision(f.old), ts: new Date().toISOString() }];
  assert.equal(noPrVerdictRowsFromLedger(sourceRows, Date.now())[0]?.contractRevision, preDispatchContractRevision(f.old));
  let latest = new Map<string, StatusProjection>();
  let dispatches = 0;
  const result = await runDaemon(f.plan(f.corrected), {
    refreshMerged: () => { latest = f.project(f.corrected); return () => false; },
    isIndependentFailureBlocked: (id) => latest.get(id)?.independentFailureBlocked === true,
    categorizedRefusalRejoinFor: (id) => latest.get(id)?.categorizedRefusalRejoin,
    readTerminalPreDispatchRefusalRevisions: () => terminalPreDispatchRefusalRevisions(f.state),
    runOne: async () => {
      dispatches++;
      assert.equal(f.project(f.corrected).get(f.old.id)?.categorizedRefusalRejoin?.receiptRecorded, true,
        "a fresh projection sees the durable admission reason");
      f.append({ task_id: f.old.id, run_id: "retry", step: "run.start" });
      assert.deepEqual(f.select(f.corrected), [], "run.start spends the old source's opportunity");
      f.append({ task_id: f.old.id, run_id: "retry", step: "verdict", verdict: "no_pr",
        terminal_class: "harness_commit_refused", report_excerpt: report });
      holdTaskForRefusal(f.state, f.corrected, extractRefusal(report), "retry");
      return { taskId: f.old.id, runId: "retry", merged: false, costUsd: 0, verdict: "no_pr" };
    },
    log: (step, fields = {}) => f.append({ step, run_id: "daemon", ...fields }),
    sleep: async () => {},
  }, { max: 1 });
  assert.equal(result.stopReason, "max_reached");
  assert.equal(dispatches, 1);
  const rows = readFileSync(f.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const receipt = rows.find((row) => row.step === "dispatch.harness_commit_retry" && row.original_refusal === "categorized_worker_refusal");
  assert.equal(receipt.original_run_id, sourceRun);
  assert.equal(receipt.refused_contract_revision, preDispatchContractRevision(f.old));
  assert.equal(receipt.contract_revision, preDispatchContractRevision(f.corrected));
  assert.equal(receipt.reason, "categorized refusal contract changed");
  assert.deepEqual(f.select(f.corrected), [], "new refusal holds the new contract");
  const amendedAgain = { ...f.corrected, files: [...f.corrected.files!, "src/next.ts"] };
  assert.equal(f.select(amendedAgain).length, 1, "the new source can earn its own correction");
  const hold = JSON.parse(readFileSync(join(f.state, "dispatch-repair", `${f.old.id}.json`), "utf8"));
  assert.equal(hold.sourceRunId, "retry");
});

test("ordinary failures and unverified refusal contracts remain held", () => {
  for (const kind of ["ordinary", "unchanged", "comment-only", "unrelated", "missing-hold", "corrupt-hold",
    "unreadable-hold", "missing-source", "wrong-source", "wrong-hold", "later-failure", "operator-hold", "dependency",
    "generic-harness-retry", "no-start", "no-run-id", "no-amendment", "null-hold", "nonterminal-hold", "dispatch-hold", "human",
    "malformed-revision", "mismatched-source-revision"] as const) {
    const f = fixture();
    let task: Task = f.corrected;
    const holdPath = join(f.state, "dispatch-repair", `${f.old.id}.json`);
    if (kind === "unchanged" || kind === "comment-only" || kind === "unrelated") task = { ...f.old, sourcePath: "comment-only.yaml" };
    if (kind === "ordinary" || kind === "missing-source" || kind === "no-start" || kind === "no-run-id" || kind === "no-amendment") {
      const rows = readFileSync(f.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const changed = kind === "ordinary" ? rows.map((row) => row.step === "verdict" ? { ...row, report_excerpt: "ordinary task failure" } : row)
        : kind === "missing-source" ? rows.filter((row) => row.step !== "verdict")
          : kind === "no-start" ? rows.filter((row) => row.step !== "run.start")
            : kind === "no-amendment" ? rows.filter((row) => row.step !== "refusal_amendment.drafted")
              : rows.map((row) => row.step === "verdict" ? { ...row, run_id: null } : row);
      writeFileSync(f.ledgerPath, changed.map((row) => JSON.stringify(row)).join("\n") + "\n");
    }
    if (kind === "missing-hold") rmSync(holdPath);
    if (kind === "corrupt-hold") writeFileSync(holdPath, "{");
    if (kind === "null-hold") writeFileSync(holdPath, "null");
    if (kind === "unreadable-hold") {
      rmSync(holdPath);
      mkdirSync(holdPath);
    }
    if (kind === "wrong-source" || kind === "wrong-hold") {
      const hold = JSON.parse(readFileSync(holdPath, "utf8"));
      writeFileSync(holdPath, JSON.stringify({ ...hold, ...(kind === "wrong-source" ? { sourceRunId: "another-run" } : { verdict: "not the worker refusal" }) }));
    }
    if (kind === "later-failure") f.append({ task_id: f.old.id, run_id: "t99-branch-gap", step: "dispatch.blocked_independent", verdict: "failed" });
    if (kind === "operator-hold") task = { ...task, status: "blocked" };
    if (kind === "dispatch-hold") task = { ...task, dispatch_hold: true };
    if (kind === "human") task = { ...task, verify: "human" };
    if (kind === "nonterminal-hold") {
      const hold = JSON.parse(readFileSync(holdPath, "utf8"));
      writeFileSync(holdPath, JSON.stringify({ ...hold, escalated: false }));
    }
    if (kind === "malformed-revision") {
      const hold = JSON.parse(readFileSync(holdPath, "utf8"));
      writeFileSync(holdPath, JSON.stringify({ ...hold, preDispatchContractRevision: "unverified" }));
    }
    if (kind === "mismatched-source-revision") {
      f.append({ task_id: f.old.id, run_id: sourceRun, step: "verdict", verdict: "no_pr",
        terminal_class: "harness_commit_refused", report_excerpt: report,
        pre_dispatch_contract_revision: preDispatchContractRevision(f.corrected) });
    }
    if (kind === "dependency") task = { ...task, depends_on: ["CONSOLE-T99"] };
    if (kind === "generic-harness-retry") {
      writeFileSync(holdPath, "{");
      f.append({ task_id: f.old.id, run_id: "daemon", step: "dispatch.harness_commit_retry",
        original_run_id: sourceRun, original_verdict: "no_pr", original_refusal: "harness_commit_refused", harness_commit_refused: true });
    }
    assert.deepEqual(f.select(task), [], kind);
  }
});
