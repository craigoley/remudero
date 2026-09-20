import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "clock-signature-ratchet.mjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-clock-signature-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const baseline = join(root, "baseline.json");
  writeFileSync(baseline, "{}\n");
  return { root, baseline };
}

function run(root: string, baseline: string, ...flags: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, "--baseline", baseline, ...flags], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

test("the generator writes a measured row into the clock-signature baseline", () => {
  const { root, baseline } = fixture();
  try {
    writeFileSync(join(root, "src", "clock.ts"), "export const now = () => Date.now();\n");
    const result = run(root, baseline);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(baseline, "utf8")), {
      "src/clock.ts": { legacy: 0, dateNow: 1, newDate: 0 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the no-record mode leaves the clock-signature baseline byte-identical", () => {
  const { root, baseline } = fixture();
  try {
    writeFileSync(baseline, "{}\n");
    writeFileSync(join(root, "src", "clock.ts"), "export const now = () => Date.now();\n");
    const before = readFileSync(baseline, "utf8");
    const result = run(root, baseline, "--no-record");
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(baseline, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable tree exits non-zero instead of recording", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-clock-signature-unreadable-"));
  const baseline = join(root, "baseline.json");
  writeFileSync(baseline, "{}\n");
  try {
    const result = run(root, baseline);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /clock-signature-ratchet:/);
    assert.equal(readFileSync(baseline, "utf8"), "{}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
