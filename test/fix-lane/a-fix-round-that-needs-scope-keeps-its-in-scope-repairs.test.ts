import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { buildFixProgressInput } from "#src/lib/fix-progress-judge.js";
import { isUngrantableInstrumentPath } from "#src/lib/proof-amendment.js";
import { COMMAND_REGISTRY, REGENERABLE_ARTIFACT_GENERATORS } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

type Run = Parameters<typeof runFixRung>[0];
const taskId = "W1-T13377";
const branch = `run-${taskId}-1795370113977`;
const declared = "src/declared.ts";
const refused = "src/refused.ts";
const instrument = "scripts/comment-load-baseline.json";
const verbRegistration = "scripts/console-parity-ratchet.mjs";
const workflow = ".github/workflows/ci.yml";
const registry = COMMAND_REGISTRY.path;
const registrySource = 'const COMMANDS = [\n  { name: "existing-verb", summary: "Original" },\n];\n';
const original = "original\n";
const repair = "repaired\n";
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;

async function fixScope(requested: string, edits: Record<string, string>, fault?: "push-misses" | "push-throws" | "head-moved") {
  const repo = gitRepo();
  const remote = gitRepo({ bare: true });
  repo.git("config", "user.name", "Fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  const write = (path: string, text: string) => {
    const file = join(repo.dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  for (const path of [declared, refused, instrument, workflow]) write(path, original);
  write(registry, registrySource);
  write(verbRegistration, original);
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main");
  repo.addRemote("origin", remote.dir);
  repo.git("push", "-q", "origin", "main");
  repo.git("checkout", "-qb", branch);
  write(declared, "initial PR change\n");
  repo.git("commit", "-qam", "build");
  repo.git("push", "-q", "origin", branch);
  const start = repo.git("rev-parse", "HEAD");
  const remoteHead = () => remote.git("rev-parse", `refs/heads/${branch}`);
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  const issues: string[] = [];
  let pushes = 0;
  const review = {
    state: "failure", criteria: [{ claim: "declared repair", proof: "unit test: declared repair", met: false,
      reason: "red", proof_exec: "not_executable" }], summary: "red", headSha: start, reviewerOutcome: "failure",
    capped: false, floorDegraded: false, keywordOnly: false, planOnly: false, testTheater: false,
  } satisfies Run["initialReview"];
  const task = { id: taskId, title: "repair declared surface", files: [declared, registry], catalog: "ops" as const };
  const writeAmendment = () => assert.fail("the scope amendment should be refused before a write");
  const result = await runFixRung({
    taskId, runId: "partial-scope-fixture", task,
    prUrl: "https://github.com/acme/remudero/pull/7", branch, worktreePath: repo.dir, initialSessionId: "initial",
    mount, settingsFile: join(repo.dir, "settings.json"), config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review, guardRoundHead: true,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture delivers" }),
    deps: {
      spawn: async () => {
        for (const [path, text] of Object.entries(edits)) write(path, text);
        if (requested === workflow) repo.git("add", "--", workflow);
        if (fault === "head-moved") repo.git("commit", "--allow-empty", "-qm", "concurrent head");
        return {
          provider: "codex", sessionId: "fix", costUsd: 0, numTurns: 1, text: `FIX_OUTCOME: NEEDS_SCOPE ${requested}`,
          blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        } satisfies WorkerResult;
      },
      fetchPrBody: async () => `Remudero-Task: ${taskId}`,
      fetchPrDiffFiles: async () => [declared],
      scopeAmendmentWritePorts: {
        repoDir: repo.dir, findShard: () => undefined, lookupIdentity: () => undefined, probeExisting: () => undefined,
        worktreePathFor: writeAmendment, worktreeAdd: writeAmendment, worktreeRemove: writeAmendment, writeFile: writeAmendment,
        gitAdd: writeAmendment, gitCommit: writeAmendment, gitPush: writeAmendment, createPr: writeAmendment,
        recordIdentity: writeAmendment, updateBranch: writeAmendment,
      },
      push: (_path, ref, head, prior) => {
        pushes++;
        assert.equal(prior, start);
        assert.equal(head, repo.git("rev-parse", "HEAD"));
        if (fault === "push-throws") throw new Error("fixture push failed");
        if (fault !== "push-misses") repo.git("push", "-q", "origin", `${head}:refs/heads/${ref}`);
      },
      readRemoteBranchHead: async () => remoteHead(),
      waitForCiGreen: async () => assert.fail("the partial repair still needs scope"),
      runReview: async () => assert.fail("the partial repair has not fixed the PR"),
      issues: { create: (_title, body) => { issues.push(body); return "https://github.com/acme/remudero/issues/1"; },
        listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, fields) => { rows.push({ step, task_id: taskId, pr_number: 7, ...fields }); },
      say: () => {}, account: (worker) => worker,
    },
  });
  return { repo, remote, start, head: remoteHead(), pushes, rows, issues, result };
}

test("W1-T13377 criterion 1: the refused amendment leaves one remote repair commit and names it for escalation", async () => {
  const { repo, remote, start, head, pushes, rows, issues, result } = await fixScope(refused, { [declared]: repair, [refused]: repair });
  assert.equal(result.outcome, "stood_down");
  assert.equal(pushes, 1);
  assert.equal(remote.git("rev-parse", `${head}^`), start);
  assert.equal(remote.git("diff", "--name-only", start, head), declared);
  assert.equal(remote.git("show", `${head}:${declared}`), repair.trim());
  assert.equal(readFileSync(join(repo.dir, refused), "utf8"), repair);
  const refusal = rows.find((row) => row.step === "fix.commit_refused");
  assert.equal(refusal?.scope_amendment_refusal, "shard-not-found");
  assert.ok(String(refusal?.reason).includes(head));
  assert.ok(String(refusal?.reason).includes(refused));
  assert.equal(rows.find((row) => row.step === "fix.done")?.pushed_head_sha, head);
  const progress = buildFixProgressInput({ ledger: rows, taskId, prNumber: 7, headSha: head, currentRed: ["fixture"] });
  assert.equal(progress.rounds.at(-1)?.pushedHead, head);
  assert.equal(progress.signals.noOpRounds, 0);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].includes(head));
  assert.ok(issues[0].includes(refused));
  assert.ok(!issues[0].includes("partial-scope-fixture"));
});

