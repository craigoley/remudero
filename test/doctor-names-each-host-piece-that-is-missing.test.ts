// W1-T12074: on 2026-11-10 a deletion on the Azure host removed the dependency tool, the field-trials
// script, ~/.gh-token and the read broker's unit and launcher, and nothing named what was gone.
// These tests pin the host-piece list (src/lib/host-pieces.ts) and the doctor check that reads it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";

import { judgeHostPieces, readHostPieces } from "#src/lib/doctor.js";
import { allHostPieces, hostPieces, type HostPieceContext } from "#src/lib/host-pieces.js";
import { doctorCommand } from "#src/lib/report-commands.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const CTX: HostPieceContext = { home: "/home/fleet", stateRoot: "/home/fleet/rmd-state" };

/** The pieces the 2026-11-10 incident and the task record name, on the Linux fleet host. */
const REQUIRED_LINUX_IDS = [
  "dependency-tool",
  "gh-broker-unit",
  "gh-broker-launcher",
  "field-trials-script",
  "daemon-launcher",
  "heartbeat-script",
  "reclaim-script",
  "host-cleanup-script",
  "tmp-sweep-script",
  "reap-stray-script",
  "session-reaper-script",
  "acr-login-script",
  "github-login",
];

async function runDoctor(hostPieceExists: (path: string) => boolean) {
  const lines: string[] = [];
  const exitCode = await doctorCommand([], {
    out: (line) => lines.push(line),
    loadConfig: () => ({ root: CTX.stateRoot, claudeBin: "/bin/true" }),
    nowMs: Date.parse("2026-08-20T12:00:00Z"),
    readLedgerLines: () => [
      { step: "daemon.alive", phase: "dispatch", ts: "2026-08-20T11:59:00Z", poll_interval_ms: 300_000 },
      { step: "sweep.pass", ts: "2026-08-20T11:50:00Z" },
      { step: "sweep.summary", ts: "2026-08-20T11:50:05Z" },
    ],
    readMemInfo: () => ({ availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 }),
    readDiskFreeBytes: () => 40 * 1024 ** 3,
    readDiskTotalBytes: () => 100 * 1024 ** 3,
    readPauseAgeMs: () => undefined,
    liveInflightRuns: () => [],
    readLockFiles: () => ({ locks: [] }),
    readGitLocks: () => [],
    readWorkerProcesses: () => ({ count: 0, processes: [] }),
    readCheckoutDepth: () => ({ shallow: false, commitCount: 980 }),
    readNvmrcVersion: () => process.versions.node,
    readCaptureSurfaceFireHistory: () => [],
    readProviderRoutingStatus: () => ({ version: 1, state: "not-probed", freshness: "unknown" }),
    hostPieceExists,
  });
  return { exitCode, text: lines.join("\n") };
}

function commandContext(): HostPieceContext {
  return {
    ...CTX,
    home: homedir(),
    configHome: process.env.XDG_CONFIG_HOME || undefined,
    binDir: process.env.RMD_BIN_DIR || undefined,
    fleetInstallDir: process.env.RMD_FLEET_INSTALL_DIR || undefined,
    cleanupPath: process.env.RMD_CLEANUP_PATH || undefined,
    tmpSweepPath: process.env.RMD_TMP_SWEEP_PATH || undefined,
  };
}

