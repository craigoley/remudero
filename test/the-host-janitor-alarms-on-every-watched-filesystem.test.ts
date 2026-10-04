/**
 * W1-T5548 — the host janitor judges EVERY watched filesystem, not only `/`.
 *
 * deploy/rmd-host-cleanup.sh used to fail a pass only when RMD_CLEANUP_ROOT_FS was at HIGH_WATER,
 * so /mnt/scratch (the swapfile) and /mnt/rmd (every state root) were never judged. Each case below
 * drives the REAL script against fixture directories: the watch list comes in through
 * RMD_CLEANUP_WATCH_FS and the df reader through RMD_CLEANUP_DF (a fake that maps each fixture path
 * to a device from a table), so no case reads the real /, /mnt/* or `df`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fixture, run, type Fixture } from "./helpers/host-cleanup-fixture.js";

interface Disk { path: string; device: string; pct: number; availKb: number; mount: string }

const GB = 1024 * 1024;

/** A fake `df -Pk <path>`: one table row per readable path; any other path is an unreadable df. */
function fakeDf(fx: Fixture, disks: Disk[]): Record<string, string> {
  const table = join(fx.root, "df.table");
  writeFileSync(table, disks.map(d => [d.path, d.device, d.pct, d.availKb, d.mount].join("|")).join("\n") + "\n");
  const df = join(fx.root, "bin", "df-by-path");
  writeFileSync(df, [
    "#!/usr/bin/env bash",
    `row="$(awk -F'|' -v p="$1" '$1 == p' '${table}')"`,
    '[ -n "$row" ] || { echo "df: $1: Input/output error" >&2; exit 1; }',
    "IFS='|' read -r _ dev pct avail mount <<<\"$row\"",
    "echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
    'echo "$dev 1000000000 1 $avail $pct% $mount"',
    "",
  ].join("\n"));
  chmodSync(df, 0o755);
  return { RMD_CLEANUP_DF: df };
}

function dir(fx: Fixture, name: string): string {
  const p = join(fx.root, "mounts", name);
  mkdirSync(p, { recursive: true });
  return p;
}

function fsLines(stdout: string): string[] {
  return stdout.split("\n").filter(l => l.startsWith("rmd-host-cleanup: fs "));
}

