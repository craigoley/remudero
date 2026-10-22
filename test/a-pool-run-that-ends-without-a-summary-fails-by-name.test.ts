/**
 * A pure-test pool run that ends without its summary is a FAILURE, by name — never a green exit 0.
 *
 * 2026-10-11, ci-shard 1/8 of #10765: one test left serve's stale-code recycle armed, and its real
 * `process.exit(0)` ended the shared `--experimental-test-isolation=none` process a few tests later.
 * The pool exited 0 with no `# tests` line after 92 of its 244 files, and exit status alone read that
 * as a pass. scripts/pure-test-pool.mjs now judges every pool-ladder run (the pool, its isolated
 * re-run, each leak-locating probe) by its end-of-run summary and by every file it was given having
 * reported.
 *
 * These drive the REAL `node --test` runner over fixture files, through the same judged spawn the
 * tier manifest uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTempDir } from "../src/lib/tmp.js";
import { finishJudgedRun, isJudgedRun } from "./helpers/judged-pool-run.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Verdict = {
  status: number;
  complete: boolean;
  given: number;
  reported: number;
  missing: string[];
  tests: number | null;
  failed: number | null;
  lastStarted: string | null;
  exitSite: string | null;
  problems: string[];
};
type JudgedOpts = {
  spawn: (cmd: string, args: string[], opts: SpawnSyncOptions) => { status: number | null; signal?: NodeJS.Signals | null };
  cwd: string;
  args: string[];
  pool: boolean;
  quiet?: boolean;
  role: string;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
};
const manifest = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "test-tier-manifest.mjs")).href)) as {
  main: (
    argv: string[],
    opts: { spawn: (cmd: string, args: string[], o?: unknown) => { status: number | null }; env?: NodeJS.ProcessEnv },
  ) => number;
};
const pool = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "pure-test-pool.mjs")).href)) as {
  POOL_ISOLATION_FLAG: string;
  spawnJudgedRun: (files: string[], opts: JudgedOpts) => number;
  judgeRun: (
    files: string[],
    opts: { status: number; pool: boolean; root?: string; tallyText?: string; markerText?: string },
  ) => Verdict;
  runShardWithPool: (
    files: string[],
    opts: {
      fast: string[];
      root?: string;
      run: (files: string[], opts: { pool: boolean; quiet?: boolean; role: string }) => number;
      log?: (line: string) => void;
    },
  ) => { status: number; poolDefect: null | { leaker: string | null; victim: string | null } };
};

/** The runner arguments a shard passes before the file list, minus tsx: the fixtures are plain .mjs. */
const RUNNER_ARGS = ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout"];

// A nested runner inherits NODE_TEST_CONTEXT (it would run inline) and the coverage session; drop both.
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_V8_COVERAGE = undefined; // blanked, not deleted: a deleted key is re-injected into the child
  return env;
}

/** Piped, so the child's TAP never lands in this file's own report. */
const pipedSpawn = (cmd: string, args: string[], opts: SpawnSyncOptions) =>
  spawnSync(cmd, args, { ...opts, stdio: "pipe", encoding: "utf8", maxBuffer: 1 << 26 });

const PASSING = (name: string) => `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("${name}", () => assert.equal(1 + 1, 2));\n`;

/** Files a runner sorts in this order. `b-recycles` arms a recycle exactly as serve's stale-code gate
 *  did: its test PASSES, then the real `process.exit(0)` fires from a helper during the next test. */
