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
import { CENSUS_SNAPSHOT_ROOTS, main, readCensusSnapshot } from "../scripts/census-precheck.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REACH = "test/the-affected-suite-reach-ratchet.test.ts";
const SNAPSHOT_ENV = "RMD_CENSUS_SNAPSHOT";
const IMPORT_CLI = `import ${JSON.stringify("../src/run-task.js")};\n`;
// W1-T10820: a real snapshot carries package.json, and an importer in a nested test folder reaches
// src/run-task.ts through the alias, which resolves from any depth where a "../" specifier does not.
const IMPORT_ALIAS = `import { run } from ${JSON.stringify("#src/run-task.js")};\n`;

function fixture(root = mkdtempSync(join(tmpdir(), "rmd-census-snapshot-"))) {
  const baseline = JSON.parse(readFileSync(join(ROOT, "scripts/affected-reach-baseline.json"), "utf8"));
  const texts: Record<string, string> = {
    "src/run-task.ts": "export {};\n",
    "src/lib/affected-suites.ts": "export {};\n",
    // A module no suite reaches keeps the fixture's median reach under the real tree's recorded one.
    "src/lib/unreached.ts": "export {};\n",
    [REACH]: "export {};\n",
    "scripts/affected-reach-baseline.json": JSON.stringify(baseline),
    "package.json": JSON.stringify({ imports: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).imports }),
  };
  for (const path of baseline.importers) texts[path] = IMPORT_ALIAS;
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

