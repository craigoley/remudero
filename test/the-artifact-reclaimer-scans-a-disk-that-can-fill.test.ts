import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { resolveArtifactScanRoots, type Config } from "../src/lib/config.js";
import { sweepReclaimableArtifacts, type ArtifactSweepOptions } from "../src/lib/disk-artifact-reclaim.js";

const GiB = 1024 ** 3;
const now = 1_800_000_000_000;
const configFor = (root: string, roots?: string[]): Config =>
  ({ claudeBin: "/usr/bin/claude", root, ...(roots === undefined ? {} : { diskArtifactScanRoots: roots }) });

test("test/the-artifact-reclaimer-scans-a-disk-that-can-fill.test.ts: each configured root uses its own free space", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-artifact-roots-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const healthy = join(dir, "healthy");
  const pressured = join(dir, "pressured");
  const managed = join(dir, "managed");
  mkdirSync(managed);
  for (const root of [healthy, pressured]) {
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    mkdirSync(join(checkout, "coverage"));
    writeFileSync(join(checkout, "coverage", "lcov.info"), "fixture\n");
  }
  const reads: string[] = [];
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const summary = sweepReclaimableArtifacts(configFor(managed, [healthy, pressured]),
    (step, extra) => events.push({ step, extra }), {
      freeBytes: (root) => { reads.push(root); return root === pressured ? GiB : 10 * GiB; },
      countDirtyFiles: () => 0,
      clock: fixedClock(now),
      modifiedAtMs: () => 0,
      isInUse: () => false,
    });
  const artifact = join(pressured, "checkout", "coverage");
  assert.deepEqual(reads, [healthy, pressured]);
  assert.deepEqual(summary.reclaimed, [artifact]);
  assert.ok(summary.bytesReclaimed > 0, "the real du reader measures the removed artifact");
  assert.deepEqual(summary.kept, [{ path: healthy, reason: "headroom-ok" }]);
  assert.equal(existsSync(artifact), false);
  assert.equal(existsSync(join(healthy, "checkout", "coverage")), true);
  assert.equal(existsSync(join(pressured, "checkout", ".git")), true);
  assert.ok(events.some(e => e.step === "disk_artifact.sweep.reclaimed" && e.extra?.path === artifact));
});

function safeOptions(overrides: ArtifactSweepOptions = {}): ArtifactSweepOptions {
  return {
    freeBytes: () => 0,
    listEntries: () => ["checkout"],
    isDirectory: path => !path.endsWith("node_modules"),
    isCheckout: () => true,
    countDirtyFiles: () => 0,
    clock: fixedClock(now),
    modifiedAtMs: () => 0,
    isInUse: () => false,
    sizeBytes: () => 10,
    removeDir: () => {},
    ...overrides,
  };
}

test("an unreadable or unlistable scan root does not prevent later roots from reclaiming", () => {
  for (const failure of ["statfs", "readdir"] as const) {
    const roots = ["/unreadable", "/usable"];
    const removed: string[] = [];
    const summary = sweepReclaimableArtifacts(configFor("/managed", roots), () => {}, safeOptions({
      freeBytes: path => failure === "statfs" && path === roots[0] ? undefined : 0,
      listEntries: path => {
        if (failure === "readdir" && path === roots[0]) throw new Error("unreadable root");
        return ["checkout"];
      },
      removeDir: path => { removed.push(path); },
    }));
    assert.deepEqual(removed, ["/usable/checkout/coverage"]);
    assert.deepEqual(summary.reclaimed, removed);
    assert.equal(summary.bytesReclaimed, 10);
    if (failure === "statfs") assert.deepEqual(summary.kept, [{ path: "/unreadable", reason: "unreadable" }]);
  }
});

