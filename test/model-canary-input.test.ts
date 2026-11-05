import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canaryCommand, projectNativeCanaryEstimands, parseNativeCanaryAnalysisInput } from "#src/lib/model-canary-command.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
test("canary descriptor input refuses a platform without the required no-follow flag", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-descriptor-flags-`));
  try {
    const input = join(dir, "runs.json"); writeFileSync(input, "[]");
    const script = `import fs from 'node:fs'; import { mock } from 'node:test';
      const safeFs={...fs,constants:{...fs.constants,O_NOFOLLOW:undefined}};
      mock.module('node:fs',{namedExports:safeFs,defaultExport:safeFs});
      const {canaryCommand}=await import('./src/lib/model-canary-command.ts');
      canaryCommand(['project',${JSON.stringify(join(dir, "out"))},${JSON.stringify(input)}]);`;
    const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "--eval", script], { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 1, child.stderr); assert.match(child.stderr, /canary-input-platform-unsupported/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("canary descriptor input refuses links directories and oversized files but accepts its exact bound", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-descriptor-`));
  try {
    const input = join(dir, "runs.json"), alias = join(dir, "alias.json");
    writeFileSync(input, "[]"); symlinkSync(input, alias);
    assert.throws(() => canaryCommand(["project", join(dir, "linked"), alias]), /ELOOP/);
    assert.throws(() => canaryCommand(["project", join(dir, "directory"), dir]), /regular-file-required/);
    writeFileSync(input, "[]" + " ".repeat(8 * 1024 * 1024 - 1));
    assert.throws(() => canaryCommand(["project", join(dir, "oversize"), input]), /canary-input-bound/);
    writeFileSync(input, "[]" + " ".repeat(8 * 1024 * 1024 - 2));
    assert.equal(canaryCommand(["project", join(dir, "exact"), input]).runs, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("canary descriptor input reads the opened file after the path is replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-descriptor-swap-`));
  try {
    const input = join(dir, "runs.json"); writeFileSync(input, "[]");
    const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const input=${JSON.stringify(input)}, initial=fs.statSync(input), original=fs.fstatSync, pathStat=fs.statSync;
      let changed=false;function swap(info){if(!changed&&info.ino===initial.ino&&info.dev===initial.dev){changed=true;
        fs.renameSync(input,input+'.opened');fs.writeFileSync(input,'replacement is not JSON');}return info;}
      fs.fstatSync=function(fd,options){return swap(original(fd,options));};
      fs.statSync=function(path,options){return swap(pathStat(path,options));};
      syncBuiltinESMExports();const {canaryCommand}=await import('./src/lib/model-canary-command.ts');
      console.log(JSON.stringify(canaryCommand(['project',${JSON.stringify(join(dir, "out"))},input])));`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).runs, 0);
    assert.equal(readFileSync(input, "utf8"), "replacement is not JSON");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("canary descriptor input retains its byte bound when the opened file grows after fstat", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-descriptor-grow-`));
  try {
    const input = join(dir, "runs.json"); writeFileSync(input, "[]");
    const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const input=${JSON.stringify(input)}, initial=fs.statSync(input), original=fs.fstatSync, pathStat=fs.statSync;
      let changed=false;function grow(info){if(!changed&&info.ino===initial.ino&&info.dev===initial.dev){changed=true;
        fs.appendFileSync(input,' '.repeat(8*1024*1024));}return info;}
      fs.fstatSync=function(fd,options){return grow(original(fd,options));};
      fs.statSync=function(path,options){return grow(pathStat(path,options));};
      syncBuiltinESMExports();const {canaryCommand}=await import('./src/lib/model-canary-command.ts');
      canaryCommand(['project',${JSON.stringify(join(dir, "out"))},input]);`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 1, child.stderr); assert.match(child.stderr, /canary-input-bound/);
    assert.equal(readFileSync(input).length, 8 * 1024 * 1024 + 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("native analysis input requires predeclared matrix identity and window", () => {
  const input = {
    version: "model-canary-analysis-input-v1", seed: "fixed-analysis-seed", censusInput: {},
    matrixOptions: { day: "2026-11-05", seed: "fixed-matrix-seed", replicates: 1 },
    matrixDigest: "a".repeat(64),
    design: { comparisons: [{ id: "comparison-a", endpoints: ["correctness"], estimands: ["first-attempt"] }],
      splits: ["development", "sealed-holdout"] },
    comparisons: [{ id: "comparison-a", endpoint: "correctness", leftConfigId: "config-a", rightConfigId: "config-b" }],
    observationWindow: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-08T00:00:00.000Z" },
  };
  assert.equal(parseNativeCanaryAnalysisInput(input).matrixDigest, input.matrixDigest);
  assert.throws(() => parseNativeCanaryAnalysisInput({ ...input, observationWindow: undefined }),
    /canary-analysis-input-invalid/);
  assert.throws(() => parseNativeCanaryAnalysisInput({ ...input, matrixDigest: "not-a-digest" }),
    /canary-analysis-input-invalid/);
});

test("native analysis command rejects incomplete CLI arguments before reading evidence", () => {
  assert.throws(() => canaryCommand(["analyze-private"]), /usage: model-canary-command analyze-private/);
});

test("native estimands do not turn extra terminal attempts into graded cases", () => {
  const repeated = projectNativeCanaryEstimands({ attempts: [{}, {}, {}] as never, verified: true });
  assert.deepEqual(repeated.outcomes, { "first-attempt": null, "all-repeats": null, "best-of-k": null });
  assert.match(repeated.availability["all-repeats"], /no-per-attempt-outcomes/);
  assert.match(repeated.availability["best-of-k"], /no-per-attempt-outcomes/);
  const single = projectNativeCanaryEstimands({ attempts: [{}] as never, verified: true });
  assert.deepEqual(single.outcomes, { "first-attempt": true, "all-repeats": null, "best-of-k": null });
});
