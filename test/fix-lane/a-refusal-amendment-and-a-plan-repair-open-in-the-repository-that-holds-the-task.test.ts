import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { extractRefusal, REFUSAL_AMENDMENT_STEP } from "#src/lib/refusal-amendment.js";
import { buildSweepEffects, runSweep, PLAN_REPAIR_DISPATCH_STEP, type BuildSweepEffectsDeps,
  type OpenPrView, type ProofDiscriminationEvidence } from "#src/lib/sweep.js";
import { buildFixturePlanPrBody } from "#test/helpers/plan-pr-body-fixture.js";

const ID = "W1-T900015", PUBLIC = "fixture/remudero", OPS = "fixture-private/ops";
const SHARD = `plan/tasks.d/${ID}-fixture.yaml`;
const PROOF: ProofDiscriminationEvidence = {
  proofs: [{ claim: "fixture behavior", proof: "unit test: missing fixture", proofExec: "not_executable" }],
};
const yaml = (where: string) => `- id: ${ID}\n  title: ${where} fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  risk: high\n  verify: auto\n  status: queued\n  attempts: 0\n  acceptance:\n    - claim: fixture behavior\n      proof: "unit test: missing fixture"\n`;

function fixture(t: TestContext, catalog: "public" | "ops", kinds: string[] | null = []) {
  const root = mkdtempSync(join(tmpdir(), "rmd-task-file-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const publicDir = join(root, "repos", "remudero"), opsDir = join(root, "repos", "ops");
  for (const [dir, label] of [[publicDir, "public"], [opsDir, "ops"]]) {
    mkdirSync(dirname(join(dir!, SHARD)), { recursive: true });
    writeFileSync(join(dir!, SHARD), yaml(label!));
  }
  mkdirSync(join(root, "state"));
  const hostFile = join(root, "state", "plan-destination.json");
  if (kinds !== null) writeFileSync(hostFile, JSON.stringify({ repository: OPS, kinds }));
  const text = yaml("ops"), hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text), tree = hash(commit + "tree"), planTree = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`);
  const reads: string[] = [], gh: string[][] = [], git: string[][] = [];
  const preflights: string[] = [], worktrees: Array<{ repoDir: string; path: string }> = [];
  const proofRoots: Array<{ codeRoot?: string; bodyProofRoot?: "code" | "plan" }> = [];
  const removed: Array<{ repoDir: string; path: string }> = [], rows: Array<Record<string, unknown>> = [];
  const opened = new Map<string, string>();
  const options = { existing: false, unreadable: false };
  const publicPlan = mergePlanBlobs([{ label: "fixture.yaml", text: catalog === "public" ? yaml("public") : "[]" }]);
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const deps: BuildSweepEffectsDeps = {
    owner: "fixture", repo: "remudero", repoRoot: publicDir,
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath, runId: "fixture-sweep", plan: publicPlan, reloadPlanForFixImpl: () => publicPlan,
    log: (step, extra) => rows.push({ step, ...extra }),
    readJsonImpl: async args => {
      const path = args[1]!; reads.push(path);
      if (options.unreadable) throw new Error("private fixture bytes must stay private");
      const base = `repos/${OPS}`;
      if (path === base) return { id: 15, full_name: OPS, default_branch: "main" };
      if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
      if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
      if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false,
        tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] };
      if (path === `${base}/git/trees/${planTree}`) return { sha: planTree, truncated: false,
        tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
      assert.equal(path, `${base}/git/blobs/${blob}`);
      return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
    },
    planRepairGitImpl: (_file, args) => {
      git.push([...args]);
      // The ops record is also on the ops main branch, where an ops refusal amendment reads it.
      if (args[1] === opsDir && args.includes("ls-tree") && args.at(-1) === "plan/tasks.d/") return `${SHARD}\n`;
      if (args[1] === opsDir && args.at(-1) === `fixture-sha:${SHARD}`) return yaml("ops");
      if (args.includes("rev-parse")) return args.at(-1) === "origin/main" ? "mainsha" : "fixture-sha";
      if (args.includes("hash-object")) return "fixture-blob";
      if (args.includes("write-tree")) return `tree-${root}-${args[1]}`;
      if (args.includes("commit-tree")) return "fixture-sha";
      return "";
    },
    ghJsonImpl: args => {
      gh.push([...args]);
      if (args[0] === "pr") {
        const repository = args[args.indexOf("--repo") + 1]!;
        if (args[1] === "list") return opened.has(repository) ? [{ url: opened.get(repository) }] : [];
        assert.equal(args[1], "create");
        const url = `https://github.com/${repository}/pull/15`; opened.set(repository, url); return url;
      }
      const route = args.find(arg => arg.startsWith("repos/"))!;
      const repository = route.split("/").slice(1, 3).join("/");
      if (route.includes("pulls?")) return options.existing ? [{ html_url: `https://github.com/${repository}/pull/14`, number: 14 }] : [];
      assert.ok(args.includes("POST"));
      return { html_url: `https://github.com/${repository}/pull/16`, number: 16 };
    },
    worktreeAddImpl: (repoDir, path) => {
      worktrees.push({ repoDir, path }); mkdirSync(dirname(join(path, SHARD)), { recursive: true });
    },
    worktreeRemoveImpl: (repoDir, path) => { removed.push({ repoDir, path }); },
    gitPushRunBranchImpl: () => {}, buildPlanPrBodyImpl: buildFixturePlanPrBody,
    planPrPreflightImpl: (dir, _sha, pr) => {
      preflights.push(dir); proofRoots.push({ codeRoot: pr.codeRoot, bodyProofRoot: pr.bodyProofRoot });
      return { ok: true, failures: [], unreadable: [] };
    },
  };
  const effects = buildSweepEffects(deps);
  const amendment = async () => {
    appendLedger(ledgerPath, { step: "verdict", run_id: "refused-run", task_id: ID, verdict: "no_pr",
      report_excerpt: "REFUSED:\n1. [premise-rotted] fixture premise moved", ts: new Date().toISOString() });
    await withLiveWritesAllowed(() => runSweep([], {
      arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, ledgerPath,
      runId: "fixture-sweep", draftRefusalAmendments: effects.draftRefusalAmendments,
      log: deps.log,
    }));
  };
  const repair = () => withLiveWritesAllowed(() => effects.dispatchPlanOnlyRepair!({
    taskId: ID, prNumber: 15, prUrl: `https://github.com/${PUBLIC}/pull/15`, headSha: "head",
  } as OpenPrView, PROOF));
  const sweepRepair = () => withLiveWritesAllowed(() => runSweep([{
    taskId: ID, prNumber: 15, prUrl: `https://github.com/${PUBLIC}/pull/15`, headSha: "head",
    body: `Remudero-Task: ${ID}`, reviewState: "pending", checksState: "red", unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
    changedFiles: ["src/fixture.ts"], redRequiredChecks: ["proof-discrimination"],
    ciFailures: [{ name: "proof-discrimination", conclusion: "FAILURE", logTail:
      `proof-discrimination: FAIL — 1 proof(s) pass at both PR head and merge base (abc123):\n  proof: ${PROOF.proofs[0]!.proof}\n  head hits: 1; base hits: 1` }],
  }], {
    arm: () => {}, close: () => {}, dispatchFix: () => { assert.fail("a stale proof uses the plan repair"); },
    escalate: () => { assert.fail("the repair is available"); }, ledgerPath, runId: "fixture-sweep-repair",
    repairMetadata: () => ({ repaired: false, notMetadata: true, reason: "a stale proof needs its task file" }),
    dispatchPlanOnlyRepair: effects.dispatchPlanOnlyRepair, log: deps.log,
  }));
  const creates = () => gh.filter(args => args[1] === "create" || args.includes("POST"));
  const ledger = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { root, publicDir, opsDir, hostFile, reads, gh, git, preflights, proofRoots, worktrees, removed, rows,
    options, amendment, repair, sweepRepair, creates, ledger, effects };
}

