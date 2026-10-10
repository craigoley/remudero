// test/a-review-proof-runs-sandboxed-without-daemon-credentials.test.ts — W1-T6124
//
// A review proof is the PR's OWN test code, run by design. W1-T499 kept GH_TOKEN out of its env,
// but the child still ran with the daemon's HOME (where ~/.gitconfig holds the GH_TOKEN credential
// helper) and, on Linux, with the daemon's whole filesystem in reach; and ensureDeps' `npm ci` ran
// the PR's install scripts with the daemon's whole env. FIXTURES ONLY: every HOME, key and marker
// below is a tmp path this suite creates. Nothing reads a real key or a real ~/.gitconfig.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";

// A NAMESPACE import, deliberately: at the merge base the W1-T6124 exports do not exist, and a named
// import would fail the whole file at load — the reviewer reads that as "never ran", not as a red.
// Read through the namespace, each test reaches its own assertion and fails there instead.
import * as review from "../src/lib/review.js";
const {
  defaultAsyncProofSpawner,
  defaultProofSpawner,
  ensureDeps,
  ensureDepsAsync,
  execWhitelistedProof,
  judgeCriterion,
  judgeReview,
  judgeReviewAsync,
  probeProofSandbox,
  proofCheckoutGitDirs,
  proofInstallEnv,
  proofLinkedModuleRoots,
  PROOF_INSTALL_ARGS,
  proofSandboxArgv,
  ProofSandboxUnavailableError,
  setProofSandboxForTests,
} = review;
import { makeTempDir } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const CREDENTIALS: Record<string, string> = {
  GH_TOKEN: "fixture-gh-token",
  GITHUB_TOKEN: "fixture-github-token",
  GH_APP_ID: "12345",
  GH_APP_INSTALLATION_ID: "67890",
  GH_APP_PRIVATE_KEY_PATH: "/nonexistent/fixture-key.pem",
  ANTHROPIC_API_KEY: "fixture-anthropic",
  OPENAI_API_KEY: "fixture-openai",
  AZURE_OPENAI_API_KEY: "fixture-azure",
  AWS_SECRET_ACCESS_KEY: "fixture-aws",
  RMD_FOUNDRY_CLAUDE_API_KEY: "fixture-foundry",
};
const CREDENTIAL_SHAPED = /^(GH_|GITHUB_|ANTHROPIC_|OPENAI_|AZURE_|AWS_)|TOKEN|_KEY|SECRET|PASSWORD/i;

/** Run `fn` with this process's env carrying `vars`, restoring every key afterwards. */
async function withEnv<T>(vars: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => setProofSandboxForTests());

// What a hostile proof does: write ~/.gitconfig, report its HOME and the env keys it can see.
const HOSTILE = [
  "const fs = require('node:fs'), os = require('node:os'), path = require('node:path');",
  "fs.writeFileSync(path.join(os.homedir(), '.gitconfig'), '[core]\\n\\tfsmonitor = /fixture/evil\\n');",
  "process.stdout.write(JSON.stringify({ home: os.homedir(), keys: Object.keys(process.env) }));",
].join("\n");

for (const [name, spawn] of [
  ["defaultProofSpawner", async (cwd: string) => defaultProofSpawner(process.execPath, ["-e", HOSTILE], cwd, 30_000)],
  ["defaultAsyncProofSpawner", (cwd: string) => defaultAsyncProofSpawner(process.execPath, ["-e", HOSTILE], cwd, 30_000)],
] as const) {
  test(`${name}: a proof's write to ~/.gitconfig lands in a throwaway HOME, never the daemon's`, async () => {
    const daemonHome = makeTempDir("t6124-daemon-home");
    const cwd = makeTempDir("t6124-checkout");
    const out = await withEnv({ HOME: daemonHome, ...CREDENTIALS }, () => spawn(cwd));
    const seen = JSON.parse(out) as { home: string; keys: string[] };
    assert.notEqual(seen.home, daemonHome, "the child must not run with the daemon's HOME");
    assert.match(basename(seen.home), /^rmd-proof-home-/, "the throwaway HOME is an rmd- prefixed mkdtemp");
    assert.equal(existsSync(join(daemonHome, ".gitconfig")), false, "the marker must never reach the daemon's HOME");
    assert.equal(existsSync(seen.home), false, "the throwaway HOME is removed once the proof exits");
    assert.ok(seen.keys.includes("PATH"), "control: the child env was read at all");
    const leaked = seen.keys.filter((k) => CREDENTIAL_SHAPED.test(k));
    assert.deepEqual(leaked, [], "no GH_TOKEN, GH_APP_* or other credential-shaped variable reaches a proof");
  });
}

