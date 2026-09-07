import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_SCHEMA, ConfigShapeError, validateConfigShape, type Config } from "../src/lib/config-schema.js";
import { loadConfig, validateConfig } from "../src/lib/config.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test("validateConfigShape refuses a wrong-typed field and names the field and source", () => {
  assert.throws(
    () =>
      validateConfigShape(
        { claudeBin: "/usr/bin/claude", root: "/tmp/root", softBudgetThresholdUsd: "25" },
        "unit-test-config.json",
      ),
    (err: unknown) => {
      assert.ok(err instanceof ConfigShapeError);
      assert.match(err.message, /unit-test-config\.json/);
      assert.match(err.message, /softBudgetThresholdUsd/);
      assert.match(err.message, /expected number/);
      return true;
    },
  );
});

test("CONFIG_SCHEMA declares the config field shape as metadata", () => {
  const fields = new Set<keyof Config>([
    "claudeBin",
    "root",
    "installRoot",
    "zdotdir",
    "workerShell",
    "workerHomeRoot",
    "softBudgetThresholdUsd",
    "workerModel",
    "architectModel",
    "accessTeamDomain",
    "accessAudience",
    "notifyRecipient",
    "overflow",
    "dailyCapUsd",
    "fixStrikeCap",
    "consoleUrl",
    "serve",
    "relay",
    "headroom",
    "workerProviders",
    "learningsHomes",
  ]);
  assert.deepEqual(
    CONFIG_SCHEMA.map((field) => field.name).sort(),
    [...fields].sort(),
  );
  for (const field of CONFIG_SCHEMA) {
    assert.ok(field.type.trim(), `${field.name} must declare a type`);
    assert.ok(field.source.trim(), `${field.name} must declare a source`);
    assert.ok(field.description.trim(), `${field.name} must declare a description`);
    assert.ok("default" in field, `${field.name} must declare a default, even when undefined`);
  }
});

test("validateConfig refuses a wrong-typed field before semantic rules run", () => {
  assert.throws(
    () =>
      validateConfig({
        claudeBin: "/usr/bin/claude",
        root: "/tmp/root",
        softBudgetThresholdUsd: "25",
      } as never),
    (err: unknown) => {
      assert.ok(err instanceof ConfigShapeError);
      assert.match(err.message, /validateConfig input/);
      assert.match(err.message, /softBudgetThresholdUsd/);
      return true;
    },
  );
});

test("loadConfig shape-validates an existing config before semantic validation", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-config-schema-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const configPath = join(home, ".config", "remudero", "config.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        claudeBin: "/usr/bin/claude",
        root: "/tmp/root",
        softBudgetThresholdUsd: "25",
      }),
    );

    assert.throws(
      () => loadConfig(),
      (err: unknown) => {
        assert.ok(err instanceof ConfigShapeError);
        assert.match(err.message, /softBudgetThresholdUsd/);
        assert.match(err.message, /config\.json/);
        return true;
      },
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
