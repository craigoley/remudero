import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canaryCommand } from "#src/lib/model-canary-command.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
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