function fixture(): string {
  const root = makeTempDir("pool-summary");
  const files: Record<string, string> = {
    "lib/recycle.mjs": `export function recycleSoon() {\n  setTimeout(() => process.exit(0), 20);\n}\n`,
    "lib/define.mjs": `import test from "node:test";\nexport function defineCheck(name) {\n  test(name, () => {});\n}\n`,
    "test/a-first.test.mjs": PASSING("a-first passes"),
    "test/b-recycles.test.mjs":
      `import test from "node:test";\nimport { recycleSoon } from "../lib/recycle.mjs";\n` +
      `test("b arms a recycle and passes", () => { recycleSoon(); });\n` +
      `test("b keeps working while the recycle lands", async () => { await new Promise((r) => setTimeout(r, 400)); });\n`,
    "test/c-after.test.mjs": PASSING("c-after passes"),
    "test/d-helper-defined.test.mjs": `import { defineCheck } from "../lib/define.mjs";\ndefineCheck("d is defined by a helper module");\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function judged(root: string, files: string[], pooled: boolean, role: string) {
  const log: string[] = [];
  const status = pool.spawnJudgedRun(files, { spawn: pipedSpawn, cwd: root, args: [...RUNNER_ARGS, ...(pooled ? [pool.POOL_ISOLATION_FLAG] : [])], pool: pooled, role, log: (l) => log.push(l), env: childEnv() });
  return { status, log: log.join("\n") };
}

const EXITING_SHARD = ["test/a-first.test.mjs", "test/b-recycles.test.mjs", "test/c-after.test.mjs"];
const CLEAN_SHARD = ["test/a-first.test.mjs", "test/c-after.test.mjs", "test/d-helper-defined.test.mjs"];

test("a pool whose process exits 0 part-way is reported FAILED, naming the file and the exit call site", () => {
  const root = fixture();
  // Control: this IS the 2026-10-11 shape — the bare runner exits 0 and prints no summary.
  const bare = pipedSpawn(process.execPath, [...RUNNER_ARGS, pool.POOL_ISOLATION_FLAG, ...EXITING_SHARD], { cwd: root, env: childEnv() });
  assert.equal(bare.status, 0, "the unjudged pool exits 0");
  assert.doesNotMatch(String(bare.stdout), /^# tests \d+$/m, "and prints no summary");

  const { status, log } = judged(root, EXITING_SHARD, true, "pool");
  assert.notEqual(status, 0, log);
  assert.match(log, /POOL RUN INCOMPLETE/);
  assert.match(log, /no end-of-run test summary/);
  assert.match(log, /Last test started: test\/b-recycles\.test\.mjs > b keeps working while the recycle lands/);
  assert.match(log, /process\.exit\(0\) from .*lib\/recycle\.mjs/);
  assert.match(log, /never reported \(first: test\/c-after\.test\.mjs\)/);
  assert.match(log, /2\/3 file\(s\) reported, # tests none/);
});

test("the shard fails when the pool exits part-way: the isolated re-run is judged by the same rule", () => {
  const root = fixture();
  const log: string[] = [];
  const result = pool.runShardWithPool(EXITING_SHARD, {
    fast: EXITING_SHARD,
    root,
    log: (l) => log.push(l),
    run: (files, opts) => {
      const run = judged(root, files, opts.pool, opts.role);
      log.push(run.log);
      return run.status;
    },
  });
  const text = log.join("\n");
  assert.notEqual(result.status, 0, text);
  assert.equal(result.poolDefect, null, "an exit that also cuts the file short alone is the test's own failure");
  // Isolated, b's own child exits 0 with b's second test never run: the per-file summary is missing.
  assert.match(text, /RERUN RUN INCOMPLETE/);
  assert.match(text, /never reported \(first: test\/b-recycles\.test\.mjs\)/);
  assert.match(text, /also fail isolated/);
});

test("a full pool run passes, and every file it was given reports (positive control)", () => {
  const root = fixture();
  const pooled = judged(root, CLEAN_SHARD, true, "pool");
  assert.equal(pooled.status, 0, pooled.log);
  assert.match(pooled.log, /pool run complete — 3\/3 file\(s\) reported, # tests 3, # fail 0\./);

  const isolated = judged(root, CLEAN_SHARD, false, "rerun");
  assert.equal(isolated.status, 0, isolated.log);
  assert.match(isolated.log, /rerun run complete — 3\/3 file\(s\) reported, # tests 3, # fail 0\./);
});

test("unit test: the judge needs a summary, a clean fail count and a report from every file", () => {
  const files = ["test/a.test.ts", "test/b.test.ts"];
  const root = "/fixture-root";
  const tally = (summary: unknown, testFiles: string[], fileSummaries: string[] = []) =>
    `${JSON.stringify({ version: 1, summary, testFiles, fileSummaries })}\n`;
  const counts = (tests: number, failed = 0) => ({ tests, failed, passed: tests - failed });
  const both = ["/fixture-root/test/a.test.ts", "/fixture-root/test/b.test.ts"];

  const whole = pool.judgeRun(files, { status: 0, pool: true, root, tallyText: tally(counts(5), both) });
  assert.equal(whole.status, 0);
  assert.equal(whole.complete, true);
  assert.deepEqual([whole.given, whole.reported, whole.tests], [2, 2, 5]);

  const noTally = pool.judgeRun(files, { status: 0, pool: true, root, tallyText: "", markerText: "start\t/fixture-root/test/a.test.ts\tfirst\n" });
  assert.equal(noTally.status, 1, "exit 0 without a summary is a failure");
  assert.equal(noTally.lastStarted, "test/a.test.ts > first");
  assert.deepEqual(noTally.missing, ["test/b.test.ts"]);

  const oneSilent = pool.judgeRun(files, { status: 0, pool: true, root, tallyText: tally(counts(5), [both[0]!]) });
  assert.equal(oneSilent.status, 1, "a summary that a file never reported into is not complete");
  assert.deepEqual(oneSilent.missing, ["test/b.test.ts"]);

  const tooFew = pool.judgeRun(files, { status: 0, pool: true, root, tallyText: tally(counts(1), both) });
  assert.equal(tooFew.status, 1, "fewer tests than files given cannot be every file reporting");

  // Isolated, a test from the file reporting is not enough: its child must reach the per-file summary.
  const cutShort = pool.judgeRun(files, { status: 0, pool: false, root, tallyText: tally(counts(3), both, [both[0]!]) });
  assert.equal(cutShort.status, 1);
  assert.deepEqual(cutShort.missing, ["test/b.test.ts"]);

  const red = pool.judgeRun(files, { status: 7, pool: true, root, tallyText: tally(counts(5, 1), both) });
  assert.equal(red.status, 7, "a non-zero status is kept as it is");
});

test("unit test: through the tier manifest, a pool child that exits 0 with no summary fails the shard", () => {
  const root = makeTempDir("pool-summary-main");
  for (const name of ["a", "b", "c"]) {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", `${name}.test.ts`), PASSING(name));
  }
  writeFileSync(join(root, "test", "spawns.test.ts"), `${PASSING("spawns")}spawnSync("true");\n`);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "test-tier-manifest.json"), JSON.stringify({ thresholdMs: 5000, files: {} }));

  // Every child "exits 0" and leaves nothing behind: the 2026-10-11 pool, as main() sees it.
  const silent: Array<{ judged: boolean; pooled: boolean }> = [];
  const code = manifest.main(["--root", root, "--run", "fast"], {
    spawn: (_cmd, args) => {
      silent.push({ judged: isJudgedRun(args), pooled: args.includes(pool.POOL_ISOLATION_FLAG) });
      return { status: 0 };
    },
    env: {},
  });
  assert.notEqual(code, 0, "exit 0 with no summary is not a pass");
  assert.deepEqual(silent, [
    { judged: true, pooled: true },
    { judged: true, pooled: false },
    { judged: true, pooled: false },
  ], "the pool, its isolated re-run and the shard's ordinary rest are all judged");

  // Control: the same shard whose children really finish is green.
  const finished = manifest.main(["--root", root, "--run", "fast"], { spawn: (_cmd, args, o) => finishJudgedRun(args, o), env: {} });
  assert.equal(finished, 0);
});


type FileDiagnostic = { diagnosticVersion: number; attemptId: string; sequence: number; phase: string; files?: string[]; file?: string; elapsedMs: number };
const DIAGNOSTIC_PREFIX = "RMD-TEST-FILE-DIAGNOSTIC ";
function diagnosticRows(stderr: string): FileDiagnostic[] {
  return stderr.split("\n").filter(line => line.startsWith(DIAGNOSTIC_PREFIX)).map(line => JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length)));
}
const diagnosticPool = (await import(pathToFileURL(join(REPO_ROOT, "scripts/pure-test-pool.mjs")).href)) as {
  prepareJudgedRun: (options?: { files?: string[]; root?: string }) => {
    args: string[]; env: NodeJS.ProcessEnv; read: () => { tallyText: string; markerText: string }; cleanup: () => void;
  };
  inlineJudgedArgs: () => string[];
};

function diagnosticFixture() {
  const root = makeTempDir("file-diagnostics");
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test/a.test.mjs"), 'import test from "node:test"; test("SECRET_TITLE",()=>{});');
  return root;
}

test("file lifecycle diagnostics keep the default completed tally separate and expose only selected physical files", () => {
  const root = diagnosticFixture();
  writeFileSync(join(root, "helper.mjs"), 'import test from "node:test"; test("test/forged.test.mjs",()=>{});');
  writeFileSync(join(root, "test/b.test.mjs"), 'import "../helper.mjs"; import test from "node:test"; test("outer",async t=>{await t.test("SECRET_NESTED",()=>{});});');
  writeFileSync(join(root, "test/empty.test.mjs"), "");
  const files = ["test/a.test.mjs", "test/b.test.mjs", "test/empty.test.mjs"];
  const outputs = [];
  for (const enabled of [false, true]) {
    const judged = diagnosticPool.prepareJudgedRun(enabled ? { files, root } : {});
    try {
      const env: NodeJS.ProcessEnv = { ...childEnv(), ...judged.env, PRIVATE_SENTINEL: "SECRET_ENV" };
      if (!enabled) delete env.RMD_TEST_FILE_DIAGNOSTICS;
      const result = pipedSpawn(process.execPath, [...RUNNER_ARGS, ...judged.args, ...files], { cwd: root, env });
      assert.equal(result.status, 0, String(result.stderr));
      outputs.push(judged.read().tallyText);
      const rows = diagnosticRows(String(result.stderr));
      if (!enabled) assert.deepEqual(rows, []);
      else {
        assert.equal(rows.length, 3 * files.length + 2);
        assert.deepEqual(rows[0].files, files);
        assert.equal(rows.at(-1)?.phase, "stream-ended");
        assert.deepEqual(rows.map(row => row.sequence), rows.map((_, index) => index));
        assert.equal(new Set(rows.map(row => row.attemptId)).size, 1);
        for (const file of files) assert.deepEqual(rows.filter(row => row.file === file).map(row => row.phase), ["queued", "dequeued", "completed"]);
        assert.doesNotMatch(JSON.stringify(rows), /SECRET_|forged|helper\.mjs|summary|passed|failed|argv/);
      }
    } finally { judged.cleanup(); }
  }
  assert.deepEqual(JSON.parse(outputs[1]), JSON.parse(outputs[0]), "diagnostics cannot change canonical tally");
});

for (const kind of ["import", "handle"] as const) {
  test(`file lifecycle diagnostics name a real ${kind} hang before the default Node runner exits`, async () => {
    const root = diagnosticFixture();
    const files = ["test/a.test.mjs", "test/b.test.mjs"];
    writeFileSync(join(root, files[1]), kind === "import"
      ? 'setInterval(()=>{},1000); await new Promise(()=>{});'
      : 'import test from "node:test"; import {writeFileSync} from "node:fs"; test("test/b.test.mjs",()=>{writeFileSync("assertion-completed","yes");}); setInterval(()=>{},1000);');
    const judged = diagnosticPool.prepareJudgedRun({ files, root });
    const child = spawn(process.execPath, [...RUNNER_ARGS, "--test-concurrency=2", ...judged.args, ...files], {
      cwd: root, env: { ...childEnv(), ...judged.env }, stdio: "pipe", detached: true,
    });
    let stdout = "", stderr = "";
    const closed = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
    child.stdout.on("data", chunk => { stdout += chunk; });
    try {
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          const rows = diagnosticRows(stderr.slice(0, stderr.lastIndexOf("\n") + 1));
          if (rows.some(row => row.phase === "dequeued" && row.file === files[1]) &&
              rows.some(row => row.phase === "completed" && row.file === files[0]) &&
              (kind === "import" || existsSync(join(root, "assertion-completed")))) {
            clearTimeout(timer); clearInterval(observeFixture); resolve();
          }
        };
        const observeFixture = setInterval(check, 10);
        const timer = setTimeout(() => {
          clearInterval(observeFixture); reject(new Error("default reporter did not expose unfinished physical file"));
        }, 10000);
        child.stderr.on("data", chunk => { stderr += chunk; check(); });
      });
      assert.equal(child.exitCode, null, "receipt must arrive while runner remains alive");
      const rows = diagnosticRows(stderr);
      assert.ok(rows.some(row => row.phase === "dequeued" && row.file === files[1]));
      assert.ok(!rows.some(row => row.phase === "completed" && row.file === files[1]));
      assert.ok(!rows.some(row => row.phase === "stream-ended"));
      assert.equal(judged.read().tallyText, "", "unfinished stream cannot fabricate canonical tally");
      assert.doesNotMatch(JSON.stringify(rows), /SECRET_/);
    } finally {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      await closed;
      judged.cleanup();
    }
  });
}

test("file lifecycle diagnostics leave inline builtin-only tally and nonzero verdict behavior intact", () => {
  const root = diagnosticFixture();
  writeFileSync(join(root, "test/fail.test.mjs"), 'import test from "node:test"; test("SECRET_FAILURE",()=>{throw new Error("SECRET_BODY");});');
  for (const files of [["test/a.test.mjs"], ["test/fail.test.mjs"]]) {
    const judged = diagnosticPool.prepareJudgedRun({ files, root });
    try {
      const result = pipedSpawn(process.execPath, [...RUNNER_ARGS, ...diagnosticPool.inlineJudgedArgs(), ...files], { cwd: root, env: { ...childEnv(), ...judged.env } });
      assert.equal(result.status, files[0].includes("fail") ? 1 : 0);
      const tally = String(result.stdout).split("\n").filter(line => line.startsWith('{"version":1,')).map(line => JSON.parse(line));
      assert.equal(tally.length, 1);
      assert.equal(tally[0].summary.failed, files[0].includes("fail") ? 1 : 0);
      const rows = diagnosticRows(String(result.stderr));
      assert.equal(rows.at(-1)?.phase, "stream-ended");
      assert.doesNotMatch(JSON.stringify(rows), /SECRET_/);
    } finally { judged.cleanup(); }
  }
});


test("file lifecycle diagnostics default failures and inherited ownership cannot change canonical tally or source errors", () => {
  const root = diagnosticFixture();
  const files = ["test/a.test.mjs"];
  const reporterUrl = pathToFileURL(join(REPO_ROOT, "scripts/pool-run-tally.mjs")).href;
  const script = join(root, "observe.mjs");
  writeFileSync(script, `import report from ${JSON.stringify(reporterUrl)};
import {closeSync} from "node:fs";
if(process.env.CLOSE_DIAGNOSTIC_FD) closeSync(2);
async function* events(){
 if(process.env.SOURCE_ERROR) throw new Error("SOURCE_ERROR_SENTINEL");
 for(let i=0;i<4;i++) for(const type of ["test:enqueue","test:dequeue","test:complete"])
  yield {type,data:{nesting:0,file:${JSON.stringify(join(root, files[0]))},name:${JSON.stringify(files[0])}}};
 yield {type:"test:summary",data:{counts:{tests:1,failed:0,passed:1}}};
}
try {for await(const line of report(events())) process.stdout.write(line);}
catch(error){process.stdout.write(error.message); process.exitCode=7;}`);
  const judged = diagnosticPool.prepareJudgedRun({ files, root });
  try {
    const env = { ...childEnv(), ...judged.env };
    const run = (overrides: NodeJS.ProcessEnv = {}) => pipedSpawn(process.execPath, [script], { cwd: root, env: { ...env, ...overrides } });
    const first = run();
    assert.equal(first.status, 0);
    assert.equal(diagnosticRows(String(first.stderr)).length, 5, "duplicate lifecycle events cannot grow output beyond3N+2");
    const inherited = run();
    assert.equal(inherited.status, 0);
    assert.deepEqual(diagnosticRows(String(inherited.stderr)), [], "same attempt belongs to one reporter only");
    assert.equal(String(inherited.stdout), String(first.stdout));
    const unavailable = run({ RMD_TEST_FILE_DIAGNOSTICS: join(root, "absent.json") });
    assert.equal(unavailable.status, 0);
    assert.equal(String(unavailable.stdout), String(first.stdout));
    const sourceObservation = diagnosticPool.prepareJudgedRun({ files, root });
    try {
      const failedSource = run({ ...sourceObservation.env, SOURCE_ERROR: "1" });
      assert.equal(failedSource.status, 7);
      assert.equal(String(failedSource.stdout), "SOURCE_ERROR_SENTINEL", "reporter cannot swallow source stream errors");
      assert.deepEqual(diagnosticRows(String(failedSource.stderr)).map(row => row.phase), ["selected"], "failed stream cannot emit EOF or a canonical tally");
    } finally { sourceObservation.cleanup(); }
  } finally { judged.cleanup(); }
  for (const config of ["{", JSON.stringify({version:1,attemptId:"SECRET_BAD_ID",root,files}),
    JSON.stringify({version:1,attemptId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",root,files:["../SECRET_OUTSIDE.test.mjs"]})]) {
    const path = join(root, "invalid.json"); writeFileSync(path, config);
    const result = pipedSpawn(process.execPath, [script], { cwd: root, env: { ...childEnv(), RMD_TEST_FILE_DIAGNOSTICS: path } });
    assert.equal(result.status, 0);
    assert.deepEqual(diagnosticRows(String(result.stderr)), []);
    assert.equal(JSON.parse(String(result.stdout)).summary.failed, 0);
  }
  const closedFd = diagnosticPool.prepareJudgedRun({ files, root });
  try {
    const result = pipedSpawn(process.execPath, [script], { cwd: root, env: { ...childEnv(), ...closedFd.env, CLOSE_DIAGNOSTIC_FD: "1" } });
    assert.equal(result.status, 0, "a real unwritable diagnostic fd must not fail a successful run");
    assert.equal(JSON.parse(String(result.stdout)).summary.failed, 0);
  } finally { closedFd.cleanup(); }
});


test("the default test-with-retry caller binds physical files and separates fresh retry attempts", () => {
  const root = diagnosticFixture();
  const marker = join(root, "attempted");
  const file = "test/a.test.mjs";
  writeFileSync(join(root, file), `import test from "node:test"; import {existsSync,writeFileSync} from "node:fs";
test("SECRET_RETRY_TITLE",()=>{if(!existsSync(${JSON.stringify(marker)})){writeFileSync(${JSON.stringify(marker)},"1");throw new Error("SECRET_FAILURE");}});`);
  const result = pipedSpawn(process.execPath, [join(REPO_ROOT, "scripts/test-with-retry.mjs"), process.execPath, ...RUNNER_ARGS, file], {
    cwd: root, env: { ...childEnv(), RMD_TEST_FLAKE_LEDGER: join(root, "private-flake.ndjson") },
  });
  assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
  assert.match(String(result.stdout), /FLAKE-RETRY-FILES: retrying 1 failed file/);
  const rows = diagnosticRows(String(result.stderr));
  const ids = [...new Set(rows.map(row => row.attemptId))];
  assert.equal(ids.length, 2, "each separate test attempt has its own diagnostic identity");
  for (const id of ids) {
    const attempt = rows.filter(row => row.attemptId === id);
    assert.deepEqual(attempt[0].files, [file]);
    assert.equal(attempt.length, 5);
    assert.equal(attempt.at(-1)?.phase, "stream-ended");
  }
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_/);
});
