import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigValidationError, validateConfig, type Config } from "../src/lib/config.js";

// NOTE: never call loadConfig() here — it eagerly shells `which claude`, which is
// absent in CI (LEARNINGS.md: lazy-config-in-ci). validateConfig is a pure function
// over a plain Config object, so it's exercised directly instead.
function config(over: Partial<Config> = {}): Config {
  return { claudeBin: "/usr/bin/claude", root: "/tmp/root", ...over };
}

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
