import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSweepEffects, deployStateRowsOffLoop, renderClarificationQuestion, runEscalationReconcile, type OpenPrView } from "#src/lib/sweep.js";
import { startReadPlaneTelemetry } from "#src/lib/read-plane.js";
import { clockFromMillisFn } from "#src/lib/clock.js";

import { ghTextAsync } from "#src/lib/github-transport.js";
import { realDeployDeps, realDeploySensorsAsync, type RealDeployOpts } from "#src/lib/deployer.js";
import { applyPlanProposalCommitAsync } from "#src/lib/plan-architect.js";
import { buildBehindMainByPrAsync, buildEscalationReconcileCandidatesAsync } from "#src/lib/tick-read-worker.js";
import { buildEscalationCloserAsync, ghLiveStateAsync, readFixRoundCommitsViaGit, readFixRoundCommitsViaGitAsync, updateBranchViaGh } from "#src/run-task.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";

async function withoutSyncSpawn<T>(run: () => T | Promise<T>): Promise<T> {
  let ticks = 0;
  const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => ++ticks) });
  try {
    const result = await run();
    const sample = telemetry.sample();
    assert.equal(sample.sync_spawn_ms, 0, JSON.stringify(sample.sync_spawn_by_caller));
    assert.deepEqual(sample.sync_spawn_by_caller, []);
    return result;
  } finally {
    telemetry.stop();
  }
}

test("W1-T10075: the escalation reconcile closes issues without a sync spawn on the daemon path", async () => {
  const events: string[] = [];
  const summary = await withoutSyncSpawn(() => runEscalationReconcile([{
    issueUrl: "https://github.com/o/r/issues/1", taskId: "W1-T1",
    derived: { merged: true, closed: false, prNumber: 2 },
  }], {
    ledgerPath: "/unused", runId: "test",
    closeIssue: async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      events.push("closed");
    },
    appendLine: () => { events.push("recorded"); },
  }));
  assert.equal(summary.closed, 1);
  assert.deepEqual(events, ["closed", "recorded"]);
});


const candidate = {
  issueUrl: "https://github.com/o/r/issues/1", taskId: "W1-T1",
  derived: { merged: true, closed: false, prNumber: 2 },
};

function shimFor(t: TestContext, routes: GhShimRoute[]) {
  const shim = ghShim(routes, { kind: "freshness-drain" });
  const saved = { PATH: process.env.PATH, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    RMD_GH_SHARED_READ_GAP_MS: process.env.RMD_GH_SHARED_READ_GAP_MS };
  process.env.PATH = `${shim.dir}:${saved.PATH ?? ""}`;
  process.env.XDG_CACHE_HOME = shim.dir;
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(shim.dir, { recursive: true, force: true });
  });
  return shim;
}

function deployOpts(dir: string): RealDeployOpts {
  return { installPath: dir, stateRoot: dir, ledgerPath: join(dir, "ledger.ndjson"),
    daemonLabel: "fixture", serveLabel: "fixture", servePort: 1, uid: 0, log: () => {} };
}

function seededInputs(t: TestContext) {
  const repo = gitRepo({ kind: "freshness-drain", scope: t, seedCommit: false });
  writeFileSync(join(repo.dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFileSync(join(repo.dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { version: "1.0.0" } } }));
  repo.git("add", ".");
  repo.git("commit", "-m", "chore: seed image inputs");
  const sha = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", sha);
  return { repo, sha };
}

test("the sampler sees a positive control sync spawn", () => {
  let ticks = 0;
  const telemetry = startReadPlaneTelemetry({ clock: clockFromMillisFn(() => ++ticks) });
  try {
    execFileSync(process.execPath, ["-e", ""]);
    const sample = telemetry.sample();
    assert.ok(sample.sync_spawn_ms > 0);
    assert.ok(sample.sync_spawn_by_caller.length > 0);
  } finally { telemetry.stop(); }
});

test("the reconcile's real close gateway uses the async transport", async t => {
  const shim = shimFor(t, []);
  const rows: unknown[] = [];
  const result = await withoutSyncSpawn(() => runEscalationReconcile([candidate], {
    closeIssue: buildEscalationCloserAsync("o", "r"), ledgerPath: "/unused", runId: "test",
    appendLine: row => { rows.push(row); },
  }));
  assert.equal(result.closed, 1);
  assert.equal(rows.length, 1);
  assert.ok(shim.calls().some(call => call.startsWith("issue close ")));
});

