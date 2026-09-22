import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../deploy/serve-container.sh", import.meta.url));

interface FixtureOptions {
  pullResult?: "success" | "failure";
  existingContainer?: boolean;
  replace?: boolean;
  dryRun?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-test-serve-image-preflight-"));
  const binDir = join(root, "bin");
  const stateDir = join(root, "state");
  const serveRepoDir = join(root, "serve-repo");
  const callsPath = join(root, "docker-calls.log");
  const runMarker = join(root, "container-started");
  const dockerPath = join(binDir, "docker");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(serveRepoDir, { recursive: true });
  writeFileSync(callsPath, "");

  writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "${callsPath}"
case "\${1:-}" in
  network)
    if [ "\${2:-}" = inspect ] && [[ " $* " == *" --format "* ]]; then
      printf '%s\\n' cloudflared
    fi
    exit 0
    ;;
  pull)
    [ "\${FAKE_PULL_RESULT:-success}" = success ]
    exit $?
    ;;
  inspect)
    if [[ " $* " == *" remudero-daemon "* ]]; then
      exit 1
    fi
    if [[ " $* " == *" remudero-serve "* ]]; then
      case "$*" in
        *State.Running*) [ -f "${runMarker}" ] && printf '%s\\n' true || printf '%s\\n' false; exit 0 ;;
        *NetworkSettings.Networks*) printf '%s\\n' yes; exit 0 ;;
        *Mounts*) exit 0 ;;
        *) [ "\${FAKE_EXISTING_CONTAINER:-0}" = 1 ] && exit 0 || exit 1 ;;
      esac
    fi
    exit 1
    ;;
  stop|rm)
    exit 0
    ;;
  run)
    touch "${runMarker}"
    exit 0
    ;;
  logs)
    printf '%s\\n' 'listening on http://0.0.0.0:4317'
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`,
  );
  chmodSync(dockerPath, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    HOME: root,
    GH_TOKEN: "fixture-token",
    RMD_STATE_DIR: stateDir,
    RMD_SERVE_REPO_DIR: serveRepoDir,
    RMD_SERVE_DOCKERENV_PATH: join(root, "not-a-container-marker"),
    RMD_SERVE_BANNER_WAIT_S: "1",
    RMD_SERVE_BANNER_POLL_S: "1",
    RMD_CLAUDE_JSON_PATH: join(root, "missing-account.json"),
    RMD_GITHUB_WEBHOOK_SECRET_PATH: "",
    REGISTRY: "test-registry",
    IMAGE: "remudero",
    TAG: "sha-test",
    FAKE_PULL_RESULT: options.pullResult ?? "success",
    FAKE_EXISTING_CONTAINER: options.existingContainer ? "1" : "0",
  };
  const args = options.dryRun ? ["--dry-run"] : options.replace ? ["--replace"] : [];
  const result = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env });
  const calls = readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean);
  return { result, calls, ref: "test-registry.azurecr.io/remudero:sha-test" };
}

test("serve replacement pulls the exact image before stop or remove", () => {
  const result = fixture({ existingContainer: true, replace: true });
  assert.equal(result.result.status, 0, result.result.stderr);
  const pullIndex = result.calls.findIndex((call) => call === `pull ${result.ref}`);
  const stopIndex = result.calls.findIndex((call) => call === "stop remudero-serve");
  const removeIndex = result.calls.findIndex((call) => call === "rm remudero-serve");
  assert.notEqual(pullIndex, -1, "the exact image reference must be pulled");
  assert.ok(stopIndex > pullIndex, `stop must follow pull: ${result.calls.join(" | ")}`);
  assert.ok(removeIndex > pullIndex, `remove must follow pull: ${result.calls.join(" | ")}`);
});

test("failed image preflight preserves the existing container", () => {
  const result = fixture({ pullResult: "failure", existingContainer: true, replace: true });
  assert.equal(result.result.status, 1);
  assert.match(result.result.stderr, /target image .* could not be pulled; existing container was left untouched/);
  assert.ok(result.calls.includes(`pull ${result.ref}`));
  assert.ok(!result.calls.includes("stop remudero-serve"), `failed pull must not stop: ${result.calls.join(" | ")}`);
  assert.ok(!result.calls.includes("rm remudero-serve"), `failed pull must not remove: ${result.calls.join(" | ")}`);
  assert.ok(!result.calls.some((call) => call.startsWith("run ")), `failed pull must not run: ${result.calls.join(" | ")}`);
});

test("successful image preflight runs the exact target reference", () => {
  const result = fixture({ pullResult: "success" });
  assert.equal(result.result.status, 0, result.result.stderr);
  const pullIndex = result.calls.findIndex((call) => call === `pull ${result.ref}`);
  const runIndex = result.calls.findIndex((call) => call.includes(`run -d --name remudero-serve`) && call.includes(result.ref));
  assert.notEqual(pullIndex, -1, "the exact image reference must be pulled");
  assert.notEqual(runIndex, -1, `the exact target reference must reach docker run: ${result.calls.join(" | ")}`);
  assert.ok(runIndex > pullIndex, `run must follow pull: ${result.calls.join(" | ")}`);
});

test("dry-run does not pull or mutate the container", () => {
  const result = fixture({ existingContainer: true, dryRun: true });
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.match(result.result.stdout, /--dry-run, nothing changed/);
  assert.ok(!result.calls.some((call) => call.startsWith("pull ")), `dry-run must not pull: ${result.calls.join(" | ")}`);
  assert.ok(!result.calls.includes("stop remudero-serve"));
  assert.ok(!result.calls.includes("rm remudero-serve"));
  assert.ok(!result.calls.some((call) => call.startsWith("run ")));
});
