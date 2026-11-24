import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { daemonSreLaneEnabled } from "#src/cli/commands/daemon.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import {
  escalateSreLaneUnresolved,
  escalateSreLaneUnresolvedCleared,
  SRE_LANE_UNRESOLVED_CLEARED_STEP,
  SRE_LANE_UNRESOLVED_ESCALATED_STEP,
} from "#src/lib/escalation-catalogue.js";
import { resolveSreLaneInstance, sreLaneStartRow } from "#src/lib/sre-lane.js";
import { legacyHostScript, withoutRegistrySelection } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T14611: every path that creates a daemon container names its instance, and a live primary daemon whose SRE lane
 * cannot find its instance pages the operator once. The recycle and installer cases drive the real scripts against a
 * temp registry and a stub docker; the daemon cases drive daemonSreLaneEnabled with the catalogue's own page.
 */

const RECYCLE = join(REPO_ROOT, "deploy", "recycle-container.sh");
const INSTALLER = join(REPO_ROOT, "deploy", "install-host-units.sh");
const HELPER = join(REPO_ROOT, "deploy", "launch-instance-name.sh");

/** A stub `docker` recording every call; `inspect` reports STUB_CONTAINER_ENV and the four state mounts. */
function writeDockerStub(dir: string): void {
  writeFileSync(join(dir, "docker"), [
    "#!/usr/bin/env bash",
    'printf "%s" "docker" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
    'case "$1" in',
    "  image)",
    '    if [ "$2" = "inspect" ]; then',
    "      shift 2",
    '      fmt=""',
    '      if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '      case "$fmt" in',
    '        *Config.Env*) echo ""; exit 0 ;;',
    '        *) echo "sha256:PULLEDID"; exit 0 ;;',
    "      esac",
    "    fi",
    "    exit 0 ;;",
    "  inspect)",
    "    shift",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    [ -n "$fmt" ] || exit 0',
    '    case "$fmt" in',
    '      *Config.Image*) echo "test-registry/remudero:old"; exit 0 ;;',
    '      *Config.Env*) printf "%s\\n" "GH_TOKEN=captured-token-value" $STUB_CONTAINER_ENV; exit 0 ;;',
    "      *Mounts*)",
    '        printf "%s\\t/home/node/Remudero\\ttrue\\n" "$RMD_STATE_DIR"',
    '        printf "%s\\t/home/node/.claude\\ttrue\\n" "${RMD_CLAUDE_DIR:-$HOME/.claude}"',
    '        printf "%s\\t/home/node/.codex\\ttrue\\n" "$RMD_CODEX_DIR"',
    '        printf "%s\\t/home/node/.config/remudero\\ttrue\\n" "$RMD_CONTAINER_CONFIG_DIR"',
    "        exit 0 ;;",
    '      *.Image}}*) echo "sha256:PULLEDID"; exit 0 ;;',
    "    esac",
    "    exit 0 ;;",
    "  pull)",
    '    echo "Status: Downloaded newer image"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(dir, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
}

interface Dirs { root: string; bin: string; rec: string; state: string; claude: string; codex: string; config: string; tmp: string }

/** One registry row in the recycle's own grammar; `overrides` replaces or adds fields. */
function row(name: string, dirs: Dirs, overrides: Record<string, string> = {}): string[] {
  const fields: Record<string, string> = {
    repo: "remudero",
    github_repo: "craigoley/remudero",
    state_dir: dirs.state,
    container_name: "remudero-daemon",
    image: "test-registry.azurecr.io/remudero:latest",
    claude_dir: dirs.claude,
    codex_dir: dirs.codex,
    container_config_dir: dirs.config,
    ...overrides,
  };
  return [`  ${name}:`, ...Object.entries(fields).map(([k, v]) => `    ${k}: ${v}`)];
}

interface Recycle {
  status: number;
  output: string;
  dirs: Dirs;
  runArgv: string[] | undefined;
  invoked: Record<string, unknown> | undefined;
}

/** Run the REAL recycle against a temp state dir and a stub docker. The registry is the copied checkout's own
 *  .remudero/daemon-instances.yaml, which is where a watchdog's recycle reads it. */
function recycle(t: TestContext, opts: { registry: (dirs: Dirs) => string[]; instance?: string; containerEnv?: string; caller?: string }): Recycle {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t14611-recycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs: Dirs = { root, bin: join(root, "bin"), rec: join(root, "rec"), state: join(root, "state-dir"), claude: join(root, "claude"), codex: join(root, "codex"), config: join(root, "config"), tmp: join(root, "tmp") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  mkdirSync(join(dirs.state, "state"), { recursive: true });
  writeDockerStub(dirs.bin);
  const cashKeyPath = join(root, "openweight-api-key");
  writeFileSync(cashKeyPath, "fixture-durable-openweight-key\n", { mode: 0o600 });
  const registry = join(root, "daemon-instances.yaml");
  writeFileSync(registry, ["instances:", ...opts.registry(dirs), ""].join("\n"));
  const r = spawnSync("bash", [legacyHostScript(root, RECYCLE, registry), ...(opts.instance === undefined ? [] : ["--instance", opts.instance])], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...withoutRegistrySelection(process.env),
      PATH: `${dirs.bin}:${process.env.PATH ?? ""}`,
      STUB_REC: dirs.rec,
      STUB_CONTAINER_ENV: opts.containerEnv ?? "",
      RMD_STATE_DIR: dirs.state,
      RMD_CLAUDE_DIR: dirs.claude,
      RMD_CODEX_DIR: dirs.codex,
      RMD_CONTAINER_CONFIG_DIR: dirs.config,
      RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
      RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_CALLER: opts.caller ?? "watchdog:deploy code",
      GH_TOKEN: "",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_INSTANCE_NAME: "",
      RMD_RECYCLE_DOCKERENV_PATH: join(root, "no-such-dockerenv-marker"),
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      TMPDIR: dirs.tmp,
    },
  });
  let calls: string[][] = [];
  try {
    calls = readFileSync(join(dirs.rec, "calls"), "utf8").split("\n").filter(Boolean).map((line) => line.split("\t").slice(1));
  } catch {
    calls = [];
  }
  let invoked: Record<string, unknown> | undefined;
  try {
    invoked = readFileSync(join(dirs.state, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.step === "recycle.invoked");
  } catch {
    invoked = undefined;
  }
  return {
    status: r.status ?? -1,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    dirs,
    runArgv: calls.find((argv) => argv[0] === "run" && argv[1] === "-d"),
    invoked,
  };
}

/** The values of every `-e RMD_INSTANCE_NAME=<v>` in an argv. */
function instanceNameArgs(argv: string[]): string[] {
  return argv.flatMap((a, i) => (argv[i - 1] === "-e" && a.startsWith("RMD_INSTANCE_NAME=") ? [a.slice("RMD_INSTANCE_NAME=".length)] : []));
}

/** An argv with its temp root written as <root>, so two runs compare. */
function portable(argv: string[], root: string): string[] {
  return argv.map((a) => a.split(root).join("<root>"));
}

/** The `INSTANCE_ENV_ARGS` a rendered launcher would pass to `docker run`, evaluated by bash. */
function launcherInstanceArgs(launcher: string): string[] {
  const line = launcher.split("\n").find((l) => l.startsWith("INSTANCE_ENV_ARGS=("));
  assert.ok(line, "the launcher must declare INSTANCE_ENV_ARGS");
  const r = spawnSync("bash", ["-c", `${line}\nprintf '%s\\n' "\${INSTANCE_ENV_ARGS[@]+"\${INSTANCE_ENV_ARGS[@]}"}"`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean);
}

/** Run the REAL installer with no --instance (the legacy install) against `registry`; returns the launcher text. */
function legacyInstall(t: TestContext, registryRows: (root: string) => string[]): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t14611-units-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const meminfo = join(root, "meminfo");
  writeFileSync(meminfo, "MemTotal:       16371996 kB\n");
  const registry = join(root, "daemon-instances.yaml");
  writeFileSync(registry, ["instances:", ...registryRows(root), ""].join("\n"));
  const launcher = join(root, "legacy-launcher.sh");
  const r = spawnSync("bash", [INSTALLER, "--install"], {
    encoding: "utf8",
    env: {
      ...withoutRegistrySelection(process.env),
      RMD_SERVICE_UID: "42424",
      RMD_MEMINFO_PATH: meminfo,
      RMD_INSTANCE_REGISTRY: registry,
      RMD_STATE_DIR: join(root, "state-dir"),
      RMD_DAEMON_CONTAINER: "remudero-daemon",
      RMD_UNIT_DIR: join(root, "systemd"),
      RMD_BIN_DIR: join(root, "bin"),
      RMD_LAUNCHER_PATH: launcher,
      RMD_REVIVAL_LOG: join(root, "revivals.log"),
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(launcher, "utf8");
}

/** Call the shared helper the way both scripts do. */
function helper(registry: string, container: string, stateDir: string): { status: number; stdout: string } {
  const r = spawnSync("bash", ["-c", '. "$1"; rmd_launch_instance_name --registry "$2" --container "$3" --state-dir "$4"', "helper", HELPER, registry, container, stateDir], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout };
}

// ── criterion 1: the no-instance recycle and the legacy launcher name the instance ──────────────────────────────────

test("W1-T14611 criterion 1: a watchdog recycle with no --instance names the one row matching its container and state dir", async (t) => {
  const run = recycle(t, {
    registry: (dirs) => [
      ...row("core", dirs, { primary: "true" }),
      ...row("site", dirs, { repo: "remudero-site", github_repo: "craigoley/remudero-site", container_name: "remudero-site-daemon", state_dir: `${dirs.state}-site` }),
    ],
  });
  assert.equal(run.status, 0, run.output);
  assert.ok(run.runArgv, `a replacement docker run must have happened:\n${run.output}`);
  assert.deepEqual(instanceNameArgs(run.runArgv), ["core"], "named exactly once");
  assert.ok(run.runArgv.indexOf("RMD_INSTANCE_NAME=core") < run.runArgv.indexOf("./bin/rmd"), "as an option, before the image");
  assert.match(run.output, /naming the container's instance 'core' from the registry row for remudero-daemon/);
  assert.equal(run.invoked?.caller, "watchdog:deploy code");

  // The container's daemon then resolves its instance by that name from inside the container.
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t14611-daemon-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = join(home, "daemon-instances.yaml");
  writeFileSync(registry, readFileSync(join(run.dirs.root, "daemon-instances.yaml")));
  const rows = await laneStart(t, { stateRoot: join(home, "Remudero"), registry, instanceName: instanceNameArgs(run.runArgv)[0] });
  assert.deepEqual(rows.map((r) => [r.step, r.fields.instance, r.fields.resolved_by]), [["sre_lane.started", "core", "env"]]);
});

test("W1-T14611 criterion 1: the legacy no-instance install renders the same instance into its launcher", (t) => {
  const launcher = legacyInstall(t, (root) => [
    "  core:", "    repo: remudero", `    state_dir: ${join(root, "state-dir")}/`, "    container_name: remudero-daemon", "    primary: true",
    "  site:", "    repo: remudero-site", `    state_dir: ${join(root, "site-state")}`, "    container_name: remudero-site-daemon",
  ]);
  assert.deepEqual(launcherInstanceArgs(launcher), ["-e", "RMD_INSTANCE_NAME=core"]);
  assert.match(launcher, /^INSTANCE_NAME=$/m, "the rendered INSTANCE_NAME stays empty, so watchdog_recycle still passes no --instance");
  const runAt = launcher.indexOf("docker run -d --name");
  assert.ok(runAt > 0 && launcher.indexOf("INSTANCE_ENV_ARGS[@]", runAt) > runAt, "the launcher's own docker run passes it");
});

// ── criterion 2: an unresolved primary daemon pages once, and the next start closes the page ──────────────────────

interface LaneRow { step: string; fields: Record<string, unknown> }

/** Run daemonSreLaneEnabled on `stateRoot` with the registry and env given; returns its logged rows. */
async function laneStart(
  t: TestContext,
  opts: { stateRoot: string; registry: string; instanceName?: string; sreLane?: string; page?: Parameters<typeof daemonSreLaneEnabled>[3]; enabled?: (on: boolean) => void;
    background?: Parameters<typeof daemonSreLaneEnabled>[4] },
): Promise<LaneRow[]> {
  const saved = Object.fromEntries(["RMD_INSTANCE_NAME", "RMD_INSTANCE_REGISTRY", "RMD_SELECTED_INSTANCE_REGISTRY", "RMD_SRE_LANE"].map((n) => [n, process.env[n]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.RMD_SELECTED_INSTANCE_REGISTRY;
  process.env.RMD_INSTANCE_REGISTRY = opts.registry;
  if (opts.instanceName === undefined) delete process.env.RMD_INSTANCE_NAME;
  else process.env.RMD_INSTANCE_NAME = opts.instanceName;
  if (opts.sreLane === undefined) delete process.env.RMD_SRE_LANE;
  else process.env.RMD_SRE_LANE = opts.sreLane;
  const rows: LaneRow[] = [];
  const on = await daemonSreLaneEnabled(opts.stateRoot, opts.stateRoot, (step, fields = {}) => rows.push({ step, fields }), opts.page, opts.background);
  opts.enabled?.(on);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return rows;
}

interface Fleet { home: string; stateRoot: string; registry: string; ledgerPath: string; issues: IssueGateway; created: string[]; closed: string[] }

/** The state root inside every daemon container, which no registry state_dir names. */
const CONTAINER_ROOT = "/home/node/Remudero";

/** A daemon on the container state root, a registry with one live primary, a ledger and a recording issue gateway. */
function fleet(t: TestContext, rows: string[] = ["  core:", "    github_repo: craigoley/remudero", "    primary: true", "    state_dir: /srv/host-core-state",
  "  site:", "    github_repo: craigoley/remudero-site", "    state_dir: /srv/host-site-state",
  "  old:", "    github_repo: craigoley/remudero-old", "    retired: true", "    state_dir: /srv/host-old-state"]): Fleet {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t14611-page-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "state"), { recursive: true });
  const registry = join(home, "daemon-instances.yaml");
  writeFileSync(registry, ["instances:", ...rows, ""].join("\n"));
  const ledgerPath = join(home, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const created: string[] = [];
  const closed: string[] = [];
  const issues: IssueGateway = {
    create(title, body) {
      created.push(`${title}\n${body}`);
      return `https://github.com/craigoley/remudero/issues/${9100 + created.length}`;
    },
    ensureLabel: () => true,
    closeWithComment(url) {
      closed.push(url);
    },
  };
  return { home, stateRoot: CONTAINER_ROOT, registry, ledgerPath, issues, created, closed };
}

/** The production page, bound as daemonCommand binds it, with the fixture's issue gateway. */
function page(f: Fleet): NonNullable<Parameters<typeof daemonSreLaneEnabled>[3]> {
  const ctx = { owner: "craigoley", repo: "remudero", ledgerPath: f.ledgerPath, runId: "DAEMON-14611", issues: f.issues };
  return { escalate: (info) => escalateSreLaneUnresolved(info, ctx), clear: (info) => escalateSreLaneUnresolvedCleared(info, ctx) };
}

function ledgerSteps(f: Fleet, step: string): Array<Record<string, unknown>> {
  return readFileSync(f.ledgerPath, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.step === step);
}

test("W1-T14611 criterion 2: an unresolved primary daemon pages once and its next lane start closes the page", async (t) => {
  const f = fleet(t);
  const first = await laneStart(t, { stateRoot: f.stateRoot, registry: f.registry, page: page(f) });
  assert.equal(first[0]?.step, "sre_lane.disabled");
  const reason = String(first[0]?.fields.reason);
  assert.match(reason, /is not exactly one instance's state_dir/);
  assert.equal(f.created.length, 1, "one page");
  assert.match(f.created[0]!, /The SRE lane is off on the primary daemon: it could not find its instance/);
  assert.match(f.created[0]!, /--instance core or set RMD_INSTANCE_NAME/);
  assert.ok(f.created[0]!.includes(f.stateRoot) && f.created[0]!.includes(f.registry), "names the state root and the registry");
  const escalated = ledgerSteps(f, SRE_LANE_UNRESOLVED_ESCALATED_STEP);
  assert.equal(escalated.length, 1);
  assert.deepEqual(
    { primary: escalated[0]!.primary, state_root: escalated[0]!.state_root, registry: escalated[0]!.registry, reason: escalated[0]!.reason, delivered: escalated[0]!.delivered },
    { primary: "core", state_root: f.stateRoot, registry: f.registry, reason, delivered: true },
  );

  // A restart in the same episode does not page again.
  await laneStart(t, { stateRoot: f.stateRoot, registry: f.registry, page: page(f) });
  assert.equal(f.created.length, 1);
  assert.equal(ledgerSteps(f, SRE_LANE_UNRESOLVED_ESCALATED_STEP).length, 1);

  // The next start that names its instance starts the lane and closes the page, once.
  const named = await laneStart(t, { stateRoot: f.stateRoot, registry: f.registry, instanceName: "core", page: page(f) });
  assert.equal(named[0]?.step, "sre_lane.started");
  assert.deepEqual(f.closed, [escalated[0]!.issue_url]);
  const cleared = ledgerSteps(f, SRE_LANE_UNRESOLVED_CLEARED_STEP);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.state_root, f.stateRoot);
  await laneStart(t, { stateRoot: f.stateRoot, registry: f.registry, instanceName: "core", page: page(f) });
  assert.equal(f.closed.length, 1, "nothing open, nothing closed");
  assert.equal(ledgerSteps(f, SRE_LANE_UNRESOLVED_CLEARED_STEP).length, 1);
});

test("W1-T14611 criterion 2: a failed escalation costs one daemon.escalation.failed row and never stops the boot", async (t) => {
  const f = fleet(t);
  let on: boolean | undefined;
  const rows = await laneStart(t, {
    stateRoot: f.stateRoot, registry: f.registry,
    page: { escalate: async () => { throw new Error("gh is down"); }, clear: async () => undefined },
    enabled: (value) => { on = value; },
  });
  assert.equal(on, false);
  assert.deepEqual(rows.map((r) => r.step), ["sre_lane.disabled", "daemon.escalation.failed"]);
  assert.match(String(rows[1]!.fields.error), /gh is down/);

  // An undelivered page leaves nothing open, so the next boot tries again.
  const failing: IssueGateway = { ...f.issues, create: () => { throw new Error("create refused"); } };
  const ctx = { owner: "craigoley", repo: "remudero", ledgerPath: f.ledgerPath, runId: "DAEMON-14611", issues: failing };
  await laneStart(t, { stateRoot: f.stateRoot, registry: f.registry, page: { escalate: (info) => escalateSreLaneUnresolved(info, ctx), clear: (info) => escalateSreLaneUnresolvedCleared(info, ctx) } });
  assert.equal(ledgerSteps(f, SRE_LANE_UNRESOLVED_ESCALATED_STEP).at(-1)?.delivered, false);
  await laneStart(t, { stateRoot: f.stateRoot, registry: f.registry, page: page(f) });
  assert.equal(f.created.length, 1);
});

test("W1-T14611: an unresolved SRE page records why its close could not be observed", async (t) => {
  for (const mode of ["missing-close", "throwing-close"] as const) {
    const f = fleet(t);
    const base = { owner: "craigoley", repo: "remudero", ledgerPath: f.ledgerPath, runId: "DAEMON-14611", issues: f.issues };
    await escalateSreLaneUnresolved({
      primary: "core", stateRoot: f.stateRoot, registry: f.registry, reason: "instance lookup failed",
    }, base);

    const issues: IssueGateway = mode === "missing-close"
      ? { create: f.issues.create, ensureLabel: f.issues.ensureLabel }
      : {
          ...f.issues,
          closeWithComment: () => { throw new Error("close refused"); },
        };
    await escalateSreLaneUnresolvedCleared({ stateRoot: f.stateRoot, instance: "core" }, { ...base, issues });

    const cleared = ledgerSteps(f, SRE_LANE_UNRESOLVED_CLEARED_STEP);
    assert.equal(cleared.length, 1, `${mode} writes one clear observation`);
    assert.equal(cleared[0]!.delivered, false);
    assert.equal(cleared[0]!.failure, mode === "missing-close" ? "issue gateway cannot close issues" : "close refused");
  }
});

// ── criterion 3: an instance that resolves today resolves the same way ──────────────────────────────────────────────

test("W1-T14611 criterion 3: the helper names nothing unless exactly one row matches both container and state dir", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t14611-helper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name: string, lines: string[]): string => {
    const path = join(root, name);
    writeFileSync(path, ["instances:", ...lines, ""].join("\n"));
    return path;
  };
  const core = ["  core:", "    container_name: remudero-daemon", "    state_dir: /srv/core-state"];
  const one = write("one.yaml", [...core, "  site:", "    container_name: remudero-site-daemon", "    state_dir: /srv/site-state"]);
  assert.deepEqual(helper(one, "remudero-daemon", "/srv/core-state"), { status: 0, stdout: "core\n" });
  assert.deepEqual(helper(one, "remudero-daemon", "/srv/core-state/"), { status: 0, stdout: "core\n" }, "a trailing slash is ignored");
  const quoted = write("quoted.yaml", ["  core:", '    container_name: "remudero-daemon"  # live', '    state_dir: "/srv/core-state/"']);
  assert.deepEqual(helper(quoted, "remudero-daemon", "/srv/core-state"), { status: 0, stdout: "core\n" });
  const nothing = { status: 0, stdout: "" };
  assert.deepEqual(helper(join(root, "absent.yaml"), "remudero-daemon", "/srv/core-state"), nothing, "absent registry");
  assert.deepEqual(helper(root, "remudero-daemon", "/srv/core-state"), nothing, "unreadable registry");
  assert.deepEqual(helper(one, "remudero-daemon", "/srv/site-state"), nothing, "the container matches another row's state dir only");
  assert.deepEqual(helper(one, "remudero-site-daemon", "/srv/core-state"), nothing, "the state dir matches another row's container only");
  assert.deepEqual(helper(one, "remudero-daemon", "/srv/elsewhere"), nothing, "no row");
  const two = write("two.yaml", [...core, "  core2:", "    container_name: remudero-daemon", "    state_dir: /srv/core-state"]);
  assert.deepEqual(helper(two, "remudero-daemon", "/srv/core-state"), nothing, "two rows match");
  const halfRow = write("half.yaml", ["  core:", "    container_name: remudero-daemon"]);
  assert.deepEqual(helper(halfRow, "remudero-daemon", "/srv/core-state"), nothing, "a row with no state dir");
});

test("W1-T14611 criterion 3: a recycle that names an instance today gives the same args, and a derived name only adds the env var", (t) => {
  // --instance: named once, from the flag, with no derived line.
  const flagged = recycle(t, { instance: "core", caller: "deploy-tick", registry: (dirs) => row("core", dirs) });
  assert.equal(flagged.status, 0, flagged.output);
  assert.deepEqual(instanceNameArgs(flagged.runArgv ?? []), ["core"]);
  assert.doesNotMatch(flagged.output, /naming the container's instance/);
  assert.equal(flagged.invoked?.instance, "core");

  // No row matches both columns: the args stay as they were.
  const unmatched = recycle(t, { registry: (dirs) => row("core", dirs, { container_name: "some-other-daemon" }) });
  assert.equal(unmatched.status, 0, unmatched.output);
  assert.deepEqual(instanceNameArgs(unmatched.runArgv ?? []), []);
  const sharedDir = recycle(t, { registry: (dirs) => [...row("core", dirs), ...row("twin", dirs)] });
  assert.equal(sharedDir.status, 0, sharedDir.output);
  assert.deepEqual(instanceNameArgs(sharedDir.runArgv ?? []), [], "two matching rows name nothing");

  // A derived name adds exactly `-e RMD_INSTANCE_NAME=<name>` and leaves INSTANCE_NAME (and so recycle.invoked) empty.
  const derived = recycle(t, { registry: (dirs) => row("core", dirs) });
  assert.equal(derived.status, 0, derived.output);
  assert.equal(derived.invoked?.instance, "");
  const withName = portable(derived.runArgv ?? [], derived.dirs.root);
  const at = withName.indexOf("RMD_INSTANCE_NAME=core");
  assert.ok(at > 0 && withName[at - 1] === "-e");
  assert.deepEqual([...withName.slice(0, at - 1), ...withName.slice(at + 1)], portable(unmatched.runArgv ?? [], unmatched.dirs.root));

  // A container that already carries the name is recycled with no drift refusal, and named once.
  const again = recycle(t, { registry: (dirs) => row("core", dirs), containerEnv: "RMD_INSTANCE_NAME=core" });
  assert.equal(again.status, 0, again.output);
  assert.doesNotMatch(again.output, /carries a runtime variable this recycle does not declare/);
  assert.deepEqual(instanceNameArgs(again.runArgv ?? []), ["core"]);
});

test("W1-T14611 criterion 3: a legacy install whose registry has no matching row renders an empty list", (t) => {
  const launcher = legacyInstall(t, (root) => [
    "  core:", "    repo: remudero", `    state_dir: ${join(root, "other-state")}`, "    container_name: remudero-daemon",
  ]);
  assert.deepEqual(launcherInstanceArgs(launcher), []);
});

test("W1-T14611 criterion 3: names that resolve today resolve the same way, and the lane off, retired or non-primary pages nothing", async (t) => {
  const f = fleet(t);
  const calls: string[] = [];
  const spy: NonNullable<Parameters<typeof daemonSreLaneEnabled>[3]> = {
    escalate: async () => { calls.push("escalate"); },
    clear: async () => { calls.push("clear"); },
  };
  const hostRoot = "/srv/host-core-state";
  for (const c of [
    { stateRoot: f.stateRoot, instanceName: "core" },
    { stateRoot: hostRoot },
    { stateRoot: f.stateRoot, instanceName: "site" },
    { stateRoot: f.stateRoot, instanceName: "old" },
    { stateRoot: f.stateRoot, sreLane: "0" },
  ]) {
    const env = c.instanceName === undefined ? {} : { RMD_INSTANCE_NAME: c.instanceName };
    const expected = sreLaneStartRow({
      instance: await resolveSreLaneInstance({ stateRoot: c.stateRoot, registryPath: f.registry, env }),
      env: { RMD_SRE_LANE: c.sreLane },
    });
    const without = await laneStart(t, { ...c, registry: f.registry });
    const withPage = await laneStart(t, { ...c, registry: f.registry, page: spy });
    assert.deepEqual(without, [expected], "the start row is unchanged");
    assert.deepEqual(withPage, [expected], "and the page adds no row");
  }
  assert.deepEqual(calls, ["clear", "clear"], "only the two started lanes send a clear; nothing escalates");

  // A registry with no live primary pages nothing either, on the container root or on a host root.
  const noPrimary = fleet(t, ["  core:", "    github_repo: craigoley/remudero", "    state_dir: /srv/host-core-state"]);
  await laneStart(t, { stateRoot: noPrimary.stateRoot, registry: noPrimary.registry, page: spy });
  await laneStart(t, { stateRoot: join(noPrimary.home, "laptop-root"), registry: noPrimary.registry, page: spy });
  // Nor does a host-side daemon whose lane is switched off.
  await laneStart(t, { stateRoot: join(f.home, "laptop-root"), registry: f.registry, sreLane: "0", page: spy });
  assert.deepEqual(calls, ["clear", "clear"]);
});

test("W1-T14611 criterion 2: an unresolved daemon pages on ANY state root, host-side as well as in a container", async (t) => {
  const f = fleet(t);
  // The class: the page depends on disabled + unresolved + one live primary only, never on where the state root is.
  const roots = [CONTAINER_ROOT, join(f.home, "laptop-root"), "/srv/unregistered-host-state"];
  for (const stateRoot of roots) {
    const rows = await laneStart(t, { stateRoot, registry: f.registry, page: page(f) });
    assert.equal(rows[0]?.step, "sre_lane.disabled", stateRoot);
    assert.match(String(rows[0]?.fields.reason), /is not exactly one instance's state_dir/, stateRoot);
  }
  const escalated = ledgerSteps(f, SRE_LANE_UNRESOLVED_ESCALATED_STEP);
  assert.deepEqual(escalated.map((e) => [e.state_root, e.primary, e.registry, e.delivered]),
    roots.map((root) => [root, "core", f.registry, true]), "one page per unresolved state root");
  assert.equal(f.created.length, roots.length);
  assert.ok(f.created[1]!.includes(roots[1]!), "the host-side page names its own state root");

  // A restart of the host-side daemon in the same episode does not page again; naming it closes only its own page.
  await laneStart(t, { stateRoot: roots[1]!, registry: f.registry, page: page(f) });
  assert.equal(f.created.length, roots.length);
  const named = await laneStart(t, { stateRoot: roots[1]!, registry: f.registry, instanceName: "core", page: page(f) });
  assert.equal(named[0]?.step, "sre_lane.started");
  assert.deepEqual(f.closed, [escalated[1]!.issue_url]);
  assert.deepEqual(ledgerSteps(f, SRE_LANE_UNRESOLVED_CLEARED_STEP).map((c) => c.state_root), [roots[1]]);
});

test("W1-T14611 criterion 2: under the test runner a registry outside the temp dir (the live fleet's) pages nothing", async (t) => {
  // A test boot of daemonCommand reads the checkout's own registry; it must never page the real primary through gh.
  // Moving TMPDIR to a sibling directory makes the fixture registry read as one outside the temp dir.
  const f = fleet(t);
  const savedTmp = process.env.TMPDIR;
  const elsewhere = join(f.home, "elsewhere-tmp");
  mkdirSync(elsewhere);
  process.env.TMPDIR = elsewhere;
  let rows: LaneRow[];
  try {
    rows = await laneStart(t, { stateRoot: join(f.home, "laptop-root"), registry: f.registry, page: page(f) });
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  }
  assert.deepEqual(rows.map((r) => r.step), ["sre_lane.disabled"], "the lane is off, with no failure row");
  assert.equal(f.created.length, 0);
  assert.equal(ledgerSteps(f, SRE_LANE_UNRESOLVED_ESCALATED_STEP).length, 0);

  // The same registry back inside the temp dir pages, so the guard is the only difference.
  await laneStart(t, { stateRoot: join(f.home, "laptop-root"), registry: f.registry, page: page(f) });
  assert.equal(f.created.length, 1);
});

test("W1-T14649 a boot does not wait for the SRE lane page to settle", async (t) => {
  const f = fleet(t);
  let settle: () => void = () => {};
  const held = new Promise<void>((resolve) => { settle = resolve; });
  let cleared = false;
  const slow: NonNullable<Parameters<typeof daemonSreLaneEnabled>[3]> = {
    escalate: async () => { await held; },
    clear: async () => { await held; cleared = true; },
  };
  let paged: Promise<void> | undefined;
  let on: boolean | undefined;
  const start = laneStart(t, { stateRoot: f.stateRoot, registry: f.registry, instanceName: "core", page: slow,
    background: (p) => { paged = p; }, enabled: (value) => { on = value; } });
  let timer: NodeJS.Timeout | undefined;
  const winner = await Promise.race([start.then(() => "boot" as const),
    new Promise<"page">((resolve) => { timer = setTimeout(() => resolve("page"), 2000); })]);
  clearTimeout(timer);
  if (winner === "page") settle(); // let the awaited page finish so the failing run still ends
  assert.equal(winner, "boot", "the lane start returned while its page was still held");
  assert.equal(on, true, "the lane start returned its answer");
  assert.ok(paged !== undefined, "the page was handed to the background");
  assert.equal(cleared, false, "the boot returned before the page's ledger read settled");
  settle();
  await paged;
  assert.equal(cleared, true, "the page still runs to completion");
});

test("W1-T14649 a lane start with no background still awaits its page", async (t) => {
  const f = fleet(t);
  let cleared = false;
  await laneStart(t, { stateRoot: f.stateRoot, registry: f.registry, instanceName: "core",
    page: { escalate: async () => {}, clear: async () => { await Promise.resolve(); cleared = true; } } });
  assert.equal(cleared, true);
});
