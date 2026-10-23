import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { commitlintStep, emitterChecksStep } from "#src/lib/commit-message.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { PreopenGateResult } from "#src/lib/preopen-gate.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { runTask } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const repo = gitRepo();
  t.after(() => repo.cleanup());
  symlinkSync(join(REPO_ROOT, "node_modules"), join(repo.dir, "node_modules"), "dir");
  copyFileSync(join(REPO_ROOT, "commitlint.config.mjs"), join(repo.dir, "commitlint.config.mjs"));
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

test("W1-T8945: a legacy wip checkpoint commit does not fail the commit-range steps", t => {
  const repo = fixture(t);
  repo.git("commit", "--quiet", "--allow-empty", "-m", "wip: yield at daemon restart");
  repo.git("commit", "--quiet", "--allow-empty", "-m", "feat(x): real work");
  for (const step of [commitlintStep, emitterChecksStep]) {
    const result = step(repo.dir);
    assert.equal(result.ok, true, result.detail);
    assert.match(result.detail, /skipped checkpoint commit 2\/2: wip: yield at daemon restart/);
    if (step === emitterChecksStep) assert.match(result.detail, /PASS — 1 commit message\(s\)/);
  }
});

test("W1-T8945: a malformed worker commit still fails the commit-range steps", t => {
  const repo = fixture(t);
  repo.git("commit", "--quiet", "--allow-empty", "-m", "wip: yield at daemon restart");
  repo.git("commit", "--quiet", "--allow-empty", "-m", "bad subject without type");
  for (const step of [commitlintStep, emitterChecksStep]) {
    const result = step(repo.dir);
    assert.equal(result.ok, false, result.detail);
    assert.match(result.detail, /type-empty/);
    assert.match(result.detail, /skipped checkpoint commit 2\/2: wip: yield at daemon restart/);
  }
});

test("all harness checkpoint subject forms are exempt, while a final checkpoint-scoped fix is linted", t => {
  const repo = fixture(t);
  const subjects = ["wip: legacy", "wip(worker): legacy scoped", "feat(wip): unfinished", "chore(checkpoint): retained"];
  for (const subject of subjects) {
    repo.git("commit", "--quiet", "--allow-empty", "-m", `${subject}\n\n${"x".repeat(120)}`);
  }
  for (const step of [commitlintStep, emitterChecksStep]) {
    const result = step(repo.dir);
    assert.equal(result.ok, true, result.detail);
    for (const subject of subjects) assert.ok(result.detail.includes(subject), result.detail);
    if (step === emitterChecksStep) assert.match(result.detail, /PASS — 0 commit message\(s\)/);
  }
  repo.git("commit", "--quiet", "--allow-empty", "-m", "fix(checkpoint): INVALID.");
  for (const step of [commitlintStep, emitterChecksStep]) {
    const result = step(repo.dir);
    assert.equal(result.ok, false, result.detail);
    assert.match(result.detail, /subject-full-stop/);
  }
});

