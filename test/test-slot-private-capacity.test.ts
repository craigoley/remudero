import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquireTestSlot as acquireNativeTestSlot, type TestSlotOptions } from "#src/lib/test-slot.js";
import { observeSlotCapacity, publishSlotCapacity, retireOwnedSlotCapacity } from "#src/lib/test-slot-capacity.js";

const input = { pid: process.pid, host: "fixture-host", bootId: "fixture-boot", pidNs: "fixture-namespace",
  startedAt: "2026-10-15T00:00:00.000Z", concurrency: 2, memoryBytes: 8192 };
const acquireTestSlot = (label: string, options: TestSlotOptions) => acquireNativeTestSlot(label, {
  ownershipProtocol: "private-capacity-v1", ...options,
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-private-capacity-")), path = join(root, "slot-1.json");
  const fd = openSync(path, "wx+", 0o600);
  writeSync(fd, JSON.stringify({ ...input, ownerNonce: "private-owner-nonce", label: "PRIVATE LABEL", filePeaks: [{ path: "/PRIVATE/PATH" }] }));
  const directory = join(root, `capacity-${lstatSync(path).uid}`);
  return { root, path, fd, directory, cleanup: () => { closeSync(fd); rmSync(root, { recursive: true, force: true }); } };
}
test("private capacity projection contains only allowlisted fields and every ownership hard link stays 0600", () => {
  const fx = fixture(); try {
    const remove = publishSlotCapacity(fx.path, fx.fd, 1, input), names = readdirSync(fx.directory);
    assert.equal(names.length, 1);
    const projection = join(fx.directory, names[0]!);
    assert.equal(lstatSync(projection).ino, lstatSync(fx.path).ino);
    assert.equal(lstatSync(projection).mode & 0o777, 0o600);
    assert.equal(lstatSync(fx.directory).mode & 0o777, 0o755);
    assert(names[0]!.length <= 255);
    assert(!/PRIVATE|nonce|fixture/.test(names[0]!));
    const observed = observeSlotCapacity(fx.path, 1); assert.equal(observed.state, "observed");
    if (observed.state !== "observed") assert.fail("missing native projection");
    assert.deepEqual(Object.keys(observed.capacity).sort(), ["concurrency", "heartbeatAt", "memoryBytes"].sort());
    assert.equal(observed.capacity.memoryBytes, 8192);
    remove(); remove(); assert.deepEqual(observeSlotCapacity(fx.path, 1), { state: "unknown" });
  } finally { fx.cleanup(); }
});
test("permissive and restrictive umasks cannot expose ownership or hide a newly published capacity directory", () => {
  const previous = process.umask();
  try { for (const mask of [0, 0o077]) {
    process.umask(mask); const fx = fixture();
    try { const remove = publishSlotCapacity(fx.path, fx.fd, 1, input);
      assert.equal(lstatSync(fx.path).mode & 0o777, 0o600);
      assert.equal(lstatSync(fx.directory).mode & 0o777, 0o755);
      assert.equal(observeSlotCapacity(fx.path, 1).state, "observed"); remove();
    } finally { fx.cleanup(); }
  } } finally { process.umask(previous); }
});
test("missing, unpublished, linked and replaced capacity records are not conflated", () => {
  const fx = fixture(); try {
    assert.deepEqual(observeSlotCapacity(fx.path, 1), { state: "unknown" });
    const remove = publishSlotCapacity(fx.path, fx.fd, 1, input);
    renameSync(fx.path, join(fx.root, "old-private"));
    assert.deepEqual(observeSlotCapacity(fx.path, 1), { state: "missing" });
    writeFileSync(fx.path, "unrelated", { mode: 0o600 });
    assert.deepEqual(observeSlotCapacity(fx.path, 1), { state: "unknown" });
    rmSync(fx.path); symlinkSync(join(fx.root, "old-private"), fx.path);
    assert.deepEqual(observeSlotCapacity(fx.path, 1), { state: "unknown" }); remove();
  } finally { fx.cleanup(); }
});
test("capacity publication rejects public ownership, invalid numbers and a replacement inode", () => {
  const fx = fixture(); try {
    chmodSync(fx.path, 0o644); assert.throws(() => publishSlotCapacity(fx.path, fx.fd, 1, input), /private slot ownership/);
    chmodSync(fx.path, 0o600);
    for (const change of [{ concurrency: 0 }, { memoryBytes: -1 }, { memoryBytes: Number.NaN }]) {
      assert.throws(() => publishSlotCapacity(fx.path, fx.fd, 1, { ...input, ...change }), /invalid slot capacity/);
    }
    renameSync(fx.path, join(fx.root, "original")); writeFileSync(fx.path, "replacement", { mode: 0o600 });
    assert.throws(() => publishSlotCapacity(fx.path, fx.fd, 1, input), /private slot ownership/);
  } finally { fx.cleanup(); }
});
test("capacity directories must be real owner-writable-only directories and are never widened on reuse", () => {
  const fx = fixture(); try {
    mkdirSync(fx.directory, { mode: 0o700 });
    assert.throws(() => publishSlotCapacity(fx.path, fx.fd, 1, input), /peer-readable/);
    assert.equal(lstatSync(fx.directory).mode & 0o777, 0o700);
    rmSync(fx.directory, { recursive: true }); symlinkSync(fx.root, fx.directory);
    assert.throws(() => publishSlotCapacity(fx.path, fx.fd, 1, input));
    assert.deepEqual(observeSlotCapacity(fx.path, 1), { state: "unknown" });
  } finally { fx.cleanup(); }
});
test("ambiguous, oversized and unreadable capacity inventories remain UNKNOWN", () => {
  const fx = fixture(); try {
    const remove = publishSlotCapacity(fx.path, fx.fd, 1, input), first = readdirSync(fx.directory)[0]!;
    linkSync(fx.path, join(fx.directory, first.replace(".8192", ".4096")));
    assert.deepEqual(observeSlotCapacity(fx.path, 1), { state: "unknown" });
    rmSync(join(fx.directory, first.replace(".8192", ".4096")));
    for (let i = 0; i < 129; i++) writeFileSync(join(fx.directory, `irrelevant-${i}`), "", { mode: 0o600 });
    assert.deepEqual(observeSlotCapacity(fx.path, 1), { state: "unknown" }); remove();
    chmodSync(fx.directory, 0o777); assert.deepEqual(observeSlotCapacity(fx.path, 1), { state: "unknown" });
  } finally { fx.cleanup(); }
});
test("a foreign projection replacement survives old-owner cleanup", () => {
  const fx = fixture(); try {
    const remove = publishSlotCapacity(fx.path, fx.fd, 1, input), path = join(fx.directory, readdirSync(fx.directory)[0]!);
    unlinkSync(path); writeFileSync(path, "foreign replacement", { mode: 0o600 });
    remove(); assert.equal(readFileSync(path, "utf8"), "foreign replacement");
  } finally { fx.cleanup(); }
});
test("capacity heartbeat follows the original private inode and drops no memory reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-heartbeat-"));
  let now = Date.parse("2026-10-15T00:00:00.000Z");
  const lease = acquireTestSlot("PRIVATE LABEL", { dir: root, slots: 1, memoryBytes: 8192, log: () => {},
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() } });
  try {
    assert.equal(lease.outcome, "acquired"); const path = join(root, "slot-1.json");
    now += 60_000; lease.refresh(); const observed = observeSlotCapacity(path, 1);
    assert.equal(observed.state, "observed"); if (observed.state !== "observed") assert.fail();
    assert.equal(Date.parse(observed.capacity.heartbeatAt), now); assert.equal(observed.capacity.memoryBytes, 8192);
    lease.release(); assert.deepEqual(observeSlotCapacity(path, 1), { state: "missing" });
  } finally { lease.release(); rmSync(root, { recursive: true, force: true }); }
});
test("UNKNOWN peer capacity blocks admission instead of disappearing from memory accounting", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-unknown-"));
  try {
    writeFileSync(join(root, "slot-1.json"), "private in-progress owner", { mode: 0o600 });
    const lease = acquireTestSlot("waiter", { dir: root, slots: 2, waitBoundMs: 0, log: () => {} });
    assert.equal(lease.outcome, "wait_bound_exceeded");
    assert.match(lease.note, /UNKNOWN/); assert.equal(readdirSync(root).includes("slot-2.json"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("private peer memory metadata still sizes a second slot without exposing paths", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-memory-"));
  const options = { dir: root, slots: 2, load: () => ({ cores: 8, load1: 0 }), memoryHeadroom: () => 16_384, log: () => {} };
  const first = acquireTestSlot("first PRIVATE", { ...options, memoryBytes: 12_288 });
  const second = acquireTestSlot("second", { ...options, perFileBytes: 4096 });
  try { assert.equal(first.outcome, "acquired"); assert.equal(second.outcome, "acquired"); assert.equal(second.concurrency, 1); }
  finally { second.release(); first.release(); rmSync(root, { recursive: true, force: true }); }
});
test("a changed private owner nonce preserves peer projection through old refresh and release", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-owner-change-"));
  const lease = acquireTestSlot("original", { dir: root, slots: 1, log: () => {} });
  try {
    assert.equal(lease.outcome, "acquired"); const path = join(root, "slot-1.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ownerNonce: "different-owner" }));
    lease.refresh(); lease.release();
    assert.equal(observeSlotCapacity(path, 1).state, "observed");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, "different-owner");
  } finally { lease.release(); rmSync(root, { recursive: true, force: true }); }
});
test("mutating caller estimates after admission cannot change the public or private granted peak", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-grant-freeze-"));
  const options = { dir: root, slots: 1, memoryBytes: 8192, log: () => {} };
  const lease = acquireTestSlot("frozen", options);
  try {
    assert.equal(lease.outcome, "acquired"); options.memoryBytes = 65_536; lease.refresh();
    const path = join(root, "slot-1.json"), observed = observeSlotCapacity(path, 1);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).memoryBytes, 8192);
    assert.equal(observed.state, "observed"); if (observed.state !== "observed") assert.fail();
    assert.equal(observed.capacity.memoryBytes, 8192);
  } finally { lease.release(); rmSync(root, { recursive: true, force: true }); }
});
test("same-owner stale recovery retires the original projection before sizing or replacing a reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-dead-owner-")), logs: string[] = [];
  const options = { dir: root, slots: 2, memoryHeadroom: () => 8192, memoryBytes: 8192,
    log: (line: string) => logs.push(line), waitBoundMs: 0 };
  const dead = acquireTestSlot("PRIVATE dead owner", { ...options, pid: 999_999 });
  let replacement: ReturnType<typeof acquireTestSlot> | undefined;
  try {
    assert.equal(dead.outcome, "acquired");
    replacement = acquireTestSlot("replacement", { ...options, isPidAlive: () => false });
    assert.equal(replacement.outcome, "acquired", replacement.note);
    const path = join(root, "slot-1.json"), observed = observeSlotCapacity(path, 1);
    assert.equal(observed.state, "observed");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).label, "replacement");
    dead.release(); // The old lease cannot retire the replacement's projection.
    assert.equal(observeSlotCapacity(path, 1).state, "observed");
    const recovered = logs.filter(line => line.includes('"step":"test_slot.owner_recovery"'));
    assert(recovered.length > 0);
    assert(!recovered.some(line => /PRIVATE|ownerNonce/.test(line)), "recovery event must not dump private bytes");
  } finally { replacement?.release(); dead.release(); rmSync(root, { recursive: true, force: true }); }
});
test("retiring reclaimed capacity refuses foreign uid authority and preserves replacement inodes", () => {
  const fx = fixture(); try {
    publishSlotCapacity(fx.path, fx.fd, 1, input);
    const owner = lstatSync(fx.path), projection = join(fx.directory, readdirSync(fx.directory)[0]!);
    assert.throws(() => retireOwnedSlotCapacity(fx.path, 1, input, { ...owner, uid: owner.uid + 1 }), /foreign capacity recovery/);
    unlinkSync(projection); writeFileSync(projection, "replacement", { mode: 0o600 });
    retireOwnedSlotCapacity(fx.path, 1, input, owner);
    assert.equal(readFileSync(projection, "utf8"), "replacement");
  } finally { fx.cleanup(); }
});
for (const kind of ["identical-json", "symlink", "fifo", "oversized"]) {
  test(`private recovery refuses a ${kind} replacement after its bounded inspection`, () => {
    const root = mkdtempSync(join(tmpdir(), "rmd-capacity-recovery-race-"));
    try {
      // A real child deadline is load-bearing: removing O_NONBLOCK must not hang this suite.
      const program = `
        import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
        import {execFileSync} from 'node:child_process'; import {join} from 'node:path';
        const root=process.argv[1],kind=process.argv[2],path=join(root,'slot-1.json');
        const original=fs.openSync,postSwapReads=[]; let swapped=false,swapping=false;
        fs.openSync=(name,flags,...rest)=>{if(swapped&&!swapping&&name===path&&flags!=='wx+')postSwapReads.push(flags);return original(name,flags,...rest)};
        syncBuiltinESMExports();
        const {acquireTestSlot}=await import(${JSON.stringify(new URL("../src/lib/test-slot.ts", import.meta.url).href)});
        const options={dir:root,slots:1,ownershipProtocol:'private-capacity-v1',waitBoundMs:0,log:()=>{},memoryHeadroom:()=>undefined};
        const first=acquireTestSlot('PRIVATE race owner',{...options,pid:999999});
        if(first.outcome!=='acquired')throw Error('positive fixture acquisition failed');
        const originalBytes=fs.readFileSync(path,'utf8'),sentinel=join(root,'sentinel');fs.writeFileSync(sentinel,'SENTINEL');
        const replacement=acquireTestSlot('replacement',{...options,isPidAlive:()=>{
          if(!swapped){swapped=true;swapping=true;fs.renameSync(path,join(root,'retained-private'));
            if(kind==='symlink')fs.symlinkSync(sentinel,path);
            else if(kind==='fifo')execFileSync('/usr/bin/mkfifo',[path]);
            else fs.writeFileSync(path,kind==='oversized'?'x'.repeat(1024*1024+1):originalBytes,{mode:0o600});swapping=false;}
          return false;
        }});
        const flagsSafe=postSwapReads.length>0&&postSwapReads.every(f=>typeof f==='number'&&(f&fs.constants.O_NOFOLLOW)!==0&&(f&fs.constants.O_NONBLOCK)!==0);
        const st=fs.lstatSync(path),preserved=kind==='fifo'?st.isFIFO():kind==='symlink'?st.isSymbolicLink():fs.readFileSync(path,'utf8')===(kind==='oversized'?'x'.repeat(1024*1024+1):originalBytes);
        console.log(JSON.stringify({swapped,flagsSafe,preserved,refused:replacement.outcome!=='acquired',sentinel:fs.readFileSync(sentinel,'utf8')}));
        replacement.release();first.release();
      `;
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program, root, kind], {
        encoding: "utf8", timeout: 4000, killSignal: "SIGKILL", env: { ...process.env, TSX_DISABLE_CACHE: "1" },
      });
      assert.equal(child.status, 0, String(child.error ?? child.stderr));
      assert.deepEqual(JSON.parse(child.stdout.trim()), { swapped: true, flagsSafe: true, preserved: true, refused: true, sentinel: "SENTINEL" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test("a private holder becoming stale after the first sweep retires its projection on the collision path", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-late-stale-"));
  const options = { dir: root, slots: 1, waitBoundMs: 0, log: () => {} };
  const first = acquireTestSlot("old", { ...options, pid: 999_999 }); let probes = 0;
  const second = acquireTestSlot("new", { ...options, isPidAlive: () => ++probes === 1 });
  try {
    assert.equal(first.outcome, "acquired"); assert.equal(second.outcome, "acquired", second.note);
    assert(probes >= 3, "both collision recovery judgments must execute");
    first.release(); assert.equal(observeSlotCapacity(join(root, "slot-1.json"), 1).state, "observed");
  } finally { second.release(); first.release(); rmSync(root, { recursive: true, force: true }); }
});
test("unknown local namespace cannot turn a private foreign-namespace lease into a dead local pid", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-unknown-ns-"));
  const options = { dir: root, slots: 1, waitBoundMs: 0, log: () => {} };
  const first = acquireTestSlot("foreign namespace", { ...options, pid: 999_999, pidNamespace: () => "pid:[111]" });
  const second = acquireTestSlot("unknown namespace", { ...options, pidNamespace: () => undefined, isPidAlive: () => false });
  try {
    assert.equal(first.outcome, "acquired"); assert.equal(second.outcome, "wait_bound_exceeded");
    assert.equal(observeSlotCapacity(join(root, "slot-1.json"), 1).state, "observed");
  } finally { second.release(); first.release(); rmSync(root, { recursive: true, force: true }); }
});
test("reader-first default keeps the private writer off and refuses mixed private coordination", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-reader-first-"));
  const options = { dir: root, slots: 2, waitBoundMs: 0, log: () => {} };
  const legacy = acquireNativeTestSlot("legacy default", options);
  try {
    assert.equal(legacy.outcome, "acquired");
    const path = join(root, "slot-1.json");
    assert.equal(lstatSync(path).mode & 0o777, 0o644);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).ownershipProtocol, undefined);
    assert.equal(readdirSync(root).some(name => name.startsWith("capacity-")), false);
    legacy.release();
    const owner = acquireTestSlot("private explicit opt-in", options);
    try {
      assert.equal(owner.outcome, "acquired");
      const reader = acquireNativeTestSlot("default reader", options);
      try {
        assert.equal(reader.executionAllowed, false, reader.note);
        assert.match(reader.note, /NOT_RUN/);
        assert.equal(readdirSync(root).includes("slot-2.json"), false);
      } finally { reader.release(); }
    } finally { owner.release(); }
  } finally { legacy.release(); rmSync(root, { recursive: true, force: true }); }
});
test("two missing Linux namespaces cannot authorize private pid or expired-heartbeat recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-linux-ns-"));
  const options = { dir: root, slots: 1, waitBoundMs: 0, log: () => {}, platform: "linux" as const,
    hostname: () => "same-host", bootId: () => "same-boot", pidNamespace: () => undefined };
  const first = acquireTestSlot("unknown Linux namespace", { ...options, pid: 999_999 });
  try {
    assert.equal(first.outcome, "acquired");
    const path = join(root, "slot-1.json"), original = JSON.parse(readFileSync(path, "utf8"));
    for (const heartbeatAt of [original.heartbeatAt, "2000-01-01T00:00:00.000Z"]) {
      writeFileSync(path, JSON.stringify({ ...original, heartbeatAt }));
      let probes = 0;
      const next = acquireTestSlot("must not infer local pid authority", { ...options, isPidAlive: () => { probes++; return false; } });
      assert.equal(next.executionAllowed, false);
      assert.equal(probes, 0, "missing namespace is not a local PID proof");
      assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, original.ownerNonce);
      next.release();
    }
  } finally { first.release(); rmSync(root, { recursive: true, force: true }); }
});
test("direct release without refresh preserves a changed nonce and its capacity projection", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-capacity-release-nonce-"));
  const lease = acquireTestSlot("old owner", { dir: root, slots: 1, log: () => {} });
  try {
    assert.equal(lease.outcome, "acquired"); const path = join(root, "slot-1.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ownerNonce: "new-owner" }));
    lease.release();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, "new-owner");
    assert.equal(observeSlotCapacity(path, 1).state, "observed");
  } finally { lease.release(); rmSync(root, { recursive: true, force: true }); }
});
