import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECYCLE_SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const HOST_UPDATE_SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");
const RUNTIME_ENV_FILE = join(REPO_ROOT, "deploy", "runtime-env-vars.sh");
const OPERATOR_GUIDE = join(REPO_ROOT, "docs", "operator-guide.md");
const CONFIG_DEST = "/home/node/.config/remudero";
const BASH_BIN = ["/opt/homebrew/opt/bash/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find(existsSync) ?? "bash";

interface ScriptRun {
  status: number;
  output: string;
  calls: string[][];
}

function writeCommandStubs(dir: string, recordFile: string): void {
  const docker = [
    "#!/usr/bin/env bash",
    'printf "docker" >> "$RMD_TEST_CALLS"',
    'for arg in "$@"; do printf "\\t%s" "$arg" >> "$RMD_TEST_CALLS"; done',
    'printf "\\n" >> "$RMD_TEST_CALLS"',
    'if [ "$1" = "inspect" ] && [ "$2" != "--format" ]; then exit 1; fi',
    'if [ "$1" = "inspect" ] && [ "$2" = "--format" ]; then printf "sha256:PULLEDID\\n"; exit 0; fi',
    'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then printf "sha256:PULLEDID\\n"; exit 0; fi',
    'if [ "$1" = "pull" ]; then printf "Status: Downloaded newer image\\n"; exit 0; fi',
    "exit 0",
    "",
  ].join("\n");
  const az = ["#!/usr/bin/env bash", "exit 0", ""].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  writeFileSync(join(dir, "az"), az, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "az"), 0o755);
  writeFileSync(recordFile, "");
}

function parseCalls(recordFile: string): string[][] {
  return readFileSync(recordFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function runRecycle(configDir: string): ScriptRun {
  const fixture = mkdtempSync(join(tmpdir(), "container-config-recycle-"));
  const binDir = join(fixture, "bin");
  const recordFile = join(fixture, "calls.tsv");
  const stateDir = join(fixture, "state-volume");
  const claudeDir = join(fixture, "claude");
  const codexDir = join(fixture, "codex-absent");
  mkdirSync(binDir);
  mkdirSync(stateDir);
  mkdirSync(claudeDir);
  writeCommandStubs(binDir, recordFile);

  const result = spawnSync(BASH_BIN, [RECYCLE_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      GH_TOKEN: "test-token",
      RMD_TEST_CALLS: recordFile,
      RMD_STATE_DIR: stateDir,
      RMD_CLAUDE_DIR: claudeDir,
      RMD_CODEX_DIR: codexDir,
      RMD_CONTAINER_CONFIG_DIR: configDir,
      RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_DOCKERENV_PATH: join(fixture, "no-dockerenv"),
    },
  });

  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    calls: parseCalls(recordFile),
  };
}

function printDaemonRun(configDir: string): ScriptRun {
  const fixture = mkdtempSync(join(tmpdir(), "container-config-print-"));
  const stateDir = join(fixture, "state-volume");
  const claudeDir = join(fixture, "claude");
  const codexDir = join(fixture, "codex-absent");
  mkdirSync(join(stateDir, "state"), { recursive: true });
  mkdirSync(claudeDir);
  writeFileSync(join(stateDir, "state", "ledger.ndjson"), '{}\n');
  writeFileSync(
    join(claudeDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 60 * 60 * 1000 } }),
  );

  const result = spawnSync(BASH_BIN, [HOST_UPDATE_SCRIPT, "--print-daemon-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      RMD_STATE_DIR: stateDir,
      RMD_CLAUDE_DIR: claudeDir,
      RMD_CODEX_DIR: codexDir,
      RMD_CONTAINER_CONFIG_DIR: configDir,
    },
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    calls: [],
  };
}

function dockerRunArgs(run: ScriptRun): string[] {
  const call = run.calls.find(([bin, verb]) => bin === "docker" && verb === "run");
  assert.ok(call, `expected the real recycle to reach docker run; output:\n${run.output}`);
  return call.slice(1);
}

