import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { gitRepo } from "./helpers/git-repo.js";
import { renderFixPrompt } from "../src/lib/prompt-render.js";
import type { WorkerResult, SpawnWorkerArgs } from "../src/lib/worker.js";
// @ts-ignore executable census module has no declaration file.
import { CENSUS_SNAPSHOT_ROOTS, main, readCensusSnapshot } from "../scripts/census-precheck.mjs";

const ROOT = REPO_ROOT;
const REACH = "test/the-affected-suite-reach-ratchet.test.ts";
const SNAPSHOT_ENV = "RMD_CENSUS_SNAPSHOT";
const IMPORT_CLI = `import ${JSON.stringify("../src/run-task.js")};\n`;
// W1-T10820: a real snapshot carries package.json, and an importer in a nested test folder reaches
// src/run-task.ts through the alias, which resolves from any depth where a "../" specifier does not.
const IMPORT_ALIAS = `import { run } from ${JSON.stringify("#src/run-task.js")};\n`;

/** The always-on skill census is gitFree and joins every nonempty diff, so a precheck over this tree runs it:
 *  the tree carries a healthy stand-in and, when `linkModules` is set, the dependency donor it runs from. */
const SKILL_CENSUS = "test/rules/every-applies-to-skill-is-selectable-and-bounded.test.ts";

/** The snapshot precheck runs the reach ratchet from the round's own tree, so a tree that must be refused for a new
 *  importer carries a stand-in suite that fails exactly when `test/new.test.ts` exists (the base tree lacks it). */
const REACH_STAND_IN = [
  // The real tree records this suite as a run-task importer, so the stand-in keeps counting as one.
  IMPORT_CLI.trimEnd(),
  'import assert from "node:assert/strict";',
  'import { existsSync } from "node:fs";',
  'import { test, type TestContext } from "node:test";',
  'test("reach stand-in refuses the new importer", () => {',
  '  assert.equal(existsSync("test/new.test.ts"), false, "importerCount: new importer test/new.test.ts");',
  "});", "",
].join("\n");

function fixture(root = mkdtempSync(join(tmpdir(), "rmd-census-snapshot-")), linkModules = false, reachText = IMPORT_ALIAS) {
  const baseline = JSON.parse(readFileSync(join(ROOT, "scripts/affected-reach-baseline.json"), "utf8"));
  const texts: Record<string, string> = {
    "src/run-task.ts": "export {};\n",
    "src/lib/affected-suites.ts": "export {};\n",
    // A module no suite reaches keeps the fixture's median reach under the real tree's recorded one.
    "src/lib/unreached.ts": "export {};\n",
    [SKILL_CENSUS]: 'import { test, type TestContext } from "node:test";\ntest("skill census stand-in", () => undefined);\n',
    "scripts/affected-reach-baseline.json": JSON.stringify(baseline),
    "package.json": JSON.stringify({ imports: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).imports }),
  };
  if (linkModules) symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  for (const path of baseline.importers) texts[path] = IMPORT_ALIAS;
  // After the loop: the baseline lists this suite as an importer, and the loop would overwrite the stand-in.
  texts[REACH] = reachText;
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
    // The judged reach run (W1-T8379) passes only on a tally: this fake stands for a finished run and writes it.
    `  const { finishJudgedRun } = require(${JSON.stringify(join(ROOT, "test", "helpers", "judged-pool-run.ts"))});`,
    `  return { ...finishJudgedRun(args, opts), stdout: "# tests 4\\n# pass 4\\n# fail 0\\n", stderr: "" };`,
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
  const f = fixture(undefined, true, REACH_STAND_IN);
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

