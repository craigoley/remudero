import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import * as push from "#src/lib/git-push.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { worktreeAdd } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T11285: hooks/pre-push's managed-worktree arm (the gate root is a harness checkout, not the pushed tree) used to
// throw "source-reader runtime calibration is unavailable" for every suite carrying a readerRuntimePolicy. These
// drive the REAL hook body through gitPushRunBranch, with a fixture bwrap that records each sandboxed child.

const READER = "test/fixture-reader.test.ts";
const POLICY = "{ floorMs: 1000, multiple: 4, remeasureMargin: 1.1 }";

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fixture({ sandbox = "available", reader = "healthy" }: { sandbox?: "available" | "unavailable"; reader?: "healthy" | "unhealthy" } = {}) {
  const root = makeTempDir("t11285");
  const harness = join(root, "harness");
  const log = join(root, "runner.jsonl");
  const runner = join(root, "runner.mjs");
  // A stand-in bwrap: records its argv, then runs the command after `--` (the proof sandbox argv's separator).
  put(runner, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv }) + '\\n');
const at = argv.indexOf('--');
const r = spawnSync(argv[at + 1], argv.slice(at + 2), { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status ?? 2);
`);
  chmodSync(runner, 0o755);
  mkdirSync(join(harness, "hooks"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "hooks/pre-push"), join(harness, "hooks/pre-push"));
  chmodSync(join(harness, "hooks/pre-push"), 0o755);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(harness, "node_modules"));
  // An ESM package scope, as the real daemon checkout is (see W1-T421 in the proof-sandbox suite).
  put(join(harness, "package.json"), JSON.stringify({ type: "module" }));
  const url = (path: string) => JSON.stringify(pathToFileURL(join(REPO_ROOT, path)).href);
  const status = sandbox === "unavailable"
    ? "{ mode: 'unsandboxed', reason: 'fixture: user namespaces unavailable' }"
    : `{ mode: 'bwrap', binary: ${JSON.stringify(runner)} }`;
  put(join(harness, "src/lib/git-push.ts"), `import * as p from ${url("src/lib/git-push.ts")};
export const createPrePushSandboxRunner = (cwd) => p.createPrePushSandboxRunner(cwd, { probe: () => (${status}) });\n`);
  // The one admitted member is a structural source-text reader with a valid runtime policy, as
  // listAdmittedCensusMembers builds for every census-shaped reader.
  put(join(harness, "scripts/census-precheck.mjs"), `export { main, runCensusSuitesViaChild } from ${url("scripts/census-precheck.mjs")};
export const listAdmittedCensusMembers = () => [{ testFile: ${JSON.stringify(READER)}, script: '', walks: ['src/'], structural: true, readerRuntimePolicy: ${POLICY} }];\n`);
  for (const name of ["ci-control-plane-precheck", "lint-plan-precheck"]) {
    put(join(harness, `scripts/${name}.mjs`), `export * from ${url(`scripts/${name}.mjs`)};\n`);
  }
  put(join(harness, "scripts/lib/git.mjs"), `export * from ${url("scripts/lib/git.mjs")};\n`);
  const remote = gitRepo({ bare: true, kind: "t11285-remote" });
  const seed = gitRepo({ kind: "t11285-seed" });
  seed.addRemote("origin", remote.dir);
  seed.git("push", "-q", "origin", "main");
  const branch = "run-W1-T11285-1";
  const wt = join(root, "worktree");
  worktreeAdd(seed.dir, wt, branch, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  const tree = seed.addWorktree(join(root, "editor"), "fixture-editor");
  const git = (...args: string[]) => tree.git("-C", wt, ...args);
  if (!existsSync(join(wt, "node_modules"))) symlinkSync(join(REPO_ROOT, "node_modules"), join(wt, "node_modules"));
  put(join(wt, "package.json"), JSON.stringify({ type: "module", scripts: { "lint-plan:fast": "node scripts/lint.mjs --base origin/main" } }));
  put(join(wt, "src/lib/policy.ts"), "export const fixture = true;\n");
  put(join(wt, "reader-input.txt"), "healthy");
  put(join(wt, "test/setup/tmp-hygiene.ts"), "export {};\n");
  put(join(wt, READER), `import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('fixture reader', () => assert.equal(readFileSync('reader-input.txt', 'utf8'), 'healthy'));\n`);
  // The always-on skill census joins every nonempty diff, so the tree carries a healthy stand-in for it.
  put(join(wt, "test/rules/every-applies-to-skill-is-selectable-and-bounded.test.ts"),
    "import { test } from 'node:test';\ntest('skill census stand-in', () => undefined);\n");
  put(join(wt, "scripts/generate-capability-snapshot.mjs"), "process.exit(0);\n");
  put(join(wt, "scripts/lint.mjs"), "console.log('fixture lint clean');\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: fixture check programs");
  git("-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "HEAD:main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  put(join(wt, "src/lib/policy.ts"), "export const fixture = false;\n");
  if (reader === "unhealthy") put(join(wt, "reader-input.txt"), "unhealthy");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: fixture inputs");
  const runs = () => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[] }) : [];
  // The sandboxed census children that ran the reader (the runner's `-e ""` startup probes excluded).
  const readerRuns = () => runs().filter((r) => r.argv.includes("--test") && r.argv.includes(READER));
  return { wt, remote, branch, runs, readerRuns, head: git("rev-parse", "HEAD") };
}

async function runPush(f: ReturnType<typeof fixture>) {
  const vars = { RMD_HARNESS_HOOKS_DIR: join(dirname(f.wt), "harness", "hooks"), RMD_PREPUSH_GATES: "1" };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const writes = { stdout: process.stdout.write, stderr: process.stderr.write };
  let output = "";
  Object.assign(process.env, vars);
  const capture = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  let error: unknown;
  try {
    await withLiveWritesAllowed(() => push.gitPushRunBranch(f.wt));
  } catch (cause) {
    error = cause;
  } finally {
    process.stdout.write = writes.stdout;
    process.stderr.write = writes.stderr;
    for (const [k, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[k]; else process.env[k] = value;
    }
  }
  return { output, error };
}

describe("test/github/a-managed-worktree-push-measures-its-reader-suites.test.ts", () => {
  test("W1-T11285 criterion 2: the managed-worktree runSuites hands a reader-policy suite to the sandboxed child", async () => {
    const f = fixture();
    const result = await runPush(f);
    assert.equal(result.error, undefined, result.output);
    assert.equal(f.remote.git("rev-parse", `refs/heads/${f.branch}`), f.head);
    assert.doesNotMatch(result.output, /source-reader runtime calibration is unavailable/);
    // Calibration, then qualification: each one sandboxed run of the reader alone, rooted at the pushed tree.
    const runs = f.readerRuns();
    assert.equal(runs.length, 2, result.output);
    for (const { argv } of runs) {
      assert.ok(argv.some((a, i) => a === "--ro-bind" && argv[i + 1] === f.wt), "the pushed tree is bound read-only");
      assert.equal(argv[argv.indexOf("--chdir") + 1], f.wt);
    }
    assert.match(result.output, /census-reader-calibration: \{"file":"test\/fixture-reader\.test\.ts"/);
    assert.match(result.output, /census-reader-runtime: \{"file":"test\/fixture-reader\.test\.ts"/);
    assert.doesNotMatch(result.output, /census suites NOT MEASURED/);
  });

  test("a reader that fails inside the sandbox reaches census-precheck's verdict and blocks the push", async () => {
    const f = fixture({ reader: "unhealthy" });
    const result = await runPush(f);
    assert.ok(result.error instanceof push.PushFailedError, result.output);
    assert.match(result.output, /census-suite: test\/fixture-reader\.test\.ts fails/);
    assert.throws(() => f.remote.git("rev-parse", "--verify", `refs/heads/${f.branch}`));
    // The head's failed calibration returns at once; the merge base then calibrates and qualifies, both sandboxed.
    const roots = f.readerRuns().map(({ argv }) => argv[argv.indexOf("--chdir") + 1]);
    assert.equal(roots.length, 3, result.output);
    assert.equal(roots[0], f.wt);
    assert.notEqual(roots[1], f.wt, "the base run has its own sandbox root");
    assert.equal(roots[2], roots[1]);
  });

  test("a reader suite whose sandbox cannot start still reads skipped, NOT passed (CI runs it)", async () => {
    const f = fixture({ sandbox: "unavailable" });
    const result = await runPush(f);
    assert.equal(result.error, undefined, result.output);
    assert.equal(f.remote.git("rev-parse", `refs/heads/${f.branch}`), f.head);
    assert.deepEqual(f.runs(), []);
    assert.match(result.output, /pre-push: census-precheck — [^\n]*fixture: user namespaces unavailable[^\n]*: skipped, NOT passed \(CI runs it\)/);
    assert.match(result.output, /census-precheck: census suites NOT MEASURED - [^\n]*test\/fixture-reader\.test\.ts: proof sandbox could not start/);
    assert.doesNotMatch(result.output, /source-reader runtime calibration is unavailable/);
  });
});
