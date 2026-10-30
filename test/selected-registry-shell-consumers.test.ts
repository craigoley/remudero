// @source-text-subject: qualification mutants delete rendered transport arms and execute the resulting launcher.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectedRegistryShadowMain } from "#src/selected-registry-shadow-main.js";
import { selectedRegistryShadowChild } from "#src/lib/child-entry-argv.js";
import { selectedRegistryLifecycleExec } from "#src/lib/selected-registry-consumers.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { registryShellFixture } from "#test/helpers/registry-shell-fixture.js";

type Row = Record<string, unknown>;

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-shell-shadow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "selected-private.yaml");
  const session = join(root, "session.json");
  const text = "instances:\n  core:\n    github_repo: craigoley/remudero\n    mode: shadow\n";
  writeFileSync(registry, text, { mode: 0o600 });
  const rows = () => readFileSync(session + ".observations", "utf8").trim().split("\n").map(line => JSON.parse(line) as Row);
  return { root, registry, session, text, rows };
}

async function capture(session: string, envPath?: string): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    assert.equal(await selectedRegistryShadowMain(["--shadow", "--capture", "--session", session],
      envPath === undefined ? {} : { RMD_INSTANCE_REGISTRY: envPath }), 0);
  } finally { console.log = original; }
  assert.match(lines[0] ?? "", /^[a-f0-9]{64}$/);
  return lines[0]!;
}

async function observe(session: string, pin: string, consumer: string, instance = "core") {
  return selectedRegistryShadowMain(["--shadow", "--session", session, "--pin", pin,
    "--consumer", consumer, "--instance", instance, "--repository", "craigoley/remudero", "--namespace", "host"]);
}

function refreshFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  const names = ["core", "site", "console"];
  const legacyRegistry = join(f.root, "legacy.yaml");
  const lines = ["instances:"];
  for (const name of names) {
    const stateRoot = join(f.root, name);
    mkdirSync(join(stateRoot, "state"), { recursive: true });
    writeFileSync(join(stateRoot, "state", "ledger.ndjson"), "");
    lines.push(`  ${name}:`, `    github_repo: craigoley/remudero${name === "core" ? "" : `-${name}`}`,
      "    mode: shadow", `    state_dir: ${stateRoot}`);
  }
  writeFileSync(legacyRegistry, lines.join("\n") + "\n");
  const bin = join(f.root, "bin"); mkdirSync(bin);
  const calls = join(f.root, "docker.calls");
  writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "$*" in
  'inspect remudero-daemon --format '* ) printf '%s\\n' sha256:fixture ;;
  *'printenv GH_APP_ID'*) printf '%s\\n' fixture-app ;;
  *'printenv GH_APP_INSTALLATION_ID'*) printf '%s\\n' fixture-installation ;;
  *'printenv GH_APP_PRIVATE_KEY_PATH'*) printf '%s\\n' /fixture-key ;;
esac
`, { mode: 0o700 });
  chmodSync(join(bin, "docker"), 0o700);
  const cron = join(f.root, "crontab.snapshot"); writeFileSync(cron, "");
  writeFileSync(join(bin, "crontab"), `#!/bin/sh
