import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PreopenGateResult } from "#src/lib/preopen-gate.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { declaredConsoleRoutes } from "#test/helpers/declared-routes.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { COMMANDS, runTask } from "#test/helpers/run-task-test.js";

async function replayPreopen(t: TestContext, recheck: PreopenGateResult, recordedRed: PreopenGateResult) {
  const root = gitRepo({ scope: t });
  const origin = gitRepo({ bare: true, scope: t });
  const seed = gitRepo({ scope: t });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const repo = gitRepo({ cloneFrom: origin.dir, scope: t });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  mkdirSync(join(root.dir, "repos"));
  renameSync(repo.dir, join(root.dir, "repos", "remudero"));
  const planPath = join(root.dir, "tasks.yaml");
  writeFileSync(planPath, "- id: D\n  title: parity replay fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  origin: test\n  status: queued\n  files: [src/D.ts]\n");
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const prUrl = "https://github.com/acme/remudero/pull/1";
  const gh = ghShim([
    { when: "pr view", stdout: JSON.stringify({ headRefName: `run-D-${now}`, body: "Remudero-Task: D" }) },
    { when: "/pulls/1", stdout: JSON.stringify({ number: 1, state: "open", merged: false, head: { sha: "c".repeat(40) } }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
  ]);
  const previousPath = process.env.PATH;
  const previousHooks = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.PATH = `${gh.dir}:${previousPath}`;
  process.env.RMD_HARNESS_HOOKS_DIR = join(root.dir, "hooks");
  mkdirSync(process.env.RMD_HARNESS_HOOKS_DIR);
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
    else process.env.RMD_HARNESS_HOOKS_DIR = previousHooks;
    rmSync(gh.dir, { recursive: true, force: true });
  });

  const worker = (text: string): WorkerResult => ({
    sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [],
    childEnvKeys: [], model: "test", effort: "test", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  });
  let spawns = 0;
  let gateReads = 0;
  let creates = 0;
  const result = await withLiveWritesAllowed(() => runTask("D", {
    config: { claudeBin: "/bin/true", root: root.dir, installRoot: REPO_ROOT, workerProviders: { harnessCommitsImplement: true } },
    skipGitSync: true, planPath, handOffAtPrOpen: true,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "parity-replay-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async token => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, aliasNames: "-", functionNames: "-", costUsd: 0 }),
    readHeadShaForProvenance: () => "c".repeat(40),
    implementPush: async (cwd, options) => {
      seed.git("-C", cwd, "push", ...(options?.force ? ["--force"] : []), origin.dir, `HEAD:refs/heads/run-D-${now}`);
    },
    otherOpenPrReader: async () => [],
    prCreateExec: () => {
      creates++;
      return JSON.stringify({ html_url: prUrl, number: 1 });
    },
    spawn: async args => {
      if (++spawns === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
      mkdirSync(join(args.cwd, "src"), { recursive: true });
      writeFileSync(join(args.cwd, "src/D.ts"), `export const value = ${spawns};\n`);
      return worker("REPORT\nCOMMIT_MESSAGE: fix(test): finish parity replay\n");
    },
    preopenGate: async () => ++gateReads === 1 ? recordedRed : recheck,
  }));
  const rows = readFileSync(join(root.dir, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
  assert.equal(gateReads, 2);
  assert.equal(spawns, 3, "recon, implementation, and its single pre-open continuation");
  return { result, creates, rows };
}

test("W1-T10408: check:test:test/console-parity-ratchet.test.ts:flaky is prevented, not retried", async t => {
  const parity = await import(import.meta.resolve("#scripts/console-parity-ratchet.mjs"));
  // PR #13416 registered review-replay before its CLI_ONLY classification landed.
  const { "review-replay": reviewReplayReason, ...recordedCliOnly } = parity.CLI_ONLY;
  assert.ok(reviewReplayReason);
  const verbs = COMMANDS.map(command => command.name);
  const routes = declaredConsoleRoutes();
  assert.deepEqual(parity.classifyVerbs(verbs, routes).unmapped, []);
  const classification = parity.classifyVerbs(verbs, routes, parity.ROUTE_MATCH, recordedCliOnly);
  assert.deepEqual(classification.unmapped, ["review-replay"]);
  const detail = parity.formatReport({
    ...classification, verbNames: verbs, baselinePath: parity.BASELINE_PATH,
    verdict: parity.ratchetVerdict(classification.cliOnlyVerbs, Object.keys(parity.CLI_ONLY)),
  });
  const recordedRed = {
    kind: "fail", durationMs: 1, failedSteps: ["ci-checks:console-parity"],
    failedDetail: { "ci-checks:console-parity": detail },
  } satisfies PreopenGateResult;

  await t.test("the persistent PR #13416 failure never opens a PR or dispatches a fix", async t => {
    const { result, creates, rows } = await replayPreopen(t, recordedRed, recordedRed);
    assert.equal(creates, 0);
    assert.equal(result.verdict, "failed");
    assert.equal(result.prUrl, undefined);
    assert.equal(rows.some(row => row.step === "pr.opened" || row.step === "fix.dispatch"), false);
    const refusal = rows.find(row => row.step === "pr.open_refused" && row.refusal_class === "console-parity-unmapped");
    assert.equal(refusal?.reason, detail);
  });

  await t.test("a repair that clears parity can open the PR", async t => {
    const { creates, rows } = await replayPreopen(t, { kind: "pass", durationMs: 1 }, recordedRed);
    assert.equal(creates, 1);
    assert.equal(rows.some(row => row.step === "pr.open_refused"), false);
  });
});
