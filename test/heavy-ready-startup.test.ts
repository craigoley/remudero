import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs, { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureHeavyNewBuildStartupGate, HEAVY_READY_STARTUP_FILENAME, readHeavyReadyStartupFile } from "../src/lib/heavy-ready-startup.js";
import { reserveHeavyNewBuilds, releaseHeavyNewBuilds } from "../src/lib/heavy-build-reservation.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-ready-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, HEAVY_READY_STARTUP_FILENAME), ready = join(dir, "ready");
  mkdirSync(ready, { mode: 0o700 });
  const publish = (value: unknown = { version: 1, readyDirectory: ready }) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return { dir, path, ready, publish };
}

test("startup sidecar leaves config bytes unchanged and never hot-reloads NEW admission", t => {
  const f = fixture(t), configFile = join(f.dir, "config.json"), original = '{"root":"/fixture","claudeBin":"/fixture/claude"}\n';
  writeFileSync(configFile, original, { mode: 0o600 });
  const disabled = captureHeavyNewBuildStartupGate(() => assert.fail("disabled gate must not log"), {}, { env: {}, startupFile: f.path });
  assert.equal(disabled(), undefined);
  f.publish();
  const gate = captureHeavyNewBuildStartupGate(() => {}, {}, { env: {}, startupFile: f.path });
  const handle = reserveHeavyNewBuilds("startup-sidecar-fixture", "private bounded fixture", { dir: f.ready });
  assert.equal(gate()?.requestId, handle.request.id); assert.equal(disabled(), undefined);
  f.publish({ version: 99 });
  assert.equal(gate()?.requestId, handle.request.id, "later sidecar edits cannot change a captured gate");
  assert.equal(releaseHeavyNewBuilds(handle), true); assert.equal(gate(), undefined);
  assert.equal(readFileSync(configFile, "utf8"), original, "old strict config readers see unchanged bytes");
});

