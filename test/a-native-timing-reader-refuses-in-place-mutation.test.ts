import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a native timing reader refuses in-place mutation after its bounded descriptor read", t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-native-timing-mutation-"));t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "coverage"));const path = join(root, "coverage", "durations.json");
  writeFileSync(path, JSON.stringify({ version: 1, files: { "test/a.test.ts": 1 } }));
  const module = new URL("../scripts/lib/native-author-runtime.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const runtime=await import(${JSON.stringify(module)}),[root,path]=process.argv.slice(1),identity=fs.statSync(path),raw=fs.readSync;
    let changed=false;
    fs.readSync=(fd,...args)=>{const count=raw(fd,...args),s=fs.fstatSync(fd);if(count>0&&s.ino===identity.ino&&s.dev===identity.dev&&!changed){changed=true;fs.utimesSync(path,identity.atimeMs/1000,identity.mtimeMs/1000+60);}return count;};
    syncBuiltinESMExports();
    try{assert.throws(()=>runtime.closedDurationEvidence(root,path,['test/a.test.ts'],{}),/changed during its descriptor read/);assert.equal(changed,true,'the positive control must exercise the actual descriptor');}
    finally{fs.readSync=raw;syncBuiltinESMExports();}
    console.log(JSON.stringify({changed}));
  `, root, path], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.error, undefined);assert.equal(child.signal, null);assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).changed, true);
});
