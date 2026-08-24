import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  SANDBOX_KEYS,
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

// ── W1-T2216: THE PINNED KEY-SET GUARD HAS NO ENFORCER — `SANDBOX_KEYS` (settings.ts)
// is asserted, by a comment, to match the installed SDK's `SandboxSettingsSchema`.
// Two mechanical routes were measured and are BOTH closed (task rationale (4)/(5)):
// the schema object is not exported at runtime (29 exports, none matching
// `/[Ss]chema/`), and the type-level `keyof SandboxSettings` widens to `string` —
// a bogus member assigns to it cleanly, so a `Record<keyof SandboxSettings, true>`
// exhaustiveness map can never fail. The only mechanical route left is parsing the
// installed `sdk.d.ts` declaration by BRACE DEPTH — never proximity or a flat regex,
// which would mistake a nested `network.allowedDomains`/`filesystem.denyRead` member
// for a top-level one. The parser below refuses its own failure: before comparing
// anything it asserts the extraction found a PLAUSIBLE set (non-empty, containing
// the load-bearing anchors `enabled`/`network`/`filesystem`) — an extraction that
// silently returns an empty set and reports "equal" would reproduce, one layer
// down, the exact defect this task exists to close. ──────────────────────────────

const SANDBOX_SCHEMA_DECLARATION_MARKER = "declare const SandboxSettingsSchema:";
const SANDBOX_SCHEMA_ANCHOR_KEYS = ["enabled", "network", "filesystem"];

/** Resolve the installed SDK's package directory without depending on `./package.json` being exported. */
function resolveSdkPackageDir(): string {
  const entryUrl = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
  return dirname(fileURLToPath(entryUrl));
}

function readInstalledSdkVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(resolveSdkPackageDir(), "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

function findMatchingBraceClose(source: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract the top-level member names of a `declare const <name>: () => z.ZodObject<{ ... }, ...>;`
 * declaration in a `.d.ts` file, by tracking BRACE DEPTH from the declaration's
 * opening `{` to its matching close — the only route that cannot mistake a nested
 * member for a top-level one. THROWS A NAMED PARSER FAULT (never returns an empty
 * or implausible set silently) when: the declaration marker isn't found, it has no
 * opening brace, the braces are unbalanced, or the extracted set is implausible
 * (empty, or missing one of `anchors`).
 */
function extractTopLevelZodObjectMembers(
  source: string,
  declarationMarker: string,
  anchors: string[],
): string[] {
  const declIdx = source.indexOf(declarationMarker);
  if (declIdx === -1) {
    throw new Error(`PARSER FAULT: declaration '${declarationMarker}' not found in source.`);
  }
  const openIdx = source.indexOf("{", declIdx);
  if (openIdx === -1) {
    throw new Error(`PARSER FAULT: no opening brace found after '${declarationMarker}'.`);
  }
  const closeIdx = findMatchingBraceClose(source, openIdx);
  if (closeIdx === -1) {
    throw new Error(
      `PARSER FAULT: no matching closing brace found for '${declarationMarker}' (unbalanced braces).`,
    );
  }
  const body = source.slice(openIdx, closeIdx + 1);
  const memberLineRe = /^[ \t]*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/;
  const members: string[] = [];
  let depth = 0;
  for (const line of body.split("\n")) {
    if (depth === 1) {
      const m = memberLineRe.exec(line);
      if (m) members.push((m[1] ?? m[2] ?? m[3])!);
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  const missingAnchors = anchors.filter((a) => !members.includes(a));
  if (members.length === 0 || missingAnchors.length > 0) {
    throw new Error(
      `PARSER FAULT: extraction from '${declarationMarker}' found an implausible member set ` +
        `(${members.length} member(s); missing anchor keys: ${missingAnchors.join(", ") || "(none — but zero members)"}). ` +
        `Treat this as a parser fault, never as "the schema is empty".`,
    );
  }
  return members;
}

/**
 * Compare a pinned key set to the schema's live members in BOTH directions.
 * Returns `null` when equal, or a message naming the keys the schema ADDED
 * (present live, not pinned), the keys the schema REMOVED (pinned, no longer
 * live), and the SDK version measured — never a bare "sets differ".
 */
function formatSandboxKeySetDrift(pinned: Set<string>, live: string[], sdkVersion: string): string | null {
  const liveSet = new Set(live);
  const added = live.filter((k) => !pinned.has(k)).sort();
  const removed = [...pinned].filter((k) => !liveSet.has(k)).sort();
  if (added.length === 0 && removed.length === 0) return null;
  return (
    `SANDBOX_KEYS (src/lib/settings.ts) has drifted from the live SandboxSettingsSchema ` +
    `at SDK ${sdkVersion}. ` +
    `Added by the schema (present live, not pinned): ${added.length ? added.join(", ") : "(none)"}. ` +
    `Removed from the schema (pinned, no longer live): ${removed.length ? removed.join(", ") : "(none)"}. ` +
    `Re-pin SANDBOX_KEYS from the schema dump and update the marker comment in src/lib/settings.ts.`
  );
}

test("W1-T2216: SANDBOX_KEYS matches SandboxSettingsSchema's live top-level members, in both directions", () => {
  const sdkDtsPath = join(resolveSdkPackageDir(), "sdk.d.ts");
  const dts = readFileSync(sdkDtsPath, "utf8");
  const liveMembers = extractTopLevelZodObjectMembers(
    dts,
    SANDBOX_SCHEMA_DECLARATION_MARKER,
    SANDBOX_SCHEMA_ANCHOR_KEYS,
  );
  const version = readInstalledSdkVersion();
  const drift = formatSandboxKeySetDrift(SANDBOX_KEYS, liveMembers, version);
  assert.equal(drift, null, drift ?? "");
});

test("W1-T2216: an extraction that finds no plausible member set fails as a parser fault, never as reported equality", () => {
  assert.throws(
    () =>
      extractTopLevelZodObjectMembers(
        "declare const SandboxSettingsSchema: () => z.ZodObject<{}, z.core.$loose>;",
        SANDBOX_SCHEMA_DECLARATION_MARKER,
        SANDBOX_SCHEMA_ANCHOR_KEYS,
      ),
    /PARSER FAULT/,
    "an empty extraction must throw a named parser fault, never silently report an empty set as equal",
  );
  assert.throws(
    () => extractTopLevelZodObjectMembers("no declaration in this source at all", SANDBOX_SCHEMA_DECLARATION_MARKER, SANDBOX_SCHEMA_ANCHOR_KEYS),
    /PARSER FAULT/,
    "a missing declaration marker must throw a named parser fault",
  );
  assert.throws(
    () =>
      extractTopLevelZodObjectMembers(
        "declare const SandboxSettingsSchema: () => z.ZodObject<{\n    enabled: z.ZodOptional<z.ZodBoolean>;\n}, z.core.$loose>;",
        SANDBOX_SCHEMA_DECLARATION_MARKER,
        SANDBOX_SCHEMA_ANCHOR_KEYS,
      ),
    /PARSER FAULT/,
    "a non-empty but anchor-missing set (no network/filesystem) must still fail as a parser fault",
  );
});

test("W1-T2216: a drift failure names the keys ADDED, the keys REMOVED, and the SDK version measured", () => {
  const message = formatSandboxKeySetDrift(
    new Set(["enabled", "network", "goneFromSchema"]),
    ["enabled", "network", "newInSchema"],
    "9.9.9",
  );
  assert.ok(message, "a real drift must produce a message, not null");
  assert.match(message!, /newInSchema/, "must name the key the schema ADDED");
  assert.match(message!, /goneFromSchema/, "must name the key REMOVED from the schema");
  assert.match(message!, /9\.9\.9/, "must name the SDK version it measured against");
});

test("W1-T2216: equal sets (either order) report no drift", () => {
  assert.equal(formatSandboxKeySetDrift(new Set(["a", "b"]), ["b", "a"], "1.2.3"), null);
});

test("W1-T2216: the guard still refuses an unknown or misplaced sandbox key exactly as it does today", () => {
  // Same hazard as the top-of-file suite (WS-0 FF10a) — pinned here explicitly so
  // this criterion has its own named assertion, independent of the enforcer above.
  assert.throws(
    () => validateWorkerSettings({ ...GOOD, sandbox: { ...GOOD.sandbox, notARealKey: true } }),
    WorkerSettingsError,
  );
  assert.throws(
    () => validateWorkerSettings({ ...GOOD, sandbox: { ...GOOD.sandbox, denyRead: ["~/.ssh/**"] } }),
    (e: unknown) => e instanceof WorkerSettingsError && /sandbox\.filesystem/.test((e as Error).message),
  );
});

test("W1-T2216: the pin marker records what was verified and when, not a bare version", () => {
  const settingsSrcPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "settings.ts");
  const src = readFileSync(settingsSrcPath, "utf8");
  assert.match(
    src,
    /verified equal to SandboxSettingsSchema at SDK \d+\.\d+\.\d+, \d{4}-\d{2}-\d{2}/,
    "the pin marker must record the SDK version AND the date it was verified, not a bare version number",
  );
});
