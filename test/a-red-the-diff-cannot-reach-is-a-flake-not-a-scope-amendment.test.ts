// W1-T9561 — a NEEDS_SCOPE for a red the PR's diff cannot reach is rerouted to the flake rerun, never a scope
// amendment. The fixture is #11702's shape (2026-10-14): a learnings task whose diff is learnings/ci.yaml, a
// golden-verdict fixture directory and test/golden-verdicts.test.ts, red on a host-snapshot test that passes at
// main, and a worker that answered `FIX_OUTCOME: NEEDS_SCOPE deploy/host-update.sh`.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { decideFixOutcomeAction, readRedAttribution, redAttribution } from "../src/lib/fix-outcome.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import { runFixRung } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
type Row = { step: string } & Record<string, unknown>;
type Run = Parameters<typeof runFixRung>[0];

const SNAPSHOT_TEST = "test/the-state-snapshot-actually-runs-on-this-host.test.ts";
const GOLDEN_READER = "test/golden-verdicts-reader.test.ts";
const REPORT = "The red is a SIGPIPE race in deploy/host-update.sh: with no RMD_STATE_BACKUP_KEEP the nightly rung keeps the newest 2 snapshots, 141 !== 0.\n" +
  "I edited deploy/host-update.sh.\n\nIt is outside this task's files.\n\nFIX_OUTCOME: NEEDS_SCOPE deploy/host-update.sh";

