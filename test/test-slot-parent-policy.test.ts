import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireTestSlot, type TestSlotOptions } from "#src/lib/test-slot.js";

function fixture(run: (root: string, options: TestSlotOptions) => void) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "rmd-private-parent-policy-"));
  try { run(root, { slots: 1, ownershipProtocol: "private-capacity-v1", privateParentPolicy: "require-entry-protection",
    waitBoundMs: 0, load: () => ({ cores: 4, load1: 0 }), memoryHeadroom: () => undefined, log: () => {} }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("private parent policy refuses nonsticky shared parents without creating entries or changing permissions", () => {
  fixture((root, options) => {
    chmodSync(root, 0o777); const before = lstatSync(root);
    const lease = acquireTestSlot("unsafe parent", { ...options, dir: root });
    assert.equal(lease.outcome, "slot_unavailable"); assert.equal(lease.executionAllowed, false);
    assert.match(lease.note, /UNSAFE: cross-user-writable-without-sticky/);
    lease.refresh(); lease.release();
    assert.deepEqual(readdirSync(root), []); assert.equal(lstatSync(root).mode, before.mode);
  });
});

test("private parent policy preserves missing parents instead of preparing them", () => {
  fixture((root, options) => {
    const dir = join(root, "missing"); const lease = acquireTestSlot("missing parent", { ...options, dir });
    assert.equal(lease.outcome, "slot_unavailable"); assert.equal(lease.executionAllowed, false);
    assert.match(lease.note, /UNKNOWN: parent-missing/); assert.equal(existsSync(dir), false);
  });
});

test("private parent policy refuses a final symlink without modifying its target", () => {
  fixture((root, options) => {
    const dir = join(root, "link"), target = join(root, "target"); mkdirSync(target); chmodSync(target, 0o1777); symlinkSync(target, dir);
    const lease = acquireTestSlot("symlink parent", { ...options, dir });
    assert.equal(lease.outcome, "slot_unavailable"); assert.equal(lease.executionAllowed, false);
    assert.match(lease.note, /UNSAFE: parent-is-symlink/); assert(lstatSync(dir).isSymbolicLink());
    assert.deepEqual(readdirSync(target), []); assert.equal(lstatSync(target).mode & 0o7777, 0o1777);
  });
});

for (const mode of [0o755, 0o1777]) {
  test(`private parent policy admits a protected ${mode.toString(8)} parent without widening its mode`, () => {
    fixture((root, options) => {
      chmodSync(root, mode); const lease = acquireTestSlot("protected parent", { ...options, dir: root });
      try {
        assert.equal(lease.outcome, "acquired"); assert.notEqual(lease.executionAllowed, false);
        assert.equal(lstatSync(root).mode & 0o7777, mode);
        assert.equal(lstatSync(join(root, "slot-1.json")).mode & 0o777, 0o600);
        lease.refresh(); assert.equal(lstatSync(root).mode & 0o7777, mode);
      } finally { lease.release(); }
      assert.equal(existsSync(join(root, "slot-1.json")), false);
      assert.deepEqual(readdirSync(join(root, `capacity-${process.getuid?.()}`)), [], "only the empty owner projection directory may remain");
      assert.equal(lstatSync(root).mode & 0o7777, mode);
    });
  });
}

test("private parent policy cannot fall back to a legacy unslotted run", () => {
  fixture((root, options) => {
    const lease = acquireTestSlot("wrong writer", { ...options, dir: root, ownershipProtocol: undefined });
    assert.equal(lease.outcome, "slot_unavailable"); assert.equal(lease.executionAllowed, false);
    assert.match(lease.note, /requires the gated private writer/); assert.deepEqual(readdirSync(root), []);
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
  });
});

test("absent parent policy preserves the existing default writer preparation", () => {
  fixture((root, options) => {
    const dir = join(root, "legacy");
    const lease = acquireTestSlot("legacy default", { ...options, dir, ownershipProtocol: undefined, privateParentPolicy: undefined });
    try { assert.equal(lease.outcome, "acquired"); assert.equal(lstatSync(dir).mode & 0o777, 0o777); }
    finally { lease.release(); }
  });
});

test("private parent policy without an explicit directory never creates a test-process parent", () => {
  fixture((root, options) => {
    const code = `import {acquireTestSlot} from './src/lib/test-slot.ts'; const l=acquireTestSlot('no implicit parent',${JSON.stringify(options)}); console.log(JSON.stringify({outcome:l.outcome,allowed:l.executionAllowed,note:l.note})); l.release();`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, TMPDIR: root, TSX_DISABLE_CACHE: "1", NODE_TEST_CONTEXT: "child", RMD_TEST_SLOT_DIR: undefined, RMD_TEST_SLOT_PARENT: undefined },
    });
    assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
    assert.equal(result.outcome, "slot_unavailable"); assert.equal(result.allowed, false);
    assert.match(result.note, /requires an explicit existing directory/); assert.deepEqual(readdirSync(root), []);
  });
});

for (const privateOwner of [false, true]) {
  test(`private parent policy ${privateOwner ? "inherits a private" : "rejects a legacy"} real ancestor reservation`, () => {
    fixture((root, options) => {
      chmodSync(root, 0o1777);
      const owner = acquireTestSlot("ancestor owner", { dir: root, slots: 1, waitBoundMs: 0,
        ownershipProtocol: privateOwner ? "private-capacity-v1" : undefined, log: () => {} });
      try {
        assert.equal(owner.outcome, "acquired"); assert(owner.childEnvironment);
        const code = `import {acquireTestSlot} from './src/lib/test-slot.ts';
          import {readFileSync,writeFileSync} from 'node:fs';
          const l=acquireTestSlot('protected descendant',{dir:${JSON.stringify(root)},slots:1,waitBoundMs:0,ownershipProtocol:'private-capacity-v1',privateParentPolicy:'require-entry-protection'});
          const completionRefused=[];
          if (${privateOwner}) {
            const path=${JSON.stringify(join(root, "slot-1.json"))}, original=readFileSync(path,'utf8');
            try {
              const downgraded=JSON.parse(original); delete downgraded.ownershipProtocol;
              writeFileSync(path,JSON.stringify(downgraded));
              for(const method of ['refresh','release']) {
                let refused=false; try {l[method]();} catch(error) {refused=/inherited parent test slot lost/.test(error.message);}
                completionRefused.push(refused);
              }
            } finally {writeFileSync(path,original);}
          }
          l.refresh(); l.release(); console.log(JSON.stringify({outcome:l.outcome,allowed:l.executionAllowed,note:l.note,completionRefused}));`;
        const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
          cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
          env: { ...process.env, ...owner.childEnvironment, TSX_DISABLE_CACHE: "1", NODE_TEST_CONTEXT: undefined },
        });
        assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
        if (privateOwner) {
          assert.equal(result.outcome, "acquired"); assert.match(result.note, /inherited live parent/);
          assert.deepEqual(result.completionRefused, [true, true], "protocol downgrade must refuse both nested completion paths");
        }
        else { assert.notEqual(result.outcome, "acquired"); assert.equal(result.allowed, false); assert.match(child.stderr, /private-protocol-required/); }
        assert.equal(lstatSync(root).mode & 0o7777, 0o1777); owner.refresh();
      } finally { owner.release(); }
    });
  });
}
