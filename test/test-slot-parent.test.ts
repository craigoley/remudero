import assert from "node:assert/strict";
import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { observeTestSlotParent, type TestSlotParentObservation } from "#src/lib/test-slot-parent.js";

const posixOnly = { skip: process.platform !== "linux" && process.platform !== "darwin" };
type TestLookup = NonNullable<Parameters<typeof observeTestSlotParent>[1]>;

function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "rmd-slot-parent-"));
  try {
    // A private TMPDIR may inherit wheel/root's group. POSIX can clear setgid on chmod
    // when that group is not ours; own the fixture's group rather than skipping mode controls.
    chownSync(root, lstatSync(root).uid, process.getgid!());
    run(root);
  }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function expectState(result: TestSlotParentObservation, state: TestSlotParentObservation["state"], reason: string): void {
  assert.equal(result.state, state);
  assert.equal(result.reason, reason);
}

test("slot parent default observer accepts real non-cross-user-writable directories", posixOnly, () => {
  fixture(root => {
    for (const mode of [0o700, 0o755, 0o750, 0o2755]) {
      const parent = join(root, `parent-${mode.toString(8)}`);
      mkdirSync(parent); chmodSync(parent, mode);
      const before = lstatSync(parent), result = observeTestSlotParent(parent, undefined, undefined);
      assert.equal(before.mode & 0o7777, mode, "positive control: the fixture must retain its requested mode");
      expectState(result, "SAFE", "no-cross-user-write-bits");
      assert("parent" in result);
      assert.deepEqual(result.parent, { dev: before.dev, ino: before.ino, uid: before.uid, gid: before.gid, mode });
      assert.equal(lstatSync(parent).mode, before.mode);
    }
  });
});

test("slot parent default observer rejects nonsticky cross-user write bits without changing permissions", posixOnly, () => {
  fixture(root => {
    for (const mode of [0o777, 0o775, 0o757, 0o722, 0o2777]) {
      const parent = join(root, `parent-${mode.toString(8)}`);
      mkdirSync(parent); chmodSync(parent, mode);
      assert.equal(lstatSync(parent).mode & 0o7777, mode);
      expectState(observeTestSlotParent(parent, undefined, undefined), "UNSAFE", "cross-user-writable-without-sticky");
      assert.equal(lstatSync(parent).mode & 0o7777, mode, "the observer must not repair a nonsticky parent");
    }
  });
});

test("slot parent default observer recognizes sticky protection for group and other writable entries", posixOnly, () => {
  fixture(root => {
    for (const mode of [0o1777, 0o1775, 0o1757, 0o3777]) {
      const parent = join(root, `parent-${mode.toString(8)}`);
      mkdirSync(parent); chmodSync(parent, mode);
      assert.equal(lstatSync(parent).mode & 0o7777, mode);
      expectState(observeTestSlotParent(parent, undefined, undefined), "SAFE", "sticky-cross-user-writable-parent");
      assert.equal(lstatSync(parent).mode & 0o7777, mode);
    }
  });
});

test("slot parent default observer rejects symlinks including trailing slash and dangling controls", posixOnly, () => {
  fixture(root => {
    const target = join(root, "target"), link = join(root, "link"), dangling = join(root, "dangling");
    mkdirSync(target); chmodSync(target, 0o1777);
    symlinkSync(target, link); symlinkSync(join(root, "absent"), dangling);
    for (const path of [link, `${link}/`, `${link}///`, dangling, `${dangling}/`]) {
      expectState(observeTestSlotParent(path, undefined, undefined), "UNSAFE", "parent-is-symlink");
    }
    assert(lstatSync(link).isSymbolicLink());
    assert.equal(lstatSync(target).mode & 0o7777, 0o1777);
  });
});

test("slot parent default observer distinguishes real file missing and lookup error controls", posixOnly, () => {
  fixture(root => {
    const file = join(root, "file"); writeFileSync(file, "private sentinel", { mode: 0o600 });
    expectState(observeTestSlotParent(file, undefined, undefined), "UNSAFE", "parent-is-not-directory");
    assert.deepEqual(observeTestSlotParent(join(root, "missing"), undefined, undefined), { state: "UNKNOWN", reason: "parent-missing", errorCode: "ENOENT" });
    assert.deepEqual(observeTestSlotParent(join(file, "child"), undefined, undefined), { state: "UNKNOWN", reason: "parent-lookup-failed", errorCode: "ENOTDIR" });
    const loop = join(root, "loop"); symlinkSync(loop, loop);
    assert.deepEqual(observeTestSlotParent(join(loop, "child"), undefined, undefined), { state: "UNKNOWN", reason: "parent-lookup-failed", errorCode: "ELOOP" });
    assert.equal(readFileSync(file, "utf8"), "private sentinel");
  });
});

test("slot parent lookup failures have bounded codes and never expose thrown details", posixOnly, () => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP", "EIO", "EMFILE", "x".repeat(10_000)]) {
    let calls = 0;
    const result = observeTestSlotParent("/isolated-parent", () => {
      calls++; throw Object.assign(new Error("private path and ownership data".repeat(1000)), { code });
    }, undefined);
    assert.deepEqual(result, { state: "UNKNOWN", reason: code === "ENOENT" ? "parent-missing" : "parent-lookup-failed",
      errorCode: ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP", "EIO"].includes(code) ? code : "OTHER" });
    assert.equal(calls, 1);
    assert(JSON.stringify(result).length < 100);
  }
  for (const error of [null, undefined, "private raw string", { get code() { throw new Error("private accessor error"); } }]) {
    assert.deepEqual(observeTestSlotParent("/isolated-parent", () => { throw error; }, undefined),
      { state: "UNKNOWN", reason: "parent-lookup-failed", errorCode: "OTHER" });
  }
});

