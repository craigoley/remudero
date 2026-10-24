import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readMountPlanDrift, type DeployDeps } from "#src/lib/deployer.js";
import { ProviderAuthSessionStore } from "#src/lib/provider-auth-sessions.js";
import { runServePolicyCycle } from "#src/lib/serve-policy-convergence.js";
import { createClaudeFleetLoginStagingDir, replaceClaudeFleetCredential } from "#src/lib/worker-home.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const DEST = "/home/node/.claude/fleet-auth";

function launcherFixture(t: TestContext) {
  const root = ownedFixtureDir(t, "w1-t10511").dir;
  const install = join(root, "install");
  const home = join(root, "home");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const fleet = join(home, ".claude", "fleet-auth");
  for (const dir of [join(install, "deploy"), home, state, bin, fleet]) mkdirSync(dir, { recursive: true });
  for (const file of ["serve-container.sh", "scratch-mounts.sh", "claude-directory.sh"]) {
    copyFileSync(join(REPO_ROOT, "deploy", file), join(install, "deploy", file));
  }
  const mounts = join(root, "daemon-mounts");
  writeFileSync(mounts, `${join(home, ".claude")}\t/home/node/.claude\n`);
  writeFileSync(join(bin, "docker"), `#!/bin/bash
case "$*" in
  'network inspect '*) exit 0 ;;
  'inspect remudero-daemon') exit 0 ;;
  *'.Source .Destination'*) cat "$FIXTURE_MOUNTS" ;;
  *'.Destination "/home/node/Remudero"'*) printf '%s' "$RMD_STATE_DIR" ;;
  'inspect remudero-daemon '*) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "az"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`, HOME: home, GH_TOKEN: "fixture-only",
    RMD_STATE_DIR: state, RMD_SERVE_REPO_DIR: join(root, "serve-repo"),
    RMD_SERVE_DOCKERENV_PATH: join(root, "no-dockerenv"), RMD_SERVE_SUPERVISOR: "off",
    RMD_SCRATCH: "off", NODE_V8_COVERAGE: "", FIXTURE_MOUNTS: mounts,
  };
  const launch = (over: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync("bash", [join(install, "deploy", "serve-container.sh"), "--dry-run"], {
      env: { ...env, ...over }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const command = result.stdout.split("\n").find((line) => line.startsWith("  docker run "));
    assert.ok(command, result.stdout);
    const args = command.trim().split(/\s+/);
    const binds = args.flatMap((arg, i) => arg === "-v" ? [args[i + 1]!] : []);
    assert.ok(binds.every((bind) => bind.split(":")[1] !== "/home/node/.claude"), "never bind the whole operator directory");
    return { binds, output: result.stdout + result.stderr };
  };
  return { root, install, home, state, fleet, mounts, env, launch };
}

test("W1-T10511: the serve launcher binds only the fleet-auth directory the daemons share", (t) => {
  const f = launcherFixture(t);
  assert.ok(f.launch().binds.includes(`${f.fleet}:${DEST}`));
  const configured = join(f.root, "configured-claude");
  mkdirSync(join(configured, "fleet-auth"), { recursive: true });
  writeFileSync(f.mounts, `${configured}\t/home/node/.claude\n`);
  assert.ok(f.launch({ RMD_CLAUDE_DIR: configured }).binds.includes(`${configured}/fleet-auth:${DEST}`));
  const mismatch = f.launch();
  assert.ok(mismatch.binds.every((bind) => bind.split(":")[1] !== DEST));
  assert.match(mismatch.output, /disagree/i);
  const explicit = f.launch({ RMD_CLAUDE_FLEET_AUTH_HOST_DIR: f.fleet });
  assert.ok(explicit.binds.includes(`${f.fleet}:${DEST}`), "an explicit host override has first priority");
  assert.ok(f.launch({ RMD_CLAUDE_DIR: join(f.root, "absent") }).binds.includes(`${configured}/fleet-auth:${DEST}`), "the daemon mount is a fallback hint");
  writeFileSync(f.mounts, "");
  assert.ok(f.launch().binds.includes(`${f.fleet}:${DEST}`), "configuration survives a daemon mid-create");
  const absent = join(f.root, "absent-fleet");
  const missing = f.launch({ RMD_CLAUDE_FLEET_AUTH_HOST_DIR: absent });
  assert.ok(missing.binds.every((bind) => bind.split(":")[1] !== DEST));
  assert.match(missing.output, /NOTE/);
  assert.equal(existsSync(absent), false);
  const shared = join(f.root, "shared-claude");
  mkdirSync(join(shared, "fleet-auth"), { recursive: true });
  writeFileSync(join(f.install, "deploy", "claude-directory.sh"), `claude_host_directory() { printf '%s\\n' '${shared}'; }\n`);
  writeFileSync(f.mounts, "");
  assert.ok(f.launch().binds.includes(`${shared}/fleet-auth:${DEST}`), "serve uses the shared daemon directory resolver");
  writeFileSync(join(f.install, "deploy", "claude-directory.sh"), "claude_host_directory() { return 17; }\n");
  const failed = spawnSync("bash", [join(f.install, "deploy", "serve-container.sh"), "--fleet-auth-plan"], {
    env: f.env, encoding: "utf8",
  });
  assert.equal(failed.status, 17, "a failed shared resolver cannot produce a fleet bind");
});

test("W1-T10511: a Claude login that cannot reach the fleet store answers unavailable and creates nothing", async (t) => {
  const realHome = ownedFixtureDir(t, "w1-t10511-login").dir;
  const fleet = join(realHome, ".claude", "fleet-auth");
  let spawned = 0;
  const store = new ProviderAuthSessionStore({
    profiles: [{ id: "fleet", provider: "claude", label: "Fleet Claude" }],
    claudeRealHome: realHome,
    resolveClaudeBin: () => "/fixture/claude",
    spawn: () => { spawned++; throw new Error("unexpected spawn"); },
  });
  const started = await store.start({ provider: "claude", profileId: "fleet" });
  assert.equal(started.state, "unavailable");
  assert.equal(spawned, 0);
  assert.equal(existsSync(fleet), false);
  assert.deepEqual(readdirSync(realHome), []);
  assert.match(started.reason!, /fleet credential store.*not reachable/i);
  assert.ok(!JSON.stringify(started).includes(realHome));
  assert.throws(() => createClaudeFleetLoginStagingDir(realHome));
  assert.equal(existsSync(fleet), false);
  const staged = join(realHome, "staged");
  mkdirSync(staged);
  const expiresAt = Date.now() + 3_600_000;
  writeFileSync(join(staged, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt,
  } }));
  assert.deepEqual(await replaceClaudeFleetCredential({ realHome, stagingDir: staged }), {
    kind: "refused", reasonClass: "fleet-store-unreachable",
  });
  assert.equal(existsSync(fleet), false);
  mkdirSync(fleet, { recursive: true });
  assert.ok(createClaudeFleetLoginStagingDir(realHome).startsWith(`${fleet}/.claude-login-`));
  assert.deepEqual(await replaceClaudeFleetCredential({ realHome, stagingDir: staged }), { kind: "replaced", expiresAtMs: expiresAt });
});