async function inheritedContractFixture(t: TestContext) {
  // Only parent changed-source coverage is needed; prevent each unchanged census child from
  // duplicating its raw V8 dump into the same bounded scratch volume.
  const coverage = process.env.NODE_V8_COVERAGE;
  delete process.env.NODE_V8_COVERAGE;
  t.after(() => { if (coverage === undefined) delete process.env.NODE_V8_COVERAGE; else process.env.NODE_V8_COVERAGE = coverage; });
  const harness = await import("#src/run-task.js");
  const repo = gitRepo({ scope: t, kind: "inherited-census-contract" });
  const f = fixture(repo.dir, true);
  const baselinePath = "scripts/affected-reach-baseline.json";
  const current = readFileSync(join(REPO_ROOT, baselinePath), "utf8");
  const legacy = JSON.parse(current);
  delete legacy.resolution;
  // The witnessed old baseline names relative-import resolution. Keep the live baseline's
  // importer population in this small fixture so both real checker legs exercise identical files.
  writeFileSync(join(repo.dir, baselinePath), JSON.stringify(legacy));
  writeFileSync(join(repo.dir, ".gitignore"), "state/\nnode_modules/\nsnapshot.json\nempty-path/\n");
  repo.git("add", "src", "test", "scripts", "package.json", ".gitignore");
  repo.git("commit", "-m", "fixture: legacy reach contract");
  const base = repo.git("rev-parse", "HEAD");
  repo.git("branch", "inherited-fix");
  writeFileSync(join(repo.dir, baselinePath), current);
  repo.git("add", baselinePath);
  repo.git("commit", "-m", "fixture: approved package-imports contract");
  const main = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", main);
  repo.git("switch", "inherited-fix");
  writeFileSync(join(repo.dir, "src/lib/unreached.ts"), "export {};\n// saved fix belongs to this branch\n");
  repo.git("add", "src/lib/unreached.ts");
  repo.git("commit", "-m", "fixture: independent source fix");
  const head = repo.git("rev-parse", "HEAD");
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const log = (step: string, fields: Record<string, unknown> = {}) => { rows.push({ step, fields }); };
  return { harness, repo, baselinePath, current, head, main, base, rows, log };
}

test("the real snapshot checker identifies the inherited reach contract after its merged control passes", async t => {
  const { harness, repo, baselinePath, current, head, main, base, log } = await inheritedContractFixture(t);
  const snapshot = await harness.writeFixCensusSnapshotAsync(repo.dir, log);
  assert.ok(snapshot, "the real Git snapshot is available");
  const refused = await harness.checkFixCensusSnapshotAsync(repo.dir, snapshot, log);
  assert.ok(refused?.refusal, "the unchanged trusted checker must still refuse the legacy contract");

  // Positive control first: do not mistake an unrelated fixture/setup failure for inherited drift.
  repo.git("merge", "--no-edit", "origin/main");
  const mergedSnapshot = await harness.writeFixCensusSnapshotAsync(repo.dir, log);
  assert.ok(mergedSnapshot);
  const merged = await harness.checkFixCensusSnapshotAsync(repo.dir, mergedSnapshot, log);
  assert.equal(merged?.refusal, undefined, "merging main clears the real trusted reach refusal without changing the gate");
  assert.equal(readFileSync(join(repo.dir, baselinePath), "utf8"), current);
  assert.match(readFileSync(join(repo.dir, "src/lib/unreached.ts"), "utf8"), /saved fix belongs/);

  const context = (refused.refusal as unknown as { inheritedMain?: Record<string, unknown> }).inheritedMain;
  assert.deepEqual(context, { state: "inherited", headSha: head, mainSha: main, mergeBase: base, baselinePath },
    "the refusing result must name its verified inherited context rather than buying another blind model retry");
});


