import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import {
  censusRunawayThresholdMs, FAST_GATE_CENSUS_REFERENCE_FLOOR_MS, FAST_GATE_CENSUS_REMEASURE_MARGIN, FAST_GATE_CENSUS_RUNAWAY_MULTIPLE,
} from "../src/lib/ci-parity.js";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore executable module has no declaration file.
import * as precheck from "../scripts/census-precheck.mjs";

// @source-text-subject: the read-call strings are inputs to census discovery in private fixtures.
// @census-reads: none — all source-text reads below belong to private fixture repositories.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUITE = "test/source-census.test.ts";
const SUBJECT = "src/subject.ts";
const ADMITTED = { testFile: "test/admitted.test.ts", script: "census:fixture", walks: ["other/"] };
const READER_POLICY = { floorMs: FAST_GATE_CENSUS_REFERENCE_FLOOR_MS, multiple: FAST_GATE_CENSUS_RUNAWAY_MULTIPLE,
  remeasureMargin: FAST_GATE_CENSUS_REMEASURE_MARGIN };
const CENSUS = [
  'import assert from "node:assert/strict";',
  'import { readFileSync } from "node:fs";',
  'import { test } from "node:test";',
  '// @census-reads: src/subject.ts',
  'test("the source declares its bound", () => {',
  '  assert.match(readFileSync("src/subject.ts", "utf8"), /declared/);',
  '});',
].join("\n");

function fixture(t: TestContext, readers = true, baseRed = false) {
  const repo = gitRepo({ kind: "source-census-precheck" });
  t.after(() => repo.cleanup());
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  put("package.json", '{"type":"module"}');
  put("src/lib/ci-parity.ts", [
    `export const CENSUS_ADMITTED_MEMBERS = [${JSON.stringify({ ...ADMITTED, verdict: { measuredMs: 1000 } })}];`,
    `export { censusRunawayThresholdMs, FAST_GATE_CENSUS_REFERENCE_FLOOR_MS, FAST_GATE_CENSUS_RUNAWAY_MULTIPLE } from ${JSON.stringify(join(ROOT, "src/lib/ci-parity.ts"))};`,
  ].join("\n"));
  if (readers) symlinkSync(join(ROOT, "src/lib/source-text-readers.ts"), join(repo.dir, "src/lib/source-text-readers.ts"));
  put(SUITE, CENSUS);
  put("test/other-census.test.ts", CENSUS);
  put("test/behaviour.test.ts", 'readFileSync("src/unrelated.ts", "utf8");');
  put(SUBJECT, baseRed ? "missing" : "declared");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base census");
  put(SUBJECT, "missing at head");
  return { ...repo, put };
}

function capture(t: { mock: { method: (o: object, k: string, f: (...a: unknown[]) => void) => unknown } }) {
  const err: string[] = [];
  const out: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void err.push(a.join(" ")));
  t.mock.method(console, "log", (...a: unknown[]) => void out.push(a.join(" ")));
  return { err, out };
}

function realChildren(options: { root: string; files: string[]; readerRuntimePolicy?: object }) {
  assert.deepEqual(options.readerRuntimePolicy, READER_POLICY);
  return precheck.runCensusSuitesViaChild(options);
}

test("W1-T9757: the precheck runs a source-text census the diff joins", (t) => {
  const repo = fixture(t);
  const io = capture(t);
  const members = precheck.listAdmittedCensusMembers(repo.dir);
  assert.deepEqual(members.map((m: { testFile: string }) => m.testFile).sort(), [ADMITTED.testFile, SUITE, "test/other-census.test.ts"].sort());
  assert.equal(precheck.main(["--root", repo.dir, "--base", "main"], { runSuites: realChildren }), 1, io.err.join("\n"));
  assert.ok(io.err.some((line) => line.includes(`census-suite: ${SUITE} fails — run node --test --import tsx ${SUITE}`)), io.err.join("\n"));
  assert.ok(!io.out.some((line) => line.includes("census-precheck: OK")));
  repo.put(SUBJECT, "declared at head");
  assert.equal(precheck.main(["--root", repo.dir, "--base", "main"], { runSuites: realChildren }), 0, io.err.join("\n"));
  const redBase = fixture(t, true, true);
  assert.equal(precheck.main(["--root", redBase.dir, "--base", "main"], { runSuites: realChildren }), 0,
    `a census already red at base does not refuse: ${io.err.join("\n")}`);
  assert.deepEqual(precheck.PRECHECK_PARITY["test/the-census-precheck-runs-the-source-text-censuses-a-diff-joins.test.ts"], { modeled: precheck.evaluateAdmittedCensusSuites });
});

