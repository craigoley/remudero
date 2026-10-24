import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import * as sweep from "#src/lib/sweep.js";
import { probeMerge } from "#src/lib/merge-probe.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

async function fixture(t: TestContext, kind: "deletion" | "generated" | "mixed" = "deletion", brokenGenerator = false) {
  const origin = gitRepo({ bare: true });
  const repo = gitRepo();
  t.after(() => { repo.cleanup(); origin.cleanup(); });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  repo.addRemote("origin", origin.dir);
  const path = kind === "deletion" ? "learnings/index.json" : "docs/docs-index.json";
  const write = (path: string, value: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), value);
  };
  write(path, "base\n");
  write("handwritten.txt", "base\n");
  write("package.json", JSON.stringify({ scripts: { "docs-index": "node generate.cjs" } }));
  write("generate.cjs", brokenGenerator ? 'throw new Error("generator unavailable");' :
    'const fs = require("node:fs"); fs.writeFileSync("docs/docs-index.json", fs.readFileSync("head.txt", "utf8") + fs.readFileSync("main.txt", "utf8"));');
  repo.git("add", ".");
  repo.git("commit", "-qm", `chore(test): seed artifacts ${repo.dir}`);
  const branch = "run-W1-T9578-1792839891250";
  repo.git("checkout", "-qb", branch);
  write(path, "head\n");
  write("head.txt", "head input\n");
  if (kind === "mixed") write("handwritten.txt", "head\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "chore(test): edit head");
  const headSha = repo.git("rev-parse", "HEAD");
  repo.git("push", "-q", "origin", branch);
  repo.git("checkout", "-q", "main");
  if (kind === "deletion") {
    repo.git("rm", path);
    write(".gitignore", `${path}\n`);
  } else write(path, "main\n");
  write("main.txt", "main input\n");
  if (kind === "mixed") write("handwritten.txt", "main\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "chore(test): edit main");
  repo.git("push", "-q", "origin", "main");
  const mainSha = repo.git("rev-parse", "HEAD");
  const probe = await probeMerge({ headSha, mainSha, git: (args) => {
    try { return { status: 0, stdout: repo.git(...args) }; }
    catch (error) { return { status: (error as { status: number }).status, stdout: String((error as { stdout: string }).stdout) }; }
  } });
  assert.equal(probe.verdict, "conflict", "positive control: Git observes a real conflict");
  const ledger: Record<string, unknown>[] = [{ step: "sweep.merge_probe", pr_number: 9578,
    head_sha: headSha, main_sha: mainSha, verdict: probe.verdict,
    conflict_paths: probe.verdict === "conflict" ? probe.paths : [] }];
  let workers = 0;
  let admissions = 0;
  let attempts = 0;
  const pr: sweep.OpenPrView = {
    prNumber: 9578, prUrl: "https://github.com/example/fixture/pull/9578", taskId: "W1-T9578",
    headRefName: branch, headSha, mergeState: "dirty", checksState: "none", reviewState: "none",
    unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
    mergeConflict: { files: [path, "handwritten.txt"].map(path => ({ path, oursDeleted: 1, theirsDeleted: 1 })), oursLog: "head", theirsLog: "main" },
  };
  const deps: sweep.SweepDeps = {
    ledgerPath: join(repo.dir, "ledger.ndjson"), runId: "regenerate-test",
    readLedger: () => ledger, appendLine: (_path, row) => { ledger.push(row); },
    arm: () => assert.fail("a conflicted PR cannot arm"), close: () => assert.fail("cannot close"),
    escalate: () => assert.fail("cannot escalate"), readMainTip: () => mainSha,
    dispatchFix: () => { workers++; }, claimFixAdmission: () => { admissions++; return { admitted: true }; },
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    regenerateConflict: (pr, main) => {
      attempts++;
      return sweep.regenerateConflictViaGit(repo.dir, join(repo.dir, "resolution"), pr, main);
    },
  };
  const run = () => withLiveWritesAllowed(async () => {
    const result = await sweep.runSweep([pr], deps);
    await sweep.drainDetachedSweepActions();
    return result;
  });
  const receipts = () => ledger.filter(row => row.step === "sweep.conflict_regenerated");
  const remoteHead = () => origin.git("rev-parse", `refs/heads/${branch}`);
  return { repo, origin, path, mainSha, headSha, pr, deps, ledger, run, receipts, remoteHead,
    counts: () => ({ workers, admissions, attempts }) };
}

test("W1-T9578: a conflict on a registry file main deleted resolves to the deletion without a worker", async (t) => {
  const f = await fixture(t);
  f.deps.claimFixAdmission = () => assert.fail("the direct route takes no fix capacity");
  await f.run();
  const head = f.remoteHead();
  assert.notEqual(head, f.headSha);
  assert.equal(f.origin.git("ls-tree", "-r", "--name-only", head, "--", f.path), "");
  assert.equal(f.origin.git("show", `${head}:head.txt`), "head input");
  assert.equal(f.origin.git("show", `${head}:main.txt`), "main input");
  assert.deepEqual(f.origin.git("rev-list", "--parents", "-1", head).split(" "), [head, f.headSha, f.mainSha]);
  assert.match(f.origin.git("show", "-s", "--format=%B", head), /^Remudero-Task: W1-T9578$/m);
  assert.deepEqual(f.counts(), { workers: 0, admissions: 0, attempts: 1 });
  assert.deepEqual(f.receipts().map(row => [row.outcome, row.head_sha, row.main_sha, row.new_head_sha, row.paths]),
    [["pushed", f.headSha, f.mainSha, head, [{ path: f.path, action: "deleted-on-main" }]]]);
  assert.equal(existsSync(join(f.repo.dir, "resolution")), false);
  await f.run();
  assert.equal(f.counts().attempts, 1, "one attempt for this exact head and main pair");
  assert.equal(f.counts().workers, 0, "a stale snapshot after success cannot dispatch a worker");
});

test("W1-T9578: an unmerged path outside the registry falls through to the conflict worker", async (t) => {
  const f = await fixture(t, "mixed");
  // Even incomplete/stale probe evidence cannot bypass the actual unmerged-index check.
  f.ledger[0]!.conflict_paths = [f.path];
  await f.run();
  assert.equal(f.remoteHead(), f.headSha);
  assert.deepEqual(f.counts(), { workers: 1, admissions: 1, attempts: 1 });
  assert.equal(f.receipts()[0]!.outcome, "fell-through");
  assert.match(String(f.receipts()[0]!.reason), /handwritten.txt/);
  assert.equal(f.ledger.findLast(row => row.step === "sweep.disposed")!.disposition, "conflicted");
  assert.equal(existsSync(join(f.repo.dir, "resolution")), false);
});

test("W1-T9578: a registry path both sides edited resolves to the generator output on the merged tree", async (t) => {
  const f = await fixture(t, "generated");
  await f.run();
  assert.notEqual(f.remoteHead(), f.headSha);
  assert.equal(f.origin.git("show", `${f.remoteHead()}:${f.path}`), "head input\nmain input");
  assert.deepEqual(f.receipts()[0]!.paths, [{ path: f.path, action: "docs-index" }]);
  assert.deepEqual(f.counts(), { workers: 0, admissions: 0, attempts: 1 });
});

test("W1-T9578: missing, wrong-pair and non-registry probes preserve the worker route", async (t) => {
  for (const change of ["missing", "head", "main", "handwritten"] as const) {
    const f = await fixture(t);
    if (change === "missing") f.ledger.length = 0;
    if (change === "head") f.ledger[0]!.head_sha = "other-head";
    if (change === "main") f.ledger[0]!.main_sha = "other-main";
    if (change === "handwritten") f.ledger[0]!.conflict_paths = [f.path, "handwritten.txt"];
    await f.run();
    assert.equal(f.remoteHead(), f.headSha, change);
    assert.deepEqual(f.counts(), { workers: 1, admissions: 1, attempts: 0 }, change);
    assert.equal(f.receipts().length, 0);
  }
});

test("W1-T9578: moved head and main leases refuse a stale resolution without a worker", async (t) => {
  for (const branch of ["main", "run-W1-T9578-1792839891250"]) {
    const f = await fixture(t);
    f.origin.git("update-ref", `refs/heads/${branch}`, branch === "main" ? f.headSha : f.mainSha);
    const before = f.remoteHead();
    await f.run();
    assert.equal(f.remoteHead(), before);
    assert.equal(f.receipts()[0]!.outcome, "lease-mismatch");
    assert.match(String(f.receipts()[0]!.reason), /moved/);
    assert.deepEqual(f.counts(), { workers: 0, admissions: 0, attempts: 1 });
  }
});

test("W1-T9578: a failed generator records its error and falls through once", async (t) => {
  const f = await fixture(t, "generated", true);
  await f.run();
  assert.equal(f.remoteHead(), f.headSha);
  assert.equal(f.receipts()[0]!.outcome, "error");
  assert.match(String(f.receipts()[0]!.reason), /generator unavailable/);
  assert.deepEqual(f.counts(), { workers: 1, admissions: 1, attempts: 1 });
  await f.run();
  assert.equal(f.counts().attempts, 1);
  assert.equal(f.receipts().length, 1);
  assert.equal(existsSync(join(f.repo.dir, "resolution")), false);
});

test("W1-T9578: overlapping passes attempt one resolution for the head and main pair", async (t) => {
  const f = await fixture(t);
  const regenerate = f.deps.regenerateConflict!;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.deps.regenerateConflict = async (pr, main) => { entered(); await pending; return regenerate(pr, main); };
  const first = f.run();
  try {
    await started;
    await f.run();
    assert.equal(f.counts().workers, 0);
  } finally {
    release();
    await first;
  }
  assert.deepEqual(f.counts(), { workers: 0, admissions: 0, attempts: 1 });
  assert.equal(f.receipts().length, 1);
});

test("W1-T9578: dry runs and foreign task heads never try regeneration", async (t) => {
  for (const dryRun of [false, true]) {
    const f = await fixture(t);
    if (dryRun) f.deps.dryRun = true;
    else f.pr.headRefName = "run-W1-TOTHER-1792839891250";
    await f.run();
    assert.equal(f.remoteHead(), f.headSha);
    assert.equal(f.counts().attempts, 0);
    assert.equal(f.receipts().length, 0);
  }
});

test("W1-T9578: merge, push, post-push and cleanup failures retain distinct outcomes", async (t) => {
  for (const fault of ["merge", "push", "post-push", "cleanup", "late-main", "late-head"] as const) {
    const f = await fixture(t);
    let pushed = false;
    const tree = join(f.repo.dir, "resolution");
    const result = await withLiveWritesAllowed(() => sweep.regenerateConflictViaGit(f.repo.dir, tree, f.pr, f.mainSha, {
      git: (cwd, args) => {
        const command = args[0];
        if ((command === "merge" && fault === "merge") || (command === "push" && fault === "push")) {
          throw Object.assign(new Error(`${fault} failed`), { stderr: `${fault} rejected by fixture` });
        }
        if (command === "ls-remote" && args.length === 4 && fault.startsWith("late-")) {
          const ref = fault === "late-main" ? "main" : f.pr.headRefName!;
          f.origin.git("update-ref", `refs/heads/${ref}`, fault === "late-main" ? f.headSha : f.mainSha);
        }
        if (command === "ls-remote" && pushed && fault === "post-push") return `other-sha\trefs/heads/${f.pr.headRefName}\n`;
        const output = execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: "pipe" });
        if (command === "push") pushed = true;
        return output;
      },
      ...(fault === "cleanup" ? { worktreeRemoveImpl: () => {
        f.repo.git("worktree", "remove", "--force", tree);
        throw new Error("cleanup receipt failure");
      } } : {}),
    }));
    assert.equal(result.outcome, fault === "merge" ? "error" : fault === "cleanup" ? "pushed" : "lease-mismatch", fault);
    if (fault === "cleanup") assert.match(result.cleanupError!, /cleanup receipt failure/);
    else assert.ok(result.reason, `${fault} carries its refusal reason`);
    if (!["cleanup", "post-push"].includes(fault)) assert.equal(pushed, false);
    assert.equal(existsSync(tree), false);
  }
});

test("W1-T9578: a throwing resolver is receipted and reaches the worker", async (t) => {
  const f = await fixture(t);
  f.deps.regenerateConflict = () => { throw new Error("resolver unavailable"); };
  await f.run();
  assert.equal(f.remoteHead(), f.headSha);
  assert.equal(f.receipts()[0]!.outcome, "error");
  assert.equal(f.receipts()[0]!.reason, "resolver unavailable");
  assert.equal(f.counts().workers, 1);
});