test("proofSandboxArgv mounts the checkout, its git dirs and its install, and nothing of the daemon's HOME", () => {
  const root = makeTempDir("t6124-argv");
  const daemonHome = join(root, "daemon-home");
  const common = join(root, "managed", ".git");
  const gitdir = join(common, "worktrees", "review-PR1");
  const install = join(root, "managed", "node_modules");
  const workspace = join(root, "managed", "packages", "api-client");
  const cwd = join(root, "worktrees", "review-PR1");
  const home = join(root, "proof-home");
  for (const d of [daemonHome, gitdir, join(install, "@remudero"), workspace, cwd, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(common, "config"), "[remote \"origin\"]\n\turl = https://x-access-token:fixture@github.com/o/r\n");
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  writeFileSync(join(cwd, ".git"), `gitdir: ${gitdir}\n`);
  symlinkSync(install, join(cwd, "node_modules"));
  symlinkSync(workspace, join(install, "@remudero", "api-client"));
  symlinkSync(join(root, "gone"), join(install, "dangling"));
  const key = join(cwd, "key.pem");
  writeFileSync(key, "fixture key, not a real one\n");

  const argv = proofSandboxArgv({ cwd, home, env: { HOME: daemonHome, GH_APP_PRIVATE_KEY_PATH: key } });
  const real = (p: string) => execFileSync("realpath", [p], { encoding: "utf8" }).trim();
  const bind = (flag: string, p: string) => argv.some((a, i) => a === flag && argv[i + 1] === real(p) && argv[i + 2] === real(p));
  for (const flag of ["--unshare-user", "--unshare-net", "--unshare-pid", "--die-with-parent"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv.at(-1), "--", "the argv ends where the proof's own command begins");
  assert.ok(bind("--bind", cwd), "the checkout is writable");
  assert.ok(bind("--bind", home), "the throwaway HOME is writable");
  assert.ok(bind("--ro-bind", common), "the git common dir is read-only");
  assert.ok(bind("--bind", gitdir), "the worktree's own gitdir is writable");
  assert.ok(argv.indexOf(real(gitdir)) > argv.indexOf(real(common)), "the deeper gitdir bind lands over its common dir");
  assert.ok(bind("--ro-bind", install), "the node_modules link target is read-only");
  assert.ok(bind("--ro-bind", workspace), "a workspace package link out of the install is read-only");
  const maskedBy = (p: string) => argv.find((a, i) => argv[i - 1] === "--ro-bind" && argv[i + 1] === p);
  assert.ok(maskedBy(join(real(common), "config")) !== undefined, "a common dir's config (a token-bearing remote) is masked");
  assert.equal(maskedBy(real(key)), "/dev/null", "an App key inside some bind is masked by /dev/null");
  assert.equal(argv.some((a) => a === real(daemonHome) || a.startsWith(`${real(daemonHome)}/`)), false,
    "nothing of the daemon's HOME is mounted");
  const noKey = proofSandboxArgv({ cwd, home, env: { HOME: daemonHome, GH_APP_PRIVATE_KEY_PATH: join(root, "absent.pem") } });
  assert.equal(noKey.filter((a) => a === "/dev/null").length, 0, "an absent key path needs no mask");
  assert.throws(() => proofSandboxArgv({ cwd: "/", home }), ProofSandboxUnavailableError);
});

test("the shared git config is masked by a file in the throwaway HOME, never by an unreadable /dev/null", () => {
  // bwrap mounts binds nodev: a /dev/null over a file reads as EACCES, and git refuses an unreadable config outright.
  const root = makeTempDir("t6124-config-mask");
  const common = join(root, "managed", ".git");
  const gitdir = join(common, "worktrees", "review-PR1");
  const cwd = join(root, "worktrees", "review-PR1");
  const home = join(root, "proof-home");
  for (const d of [gitdir, cwd, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(common, "config"), "[remote \"origin\"]\n\turl = https://x-access-token:fixture@github.com/o/r\n");
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  writeFileSync(join(cwd, ".git"), `gitdir: ${gitdir}\n`);
  const real = (p: string) => execFileSync("realpath", [p], { encoding: "utf8" }).trim();
  const target = join(real(common), "config");
  const maskOf = (argv: string[]) => argv.find((a, i) => argv[i - 1] === "--ro-bind" && argv[i + 1] === target);
  const first = maskOf(proofSandboxArgv({ cwd, home, env: {} }));
  assert.ok(first !== undefined && first !== "/dev/null", "the config is masked by a regular file");
  assert.ok(first!.startsWith(`${real(home)}/`), "the mask lives in the throwaway HOME its caller removes");
  assert.equal(readFileSync(first!, "utf8"), '[remote "origin"]\n\turl = "https://github.com/o/r"\n',
    "the mask carries ONLY the credential-free origin url: git reads it and no token");
  assert.equal(maskOf(proofSandboxArgv({ cwd, home, env: {} })), first, "a second argv for the same HOME reuses its mask");
  const fileHome = join(root, "home-is-a-file");
  writeFileSync(fileHome, "");
  assert.throws(() => proofSandboxArgv({ cwd, home: fileHome, env: {} }), /ENOTDIR/, "a mask that cannot be made is refused, never skipped");
});

test("proofCheckoutGitDirs and proofLinkedModuleRoots read each checkout shape", () => {
  const root = makeTempDir("t6124-shapes");
  const clone = join(root, "clone");
  mkdirSync(join(clone, ".git"), { recursive: true });
  assert.deepEqual(proofCheckoutGitDirs(clone), { common: join(clone, ".git") }, "an ordinary clone");
  assert.deepEqual(proofCheckoutGitDirs(join(root, "absent")), {}, "no .git at all");
  const odd = join(root, "odd");
  mkdirSync(odd);
  writeFileSync(join(odd, ".git"), "not a gitdir line\n");
  assert.deepEqual(proofCheckoutGitDirs(odd), {}, "a .git file naming no gitdir");
  const lone = join(root, "lone");
  const loneGitdir = join(root, "lone-gitdir");
  mkdirSync(lone);
  mkdirSync(loneGitdir);
  writeFileSync(join(lone, ".git"), `gitdir: ${loneGitdir}\n`);
  assert.deepEqual(proofCheckoutGitDirs(lone), { common: loneGitdir, worktree: loneGitdir }, "a gitdir with no commondir");
  writeFileSync(join(odd, ".git"), `gitdir: ${join(root, "vanished")}\n`);
  assert.deepEqual(proofCheckoutGitDirs(odd), {}, "a gitdir that no longer exists");
  assert.deepEqual(proofLinkedModuleRoots(clone), [], "no node_modules");
  mkdirSync(join(clone, "node_modules"));
  assert.deepEqual(proofLinkedModuleRoots(clone), [], "an in-checkout install needs no extra mount");
});

test("a sandbox that cannot start reads as not_executable, never a pass or a failure", async () => {
  const dir = makeTempDir("t6124-nostart");
  const fake = join(dir, "fake-bwrap");
  writeFileSync(fake, "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n");
  chmodSync(fake, 0o755);
  writeFileSync(join(dir, "x.txt"), "needle\n");
  setProofSandboxForTests({ mode: "bwrap", binary: fake });

  assert.throws(() => defaultProofSpawner("grep", ["-arn", "--", "needle", "x.txt"], dir, 30_000),
    (e: unknown) => e instanceof ProofSandboxUnavailableError && /uid map/.test(e.sandboxReason));
  await assert.rejects(defaultAsyncProofSpawner("grep", ["-arn", "--", "needle", "x.txt"], dir, 30_000),
    (e: unknown) => e instanceof ProofSandboxUnavailableError && /uid map/.test(e.sandboxReason));
  const verdict = judgeCriterion({ claim: "the needle is present", proof: "grep: needle in x.txt" },
    new Set(["needle", "present"]), undefined, { cwd: dir, exec: execWhitelistedProof });
  assert.equal(verdict.proof_exec, "not_executable");
  assert.equal(verdict.proof_skip, "runner-absent");
  assert.match(verdict.reason, /proof sandbox could not start/);

  setProofSandboxForTests({ mode: "bwrap", binary: join(dir, "no-such-bwrap") });
  assert.throws(() => defaultProofSpawner("grep", ["needle", "x.txt"], dir, 30_000),
    (e: unknown) => e instanceof ProofSandboxUnavailableError && /not installed/.test(e.sandboxReason));
  assert.throws(() => defaultProofSpawner("grep", ["needle", "x.txt"], join(dir, "missing"), 30_000),
    ProofSandboxUnavailableError, "a checkout the sandbox cannot resolve is a start failure too");
  assert.throws(() => defaultProofSpawner("grep", ["needle", "x.txt"], "/", 30_000), ProofSandboxUnavailableError);
});

test("the probe degrades off Linux and on a Linux host whose bwrap cannot start, and names why", () => {
  assert.match((probeProofSandbox("darwin") as { reason: string }).reason, /Linux-only.*darwin/);
  const absent = (() => {
    throw Object.assign(new Error("spawn bwrap ENOENT"), { code: "ENOENT" });
  }) as unknown as typeof execFileSync;
  assert.deepEqual(probeProofSandbox("linux", absent).mode, "unsandboxed");
  assert.match((probeProofSandbox("linux", absent) as { reason: string }).reason, /not installed/);
  const denied = (() => {
    throw Object.assign(new Error("Command failed"), { status: 1, stderr: "\nbwrap: No permissions to create new namespace\n" });
  }) as unknown as typeof execFileSync;
  assert.match((probeProofSandbox("linux", denied) as { reason: string }).reason, /No permissions/);
  const quiet = (() => {
    throw new Error("killed");
  }) as unknown as typeof execFileSync;
  assert.match((probeProofSandbox("linux", quiet) as { reason: string }).reason, /killed/);
  let argv: readonly string[] = [];
  const starts = ((_file: string, args: readonly string[]) => {
    argv = args;
    return "";
  }) as unknown as typeof execFileSync;
  assert.deepEqual(probeProofSandbox("linux", starts), { mode: "bwrap", binary: "bwrap" });
  assert.ok(argv.includes("--unshare-net") && argv.includes(process.execPath), "the probe starts node inside the real argv");
});

test("a review whose proof ran unsandboxed records the degraded sandbox on its verdict", async () => {
  const dir = makeTempDir("t6124-degraded");
  writeFileSync(join(dir, "x.txt"), "needle\n");
  const criteria = [{ claim: "the needle is present", proof: "grep: needle in x.txt" }];
  const evidence = { diff: "diff --git a/x.txt b/x.txt\n+needle\n", report: "the needle is present", headCheckoutDir: dir };
  setProofSandboxForTests({ mode: "unsandboxed", reason: "fixture: no bwrap on this host" });
  assert.equal(judgeReview(criteria, evidence).proofSandboxDegraded, "fixture: no bwrap on this host");
  assert.equal((await judgeReviewAsync(criteria, evidence)).proofSandboxDegraded, "fixture: no bwrap on this host");
  const injected = judgeReview(criteria, { ...evidence, execProof: () => "pass" });
  assert.equal(injected.proofSandboxDegraded, undefined, "no proof child started, so nothing degraded");
  if (process.platform === "darwin") {
    setProofSandboxForTests();
    assert.match(judgeReview(criteria, evidence).proofSandboxDegraded ?? "", /Linux-only/, "macOS records its degrade");
  }
});

function postinstallFixture(): string {
  const cwd = makeTempDir("t6124-install");
  const dep = join(cwd, "dep");
  mkdirSync(dep);
  writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  const pkg = {
    name: "fx",
    version: "1.0.0",
    private: true,
    scripts: { postinstall: "node -e \"require('fs').writeFileSync('postinstall-ran', process.env.GH_TOKEN || 'none')\"" },
    dependencies: { dep: "file:dep" },
  };
  writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({
    name: "fx",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fx", version: "1.0.0", hasInstallScript: true, dependencies: { dep: "file:dep" } },
      dep: { version: "1.0.0" },
      "node_modules/dep": { resolved: "dep", link: true },
    },
  }));
  return cwd;
}

test("ensureDeps' npm ci passes --ignore-scripts and carries no credential", async () => {
  const npmHome = makeTempDir("t6124-npm-home");
  await withEnv({ HOME: npmHome, ...CREDENTIALS }, async () => {
    const calls: { args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
    const recorder = ((_file: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: opts.env });
      return "";
    }) as unknown as typeof execFileSync;
    ensureDeps(postinstallFixture(), recorder);
    assert.equal(calls.length, 1, "control: the install was attempted");
    assert.ok(calls[0]!.args.includes("--ignore-scripts"));
    assert.deepEqual(Object.keys(calls[0]!.env ?? {}).filter((k) => CREDENTIAL_SHAPED.test(k)), [],
      "the install env is the allowlist, never the daemon's whole env");
    assert.deepEqual(Object.keys(proofInstallEnv()).filter((k) => CREDENTIAL_SHAPED.test(k)), []);
    assert.ok(PROOF_INSTALL_ARGS.includes("--ignore-scripts"));

    const sync = postinstallFixture();
    ensureDeps(sync);
    assert.ok(existsSync(join(sync, "node_modules", "dep", "package.json")), "control: npm ci really installed");
    assert.equal(existsSync(join(sync, "postinstall-ran")), false, "the PR's postinstall must not run");
    const viaAsync = postinstallFixture();
    await ensureDepsAsync(viaAsync);
    assert.ok(existsSync(join(viaAsync, "node_modules", "dep", "package.json")), "control: the async install ran");
    assert.equal(existsSync(join(viaAsync, "postinstall-ran")), false, "the async path runs no lifecycle script");
  });
});