test("W1-T9757: a tree without the reader module adds no suite", (t) => {
  const repo = fixture(t, false);
  const io = capture(t);
  assert.deepEqual(precheck.listAdmittedCensusMembers(repo.dir), [ADMITTED]);
  assert.equal(precheck.main(["--root", repo.dir, "--base", "main"]), 0, io.err.join("\n"));
  assert.ok(io.out.some((line) => line.includes("census-precheck: OK")));
});

test("W1-T9757: joined readers run separately with a measured bound and name an unfinished reader", (t) => {
  const repo = fixture(t);
  const members = precheck.listAdmittedCensusMembers(repo.dir);
  const runs: string[][] = [];
  const result = precheck.evaluateAdmittedCensusSuites({
    changed: [SUBJECT],
    loadMembers: () => members,
    runSuites: (files: string[], options: { readerRuntimePolicy: object }) => {
      runs.push(files);
      assert.deepEqual(options.readerRuntimePolicy, READER_POLICY);
      if (files.includes(SUITE)) throw new Error("ETIMEDOUT");
      return files;
    },
  });
  assert.deepEqual(runs, [["test/other-census.test.ts"], [SUITE]]);
  assert.match(result.unmeasured, /test\/source-census.test.ts.*ETIMEDOUT/);
  assert.match(result.violations[0], /test\/other-census.test.ts fails/);
  const io = capture(t);
  assert.equal(precheck.main(["--root", repo.dir, "--base", "main"], {
    runSuites: ({ files, readerRuntimePolicy }: { files: string[]; readerRuntimePolicy: object }) => {
      assert.deepEqual(readerRuntimePolicy, READER_POLICY);
      assert.equal(files.length, 1);
      throw new Error("ETIMEDOUT");
    },
  }), 2);
  assert.ok(io.err.some((line) => /NOT MEASURED.*test\/source-census.test.ts.*ETIMEDOUT/.test(line)), io.err.join("\n"));
  assert.ok(!io.out.some((line) => line.includes("census-precheck: OK")));
});

test("W1-T9757: an explicit trigger cannot group a discovered reader with other suites", () => {
  const suite = "test/env-var-registry.test.ts";
  const timeoutMs = censusRunawayThresholdMs([1000])!;
  const runs: { files: string[]; timeoutMs?: number }[] = [];
  const result = precheck.evaluateAdmittedCensusSuites({
    changed: ["src/lib/config-schema.ts"],
    loadMembers: () => [
      { testFile: suite, script: "", walks: ["src/"], structural: true, timeoutMs },
      { ...ADMITTED, walks: ["src/"] },
    ],
    runSuites: (files: string[], options: { timeoutMs?: number } = {}) => {
      runs.push({ files, ...options });
      return files.includes(suite) ? [suite] : [];
    },
  });
  assert.deepEqual(runs, [{ files: [ADMITTED.testFile] }, { files: [suite], timeoutMs }]);
  assert.deepEqual(result, { violations: [
    `census-suite: ${suite} fails — run npm run census:env-var-registry; register ENV_REGISTRY in src/lib/config-schema.ts`,
  ], unmeasured: null });
});

test("W1-T9757: the reader child uses its measured timeout and a broken reader module is not an empty discovery", (t) => {
  const repo = fixture(t, false);
  repo.put("src/lib/source-text-readers.ts", 'throw new Error("broken reader discovery");');
  assert.throws(() => precheck.listAdmittedCensusMembers(repo.dir), /broken reader discovery/);
  const timeoutMs = censusRunawayThresholdMs([1000])!;
  assert.throws(() => precheck.runCensusSuitesViaChild({
    root: repo.dir,
    files: [SUITE],
    timeoutMs,
    run: (_file: string, _args: string[], options: { timeout: number }) => {
      assert.equal(options.timeout, timeoutMs);
      return { error: new Error("ETIMEDOUT") };
    },
  }), /ETIMEDOUT/);
});
