import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = join(REPO_ROOT, "deploy", "container-runtime-contract.sh");
const RECYCLE = join(REPO_ROOT, "deploy", "recycle-container.sh");
const BASH_BIN = ["/opt/homebrew/opt/bash/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"]
  .find((candidate) => existsSync(candidate) && spawnSync(candidate, ["-c", "declare -A probe"]).status === 0)
  ?? "bash";
const BASH_SUPPORTS_ASSOCIATIVE_ARRAYS = spawnSync(BASH_BIN, ["-c", "declare -A probe"], {
  encoding: "utf8",
}).status === 0;

interface ContractExpectation {
  source: string;
  destination: string;
  mode?: "rw" | "ro";
}

interface ContractRun {
  status: number;
  stdout: string;
  stderr: string;
  verdict: Record<string, unknown> | null;
}

function writeDockerStub(binDir: string): void {
  const script = [
    "#!/usr/bin/env bash",
    'if [ -n "${STUB_CALLS:-}" ]; then printf "docker" >> "$STUB_CALLS"; for arg in "$@"; do printf "\\t%s" "$arg" >> "$STUB_CALLS"; done; printf "\\n" >> "$STUB_CALLS"; fi',
    'if [ "$1" = "inspect" ] && [ "$2" = "--format" ] && [[ "$3" == *Mounts* ]]; then',
    '  [ "${STUB_RUNTIME_UNREADABLE:-0}" = "1" ] && exit 1',
    '  [ -n "${STUB_MOUNTS_FILE:-}" ] && cat "$STUB_MOUNTS_FILE"',
    "  exit 0",
    "fi",
    'if [ "$1" = "inspect" ] && [ "$2" = "--format" ] && [[ "$3" == *Config.Image* ]]; then echo "test-registry/remudero:old"; exit 0; fi',
    'if [ "$1" = "inspect" ] && [ "$2" = "--format" ] && [[ "$3" == *Config.Env* ]]; then echo ""; exit 0; fi',
    'if [ "$1" = "inspect" ] && [ "$2" = "--format" ] && [[ "$3" == *Image* ]]; then echo "sha256:PULLEDID"; exit 0; fi',
    'if [ "$1" = "inspect" ] && [ $# -eq 2 ]; then [ -e "${STUB_STARTED_FILE:-/no-such-file}" ] && exit 0; exit 1; fi',
    'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then echo "sha256:PULLEDID"; exit 0; fi',
    'if [ "$1" = "pull" ]; then echo "Status: Downloaded newer image"; exit 0; fi',
    'if [ "$1" = "run" ]; then [ -n "${STUB_STARTED_FILE:-}" ] && : > "$STUB_STARTED_FILE"; exit 0; fi',
    'if [ "$1" = "ps" ]; then exit 0; fi',
    'if [ "$1" = "exec" ]; then exit 0; fi',
    'if [ "$1" = "stop" ] || [ "$1" = "rm" ]; then exit 0; fi',
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(binDir, "docker"), script, { mode: 0o755 });
  chmodSync(join(binDir, "docker"), 0o755);
}

function runContract(expectations: ContractExpectation[], extraEnv: Record<string, string> = {}): ContractRun {
  const binDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtime-contract-bin-`));
  const mountsFile = join(binDir, "mounts");
  writeDockerStub(binDir);
  if (!("STUB_MOUNTS_FILE" in extraEnv)) writeFileSync(mountsFile, "");
  const args = ["--container", "remudero-daemon"];
  for (const expectation of expectations) {
    args.push("--expect", expectation.source, expectation.destination, expectation.mode ?? "rw");
  }
  const run = spawnSync(BASH_BIN, [CONTRACT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      STUB_MOUNTS_FILE: mountsFile,
      ...extraEnv,
    },
  });
  let verdict: Record<string, unknown> | null = null;
  try {
    verdict = JSON.parse((run.stdout ?? "").trim()) as Record<string, unknown>;
  } catch {
    verdict = null;
  }
  return { status: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? "", verdict };
}

test("W1-T2857: exact expected provider mounts produce one bounded healthy verdict", () => {
  const binDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtime-contract-mounts-`));
  const mountsFile = join(binDir, "mounts");
  writeFileSync(
    mountsFile,
    [
      "/srv/rmd-state\t/home/node/Remudero\ttrue",
      "/srv/claude\t/home/node/.claude\ttrue",
      "/srv/codex\t/home/node/.codex\ttrue",
      "/srv/provider-config\t/home/node/.config/remudero\ttrue",
      "",
    ].join("\n"),
  );
  const run = runContract(
    [
      { source: "/srv/rmd-state", destination: "/home/node/Remudero" },
      { source: "/srv/claude", destination: "/home/node/.claude" },
      { source: "/srv/codex", destination: "/home/node/.codex" },
      { source: "/srv/provider-config", destination: "/home/node/.config/remudero" },
    ],
    { STUB_MOUNTS_FILE: mountsFile },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.verdict, { status: "healthy", container: "remudero-daemon", checked: 4, drift: [] });
  assert.ok(run.stdout.length < 1024, "the machine-readable verdict must stay bounded");
});

