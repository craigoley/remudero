import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as push from "#src/lib/git-push.js";
import { probeProofSandbox, ProofSandboxUnavailableError } from "#src/lib/review.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { worktreeAdd } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const credentials = { GH_TOKEN: "fixture-token", GH_APP_ID: "123", GH_APP_PRIVATE_KEY_PATH: "/fixture/key", NODE_OPTIONS: "--require /fixture/evil" };
const credentialKeys = (env: Record<string, unknown>) => Object.keys(env).filter((k) => /^(GH_|GITHUB_)|TOKEN|PRIVATE_KEY/.test(k));

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fixture(mode = "available", failure = "") {
  const root = makeTempDir("t6138");
  const harness = join(root, "harness");
  const log = join(root, "runner.jsonl");
  const runner = join(root, "runner.mjs");
  put(runner, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env: process.env }) + '\\n');
const at = argv.indexOf('--');
const r = spawnSync(argv[at + 1], argv.slice(at + 2), { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status ?? 2);
`);
  chmodSync(runner, 0o755);
  mkdirSync(join(harness, "hooks"), { recursive: true });
  copyFileSync(join(repo, "hooks/pre-push"), join(harness, "hooks/pre-push"));
  chmodSync(join(harness, "hooks/pre-push"), 0o755);
  symlinkSync(join(repo, "node_modules"), join(harness, "node_modules"));
  // W1-T421: the harness is an ESM package scope, as the real daemon checkout is. Without this
  // package.json the .ts wrapper below sits in os.tmpdir()'s CommonJS scope, tsx compiles it and the
  // real src graph it re-exports as CommonJS, and every pre-push child under coverage emits a synthetic
  // `SF:src/lib/<define:import.meta>` record that coverage-merge-ratchet refuses (#11757, shard 3).
  put(join(harness, "package.json"), JSON.stringify({ type: "module" }));
  const url = (path: string) => JSON.stringify(pathToFileURL(join(repo, path)).href);
  put(join(harness, "src/lib/git-push.ts"), `import * as p from ${url("src/lib/git-push.ts")};
export const createPrePushSandboxRunner = (cwd) => p.createPrePushSandboxRunner(cwd, {
  probe: () => (${mode === "unavailable" ? "{ mode: 'unsandboxed', reason: 'fixture: user namespaces unavailable' }" : `{ mode: 'bwrap', binary: ${JSON.stringify(runner)} }`})
});\n`);
  // W1-T12510: the hook runs no census precheck or plan lint; the control-plane check is the one branch check left.
  put(join(harness, "scripts/ci-control-plane-precheck.mjs"), `export * from ${url("scripts/ci-control-plane-precheck.mjs")};\n`);
  put(join(harness, "scripts/lib/git.mjs"), `export * from ${url("scripts/lib/git.mjs")};\n`);
  const remote = gitRepo({ bare: true, kind: "t6138-remote" });
  const seed = gitRepo({ kind: "t6138-seed" });
  seed.addRemote("origin", remote.dir);
  seed.git("push", "-q", "origin", "main");
  const branch = "run-W1-T6138-1";
  const wt = join(root, "worktree");
  worktreeAdd(seed.dir, wt, branch, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  const tree = seed.addWorktree(join(root, "editor"), "fixture-editor");
  // Use the fixture helper's identity for the run worktree's commits too.
  const git = (...args: string[]) => tree.git("-C", wt, ...args);
  if (!existsSync(join(wt, "node_modules"))) symlinkSync(join(repo, "node_modules"), join(wt, "node_modules"));
  put(join(wt, "protected.txt"), "fixture content\n");
  put(join(wt, "package.json"), JSON.stringify({ type: "module", scripts: { "lint-plan:fast": "node scripts/lint.mjs --base origin/main" } }));
  put(join(wt, "src/lib/policy.ts"), "export const fixture = true;\n");
  put(join(wt, "plan/fixture.yaml"), "fixture: true\n");
  put(join(wt, "test/setup/tmp-hygiene.ts"), "export {};\n");
  put(join(wt, "scripts/generate-capability-snapshot.mjs"), `process.exit(${failure === "capability" ? 1 : 0});\n`);
  // A lint the hook used to run in the sandbox; it must not run now.
  put(join(wt, "scripts/lint.mjs"), "console.log('fixture lint clean');\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: fixture check programs");
  git("-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "HEAD:main");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  put(join(wt, "src/lib/policy.ts"), "export const fixture = false;\n");
  put(join(wt, "plan/fixture.yaml"), "fixture: false\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: fixture inputs");
  const runs = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> }) : [];
  return { root, harness, wt, remote, branch, runner, runs, head: git("rev-parse", "HEAD") };
}

async function runPush(f: ReturnType<typeof fixture>, asyncPush = false) {
  const vars = { RMD_HARNESS_HOOKS_DIR: join(f.harness, "hooks"), RMD_PREPUSH_GATES: "1", ...credentials };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const write = process.stderr.write;
  let stderr = "";
  Object.assign(process.env, vars);
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  let error: unknown;
  try {
    await withLiveWritesAllowed(() => asyncPush ? push.gitPushRunBranchAsync(f.wt) : push.gitPushRunBranch(f.wt));
  } catch (cause) {
    error = cause;
  } finally {
    process.stderr.write = write;
    for (const [k, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[k]; else process.env[k] = value;
    }
  }
  return { stderr, error };
}

describe("test/the-pre-push-gate-runs-the-branch-s-own-checks-in-the-proof-sandbox.test.ts", () => {
  test("the host gate runs the branch's capability check through the runner with readonly binds and a credential-free throwaway HOME", async () => {
    const f = fixture();
    const result = await runPush(f);
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(f.remote.git("rev-parse", `refs/heads/${f.branch}`), f.head);
    const children = f.runs().filter((r) => !r.argv.includes("-e"));
    assert.equal(children.length, 1, "only the capability check reached the sandbox runner (W1-T12510)");
    assert.ok(children[0]!.argv.includes("scripts/generate-capability-snapshot.mjs"));
    assert.ok(!children.some((r) => r.argv.includes("--test") || r.argv.includes("scripts/lint.mjs")), "no census suite or plan lint ran");
    for (const { argv, env } of children) {
      assert.deepEqual(credentialKeys(env), []);
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.notEqual(env.HOME, process.env.HOME);
      assert.equal(existsSync(env.HOME), false, "the temporary HOME was removed");
      assert.equal(env.TMPDIR, "/tmp");
      const writable = argv.flatMap((a, i) => a === "--bind" ? [argv[i + 1]] : []);
      assert.deepEqual(writable.sort(), [env.HOME, join(env.HOME, ".rmd-private-tmp")].sort(), "only the temporary HOME and its exact private tmp child are writable host binds");
      assert.ok(argv.includes("--unshare-net"));
      assert.ok(argv.some((a, i) => a === "--ro-bind" && argv[i + 1] === f.wt));
    }
  });

  test("a capability finding inside the sandbox blocks the push and no branch lands", async () => {
    const f = fixture("available", "capability");
    const result = await runPush(f, true);
    assert.ok(result.error instanceof push.PushFailedError, result.stderr);
    assert.match(result.stderr, /REFUSED -- capability snapshot is stale/);
    assert.throws(() => f.remote.git("rev-parse", "--verify", `refs/heads/${f.branch}`));
    assert.ok(f.runs().length > 0);
  });

  test("an unavailable sandbox skips each check by name and never invokes the runner", async () => {
    const f = fixture("unavailable");
    const result = await runPush(f);
    assert.equal(result.error, undefined, result.stderr);
    assert.deepEqual(f.runs(), []);
    assert.match(result.stderr, /ci-control-plane-precheck[^\n]*skipped, NOT passed/);
    assert.match(result.stderr, /fixture: user namespaces unavailable/);
  });

  test("the default spawn executes the fixture sandbox runner and removes the successful child's HOME", () => {
    const f = fixture();
    const run = push.createPrePushSandboxRunner(f.wt, { probe: () => ({ mode: "bwrap", binary: f.runner }) });
    const result = run(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.HOME + '/marker', 'temporary'); console.log(JSON.stringify(process.env));"]);
    assert.equal(result.status, 0, String(result.stderr));
    const env = JSON.parse(result.stdout);
    assert.equal(env.TMPDIR, "/tmp");
    assert.deepEqual(credentialKeys(env), []);
    assert.notEqual(env.HOME, process.env.HOME);
    assert.equal(existsSync(env.HOME), false);
    assert.equal(f.runs().length, 2, "the startup probe and then the check ran");
  });

  test("an unsandboxed probe result refuses the direct runner without spawning a child", () => {
    const f = fixture();
    const run = push.createPrePushSandboxRunner(f.wt, { probe: () => ({ mode: "unsandboxed", reason: "fixture: no bwrap" }) });
    assert.throws(() => run(process.execPath, ["-e", "throw Error('must not run')"]),
      (error: unknown) => error instanceof ProofSandboxUnavailableError && error.sandboxReason === "fixture: no bwrap");
    assert.deepEqual(f.runs(), []);
  });

  test("the runner names a start failure and never falls back to an unsandboxed child", () => {
    assert.equal(typeof push.createPrePushSandboxRunner, "function");
    const f = fixture();
    const calls: string[] = [];
    const run = push.createPrePushSandboxRunner(f.wt, {
      probe: () => ({ mode: "bwrap", binary: "/fixture/absent-bwrap" }),
      run: (file, args, options) => { calls.push(file); return spawnSync(file, args, options); },
    });
    assert.throws(() => run(process.execPath, ["-e", "throw Error('must not run')"]), ProofSandboxUnavailableError);
    assert.deepEqual(calls, ["/fixture/absent-bwrap"]);
  });

  for (const diagnostic of ["fixture namespace failure", ""]) {
    test(`a failed sandbox startup with ${diagnostic ? "a diagnostic" : "only an exit code"} is unmeasured and cleans HOME`, () => {
      const f = fixture();
      const homes: string[] = [];
      const run = push.createPrePushSandboxRunner(f.wt, {
        probe: () => ({ mode: "bwrap", binary: process.execPath }),
        run: (_file, _args, options) => {
          homes.push(String(options.env?.HOME));
          return spawnSync(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(7);`], options);
        },
      });
      assert.throws(() => run(process.execPath, ["-e", "throw Error('must not run')"]),
        (error: unknown) => error instanceof ProofSandboxUnavailableError && error.sandboxReason.includes(diagnostic || "exited 7"));
      assert.equal(homes.length, 1, "the check child never started");
      assert.equal(existsSync(homes[0]), false);
    });
  }

  test("real bwrap confines writes and hides fixture daemon files", (t) => {
    const status = probeProofSandbox();
    if (status.mode !== "bwrap") { t.skip(`real-bwrap arm unavailable: ${status.reason}`); return; }
    const f = fixture();
    const secret = join(f.root, "daemon-key");
    writeFileSync(secret, "fixture key");
    const before = readFileSync(join(f.wt, "protected.txt"), "utf8");
    const run = push.createPrePushSandboxRunner(f.wt);
    const result = run(process.execPath, ["-e", `const fs = require('node:fs');
let blocked = false; try { fs.writeFileSync('protected.txt', 'damaged'); } catch (error) { blocked = error.code === 'EROFS' || error.code === 'EACCES'; }
fs.writeFileSync(process.env.HOME + '/marker', 'temporary');
console.log(JSON.stringify({ blocked, secret: fs.existsSync(${JSON.stringify(secret)}), home: process.env.HOME }));`]);
    assert.equal(result.status, 0, String(result.stderr));
    const seen = JSON.parse(String(result.stdout));
    assert.equal(seen.blocked, true);
    assert.equal(seen.secret, false);
    assert.equal(existsSync(seen.home), false);
    assert.equal(readFileSync(join(f.wt, "protected.txt"), "utf8"), before);
  });
});
