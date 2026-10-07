/**
 * W1-T6138 — THE PRE-PUSH GATE RUNS THE BRANCH'S OWN CHECKS IN THE PROOF SANDBOX.
 *
 * W1-T6120 made the harness's gate skip three checks on the host path, because each runs the pushed tree's own code:
 * census-precheck's census suites, ci-control-plane-precheck's capability-snapshot generator, and lint-plan-precheck's
 * package.json lint argv. They now run inside W1-T6124's proof sandbox. A fixture harness carries the REAL hook, the
 * REAL src/ (the sandbox runner) and loader, and stand-ins that re-export the real check modules; a fixture tree's
 * census suite, generator and lint each record their env, HOME and whether they can read a planted daemon secret.
 *
 * The runner is reached through PATH, which the gate's env allowlist carries: a fixture `bwrap` that records its argv
 * and env and runs the child stands in for the real one on any OS; a failing one forces the degraded path; and where a
 * real bwrap starts (the daemon's Linux container), the last case runs under it. FIXTURES ONLY, under this suite's tmp.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as gitPush from "../src/lib/git-push.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { worktreeAdd } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const { gitPushRunBranch, gitPushRunBranchAsync, PushFailedError, prePushGateSandbox, treeImportArgs } = gitPush;
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const DAEMON_CREDENTIALS = {
  GH_TOKEN: "fixture-gh-token",
  GITHUB_TOKEN: "fixture-github-token",
  GH_APP_ID: "4242",
  ANTHROPIC_API_KEY: "fixture-provider-key",
};
const CREDENTIAL_NAME = /^(?:GH_|GITHUB_)|TOKEN|API_KEY|PRIVATE_KEY/;

let root: string;
let harness: string;
let secret: string;
let runnerLog: string;
let recordingBin: string;
let refusingBin: string;
const saved: Record<string, string | undefined> = {};
let counter = 0;

function raw(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_V8_COVERAGE: "" },
  });
}

function put(path: string, body: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mode !== undefined) chmodSync(path, mode);
}

/** The fixture harness root: the real hook, src/ and loader; stand-ins for the checks this suite does not judge. */
function buildHarness(): void {
  put(join(harness, "hooks", "pre-push"), readFileSync(join(REPO, "hooks", "pre-push"), "utf8"), 0o755);
  symlinkSync(join(REPO, "node_modules"), join(harness, "node_modules"));
  symlinkSync(join(REPO, "src"), join(harness, "src"));
  copyFileSync(join(REPO, "tsconfig.json"), join(harness, "tsconfig.json"));
  const s = (name: string, body: string) => put(join(harness, "scripts", `${name}.mjs`), body);
  const real = (name: string) => JSON.stringify(pathToFileURL(join(REPO, "scripts", `${name}.mjs`)).href);
  s("lib/git", `import { spawnSync } from "node:child_process";\n` +
    `export function gitOrThrow(args) { const r = spawnSync("git", args, { encoding: "utf8" });\n` +
    `  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr); return r.stdout; }\n`);
  for (const name of ["rule15-precheck", "rule25-precheck", "test-tier-manifest", "worker-branch-shape", "head-identity-gate"]) {
    s(name, "export const evaluateHeadIdentityGate = () => ({ ok: true });\n");
  }
  s("ci-control-plane-precheck", `export { affectedCapabilitySnapshot, runCiControlPlanePrecheck } from ${real("ci-control-plane-precheck")};\n`);
  s("lint-plan-precheck", `export { runLintPlanPrecheck } from ${real("lint-plan-precheck")};\n`);
  // The real suite runner and verdict; only the counts (which judge this repo's own layout) are left out.
  s("census-precheck", `import { evaluateAdmittedCensusSuites } from ${real("census-precheck")};\n` +
    `export { runCensusSuitesViaChild } from ${real("census-precheck")};\n` +
    `export const listAdmittedCensusMembers = () => [{ testFile: "test/census.test.ts", script: "census:fixture", walks: ["src/"] }];\n` +
    `export function main(argv, { admitted, runSuites }) {\n` +
    `  const r = evaluateAdmittedCensusSuites({ changed: ["src/feature.ts"], loadMembers: admitted,\n` +
    `    runSuites: (files) => runSuites({ root: process.cwd(), files }) });\n` +
    `  if (r.violations.length > 0) { console.error("census-precheck: this branch grows 1 census count(s) CI will refuse:");\n` +
    `    for (const v of r.violations) console.error("  " + v); return 1; }\n` +
    `  if (r.unmeasured !== null) { console.error("census-precheck: census suites NOT MEASURED - " + r.unmeasured); return 2; }\n` +
    `  return 0; }\n`);
}