test("an async close rejection is contained before recording success and the next issue closes", async () => {
  const rows: unknown[] = [];
  const summary = await runEscalationReconcile([candidate, { ...candidate, issueUrl: "second" }], {
    closeIssue: async url => { if (url === candidate.issueUrl) throw new Error("close refused"); },
    ledgerPath: "/unused", runId: "test", appendLine: row => { rows.push(row); },
  });
  assert.deepEqual(summary.results.map(row => row.outcome), ["close-failed", "closed"]);
  assert.equal(summary.closed, 1);
  assert.equal(rows.length, 1);
});

test("W1-T10075: the deployer.s git reads record no sync spawn on the daemon path", async t => {
  const { repo, sha } = seededInputs(t);
  const sensors = realDeploySensorsAsync(deployOpts(repo.dir), ghTextAsync);
  assert.equal(await withoutSyncSpawn(() => sensors.newestBakedSha()), sha);
  assert.equal(realDeployDeps(deployOpts(repo.dir)).newestBakedSha!(), sha, "the sync CLI contract is preserved");
  const rows = await withoutSyncSpawn(() => deployStateRowsOffLoop({
    deploy: sensors, requestDeploy: () => {}, deployRequested: () => false,
    failedAt: () => undefined, clearFailure: () => {},
  }, []));
  assert.deepEqual(rows.map(row => row.pipeline), ["image", "deploy"]);
});

