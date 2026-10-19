import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ownedFixtureDir } from "../helpers/owned-fixture-dir.js";

const policySource = "deploy/resource-policy.sh";

function fixture(t: TestContext, container = "remudero-daemon") {
  const { dir } = ownedFixtureDir(t, "deploy-revival-policy");
  const state = join(dir, "state-root"), bin = join(dir, "bin"), stubs = join(dir, "stubs");
  const checkout = join(state, "daemon-install"), launcher = join(dir, "rmd-relaunch.sh");
  const calls = join(dir, "docker-calls"), argv = join(dir, "docker-run-argv"), meminfo = join(dir, "meminfo");
  for (const path of [join(state, "state"), bin, stubs, join(checkout, "deploy")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(state, "state", "ledger.ndjson"), '{"step":"fixture.control"}\n');
  writeFileSync(meminfo, "MemTotal:       16371996 kB\n");
  // No real Docker/systemd/privilege or forge access: run the actual rendered launcher with
  // bounded command fixtures. An unknown command refuses instead of falling through to Docker.
  writeFileSync(join(stubs, "docker"), `#!/usr/bin/env bash
set -eu
printf '%s\n' "$1" >> "$FIXTURE_DOCKER_CALLS"
case "$1" in
  ps) exit 0 ;;
  inspect) exit 1 ;;
  rm) exit 0 ;;
  run) printf '%s\\0' "$@" > "$FIXTURE_DOCKER_ARGV"; printf 'fixture-container\\n' ;;
  *) exit 97 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(stubs, "findmnt"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${stubs}:${process.env.PATH}`,
    RMD_STATE_DIR: state,
    RMD_DAEMON_CONTAINER: container,
    RMD_UNIT_DIR: join(dir, "systemd"),
    RMD_BIN_DIR: bin,
    RMD_LAUNCHER_PATH: launcher,
    RMD_REVIVAL_LOG: join(dir, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_SERVICE_UID: "42424",
    RMD_MEMINFO_PATH: meminfo,
    RMD_CASH_SECRET_DIR: join(dir, "absent-secrets"),
    RMD_SCRATCH: "off",
    RMD_SCRATCH_CHECKOUTS: "off",
    RMD_SCRATCH_ROOT: join(dir, "absent-scratch"),
    RMD_MEMORY_HIGH_TUNED_DIR: join(state, "state"),
    FIXTURE_DOCKER_CALLS: calls,
    FIXTURE_DOCKER_ARGV: argv,
  };
  const install = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], {
    env, encoding: "utf8", timeout: 15_000, maxBuffer: 1 << 20,
  });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  copyFileSync(policySource, join(checkout, policySource));
  const run = () => spawnSync("bash", [launcher, "--boot"], {
    env, encoding: "utf8", timeout: 15_000, maxBuffer: 1 << 20,
  });
  const args = () => readFileSync(argv, "utf8").split("\0").filter(Boolean);
  return { dir, state, bin, checkout, env, meminfo, calls, argv, run, args };
}

function expectedPolicy(env: NodeJS.ProcessEnv, container: string): string[] {
  // The same real policy that recycle uses, not a reimplementation of its sizing arithmetic.
  const result = spawnSync("bash", ["-c", '. "$1"; resource_policy_build_args "$2"; printf "%s\\0" "${RESOURCE_POLICY_BUILD_ARGS[@]}"', "fixture", policySource, container], {
    env, encoding: "utf8", timeout: 5_000, maxBuffer: 1 << 16,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\0").filter(Boolean);
}

const policyArgs = (args: string[]) => args.filter((arg) => /^--(?:memory=|memory-swap=|cpu-shares=|annotation=org\.systemd\.property\.MemoryHigh=)/.test(arg));

test("deploy revival applies the current build resource policy to the actual Docker argv", (t) => {
  const f = fixture(t);
  // Prove checkout-first selection rather than accidentally using the installed fallback.
  writeFileSync(join(f.bin, "rmd-resource-policy"), "return 98\n");
  const result = f.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const expected = expectedPolicy(f.env, "remudero-daemon");
  assert.ok(expected.some((arg) => arg.startsWith("--memory=")), "positive control: readable host memory sizes a ceiling");
  assert.deepEqual(policyArgs(f.args()), expected);
  assert.ok(f.args().includes("--restart=on-failure:5"));
  assert.match(result.stdout, /resource policy from .*daemon-install\/deploy\/resource-policy\.sh/);
  assert.match(result.stdout, /memory ceiling 8820 MiB/);
});

test("deploy revival uses the installed policy when the checkout is absent", (t) => {
  const f = fixture(t, "remudero-console-daemon");
  rmSync(f.checkout, { recursive: true });
  const helper = join(f.bin, "rmd-resource-policy");
  assert.equal(readFileSync(helper, "utf8"), readFileSync(policySource, "utf8"));
  writeFileSync(join(f.state, "state", "memory-high-tuned-remudero-console-daemon.json"), '{"container":"remudero-console-daemon","high_mib":3072}\n');
  const result = f.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(policyArgs(f.args()), expectedPolicy(f.env, "remudero-console-daemon"));
  assert.ok(f.args().includes("--annotation=org.systemd.property.MemoryHigh=uint64 3221225472"), "use this instance's learned high, not Core's floor");
  assert.match(result.stdout, /resource policy from .*bin\/rmd-resource-policy/);
});

test("deploy revival preserves the policy's explicit unreadable-memory outcome", (t) => {
  const f = fixture(t);
  writeFileSync(f.meminfo, "FixtureWithoutMemTotal: 0\n");
  const result = f.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(policyArgs(f.args()), expectedPolicy(f.env, "remudero-daemon"));
  assert.deepEqual(policyArgs(f.args()), ["--cpu-shares=512"]);
  assert.match(result.stdout, /NO memory ceiling.*MemTotal unreadable/);
});

test("deploy revival refuses missing policy before removing the dead container", (t) => {
  const f = fixture(t);
  rmSync(join(f.checkout, policySource));
  rmSync(join(f.bin, "rmd-resource-policy"), { force: true });
  const result = f.run();
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /FATAL.*resource policy.*unreadable/);
  assert.ok(!existsSync(f.argv), "no ungoverned Docker run");
  assert.ok(!readFileSync(f.calls, "utf8").split("\n").includes("rm"), "retain the dead container");
});

test("deploy revival STOP still outranks a missing resource policy", (t) => {
  const f = fixture(t);
  rmSync(join(f.checkout, policySource));
  rmSync(join(f.bin, "rmd-resource-policy"), { force: true });
  writeFileSync(join(f.state, "state", "STOP"), "fixture operator stop\n");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /state\/STOP present/);
  assert.ok(!existsSync(f.calls), "STOP asks Docker nothing");
});
