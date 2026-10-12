import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONFIG_SCHEMA, validateConfigShape } from "../src/lib/config-schema.js";
import { resolveHeavyReadyDirectory } from "../src/lib/config.js";

test("heavy READY startup config is explicitly opt-in and keeps the existing env override", () => {
  assert.equal(resolveHeavyReadyDirectory({}, {}), undefined);
  assert.equal(resolveHeavyReadyDirectory({ heavyReadyDirectory: "/private/core-ready" }, {}), "/private/core-ready");
  assert.equal(resolveHeavyReadyDirectory({ heavyReadyDirectory: "/private/core-ready" }, { RMD_HEAVY_READY_DIR: "/private/env-ready" }), "/private/env-ready");
  assert.equal(resolveHeavyReadyDirectory({ heavyReadyDirectory: "/private/core-ready" }, { RMD_HEAVY_READY_DIR: "" }), "", "preserve an explicitly invalid legacy override; the NEW-only reader refuses it");
});

test("heavy READY startup config has one declared optional string field and rejects malformed shape", () => {
  const field = CONFIG_SCHEMA.find(f => f.name === "heavyReadyDirectory");
  assert.equal(field?.type, "string"); assert.equal(field?.optional, true); assert.equal(field?.default, undefined);
  const base = { claudeBin: "/fixture/claude", root: "/fixture/root" };
  assert.deepEqual(validateConfigShape({ ...base, heavyReadyDirectory: "/private/core-ready" }), { ...base, heavyReadyDirectory: "/private/core-ready" });
  assert.throws(() => validateConfigShape({ ...base, heavyReadyDirectory: 123 }), /heavyReadyDirectory/);
});

test("both NEW-build composition roots resolve config once without starting or restarting a daemon", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  assert.equal([...source.matchAll(/checkHeavyNewBuild: deps\.checkHeavyNewBuild \?\? heavyNewBuildGate\(log, \{ dir: resolveHeavyReadyDirectory\(config\) \}\)/g)].length, 2);
  const configSource = readFileSync(fileURLToPath(new URL("../src/lib/config.ts", import.meta.url)), "utf8");
  const block = configSource.slice(configSource.indexOf("export function resolveHeavyReadyDirectory("), configSource.indexOf("\n}", configSource.indexOf("export function resolveHeavyReadyDirectory(")) + 2);
  assert.doesNotMatch(block, /execFile|spawn|writeFile|mkdir|restart|docker/);
});
