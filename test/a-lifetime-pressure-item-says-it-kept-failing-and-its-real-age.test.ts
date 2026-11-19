import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { fixedClock } from "#src/lib/clock.js";
import { loadProposalRegistry } from "#src/lib/inbox.js";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import {
  automationProposalFromJudgedShard,
  proposalFromJudgedShard,
  observedStateKey,
  type ShardUnderJudgement,
  type VerifyHumanVerdict,
} from "#src/lib/verify-human-judge.js";
import type { Config } from "#src/lib/config-schema.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "#src/lib/worker.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { lifetimeContractDigest, routeAdaptiveLifetimePressure } from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T8827: the adaptive lifetime-pressure path judged every task with `ageDays: 0` and the
// proposal then worded it as "filed `verify: human` 0 days ago". These tests drive the real route
// with a fake judge spawn and read what the judge was shown and what the operator was told.

const DAY_MS = 86_400_000;
const NOW_MS = Date.parse("2026-10-16T12:00:00Z");
const ID = "T8827-OLD";

const PLAN_YAML = `
- id: ${ID}
  title: an old task whose build kept failing
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

type Fixture = { dir: string; plan: Plan; ledgerPath: string; config: Config };

function fixture(inRepo = false): Fixture {
  const dir = inRepo ? gitRepo({ seedCommit: false, kind: "lifetime-age" }).dir : mkdtempSync(join(tmpdir(), "rmd-lifetime-age-"));
  writeFileSync(join(dir, "tasks.yaml"), PLAN_YAML);
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  copyFileSync(join(import.meta.dirname, "..", ".remudero", "mounts.yaml"), join(dir, ".remudero", "mounts.yaml"));
  mkdirSync(join(dir, "state"), { recursive: true });
  return { dir, plan: loadPlan(join(dir, "tasks.yaml")), ledgerPath: join(dir, "ledger.ndjson"), config: { root: dir } as unknown as Config };
}

/** Commit the shard file `daysAgo` days before NOW_MS, so `git log --diff-filter=A` dates it. */
function commitShard(dir: string, daysAgo: number): void {
  const when = new Date(NOW_MS - daysAgo * DAY_MS).toISOString();
  const { name, email } = GIT_REPO_FIXTURE_IDENTITY;
  const env = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when,
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  const git = (...args: string[]): void => void execFileSync("git", ["-C", dir, ...args], { env, stdio: "pipe" });
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.d", `${ID}-old.yaml`), `- id: ${ID}\n`);
  git("add", "plan");
  git("commit", "-q", "-m", "add shard");
}

function failedAttempts(n: number, daysAgo: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(NOW_MS - (daysAgo - i) * DAY_MS).toISOString();
    rows.push({ ts, step: "run.start", task_id: ID, run_id: `r${i}` });
    rows.push({ ts, step: "verdict", task_id: ID, run_id: `r${i}`, verdict: "failed", stage: "implement", reason: "retry" });
  }
  return rows;
}

function writeLedger(path: string, rows: Record<string, unknown>[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Run the real route; the judge says needs_operator and its prompt is captured. */
async function route(f: Fixture): Promise<{ prompts: string[]; summaries: string[]; ids: string[] }> {
  const prompts: string[] = [];
  const spawn: typeof spawnWorker = async (args: SpawnWorkerArgs) => {
    prompts.push(String((args as { prompt?: string }).prompt ?? ""));
    return { text: "VERIFY_HUMAN_DECISION: needs_operator\nVERIFY_HUMAN_REASON: fixture" } as WorkerResult;
  };
  const result = await routeAdaptiveLifetimePressure([f.plan.byId.get(ID)!], {
    plan: f.plan, root: f.dir, config: f.config, ledgerPath: f.ledgerPath, runId: "RUN-T8827",
    shadowJudgeSpawns: { primary: spawn, shadow: spawn }, clock: fixedClock(NOW_MS),
  });
  assert.equal(result.judged, 1);
  const staged = loadProposalRegistry(join(f.dir, "state", "inbox-proposals.json"));
  return { prompts, summaries: staged.map((p) => p.summary), ids: staged.map((p) => p.id) };
}

test("W1-T8827: a lifetime-pressure proposal says the build kept failing and how long", async () => {
  const f = fixture(true);
  try {
    commitShard(f.dir, 30);
    writeLedger(f.ledgerPath, failedAttempts(4, 3));
    const { summaries, ids } = await route(f);
    assert.deepEqual(ids, [`verify-human:${ID}`], "the proposal id format is unchanged");
    assert.match(summaries[0]!, new RegExp(`${ID} kept failing to build \\(4 attempts over 30 days\\) and a judge reads it as still needing you`));
    assert.doesNotMatch(summaries[0]!, /was filed `verify: human`/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T8827: an old task is judged with its real age", async () => {
  const f = fixture(true);
  try {
    commitShard(f.dir, 30);
    writeLedger(f.ledgerPath, failedAttempts(4, 3));
    const { prompts } = await route(f);
    assert.match(prompts[0]!, /AGE: 30 days since filing/);
    assert.doesNotMatch(prompts[0]!, /AGE: 0 days/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T8827: a task with no shard file is aged from its first dispatch row, never zero", async () => {
  const f = fixture(); // no git repository: the shard's first commit cannot be read
  try {
    writeLedger(f.ledgerPath, failedAttempts(2, 20));
    const { prompts, summaries } = await route(f);
    assert.match(prompts[0]!, /AGE: 20 days since filing/);
    assert.match(summaries[0]!, /\(2 attempts over 20 days\)/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T8827: an age that cannot be read is said to be unknown, never zero", async () => {
  const f = fixture();
  try {
    writeLedger(f.ledgerPath, [{ step: "run.start", task_id: ID, run_id: "r0" }]); // no ts
    const { summaries } = await route(f);
    assert.match(summaries[0]!, /\(1 attempts over an unknown number of days \(filing age unknown: /);
    assert.doesNotMatch(summaries[0]!, / 0 days/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("W1-T8827: a verify-human proposal keeps its wording and id", () => {
  const verdict: VerifyHumanVerdict = { decision: "needs_operator", reason: "r" };
  const base: ShardUnderJudgement = {
    id: "W1-T216", title: "t", rationale: "", acceptance: [], ageDays: 49, depsAllMerged: true, citedInSrc: false,
  };
  for (const shard of [base, { ...base, route: "verify-human" as const }]) {
    const p = proposalFromJudgedShard(shard, verdict);
    assert.equal(p.id, "verify-human:W1-T216");
    assert.match(p.summary, /^W1-T216 was filed `verify: human` 49 days ago and a judge reads it as still needing you:/);
    const a = automationProposalFromJudgedShard(shard, verdict);
    assert.equal(a.id, "verify-human-automate:W1-T216");
    assert.match(a.summary, /^W1-T216 was filed `verify: human` 49 days ago and a judge reads it as safe to enter/);
  }
  const lifetime = automationProposalFromJudgedShard({ ...base, route: "lifetime-pressure", attributableDispatches: 3 }, verdict);
  assert.equal(lifetime.id, "verify-human-automate:W1-T216", "the id does not depend on the route");
  assert.match(lifetime.summary, /^W1-T216 kept failing to build \(3 attempts over 49 days\) and a judge reads it as safe to enter/);
});

test("W1-T10210: age consumers preserve fallback and judgment identity", async () => {
  for (const inRepo of [true, false]) {
    const f = fixture(inRepo);
    try {
      if (inRepo) commitShard(f.dir, 30);
      writeLedger(f.ledgerPath, [
        { ts: "not-a-date", task_id: ID, step: "earlier-unusable-evidence" },
        { ts: new Date(NOW_MS - 50 * DAY_MS).toISOString(), task: ID, step: "first-seen-context-not-a-dispatch" },
        { ts: new Date(NOW_MS - 80 * DAY_MS).toISOString(), task_id: "OTHER", step: "unrelated" },
        ...failedAttempts(4, 3),
      ]);
      const result = await route(f);
      const expected = inRepo ? 30 : 50;
      assert.match(result.prompts[0]!, new RegExp(`AGE: ${expected} days since filing`),
        "qualified Git wins; otherwise the earliest valid matching task alias row remains the fallback");
      assert.match(result.summaries[0]!, new RegExp(`4 attempts over ${expected} days`));
      assert.deepEqual(result.ids, [`verify-human:${ID}`]);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
  const base: ShardUnderJudgement = { id: ID, title: "t", rationale: "", acceptance: [], ageDays: 49,
    observationKey: "source-bound-evidence", depsAllMerged: true, citedInSrc: false };
  assert.equal(observedStateKey(base), observedStateKey({ ...base, ageDays: 79 }));
  assert.equal(observedStateKey(base), observedStateKey({ ...base, ageDays: null, ageUnknownReason: "history unreadable" }));
  assert.notEqual(observedStateKey(base), observedStateKey({ ...base, observationKey: "changed-source-evidence" }));
  assert.equal(proposalFromJudgedShard(base, { decision: "needs_operator", reason: "r" }).id,
    proposalFromJudgedShard({ ...base, ageDays: null }, { decision: "needs_operator", reason: "r" }).id);
});

test("W1-T10210: callers share one aggregate filing-history budget (lifetime route)", async () => {
  const f = fixture(true), secondId = "T8827-SECOND";
  try {
    const second = { ...f.plan.byId.get(ID)!, id: secondId };
    f.plan.tasks.push(second); f.plan.byId.set(secondId, second);
    mkdirSync(join(f.dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(f.dir, "plan", "tasks.d", `${secondId}-old.yaml`), `- id: ${secondId}\n`);
    commitShard(f.dir, 30);
    const rows = failedAttempts(2, 3);
    writeLedger(f.ledgerPath, [...rows, ...rows.map(row => ({ ...row, task_id: secondId, run_id: `second:${row.run_id}` }))]);
    const prompts: string[] = [], calls: string[][] = [];
    const spawn: typeof spawnWorker = async (args: SpawnWorkerArgs) => {
      prompts.push(String((args as { prompt?: string }).prompt ?? ""));
      return { text: "VERIFY_HUMAN_DECISION: needs_operator\nVERIFY_HUMAN_REASON: fixture" } as WorkerResult;
    };
    const result = await routeAdaptiveLifetimePressure(f.plan.tasks, {
      plan: f.plan, root: f.dir, config: f.config, ledgerPath: f.ledgerPath, runId: "RUN-T10210-SHARED",
      clock: fixedClock(NOW_MS), shadowJudgeSpawns: { primary: spawn, shadow: spawn },
      filingHistory: { limits: { blobReads: 1 }, readGit: (root, args, opts) => {
        calls.push([...args]); return hostWorktreeGitAsync(root, args, opts);
      } },
    });
    assert.equal(result.judged, 2); assert.ok(prompts.length >= 2);
    for (const prompt of prompts) assert.match(prompt, /AGE: 3 days since filing/,
      "aggregate history exhaustion preserves the existing per-task ledger fallback");
    assert.equal(calls.filter(a => a[0] === "rev-parse" && a[1] === "--verify").length, 1);
    assert.equal(calls.filter(a => a[0] === "cat-file").length, 0, "both tasks share the pre-read refusal");
    assert.deepEqual(loadProposalRegistry(join(f.dir, "state", "inbox-proposals.json")).map(p => p.id).sort(),
      [`verify-human:${ID}`, `verify-human:${secondId}`].sort());
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("W1-T10278: lifetime ages survive unrelated historical metadata errors", async () => {
  const f = fixture(true);
  try {
    commitShard(f.dir, 30);
    const unrelated = join(f.dir, "plan", "tasks.d", "unrelated-metadata.yaml");
    writeFileSync(unrelated, "- id: UNRELATED\n  priority: 1\n  priority: 2\n");
    commitShard(f.dir, 20);
    writeFileSync(unrelated, "- id: UNRELATED\n  priority: 2\n");
    commitShard(f.dir, 10);
    writeLedger(f.ledgerPath, [
      { ts: new Date(NOW_MS - 50 * DAY_MS).toISOString(), task: ID, step: "first-seen-context" },
      ...failedAttempts(4, 3),
    ]);
    const result = await route(f);
    assert.match(result.prompts[0]!, /AGE: 30 days since filing/,
      "original qualified Git age wins over the ledger after unrelated metadata was repaired");
    assert.match(result.summaries[0]!, /4 attempts over 30 days/);
    assert.deepEqual(result.ids, [`verify-human:${ID}`]);
    const base: ShardUnderJudgement = { id: ID, title: "t", rationale: "", acceptance: [],
      ageDays: 30, observationKey: "same-source", depsAllMerged: true, citedInSrc: false };
    assert.equal(observedStateKey(base), observedStateKey({ ...base, ageDays: null, ageUnknownReason: "unreadable" }));
    assert.equal(automationProposalFromJudgedShard(base, { decision: "automate", reason: "fixture" }).id,
      automationProposalFromJudgedShard({ ...base, ageDays: null }, { decision: "automate", reason: "fixture" }).id);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

// W1-T13754: an amended task's lifetime-pressure verdict is not reused; a dispatch-only change still is.

const T13754_NOW_MS = Date.parse("2026-11-18T12:00:00Z");
const T13754_ID = "T13754-AMENDED";

function t13754Shard(proof: string, status = "queued", priority = 1.1): string {
  return `
