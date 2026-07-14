import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateWorkerSettings,
  WorkerSettingsError,
} from "../src/lib/settings.js";

const GOOD = {
  permissions: { deny: ["Read(~/.ssh/**)"], allow: [], ask: [] },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] },
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    filesystem: { denyRead: ["~/.ssh/**"] },
    network: { allowedDomains: ["github.com"] },
    excludedCommands: ["gh *"],
  },
};

test("accepts a correctly-shaped worker.json", () => {
  assert.doesNotThrow(() => validateWorkerSettings(GOOD));
});

test("REJECTS allowedDomains at the sandbox root (the WS-0 silent-drop typo)", () => {
  const bad = {
    ...GOOD,
    sandbox: { ...GOOD.sandbox, allowedDomains: ["github.com"] },
  };
  assert.throws(
    () => validateWorkerSettings(bad),
    (e: unknown) =>
      e instanceof WorkerSettingsError &&
      /allowedDomains/.test((e as Error).message) &&
      /sandbox\.network/.test((e as Error).message),
    "must name the misplaced key and where it belongs",
  );
});

test("rejects an unknown sandbox key", () => {
  const bad = { ...GOOD, sandbox: { ...GOOD.sandbox, enabledd: true } };
  assert.throws(() => validateWorkerSettings(bad), WorkerSettingsError);
});

test("rejects sandbox disabled / failIfUnavailable false", () => {
  assert.throws(
    () => validateWorkerSettings({ ...GOOD, sandbox: { ...GOOD.sandbox, enabled: false } }),
    WorkerSettingsError,
  );
  assert.throws(
    () => validateWorkerSettings({ ...GOOD, sandbox: { ...GOOD.sandbox, failIfUnavailable: false } }),
    WorkerSettingsError,
  );
});

test("rejects non-empty permissions.ask (headless-hang hazard)", () => {
  const bad = { ...GOOD, permissions: { ...GOOD.permissions, ask: ["Bash(git push *)"] } };
  assert.throws(() => validateWorkerSettings(bad), WorkerSettingsError);
});

test("rejects a misplaced filesystem key at the sandbox root", () => {
  const bad = { ...GOOD, sandbox: { ...GOOD.sandbox, denyRead: ["~/.ssh/**"] } };
  assert.throws(
    () => validateWorkerSettings(bad),
    (e: unknown) => e instanceof WorkerSettingsError && /sandbox\.filesystem/.test((e as Error).message),
  );
});
