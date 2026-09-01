import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { architectModel, ConfigValidationError, configPath, loadConfig, resolveHeadroomEnabled, validateConfig, type Config } from "../src/lib/config.js";

// NOTE: calling loadConfig() on its CREATE path shells `which claude`, which is
// absent in CI (LEARNINGS.md: lazy-config-in-ci). validateConfig is a pure function
// over a plain Config object, so it's exercised directly instead.
function config(over: Partial<Config> = {}): Config {
  return { claudeBin: "/usr/bin/claude", root: "/tmp/root", ...over };
}

// ── W1-T67: loadConfig's EEXIST fallback (the exclusive-create read path) ────────
// The create path is `openSync(p, "wx", 0o600)` — no existsSync-then-write TOCTOU.
// When the file ALREADY exists (a concurrent first-run winner, or a normal second
// boot), `wx` fails with EEXIST and loadConfig READS the existing file, never
// clobbering it. Testing the EEXIST fallback is CI-safe: a PRE-EXISTING full config
// (with claudeBin present) means the read path never reaches resolveClaudeBin, so
// no `which claude` shell-out happens.
test("W1-T67: loadConfig's EEXIST fallback READS the existing config, never clobbering it (no exists-then-write TOCTOU)", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-cfg-eexist-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home; // configPath() is HOME-relative (~/.config/remudero/config.json)
  try {
    const p = configPath();
    assert.ok(p.startsWith(home), "configPath must resolve under the overridden HOME");
    // Simulate the "already exists" case: a full, valid config with a SENTINEL root
    // that a clobbering write would destroy.
    const existing: Config = { claudeBin: "/opt/homebrew/bin/claude", root: "/SENTINEL/root" };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(existing, null, 2) + "\n");

    const loaded = loadConfig(); // openSync wx -> EEXIST -> read path (no resolveClaudeBin: claudeBin present)

    assert.equal(loaded.root, "/SENTINEL/root", "the existing config must be READ, not clobbered by a first-run write");
    assert.equal(loaded.claudeBin, "/opt/homebrew/bin/claude");
    // The file on disk is byte-for-byte the one we wrote — the EEXIST path wrote nothing.
    assert.equal(readFileSync(p, "utf8"), JSON.stringify(existing, null, 2) + "\n");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("validateConfig rejects overflow: api_key + daily_cap: none (dailyCapUsd unset)", () => {
  assert.throws(() => validateConfig(config({ overflow: "api_key" })), ConfigValidationError);
});

test("validateConfig rejects overflow: api_key + an explicit null dailyCapUsd", () => {
  assert.throws(
    () => validateConfig(config({ overflow: "api_key", dailyCapUsd: null })),
    ConfigValidationError,
  );
});

test("validateConfig accepts overflow: api_key when a dailyCapUsd is set", () => {
  assert.doesNotThrow(() => validateConfig(config({ overflow: "api_key", dailyCapUsd: 50 })));
});

test("validateConfig accepts overflow: none with no dailyCapUsd (subscription default, G-3)", () => {
  assert.doesNotThrow(() => validateConfig(config({ overflow: "none" })));
});

test("validateConfig accepts a config with overflow entirely unset (default is none)", () => {
  assert.doesNotThrow(() => validateConfig(config()));
});

// ── resolveHeadroomEnabled (ruling fb-1784894405468-a4153e; DEFAULT clause reversed
// by the operator ruling of 2026-07-25 — the flag architecture a4153e built is kept
// verbatim, only the inherited default flips) ────────────────────────────────────

test("resolveHeadroomEnabled: default is ON — an unconfigured install inherits the governor, protecting the subscription window", () => {
  assert.equal(resolveHeadroomEnabled(config(), {}), true);
  // ...and an empty headroom object is still "unset", not a spurious OFF.
  assert.equal(resolveHeadroomEnabled(config({ headroom: {} }), {}), true);
});

test("resolveHeadroomEnabled: an explicit config headroom.enabled=false is honored — opting into overflow is the deliberate act (this host's posture)", () => {
  assert.equal(resolveHeadroomEnabled(config({ headroom: { enabled: false } }), {}), false);
  // The host config is exactly this shape: the credits-burst opt-out a4153e ruled for,
  // now carried explicitly rather than inherited from a permissive default.
  const hostConfig = JSON.parse(
    '{"claudeBin":"/Users/x/.npm-global/bin/claude","root":"/Users/x/Remudero","headroom":{"enabled":false}}',
  ) as Config;
  assert.equal(resolveHeadroomEnabled(hostConfig, {}), false);
});

test("resolveHeadroomEnabled: config headroom.enabled=true turns it on", () => {
  assert.equal(resolveHeadroomEnabled(config({ headroom: { enabled: true } }), {}), true);
  assert.equal(resolveHeadroomEnabled(config({ headroom: { enabled: false } }), {}), false);
});

test("resolveHeadroomEnabled: RMD_HEADROOM_ENABLED overrides config in BOTH directions", () => {
  // env ON beats config OFF
  assert.equal(resolveHeadroomEnabled(config({ headroom: { enabled: false } }), { RMD_HEADROOM_ENABLED: "1" }), true);
  assert.equal(resolveHeadroomEnabled(config(), { RMD_HEADROOM_ENABLED: "true" }), true);
  // env OFF beats config ON
  assert.equal(resolveHeadroomEnabled(config({ headroom: { enabled: true } }), { RMD_HEADROOM_ENABLED: "0" }), false);
  assert.equal(resolveHeadroomEnabled(config({ headroom: { enabled: true } }), { RMD_HEADROOM_ENABLED: "false" }), false);
  // env OFF also beats the (now ON) inherited default, with no config field at all
  assert.equal(resolveHeadroomEnabled(config(), { RMD_HEADROOM_ENABLED: "0" }), false);
});

test("resolveHeadroomEnabled: an empty/whitespace env value defers to config, not a spurious OFF", () => {
  assert.equal(resolveHeadroomEnabled(config({ headroom: { enabled: true } }), { RMD_HEADROOM_ENABLED: "" }), true);
  assert.equal(resolveHeadroomEnabled(config({ headroom: { enabled: true } }), { RMD_HEADROOM_ENABLED: "   " }), true);
  // ...and it defers to an explicit config OFF too — a blank env never re-enables the governor
  assert.equal(resolveHeadroomEnabled(config({ headroom: { enabled: false } }), { RMD_HEADROOM_ENABLED: "" }), false);
});

// ── architectModel: the Architect-tier model is governed by mounts.yaml's `architect:` row ──
// (fb-1784921980488-44b355 §4 — the MPG first-instance ruling: opus -> Opus 5). Plan authorship
// (`rmd plan`'s orchestration) resolves its model through this. W1-T2559: retro, triage, and the
// inbox-draft spawns used to ALSO resolve through this resolver but now ride their OWN
// `synthesis.<role>` row instead — see test/synthesis-rungs-ride-their-own-mount.test.ts and
// src/lib/config.ts's `synthesisModel`/`synthesisEffort`.
test("architectModel: the mounts.yaml architect row is the source of truth, then config.architectModel, then the opus default", () => {
  // the mounts row wins when present
  assert.equal(architectModel(config(), { architect: { model: "claude-opus-5" } }), "claude-opus-5");
  // no mounts table -> falls back to config.architectModel
  assert.equal(architectModel(config({ architectModel: "sonnet" })), "sonnet");
  // neither present -> the bare "opus" default (back-compat)
  assert.equal(architectModel(config()), "opus");
  // the mounts row overrides even an explicit config.architectModel
  assert.equal(architectModel(config({ architectModel: "opus" }), { architect: { model: "claude-opus-5" } }), "claude-opus-5");
});
