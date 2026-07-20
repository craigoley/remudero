import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// -- W1-T98: TS-strict proven ACTIVE by a planted probe (MASTER-PLAN §5 TIER 2, quality gate 4/4) --
//
// "0 violations" from a fresh strict gate reads identically whether strict is genuinely wired or
// silently inert (the neon-drift `_probe(x)` lesson) -- so the doctrine requires a committed
// probe that MUST fail under strict and MUST pass with it off, never a live paste. This test
// drives the real `tsc` binary (node_modules/typescript/bin/tsc -- the file its own package.json
// `bin` field points at) as a subprocess against scripts/strict-probe.ts, so the assertion is on
// the actual exit code a CI job would see.
//
// scripts/strict-probe.ts is compiled directly (`--ignoreConfig`, bypassing this repo's own
// tsconfig.json) so the ON/OFF comparison isolates exactly the `--strict` flag, not any other
// project setting. `--ignoreConfig` is required here for an unrelated reason too: this
// TypeScript release (7.0.2) hard-errors (TS5112) if a file is named on the command line while a
// tsconfig.json is discoverable in the cwd, unless `--ignoreConfig` is passed.
//
// ⚠ DISTRUST THE DEFAULT: unlike earlier TypeScript majors (where omitting `--strict` means
// non-strict), this installed release (typescript@7.0.2) defaults `--strict` to `true` --
// confirmed live via `tsc --help` ("--strict ... default: true") and by compiling this exact
// probe with no strict flag at all, which already REJECTS it. So "strict off" below must pass
// the flag explicitly as `--strict false`; merely omitting `--strict` would not falsify anything
// on this compiler version and the second test below would be vacuous.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const PROBE_FILE = join(REPO_ROOT, "scripts", "strict-probe.ts");

function runTsc(strictFlag: string) {
  return spawnSync(
    process.execPath,
    [TSC_BIN, "--noEmit", "--skipLibCheck", "--ignoreConfig", "--strict", strictFlag, PROBE_FILE],
    { cwd: REPO_ROOT },
  );
}

test("strict-probe: --strict true -> tsc REJECTS (implicit any + unchecked null) -- the gate is ACTIVE", () => {
  const result = runTsc("true");
  const output = result.stdout?.toString() + result.stderr?.toString();
  assert.notEqual(result.status, 0, output);
  assert.match(output, /implicitly has an 'any' type/);
  assert.match(output, /possibly 'null'/);
});

test("strict-probe: --strict false -> tsc ACCEPTS the SAME file unchanged -- proves the rejection above is strict-mode-caused, not a stray syntax error", () => {
  const result = runTsc("false");
  const output = result.stdout?.toString() + result.stderr?.toString();
  assert.equal(result.status, 0, output);
});

test("strict-probe: the real tsconfig.json declares strict: true, and ci.yml's typecheck step actually compiles against it", async () => {
  const { readFile } = await import("node:fs/promises");
  const tsconfig = JSON.parse(await readFile(join(REPO_ROOT, "tsconfig.json"), "utf8"));
  assert.equal(tsconfig.compilerOptions.strict, true);

  const ciYml = await readFile(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ciYml, /npx tsc -p tsconfig\.json --noEmit/, "ci.yml's ci job must run the project typecheck against the real tsconfig.json");
});

test("strict-probe: tsconfig.json's include globs never reach scripts/**, so this permanently-broken probe never joins the real build", async () => {
  const { readFile } = await import("node:fs/promises");
  const tsconfig = JSON.parse(await readFile(join(REPO_ROOT, "tsconfig.json"), "utf8"));
  assert.ok(Array.isArray(tsconfig.include), "tsconfig.json must declare an include array");
  const KNOWN_SAFE_GLOBS = ["src/**/*.ts", "test/**/*.ts", "packages/*/src/**/*.ts", "apps/*/src/**/*.ts"];
  for (const pattern of tsconfig.include) {
    assert.ok(
      KNOWN_SAFE_GLOBS.includes(pattern),
      `tsconfig.json include pattern "${pattern}" is not one of the known-safe globs -- verify it still excludes scripts/**`,
    );
  }
});
