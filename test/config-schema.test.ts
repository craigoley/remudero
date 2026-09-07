import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG_SCHEMA, ConfigShapeError, validateConfigShape, type Config } from "../src/lib/config-schema.js";
import { loadConfig, validateConfig } from "../src/lib/config.js";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("validateConfigShape reports every schema variant through the declared config shape", () => {
  assert.throws(
    () =>
      validateConfigShape(
        {
          claudeBin: 12,
          root: "/tmp/root",
          overflow: "metered",
          dailyCapUsd: "25",
          serve: "127.0.0.1",
          headroom: { enabled: "yes" },
          workerProviders: { enabled: "claude", codexModels: { economy: ["gpt-5", 3] } },
          surprise: true,
        },
        "variant-config.json",
      ),
    (err: unknown) => {
      assert.ok(err instanceof ConfigShapeError);
      assert.match(err.message, /variant-config\.json/);
      assert.match(err.message, /claudeBin: expected string/);
      assert.match(err.message, /overflow: expected one of "none", "api_key"/);
      assert.match(err.message, /dailyCapUsd: expected number or null/);
      assert.match(err.message, /serve: expected object/);
      assert.match(err.message, /headroom\.enabled: expected boolean/);
      assert.match(err.message, /workerProviders\.enabled: expected string\[\]/);
      assert.match(err.message, /workerProviders\.codexModels\.economy\[1\]: expected string/);
      assert.match(err.message, /surprise: unexpected field/);
      return true;
    },
  );
});

test("validateConfigShape refuses a missing required root and a non-object document", () => {
  assert.throws(
    () => validateConfigShape({ claudeBin: "/usr/bin/claude" }, "missing-root.json"),
    (err: unknown) => {
      assert.ok(err instanceof ConfigShapeError);
      assert.match(err.message, /root: required field is missing/);
      return true;
    },
  );

  assert.throws(
    () => validateConfigShape(null, "null-config.json"),
    (err: unknown) => {
      assert.ok(err instanceof ConfigShapeError);
      assert.match(err.message, /<root>: expected object/);
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

test("loadConfig shape-validates newly created defaults before writing them", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-config-schema-create-"));
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeClaude, 0o755);

  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${binDir}${savedPath ? `:${savedPath}` : ""}`;
  try {
    const config = loadConfig();
    assert.equal(config.claudeBin, fakeClaude);
    assert.equal(config.root, join(home, "Remudero"));
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test("loadConfig fills legacy existing configs that omit claudeBin and root before shape validation", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-config-schema-defaults-"));
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = join(binDir, "claude");
  writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeClaude, 0o755);

  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = `${binDir}${savedPath ? `:${savedPath}` : ""}`;
  try {
    const configPath = join(home, ".config", "remudero", "config.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ workerModel: "sonnet" }));

    const config = loadConfig();
    assert.equal(config.claudeBin, fakeClaude);
    assert.equal(config.root, join(home, "Remudero"));
    assert.equal(config.workerModel, "sonnet");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});