test("all daemon deploy sensors await their processes and retain unknown outcomes", async t => {
  const { repo, sha } = seededInputs(t);
  repo.addRemote("origin", "https://github.com/o/r.git");
  const shim = shimFor(t, [{ when: "run list", stdout: "[]" }]);
  writeFileSync(join(shim.dir, "docker"), `#!/bin/sh\nprintf '%s\\n' '${sha}'\n`, { mode: 0o755 });
  const sensors = realDeploySensorsAsync(deployOpts(repo.dir), ghTextAsync);
  assert.equal(await withoutSyncSpawn(() => sensors.imageBakedCommitsBehind()), 0);
  assert.equal(await withoutSyncSpawn(() => sensors.imageBuildInFlight()), false);
  await withoutSyncSpawn(() => sensors.dispatchImageBuild());
  assert.ok(shim.calls().some(call => call.startsWith("workflow run ")));
  assert.equal(await withoutSyncSpawn(() => sensors.imagePublished(sha)), undefined, "no registry is unknown");
  writeFileSync(join(shim.dir, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal(await withoutSyncSpawn(() => sensors.imageBakedCommitsBehind()), undefined);
  shim.addRoute({ when: "run list", exit: 1, stderr: "unreadable" });
  assert.equal(await withoutSyncSpawn(() => sensors.imageBuildInFlight()), undefined);
  const broken = realDeploySensorsAsync({ ...deployOpts(repo.dir), installPath: join(repo.dir, "missing") }, ghTextAsync);
  assert.equal(await withoutSyncSpawn(() => broken.newestBakedSha()), undefined);
  await assert.rejects(withoutSyncSpawn(() => broken.dispatchImageBuild()), /origin is not a github.com remote|Command failed/);
});

test("W1-T10075: the fix-round commit read records no sync spawn on the daemon path", async t => {
  const { repo, sha } = seededInputs(t);
  writeFileSync(join(repo.dir, "change.txt"), "the repair\n");
  repo.git("add", "change.txt");
  repo.git("commit", "-m", "fix: repair the fixture");
  const commits = await withoutSyncSpawn(() => readFixRoundCommitsViaGitAsync(repo.dir, sha));
  assert.deepEqual(commits, readFixRoundCommitsViaGit(repo.dir, sha));
  assert.equal(commits[0]?.subject, "fix: repair the fixture");
  assert.equal(commits[0]?.changedFiles, 1);
  assert.match(commits[0]?.diffDigest ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(await withoutSyncSpawn(() => readFixRoundCommitsViaGitAsync(repo.dir, "HEAD")), []);
  await assert.rejects(withoutSyncSpawn(() => readFixRoundCommitsViaGitAsync(repo.dir, "missing")));
});

test("the live-state, compare and branch-update defaults spawn asynchronously", async t => {
  const shim = shimFor(t, [
    { when: "compare/", stdout: JSON.stringify({ ahead_by: 4, files: [{ filename: "src/a.ts" }] }) },
    { when: "update-branch", stdout: "{}" },
    { when: "pulls/2", stdout: JSON.stringify({ state: "open", head: { sha: "head" } }) },
  ]);
  const pr = { prNumber: 2, prUrl: "https://github.com/o/r/pull/2", headSha: "head",
    lastActivityAt: new Date().toISOString() } as OpenPrView;
  assert.deepEqual(await withoutSyncSpawn(() => ghLiveStateAsync(pr.prUrl)), { ok: true, state: "OPEN", headSha: "head" });
  const files = new Map();
  const distances = await withoutSyncSpawn(() => buildBehindMainByPrAsync("o", "r", [pr], undefined, undefined, files));
  assert.equal(distances.get(2), 4);
  assert.deepEqual(files.get(2), { files: ["src/a.ts"], truncated: false });
  assert.equal(await withLiveWritesAllowed(() => withoutSyncSpawn(() => updateBranchViaGh(pr, () => {}))), "updated");
  assert.ok(shim.calls().some(call => call.includes("update-branch")));
  assert.deepEqual(await ghLiveStateAsync("invalid"), { ok: false });
  shim.addRoute({ when: "pulls/2", exit: 1, stderr: "offline" });
  assert.deepEqual(await withoutSyncSpawn(() => ghLiveStateAsync(pr.prUrl)), { ok: false });
  shim.addRoute({ when: "compare/", exit: 1 });
  assert.equal((await withoutSyncSpawn(() => buildBehindMainByPrAsync("o", "r", [pr]))).size, 0);
});

test("the daemon lists retirable issues and files an escalation through asynchronous gateway steps", async t => {
  const repo = gitRepo({ kind: "drain-escalation", scope: t });
  const shim = shimFor(t, [
    { when: "issues?", stdout: "[]" },
    { when: "issue create", stdout: "https://github.com/o/r/issues/9" },
  ]);
  const plan = { tasks: [], byId: new Map() } as unknown as Plan;
  const ledgerPath = join(repo.dir, "ledger.ndjson");
  let intake: unknown;
  assert.deepEqual(await withoutSyncSpawn(() => buildEscalationReconcileCandidatesAsync("o", "r", plan, ledgerPath, () => {}, {
    evidenceRootFor: () => undefined, onIntake: value => { intake = value; },
  })), []);
  assert.deepEqual(intake, { issuesSeen: 0, droppedNoTaskTrailer: 0, droppedNoReferent: 0 });
  const effects = buildSweepEffects({ owner: "o", repo: "r", repoRoot: repo.dir,
    localRepoName: "r", config: { root: repo.dir } as Config, ledgerPath, runId: "test", plan, log: () => {},
  });
  const pr = { prNumber: 2, prUrl: "https://github.com/o/r/pull/2",
    headSha: "head", mergeState: "clean", reviewState: "none", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date().toISOString() } as OpenPrView;
  await withLiveWritesAllowed(() => withoutSyncSpawn(() => effects.escalate(pr,
    "operator input", renderClarificationQuestion(pr, "operator input", []))));
  assert.ok(shim.calls().some(call => call.startsWith("label create ")));
  assert.ok(shim.calls().some(call => call.startsWith("issue create ")));
});

test("the leaf plan commit runs asynchronously and preserves staged plan output", async t => {
  const { repo } = seededInputs(t);
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@invalid.test");
  mkdirSync(join(repo.dir, "plan"));
  writeFileSync(join(repo.dir, "plan", "proposal.yaml"), "proposal: true\n");
  writeFileSync(join(repo.dir, "MASTER-PLAN.md"), "proposal\n");
  await withoutSyncSpawn(() => applyPlanProposalCommitAsync(repo.dir, "chore: record proposal"));
  assert.equal(repo.git("log", "-1", "--format=%s"), "chore: record proposal");
  assert.match(repo.git("show", "--stat", "--format="), /proposal.yaml/);
});

test("the async plan commit restores its index snapshot and rethrows the original refusal", async () => {
  const calls: string[] = [];
  const error = new Error("commit refused");
  await assert.rejects(applyPlanProposalCommitAsync("/fixture", "chore: proposal", () => {}, async (_cwd, args) => {
    calls.push(args[0]!);
    if (args[0] === "write-tree") return "snapshot";
    if (args[0] === "commit") throw error;
    if (args[0] === "read-tree") assert.equal(args[1], "snapshot");
    return "";
  }), thrown => thrown === error);
  assert.deepEqual(calls, ["write-tree", "add", "commit", "read-tree"]);
});

for (const failure of ["snapshot", "rollback"] as const) {
  test(`an async plan ${failure} failure is recorded while the original commit error propagates`, async () => {
    const events: string[] = [];
    const error = new Error("original commit refusal");
    await assert.rejects(applyPlanProposalCommitAsync("/fixture", "chore: proposal", step => { events.push(step); }, async (_cwd, args) => {
      if (args[0] === "write-tree") { if (failure === "snapshot") throw new Error("snapshot unavailable"); return "tree"; }
      if (args[0] === "commit") throw error;
      if (args[0] === "read-tree") throw new Error("rollback unavailable");
      return "";
    }), thrown => thrown === error);
    assert.deepEqual(events, failure === "snapshot"
      ? ["plan_commit.snapshot.error", "plan_commit.rollback.skipped"] : ["plan_commit.rollback.error"]);
  });
}
