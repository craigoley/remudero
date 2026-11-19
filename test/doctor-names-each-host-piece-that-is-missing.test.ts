// W1-T12074: on 2026-11-10 a deletion on the Azure host removed the dependency tool, the field-trials
// script, ~/.gh-token and the read broker's unit and launcher, and nothing named what was gone.
// These tests pin the host-piece list (src/lib/host-pieces.ts) and the doctor check that reads it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";

import { buildDoctorReport, judgeHostPieces, readHostPieces } from "#src/lib/doctor.js";
import { allHostPieces, hostPieces, type HostPieceContext } from "#src/lib/host-pieces.js";
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
  "reap-stray-script",
  "session-reaper-script",
  "acr-login-script",
  "github-login",
];

function baseInputs(over: Partial<Parameters<typeof buildDoctorReport>[0]> = {}): Parameters<typeof buildDoctorReport>[0] {
  return {
    nowMs: Date.parse("2026-08-20T12:00:00Z"),
    ledgerLines: [
      { step: "daemon.alive", phase: "dispatch", ts: "2026-08-20T11:59:00Z", poll_interval_ms: 300_000 },
      { step: "sweep.pass", ts: "2026-08-20T11:50:00Z" },
      { step: "sweep.summary", ts: "2026-08-20T11:50:05Z" },
    ],
    candidateCount: 0,
    mem: { availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 },
    diskFreeBytes: 40 * 1024 ** 3,
    totalLocks: 0,
    deadLocks: [],
    gitLocks: [],
    workerCount: 0,
    checkoutDepth: { shallow: false, commitCount: 980 },
    runningNodeVersion: "22.22.3",
    nvmrcVersion: "22.22.3",
    ...over,
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
  assert.equal(byId.get("heartbeat-script")!.path, "/home/fleet/rmd-state/daemon-install/scripts/fleet-heartbeat.sh");
  assert.equal(byId.get("github-login")!.path, "/home/fleet/.gh-token");
  assert.equal(
    hostPieces("linux", { ...CTX, configHome: "/xdg" }).find((p) => p.id === "gh-broker-unit")!.path,
    "/xdg/systemd/user/remudero-gh-read-broker.service",
    "XDG_CONFIG_HOME moves the broker unit as the installer does",
  );
});

test("W1-T12074 criterion 2: the doctor check reports FAIL and names every missing piece with the command that restores it, and reports OK, its pass verdict, when all are present", () => {
  const gone = new Set(["dependency-tool", "gh-broker-unit", "github-login"]);
  const missingPaths = new Set(hostPieces("linux", CTX).filter((p) => gone.has(p.id)).map((p) => p.path));
  const seen: string[] = [];
  const reading = readHostPieces(CTX, {
    platform: "linux",
    exists: (path) => {
      seen.push(path);
      return !missingPaths.has(path);
    },
  });
  assert.deepEqual(seen, hostPieces("linux", CTX).map((p) => p.path), "the check is given each piece's path and nothing else");

  const report = buildDoctorReport(baseInputs({ hostPieces: reading }));
  const check = report.checks.find((c) => c.name === "host-pieces");
  assert.ok(check, "the host-pieces check is in the composed report");
  assert.equal(check!.verdict, "FAIL");
  assert.equal(report.exitCode, 2, "a missing piece makes rmd doctor exit 2");
  assert.match(check!.measured, /^3 of \d+ missing: dependency-tool, gh-broker-unit, github-login$/);
  for (const p of hostPieces("linux", CTX).filter((x) => gone.has(x.id))) {
    assert.ok(report.text.includes(`${p.id} missing at ${p.path} — restore: ${p.installer}`), `the report names ${p.id} with its restore command:\n${report.text}`);
  }
  for (const p of hostPieces("linux", CTX).filter((x) => !gone.has(x.id))) {
    assert.ok(!report.text.includes(`${p.id} missing`), `a present piece (${p.id}) is not reported missing`);
  }

  // All present: the check passes with doctor's passing verdict, OK.
  const healthy = buildDoctorReport(baseInputs({ hostPieces: readHostPieces(CTX, { platform: "linux", exists: () => true }) }));
  const ok = healthy.checks.find((c) => c.name === "host-pieces")!;
  assert.equal(ok.verdict, "OK");
  assert.equal(ok.detail, undefined);
  assert.equal(healthy.exitCode, 0);

  // A caller that measured no host adds no check.
  assert.equal(buildDoctorReport(baseInputs()).checks.some((c) => c.name === "host-pieces"), false);
});

test("W1-T12074 criterion 2: the default reader tests real paths on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-host-pieces-"));
  try {
    const ctx: HostPieceContext = { home: join(dir, "home"), stateRoot: join(dir, "state"), binDir: join(dir, "bin") };
    for (const p of hostPieces("linux", ctx)) {
      mkdirSync(dirname(p.path), { recursive: true });
      writeFileSync(p.path, "");
    }
    assert.equal(judgeHostPieces(readHostPieces(ctx, { platform: "linux" })).verdict, "OK");

    const removed = hostPieces("linux", ctx).find((p) => p.id === "field-trials-script")!;
    rmSync(removed.path);
    const check = judgeHostPieces(readHostPieces(ctx, { platform: "linux" }));
    assert.equal(check.verdict, "FAIL");
    assert.match(check.measured, /^1 of \d+ missing: field-trials-script$/);
    assert.ok(check.detail!.includes(`restore: ${removed.installer}`), check.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T12074 criterion 3: a piece that does not apply to this host, such as a Mac-only one on Linux, is not reported", () => {
  const nothing = () => false;
  const onLinux = judgeHostPieces(readHostPieces(CTX, { platform: "linux", exists: nothing }));
  assert.equal(onLinux.verdict, "FAIL");
  assert.ok(!onLinux.detail!.includes("gh-broker-agent"), "the Mac launchd agent is not reported on Linux");
  assert.ok(!onLinux.detail!.includes("LaunchAgents"), onLinux.detail);
  assert.ok(!onLinux.detail!.includes("hosts.yml"), "the Mac GitHub login path is not reported on Linux");
  assert.ok(onLinux.detail!.includes("gh-broker-unit"), "control: a Linux piece is reported on Linux");

  const onMac = judgeHostPieces(readHostPieces(CTX, { platform: "darwin", exists: nothing }));
  assert.ok(onMac.detail!.includes("gh-broker-agent"), "control: the Mac agent is reported on a Mac");
  assert.ok(!onMac.detail!.includes("gh-broker-unit"), "the Linux systemd unit is not reported on a Mac");
  assert.ok(!onMac.detail!.includes(".gh-token"), "the Linux token file is not reported on a Mac");

  const elsewhere = readHostPieces(CTX, { platform: "win32", exists: nothing });
  assert.equal(elsewhere.checked, 0);
  assert.equal(judgeHostPieces(elsewhere).verdict, "OK", "a platform with no pieces reports none missing");
});
