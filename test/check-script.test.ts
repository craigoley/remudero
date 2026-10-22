/**
 * test/check-script.test.ts — impl-GC.
 *
 * `scripts/check.mjs` bundles a scoped test run and `tsc --noEmit` into ONE invocation, so a
 * session cannot run the typecheck before writing its last file and get a stale all-clear.
 *
 * Empty, separator-only, missing and directory targets must refuse before either child starts.
 * The real happy path uses a tiny isolated project, so this control never selects the repository's
 * whole suite or whole-project typecheck. A literal dash-prefixed filename reaches the real Node
 * child, and missing binaries exercise both default spawn error arms.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check.mjs");

test("check refuses with no target rather than defaulting to the whole suite", () => {
  const r = spawnSync("node", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });

  assert.equal(r.status, 2, "a distinct exit code, not 0 and not the 1 a real failure uses");
  assert.match(r.stderr, /no test target given/);
  assert.match(r.stderr, /npm run check -- test\/<file>\.test\.ts/, "and it says how to invoke it");
  assert.match(
    r.stderr,
    /walks the whole tree/,
    "naming WHY it refuses — a default-to-everything regression is the dangerous one",
  );
  assert.equal(r.stdout.trim(), "", "it runs nothing at all before refusing");
});

test("the refusal is the only zero-target behaviour — no argv shape slips past it", () => {
  for (const argv of [[], [""], ["--"], ["--", ""], ["", "--"], ["--", "--"]]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
      cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" },
    });
    assert.equal(r.status, 2, `argv ${JSON.stringify(argv)} must refuse`);
    assert.match(r.stderr, /no test target given/);
    assert.equal(r.stdout.trim(), "", "neither the tests nor typecheck may start");
  }
});

test("check refuses missing, directory and option-only targets before either child starts", () => {
  for (const argv of [["test/ghost-check-target.test.ts"], ["test"], ["--test-name-pattern", "only-this"]]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
      cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" },
    });
    assert.equal(r.status, 2, `unverified targets ${JSON.stringify(argv)} must refuse`);
    assert.match(r.stderr, /every target must name an existing test file/);
    assert.equal(r.stdout.trim(), "", "no child is attempted before the entire file list is verified");
  }
});

test("check with a separator and a real file runs its scoped test and typecheck in an isolated tiny project", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-check-target-"));
  try {
    mkdirSync(join(root, "test", "setup"), { recursive: true });
    // The executable witness lives in this fixture, never in the immutable dependency donor.
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    for (const dependency of ["tsx", "typescript"])
      symlinkSync(join(REPO_ROOT, "node_modules", dependency), join(root, "node_modules", dependency), "dir");
    writeFileSync(join(root, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
    writeFileSync(join(root, "-probe.test.mjs"), "import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; test('the real scoped child runs', () => { writeFileSync('executed', 'one real child'); });\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      allowJs: true, skipLibCheck: true, types: [],
    }, files: ["-probe.test.mjs"] }));
    const compiler = join(root, "node_modules", ".bin", "tsc");
    writeFileSync(compiler, `#!${process.execPath}\nconst fs = require('node:fs'); const { spawnSync } = require('node:child_process'); fs.writeFileSync('compiler-argv.json', JSON.stringify(process.argv.slice(2))); fs.writeFileSync('compiler-admission.json', JSON.stringify({ slotDir: process.env.RMD_TEST_SLOT_DIR, hasParentClaim: typeof process.env.RMD_TEST_SLOT_PARENT === 'string', privateLeaseHeld: fs.readdirSync(process.env.RMD_TEST_SLOT_DIR).some(name => name.startsWith('slot-') && name.endsWith('.json')) })); const r = spawnSync(${JSON.stringify(join(REPO_ROOT, "node_modules", ".bin", "tsc"))}, process.argv.slice(2), { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`);
    chmodSync(compiler, 0o755);
    const r = spawnSync(process.execPath, [SCRIPT, "--", "-probe.test.mjs"], {
      cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined,
        RMD_TEST_SLOT_DIR: join(root, "fixture-slots"), RMD_TEST_SLOT_PARENT: undefined },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /the real scoped child runs/);
    assert.equal(readFileSync(join(root, "executed"), "utf8"), "one real child");
    assert.match(r.stdout, /scoped tests\s*: PASS/);
    assert.match(r.stdout, /typecheck\s*: PASS/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "compiler-admission.json"), "utf8")), {
      slotDir: join(root, "fixture-slots"), hasParentClaim: false, privateLeaseHeld: true,
    }, "the real compiler child holds its private fixture lease without the author authority");
    const compilerArgs = JSON.parse(readFileSync(join(root, "compiler-argv.json"), "utf8"));
    assert.deepEqual(compilerArgs.slice(0, 6), [
      "-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", join(root, ".rmd-typecheck.tsbuildinfo"),
    ]);
    assert.ok(["[]", '["--checkers","2"]', '["--checkers","3"]'].includes(JSON.stringify(compilerArgs.slice(6))),
      "the real child retains the accepted headroom policy and cannot use an arbitrary checker override");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid compiler resource settings retain scoped results and a failed typecheck summary", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-check-budget-"));
  try {
    mkdirSync(join(root, "test", "setup"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
    writeFileSync(join(root, "probe.test.mjs"), "import { test } from 'node:test'; test('the actual scoped child completes', () => {});\n");
    const context = join(root, "compiler-context.mjs");
    writeFileSync(context, "process.constrainedMemory = () => 4294967296; process.env.GOMAXPROCS = 'broken'; delete process.env.GOMEMLIMIT;\n");
    const result = spawnSync(process.execPath, ["--import", context, SCRIPT, "probe.test.mjs"], {
      cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined,
        RMD_TEST_SLOT_DIR: join(root, "fixture-slots"), RMD_TEST_SLOT_PARENT: undefined },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /scoped tests\s*: PASS/);
    assert.match(result.stdout, /typecheck\s*: FAIL/);
    assert.match(result.stderr, /invalid inherited GOMAXPROCS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing binary is NAMED, not reported as an ordinary failure", () => {
  // The `r.error` arm. Unreachable while node and npx exist, so it is driven by handing the child
  // a PATH with nothing on it — the same "cover the catch arm for real" discipline this repo
  // applies elsewhere. `process.execPath` launches the script itself, since a name-based `node`
  // would not resolve either.
  const r = spawnSync(process.execPath, [SCRIPT, "test/check-script.test.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: "/nonexistent" },
  });

  assert.equal(r.status, 1, "still exits non-zero overall");
  const named = r.stderr.split("\n").filter((l) => l.includes("could not run"));
  assert.equal(named.length, 2, `both commands name themselves; got ${JSON.stringify(named)}`);
  assert.match(named.join("\n"), /ENOENT/, "carrying the real cause, not a bare exit code");
  assert.match(r.stdout, /scoped tests\s*: FAIL \(exit 127\)/, "127 distinguishes 'could not run' from 'ran and failed'");
  assert.match(r.stdout, /typecheck\s*: FAIL \(exit 127\)/);
});
