import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as gardener from "../src/lib/gate-gardener.js";
import { makeTempDir } from "../src/lib/tmp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const census = await import(pathToFileURL(join(ROOT, "scripts/expiring-fixture-census.mjs")).href);
const NOW = Date.now();
const DAY = 86_400_000;
const FILE = "test/near.test.ts";
type Measurement = { passed: boolean; pass: number; tests: number };
type Runner = (file: string, days: number) => Measurement;
const green = { passed: true, pass: 15, tests: 15 };
const red = { passed: false, pass: 14, tests: 15 };
const stamp = (days: number) => new Date(NOW + (days - 14) * DAY).toISOString();

function check(runSuite: Runner, days = 0.5, inherited = false, duplicate = false) {
  const text = `updated_at: "${stamp(days)}",\n${duplicate ? `updatedAt: "${stamp(days / 2)}",` : ""}`;
  const output: string[] = [];
  const code = census.main({
    execFile: (command: string, args: string[]) => {
      if (command === "node") return JSON.stringify({ staleDays: 14 });
      if (args[0] === "ls-files") return FILE;
      if (args[0] === "rev-parse") return "base";
      return inherited ? text : "";
    },
    readFile: () => text, now: () => NOW, log: (line: string) => output.push(line),
    assertAged: () => undefined, assertComplete: () => undefined,
    recordedPopulationByFile: {}, runSuite,
  });
  return { code, report: output.join("\n") };
}

test("W1-T7812: a near crossing whose shifted re-run goes red blocks as confirmed", () => {
  const calls: Array<[string, number]> = [];
  const result = check((file, days) => {
    calls.push([file, days]);
    return days < 1 ? green : red;
  }, 0.5, true, true);
  assert.equal(result.code, 1);
  assert.match(result.report, /confirmed/);
  assert.match(result.report, /BLOCKED/);
  assert.deepEqual(calls, [[FILE, gardener.DEFUSE_CONTROL_SHIFT_DAYS], [FILE, 2]]);
});

test("W1-T7812: a near crossing that stays green proposes the exemption marker with its pass counts", () => {
  const calls: number[] = [];
  const result = check((_file, days) => { calls.push(days); return green; }, 0.75, false, true);
  assert.equal(result.code, 0);
  assert.match(result.report, /shifted_passed/);
  assert.match(result.report, /CLEAR/);
  assert.match(result.report, /expiring-fixture: exempt -- .+; 15\/15 pass with Date.now shifted \+2d/);
  assert.deepEqual(calls, [gardener.DEFUSE_CONTROL_SHIFT_DAYS, 2]);
});

