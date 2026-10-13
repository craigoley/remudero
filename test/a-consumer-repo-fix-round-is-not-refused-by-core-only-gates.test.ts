import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
import type { WorkerResult, SpawnWorkerArgs } from "../src/lib/worker.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REACH = "test/the-affected-suite-reach-ratchet.test.ts";
const BASELINE = "scripts/affected-reach-baseline.json";
const SNAPSHOT_ENV = "RMD_CENSUS_SNAPSHOT";
const IMPORT_CLI = `import ${JSON.stringify("../src/run-task.js")};\n`;
const entrypoint = new URL("../src/run-task.ts", import.meta.url);

/** A committed worktree shaped like core's census inputs; `withBaseline: false` is a consumer tree (or a core
 *  branch that deleted the baseline — the two differ only in the task's repo). */
function worktree(kind: string, withBaseline: boolean) {
  const repo = gitRepo({ kind });
  const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE), "utf8"));
  const texts: Record<string, string> = {
    "src/run-task.ts": "export {};\n", "src/lib/affected-suites.ts": "export {};\n", [REACH]: "export {};\n",
    ...(withBaseline ? { [BASELINE]: JSON.stringify(baseline) } : {}),
  };
  for (const path of baseline.importers) texts[path] = IMPORT_CLI;
  for (const [path, text] of Object.entries(texts)) {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
  writeFileSync(join(repo.dir, ".gitignore"), "state/\nsettings.json\n");
  repo.git("add", "-A");
  repo.git("commit", "-m", "fixture: census inputs");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

class PushReached extends Error {}

async function fixRound(repoName: string, withBaseline: boolean) {
  const harness = await import(entrypoint.href);
  const repo = worktree(`census-${repoName}-${withBaseline}`, withBaseline);
  const head = repo.git("rev-parse", "HEAD");
  const review = { state: "failure", criteria: [{ claim: "census", proof: "unit test: census", met: false,
    reason: "red", proof_exec: "not_executable" }], testTheater: false, summary: "red", floorDegraded: false,
    capped: false, keywordOnly: false, planOnly: false, headSha: head, reviewerOutcome: "failure" };
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000, provider: "claude" };
  const rows: { step: string; extra: Record<string, unknown> }[] = [];
  const snapshotEnvs: (string | undefined)[] = [];
  const prompts: string[] = [];
  let commits = 0;
  let pushes = 0;
  const result = await harness.runFixRung({ taskId: "W1-T8918", runId: `consumer-${repoName}`,
    task: { id: "W1-T8918", title: "census", repo: repoName, files: ["test/new.test.ts"] },
    prUrl: `https://github.com/fixture/${repoName}/pull/1`, branch: "run-W1-T8918-1", worktreePath: repo.dir,
    initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } }, budgetUsd: 1, strikeCap: 2,
    initialReview: review, reviewBase: { owner: "fixture", repo: repoName, headCheckoutDir: repo.dir, reviewerMount: mount },
    deps: {
      writeFixCensusSnapshot: harness.writeFixCensusSnapshot,
      spawn: async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
        prompts.push(args.prompt);
        snapshotEnvs.push(args.env?.[SNAPSHOT_ENV]);
        writeFileSync(join(repo.dir, "test/new.test.ts"), IMPORT_CLI);
        return { sessionId: "session", costUsd: 0, numTurns: 1,
          text: "COMMIT_MESSAGE: fix(census): save edits", blocks: [], stderr: "", subtype: "success",
          isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
      },
      waitForCiGreen: async () => { assert.fail("an uncommitted round must not wait on hosted CI"); },
      runReview: async () => { assert.fail("an uncommitted round must not request review"); },
      fetchPrBody: async () => "REPORT", push: () => { pushes += 1; throw new PushReached(); },
      harnessCommitForShellLessWorker: () => { commits += 1; return 0; },
      issues: { create: () => "https://github.com/fixture/x/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "state", "ledger.ndjson"),
      log: (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, extra }); },
      say: () => {}, account: (r: WorkerResult) => r,
    },
  }).catch((error: unknown) => { if (error instanceof PushReached) return undefined; throw error; });
  return { repo, result, rows, snapshotEnvs, prompts, commits: () => commits, pushes: () => pushes };
}

test("W1-T8918: a consumer-repo fix round is not refused by core-only gates", async () => {
  const f = await fixRound("remudero-console", false);
  const checks = f.rows.filter((r) => r.step === "fix.census_check");
  assert.ok(checks.some((r) => r.extra.outcome === "not-applicable" && r.extra.repo === "remudero-console"));
  assert.ok(!checks.some((r) => r.extra.outcome === "refused"));
  assert.ok(f.pushes() > 0, "the saved edit is not stopped before the push");
  assert.ok(f.prompts.every((p) => !p.includes("ENOENT") && !p.includes("census-suite:")));
});

test("W1-T8918: a core fix round still refuses a branch that deletes the reach baseline", async () => {
  const f = await fixRound("remudero", false);
  assert.ok(f.rows.some((r) => r.step === "fix.census_check" && r.extra.outcome === "refused"));
  assert.ok(!f.rows.some((r) => r.step === "fix.census_check" && r.extra.outcome === "not-applicable"));
  assert.equal(f.commits(), 0, "a refused edit is never committed");
  assert.ok(f.prompts[1]!.includes("census-suite: test/the-affected-suite-reach-ratchet.test.ts fails"));
});

test("W1-T8918: no census snapshot is written for a consumer-repo worktree", async () => {
  const f = await fixRound("remudero-console", true);
  assert.ok(f.snapshotEnvs.length > 0);
  assert.ok(f.snapshotEnvs.every((env) => env === undefined), "no snapshot env reaches a consumer worker");
  assert.ok(!f.rows.some((r) => r.step === "fix.census_snapshot"));
  const harness = await import(entrypoint.href);
  const quiet: string[] = [];
  assert.equal(harness.fixCensusAppliesToRepo("remudero-console", (s: string) => quiet.push(s), () => ({ owner: "o", repo: "remudero" })), false);
  assert.equal(harness.fixCensusAppliesToRepo("remudero", () => {}, () => ({ owner: "o", repo: "remudero" })), true);
  assert.equal(harness.fixCensusAppliesToRepo("remudero-console", () => {}, () => { throw new Error("no origin"); }), true);
});