test("checkpoint filtering preserves commitlint configuration and names failed executions", () => {
  for (const result of [
    { status: null, stdout: "", stderr: "", error: "spawnSync ENOENT" },
    { status: 1, stdout: "worker message rejected", stderr: "" },
  ]) {
    const inputs: string[] = [];
    const checked = commitlintStep(REPO_ROOT, undefined, (file, args, opts) => {
      if (file === "git") return { status: 0, stdout: "\0feat(x): real work\n\0wip: legacy\n", stderr: "" };
      assert.equal(file, process.execPath);
      assert.deepEqual(args, [join(REPO_ROOT, "node_modules", ".bin", "commitlint"), "--config", join(REPO_ROOT, "commitlint.config.mjs")]);
      inputs.push(opts!.input!);
      return result;
    });
    assert.deepEqual(inputs, ["feat(x): real work\n"]);
    assert.equal(checked.ok, false);
    assert.match(checked.detail, /skipped checkpoint commit 2\/2: wip: legacy/);
    assert.ok(checked.detail.includes(result.error ?? result.stdout), checked.detail);
  }
  const thrown = commitlintStep(REPO_ROOT, undefined, file => {
    if (file === "git") return { status: 0, stdout: "\0feat(x): real work\n\0wip: legacy\n", stderr: "" };
    throw new Error("fixture lint execution threw");
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.detail, /fixture lint execution threw/);
});

async function repairRun(t: TestContext, second: PreopenGateResult, repairError = false, initiallyPasses = false) {
  const root = gitRepo({ scope: t });
  const origin = gitRepo({ bare: true, scope: t });
  const seed = gitRepo({ scope: t });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const repo = gitRepo({ cloneFrom: origin.dir, scope: t });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@remudero.invalid");
  mkdirSync(join(root.dir, "repos"));
  renameSync(repo.dir, join(root.dir, "repos", "remudero"));
  const planPath = join(root.dir, "tasks.yaml");
  writeFileSync(planPath, "- id: D\n  title: checkpoint gate fixture\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  origin: test\n  status: queued\n  files: [src/D.ts]\n");
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const prUrl = "https://github.com/acme/remudero/pull/1";
  const gh = ghShim([
    { when: "pulls?", stdout: "[]" },
    { when: "api --method POST repos/", stdout: JSON.stringify({ html_url: prUrl, number: 1 }) },
    { when: "pr view", stdout: JSON.stringify({ headRefName: `run-D-${now}`, body: "Remudero-Task: D" }) },
    { when: "/pulls/1", stdout: JSON.stringify({ number: 1, state: "open", merged: false, head: { sha: "c".repeat(40) } }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
  ]);
  const priorPath = process.env.PATH;
  const priorHooks = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.PATH = `${gh.dir}:${priorPath}`;
  mkdirSync(join(root.dir, "hooks"));
  process.env.RMD_HARNESS_HOOKS_DIR = join(root.dir, "hooks");
  t.after(() => {
    process.env.PATH = priorPath;
    if (priorHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
    else process.env.RMD_HARNESS_HOOKS_DIR = priorHooks;
    rmSync(gh.dir, { recursive: true, force: true });
  });
  const worker = (text: string, isError = false): WorkerResult => ({
    sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "",
    subtype: isError ? "error_max_turns" : "success", isError, apiError: false, permissionDenials: [],
    childEnvKeys: [], model: "test", effort: "test", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  });
  const order: string[] = [];
  let calls = 0;
  let gates = 0;
  const outcome = await withLiveWritesAllowed(() => runTask("D", {
    config: { claudeBin: "/bin/true", root: root.dir, installRoot: REPO_ROOT, workerProviders: { harnessCommitsImplement: true } },
    skipGitSync: true, planPath, handOffAtPrOpen: true,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "checkpoint-gate-anchor", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async token => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    readHeadShaForProvenance: () => "c".repeat(40),
    spawn: async args => {
      if (++calls === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
      order.push(calls === 2 ? "implement" : "repair");
      mkdirSync(join(args.cwd, "src"), { recursive: true });
      writeFileSync(join(args.cwd, "src/D.ts"), `export const value = ${calls};\n`);
      return worker("REPORT\nCOMMIT_MESSAGE: fix(test): finish gate repair\n", calls > 2 && repairError);
    },
    preopenGate: async path => {
      order.push(`gate-${++gates}`);
      assert.equal(readFileSync(join(path, "src/D.ts"), "utf8"), `export const value = ${gates + 1};\n`);
      return gates === 1 && !initiallyPasses ? { kind: "fail", failedSteps: ["typecheck"], durationMs: 1 } : second;
    },
  }));
  const rows = readFileSync(join(root.dir, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
  return { outcome, rows, order, prUrl };
}

test("W1-T8945: the pre-open gate re-runs after its repair worker", async t => {
  for (const second of [
    { kind: "pass", durationMs: 2 },
    { kind: "fail", failedSteps: ["emitter-checks"], durationMs: 3 },
    { kind: "unmeasured", reason: "fixture gate could not run", durationMs: 4 },
  ] satisfies PreopenGateResult[]) {
    await t.test(second.kind, async t => {
      const h = await repairRun(t, second);
      assert.deepEqual(h.order, ["implement", "gate-1", "repair", "gate-2"]);
      const gates = h.rows.filter(row => row.step === "implement.preopen_gate");
      assert.equal(gates.length, 2);
      assert.equal(gates[0]!.after_repair, undefined);
      assert.equal(gates[1]!.after_repair, true);
      assert.equal(gates[1]!.result, second.kind);
      assert.equal(gates[1]!.duration_ms, second.durationMs);
      assert.deepEqual(gates[1]!.failed, second.kind === "fail" ? second.failedSteps : []);
      if (second.kind === "unmeasured") assert.equal(gates[1]!.reason, second.reason);
      assert.equal(h.outcome.verdict, "handed_off");
      assert.equal(h.outcome.prUrl, h.prUrl, "the second result introduces no new hold");
    });
  }
});

test("a failed repair worker is not re-gated and an initially passing gate needs no repair", async t => {
  await t.test("repair error", async t => {
    const h = await repairRun(t, { kind: "pass", durationMs: 1 }, true);
    assert.deepEqual(h.order, ["implement", "gate-1", "repair"]);
    assert.equal(h.outcome.verdict, "failed");
    assert.equal(h.rows.some(row => row.after_repair === true), false);
  });
  await t.test("initial pass", async t => {
    const h = await repairRun(t, { kind: "pass", durationMs: 1 }, false, true);
    assert.deepEqual(h.order, ["implement", "gate-1"]);
    assert.equal(h.outcome.prUrl, h.prUrl);
  });
});
