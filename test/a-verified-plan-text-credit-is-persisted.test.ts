import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { stringify } from "yaml";
import { reconcilePlan } from "../src/lib/plan-reconcile.js";
import {
  defaultCreditStorePath, deriveStatus, loadCreditStore, persistVerifiedCredit,
  type GitHub, type PrRef, type StatusProjection,
} from "../src/lib/status.js";
import { buildCreditCandidates, creditCandidatesFromProjection, creditIsReconcilable, runTask } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const id = "W9-T5661";
const shard = "plan/tasks.d/W9-T5660-deliverable.yaml";
const own = `plan/tasks.d/${id}-filing.yaml`;
const task: Task = {
  id, title: "repair declared plan text", repo: "remudero", depends_on: [], type: "implement",
  verify: "auto", risk: "high", status: "queued", attempts: 0, files: [shard, own],
};
const pr: PrRef = {
  number: 9124, url: "https://github.com/o/r/pull/9124", state: "MERGED",
  headRefName: "chore/repair-proof", body: `Remudero-Task: ${id}\n`,
};
const projection: StatusProjection = {
  taskId: id, merged: true, status: "merged", source: "trailer", prNumber: pr.number, prUrl: pr.url,
};
const subjects = new Map([[pr.number, "chore(plan): repair declared proof (#9124)"]]);
const tasks = new Map([[id, task]]);

test("test/a-verified-plan-text-credit-is-persisted.test.ts: verified plan-text credit is recorded and survives a newer filing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-text-credit-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  try {
    assert.equal(persistVerifiedCredit(ledgerPath, task, pr, [shard, own]), "recorded");
    const store = loadCreditStore(defaultCreditStorePath(ledgerPath));
    assert.equal(store[id]?.trailer?.prNumber, pr.number);
    assert.equal(store[id]?.trailer?.prState, "MERGED");
    const newer = { ...pr, number: 9130, url: "https://github.com/o/r/pull/9130" };
    const github = {
      prByRef: () => null, findMergedByTrailer: () => newer, findMergedByHeadBranch: () => [],
      headRefName: () => newer.headRefName, prBody: () => newer.body, changedFiles: () => [own],
    } as unknown as GitHub;
    const deps = { ledgerPath, github, readLedger: () => [], mergedPathsByPr: new Map([[pr.number, [shard, own]]]) };
    assert.equal(deriveStatus(task, { ...deps, readCreditStore: () => ({}), writeCreditStore: () => {} }).merged, false);
    const persisted = deriveStatus(task, deps);
    assert.equal(persisted.merged, true);
    assert.equal(persisted.prNumber, pr.number);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test/a-verified-plan-text-credit-is-persisted.test.ts: filing and unreadable changesets persist nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-text-refusal-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  try {
    for (const paths of [[own], [shard, "plan/tasks.yaml"]]) {
      assert.equal(persistVerifiedCredit(ledgerPath, task, pr, paths), "plan-only");
    }
    assert.equal(persistVerifiedCredit(ledgerPath, { ...task, files: [shard, "src/x.ts"] }, pr, [shard]), "plan-only");
    assert.equal(persistVerifiedCredit(ledgerPath, task, pr, undefined), "unreadable");
    assert.equal(persistVerifiedCredit(ledgerPath, task, pr, []), "unreadable");
    assert.deepEqual(loadCreditStore(defaultCreditStorePath(ledgerPath)), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test/a-verified-plan-text-credit-is-persisted.test.ts: declared shards reconcile under a chore(plan) subject", () => {
  const candidates = creditCandidatesFromProjection([projection], subjects, new Map(), new Map([[pr.number, [shard]]]), () => [], tasks);
  assert.equal(candidates[0]?.creditIsImplementation, false);
  assert.equal(candidates[0]?.creditHasBuildDiff, true);
  assert.equal(creditIsReconcilable(candidates[0]!), true);
  const result = reconcilePlan([{ taskId: id, text: `- id: ${id}\n  status: queued\n` }], () => creditIsReconcilable(candidates[0]!));
  assert.equal(result.writes.length, 1);
  assert.match(result.writes[0].text, /status: merged/);
  for (const paths of [[own], [shard, "plan/tasks.yaml"], []]) {
    const [filing] = creditCandidatesFromProjection([projection], subjects, new Map(), new Map([[pr.number, paths]]), () => [], tasks);
    assert.equal(creditIsReconcilable(filing!), false);
  }
  const body = `Prerequisite split for ${id}\nThis PR carries ONLY the instrument\n`;
  const [prerequisite] = creditCandidatesFromProjection([projection], subjects, new Map([[pr.number, body]]), new Map([[pr.number, [shard]]]), () => [], tasks);
  assert.equal(creditIsReconcilable(prerequisite!), false);
});

test("test/a-verified-plan-text-credit-is-persisted.test.ts: the production builder supplies declared files to both credit readers", () => {
  const repo = gitRepo({ kind: "plan-text-credit" });
  const ledgerPath = join(repo.dir, "state", "ledger.ndjson");
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, "");
  mkdirSync(dirname(join(repo.dir, shard)), { recursive: true });
  writeFileSync(join(repo.dir, shard), "delivered\n");
  repo.git("add", shard);
  repo.git("commit", "-qm", subjects.get(pr.number)!);
  writeFileSync(join(repo.dir, own), "filed\n");
  repo.git("add", own);
  repo.git("commit", "-qm", "chore(plan): file task (#9130)");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const filing: PrRef = { ...pr, number: 9130, url: "https://github.com/o/r/pull/9130" };
  const github = {
    prByRef: (ref: string | number) => ref === pr.url || ref === pr.number ? pr : filing,
    listMergedHeadBranches: () => [filing, pr], mergedTrailerLookup: () => () => filing,
    findMergedByTrailer: () => filing, findMergedByHeadBranch: () => [],
    headRefName: () => pr.headRefName, prBody: () => pr.body,
    changedFiles: (url: string) => url === pr.url ? [shard] : [own],
  } as unknown as GitHub;
  const plan: Plan = { tasks: [task], byId: tasks };
  try {
    const build = () => buildCreditCandidates("o", "r", plan, ledgerPath, undefined, github, () => repo.dir);
    // A legacy filing credit drives the later-merge reader, not just the selected PR reader.
    writeFileSync(ledgerPath, JSON.stringify({ step: "pr.opened", task_id: id, pr_url: filing.url }) + "\n");
    const [later] = build();
    assert.equal(later?.prNumber, filing.number);
    assert.equal(later?.creditHasBuildDiff, false);
    assert.equal(later?.creditHasOtherBuildMerge, true);
    writeFileSync(ledgerPath, "");
    assert.equal(persistVerifiedCredit(ledgerPath, task, pr, [shard]), "recorded");
    const [direct] = build();
    assert.equal(direct?.prNumber, pr.number);
    assert.equal(direct?.creditHasBuildDiff, true);
    assert.equal(creditIsReconcilable(direct!), true);
  } finally {
    repo.cleanup();
  }
});

