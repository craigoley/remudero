import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { withTempDir } from "../src/lib/tmp.js";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import {
  renderDiagnosePrompt,
  renderFixPrompt,
  renderImplementPrompt,
  renderPrerequisitePrPrompt,
  renderReconPrompt,
} from "../src/lib/prompt-render.js";
import {
  buildPrerequisitePrDispatchArgs,
  prerequisitePrAdmissionRefusal,
  runFixRung,
  renderDiagnosePrompt as compatRenderDiagnosePrompt,
  renderFixPrompt as compatRenderFixPrompt,
  renderImplementPrompt as compatRenderImplementPrompt,
  renderPrerequisitePrPrompt as compatRenderPrerequisitePrPrompt,
  renderReconPrompt as compatRenderReconPrompt,
} from "./helpers/run-task-test.js";

const TASK: Task = {
  id: "W1-T2886X",
  title: "move prompt renderers",
  repo: "remudero",
  depends_on: [],
  type: "implement",
  risk: "high",
  verify: "auto",
  status: "queued",
  attempts: 0,
  context: [{ claim: "Recon observed the renderer locations", src: "recon#W1-T2886X" }],
  prompt: "Implement ${TASK_ID} during ${RUN_ID}",
  files: ["src/run-task.ts", "src/lib/prompt-render.ts", "test/prompt-render.test.ts"],
};

const UNMET = {
  claim: "the renderer moved",
  proof: "grep: lib/prompt-render in src/run-task.ts",
  met: false,
  reason: "renderFixPrompt still lives in the dispatcher",
  proof_exec: "not_executable",
} as const;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function contextLines(prompt: string): string[] {
  const [, afterContext = ""] = prompt.split("# CONTEXT\n");
  const [context = ""] = afterContext.split("\n\n# TASK");
  return context.split("\n").filter((line) => line.trim().length > 0);
}

test("prompt renderers: lib exports stay byte-identical to the pre-move dispatcher templates", () => {
  const fix = renderFixPrompt({
    task: TASK,
    round: 2,
    branch: "run-W1-T2886X-1700000000000",
    evidence: { review: { unmetCriteria: [UNMET], summary: "one criterion unmet" } },
    baselineDiffFiles: ["src/run-task.ts"],
  });
  const prerequisite = renderPrerequisitePrPrompt({
    task: TASK,
    branch: "run-W1-T2886X-1700000000000",
    prUrl: "https://github.com/craigoley/remudero/pull/2886",
    instrumentPaths: ["test/prompt-render.test.ts"],
    srcPaths: ["src/run-task.ts", "src/lib/prompt-render.ts"],
    prerequisiteBranch: "run-unfiled-1700000000000",
  });
  const recon = renderReconPrompt(
    "PLAN INDEX\n- section 1: Mission",
    "## OPERATOR NOTES\n- verify byte identity",
    TASK,
    "plan/tasks.d/W1-T2886.yaml",
  );
  const diagnose = renderDiagnosePrompt(TASK, "first attempt failed\nsecond attempt failed");
  const implement = renderImplementPrompt(
    TASK,
    "- Renderer locations observed [src: recon#W1-T2886X]",
    "RUN-2886",
    "- Move pure templates to lib [src: learnings#standing-rule-7]",
    "## OPERATOR NOTES\n- keep API stable",
    "- Rule headline [src: plan#W1-T2508]",
  );

  // W1-T4432: the plan index is no longer a regenerable artifact, so the fix prompt's generated
  // registry exception list intentionally no longer includes plan/plan-index.json.
  // W1-T4268 re-baselined fix: it now carries GH_PR_EDIT_FALLBACK_LINES
  // (test/gh-pr-edit-fallback-contract.test.ts pins the new text itself).
  // W1-T5532 intentionally adds the typed FIX_OUTCOME contract; its exact wording is pinned above.
  // W1-T6465 re-baselined fix: NEEDS_SCOPE now tells the worker to keep out-of-scope edits saved
  // (test/a-fix-round-that-needs-scope-gets-it.test.ts pins the new text itself).
  assert.equal(sha256(fix), "178ed4a5d6104ffbd54cb01067dbc57c30d84c2cfcab13904eb785f1d2d491af");
  assert.equal(sha256(prerequisite), "802d1ed90dfcdf9bafe73c210c63c61a2856e36228cd268235bc412543518b2b");
  // W1-T3656 DELIBERATELY diverged this ONE template. renderReconPrompt no longer names shell
  // binaries ("git remote -v, git log --oneline -5, ls"), because a worker holding the allowlisted
  // check-runner instead of a shell cannot follow those literally -- which pinned the recon lane to
  // Claude. The observations it asks for are unchanged; only the instruction to use a shell is gone.
  // Re-baselined rather than reverted. The other four hashes are untouched, so this test still
  // guards W1-T2886's move for every template that did NOT intentionally change.
  // W1-T4106 re-baselined fix and implement: both now carry ONE_TEST_SUITE_AT_A_TIME_LINE.
  assert.equal(sha256(recon), "45ccd6b3f8cf9ffbf89a5d7bbe0c5c946cfa9bb27a0faea04d1f920ccdde66ad");
  // W1-T4330 re-baselined diagnose: its contract now leads with REPRODUCTION and adds FALSIFIER
  // (test/a-diagnose-report-names-a-red-capable-reproduction.test.ts pins the new text itself).
  assert.equal(sha256(diagnose), "ab2e0942887144a79c234d86a5b65ef390d05babe7c116bb4f8bd3fa5bf0fa49");
  // Re-baselined implement: its contract now teaches the QUESTION / CURRENT_ASSUMPTION lines
  // (test/a-worker-is-taught-the-question-contract.test.ts pins the new text itself).
  // Re-baselined implement: its DECISION_REQUEST now asks for a FALSIFIER line
  // (test/a-decision-request-names-its-falsifier.test.ts pins the new text itself).
  // W1-T4114 re-baselined implement: its contract now asks for a SKILLS_USED line
  // (test/the-knowledge-gardener-tends-rules-and-skills.test.ts pins the new text itself).
  // Re-baselined implement: its contract now opens with a scope-time check before the first edit
  // (test/implement-contract-orders-a-scope-time-check.test.ts pins the new text itself).
  // W1-T4268 re-baselined implement: outputContractLines now splices GH_PR_EDIT_FALLBACK_LINES.
  assert.equal(sha256(implement), "8b8d0b88b9c8126df909c182edb7da9855fac054a923840c3bdbd08057ba41a2");
});

