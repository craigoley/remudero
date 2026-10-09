import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { withTempDir } from "../src/lib/tmp.js";
import {
  buildPrerequisitePrDispatchArgs,
  prerequisitePrAdmissionRefusal,
  renderPrerequisitePrPrompt,
  runFixRung,
} from "../src/run-task.js";

const PROOF = "test/the-prerequisite-split-contract-has-no-optional-seam.test.ts";
const PREREQUISITE_URL = "https://github.com/acme/remudero/pull/5810";
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
const PROMPT_ARGS = {
  task: { id: "W1-T5810", title: "require prerequisite inputs" },
  branch: "run-W1-T5810-1730000000000",
  prUrl: "https://github.com/acme/remudero/pull/4242",
  instrumentPaths: ["scripts/diff-coverage.mjs"],
  srcPaths: ["src/run-task.ts"],
};
const DISPATCH_ARGS = {
  ...PROMPT_ARGS,
  worktreePath: "/tmp/rmd-w1-t5810-wt",
  mount: MOUNT,
  settingsFile: "/tmp/rmd-w1-t5810-settings.json",
  config: {} as Config,
  budgetUsd: 1,
  runId: "W1-T5810-1730000000000",
  taskId: "W1-T5810",
};

// Compiled by the test below, never invoked: omission must be a type error at both boundaries.
function rejectedCalls() {
  // @ts-expect-error W1-T5810: the renderer requires the minted branch.
  renderPrerequisitePrPrompt(PROMPT_ARGS);
  // @ts-expect-error W1-T5810: the dispatch builder requires the minted branch.
  buildPrerequisitePrDispatchArgs(DISPATCH_ARGS);
  // @ts-expect-error W1-T5810: the admission check requires a head reader.
  prerequisitePrAdmissionRefusal(PREREQUISITE_URL, "run-unfiled-42", { fetchPrBody: async () => "" });
  // @ts-expect-error W1-T5810: the admission check requires a body reader.
  prerequisitePrAdmissionRefusal(PREREQUISITE_URL, "run-unfiled-42", { readLiveHead: () => ({ ok: false }) });
}

test(`${PROOF}: a type check rejects omitted branch and reader arguments`, () => {
  const compiler = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
  const checked = spawnSync(process.execPath, [
    compiler, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--esModuleInterop",
    "--module", "nodenext", "--target", "ES2022", "--lib", "ES2023,DOM", fileURLToPath(import.meta.url),
  ], { encoding: "utf8", timeout: 60_000 });
  assert.ifError(checked.error);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test(`${PROOF}: the prerequisite prompt and dispatch always name the minted branch`, () => {
  const prerequisiteBranch = "run-unfiled-42";
  const prompt = renderPrerequisitePrPrompt({ ...PROMPT_ARGS, prerequisiteBranch });
  assert.match(prompt, /git switch -c run-unfiled-42 origin\/main/);
  assert.match(prompt, /gh pr create --head run-unfiled-42/);
  assert.match(prompt, /## Acceptance/);
  assert.equal(buildPrerequisitePrDispatchArgs({ ...DISPATCH_ARGS, prerequisiteBranch }).prompt, prompt);
});

async function drive(missing: readonly ("readLiveHead" | "fetchPrBody")[]) {
  return withTempDir("w1-t5810-contract", async (dir) => {
    const logs: Array<{ step: string } & Record<string, unknown>> = [];
    const ciWaits: string[] = [];
    const issues: string[] = [];
    const reads: string[] = [];
    let prompt = "";
    const deps: Parameters<typeof runFixRung>[0]["deps"] = {
      spawn: async (args) => {
        prompt = args.prompt;
        return {
          sessionId: "s", costUsd: 0, numTurns: 1, text: `PR_URL: ${PREREQUISITE_URL}`,
          blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
          permissionDenials: [], childEnvKeys: [], model: "default", effort: "default",
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        } satisfies WorkerResult;
      },
      waitForCiGreen: async (url) => { ciWaits.push(url); return "green"; },
      runReview: async () => { throw new Error("the prerequisite path must return before re-review"); },
      push: () => { throw new Error("the original branch must stay untouched"); },
      issues: { create: (title) => { issues.push(title); return "https://github.com/acme/remudero/issues/8888"; } },
      ledgerPath: join(dir, "ledger.ndjson"),
      log: (step, fields) => logs.push({ step, ...fields }),
      say: () => {},
      account: (result) => result,
      ledgerLines: () => [],
      readPrerequisiteState: async () => ({ ok: true, state: "OPEN" }),
      ...(!missing.includes("readLiveHead") ? {
        readLiveHead: () => {
          reads.push("readLiveHead");
          const headRefName = prompt.match(/run-unfiled-\d+/)?.[0];
          assert.ok(headRefName, "the dispatched prompt supplies the head being admitted");
          return { ok: true, headSha: "abc", headRefName };
        },
      } : {}),
      ...(!missing.includes("fetchPrBody") ? {
        fetchPrBody: async () => {
          reads.push("fetchPrBody");
          return "## Acceptance\n- the instrument reads the new field | grep: newField in scripts/diff-coverage.mjs";
        },
      } : {}),
    };
    const outcome = await runFixRung({
      ...DISPATCH_ARGS,
      initialSessionId: "session-0",
      strikeCap: 3,
      escalationJudge: async () => ({ decision: "deliver", reason: "missing prerequisite input" }),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: dir, reviewerMount: MOUNT },
      initialReview: {
        state: "failure", criteria: [], testTheater: false, summary: "entangled", floorDegraded: false,
        capped: false, keywordOnly: false, planOnly: false, instrumentEntangled: true,
        instrumentEntanglementPaths: { instrumentPaths: PROMPT_ARGS.instrumentPaths, srcPaths: PROMPT_ARGS.srcPaths },
        headSha: "deadbeef", reviewerOutcome: "success",
      },
      deps,
    });
    return { outcome, logs, ciWaits, issues, reads };
  });
}

for (const missing of [["readLiveHead"], ["fetchPrBody"], ["readLiveHead", "fetchPrBody"]] as const) {
  test(`${PROOF}: a rung missing ${missing.join(" and ")} refuses without waiting on CI`, async () => {
    const result = await drive(missing);
    assert.equal(result.outcome.outcome, "escalated");
    assert.equal(result.outcome.strikes, 0);
    assert.deepEqual(result.ciWaits, []);
    assert.equal(result.issues.length, 1);
    const refusal = result.logs.find((row) => row.step === "fix.prerequisite_dispatch_failed");
    assert.ok(refusal, "missing readers produce a dispatch failure");
    for (const reader of missing) assert.ok(String(refusal.reason).includes(reader), `the reason names ${reader}`);
  });
}

test(`${PROOF}: a rung with both readers admits the prerequisite and waits on CI`, async () => {
  const result = await drive([]);
  assert.equal(result.outcome.outcome, "parked");
  assert.deepEqual(result.reads, ["readLiveHead", "fetchPrBody"]);
  assert.deepEqual(result.ciWaits, [PREREQUISITE_URL]);
  assert.deepEqual(result.issues, []);
});
