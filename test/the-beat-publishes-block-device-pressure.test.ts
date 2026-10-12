import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../src/lib/tmp.js";
import { REAL_SCRIPT } from "./helpers/fleet-heartbeat-harness.js";

const DAEMON_ID = "bcb1d8de856d4b71bdff7230db6102423802664c254970b9482578c18ab30631";

// Whole disks and partitions as sysfs lays them out: a partition's directory sits INSIDE its disk's.
const DISKS: Array<{ name: string; mm: string; parts?: Array<{ name: string; mm: string }> }> = [
  { name: "nvme0n2", mm: "259:0", parts: [{ name: "nvme0n2p1", mm: "259:2" }] },
  { name: "nvme0n1", mm: "259:1", parts: [{ name: "nvme0n1p1", mm: "259:6" }] },
  { name: "nvme1n1", mm: "259:7" },
];

/** A /proc/diskstats line: reads, read ms, writes, write ms, io ticks — the rest is filler. */
function stat(major: number, minor: number, name: string, c: { r: number; rms: number; w: number; wms: number; ticks: number }): string {
  return `${String(major).padStart(4)} ${String(minor).padStart(7)} ${name} ${c.r} 0 0 ${c.rms} ${c.w} 0 0 ${c.wms} 0 ${c.ticks} 0 0 0 0 0 0 0`;
}

interface Run {
  beat: Record<string, string>;
  snapshot?: string;
}