function fixture(opts: { headChanges?: Record<string, string>; failing?: string; verdict?: "passes" | "fails" | "none" } = {}) {
  const repo = gitRepo({ kind: "w1-t9561" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  const put = (path: string, text: string) => {
    mkdirSync(join(repo.dir, dirname(path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  put("src/lib/snapshot.ts", "export const keep = 2;\n");
  put(SNAPSHOT_TEST, 'import { keep } from "../src/lib/snapshot.js";\nvoid keep;\n');
  put(GOLDEN_READER, 'import { join } from "node:path";\nexport const dir = join("fixtures/golden-verdicts");\n');
  put("test/golden-verdicts.test.ts", "export {};\n");
  put("learnings/ci.yaml", "- old\n");
  put("deploy/host-update.sh", "#!/bin/sh\nls | head -2\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main");
  const mainSha = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", mainSha);
  const changes = opts.headChanges ?? {
    "learnings/ci.yaml": "- old\n- new\n",
    "test/fixtures/golden-verdicts/case.json": "{}\n",
    "test/golden-verdicts.test.ts": "export const golden = 1;\n",
  };
  for (const [path, text] of Object.entries(changes)) put(path, text);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "head");
  const headSha = repo.git("rev-parse", "HEAD");
  const failing = opts.failing ?? SNAPSHOT_TEST;
  const rows: Row[] = [];
  if ((opts.verdict ?? "passes") !== "none") rows.push({ step: "sweep.base_reproduction", task_id: "W1-T9000", pr_number: 11702, head_sha: headSha,
    main_sha: mainSha, verdict: opts.verdict === "fails" ? "reproduced" : "clear",
    files: [{ file: failing, outcome: opts.verdict ?? "passes", duration_ms: 1, cached: false }] });
  let spawns = 0;
  let pushes = 0;
  let requeues = 0;
  const review = {
    state: "failure", criteria: [{ claim: "ci green", proof: "unit test: ci", met: false, reason: "red", proof_exec: "not_executable" }],
    testTheater: false, summary: "red", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha, reviewerOutcome: "failure",
  } as Run["initialReview"];
  const worker: WorkerResult = {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text: REPORT, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
  };
  const run: Run = {
    taskId: "W1-T9000", runId: "w1-t9561-run",
    task: { id: "W1-T9000", title: "learnings", files: ["learnings/ci.yaml", "test/golden-verdicts.test.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/11702", branch: "run-W1-T9000-1",
    worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    ciFailures: [{ name: "test-slow-shard", logTail: `not ok 1 - ${failing}\n  141 !== 0`, jobId: "77" }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      spawn: async () => { spawns++; put("deploy/host-update.sh", "#!/bin/sh\nls | sed -n 1,2p\n"); return worker; },
      readMainTip: () => mainSha,
      requeueCheck: () => { requeues++; return true; },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "REPORT", push: () => { pushes++; },
      issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
      // An offline amendment writer: a shard-less fixture refuses before any real gh call.
      scopeAmendmentWritePorts: { repoDir: repo.dir, findShard: () => undefined, lookupIdentity: () => undefined,
        probeExisting: () => undefined } as unknown as NonNullable<Run["deps"]["scopeAmendmentWritePorts"]>,
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: "W1-T9000", pr_number: 11702, ...extra }), say: () => {}, account: (r) => r,
    },
  };
  return { repo, run, rows, headSha, mainSha, counts: () => ({ spawns, pushes, requeues }) };
}

const step = (rows: readonly Row[], name: string) => rows.filter((row) => row.step === name);

test("W1-T9561: a NEEDS_SCOPE red the diff cannot reach reruns as a flake", async () => {
  const f = fixture();
  const result = await runFixRung(f.run);
  assert.equal(step(f.rows, "fix.scope_needed").length, 0, JSON.stringify(step(f.rows, "fix.scope_rerouted")));
  assert.equal(step(f.rows, "fix.scope_amendment").length, 0);
  assert.equal(f.counts().requeues, 1);
  assert.equal(f.counts().pushes, 0);
  const rerouted = step(f.rows, "fix.scope_rerouted")[0];
  assert.equal(rerouted?.attribution, "diff-cannot-reach");
  assert.deepEqual(rerouted?.paths, ["deploy/host-update.sh"]);
  assert.deepEqual(rerouted?.reached, []);
  assert.deepEqual(rerouted?.failing_test_files, [SNAPSHOT_TEST]);
  assert.equal(rerouted?.head_sha, f.headSha);
  assert.match(String(rerouted?.diagnosis), /SIGPIPE race in deploy\/host-update\.sh/);
  assert.doesNotMatch(String(rerouted?.diagnosis), /FIX_OUTCOME/);
  // The fixture's config root is its worktree, so the round's transcript archive is saved there too.
  assert.ok((rerouted?.saved_paths as string[]).includes("deploy/host-update.sh"));
  assert.ok(!(rerouted?.saved_paths as string[]).includes("learnings/ci.yaml"));
  assert.equal(step(f.rows, "fix.strike_refunded")[0]?.reason, "flake-confirmed");
  assert.equal(result.strikes, 0);
  const done = step(f.rows, "fix.done").at(-1);
  assert.equal(done?.flake_claim, "confirmed");
  assert.equal(done?.flake_claim_source, "scope-rerouted");
  // The worker's out-of-scope edit is never committed to this PR.
  assert.equal(f.repo.git("rev-parse", "HEAD"), f.headSha);
  // The fix footer tells the worker the same rule the harness enforces.
  const prompt = renderFixPrompt({ task: { id: "W1-T9000", title: "learnings", files: ["learnings/ci.yaml"] }, round: 1,
    branch: "run-W1-T9000-1", evidence: { review: { unmetCriteria: [], summary: "red" } }, harnessCommits: true });
  assert.match(prompt, /NEEDS_SCOPE is for a red this PR's diff causes: a red in a file the diff does not touch or reach, which passes at main, is FLAKE/);
});

test("W1-T9561: a NEEDS_SCOPE red the diff reaches still asks for scope", async () => {
  // The failing test imports a module the diff changed.
  const imported = fixture({ headChanges: { "learnings/ci.yaml": "- new\n", "src/lib/snapshot.ts": "export const keep = 3;\n" } });
  await runFixRung(imported.run);
  assert.equal(step(imported.rows, "fix.scope_rerouted").length, 0);
  assert.deepEqual(step(imported.rows, "fix.scope_needed")[0]?.paths, ["deploy/host-update.sh"]);
  assert.equal(step(imported.rows, "fix.scope_needed")[0]?.attribution, "diff-reaches");
  assert.match(String(step(imported.rows, "fix.scope_needed")[0]?.attribution_reason), /src\/lib\/snapshot\.ts/);
  assert.equal(imported.counts().requeues, 0);
  // A fixture the failing test's own source names by directory reaches it, though nothing imports it.
  const named = fixture({ failing: GOLDEN_READER, headChanges: { "test/fixtures/golden-verdicts/case.json": "{}\n" } });
  await runFixRung(named.run);
  assert.equal(step(named.rows, "fix.scope_rerouted").length, 0);
  assert.equal(step(named.rows, "fix.scope_needed")[0]?.attribution, "diff-reaches");
  assert.match(String(step(named.rows, "fix.scope_needed")[0]?.attribution_reason), /test\/fixtures\/golden-verdicts\/case\.json/);
  // Pure: a CI harness path and a root-level file reach every red.
  for (const path of ["scripts/run.mjs", "package.json", SNAPSHOT_TEST]) {
    const attribution = redAttribution({ failingTestFiles: [SNAPSHOT_TEST], changedPaths: [path], closure: new Map([[SNAPSHOT_TEST, new Set([SNAPSHOT_TEST])]]),
      baseOutcomes: new Map([[SNAPSHOT_TEST, "passes"]]), isHarnessPath: (p) => p.startsWith("scripts/"), namedInClosure: new Set() });
    assert.deepEqual([attribution.kind, attribution.reached], ["diff-reaches", [path]], path);
    assert.equal(decideFixOutcomeAction({ kind: "NEEDS_SCOPE", paths: ["deploy/host-update.sh"] }, { admitTests: true, attribution }).kind, "scope-needed");
  }
});

test("W1-T9561: an unknown attribution keeps the scope amendment", async () => {
  // No base verdict at main for the failing file.
  const unverdicted = fixture({ verdict: "none" });
  await runFixRung(unverdicted.run);
  assert.equal(step(unverdicted.rows, "fix.scope_rerouted").length, 0);
  assert.equal(step(unverdicted.rows, "fix.scope_needed")[0]?.attribution, "unknown");
  assert.equal(unverdicted.counts().requeues, 0);
  // The failing file fails at main: that is BASE_RED territory, never a flake.
  const red = fixture({ verdict: "fails" });
  await runFixRung(red.run);
  assert.match(String(step(red.rows, "fix.scope_needed")[0]?.attribution_reason), /no passing verdict at main/);
  // An unreadable closure: the failing file is in neither tree.
  const ghost = fixture({ failing: "test/ghost.test.ts" });
  await runFixRung(ghost.run);
  assert.match(String(step(ghost.rows, "fix.scope_needed")[0]?.attribution_reason), /no import closure for test\/ghost\.test\.ts/);
  // Pure: every missing fact is unknown, and unknown never reroutes.
  const base = { failingTestFiles: [SNAPSHOT_TEST], changedPaths: ["learnings/ci.yaml", "test/fixtures/g/case.json"],
    closure: new Map([[SNAPSHOT_TEST, new Set([SNAPSHOT_TEST])]]), baseOutcomes: new Map([[SNAPSHOT_TEST, "passes" as const]]),
    isHarnessPath: () => false, namedInClosure: new Set<string>(), censusWalks: new Map([[SNAPSHOT_TEST, []]]) };
  assert.equal(redAttribution(base).kind, "diff-cannot-reach");
  for (const [why, input] of [
    ["no failing file", { ...base, failingTestFiles: [] }], ["diff unread", { ...base, changedPaths: undefined }],
    ["closure unread", { ...base, closure: undefined }], ["no base verdict", { ...base, baseOutcomes: undefined }],
    ["fixture naming unread", { ...base, namedInClosure: undefined }], ["rerun reproduced", { ...base, rerunReproduced: true }],
  ] as const) {
    const attribution = redAttribution(input);
    assert.equal(attribution.kind, "unknown", why);
    assert.equal(decideFixOutcomeAction({ kind: "NEEDS_SCOPE", paths: ["deploy/host-update.sh"] }, { admitTests: true, attribution }).kind, "scope-needed", why);
  }
  // Every read that throws is unread, never an empty answer.
  const reads = { failingTestFiles: [SNAPSHOT_TEST], headSha: "h", prNumber: 1, ledger: [], rerunReproduced: false, isHarnessPath: () => false,
    mainTip: () => "m", changedPaths: () => ["test/fixtures/g/case.json"], closure: async () => new Map([[SNAPSHOT_TEST, new Set([SNAPSHOT_TEST])]]),
    namedInClosure: () => new Set<string>(), readTestText: () => "export {};" };
  const boom = () => { throw new Error("unreadable"); };
  for (const broken of [{ mainTip: boom }, { changedPaths: boom }, { closure: async () => boom() }, { namedInClosure: boom }, { prNumber: undefined }]) {
    assert.equal((await readRedAttribution({ ...reads, ...broken })).kind, "unknown", JSON.stringify(Object.keys(broken)));
  }
});

test("W1-T9561: a rerouted flake leaves a fix-round flake retry row", async () => {
  for (const green of [true, false]) {
    const f = fixture();
    f.run.deps.waitForCiGreen = async () => green ? "green" : "red";
    await runFixRung(f.run);
    const retries = step(f.rows, "test.flake_retry");
    assert.equal(retries.length, 1, String(green));
    assert.equal(retries[0]?.source, "fix-round");
    assert.equal(retries[0]?.file, SNAPSHOT_TEST);
    assert.equal(retries[0]?.retry_outcome, green ? "recovered" : "also_failed");
    assert.deepEqual(retries[0]?.pr_numbers, [11702]);
    assert.equal(retries[0]?.head_sha, f.headSha);
    if (!green) {
      assert.equal(step(f.rows, "fix.done").at(-1)?.flake_claim, "refuted");
      // A refuted claim on this head ends the reroute: the next NEEDS_SCOPE goes to the amendment as before.
      await runFixRung(f.run);
      assert.equal(step(f.rows, "fix.scope_rerouted").length, 1);
      assert.match(String(step(f.rows, "fix.scope_needed")[0]?.attribution_reason), /a rerun at this head already reproduced/);
    }
  }
});
