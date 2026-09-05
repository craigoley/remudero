import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { runReview } from "../src/run-task.js";

type LogRow = { step: string; extra: Record<string, unknown> };

interface Fixture {
  root: string;
  sourceDir: string;
  headSha: string;
  ghLog: string;
  ledgerPath: string;
  settingsFile: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function withFixture<T>(
  fn: (fixture: Fixture) => Promise<T>,
  servedHead?: (actualHead: string) => string,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}codex-reviewer-checkout-`));
  const sourceDir = join(root, "source");
  const binDir = join(root, "bin");
  const ghLog = join(root, "gh.log");
  const ledgerPath = join(root, "ledger.ndjson");
  const settingsFile = join(root, "settings.json");
  mkdirSync(join(sourceDir, "src"), { recursive: true });
  mkdirSync(binDir);
  execFileSync("git", ["init", "-q", sourceDir]);
  git(sourceDir, "config", "user.name", "RMD Test");
  git(sourceDir, "config", "user.email", "rmd-test@example.invalid");
  writeFileSync(join(sourceDir, "src", "example.ts"), "export const fixed = true;\n", "utf8");
  git(sourceDir, "add", "src/example.ts");
  git(sourceDir, "commit", "-q", "-m", "fixture");
  const headSha = git(sourceDir, "rev-parse", "HEAD");
  const apiHead = servedHead?.(headSha) ?? headSha;
  writeFileSync(settingsFile, "{}\n", "utf8");
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(ghLog)}
case "$1 $2" in
  "api "*)
    case "$*" in
      *pulls/*) echo '{"number":2868,"html_url":"https://github.com/acme/remudero/pull/2868","updated_at":"t","body":"fixed","state":"open","head":{"ref":"b","sha":"${apiHead}"}}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") printf '%s\n' 'diff --git a/src/example.ts b/src/example.ts' '+export const fixed = true;' ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    return await fn({ root, sourceDir, headSha, ghLog, ledgerPath, settingsFile });
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
}

function reviewerResult(provider: "claude" | "codex", text: string): WorkerResult {
  return {
    sessionId: `${provider}-reviewer`,
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: provider === "claude" ? "claude-sonnet-5" : "gpt-5.5",
    effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    provider,
  };
}

async function review(
  fixture: Fixture,
  options: {
    headCheckoutDir?: string;
    spawn: (args: SpawnWorkerArgs) => Promise<WorkerResult>;
    logs: LogRow[];
  },
) {
  return runReview({
    owner: "acme",
    repo: "remudero",
    prUrl: "https://github.com/acme/remudero/pull/2868",
    task: {
      id: "W1-T2868",
      files: ["src/example.ts"],
      acceptance: [{ claim: "the fixed source is present", proof: "grep: fixed in src/example.ts" }],
    },
    report: "the fixed source is present",
    settingsFile: fixture.settingsFile,
    config: { claudeBin: "/unused", root: fixture.root } as never,
    log: (step: string, extra: Record<string, unknown> = {}) => options.logs.push({ step, extra }),
    say: () => {},
    account: (worker: WorkerResult) => worker,
    spawnReviewer: true,
    reviewerSpawnWorker: options.spawn as typeof import("../src/lib/worker.js").spawnWorker,
    reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 },
    headCheckoutDir: options.headCheckoutDir,
    ledgerPath: fixture.ledgerPath,
    runId: `RUN-W1-T2868-${fixture.headSha.slice(0, 8)}`,
    disarm: () => "not-armed" as const,
    arm: () => ({ armed: false, reason: "test" }),
  } as never);
}

test("W1-T2868: the Claude semantic reviewer receives a disposable exact-head checkout without changing its source", async () => {
  await withFixture(async (fixture) => {
    const logs: LogRow[] = [];
    let reviewerCwd = "";
    let reviewerPrompt = "";
    const verdict = await review(fixture, {
      headCheckoutDir: fixture.sourceDir,
      logs,
      spawn: async (args) => {
        reviewerCwd = args.cwd;
        reviewerPrompt = args.prompt;
        assert.notEqual(args.cwd, fixture.sourceDir, "the reviewer never receives the live proof checkout");
        assert.equal(git(args.cwd, "rev-parse", "HEAD"), fixture.headSha);
        assert.equal(git(args.cwd, "status", "--porcelain", "--untracked-files=all"), "");
        assert.equal(readFileSync(join(args.cwd, "src", "example.ts"), "utf8"), "export const fixed = true;\n");
        return reviewerResult("claude", "REVIEW_VERDICT 1: PASS");
      },
    });

    assert.equal(verdict.state, "success");
    assert.equal(verdict.reviewerOutcome, "success");
    assert.equal(verdict.evaluatorProvenance?.provider, "claude");
    assert.match(reviewerPrompt, new RegExp(`already.*${fixture.headSha}`, "is"));
    assert.doesNotMatch(reviewerPrompt, /gh pr checkout|git fetch origin/);
    assert.equal(existsSync(reviewerCwd), false, "the disposable checkout is removed after success");
    assert.equal(git(fixture.sourceDir, "rev-parse", "HEAD"), fixture.headSha);
    assert.equal(git(fixture.sourceDir, "status", "--porcelain", "--untracked-files=all"), "");
    assert.doesNotMatch(readFileSync(fixture.ghLog, "utf8"), /pr checkout/, "materialization adds no GitHub checkout call");
  });
});

test("W1-T2868: a missing or wrong source checkout is a named advisory failure and never spawns", async () => {
  for (const scenario of ["missing", "wrong-head"] as const) {
    await withFixture(async (fixture) => {
      const logs: LogRow[] = [];
      let spawns = 0;
      const verdict = await review(fixture, {
        headCheckoutDir: scenario === "missing" ? undefined : fixture.sourceDir,
        logs,
        spawn: async () => {
          spawns += 1;
          return reviewerResult("claude", "REVIEW_VERDICT 1: FAIL");
        },
      });
      assert.equal(spawns, 0, `${scenario}: an unprovable snapshot must not reach a provider`);
      assert.equal(verdict.reviewerOutcome, "spawn_error");
      const failure = logs.find((row) => row.step === "review.reviewer.materialization_error");
      assert.ok(failure, `${scenario}: the ledger names materialization, not a semantic FAIL`);
      assert.match(String(failure.extra.reason), scenario === "missing" ? /source-unavailable/ : /head-mismatch/);
      assert.ok(verdict.criteria.every((criterion) => !/reviewer judged/i.test(criterion.reason)));
    }, scenario === "wrong-head" ? () => "f".repeat(40) : undefined);
  }
});

test("W1-T2868: reviewer mutation invalidates its semantic FAIL while the deterministic floor stays authoritative", async () => {
  await withFixture(async (fixture) => {
    const logs: LogRow[] = [];
    let reviewerCwd = "";
    const verdict = await review(fixture, {
      headCheckoutDir: fixture.sourceDir,
      logs,
      spawn: async (args) => {
        reviewerCwd = args.cwd;
        writeFileSync(join(args.cwd, "reviewer-mutation.txt"), "must be refused\n", "utf8");
        return reviewerResult("codex", "REVIEW_VERDICT 1: FAIL");
      },
    });

    assert.equal(verdict.state, "success", "an integrity failure cannot manufacture a semantic downgrade");
    assert.equal(verdict.criteria[0]?.met, true, "the deterministic proof floor remains binding");
    assert.equal(verdict.reviewerOutcome, "spawn_error");
    const failure = logs.find((row) => row.step === "review.reviewer.integrity_error");
    assert.match(String(failure?.extra.reason), /dirty/);
    assert.equal(existsSync(reviewerCwd), false, "the dirty disposable checkout is still removed");
    assert.equal(git(fixture.sourceDir, "status", "--porcelain", "--untracked-files=all"), "");
  });
});

test("W1-T2868: a reviewer spawn error still removes the materialized checkout", async () => {
  await withFixture(async (fixture) => {
    const logs: LogRow[] = [];
    let reviewerCwd = "";
    const verdict = await review(fixture, {
      headCheckoutDir: fixture.sourceDir,
      logs,
      spawn: async (args) => {
        reviewerCwd = args.cwd;
        assert.equal(git(args.cwd, "rev-parse", "HEAD"), fixture.headSha);
        throw new Error("seeded reviewer failure");
      },
    });
    assert.equal(verdict.reviewerOutcome, "spawn_error");
    assert.ok(logs.some((row) => row.step === "review.reviewer.error"));
    assert.equal(existsSync(reviewerCwd), false);
  });
});
