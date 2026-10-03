import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runFixRung } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const inherited = "src/inherited.ts";
const rogue = "src/rogue.ts";
const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 20, contextBudget: 120000 };

async function repair(baseline: "known" | "absent" | "failed", edit: string, mixed = false) {
  const repo = gitRepo({ kind: "w1-t5385" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src/declared.ts"), "export const declared = 1;\n");
  repo.git("add", "src/declared.ts");
  repo.git("commit", "-qm", "seed declared surface");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, inherited), "export const inherited = 1;\n");
  repo.git("add", inherited);
  repo.git("commit", "-qm", "inherited implementation");
  const before = repo.git("rev-parse", "HEAD");
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  let spawns = 0;
  let pushes = 0;
  let waits = 0;
  let diffReads = 0;
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: [{ claim: "repair inherited implementation", proof: "unit test: repair",
      met: false, reason: "wrong value", proof_exec: "not_executable" }],
    summary: "wrong value", testTheater: false, floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: before, reviewerOutcome: "failure",
  };
  const outcome = await runFixRung({
    taskId: "W1-T5385X", runId: "W1-T5385X-run",
    task: { id: "W1-T5385X", title: "repair inherited implementation", files: ["src/declared.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/1", branch: "run-W1-T5385X-1",
    worktreePath: repo.dir, initialSessionId: "initial", mount,
    settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    deps: {
      spawn: async () => {
        spawns++;
        writeFileSync(join(repo.dir, edit), "export const repaired = 2;\n");
        if (mixed) writeFileSync(join(repo.dir, rogue), "export const rogue = 2;\n");
        return {
          sessionId: "fix-session", costUsd: 0, numTurns: 1,
          text: "COMMIT_MESSAGE: fix(ci): repair inherited implementation", blocks: [], stderr: "",
          subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        } satisfies WorkerResult;
      },
      ...(baseline === "absent" ? {} : { fetchPrDiffFiles: async () => {
        diffReads++;
        if (baseline === "failed") throw new Error("diff unavailable");
        // The live view can change; commit permission comes from the pre-rung snapshot.
        return diffReads === 1 ? [inherited] : ["src/declared.ts"];
      } }),
      waitForCiGreen: async () => { waits++; return "green"; },
      runReview: async () => ({ ...review, state: "success", criteria: [],
        headSha: repo.git("rev-parse", "HEAD"), reviewerOutcome: "success" }),
      fetchPrBody: async () => "repair inherited implementation",
      readHeadShaForProvenance: () => repo.git("rev-parse", "HEAD"),
      push: () => { pushes++; },
      issues: { create: () => { throw new Error("unexpected escalation"); }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"),
      log: (step, extra) => rows.push({ step, ...extra }), say: () => {}, account: (result) => result,
    },
  });
  return { repo, before, outcome, rows, spawns, pushes, waits };
}

test("W1-T5385: fix_refusal:every-change-the-worker-made-is-outside-its-declared-files is prevented, not retried", async () => {
  const result = await repair("known", inherited);
  assert.equal(result.outcome.outcome, "fixed");
  assert.equal(result.spawns, 1, "the repair lands without another worker round or resume");
  assert.equal(result.outcome.strikes, 1);
  assert.equal(result.pushes, 1);
  assert.equal(result.waits, 1);
  assert.equal(result.rows.some((row) => row.step === "fix.commit_refused"), false);
  assert.equal(result.repo.git("show", "--format=", "--name-only", "HEAD"), inherited);
  assert.equal(result.repo.git("show", `HEAD:${inherited}`), "export const repaired = 2;");
});

test("W1-T5385: new out-of-scope edits stay refused", async () => {
  const result = await repair("known", rogue);
  assert.equal(result.outcome.outcome, "stood_down");
  assert.equal(result.spawns, 1);
  assert.equal(result.pushes, 0);
  assert.equal(result.waits, 0);
  assert.equal(result.repo.git("rev-parse", "HEAD"), result.before);
  const refusal = result.rows.find((row) => row.step === "fix.commit_refused");
  assert.equal(refusal?.reason, "every change the worker made is outside its declared files");
});

test("W1-T5385: unknown inherited scope never grants commit permission", async () => {
  for (const baseline of ["absent", "failed"] as const) {
    const result = await repair(baseline, inherited);
    assert.equal(result.outcome.outcome, "stood_down", baseline);
    assert.equal(result.pushes, 0);
    assert.equal(result.repo.git("rev-parse", "HEAD"), result.before);
  }
});

test("W1-T5385: a mixed repair stages only the inherited edit", async () => {
  const result = await repair("known", inherited, true);
  assert.equal(result.outcome.outcome, "fixed");
  assert.equal(result.repo.git("show", "--format=", "--name-only", "HEAD"), inherited);
  assert.match(result.repo.git("status", "--porcelain"), /\?\? src\/rogue.ts/);
  assert.deepEqual(result.rows.find((row) => row.step === "implement.harness_commit")?.undeclared, [rogue]);
});
