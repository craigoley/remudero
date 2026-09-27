import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { buildTaskCaseFile, readTaskCaseLedger, type CaseLedgerRead, type CasePrRead } from "../src/lib/task-case-file.js";
import type { Task } from "../src/lib/plan.js";
import type { StatusProjection } from "../src/lib/status.js";

const now = "2026-09-27T14:00:00.000Z";
const task = { id: "W1-T4607", title: "Evidence case file", repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "high", status: "queued", attempts: 0 } as Task;
const projection = { taskId: task.id, status: "merged", merged: true, source: "trailer",
  prNumber: 7449, prUrl: "https://github.com/craigoley/remudero/pull/7449" } as StatusProjection;
const sha = "a".repeat(40);
const prRead: CasePrRead = { state: "observed", value: { number: 7449, url: projection.prUrl!, state: "MERGED", headSha: sha,
  body: `Remudero-Task: ${task.id}`, mergedAt: "2026-09-27T13:52:28Z", readAt: now,
  checks: [{ name: "remudero-review", state: "success" }, { name: "ci-gate", state: "success" }] } };
const row = (step: string, rest: Record<string, unknown>) => ({ ts: "2026-09-27T13:00:00.000Z", task_id: task.id,
  run_id: `${task.id}-1790514000000`, step, ...rest });
const ledger = (rows: Record<string, unknown>[]): CaseLedgerRead => ({ state: "observed", rows,
  asOf: now, windowStart: "2026-08-28T14:00:00.000Z", forms: { gzip: 1, plain: 1, live: 1 },
  unread: [], malformed: 0, truncated: false });

test("case file joins one owned assignment and separates selected, served, cash, merge, deployment and runtime", () => {
  const rows = [
    row("run.start", {}),
    row("worker.assignment", { worker_assignment: { id: "a1", selected: { provider: "cash", model: "gpt-oss-120b" } } }),
    row("worker.attempt", { selection_assignment_id: "a1", served_model: "gpt-6-luna", billing_mode: "api", total_cost_usd: 0.02 }),
    row("worker.attempt", { selection_assignment_id: "other", served_model: "claude-opus-5-5", billing_mode: "api", total_cost_usd: 5 }),
    row("pr.opened", { pr_url: projection.prUrl }),
    row("verdict", { selection_assignment_id: "a1", verdict: "passed" }),
  ];
  const result = buildTaskCaseFile({ task, projection, ledger: ledger(rows), prRead, asOf: now });
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].selectedModel, "gpt-oss-120b");
  assert.equal(result.runs[0].servedModel, "gpt-6-luna");
  assert.equal(result.runs[0].costUsd, 0.02);
  assert.equal(result.review.state, "observed");
  assert.equal(result.ci.state, "observed");
  assert.equal(result.mergedSource.state, "observed");
  assert.equal(result.deployment.state, "unavailable");
  assert.equal(result.runtime.state, "unavailable");
});

test("case file refuses GitHub read failure, wrong PR identity, absent checks, and an open merge", () => {
  const base = { task, projection, ledger: ledger([]), asOf: now };
  const unread = buildTaskCaseFile({ ...base, prRead: { state: "unavailable", reason: "auth" } });
  assert.equal(unread.pr.state, "unavailable");
  assert.equal(unread.mergedSource.state, "pending");
  const wrong = buildTaskCaseFile({ ...base, prRead: { state: "observed", value: { ...prRead.value, number: 7450 } } });
  assert.equal(wrong.pr.state, "stale");
  assert.equal(wrong.review.state, "unavailable");
  const noChecks = buildTaskCaseFile({ ...base, prRead: { state: "observed", value: { ...prRead.value, checks: null } } });
  assert.equal(noChecks.ci.state, "unavailable");
  const open = buildTaskCaseFile({ ...base, projection: { ...projection, merged: false },
    prRead: { state: "observed", value: { ...prRead.value, state: "OPEN", mergedAt: null } } });
  assert.equal(open.mergedSource.state, "pending");
});

test("case file with unreadable ledger does not publish partial run evidence", () => {
  const result = buildTaskCaseFile({ task, projection, ledger: { ...ledger([row("run.start", {})]),
    state: "unavailable", reason: "ledger-source-unreadable" }, prRead, asOf: now });
  assert.equal(result.ledger.state, "unavailable");
  assert.deepEqual(result.runs, []);
});

test("three-form ledger read sees gzip, plain, and live with exact task-owned rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-case-file-"));
  const record = (id: string, suffix: string) => JSON.stringify({ ts: "2026-09-27T13:00:00.000Z", task_id: id,
    run_id: `${id}-${suffix}`, step: "run.start" }) + "\n";
  writeFileSync(join(dir, "ledger.2026-09-27T13-00-00-000Z.ndjson.gz"), gzipSync(record(task.id, "a")));
  writeFileSync(join(dir, "ledger.2026-09-27T13-10-00-000Z.ndjson"), record(task.id, "b"));
  writeFileSync(join(dir, "ledger.ndjson"), record(task.id, "c") + record(task.id, "b") + record("W1-T99", "x"));
  const result = await readTaskCaseLedger(dir, task.id, now);
  assert.equal(result.state, "observed");
  assert.deepEqual(result.forms, { gzip: 1, plain: 1, live: 1 });
  assert.equal(result.rows.length, 3);
  const limited = await readTaskCaseLedger(dir, task.id, now, { maxRows: 2 });
  assert.equal(limited.state, "unavailable");
  assert.equal(limited.reason, "task-row-bound-exceeded");
  assert.deepEqual(limited.rows, []);
});

test("missing and malformed ledger sources stay unavailable", async () => {
  const empty = mkdtempSync(join(tmpdir(), "rmd-case-file-empty-"));
  assert.equal((await readTaskCaseLedger(empty, task.id, now)).reason, "ledger-corpus-missing");
  writeFileSync(join(empty, "ledger.ndjson"), "{bad-json}\n");
  assert.equal((await readTaskCaseLedger(empty, task.id, now)).reason, "ledger-source-malformed");
  assert.match((await readTaskCaseLedger(join(empty, "ledger.ndjson"), task.id, now)).reason ?? "", /ledger-read-failed/);
});

test("an explicit human gate supplies the next owner without inferring one from prose", () => {
  const result = buildTaskCaseFile({ task, projection: { ...projection, needsHuman: true,
    escalationIssueUrl: "https://github.com/craigoley/remudero/issues/123" }, ledger: ledger([]), prRead, asOf: now });
  assert.deepEqual(result.next, { owner: "operator", action: "https://github.com/craigoley/remudero/issues/123",
    source: "status-escalation-receipt" });
});