test("prompt renderers: run-task keeps compatibility re-exports of the lib templates", () => {
  assert.equal(
    renderFixPrompt({
      task: TASK,
      round: 2,
      branch: "run-W1-T2886X-1700000000000",
      evidence: { review: { unmetCriteria: [UNMET], summary: "one criterion unmet" } },
    }),
    compatRenderFixPrompt({
      task: TASK,
      round: 2,
      branch: "run-W1-T2886X-1700000000000",
      evidence: { review: { unmetCriteria: [UNMET], summary: "one criterion unmet" } },
    }),
  );
  assert.equal(
    renderPrerequisitePrPrompt({
      task: TASK,
      branch: "run-W1-T2886X-1700000000000",
      prUrl: "https://github.com/craigoley/remudero/pull/2886",
      instrumentPaths: ["test/prompt-render.test.ts"],
      srcPaths: ["src/run-task.ts", "src/lib/prompt-render.ts"],
      prerequisiteBranch: "run-unfiled-1700000000000",
    }),
    compatRenderPrerequisitePrPrompt({
      task: TASK,
      branch: "run-W1-T2886X-1700000000000",
      prUrl: "https://github.com/craigoley/remudero/pull/2886",
      instrumentPaths: ["test/prompt-render.test.ts"],
      srcPaths: ["src/run-task.ts", "src/lib/prompt-render.ts"],
      prerequisiteBranch: "run-unfiled-1700000000000",
    }),
  );
  assert.equal(renderReconPrompt("PLAN INDEX"), compatRenderReconPrompt("PLAN INDEX"));
  assert.equal(renderDiagnosePrompt(TASK, "evidence"), compatRenderDiagnosePrompt(TASK, "evidence"));
  assert.equal(renderImplementPrompt(TASK, "", "RUN-2886"), compatRenderImplementPrompt(TASK, "", "RUN-2886"));
});

