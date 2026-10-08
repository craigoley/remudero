/**
 * deploy/edge-heal.sh: after a Docker data-root wipe the watchdog revives the daemons, but nothing
 * recreated remudero-serve or cloudflared, so the console went dark. Fake `docker` and a fake
 * serve-container.sh on disk; container presence is a marker file per name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEAL = join(process.cwd(), "deploy", "edge-heal.sh");
const FAKE_TOKEN = "fake-tunnel-token-not-real-0000";

interface Scene {
  root: string;
  present: string;
  dockerLog: string;
  serveLog: string;
  tokenFile: string;
  env: NodeJS.ProcessEnv;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** `present` names the containers/networks docker already has; `token` writes the token file. */
function scene(opts: { present: string[]; token: boolean }): Scene {
  const root = mkdtempSync(join(tmpdir(), "rmd-edge-heal-"));
  const stub = join(root, "stubbin");
  const present = join(root, "present");
  mkdirSync(stub);
  mkdirSync(present);
  for (const name of opts.present) writeFileSync(join(present, name), "");
  const dockerLog = join(root, "docker.log");
  const serveLog = join(root, "serve.log");
  writeExecutable(
    join(stub, "docker"),
    [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${dockerLog}"`,
      `P="${present}"`,
      'case "$1 $2" in',
      '  "container inspect") [ -e "$P/$3" ] ;;',
      '  "network inspect") [ -e "$P/net-$3" ] ;;',
      '  "network create") touch "$P/net-$3" ;;',
      '  "run -d") touch "$P/$4" ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  const serveScript = join(root, "serve-container.sh");
  writeExecutable(serveScript, `#!/usr/bin/env bash\necho "serve-container $* state=$RMD_STATE_DIR" >> "${serveLog}"\n`);
  const tokenFile = join(root, "cloudflared-token");
  if (opts.token) writeFileSync(tokenFile, `${FAKE_TOKEN}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${stub}:${process.env.PATH ?? ""}`,
    RMD_STATE_DIR: "/fixture/state",
    RMD_SERVE_CONTAINER_SCRIPT: serveScript,
    RMD_CLOUDFLARED_TOKEN_FILE: tokenFile,
  };
  return { root, present, dockerLog, serveLog, tokenFile, env };
}

const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
const heal = (s: Scene, args: string[] = []) => spawnSync("bash", [HEAL, ...args], { encoding: "utf8", env: s.env });

test("edge heal: an absent remudero-serve is recreated by serve-container.sh in create mode", () => {
  const s = scene({ present: ["cloudflared", "net-rmd-net"], token: true });
  try {
    const r = heal(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(s.serveLog), "serve-container  state=/fixture/state\n", "create mode: no --replace, the tick's state root");
    assert.doesNotMatch(read(s.dockerLog), /^(run|rm|network create) /m, "a present cloudflared and network are not touched");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("edge heal control: after a wipe (nothing present) it makes rmd-net once, then serve, then the tunnel", () => {
  const s = scene({ present: [], token: true });
  try {
    const r = heal(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(s.dockerLog).split("\n").filter((l) => l === "network create rmd-net").length, 1, read(s.dockerLog));
    assert.equal(read(s.serveLog), "serve-container  state=/fixture/state\n");
    assert.match(read(s.dockerLog), /^run -d --name cloudflared /m);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("edge heal control: rmd-net is never created beside a live cloudflared", () => {
  const s = scene({ present: ["cloudflared"], token: true });
  try {
    const r = heal(s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /rmd-net is absent while cloudflared exists; not creating it/);
    assert.doesNotMatch(read(s.dockerLog), /^network create /m);
    assert.equal(read(s.serveLog), "");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("edge heal: an absent cloudflared is created with --token-file from a read-only mount, and the token never reaches argv", () => {
  const s = scene({ present: ["remudero-serve", "net-rmd-net"], token: true });
  try {
    const r = heal(s);
    assert.equal(r.status, 0, r.stderr);
    const runs = read(s.dockerLog).split("\n").filter((l) => l.startsWith("run "));
    assert.equal(runs.length, 1, read(s.dockerLog));
    assert.equal(
      runs[0],
      `run -d --name cloudflared --restart=unless-stopped --network rmd-net -v ${s.tokenFile}:/etc/cloudflared/token:ro ` +
        "cloudflare/cloudflared:latest tunnel --no-autoupdate run --token-file /etc/cloudflared/token",
    );
    for (const text of [read(s.dockerLog), r.stdout, r.stderr]) assert.ok(!text.includes(FAKE_TOKEN), "the token value leaked");
    assert.doesNotMatch(read(s.dockerLog), /(^| )-e /m, "no env value carries the token");
    assert.equal(read(s.serveLog), "", "a present serve is not touched");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("edge heal: an absent cloudflared with no token file is refused in one line and nothing is run", () => {
  const s = scene({ present: ["remudero-serve", "net-rmd-net"], token: false });
  try {
    const r = heal(s);
    assert.equal(r.status, 1);
    const refusals = r.stderr.split("\n").filter((l) => l.includes("REFUSING"));
    assert.equal(refusals.length, 1, r.stderr);
    assert.match(refusals[0], /token file .*cloudflared-token is missing or empty/);
    assert.doesNotMatch(read(s.dockerLog), /^(run|network create|rm) /m);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("edge heal control: both containers present costs one container inspect each and nothing else", () => {
  const s = scene({ present: ["remudero-serve", "cloudflared"], token: true });
  try {
    const r = heal(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(s.dockerLog), "container inspect remudero-serve\ncontainer inspect cloudflared\n");
    assert.equal(read(s.serveLog), "");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("edge heal: --migrate-cloudflared replaces the live tunnel with the token-file shape", () => {
  const s = scene({ present: ["remudero-serve", "cloudflared", "net-rmd-net"], token: true });
  try {
    const r = heal(s, ["--migrate-cloudflared"]);
    assert.equal(r.status, 0, r.stderr);
    const calls = read(s.dockerLog).split("\n").filter(Boolean);
    assert.deepEqual(calls.map((c) => c.split(" ").slice(0, 2).join(" ")), ["pull cloudflare/cloudflared:latest", "network inspect", "rm -f", "run -d"]);
    assert.match(calls[3], /--token-file \/etc\/cloudflared\/token$/);
    assert.ok(!read(s.dockerLog).includes(FAKE_TOKEN));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

/** The core launcher calls the heal on a clean exit; a non-core instance launcher never does. */
test("edge heal: the core watchdog tick runs deploy/edge-heal.sh on a clean exit with its state root", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-edge-heal-launcher-"));
  try {
    const stateDir = join(root, "state-root");
    const stub = join(root, "stubbin");
    const healLog = join(root, "heal.log");
    for (const d of [join(stateDir, "state"), stub, join(stateDir, "daemon-install", "deploy")]) mkdirSync(d, { recursive: true });
    writeExecutable(join(stub, "docker"), '#!/usr/bin/env bash\n[ "$1" = ps ] && echo fake-id\nexit 0\n');
    writeExecutable(join(stateDir, "daemon-install", "deploy", "edge-heal.sh"), `#!/usr/bin/env bash\necho "heal state=$RMD_STATE_DIR" >> "${healLog}"\n`);
    const launcher = join(root, "rmd-relaunch.sh");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RMD_STATE_DIR: stateDir,
      RMD_UNIT_DIR: join(root, "systemd"),
      RMD_BIN_DIR: join(root, "bin"),
      RMD_LAUNCHER_PATH: launcher,
      RMD_REVIVAL_LOG: join(root, "revivals.log"),
      RMD_NODE_MAX_OLD_SPACE_MB: "8192",
      RMD_CASH_SECRET_DIR: join(root, "no-secrets"),
      PATH: `${stub}:${process.env.PATH ?? ""}`,
    };
    const install = spawnSync("bash", ["deploy/install-host-units.sh", "--install"], { encoding: "utf8", env });
    assert.equal(install.status, 0, install.stderr);
    const tick = spawnSync("bash", [launcher], { encoding: "utf8", env });
    assert.equal(tick.status, 0, tick.stderr);
    assert.match(tick.stdout, /already running -- nothing to do/);
    assert.equal(read(healLog), `heal state=${stateDir}\n`);

    // Daemon absent and /mnt/rmd unmounted: the launcher refuses, so the heal must not run.
    rmSync(healLog);
    writeExecutable(join(stub, "findmnt"), "#!/usr/bin/env bash\nexit 1\n");
    writeExecutable(join(stub, "docker"), "#!/usr/bin/env bash\nexit 0\n");
    const refused = spawnSync("bash", [launcher], { encoding: "utf8", env });
    assert.equal(refused.status, 1, "an unmounted /mnt/rmd is refused");
    assert.equal(read(healLog), "", "a refused tick never heals against an unverified state root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge heal control: a non-core instance launcher carries no edge heal", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-edge-heal-site-"));
  try {
    const registry = join(root, "daemon-instances.yaml");
    writeFileSync(
      registry,
      [
        "instances:",
        "  site:",
        "    repo: remudero-site",
        "    state_dir: /srv/remudero-site",
        "    container_name: remudero-site-daemon",
        "    service_user: test-user",
        "    image: example.invalid/remudero:test",
        "    max_old_space_mb: 8192",
        "    service_name: remudero-site.service",
        "    watchdog_service_name: remudero-site-watchdog.service",
        "    watchdog_timer_name: remudero-site-watchdog.timer",
        `    launcher_path: ${join(root, "site-launcher.sh")}`,
        `    revival_log: ${join(root, "site-revivals.log")}`,
        "    gh_app_id: 1",
        "    gh_app_installation_id: 2",
        "    gh_app_private_key_path: /etc/remudero/key.pem",
        "    claude_dir: /var/lib/remudero/claude",
        "    codex_dir: /var/lib/remudero/codex",
        "    container_config_dir: /etc/remudero",
        "",
      ].join("\n"),
    );
    const r = spawnSync("bash", ["deploy/install-host-units.sh", "--install", "--instance", "site"], {
      encoding: "utf8",
      env: { ...process.env, RMD_INSTANCE_REGISTRY: registry, RMD_UNIT_DIR: join(root, "systemd"), RMD_BIN_DIR: join(root, "bin") },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!readFileSync(join(root, "site-launcher.sh"), "utf8").includes("edge_heal_on_exit"), "only core heals the edge");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
