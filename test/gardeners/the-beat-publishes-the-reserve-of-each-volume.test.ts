/**
 * W1-T12253: the heartbeat publishes the disk reserve of each volume of its host.
 *
 * On 2026-11-10 the Azure host went past the mark of its janitor, and the mark was known to the
 * janitor only, so no reader of the heartbeat could say whether a free value was low. These tests run
 * the REAL committed scripts/fleet-heartbeat.sh through the shared harness with a stubbed `df`, and
 * read the published payload. No Mac account publishes a heartbeat (operator ruling 2026-11-12,
 * W1-T12259 retired), so on macOS each reserve is `unknown`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { runBeat, type Beat } from "#test/helpers/fleet-heartbeat-harness.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ROOT_DEV = "/dev/root";
const STATE_DEV = "/dev/nvme0n2p1";
const SCRATCH_DEV = "/dev/nvme1n1";
const GIB_KB = 1024 * 1024;

/** One `df -Pk` answer: a device, total KB and free KB; `fail` exits 1 with no output. */
type Df = { dev: string; total: string; free?: string } | "fail";

function field(payload: string, key: string): string | undefined {
  const line = payload.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

/** A `df` stub: one arm per named path, and `other` for every other path (the harness's RMD_ROOT). */
function dfStub(paths: Record<string, Df>, other: Df): string {
  const arm = (d: Df): string => {
    if (d === "fail") return "  exit 1";
    const row = `${d.dev} ${d.total} 1000 ${d.free ?? "5000000"} 50% /x`;
    return `  printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n%s\\n' ${JSON.stringify(row)}`;
  };
  const lines = ["#!/usr/bin/env bash", 'target="${@: -1}"', "case \"$target\" in"];
  for (const [path, d] of Object.entries(paths)) lines.push(`${JSON.stringify(path)})`, arm(d), "  ;;");
  lines.push("*)", arm(other), "  ;;", "esac", "");
  return lines.join("\n");
}

function beat(opts: { kernel?: string; env?: Record<string, string>; paths: Record<string, Df>; other: Df }): Beat {
  const b = runBeat({
    unameStub: `#!/bin/sh\necho ${opts.kernel ?? "Linux"}\n`,
    env: { RMD_SCRATCH_ROOT: "/nonexistent/rmd-scratch-for-w1-t12253", ...(opts.env ?? {}) },
    dfStub: dfStub(opts.paths, opts.other),
  });
  assert.equal(b.status, 0, b.stderr);
  return b;
}

test("W1-T12253 criterion 1: each heartbeat carries root_fs_reserve_kb, and state_fs_reserve_kb when the state volume is another device", () => {
  const env = { HIGH_WATER: "85", RMD_CLEANUP_WATCH_FS: "/mnt/rmd:80" };
  const apart = beat({
    env,
    paths: { "/": { dev: ROOT_DEV, total: "100000000" }, "/mnt/rmd": { dev: STATE_DEV, total: "200000000" } },
    other: { dev: STATE_DEV, total: "200000000" },
  });
  assert.equal(field(apart.published, "root_fs_reserve_kb"), "15000000");
  assert.equal(field(apart.published, "state_fs_reserve_kb"), "40000000");

  const together = beat({
    env,
    paths: { "/": { dev: ROOT_DEV, total: "100000000" }, "/mnt/rmd": "fail" },
    other: { dev: ROOT_DEV, total: "100000000" },
  });
  assert.equal(field(together.published, "root_fs_reserve_kb"), "15000000");
  assert.equal(field(together.published, "state_fs_reserve_kb"), undefined, "one device carries one reserve");
});

test("W1-T12253 criterion 2: on macOS each reserve is unknown", () => {
  for (const total of ["100000000", "900000000"]) {
    const mac = beat({
      kernel: "Darwin",
      env: { HIGH_WATER: "85", RMD_CLEANUP_WATCH_FS: "/mnt/rmd:80" },
      paths: { "/": { dev: "/dev/disk3s1s1", total }, "/mnt/rmd": { dev: "/dev/disk3s5", total } },
      other: { dev: "/dev/disk3s5", total },
    });
    assert.equal(field(mac.published, "root_fs_reserve_kb"), "unknown", "no Mac reserve is held");
    assert.equal(field(mac.published, "state_fs_reserve_kb"), "unknown", "no Mac reserve is held");
  }
});

test("W1-T12253 criterion 3: on Linux the reserve is the part above the mark percent, or the free space of the mark when larger", () => {
  const run = (total: string, watch: string, other: Df): Beat =>
    beat({
      env: { HIGH_WATER: "85", RMD_CLEANUP_WATCH_FS: watch },
      paths: { "/": { dev: ROOT_DEV, total }, "/mnt/rmd": { dev: STATE_DEV, total: "1000000000" }, "/mnt/scratch": { dev: STATE_DEV, total: "1000000000" } },
      other,
    });
  // 10% of 100,000,000 KB is less than 40 GiB, so the free space part is the reserve.
  const small = run("100000000", "/:90/40G", { dev: ROOT_DEV, total: "100000000" });
  assert.equal(field(small.published, "root_fs_reserve_kb"), String(40 * GIB_KB));
  // 10% of 1,000,000,000 KB is more than 40 GiB, so the percent part is the reserve.
  const large = run("1000000000", "/:90/40G", { dev: ROOT_DEV, total: "1000000000" });
  assert.equal(field(large.published, "root_fs_reserve_kb"), "100000000");
  // Two paths on one device: the strictest percent and the largest free space, as the janitor judges.
  const shared = run("100000000", "/mnt/rmd:95 /mnt/scratch:85/1G", { dev: STATE_DEV, total: "1000000000" });
  assert.equal(field(shared.published, "state_fs_reserve_kb"), "150000000");
  assert.equal(field(shared.published, "root_fs_reserve_kb"), "15000000", "the root gets HIGH_WATER when the list omits it");
});

/** The default marks of deploy/rmd-host-cleanup.sh, read from the janitor itself. */
function janitorDefaults(): { highWater: number; watch: string } {
  const text = readFileSync(join(REPO_ROOT, "deploy", "rmd-host-cleanup.sh"), "utf8");
  const hw = /^HIGH_WATER="\$\{HIGH_WATER:-(\d+)\}"/m.exec(text);
  const watch = /^elif \[ "\$ROOT_FS" = \/ \]; then WATCH_FS="([^"]*)"/m.exec(text);
  assert.ok(hw && watch, "the janitor's default marks must be readable");
  return { highWater: Number(hw[1]), watch: watch[1] };
}