test("renderImplementPrompt: every injected CONTEXT line still carries a provenance citation", () => {
  const prompt = renderImplementPrompt(
    TASK,
    "- Renderer locations observed [src: recon#W1-T2886X]",
    "RUN-2886",
    "- Move pure templates to lib [src: learnings#standing-rule-7]",
    "- Operator note is cited [src: operator#W1-T2886X]",
    "- Rule headline [src: plan#W1-T2508]",
  );

  assert.ok(contextLines(prompt).length > 0);
  assert.deepEqual(
    contextLines(prompt).filter((line) => !line.includes("[src:")),
    [],
  );
});

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

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COMPILER = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
const TYPE_FLAGS = [
  "--ignoreConfig", "--strict", "--skipLibCheck", "--esModuleInterop",
  "--module", "nodenext", "--target", "ES2022", "--lib", "ES2023,DOM",
];
const REJECTED_CALLS = `
  declare const args: Omit<Parameters<typeof buildPrerequisitePrDispatchArgs>[0], "prerequisiteBranch">;
  buildPrerequisitePrDispatchArgs({ ...args, prerequisiteBranch: "run-unfiled-42" });
  prerequisitePrAdmissionRefusal("url", "branch", {
    readLiveHead: () => ({ ok: false }), fetchPrBody: async () => "",
  });
  // @ts-expect-error W1-T5810: the dispatch builder requires the minted branch.
  buildPrerequisitePrDispatchArgs(args);
  // @ts-expect-error W1-T5810: the admission check requires a head reader.
  prerequisitePrAdmissionRefusal("url", "branch", { fetchPrBody: async () => "" });
  // @ts-expect-error W1-T5810: the admission check requires a body reader.
  prerequisitePrAdmissionRefusal("url", "branch", { readLiveHead: () => ({ ok: false }) });
`;

function compileTypes(args: string[]) {
  return spawnSync(process.execPath, [COMPILER, ...TYPE_FLAGS, ...args], {
    encoding: "utf8", timeout: 60_000,
  });
}

// Check the real exported signatures, without making unrelated implementation diagnostics fail
// this contract. The repository's separate typecheck still checks those implementation bodies.
async function checkPrerequisiteTypes(root: string, entry: string) {
  return withTempDir("w1-t7410-types", (dir) => {
    symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const emitted = compileTypes([
      "--noCheck", "--declaration", "--emitDeclarationOnly", "--rootDir", root,
      "--outDir", join(dir, "types"), entry,
    ]);
    assert.ifError(emitted.error);
    assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);
    const modulePath = "./types/" + relative(root, entry).split("\\").join("/").replace(/\.ts$/, ".js");
    const fixture = join(dir, "contract.mts");
    writeFileSync(fixture,
      `import { buildPrerequisitePrDispatchArgs, prerequisitePrAdmissionRefusal } from ${JSON.stringify(modulePath)};\n` +
      REJECTED_CALLS);
    return compileTypes(["--noEmit", fixture]);
  });
}

test(`${PROOF}: a type check rejects omitted branch and reader arguments`, async () => {
  const checked = await checkPrerequisiteTypes(REPO_ROOT, join(REPO_ROOT, "src/run-task.ts"));
  assert.ifError(checked.error);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});

test("W1-T7410 pins the cause of the intermittent failure", async () => {
  await withTempDir("w1-t7410-order", async (dir) => {
    mkdirSync(join(dir, "src"));
    const entry = join(dir, "src/entry.ts");
    const source = `
      import "./unrelated.js";
      export function buildPrerequisitePrDispatchArgs(args: { prerequisiteBranch: string }) { return args; }
      export async function prerequisitePrAdmissionRefusal(url: string, branch: string, read: {
        readLiveHead: (url: string) => { ok: false }; fetchPrBody: (url: string) => Promise<string>;
      }) { return undefined; }
    `;
    writeFileSync(entry, source);
    // Force an unrelated imported body to be broken BEFORE the contract check, as in run 37941672866.
    writeFileSync(join(dir, "src/unrelated.ts"),
      'const view: { readPaced: true } | (() => void) = () => {};\nview.readPaced;\n');
    const poisoned = compileTypes(["--noEmit", entry]);
    assert.ifError(poisoned.error);
    assert.equal(poisoned.status, 1, poisoned.stdout + poisoned.stderr);
    assert.match(poisoned.stdout + poisoned.stderr, /TS2339.*readPaced/);

    const isolated = await checkPrerequisiteTypes(dir, entry);
    assert.ifError(isolated.error);
    assert.equal(isolated.status, 0, isolated.stdout + isolated.stderr);

    for (const required of ["prerequisiteBranch", "readLiveHead", "fetchPrBody"]) {
      writeFileSync(entry, source.replace(`${required}:`, `${required}?:`));
      const relaxed = await checkPrerequisiteTypes(dir, entry);
      assert.ifError(relaxed.error);
      assert.equal(relaxed.status, 1, relaxed.stdout + relaxed.stderr);
      assert.match(relaxed.stdout + relaxed.stderr, /TS2578.*Unused '@ts-expect-error'/);
    }
  });
});

test(`${PROOF}: the dispatch uses the prerequisite renderer output`, () => {
  const prerequisiteBranch = "run-unfiled-42";
  const prompt = renderPrerequisitePrPrompt({ ...PROMPT_ARGS, prerequisiteBranch });
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