test("on Linux with bwrap, a proof cannot read the App key or the daemon's HOME", async (t) => {
  const status = probeProofSandbox();
  if (status.mode !== "bwrap") {
    if (process.platform === "darwin") assert.match(status.reason, /Linux-only/, "macOS degrades, by name");
    t.skip(`bwrap sandbox unavailable here: ${status.reason}`);
    return;
  }
  const daemonHome = makeTempDir("t6124-linux-home");
  const keyDir = makeTempDir("t6124-linux-key");
  const key = join(keyDir, "app-key.pem");
  writeFileSync(key, "fixture key, not a real one\n");
  writeFileSync(join(daemonHome, "marker"), "daemon\n");
  const cwd = makeTempDir("t6124-linux-checkout");
  const probe = [
    "const fs = require('node:fs');",
    "const r = (p) => { try { fs.readFileSync(p); return 'read'; } catch (e) { return e.code; } };",
    `process.stdout.write(JSON.stringify({ key: r(${JSON.stringify(key)}), home: r(${JSON.stringify(join(daemonHome, "marker"))}) }));`,
  ].join("\n");
  setProofSandboxForTests(status);
  const out = await withEnv({ HOME: daemonHome, GH_APP_PRIVATE_KEY_PATH: key }, () =>
    defaultProofSpawner(process.execPath, ["-e", probe], cwd, 30_000));
  const seen = JSON.parse(out) as { key: string; home: string };
  assert.notEqual(seen.key, "read", "the App key file must not be readable from a proof");
  assert.notEqual(seen.home, "read", "the daemon's HOME must not be mounted");
  assert.equal(readFileSync(key, "utf8"), "fixture key, not a real one\n", "control: the key exists outside the sandbox");
});

