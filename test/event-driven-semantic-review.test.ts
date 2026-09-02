import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import { CLAUDE_BIN_ENV_OVERRIDE } from "../src/lib/worker.js";
import { reviewCommand, runReview } from "../src/run-task.js";

const REPO_ROOT = process.cwd();
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

interface CapturedReview {
  spawnReviewer?: boolean;
  reviewerMount?: Mount;
  budgetUsd?: number;
  settingsFile: string;
  settingsFileExists?: boolean;
  task: { id: string; acceptance?: { claim: string; proof: string }[] };
}

async function captureReview(
  body: string,
  mode: "manual" | "semantic" | "sweep",
): Promise<{ args: CapturedReview; ledger: Record<string, unknown>[] }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-event-semantic-review-"));
  let captured: CapturedReview | undefined;
  try {
    const deps = {
      fetchView: () =>
        mode === "sweep"
          ? {
              body,
              html_url: "https://github.com/craigoley/remudero/pull/9999",
              head: { ref: "codex/event-review-test", sha: HEAD },
              updated_at: new Date(0).toISOString(),
              number: 9999,
            }
          : {
              headRefOid: HEAD,
              headRefName: "codex/event-review-test",
              body,
              url: "https://github.com/craigoley/remudero/pull/9999",
              number: 9999,
            },
      fetchHead: () => {},
      loadConfig: () => ({ root, claudeBin: "/bin/true" }) as Config,
      postReviewPending: async () => ({ posted: true }),
      materialize: () => ({
        worktreePath: undefined,
        failure: { errorClass: "test", message: "semantic-review wiring fixture" },
      }),
      runReview: async (args: CapturedReview) => {
        captured = { ...args, settingsFileExists: existsSync(args.settingsFile) };
        return { state: "success", headSha: HEAD, reviewerOutcome: "not_attempted", criteria: [] };
      },
      ...(mode !== "manual" ? { executionMode: "semantic" as const } : {}),
    };

    if (mode === "sweep") await reviewCommand("9999", ["--repo", "craigoley/remudero"], deps as never);
    else await reviewCommand("codex/event-review-test", ["--repo", "craigoley/remudero"], deps as never);

    assert.ok(captured, "the real review command must reach runReview");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    return { args: captured, ledger };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the sweep runner explicitly enables a semantic reviewer with the head-resolved task risk and hard budget", async () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.match(
    source,
    /reviewRunner:[^\n]+reviewCommand\(String\(prNumber\), \["--repo", repo\], \{ executionMode: "semantic" \}\)/,
    "the production sweep default must opt in explicitly, not infer its caller",
  );
  const { args } = await captureReview("Remudero-Task: W1-T2593", "sweep");

  assert.equal(args.spawnReviewer, true);
  assert.equal(args.reviewerMount?.model, "sonnet");
  assert.equal(args.reviewerMount?.effort, "high", "W1-T2593 is risk: high at this exact PR head");
  assert.equal(args.budgetUsd, 15, "the reviewer hard cap must be W1-T2593's head-resolved budget_usd");
  assert.ok(args.settingsFile, "semantic mode must render a normal worker settings file");
  assert.equal(args.settingsFileExists, true, "the rendered settings path handed to runReview must exist");
});

test("manual rmd review remains deterministic-only by default", async () => {
  const { args } = await captureReview("Remudero-Task: W1-T2593", "manual");

  assert.equal(args.spawnReviewer, false);
  assert.equal(args.budgetUsd, undefined);
  assert.equal(args.reviewerMount, undefined);
  assert.equal(args.settingsFile, "");
});

test("semantic mode with no head-resolved task metadata names its deterministic fallback and invents no mount or budget", async () => {
  const body = [
    "## Acceptance",
    "- the deterministic floor still runs | grep: review in src/lib/review.ts",
    "",
    "Remudero-Task: W1-T999999",
  ].join("\n");
  const { args, ledger } = await captureReview(body, "semantic");

  assert.equal(args.spawnReviewer, false);
  assert.equal(args.budgetUsd, undefined);
  assert.equal(args.reviewerMount, undefined);
  assert.equal(args.settingsFile, "");
  assert.ok(
    ledger.some(
      (row) => row.step === "review.reviewer.skipped" && row.reason === "head-task-metadata-unavailable",
    ),
    "the durable ledger must distinguish missing task metadata from a completed semantic review",
  );
});

test("a semantic provider failure still posts the binding deterministic verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-event-semantic-provider-"));
  const bin = mkdtempSync(join(tmpdir(), "rmd-event-semantic-bin-"));
  const oldPath = process.env.PATH;
  const oldClaudeBin = process.env[CLAUDE_BIN_ENV_OVERRIDE];
  const oldToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const diffPath = join(root, "diff.txt");
  const settingsFile = join(root, "settings.json");
  try {
    writeFileSync(diffPath, "diff --git a/src/x.ts b/src/x.ts\n+const semantic = true;\n", "utf8");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }), "utf8");
    const fakeClaude = join(bin, "claude");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(fakeClaude, 0o755);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "api repos/"*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"cafebabe0002"},"state":"open"}' ;;
  "pr diff") cat ${JSON.stringify(diffPath)} ;;
  "pr view") echo '{"state":"OPEN"}' ;;
  *) echo '{}' ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${oldPath}`;
    process.env[CLAUDE_BIN_ENV_OVERRIDE] = fakeClaude;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token-never-sent";

    const steps: string[] = [];
    const verdict = await runReview({
      owner: "o",
      repo: "r",
      prUrl: "https://github.com/o/r/pull/1",
      task: {
        id: "W1-T2593",
        acceptance: [{ claim: "the deterministic verdict posts", proof: "the deterministic verdict posts" }],
      },
      report: "The deterministic verdict posts.",
      settingsFile,
      config: { root, claudeBin: fakeClaude, enabledProviders: ["claude"] } as Config,
      budgetUsd: 15,
      log: (step: string) => steps.push(step),
      say: () => {},
      account: (result) => result,
      spawnReviewer: true,
      reviewerMount: { model: "sonnet", effort: "high", maxTurns: 400, contextBudget: 120000 },
      reviewerQueryFn: (() => {
        throw new Error("provider unavailable fixture");
      }) as never,
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "REVIEW-PROVIDER-UNAVAILABLE",
      arm: () => "armed",
      disarm: () => "not-armed",
    });

    assert.ok(steps.includes("review.reviewer.error"), "the semantic failure must be explicit");
    assert.ok(steps.includes("review.posted"), "the authoritative deterministic status must still post");
    assert.equal(verdict.reviewerOutcome, "spawn_error");
  } finally {
    process.env.PATH = oldPath;
    if (oldClaudeBin === undefined) delete process.env[CLAUDE_BIN_ENV_OVERRIDE];
    else process.env[CLAUDE_BIN_ENV_OVERRIDE] = oldClaudeBin;
    if (oldToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldToken;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
