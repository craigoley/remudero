import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  realWriteAtomicIo,
  realWriteAtomicIoOver,
  writeAtomic,
  writeAtomicIoFrom,
  type WriteAtomicIo,
} from "../src/lib/fs-race-safe.js";
import { deployMarkerPath, requestDeploy } from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T2899 ────────────────────────────────────────────────────────────────────────────────
//
// Atomic write existed six times privately and nowhere as an export, and the deployer's markers
// used none of them. These are the properties every one of those copies assumed and none stated:
// a write that fails leaves the PREVIOUS bytes at the path, a write that succeeds lands the new
// bytes EXACTLY, and the stage sits in the destination's own directory (rename is atomic only
// within one filesystem). The deployer case is asserted through a recorder on the seam, because
// "the marker is correct afterwards" is equally true of the non-atomic write this replaced.

function tmpDir(kind: string): string {
  // RMD_TMP_PREFIX verbatim, not a "rmd-" literal: mkdtemp-callsite-check resolves the prefix
  // statically, and a dir it cannot resolve is one the boot sweep cannot reap.
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}`));
}

/** The real syscalls, with each call recorded and any one of them made to throw. Delegating to
 *  the real fs (rather than faking it) is what lets these tests read the DIRECTORY afterwards
 *  and see whether a stage was left behind. */
function recordingIo(fail?: { on: "write" | "rename"; error: Error }): {
  io: WriteAtomicIo;
  writes: string[];
  renames: Array<{ from: string; to: string }>;
  removals: string[];
} {
  const writes: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  const removals: string[] = [];
  const io: WriteAtomicIo = {
    mkdirSync: (path, opts) => mkdirSync(path, opts),
    writeFileSync: (path, content) => {
      writes.push(path);
      if (fail?.on === "write") throw fail.error;
      writeFileSync(path, content);
    },
    renameSync: (from, to) => {
      renames.push({ from, to });
      if (fail?.on === "rename") throw fail.error;
      renameSync(from, to);
    },
    rmSync: (path, opts) => {
      removals.push(path);
      rmSync(path, opts);
    },
  };
  return { io, writes, renames, removals };
}

// ── the interrupted write ────────────────────────────────────────────────────────────────────

test("writeAtomic: a write interrupted at the RENAME leaves the previous file byte-for-byte intact", () => {
  const dir = tmpDir("w1-t2899-interrupt-rename-");
  const p = join(dir, "marker.json");
  writeFileSync(p, "PREVIOUS-CONTENTS");
  const { io, renames, removals } = recordingIo({ on: "rename", error: new Error("EIO: rename blew up") });

  assert.throws(() => writeAtomic(p, "NEW-CONTENTS", { io }), /rename blew up/);

  // The property that matters: a reader arriving now sees the OLD file, not a torn one.
  assert.equal(readFileSync(p, "utf8"), "PREVIOUS-CONTENTS");
  assert.equal(renames.length, 1, "the rename was attempted -- otherwise this proves nothing");
  // And the stage does not survive the failure.
  assert.equal(removals.length, 1);
  assert.deepEqual(readdirSync(dir), ["marker.json"]);
});

test("writeAtomic: a write interrupted at the STAGE never touches the destination path at all", () => {
  const dir = tmpDir("w1-t2899-interrupt-write-");
  const p = join(dir, "marker.json");
  writeFileSync(p, "PREVIOUS-CONTENTS");
  const { io, renames } = recordingIo({ on: "write", error: new Error("ENOSPC: no space left") });

  assert.throws(() => writeAtomic(p, "NEW-CONTENTS", { io }), /ENOSPC/);

  assert.equal(readFileSync(p, "utf8"), "PREVIOUS-CONTENTS");
  assert.equal(renames.length, 0, "a failed stage must not reach the rename");
  assert.deepEqual(readdirSync(dir), ["marker.json"]);
});

test("writeAtomic: when the CLEANUP also fails, the original write error is what propagates", () => {
  // The cleanup is best-effort by design: the temp may never have been created. Swallowing its
  // failure is only correct if the REAL error still reaches the caller -- a consolidation that
  // reported "rmSync failed" would send every diagnosis to the wrong syscall.
  const dir = tmpDir("w1-t2899-cleanup-fails-");
  const p = join(dir, "marker.json");
  writeFileSync(p, "PREVIOUS-CONTENTS");
  const io: WriteAtomicIo = {
    mkdirSync: (path, opts) => mkdirSync(path, opts),
    writeFileSync: (path, content) => writeFileSync(path, content),
    renameSync: () => {
      throw new Error("EXDEV: the real failure");
    },
    rmSync: () => {
      throw new Error("EACCES: the cleanup failure");
    },
  };

  assert.throws(() => writeAtomic(p, "NEW", { io }), /EXDEV: the real failure/);
  assert.equal(readFileSync(p, "utf8"), "PREVIOUS-CONTENTS");
});

// ── the completed write ──────────────────────────────────────────────────────────────────────

test("writeAtomic: a completed write is byte-identical, for utf8 text and for raw bytes alike", () => {
  const dir = tmpDir("w1-t2899-identical-");

  const textPath = join(dir, "text.json");
  // Content chosen to break a naive re-encode: a lone carriage return and a non-BMP codepoint.
  const text = '{"reason":"a\rb c \u{1F600}"}\n';
  assert.equal(writeAtomic(textPath, text), true);
  assert.deepEqual(readFileSync(textPath), Buffer.from(text, "utf8"));

  const bytesPath = join(dir, "bytes.bin");
  const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x80, 0x7f]);
  assert.equal(writeAtomic(bytesPath, bytes), true);
  assert.deepEqual(readFileSync(bytesPath), bytes);

  // A REPLACEMENT is the case the copies were written for: the old bytes are gone, not appended
  // to and not partially overwritten by a shorter payload.
  assert.equal(writeAtomic(textPath, "SHORT"), true);
  assert.equal(readFileSync(textPath, "utf8"), "SHORT");
  assert.deepEqual(readdirSync(dir).sort(), ["bytes.bin", "text.json"]);
});

test("writeAtomic: the stage sits in the DESTINATION's own directory -- rename is atomic only within one filesystem", () => {
  const dir = tmpDir("w1-t2899-same-dir-");
  const p = join(dir, "nested", "deep", "marker.json");
  const { io, writes, renames } = recordingIo();

  assert.equal(writeAtomic(p, "x", { io }), true);

  assert.equal(writes.length, 1);
  assert.equal(dirname(writes[0]!), dirname(p), "the stage must be a SIBLING of the destination");
  assert.equal(renames[0]!.from, writes[0]);
  assert.equal(renames[0]!.to, p);
  // The intermediate directories are created, so a first-ever write does not need a caller mkdir.
  assert.equal(readFileSync(p, "utf8"), "x");
});

test("writeAtomic: beforeRename returning false withdraws the stage and leaves the previous file untouched", () => {
  const dir = tmpDir("w1-t2899-withdraw-");
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, "PREVIOUS-CONTENTS");
  const { io, renames, removals } = recordingIo();

  const wrote = writeAtomic(p, "ROTATED", { io, beforeRename: () => false, tmpTag: "rotate-tmp" });

  assert.equal(wrote, false, "a withdrawn write reports false -- the ledger rotation branches on it");
  assert.equal(renames.length, 0);
  assert.equal(removals.length, 1);
  assert.equal(readFileSync(p, "utf8"), "PREVIOUS-CONTENTS");
  assert.deepEqual(readdirSync(dir), ["ledger.ndjson"]);
});

test("writeAtomic: tmpTag names the stage, so a directory scanner can tell a stage from a real file", () => {
  // ledgerRotationEntries reads the ledger directory; a stage named like an archive would be
  // mistaken for one. The tag is the only thing separating them, so it is asserted.
  const dir = tmpDir("w1-t2899-tag-");
  const p = join(dir, "ledger.ndjson");
  const { io, writes } = recordingIo();

  writeAtomic(p, "x", { io, tmpTag: "rotate-tmp" });

  assert.match(writes[0]!, /\/ledger\.ndjson\.rotate-tmp-\d+-[a-z0-9]+$/);
});

// ── writeAtomicIoFrom: the injected-seam adapter ─────────────────────────────────────────────

test("writeAtomicIoFrom: every syscall goes through the CALLER's seam, so its own spies still see the write", () => {
  // The four onboard phases assert "the only writes are X and Y" by spying on their fsDeps. If
  // the primitive took the real fs, those writes would vanish from the spy and the suites would
  // pass while observing nothing.
  const dir = tmpDir("w1-t2899-adapter-");
  const p = join(dir, "artifact.json");
  const seen: string[] = [];
  const seam = {
    mkdirSync: (path: string, opts: { recursive: true }) => {
      seen.push(`mkdir ${path}`);
      mkdirSync(path, opts);
    },
    writeFileSync: (path: string, content: string) => {
      seen.push(`write ${path}`);
      writeFileSync(path, content);
    },
    renameSync: (from: string, to: string) => {
      seen.push(`rename ${to}`);
      renameSync(from, to);
    },
  };

  assert.equal(writeAtomic(p, "CONTENT", { io: writeAtomicIoFrom(seam) }), true);

  assert.deepEqual(seen, [`mkdir ${dir}`, `write ${seen[1]!.slice(6)}`, `rename ${p}`]);
  assert.match(seen[1]!, /artifact\.json\.tmp-/);
  assert.equal(readFileSync(p, "utf8"), "CONTENT");
});

test("writeAtomicIoFrom: Buffer content reaches a string-only seam as utf8, not as [object Object]", () => {
  const dir = tmpDir("w1-t2899-adapter-buffer-");
  const p = join(dir, "artifact.txt");
  const written: string[] = [];
  const seam = {
    mkdirSync: (path: string, opts: { recursive: true }) => mkdirSync(path, opts),
    writeFileSync: (path: string, content: string) => {
      written.push(content);
      writeFileSync(path, content);
    },
    renameSync: (from: string, to: string) => renameSync(from, to),
  };

  writeAtomic(p, Buffer.from("héllo", "utf8"), { io: writeAtomicIoFrom(seam) });

  assert.deepEqual(written, ["héllo"]);
  assert.equal(readFileSync(p, "utf8"), "héllo");
});

test("writeAtomicIoFrom: the adapter supplies NO rmSync, so a failed write propagates rather than crashing on cleanup", () => {
  // rmSync is optional precisely so a three-syscall seam does not have to fake one. The property
  // asserted is that its absence costs the caller nothing but the stray stage: the ORIGINAL error
  // still arrives, rather than a TypeError from calling undefined.
  const dir = tmpDir("w1-t2899-adapter-no-rm-");
  const p = join(dir, "artifact.json");
  writeFileSync(p, "PREVIOUS-CONTENTS");
  const seam = {
    mkdirSync: (path: string, opts: { recursive: true }) => mkdirSync(path, opts),
    writeFileSync: (path: string, content: string) => writeFileSync(path, content),
    renameSync: () => {
      throw new Error("EPERM: rename refused");
    },
  };

  assert.equal(writeAtomicIoFrom(seam).rmSync, undefined, "the adapter must not fake a cleanup");
  assert.throws(() => writeAtomic(p, "NEW", { io: writeAtomicIoFrom(seam) }), /EPERM: rename refused/);
  assert.equal(readFileSync(p, "utf8"), "PREVIOUS-CONTENTS");
  // The stage IS left behind -- stated here rather than asserted away, because that is exactly
  // what the private copies this replaced did.
  assert.equal(readdirSync(dir).length, 2);
});

// ── the default io's own syscalls ────────────────────────────────────────────────────────────

test("realWriteAtomicIoOver: a SHORT write throws rather than renaming a truncated stage into place", () => {
  // The copy this replaces only console.error'd a short write and then renamed anyway -- which
  // puts a truncated file at the real path, the exact tear the primitive exists to prevent. A
  // short writeSync cannot be provoked through the real syscall on a regular file, so the arm is
  // only reachable through the seam.
  const dir = tmpDir("w1-t2899-short-write-");
  const p = join(dir, "state.json");
  writeFileSync(p, "PREVIOUS-CONTENTS");
  const closed: number[] = [];
  const io = realWriteAtomicIoOver({
    mkdirSync,
    openSync,
    writeSync: (fd, buf) => writeSync(fd, buf as Buffer, 0, 3), // three bytes of a longer payload
    fsyncSync,
    closeSync: (fd) => {
      closed.push(fd);
      closeSync(fd);
    },
    renameSync,
    rmSync,
  } as Parameters<typeof realWriteAtomicIoOver>[0]);

  assert.throws(() => writeAtomic(p, "MUCH LONGER THAN THREE BYTES", { io }), /short write staging/);

  assert.equal(readFileSync(p, "utf8"), "PREVIOUS-CONTENTS", "the truncated stage must never be renamed over the real file");
  assert.equal(closed.length, 1, "the descriptor is released even on the throw -- the finally arm");
  assert.deepEqual(readdirSync(dir), ["state.json"], "and the stage is cleaned up");
});

test("realWriteAtomicIoOver: a full write flushes BEFORE the rename, so a power loss cannot lose it", () => {
  const dir = tmpDir("w1-t2899-fsync-order-");
  const p = join(dir, "state.json");
  const order: string[] = [];
  const io = realWriteAtomicIoOver({
    mkdirSync,
    openSync,
    writeSync: (fd, buf, off, len) => {
      order.push("write");
      return writeSync(fd, buf as Buffer, off as number, len as number);
    },
    fsyncSync: (fd) => {
      order.push("fsync");
      fsyncSync(fd);
    },
    closeSync: (fd) => {
      order.push("close");
      closeSync(fd);
    },
    renameSync: (from, to) => {
      order.push("rename");
      renameSync(from, to);
    },
    rmSync,
  } as Parameters<typeof realWriteAtomicIoOver>[0]);

  assert.equal(writeAtomic(p, "DURABLE", { io }), true);

  assert.deepEqual(order, ["write", "fsync", "close", "rename"]);
  assert.equal(readFileSync(p, "utf8"), "DURABLE");
});

// ── the stage mode ───────────────────────────────────────────────────────────────────────────

test("writeAtomic: mode is applied to the STAGE, so a secret is never briefly readable at its final path", () => {
  // github-event-wake's replay state is 0o600. Setting the mode after the rename would leave a
  // window at the real path where it is not; setting it on the stage closes that window, and the
  // rename carries the mode across.
  const dir = tmpDir("w1-t2899-mode-");
  const p = join(dir, "replay.json");

  writeAtomic(p, '{"deliveryIds":[]}', { mode: 0o600 });

  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test("writeAtomic: without a mode the stage takes the process default, so ordinary state files are unchanged", () => {
  const dir = tmpDir("w1-t2899-no-mode-");
  const p = join(dir, "marker.json");
  const reference = join(dir, "reference.json");
  writeFileSync(reference, "x");

  writeAtomic(p, "y");

  assert.equal(statSync(p).mode & 0o777, statSync(reference).mode & 0o777);
});

test("writeAtomicIoFrom: a mode request is REFUSED by an injected seam, never silently written world-readable", () => {
  const dir = tmpDir("w1-t2899-mode-refused-");
  const p = join(dir, "secret.json");
  const seam = {
    mkdirSync: (path: string, opts: { recursive: true }) => mkdirSync(path, opts),
    writeFileSync: (path: string, content: string) => writeFileSync(path, content),
    renameSync: (from: string, to: string) => renameSync(from, to),
  };

  assert.throws(
    () => writeAtomic(p, "SECRET", { io: writeAtomicIoFrom(seam), mode: 0o600 }),
    /cannot set a file mode/,
  );
  // Nothing was left at the destination -- the refusal is not a half-write.
  assert.equal(existsSync(p), false);
});

// ── the deployer marker, through a recorder on the seam ──────────────────────────────────────

test("writeAtomic: the deployer's request marker is STAGED AND RENAMED, not written in place", () => {
  // A recorder on the shared seam, because the marker's CONTENT is identical either way: the
  // non-atomic writeFileSync this replaced produced the same bytes and the same test would pass.
  // What distinguishes them is that a rename happened, from a sibling stage, onto the marker path.
  const root = tmpDir("w1-t2899-deployer-");
  const renames: Array<{ from: string; to: string }> = [];
  const original = realWriteAtomicIo.renameSync;
  realWriteAtomicIo.renameSync = (from, to) => {
    renames.push({ from, to });
    original(from, to);
  };
  try {
    requestDeploy(root, "operator asked for a deploy");
  } finally {
    realWriteAtomicIo.renameSync = original;
  }

  const marker = deployMarkerPath(root);
  assert.equal(renames.length, 1, "the marker did not go through the atomic primitive");
  assert.equal(renames[0]!.to, marker);
  assert.equal(dirname(renames[0]!.from), dirname(marker));
  assert.notEqual(renames[0]!.from, marker, "the stage must be a distinct path from the marker");

  const parsed: unknown = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal((parsed as { reason?: string }).reason, "operator asked for a deploy");
});
