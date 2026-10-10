import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import type { WorkerResult, SpawnWorkerArgs } from "../src/lib/worker.js";
// @ts-ignore executable census module has no declaration file.
import { main, readCensusSnapshot } from "../scripts/census-precheck.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REACH = "test/the-affected-suite-reach-ratchet.test.ts";
const SNAPSHOT_ENV = "RMD_CENSUS_SNAPSHOT";
const IMPORT_CLI = `import ${JSON.stringify("../src/run-task.js")};\n`;

function fixture(root = mkdtempSync(join(tmpdir(), "rmd-census-snapshot-"))) {
  const baseline = JSON.parse(readFileSync(join(ROOT, "scripts/affected-reach-baseline.json"), "utf8"));
  const texts: Record<string, string> = {
    "src/run-task.ts": "export {};\n",
    "src/lib/affected-suites.ts": "export {};\n",
    [REACH]: "export {};\n",
    "scripts/affected-reach-baseline.json": JSON.stringify(baseline),
  };
  for (const path of baseline.importers) texts[path] = IMPORT_CLI;
  for (const [path, text] of Object.entries(texts)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const snapshot = join(root, "snapshot.json");
  writeFileSync(snapshot, JSON.stringify({ version: 1, root, mergeBase: "base-sha",
    headPaths: Object.keys(texts), basePaths: Object.keys(texts), baseBlobs: texts,
    mainBlobs: { "scripts/affected-reach-baseline.json": texts["scripts/affected-reach-baseline.json"] } }));
  const noGit = join(root, "empty-path");
  mkdirSync(noGit);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: noGit, [SNAPSHOT_ENV]: snapshot };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_V8_COVERAGE = undefined;
  return { root, snapshot, env };
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [...args, join(ROOT, file)], {
    cwd: ROOT, env, encoding: "utf8", timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, text: result.stdout + result.stderr };
}

test("test/a-fix-round-checks-its-edits-from-a-harness-git-snapshot.test.ts: no git on PATH, edited census inputs and a new importer are refused", () => {
  const f = fixture();
  const reachArgs = ["--test", "--test-reporter=tap", "--import", "tsx"];
  const clean = run(REACH, reachArgs, f.env);
  assert.equal(clean.status, 0, clean.text);
  assert.match(clean.text, /^# tests 4$/m);
  writeFileSync(join(f.root, "test/new.test.ts"), IMPORT_CLI);
  const refused = run(REACH, reachArgs, f.env);
  assert.equal(refused.status, 1, refused.text);
  assert.match(refused.text, /importerCount: 934 > 933; new importers: test\/new.test.ts/);
  assert.doesNotMatch(refused.text, /ENOENT|git /);
  const precheck = spawnSync(process.execPath, [join(ROOT, "scripts/census-precheck.mjs"), "--root", f.root],
    { cwd: ROOT, env: f.env, encoding: "utf8", timeout: 60_000 });
  assert.ifError(precheck.error);
  assert.equal(precheck.status, 1, precheck.stdout + precheck.stderr);
  assert.match(precheck.stderr, /census-suite: test\/the-affected-suite-reach-ratchet.test.ts fails/);
  assert.doesNotMatch(precheck.stdout + precheck.stderr, /ENOENT|git merge-base/);
});

test("snapshot counters compare disk edits and deletions with frozen base blobs, and reject malformed inputs", () => {
  const f = fixture();
  const before = process.env[SNAPSHOT_ENV];
  process.env[SNAPSHOT_ENV] = f.snapshot;
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    writeFileSync(join(f.root, "src/run-task.ts"), "export const now = Date.now();\n");
    assert.equal(main(["--root", f.root], { admitted: () => [] }), 1);
    assert.ok(errors.some((s) => /clock-signature: src\/run-task.ts dateNow 1 > baseline 0/.test(s)), errors.join("\n"));
    unlinkSync(join(f.root, "src/run-task.ts"));
    assert.equal(readCensusSnapshot().baseBlobs["src/run-task.ts"], "export {};\n");
    writeFileSync(f.snapshot, "{}");
    assert.equal(main(["--root", f.root]), 2);
    assert.ok(errors.some((s) => s.includes("invalid census snapshot")));
    writeFileSync(f.snapshot, JSON.stringify({ version: 1, root: f.root, mergeBase: "base", headPaths: ["../escape"],
      basePaths: [], baseBlobs: {}, mainBlobs: {} }));
    assert.throws(() => readCensusSnapshot(), /invalid census snapshot path/);
  } finally {
    console.error = error;
    if (before === undefined) delete process.env[SNAPSHOT_ENV];
    else process.env[SNAPSHOT_ENV] = before;
  }
});

