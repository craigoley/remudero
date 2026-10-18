import assert from "node:assert/strict";
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { assessWorkspaceDiskBudget, sampleWorkspaceUsage, workspaceSizeWarning, workspaceUsageEvidence } from "#src/lib/workspace-usage.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { renderCanaryReport } from "#src/lib/model-canary-report.js";
import { clockFromMillisFn } from "#src/lib/clock.js";

test("workspace measurements distinguish a proven empty root from missing or budget-incomplete evidence", (t) => {
  const { dir } = ownedFixtureDir(t, "workspace-observation");
  const empty = sampleWorkspaceUsage(dir);
  assert.equal(empty.completeness, "complete"); assert.equal(empty.generatedPathBytes, 0);
  assert.ok(empty.hostFreeBytes! > 0); assert.equal(empty.dependencyMethod, "missing");
  mkdirSync(join(dir, "coverage")); writeFileSync(join(dir, "coverage", "payload"), Buffer.alloc(64 * 1024));
  const measured = sampleWorkspaceUsage(dir, { maxMs: 1000 });
  assert.equal(measured.completeness, "complete"); assert.ok(measured.generatedPathBytes! > 0);
  assert.equal(sampleWorkspaceUsage(join(dir, "absent")).generatedPathBytes, null);
  let clock = 0;
  assert.equal(sampleWorkspaceUsage(dir, { maxMs: 1, clock: clockFromMillisFn(() => ++clock) }).completeness, "unknown");
  assert.equal(sampleWorkspaceUsage(dir, { maxEntries: 0 }).generatedPathBytes, null);
  assert.equal(sampleWorkspaceUsage(dir, { roots: ["../outside"] }).completeness, "unknown");
});

test("workspace accounting deduplicates hardlinks and excludes borrowed cache targets", (t) => {
  const { dir } = ownedFixtureDir(t, "workspace-links"), outside = ownedFixtureDir(t, "workspace-borrowed").dir;
  mkdirSync(join(dir, "coverage"));
  const file = join(dir, "coverage", "payload"); writeFileSync(file, Buffer.alloc(64 * 1024));
  linkSync(file, join(dir, "coverage", "duplicate"));
  const sample = sampleWorkspaceUsage(dir, { roots: ["coverage"], maxMs: 1000 });
  assert.equal(sample.generatedPathBytes, statSync(file).blocks * 512 + statSync(join(dir, "coverage")).blocks * 512);
  const partial = sampleWorkspaceUsage(dir, { roots: ["coverage"], maxEntries: 1, maxMs: 1000 });
  assert.equal(partial.completeness, "lower-bound");
  symlinkSync(outside, join(dir, "node_modules"));
  mkdirSync(join(outside, ".cache")); writeFileSync(join(outside, ".cache", "keep"), "borrowed");
  const borrowed = sampleWorkspaceUsage(dir, { roots: ["node_modules/.cache"] });
  assert.equal(borrowed.dependencyMethod, "borrowed-link"); assert.equal(borrowed.completeness, "unknown");
  assert.equal(borrowed.generatedPathBytes, null);
  assert.equal(readFileSync(join(outside, ".cache", "keep"), "utf8"), "borrowed");
});

