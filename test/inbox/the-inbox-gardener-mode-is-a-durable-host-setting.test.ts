// W1-T13258: the Inbox gardener mode was env-only, and the daemon's env is retyped by the recycle
// capture list and the boot launcher's fixed list, so a reboot would drop it. The durable setting is
// config.json `inboxGardenerMode`; a valid RMD_INBOX_GARDENER_MODE still wins.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ConfigShapeError, validateConfigShape } from "#src/lib/config-schema.js";
import { inboxGardenerMode, readConfiguredInboxGardenerMode } from "#src/lib/inbox-retirement.js";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-gardener-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("W1-T13258 criterion 1: with no env mode, the gardener mode is config.json's inboxGardenerMode, and off when the file is absent, unreadable or names none", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "config.json");
  for (const mode of ["off", "shadow", "act"] as const) {
    writeFileSync(path, JSON.stringify({ claudeBin: "/bin/claude", root: "/r", inboxGardenerMode: mode }));
    assert.equal(readConfiguredInboxGardenerMode(path), mode);
    assert.equal(inboxGardenerMode({}, () => readConfiguredInboxGardenerMode(path)), mode);
  }
  writeFileSync(path, JSON.stringify({ claudeBin: "/bin/claude", root: "/r" }));
  assert.equal(inboxGardenerMode({}, () => readConfiguredInboxGardenerMode(path)), "off", "no key reads as off");
  writeFileSync(path, JSON.stringify({ inboxGardenerMode: "yes" }));
  assert.equal(inboxGardenerMode({}, () => readConfiguredInboxGardenerMode(path)), "off", "an invalid value reads as off");
  writeFileSync(path, "{ not json");
  assert.equal(inboxGardenerMode({}, () => readConfiguredInboxGardenerMode(path)), "off", "a malformed file reads as off");
  writeFileSync(path, "null");
  assert.equal(readConfiguredInboxGardenerMode(path), undefined);
  assert.equal(readConfiguredInboxGardenerMode(join(dir, "missing.json")), undefined, "an absent file is no setting");
  assert.equal(readConfiguredInboxGardenerMode(dir), undefined, "an unreadable path (a directory) is no setting");
});

test("W1-T13258 criterion 1: the default reader resolves config.json under HOME, like configPath", (t) => {
  const home = tempDir(t);
  const saved = process.env.HOME;
  t.after(() => { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; });
  process.env.HOME = home;
  assert.equal(inboxGardenerMode({}), "off", "no config under HOME reads as off");
  const configDir = join(home, ".config", "remudero");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ inboxGardenerMode: "shadow" }));
  assert.equal(inboxGardenerMode({}), "shadow");
});

test("W1-T13258 criterion 2: a valid env mode wins over config.json, and the schema accepts only off, shadow or act", () => {
  assert.equal(inboxGardenerMode({ RMD_INBOX_GARDENER_MODE: "act" }, () => "shadow"), "act");
  assert.equal(inboxGardenerMode({ RMD_INBOX_GARDENER_MODE: "shadow" }, () => "act"), "shadow");
  assert.equal(inboxGardenerMode({ RMD_INBOX_GARDENER_MODE: "yes" }, () => "shadow"), "shadow", "an invalid env value falls through to config");
  assert.equal(inboxGardenerMode({ RMD_INBOX_GARDENER_MODE: "off" }, () => "act"), "act", "env off is not a valid override; config decides");
  for (const mode of ["off", "shadow", "act"]) {
    assert.doesNotThrow(() => validateConfigShape({ claudeBin: "/bin/claude", root: "/r", inboxGardenerMode: mode }, "config.json"));
  }
  assert.throws(() => validateConfigShape({ claudeBin: "/bin/claude", root: "/r", inboxGardenerMode: "on" }, "config.json"), ConfigShapeError);
  assert.throws(() => validateConfigShape({ claudeBin: "/bin/claude", root: "/r", inboxGardenerMode: true }, "config.json"), ConfigShapeError);
});

test("W1-T13258 criterion 3: resolving the mode never creates, rewrites or chmods config.json", (t) => {
  const dir = tempDir(t);
  const missing = join(dir, ".config", "remudero", "config.json");
  assert.equal(readConfiguredInboxGardenerMode(missing), undefined);
  assert.equal(existsSync(missing), false, "a missing config stays missing");
  assert.equal(existsSync(join(dir, ".config")), false, "no directory is created either");
  const path = join(dir, "config.json");
  const body = JSON.stringify({ inboxGardenerMode: "shadow" });
  writeFileSync(path, body, { mode: 0o600 });
  const before = statSync(path);
  assert.equal(readConfiguredInboxGardenerMode(path), "shadow");
  const after = statSync(path);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode, before.mode);
  assert.equal(after.size, Buffer.byteLength(body));
});