test("test/a-verified-plan-text-credit-is-persisted.test.ts: already_satisfied passes its task to the durable writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plan-text-run-"));
  const origin = gitRepo({ kind: "plan-text-origin", bare: true });
  const seed = gitRepo({ kind: "plan-text-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const checkout = gitRepo({ kind: "plan-text-checkout", cloneFrom: origin.dir });
  checkout.git("config", "user.name", "plan-text fixture");
  checkout.git("config", "user.email", "fixture@remudero.invalid");
  mkdirSync(join(root, "repos"));
  renameSync(checkout.dir, join(root, "repos", "remudero"));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, stringify([{ ...task, risk: "medium", origin: "architect" }]));
  const github = {
    prByRef: () => null, findMergedByTrailer: () => pr,
    headRefName: () => undefined, prBody: () => undefined, changedFiles: () => [shard],
  } as GitHub;
  let spawns = 0;
  const result = (text: string): WorkerResult => ({
    sessionId: "plan-text-worker", costUsd: 0, numTurns: 0, text, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "default", effort: "default", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  });
  try {
    const run = await withLiveWritesAllowed(() => runTask(id, {
      skipGitSync: true, planPath, config: { claudeBin: "/bin/true", root, installRoot: process.cwd() }, github,
      spawn: async () => result(++spawns === 1 ? "RECON REPORT\nOBSERVED: declared plan text\n" : `REPORT\nALREADY_SATISFIED: #${pr.number}\n`),
      containmentExec: async (token) => ({
        transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false,
        insideWriteCreated: true, costUsd: 0,
      }),
      isolationExec: async () => ({
        transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
        aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0,
      }),
    }));
    assert.equal(run.verdict, "already_satisfied");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.find((row) => row.step === "already_satisfied.credit_persisted")?.outcome, "recorded");
    assert.equal(loadCreditStore(defaultCreditStorePath(ledgerPath))[id]?.trailer?.prNumber, pr.number);
  } finally {
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
    origin.cleanup();
  }
});