test("inherited census baseline drift refreshes before another fix worker", async t => {
  const { harness, repo, head, main, baselinePath, current, rows, log } = await inheritedContractFixture(t);
  const { acquireInflightLock } = await import("#src/lib/inflight-lock.js");
  const { fixRoundBranchClaim } = await import("#src/lib/sweep.js");
  const { spawnSync } = await import("node:child_process");
  const root = join(repo.dir, "state", "native-refresh");
  mkdirSync(root, { recursive: true });
  const branch = repo.git("branch", "--show-current");
  const sibling = "refs/heads/unrelated-sibling";
  repo.git("update-ref", sibling, main);
  const lock = acquireInflightLock(join(root, "locks"), "refresh", { run_id: "TEST-refresh" });
  t.after(() => lock.release());
  const claim = fixRoundBranchClaim(lock, () => { throw new Error("unexpected second owner"); });
  const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 2, contextBudget: 120000 };
  const review = { state: "failure" as const, headSha: head, reviewerOutcome: "failure", testTheater: false, summary: "cleanup needs repair",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    criteria: [{ claim: "the cleanup is confirmed", proof: "unit test: cleanup is confirmed", met: false, reason: "still blocked", proof_exec: "not_executable" as const }] };
  let spawned = 0, updates = 0;
  const outcome = await harness.runFixRung({ taskId: "W1-T10935TEST", runId: "TEST-refresh",
    task: { id: "W1-T10935TEST", title: "cleanup is confirmed", files: ["src/lib/unreached.ts"] },
    prUrl: "https://github.com/craigoley/remudero/pull/1", branch, worktreePath: repo.dir, initialSessionId: "fixture",
    mount, settingsFile: join(root, "settings.json"), config: { root, workerProviders: { harnessCommitsFix: true } } as import("#src/lib/config.js").Config,
    budgetUsd: 1, strikeCap: 1, initialReview: review,
    reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    deps: { spawn: async () => { spawned++; throw new Error("must refresh before buying a model retry"); },
      waitForCiGreen: async () => "green" as const, runReview: async () => review,
      fetchPrBody: async () => "REPORT", push: () => { throw new Error("no push from old checkout"); },
      issues: { create: () => "https://github.com/craigoley/remudero/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => [], log, say: () => {}, account: result => result,
      writeFixCensusSnapshot: harness.writeFixCensusSnapshotAsync, branchClaim: claim,
      readLiveState: () => ({ ok: true, state: "OPEN" }),
      readLiveHead: () => ({ ok: true, headSha: head, headRefName: branch }),
      readCiRollup: () => [{ name: "ci-gate", conclusion: "SUCCESS" }],
      readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 1 }),
      reproduceFailingTestsOnMerge: async (_pr, files, tip) => {
        assert.equal(tip, main);
        const trial = join(root, "trial");
        repo.git("worktree", "add", "--detach", trial, main);
        try {
          const git = (...args: string[]) => {
            const out = spawnSync("git", ["-C", trial, ...args], { encoding: "utf8" });
            assert.equal(out.status, 0, out.stderr); return out.stdout.trim();
          };
          git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "merge", "--no-edit", head);
          const snap = await harness.writeFixCensusSnapshotAsync(trial, log);
          const checked = await harness.checkFixCensusSnapshotAsync(trial, snap, log);
          assert.equal(checked?.refusal, undefined, "the unchanged real checker passes the private merged control");
          assert.equal(readFileSync(join(trial, baselinePath), "utf8"), current);
          return files.map(file => ({ file, outcome: "passes" as const, duration_ms: 1, cached: false }));
        } finally { repo.git("worktree", "remove", "--force", trial); }
      },
      updateBranch: (number, expected) => { assert.equal(number, 1); assert.equal(expected, head); updates++; return { ok: true }; },
    },
  });
  assert.equal(outcome.outcome, "base_refreshed", JSON.stringify({ outcome, rows }));
  assert.equal(spawned, 0); assert.equal(updates, 1);
  assert.equal(repo.git("rev-parse", "HEAD"), head, "asynchronous acceptance never pretends this old checkout was refreshed");
  assert.equal(repo.git("rev-parse", sibling), main, "unrelated sibling is untouched");
  assert.ok(rows.some(row => row.step === "fix.census_check" && row.fields.outcome === "refused"));
  assert.ok(rows.some(row => row.step === "fix.census_refresh" && row.fields.outcome === "requested"));
});


test("census baseline refresh never excuses new growth or an edited baseline", async t => {
  const { harness, repo, baselinePath, current, log } = await inheritedContractFixture(t);
  // A formatting-only edit is still a PR baseline edit; compare Git blobs, not trimmed JSON.
  writeFileSync(join(repo.dir, baselinePath), readFileSync(join(repo.dir, baselinePath), "utf8") + "\n");
  repo.git("add", baselinePath); repo.git("commit", "-m", "fixture: baseline edited by PR");
  let snapshot = await harness.writeFixCensusSnapshotAsync(repo.dir, log);
  assert.ok(snapshot);
  assert.equal((await harness.readInheritedCensusContextAsync(repo.dir, snapshot)).state, "not-inherited");
  repo.git("revert", "--no-edit", "HEAD");
  // Keep this fresh head/base pair for the unreadable and stale-identity controls below.
  snapshot = await harness.writeFixCensusSnapshotAsync(repo.dir, log);
  assert.ok(snapshot);
  assert.equal((await harness.readInheritedCensusContextAsync(repo.dir, snapshot)).state, "inherited");
  const malformed = join(repo.dir, "state", "malformed-snapshot.json");
  writeFileSync(malformed, "{\"version\":1}");
  assert.equal((await harness.readInheritedCensusContextAsync(repo.dir, malformed)).state, "unavailable");
  assert.equal((await harness.readInheritedCensusContextAsync(repo.dir, malformed + ".missing")).state, "unavailable");
  assert.equal((await harness.readInheritedCensusContextAsync(repo.dir, join(repo.dir, "state"))).state, "unavailable");
  writeFileSync(malformed, JSON.stringify({ version: 1, root: repo.dir, headSha: "invalid", headPaths: [] }));
  assert.equal((await harness.readInheritedCensusContextAsync(repo.dir, malformed)).state, "unavailable");
  repo.git("merge", "--no-edit", "origin/main");
  assert.equal((await harness.readInheritedCensusContextAsync(repo.dir, snapshot)).state, "unavailable", "a stale snapshot cannot authorize refresh");
  const migrated = await harness.writeFixCensusSnapshotAsync(repo.dir, log); assert.ok(migrated);
  assert.equal((await harness.readInheritedCensusContextAsync(repo.dir, migrated)).state, "not-inherited", "an already migrated baseline needs no refresh");
  writeFileSync(join(repo.dir, "test/new.test.ts"), IMPORT_ALIAS);
  repo.git("add", "test/new.test.ts"); repo.git("commit", "-m", "fixture: actual new alias importer");
  snapshot = await harness.writeFixCensusSnapshotAsync(repo.dir, log);
  assert.ok(snapshot);
  const refused = await harness.checkFixCensusSnapshotAsync(repo.dir, snapshot, log);
  assert.ok(refused?.refusal, "new head-only growth remains refused after main's migration");
  assert.match(refused.refusal.text, /importerCount|new importers/);
  assert.notEqual(refused.refusal.inheritedMain?.state, "inherited");
  assert.equal(readFileSync(join(repo.dir, baselinePath), "utf8"), current, "no ceiling or baseline edit excused new growth");
});


