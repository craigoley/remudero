import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { caseFileCommand, parseCasePrSnapshot } from "../src/lib/report-commands.js";
import type { Task } from "../src/lib/plan.js";
import type { StatusProjection } from "../src/lib/status.js";
import { buildBatchedGithub } from "../src/lib/status.js";

const task = { id: "W1-T4607", title: "Case file", repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "high", status: "queued", attempts: 0 } as Task;
const head = "a".repeat(40);

test("PR parser keeps an unreadable rollup separate from an observed empty rollup", () => {
  const basic = { number: 7449, url: "https://github.com/craigoley/remudero/pull/7449", state: "MERGED",
    headRefOid: head, body: `Remudero-Task: ${task.id}`, mergedAt: "2026-09-27T13:52:28Z" };
  const unread = parseCasePrSnapshot(basic, "2026-09-27T14:00:00Z");
  assert.equal(unread.state, "observed");
  if (unread.state === "observed") assert.equal(unread.value.checks, null);
  const empty = parseCasePrSnapshot({ ...basic, statusCheckRollup: [] }, "2026-09-27T14:00:00Z");
  assert.equal(empty.state, "observed");
  if (empty.state === "observed") assert.deepEqual(empty.value.checks, []);
  const exact = parseCasePrSnapshot({ ...basic, statusCheckRollup: [
    { __typename: "StatusContext", context: "remudero-review", state: "SUCCESS" },
    { __typename: "CheckRun", name: "ci-gate", conclusion: "SUCCESS", status: "COMPLETED" },
  ] }, "2026-09-27T14:00:00Z");
  assert.equal(exact.state, "observed");
  if (exact.state === "observed") assert.deepEqual(exact.value.checks?.map((check) => check.state), ["success", "success"]);
  assert.deepEqual(parseCasePrSnapshot({ ...basic, headRefOid: "short" }, "2026-09-27T14:00:00Z"),
    { state: "unavailable", reason: "pr-identity-invalid" });
  const failed = parseCasePrSnapshot({ ...basic, statusCheckRollup: [
    { __typename: "CheckRun", name: "ci-gate", conclusion: "FAILURE" },
  ] }, "2026-09-27T14:00:00Z");
  assert.equal(failed.state, "observed");
  if (failed.state === "observed") assert.equal(failed.value.checks?.[0].state, "failure");
});

test("operator case-file command streams the real ledger union and emits sourced JSON", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-case-command-"));
  writeFileSync(join(stateDir, "ledger.ndjson"), JSON.stringify({ ts: "2026-09-27T13:00:00.000Z", step: "run.start",
    task_id: task.id, run_id: `${task.id}-1790514000000` }) + "\n");
  const printed: string[] = [];
  const code = await caseFileCommand([task.id, "--json"], {
    stateDir, nowIso: () => "2026-09-27T14:00:00.000Z", resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    readTask: () => task,
    readProjection: () => ({ taskId: task.id, status: "merged", merged: true, source: "trailer", prNumber: 7449 } as StatusProjection),
    readPr: () => parseCasePrSnapshot({ number: 7449, url: "https://github.com/craigoley/remudero/pull/7449",
      state: "MERGED", headRefOid: head, body: `Remudero-Task: ${task.id}`, mergedAt: "2026-09-27T13:52:28Z",
      statusCheckRollup: [
        { __typename: "StatusContext", context: "remudero-review", state: "SUCCESS" },
        { __typename: "CheckRun", name: "ci-gate", conclusion: "SUCCESS" },
      ] }, "2026-09-27T14:00:00.000Z"),
    out: (line) => printed.push(line),
  });
  assert.equal(code, 0);
  const file = JSON.parse(printed[0]);
  assert.equal(file.ledger.state, "observed");
  assert.equal(file.runs[0].runId, `${task.id}-1790514000000`);
  assert.equal(file.pr.state, "observed");
  assert.equal(file.review.state, "observed");
  assert.equal(file.mergedSource.state, "observed");
  assert.equal(file.deployment.state, "unavailable");
});

test("operator command reports a failed PR read as unavailable and refuses invalid arguments", async () => {
  const printed: string[] = [];
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-case-command-empty-"));
  const seams = {
    stateDir, nowIso: () => "2026-09-27T14:00:00.000Z", resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    readTask: () => task,
    readProjection: () => ({ taskId: task.id, status: "running", merged: false, source: "ledger", prNumber: 7449 } as StatusProjection),
    readPr: () => { throw new Error("network unavailable"); },
    out: (line: string) => printed.push(line), err: (_line: string) => {},
  };
  assert.equal(await caseFileCommand([task.id], seams), 0);
  const file = JSON.parse(printed[0]);
  assert.equal(file.ledger.state, "unavailable");
  assert.equal(file.pr.state, "unavailable");
  assert.match(file.pr.reason, /github-read-failed/);
  assert.equal(await caseFileCommand(["not-a-task"], seams), 2);
});

test("operator command's default projection uses the batched GitHub gateway and one PR head read", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-case-default-projection-"));
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  const printed: string[] = [];
  let prReads = 0;
  const code = await caseFileCommand([task.id], {
    stateDir, nowIso: () => "2026-09-27T14:00:00.000Z", resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    loadConfig: () => ({ root: stateDir, claudeBin: "/bin/true" }), readTask: () => task,
    buildGithub: (owner, repo) => buildBatchedGithub(owner, repo, { fetchAll: () => [{
      number: 7449, url: "https://github.com/craigoley/remudero/pull/7449", state: "OPEN",
      headRefName: `run-${task.id}-1790514000000`, headRefOid: head, body: `Remudero-Task: ${task.id}`,
    }] }),
    readGhPr: () => { prReads += 1; return { number: 7449, url: "https://github.com/craigoley/remudero/pull/7449",
      state: "OPEN", headRefOid: head, body: `Remudero-Task: ${task.id}`, mergedAt: null, statusCheckRollup: [] }; },
    out: (line) => printed.push(line),
  });
  assert.equal(code, 0);
  assert.equal(prReads, 1);
  assert.equal(JSON.parse(printed[0]).pr.state, "observed");
});

test("operator command with no projected PR performs no PR read", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-case-no-pr-"));
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  const printed: string[] = [];
  const code = await caseFileCommand([task.id], {
    stateDir, nowIso: () => "2026-09-27T14:00:00.000Z", resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    readTask: () => task, readProjection: () => ({ taskId: task.id, status: "queued", merged: false, source: "none" } as StatusProjection),
    readPr: () => { throw new Error("must not read PR"); }, out: (line) => printed.push(line),
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(printed[0]).pr.reason, "no-pr-in-current-projection");

  const throttled: string[] = [];
  const throttledCode = await caseFileCommand([task.id], {
    stateDir, nowIso: () => "2026-09-27T14:00:00.000Z", resolveOwnerRepo: () => ({ owner: "craigoley", repo: "remudero" }),
    readTask: () => task, readProjection: () => ({ taskId: task.id, status: "queued", merged: false, source: "throttled",
      indeterminate: true, unavailableReason: "rate_limit" } as StatusProjection),
    readPr: () => { throw new Error("must not read PR"); }, out: (line) => throttled.push(line),
  });
  assert.equal(throttledCode, 0);
  assert.equal(JSON.parse(throttled[0]).pr.reason, "projection-indeterminate:rate_limit",
    "a throttled status read with no PR number is not an observed absence of a PR");
});