test("startup sidecar preserves explicit env and config precedence without reading the file", t => {
  const f = fixture(t), config = { heavyReadyDirectory: f.ready }, env = { RMD_HEAVY_READY_DIR: f.ready };
  const noRead = t.mock.method(fs, "openSync", () => { throw new Error("sidecar must not be opened"); }); syncBuiltinESMExports();
  try {
    const first = captureHeavyNewBuildStartupGate(() => {}, config, { env, startupFile: f.path });
    const second = captureHeavyNewBuildStartupGate(() => {}, config, { env: {}, startupFile: f.path });
    assert.equal(noRead.mock.callCount(), 0);
    config.heavyReadyDirectory = "/changed-after-startup"; env.RMD_HEAVY_READY_DIR = "/changed-after-startup";
    t.mock.restoreAll(); syncBuiltinESMExports(); assert.equal(first(), undefined); assert.equal(second(), undefined);
    const invalid = captureHeavyNewBuildStartupGate(() => {}, {}, { env: { RMD_HEAVY_READY_DIR: "" }, startupFile: f.path });
    assert.throws(invalid, /observation unavailable/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("startup sidecar absence disables, but malformed or unreadable evidence refuses NEW only", t => {
  const f = fixture(t); assert.deepEqual(readHeavyReadyStartupFile(f.path), { state: "absent" });
  for (const value of [null, [], 2, {}, { version: 2, readyDirectory: f.ready }, { version: 1, readyDirectory: "relative" }, { version: 1, readyDirectory: "" }, { version: 1, readyDirectory: 12 }, { version: 1, readyDirectory: f.ready, extra: true }, { version: 1, readyDirectory: f.ready + "/../ready" }, { version: 1, readyDirectory: "/" + "x".repeat(2049) }]) {
    f.publish(value); assert.equal(readHeavyReadyStartupFile(f.path).state, "unavailable");
    const gate = captureHeavyNewBuildStartupGate(() => {}, {}, { env: {}, startupFile: f.path });
    assert.throws(gate, /startup observation unavailable/, "construction must not interrupt startup or active work");
  }
  writeFileSync(f.path, "{", { mode: 0o600 }); assert.equal(readHeavyReadyStartupFile(f.path).state, "unavailable");
  assert.equal(readHeavyReadyStartupFile("relative.json").state, "unavailable");
  assert.equal(readHeavyReadyStartupFile(f.dir + "/missing/../missing.json").state, "unavailable");
  f.publish(); const open = t.mock.method(fs, "openSync", () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); }); syncBuiltinESMExports();
  try { assert.deepEqual(readHeavyReadyStartupFile(f.path), { state: "unavailable", reason: "permission denied" }); assert.equal(open.mock.callCount(), 1); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("startup sidecar rejects unsafe parents, symlinks, hardlinks, special files and oversize records", t => {
  const f = fixture(t); f.publish(); chmodSync(f.path, 0o644); assert.equal(readHeavyReadyStartupFile(f.path).state, "unavailable"); chmodSync(f.path, 0o600);
  chmodSync(f.dir, 0o755); assert.equal(readHeavyReadyStartupFile(f.path).state, "unavailable"); chmodSync(f.dir, 0o700);
  const alias = join(f.dir, "alias"); symlinkSync(f.path, alias); assert.equal(readHeavyReadyStartupFile(alias).state, "unavailable");
  const parentAlias = join(f.dir, "parent-alias"); symlinkSync(f.dir, parentAlias); assert.equal(readHeavyReadyStartupFile(join(parentAlias, HEAVY_READY_STARTUP_FILENAME)).state, "unavailable");
  const hard = join(f.dir, "hard"); linkSync(f.path, hard); assert.equal(readHeavyReadyStartupFile(f.path).state, "unavailable"); rmSync(hard);
  assert.equal(readHeavyReadyStartupFile(f.ready).state, "unavailable");
  writeFileSync(f.path, " ".repeat(4097)); assert.equal(readHeavyReadyStartupFile(f.path).state, "unavailable");
});

test("startup sidecar detects descriptor read failure, in-place changes and atomic replacement", t => {
  const f = fixture(t); f.publish();
  const realRead = fs.readSync;
  for (const mode of ["error", "grow", "replace"] as const) {
    f.publish(); let first = true;
    t.mock.method(fs, "readSync", (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
      if (first) { first = false;
        if (mode === "error") throw new Error("descriptor failure");
        if (mode === "grow") writeFileSync(f.path, " ".repeat(4097));
        if (mode === "replace") { const staged = f.path + ".stage"; writeFileSync(staged, '{"version":1}', { mode: 0o600 }); renameSync(staged, f.path); }
      }
      return realRead(fd, buffer, offset, length, position);
    }); syncBuiltinESMExports();
    try { assert.equal(readHeavyReadyStartupFile(f.path).state, "unavailable"); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
});

test("startup sidecar descriptor-close errors are UNKNOWN, not fatal startup or successful absence", t => {
  const f = fixture(t); f.publish(); const close = fs.closeSync;
  t.mock.method(fs, "closeSync", (fd: number) => { close(fd); throw new Error("close receipt failed"); }); syncBuiltinESMExports();
  try {
    assert.deepEqual(readHeavyReadyStartupFile(f.path), { state: "unavailable", reason: "startup descriptor closure unavailable: close receipt failed" });
    const gate = captureHeavyNewBuildStartupGate(() => {}, {}, { env: {}, startupFile: f.path });
    assert.throws(gate, /startup observation unavailable/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("startup sidecar default location is captured once and absence writes no files", t => {
  let opened: string | undefined;
  t.mock.method(fs, "openSync", (path: fs.PathLike) => { opened = String(path); throw Object.assign(new Error("absent"), { code: "ENOENT" }); }); syncBuiltinESMExports();
  try {
    const gate = captureHeavyNewBuildStartupGate(() => assert.fail("no logging when absent"), {}, { env: {} });
    assert.ok(opened?.endsWith("/" + HEAVY_READY_STARTUP_FILENAME)); assert.equal(gate(), undefined); assert.equal(gate(), undefined);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