test("W1-T2857: missing, wrong-source and read-only mounts are named without exposing sources", () => {
  const binDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtime-contract-drift-`));
  const mountsFile = join(binDir, "mounts");
  writeFileSync(
    mountsFile,
    [
      "/wrong/secret/source\t/home/node/.claude\ttrue",
      "/srv/codex\t/home/node/.codex\tfalse",
      "",
    ].join("\n"),
  );
  const run = runContract(
    [
      { source: "/srv/rmd-state", destination: "/home/node/Remudero" },
      { source: "/srv/claude", destination: "/home/node/.claude" },
      { source: "/srv/codex", destination: "/home/node/.codex" },
    ],
    { STUB_MOUNTS_FILE: mountsFile },
  );
  assert.equal(run.status, 1);
  assert.deepEqual(run.verdict, {
    status: "drift",
    container: "remudero-daemon",
    checked: 3,
    drift: [
      { destination: "/home/node/Remudero", reason: "missing" },
      { destination: "/home/node/.claude", reason: "wrong_source" },
      { destination: "/home/node/.codex", reason: "read_only" },
    ],
  });
  assert.doesNotMatch(run.stdout, /wrong\/secret|srv\/claude|srv\/codex/);
  assert.ok(run.stdout.length < 1024, "the drift verdict must stay bounded");
});

test("W1-T2857: an unreadable Docker inspection is distinct from drift and exposes no inspect payload", () => {
  const run = runContract([{ source: "/private/credential-home", destination: "/home/node/.codex" }], {
    STUB_RUNTIME_UNREADABLE: "1",
  });
  assert.equal(run.status, 2);
  assert.deepEqual(run.verdict, {
    status: "unreadable",
    container: "remudero-daemon",
    checked: 1,
    drift: [],
  });
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /private\/credential-home|auth\.json|Config|Mounts/);
});

interface RecycleRun {
  status: number;
  stdout: string;
  stderr: string;
  calls: string;
  codexExists: boolean;
  configExists: boolean;
}

function runRecycle(opts: { codex: boolean; omitCodexMount?: boolean; scriptPath?: string }): RecycleRun {
  const binDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtime-recycle-bin-`));
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtime-recycle-state-`));
  const credDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtime-recycle-claude-`));
  const optionalRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtime-recycle-optional-`));
  const codexDir = join(optionalRoot, "codex");
  const configDir = join(optionalRoot, "provider-config");
  const mountsFile = join(binDir, "mounts");
  const callsFile = join(binDir, "calls");
  const startedFile = join(binDir, "started");
  if (opts.codex) mkdirSync(codexDir);
  writeFileSync(
    mountsFile,
    [
      `${stateDir}\t/home/node/Remudero\ttrue`,
      `${credDir}\t/home/node/.claude\ttrue`,
      ...(opts.codex && !opts.omitCodexMount ? [`${codexDir}\t/home/node/.codex\ttrue`] : []),
      "",
    ].join("\n"),
  );
  writeDockerStub(binDir);
  writeFileSync(
    join(binDir, "az"),
    '#!/usr/bin/env bash\nif [ -n "${STUB_CALLS:-}" ]; then printf "az" >> "$STUB_CALLS"; for arg in "$@"; do printf "\\t%s" "$arg" >> "$STUB_CALLS"; done; printf "\\n" >> "$STUB_CALLS"; fi\nexit 0\n',
    { mode: 0o755 },
  );
  chmodSync(join(binDir, "az"), 0o755);
  const run = spawnSync(BASH_BIN, [opts.scriptPath ?? RECYCLE], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      STUB_CALLS: callsFile,
      STUB_MOUNTS_FILE: mountsFile,
      STUB_STARTED_FILE: startedFile,
      RMD_STATE_DIR: stateDir,
      RMD_CLAUDE_DIR: credDir,
      RMD_CODEX_DIR: codexDir,
      RMD_CONTAINER_CONFIG_DIR: configDir,
      RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_DOCKERENV_PATH: join(binDir, "no-dockerenv"),
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_SKIP_RECLAIM: "1",
      GH_TOKEN: "fixture-token",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      REGISTRY: "test-registry",
    },
  });
  return {
    status: run.status ?? -1,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    calls: existsSync(callsFile) ? readFileSync(callsFile, "utf8") : "",
    codexExists: existsSync(codexDir),
    configExists: existsSync(configDir),
  };
}

test("W1-T2857: absent optional sources stay absent and preserve the Claude-only launch", {
  skip: !BASH_SUPPORTS_ASSOCIATIVE_ARRAYS && "recycle-container.sh requires Bash 4; macOS ships Bash 3",
}, () => {
  const run = runRecycle({ codex: false });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.codexExists, false, "Docker must not create a missing optional Codex source");
  assert.equal(run.configExists, false, "Docker must not create a missing optional config source");
  const dockerRun = run.calls.split("\n").find((line) => line.startsWith("docker\trun\t")) ?? "";
  assert.match(dockerRun, /\/home\/node\/Remudero/);
  assert.match(dockerRun, /\/home\/node\/\.claude/);
  assert.doesNotMatch(dockerRun, /\/home\/node\/\.codex|\/home\/node\/\.config\/remudero/);
  assert.match(run.stdout, /runtime contract healthy/);
});

test("W1-T2857: a selected Codex mount missing after launch fails but leaves the replacement running", {
  skip: !BASH_SUPPORTS_ASSOCIATIVE_ARRAYS && "recycle-container.sh requires Bash 4; macOS ships Bash 3",
}, () => {
  const run = runRecycle({ codex: true, omitCodexMount: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /FAILED RUNTIME CONTRACT/);
  assert.match(run.stderr, /new container remains running/i);
  assert.ok(run.calls.split("\n").some((line) => line.startsWith("docker\trun\t")), "the replacement must already be running");
  assert.equal(run.calls.split("\n").filter((line) => line.startsWith("docker\tstop\t")).length, 0);
  assert.equal(run.calls.split("\n").filter((line) => line.startsWith("docker\trm\t")).length, 0);
});

test("W1-T2857: MUTANT deleting the runtime-contract call lets a missing selected mount report success", {
  skip: !BASH_SUPPORTS_ASSOCIATIVE_ARRAYS && "recycle-container.sh requires Bash 4; macOS ships Bash 3",
}, () => {
  const source = readFileSync(RECYCLE, "utf8");
  const start = "# ── 7.5. PROVE THE PROVIDER RUNTIME MOUNTS SELECTED BEFORE LAUNCH ──";
  const end = 'echo "recycle-container: OK —';
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  assert.ok(startAt >= 0 && endAt > startAt, "the runtime-contract integration block must be present and uniquely bounded");
  const mutantSource = `${source.slice(0, startAt)}${source.slice(endAt)}`;
  const fixtureDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}runtime-recycle-mutant-`));
  const mutant = join(fixtureDir, "recycle-container.sh");
  writeFileSync(mutant, mutantSource, { mode: 0o755 });
  chmodSync(mutant, 0o755);
  const run = runRecycle({ codex: true, omitCodexMount: true, scriptPath: mutant });
  assert.equal(run.status, 0, `the mutant must falsely report success or the integration call is not load-bearing: ${run.stderr}`);
  assert.match(run.stdout, /OK — remudero-daemon recycled/);
});
