import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const subject = "#scripts/preflight-author.mjs";
const { main } = await import(subject);

function fixture(t: TestContext, source: string, treeStatus = 0) {
  const root = mkdtempSync(join(tmpdir(), "rmd-author-coverage-blanking-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, ".nvmrc"), process.versions.node);
  const path = "test/child.test.ts";
  writeFileSync(join(root, path), source);
  // These unchanged and deleted paths must not turn a changed-file precheck into a corpus scan.
  writeFileSync(join(root, "test/unchanged.test.ts"), "delete env.NODE_V8_COVERAGE;");
  const changed = [path, "test/deleted.test.ts", "src/leaf.ts"];
  const calls: string[][] = [];
  const spawn = ((file: string, args: string[]) => {
    assert.equal(file, "git", "no validation child may start in this fixture");
    calls.push(args);
    const result = (stdout = "", status = 0) => ({ status, stdout, stderr: "" });
    if (args[0] === "config") return result("", 1);
    if (args[0] === "status" || args[0] === "fetch") return result();
    if (args[0] === "diff") return result(changed.join("\0") + "\0");
    if (args[0] === "ls-tree") return result(args.at(-1) === "test/deleted.test.ts" ? "" : path + "\0", treeStatus);
    if (args[0] === "rev-parse") {
      if (args[1] === "--is-inside-work-tree") return result("true");
      if (args[1] === "--is-shallow-repository") return result("false");
      return result((args[1] === "HEAD" ? "a" : "b").repeat(40));
    }
    assert.fail(`unexpected command: ${args.join(" ")}`);
  }) as unknown as typeof spawnSync;
  let selections = 0;
  const run = (argv: string[] = []) => main(argv, { root, spawn, select: () => {
    selections++;
    return { fullRun: false, suites: [path], reasons: ["coverage blanking fixture"] };
  }, admitHost: () => assert.fail("no heavy admission may start") });
  const receipt = () => JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8"));
  return { root, path, run, receipt, calls, selections: () => selections };
}

test("W1-T10411: check:test:test/coverage-session-blanking.test.ts:flaky is prevented, not retried", t => {
  for (const [source, kind] of [
    ["const env = { ...process.env };\ndelete env.NODE_V8_COVERAGE;", "defects"],
    ["const env = { ...process.env };\ndelete env.NODE_TEST_CONTEXT;", "suspects"],
  ] as const) {
    const f = fixture(t, source);
    assert.equal(f.run(), 1);
    const r = f.receipt();
    assert.equal(r.verdict, "refused");
    assert.equal(r.coverageBlankingPrecheck.filesScanned, 1);
    assert.deepEqual(r.coverageBlankingPrecheck[kind], [
      { file: f.path, line: 2, ...(kind === "defects" ? { expr: "env" } : { ident: "env" }) },
    ]);
    assert.match(r.affectedTestsNotRunReason, /blanking refused before selection/);
    assert.equal(f.selections(), 0);
    assert.deepEqual(r.steps, []);
    assert.equal(r.dependencyProvenance, undefined);
    assert.equal(r.testSlot, undefined);
    assert.equal(f.calls.filter(args => args[0] === "diff").length, 1, "no retry");
    assert.equal(readFileSync(join(f.root, f.path), "utf8"), source, "diagnosis preserves callers");
  }
});

test("author blanking precheck admits both blanking forms and ignores deleted and unchanged tests", t => {
  for (const value of ["undefined", '""']) {
    for (const source of [
      `const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; env.NODE_V8_COVERAGE = ${value};`,
      `const env = { ...process.env, NODE_V8_COVERAGE: ${value} }; delete env.NODE_TEST_CONTEXT;`,
    ]) {
      const f = fixture(t, source);
      assert.equal(f.run(["--dry-run"]), 0);
      const r = f.receipt();
      assert.equal(r.verdict, "not-run");
      assert.deepEqual(r.coverageBlankingPrecheck, { defects: [], suspects: [], filesScanned: 1 });
      assert.equal(f.selections(), 1);
      assert.deepEqual(r.steps, []);
    }
  }
});

test("author blanking precheck refuses unreadable changed tests before selection", t => {
  const f = fixture(t, "");
  rmSync(join(f.root, f.path));
  mkdirSync(join(f.root, f.path));
  assert.equal(f.run(), 1);
  assert.match(f.receipt().error, /EISDIR/);
  assert.equal(f.selections(), 0);
});

test("author blanking precheck refuses missing committed tests before selection", t => {
  const f = fixture(t, "");
  rmSync(join(f.root, f.path));
  assert.equal(f.run(["--dry-run"]), 1);
  const r = f.receipt();
  assert.match(r.error, /ENOENT/);
  assert.equal(r.coverageBlankingPrecheck, undefined, "missing evidence cannot certify a clean scan");
  assert.equal(f.selections(), 0);
  assert.deepEqual(r.steps, []);
});

test("author blanking precheck refuses unavailable deletion evidence before selection", t => {
  const f = fixture(t, "", 128);
  assert.equal(f.run(["--dry-run"]), 1);
  const r = f.receipt();
  assert.match(r.error, /git ls-tree .* failed/);
  assert.equal(r.coverageBlankingPrecheck, undefined, "failed evidence cannot certify a clean scan");
  assert.equal(f.selections(), 0);
  assert.deepEqual(r.steps, []);
});

test("author blanking precheck preserves changed-test metadata errors before selection", t => {
  const f = fixture(t, "");
  rmSync(join(f.root, "test"), { recursive: true });
  writeFileSync(join(f.root, "test"), "not a directory");
  assert.equal(f.run(["--dry-run"]), 1);
  const r = f.receipt();
  assert.match(r.error, /ENOTDIR/);
  assert.equal(r.coverageBlankingPrecheck, undefined);
  assert.equal(f.selections(), 0);
  assert.deepEqual(r.steps, []);
});
