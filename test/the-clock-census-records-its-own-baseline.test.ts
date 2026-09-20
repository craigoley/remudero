import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "clock-signature-ratchet.mjs");

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static
// `import … from "../scripts/clock-signature-ratchet.mjs"` is a TS7016 -- the same reason
// test/a-source-file-cannot-outgrow-its-baseline.test.ts reaches its own sibling script through a
// runtime import rather than a typed one. A dynamic specifier is not statically resolved, so this
// loads the REAL module with no shadow copy to drift from it.
const { readBaseline, scanClockSignatures } = (await import(pathToFileURL(SCRIPT).href)) as {
  readBaseline: (text: string, path?: string) => Record<string, unknown>;
  scanClockSignatures: (root: string) => Record<string, { legacy: number; dateNow: number; newDate: number }>;
};

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
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /clock-signature-ratchet: CHECK FAILED -- 1 growth\/new row change\(s\) require recording/,
    );
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

test("scanClockSignatures counts the legacy shape, Date.now, and new Date separately", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-clock-signature-scan-"));
  try {
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(
      join(root, "src", "nested", "clock.ts"),
      "export const now: () => number = () => Date.now();\nconst then = new Date(0);\n",
    );
    writeFileSync(join(root, "src", "plain.ts"), "export const x = 1;\n");
    writeFileSync(join(root, "src", "ignored.js"), "const now = () => Date.now();\n");
    const result = scanClockSignatures(root);
    assert.deepEqual(result, {
      "src/nested/clock.ts": { legacy: 1, dateNow: 1, newDate: 1 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBaseline rejects invalid JSON, arrays, and null with a path-qualified message", () => {
  assert.throws(() => readBaseline("not json", "some/path.json"), /some\/path\.json is not valid JSON/);
  assert.throws(() => readBaseline("[]", "some/path.json"), /some\/path\.json must be a JSON object/);
  assert.throws(() => readBaseline("null", "some/path.json"), /some\/path\.json must be a JSON object/);
  assert.deepEqual(readBaseline('{"a":1}'), { a: 1 });
});

test("a shrink from the recorded baseline is recorded silently, not flagged as drift", () => {
  const { root, baseline } = fixture();
  try {
    writeFileSync(baseline, JSON.stringify({ "src/clock.ts": { legacy: 0, dateNow: 5, newDate: 0 } }) + "\n");
    writeFileSync(join(root, "src", "clock.ts"), "export const now = () => Date.now();\n");
    const result = run(root, baseline);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /CHECK FAILED/);
    assert.deepEqual(JSON.parse(readFileSync(baseline, "utf8")), {
      "src/clock.ts": { legacy: 0, dateNow: 1, newDate: 0 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file removed from the tree drops out of the recorded baseline", () => {
  const { root, baseline } = fixture();
  try {
    writeFileSync(baseline, JSON.stringify({ "src/gone.ts": { legacy: 0, dateNow: 3, newDate: 0 } }) + "\n");
    const result = run(root, baseline);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(baseline, "utf8")), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second run with no growth leaves the baseline file byte-identical on disk", () => {
  const { root, baseline } = fixture();
  try {
    writeFileSync(join(root, "src", "clock.ts"), "export const now = () => Date.now();\n");
    const first = run(root, baseline);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const before = statSync(baseline).mtimeMs;
    const beforeText = readFileSync(baseline, "utf8");
    const second = run(root, baseline);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(readFileSync(baseline, "utf8"), beforeText);
    assert.equal(statSync(baseline).mtimeMs, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--check exits 0 and prints OK when the tree already matches the baseline", () => {
  const { root, baseline } = fixture();
  try {
    writeFileSync(join(root, "src", "clock.ts"), "export const now = () => Date.now();\n");
    const record = run(root, baseline);
    assert.equal(record.status, 0, `${record.stdout}\n${record.stderr}`);
    const result = run(root, baseline, "--check");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /clock-signature-ratchet: OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("omitting --baseline falls back to the default in-root path", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-clock-signature-default-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    const defaultBaseline = join(root, "scripts", "clock-signature-baseline.json");
    writeFileSync(defaultBaseline, "{}\n");
    writeFileSync(join(root, "src", "clock.ts"), "export const now = () => Date.now();\n");
    const result = spawnSync(process.execPath, [SCRIPT, "--root", root], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(defaultBaseline, "utf8")), {
      "src/clock.ts": { legacy: 0, dateNow: 1, newDate: 0 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a read-only baseline file exits non-zero instead of silently dropping the write", () => {
  const { root, baseline } = fixture();
  try {
    writeFileSync(join(root, "src", "clock.ts"), "export const now = () => Date.now();\n");
    chmodSync(baseline, 0o400);
    try {
      const result = run(root, baseline);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /clock-signature-ratchet: could not write/);
    } finally {
      chmodSync(baseline, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
