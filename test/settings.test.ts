import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  validateWorkerSettings,
  WorkerSettingsError,
} from "../src/lib/settings.js";
import { workerHomeDir, type Config } from "../src/lib/config.js";
import { resolveServiceTokens, serviceTokensPath } from "../src/lib/serve.js";

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

// ── W1-T2211: A WORKER CAN READ THE CONSOLE'S WRITE TOKEN — the committed
// TEMPLATE, not a fixture, must carry the fix. `${HOOKS_DIR}` is only ever
// substituted inside `hooks.PreToolUse[0].hooks[0].command` (renderWorkerSettings,
// worker.ts), so the raw committed file JSON.parses as-is for every assertion
// below — no rendering step is needed to exercise the deny lists. ─────────────

const WORKER_SETTINGS_TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "settings",
  "worker.json",
);

// W1-T2213: re-anchored from bare `~/.ssh/**` etc. — under the worker's redirected
// HOME, `~` alone resolved inside the worker's own scratch home rather than the
// operator's. `~/../..` escapes through config.root (the same `~/..` step the
// service-tokens.json entry below relies on) one level further, to the operator's
// real home — see the tests below this file's own W1-T2211 block for the proof.
const ORIGINAL_DENY_READ_ENTRIES = ["~/../../.ssh/**", "~/../../.aws/**", "~/../../.config/remudero/**"];

function readWorkerSettingsTemplate(): Record<string, unknown> {
  return JSON.parse(readFileSync(WORKER_SETTINGS_TEMPLATE_PATH, "utf8"));
}

test("W1-T2211 ACCEPTANCE 4: the committed worker.json TEMPLATE still validates", () => {
  assert.doesNotThrow(() => validateWorkerSettings(readWorkerSettingsTemplate()));
});

test("W1-T2211 ACCEPTANCE 4: the three ORIGINAL denyRead entries are unchanged, and exactly one new entry was added", () => {
  const settings = readWorkerSettingsTemplate() as {
    sandbox: { filesystem: { denyRead: string[] } };
    permissions: { deny: string[] };
  };
  const denyRead = settings.sandbox.filesystem.denyRead;
  for (const original of ORIGINAL_DENY_READ_ENTRIES) {
    assert.ok(denyRead.includes(original), `original entry ${original} must be unchanged`);
  }
  assert.equal(denyRead.length, ORIGINAL_DENY_READ_ENTRIES.length + 1, "exactly one entry was added");
  // `permissions.deny` mirrors `sandbox.filesystem.denyRead` as `Read(...)` rules
  // (settings/worker.json's own $comment) — the mirror must gain the same one entry.
  for (const original of ORIGINAL_DENY_READ_ENTRIES) {
    assert.ok(settings.permissions.deny.includes(`Read(${original})`), `permissions.deny must still mirror ${original}`);
  }
  assert.equal(
    settings.permissions.deny.length,
    ORIGINAL_DENY_READ_ENTRIES.length + 1,
    "permissions.deny gained exactly one mirrored entry too",
  );
});

test("W1-T2211: the new entry names the token file SPECIFICALLY — never a blanket state/** deny (design part i)", () => {
  const settings = readWorkerSettingsTemplate() as { sandbox: { filesystem: { denyRead: string[] } } };
  const denyRead = settings.sandbox.filesystem.denyRead;
  const added = denyRead.filter((e) => !ORIGINAL_DENY_READ_ENTRIES.includes(e));
  assert.equal(added.length, 1, "exactly one new entry");
  assert.match(added[0], /service-tokens\.json$/, "the new entry must name the token file by basename");
  assert.doesNotMatch(added[0], /state\/\*\*$/, "must never be a blanket state/** deny");
  assert.ok(
    !denyRead.some((e) => e === "state/**" || e === "~/state/**" || e.endsWith("/state/**")),
    "no entry anywhere in denyRead may be a blanket state/** deny",
  );
});

test("W1-T2211: the new entry resolves to the SAME path serviceTokensPath(config.root) produces (design part i's own requirement)", () => {
  const settings = readWorkerSettingsTemplate() as { sandbox: { filesystem: { denyRead: string[] } } };
  const added = settings.sandbox.filesystem.denyRead.find((e) => !ORIGINAL_DENY_READ_ENTRIES.includes(e));
  assert.ok(added, "a new denyRead entry must exist");
  // `~` resolves to the worker's redirected HOME (workerHomeDir), never the real
  // homedir — reproduce that resolution exactly, then apply the entry's own `..`
  // segments, and compare against the resolver's own output for the SAME root.
  const configRoot = "/tmp/rmd-w1-t2211-fixture-root";
  const config = { root: configRoot } as Config;
  const home = workerHomeDir(config);
  assert.ok(added!.startsWith("~/"), "the entry must be `~`-anchored, like the other three");
  const resolved = resolve(home, added!.slice(2));
  assert.equal(resolved, serviceTokensPath(configRoot), "the deny entry must resolve to the resolver's own path");
});