test("on Linux with bwrap, a proof's git runs in a review worktree and reads only a credential-free origin", async (t) => {
  const status = probeProofSandbox();
  if (status.mode !== "bwrap") {
    if (process.platform === "darwin") assert.match(status.reason, /Linux-only/, "macOS degrades, by name");
    t.skip(`bwrap sandbox unavailable here: ${status.reason}`);
    return;
  }
  // The review checkout's shape: a worktree whose common dir (and its config) sits outside the checkout.
  const managed = gitRepo({ kind: "t6124-git-managed" });
  managed.addRemote("origin", "https://x-access-token:fixture@github.com/o/r");
  const cwd = join(makeTempDir("t6124-git-review"), "review-PR1");
  managed.addWorktree(cwd, "review-pr1");
  const probe = [
    "const { spawnSync } = require('node:child_process');",
    "const git = (...a) => { const r = spawnSync('git', a, { encoding: 'utf8' }); return { status: r.status, out: (r.stdout + r.stderr).trim() }; };",
    "process.stdout.write(JSON.stringify({ head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), url: git('config', '--get', 'remote.origin.url') }));",
  ].join("\n");
  setProofSandboxForTests(status);
  const seen = JSON.parse(await defaultProofSpawner(process.execPath, ["-e", probe], cwd, 30_000)) as Record<string, { status: number; out: string }>;
  assert.equal(seen.head.status, 0, `git rev-parse must run in the sandboxed worktree: ${seen.head.out}`);
  assert.equal(seen.status.status, 0, `git status must run in the sandboxed worktree: ${seen.status.out}`);
  assert.equal(seen.url.status, 0, `the origin url is readable, as in CI's checkout: ${seen.url.out}`);
  assert.equal(seen.url.out, "https://github.com/o/r", "only the credential-free origin url reaches the proof");
  assert.doesNotMatch(seen.url.out, /fixture/, "no credential from the remote URL reaches the proof");
});
