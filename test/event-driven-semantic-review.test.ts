import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "#src/lib/config.js";
import type { Mount } from "#src/lib/mounts.js";
import { ledgeredNonDispatchSpawn, reviewCommand, runReview } from "#src/run-task.js";

const REPO_ROOT = process.cwd();
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

interface CapturedReview {
  spawnReviewer?: boolean;
  requireSemanticReview?: boolean;
  reviewerMount?: Mount;
  budgetUsd?: number;
  settingsFile: string;
  settingsFileExists?: boolean;
  task: { id: string; acceptance?: { claim: string; proof: string }[] };
}

async function captureReview(
  body: string,
  mode: "manual" | "semantic" | "sweep",
  expectedCode = 0,
): Promise<{ args: CapturedReview | undefined; ledger: Record<string, unknown>[]; effects: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-event-semantic-review-"));
  let captured: CapturedReview | undefined;
  const effects: string[] = [];
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
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
      postReviewPending: async () => { effects.push("pending"); return { posted: true }; },
      materialize: () => { effects.push("materialize"); return ({
        worktreePath: undefined,
        failure: { errorClass: "test", message: "semantic-review wiring fixture" },
      }); },
      runReview: async (args: CapturedReview) => {
        effects.push("review");
        captured = { ...args, settingsFileExists: existsSync(args.settingsFile) };
        return { state: "success", headSha: HEAD, reviewerOutcome: "not_attempted", criteria: [] };
      },
      ...(mode !== "manual" ? { executionMode: "semantic" as const } : {}),
    };

    const code = await reviewCommand(mode === "sweep" ? "9999" : "codex/event-review-test", ["--repo", "craigoley/remudero"], deps as never);

    assert.equal(code, expectedCode);
    if (expectedCode === 0) assert.ok(captured, "the real review command must reach runReview");
    else assert.equal(captured, undefined, "a refused command must not reach a reviewer capable of merge effects");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    return { args: captured, ledger, effects };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the sweep runner explicitly enables a semantic reviewer with the head-resolved task risk and hard budget", async () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.match(
    source,
    // The DECLARATION's syntax is not the subject and must not be pinned to it: this assertion has
    // now been re-derived twice for shape changes that preserved the behaviour exactly (a deps
    // object collapsing to a local, then that local gaining a type annotation between its name and
    // its `=`). What it actually protects is the OPT-IN — that the production default names
    // `executionMode: "semantic"` itself rather than letting reviewCommand infer it from the
    // caller — so the binding is matched loosely and the call shape strictly.
    // The CALLEE may be the seam (`reviewCommandImpl`, whose default IS `reviewCommand`) — that
    // indirection exists so the default arm itself is reachable by a test rather than replaced by
    // one. What this pins either way is the OPT-IN, which is the same in both spellings.
    // The gap is BOUNDED, not open: an annotation is ~60 chars, so 120 admits one and still cannot
    // wander into an unrelated `reviewCommand(` elsewhere in a 38k-line file.
    /reviewRunner\b[\s\S]{0,120}?=\s*\(prNumber, isPlanFiling\) =>[\s\S]{0,200}?reviewCommand(?:Impl)?\(String\(prNumber\), \["--repo", repo\], \{\s*executionMode: "semantic",\s*planOnlyFiling: isPlanFiling,\s*\}\)/,
    "the production sweep default must opt in explicitly, not infer its caller",
  );
  const { args } = await captureReview("Remudero-Task: W1-T2593", "sweep");

  assert.ok(args);
  assert.equal(args.spawnReviewer, true);
  assert.equal(args.requireSemanticReview, true);
  assert.equal(args.reviewerMount?.model, "sonnet");
  assert.equal(args.reviewerMount?.effort, "high", "W1-T2593 is risk: high at this exact PR head");
  assert.equal(args.budgetUsd, 15, "the reviewer hard cap must be W1-T2593's head-resolved budget_usd");
  assert.ok(args.settingsFile, "semantic mode must render a normal worker settings file");
  assert.equal(args.settingsFileExists, true, "the rendered settings path handed to runReview must exist");
});

