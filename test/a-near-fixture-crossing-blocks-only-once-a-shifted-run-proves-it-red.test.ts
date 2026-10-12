import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as gardener from "../src/lib/gate-gardener.js";
import * as precheck from "../scripts/census-precheck.mjs";
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

  const root = fixture();
  const file = "test/green.test.ts";
  writeFileSync(join(root, file), 'import { test } from "node:test";\ntest("green", () => {});\n');
  const output: string[] = [];
  try {
    const code = census.main({
      execFile: (command: string, args: string[]) => command === "node"
        ? JSON.stringify({ staleDays: 14 }) : args[0] === "ls-files" ? file : "",
      readFile: () => `updated_at: "${stamp(0.5)}",`, now: () => NOW,
      log: (line: string) => output.push(line), assertAged: () => undefined,
      assertComplete: () => undefined, recordedPopulationByFile: {}, repoRoot: root,
    });
    assert.equal(code, 0);
    assert.match(output.join("\n"), /expiring-fixture: exempt -- .+; 1\/1 pass with Date.now shifted \+2d/);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

  const root = fixture();
  const file = "test/empty.test.ts";
  writeFileSync(join(root, file), "export {};\n");
  const output: string[] = [];
  try {
    const code = census.main({
      execFile: (command: string, args: string[]) => command === "node"
        ? JSON.stringify({ staleDays: 14 }) : args[0] === "ls-files" ? file : "",
      readFile: () => `updated_at: "${stamp(0.5)}",`, now: () => NOW,
      log: (line: string) => output.push(line), assertAged: () => undefined,
      assertComplete: () => undefined, recordedPopulationByFile: {}, repoRoot: root,
    });
    assert.equal(code, 1, "a green file wrapper is not a measured test verdict");
    assert.match(output.join("\n"), /run_error.*no named tests/);
    assert.doesNotMatch(output.join("\n"), /expiring-fixture: exempt/);

    writeFileSync(join(root, file), `import { test } from "node:test";
test("completed", () => {});
test("exits before finishing", async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  process.exit(0);
});
`);
    output.length = 0;
    const interrupted = census.main({
      execFile: (command: string, args: string[]) => command === "node"
        ? JSON.stringify({ staleDays: 14 }) : args[0] === "ls-files" ? file : "",
      readFile: () => `updated_at: "${stamp(0.5)}",`, now: () => NOW,
      log: (line: string) => output.push(line), assertAged: () => undefined,
      assertComplete: () => undefined, recordedPopulationByFile: {}, repoRoot: root,
    });
    assert.equal(interrupted, 1, "a partial test file cannot earn an exemption");
    assert.match(output.join("\n"), /run_error.*never reported/);
    assert.doesNotMatch(output.join("\n"), /expiring-fixture: exempt/);
    assert.throws(() => gardener.runSuiteShifted(root, file, 2), /never reported/);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test("W1-T7812: pre-push runs the shifted-crossing proof when its implementation or roster changes", () => {
  const testFile = "test/a-near-fixture-crossing-blocks-only-once-a-shifted-run-proves-it-red.test.ts";
  const dependencies = [
    "scripts/expiring-fixture-census.mjs", "src/lib/gate-gardener.ts", "scripts/clock-shift.mjs",
    "src/lib/ci-parity.ts", "scripts/census-precheck.mjs", "package.json", testFile,
  ];
  for (const changedPath of dependencies) {
    const runs: string[][] = [];
    const result = precheck.evaluateAdmittedCensusSuites({
      changed: [changedPath], loadMembers: () => [],
      runSuites: (files: string[]) => { runs.push(files); return []; },
    }) as { violations: string[]; unmeasured: string | null };
    assert.deepEqual(runs, [[testFile]], changedPath);
    assert.deepEqual(result, { violations: [], unmeasured: null }, changedPath);
  }
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
  gardener.runSuiteShiftedMeasured(root, file, days, options);

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

test("W1-T7812: incomplete TAP counts block as run_error and clean the private root", () => {
  const root = fixture();
  const file = join(root, "test", "counts.test.ts");
  writeFileSync(file, 'import { test } from "node:test";\ntest("green", () => {});\n');
  const parent = process.env.TMPDIR;
  const summary = "# Subtest: measured\n# tests 2\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  const roots: string[] = [];
  const run = (output: string, error?: Error) => measured(root, file, 2, {
    execFile: (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      roots.push(options.env.TMPDIR!);
      assert.ok(existsSync(options.env.TMPDIR!));
      const destination = args.find((arg) => arg.startsWith("--test-reporter-destination=") && arg.endsWith("tally.json"));
      if (destination) writeFileSync(destination.slice(destination.indexOf("=") + 1), JSON.stringify({
        summary: { tests: Number(/# tests (\d+)/.exec(output)?.[1]), failed: Number(/# fail (\d+)/.exec(output)?.[1]) },
        fileSummaries: [file],
      }));
      if (error) throw error;
      return output;
    },
  });
  try {
    const result = check(() => run(summary));
    assert.equal(result.code, 1);
    assert.match(result.report, /run_error.*incomplete TAP verdict/);
    assert.doesNotMatch(result.report, /expiring-fixture: exempt/);
    assert.throws(() => run(summary.replace("# tests 2", "# tests 1").replace("# skipped 0\n", "")), /no # skipped/);
    assert.throws(() => run(summary, Object.assign(new Error("spawn timed out"), { signal: "SIGTERM" })), /spawn timed out/);
    const skipped = summary.replace("# skipped 0", "# skipped 1");
    assert.deepEqual(run(skipped), { passed: true, pass: 1, tests: 2 });
    assert.throws(() => run(skipped, Object.assign(new Error("output buffer exceeded"), { status: 0 })), /output buffer exceeded/);
    assert.throws(() => run(skipped.replace("# tests 2", "# tests 999999999999999999")), /invalid # tests TAP count/);
    assert.throws(() => run(skipped.replace("# fail 0", "# fail 1")), /incomplete TAP verdict/);
    const failed = summary.replace("# pass 1", "# pass 0").replace("# fail 0", "# fail 2");
    assert.deepEqual(run(failed, Object.assign(new Error("exit 1"), { status: 1, stdout: failed })), { passed: false, pass: 0, tests: 2 });
    assert.throws(() => run(skipped, Object.assign(new Error("exit 1"), { status: 1, stdout: skipped })), /incomplete TAP verdict/);
    assert.equal(process.env.TMPDIR, parent);
    for (const temp of roots) assert.equal(existsSync(temp), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T7812: inconsistent or missing end-of-run tallies block as run_error", () => {
  const root = fixture();
  const file = join(root, "test", "tally.test.ts");
  writeFileSync(file, 'import { test } from "node:test";\ntest("measured", () => {});\n');
  try {
    for (const failed of [0, 1]) {
      const output = `# Subtest: measured\n# tests 1\n# pass ${1 - failed}\n# fail ${failed}\n# cancelled 0\n# skipped 0\n# todo 0\n`;
      for (const summary of [null, { tests: 2, failed }, { tests: 1, failed: 1 - failed }]) {
        let calls = 0;
        const result = check(() => {
          if (calls++ === 0) return green;
          return measured(root, file, 2, {
            execFile: (_command: string, args: string[]) => {
              const destination = args.find((arg) => arg.startsWith("--test-reporter-destination=") && arg.endsWith("tally.json"));
              assert.ok(destination);
              writeFileSync(destination.slice(destination.indexOf("=") + 1), JSON.stringify({ summary, fileSummaries: [file] }));
              if (failed) throw Object.assign(new Error("exit 1"), { status: 1, stdout: output });
              return output;
            },
          });
        });
        assert.equal(result.code, 1);
        assert.match(result.report, /run_error/);
        assert.doesNotMatch(result.report, /expiring-fixture: exempt/);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
