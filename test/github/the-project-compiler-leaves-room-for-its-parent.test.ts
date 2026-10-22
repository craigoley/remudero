import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compilerEnvironment, goMemoryBytes } from "#src/lib/compiler-budget.js";
import { typecheckStep } from "#src/lib/commit-message.js";
// @ts-ignore the shipped executable is exercised with actual default compiler children.
import { main as compile } from "#scripts/compile-project.mjs";

const GiB = 1024 ** 3;

test("the compiler leaves a quarter of an actual memory constraint and caps Go CPU work", () => {
  const parent = { PATH: "unchanged", GOMEMLIMIT: "off", GOMAXPROCS: "8" };
  assert.deepEqual(compilerEnvironment(parent, 4 * GiB, 8), { GOMEMLIMIT: `${3 * GiB}B`, GOMAXPROCS: "2" });
  assert.deepEqual(parent, { PATH: "unchanged", GOMEMLIMIT: "off", GOMAXPROCS: "8" });
  assert.deepEqual(compilerEnvironment({ GOMEMLIMIT: "1GiB", GOMAXPROCS: "1" }, 4 * GiB, 8), { GOMAXPROCS: "1" });
  assert.deepEqual(compilerEnvironment({ GOMEMLIMIT: "0" }, 4 * GiB, 1), { GOMAXPROCS: "1" });
});

test("unknown memory is not an invented compiler limit and invalid settings are not repaired", () => {
  assert.deepEqual(compilerEnvironment({}, 0, 8), { GOMAXPROCS: "2" });
  assert.deepEqual(compilerEnvironment({ GOMEMLIMIT: "operator-invalid" }, 0, 8), { GOMAXPROCS: "2" });
  for (const value of [NaN, Infinity, -1, 1.5]) assert.throws(() => compilerEnvironment({}, value, 2));
  for (const value of [0, NaN, -1, 1.5]) assert.throws(() => compilerEnvironment({}, 4 * GiB, value));
  assert.throws(() => compilerEnvironment({ GOMEMLIMIT: "broken" }, 4 * GiB, 8), /invalid inherited GOMEMLIMIT/);
  assert.throws(() => compilerEnvironment({ GOMAXPROCS: "broken" }, 4 * GiB, 8), /invalid inherited GOMAXPROCS/);
  assert.throws(() => compilerEnvironment({}, 1, 2), /too small/);
  assert.deepEqual(compilerEnvironment({ GOMAXPROCS: "0", GOMEMLIMIT: "" }, 4 * GiB, 8),
    { GOMAXPROCS: "2", GOMEMLIMIT: `${3 * GiB}B` });
});

test("the Go byte parser accepts documented units and refuses overflow or ambiguous text", () => {
  for (const [raw, expected] of [["0", 0n], ["17B", 17n], ["1KiB", 1024n], ["2MiB", 2n * 1024n ** 2n],
    ["3GiB", 3n * 1024n ** 3n], ["1TiB", 1024n ** 4n], ["off", null]] as const)
    assert.equal(goMemoryBytes(raw), expected);
  for (const value of ["", " 1GiB", "1GB", "1.5GiB", "-1", "9223372036854775808B"])
    assert.throws(() => goMemoryBytes(value));
});

function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rmd-compiler-environment-"));
  try {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    const compiler = join(root, "node_modules", ".bin", "tsc");
    writeFileSync(compiler, `#!${process.execPath}\nrequire('node:fs').writeFileSync('actual-child.json', JSON.stringify({args:process.argv.slice(2),memory:process.env.GOMEMLIMIT,cpu:process.env.GOMAXPROCS}));\n`);
    chmodSync(compiler, 0o755);
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("the real default compiler child receives the bound without omitting project files", () => {
  const memory = process.constrainedMemory, oldMemory = process.env.GOMEMLIMIT, oldCpu = process.env.GOMAXPROCS;
  process.constrainedMemory = () => 4 * GiB;
  process.env.GOMEMLIMIT = "off"; process.env.GOMAXPROCS = "8";
  try {
    fixture((root) => {
      const outcome = typecheckStep(root, undefined, { memoryHeadroom: () => undefined });
      assert.equal(outcome.ok, true, outcome.detail);
      const actual = JSON.parse(readFileSync(join(root, "actual-child.json"), "utf8"));
      assert.deepEqual(actual.args, ["-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile",
        join(root, ".rmd-typecheck.tsbuildinfo")]);
      assert.equal(actual.memory, `${3 * GiB}B`);
      assert.ok(Number(actual.cpu) >= 1 && Number(actual.cpu) <= 2);
      for (const mode of ["build", "typecheck"]) {
        assert.equal(compile([mode], root), 0);
        const invoked = JSON.parse(readFileSync(join(root, "actual-child.json"), "utf8"));
        if (mode === "build") {
          assert.deepEqual(invoked.args, ["-p", "tsconfig.json", "--checkers", "1"]);
        } else {
          assert.deepEqual(invoked.args.slice(0, 6), ["-p", "tsconfig.json", "--noEmit", "--incremental",
            "--tsBuildInfoFile", join(root, ".rmd-typecheck.tsbuildinfo")]);
          assert.ok(["[]", '["--checkers","2"]', '["--checkers","3"]'].includes(JSON.stringify(invoked.args.slice(6))),
            "the actual child preserves the accepted headroom policy without an arbitrary override");
        }
        assert.equal(invoked.memory, `${3 * GiB}B`);
        assert.ok(Number(invoked.cpu) >= 1 && Number(invoked.cpu) <= 2);
      }
      process.env.GOMEMLIMIT = "broken";
      assert.equal(typecheckStep(root).ok, false);
      assert.equal(compile(["typecheck"], root), 1);
    });
  } finally {
    process.constrainedMemory = memory;
    if (oldMemory === undefined) delete process.env.GOMEMLIMIT; else process.env.GOMEMLIMIT = oldMemory;
    if (oldCpu === undefined) delete process.env.GOMAXPROCS; else process.env.GOMAXPROCS = oldCpu;
  }
});

test("compiler runner retains nonzero, missing, signaled and thrown native failures", () => {
  assert.equal(compile(["typecheck", "--checkers", "8"]), 2);
  for (const result of [{ status: 7 }, { status: null }, { status: undefined }, { status: 0, signal: "SIGKILL" },
    { status: 0, error: new Error("launch failed") }]) assert.notEqual(compile(["typecheck"], "/absent", () => result), 0);
  assert.equal(compile(["typecheck"], "/absent", () => { throw new Error("real seam threw"); }), 1);
  fixture((root) => {
    rmSync(join(root, "node_modules", ".bin", "tsc"));
    assert.equal(compile(["typecheck"], root), 127, "the shared typecheck wrapper names a compiler that could not start");
    assert.equal(compile(["build"], root), 1, "the build compatibility entry retains its failure contract");
  });
});
