import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bodyVsDiffContractLines, commitMessageContractLines } from "../src/lib/compaction.js";
import type { AlertLaneAlert } from "../src/lib/alert-lane.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildReviewPrompt, reviewerVerdictContract } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { dispatchAlertFixRun, type AlertFixDispatchDeps } from "../src/run-task.js";

const ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "401",
  severity: "medium",
  state: "open",
  createdAt: "2026-10-03T00:00:00Z",
  summary: "unused variable",
  url: "https://github.com/craigoley/remudero/security/code-scanning/401",
  path: "src/lib/some-non-critical-file.ts",
};

const MOUNT: Mount = { model: "fake-model", effort: "low", maxTurns: 5, contextBudget: 1000 };

/** Drive the real `dispatchAlertFixRun` over injected boundaries and return the prompt its spawn received. */
async function capturedAlertFixPrompt(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}prompt-contracts-alert-fix-`));
  let prompt = "";
  const deps: AlertFixDispatchDeps = {
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    renderWorkerSettings: () => "/tmp/fake-settings.json",
    loadMounts: () => ({}) as never,
    resolveMount: () => MOUNT,
    spawn: async (args) => {
      prompt = args.prompt;
      return { sessionId: "s", text: "REPORT\nno pr\n", blocks: [], subtype: "success", isError: false } as unknown as WorkerResult;
    },
    ensureTaskTrailer: () => {},
    checkAcceptance: () => ({ ok: true, message: "fixture" }),
  };
  try {
    await dispatchAlertFixRun("craigoley", "remudero", { root } as Config, ALERT, join(root, "ledger.ndjson"), "ALERT-FIX-PC-1", deps);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return prompt;
}

test("the alert-fix prompt carries the commit message contract", async () => {
  const prompt = await capturedAlertFixPrompt();
  assert.ok(prompt.includes(commitMessageContractLines().join("\n")), "the shared commit contract block is present verbatim");
  assert.ok(prompt.includes(bodyVsDiffContractLines().join("\n")), "the shared body-versus-diff block is present verbatim");
  assert.match(prompt, /header .*must be <= 100 CHARACTERS/s);
});

test("the alert-fix prompt names an explicit pull request title rule", async () => {
  const prompt = await capturedAlertFixPrompt();
  assert.match(prompt, /--title "type\(scope\): subject"/);
  assert.match(prompt, /PR TITLE: a conventional-commit subject of <= 100 characters/);
  assert.doesNotMatch(prompt, /gh pr create --fill --base main/, "the commit-derived title is no longer relied on");
});

test("the alert-fix prompt keeps the alert-fix lane's own report and trailer contract", async () => {
  const prompt = await capturedAlertFixPrompt();
  assert.match(prompt, /origin: alert#/);
  assert.match(prompt, /Remudero-Task: alert-code-scanning-401/);
  assert.match(prompt, /End your REPORT with exactly: PR_URL: <the pull request url>/);
});

const REVIEW_INPUT = {
  task: { id: "W1-T1", acceptance: [{ claim: "a claim", proof: "unit test: some test" }] },
  prUrl: "https://github.com/craigoley/remudero/pull/1",
  owner: "craigoley",
  repo: "remudero",
  headSha: "a".repeat(40),
};

test("the reviewer prompt asks for a one-line explanation, not its reasoning", () => {
  const prompt = buildReviewPrompt(REVIEW_INPUT);
  assert.match(prompt, /End with a REPORT: one line per criterion naming what you ran and observed\./);
  assert.doesNotMatch(prompt, /your reasoning for each/);
  assert.doesNotMatch(prompt, /write out your reasoning/i);
});

test("the machine-readable reviewer verdict contract is byte-identical to its pre-change text", () => {
  // Hashes measured at origin/main 231b7673b, before the wording change in `buildReviewPrompt`.
  const sha = (n: number) => createHash("sha256").update(reviewerVerdictContract(n), "utf8").digest("hex");
  assert.equal(sha(1), "1db6e601901edb8784317fd52a1f3614f21715a39b77700507aba661f4757340");
  assert.equal(sha(3), "7f76ef7ced39530610cd2b5afe2b764dac166e595bdbc0829c27b063b0f8008b");
});
