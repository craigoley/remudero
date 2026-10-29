import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listRuleSuites } from "#src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-ignore the executable .mjs module is exercised directly and has no declaration file.
import { main, ruleSuiteConcurrency, runRuleSuitesConcurrently, spawnSuiteCaptured } from "#scripts/list-rule-suites.mjs";

// light-gates ran 134 rule suites one at a time, ~11 of its 15 minutes, and 3 of 55 runs hit the
// ceiling (cancelled at 15 min; seen on #15538, 2026-10-29). The suites still run one file per child process, now several at once.

type Result = { status: number | null; error?: Error; output: string };

test("light-gates ceiling: the rule suites run several at once, each in its own child, and still name every failure in population order", async (t) => {
  const suites = listRuleSuites(REPO_ROOT);
  const failing = new Set([suites[1]!, suites[0]!]);
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => printed.push(line));
  t.mock.method(console, "error", (line: string) => printed.push(line));
  const write = (text: string) => printed.push(...text.replace(/\n$/, "").split("\n"));
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];
  const run = async (suite: string): Promise<Result> => {
    started.push(suite);
    peak = Math.max(peak, ++inFlight);
    // Later suites finish first, so the closing line cannot lean on completion order.
    await new Promise((resolve) => setTimeout(resolve, suite === suites[0] ? 20 : 1));
    inFlight--;
    return { status: failing.has(suite) ? 1 : 0, output: `out of ${suite}\nsecond line of ${suite}` };
  };
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 4, run, write }), 1);
  assert.equal(peak, 4, "four suites in flight at once");
  assert.deepEqual([...started].sort(), [...suites].sort(), "every suite runs exactly once");
  assert.equal(printed.at(-1), `rule-checks: failed suites: ${suites[0]} ${suites[1]}`);
  for (const suite of suites) {
    const at = printed.indexOf(`rule-checks: ${suite}`);
    assert.deepEqual(printed.slice(at, at + 3), [`rule-checks: ${suite}`, `out of ${suite}`, `second line of ${suite}`],
      "a suite's output follows its own header as one block");
  }

  printed.length = 0;
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 3, run: async () => ({ status: 0, output: "" }), write }), 0);
  assert.equal(printed.filter((line) => line.includes("failed suites")).length, 0, "a green run names no failed suite");
});

test("light-gates ceiling: the concurrency is the machine's parallelism unless RMD_RULE_SUITE_CONCURRENCY names a positive integer", () => {
  assert.equal(ruleSuiteConcurrency({}, 4), 4);
  assert.equal(ruleSuiteConcurrency({ RMD_RULE_SUITE_CONCURRENCY: "1" }, 4), 1);
  assert.equal(ruleSuiteConcurrency({ RMD_RULE_SUITE_CONCURRENCY: "6" }, 2), 6);
  for (const bad of ["0", "-2", "two", ""]) assert.equal(ruleSuiteConcurrency({ RMD_RULE_SUITE_CONCURRENCY: bad }, 2), 2, bad);
  assert.equal(ruleSuiteConcurrency({}, 0), 1);
});

test("light-gates ceiling: the real captured spawn returns a red suite's exit status with its output, and a child that never starts as an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rule-suite-spawn-`));
  try {
    // The suite file is absent, so node exits non-zero and says which file it could not run.
    const red = await spawnSuiteCaptured("absent.test.ts", dir);
    assert.notEqual(red.status, 0);
    assert.equal(red.error, undefined);
    assert.match(red.output, /absent\.test\.ts/);
    const never = await spawnSuiteCaptured("absent.test.ts", join(dir, "no-such-dir"));
    assert.equal(never.status, null);
    assert.match(String(never.error?.message), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("light-gates ceiling: --run goes concurrent at the configured width, and a suite's output reaches stdout by default", async (t) => {
  const calls: { root: string; concurrency: number }[] = [];
  const runConcurrently = async (root: string, options: { concurrency: number }) => { calls.push({ root, ...options }); return 0; };
  t.mock.method(console, "log", () => {});
  assert.equal(await main(["--run"], undefined, 3, runConcurrently), 0);
  assert.deepEqual(calls.map(({ concurrency }) => concurrency), [3]);
  assert.equal(calls[0]!.root.replace(/\/$/, ""), REPO_ROOT.replace(/\/$/, ""));

  const captured: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string" && chunk.startsWith("output of ")) { captured.push(chunk); return true; }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  });
  const suites = listRuleSuites(REPO_ROOT);
  assert.equal(await runRuleSuitesConcurrently(REPO_ROOT, { concurrency: 2, run: async (suite: string) => ({ status: 0, output: `output of ${suite}` }) }), 0);
  assert.deepEqual([...captured].sort(), suites.map((suite) => `output of ${suite}\n`).sort());
});