test("configured roots retain the dirty, young and in-use refusals", () => {
  for (const reason of ["checkout-dirty", "too-young", "in-use"] as const) {
    const removed: string[] = [];
    const summary = sweepReclaimableArtifacts(configFor("/managed", ["/one", "/two"]), () => {}, safeOptions({
      countDirtyFiles: () => reason === "checkout-dirty" ? 1 : 0,
      modifiedAtMs: () => reason === "too-young" ? now : 0,
      isInUse: () => reason === "in-use",
      removeDir: path => { removed.push(path); },
    }));
    assert.deepEqual(removed, []);
    assert.deepEqual(summary.kept, ["/one", "/two"].map(root => ({ path: join(root, "checkout", "coverage"), reason })));
  }
});

test("the parent-root default and the existing scanRoot override remain compatible", () => {
  for (const override of [undefined, () => "/override"]) {
    const reads: string[] = [];
    sweepReclaimableArtifacts(configFor("/parent/managed", override ? ["/configured"] : undefined), () => {}, {
      scanRoot: override,
      freeBytes: path => { reads.push(path); return 10 * GiB; },
    });
    assert.deepEqual(reads, [override ? "/override" : "/parent"]);
  }
});

test("artifact root resolution defaults to the parent and preserves the configured list", () => {
  assert.deepEqual(resolveArtifactScanRoots(configFor("/parent/managed")), ["/parent"]);
  assert.deepEqual(resolveArtifactScanRoots(configFor("/parent/managed", ["/one", "/two"])), ["/one", "/two"]);
});

test("unwatched scan filesystems are reported once per boot while state and scratch aliases are recognized", () => {
  const config = configFor("/state/managed", ["/state-alias", "/scratch-alias", "/container"]);
  const events: Array<Record<string, unknown>> = [];
  const probes: string[] = [];
  const opts: ArtifactSweepOptions = {
    freeBytes: () => 10 * GiB,
    filesystemDevice: path => {
      probes.push(path);
      if (path === config.root || path === "/state-alias") return 1;
      if (path === join(config.root, "worktrees") || path === "/scratch-alias") return 2;
      return 3;
    },
  };
  const log = (step: string, extra?: Record<string, unknown>) => {
    if (step === "disk_artifact.sweep.root_unwatched") events.push(extra!);
  };
  sweepReclaimableArtifacts(config, log, opts);
  const firstProbes = [...probes];
  sweepReclaimableArtifacts(config, log, opts);
  assert.deepEqual(probes, firstProbes, "the comparison is once per boot, not once per tick");
  assert.deepEqual(events, [{
    path: "/container", device: 3, watchedRoots: [config.root, join(config.root, "worktrees")],
    watchedDevices: [1, 2], reason: "different-filesystem",
  }]);
  sweepReclaimableArtifacts({ ...config }, log, opts);
  assert.equal(events.length, 2, "a new daemon instance reports its own warning");
});

test("filesystem identity failures are visible separately from a measured unwatched device", () => {
  for (const failure of ["scan", "watched"] as const) {
    const events: Array<Record<string, unknown>> = [];
    const config = configFor("/managed", ["/scan"]);
    sweepReclaimableArtifacts(config, (step, extra) => {
      if (step === "disk_artifact.sweep.root_unwatched") events.push(extra!);
    }, {
      watchedRoots: () => ["/watched"],
      filesystemDevice: path => (failure === "scan" ? path === "/scan" : path === "/watched") ? undefined : 1,
      freeBytes: () => 10 * GiB,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.reason, failure === "scan" ? "scan-filesystem-unreadable" : "watched-filesystems-unreadable");
  }
});

test("the real filesystem identity reader reports an absent root and recognizes a same-device reference", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-artifact-devices-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, "missing");
  const config = configFor(dir, [dir, missing]);
  const events: Array<Record<string, unknown>> = [];
  const summary = sweepReclaimableArtifacts(config, (step, extra) => {
    if (step === "disk_artifact.sweep.root_unwatched") events.push(extra!);
  });
  assert.equal(summary.kept.find(item => item.path === missing)?.reason, "unreadable");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.path, missing);
  assert.equal(events[0]?.reason, "scan-filesystem-unreadable");
  assert.deepEqual(events[0]?.watchedDevices, [statSync(dir).dev, undefined]);
});