test("W1-T12215 criterion 1: ops refusal reads the ops shard and lands in ops with task kind removed", async t => {
  const f = fixture(t, "ops"); await f.amendment();
  assert.equal(f.creates().length, 1);
  assert.ok(f.creates()[0]!.includes(OPS));
  assert.deepEqual(f.preflights, [f.opsDir]);
  assert.deepEqual(f.proofRoots, [{ codeRoot: f.publicDir, bodyProofRoot: "plan" }]);
  const staged = readFileSync(join(f.root, "state/task-files-landing-pending", SHARD), "utf8");
  assert.match(staged, /title: ops fixture/); assert.match(staged, /refusal-amendment/);
  assert.equal(f.ledger().find(row => row.step === REFUSAL_AMENDMENT_STEP)?.pr_url, `https://github.com/${OPS}/pull/15`);
});

test("W1-T12215 criterion 2: ops repair binds probe worktree preflight create and cleanup to ops", async t => {
  const f = fixture(t, "ops"); await f.repair();
  assert.equal(f.creates().length, 1); assert.ok(f.creates()[0]!.includes(`repos/${OPS}/pulls`));
  assert.equal(f.worktrees[0]?.repoDir, f.opsDir); assert.deepEqual(f.removed, f.worktrees);
  assert.deepEqual(f.preflights, [f.worktrees[0]!.path]);
  assert.deepEqual(f.proofRoots, [{ codeRoot: f.publicDir, bodyProofRoot: "plan" }]);
  assert.match(readFileSync(join(f.worktrees[0]!.path, SHARD), "utf8"), /title: ops fixture/);
  assert.match(readFileSync(join(f.worktrees[0]!.path, SHARD), "utf8"), /sweep-flagged proof/);
  assert.ok(f.git.filter(args => args.includes("fetch") || args.includes("branch")).every(args => args[1] === f.opsDir));
});

