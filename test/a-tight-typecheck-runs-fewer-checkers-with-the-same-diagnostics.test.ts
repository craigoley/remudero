// test/a-tight-typecheck-runs-fewer-checkers-with-the-same-diagnostics.test.ts — a cold native tsc (TypeScript 7) on
// this repo peaks at 2.2–2.95 GB in the core daemon container. MEASURED 2026-10-10 on this repo, cold, 5 runs each:
// `--checkers 2` peaked 7–10% below the default's Go heap; `GOGC=50`, one checker and `--singleThreaded` did not lower
// it. So a fleet tsc entrypoint whose memory headroom cannot hold the expected peak runs fewer checkers — and the
// diagnostics and exit code are tsc's own either way.
// FIXTURES ONLY: every project and buildinfo lives under this test's tmp dirs; the headroom is always injected.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { typecheckStep, type PreflightSpawn } from "../src/lib/commit-message.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  lowMemoryTypecheckArgs, TSC_DEFAULT_CHECKERS, TSC_LOW_MEMORY_MIN_CHECKERS, TYPECHECK_COLD_PEAK_BYTES, TYPECHECK_WARM_PEAK_BYTES,
} from "../src/lib/typecheck-buildinfo.js";
import { runTypecheck } from "../src/lib/typecheck-run.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GiB = 1024 ** 3;

/** A small project with type errors spread over several files, so more than one checker has diagnostics to report. */
function project(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}tight-typecheck-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [], noEmit: true, strict: true }, include: ["*.ts"] }));
  for (let i = 0; i < 8; i += 1) {
    writeFileSync(join(dir, `m${i}.ts`), [
      `import { base } from "./base";`,
      `export const n${i}: number = "${i}";`,
      `export function f${i}(x: string): number { return x; }`,
      `export const b${i}: string = base(${i});`,
      "",
    ].join("\n"));
  }
  writeFileSync(join(dir, "base.ts"), "export function base(n: number): number { return n; }\n");
  return dir;
}

test("tsc gets fewer checkers under low injected headroom, scaled to the shortfall, and nothing extra with room", () => {
  assert.equal(TSC_DEFAULT_CHECKERS, 4);
  assert.equal(TSC_LOW_MEMORY_MIN_CHECKERS, 2);
  assert.equal(TYPECHECK_WARM_PEAK_BYTES, TYPECHECK_COLD_PEAK_BYTES / 2);
  assert.deepEqual(lowMemoryTypecheckArgs(undefined, TYPECHECK_COLD_PEAK_BYTES), [], "no reading (macOS) changes nothing");
  assert.deepEqual(lowMemoryTypecheckArgs(8 * GiB, TYPECHECK_COLD_PEAK_BYTES), [], "a roomy host (CI) changes nothing");
  assert.deepEqual(lowMemoryTypecheckArgs(TYPECHECK_COLD_PEAK_BYTES, TYPECHECK_COLD_PEAK_BYTES), []);
  assert.deepEqual(lowMemoryTypecheckArgs(0.8 * TYPECHECK_COLD_PEAK_BYTES, TYPECHECK_COLD_PEAK_BYTES), ["--checkers", "3"]);
  assert.deepEqual(lowMemoryTypecheckArgs(0.5 * TYPECHECK_COLD_PEAK_BYTES, TYPECHECK_COLD_PEAK_BYTES), ["--checkers", "2"]);
  assert.deepEqual(lowMemoryTypecheckArgs(-1 * GiB, TYPECHECK_COLD_PEAK_BYTES), ["--checkers", "2"], "never below the measured floor");
  assert.deepEqual(lowMemoryTypecheckArgs(1 * GiB, TYPECHECK_WARM_PEAK_BYTES), ["--checkers", "3"], "a warm check is judged by its own peak");
});

test("npm run typecheck and rmd preflight's typecheck pass the low-memory flags only when the injected headroom is tight", (t) => {
  const dir = project(t);
  const seen: string[][] = [];
  const spawn = (_file: string, args: readonly string[]) => { seen.push([...args]); return { status: 0 }; };
  const acquireSlot = () => ({ outcome: "acquired" as const, concurrency: 1, waitedMs: 0, note: "fixture", refresh: () => {}, release: () => {} });
  const tight = { memoryHeadroom: () => 1 * GiB };
  assert.equal(runTypecheck(dir, ["--pretty", "false"], { spawn, acquireSlot, testSlot: tight, canWrite: () => false, log: () => {} }), 0);
  assert.equal(runTypecheck(dir, [], { spawn, acquireSlot, testSlot: { memoryHeadroom: () => 16 * GiB }, canWrite: () => false, log: () => {} }), 0);
  assert.deepEqual(seen, [
    ["-p", "tsconfig.json", "--noEmit", "--checkers", "2", "--pretty", "false"],
    ["-p", "tsconfig.json", "--noEmit"],
  ]);

  const preflightArgs: string[][] = [];
  const preflightSpawn: PreflightSpawn = (_file, args) => { preflightArgs.push([...args]); return { status: 0, stdout: "", stderr: "" }; };
  const slots = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}tight-typecheck-slots-`));
  t.after(() => rmSync(slots, { recursive: true, force: true }));
  assert.equal(typecheckStep(dir, preflightSpawn, { dir: slots, slots: 1, memoryHeadroom: () => 1 * GiB, log: () => {} }, () => false).ok, true);
  assert.deepEqual(preflightArgs, [["-p", "tsconfig.json", "--noEmit", "--checkers", "2"]]);
});

test("the low-memory tsc reports identical diagnostics and exit code, and a warm buildinfo stays warm across it", (t) => {
  const dir = project(t);
  const run = (extra: readonly string[]) => spawnSync(TSC, ["-p", "tsconfig.json", "--noEmit", "--pretty", "false", ...extra], { cwd: dir, encoding: "utf8" });
  const plain = run([]);
  const errors = plain.stdout.split("\n").filter((line) => line.includes("error TS"));
  assert.notEqual(plain.status, 0, plain.stderr);
  assert.equal(errors.length, 24, "three errors in each of eight files: the comparison compares something");
  for (const headroom of [0.8, 0.5, 0.1].map((share) => share * TYPECHECK_COLD_PEAK_BYTES)) {
    const extra = lowMemoryTypecheckArgs(headroom, TYPECHECK_COLD_PEAK_BYTES);
    assert.notDeepEqual(extra, [], "the flags under test are really passed");
    const tight = run(extra);
    assert.equal(tight.status, plain.status);
    assert.equal(tight.stdout, plain.stdout, `${extra.join(" ")} reports the same diagnostics, in the same order`);
  }

  const buildInfo = join(dir, "probe.tsbuildinfo");
  run(["--incremental", "--tsBuildInfoFile", buildInfo]);
  const before = readFileSync(buildInfo, "utf8");
  const warm = run(["--incremental", "--tsBuildInfoFile", buildInfo, ...lowMemoryTypecheckArgs(0.5 * TYPECHECK_COLD_PEAK_BYTES, TYPECHECK_COLD_PEAK_BYTES)]);
  assert.equal(warm.stdout, plain.stdout);
  assert.equal(readFileSync(buildInfo, "utf8"), before, "--checkers is not a compiler option tsc keys the buildinfo by");
});
