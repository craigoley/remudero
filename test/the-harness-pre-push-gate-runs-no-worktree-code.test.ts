/**
 * W1-T6120 — THE HARNESS PRE-PUSH GATE RUNS NO WORKTREE CODE.
 *
 * W1-T6106 made the push leaf run the HARNESS's hooks/pre-push instead of the worktree's, but with the
 * worktree as cwd and the daemon's whole env, so every relative `scripts/<check>.mjs` (and `--import tsx`)
 * still ran the file the worker wrote, as the daemon, holding GH_TOKEN. Here the real hooks/pre-push is
 * copied into a fixture harness root whose scripts/ are recording stand-ins, and pushed through the leaf
 * from a fixture worktree whose own scripts/, loader, census suite and lint argv each leave a marker.
 *
 * FIXTURES ONLY: every hostile file writes a marker under this suite's own mkdtemp root, in repositories
 * that root holds. The control proves each marker route is LIVE first: the same hook, run as the tree's
 * OWN hook by a raw `git push`, does run the tree's scripts.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as gitPush from "../src/lib/git-push.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { worktreeAdd } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const { gitPushRunBranch, gitPushRunBranchAsync, PushFailedError } = gitPush;
const REPO_HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "pre-push");

/** Planted for the push: the gate must carry none of them into anything it starts. */
const DAEMON_CREDENTIALS = {
  GH_TOKEN: "fixture-gh-token",
  GITHUB_TOKEN: "fixture-github-token",
  GH_APP_ID: "4242",
  GH_APP_PRIVATE_KEY_PATH: "/nonexistent/fixture-app-key.pem",
  ANTHROPIC_API_KEY: "fixture-provider-key",
};
const CREDENTIAL_NAME = /^(?:GH_|GITHUB_)|TOKEN|API_KEY|PRIVATE_KEY/;

/** Every check the hook names; the harness root lacks proof-resolve-precheck on purpose. */
const TREE_SCRIPTS = [
  "rule15-precheck", "rule25-precheck", "ci-control-plane-precheck", "test-tier-manifest", "census-precheck",
  "lint-plan-precheck", "lint-plan-offline", "head-identity-gate", "worker-branch-shape", "proof-resolve-precheck", "lib/git",
];

let root: string;
let harness: string;
let gateLog: string;
const saved: Record<string, string | undefined> = {};
let counter = 0;

function raw(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_V8_COVERAGE: "" },
  });
}

