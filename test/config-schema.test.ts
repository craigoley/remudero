import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigShapeError, validateConfigShape } from "../src/lib/config-schema.js";
import { loadConfig } from "../src/lib/config.js";
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