function beatOnce(opts: { prevAgoS?: number; publish?: boolean; cgroupUnreadable?: boolean } = {}): Run {
  const dir = makeTempDir("heartbeat-io");
  try {
    for (const path of ["bin", "scripts", "home", "state-root/state", "tmp", "scratch", "daemon-src", "sys/block", "sys/dev"])
      mkdirSync(join(dir, path), { recursive: true });
    const script = join(dir, "scripts", "fleet-heartbeat.sh");
    writeFileSync(script, readFileSync(REAL_SCRIPT), { mode: 0o755 });

    for (const disk of DISKS) {
      const diskDir = join(dir, "sys/block", disk.name);
      mkdirSync(diskDir, { recursive: true });
      writeFileSync(join(diskDir, "dev"), `${disk.mm}\n`);
      symlinkSync(diskDir, join(dir, "sys/dev", disk.mm));
      for (const part of disk.parts ?? []) {
        const partDir = join(diskDir, part.name);
        mkdirSync(partDir);
        writeFileSync(join(partDir, "dev"), `${part.mm}\n`);
        writeFileSync(join(partDir, "partition"), "1\n");
        symlinkSync(partDir, join(dir, "sys/dev", part.mm));
      }
    }

    // The slow data disk (nvme0n1) is busy 240 s of a 300 s interval: 80% util. 36,000 ios took
    // 3,600,000 ms between them: 100 ms await, 120 tps. Its partition's own row must be ignored.
    const prev = {
      root: { r: 1000, rms: 1000, w: 1000, wms: 1000, ticks: 1000 },
      data: { r: 500_000, rms: 9_000_000, w: 100_000, wms: 1_000_000, ticks: 7_000_000 },
      scratch: { r: 1, rms: 1, w: 1, wms: 1, ticks: 1 },
    };
    const now = {
      root: { r: 4000, rms: 4000, w: 1000, wms: 1000, ticks: 31_000 },
      data: { r: 530_000, rms: 12_000_000, w: 106_000, wms: 1_600_000, ticks: 7_240_000 },
      scratch: { r: 1, rms: 1, w: 1, wms: 1, ticks: 1 },
    };
    writeFileSync(join(dir, "diskstats"), [
      stat(259, 0, "nvme0n2", now.root),
      stat(259, 2, "nvme0n2p1", now.root),
      stat(259, 1, "nvme0n1", now.data),
      stat(259, 6, "nvme0n1p1", { r: 1, rms: 1, w: 1, wms: 1, ticks: 1 }),
      stat(259, 7, "nvme1n1", now.scratch),
      stat(7, 0, "loop0", now.scratch),
    ].join("\n") + "\n");

    const cg = join(dir, "cgroup");
    const daemonCg = join(cg, "system.slice", `docker-${DAEMON_ID}.scope`);
    const userCg = join(cg, "user.slice", "user-1000.slice");
    const journald = join(cg, "system.slice", "systemd-journald.service");
    for (const d of [daemonCg, userCg, journald]) mkdirSync(d, { recursive: true });
    if (!opts.cgroupUnreadable) {
      writeFileSync(join(daemonCg, "io.stat"), "259:1 rbytes=1300000 wbytes=2600000 rios=1100 wios=2000 dbytes=0 dios=0\n259:7 rbytes=9 wbytes=9 rios=9 wios=9 dbytes=0 dios=0\n");
      writeFileSync(join(userCg, "io.stat"), "259:1 rbytes=31000000 wbytes=0 rios=6000 wios=0 dbytes=0 dios=0\n");
      writeFileSync(join(journald, "io.stat"), "259:1 rbytes=1000 wbytes=500000 rios=1 wios=300 dbytes=0 dios=0\n");
    }

    const prevAgoS = opts.prevAgoS ?? 300;
    if (prevAgoS > 0) {
      const epoch = Math.floor(Date.now() / 1000) - prevAgoS;
      writeFileSync(join(dir, "state-root/state/heartbeat-io.txt"), [
        `epoch ${epoch}`,
        `disk 259:0 nvme0n2 ${prev.root.r} ${prev.root.w} ${prev.root.rms} ${prev.root.wms} ${prev.root.ticks}`,
        `disk 259:1 nvme0n1 ${prev.data.r} ${prev.data.w} ${prev.data.rms} ${prev.data.wms} ${prev.data.ticks}`,
        `disk 259:7 nvme1n1 ${prev.scratch.r} ${prev.scratch.w} ${prev.scratch.rms} ${prev.scratch.wms} ${prev.scratch.ticks}`,
        `cg docker-${DAEMON_ID}.scope remudero-daemon 259:1 1000000 2000000 1000 1700`,
        `cg user-1000.slice user-1000.slice 259:1 1000000 0 0 0`,
        `cg systemd-journald.service systemd-journald.service 259:1 1000 200000 1 0`,
      ].join("\n") + "\n");
    }
    writeFileSync(join(dir, "state-root/state/heartbeat-count.txt"), "1");

    const stub = (name: string, body: string) =>
      writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    stub("git", 'printf "fixture-sha\\n"');
    stub("uname", 'printf "Linux\\n"');
    stub("docker", `
case "$1" in
  ps) printf '%s %s\\n' "${DAEMON_ID}" remudero-daemon 4d2c0ffee cloudflared ;;
  inspect)
    case "$*" in
      *"range .Mounts"*) printf '%s\\n%s\\n' "$FIXTURE/daemon-src" "$FIXTURE/scratch" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac`);
    // The data disk is mounted as a partition: the probe must fold 259:6 into its disk, 259:1.
    stub("findmnt", `
p="$5"
case "$p" in
  /) printf '259:2\\n' ;;
  "$FIXTURE/state-root"|"$FIXTURE/daemon-src") printf '259:6\\n' ;;
  "$FIXTURE/scratch") printf '259:7\\n' ;;
  *) exit 1 ;;
esac`);

    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        HOME: join(dir, "home"),
        TMPDIR: join(dir, "tmp"),
        FIXTURE: dir,
        RMD_ROOT: join(dir, "state-root"),
        RMD_SCRATCH_ROOT: join(dir, "scratch"),
        RMD_HEARTBEAT_LOCK_HELD: "1",
        RMD_HEARTBEAT_DRY_RUN: opts.publish ? "" : "1",
        RMD_HEARTBEAT_BRANCH: "heartbeat-io-fixture",
        RMD_HEARTBEAT_DOCKER: join(dir, "bin", "docker"),
        RMD_HEARTBEAT_CONTAINER: "none",
        RMD_DISKSTATS: join(dir, "diskstats"),
        RMD_SYS_DEV_BLOCK: join(dir, "sys/dev"),
        RMD_CGROUP_ROOT: cg,
        RMD_JANITOR_LOGS: join(dir, "none.log"),
      },
    });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
    const beat = Object.fromEntries(result.stdout.split("\n").filter((line) => line.includes("="))
      .map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
    const snapshotPath = join(dir, "state-root/state/heartbeat-io.txt");
    return { beat, ...(existsSync(snapshotPath) ? { snapshot: readFileSync(snapshotPath, "utf8") } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the beat publishes each backing disk's util, await and tps from /proc/diskstats deltas", () => {
  const { beat } = beatOnce();
  const dt = Number(beat.io_interval_s);
  assert.ok(dt >= 300 && dt <= 305, `interval ${beat.io_interval_s}`);
  assert.equal(beat.io_devices, "nvme0n2,nvme0n1,nvme1n1", "partitions fold into their disks; an unbacked disk is not read");
  assert.equal(beat.io_nvme0n1_util_pct, String(Math.round(240_000 / (dt * 10))));
  assert.equal(beat.io_nvme0n1_await_ms, "100.0");
  assert.equal(beat.io_nvme0n1_tps, (36_000 / dt).toFixed(1));
  assert.equal(beat.io_nvme0n1_roles, "state,daemon");
  assert.equal(beat.io_nvme0n2_roles, "root");
  assert.equal(beat.io_nvme0n2_await_ms, "1.0");
  assert.equal(beat.io_nvme1n1_roles, "scratch,daemon");
  assert.equal(beat.io_nvme1n1_util_pct, "0");
  assert.equal(beat.io_nvme1n1_await_ms, "0.0", "an idle disk is 0, measured");
  assert.equal(beat.io_loop0_util_pct, undefined);
});

test("the beat names the cgroups that read the most from each disk, daemons by container name", () => {
  const { beat } = beatOnce();
  const dt = Number(beat.io_interval_s);
  const bps = (bytes: number) => String(Math.round(bytes / dt));
  assert.equal(
    beat.io_nvme0n1_readers,
    `user-1000.slice:${bps(30_000_000)}:${(6000 / dt).toFixed(1)},remudero-daemon:${bps(300_000)}:${(100 / dt).toFixed(1)}`,
    "most bytes read first; a cgroup that read nothing is not a reader",
  );
  assert.equal(beat["io_cg_remudero-daemon_nvme0n1"], `rbps=${bps(300_000)} wbps=${bps(600_000)} riops=${(100 / dt).toFixed(1)} wiops=${(300 / dt).toFixed(1)}`);
  assert.equal(beat["io_cg_remudero-daemon_nvme1n1"], undefined, "a cgroup row with no previous counters has no delta");
});

test("a first beat and an unreadable cgroup tree publish unknown, never a zero", () => {
  const first = beatOnce({ prevAgoS: 0 }).beat;
  assert.equal(first.io_interval_s, "unknown");
  assert.equal(first.io_nvme0n1_util_pct, "unknown");
  assert.equal(first.io_nvme0n1_tps, undefined);
  assert.equal(first.io_nvme0n1_readers, undefined);
  const blind = beatOnce({ cgroupUnreadable: true }).beat;
  assert.match(blind.io_nvme0n1_util_pct ?? "", /^[0-9]+$/);
  assert.equal(blind.io_nvme0n1_readers, undefined);
});

test("a published beat keeps the raw counters so the next beat can take a delta", () => {
  const { snapshot } = beatOnce({ publish: true });
  assert.ok(snapshot, "the published beat must write state/heartbeat-io.txt");
  assert.match(snapshot, /^epoch [0-9]+$/m);
  assert.match(snapshot, /^disk 259:1 nvme0n1 530000 106000 12000000 1600000 7240000$/m);
  assert.match(snapshot, new RegExp(`^cg docker-${DAEMON_ID}\\.scope remudero-daemon 259:1 1300000 2600000 1100 2000$`, "m"));
  assert.equal(beatOnce().snapshot?.includes("530000"), false, "a dry run leaves the previous counters alone");
});
