import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const destination = "/run/remudero/github-app.pem";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-app-key-contract-"));
  const state = join(root, "state-root");
  const claude = join(root, "claude");
  const key = join(root, "key with spaces.pem");
  const bin = join(root, "bin");
  const calls = join(root, "calls");
  for (const path of [join(state, "state"), join(state, "remudero", ".git"), claude, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(state, "state", "ledger.ndjson"), "{}\n");
  writeFileSync(key, "synthetic App key; not usable for authentication\n");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
printf 'docker' >> "$CALLS"; for arg in "$@"; do printf '\\t%s' "$arg" >> "$CALLS"; done; printf '\\n' >> "$CALLS"
if [ "$1" = inspect ] && [ "$2" = --format ]; then
  case "$3" in
    *Config.Env*) printf 'GH_TOKEN=\\nGH_APP_ID=fixture-app\\nGH_APP_INSTALLATION_ID=fixture-installation\\nGH_APP_PRIVATE_KEY_PATH=${destination}\\n' ;;
    *Config.Image*) echo fixture.azurecr.io/remudero:latest ;;
    *Mounts*) printf '%s\\t/home/node/Remudero\\ttrue\\n%s\\t/home/node/.claude\\ttrue\\n' "$FIXTURE_STATE" "$FIXTURE_CLAUDE"
      [ "\${KEY_VIEW:-correct}" = missing ] || printf '%s\\t${destination}\\t%s\\n' "$FIXTURE_KEY" "$([ "\${KEY_VIEW:-correct}" = writable ] && echo true || echo false)" ;;
    *Image*) echo sha256:fixture ;;
  esac
elif [ "$1" = image ] && [ "$2" = inspect ]; then
  case "$*" in *Config.Env*) echo "" ;; *) echo sha256:fixture ;; esac
elif [ "$1" = container ] && [ "$2" = run ]; then echo 'WORKER-SMOKE PASS fixture'
elif [ "$1" = exec ]; then exit 0
fi
exit 0
`, { mode: 0o755 });
  for (const command of ["az", "findmnt"]) writeFileSync(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const registry = join(root, "instances.yaml");
  const launcher = join(root, "relaunch.sh");
  writeFileSync(registry, `instances:
  example:
    repo: example
    state_dir: ${state}
    container_name: remudero-example-daemon
    service_user: example
    image: fixture.azurecr.io/remudero:latest
    max_old_space_mb: 2048
    service_name: rmd-example-fleet.service
    watchdog_service_name: rmd-example-watchdog.service
    watchdog_timer_name: rmd-example-watchdog.timer
    launcher_path: ${launcher}
    revival_log: ${join(root, "revivals.log")}
    gh_app_id: fixture-app
    gh_app_installation_id: fixture-installation
    gh_app_private_key_path: ${destination}
    gh_app_private_key_host_path: ${key}
    claude_dir: ${claude}
    codex_dir: ${join(root, "absent-codex")}
    container_config_dir: ${join(root, "absent-config")}
`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls,
    FIXTURE_STATE: state, FIXTURE_CLAUDE: claude, FIXTURE_KEY: key,
    RMD_INSTANCE_REGISTRY: registry, RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: bin,
    RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-dockerenv"), RMD_RECYCLE_WAIT_S: "1",
    RMD_RECYCLE_POLL_S: "1", RMD_RECYCLE_SKIP_RECLAIM: "1", GH_TOKEN: "",
    GH_APP_ID: "", GH_APP_INSTALLATION_ID: "", GH_APP_PRIVATE_KEY_PATH: "" };
  const run = (script: string, args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync("bash", [script, ...args], { encoding: "utf8", timeout: 30000, env: { ...env, ...extra } });
  return { root, state, key, registry, launcher, env, run, calls: () => existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}

test("an explicit App key is mounted read-only by the instance recycler and its pre-stop worker smoke", () => {
  const f = fixture();
  try {
    const run = f.run("deploy/recycle-container.sh", ["--instance", "example"]);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const mount = `type=bind,source=${f.key},target=${destination},readonly`;
    const calls = f.calls().split("\n");
    for (const prefix of ["docker\trun\t", "docker\tcontainer\trun\t"]) {
      assert.ok(calls.some(line => line.startsWith(prefix) && line.includes(`\t--mount\t${mount}`)), prefix);
    }
    assert.match(run.stdout, /runtime contract healthy/);
    assert.ok(!existsSync(join(f.state, "state", "PAUSE")));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a declared App key refusal leaves the old container and pause untouched", () => {
  for (const bad of ["missing", "empty", "directory", "relative", "overlap", "csv-comma", "csv-quote"]) {
    const f = fixture();
    try {
      if (bad === "missing") rmSync(f.key);
      if (bad === "empty") writeFileSync(f.key, "");
      if (bad === "directory") { rmSync(f.key); mkdirSync(f.key); }
      if (bad === "relative") writeFileSync(f.registry, readFileSync(f.registry, "utf8").replace(f.key, "relative.pem"));
      if (bad === "overlap") writeFileSync(f.registry, readFileSync(f.registry, "utf8").replace(destination, "/home/node/.claude/.credentials.json"));
      if (bad === "csv-comma" || bad === "csv-quote") writeFileSync(f.registry, readFileSync(f.registry, "utf8").replace(f.key, `${f.key}${bad === "csv-comma" ? "," : '"'}unsafe`));
      const run = f.run("deploy/recycle-container.sh", ["--instance", "example"]);
      assert.notEqual(run.status, 0, bad);
      assert.match(run.stderr, /REFUSING/, bad);
      assert.doesNotMatch(f.calls(), /^docker\t(?:stop|rm|run|pull)\t/m, bad);
      assert.ok(!existsSync(join(f.state, "state", "PAUSE")), bad);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("the recycler reports a missing or writable App key mount without declaring adoption", () => {
  for (const view of ["missing", "writable"]) {
    const f = fixture();
    try {
      const run = f.run("deploy/recycle-container.sh", ["--instance", "example"], { KEY_VIEW: view });
      assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
      assert.match(run.stderr, /FAILED RUNTIME CONTRACT/);
      assert.match(run.stderr, view === "missing" ? /"reason":"missing"/ : /"reason":"read_write"/);
      assert.doesNotMatch(run.stdout, /OK — .* recycled onto/);
      assert.equal(f.calls().split("\n").filter(line => line.startsWith("docker\tstop\t")).length, 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("the rendered instance launcher carries the App key contract and refuses its loss before removal", () => {
  const f = fixture();
  try {
    const install = f.run("deploy/install-host-units.sh", ["--install", "--instance", "example"]);
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const source = readFileSync(f.launcher, "utf8");
    assert.ok(source.includes("app_private_key_mount_args"));
    assert.ok(source.indexOf("app_private_key_mount_args ") < source.indexOf("docker rm -f "));
    const launch = f.run(f.launcher, ["--boot"]);
    assert.equal(launch.status, 0, `${launch.stdout}\n${launch.stderr}`);
    assert.ok(f.calls().includes(`\t--mount\ttype=bind,source=${f.key},target=${destination},readonly`));
    assert.ok(f.calls().includes(`GH_APP_PRIVATE_KEY_PATH=${destination}`));
    const removals = () => f.calls().split("\n").filter(line => line.startsWith("docker\trm\t")).length;
    const before = removals();
    rmSync(f.key);
    const run = f.run(f.launcher, ["--boot"]);
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /App key mount: REFUSING/);
    assert.equal(removals(), before, "key loss must refuse before removing the old container");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