test("W1-T12215 criterion 3: public tasks stay public with task in kinds for both paths", async t => {
  const f = fixture(t, "public", ["task"]); await f.amendment(); await f.repair();
  assert.equal(f.creates().length, 2);
  assert.ok(f.creates()[0]!.includes(PUBLIC)); assert.ok(f.creates()[1]!.includes(`repos/${PUBLIC}/pulls`));
  assert.deepEqual(f.reads, []); assert.equal(f.worktrees[0]?.repoDir, f.publicDir);
  assert.match(readFileSync(join(f.root, "state/task-files-landing-pending", SHARD), "utf8"), /title: public fixture/);
});

test("W1-T12215 criterion 4: an existing ops amendment is probed in ops and never duplicated", async t => {
  const f = fixture(t, "ops"); f.options.existing = true; await f.amendment(); await f.repair();
  const probes = f.gh.filter(args => args.some(arg => arg.includes("pulls?")));
  assert.equal(probes.length, 2); assert.ok(probes.every(args => args[1]!.startsWith(`repos/${OPS}/`)));
  assert.equal(f.creates().length, 0); assert.equal(f.worktrees.length, 0);
  assert.equal(f.ledger().find(row => row.step === REFUSAL_AMENDMENT_STEP)?.pr_url, `https://github.com/${OPS}/pull/14`);
});

test("W1-T12215 criterion 4: a queued ops amendment keeps its ops landing receipt", async t => {
  const f = fixture(t, "ops"); await f.amendment();
  const reportExcerpt = "REFUSED:\n1. [premise-rotted] fixture premise moved again";
  const results = await withLiveWritesAllowed(() => f.effects.draftRefusalAmendments!([{
    taskId: ID, runId: "another-refusal", reportExcerpt, refusals: extractRefusal(reportExcerpt),
  }]));
  assert.equal(results[0]?.outcome, "deduped");
  assert.equal(results[0]?.prUrl, `https://github.com/${OPS}/pull/15`);
  assert.equal(f.creates().length, 1);
});

for (const failure of ["catalog", "host"] as const) {
  test(`W1-T12215 criterion 5: unreadable ${failure} opens neither path and reports a retryable code`, async t => {
    const f = fixture(t, "ops");
    if (failure === "catalog") f.options.unreadable = true; else writeFileSync(f.hostFile, "{");
    await f.amendment(); await f.repair();
    assert.equal(f.creates().length, 0); assert.equal(f.worktrees.length, 0); assert.deepEqual(f.git, []);
    const code = failure === "catalog" ? "ops-unreadable" : "destination-unreadable";
    for (const step of ["sweep.refusal_amendment.error", PLAN_REPAIR_DISPATCH_STEP]) {
      const row = f.rows.find(row => row.step === step);
      assert.equal(row?.outcome, "lookup_unreadable"); assert.equal(row?.code, code);
    }
    assert.equal(f.ledger().some(row => row.step === REFUSAL_AMENDMENT_STEP), false);
    assert.equal(JSON.stringify(f.rows).includes("private fixture bytes"), false);
    assert.equal(existsSync(join(f.root, "state/task-files-landing-pending", SHARD)), false);
    f.options.unreadable = false;
    writeFileSync(f.hostFile, JSON.stringify({ repository: OPS, kinds: [] }));
    await f.amendment();
    assert.equal(f.creates().length, 1); assert.ok(f.creates()[0]!.includes(OPS));
  });
}

test("W1-T12215 criterion 6: without a host file both paths retain their public calls", async t => {
  const f = fixture(t, "public", null); await f.amendment(); await f.repair();
  assert.equal(f.creates().length, 2); assert.ok(f.creates()[0]!.includes(PUBLIC));
  assert.ok(f.creates()[1]!.includes(`repos/${PUBLIC}/pulls`)); assert.deepEqual(f.reads, []);
  assert.equal(f.worktrees[0]?.repoDir, f.publicDir);
  assert.deepEqual(f.preflights, [f.publicDir, f.worktrees[0]!.path]);
});

test("W1-T12215 criterion 7: the real sweep resolves ops through the pinned catalog reader", async t => {
  const f = fixture(t, "ops"); await f.amendment(); await f.sweepRepair();
  assert.ok(f.reads.includes(`repos/${OPS}/git/ref/heads/main`));
  assert.ok(f.reads.some(path => path.startsWith(`repos/${OPS}/git/blobs/`)));
  assert.equal(f.ledger().find(row => row.step === REFUSAL_AMENDMENT_STEP)?.outcome, "drafted");
  assert.equal(f.creates().length, 2, JSON.stringify({ rows: f.rows, ledger: f.ledger() })); assert.ok(f.creates()[0]!.includes(OPS));
  assert.ok(f.creates()[1]!.includes(`repos/${OPS}/pulls`));
  assert.equal(f.rows.find(row => row.step === PLAN_REPAIR_DISPATCH_STEP)?.outcome, "dispatched");
});