test("W1-T2592: both launch paths mount an existing container config directory read-write", () => {
  const configDir = mkdtempSync(join(tmpdir(), "remudero-container-config-"));
  const expectedMount = `${configDir}:${CONFIG_DEST}`;

  const recycle = runRecycle(configDir);
  assert.equal(recycle.status, 0, recycle.output);
  const actualArgs = dockerRunArgs(recycle);
  assert.ok(actualArgs.includes(expectedMount), `actual docker run omitted ${expectedMount}`);
  assert.ok(!actualArgs.includes(`${expectedMount}:ro`), "the daemon must be able to persist config changes");

  const printed = printDaemonRun(configDir);
  assert.equal(printed.status, 0, printed.output);
  assert.match(printed.output, new RegExp(`-v ${expectedMount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\\\`));
  assert.doesNotMatch(printed.output, new RegExp(`${expectedMount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:ro`));
});

test("W1-T2592: an absent source warns, remains absent, and preserves both Claude-only launch shapes", () => {
  const fixture = mkdtempSync(join(tmpdir(), "remudero-container-config-absent-"));
  const configDir = join(fixture, "not-created");

  const recycle = runRecycle(configDir);
  assert.equal(recycle.status, 0, recycle.output);
  assert.match(recycle.output, /no container config directory/);
  assert.ok(!existsSync(configDir), "recycle must not let Docker create an empty bind source");
  const actualArgs = dockerRunArgs(recycle);
  assert.ok(actualArgs.some((arg) => arg.endsWith(":/home/node/Remudero")), "the state mount must remain present");
  assert.ok(actualArgs.some((arg) => arg.endsWith(":/home/node/.claude")), "the Claude credential mount must remain present");
  assert.ok(!actualArgs.some((arg) => arg.includes(CONFIG_DEST)), "the absent config source must be omitted");

  const printed = printDaemonRun(configDir);
  assert.equal(printed.status, 0, printed.output);
  assert.match(printed.output, /no container config directory/);
  assert.match(printed.output, /docker run -d --name remudero-daemon/);
  assert.match(printed.output, /\/home\/node\/\.claude/);
  assert.doesNotMatch(printed.output, new RegExp(CONFIG_DEST.replaceAll(".", "\\.")));
  assert.ok(!existsSync(configDir), "print-only mode must not create the bind source");
});

test("W1-T2592: both scripts share the host-only variable, destination, and safe default", () => {
  const recycle = readFileSync(RECYCLE_SCRIPT, "utf8");
  const hostUpdate = readFileSync(HOST_UPDATE_SCRIPT, "utf8");
  const runtimeEnv = readFileSync(RUNTIME_ENV_FILE, "utf8");
  const derivation = '${RMD_CONTAINER_CONFIG_DIR:-${HOME:-/root}/.config/remudero-container}';

  for (const [name, source] of [["recycle", recycle], ["host-update", hostUpdate]] as const) {
    assert.ok(source.includes(derivation), `${name} must use the shared container-specific default`);
    assert.ok(source.includes(`CONTAINER_CONFIG_MOUNT_DEST="${CONFIG_DEST}"`), `${name} destination drifted`);
  }
  assert.doesNotMatch(runtimeEnv, /RMD_CONTAINER_CONFIG_DIR/, "a host bind source is not a container runtime variable");
  assert.doesNotMatch(derivation, /\.config\/remudero}/, "the default must not reuse the host CLI config directory");
});

test("W1-T2592: the operator guide commissions and verifies config without taking lifecycle control", () => {
  const guide = readFileSync(OPERATOR_GUIDE, "utf8");
  const start = guide.indexOf("### Azure container provider configuration");
  const end = guide.indexOf("\n### ", start + 4);
  assert.ok(start >= 0, "the Azure container commissioning section must be present");
  const section = guide.slice(start, end >= 0 ? end : undefined);

  assert.match(section, /RMD_CONTAINER_CONFIG_DIR/);
  assert.match(section, /\.config\/remudero-container/);
  assert.match(section, /install -d -m 700 -o 1000 -g 1000/);
  assert.match(section, /install -m 600 -o 1000 -g 1000/);
  assert.match(section, /c\.root="\/home\/node\/Remudero"/);
  assert.match(section, /c\.claudeBin="\/usr\/local\/bin\/claude"/);
  assert.match(section, /const w=c\.workerProviders\?\?\{\}/);
  assert.match(section, /c\.workerProviders=\{\.\.\.w,/);
  assert.match(section, /claude.+auth status/s);
  assert.match(section, /codex.+login status/s);
  assert.match(section, /does not start, stop,\s+restart, recycle, or deploy/i);
  assert.doesNotMatch(section, /docker (?:start|stop|restart)\b/);
  assert.doesNotMatch(section, /recycle-container\.sh\b/);
});