test("W1-T13377 criterion 2: instrument and staged workflow edits stay out of the remote commit", async () => {
  assert.ok(isUngrantableInstrumentPath(instrument));
  assert.ok(Object.hasOwn(REGENERABLE_ARTIFACT_GENERATORS, instrument));
  for (const requested of [instrument, workflow]) {
    const { repo, remote, start, head, pushes, issues, result } = await fixScope(requested, {
      [declared]: repair, [refused]: repair, [instrument]: repair, [workflow]: repair,
    });
    assert.equal(result.outcome, "stood_down");
    assert.equal(pushes, 1, requested);
    assert.equal(remote.git("rev-parse", `${head}^`), start);
    assert.equal(remote.git("diff", "--name-only", start, head), declared);
    for (const path of [refused, instrument, workflow]) assert.equal(readFileSync(join(repo.dir, path), "utf8"), repair);
    assert.equal(issues.length, 1);
    assert.ok(issues[0].includes(head));
    assert.ok(issues[0].includes(requested));
  }
});

test("W1-T13377 criterion 2: a normal commit refusal leaves the branch tip untouched", async () => {
  const { start, head, pushes, rows } = await fixScope(refused, {
    [declared]: "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> main\n", [refused]: repair,
  });
  assert.equal(pushes, 0);
  assert.equal(head, start);
  assert.deepEqual(rows.find((row) => row.step === "implement.harness_commit_refused")?.conflict_marker_files, [declared]);
});

test("a partial repair holds a worker-added verb with its refused registrations", async () => {
  const addedVerb = registrySource.replace("];", '  { name: "worker-verb", summary: "New" },\n];');
  const editedVerb = registrySource.replace("Original", "Repaired");
  for (const [registryEdit, keepRegistry] of [[addedVerb, false], [editedVerb, true]] as const) {
    const { repo, remote, start, head, pushes, issues } = await fixScope(verbRegistration, {
      [declared]: repair, [registry]: registryEdit, [verbRegistration]: repair,
    });
    assert.equal(pushes, 1);
    assert.deepEqual(remote.git("diff", "--name-only", start, head).split("\n"), keepRegistry ? [declared, registry] : [declared]);
    assert.equal(remote.git("show", `${head}:${registry}`), (keepRegistry ? registryEdit : registrySource).trimEnd());
    assert.equal(readFileSync(join(repo.dir, registry), "utf8"), registryEdit);
    assert.equal(readFileSync(join(repo.dir, verbRegistration), "utf8"), repair);
    assert.equal(issues.length, 1);
    assert.ok(issues[0].includes(head));
    assert.equal(issues[0].includes(`- ${registry}\n`), !keepRegistry);
  }
});

test("W1-T13377 criterion 2: a push that cannot be verified names no repair commit in the scope issue", async () => {
  for (const fault of ["push-misses", "push-throws"] as const) {
    const { repo, start, head, pushes, issues, rows } = await fixScope(workflow, { [declared]: repair, [workflow]: repair }, fault);
    assert.equal(pushes, 1);
    assert.equal(head, start);
    assert.equal(issues.length, 1);
    assert.ok(!issues[0].includes(repo.git("rev-parse", "HEAD")));
    assert.equal(rows.find((row) => row.step === "fix.done")?.push_outcome, fault === "push-misses" ? "not_on_remote" : "failed");
  }
});

test("W1-T13377 criterion 2: a blocked-only edit or a moved head leaves the remote untouched", async () => {
  const blocked = await fixScope(instrument, { [instrument]: repair });
  assert.equal(blocked.pushes, 0);
  assert.equal(blocked.head, blocked.start);
  assert.equal(blocked.repo.git("rev-parse", "HEAD"), blocked.start);
  assert.equal(readFileSync(join(blocked.repo.dir, instrument), "utf8"), repair);

  const moved = await fixScope(instrument, { [declared]: repair }, "head-moved");
  assert.equal(moved.pushes, 0);
  assert.equal(moved.head, moved.start);
  assert.equal(moved.repo.git("log", "-1", "--format=%s"), "concurrent head");
  assert.match(String(moved.rows.find((row) => row.step === "implement.harness_commit_refused")?.reason), /branch moved/);
});
