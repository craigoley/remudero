import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractReviewFindings, recordReviewFindings } from "../src/lib/review-findings.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { projectFlowRow } from "../src/lib/field-trials-flow.js";
import { runReview } from "../src/run-task.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";

async function fixture(fn: (root: string, sha: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rmd-review-findings-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
    execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "changed.ts"), "export const changed = true;\n");
    writeFileSync(join(root, "src", "dependency.ts"), "export const dependent = changed;\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    await fn(root, execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const diff = "diff --git a/src/changed.ts b/src/changed.ts\n+++ b/src/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n";
const base = { owner: "acme", repo: "remudero", prUrl: "https://github.com/acme/remudero/pull/1", diff, criteriaCount: 1 };
const finding = (anchor: unknown) => `REVIEW_FINDING ${JSON.stringify({ criterion: 1, category: "wiring", severity: "medium", mechanism: "The new producer does not reach the consumer", remedy: "Connect the producer", anchor })}`;

test("W1-T4848: a verified finding gets one stable receipt", () => fixture((root, headSha) => {
  const input = { ...base, root, headSha, text: finding({ path: "src/changed.ts", line: 1, kind: "changed" }) };
  const first = extractReviewFindings(input);
  const second = extractReviewFindings(input);
  assert.equal(first.state, "captured");
  assert.equal(first.verifiedCount, 1);
  assert.equal(first.findings[0]?.id, second.findings[0]?.id);
  assert.equal(first.findings[0]?.anchor.status, "verified");
  const rows: Array<Record<string, unknown>> = [];
  const provenance = { provider: "codex", requestedModel: "reviewer", servedModel: "gpt-6-sol", effort: "high", sessionId: "s", selectionAssignmentId: "assignment-1" };
  recordReviewFindings(first, { taskId: "W1-T4848", headSha, prUrl: base.prUrl, decisionDigest: "decision", provenance, log: (step, row) => rows.push({ step, ...row }) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.selection_assignment_id, "assignment-1");
  assert.equal(rows[0]?.served_model, "gpt-6-sol");
  assert.equal(rows[0]?.finding_id, first.findings[0]?.id);
  assert.equal(rows[0]?.criterion_index, 1);
  const projected = projectFlowRow({ ...rows[0], ts: "2026-09-30T00:00:00Z" }, "fingerprint");
  assert.ok(!JSON.stringify(projected).includes("The new producer"), "public telemetry projection never contains raw finding text");
}));

test("W1-T4848: an ungrounded finding is not a catch", () => fixture((root, headSha) => {
  const invented = extractReviewFindings({ ...base, root, headSha, text: finding({ path: "src/invented.ts", line: 1, kind: "changed" }) });
  assert.equal(invented.verifiedCount, 0);
  assert.equal(invented.findings[0]?.anchor.status, "unsupported");
  const stale = extractReviewFindings({ ...base, root, headSha: "f".repeat(40), text: finding({ path: "src/changed.ts", line: 1, kind: "changed" }) });
  assert.equal(stale.verifiedCount, 0);
  const outside = extractReviewFindings({ ...base, root, headSha, text: finding({ path: "src/dependency.ts", line: 1, kind: "dependency" }) });
  assert.equal(outside.verifiedCount, 0);
  const supported = extractReviewFindings({ ...base, root, headSha, text: finding({ path: "src/dependency.ts", line: 1, kind: "dependency", changedProducer: { path: "src/changed.ts", line: 1 } }) });
  assert.equal(supported.verifiedCount, 1);
}));

test("W1-T4848: finding extraction cannot hold a PR", () => fixture((root, headSha) => {
  const absent = extractReviewFindings({ ...base, root, headSha, text: "REVIEW_VERDICT 1: PASS" });
  assert.equal(absent.state, "unavailable");
  assert.equal(absent.verifiedCount, 0);
  const malformed = extractReviewFindings({ ...base, root, headSha, text: "REVIEW_FINDING {broken" });
  assert.equal(malformed.state, "partial");
  assert.equal(malformed.invalidCount, 1);
  const zero = extractReviewFindings({ ...base, root, headSha, text: "REVIEW_FINDINGS: NONE" });
  assert.equal(zero.state, "zero");
  const valid = extractReviewFindings({ ...base, root, headSha, text: finding({ path: "src/changed.ts", line: 1, kind: "changed" }) });
  let attempts = 0;
  recordReviewFindings(valid, { taskId: "W1-T4848", headSha, prUrl: base.prUrl, decisionDigest: "decision", provenance: { provider: null, requestedModel: null, servedModel: null, effort: null, sessionId: null }, log: () => { attempts++; throw new Error("telemetry unavailable"); } });
  assert.equal(attempts, 1);
}));

test("the production reviewer posts status and ledgers a finding only once across replay", () => fixture(async (root, headSha) => {
  const prUrl = base.prUrl;
  const ledgerPath = join(root, "ledger.ndjson");
  const shim = ghShim([
    { when: "pulls/", stdout: JSON.stringify({ number: 1, html_url: prUrl, updated_at: "t", body: "changed", state: "open", head: { ref: "b", sha: headSha } }) },
    { when: "pr diff", stdout: diff },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "api ", stdout: "{}" },
  ], { kind: "review-finding-receipts" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    let spawns = 0;
    const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const review = (runId: string) => runReview({
      owner: "acme", repo: "remudero", prUrl,
      task: { id: "W1-T4848", files: ["src/changed.ts"], acceptance: [{ claim: "changed exists", proof: "grep: changed in src/changed.ts" }] },
      report: "changed", settingsFile: join(root, "settings.json"), config: { root, claudeBin: "/unused" } as never,
      log: (step: string, extra: Record<string, unknown> = {}) => {
        rows.push({ step, extra });
        appendLedger(ledgerPath, { run_id: runId, task_id: "W1-T4848", step, ...extra });
      },
      say: () => {}, account: (worker: WorkerResult) => worker,
      spawnReviewer: true,
      reviewerSpawnWorker: (async (_args: SpawnWorkerArgs): Promise<WorkerResult> => {
        spawns++;
        return {
          sessionId: "finding-session", costUsd: 0, numTurns: 1,
          text: `REVIEW_VERDICT 1: PASS\n${finding({ path: "src/changed.ts", line: 1, kind: "changed" })}`,
          blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], model: "sonnet", provider: "codex", servedModel: "gpt-6-sol", effort: "high",
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        };
      }) as typeof import("../src/lib/worker.js").spawnWorker,
      reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 },
      headCheckoutDir: root, ledgerPath, runId,
      disarm: () => "not-armed" as const, arm: () => ({ armed: false, reason: "test" }),
    } as never);
    const first = await review("finding-first");
    assert.equal(first.state, "success");
    assert.equal(rows.find((row) => row.step === "review.posted")?.extra.finding_capture_state, "captured");
    assert.equal(rows.filter((row) => row.step === "review.finding").length, 1);
    const firstSpawns = spawns; // A sampled decision may also dispatch one shadow judge.
    const second = await review("finding-replay");
    assert.equal(second.decisionDisposition, "replayed");
    assert.equal(rows.filter((row) => row.step === "review.finding").length, 1);
    assert.equal(readLedgerLines(ledgerPath).filter((row) => row.step === "review.finding").length, 1);
    assert.equal(spawns, firstSpawns);
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}));
