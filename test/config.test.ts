import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ConfigValidationError, configPath, loadConfig, validateConfig, type Config } from "../src/lib/config.js";

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