test("manual rmd review remains deterministic-only by default", async () => {
  const { args } = await captureReview("Remudero-Task: W1-T2593", "manual");

  assert.ok(args);
  assert.equal(args.spawnReviewer, false);
  assert.equal(args.requireSemanticReview, false);
  assert.equal(args.budgetUsd, undefined);
  assert.equal(args.reviewerMount, undefined);
  assert.equal(args.settingsFile, "");
});

test("semantic mode with no head-resolved task metadata refuses before pending, materialization or review", async () => {
  const body = [
    "## Acceptance",
    "- a refused semantic review cannot publish a deterministic verdict | grep: review in src/lib/review.ts",
    "",
    "Remudero-Task: W1-T999999",
  ].join("\n");
  const { args, ledger, effects } = await captureReview(body, "semantic", 2);

  assert.equal(args, undefined);
  assert.deepEqual(effects, []);
  assert.ok(
    ledger.some(
      (row) => row.step === "review.reviewer.skipped" && row.reason === "head-task-metadata-unavailable",
    ),
    "the durable ledger must distinguish missing task metadata from a completed semantic review",
  );
  assert.ok(ledger.some(row => row.step === "review.semantic_setup_refused" && row.reason === "head-task-metadata-unavailable"));
  assert.ok(!ledger.some(row => row.step === "review.posted" || row.step === "automerge.armed"));
});

