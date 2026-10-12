import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkProofCommand, CHECK_PROOF_EXIT } from "../src/run-task.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NEEDLE = "dirty_proof_marker_W1_T5808";
type Deps = NonNullable<Parameters<typeof checkProofCommand>[1]>;

function run(cwd: string, proof: string[], deps?: Deps) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const original = { cwd: process.cwd(), log: console.log, error: console.error };
  console.log = (...args: unknown[]) => void stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void stderr.push(args.map(String).join(" "));
  try {
    process.chdir(cwd);
    return { code: checkProofCommand(proof, deps), stdout: stdout.join("\n"), stderr };
  } finally {
    process.chdir(original.cwd);
    console.log = original.log;
    console.error = original.error;
  }
}

function fixture(body: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proof-dirty-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/marker.txt"), `${NEEDLE}\n`);
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const proof = ["grep:", NEEDLE, "in", "src/marker.txt"];

test("check-proof warns for modified, staged and untracked targets while preserving pass and no-match", () => {
  fixture((dir) => {
    for (const status of [" M src/marker.txt\0", "M  src/marker.txt\0", "?? src/marker.txt\0"]) {
      for (const needle of [NEEDLE, "missing_marker_W1_T5808"]) {
        const argv = ["grep:", needle, "in", "src/marker.txt"];
        const clean = run(dir, argv, { pathStatus: () => "" });
        const calls: string[][] = [];
        const dirty = run(dir, argv, { pathStatus: (cwd, path) => {
          calls.push([cwd, path]);
          return status;
        } });
        assert.deepEqual(calls, [[dir, "src/marker.txt"]]);
        assert.equal(dirty.code, clean.code);
        assert.equal(dirty.stdout, clean.stdout);
        assert.equal(dirty.stderr.length, 1);
        assert.match(dirty.stderr[0], /src\/marker\.txt.*pushed head may answer differently/);
      }
    }
  });
});

test("check-proof prints no warning for a clean target or a throwing status seam", () => {
  fixture((dir) => {
    const clean = run(dir, proof, { pathStatus: () => "" });
    const unreadable = run(dir, proof, { pathStatus: () => { throw new Error("git unavailable"); } });
    assert.equal(clean.code, CHECK_PROOF_EXIT.pass);
    assert.deepEqual(clean.stderr, []);
    assert.deepEqual(unreadable, clean);
  });
});

test("check-proof uses real git status for an untracked proof target and a clean tracked target", () => {
  const dir = mkdtempSync(join(ROOT, "test/proof-status-"));
  try {
    const path = relative(ROOT, join(dir, "marker.txt"));
    writeFileSync(join(ROOT, path), `${NEEDLE}\n`);
    const dirty = run(ROOT, ["grep:", NEEDLE, "in", path]);
    assert.equal(dirty.code, CHECK_PROOF_EXIT.pass);
    assert.equal(dirty.stderr.length, 1);
    assert.ok(dirty.stderr[0].includes(path));
    const nested = run(dir, ["grep:", NEEDLE, "in", "marker.txt"]);
    assert.equal(nested.code, CHECK_PROOF_EXIT.pass);
    assert.equal(nested.stderr.length, 1);
    assert.match(nested.stderr[0], /marker\.txt.*pushed head may answer differently/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const clean = run(ROOT, ["grep:", "remudero", "in", "package.json"]);
  assert.equal(clean.code, CHECK_PROOF_EXIT.pass);
  assert.deepEqual(clean.stderr, []);
});

test("check-proof preserves its verdict when real git status cannot read a repository", () => {
  fixture((dir) => {
    const result = run(dir, proof);
    assert.equal(result.code, CHECK_PROOF_EXIT.pass);
    assert.deepEqual(result.stderr, []);
    writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "missing-gitdir")}\n`);
    assert.deepEqual(run(dir, proof), result);
  });
});

test("check-proof warns before the working-tree run even with --base", () => {
  fixture((dir) => {
    const result = run(dir, ["--base", "fixture-base", ...proof], {
      pathStatus: () => " M src/marker.txt\0",
      baseBlobDeps: {
        addWorktree: () => { throw new Error("use fixture blobs"); },
        showBlob: () => "base has no marker\n",
      },
    });
    assert.equal(result.code, CHECK_PROOF_EXIT.pass);
    assert.equal(result.stderr.length, 1);
    assert.match(result.stdout, /discrimination:\s+discriminates/);
  });
});

test("check-proof warns once per resolved unit-test file and ignores runner imports", () => {
  fixture((dir) => {
    mkdirSync(join(dir, "test/setup"), { recursive: true });
    symlinkSync(dirname(dirname(fileURLToPath(import.meta.resolve("tsx/package.json")))), join(dir, "node_modules"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(join(dir, "test/setup/tmp-hygiene.ts"), "export {};\n");
    for (const path of ["test/one.test.ts", "test/two.test.ts"]) {
      writeFileSync(join(dir, path), 'import { test } from "node:test";\ntest("dirty unit proof marker", () => {});\n');
    }
    for (const target of ["test/one.test.ts", "dirty unit proof marker"]) {
      const paths: string[] = [];
      const result = run(dir, ["unit test:", target], { pathStatus: (_cwd, path) => {
        paths.push(path);
        return ` M ${path}\0`;
      } });
      assert.equal(result.code, CHECK_PROOF_EXIT.pass, result.stdout);
      const expected = target.startsWith("test/") ? [target] : ["test/one.test.ts", "test/two.test.ts"];
      assert.deepEqual(paths.sort(), expected);
      assert.equal(result.stderr.length, expected.length);
      for (const path of expected) assert.ok(result.stderr.some((line) => line.includes(path)));
    }
  });
});