test("a CommonJS probe loads the harness snapshot functions without git or async-module errors", () => {
  const f = fixture();
  const script = join(f.root, "probe.cts");
  const tracked = [...CENSUS_SNAPSHOT_ROOTS.map((dir: string) => `${dir}/input.ts`),
    "package.json", ".dependency-cruiser.cjs"];
  writeFileSync(script, [
    `const harness = require(${JSON.stringify(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)))});`,
    `const root = ${JSON.stringify(f.root)};`,
    `const tracked = ${JSON.stringify([...tracked, "unrelated/ignored.ts"])};`,
    `const snapshot = harness.writeFixCensusSnapshot(root, () => {}, (_root, args) => {`,
    `  if (args[0] === "rev-parse") return args[1] === "HEAD" ? "head-sha" : "main-sha";`,
    `  if (args[0] === "merge-base") return "base-sha";`,
    `  if (args[0] === "ls-files") return tracked.join("\\n");`,
    `  if (args[0] === "ls-tree") return "";`,
    `  throw new Error("unexpected snapshot read: " + args.join(" "));`,
    `});`,
    `if (!snapshot) throw new Error("snapshot was not written");`,
    `const calls = [];`,
    `const budgetCalls = [];`,
    `const checked = harness.checkFixCensusSnapshot(root, snapshot, () => {}, (_file, args, opts) => {`,
    `  if (args.includes("--snapshot-budget")) {`,
    `    budgetCalls.push({ args, snapshot: opts.env.RMD_CENSUS_SNAPSHOT });`,
    `    return require("node:child_process").spawnSync(_file, args, opts);`,
    `  }`,
    `  calls.push({ args, snapshot: opts.env.RMD_CENSUS_SNAPSHOT });`,
    `  return { status: 0, stdout: "# tests 4\\n# pass 4\\n# fail 0\\n", stderr: "" };`,
    `});`,
    `process.stdout.write(JSON.stringify({ snapshot, checked, calls, budgetCalls }));`,
  ].join("\n"));
  const result = spawnSync(process.execPath, ["--import", "tsx", script],
    { cwd: ROOT, env: f.env, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.budgetCalls.length, 1, "the actual trusted budget inspector is executed once before the two original checks");
  assert.deepEqual(output.checked, {});
  assert.deepEqual(readCensusSnapshot(output.snapshot).headPaths, tracked);
  assert.equal(statSync(output.snapshot).mode & 0o777, 0o444);
  assert.equal(output.calls.length, 2);
  assert.ok(output.calls.every((call: { snapshot: string }) => call.snapshot === output.snapshot));
  assert.ok(output.calls[0].args[0].endsWith("scripts/census-precheck.mjs"));
  assert.equal(output.calls[1].args.at(-1), REACH);
});

test("test/a-fix-round-checks-its-edits-from-a-harness-git-snapshot.test.ts: no git on PATH, edited census inputs and a new importer are refused", () => {
  const f = fixture();
  const reachArgs = ["--test", "--test-reporter=tap", "--import", "tsx"];
  const clean = run(REACH, reachArgs, f.env);
  assert.equal(clean.status, 0, clean.text);
  assert.match(clean.text, /^# tests 6$/m);
  writeFileSync(join(f.root, "test/new.test.ts"), IMPORT_CLI);
  const refused = run(REACH, reachArgs, f.env);
  assert.equal(refused.status, 1, refused.text);
  const recorded = JSON.parse(readFileSync(join(ROOT, "scripts/affected-reach-baseline.json"), "utf8")).importerCount;
  assert.ok(refused.text.includes(`importerCount: ${recorded + 1} > ${recorded}; new importers: test/new.test.ts`), refused.text);
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
  let snapshotReady = false;
  const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000, provider: "claude" };
  const result = await harness.runFixRung({ taskId: "W1-T7182", runId: "snapshot-round",
    task: { id: "W1-T7182", title: "census", files: ["test/new.test.ts"] },
    prUrl: "https://github.com/fixture/remudero/pull/1", branch: "run-W1-T7182-1", worktreePath: f.root,
    initialSessionId: "initial", mount, settingsFile: join(f.root, "settings.json"),
    config: { root: f.root, workerProviders: { harnessCommitsFix: true } }, budgetUsd: 1, strikeCap: 2,
    initialReview: review, reviewBase: { owner: "fixture", repo: "remudero", headCheckoutDir: f.root, reviewerMount: mount },
    deps: {
      writeFixCensusSnapshot: async (root: string, log: Parameters<typeof harness.writeFixCensusSnapshot>[1]) => {
        snapshotReady = false;
        await new Promise<void>((resolve) => setImmediate(resolve));
        const snapshot = harness.writeFixCensusSnapshot(root, log);
        snapshotReady = true;
        return snapshot;
      },
      spawn: async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
        assert.equal(snapshotReady, true, "the snapshot finishes before the worker is called");
        assert.equal(typeof args.env?.[SNAPSHOT_ENV], "string", "the worker receives a path, never a pending read");
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

test("PR-13121: a census snapshot taken mid-merge of origin/main measures from main, not the branch's old base", async () => {
  const harness = await import(new URL("../src/run-task.ts", import.meta.url).href);
  const repo = gitRepo({ kind: "census-merge" });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  write(".gitignore", "state/\n");
  write("src/shared.ts", "export const shared = 0;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "base");
  const base = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-qb", "mainline");
  write("src/main-only.ts", "export const main = 1;\n");
  write("src/shared.ts", "export const shared = 1;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "main moves on");
  const main = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", main);
  repo.git("checkout", "-qb", "run-branch", base);
  write("src/own.ts", "export const own = 2;\n");
  write("src/shared.ts", "export const shared = 2;\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "branch work");
  const rows: { step: string; extra: Record<string, unknown> }[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => { rows.push({ step, extra }); };
  const before = readCensusSnapshot(harness.writeFixCensusSnapshot(repo.dir, log));
  assert.equal(before.mergeBase, base, "control: with no merge in progress the branch's own merge base is measured");
  assert.equal(rows.at(-1)!.extra.merge_head, undefined);
  assert.throws(() => repo.git("merge", "--no-commit", "--no-ff", "origin/main"), "the fixture's merge conflicts on src/shared.ts");
  const during = readCensusSnapshot(harness.writeFixCensusSnapshot(repo.dir, log));
  assert.equal(during.mergeBase, main, "a merge of origin/main in progress is measured from the main it merges");
  assert.ok(during.basePaths.includes("src/main-only.ts") && during.headPaths.includes("src/own.ts"));
  assert.equal(new Set(during.headPaths).size, during.headPaths.length, "an unmerged path is listed once");
  assert.equal(rows.at(-1)!.extra.merge_head, main);
  writeFileSync(join(repo.dir, repo.git("rev-parse", "--git-path", "MERGE_HEAD")), `${base}\n`);
  const forged = readCensusSnapshot(harness.writeFixCensusSnapshot(repo.dir, log));
  assert.equal(forged.mergeBase, base, "a MERGE_HEAD that is not origin/main never moves the census base");
});

test("PR-13121: a merge-conflict round's census check re-snapshots after the merge has started", async () => {
  const harness = await import(new URL("../src/run-task.ts", import.meta.url).href);
  const written: string[] = [];
  const write = async (root: string) => { written.push(root); return "after-merge.json"; };
  const log = () => {};
  assert.equal(await harness.censusSnapshotForCheck("/wt", "before-merge.json", true, write, log), "after-merge.json");
  assert.equal(await harness.censusSnapshotForCheck("/wt", "before-merge.json", false, write, log), "before-merge.json");
  assert.equal(await harness.censusSnapshotForCheck("/wt", undefined, true, write, log), undefined);
  assert.equal(await harness.censusSnapshotForCheck("/wt", "before-merge.json", true, undefined, log), "before-merge.json");
  assert.equal(await harness.censusSnapshotForCheck("/wt", "before-merge.json", true, async () => undefined, log), "before-merge.json");
  assert.deepEqual(written, ["/wt"]);
});

test("a pending main merge gives the census its prospective merged base without hiding branch edits", async t => {
  const harness = await import("#src/run-task.js");
  const repo = gitRepo({ kind: "pending-main-census", scope: t });
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src/branch.ts"), "export const own = 0;\n");
  repo.git("add", "src"); repo.git("commit", "-m", "fixture: shared census base");
  const base = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-b", "repair");
  writeFileSync(join(repo.dir, "src/branch.ts"), "export const own = Date.now();\n");
  repo.git("add", "src"); repo.git("commit", "-m", "fixture: branch-owned change");
  const head = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "main");
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  const inherited = "test/main-added.test.ts";
  writeFileSync(join(repo.dir, inherited), 'export const inherited = "unchanged main bytes";\n');
  repo.git("add", "test"); repo.git("commit", "-m", "fixture: main adds census member");
  const main = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", main);
  repo.git("checkout", "repair");
  const beforePath = await harness.writeFixCensusSnapshotAsync(repo.dir, () => {});
  assert.ok(beforePath);
  assert.equal(readCensusSnapshot(beforePath).mergeBase, base, "control: an unmerged branch retains the ordinary merge base");
  repo.git("merge", "--no-commit", "--no-ff", "main");
  assert.equal(repo.git("rev-parse", "HEAD"), head, "the harness has not committed its prepared merge");
  const path = await harness.writeFixCensusSnapshotAsync(repo.dir, () => {});
  assert.ok(path);
  const snapshot = readCensusSnapshot(path);
  assert.equal(snapshot.mergeBase, main, "a normal pending main merge has main as its prospective merge base");
  assert.equal(snapshot.baseBlobs[inherited], readFileSync(join(repo.dir, inherited), "utf8"));
  assert.equal(snapshot.baseBlobs["src/branch.ts"], "export const own = 0;\n");
  assert.equal(snapshot.headSha, head, "the branch's committed census inputs remain selected as head");
  assert.ok(snapshot.headPaths.includes("src/branch.ts"));
  assert.equal(repo.git("diff", "--name-only", snapshot.mergeBase, "--", "src/branch.ts"), "src/branch.ts",
    "the branch's own newly unsafe census input remains different from the measured base");
});