test("W1-T12074 criterion 1: one list names each host piece with its path, what installs it and what fails without it", () => {
  const linux = hostPieces("linux", CTX);
  const ids = linux.map((p) => p.id);
  for (const id of REQUIRED_LINUX_IDS) assert.ok(ids.includes(id), `the Linux list names ${id}; got ${ids.join(", ")}`);
  assert.equal(new Set(ids).size, ids.length, "each piece is named once per platform");

  for (const p of allHostPieces(CTX)) {
    assert.ok(isAbsolute(p.path), `${p.id} names an absolute path: ${p.path}`);
    assert.ok(p.installer.trim().length > 0, `${p.id} names what installs it`);
    assert.ok(p.withoutIt.trim().length > 0, `${p.id} names what fails without it`);
    assert.ok(p.platforms.length > 0, `${p.id} names the platforms it applies to`);
    // An installer named as a repo script must exist in the repo, or the restore command is a guess.
    const script = /(?:^|\s)(deploy\/\S+\.sh)/.exec(p.installer)?.[1];
    if (script) assert.ok(existsSync(join(REPO_ROOT, script)), `${p.id}'s installer ${script} exists in the repo`);
  }

  // The paths are the ones the installers write.
  const byId = new Map(linux.map((p) => [p.id, p]));
  assert.equal(byId.get("dependency-tool")!.path, "/home/fleet/.local/bin/remudero-dependencies");
  assert.equal(byId.get("gh-broker-unit")!.path, "/home/fleet/.config/systemd/user/remudero-gh-read-broker.service");
  assert.equal(byId.get("gh-broker-launcher")!.path, "/home/fleet/.config/remudero/gh-broker-start.sh");
  assert.equal(byId.get("field-trials-script")!.path, "/home/fleet/.local/bin/rmd-field-trials-refresh");
  assert.equal(byId.get("host-cleanup-script")!.path, "/home/fleet/rmd-host-cleanup.sh");
  assert.equal(byId.get("tmp-sweep-script")!.path, "/home/fleet/rmd-tmp-sweep.sh");
  assert.equal(byId.get("heartbeat-script")!.path, "/home/fleet/rmd-state/daemon-install/scripts/fleet-heartbeat.sh");
  assert.equal(byId.get("host-cleanup-script")!.path, "/home/fleet/rmd-host-cleanup.sh");
  assert.equal(byId.get("tmp-sweep-script")!.path, "/home/fleet/rmd-tmp-sweep.sh");
  for (const id of ["host-cleanup-script", "tmp-sweep-script"]) {
    assert.equal(byId.get(id)!.installer, "sudo deploy/install-host-units.sh --install");
  }
  assert.equal(byId.get("github-login")!.path, "/home/fleet/.gh-token");
  assert.equal(byId.get("dependency-tool")!.installer, "bash deploy/install-dependency-seeds.sh");
  assert.equal(
    byId.get("heartbeat-script")!.installer,
    "git -C '/home/fleet/rmd-state/daemon-install' restore -- scripts/fleet-heartbeat.sh",
  );
  assert.equal(
    byId.get("reclaim-script")!.installer,
    "git -C '/home/fleet/rmd-state/daemon-install' restore -- deploy/host-update.sh",
  );
  const overridden = hostPieces("linux", { ...CTX, binDir: "/custom/bin", fleetInstallDir: "/custom/daemon-install" });
  assert.equal(overridden.find((p) => p.id === "reap-stray-script")!.path, "/custom/bin/rmd-reap-stray-containers");
  assert.equal(overridden.find((p) => p.id === "heartbeat-script")!.path, "/custom/daemon-install/scripts/fleet-heartbeat.sh");
  assert.equal(
    hostPieces("linux", { ...CTX, cleanupPath: "/custom/cleanup/host.sh" }).find((p) => p.id === "tmp-sweep-script")!.path,
    "/custom/cleanup/rmd-tmp-sweep.sh",
  );
  assert.equal(
    hostPieces("linux", { ...CTX, configHome: "/xdg" }).find((p) => p.id === "gh-broker-unit")!.path,
    "/xdg/systemd/user/remudero-gh-read-broker.service",
    "XDG_CONFIG_HOME moves the broker unit as the installer does",
  );
});

