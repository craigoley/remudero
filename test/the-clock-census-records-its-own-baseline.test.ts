import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "clock-signature-ratchet.mjs");
const clockRatchet = (await import(pathToFileURL(SCRIPT).href)) as {
  main: (
    argv: string[],
    deps?: { writeFileSync?: (path: string, data: string, encoding?: string) => void },
  ) => number;
  readBaseline: (text: string, path?: string) => Record<string, unknown>;
};
const { main, readBaseline } = clockRatchet;

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

test("W1-T3902 real clock-ratchet subprocess keeps the default filesystem path in test/the-clock-census-records-its-own-baseline.test.ts", () => {
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

test("baseline parsing refuses malformed JSON and non-object values", () => {
  assert.throws(() => readBaseline("{"), /is not valid JSON/);
  assert.throws(() => readBaseline("[]"), /must be a JSON object/);
});

test("W1-T3902 injected write failure is host-independent in test/the-clock-census-records-its-own-baseline.test.ts", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-clock-signature-write-failure-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const baseline = join(root, "baseline.json");
  writeFileSync(baseline, "{}\n");
  writeFileSync(join(root, "src", "clock.ts"), "export const now = () => Date.now();\n");
  const before = readFileSync(baseline, "utf8");
  const diskFull = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  let diagnostic = "";
  const originalError = console.error;
  try {
    console.error = (...args: unknown[]) => {
      diagnostic += `${args.join(" ")}\n`;
    };
    assert.equal(
      main(["--root", root, "--baseline", baseline], {
        writeFileSync: () => {
          throw diskFull;
        },
      }),
      2,
    );
    assert.match(diagnostic, /could not write .*ENOSPC/);
    assert.equal(readFileSync(baseline, "utf8"), before);
  } finally {
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});
