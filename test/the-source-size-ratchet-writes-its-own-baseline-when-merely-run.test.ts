import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "source-size-ratchet.mjs");

function fixture(): { root: string; baselinePath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-source-size-check-"));
  const baselinePath = join(root, "baseline.json");
  writeFileSync(baselinePath, "{}\n");
  return { root, baselinePath };
}

function plant(root: string, path: string, lines: number): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${Array.from({ length: lines }, (_, i) => `// ${i}`).join("\n")}\n`);
}

function run(root: string, baselinePath: string, check = false) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--root", root, "--baseline", baselinePath, ...(check ? ["--check"] : [])],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
}

test("W1-T2678: --check refuses an unrecorded source file, prints its exact JSON entry, and leaves the baseline byte-identical", () => {
  const { root, baselinePath } = fixture();
  try {
    plant(root, "src/lib/new.ts", 17);
    const before = readFileSync(baselinePath, "utf8");
    const result = run(root, baselinePath, true);

    assert.notEqual(result.status, 0, "an unrecorded file must make check mode fail");
    assert.equal(readFileSync(baselinePath, "utf8"), before, "check mode must never rewrite the baseline");
    assert.match(result.stderr, /source-size-ratchet: CHECK FAILED/);
    assert.match(result.stderr, /^    "src\/lib\/new\.ts": 500,$/m, "the remedy prints the exact bucketed JSON line to add");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2678: default mode still records a newly seen source file", () => {
  const { root, baselinePath } = fixture();
  try {
    plant(root, "src/lib/new.ts", 17);
    const result = run(root, baselinePath);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), { "src/lib/new.ts": 500 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2678: a fully recorded tree is byte-identical after either mode", () => {
  const { root, baselinePath } = fixture();
  try {
    plant(root, "src/lib/known.ts", 17);
    const recorded = '{\n  "src/lib/known.ts": 500\n}\n';

    for (const check of [true, false]) {
      writeFileSync(baselinePath, recorded);
      const result = run(root, baselinePath, check);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(baselinePath, "utf8"), recorded, `${check ? "check" : "default"} mode must not rewrite a settled baseline`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2678: check mode never applies automatic shrink or deletion cleanup", () => {
  const { root, baselinePath } = fixture();
  try {
    plant(root, "src/lib/shrunk.ts", 17);
    const recorded = '{\n  "src/lib/gone.ts": 500,\n  "src/lib/shrunk.ts": 1000\n}\n';
    writeFileSync(baselinePath, recorded);

    const result = run(root, baselinePath, true);
    assert.notEqual(result.status, 0, "check mode reports every baseline change it declines to write");
    assert.equal(readFileSync(baselinePath, "utf8"), recorded);
    assert.match(result.stderr, /src\/lib\/shrunk\.ts: 1000 -> 500/);
    assert.match(result.stderr, /remove "src\/lib\/gone\.ts"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
