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
import { buildBatchedGithub, durableDependencyCredit, type CreditStore, type DeriveDeps } from "#src/lib/status.js";
import { createChangedFilesCache, type ChangedFileEvidence, type ChangedFilesCache } from "#src/lib/changed-files-cache.js";

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

function earlyMergeFixture(mode: "ledger" | "explicit", change: {
  pr?: Partial<PrRef>; evidence?: Partial<Extract<ChangedFileEvidence, { status: "complete" }>>;
  repository?: [string, string]; store?: (store: CreditStore) => CreditStore;
  cache?: ChangedFilesCache; deps?: Partial<DeriveDeps>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-early-implementation-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const candidate: PrRef = { ...pr, headRefName: `run-${id}-1793132346799`, headRefOid: "a".repeat(40), ...change.pr };
  const implementationTask = { ...task, repo: "r", files: ["src/implementation.ts"], ...(mode === "explicit" ? { pr: candidate.number } : {}) };
  const initial: CreditStore = change.store?.({ [id]: { backfillReceipt: { source: "sweep.credit_backfill", prUrl: pr.url, prNumber: pr.number } } }) ??
    { [id]: { backfillReceipt: { source: "sweep.credit_backfill", prUrl: pr.url, prNumber: pr.number } } };
  writeFileSync(defaultCreditStorePath(ledgerPath), JSON.stringify(initial));
  let evidence: ChangedFileEvidence = { status: "complete", repository: "o/r", prNumber: pr.number,
    headRefOid: "a".repeat(40), prState: "MERGED", source: "github_rest_pull_files_paginated", complete: true,
    observedAt: Date.now(), freshness: "immutable_merged_head", files: ["src/implementation.ts"], ...change.evidence };
  let requests = 0;
  const [owner, repository] = change.repository ?? ["o", "r"];
  const github = buildBatchedGithub(owner, repository, {
    fetchAll: () => [candidate], commitTrailerIndex: () => new Map(),
    changedFilesCache: change.cache ?? { evidence: () => evidence, lookup: () => { requests++; return undefined; }, settle: async () => {} },
  });
  const deps: DeriveDeps = { ledgerPath, github, creditOverrideRows: () => [],
    readLedger: () => mode === "ledger" ? [{ step: "pr.opened", task_id: id, pr_url: candidate.url }] : [], ...change.deps };
  return { dir, ledgerPath, candidate, implementationTask, initial, github, deps,
    run: () => deriveStatus(implementationTask, deps), store: () => loadCreditStore(defaultCreditStorePath(ledgerPath)),
    setEvidence: (next: ChangedFileEvidence) => { evidence = next; }, requests: () => requests,
    close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("native implementation evidence survives ledger merge early return", () => {
  const f = earlyMergeFixture("ledger");
  try {
    assert.equal(durableDependencyCredit(f.store(), id, "o/r", []).state, "unknown");
    assert.equal(f.run().source, "ledger");
    assert.equal(f.run().merged, true);
    assert.equal(f.store()[id]?.trailer?.prNumber, pr.number);
    assert.equal(durableDependencyCredit(f.store(), id, "o/r", []).state, "merged");
    assert.equal(f.requests(), 0);
  } finally { f.close(); }
});

test("native implementation evidence survives explicit PR merge early return", () => {
  const f = earlyMergeFixture("explicit", { pr: { body: "No trailer; the accepted build branch owns this implementation." } });
  try {
    assert.equal(f.run().source, "pr-field");
    assert.equal(f.run().merged, true);
    assert.equal(f.store()[id]?.["head-branch"]?.prNumber, pr.number);
    assert.equal(durableDependencyCredit(f.store(), id, "o/r", []).state, "merged");
  } finally { f.close(); }
});

test("receipt-only merge evidence cannot bypass implementation or ownership", () => {
  const negatives: Array<Parameters<typeof earlyMergeFixture>[1]> = [
    { evidence: { files: [] } }, { evidence: { files: [own] } }, { evidence: { files: ["src/x.ts", "src/x.ts"] } },
    { evidence: { files: ["../src/x.ts"] } }, { evidence: { files: ["src/\0x.ts"] } },
    { evidence: { files: ["src/x.ts", null] as unknown as string[] } },
    { evidence: { files: Array.from({ length: 3000 }, (_, index) => `src/file-${index}.ts`) } },
    { evidence: { repository: "foreign/r" } }, { repository: ["foreign", "r"] }, { repository: ["o", "foreign"] },
    { evidence: { prNumber: pr.number + 1 } }, { pr: { headRefOid: "b".repeat(40) } }, { pr: { headRefOid: undefined } },
    { evidence: { prState: "OPEN" as "MERGED" } }, { pr: { state: "OPEN" } },
    { evidence: { complete: false as true } }, { evidence: { freshness: "stale" as "immutable_merged_head" } },
    { evidence: { source: "label" as "github_rest_pull_files_paginated" } }, { evidence: { observedAt: NaN } },
    { evidence: { observedAt: Date.now() + 86400_000 } }, { pr: { url: "https://github.com/foreign/r/pull/9124" } },
    { pr: { headRefName: "run-W9-T9999-1793132346799" } },
    { pr: { headRefName: undefined } }, { pr: { headRefName: "chore/no-task", body: `Mention Remudero-Task: ${id}` } },
    { store: store => ({ [id]: { ...store[id], backfillReceipt: { source: "sweep.credit_backfill", prNumber: 9000, prUrl: pr.url } } }) },
    { store: store => ({ [id]: { ...store[id], backfillReceipt: { source: "sweep.credit_backfill", prNumber: pr.number, prUrl: "https://github.com/o/r/pull/9000" } } }) },
    { store: () => ({}) },
  ];
  for (const [index, change] of negatives.entries()) for (const mode of ["ledger", "explicit"] as const) {
    const f = earlyMergeFixture(mode, change);
    try {
      f.run();
      assert.deepEqual(f.store(), f.initial, `${mode} boundary ${index} must not write a canonical slot`);
      assert.equal(durableDependencyCredit(f.store(), id, "o/r", []).state, "unknown");
    } finally { f.close(); }
  }
});

test("durable merge evidence keeps corrections and refusals", () => {
  for (const source of ["trailer", "head-branch"] as const) {
    const f = earlyMergeFixture("ledger", { store: store => ({ [id]: { ...store[id], invalidated: {
      [source]: { prUrl: pr.url, prNumber: pr.number, reason: "durable-credit-plan-only" },
    } } }) });
    try { assert.equal(f.run().merged, true); assert.deepEqual(f.store(), f.initial); }
    finally { f.close(); }
  }
  const correction = earlyMergeFixture("explicit", { store: store => ({ [id]: { ...store[id], correction: {
    prUrl: "https://github.com/o/r/pull/9000", prNumber: 9000,
  } } }) });
  try { assert.equal(correction.run().source, "correction"); assert.deepEqual(correction.store(), correction.initial); }
  finally { correction.close(); }
  const override = earlyMergeFixture("ledger", { deps: { creditOverrideRows: () => [{ task: id, pr: pr.number,
    action: "remove-credit", reason: "verified plan-only", author_class: "operator" }] } });
  try { assert.equal(override.run().merged, false); assert.deepEqual(override.store(), override.initial); }
  finally { override.close(); }
  const filing = earlyMergeFixture("explicit");
  filing.deps.readLedger = () => [{ step: "pr.opened", task_id: id, pr_url: pr.url, plan_only: true }];
  try { assert.equal(filing.run().merged, true); assert.deepEqual(filing.store(), filing.initial); }
  finally { filing.close(); }
  const debunked = earlyMergeFixture("explicit");
  debunked.deps.readLedger = () => [{ step: "correction.provenance", task_id: id, claimed_pr_url: pr.url }];
  try { assert.equal(debunked.run().merged, true); assert.deepEqual(debunked.store(), debunked.initial); }
  finally { debunked.close(); }
});

test("receipt-only evidence uses no synchronous file reads or unrelated cache work", () => {
  const f = earlyMergeFixture("ledger"); let reads = 0;
  try {
    f.deps.github = buildBatchedGithub("o", "r", { fetchAll: () => [f.candidate], commitTrailerIndex: () => new Map(),
      exec: () => { reads++; throw Error("unbudgeted file read"); } });
    assert.equal(f.run().merged, true); assert.deepEqual(f.store(), f.initial); assert.equal(reads, 0);
    const forbidden = () => { throw Error("unrelated task must not request implementation evidence"); };
    const unrelated = earlyMergeFixture("explicit", { store: () => ({}), cache: { lookup: forbidden, evidence: forbidden, settle: async () => {} } });
    try { assert.equal(unrelated.run().merged, true); assert.deepEqual(unrelated.store(), {}); }
    finally { unrelated.close(); }
  } finally { f.close(); }
});

test("default stored implementation evidence satisfies the strict dependency reader", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "rmd-real-implementation-cache-"));
  const cache = createChangedFilesCache(cacheRoot, "o", "r", { fetch: async () => ["src/implementation.ts"] });
  const f = earlyMergeFixture("ledger", { cache });
  try {
    assert.equal(f.run().merged, true);
    assert.deepEqual(f.store(), f.initial, "a queued cache request is not persistence");
    await cache.settle();
    assert.equal(f.run().merged, true);
    const stored = loadCreditStore(defaultCreditStorePath(f.ledgerPath));
    assert.equal(stored[id]?.trailer?.source, "trailer");
    assert.equal(durableDependencyCredit(stored, id, "o/r", []).state, "merged");
    const forbidden = buildBatchedGithub("o", "r", { fetchAll: () => { throw Error("durable credit must need no PR read"); } });
    assert.equal(deriveStatus(f.implementationTask, { ...f.deps, github: forbidden }).merged, true);
  } finally { await cache.settle(); f.close(); rmSync(cacheRoot, { recursive: true, force: true }); }
});

test("early implementation persistence failures keep the original merge and durable unknown", () => {
  const throwing = () => { throw Error("private fixture refusal"); };
  const cases: Array<Parameters<typeof earlyMergeFixture>[1]> = [
    { cache: { lookup: throwing, evidence: throwing, settle: async () => {} } },
    { cache: { lookup: throwing, evidence: () => ({ status: "unknown", reason: "cold" }), settle: async () => {} } },
    { deps: { writeCreditStore: throwing } },
  ];
  for (const change of cases) {
    const f = earlyMergeFixture("ledger", change);
    try { assert.equal(f.run().merged, true); assert.deepEqual(f.store(), f.initial); }
    finally { f.close(); }
  }
  const f = earlyMergeFixture("explicit");
  try {
    const blocked = join(f.dir, "blocked-parent"); writeFileSync(blocked, "a file, not a writable directory");
    f.deps.creditStorePath = join(blocked, "merge-credit.json"); f.deps.readCreditStore = () => f.initial;
    assert.equal(f.run().merged, true); assert.deepEqual(f.store(), f.initial);
    assert.equal(durableDependencyCredit(loadCreditStore(f.deps.creditStorePath), id, "o/r", []).state, "unknown");
  } finally { f.close(); }
});

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
