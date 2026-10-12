import assert from "node:assert/strict";
import { test } from "node:test";
import { ENV_REGISTRY } from "../src/lib/config-schema.js";
import { isRegisteredHarnessEnvName } from "../src/lib/env.js";
import { declaredHarnessEnvNames, harnessEnvNamesInSource, srcFiles } from "./env-var-registry.test.js";

const DOT_READERS = {
  REMUDERO_PROCESS_ACTOR: ["src/lib/ledger.ts", "src/lib/replay-harness.ts"],
  REMUDERO_SESSION_ID: ["src/lib/fleet-control.ts"],
  RMD_GH_CACHE_HOME: ["src/lib/config.ts", "src/lib/github-transport.ts"],
  RMD_GH_TRANSPORT_FLOOR: ["src/lib/github-transport.ts"],
  RMD_OPERATOR_MCP_URL: ["src/lib/operator-mcp.ts"],
  RMD_PROVIDER_AUTH_PROFILES: ["src/lib/provider-auth-sessions.ts"],
  RMD_RESOURCE_POLICY_CONTAINER: ["src/lib/deployer.ts"],
  RMD_RESOURCE_POLICY_ROLE: ["src/lib/deployer.ts"],
  RMD_WORKER_EGRESS: ["src/lib/worker.ts"],
};

test("test/every-env-name-a-source-file-reads-is-registered.test.ts: dot reads and all nine names join the registry census", () => {
  const declared = declaredHarnessEnvNames();
  assert.deepEqual(ENV_REGISTRY.map((entry) => entry.name).sort(), declared);
  for (const [name, readers] of Object.entries(DOT_READERS)) {
    for (const receiver of ["process.env", "env", "workerEnv?"]) {
      assert.deepEqual(harnessEnvNamesInSource(`${receiver}.${name}`), [name]);
    }
    assert.ok(declared.includes(name), `${name} must be visible to the source census`);
    const entry = ENV_REGISTRY.find((entry) => entry.name === name);
    assert.ok(entry, `${name} must be registered`);
    assert.ok(entry.purpose.trim(), `${name} must describe its purpose`);
    assert.deepEqual(entry.readBy, readers, `${name} must name its actual readers`);
    assert.equal(isRegisteredHarnessEnvName(name), true);
  }
});

test("env census recognizes dot and optional dot access on env identifiers", () => {
  for (const receiver of ["env", "process.env", "workerEnv", "this.env", "$env", "ENV"]) {
    for (const access of [".", "?."]) {
      for (const name of ["RMD_UNREGISTERED_DOT_READ", "REMUDERO_UNREGISTERED_DOT_READ"]) {
        assert.deepEqual(harnessEnvNamesInSource(`${receiver}${access}${name}`), [name]);
        assert.equal(isRegisteredHarnessEnvName(name), false, "control: detected names are not pre-registered");
      }
    }
  }
  assert.deepEqual(harnessEnvNamesInSource("process.env\n ?. RMD_UNREGISTERED_DOT_READ"), ["RMD_UNREGISTERED_DOT_READ"]);
});

test("env census preserves quoted literals and excludes unrelated dot properties", () => {
  for (const quote of ["'", '"', "`"]) {
    assert.deepEqual(harnessEnvNamesInSource(`env[${quote}RMD_QUOTED_READ${quote}]`), ["RMD_QUOTED_READ"]);
  }
  for (const source of ["config.RMD_OTHER", "environment.RMD_OTHER", "envSuffix.RMD_OTHER", "env.NOT_HARNESS", "env.RMD_lowercase"]) {
    assert.deepEqual(harnessEnvNamesInSource(source), []);
  }
});

test("env census includes top-level source readers", () => {
  const files = srcFiles();
  assert.ok(files.includes("src/lib/config.ts"), "control: nested source files are enumerated");
  assert.ok(files.includes("src/run-task.ts"));
  assert.ok(files.includes("src/spike.ts"));
  const declared = declaredHarnessEnvNames();
  for (const name of ["RMD_IDLE_STARVED_SUPERVISED", "RMD_SRE_LANE"]) {
    assert.ok(declared.includes(name), `${name} must be visible to the source census`);
    assert.equal(isRegisteredHarnessEnvName(name), true);
  }
});
