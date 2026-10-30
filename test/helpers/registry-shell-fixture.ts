import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

export interface Receipt { bin: string; args: string[]; selected?: string; workerEnv?: Record<string, string> }

/** Real shell programs, disposable namespaces, recording external transports. */
export function registryShellFixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-registry-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "transports"), state = join(root, "state-root"), output = join(root, "output");
  for (const dir of [bin, output, join(state, "state"), join(state, "daemon-install", ".git"),
    join(state, "remudero", ".git"), join(root, "home"), join(root, "cgroups")]) mkdirSync(dir, { recursive: true });
  // The maintained script directory is used verbatim. No production state or real git is reachable.
  symlinkSync(join(REPO_ROOT, "deploy"), join(state, "daemon-install", "deploy"));
  writeFileSync(join(state, "state", "ledger.ndjson"), '{"step":"daemon.idle","ts":"2026-10-29T00:00:00Z"}\n');
  const selected = join(root, "selected-private.yaml"), session = join(root, "session.json");
  const text = "instances:\n  core:\n    github_repo: craigoley/remudero\n    mode: shadow\n    state_dir: /private-material-sentinel\n";
  writeFileSync(selected, text);
  const legacy = join(root, "legacy.yaml");
  writeFileSync(legacy, `instances:\n  core:\n    state_dir: ${state}\n    container_name: remudero-daemon\n`);
  const callsPath = join(root, "calls.ndjson"), payload = join(root, "published.txt");
  writeFileSync(callsPath, "");
  const transport = `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const bin = path.basename(process.argv[1]), args = process.argv.slice(2), e = process.env;
let workerEnv;
if (bin === "docker" && args[0] === "run") {
  workerEnv = {};
  for (let i = 1; i < args.length; i++) {
    let value;
    if (args[i] === "-e" || args[i] === "--env") value = args[++i];
    else if (args[i].startsWith("--env=")) value = args[i].slice(6);
    if (!value) continue;
    const split = value.indexOf("="), key = split < 0 ? value : value.slice(0, split);
    if (split >= 0) workerEnv[key] = value.slice(split + 1);
    else if (e[key] !== undefined) workerEnv[key] = e[key];
  }
}
fs.appendFileSync(e.FIXTURE_CALLS, JSON.stringify({bin, args, selected:e.RMD_INSTANCE_REGISTRY, workerEnv}) + "\n");
const out = s => process.stdout.write(s + "\n");
if (bin === "id") { out(e.FIXTURE_ELEVATED ? "0" : e.FIXTURE_UID); process.exit(0); }
if (bin === "sudo") {
  let a = args.filter(a => a !== "-n");
  const dropping = a[0] === "-u";
  if (dropping && e.FIXTURE_DROP_FAIL) process.exit(93);
  if (dropping) { if (a[1] !== "#" + e.FIXTURE_UID) process.exit(91); a = a.slice(3); }
  const env = {...e};
  if (dropping) { delete env.FIXTURE_ELEVATED; delete env.SUDO_UID; }
  else { env.FIXTURE_ELEVATED = "1"; env.SUDO_UID = e.FIXTURE_UID; }
  const r = cp.spawnSync(a[0], a.slice(1), {env, stdio:"inherit"}); process.exit(r.status ?? 92);
}
if (bin === "git") {
  let a = [...args]; while(a[0] === "-C") a = a.slice(2);
  if (a[0] === "symbolic-ref") out("main");
  else if (a[0] === "rev-parse") out("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  else if (a[0] === "hash-object") { fs.writeFileSync(e.FIXTURE_PAYLOAD, fs.readFileSync(0)); out("1".repeat(40)); }
  else if (a[0] === "mktree") { fs.readFileSync(0); out("2".repeat(40)); }
  else if (a[0] === "commit-tree") out("3".repeat(40));
  else if (a[0] === "fetch" && e.FIXTURE_MUTATE === "fetch") fs.appendFileSync(e.FIXTURE_SELECTED, "# revised while converging\n");
  process.exit(0);
}
if (bin === "docker") {
  if (args[0] === "ps") {
    if (args.includes("{{.ID}} {{.Names}}")) {
      if (e.FIXTURE_MUTATE === "measurement") fs.appendFileSync(e.FIXTURE_SELECTED, "# revised at measurement\n");
      out("fixture-id remudero-daemon\nother-id " + (e.FIXTURE_SAME_NAME ? "remudero-daemon" : "remudero-other-daemon"));
    } else if (e.FIXTURE_RUNNING === "1") out("fixture-id");
  } else if (args[0] === "inspect") {
    const fmt = args[args.indexOf("--format") + 1] ?? "";
    if (fmt.includes("MemoryHigh")) out("/remudero-daemon uint64 6442450944\n/remudero-other-daemon uint64 6442450944");
    else if (fmt.includes("Mounts")) out("");
    else if (fmt.includes(".State.Status")) out("exited");
    else if (fmt.includes(".State.ExitCode") || fmt.includes("RestartCount")) out("1");
    else if (fmt.includes(".State.Running")) out("true");
    else if (fmt.includes("NetworkSettings.Networks")) out("yes");
    else if (fmt.includes(".Image")) out("sha256:fixture");
  } else if (args[0] === "run") out("fixture-started");
  else if (args[0] === "logs") out("listening on http://0.0.0.0:4317");
  else if (args[0] === "network") out("fixture-tunnel");
  process.exit(0);
}
if (bin === "findmnt") { out(args.includes("MAJ:MIN") ? "8:1" : "/"); process.exit(0); }
if (bin === "df") { out("Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 100000 1000 99000 1% /"); process.exit(0); }
if (bin === "uname") { out("Linux"); process.exit(0); }
if (bin === "hostname") { out("fixture-host"); process.exit(0); }
if (bin === "systemctl") process.exit(args[0]?.startsWith("is-") ? 1 : 0);
if (bin === "az" && args[0] === "acr" && args[1] === "login") process.exit(0);
// No Azure, GitHub, mount or credential operation may escape the fixture.
if (["az", "gh", "mount", "umount", "curl", "crontab", "du", "sysctl"].includes(bin)) process.exit(97);
process.exit(98);
`;
  for (const name of ["id", "sudo", "git", "docker", "findmnt", "df", "uname", "hostname", "systemctl",
    "az", "gh", "mount", "umount", "curl", "crontab", "du", "sysctl"]) writeFileSync(join(bin, name), transport, { mode: 0o700 });
  const meminfo = join(root, "meminfo"); writeFileSync(meminfo, "MemTotal: 32768000 kB\nMemAvailable: 16000000 kB\n");
  for (const id of ["fixture-id", "other-id"]) {
    const dir = join(root, "cgroups", "docker", id); mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of Object.entries({ "memory.high": "6442450944", "memory.max": "max",
      "memory.current": "1048576", "memory.events": "high 0", "memory.stat": "anon 1048576\nfile 0\nworkingset_refault_file 0" })) writeFileSync(join(dir, name), bytes + "\n");
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: join(root, "home"), TMPDIR: root,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    FIXTURE_UID: String(process.getuid?.()), FIXTURE_CALLS: callsPath, FIXTURE_PAYLOAD: payload,
    FIXTURE_SELECTED: selected, RMD_INSTANCE_REGISTRY: legacy, RMD_ROOT: state, RMD_STATE_DIR: state,
    RMD_UNIT_DIR: join(output, "systemd"), RMD_BIN_DIR: join(output, "bin"),
    RMD_LAUNCHER_PATH: join(output, "launcher"), RMD_REVIVAL_LOG: join(output, "revivals.log"),
    RMD_SERVICE_USER: "fixture", RMD_SERVICE_UID: "42424", RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_MEMINFO_PATH: meminfo, RMD_MEMINFO: meminfo, RMD_CGROUP_ROOT: join(root, "cgroups"),
    RMD_DISKSTATS: join(root, "no-diskstats"), RMD_SYS_DEV_BLOCK: join(root, "no-blocks"),
    RMD_CLAUDE_DIR: join(root, "claude"), RMD_CODEX_DIR: join(root, "codex"),
    RMD_CONTAINER_CONFIG_DIR: join(root, "config"), RMD_CASH_SECRET_DIR: join(root, "secrets"),
    RMD_GH_APP_PRIVATE_KEY_HOST_PATH: "", RMD_CLEANUP_PATH: "", RMD_LEGACY_USER_UNIT_DIR: "",
    RMD_SYSTEMCTL_CMD: join(bin, "systemctl"), RMD_CRONTAB_CMD: join(bin, "crontab"),
    RMD_HEARTBEAT_DOCKER: join(bin, "docker"), RMD_HEARTBEAT_SYSTEMCTL: join(bin, "systemctl"),
    RMD_JANITOR_LOGS: join(root, "janitor.log"), RMD_SESSION_REAPER_LOG: join(root, "reaper.log"),
    RMD_STATE_SNAPSHOT_RECEIPT: join(root, "backup.receipt"), RMD_CONSUMER_EVERY: "999999",
    RMD_SCRATCH: "off", RMD_SCRATCH_CHECKOUTS: "off", RMD_SCRATCH_ROOT: join(root, "scratch"),
    RMD_SERVE_DOCKERENV_PATH: join(root, "no-dockerenv"), GH_TOKEN: "fixture-token",
  };
  const run = (script: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}, shell = "bash") => {
    const r = spawnSync(shell, [script, ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 90_000 });
    assert.equal(r.error, undefined, `${script}: ${r.error}`);
    return r;
  };
  const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(process.execPath, ["--import", join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs"),
      join(REPO_ROOT, "src/lib/child-entry-argv.ts"), "--selected-registry-shadow", REPO_ROOT, ...args],
    { env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const capture = (options: string[] = ["--registry", selected]) => cli(["--shadow", "--capture", "--session", session, ...options],
    { RMD_INSTANCE_REGISTRY: undefined });
  const receipts = (): Receipt[] => readFileSync(callsPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const rows = (): Record<string, unknown>[] => readFileSync(session + ".observations", "utf8").trim().split("\n").map(line => JSON.parse(line));
  const install = (shadow = true) => run(join(REPO_ROOT, "deploy/install-host-units.sh"),
    ["--install", ...(shadow ? ["--selected-registry-shadow", session] : [])]);
  return { root, state, output, selected, session, text, legacy, payload, env, run, cli, capture, receipts, rows, install };
}