/** A tree file recording, into the tree, the env it saw, its HOME, and whether the daemon's secret is readable. */
function probe(name: string): string {
  return `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";\n` +
    `let canReadSecret = true; try { readFileSync(${JSON.stringify(secret)}); } catch { canReadSecret = false; }\n` +
    `mkdirSync(".probe", { recursive: true });\n` +
    `writeFileSync(".probe/${name}.json", JSON.stringify({ env: process.env, home: process.env.HOME, canReadSecret }));\n`;
}

interface Lane { wt: string; branch: string; remote: string }

/** A seeded origin and a run worktree cut from it by the real `worktreeAdd`, whose head edits a path the census table
 *  walks, a capability-snapshot input and a plan shard, so each of the three checks has its tree-owned half to run. */
function cutLane(edits: { censusFails?: boolean; snapshotStale?: boolean; lintRefuses?: boolean } = {}): Lane {
  const n = ++counter;
  const remote = gitRepo({ bare: true, kind: `t6138-remote-${n}` }).dir;
  const seed = gitRepo({ kind: `t6138-seed-${n}` });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  put(join(seed.dir, ".gitignore"), "node_modules\n.probe/\n");
  put(join(seed.dir, "package.json"), JSON.stringify({ type: "module", scripts: { "lint-plan:fast": "node --import tsx scripts/lint-plan-offline.mjs --base origin/main" } }));
  put(join(seed.dir, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
  put(join(seed.dir, "test", "census.test.ts"), `import { existsSync } from "node:fs";\nimport { test } from "node:test";\n` +
    `${probe("census")}test("the fixture census", () => { if (existsSync("census.fail")) throw new Error("this branch grows the count"); });\n`);
  put(join(seed.dir, "scripts", "generate-capability-snapshot.mjs"), `import { existsSync } from "node:fs";\n${probe("snapshot")}` +
    `if (existsSync("capability.stale")) { console.error("snapshot differs"); process.exit(1); }\n`);
  put(join(seed.dir, "scripts", "lint-plan-offline.mjs"), `import { existsSync } from "node:fs";\n${probe("lint")}` +
    `if (existsSync("plan/bad.yaml")) { console.log("✗ plan/bad.yaml\\n    [sizing] the fixture shard is too big"); process.exit(1); }\n`);
  put(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", remote);
  seed.git("push", "-q", "origin", "main");
  const wt = join(root, `t6138-wt-${n}`);
  const branch = `run-T6138-${n}-1`;
  worktreeAdd(seed.dir, wt, branch, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  // worktreeAdd links the seed's node_modules when it has one; this seed has none, so link the real install.
  if (!existsSync(join(wt, "node_modules"))) symlinkSync(join(REPO, "node_modules"), join(wt, "node_modules"));
  raw(wt, "config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  raw(wt, "config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  put(join(wt, "src", "feature.ts"), "export const x = 1;\n");
  put(join(wt, "MASTER-PLAN.md"), "a capability-snapshot input\n");
  put(join(wt, "plan", "tasks.yaml"), "- id: fixture\n");
  if (edits.censusFails) put(join(wt, "census.fail"), "x\n");
  if (edits.snapshotStale) put(join(wt, "capability.stale"), "x\n");
  if (edits.lintRefuses) put(join(wt, "plan", "bad.yaml"), "x\n");
  raw(wt, "add", "-A");
  raw(wt, "commit", "-q", "-m", "feat: the worker's edit");
  return { wt, branch, remote };
}

type Probe = { env: Record<string, string>; home: string; canReadSecret: boolean };
const probed = (lane: Lane, name: string): Probe | undefined =>
  existsSync(join(lane.wt, ".probe", `${name}.json`)) ? (JSON.parse(readFileSync(join(lane.wt, ".probe", `${name}.json`), "utf8")) as Probe) : undefined;

type RunnerCall = { argv: string[]; env: Record<string, string> };
function runnerCalls(): RunnerCall[] {
  return existsSync(runnerLog) ? readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunnerCall) : [];
}

async function capturingStderr(push: () => unknown): Promise<string> {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => (chunks.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    await push();
  } finally {
    process.stderr.write = write;
  }
  return chunks.join("");
}

/** Runs `body` with `bin` first on PATH, so the gate's `bwrap` is that fixture runner. */
async function withRunner<T>(bin: string | undefined, body: () => Promise<T>): Promise<T> {
  const path = process.env.PATH;
  if (bin !== undefined) process.env.PATH = `${bin}:${path}`;
  try {
    return await body();
  } finally {
    process.env.PATH = path;
  }
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

function assertSandboxedCleanly(lane: Lane, name: string, p: Probe | undefined): void {
  assert.ok(p, `the tree's ${name} ran`);
  assert.deepEqual(Object.keys(p.env).filter((k) => CREDENTIAL_NAME.test(k)), [], `${name} saw no credential variable`);
  assert.match(p.home, /prepush-sandbox-home-/, `${name} ran with the sandbox's throwaway HOME`);
  assert.notEqual(p.home, process.env.HOME);
  assert.equal(existsSync(p.home), false, `${name}'s throwaway HOME is removed after the gate`);
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6138-`)));
  harness = join(root, "harness");
  secret = join(root, "daemon-home", "app-key.pem");
  put(secret, "fixture daemon secret\n");
  runnerLog = join(root, "runner.log");
  recordingBin = join(root, "recording-bin");
  refusingBin = join(root, "refusing-bin");
  put(join(recordingBin, "bwrap"), `#!/usr/bin/env node\nconst { appendFileSync } = require("node:fs");\n` +
    `const { spawnSync } = require("node:child_process");\nconst argv = process.argv.slice(2);\n` +
    `appendFileSync(${JSON.stringify(runnerLog)}, JSON.stringify({ argv, env: process.env }) + "\\n");\n` +
    `const rest = argv.slice(argv.indexOf("--") + 1);\n` +
    `const r = spawnSync(rest[0], rest.slice(1), { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n`, 0o755);
  put(join(refusingBin, "bwrap"), "#!/bin/sh\necho 'bwrap: No permissions to create new namespace' >&2\nexit 1\n", 0o755);
  buildHarness();
  for (const [k, v] of Object.entries({ ...DAEMON_CREDENTIALS, GH_APP_PRIVATE_KEY_PATH: secret, RMD_HARNESS_HOOKS_DIR: join(harness, "hooks") })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.RMD_PREPUSH_GATES;
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("W1-T6138: the pre-push gate runs the branch's own checks in the proof sandbox", () => {
  it("on the host path the census suite, the capability generator and the lint argv each run through the sandbox runner, with the proof sandbox's argv, no credential and a throwaway HOME", async () => {
    const lane = cutLane();
    rmSync(runnerLog, { force: true });
    await withRunner(recordingBin, () => withLiveWritesAllowed(() => gitPushRunBranchAsync(lane.wt, { stdio: "ignore" })));
    assert.equal(raw(lane.remote, "rev-parse", `refs/heads/${lane.branch}`).trim(), raw(lane.wt, "rev-parse", "HEAD").trim(), "the push landed");
    for (const name of ["census", "snapshot", "lint"]) assertSandboxedCleanly(lane, name, probed(lane, name));
    const calls = runnerCalls();
    const ran = (needle: string) => calls.filter((c) => c.argv.some((a) => a.includes(needle)));
    assert.equal(ran("test/census.test.ts").length, 1, "one sandboxed census child");
    assert.equal(ran("scripts/generate-capability-snapshot.mjs").length, 1, "one sandboxed generator");
    assert.equal(ran("scripts/lint-plan-offline.mjs").length, 1, "one sandboxed lint");
    const census = ran("test/census.test.ts")[0]!.argv;
    assert.ok(census.includes("./test/setup/tmp-hygiene.ts"), "the census child loads the TREE's setup file, not the gate's");
    for (const call of calls) {
      for (const flag of ["--unshare-user", "--unshare-net", "--unshare-pid", "--die-with-parent"]) assert.ok(call.argv.includes(flag), flag);
      const binds = call.argv.flatMap((a, i) => (a === "--bind" || a === "--ro-bind" ? [call.argv[i + 1]!] : []));
      assert.ok(binds.includes(realpathSync(lane.wt)), "the tree is bound");
      for (const b of binds) {
        assert.equal(within(secret, b), false, `no bind (${b}) exposes the daemon secret`);
        assert.equal(within(String(process.env.HOME), b), false, `no bind (${b}) exposes the daemon HOME`);
      }
      assert.deepEqual(Object.keys(call.env).filter((k) => CREDENTIAL_NAME.test(k)), [], "the runner's env carries no credential");
      assert.equal(call.env.NODE_V8_COVERAGE, "", "coverage is blanked for the sandboxed child");
    }
  });

  it("a census suite that fails in the sandbox now BLOCKS the push, in the shape the daemon classifies, sync and async", async () => {
    for (const push of [(wt: string) => gitPushRunBranch(wt, { stdio: "ignore" }), (wt: string) => gitPushRunBranchAsync(wt, { stdio: "ignore" })]) {
      const lane = cutLane({ censusFails: true });
      await withRunner(recordingBin, () => assert.rejects(async () => withLiveWritesAllowed(() => push(lane.wt)), (e: unknown) =>
        e instanceof PushFailedError && /^Command failed: git -C \S+ push /m.test(e.message) &&
        /^ {2}census-suite: test\/census\.test\.ts fails — run npm run census:fixture/m.test(e.message)));
      assert.throws(() => raw(lane.remote, "rev-parse", "--verify", `refs/heads/${lane.branch}`), "nothing was pushed");
      assertSandboxedCleanly(lane, "census", probed(lane, "census"));
    }
  });

  it("a stale capability snapshot and a refusing plan lint, each run in the sandbox, block the push", async () => {
    const stale = cutLane({ snapshotStale: true });
    await withRunner(recordingBin, () => assert.rejects(async () => withLiveWritesAllowed(() => gitPushRunBranch(stale.wt, { stdio: "ignore" })),
      (e: unknown) => e instanceof PushFailedError && /capability snapshot is stale/.test(e.message)));
    const lint = cutLane({ lintRefuses: true });
    await withRunner(recordingBin, () => assert.rejects(async () => withLiveWritesAllowed(() => gitPushRunBranch(lint.wt, { stdio: "ignore" })),
      (e: unknown) => e instanceof PushFailedError && /lint-plan-precheck: the plan lint CI runs on this diff REFUSES it \[sizing\]/.test(e.message)));
    assertSandboxedCleanly(lint, "lint", probed(lint, "lint"));
  });

  it("with the sandbox unable to start, each of the three reports skipped by name, runs nothing of the tree's, and does not block", async () => {
    const lane = cutLane({ censusFails: true, snapshotStale: true, lintRefuses: true });
    const stderr = await withRunner(refusingBin, () => capturingStderr(() => withLiveWritesAllowed(() => gitPushRunBranch(lane.wt))));
    assert.equal(raw(lane.remote, "rev-parse", `refs/heads/${lane.branch}`).trim(), raw(lane.wt, "rev-parse", "HEAD").trim(), "a skip is not a refusal");
    assert.equal(existsSync(join(lane.wt, ".probe")), false, "no tree code ran, sandboxed or not");
    const why = /the proof sandbox cannot start on this \w+ host \(bwrap: No permissions to create new namespace\)/.source;
    assert.match(stderr, new RegExp(`census suites NOT MEASURED - .*host gate runs no worktree code outside the proof sandbox \\(${why}\\)`));
    assert.match(stderr, new RegExp(`ci-control-plane-precheck — this diff moves a capability-snapshot input.*\\(${why}\\): skipped, NOT passed`));
    assert.match(stderr, new RegExp(`lint-plan-precheck runs the branch's own package\\.json lint argv.*\\(${why}\\): skipped, NOT passed`));
  });

  it("where no bwrap is installed (this macOS host), the gate degrades to the named skip", async (t) => {
    const lane = cutLane({ censusFails: true });
    const box = prePushGateSandbox(lane.wt);
    if (box.mode === "sandboxed") {
      t.skip("bwrap starts on this host; the degraded path is the refusing-runner case above");
      return;
    }
    if (process.platform === "darwin") assert.match(box.reason, /bwrap is not installed/);
    const stderr = await capturingStderr(() => withLiveWritesAllowed(() => gitPushRunBranch(lane.wt)));
    assert.equal(existsSync(join(lane.wt, ".probe")), false, "nothing of the tree's ran");
    assert.match(stderr, /lint-plan-precheck runs the branch's own package\.json lint argv.*\(the proof sandbox cannot start.*\): skipped, NOT passed/);
  });

  it("on Linux with a working bwrap, the tree's checks run with no credential, a throwaway HOME, and cannot read the daemon's secret", async (t) => {
    const probeLane = cutLane();
    const box = prePushGateSandbox(probeLane.wt);
    if (box.mode !== "sandboxed") {
      t.skip(`bwrap sandbox unavailable here: ${box.reason}`);
      return;
    }
    await withLiveWritesAllowed(() => gitPushRunBranchAsync(probeLane.wt, { stdio: "ignore" }));
    for (const name of ["census", "snapshot", "lint"]) {
      const p = probed(probeLane, name);
      assertSandboxedCleanly(probeLane, name, p);
      assert.equal(p!.canReadSecret, false, `${name} cannot read the daemon secret`);
    }
    const failing = cutLane({ censusFails: true });
    await assert.rejects(async () => withLiveWritesAllowed(() => gitPushRunBranch(failing.wt, { stdio: "ignore" })),
      (e: unknown) => e instanceof PushFailedError && /census-suite: test\/census\.test\.ts fails/.test(e.message));
  });
});

describe("W1-T6138: the gate sandbox runner, in process", () => {
  it("names why it cannot start: no binary, a refusing binary, a silent one, and an argv it cannot build", () => {
    const tree = mkdtempSync(join(root, "unit-"));
    const enoent = (() => ({ error: Object.assign(new Error("spawn bwrap ENOENT"), { code: "ENOENT" }), status: null })) as unknown as typeof spawnSync;
    assert.match((prePushGateSandbox(tree, {}, enoent) as { reason: string }).reason, /\(bwrap is not installed\)$/);
    const refuses = (() => ({ status: 1, stderr: "bwrap: setting up uid map: Permission denied\nmore\n" })) as unknown as typeof spawnSync;
    assert.match((prePushGateSandbox(tree, {}, refuses) as { reason: string }).reason, /\(bwrap: setting up uid map: Permission denied\)$/);
    const silent = (() => ({ status: 1, stderr: "" })) as unknown as typeof spawnSync;
    assert.match((prePushGateSandbox(tree, {}, silent) as { reason: string }).reason, /\(exit 1\)$/);
    assert.match((prePushGateSandbox("/", {}) as { reason: string }).reason, /argv could not be built \(.*refusing \/ as a writable sandbox bind/);
  });

  it("a started sandbox runs each child as bwrap, the sandbox argv, then the child, in the tree with the filtered env", () => {
    const tree = mkdtempSync(join(root, "unit-"));
    const calls: { file: string; args: string[]; opts: { cwd?: string; env?: NodeJS.ProcessEnv } }[] = [];
    const exec = ((file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      calls.push({ file, args, opts });
      return { status: 0, stdout: "", stderr: "" };
    }) as unknown as typeof spawnSync;
    const box = prePushGateSandbox(tree, { PATH: "/bin", GH_TOKEN: "x" }, exec);
    assert.equal(box.mode, "sandboxed");
    if (box.mode === "sandboxed") box.run("node", ["child.mjs"], { cwd: "/elsewhere" });
    const child = calls[1]!;
    assert.equal(child.file, "bwrap");
    assert.deepEqual(child.args.slice(child.args.indexOf("--") + 1), ["node", "child.mjs"]);
    assert.equal(child.opts.cwd, tree, "a caller's cwd cannot move the child out of the tree");
    assert.equal(child.opts.env?.GH_TOKEN, undefined);
    assert.equal(child.opts.env?.PATH, "/bin");
  });

  it("rebases a census child's gate-owned --import values onto the tree's own files, and leaves every other argument alone", () => {
    const tree = mkdtempSync(join(root, "unit-"));
    put(join(tree, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
    put(join(tree, "node_modules", "tsx", "dist", "loader.mjs"), "export {};\n");
    const args = [
      "--test", "--import", pathToFileURL("/gate/root/node_modules/tsx/dist/loader.mjs").href,
      "--import", "/gate/root/test/setup/tmp-hygiene.ts", "--import", "/gate/root/absent.mjs", "--import", "tsx", "/gate/root/test/x.ts",
    ];
    assert.deepEqual(treeImportArgs(args, tree), [
      "--test", "--import", "./node_modules/tsx/dist/loader.mjs",
      "--import", "./test/setup/tmp-hygiene.ts", "--import", "/gate/root/absent.mjs", "--import", "tsx", "/gate/root/test/x.ts",
    ]);
  });
});
