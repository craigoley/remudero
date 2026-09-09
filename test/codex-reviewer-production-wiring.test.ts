import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnCodexWorker } from "../src/lib/worker-provider.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { runReview } from "../src/run-task.js";

test("W1-T2946: runReview gives Codex a test-capable disposable review sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-review-wiring-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-codex-review-gh-"));
  const oldPath = process.env.PATH;
  try {
    const sourceDir = join(root, "source");
    mkdirSync(join(sourceDir, "src"), { recursive: true });
    const dependencyRoot = join(root, "dependencies");
    mkdirSync(dependencyRoot);
    const physicalDependencyRoot = realpathSync(dependencyRoot);
    symlinkSync(physicalDependencyRoot, join(sourceDir, "node_modules"), "dir");
    execFileSync("git", ["init", "-q", sourceDir]);
    writeFileSync(join(sourceDir, ".git", "info", "exclude"), "/node_modules\n");
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
  "pr diff") printf '%s\n' 'diff --git a/src/example.ts b/src/example.ts' '+export const fixed = true;' 'diff --git a/src/extra.ts b/src/extra.ts' '+export const extra = true;' ;;
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
    let reviewerNodeModulesLink: string | undefined;
    let codexArgs: string[] = [];
    let codexTmpDir: string | undefined;
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
        reviewerNodeModulesLink = readlinkSync(join(spawnArgs.cwd, "node_modules"));
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
              codexTmpDir = options.env.TMPDIR;
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
        acceptance: [{ claim: "the production reviewer keeps read-only inspection tools and disposable test scratch", proof: "grep: fixed in src/example.ts" }],
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
    assert.equal(observedSpawn?.sandboxIntent, "disposable-review");
    assert.deepEqual(observedSpawn?.sandboxReadRoots, [physicalDependencyRoot]);
    assert.equal(reviewerNodeModulesLink, physicalDependencyRoot, "the reviewer link must not traverse a denied intermediate checkout");
    assert.equal(observedSpawn?.model, "gpt-5.5");
    assert.equal(observedSpawn?.effort, "high");
    assert.equal(observedSpawn?.maxTurns, 10);
    assert.match(observedSpawn?.prompt ?? "", /TASK UNDER REVIEW: W1-T2829/);
    assert.match(observedSpawn?.prompt ?? "", /DECLARED PATHS: \["src\/example\.ts"\]/);
    assert.match(observedSpawn?.prompt ?? "", /CHANGED PATHS: \["src\/example\.ts","src\/extra\.ts"\]/);
    assert.match(observedSpawn?.prompt ?? "", /WIDENED PATHS \(changed but not declared\): \["src\/extra\.ts"\]/);
    assert.match(observedSpawn?.prompt ?? "", /Scope expansion alone must NEVER cause FAILURE/i);
    assert.match(observedSpawn?.prompt ?? "", /REVIEW_VERDICT <n>:/);
    assert.equal(existsSync(observedSpawn?.cwd ?? root), false, "the semantic review scratch cwd must be removed after the spawn");
    assert.equal(codexArgs.includes("--skip-git-repo-check"), false, "a materialized repository must not need the non-repository bypass");
    assert.equal(codexArgs.includes("--sandbox"), false, "the explicit permission profile replaces legacy sandbox flags");
    assert.equal(codexArgs.includes("--add-dir"), false, "a review must not gain writable Git metadata roots");
    assert.ok(codexArgs.includes("network_proxy"), "review commands must stay behind the deny-by-default proxy");
    assert.ok(codexArgs.includes('default_permissions="rmd_review"'));
    assert.ok(codexArgs.includes('permissions.rmd_review.extends=":workspace"'));
    assert.ok(codexArgs.includes(
      `permissions.rmd_review.filesystem={":slash_tmp"="deny",":tmpdir"="write",${JSON.stringify(physicalDependencyRoot)}="read"}`,
    ));
    assert.ok(codexArgs.includes("permissions.rmd_review.network.enabled=true"));
    assert.equal(codexArgs.some((arg) => arg.includes("permissions.rmd_review.network.domains")), false,
      "reviews must not allow any external command destination");
    assert.equal(codexArgs.includes("sandbox_workspace_write.network_access=true"), false, "reviews do not gain network access");
    assert.equal(existsSync(codexTmpDir ?? root), false, "the private writable test scratch is reaped after review");
    assert.equal(execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), headSha);
    assert.equal(execFileSync("git", ["-C", sourceDir, "status", "--porcelain"], { encoding: "utf8" }), "");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("W1-T2946 mutation: omitting the disposable review intent restores read-only reviewer argv", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-review-intent-mutation-"));
  const workerHome = mkdtempSync(join(tmpdir(), "rmd-codex-review-intent-home-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
    let codexArgs: string[] = [];
    stdin.on("finish", () => {
      stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-review-missing-intent" })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
      stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      stdout.end();
      queueMicrotask(() => proc.emit("exit", 0));
    });

    await spawnCodexWorker(
      {
        workerHome,
        cwd: root,
        prompt: "exercise reviewer argv without its explicit intent",
        tools: ["Read", "Grep", "Glob", "Bash"],
        containment: {
          spawn: (options) => {
            codexArgs = options.args;
            return { process: proc as never, pid: 29_461 };
          },
          teardown: () => {},
        },
      },
      { claudeBin: "/unused", root, workerProviders: { enabled: ["codex"], codexBin: "/bin/sh" } },
    );

    assert.deepEqual(
      codexArgs.slice(codexArgs.indexOf("--sandbox"), codexArgs.indexOf("--sandbox") + 2),
      ["--sandbox", "read-only"],
      "deleting runReview's sandboxIntent would restore the old read-only reviewer argv",
    );
    assert.equal(codexArgs.includes("--add-dir"), false, "without the intent the private TMPDIR is not writable");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workerHome, { recursive: true, force: true });
  }
});
