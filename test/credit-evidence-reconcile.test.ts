/**
 * W1-T2729 — the dispatch and lint credit surfaces are intentionally different. This suite
 * proves the reconciler reports that difference without becoming a third credit writer.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CREDIT_EVIDENCE_TEXT_ROW_LIMIT,
  lintCreditSignals,
  reconcileCreditEvidence,
  renderCreditEvidenceReport,
} from "../src/lib/credit-evidence-reconcile.js";
import { statusCommand } from "../src/run-task.js";

const REPO_ROOT = join(import.meta.dirname, "..");

function dumpOf(...entries: Array<[subject: string, body?: string]>): string {
  return entries.map(([subject, body]) => `${subject}\x00${body ?? ""}`).join("\x01") + "\x01";
}

test("reports every task's four signals and flags both directions of disagreement", () => {
  const report = reconcileCreditEvidence(
    ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5", "W1-T6"],
    dumpOf(
      ["fix(worker): implement W1-T3 (#103)"],
      ["feat(router): land W1-T4 (#104)", "Remudero-Task: W1-T4"],
      ["chore(plan): file W1-T5 (#105)", "Remudero-Task: W1-T5"],
      ["fix(worker): implement W1-T60 (#160)"],
    ),
    [
      { number: 101, url: "https://github.com/o/r/pull/101", headRefName: "hand/pr-101", body: "Remudero-Task: W1-T1" },
      { number: 102, url: "https://github.com/o/r/pull/102", headRefName: "run-W1-T2-1788000000000", body: "" },
      { number: 104, url: "https://github.com/o/r/pull/104", headRefName: "hand/pr-104", body: "Remudero-Task: W1-T4" },
    ],
  );

  assert.equal(report.tasks.length, 6, "no open task is silently omitted");
  assert.deepEqual(
    report.tasks.map((row) => ({
      id: row.taskId,
      dispatchTrailer: row.signals.dispatchTrailer,
      dispatchHeadBranch: row.signals.dispatchHeadBranch,
      lintTrailer: row.signals.lintTrailer,
      lintSubject: row.signals.lintSubject,
      disagreement: row.disagreement,
    })),
    [
      { id: "W1-T1", dispatchTrailer: true, dispatchHeadBranch: false, lintTrailer: false, lintSubject: false, disagreement: "dispatch_only" },
      { id: "W1-T2", dispatchTrailer: false, dispatchHeadBranch: true, lintTrailer: false, lintSubject: false, disagreement: "dispatch_only" },
      { id: "W1-T3", dispatchTrailer: false, dispatchHeadBranch: false, lintTrailer: false, lintSubject: true, disagreement: "lint_only" },
      { id: "W1-T4", dispatchTrailer: true, dispatchHeadBranch: false, lintTrailer: true, lintSubject: true, disagreement: null },
      { id: "W1-T5", dispatchTrailer: true, dispatchHeadBranch: false, lintTrailer: false, lintSubject: false, disagreement: "dispatch_only" },
      { id: "W1-T6", dispatchTrailer: false, dispatchHeadBranch: false, lintTrailer: false, lintSubject: false, disagreement: null },
    ],
  );
  assert.deepEqual(report.disagreements.map((row) => row.taskId), ["W1-T1", "W1-T2", "W1-T3", "W1-T5"]);
  assert.deepEqual(lintCreditSignals("W1-T4", dumpOf(["feat(router): land W1-T4 (#104)", "Remudero-Task: W1-T4"])), {
    lintTrailer: true,
    lintSubject: true,
  });
});

test("the human view states when both surfaces agree and has no correction candidate", () => {
  const report = reconcileCreditEvidence(["W1-T7"], "", []);
  assert.equal(renderCreditEvidenceReport(report, "origin/main"), [
    "── CREDIT EVIDENCE ─────────────────────────────────────",
    "  1 open task(s) checked on origin/main; 0 dispatch/lint disagreement(s)",
    "  no correction candidates",
  ].join("\n"));
});

test("each disagreement is an operator-confirmable rmd correct candidate and never applies credit", () => {
  const taskIds = Object.freeze(["W1-T10", "W1-T11"]);
  const mergedPrs = Object.freeze([
    Object.freeze({
      number: 210,
      url: "https://github.com/o/r/pull/210",
      headRefName: "run-W1-T10-1788000000000",
      body: "",
    }),
  ]);
  const report = reconcileCreditEvidence(
    taskIds,
    dumpOf(["fix(queue): implement W1-T11 (#211)"]),
    mergedPrs,
  );

  assert.deepEqual(report.candidates, [
    {
      taskId: "W1-T10",
      disagreement: "dispatch_only",
      prNumber: 210,
      prUrl: "https://github.com/o/r/pull/210",
      command: "rmd correct W1-T10 --pr 210",
      requiresOperatorConfirmation: true,
    },
    {
      taskId: "W1-T11",
      disagreement: "lint_only",
      prNumber: 211,
      prUrl: undefined,
      command: "rmd correct W1-T11 --pr 211",
      requiresOperatorConfirmation: true,
    },
  ]);
  assert.deepEqual(taskIds, ["W1-T10", "W1-T11"], "the task input remains unchanged");
  assert.equal(mergedPrs[0]?.body, "", "the GitHub evidence input remains unchanged");

  const source = readFileSync(join(REPO_ROOT, "src/lib/credit-evidence-reconcile.ts"), "utf8");
  assert.doesNotMatch(source, /applyCorrection|appendLedger|writeFile|appendFile|createWriteStream/);
});

test("the reconciler is reachable from the CLI status path rather than an inert producer", () => {
  const source = readFileSync(join(REPO_ROOT, "src/run-task.ts"), "utf8");
  const statusStart = source.indexOf("export async function statusCommand(");
  const serveStart = source.indexOf("// ── rmd serve", statusStart);
  assert.ok(statusStart >= 0 && serveStart > statusStart);
  assert.match(source.slice(statusStart, serveStart), /reconcileCreditEvidence\(/);
});

test("rmd status JSON exposes the complete report while text remains a bounded disagreement view", async () => {
  const reconcileCalls: Array<{ taskIds: readonly string[]; dump: string; mergedPrCount: number }> = [];
  const baseDeps = {
    loadConfig: () => ({ root: "/state", claudeBin: "/bin/false" }) as never,
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => "/missing/ledger.ndjson",
    repoRoot: "/repo",
    github: {
      listMergedHeadBranches: () => [
        { number: 301, url: "https://github.com/o/r/pull/301", state: "MERGED", headRefName: "run-W1-T30-1788000000000" },
      ],
    } as never,
    buildStatusBoard: () => ({ liveness: { services: [] } }) as never,
    renderStatusBoardText: () => "STATUS",
    readLedgerLines: () => [],
    loadPlan: () => ({ tasks: [{ id: "W1-T30", status: "queued" }, { id: "W1-T31", status: "queued" }] }) as never,
    readMergeEvidenceLog: () => ({ dump: dumpOf(["fix(x): implement W1-T31 (#302)"]), ref: "origin/main" }),
    reconcileCreditEvidence: (
      taskIds: readonly string[],
      dump: string,
      mergedPrs: ReadonlyArray<{ number: number; url: string; headRefName?: string; body?: string }>,
    ) => {
      reconcileCalls.push({ taskIds, dump, mergedPrCount: mergedPrs.length });
      return reconcileCreditEvidence(taskIds, dump, mergedPrs);
    },
  };

  const jsonLines: string[] = [];
  assert.equal(await statusCommand(["--json"], { ...baseDeps, out: (line) => jsonLines.push(line) }), 0);
  const parsed = JSON.parse(jsonLines[0]);
  assert.equal(parsed.creditEvidence.available, true);
  assert.deepEqual(parsed.creditEvidence.report.tasks.map((row: { taskId: string }) => row.taskId), ["W1-T30", "W1-T31"]);
  assert.deepEqual(parsed.creditEvidence.report.candidates.map((row: { command: string }) => row.command), [
    "rmd correct W1-T30 --pr 301",
    "rmd correct W1-T31 --pr 302",
  ]);
  assert.deepEqual(reconcileCalls[0], {
    taskIds: ["W1-T30", "W1-T31"],
    dump: dumpOf(["fix(x): implement W1-T31 (#302)"]),
    mergedPrCount: 1,
  });

  const textLines: string[] = [];
  assert.equal(await statusCommand([], { ...baseDeps, out: (line) => textLines.push(line) }), 0);
  assert.match(textLines[0], /CREDIT EVIDENCE/);
  assert.match(textLines[0], /2 dispatch\/lint disagreement/);
  assert.match(textLines[0], /candidates are proposals only; each requires operator confirmation/);
});

test("the human view caps a large disagreement population while preserving every row in JSON-shaped data", () => {
  const taskIds = Array.from({ length: CREDIT_EVIDENCE_TEXT_ROW_LIMIT + 3 }, (_, index) => `W1-T${1_000 + index}`);
  const mergedPrs = taskIds.map((taskId, index) => ({
    number: 1_000 + index,
    url: `https://github.com/o/r/pull/${1_000 + index}`,
    headRefName: `run-${taskId}-1788000000000`,
  }));
  const report = reconcileCreditEvidence(taskIds, "", mergedPrs);

  assert.equal(report.disagreements.length, CREDIT_EVIDENCE_TEXT_ROW_LIMIT + 3);
  const text = renderCreditEvidenceReport(report, "origin/main");
  assert.equal((text.match(/^  ! /gm) ?? []).length, CREDIT_EVIDENCE_TEXT_ROW_LIMIT);
  assert.match(text, /\.\.\. 3 more disagreement\(s\); use --json for the complete report/);
  assert.doesNotMatch(text, new RegExp(taskIds.at(-1)!));
});