for (const required of [false, true]) test(required
  ? "a required semantic provider failure withholds verdict publication and every merge effect"
  : "a semantic provider failure still posts the binding deterministic verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-event-semantic-provider-"));
  const bin = mkdtempSync(join(tmpdir(), "rmd-event-semantic-bin-"));
  const oldPath = process.env.PATH;
  const diffPath = join(root, "diff.txt");
  const settingsFile = join(root, "settings.json");
  try {
    writeFileSync(diffPath, "diff --git a/src/x.ts b/src/x.ts\n+const semantic = true;\n", "utf8");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }), "utf8");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "api repos/"*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"${HEAD}"},"state":"open"}' ;;
  "pr diff") cat ${JSON.stringify(diffPath)} ;;
  "pr view") echo '{"state":"OPEN"}' ;;
  *) echo '{}' ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${oldPath}`;

    const steps: string[] = [];
    const providerErrors: string[] = [];
    let providerInvoked = false;
    let providerInvocations = 0;
    const reviewArgs: Parameters<typeof runReview>[0] = {
      owner: "o",
      repo: "r",
      prUrl: "https://github.com/o/r/pull/1",
      task: {
        id: "W1-T2593",
        design: "Preserve all original behavioral assertions.",
        amendment: "Only the approved companions may change.",
        acceptance: [{ claim: "the deterministic verdict posts", proof: "the deterministic verdict posts" }],
      },
      report: "The deterministic verdict posts.",
      reviewInputBody: "",
      settingsFile,
      config: { root, claudeBin: "/bin/true", enabledProviders: ["claude"] } as Config,
      budgetUsd: 15,
      log: (step: string, fields?: Record<string, unknown>) => {
        steps.push(step);
        if (step === "review.reviewer.error") providerErrors.push(String(fields?.error ?? "unavailable"));
      },
      say: () => {},
      account: (result) => result,
      spawnReviewer: true,
      requireSemanticReview: required,
      reviewerMount: { model: "sonnet", effort: "high", maxTurns: 400, contextBudget: 120000 },
      // Exercise the orchestration failure boundary without SDK/auth/home setup.
      // Real default worker wiring is qualified separately, not by this fixture.
      reviewerSpawnWorker: ledgeredNonDispatchSpawn("review", async (workerArgs) => {
        assert.ok(workerArgs.prompt.includes("Preserve all original behavioral assertions."));
        assert.ok(workerArgs.prompt.includes("Only the approved companions may change."));
        providerInvoked = true;
        providerInvocations++;
        throw new Error("provider unavailable fixture");
      }),
      headCheckoutDir: REPO_ROOT,
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "REVIEW-PROVIDER-UNAVAILABLE",
      arm: () => { steps.push("arm-effect"); return "armed"; },
      disarm: () => { steps.push("disarm-effect"); return "not-armed"; },
    };
    const verdict = await runReview(reviewArgs);

    assert.equal(providerInvoked, true, "the fixture must reach the injected worker boundary: " + providerErrors.join("; "));
    assert.ok(steps.includes("review.reviewer.error"), "the semantic failure must be explicit");
    assert.equal(steps.includes("review.posted"), !required, "only the advisory policy may publish a deterministic fallback");
    if (required) {
      assert.equal(verdict.state, "failure");
      assert.equal(verdict.verdictWithheld, "required-semantic-spawn_error");
      assert.ok(steps.includes("review.semantic_incomplete"));
      assert.ok(!steps.includes("arm-effect") && !steps.includes("disarm-effect"));
    }
    assert.equal(verdict.reviewerOutcome, "spawn_error");
    if (required) {
      const changed = await runReview({ ...reviewArgs,
        task: { ...reviewArgs.task, amendment: String(reviewArgs.task.amendment) + "\nPreserve the original assertions." },
        runId: "REVIEW-AMENDMENT-CHANGED",
      });
      assert.notEqual(changed.reviewDecisionDigest, verdict.reviewDecisionDigest, "the actual decision producer must bind the changed amendment at the same PR head");
      assert.equal(providerInvocations, 2);
    }
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});


test("direct semantic review withholds unreadable task narrative before publication or worker effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-event-semantic-provider-"));
  const bin = mkdtempSync(join(tmpdir(), "rmd-event-semantic-bin-"));
  const oldPath = process.env.PATH;
  const diffPath = join(root, "diff.txt");
  const settingsFile = join(root, "settings.json");
  try {
    writeFileSync(diffPath, "diff --git a/src/x.ts b/src/x.ts\n+const semantic = true;\n", "utf8");
    writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }), "utf8");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "api repos/"*) echo '{"number":1,"html_url":"https://github.com/o/r/pull/1","updated_at":"t","body":"","head":{"ref":"b","sha":"${HEAD}"},"state":"open"}' ;;
  "pr diff") cat ${JSON.stringify(diffPath)} ;;
  "pr view") echo '{"state":"OPEN"}' ;;
  *) echo '{}' ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${oldPath}`;

    const steps: string[] = [];
    const providerErrors: string[] = [];
    let providerInvoked = false;
    const verdict = await runReview({
      owner: "o",
      repo: "r",
      prUrl: "https://github.com/o/r/pull/1",
      task: {
        id: "W1-T2593",
        narrativeUnavailable: true,
        design: "Preserve all original behavioral assertions.",
        amendment: "Only the approved companions may change.",
        acceptance: [{ claim: "the deterministic verdict posts", proof: "the deterministic verdict posts" }],
      },
      report: "The deterministic verdict posts.",
      reviewInputBody: "",
      settingsFile,
      config: { root, claudeBin: "/bin/true", enabledProviders: ["claude"] } as Config,
      budgetUsd: 15,
      log: (step: string, fields?: Record<string, unknown>) => {
        steps.push(step);
        if (step === "review.reviewer.error") providerErrors.push(String(fields?.error ?? "unavailable"));
      },
      say: () => {},
      account: (result) => result,
      spawnReviewer: true,
      requireSemanticReview: true,
      reviewerMount: { model: "sonnet", effort: "high", maxTurns: 400, contextBudget: 120000 },
      // Exercise the orchestration failure boundary without SDK/auth/home setup.
      // Real default worker wiring is qualified separately, not by this fixture.
      reviewerSpawnWorker: ledgeredNonDispatchSpawn("review", async (workerArgs) => {
        assert.ok(workerArgs.prompt.includes("Preserve all original behavioral assertions."));
        assert.ok(workerArgs.prompt.includes("Only the approved companions may change."));
        providerInvoked = true;
        throw new Error("provider unavailable fixture");
      }),
      headCheckoutDir: REPO_ROOT,
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "REVIEW-PROVIDER-UNAVAILABLE",
      arm: () => { steps.push("arm-effect"); return "armed"; },
      disarm: () => { steps.push("disarm-effect"); return "not-armed"; },
    });

    assert.equal(providerInvoked, false);
    assert.equal(verdict.verdictWithheld, "head-task-narrative-unavailable");
    assert.ok(steps.includes("review.reviewer.skipped"));
    assert.ok(!steps.includes("review.posted") && !steps.includes("arm-effect") && !steps.includes("disarm-effect"));

  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