function put(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** A worktree file that, if anything runs it, leaves `<markers>/<name>` holding the env names it saw. */
function hostile(markers: string, name: string): string {
  return `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(join(markers, name))}, JSON.stringify(Object.keys(process.env)));\n`;
}

/** The fixture harness root: the REAL hooks/pre-push, stand-in checks that record where and how they ran. */
function buildHarness(): void {
  copyFileSync(REPO_HOOK, join(harness, "hooks", "pre-push"));
  chmodSync(join(harness, "hooks", "pre-push"), 0o755);
  put(join(harness, "node_modules", "tsx", "dist", "loader.mjs"), "export {};\n");
  const s = (name: string, body: string) => put(join(harness, "scripts", `${name}.mjs`), body);
  s("lib/record", `import { appendFileSync } from "node:fs";\n` +
    `export const record = (check, extra = {}) => appendFileSync(${JSON.stringify(gateLog)}, JSON.stringify({ check, cwd: process.cwd(),\n` +
    `  home: process.env.HOME, env: Object.keys(process.env), ...extra }) + "\\n");\n`);
  s("lib/git", `import { spawnSync } from "node:child_process";\n` +
    `export function gitOrThrow(args) { const r = spawnSync("git", args, { encoding: "utf8" });\n` +
    `  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr); return r.stdout; }\n`);
  s("rule15-precheck", `import { existsSync } from "node:fs";\nimport { record } from "./lib/record.mjs";\nrecord("rule15-precheck");\n` +
    `if (existsSync("refuse.rule15")) { console.error("rule15-precheck: a plan record rides with code"); process.exit(1); }\n`);
  for (const name of ["rule25-precheck", "test-tier-manifest", "head-identity-gate", "worker-branch-shape", "lint-plan-precheck"]) {
    s(name, `import { record } from "./lib/record.mjs";\nrecord(${JSON.stringify(name)});\n` +
      "export const evaluateHeadIdentityGate = () => ({ ok: true });\n");
  }
  s("ci-control-plane-precheck", `import { record } from "./lib/record.mjs";\n` +
    `export const affectedCapabilitySnapshot = (files) => files.includes("capability.input");\n` +
    `export function runCiControlPlanePrecheck({ readChangedFiles }) {\n` +
    `  record("ci-control-plane-precheck", { files: readChangedFiles("origin/main") }); return 0; }\n`);
  s("census-precheck", `import { record } from "./lib/record.mjs";\n` +
    `export function listAdmittedCensusMembers(root) {\n` +
    `  record("census-table", { root }); return [{ testFile: "test/census.test.ts", script: "census:x", walks: ["src/"] }]; }\n` +
    `export function main(argv, { admitted, runSuites }) {\n` +
    `  const members = admitted(); let refused = null;\n` +
    `  try { runSuites({ root: ".", files: members.map((m) => m.testFile) }); } catch (e) { refused = e.message; }\n` +
    `  record("census-precheck", { argv, refused });\n` +
    `  if (refused) { console.error("census-precheck: census suites NOT MEASURED - " + refused); return 2; }\n` +
    `  return 0; }\n`);
}

/** A seeded origin + checkout whose tree carries a hostile copy of every gate script, the loader, a census
 *  suite and a lint argv, and a run worktree cut from it by the real `worktreeAdd` (`core.hooksPath=hooks`). */
function cutLane(): { wt: string; branch: string; remote: string; markers: string } {
  const n = ++counter;
  const markers = join(root, `markers-${n}`);
  mkdirSync(markers);
  const remote = gitRepo({ bare: true, kind: `t6120-remote-${n}` }).dir;
  const seed = gitRepo({ kind: `t6120-seed-${n}` });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  for (const name of TREE_SCRIPTS) put(join(seed.dir, "scripts", `${name}.mjs`), hostile(markers, `tree-${name.replace("/", "-")}`));
  put(join(seed.dir, "node_modules", "tsx", "dist", "loader.mjs"), hostile(markers, "tree-tsx-loader"));
  put(join(seed.dir, "node_modules", "tsx", "package.json"), JSON.stringify({ name: "tsx", type: "module", exports: { ".": "./dist/loader.mjs" } }));
  put(join(seed.dir, "test", "census.test.ts"), hostile(markers, "tree-census-suite"));
  put(join(seed.dir, "package.json"), JSON.stringify({ scripts: { "lint-plan:fast": "node scripts/lint-plan-offline.mjs --base origin/main" } }));
  mkdirSync(join(seed.dir, "hooks"));
  copyFileSync(REPO_HOOK, join(seed.dir, "hooks", "pre-push"));
  chmodSync(join(seed.dir, "hooks", "pre-push"), 0o755);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", remote);
  seed.git("push", "-q", "origin", "main");
  const wt = join(root, `t6120-wt-${n}`);
  const branch = `run-T6120-${n}-1`;
  worktreeAdd(seed.dir, wt, branch, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  raw(wt, "config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  raw(wt, "config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  // The worker's edit: a path the census table walks, so the gate reaches the census-suite arm.
  put(join(wt, "src", "feature.ts"), "export const x = 1;\n");
  raw(wt, "add", "src/feature.ts");
  raw(wt, "commit", "-q", "-m", "feat: the worker's edit");
  return { wt, branch, remote, markers };
}

type Run = { check: string; cwd: string; home: string; env: string[]; files?: string[]; root?: string; refused?: string | null };
function gateRuns(): Run[] {
  return existsSync(gateLog) ? readFileSync(gateLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run) : [];
}

/** Runs `push` with process.stderr captured; returns what the gate wrote through. */
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

before(() => {
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6120-`));
  harness = join(root, "harness");
  gateLog = join(root, "gate.log");
  mkdirSync(join(harness, "hooks"), { recursive: true });
  buildHarness();
  for (const [k, v] of Object.entries({ ...DAEMON_CREDENTIALS, RMD_HARNESS_HOOKS_DIR: join(harness, "hooks") })) {
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

describe("W1-T6120: the harness pre-push gate runs no worktree code", () => {
  it("the control: the same hook run as the TREE's own hook by a raw push does run the tree's scripts", () => {
    const { wt, markers } = cutLane();
    raw(wt, "push", "-q", "origin", "HEAD");
    for (const name of ["tree-rule15-precheck", "tree-census-precheck", "tree-tsx-loader"]) {
      assert.ok(existsSync(join(markers, name)), `control: the tree's own hook ran ${name}`);
    }
    assert.ok(JSON.parse(readFileSync(join(markers, "tree-rule15-precheck"), "utf8")).includes("GH_TOKEN"), "control: the env route is live");
  });

  it("a host push through the push leaf runs the harness copies of the gate checks, neither marker is written, the gate's child environment carries no GH_TOKEN, and a check the harness cannot run reports skipped", async () => {
    const { wt, branch, remote, markers } = cutLane();
    rmSync(gateLog, { force: true });
    const stderr = await capturingStderr(() => withLiveWritesAllowed(() => gitPushRunBranch(wt)));
    assert.equal(raw(remote, "rev-parse", `refs/heads/${branch}`).trim(), raw(wt, "rev-parse", "HEAD").trim(), "the push landed");

    assert.deepEqual(readdirSync(markers), [], "no worktree script, loader, census suite or lint argv ran");
    const runs = gateRuns();
    const ran = new Set(runs.map((r) => r.check));
    for (const check of ["rule15-precheck", "rule25-precheck", "ci-control-plane-precheck", "test-tier-manifest", "census-table", "census-precheck", "worker-branch-shape", "head-identity-gate"]) {
      assert.ok(ran.has(check), `the harness copy of ${check} ran`);
    }
    assert.equal(ran.has("lint-plan-precheck"), false, "the lint argv check, which runs the tree's own code, is not run by the host gate");
    for (const run of runs) {
      assert.equal(realpathSync(run.cwd), realpathSync(wt), `${run.check} judged the worktree as its data root`);
      assert.deepEqual(run.env.filter((k) => CREDENTIAL_NAME.test(k)), [], `${run.check} saw no credential variable`);
      assert.notEqual(run.home, process.env.HOME, `${run.check} ran with a throwaway HOME`);
      assert.equal(existsSync(run.home), false, "the throwaway HOME is removed after the gate");
    }
    const census = runs.find((r) => r.check === "census-precheck");
    assert.match(String(census?.refused), /host gate runs no worktree code/, "a census suite to run is refused, not run");
    assert.equal(realpathSync(String(runs.find((r) => r.check === "census-table")?.root)), realpathSync(harness), "the admission table is the gate root's");
    assert.deepEqual(runs.find((r) => r.check === "ci-control-plane-precheck")?.files, ["src/feature.ts"]);

    assert.match(stderr, /proof-resolve-precheck\.mjs absent — skipped, NOT passed/, "an absent harness check is skipped by name");
    assert.match(stderr, /lint-plan-precheck runs the branch's own package\.json lint argv.*skipped, NOT passed/);
    assert.match(stderr, /census-precheck: census suites NOT MEASURED/);
  });

  it("off the event loop the same holds, and a capability-snapshot diff skips the control-plane check by name", async () => {
    const { wt, markers } = cutLane();
    put(join(wt, "capability.input"), "c\n");
    raw(wt, "add", "capability.input");
    raw(wt, "commit", "-q", "-m", "feat: a capability input");
    rmSync(gateLog, { force: true });
    const stderr = await capturingStderr(() => withLiveWritesAllowed(() => gitPushRunBranchAsync(wt)));
    assert.deepEqual(readdirSync(markers), [], "no worktree code ran");
    const runs = gateRuns();
    assert.ok(runs.some((r) => r.check === "rule15-precheck"), "the harness copy ran");
    assert.equal(runs.some((r) => r.check === "ci-control-plane-precheck"), false, "the control-plane check did not run");
    for (const run of runs) assert.deepEqual(run.env.filter((k) => CREDENTIAL_NAME.test(k)), [], `${run.check} saw no credential`);
    assert.match(stderr, /ci-control-plane-precheck — this diff moves a capability-snapshot input.*skipped, NOT passed/);
  });

  it("the gate still refuses a genuinely failing check, in the shape the daemon classifies, and nothing lands", async () => {
    for (const push of [(wt: string) => gitPushRunBranch(wt, { stdio: "ignore" }), (wt: string) => gitPushRunBranchAsync(wt, { stdio: "ignore" })]) {
      const { wt, branch, remote, markers } = cutLane();
      put(join(wt, "refuse.rule15"), "x\n");
      raw(wt, "add", "refuse.rule15");
      raw(wt, "commit", "-q", "-m", "feat: refused");
      await assert.rejects(async () => withLiveWritesAllowed(() => push(wt)), (e: unknown) =>
        e instanceof PushFailedError && /^Command failed: git -C \S+ push /m.test(e.message) && /^rule15-precheck: a plan record rides with code/m.test(e.message));
      assert.throws(() => raw(remote, "rev-parse", "--verify", `refs/heads/${branch}`), "nothing was pushed");
      assert.deepEqual(readdirSync(markers), [], "the refusal ran no worktree code either");
    }
  });

  it("the gate env is an allowlist: the switch and PATH cross, no credential does, and git carries the host overrides", () => {
    const env = gitPush.prePushGateEnv({ PATH: "/bin", RMD_PREPUSH_GATES: "0", ...DAEMON_CREDENTIALS, NODE_OPTIONS: "--require /x.js" });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.RMD_PREPUSH_GATES, "0");
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.deepEqual(Object.keys(env).filter((k) => CREDENTIAL_NAME.test(k)), []);
    const keys = Object.keys(env).filter((k) => /^GIT_CONFIG_KEY_\d+$/.test(k)).map((k) => env[k]);
    assert.ok(keys.includes("core.fsmonitor") && keys.includes("core.hooksPath"), "the hook's own git calls carry HOST_GIT_CONFIG");
  });
});
