import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { readExistingNativeCanaryConfig } from "#src/lib/model-canary-native-config.js";

test("native config reader reads only an existing config and does not provision defaults", () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}native-canary-config-`));
  const prior = process.env.HOME;
  try {
    process.env.HOME = home;
    const missing = readExistingNativeCanaryConfig();
    assert.deepEqual(missing, { state: "unavailable", reason: "native-config-not-found" });
    assert.equal(existsSync(join(home, ".config", "remudero")), false);
    mkdirSync(join(home, ".config", "remudero"), { recursive: true, mode: 0o700 });
    const path = join(home, ".config", "remudero", "config.json");
    writeFileSync(path, JSON.stringify({ claudeBin: "/bin/true", root: join(home, "Remudero") }), { mode: 0o600 });
    const found = readExistingNativeCanaryConfig();
    assert.equal(found.state, "available");
    if (found.state === "available") assert.equal(found.config.root, join(home, "Remudero"));
  } finally {
    if (prior === undefined) delete process.env.HOME; else process.env.HOME = prior;
    rmSync(home, { recursive: true, force: true });
  }
});