test("W1-T12074 criterion 2: the doctor command reports FAIL with every missing piece and restore command, then OK when all are present", async (t) => {
  t.mock.property(process, "platform", "linux");
  const savedEnv = new Map(
    ["RMD_BIN_DIR", "RMD_FLEET_INSTALL_DIR", "RMD_CLEANUP_PATH", "RMD_TMP_SWEEP_PATH"]
      .map((key) => [key, process.env[key]] as const),
  );
  t.after(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.RMD_BIN_DIR = "/custom/bin";
  process.env.RMD_FLEET_INSTALL_DIR = "/custom/daemon-install";
  process.env.RMD_CLEANUP_PATH = "/custom/cleanup/host.sh";
  process.env.RMD_TMP_SWEEP_PATH = "/custom/cleanup/hourly-sweep.sh";
  const pieces = hostPieces("linux", commandContext());
  const missingIds = ["dependency-tool", "heartbeat-script", "reclaim-script", "host-cleanup-script", "tmp-sweep-script", "reap-stray-script", "github-login"];
  const missingPaths = new Set(pieces.filter((p) => missingIds.includes(p.id)).map((p) => p.path));
  const seen: [string][] = [];
  const failed = await runDoctor((...args) => {
    seen.push(args);
    return !missingPaths.has(args[0]);
  });
  assert.deepEqual(seen, pieces.map((p) => [p.path]), "the command checks each applicable path with no other arguments");
  assert.equal(failed.exitCode, 2, failed.text);
  assert.match(failed.text, /\[FAIL\]\s+host-pieces\s+measured:/);
  assert.match(failed.text, /reap-stray-script missing at \/custom\/bin\/rmd-reap-stray-containers/);
  assert.match(failed.text, /heartbeat-script missing at \/custom\/daemon-install\/scripts\/fleet-heartbeat\.sh/);
  assert.match(failed.text, /host-cleanup-script missing at \/custom\/cleanup\/host\.sh/);
  assert.match(failed.text, /tmp-sweep-script missing at \/custom\/cleanup\/hourly-sweep\.sh/);
  assert.ok(failed.text.includes(`${missingIds.length} of ${pieces.length} missing: ${missingIds.join(", ")}`), failed.text);
  assert.deepEqual(
    failed.text.split("\n").map((line) => line.trim()).filter((line) => line.includes(" — restore: ")),
    pieces.filter((p) => missingPaths.has(p.path))
      .map((p) => `${p.id} missing at ${p.path} — restore: ${p.installer} — without it: ${p.withoutIt}`),
  );

  const healthy = await runDoctor(() => true);
  assert.equal(healthy.exitCode, 0, healthy.text);
  assert.match(healthy.text, /\[OK\s*\]\s+host-pieces\s+measured: \d+ of \d+ present/);
  assert.doesNotMatch(healthy.text, / — restore: /);
});

test("W1-T12074 criterion 2: the default reader tests real paths on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-host-pieces-"));
  try {
    const ctx: HostPieceContext = { home: join(dir, "home"), stateRoot: join(dir, "state"), binDir: join(dir, "bin") };
    for (const p of hostPieces("linux", ctx)) {
      mkdirSync(dirname(p.path), { recursive: true });
      writeFileSync(p.path, "");
    }
    assert.equal(judgeHostPieces(readHostPieces(ctx, "linux")).verdict, "OK");

    const removed = hostPieces("linux", ctx).find((p) => p.id === "field-trials-script")!;
    rmSync(removed.path);
    const check = judgeHostPieces(readHostPieces(ctx, "linux"));
    assert.equal(check.verdict, "FAIL");
    assert.match(check.measured, /^1 of \d+ missing: field-trials-script$/);
    assert.ok(check.detail!.includes(`restore: ${removed.installer}`), check.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T12074 criterion 3: the doctor command only checks and reports pieces for the running platform", async (t) => {
  const nothing = () => false;
  const platform = t.mock.property(process, "platform", "linux");
  const onLinux = await runDoctor(nothing);
  assert.equal(onLinux.exitCode, 2, onLinux.text);
  assert.match(onLinux.text, /gh-broker-unit missing at /);
  assert.match(onLinux.text, /github-login missing at .*\/\.gh-token /);
  assert.doesNotMatch(onLinux.text, /gh-broker-agent|LaunchAgents|hosts\.yml/);

  platform.mock.restore();
  t.mock.property(process, "platform", "darwin");
  const onMac = await runDoctor(nothing);
  assert.equal(onMac.exitCode, 2, onMac.text);
  assert.match(onMac.text, /gh-broker-agent missing at /);
  assert.match(onMac.text, /github-login missing at .*\/hosts\.yml /);
  assert.doesNotMatch(onMac.text, /gh-broker-unit|\.gh-token|host-cleanup-script|tmp-sweep-script/);

  const elsewhere = readHostPieces(CTX, "win32", nothing);
  assert.equal(elsewhere.checked, 0);
  assert.equal(judgeHostPieces(elsewhere).verdict, "OK", "a platform with no pieces reports none missing");
});