test("W1-T2211 ACCEPTANCE 5: the token file's mode is unchanged (0600) and resolveServiceTokens is still create-once/read-thereafter (nothing rotates a token)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t2211-token-mode-"));
  const first = resolveServiceTokens(dir);
  const mode = statSync(serviceTokensPath(dir)).mode & 0o777;
  assert.equal(mode, 0o600, "the token file must be created at mode 0600, unchanged by this fix");
  // A second call on the SAME root must return the IDENTICAL tokens — create-once,
  // read-thereafter — proving this change introduces no rotation.
  const second = resolveServiceTokens(dir);
  assert.deepEqual(second, first, "resolveServiceTokens must never mint a new pair on an existing file");
});

// ── W1-T2213: ALL SIX `~`-ANCHORED DENIES RESOLVE INSIDE THE WORKER'S OWN SCRATCH
// HOME — `~/.ssh/**`, `~/.aws/**` and `~/.config/remudero/**` (each mirrored in
// permissions.deny and sandbox.filesystem.denyRead, six entries) named the
// operator's real home but, under the worker's redirected HOME, resolved inside
// the worker's own scratch directory instead (rationale (1)/(2)). Re-anchored to
// `~/../../...`: `~/..` reaches config.root exactly as the W1-T2211 token deny
// above already relies on, and loadConfig's own default (`root: join(homedir(),
// "Remudero")`, config.ts) puts the operator's real home exactly one level above
// config.root, so `~/../..` reaches it — the SAME config.root-relative escape,
// extended by the one level that separates config.root from homedir() under that
// default. Design part (i): re-anchored, never removed. ─────────────────────────

test("W1-T2213 ACCEPTANCE 1: each of the three re-anchored denyRead entries resolves to the OPERATOR's real home, not the worker's redirected scratch home", () => {
  const settings = readWorkerSettingsTemplate() as { sandbox: { filesystem: { denyRead: string[] } } };
  const denyRead = settings.sandbox.filesystem.denyRead;
  // A fixture stand-in for the operator's real home — never the test runner's own
  // `homedir()`, so this passes on any host — paired with config.root exactly as
  // loadConfig's own default relates the two (see comment above).
  const fakeRealHome = "/tmp/rmd-w1-t2213-fixture-realhome";
  const config = { root: join(fakeRealHome, "Remudero") } as Config;
  const home = workerHomeDir(config);
  const cases: Array<[string, string]> = [
    ["~/../../.ssh/**", join(fakeRealHome, ".ssh")],
    ["~/../../.aws/**", join(fakeRealHome, ".aws")],
    ["~/../../.config/remudero/**", join(fakeRealHome, ".config", "remudero")],
  ];
  for (const [entry, expectedDir] of cases) {
    assert.ok(denyRead.includes(entry), `${entry} must be present in denyRead`);
    assert.ok(entry.startsWith("~/"), "still `~`-anchored, like the entries it replaces");
    const withoutGlob = entry.slice(2).replace(/\/\*\*$/, "");
    const resolved = resolve(home, withoutGlob);
    assert.equal(
      resolved,
      expectedDir,
      `${entry} must resolve to the operator's real home (${expectedDir}), not the worker's scratch home (was under ${home})`,
    );
  }
});

test("W1-T2213 ACCEPTANCE 2: all four denyRead entries (three re-anchored, one already-anchored by W1-T2211) are still present, none removed or narrowed", () => {
  const settings = readWorkerSettingsTemplate() as {
    sandbox: { filesystem: { denyRead: string[] } };
    permissions: { deny: string[] };
  };
  const denyRead = settings.sandbox.filesystem.denyRead;
  assert.equal(denyRead.length, 4, "still exactly four denyRead entries — none removed by this re-anchoring");
  for (const entry of ORIGINAL_DENY_READ_ENTRIES) {
    assert.ok(denyRead.includes(entry), `${entry} must still be present`);
  }
  assert.ok(
    denyRead.includes("~/../state/service-tokens.json"),
    "the W1-T2211 token deny is untouched by this re-anchoring",
  );
  for (const entry of ORIGINAL_DENY_READ_ENTRIES) {
    assert.ok(settings.permissions.deny.includes(`Read(${entry})`), `permissions.deny must mirror ${entry}`);
  }
  assert.equal(settings.permissions.deny.length, 4, "permissions.deny mirrors denyRead one-for-one");
});
