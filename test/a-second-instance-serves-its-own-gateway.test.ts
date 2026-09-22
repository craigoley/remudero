import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "deploy", "serve-container.sh");

function fixture(): { root: string; docker: string; state: string; code: string; registry: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-second-gateway-"));
  const docker = join(root, "bin", "docker");
  const state = join(root, "state");
  const coreState = join(root, "core-state");
  const consoleState = join(root, "console-state");
  const code = join(root, "serve-code");
  const registry = join(root, "daemon-instances.yaml");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(coreState, { recursive: true });
  mkdirSync(consoleState, { recursive: true });
  mkdirSync(code, { recursive: true });
  writeFileSync(
    registry,
    [
      "instances:",
      "  core:",
      "    repo: remudero",
      "    container_name: remudero-daemon",
      `    state_dir: ${coreState}`,
      "    image: example.invalid/remudero:latest",
      "  site:",
      "    repo: remudero-site",
      "    container_name: remudero-site-daemon",
      `    state_dir: ${state}`,
      "    image: example.invalid/remudero:latest",
      "  console:",
      "    repo: remudero-console",
      "    container_name: remudero-console-daemon",
      `    state_dir: ${consoleState}`,
      "    image: example.invalid/remudero:latest",
      "",
    ].join("\n"),
  );
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -euo pipefail
last=""
for arg in "$@"; do last="$arg"; done
if [ "\${1:-}" = "network" ] && [ "\${2:-}" = "inspect" ]; then exit 0; fi
if [ "\${1:-}" = "inspect" ] && [ "\$last" = "remudero-site-daemon" ]; then
  case "\$*" in
    *Mounts*) printf '%s\\n' "\${FAKE_SITE_STATE}" ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "inspect" ] && [ "\$last" = "remudero-site-serve" ]; then exit 1; fi
exit 1
`,
  );
  chmodSync(docker, 0o755);
  return { root, docker, state, code, registry };
}

function runServe(root: ReturnType<typeof fixture>, instance: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [SCRIPT, "--instance", instance, "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root.root, "bin")}:${process.env.PATH ?? ""}`,
      GH_TOKEN: "test-token",
      FAKE_SITE_STATE: root.state,
      RMD_INSTANCE_REGISTRY: root.registry,
      RMD_SERVE_REPO_DIR: root.code,
      RMD_SERVE_DOCKER_NETWORK: "rmd-test-net",
      RMD_DOCKERENV_PATH: join(root.root, "no-dockerenv"),
    },
  });
}

function stdout(result: ReturnType<typeof spawnSync>): string {
  return result.stdout?.toString() ?? "";
}

function stderr(result: ReturnType<typeof spawnSync>): string {
  return result.stderr?.toString() ?? "";
}

test("a second instance serves its own gateway from its own state directory", () => {
  const root = fixture();
  try {
    const result = runServe(root, "site");
    assert.equal(result.status, 0, `${stdout(result)}\n${stderr(result)}`);
    assert.match(stdout(result), /--name remudero-site-serve/);
    assert.match(stdout(result), new RegExp(`-v ${root.state}:/home/node/Remudero`));
    assert.match(stdout(result), /RMD_CONSOLE_BUILD_ROOT=\/home\/node\/Remudero\/remudero-site\/apps\/dashboard\/dist/);
    assert.match(stdout(result), /\.\/bin\/rmd serve --host 0\.0\.0\.0 --port 4318/);
    assert.doesNotMatch(stdout(result), /--name remudero-serve(?:\s|$)/, "site must not reuse core's gateway container");
    assert.doesNotMatch(stdout(result), /\/home\/node\/Remudero\/remudero\/apps\/dashboard\/dist/, "site must not point at core's checkout");
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("the legacy invocation stays the core gateway on port 4317", () => {
  const root = fixture();
  try {
    const result = spawnSync("bash", [SCRIPT, "--dry-run"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root.root, "bin")}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "test-token",
        RMD_STATE_DIR: root.state,
        RMD_SERVE_REPO_DIR: root.code,
        RMD_SERVE_DOCKER_NETWORK: "rmd-test-net",
        RMD_DOCKERENV_PATH: join(root.root, "no-dockerenv"),
      },
    });
    assert.equal(result.status, 0, `${stdout(result)}\n${stderr(result)}`);
    assert.match(stdout(result), /--name remudero-serve/);
    assert.match(stdout(result), /\.\/bin\/rmd serve --host 0\.0\.0\.0 --port 4317/);
    assert.match(stdout(result), /RMD_CONSOLE_BUILD_ROOT=\/home\/node\/Remudero\/remudero\/apps\/dashboard\/dist/);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("a gateway answers only for the instance it was launched for", () => {
  const root = fixture();
  try {
    const site = runServe(root, "site");
    const console = runServe(root, "console");
    assert.equal(site.status, 0, `${stdout(site)}\n${stderr(site)}`);
    assert.equal(console.status, 0, `${stdout(console)}\n${stderr(console)}`);

    assert.match(stdout(site), /--name remudero-site-serve/);
    assert.match(stdout(site), /RMD_CONSOLE_BUILD_ROOT=\/home\/node\/Remudero\/remudero-site\/apps\/dashboard\/dist/);
    assert.match(stdout(site), /\.\/bin\/rmd serve --host 0\.0\.0\.0 --port 4318/);
    assert.doesNotMatch(stdout(site), /remudero-console|port 4319/);

    assert.match(stdout(console), /--name remudero-console-serve/);
    assert.match(stdout(console), /-v .*\/console-state:\/home\/node\/Remudero/);
    assert.match(stdout(console), /RMD_CONSOLE_BUILD_ROOT=\/home\/node\/Remudero\/remudero-console\/apps\/dashboard\/dist/);
    assert.match(stdout(console), /\.\/bin\/rmd serve --host 0\.0\.0\.0 --port 4319/);
    assert.doesNotMatch(stdout(console), /remudero-site|port 4318/);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("a host-level figure is not repeated per instance", () => {
  const root = fixture();
  try {
    const result = runServe(root, "site");
    assert.equal(result.status, 0, `${stdout(result)}\n${stderr(result)}`);
    const launch = stdout(result);
    assert.match(readFileSync(SCRIPT, "utf8"), /INSTANCE_NAME="\$\{RMD_SERVE_INSTANCE:-\}"/);
    const hostHealthNames = ["diskFreeBytes", "rateLimitRemaining", "lastPollAgeMs", "pollIntervalMs"];
    for (const name of hostHealthNames) {
      assert.doesNotMatch(launch, new RegExp(name), `${name} must stay a host-level read`);
    }
    assert.equal((launch.match(/-v .*:\/home\/node\/Remudero(?:\s|$)/g) ?? []).length, 1);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});