- id: ${T13754_ID}
  title: a task whose proof was amended
  repo: remudero
  type: implement
  depends_on: []
  priority: ${priority}
  status: ${status}
  files:
    - src/example.ts
  acceptance:
    - claim: "the example works"
      proof: "${proof}"
`;
}

async function t13754JudgeOnce(dir: string, yaml: string): Promise<number> {
  writeFileSync(join(dir, "tasks.yaml"), yaml);
  const plan = loadPlan(join(dir, "tasks.yaml"));
  let calls = 0;
  const spawn: typeof spawnWorker = async (_args: SpawnWorkerArgs) => {
    calls += 1;
    return { text: "VERIFY_HUMAN_DECISION: needs_operator\nVERIFY_HUMAN_REASON: fixture" } as WorkerResult;
  };
  await routeAdaptiveLifetimePressure([plan.byId.get(T13754_ID)!], {
    plan, root: dir, config: { root: dir } as unknown as Config, ledgerPath: join(dir, "ledger.ndjson"),
    runId: "RUN-T13754", shadowJudgeSpawns: { primary: spawn, shadow: spawn }, clock: fixedClock(T13754_NOW_MS),
  });
  return calls;
}

function t13754Fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lifetime-contract-"));
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  copyFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), join(dir, ".remudero", "mounts.yaml"));
  mkdirSync(join(dir, "state"), { recursive: true });
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 2; i++) {
    const ts = new Date(T13754_NOW_MS - (5 - i) * 86_400_000).toISOString();
    rows.push({ ts, step: "run.start", task_id: T13754_ID, run_id: `r${i}` });
    rows.push({ ts, step: "verdict", task_id: T13754_ID, run_id: `r${i}`, verdict: "failed", stage: "review", reason: "proof passes at base" });
  }
  writeFileSync(join(dir, "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

test("W1-T13754 criterion 1: an amended acceptance is judged again, not settled by the old verdict", async () => {
  const dir = t13754Fixture();
  try {
    assert.ok(await t13754JudgeOnce(dir, t13754Shard("unit test: test/old.test.ts")) > 0, "the first observation is judged");
    assert.equal(await t13754JudgeOnce(dir, t13754Shard("unit test: test/old.test.ts")), 0, "the same contract is settled");
    assert.ok(await t13754JudgeOnce(dir, t13754Shard("unit test: test/new.test.ts")) > 0, "the amended contract is judged again");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T13754 criterion 2: a status or priority change alone leaves the verdict settled", async () => {
  const dir = t13754Fixture();
  try {
    assert.ok(await t13754JudgeOnce(dir, t13754Shard("unit test: test/old.test.ts")) > 0);
    assert.equal(await t13754JudgeOnce(dir, t13754Shard("unit test: test/old.test.ts", "running", 2.5)), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T13754: the contract digest ignores status, attempts and priority", () => {
  const task = { id: T13754_ID, title: "t", acceptance: [{ claim: "c", proof: "p" }], files: ["a"], status: "queued", priority: 1 };
  const moved = { ...task, status: "running", priority: 3, attempts: 2 };
  const amended = { ...task, acceptance: [{ claim: "c", proof: "q" }] };
  assert.equal(lifetimeContractDigest(task as never), lifetimeContractDigest(moved as never));
  assert.notEqual(lifetimeContractDigest(task as never), lifetimeContractDigest(amended as never));
});
