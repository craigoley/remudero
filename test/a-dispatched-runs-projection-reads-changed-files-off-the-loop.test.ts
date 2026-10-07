import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlanFromYaml } from "../src/lib/plan.js";
import { buildBatchedGithub, projectPlan, type BatchedPr } from "../src/lib/status.js";
// A NAMESPACE import: at the merge base `createDaemonGatewayFactory` does not exist, and a named import would fail
// the whole file at load, which the reviewer reads as "never ran" rather than as a red.
import * as runTask from "../src/run-task.js";

/**
 * W1-T6259 — A DISPATCHED RUN'S PROJECTION READS CHANGED FILES OFF THE LOOP. The daemon's lane gateways were built
 * without `changedFilesCache`, so projectPlan → uncreditedBuildWarning fell back to the synchronous memo and shelled
 * `gh api …/pulls/<n>/files` once per candidate PR on the daemon thread: one unbroken 160.8 s block in a live CPU
 * profile (2026-10-07 18:32Z).
 *
 * FIXTURES ONLY: the state root, the ledger and every PR row are throwaway data; no gh is ever run.
 */

const TASK = "W1-T9001";
// A merged build that names the task in its body but carries no trailer and no run branch: uncredited, so
// uncreditedBuildWarning asks for its changed files.
const prs: BatchedPr[] = [{ number: 5, url: "https://github.com/o/r/pull/5", state: "MERGED", headRefName: "feature-x",
  title: "build the thing", body: `Implements ${TASK}.` }];

function fixture(): { root: string; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-t6259-"));
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return { root, ledgerPath };
}

const plan = () => loadPlanFromYaml([
  `- id: ${TASK}`, '  title: "fixture task"', "  repo: r", "  type: implement", "  verify: auto", "  depends_on: []",
  "  budget_usd: 1.00", "  risk: low", "  files: [src/x.ts]", "  status: queued", "  attempts: 0",
  "  acceptance:", '    - claim: "x"', '      proof: "grep: x in src/x.ts"', "",
].join("\n"), "fixture");

function recordingExec(calls: string[][]): (args: string[]) => string {
  return (args) => {
    calls.push(args);
    return args.some((a) => a.includes("/files")) ? "src/x.ts\n" : "[]";
  };
}

test("W1-T6259: a lane gateway reads changed files through the non-blocking provider", async () => {
  const { root } = fixture();
  const calls: string[][] = [];
  let fetched = 0;
  const factory = runTask.createDaemonGatewayFactory(root, () => {}, {
    exec: recordingExec(calls), fetchAll: () => prs,
    fetchChangedFiles: async () => { fetched++; return ["src/x.ts"]; },
  });
  const github = factory("o", "r");
  assert.equal(github.changedFiles?.(prs[0]!.url), undefined, "a miss answers at once, unknown");
  assert.deepEqual(calls.filter((a) => a.some((x) => x.includes("/files"))), [], "no synchronous gh for changed files");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fetched, 1, "the read ran asynchronously");
  assert.deepEqual(github.changedFiles?.(prs[0]!.url), ["src/x.ts"], "the next read is served from the cache");
  assert.equal(factory("o", "r").changedFiles?.(prs[0]!.url)?.[0], "src/x.ts", "one cache per repository, shared");
});

test("W1-T6259: a dispatched run projects with no synchronous changed-files gh call", () => {
  // Positive control: a gateway with no provider reaches changedFiles synchronously on this fixture.
  const control: string[][] = [];
  const plain = fixture();
  projectPlan(plan(), { ledgerPath: plain.ledgerPath, github: buildBatchedGithub("o", "r", { exec: recordingExec(control), fetchAll: () => prs }) });
  assert.ok(control.some((a) => a.some((x) => x.includes("/pulls/5/files"))), "control: the fixture asks for changed files");

  const { root, ledgerPath } = fixture();
  const calls: string[][] = [];
  const github = runTask.createDaemonGatewayFactory(root, () => {}, {
    exec: recordingExec(calls), fetchAll: () => prs, fetchChangedFiles: async () => ["src/x.ts"],
  })("o", "r");
  projectPlan(plan(), { ledgerPath, github });
  assert.deepEqual(calls.filter((a) => a.some((x) => x.includes("/files"))), [], "the daemon's gateway never shells for changed files");
});