test("harness writes a read-only snapshot through host git, checks before commit, and records unavailable snapshots", async () => {
  const entrypoint = new URL("../src/run-task.ts", import.meta.url);
  const harness = await import(entrypoint.href);
  const repo = gitRepo({ kind: "census-snapshot" });
  const f = fixture(repo.dir);
  writeFileSync(join(f.root, ".gitignore"), "state/\n");
  writeFileSync(join(f.root, "scripts/unicode.json"), '{"text":"café 🐾"}\n');
  repo.git("add", "src", "scripts", "test", ".gitignore");
  repo.git("commit", "-m", "fixture: census baseline");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const rows: { step: string; extra: Record<string, unknown> }[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, extra }); };
  const snapshot = harness.writeFixCensusSnapshot(f.root, log);
  assert.ok(snapshot);
  assert.equal(statSync(snapshot).mode & 0o777, 0o444);
  const saved = readCensusSnapshot(snapshot);
  assert.equal(saved.baseBlobs["scripts/unicode.json"], '{"text":"café 🐾"}\n');
  assert.ok(saved.headPaths.includes("src/run-task.ts"));
  assert.equal(harness.checkFixCensusSnapshot(f.root, undefined, log), undefined);
  const prompt = renderFixPrompt({ task: { id: "W1-T7182", title: "snapshot" }, round: 1,
    branch: "run-W1-T7182-1", evidence: { ciFailures: [{ name: "census", logTail: "red" }] },
    harnessCommits: true, censusSnapshotPath: snapshot });
  assert.ok(prompt.includes(`RMD_CENSUS_SNAPSHOT='${snapshot}' node scripts/census-precheck.mjs`));
  assert.ok(prompt.includes("Do NOT run git or gh"));
  const oldPath = process.env.PATH;
  process.env.PATH = f.env.PATH;
  try {
    assert.equal(harness.checkFixCensusSnapshot(f.root, snapshot, log).refusal, undefined);
    writeFileSync(join(f.root, "test/new.test.ts"), IMPORT_CLI);
    assert.match(harness.checkFixCensusSnapshot(f.root, snapshot, log).refusal.text, /census-suite:/);
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(harness.writeFixCensusSnapshot(join(f.root, "missing"), log), undefined);
  assert.ok(rows.some((r) => r.step === "fix.census_snapshot" && r.extra.outcome === "unavailable" && r.extra.reason));
  assert.ok(rows.some((r) => r.step === "fix.census_check" && r.extra.outcome === "refused"));
});

test("a refused saved edit is never committed or pushed, and the next fix round receives the census evidence", async () => {
  const entrypoint = new URL("../src/run-task.ts", import.meta.url);
  const harness = await import(entrypoint.href);
  const repo = gitRepo({ kind: "census-round" });
  const f = fixture(repo.dir);
  writeFileSync(join(f.root, ".gitignore"), "state/\nsnapshot.json\nempty-path/\n");
  repo.git("add", "src", "scripts", "test", ".gitignore");
  repo.git("commit", "-m", "fixture: census round baseline");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const head = repo.git("rev-parse", "HEAD");
  const review = { state: "failure", criteria: [{ claim: "census", proof: "unit test: census", met: false,
    reason: "red", proof_exec: "not_executable" }], testTheater: false, summary: "red", floorDegraded: false,
    capped: false, keywordOnly: false, planOnly: false, headSha: head, reviewerOutcome: "failure" };
  const prompts: string[] = [];
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000, provider: "claude" };
  const result = await harness.runFixRung({ taskId: "W1-T7182", runId: "snapshot-round",
    task: { id: "W1-T7182", title: "census", files: ["test/new.test.ts"] },
    prUrl: "https://github.com/fixture/remudero/pull/1", branch: "run-W1-T7182-1", worktreePath: f.root,
    initialSessionId: "initial", mount, settingsFile: join(f.root, "settings.json"),
    config: { root: f.root, workerProviders: { harnessCommitsFix: true } }, budgetUsd: 1, strikeCap: 2,
    initialReview: review, reviewBase: { owner: "fixture", repo: "remudero", headCheckoutDir: f.root, reviewerMount: mount },
    deps: {
      writeFixCensusSnapshot: harness.writeFixCensusSnapshot,
      spawn: async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
        prompts.push(args.prompt);
        assert.ok(args.env?.[SNAPSHOT_ENV]);
        writeFileSync(join(f.root, "test/new.test.ts"), IMPORT_CLI);
        return { sessionId: "session", costUsd: 0, numTurns: 1,
          text: "COMMIT_MESSAGE: fix(census): save edits", blocks: [], stderr: "", subtype: "success",
          isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
      },
      waitForCiGreen: async () => { assert.fail("an uncommitted round must not wait on hosted CI"); },
      runReview: async () => { assert.fail("an uncommitted round must not request review"); },
      fetchPrBody: async () => "REPORT", push: () => { assert.fail("red edits must not be pushed"); },
      harnessCommitForShellLessWorker: () => { assert.fail("red edits must not be committed"); },
      issues: { create: () => "https://github.com/fixture/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(f.root, "state", "ledger.ndjson"), log: () => {}, say: () => {}, account: (r: WorkerResult) => r,
    },
  });
  assert.equal(result.strikes, 2);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1]!.includes("census-suite: test/the-affected-suite-reach-ratchet.test.ts fails"));
  assert.equal(repo.git("rev-parse", "HEAD"), head);
});