test("W1-T7812: a re-run with no verdict blocks as run_error", () => {
  for (const atControl of [true, false]) {
    let calls = 0;
    const result = check(() => {
      calls++;
      if (!atControl && calls === 1) return green;
      throw new Error("no # tests TAP summary; run timed out");
    });
    assert.equal(result.code, 1);
    assert.match(result.report, /run_error/);
    assert.match(result.report, /no # tests TAP summary; run timed out/);
    assert.doesNotMatch(result.report, /expiring-fixture: exempt/);
    assert.equal(calls, atControl ? 1 : 2);
  }
});

test("W1-T7812: control red blocks as control_failed without a shifted run", () => {
  let calls = 0;
  const result = check(() => { calls++; return red; }, 0.5, true);
  assert.equal(result.code, 1);
  assert.equal(calls, 1);
  assert.match(result.report, /control_failed.*red without any shift/);
});

test("W1-T7812: a crossing beyond the 24 h tier runs no suite and keeps the attributed rule", () => {
  const never = (): Measurement => { throw new Error("far crossing ran a suite"); };
  assert.equal(check(never, 1.0001).code, 1);
  const inherited = check(never, 1.0001, true);
  assert.equal(inherited.code, 0);
  assert.match(inherited.report, /inherited/);
  assert.doesNotMatch(inherited.report, /confirmed|run_error|shifted_passed|control_failed/);
  assert.equal(census.NEAR_CROSSING_HOURS, 24);
  assert.equal(check(never, 1, true).code, 0, "exactly 24 h is outside the strictly inside tier");
});

function fixture() {
  const root = makeTempDir("near-crossing-runner");
  mkdirSync(join(root, "test", "setup"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
  symlinkSync(join(ROOT, "scripts", "clock-shift.mjs"), join(root, "scripts", "clock-shift.mjs"));
  return root;
}

const measured = (root: string, file: string, days: number, options?: object): Measurement =>
  (gardener as unknown as { runSuiteShiftedMeasured: (r: string, f: string, d: number, o?: object) => Measurement })
    .runSuiteShiftedMeasured(root, file, days, options);

test("W1-T7812: each shifted re-run runs under its own private TMPDIR", () => {
  const root = fixture();
  const parent = tmpdir();
  const evidence = join(root, "roots.jsonl");
  const file = join(root, "test", "private.test.ts");
  writeFileSync(file, `import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("private root", () => {
  const temp = tmpdir();
  assert.notEqual(temp, ${JSON.stringify(parent)});
  const child = join(temp, "rmd-fixture");
  mkdirSync(child);
  writeFileSync(join(child, "proof"), "present");
  appendFileSync(${JSON.stringify(evidence)}, JSON.stringify(temp) + "\\n");
});\n`);
  try {
    assert.deepEqual(measured(root, file, gardener.DEFUSE_CONTROL_SHIFT_DAYS), { passed: true, pass: 1, tests: 1 });
    assert.deepEqual(measured(root, file, 2), { passed: true, pass: 1, tests: 1 });
    const roots = readFileSync(evidence, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string);
    assert.equal(new Set(roots).size, 2);
    for (const temp of roots) assert.equal(existsSync(temp), false, "runner removes its root and descendants");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T7812: the shared default runner measures a real clock-sensitive suite", () => {
  const root = fixture();
  const file = join(root, "test", "bomb.test.ts");
  writeFileSync(file, `import { test } from "node:test";
import assert from "node:assert/strict";
test("crosses", () => assert.ok(Date.now() < ${Date.now() + DAY}));\n`);
  try {
    assert.deepEqual(measured(root, file, gardener.DEFUSE_CONTROL_SHIFT_DAYS), { passed: true, pass: 1, tests: 1 });
    assert.deepEqual(measured(root, file, 2), { passed: false, pass: 0, tests: 1 });
    assert.equal(gardener.runSuiteShifted(root, file, 2), false);
    const reports: string[] = [];
    const code = census.main({
      execFile: (command: string, args: string[]) => command === "node"
        ? JSON.stringify({ staleDays: 14 }) : args[0] === "ls-files" ? "test/bomb.test.ts" : "",
      readFile: () => `updated_at: "${stamp(0.5)}",`, now: () => NOW,
      log: (line: string) => reports.push(line), assertAged: () => undefined,
      assertComplete: () => undefined, recordedPopulationByFile: {}, repoRoot: root,
    });
    assert.equal(code, 1);
    assert.match(reports.join("\n"), /confirmed -- 0\/1 pass/);
    assert.throws(() => measured(join(root, "absent"), file, 2), /ENOENT/);
    assert.throws(() => measured(root, join(root, "absent.test.ts"), 2), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T7812: incomplete, killed, and summary-less runner output never passes", () => {
  const root = fixture();
  const file = join(root, "test", "empty.test.ts");
  writeFileSync(file, "export {};\n");
  try {
    for (const output of ["", "# pass 1\n# fail 0\n", "# tests 1\n", "# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n", "# tests 1\n# pass 0\n# fail 0\n# cancelled 1\n"]) {
      assert.throws(() => measured(root, file, 2, { execFile: () => output }), /TAP|verdict/);
    }
    const killed = Object.assign(new Error("timed out"), { status: null, signal: "SIGTERM", stdout: "# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n" });
    assert.throws(() => measured(root, file, 2, { execFile: () => { throw killed; } }), /timed out/);
    const failed = Object.assign(new Error("exit 1"), { status: 1, stdout: "" });
    assert.throws(() => measured(root, file, 2, { execFile: () => { throw failed; } }), /TAP/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
