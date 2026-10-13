import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { mkdtempSync, rmSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_SCHEMA, validateConfigShape } from "../src/lib/config-schema.js";
import { resolveHeavyReadyDirectory } from "../src/lib/config.js";
import { heavyNewBuildGate, reserveHeavyNewBuilds, releaseHeavyNewBuilds } from "../src/lib/heavy-build-reservation.js";

test("heavy READY startup config is explicitly opt-in and keeps the existing env override", () => {
  assert.equal(resolveHeavyReadyDirectory({}, {}), undefined);
  assert.equal(resolveHeavyReadyDirectory({ heavyReadyDirectory: "/private/core-ready" }, {}), "/private/core-ready");
  assert.equal(resolveHeavyReadyDirectory({ heavyReadyDirectory: "/private/core-ready" }, { RMD_HEAVY_READY_DIR: "/private/env-ready" }), "/private/env-ready");
  assert.equal(resolveHeavyReadyDirectory({ heavyReadyDirectory: "/private/core-ready" }, { RMD_HEAVY_READY_DIR: "" }), "", "preserve an explicitly invalid legacy override; the NEW-only reader refuses it");
});

test("heavy READY startup config has one declared optional string field and rejects malformed shape", () => {
  const field = CONFIG_SCHEMA.find(f => f.name === "heavyReadyDirectory");
  assert.equal(field?.type, "string"); assert.equal(field?.optional, true); assert.equal(field?.default, undefined);
  const base = { claudeBin: "/fixture/claude", root: "/fixture/root" };
  assert.deepEqual(validateConfigShape({ ...base, heavyReadyDirectory: "/private/core-ready" }, "fixture config"), { ...base, heavyReadyDirectory: "/private/core-ready" });
  assert.throws(() => validateConfigShape({ ...base, heavyReadyDirectory: 123 }, "fixture config"), /heavyReadyDirectory/);
});

test("startup directory resolution performs no filesystem or process activity", t => {
  for (const key of ["readFileSync", "writeFileSync", "mkdirSync"] as const) t.mock.method(fs, key, () => { throw new Error(`unexpected filesystem ${key}`); });
  for (const key of ["execFileSync", "execFile", "spawn", "spawnSync"] as const) t.mock.method(childProcess, key, () => { throw new Error(`unexpected process ${key}`); });
  syncBuiltinESMExports();
  try {
    assert.equal(resolveHeavyReadyDirectory({ heavyReadyDirectory: "/private/core-ready" }, {}), "/private/core-ready");
    assert.equal(resolveHeavyReadyDirectory({}, {}), undefined);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("a configured native READY request safely releases and a captured adapter never hot-reloads config", t => {
  const directory = mkdtempSync(join(tmpdir(), "rmd-heavy-ready-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { heavyReadyDirectory: directory }, gate = heavyNewBuildGate(() => {}, { dir: resolveHeavyReadyDirectory(config, {}) });
  assert.equal(gate(), undefined);
  const handle = reserveHeavyNewBuilds("native-core-config-fixture", "bounded fixture", { dir: directory });
  assert.equal(gate()?.requestId, handle.request.id);
  config.heavyReadyDirectory = join(directory, "not-configured-at-startup");
  assert.equal(gate()?.requestId, handle.request.id);
  assert.equal(releaseHeavyNewBuilds(handle), true); assert.equal(gate(), undefined);
  assert.equal(heavyNewBuildGate(() => {}, { dir: resolveHeavyReadyDirectory({}, {}) })(), undefined);
  assert.throws(() => heavyNewBuildGate(() => {}, { dir: resolveHeavyReadyDirectory(config, {}) })(), /observation unavailable/);
});