test("W1-T10511: a serve container without the fleet-auth bind is mount drift", (t) => {
  const f = launcherFixture(t);
  let mounted = false;
  let inspect = true;
  const exec = (cmd: string, args: string[]): string => {
    if (cmd === "bash") return execFileSync(cmd, args, { env: f.env, encoding: "utf8", stdio: "pipe" });
    assert.equal(cmd, "docker");
    assert.equal(args[1], "remudero-serve");
    if (!inspect) throw new Error("inspect unavailable");
    return JSON.stringify({ Mounts: mounted ? [{ Source: f.fleet, Destination: DEST, RW: true }] : [], Env: [] });
  };
  assert.deepEqual(readMountPlanDrift(exec, f.install, f.state, "remudero-serve"), [
    { target: DEST, expected: f.fleet, actual: undefined },
  ], "the fleet bind is compared even when scratch mounts are off");
  let replaces = 0;
  const deps = {
    now: () => Date.now(), log: () => undefined,
    stopPresent: () => false, pausePresent: () => false,
    serveHealthy: () => true, serveHandoffInProgress: () => false,
    servePolicyDrift: () => [], servePolicyLastFailedAtMs: () => undefined,
    serveMountPlanDrift: () => readMountPlanDrift(exec, f.install, f.state, "remudero-serve"),
    replaceServe: () => { replaces++; mounted = true; },
  } as unknown as DeployDeps;
  assert.equal(runServePolicyCycle(deps, { imageDriftOnly: true }).replaced, true);
  assert.equal(replaces, 1);
  assert.deepEqual(readMountPlanDrift(exec, f.install, f.state, "remudero-serve"), []);
  inspect = false;
  assert.equal(readMountPlanDrift(exec, f.install, f.state, "remudero-serve"), undefined);
  assert.equal(runServePolicyCycle(deps, { imageDriftOnly: true }).replaced, false);
  assert.equal(replaces, 1, "an unknown inspect cannot cause a replacement");
});
