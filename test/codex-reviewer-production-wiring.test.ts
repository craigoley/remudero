import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnCodexWorker } from "../src/lib/worker-provider.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { runReview } from "../src/run-task.js";

test("W1-T2829/W1-T2868: runReview gives Codex an exact materialized checkout under the read-only sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-review-wiring-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-codex-review-gh-"));
  const oldPath = process.env.PATH;
  try {
    const sourceDir = join(root, "source");
    mkdirSync(join(sourceDir, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", sourceDir]);
    execFileSync("git", ["-C", sourceDir, "config", "user.name", "RMD Test"]);
    execFileSync("git", ["-C", sourceDir, "config", "user.email", "rmd-test@example.invalid"]);
    writeFileSync(join(sourceDir, "src", "example.ts"), "export const fixed = true;\n", "utf8");
    execFileSync("git", ["-C", sourceDir, "add", "src/example.ts"]);
    execFileSync("git", ["-C", sourceDir, "commit", "-q", "-m", "fixture"]);
    const headSha = execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const settingsFile = join(root, "settings.json");
    const ledgerPath = join(root, "ledger.ndjson");
    const workerHome = join(root, "worker-home");
    mkdirSync(workerHome);
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }), "utf8");
    writeFileSync(
      join(binDir, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "api "*)
    case "$*" in
      *pulls/*) echo '{"number":2829,"html_url":"https://github.com/acme/remudero/pull/2829","updated_at":"t","body":"","head":{"ref":"b","sha":"${headSha}"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") printf '%s\n' 'diff --git a/src/example.ts b/src/example.ts' '+export const fixed = true;' ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${oldPath}`;

    let observedTools: string[] | undefined;
    let observedSpawn: SpawnWorkerArgs | undefined;
    let reviewerCwdWasGit: boolean | undefined;
    let reviewerHead: string | undefined;
    let codexArgs: string[] = [];
    let reviewerError: string | undefined;
    const reviewerSpawnWorker = async (spawnArgs: SpawnWorkerArgs): Promise<WorkerResult> => {
      observedSpawn = spawnArgs;
      observedTools = spawnArgs.tools;
      try {
        reviewerCwdWasGit = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: spawnArgs.cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() === "true";
        reviewerHead = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: spawnArgs.cwd,
          encoding: "utf8",
        }).trim();
      } catch {
        reviewerCwdWasGit = false;
      }

      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
      stdin.on("finish", () => {
        stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-review-2829" })}\n`);
        stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
        stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "REVIEW_VERDICT 1: PASS" } })}\n`);
        stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })}\n`);
        stdout.end();
        queueMicrotask(() => proc.emit("exit", 0));
      });
      return spawnCodexWorker(
        {
          ...spawnArgs,
          workerHome,
          containment: {
            spawn: (options) => {
              codexArgs = options.args;
              return { process: proc as never, pid: 28_290 };
            },
            teardown: () => {},
          },
        },
        spawnArgs.config!,
        { model: "gpt-5.5", effort: "high" },
      ) as Promise<WorkerResult>;
    };

    const result = await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/2829",
      task: {
        id: "W1-T2829",
        files: ["src/example.ts"],
        acceptance: [{ claim: "the production reviewer has only read-only inspection tools", proof: "grep: fixed in src/example.ts" }],
      },
      report: "The production reviewer has only read-only inspection tools.",
      settingsFile,
      config: {
        claudeBin: "/unused",
        root,
        workerProviders: { enabled: ["codex"], codexBin: "/bin/sh" },
      } as never,
      log: (step: string, extra?: Record<string, unknown>) => {
        if (step === "review.reviewer.error") reviewerError = String(extra?.error);
      },
      say: () => {},
      account: (worker: WorkerResult) => worker,
      spawnReviewer: true,
      reviewerSpawnWorker,
      reviewerMount: { model: "gpt-5.5", effort: "high", maxTurns: 10, contextBudget: 120_000 },
      headCheckoutDir: sourceDir,
      ledgerPath,
      runId: "RUN-W1-T2829",
      disarm: () => "not-armed" as const,
      arm: () => ({ armed: false, reason: "test" }),
    } as never);

    assert.equal(result.reviewerOutcome, "success", `the fake Codex semantic reviewer must complete through runReview: ${reviewerError ?? "no error logged"}`);
    assert.equal(reviewerCwdWasGit, true, "the reviewer cwd must be a real Git checkout");
    assert.equal(reviewerHead, headSha, "the reviewer must inspect the exact PR head");
    assert.deepEqual(observedTools, ["Read", "Grep", "Glob", "Bash"], "the production call site must preserve inspection while excluding write tools");
    assert.equal(observedSpawn?.model, "gpt-5.5");
    assert.equal(observedSpawn?.effort, "high");
    assert.equal(observedSpawn?.maxTurns, 10);
    assert.match(observedSpawn?.prompt ?? "", /TASK UNDER REVIEW: W1-T2829/);
    assert.match(observedSpawn?.prompt ?? "", /REVIEW_VERDICT <n>:/);
    assert.equal(existsSync(observedSpawn?.cwd ?? root), false, "the semantic review scratch cwd must be removed after the spawn");
    assert.equal(codexArgs.includes("--skip-git-repo-check"), false, "a materialized repository must not need the non-repository bypass");
    assert.deepEqual(codexArgs.slice(codexArgs.indexOf("--sandbox"), codexArgs.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
    assert.equal(execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), headSha);
    assert.equal(execFileSync("git", ["-C", sourceDir, "status", "--porcelain"], { encoding: "utf8" }), "");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});
