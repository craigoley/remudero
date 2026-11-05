import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { daemonInstanceRegistryPath, realDeployDeps, type RealDeployOpts } from "#src/lib/deployer.js";
import { withInstanceRegistryRuntime } from "#src/lib/instance-registry-selection.js";
import { SELECTED_REGISTRY_LAUNCH_WRAPPER, selectedRegistryLifecycleExec } from "#src/lib/selected-registry-consumers.js";
import { makeTempDir } from "#src/lib/tmp.js";

test("deployer and the selected-registry shell adapter share the exact launcher command", async t => {
  const root = makeTempDir("selected-registry-launch-wrapper"), stateRoot = join(root, "state-root");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".remudero"), { recursive: true });
  mkdirSync(join(root, "deploy"), { recursive: true });
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  const selectedPath = join(root, "private-selected.yaml"), recycler = join(root, "deploy/recycle-container.sh");
  const registry = "instances:\n  owner:\n    repo: remudero\n    github_repo: fixture/remudero\n    primary: true\n    mode: shadow\n    state_dir: " + stateRoot
    + "\n    container_name: remudero-daemon\n    image: registry.invalid/remudero:fixture\n";
  writeFileSync(daemonInstanceRegistryPath(root), registry);
  writeFileSync(selectedPath, registry, { mode: 0o600 });
  writeFileSync(recycler, "#!/usr/bin/env bash\ncase \"$1\" in --selected-registry-shadow) : ;; --selected-registry-pin) : ;; esac\nprintf '%s\\n' \"$@\"\n", { mode: 0o700 });

  const calls: Array<{ cmd: string; args: string[] }> = [];
  const opts: RealDeployOpts = { installPath: root, stateRoot, daemonLabel: "owner", serveLabel: "serve", servePort: 1,
    uid: 1, ledgerPath: join(stateRoot, "state/ledger.ndjson"), log: () => {},
    execFile: (cmd, args) => { calls.push({ cmd, args }); return ""; } };
  await withInstanceRegistryRuntime(async () => {
    realDeployDeps(opts).restartBackends!()[1]!.restart();
  }, { envPath: selectedPath, instanceName: "owner" });

  const launch = calls.find(call => call.cmd === "bash");
  assert.ok(launch, "the real deployer must launch its container recycler through bash");
  assert.equal(launch.args[0], "-c");
  assert.equal(launch.args[1], SELECTED_REGISTRY_LAUNCH_WRAPPER);
  assert.equal(launch.args[2], "selected-registry-launch");
  assert.deepEqual(launch.args.slice(6), [recycler, "--instance", "owner"]);

  const output = selectedRegistryLifecycleExec(root, { session: "private-session", pin: "a".repeat(64) })(launch.cmd, launch.args);
  assert.deepEqual(output.trim().split("\n"), ["--instance", "owner", "--selected-registry-shadow", "private-session",
    "--selected-registry-pin", "a".repeat(64)]);
});