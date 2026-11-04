import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { daemonInstanceRegistryPath, type DeployDeps } from "#src/lib/deployer.js";
import { loadHostMemoryBudgetPolicy } from "#src/lib/host-memory-shadow.js";
import { withInstanceRegistryRuntime, trustedInstanceRegistryLaunchPacket } from "#src/lib/instance-registry-selection.js";
import { realServePolicyDeps, runServePolicyCycle, serveReplaceAdmissionEnv, SERVE_REPLACE_HELD_EXIT } from "#src/lib/serve-policy-convergence.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { repoRoot } from "#test/helpers/repo-root.js";

const SERVE_SCRIPT = "deploy/serve-container.sh";
const DRIFT = [{ field: "Memory", expected: 8, actual: 4 }];
const BUDGET = loadHostMemoryBudgetPolicy(join(repoRoot(), "plan", "policy.yaml"));

function fixture() {
  const root = makeTempDir("serve-policy-selected-replace");
  const installPath = join(root, "install"), stateRoot = join(root, "state-root");
  mkdirSync(join(installPath, ".remudero"), { recursive: true });
  mkdirSync(join(installPath, "deploy"), { recursive: true });
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  const selectedPath = join(root, "private-selection.yaml");
  const registry = `instances:\n  owner:\n    repo: remudero\n    github_repo: craigoley/remudero\n    primary: true\n    mode: shadow\n    state_dir: ${stateRoot}\n    container_name: remudero-daemon\n    image: registry.invalid/remudero:fixture\n  other:\n    repo: remudero\n    github_repo: craigoley/remudero-other\n    mode: shadow\n    state_dir: ${join(root, "other-state")}\n    container_name: remudero-other-daemon\n    image: registry.invalid/remudero-other:fixture\n`;
  writeFileSync(daemonInstanceRegistryPath(installPath), registry);
  writeFileSync(selectedPath, registry, { mode: 0o600 });
  return { root, installPath, stateRoot, selectedPath };
}

function convergenceDeps(real: Partial<DeployDeps>): DeployDeps {
  let reads = 0;
  return {
    ...real,
    log: () => {},
    now: () => 1,
    stopPresent: () => false,
    pausePresent: () => false,
    serveHandoffInProgress: () => false,
    serveHealthy: () => true,
    servePolicyLastFailedAtMs: () => undefined,
    servePolicyDrift: () => reads++ === 0 ? DRIFT : [],
    serveMountPlanDrift: () => [],
    serveImageDrift: () => undefined,
    serveImageInputs: undefined,
    replaceServe: real.replaceServe,
    clearServePolicyFailure: () => {},
    recordServePolicyFailure: () => {},
  } as DeployDeps;
}

function run(real: Partial<DeployDeps>, calls: string[][]) {
  const outcome = runServePolicyCycle(convergenceDeps(real), { imageDriftOnly: true });
  assert.equal(outcome.replaced, true, outcome.reason);
  assert.equal(calls.filter(([cmd]) => cmd === "env").length, 1, "the cycle invokes exactly one recorded replacement");
}

test("selected serve policy replacement names the instance and uses deploy-run's trusted selection wrapper", async t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ""; };

  await withInstanceRegistryRuntime(async () => {
    const packet = trustedInstanceRegistryLaunchPacket("owner").split("\n");
    const real = realServePolicyDeps({ installPath: f.installPath, stateRoot: f.stateRoot }, exec, undefined, () => BUDGET);
    run(real, calls);
  const command = calls.find(([cmd]) => cmd === "env")!;
    assert.equal(command[0], "env");
    assert.ok(command.includes("bash"));
    const scriptIndex = command.indexOf(join(f.installPath, SERVE_SCRIPT));
    assert.ok(scriptIndex > 0, "replacement reaches the real serve launcher path");
    assert.deepEqual(command.slice(scriptIndex), [join(f.installPath, SERVE_SCRIPT), "--replace", "--instance", "owner"]);
    assert.deepEqual(command.slice(command.indexOf("selected-registry-launch")), [
      "selected-registry-launch", packet[1]!, packet[2]!, packet[3]!,
      join(f.installPath, SERVE_SCRIPT), "--replace", "--instance", "owner",
    ]);
    assert.deepEqual(command.slice(1, 2 + serveReplaceAdmissionEnv(BUDGET).length), [
      `RMD_STATE_DIR=${f.stateRoot}`, ...serveReplaceAdmissionEnv(BUDGET),
    ]);
  }, { envPath: f.selectedPath, instanceName: "owner" });
});

test("serve policy replacement keeps the unselected legacy invocation byte-for-byte", t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ""; };
  const real = realServePolicyDeps({ installPath: f.installPath, stateRoot: f.stateRoot }, exec, undefined, () => BUDGET);
  run(real, calls);
  assert.deepEqual(calls.filter(([cmd]) => cmd === "env"), [["env", `RMD_STATE_DIR=${f.stateRoot}`, ...serveReplaceAdmissionEnv(BUDGET),
    "bash", join(f.installPath, SERVE_SCRIPT), "--replace"]]);
});

test("a selected instance that does not own the convergence state root is refused before launch", async t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ""; };
  await withInstanceRegistryRuntime(() => {
    assert.throws(() => realServePolicyDeps({ installPath: f.installPath, stateRoot: f.stateRoot, instance: "other" }, exec,
      undefined, () => BUDGET), /selected instance registry unavailable \(target_missing_or_mismatched\)/);
  }, { envPath: f.selectedPath, instanceName: "other" });
  assert.deepEqual(calls, [], "a mismatched selected target never reaches env/bash or the serve script");
});

test("a selected host-pressure hold stays named without disclosing private binding bytes", async t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  let packet: string[] = [];
  await withInstanceRegistryRuntime(() => {
    packet = trustedInstanceRegistryLaunchPacket("owner").split("\n");
    const exec = (_cmd: string, _args: string[]) => {
      throw Object.assign(new Error("private argv in the thrown message"), {
        status: SERVE_REPLACE_HELD_EXIT,
        stderr: `serve-container: HELD (host_headroom) — MemAvailable 4 MiB < need 8 MiB ${f.selectedPath} ${packet[2]} ${packet[3]} ${packet[4]}`,
      });
    };
    const replace = realServePolicyDeps({ installPath: f.installPath, stateRoot: f.stateRoot }, exec, undefined, () => BUDGET).replaceServe!;
    const held = replace();
    assert.equal(held?.held, "host_headroom");
    assert.match(held?.detail ?? "", /MemAvailable 4 MiB < need 8 MiB/);
    for (const privateValue of [f.selectedPath, packet[2]!, packet[3]!, packet[4]!]) {
      assert.equal(held?.detail.includes(privateValue), false, "hold diagnostics never serialize private selection bytes");
    }
  }, { envPath: f.selectedPath, instanceName: "owner" });
});
