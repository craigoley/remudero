import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/lib/config.js";
import { baseReproductionFiles } from "../src/lib/base-reproduction.js";
import { buildBaseReproductionProbe } from "../src/run-task.js";
import type { OpenPrView } from "../src/lib/sweep.js";

const MAIN = "b".repeat(40);
const NEXT = "c".repeat(40);
const FILE = "test/example.test.ts";
const HELPERS = ["test/helpers/wall-clock-bound.ts", "test/helpers/delegation-profile-fixture.ts"];
const PR = { prNumber: 6354, headSha: "a".repeat(40) } as OpenPrView;
type ProbeDeps = NonNullable<Parameters<typeof buildBaseReproductionProbe>[4]>;

function harness(t: TestContext, overrides: ProbeDeps = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-base-test-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reads: string[] = [];
  const executions: string[] = [];
  const checkouts: string[][] = [];
  const deps: ProbeDeps = {
    readLedger: () => [],
    git: async (args) => { checkouts.push(args); },
    link: () => "linked",
    readFile: async (path) => { reads.push(path); return "contents"; },
    execute: async (proof) => { executions.push(proof.label); return "pass"; },
    timeout: () => 60_000,
    ...overrides,
  };
  const build = () => buildBaseReproductionProbe({ root } as Config, join(root, "repo"), "unused", () => {}, deps);
  return { build, reads, executions, checkouts };
}

test("W1-T6354: helper files are never probed as tests", async (t) => {
  const h = harness(t);
  const candidates = baseReproductionFiles([{ name: "ci", logTail:
    `/checkout/${FILE}:10:1\nfile:///checkout/${HELPERS[0]}:20:2\n${HELPERS[1]}:30:3` }]);
  assert.deepEqual(candidates, [FILE, ...HELPERS]);
  const results = await h.build()(PR, candidates, MAIN);
  assert.deepEqual(results.map(({ file, outcome }) => ({ file, outcome })), [{ file: FILE, outcome: "passes" }]);
  assert.deepEqual(h.executions, [FILE]);
  assert.equal(h.reads.length, 2);
  assert.ok(h.reads[1].endsWith(FILE));

  const helperOnly = harness(t);
  assert.deepEqual(await helperOnly.build()(PR, [...HELPERS, "test/legacy.test.js"], MAIN), []);
  assert.deepEqual(helperOnly.checkouts, []);
  assert.deepEqual(helperOnly.reads, []);
  assert.deepEqual(helperOnly.executions, []);
});

test("W1-T6354: a base sha is probed once per file", async (t) => {
  const h = harness(t);
  const candidates = [FILE, ...HELPERS, FILE];
  const first = await h.build()(PR, candidates, MAIN);
  assert.deepEqual(first.map(({ file, cached }) => ({ file, cached })), [{ file: FILE, cached: false }]);
  const second = await h.build()({ ...PR, prNumber: 6355, headSha: "d".repeat(40) }, candidates, MAIN);
  assert.deepEqual(second.map(({ file, outcome, cached }) => ({ file, outcome, cached })),
    [{ file: FILE, outcome: "passes", cached: true }]);
  assert.deepEqual(h.executions, [FILE]);
  assert.equal(h.checkouts.length, 2);

  const moved = await h.build()(PR, candidates, NEXT);
  assert.deepEqual(moved.map(({ file, cached }) => ({ file, cached })), [{ file: FILE, cached: false }]);
  assert.deepEqual(h.executions, [FILE, FILE]);
  const added = await h.build()(PR, [FILE, "test/other.test.ts"], NEXT);
  assert.deepEqual(added.map(({ file, cached }) => ({ file, cached })),
    [{ file: FILE, cached: true }, { file: "test/other.test.ts", cached: false }]);
  assert.deepEqual(h.executions, [FILE, FILE, "test/other.test.ts"]);

  const restarted = harness(t, { readLedger: () => [{ step: "sweep.base_reproduction", main_sha: MAIN, files: first }] });
  const persisted = await restarted.build()(PR, candidates, MAIN);
  assert.deepEqual(persisted.map(({ file, outcome, cached }) => ({ file, outcome, cached })),
    [{ file: FILE, outcome: "passes", cached: true }]);
  assert.deepEqual(restarted.checkouts, []);
  assert.deepEqual(restarted.executions, []);
});

test("W1-T6354: missing and unreadable test files retain their outcomes", async (t) => {
  const h = harness(t, { readFile: async (path) => {
    if (path.endsWith("package.json")) return "{}";
    throw Object.assign(new Error("cannot read test"), { code: path.endsWith("missing.test.ts") ? "ENOENT" : "EACCES" });
  } });
  const candidates = [...HELPERS, "test/missing.test.ts", "test/unreadable.test.ts"];
  const first = await h.build()(PR, candidates, MAIN);
  assert.deepEqual(first.map(({ file, outcome }) => ({ file, outcome })),
    [{ file: "test/missing.test.ts", outcome: "absent" }, { file: "test/unreadable.test.ts", outcome: "unrunnable" }]);
  assert.match(first[1].reason!, /cannot read test/);
  const second = await h.build()(PR, candidates, MAIN);
  assert.ok(second.every(({ cached }) => cached));
  assert.deepEqual(second.map(({ outcome, reason }) => ({ outcome, reason })),
    first.map(({ outcome, reason }) => ({ outcome, reason })));
  assert.deepEqual(h.executions, []);
  assert.equal(h.checkouts.length, 2);
});
