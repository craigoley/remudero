import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rotatingCanarySuite } from "../src/lib/model-canary-rotation.js";
import { canaryCommand } from "../src/lib/model-canary-command.js";
import { commonCanarySuite, gradeCanary, canaryTools } from "../src/lib/model-canary-suite.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const KEY = "ab".repeat(32), DAY = "2026-10-11";
function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-rotation-`));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
test("canary rotation gives every arm one reproducible private day pack and unique instance ids", () => {
  const a = rotatingCanarySuite(DAY, KEY), b = rotatingCanarySuite(DAY, KEY);
  assert.deepEqual(a, b); assert.equal(a.cases.length, 12); assert.equal(new Set(a.cases.map(v => v.id)).size, 12);
  assert.ok(a.cases.every(v => v.id.startsWith("rotation-" + DAY + "-") && v.id.length <= 128));
  assert.equal(a.sampleUnit, "task-instance"); assert.equal(a.inference, "descriptive-only");
  assert.notEqual(a.suiteHash, rotatingCanarySuite("2026-10-12", KEY).suiteHash);
  assert.notEqual(a.suiteHash, rotatingCanarySuite(DAY, "cd".repeat(32)).suiteHash);
  assert.equal(JSON.stringify(a).includes(KEY), false);
});
test("canary rotation rejects invalid calendars and private seed formats", () => {
  for (const day of ["2026-02-30", "2026-10-11T00:00:00Z", "", "2026-1-11"])
    assert.throws(() => rotatingCanarySuite(day, KEY), /day-invalid/);
  for (const key of ["", "a".repeat(63), "A".repeat(64), "x".repeat(64), KEY + "\n"])
    assert.throws(() => rotatingCanarySuite(DAY, key), /private-key-invalid/);
  assert.equal(rotatingCanarySuite("2024-02-29", KEY).cases.length, 12);
});
test("canary rotation preserves real scorer authority and missing evidence across varied instances", () => {
  for (const day of [DAY, "2026-10-12", "2026-11-02"]) {
    for (const item of rotatingCanarySuite(day, KEY).cases) {
      const tool = canaryTools(item), trace = item.tools === "none" ? [] : item.tools === "inventory"
        ? [tool("inventory", { item: item.id.endsWith("tools-A") ? "A" : "B" })]
        : item.tools === "retry" ? [tool("lookup", {}), tool("lookup", {})] : [tool("lookup", {})];
      assert.equal(gradeCanary(item, JSON.stringify(item.expected), trace).passed, true, item.id);
      assert.equal(gradeCanary(item, JSON.stringify({ ...item.expected, invented: true }), trace).passed, false);
      if (item.tools !== "none") assert.equal(gradeCanary(item, JSON.stringify(item.expected), []).passed, false);
    }
  }
  assert.deepEqual(rotatingCanarySuite(DAY, KEY).cases.find(v => v.id.endsWith("evidence-absent"))?.expected, { answer: null, sources: [] });
  assert.deepEqual(rotatingCanarySuite(DAY, KEY).cases.find(v => v.id.endsWith("schema-missing"))?.expected, { category: "other", ticket: null, severity: null });
  assert.equal(commonCanarySuite()[0]?.id, "schema-deploy");
});
test("canary rotation real command writes private scorer and inert request manifests without answers or key", () => fixture(root => {
  const keyFile = join(root, "synthetic-seed"), out = join(root, "out"); writeFileSync(keyFile, KEY + "\n", { mode: 0o600 });
  const child = spawnSync(process.execPath, ["--import", "tsx", "src/lib/model-canary-command.ts", "prepare-rotation", out, DAY, keyFile], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).cases, 12);
  const manifest = JSON.parse(readFileSync(join(out, "model-canary-rotation-manifest.json"), "utf8"));
  const scorer = JSON.parse(readFileSync(join(out, "model-canary-rotation-scorer.json"), "utf8"));
  assert.equal(manifest.state, "prepared-not-activated"); assert.equal(manifest.suiteHash, scorer.suiteHash);
  assert.ok(manifest.tasks.every((v: object) => !Object.hasOwn(v, "expected")));
  assert.ok(scorer.cases.every((v: object) => Object.hasOwn(v, "expected")));
  assert.equal(manifest.cash.globalDailyCapUsd, 25); assert.equal(manifest.cash.experimentDailyCapUsd, 0);
  assert.equal(manifest.cash.premiumCashEligible, false);
  assert.equal(JSON.stringify(manifest).includes(KEY), false); assert.equal(child.stdout.includes(KEY), false);
  for (const file of ["model-canary-rotation-manifest.json", "model-canary-rotation-scorer.json"])
    assert.equal(statSync(join(out, file)).mode & 0o077, 0);
  assert.equal(statSync(out).mode & 0o077, 0);
  assert.throws(() => canaryCommand(["prepare-rotation", out, DAY, keyFile]), /EEXIST/);
}));
test("canary rotation command refuses malformed arity, symlink key and invalid key before output", () => fixture(root => {
  assert.throws(() => canaryCommand(["prepare-rotation", root]), /usage/);
  const key = join(root, "key"); writeFileSync(key, KEY); symlinkSync(key, join(root, "alias"));
  assert.throws(() => canaryCommand(["prepare-rotation", join(root, "out"), DAY, join(root, "alias")]));
  writeFileSync(key, "not-a-key"); assert.throws(() => canaryCommand(["prepare-rotation", join(root, "out"), DAY, key]), /private-key-invalid/);
  assert.throws(() => canaryCommand(["prepare-rotation", join(root, "out"), DAY, join(root, "missing")]));
}));
test("canary rotation command retains the existing private Git-boundary refusal", () => fixture(root => {
  mkdirSync(join(root, "repo/.git"), { recursive: true }); const key = join(root, "key"); writeFileSync(key, KEY);
  assert.throws(() => canaryCommand(["prepare-rotation", join(root, "repo/out"), DAY, key]), /inside-git/);
}));
test("canary rotation seed reader bounds bytes while accepting a single CRLF", () => fixture(root => {
  const key = join(root, "key"); writeFileSync(key, KEY + "\r\n");
  assert.equal(canaryCommand(["prepare-rotation", join(root, "out"), DAY, key]).state, "prepared-not-activated");
  writeFileSync(key, KEY + "\n\n\n");
  assert.throws(() => canaryCommand(["prepare-rotation", join(root, "other"), DAY, key]), /input-bound/);
  assert.throws(() => canaryCommand(["prepare-rotation", join(root, "other"), DAY, root]), /regular-file-required/);
}));
test("canary rotation leaves the anchor preparation and real private projection available", () => fixture(root => {
  assert.equal(canaryCommand(["prepare", join(root, "anchors")]).state, "prepared-not-activated");
  const anchors = JSON.parse(readFileSync(join(root, "anchors/model-canary-manifest.json"), "utf8"));
  assert.equal(anchors.dailyCases, 12);
  const input = join(root, "runs"); writeFileSync(input, "[]");
  assert.equal(canaryCommand(["project", join(root, "report"), input]).state, "private-projection");
  assert.throws(() => canaryCommand(["project", join(root, "wrong")]));
  writeFileSync(input, "{}"); assert.throws(() => canaryCommand(["project", join(root, "wrong"), input]), /run-array-required/);
  assert.throws(() => canaryCommand(["unknown", root]), /usage/);
}));