if [ "$1" = -l ]; then cat "$CRONTAB_SNAPSHOT"; else cat > "$CRONTAB_SNAPSHOT"; fi
`, { mode: 0o700 });
  const trustedState = join(f.root, "trusted-state");
  mkdirSync(join(trustedState, "daemon-install"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "deploy"), join(trustedState, "daemon-install/deploy"));
  const cases = join(f.root, "cases.json"); writeFileSync(cases, "{}\n");
  const env = { ...process.env, HOME: f.root, PATH: `${bin}:${process.env.PATH ?? ""}`,
    RMD_STATE_DIR: trustedState, CRONTAB_SNAPSHOT: cron,
    DOCKER_CALLS: calls, RMD_INSTANCE_REGISTRY: legacyRegistry, RMD_FIELD_TRIALS_CASE_FILES: cases };
  const run = (args: string[] = [], script = join(REPO_ROOT, "deploy", "field-trials-refresh.sh"),
    shell = "bash", extra: NodeJS.ProcessEnv = {}) => {
    writeFileSync(calls, "");
    const result = spawnSync(shell, [script, ...args],
      { env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      calls: readFileSync(calls, "utf8").trim().split("\n") };
  };
  return { ...f, legacyRegistry, run };
}

/** Pin and unpack the real historical interpreter inside a disposable test namespace. */
function bash32(t: { after(fn: () => void): void }) {
  if (process.platform === "darwin") {
    const shell = "/bin/bash";
    const version = spawnSync(shell, ["-c", 'printf "%s" "$BASH_VERSION"'], { encoding: "utf8" });
    assert.equal(version.status, 0, String(version.error ?? version.stderr));
    assert.match(version.stdout, /^3\.2\./, "the native historical executable must really be Bash 3.2");
    return { shell, env: {} as NodeJS.ProcessEnv, version: version.stdout };
  }
  assert.equal(`${process.platform}/${process.arch}`, "linux/x64",
    "mixed-version qualification requires native macOS Bash 3.2 or the pinned Linux x64 fixture");
  const root = mkdtempSync(join(tmpdir(), "rmd-bash32-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packages = join(REPO_ROOT, "test/fixtures/bash-3.2-linux-amd64");
  for (const [name, digest] of [
    ["bash_3.2-5ubuntu1_amd64.deb", "fe15a51dc70b4b0d5ed0556c670ffdf5b0297bb509480f22336684ee156b1d30"],
    ["libncurses5_6.1+20190803-1ubuntu1_amd64.deb", "56d3dc9fd3c23ee99965e9d234df3ea9d40a276a45a4ef66ba735830dac03fc5"],
    ["libtinfo5_6.1+20190803-1ubuntu1_amd64.deb", "d7595f8592080f8172d02a5584093d0b04e035c8550246b6918b8d48233ccbe0"],
  ]) {
    const archive = join(packages, name);
    assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), digest, name);
    const extracted = spawnSync("dpkg-deb", ["-x", archive, root], { encoding: "utf8" });
    assert.equal(extracted.status, 0, `${name}: ${extracted.error ?? extracted.stderr}`);
  }
  const shell = join(root, "bin/bash");
  const libraryPath = join(root, "lib/x86_64-linux-gnu");
  const env = { LD_LIBRARY_PATH: libraryPath };
  const version = spawnSync(shell, ["-c", 'printf "%s" "$BASH_VERSION"'], { env, encoding: "utf8" });
  assert.equal(version.status, 0, String(version.error ?? version.stderr));
  assert.match(version.stdout, /^3\.2\./, "the historical executable must really be Bash 3.2");
  return { shell, env, version: version.stdout };
}

function supervisorFixture(t: { after(fn: () => void): void }) {
  const f = registryShellFixture(t), pin = f.capture();
  writeFileSync(f.legacy, `instances:\n  core:\n    repo: remudero\n    github_repo: craigoley/remudero\n    state_dir: ${f.state}\n    container_name: remudero-daemon\n    primary: true\n    image: fixture.azurecr.io/remudero:latest\n    claude_dir: ${f.env.RMD_CLAUDE_DIR}\n    codex_dir: ${f.env.RMD_CODEX_DIR}\n    container_config_dir: ${f.env.RMD_CONTAINER_CONFIG_DIR}\n`);
  mkdirSync(join(f.state, "daemon-install/.remudero"));
  writeFileSync(join(f.state, "daemon-install/.remudero/daemon-instances.yaml"), readFileSync(f.legacy));
  assert.equal(f.install().status, 0);
  mkdirSync(join(f.state, "remudero/bin"));
  symlinkSync(join(REPO_ROOT, "src"), join(f.state, "remudero/src"));
  writeFileSync(join(f.state, "remudero/bin/rmd"), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({bin:'rmd', args}) + '\\n');
if (args[0] !== 'deploy-run') { console.log('{"state":"HEALTHY","action":"none"}'); process.exit(0); }
const r = cp.spawnSync(process.execPath, ['--import', ${JSON.stringify(join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs"))},
  ${JSON.stringify(join(REPO_ROOT, "src/run-task.ts"))}, ...args, '--repo-root', ${JSON.stringify(join(f.state, "daemon-install"))}],
  {stdio:'inherit', env:process.env});
process.exit(r.status ?? 99);
`, { mode: 0o700 });
  writeFileSync(join(f.state, "state/DEPLOY_REQUESTED"), "fixture\n");
  const docker = join(f.root, "transports/docker"), source = readFileSync(docker, "utf8");
  writeFileSync(docker, source.replaceAll("sha256:fixture", "sha256:" + "a".repeat(64)).replace('if (bin === "docker") {', `if (bin === "docker") {
  if (args[0] === 'top') { out('PID PPID COMMAND\\n1 0 node daemon'); process.exit(0); }
  if (args[0] === 'inspect' && args.join(' ').includes('Config.Env')) { out('GH_TOKEN=fixture-token'); process.exit(0); }
  if (args[0] === 'inspect' && args.join(' ').includes('Config.Image')) { out('fixture.azurecr.io/remudero:latest'); process.exit(0); }
  if (args[0] === 'inspect' && args.join(' ').includes('.Id')) { out('fixture-id'); process.exit(0); }
  if (args[0] === 'inspect' && args.join(' ').includes('.State.Restarting')) { out('true false'); process.exit(0); }
  if (args[0] === 'inspect' && args.includes('remudero-serve') && args.join(' ').includes('.Image')) {
    out('sha256:' + (fs.existsSync(e.FIXTURE_SERVE_STARTED) ? 'a' : 'b').repeat(64)); process.exit(0);
  }
  if (args[0] === 'run' && !args.includes('--entrypoint')) {
    if (args.includes('remudero-serve')) fs.writeFileSync(e.FIXTURE_SERVE_STARTED, 'started');
    else fs.appendFileSync(path.join(e.RMD_STATE_DIR, 'state/ledger.ndjson'), JSON.stringify({step:'daemon.boot', ts:new Date().toISOString(), head_sha:'a'.repeat(40)}) + '\\n');
  }
`));
  const git = join(f.root, "transports/git");
  writeFileSync(git, readFileSync(git, "utf8").replace('if (bin === "git") {', `if (bin === "git") {
  if (args.includes('fetch') && e.FIXTURE_MUTATE === 'session' && !fs.existsSync(e.FIXTURE_SESSION_CHANGED)) {
    fs.appendFileSync(e.FIXTURE_SESSION, ' '); fs.writeFileSync(e.FIXTURE_SESSION_CHANGED, 'changed');
  }
`));
  f.env.RMD_RECYCLE_DOCKERENV_PATH = join(f.root, "no-dockerenv");
  f.env.RMD_RECYCLE_HOST_LOCK = join(f.root, "recycle.lock");
  f.env.RMD_RECYCLE_WAIT_S = "1";
  f.env.RMD_RECYCLE_POLL_S = "1";
  f.env.FIXTURE_SERVE_STARTED = join(f.root, "serve-started");
  f.env.FIXTURE_SESSION = f.session;
  f.env.FIXTURE_SESSION_CHANGED = join(f.root, "session-changed");
  f.env.RMD_SERVE_ADMIT_MEMINFO_PATH = f.env.RMD_MEMINFO;
  f.env.RMD_SERVE_ADMIT_VMSTAT_PATH = join(f.root, "vmstat");
  f.env.RMD_SERVE_ADMIT_PSI_PATH = join(f.root, "psi");
  writeFileSync(f.env.RMD_SERVE_ADMIT_VMSTAT_PATH, "pswpin 0\n");
  writeFileSync(f.env.RMD_SERVE_ADMIT_PSI_PATH, "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n");
  return { ...f, pin };
}

test("selected shell shadow reaches real lifecycle and heartbeat consumers: generated deploy-run supervisor", t => {
  const f = supervisorFixture(t);
  const historical = bash32(t), historicalBin = join(f.root, "historical-bin"); mkdirSync(historicalBin);
  symlinkSync(historical.shell, join(historicalBin, "bash"));
  f.env.PATH = `${historicalBin}:${f.env.PATH}`;
  Object.assign(f.env, historical.env);
  const offset = f.rows().length;
  const launch = f.run(join(f.output, "launcher"), [], { FIXTURE_RUNNING: "1" }, historical.shell);
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  assert.match(launch.stdout, /asking the supervisor/);
  const call = f.receipts().find(c => c.bin === "rmd" && c.args[0] === "deploy-run");
  assert.ok(call, launch.stdout + launch.stderr);
  assert.deepEqual(call.args.slice(-4), ["--selected-registry-shadow", f.session, "--selected-registry-pin", f.pin]);
  assert.ok(f.rows().slice(offset).some(r => r.action === "recycle"), launch.stdout + launch.stderr);
  for (const name of ["remudero-daemon", "remudero-serve"]) {
    assert.ok(f.receipts().some(c => c.bin === "docker" && c.args[0] === "run" && c.args.includes(name)), launch.stdout + launch.stderr);
  }
  assert.ok(f.rows().slice(offset).some(r => r.action === "serve"), launch.stdout + launch.stderr);
});

for (const mutation of ["pull", "session"] as const) {
test(`selected shell revisions invalidate generated child and heartbeat observations: deploy-run children after ${mutation}`, t => {
  const f = supervisorFixture(t), offset = f.rows().length;
  const launch = f.run(join(f.output, "launcher"), [], { FIXTURE_RUNNING: "1", FIXTURE_MUTATE: mutation });
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  for (const action of ["recycle", "serve"]) {
    const rows = f.rows().slice(offset).filter(r => r.action === action);
    assert.ok(rows.length >= 2, `${action}: ${launch.stdout + launch.stderr}`);
    assert.equal(rows.at(-1)?.reason, mutation === "session" ? "session_changed" : "digest_mismatch", action);
    assert.equal(rows.at(-1)?.selected_outcome, "would-refuse", action);
  }
  assert.equal(readFileSync(f.session, "utf8").endsWith(" "), mutation === "session");
  assert.equal(createHash("sha256").update(readFileSync(f.session, "utf8").trimEnd()).digest("hex"), f.pin);
  const workerCalls = f.receipts().filter(c => c.bin === "docker" && c.args[0] === "run");
  assert.ok(workerCalls.some(c => c.args.includes("remudero-daemon")));
  assert.ok(workerCalls.some(c => c.args.includes("remudero-serve")));
  for (const secret of [f.session, f.selected, f.pin]) {
    assert.ok(!JSON.stringify(workerCalls).includes(secret));
    assert.ok(!(launch.stdout + launch.stderr).includes(secret));
  }
});
}