test("every watched filesystem is reported once per device, keeping the strictest mark", () => {
  const fx = fixture();
  const state = dir(fx, "rmd");
  const stateTmp = dir(fx, "rmd-tmp"); // a second path on the SAME device as state
  const scratch = dir(fx, "scratch");
  const env = fakeDf(fx, [
    { path: fx.rootfs, device: "/dev/root", pct: 60, availKb: 40 * GB, mount: "/" },
    { path: state, device: "/dev/sdb1", pct: 70, availKb: 30 * GB, mount: "/mnt/rmd" },
    { path: stateTmp, device: "/dev/sdb1", pct: 70, availKb: 30 * GB, mount: "/mnt/rmd" },
    { path: scratch, device: "/dev/sdc1", pct: 18, availKb: 350 * GB, mount: "/mnt/scratch" },
  ]);
  const r = run(fx, { ...env, RMD_CLEANUP_WATCH_FS: `${fx.rootfs}:85 ${state}:85 ${stateTmp}:75/20G ${scratch}:90/40G` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const lines = fsLines(r.stdout);
  assert.deepEqual(lines, [
    "rmd-host-cleanup: fs / (/dev/root) 60% used, 40G free, mark 85%",
    "rmd-host-cleanup: fs /mnt/rmd (/dev/sdb1) 70% used, 30G free, mark 75%/20G",
    "rmd-host-cleanup: fs /mnt/scratch (/dev/sdc1) 18% used, 350G free, mark 90%/40G",
  ], r.stdout);
  assert.doesNotMatch(r.stdout, /FAIL/);
  // the heartbeat parses the LAST `rmd-host-cleanup: ... ->` line; the per-device lines carry no arrow
  assert.match(r.stdout, /rmd-host-cleanup: \/ 60% -> 60% \(0 MB reclaimed this pass\)/);
  for (const l of lines) assert.doesNotMatch(l, /->/);
});

test("a full second device fails the pass and is named, while the root alone would pass", () => {
  const fx = fixture();
  const state = dir(fx, "rmd");
  const scratch = dir(fx, "scratch");
  const disks: Disk[] = [
    { path: fx.rootfs, device: "/dev/root", pct: 60, availKb: 40 * GB, mount: "/" },
    { path: state, device: "/dev/sdb1", pct: 90, availKb: 12 * GB, mount: "/mnt/rmd" },
    { path: scratch, device: "/dev/sdc1", pct: 18, availKb: 350 * GB, mount: "/mnt/scratch" },
  ];
  const r = run(fx, { ...fakeDf(fx, disks), RMD_CLEANUP_WATCH_FS: `${fx.rootfs}:85 ${state}:85 ${scratch}:90/40G` });
  assert.equal(r.status, 1, `a device past its mark must fail the pass\n${r.stdout}`);
  assert.match(r.stdout, /rmd-host-cleanup: FAIL \/mnt\/rmd is at 90% with 12G free \(\/dev\/sdb1\), past its mark 85%/);
  assert.doesNotMatch(r.stdout, /FAIL \/ /, "the root is under its mark and must not be named");
  assert.doesNotMatch(r.stdout, /FAIL \/mnt\/scratch/);

  // a device under its percent but short of its minimum free space is past its mark too
  const fx2 = fixture();
  const scratch2 = dir(fx2, "scratch");
  const r2 = run(fx2, {
    ...fakeDf(fx2, [
      { path: fx2.rootfs, device: "/dev/root", pct: 60, availKb: 40 * GB, mount: "/" },
      { path: scratch2, device: "/dev/sdc1", pct: 87, availKb: 39 * GB, mount: "/mnt/scratch" },
    ]),
    RMD_CLEANUP_WATCH_FS: `${scratch2}:90/40G`,
  });
  assert.equal(r2.status, 1, r2.stdout);
  assert.match(r2.stdout, /FAIL \/mnt\/scratch is at 87% with 39G free \(\/dev\/sdc1\), past its mark 90%\/40G/);

  // and every device past its mark is named, not only the first
  const fx3 = fixture();
  const state3 = dir(fx3, "rmd");
  const r3 = run(fx3, {
    ...fakeDf(fx3, [
      { path: fx3.rootfs, device: "/dev/root", pct: 95, availKb: 512 * 1024, mount: "/" },
      { path: state3, device: "/dev/sdb1", pct: 90, availKb: 12 * GB, mount: "/mnt/rmd" },
    ]),
    RMD_CLEANUP_WATCH_FS: `${fx3.rootfs}:85 ${state3}:85`,
  });
  assert.equal(r3.status, 1, r3.stdout);
  assert.match(r3.stdout, /FAIL \/ is at 95% with 512M free \(\/dev\/root\), past its mark 85%/);
  assert.match(r3.stdout, /FAIL \/mnt\/rmd is at 90%/);
});

test("an unreadable filesystem reads unknown, never full or empty, and a missing path is skipped", () => {
  const fx = fixture();
  const blind = dir(fx, "blind"); // exists, but the df reader cannot read it
  const absent = join(fx.root, "mounts", "never-created");
  const env = fakeDf(fx, [{ path: fx.rootfs, device: "/dev/root", pct: 60, availKb: 40 * GB, mount: "/" }]);
  const r = run(fx, { ...env, RMD_CLEANUP_WATCH_FS: `${fx.rootfs}:85 ${blind}:85 ${absent}:85` });
  assert.equal(r.status, 0, `an unknown is not a full filesystem\n${r.stdout}`);
  assert.ok(fsLines(r.stdout).includes(`rmd-host-cleanup: fs ${blind} unknown (df unreadable), mark 85%`), r.stdout);
  assert.doesNotMatch(r.stdout, new RegExp(`fs ${blind} [0-9]+% used`), "an unreadable filesystem has no percentage");
  assert.doesNotMatch(r.stdout, /FAIL/);
  assert.equal(r.stdout.includes(absent), false, "a watched path that does not exist is skipped");
});

test("HIGH_WATER stays the root's mark when the watch list omits it", () => {
  const fx = fixture();
  const scratch = dir(fx, "scratch");
  const env = fakeDf(fx, [
    { path: fx.rootfs, device: "/dev/root", pct: 70, availKb: 40 * GB, mount: "/" },
    { path: scratch, device: "/dev/sdc1", pct: 18, availKb: 350 * GB, mount: "/mnt/scratch" },
  ]);
  const r = run(fx, { ...env, HIGH_WATER: "65", RMD_CLEANUP_WATCH_FS: `${scratch}:90/40G` });
  assert.equal(r.status, 1, r.stdout);
  assert.ok(fsLines(r.stdout).includes("rmd-host-cleanup: fs / (/dev/root) 70% used, 40G free, mark 65%"), r.stdout);
  assert.match(r.stdout, /FAIL \/ is at 70% with 40G free \(\/dev\/root\), past its mark 65%/);
});

test("a malformed watch mark is refused before the pass touches anything", () => {
  const fx = fixture();
  for (const bad of [`${fx.rootfs}`, `${fx.rootfs}:high`, `${fx.rootfs}:85/lots`, `${fx.rootfs}:101`]) {
    const r = run(fx, { RMD_CLEANUP_WATCH_FS: bad });
    assert.equal(r.status, 2, `${bad}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /FATAL RMD_CLEANUP_WATCH_FS entry/);
    assert.doesNotMatch(r.stdout, /rmd-host-cleanup: \//, "no pass ran");
  }
});