test("slot parent recheck detects a real replacement directory and never retries", posixOnly, () => {
  fixture(root => {
    const parent = join(root, "parent"); mkdirSync(parent); chmodSync(parent, 0o1777);
    let calls = 0;
    const lstat: TestLookup = path => {
      if (++calls === 2) {
        renameSync(parent, join(root, "original")); mkdirSync(parent); chmodSync(parent, 0o1777);
      }
      return lstatSync(path);
    };
    expectState(observeTestSlotParent(parent, lstat, undefined), "UNKNOWN", "parent-changed");
    assert.equal(calls, 2);
    assert.notEqual(lstatSync(parent).ino, lstatSync(join(root, "original")).ino);
  });
});

test("slot parent recheck detects real mode changes and symlink replacement", posixOnly, () => {
  for (const change of ["mode", "symlink"] as const) fixture(root => {
    const parent = join(root, "parent"); mkdirSync(parent); chmodSync(parent, 0o1777);
    let calls = 0;
    const lstat: TestLookup = path => {
      if (++calls === 2) {
        if (change === "mode") chmodSync(parent, 0o777);
        else { renameSync(parent, join(root, "original")); symlinkSync(join(root, "original"), parent); }
      }
      return lstatSync(path);
    };
    expectState(observeTestSlotParent(parent, lstat, undefined), "UNKNOWN", "parent-changed");
    assert.equal(calls, 2);
    if (change === "mode") assert.equal(lstatSync(parent).mode & 0o7777, 0o777);
    else assert(lstatSync(parent).isSymbolicLink());
  });
});

test("slot parent second lookup failure remains unknown rather than reusing an earlier safe stat", posixOnly, () => {
  fixture(root => {
    for (const code of ["ENOENT", "EACCES", "EIO"]) {
      let calls = 0;
      const lstat: TestLookup = path => { if (++calls === 2) throw Object.assign(new Error("private detail"), { code }); return lstatSync(path); };
      assert.deepEqual(observeTestSlotParent(root, lstat, undefined), { state: "UNKNOWN",
        reason: code === "ENOENT" ? "parent-missing" : "parent-lookup-failed", errorCode: code });
      assert.equal(calls, 2);
    }
  });
});

test("slot parent metadata changes and invalid measurements cannot become safe", posixOnly, () => {
  fixture(root => {
    const st = lstatSync(root);
    for (const field of ["dev", "ino", "uid", "gid"] as const) {
      let calls = 0;
      const lstat: TestLookup = () => Object.assign(lstatSync(root), { [field]: st[field] + (++calls === 2 ? 1 : 0) });
      expectState(observeTestSlotParent(root, lstat, undefined), "UNKNOWN", "parent-changed");
      assert.equal(calls, 2);
    }
    for (const bad of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectState(observeTestSlotParent(root, () => Object.assign(lstatSync(root), { mode: bad }), undefined), "UNKNOWN", "invalid-metadata");
    }
    let calls = 0;
    expectState(observeTestSlotParent(root, () => Object.assign(lstatSync(root), { mode: ++calls === 2 ? 0o200000 : st.mode }), undefined),
      "UNKNOWN", "invalid-metadata");
    assert.equal(calls, 2);
  });
});

test("slot parent invalid paths and unsupported platforms do no filesystem lookups", () => {
  let calls = 0;
  const lstat: TestLookup = () => { calls++; throw new Error("lookup must not run"); };
  for (const path of ["", "relative", "/parent/../other", "/parent/.", "/parent\0suffix", `/${"x".repeat(4096)}`]) {
    assert.deepEqual(observeTestSlotParent(path, lstat, "linux"), { state: "UNKNOWN", reason: "invalid-path" });
  }
  assert.deepEqual(observeTestSlotParent("/parent", lstat, "win32"), { state: "UNKNOWN", reason: "unsupported-platform" });
  assert.equal(calls, 0);
});

test("slot parent safe recheck reads only directory metadata and preserves private entries", posixOnly, () => {
  fixture(root => {
    chmodSync(root, 0o1777);
    const slot = join(root, "slot-1.json"), guard = join(root, ".slot-1.json.mutation"), capacity = join(root, "capacity-123");
    writeFileSync(slot, "private ownership sentinel", { mode: 0o600 });
    writeFileSync(guard, "", { mode: 0o600 }); mkdirSync(capacity);
    const before = [slot, guard, capacity].map(path => lstatSync(path));
    const lookedUp: string[] = [];
    expectState(observeTestSlotParent(`${root}/`, path => { lookedUp.push(path); return lstatSync(path); }, undefined),
      "SAFE", "sticky-cross-user-writable-parent");
    assert.deepEqual(lookedUp, [root, root]);
    assert.deepEqual(readdirSync(root).sort(), [".slot-1.json.mutation", "capacity-123", "slot-1.json"]);
    assert.deepEqual([slot, guard, capacity].map(path => lstatSync(path)), before);
    assert.equal(readFileSync(slot, "utf8"), "private ownership sentinel");
  });
});