test("selected shell defaults and failures remain shadow only without live effects: supervisor transports", t => {
  const f = fixture(t), deploy = join(f.root, "deploy"); mkdirSync(deploy);
  const recycler = join(deploy, "recycle-container.sh"), serve = join(deploy, "serve-container.sh");
  const header = "# --selected-registry-shadow)\n# --selected-registry-pin)\n";
  const body = "printf '%s\\n' \"$@\"\n";
  writeFileSync(recycler, header + body); writeFileSync(serve, header + body);
  const binding = { session: f.session, pin: "a".repeat(64) };
  const exec = selectedRegistryLifecycleExec(f.root, binding);
  binding.session = "changed after capture";
  const expected = ["--selected-registry-shadow", f.session, "--selected-registry-pin", binding.pin];
  assert.deepEqual(exec("bash", [recycler, "--instance", "core"]).trim().split("\n"), ["--instance", "core", ...expected]);
  assert.deepEqual(exec("bash", ["-c", 'shift; exec bash "$@"', "recycle-wait", "15", recycler]).trim().split("\n"), expected);
  assert.deepEqual(exec("env", ["RMD_STATE_DIR=fixture", "bash", serve, "--replace"]).trim().split("\n"), ["--replace", ...expected]);
  const legacy = selectedRegistryLifecycleExec(f.root, {});
  assert.equal(legacy("bash", [recycler, "--instance", "core"]), "--instance\ncore\n");
  assert.equal(selectedRegistryLifecycleExec(f.root, { pin: binding.pin })("bash", [recycler, "--instance", "core"]), "--instance\ncore\n");
  assert.equal(selectedRegistryLifecycleExec(f.root, { session: f.session })("bash", [recycler, "--instance", "core"]), "--instance\ncore\n");
  assert.equal(exec(process.execPath, ["-e", "console.log(process.argv.slice(1).join(','))", recycler]), recycler + "\n",
    "a matching path in an unrelated command never admits the private transport");
  const other = join(f.root, "other/deploy"); mkdirSync(other, { recursive: true });
  const otherRecycler = join(other, "recycle-container.sh"); writeFileSync(otherRecycler, header + body);
  assert.equal(exec("bash", [otherRecycler, "--instance", "core"]), "--instance\ncore\n",
    "the same child name in another checkout is outside this binding");
  writeFileSync(recycler, "# --selected-registry-shadow)\n" + body);
  assert.equal(exec("bash", [recycler, "--instance", "core"]), "--instance\ncore\n", "both transport options must be supported");
  writeFileSync(recycler, body);
  assert.equal(exec("bash", [recycler, "--instance", "core"]), "--instance\ncore\n", "old grammar keeps legacy argv");
  rmSync(recycler); symlinkSync(serve, recycler);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  assert.equal(exec("bash", [recycler, "--instance", "core"]), "--instance\ncore\n", "unadmitted file symlink stays legacy");
  rmSync(recycler); mkdirSync(recycler);
  assert.throws(() => exec("bash", [recycler]));
  rmSync(recycler, { recursive: true });
  assert.throws(() => exec("bash", [recycler]));
  assert.equal(errors.length, 3, "header failures have an explicit unrecorded diagnostic");
  writeFileSync(recycler, header + `printf '%s\\n' "$*" >&2\nprintf '%s\\n' "$*"\nexit 75\n`);
  assert.throws(() => exec("bash", [recycler]), (error: unknown) => {
    const failure = error as Error & { status: number; stdout: string; stderr: string };
    assert.equal(failure.status, 75, "serve admission/refusal status must survive redaction");
    for (const value of [failure.message, failure.stdout, failure.stderr]) {
      assert.ok(!value.includes(f.session) && !value.includes(binding.pin));
    }
    return true;
  });
  assert.throws(() => exec("bash", [recycler], { env: { PATH: join(f.root, "absent-bin") } }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", "a real spawn refusal retains its OS code");
  const read = t.mock.method(fs, "readSync", () => { throw "private read error"; });
  const spawn = t.mock.method(childProcess, "execFileSync", () => "legacy");
  syncBuiltinESMExports();
  try { assert.equal(exec("bash", [recycler]), "legacy"); }
  finally { read.mock.restore(); spawn.mock.restore(); syncBuiltinESMExports(); }
  const failure = t.mock.method(childProcess, "spawnSync", () => { throw null; });
  syncBuiltinESMExports();
  try { assert.throws(() => exec("bash", [recycler]), /trusted lifecycle child failed/); }
  finally { failure.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(!JSON.stringify(errors).includes(f.session));
});

test("selected shell shadow reaches real lifecycle and heartbeat consumers", async t => {
  const f = registryShellFixture(t), pin = f.capture();
  const installed = f.install();
  assert.equal(installed.status, 0, installed.stderr);
  const launched = f.run(join(f.output, "launcher"), ["--boot"]);
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  const beat = f.run(join(REPO_ROOT, "scripts/fleet-heartbeat.sh"), ["--selected-registry-shadow", f.session]);
  assert.equal(beat.status, 0, beat.stderr);
  assert.ok(f.receipts().some(c => c.bin === "docker" && c.args[0] === "run"), "rendered launcher really launches a child");
  assert.ok(f.receipts().some(c => c.bin === "git" && c.args.includes("push")), "real heartbeat reaches publication");
  assert.match(readFileSync(f.payload, "utf8"), /mem_remudero-daemon_current_mib=1/);
  for (const action of ["install", "launcher", "heartbeat"]) assert.ok(f.rows().some(row => row.action === action), action);
  assert.ok(f.rows().every(row => row.binding_digest === createHash("sha256").update(f.text).digest("hex")));
  assert.equal(createHash("sha256").update(readFileSync(f.session)).digest("hex"), pin);
  const refresh = refreshFixture(t), result = refresh.run(["--selected-registry-shadow", refresh.session]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.some(call => call.startsWith("run ")));
  assert.ok(refresh.rows().some(row => row.action === "field-trials"));
  const serve = f.run(join(REPO_ROOT, "deploy/serve-container.sh"), ["--replace"]);
  assert.equal(serve.status, 0, serve.stdout + serve.stderr);
  const selectedServe = f.run(join(REPO_ROOT, "deploy/serve-container.sh"), ["--replace", "--selected-registry-shadow", f.session]);
  assert.equal(selectedServe.status, 0, selectedServe.stdout + selectedServe.stderr);
  assert.ok(f.rows().some(row => row.action === "serve"));
  const host = f.run(join(REPO_ROOT, "deploy/host-update.sh"), ["--print-daemon-run", "--selected-registry-shadow", f.session]);
  assert.equal(host.status, 0, host.stdout + host.stderr);
  assert.ok(f.rows().some(row => row.action === "host-update"));
});

test("selected shell shadow reaches real lifecycle and heartbeat consumers: installed field trials command", t => {
  const historical = bash32(t);
  for (const interpreter of [{ shell: "bash", env: {} }, historical]) {
    const f = refreshFixture(t);
    const installer = join(REPO_ROOT, "deploy/install-field-trials-refresh.sh");
    const installed = join(f.root, ".local/bin/rmd-field-trials-refresh");
    const install = f.run(["--install"], installer, interpreter.shell, interpreter.env);
    assert.equal(install.status, 0, install.stderr);
    assert.equal(f.run(["--check"], installer, interpreter.shell, interpreter.env).status, 0);
    const trap = join(f.root, "untrusted-sibling-ran");
    writeFileSync(join(f.root, ".local/bin/registry-shadow.sh"), `touch '${trap}'\nexit 91\n`);
    const legacy = f.run([], installed, interpreter.shell, interpreter.env);
    const qualified = f.run(["--selected-registry-shadow", f.session], installed, interpreter.shell, interpreter.env);
    assert.equal(qualified.status, 0, qualified.stderr);
    assert.equal(qualified.stdout, legacy.stdout);
    assert.equal(qualified.stderr, legacy.stderr);
    assert.deepEqual(qualified.calls, legacy.calls, "installed qualification preserves actual Docker arguments");
    assert.equal(existsSync(trap), false, "installed command never sources a sibling from the command directory");
    const rows = f.rows();
    assert.equal(rows.filter(row => row.action === "field-trials").length, 3,
      "the installed command observes routing, credential and snapshot boundaries through the real entry");
    assert.ok(rows.every(row => row.binding_digest === createHash("sha256")
      .update(readFileSync(f.legacyRegistry)).digest("hex")));
    for (const stateDir of [join(f.root, "missing-trusted-checkout"), "relative-unsupported"]) {
      const missing = f.run(["--selected-registry-shadow", f.session], installed, interpreter.shell,
        { ...interpreter.env, RMD_STATE_DIR: stateDir });
      assert.equal(missing.status, legacy.status, missing.stderr);
      assert.equal(missing.stdout, legacy.stdout);
      assert.deepEqual(missing.calls, legacy.calls);
      assert.match(missing.stderr, /instance_registry\.shell_shadow_unrecorded/);
      assert.equal(f.rows().length, rows.length, "missing or unsupported trusted checkout stays unrecorded");
      assert.equal(existsSync(trap), false);
    }
  }
});

for (const phase of ["capture", "observation"] as const) {
test(`selected shell defaults and failures remain shadow only without live effects: observer deadlines (${phase})`, t => {
  const historical = bash32(t);
  for (const interpreter of [{ shell: "bash", env: {} }, historical]) {
      const f = registryShellFixture(t);
      const script = join(REPO_ROOT, "deploy/host-update.sh");
      const legacy = f.run(script, ["--print-daemon-run"], interpreter.env, interpreter.shell);
      assert.equal(legacy.status, 0, legacy.stderr);
      const calls = join(f.root, "observer.calls");
      const released = join(f.root, "observer-released");
      // The unhealthy transport releases itself after 15s so deleting the deadline
      // fails assertions without leaving a permanently hung test or descendant.
      writeFileSync(join(f.root, "transports/node"), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
const phase = args.includes('--capture') ? 'capture' : 'observation';
fs.appendFileSync(${JSON.stringify(calls)}, phase + '\\n');
if (phase === ${JSON.stringify(phase)}) {
  cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {stdio:'inherit'});
  setTimeout(() => { fs.writeFileSync(${JSON.stringify(released)}, phase); process.exit(93); }, 15000);
} else {
  const result = cp.spawnSync(process.execPath, args, {stdio:'inherit'});
  process.exit(result.status ?? 94);
}
`, { mode: 0o700 });
      const qualified = f.run(script, ["--print-daemon-run", "--selected-registry-shadow", f.session],
        interpreter.env, interpreter.shell);
      assert.equal(qualified.status, legacy.status, qualified.stdout + qualified.stderr);
      assert.equal(qualified.stdout, legacy.stdout, "legacy output continues after an observer deadline");
      assert.ok(readFileSync(calls, "utf8").split("\n").includes(phase), "the intended unhealthy observer actually ran");
      assert.equal(existsSync(released), false, `${phase} must be killed before the fixture releases itself`);
      assert.match(qualified.stderr, /instance_registry\.shell_shadow_unrecorded/);
      assert.ok(!qualified.stderr.includes(f.session) && !qualified.stderr.includes(f.selected));
      if (phase === "observation") {
        rmSync(join(f.root, "transports/node"));
        f.capture();
        assert.equal(f.install().status, 0);
        // Reuse the hung transport at the independently executed generated boundary.
        writeFileSync(join(f.root, "transports/node"), `#!/bin/sh\nexec sleep 15\n`, { mode: 0o700 });
        const launched = f.run(join(f.output, "launcher"), ["--boot"], interpreter.env, interpreter.shell);
        assert.equal(launched.status, 0, launched.stdout + launched.stderr);
        assert.match(launched.stderr, /instance_registry\.shell_shadow_unrecorded/);
        assert.ok(f.receipts().some(c => c.bin === "docker" && c.args[0] === "run"),
          "a hung observer cannot prevent the generated launcher's actual legacy child effect");
      }
  }
});
}

test("selected shell shadow reaches real lifecycle and heartbeat consumers across generated sudo convergence", t => {
  const f = registryShellFixture(t), pin = f.capture();
  assert.equal(f.install().status, 0);
  writeFileSync(join(f.output, "systemd/rmd-fleet.service"), "drifted\n");
  const offset = f.rows().length;
  const launch = f.run(join(f.output, "launcher"), [], { FIXTURE_RUNNING: "1", FIXTURE_MUTATE: "fetch" });
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  assert.match(launch.stdout, /units DRIFTED/);
  const elevated = f.receipts().filter(c => c.bin === "sudo");
  assert.ok(elevated.some(c => c.args.includes("--install") && c.args.includes(f.session)), "generated installer argv crosses elevation");
  assert.ok(elevated.some(c => c.args.includes("-u") && c.args.includes(`#${f.env.FIXTURE_UID}`)
    && c.args.includes("node")), "elevated observer returns to the session owner");
  const writes = f.rows().slice(offset).filter(r => r.action === "install");
  assert.ok(writes.length > 0, "the child installer itself records its write boundaries");
  assert.ok(writes.every(r => r.reason === "digest_mismatch"), "mutation during fetch reaches the independently launched installer");
  assert.equal(createHash("sha256").update(readFileSync(f.session)).digest("hex"), pin);
  assert.match(readFileSync(join(f.output, "systemd/rmd-fleet.service"), "utf8"), /\[Service\]/, "legacy converge still repairs units");
  writeFileSync(join(f.output, "systemd/rmd-fleet.service"), "drifted after observer failure\n");
  const failed = f.run(join(f.output, "launcher"), [], { FIXTURE_RUNNING: "1", FIXTURE_DROP_FAIL: "1" });
  assert.equal(failed.status, 0, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /shell_shadow_unrecorded/);
  assert.match(readFileSync(join(f.output, "systemd/rmd-fleet.service"), "utf8"), /\[Service\]/,
    "even failed owner delegation cannot suppress the elevated legacy write");
});

test("selected shell revisions invalidate generated child and heartbeat observations", async t => {
  const f = registryShellFixture(t), pin = f.capture();
  assert.equal(f.install().status, 0);
  writeFileSync(f.selected, f.text.replace("mode: shadow", "mode: live"));
  const launched = f.run(join(f.output, "launcher"), ["--boot"]);
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  const launcherRows = f.rows().filter(r => r.action === "launcher");
  assert.ok(launcherRows.length > 0 && launcherRows.every(r => r.reason === "digest_mismatch"));
  writeFileSync(f.selected, f.text);
  const start = f.rows().length;
  const beat = f.run(join(REPO_ROOT, "scripts/fleet-heartbeat.sh"), ["--selected-registry-shadow", f.session],
    { FIXTURE_MUTATE: "measurement", FIXTURE_SAME_NAME: "1" });
  assert.equal(beat.status, 0, beat.stderr);
  const emptyIdentity = createHash("sha256").update("").digest("hex");
  const measurements = f.rows().slice(start).filter(r => r.action === "heartbeat" && r.target_digest !== emptyIdentity);
  assert.equal(measurements.length, 2, "each independently measured child rechecks after Docker returns");
  assert.ok(measurements.every(r => r.reason === "digest_mismatch" && r.selected_outcome === "would-refuse"));
  assert.notEqual(measurements[0]!.target_digest, measurements[1]!.target_digest, "same-named containers retain different actual identities");
  assert.equal(readFileSync(f.payload, "utf8").split("mem_remudero-daemon_current_mib=1").length - 1, 2);
  assert.equal(createHash("sha256").update(readFileSync(f.session)).digest("hex"), pin, "later children cannot recapture");
});

test("selected shell revisions invalidate generated child and heartbeat observations: host update launch and measurement", t => {
  const snapshot = registryShellFixture(t), snapshotPin = snapshot.capture();
  const nightly = snapshot.run(join(REPO_ROOT, "deploy/host-update.sh"),
    ["--reclaim-only", "--selected-registry-shadow", snapshot.session], { FIXTURE_MUTATE: "snapshot" });
  assert.equal(nightly.status, 0, nightly.stdout + nightly.stderr);
  assert.ok(snapshot.receipts().some(c => c.bin === "docker" && c.args[0] === "run"
    && c.args.includes("--entrypoint") && c.args.includes("node")), "the real snapshot child launched");
  assert.match(nightly.stdout, /state snapshot.*verified/);
  const snapshotRows = snapshot.rows().filter(r => r.action === "host-update");
  assert.ok(snapshotRows.length >= 3, "startup, child launch and closing measurement each observe");
  assert.notEqual(snapshotRows[0]?.reason, "digest_mismatch", "startup saw the original selected bytes");
  assert.ok(snapshotRows.slice(1).every(r => r.reason === "digest_mismatch"
    && r.selected_outcome === "would-refuse"), "every later boundary sees the revision");
  assert.equal(createHash("sha256").update(readFileSync(snapshot.session)).digest("hex"), snapshotPin);

  const final = registryShellFixture(t), finalPin = final.capture();
  const normal = final.run(join(REPO_ROOT, "deploy/host-update.sh"),
    ["--selected-registry-shadow", final.session], { FIXTURE_MUTATE: "pull" });
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  assert.ok(final.receipts().some(c => c.bin === "docker" && c.args[0] === "pull"), "legacy pull actually ran");
  assert.match(normal.stdout, /host-update: AFTER/);
  const finalRows = final.rows().filter(r => r.action === "host-update");
  assert.equal(finalRows.length, 2, "normal run checks startup and final measurement");
  assert.notEqual(finalRows[0]?.reason, "digest_mismatch");
  assert.equal(finalRows[1]?.reason, "digest_mismatch");
  assert.equal(finalRows[1]?.selected_outcome, "would-refuse");
  assert.equal(createHash("sha256").update(readFileSync(final.session)).digest("hex"), finalPin);
});

test("selected shell revisions invalidate generated child and heartbeat observations: host update missing selection", t => {
  for (const [args, mutation, effect] of [
    [["--reclaim-only"], "snapshot-delete", "run"],
    [[], "pull-delete", "pull"],
  ] as const) {
    const f = registryShellFixture(t); f.capture();
    const run = f.run(join(REPO_ROOT, "deploy/host-update.sh"),
      [...args, "--selected-registry-shadow", f.session], { FIXTURE_MUTATE: mutation });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(f.receipts().some(c => c.bin === "docker" && c.args[0] === effect), effect);
    const rows = f.rows().filter(r => r.action === "host-update");
    assert.ok(rows.length >= 2);
    assert.notEqual(rows[0]?.reason, "missing", "startup read the selected file");
    assert.ok(rows.slice(1).every(r => r.reason === "missing"
      && r.selected_state === "unknown" && r.selected_outcome === "would-refuse"),
    `missing selection remains an explicit invalidation at later observations: ${JSON.stringify(rows)}`);
  }
});

test("selected shell revisions invalidate generated child and heartbeat observations: host update recheck deletion falsifiers", t => {
  const source = readFileSync(join(REPO_ROOT, "deploy/host-update.sh"), "utf8");
  const mutantRoot = mkdtempSync(join(tmpdir(), "rmd-host-update-recheck-mutant-"));
  t.after(() => rmSync(mutantRoot, { recursive: true, force: true }));
  const mutantDeploy = join(mutantRoot, "deploy"), script = join(mutantDeploy, "host-update.sh");
  mkdirSync(mutantDeploy);
  for (const name of readdirSync(join(REPO_ROOT, "deploy"))) {
    if (name !== "host-update.sh" && name !== "registry-shadow.sh")
      symlinkSync(join(REPO_ROOT, "deploy", name), join(mutantDeploy, name));
  }
  const shadowSource = readFileSync(join(REPO_ROOT, "deploy/registry-shadow.sh"), "utf8");
  const localShadow = shadowSource.replace(/^registry_shadow_root=.*$/m, `registry_shadow_root='${REPO_ROOT}'`);
  assert.notEqual(localShadow, shadowSource);
  writeFileSync(join(mutantDeploy, "registry-shadow.sh"), localShadow);
  const launchArm = '    registry_shadow_observe host-update "" "" host "$snap_root|$STATE_SNAPSHOT_IMAGE"\n';
  const measureArm = 'registry_shadow_observe host-update "" "" host "$STATE_DIR|$DAEMON_REPO"\nAFTER_DIGEST=';
  for (const [arm, mutation, args, effect, expectedRows] of [
    [launchArm, "snapshot", ["--reclaim-only"], "run", 4],
    [measureArm, "pull", [], "pull", 2],
  ] as const) {
    const f = registryShellFixture(t); f.capture();
    const removed = source.replace(arm, arm === measureArm ? "AFTER_DIGEST=" : "");
    assert.notEqual(removed, source, "the mutant deletes an actual observation call");
    writeFileSync(script, removed, { mode: 0o700 });
    let offset = 0;
    const without = f.run(script, [...args, "--selected-registry-shadow", f.session], { FIXTURE_MUTATE: mutation });
    assert.equal(without.status, 0, without.stdout + without.stderr);
    assert.ok(existsSync(f.session + ".observations"), without.stdout + without.stderr);
    const missingRows = f.rows().slice(offset).filter(r => r.action === "host-update");
    assert.equal(missingRows.length, expectedRows - 1, "deleted arm loses precisely its boundary observation");
    assert.ok(f.receipts().some(c => c.bin === "docker" && c.args[0] === effect), "legacy effect still runs");
    writeFileSync(f.selected, f.text);
    writeFileSync(script, source, { mode: 0o700 });
    offset = f.rows().length;
    const restored = f.run(script, [...args, "--selected-registry-shadow", f.session], { FIXTURE_MUTATE: mutation });
    assert.equal(restored.status, without.status, restored.stdout + restored.stderr);
    const restoredRows = f.rows().slice(offset).filter(r => r.action === "host-update");
    assert.equal(restoredRows.length, expectedRows, "exact restoration recovers the observation");
    assert.ok(restoredRows.slice(1).every(r => r.reason === "digest_mismatch"));
  }
});

test("selected shell revisions invalidate generated child and heartbeat observations: deleted forwarding and pin falsifiers", t => {
  const f = registryShellFixture(t); f.capture();
  assert.equal(f.install().status, 0);
  const launcher = join(f.output, "launcher"), source = readFileSync(launcher, "utf8");
  const withoutForwarding = source.replace(/^    INSTALLER_SHADOW_ARGS=\(.*$/m, "    INSTALLER_SHADOW_ARGS=()");
  assert.notEqual(withoutForwarding, source);
  writeFileSync(launcher, withoutForwarding);
  writeFileSync(join(f.output, "systemd/rmd-fleet.service"), "drifted\n");
  let offset = f.rows().length;
  const dropped = f.run(launcher, [], { FIXTURE_RUNNING: "1" });
  assert.equal(dropped.status, 0, dropped.stdout + dropped.stderr);
  assert.ok(f.receipts().some(c => c.bin === "sudo" && c.args.includes("--install")));
  assert.equal(f.rows().slice(offset).filter(r => r.action === "install").length, 0,
    "deleting real forwarding destroys child evidence while legacy convergence still succeeds");
  writeFileSync(launcher, source);
  writeFileSync(join(f.output, "systemd/rmd-fleet.service"), "drifted again\n");
  offset = f.rows().length;
  const restored = f.run(launcher, [], { FIXTURE_RUNNING: "1" });
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.ok(f.rows().slice(offset).some(r => r.action === "install"), "exact restoration restores child evidence");
  const wrongPin = source.replace(/^registry_shadow_pin=.*$/m, `registry_shadow_pin=${"0".repeat(64)}`);
  assert.notEqual(wrongPin, source);
  writeFileSync(launcher, wrongPin); offset = f.rows().length;
  const rebound = f.run(launcher, ["--boot"]);
  assert.equal(rebound.status, 0, rebound.stderr);
  const reboundRows = f.rows().slice(offset).filter(r => r.action === "launcher");
  assert.ok(reboundRows.length > 0 && reboundRows.every(r => r.reason === "session_changed"));
  writeFileSync(launcher, source); offset = f.rows().length;
  const pinned = f.run(launcher, ["--boot"]);
  assert.equal(pinned.status, 0, pinned.stderr);
  const rows = f.rows().slice(offset).filter(r => r.action === "launcher");
  assert.ok(rows.length > 0 && rows.every(r => r.reason !== "session_changed"));
  assert.equal(readFileSync(launcher, "utf8"), source);
});

test("selected shell revisions invalidate generated child and heartbeat observations: real reader recheck falsifier", t => {
  const f = registryShellFixture(t), pin = f.capture();
  const source = readFileSync(join(REPO_ROOT, "src/selected-registry-shadow-main.ts"), "utf8");
  const mutant = source.replace("readSelectedInstanceRegistry({ ...session.input, signal })",
    "readSelectedInstanceRegistry({ ...session.input, expectedDigest: undefined, signal })");
  assert.notEqual(mutant, source);
  const entry = join(f.root, "observer.ts");
  symlinkSync(join(REPO_ROOT, "src/lib"), join(f.root, "lib"));
  writeFileSync(join(f.root, "package.json"), '{"type":"module"}\n');
  writeFileSync(f.selected, f.text + "# revised\n");
  const args = ["--shadow", "--session", f.session, "--pin", pin, "--consumer", "heartbeat",
    "--instance", "core", "--repository", "craigoley/remudero", "--namespace", "host"];
  const run = (text: string) => {
    writeFileSync(entry, text);
    const r = spawnSync(process.execPath, ["--import", join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs"), entry, ...args],
      { env: f.env, encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    return f.rows().at(-1)!;
  };
  assert.equal(run(source).reason, "digest_mismatch");
  assert.equal(run(mutant).selected_outcome, "would-observe", "removing the pinned digest admits revised bytes");
  assert.equal(run(source).reason, "digest_mismatch", "exact restoration refuses the revision again");
});

test("selected shell qualification preserves mixed version legacy effects", t => {
  const f = refreshFixture(t);
  const pinned = join(REPO_ROOT, "test/fixtures/selected-registry-old");
  const provenance = JSON.parse(readFileSync(join(pinned, "PROVENANCE.json"), "utf8"));
  for (const [path, digest] of Object.entries(provenance.files)) {
    assert.equal(createHash("sha256").update(readFileSync(join(pinned, path))).digest("hex"), digest);
  }
  t.diagnostic(`old shell revision ${provenance.revision}`);
  const old = f.run([], join(pinned, "deploy/field-trials-refresh.sh"));
  const before = f.run();
  const after = f.run(["--selected-registry-shadow", f.session]);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(after.status, before.status);
  assert.equal(after.stdout, before.stdout);
  assert.deepEqual(after.calls, before.calls, "qualification cannot change Docker arguments or effects");
  assert.equal(old.status, before.status, old.stderr);
  assert.equal(old.stdout, before.stdout);
  const withoutVersionReceipt = (calls: string[], script: string) => {
    const bytes = readFileSync(script);
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.ok(calls.at(-1)?.endsWith(`--refresh-script-blob ${blob}`), "each version reports its own actual script blob");
    return calls.map(call => call.replace(`--refresh-script-blob ${blob}`, "--refresh-script-blob VERIFIED_VERSION"));
  };
  assert.deepEqual(withoutVersionReceipt(old.calls, join(pinned, "deploy/field-trials-refresh.sh")),
    withoutVersionReceipt(before.calls, join(REPO_ROOT, "deploy/field-trials-refresh.sh")),
    "legacy effects agree apart from the separately verified script-version receipt");
  assert.ok(f.rows().length > 0);
  const host = registryShellFixture(t);
  host.capture();
  assert.equal(host.install(false).status, 0);
  const launcher = join(host.output, "launcher");
  const legacy = host.run(launcher, ["--boot"]);
  const oldEffects = host.receipts().filter(c => c.bin === "docker");
  writeFileSync(join(host.root, "calls.ndjson"), "");
  assert.equal(host.install().status, 0);
  const qualified = host.run(launcher, ["--boot"]);
  assert.equal(qualified.status, legacy.status, qualified.stderr);
  assert.equal(qualified.stdout, legacy.stdout);
  assert.deepEqual(host.receipts().filter(c => c.bin === "docker"), oldEffects);
  // Execute the generated convergence against a real older installer. Dependencies
  // remain the maintained public templates; the older executable's bytes are pinned.
  const oldDeploy = join(host.root, "old-deploy"); mkdirSync(oldDeploy);
  for (const name of readdirSync(join(REPO_ROOT, "deploy"))) symlinkSync(
    join(name === "install-host-units.sh" ? pinned : REPO_ROOT, "deploy", name), join(oldDeploy, name));
  rmSync(join(host.state, "daemon-install/deploy"));
  symlinkSync(oldDeploy, join(host.state, "daemon-install/deploy"));
  writeFileSync(join(host.output, "systemd/rmd-fleet.service"), "drifted\n");
  const offset = host.receipts().length;
  const mixed = host.run(launcher, [], { FIXTURE_RUNNING: "1" });
  assert.equal(mixed.status, 0, mixed.stdout + mixed.stderr);
  assert.match(mixed.stdout, /units DRIFTED/);
  const install = host.receipts().slice(offset).find(c => c.bin === "sudo" && c.args.includes("--install"));
  assert.ok(install, "generated launcher must execute the older child, never just probe it");
  assert.ok(!install.args.includes("--selected-registry-shadow") && !install.args.includes(host.session));
  assert.match(readFileSync(join(host.output, "systemd/rmd-fleet.service"), "utf8"), /\[Service\]/);
  const historical = bash32(t);
  for (const script of [join(pinned, "deploy/field-trials-refresh.sh"), join(REPO_ROOT, "deploy/field-trials-refresh.sh")]) {
    const result = f.run([], script, historical.shell, historical.env);
    assert.equal(result.status, before.status, result.stderr);
    assert.equal(result.stdout, before.stdout);
    assert.deepEqual(withoutVersionReceipt(result.calls, script),
      withoutVersionReceipt(before.calls, join(REPO_ROOT, "deploy/field-trials-refresh.sh")));
  }
  const qualified32 = f.run(["--selected-registry-shadow", f.session], undefined,
    historical.shell, historical.env);
  assert.equal(qualified32.status, before.status, qualified32.stderr);
  assert.equal(qualified32.stdout, before.stdout);
  assert.deepEqual(qualified32.calls, before.calls);
  const h32 = registryShellFixture(t); h32.capture();
  const historicalBin = join(h32.root, "historical-bin"); mkdirSync(historicalBin);
  symlinkSync(historical.shell, join(historicalBin, "bash"));
  h32.env.PATH = `${historicalBin}:${h32.env.PATH}`;
  h32.env.LD_LIBRARY_PATH = historical.env.LD_LIBRARY_PATH;
  const oldDeploy32 = join(h32.root, "old-deploy"); mkdirSync(oldDeploy32);
  for (const name of readdirSync(join(REPO_ROOT, "deploy"))) symlinkSync(
    join(name === "install-host-units.sh" ? pinned : REPO_ROOT, "deploy", name), join(oldDeploy32, name));
  const oldInstall32 = h32.run(join(oldDeploy32, "install-host-units.sh"), ["--install"], {}, historical.shell);
  assert.equal(oldInstall32.status, 0, oldInstall32.stdout + oldInstall32.stderr);
  const oldBoot32 = h32.run(join(h32.output, "launcher"), ["--boot"], {}, historical.shell);
  assert.equal(oldBoot32.status, 0, oldBoot32.stdout + oldBoot32.stderr);
  const oldDocker32 = h32.receipts().filter(c => c.bin === "docker");
  writeFileSync(join(h32.root, "calls.ndjson"), "");
  const newInstall32 = h32.run(join(REPO_ROOT, "deploy/install-host-units.sh"), ["--install"], {}, historical.shell);
  assert.equal(newInstall32.status, oldInstall32.status, newInstall32.stdout + newInstall32.stderr);
  const newBoot32 = h32.run(join(h32.output, "launcher"), ["--boot"], {}, historical.shell);
  assert.equal(newBoot32.status, oldBoot32.status, newBoot32.stdout + newBoot32.stderr);
  assert.equal(newBoot32.stdout, oldBoot32.stdout);
  const newDocker32 = h32.receipts().filter(c => c.bin === "docker");
  assert.deepEqual(newDocker32, oldDocker32,
    "Bash 3.2 old and new installers and rendered launchers keep no-option Docker effects");
  const qualifiedOffset = h32.receipts().length;
  const install32 = h32.run(join(REPO_ROOT, "deploy/install-host-units.sh"),
    ["--install", "--selected-registry-shadow", h32.session], {}, historical.shell);
  assert.equal(install32.status, 0, install32.stderr);
  const boot32 = h32.run(join(h32.output, "launcher"), ["--boot"], {}, historical.shell);
  assert.equal(boot32.status, oldBoot32.status, boot32.stdout + boot32.stderr);
  assert.equal(boot32.stdout, oldBoot32.stdout);
  assert.deepEqual(h32.receipts().slice(qualifiedOffset).filter(c => c.bin === "docker"), newDocker32,
    "Bash 3.2 qualification leaves generated launcher Docker arguments and effects unchanged");
  assert.ok(h32.receipts().some(c => c.bin === "docker" && c.args[0] === "run"));
  assert.ok(h32.rows().some(r => r.action === "launcher"));
  t.diagnostic(`old/new scripts and generated launchers executed with Bash ${historical.version}`);
});

test("selected shell defaults and failures remain shadow only without live effects: input matrix and healthy stop", t => {
  const github = ghShim([{ when: "", exit: 97 }]);
  t.after(() => rmSync(github.dir, { recursive: true, force: true }));
  const cases = ["absent", "empty", "missing", "malformed", "truncated", "symlink", "contract", "capability"] as const;
  for (const kind of cases) {
    const f = registryShellFixture(t);
    f.env.PATH = `${github.dir}:${f.env.PATH}`;
    let options = ["--registry", f.selected];
    if (kind === "absent") options = [];
    if (kind === "empty") options = ["--registry", ""];
    if (kind === "missing") rmSync(f.selected);
    if (kind === "malformed") writeFileSync(f.selected, "instances:\n  core:\n    mode: invalid\n");
    if (kind === "truncated") writeFileSync(f.selected, "instances:\n  core:\n    github_repo:");
    if (kind === "symlink") { rmSync(f.selected); symlinkSync(f.legacy, f.selected); }
    if (kind === "contract") options.push("--contract-version", "2");
    if (kind === "capability") options.push("--require-capability", "future-unsupported");
    f.capture(options);
    const legacy = f.run(join(REPO_ROOT, "deploy/host-update.sh"), ["--print-daemon-run"]);
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(existsSync(f.session + ".observations"), false, "environment path and a session file alone do not opt in");
    const selected = f.run(join(REPO_ROOT, "deploy/host-update.sh"),
      ["--print-daemon-run", "--selected-registry-shadow", f.session]);
    assert.equal(selected.status, legacy.status, selected.stderr);
    assert.equal(selected.stdout, legacy.stdout, kind);
    assert.equal(selected.stderr, legacy.stderr, kind);
    assert.equal(f.rows().at(-1)?.selected_state, kind === "absent" ? "absent" : "unknown", kind);
    assert.equal(f.rows().at(-1)?.selected_outcome, "would-refuse", kind);
    assert.ok(!f.receipts().some(c => ["mount", "umount", "az"].includes(c.bin)));
    assert.deepEqual(github.calls(), [], "no GitHub operation may escape the input matrix");
  }
  const githubControl = spawnSync("sh", ["-c", "gh --version"], {
    env: { PATH: `${github.dir}:${process.env.PATH ?? ""}` }, encoding: "utf8",
  });
  assert.equal(githubControl.status, 97, "the shared GitHub guard must intercept and refuse commands");
  assert.deepEqual(github.calls(), ["--version"], "the empty call census above has a recording control");
  const stopped = registryShellFixture(t); stopped.capture();
  assert.equal(stopped.install().status, 0);
  writeFileSync(join(stopped.state, "state/STOP"), "operator hold\n");
  const offset = stopped.receipts().length;
  const stop = stopped.run(join(stopped.output, "launcher"), ["--boot"]);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /state\/STOP present/);
  assert.ok(stopped.rows().some(r => r.action === "launcher"));
  const stopDocker = stopped.receipts().slice(offset).filter(c => c.bin === "docker");
  assert.ok(stopDocker.every(c => ["inspect", "ps", "info"].includes(c.args[0]!)
    || (["container", "image", "network"].includes(c.args[0]!) && c.args[1] === "inspect")),
    `STOP permits only legacy read probes, never child effects: ${JSON.stringify(stopDocker)}`);
  assert.equal(readFileSync(join(stopped.state, "state/STOP"), "utf8"), "operator hold\n");
});

test("selected shell qualification does not disclose private inputs", async t => {
  const f = registryShellFixture(t);
  f.capture();
  // Also cover Docker's name-only -e forwarding: a trusted host environment may
  // contain the private input, but only explicitly admitted values reach workers.
  f.env.RMD_INSTANCE_REGISTRY = f.selected;
  assert.equal(f.install().status, 0);
  const launcher = f.run(join(f.output, "launcher"), ["--boot"]);
  assert.equal(launcher.status, 0, launcher.stderr);
  const beat = f.run(join(REPO_ROOT, "scripts/fleet-heartbeat.sh"), ["--selected-registry-shadow", f.session]);
  assert.equal(beat.status, 0, beat.stderr);
  const publicBytes = readFileSync(f.payload, "utf8");
  assert.match(publicBytes, /beat_host=fixture-host/);
  const workerCalls = f.receipts().filter(c => c.bin === "docker" && ["run", "exec"].includes(c.args[0]!));
  assert.ok(workerCalls.some(c => c.args[0] === "run"), "a real worker launch is the positive control");
  const workerInputs = workerCalls.map(({ bin, args, workerEnv }) => ({ bin, args, workerEnv }));
  assert.ok(workerCalls.some(c => c.workerEnv?.NODE_OPTIONS), "name/value environment transport was actually captured");
  for (const bytes of [publicBytes, JSON.stringify(workerInputs), launcher.stdout + launcher.stderr + beat.stdout + beat.stderr,
    JSON.stringify(f.rows())]) {
    for (const secret of [f.selected, f.session, "private-material-sentinel", f.text.trim()]) assert.ok(!bytes.includes(secret), secret);
  }
  assert.ok(f.rows().every(r => r.publication_permission === "not-granted"));
  assert.ok(!publicBytes.includes("binding_digest="), "a digest grants no public publication field");
});

test("selected shell defaults and failures remain shadow only without live effects", async t => {
  const absent = fixture(t);
  const absentPin = await capture(absent.session);
  assert.equal(await observe(absent.session, absentPin, "install"), 0);
  assert.equal(absent.rows().at(-1)?.selected_state, "absent");
  const invalid = fixture(t);
  const invalidPin = await capture(invalid.session, "relative-invalid-path");
  assert.equal(await observe(invalid.session, invalidPin, "install"), 0);
  assert.equal(invalid.rows().at(-1)?.selected_state, "unknown");
  const sink = fixture(t);
  const sinkPin = await capture(sink.session, sink.registry);
  symlinkSync(join(sink.root, "elsewhere"), sink.session + ".observations");
  const errors: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try { assert.equal(await observe(sink.session, sinkPin, "install"), 1); }
  finally { console.error = original; }
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0]!, /selected-private\.yaml|session\.json|relative-invalid-path/);
  for (const failure of ["sink", "session", "observer"] as const) {
    const f = registryShellFixture(t);
    f.capture();
    assert.equal(f.install().status, 0);
    if (failure === "sink") {
      rmSync(f.session + ".observations");
      symlinkSync(join(f.root, "never-written"), f.session + ".observations");
    } else if (failure === "session") writeFileSync(f.session, "{");
    else writeFileSync(join(f.root, "transports", "node"), "#!/bin/sh\nexit 93\n", { mode: 0o700 });
    const launch = f.run(join(f.output, "launcher"), ["--boot"]);
    assert.equal(launch.status, 0, launch.stdout + launch.stderr);
    assert.match(launch.stderr, /shell_shadow_unrecorded/);
    assert.ok(f.receipts().some(c => c.bin === "docker" && c.args[0] === "run"), `${failure}: legacy child still starts`);
    const beat = f.run(join(REPO_ROOT, "scripts/fleet-heartbeat.sh"), ["--selected-registry-shadow", f.session]);
    assert.equal(beat.status, 0, beat.stderr);
    assert.ok(f.receipts().some(c => c.bin === "git" && c.args.includes("push")), `${failure}: legacy beat still publishes`);
    assert.equal(existsSync(join(f.root, "never-written")), false);
  }
});

test("selected shell child default launches the maintained entry and captures the selected bytes", async t => {
  const f = fixture(t);
  assert.equal(await selectedRegistryShadowChild(REPO_ROOT,
    ["--shadow", "--capture", "--registry", f.registry, "--session", f.session]), 0);
  const session = JSON.parse(readFileSync(f.session, "utf8"));
  assert.equal(session.initial, "ready");
  assert.equal(session.input.cliPath, f.registry);
  assert.equal(session.input.expectedDigest, createHash("sha256").update(f.text).digest("hex"));
});

for (const failure of ["synchronous", "asynchronous"] as const) {
  test(`selected shell child reports ${failure} spawn failure without leaking the transport error`, async t => {
    const f = fixture(t);
    const errors: unknown[][] = [];
    const calls: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
    const spawn = t.mock.method(childProcess, "spawn", ((...args: unknown[]) => {
      calls.push(args);
      const error = new Error(`private-material-sentinel ${f.registry}`);
      if (failure === "synchronous") throw error;
      const child = new EventEmitter();
      process.nextTick(() => child.emit("error", error));
      return child;
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    try {
      assert.equal(await selectedRegistryShadowChild(REPO_ROOT,
        ["--shadow", "--capture", "--session", f.session]), 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.[0], process.execPath);
      assert.deepEqual((calls[0]?.[1] as string[]).slice(-4), ["--shadow", "--capture", "--session", f.session]);
      assert.deepEqual(calls[0]?.[2], { stdio: "inherit" });
      assert.deepEqual(errors, [["instance_registry.shell_shadow_unrecorded", "child_launch_failed"]]);
      assert.equal(existsSync(f.session), false);
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

test("selected shell unsafe session closes its opened handle before reporting observer failure", async t => {
  const f = fixture(t);
  const pin = await capture(f.session, f.registry);
  rmSync(f.session);
  mkdirSync(f.session);
  const realOpen = fsPromises.open;
  let opened: Awaited<ReturnType<typeof realOpen>> | undefined;
  const open = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof realOpen>) => {
    const handle = await realOpen(...args);
    opened = handle;
    return handle;
  });
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  syncBuiltinESMExports();
  try {
    assert.equal(await observe(f.session, pin, "heartbeat"), 1);
    assert.ok(opened, "the unsafe file must have been opened before its metadata was rejected");
    await assert.rejects(opened.stat(), { code: "EBADF" }, "the rejected session handle must be closed");
    assert.deepEqual(errors, [["instance_registry.shell_shadow_unrecorded", "observer_or_sink_failed"]]);
    assert.equal(existsSync(f.session + ".observations"), false);
  } finally {
    open.mock.restore();
    syncBuiltinESMExports();
    await opened?.close();
  }
});
