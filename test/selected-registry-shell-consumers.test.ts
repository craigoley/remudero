// @source-text-subject: qualification mutants delete rendered transport arms and execute the resulting launcher.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectedRegistryShadowMain } from "#src/selected-registry-shadow-main.js";
import { selectedRegistryShadowChild } from "#src/lib/child-entry-argv.js";
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
  const cases = join(f.root, "cases.json"); writeFileSync(cases, "{}\n");
  const env = { ...process.env, HOME: f.root, PATH: `${bin}:${process.env.PATH ?? ""}`,
    DOCKER_CALLS: calls, RMD_INSTANCE_REGISTRY: legacyRegistry, RMD_FIELD_TRIALS_CASE_FILES: cases };
  const run = (args: string[] = [], script = join(REPO_ROOT, "deploy", "field-trials-refresh.sh"), shell = "bash") => {
    writeFileSync(calls, "");
    const result = spawnSync(shell, [script, ...args],
      { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      calls: readFileSync(calls, "utf8").trim().split("\n") };
  };
  return { ...f, legacyRegistry, run };
}

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
  const historical = process.env.RMD_TEST_HISTORICAL_BASH;
  if (historical) {
    const version = spawnSync(historical, ["-c", 'printf "%s" "$BASH_VERSION"'], { encoding: "utf8" });
    assert.match(version.stdout, /^3\.2\./, "the historical control must really be Bash 3.2");
    for (const script of [join(pinned, "deploy/field-trials-refresh.sh"), join(REPO_ROOT, "deploy/field-trials-refresh.sh")]) {
      const result = f.run([], script, historical);
      assert.equal(result.status, before.status, result.stderr);
      assert.deepEqual(withoutVersionReceipt(result.calls, script),
        withoutVersionReceipt(before.calls, join(REPO_ROOT, "deploy/field-trials-refresh.sh")));
    }
    const qualified32 = f.run(["--selected-registry-shadow", f.session], undefined, historical);
    assert.equal(qualified32.status, before.status, qualified32.stderr);
    assert.deepEqual(qualified32.calls, before.calls);
    const h32 = registryShellFixture(t); h32.capture();
    const install32 = h32.run(join(REPO_ROOT, "deploy/install-host-units.sh"),
      ["--install", "--selected-registry-shadow", h32.session], {}, historical);
    assert.equal(install32.status, 0, install32.stderr);
    const boot32 = h32.run(join(h32.output, "launcher"), ["--boot"], {}, historical);
    assert.equal(boot32.status, 0, boot32.stdout + boot32.stderr);
    assert.ok(h32.receipts().some(c => c.bin === "docker" && c.args[0] === "run"));
    assert.ok(h32.rows().some(r => r.action === "launcher"));
    t.diagnostic(`historical scripts and generated launcher executed with ${version.stdout}`);
  } else t.diagnostic("Bash 3.2 UNVERIFIED here; set RMD_TEST_HISTORICAL_BASH for the historical execution control");
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
