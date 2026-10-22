import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { typecheckStep } from "#src/lib/commit-message.js";

const repoRoot = __workspaceRoot;
const compiler = join(repoRoot, "node_modules", ".bin", "tsc");

function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rmd-native-typecheck-"));
  try {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the real preflight child bounds native checker fanout and retains the full project", () => {
  fixture((root) => {
    const tool = join(root, "node_modules", ".bin", "tsc");
    writeFileSync(tool, `#!${process.execPath}\nrequire('node:fs').writeFileSync('compiler-argv.json', JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(tool, 0o755);
    let reads = 0;
    const result = typecheckStep(root, undefined, { memoryHeadroom: () => { reads++; return 512 * 1024 ** 2; } });
    assert.ok(reads > 0, "the actual child uses the controlled tight memory reading");
    assert.equal(result.ok, true, result.detail);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "compiler-argv.json"), "utf8")), [
      "-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile",
      join(root, ".rmd-typecheck.tsbuildinfo"), "--checkers", "2",
    ]);
    assert.match(result.detail, /--checkers 2$/);
  });
});

test("shipped typecheck entrypoints retain full-project checks and the accepted headroom checker policy", () => {
  const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;
  assert.equal(scripts.build, "node --import tsx scripts/compile-project.mjs build");
  assert.equal(scripts.typecheck, "node --import tsx scripts/typecheck.mjs");
  const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /^          npm run typecheck$/m);
  const check = readFileSync(join(repoRoot, "scripts", "check.mjs"), "utf8");
  assert.match(check, /tscCode = run\([^\n]+"node", \["--import", "tsx", typecheckScript\], compilerEnvironment\(\)\);/);
  const build = readFileSync(join(repoRoot, "scripts", "compile-project.mjs"), "utf8");
  assert.match(build, /const args = \['-p', 'tsconfig\.json', '--checkers', '1'\];/);
  assert.match(build, /return runTypecheck\(root, \[\],/);
});

test("the real native compiler retains cross-file diagnostics under the accepted tight checker policy", () => {
  fixture((root) => {
    symlinkSync(compiler, join(root, "node_modules", ".bin", "tsc"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "nodenext", strict: true, types: [] },
      include: ["a.ts", "b.ts"],
    }));
    writeFileSync(join(root, "a.ts"), 'export const total: number = "invalid";\n');
    writeFileSync(join(root, "b.ts"), 'import { total } from ' + JSON.stringify("./a.js") + '; export const other: string = total;\n');
    const four = spawnSync(compiler, ["-p", "tsconfig.json", "--noEmit", "--checkers", "4"], {
      cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    assert.equal(four.error, undefined);
    assert.notEqual(four.status, null);
    assert.notEqual(four.status, 0);
    const one = typecheckStep(root, undefined, { memoryHeadroom: () => 512 * 1024 ** 2 });
    assert.equal(one.ok, false);
    const diagnostics = (output: string) => output.split("\n").filter((line) => /error TS\d+:/.test(line)).sort();
    const expected = diagnostics(four.stdout + four.stderr);
    assert.equal(expected.length, 2, four.stdout + four.stderr);
    assert.deepEqual(diagnostics(one.detail), expected);
    writeFileSync(join(root, "a.ts"), "export const total: number = 1;\n");
    writeFileSync(join(root, "b.ts"), 'import { total } from ' + JSON.stringify("./a.js") + '; export const other: number = total;\n');
    const valid = typecheckStep(root);
    assert.equal(valid.ok, true, valid.detail);
  });
});

test("a missing real compiler remains a spawn failure under the checker bound", () => {
  fixture((root) => {
    const result = typecheckStep(root);
    assert.equal(result.ok, false);
    assert.match(result.detail, /SPAWN FAILURE/);
    assert.match(result.detail, /ENOENT/);
  });
});


test("the real build child retains the accepted Go memory target and tighter explicit policy", () => {
  fixture((root) => {
    const tool = join(root, "node_modules", ".bin", "tsc");
    writeFileSync(tool, `#!${process.execPath}\nrequire('node:fs').writeFileSync('compiler-env.json', JSON.stringify({ memory: process.env.GOMEMLIMIT, cpus: process.env.GOMAXPROCS, path: process.env.PATH }));\n`);
    chmodSync(tool, 0o755);
    const env = { ...process.env };
    delete env.GOMEMLIMIT;
    const code = 'import { main } from "#scripts/compile-project.mjs"; process.exitCode = main(["build"], process.argv[1]);';
    for (const limit of [undefined, "2GiB"]) {
      if (limit !== undefined) env.GOMEMLIMIT = limit;
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, root], {
        cwd: repoRoot, env, encoding: "utf8", timeout: 20_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const seen = JSON.parse(readFileSync(join(root, "compiler-env.json"), "utf8"));
      assert.equal(seen.memory, limit ?? "3GiB");
      assert.ok(Number(seen.cpus) >= 1 && Number(seen.cpus) <= 2);
      assert.equal(seen.path, env.PATH);
    }
  });
});