/** The reserve of one device from the marks of the paths on it, by the janitor's rule. */
function expectedReserve(total: number, marks: string[]): string {
  let pct = 101;
  let minKb = 0;
  for (const mark of marks) {
    const [p, free = ""] = mark.split("/");
    pct = Math.min(pct, Number(p));
    const unit = { "": 1, K: 1, M: 1024, G: 1024 ** 2, T: 1024 ** 3 }[free.replace(/^\d+/, "")] ?? 1;
    minKb = Math.max(minKb, Number(free.replace(/[KMGT]$/, "") || "0") * unit);
  }
  return String(Math.max(Math.floor((total * (100 - pct)) / 100), minKb));
}

test("W1-T12253 criterion 4: the heartbeat and the host janitor have the same default marks", () => {
  const saved = { hw: process.env.HIGH_WATER, watch: process.env.RMD_CLEANUP_WATCH_FS };
  delete process.env.HIGH_WATER;
  delete process.env.RMD_CLEANUP_WATCH_FS;
  try {
    const { highWater, watch } = janitorDefaults();
    const marks = new Map(watch.split(/\s+/).filter(Boolean).map((e) => [e.slice(0, e.lastIndexOf(":")), e.slice(e.lastIndexOf(":") + 1)]));
    const markOf = (path: string): string => {
      const m = marks.get(path);
      assert.ok(m !== undefined, `the janitor default list must watch ${path}`);
      return m;
    };
    assert.equal(marks.has("/"), false, "the janitor adds the root at HIGH_WATER");
    for (const total of [100_000_000, 2_000_000_000]) {
      // The state volume holds /mnt/rmd; the scratch volume is a third device.
      const rmd = beat({
        paths: { "/": { dev: ROOT_DEV, total: String(total) }, "/mnt/rmd": { dev: STATE_DEV, total: String(total) }, "/mnt/scratch": { dev: SCRATCH_DEV, total: String(total) } },
        other: { dev: STATE_DEV, total: String(total) },
      });
      assert.equal(field(rmd.published, "root_fs_reserve_kb"), expectedReserve(total, [String(highWater)]));
      assert.equal(field(rmd.published, "state_fs_reserve_kb"), expectedReserve(total, [markOf("/mnt/rmd")]));
      // The state volume holds /mnt/scratch only.
      const scratch = beat({
        paths: { "/": { dev: ROOT_DEV, total: String(total) }, "/mnt/rmd": "fail", "/mnt/scratch": { dev: STATE_DEV, total: String(total) } },
        other: { dev: STATE_DEV, total: String(total) },
      });
      assert.equal(field(scratch.published, "state_fs_reserve_kb"), expectedReserve(total, [markOf("/mnt/scratch")]));
    }
  } finally {
    if (saved.hw !== undefined) process.env.HIGH_WATER = saved.hw;
    if (saved.watch !== undefined) process.env.RMD_CLEANUP_WATCH_FS = saved.watch;
  }
});

test("W1-T12253 criterion 5: when the heartbeat cannot read the size of a volume, its reserve is unknown", () => {
  const env = { HIGH_WATER: "85", RMD_CLEANUP_WATCH_FS: "/mnt/rmd:80" };
  // The root answers a device but no size; the state volume does not answer at all.
  const blind = beat({ env, paths: { "/": { dev: ROOT_DEV, total: "-" }, "/mnt/rmd": "fail" }, other: "fail" });
  assert.equal(field(blind.published, "root_fs_reserve_kb"), "unknown", "never 0");
  assert.equal(field(blind.published, "state_fs_reserve_kb"), "unknown", "never the number of another volume");
  // A readable root next to an unreadable state volume: the root number does not leak to the state line.
  const half = beat({
    env,
    paths: { "/": { dev: ROOT_DEV, total: "100000000" }, "/mnt/rmd": { dev: STATE_DEV, total: "200000000" } },
    other: { dev: STATE_DEV, total: "junk" },
  });
  assert.equal(field(half.published, "root_fs_reserve_kb"), "15000000");
  assert.equal(field(half.published, "state_fs_reserve_kb"), "unknown");
});