test("a pre-open inherited census refusal cannot buy another worker without a native PR refresh", async t => {
  const { harness, repo, head, main, base, log } = await inheritedContractFixture(t);
  let spawned = 0;
  const root = join(repo.dir, "state", "pre-open"); mkdirSync(root, { recursive: true });
  const result = await harness.repairCensusRefusedPush({
    refusal: { text: "trusted census refused", censuses: ["census-suite"], offeredBaselines: [],
      inheritedMain: { state: "inherited", headSha: head, mainSha: main, mergeBase: base, baselinePath: "scripts/affected-reach-baseline.json" } },
    task: { id: "W1-T10935TEST", title: "fixture", repo: "remudero", files: ["src/lib/unreached.ts"] },
    runId: "TEST-pre-open", worktreePath: repo.dir, branch: "inherited-fix", resumeSessionId: "fixture",
    mount: { model: "sonnet", effort: "medium", maxTurns: 2, contextBudget: 120000 }, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as import("#src/lib/config.js").Config,
    budgetUsd: 1, ledgerPath: join(root, "ledger.ndjson"),
    spawn: async () => { spawned++; throw new Error("must not buy another worker"); }, account: result => result, log, say: () => {},
  });
  assert.equal(result.outcome, "refused"); assert.equal(result.strikes, 0); assert.equal(spawned, 0);
  assert.match(result.reason, /no PR exists yet/);
});


test("a pre-open census repair stops on newly witnessed inherited drift before its second worker", async t => {
  const { harness, repo, log } = await inheritedContractFixture(t);
  let spawned = 0;
  const root = join(repo.dir, "state", "pre-open-new"); mkdirSync(root, { recursive: true });
  const result = await harness.repairCensusRefusedPush({
    refusal: { text: "trusted census refused", censuses: ["census-suite"], offeredBaselines: [] },
    task: { id: "W1-T10935TEST", title: "fixture", repo: "remudero", files: ["src/lib/unreached.ts"] },
    runId: "TEST-pre-open", worktreePath: repo.dir, branch: "inherited-fix", resumeSessionId: "fixture",
    mount: { model: "sonnet", effort: "medium", maxTurns: 2, contextBudget: 120000 }, settingsFile: join(root, "settings.json"),
    config: { root, workerProviders: { harnessCommitsFix: true } } as import("#src/lib/config.js").Config,
    budgetUsd: 1, ledgerPath: join(root, "ledger.ndjson"),
    spawn: async () => {
      spawned++;
      return { sessionId: "fixture", costUsd: 0, numTurns: 1, text: "FIX_OUTCOME: FIXED", blocks: [], stderr: "", subtype: "success",
        isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
    }, account: result => result, log, say: () => {},
  });
  assert.equal(result.outcome, "refused"); assert.equal(result.strikes, 1); assert.equal(spawned, 1);
  assert.equal(result.refusal.inheritedMain?.state, "inherited");
  assert.match(result.reason, /no PR exists yet/);
});