test("workspace read failures retain unknown capacity and incomplete generated usage", (t) => {
  const { dir } = ownedFixtureDir(t, "workspace-read-failure");
  mkdirSync(join(dir, "coverage")); const payload = join(dir, "coverage/payload"); writeFileSync(payload, "retained");
  const unavailable = t.mock.method(fs, "statfsSync", () => { throw new Error("filesystem observation unavailable"); });
  syncBuiltinESMExports();
  try {
    const sample = sampleWorkspaceUsage(dir, { maxMs: 1000 });
    assert.equal(sample.hostFreeBytes, null); assert.ok(sample.reasons.includes("host-free-unavailable"));
    assert.equal(assessWorkspaceDiskBudget(sample.hostFreeBytes, { minimumFreeBytes: 1, reservedBytes: 0, estimatedPeakBytes: 0 }), "unknown");
  } finally { unavailable.mock.restore(); syncBuiltinESMExports(); }
  const original = fs.lstatSync;
  const unreadable = t.mock.method(fs, "lstatSync", ((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === payload) throw Object.assign(new Error("entry unreadable"), { code: "EACCES" });
    return Reflect.apply(original, fs, args);
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  try {
    const sample = sampleWorkspaceUsage(dir, { maxMs: 1000 });
    assert.equal(sample.completeness, "lower-bound"); assert.ok(sample.reasons.includes("entry-unreadable-or-changed"));
    assert.notEqual(sample.generatedPathBytes, null);
  } finally { unreadable.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(payload, "utf8"), "retained");
  assert.equal(sampleWorkspaceUsage(dir, { maxMs: 1000 }).completeness, "complete");
});

test("workspace seed metadata records APFS materialization without claiming unique physical disk cost", (t) => {
  const { dir } = ownedFixtureDir(t, "workspace-seed"); mkdirSync(join(dir, "node_modules"));
  assert.equal(sampleWorkspaceUsage(dir).dependencyMethod, "unrecorded");
  const marker = join(dir, "node_modules", ".rmd-dependency-seed.json");
  for (const method of ["apfs-clone", "private-copy", "readonly-links"] as const) {
    writeFileSync(marker, JSON.stringify({ method })); assert.equal(sampleWorkspaceUsage(dir).dependencyMethod, method);
  }
  writeFileSync(marker, "malformed"); assert.equal(sampleWorkspaceUsage(dir).dependencyMethod, "unknown");
  writeFileSync(marker, " ".repeat(65537)); assert.equal(sampleWorkspaceUsage(dir).dependencyMethod, "unknown");
  rmSync(marker); mkdirSync(marker); assert.equal(sampleWorkspaceUsage(dir).dependencyMethod, "unknown");
});

test("disk admission preserves the supplied floor and counts reservations before a new batch", () => {
  const GiB = 1024 ** 3;
  const profile = { minimumFreeBytes: 20 * GiB, reservedBytes: 2 * GiB, estimatedPeakBytes: 3 * GiB };
  assert.equal(assessWorkspaceDiskBudget(25 * GiB, profile), "admitted");
  assert.equal(assessWorkspaceDiskBudget(24 * GiB, profile), "not-run-disk-capacity");
  assert.equal(assessWorkspaceDiskBudget(null, profile), "unknown");
  assert.equal(assessWorkspaceDiskBudget(25 * GiB, { ...profile, estimatedPeakBytes: NaN }), "unknown");
  assert.equal(workspaceSizeWarning(GiB - 1), null);
  assert.equal(workspaceSizeWarning(GiB), "observed-generated-at-least-1GiB");
  assert.equal(workspaceSizeWarning(Infinity), null);
});

test("private resource evidence labels phase sampling cleanup and missing measurements explicitly", (t) => {
  const { dir } = ownedFixtureDir(t, "workspace-evidence");
  assert.equal(workspaceUsageEvidence([]).generatedPeakObservedBytes, null);
  assert.equal(workspaceUsageEvidence([]).completeness, "unknown");
  const sample = sampleWorkspaceUsage(dir), missing = sampleWorkspaceUsage(join(dir, "missing"));
  const evidence = workspaceUsageEvidence([sample, missing]);
  assert.equal(evidence.sampling, "phase-boundaries"); assert.equal(evidence.completeness, "lower-bound");
  assert.equal(evidence.cleanup, "unknown");
  assert.equal(workspaceUsageEvidence([sample], "confirmed").cleanup, "confirmed");
  const html = renderCanaryReport([]);
  assert.match(html, /Observed generated disk/);
  assert.match(html, /transient peaks unmeasured/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
  assert.doesNotThrow(() => new Script(script), "the actual private report script parses");
});
