// test/a-reader-never-parses-a-half-written-config.test.ts — W1-T4641.
//
// OBSERVED 2026-09-27 on a CI coverage shard: a test fell back to the real `loadConfig()` while a
// parallel test process was creating the default config, and died on `SyntaxError: Unexpected end
// of JSON input`. `createOrReadExclusive` opens with `wx`; the loser reads on EEXIST, so it could
// read the winner's file between the winner's `open(wx)` and its write. These cases drive that
// window deterministically through the `FsRaceSyscalls` seam and an injected sleep.

import assert from "node:assert/strict";
import fsMod from "node:fs";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { configPath, loadConfig } from "../src/lib/config.js";
import { createOrReadPublished, StillBeingWrittenError, writeAtomic } from "../src/lib/fs-race-safe.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const FULL = JSON.stringify({ claudeBin: "/opt/claude", root: "/SENTINEL/root" }, null, 2) + "\n";

function tmpDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}half-written-${tag}-`));
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a reader arriving between the creator's open(wx) and its write waits, then reads the COMPLETE file", () => {
  const dir = tmpDir("wait");
  try {
    const p = join(dir, "config.json");
    let peerFd: number | undefined;
    const reads: string[] = [];
    const sleeps: number[] = [];
    const fsImpl = {
      openSync: ((path: string, flags: string, mode?: number) => {
        // The peer wins the claim an instant before this reader's own `wx`, and has not written.
        if (flags === "wx" && peerFd === undefined) peerFd = fsMod.openSync(path, "wx", 0o600);
        return fsMod.openSync(path, flags as never, mode as never);
      }) as typeof fsMod.openSync,
      readFileSync: ((fd: number, enc: BufferEncoding) => {
        const raw = fsMod.readFileSync(fd, enc);
        reads.push(raw);
        return raw;
      }) as typeof fsMod.readFileSync,
      closeSync: fsMod.closeSync,
    };
    const sleep = (ms: number): void => {
      sleeps.push(ms);
      if (sleeps.length === 1 && peerFd !== undefined) {
        writeAtomic(p, FULL, { mode: 0o600 }); // the peer publishes while this reader waits
        closeSync(peerFd);
      }
    };

    const result = createOrReadPublished(p, 0o600, fsImpl, sleep);

    assert.ok(!result.created, "the reader must never become the creator here");
    assert.equal(result.raw, FULL, "the reader hands back the whole file, never the empty claim");
    assert.deepEqual(JSON.parse(result.raw), { claudeBin: "/opt/claude", root: "/SENTINEL/root" });
    assert.deepEqual(reads, ["", FULL], "the window was exercised: the first read saw the empty claim");
    assert.equal(sleeps.length, 1, "exactly one wait bridged the creator's claim-to-publish span");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reader whose creator never publishes fails with the named reason, not a JSON parse error", () => {
  const dir = tmpDir("stuck");
  try {
    const p = join(dir, "config.json");
    let refusal: unknown;
    const sleeps: number[] = [];
    const claim = createOrReadPublished(p, 0o600);
    assert.ok(claim.created, "the first caller wins the wx claim");
    try {
      // Strictly between the creator's open(wx) and its write: the window itself.
      assert.equal(readFileSync(p, "utf8"), "", "mid-creation the path holds zero bytes, never a prefix of the config");
      try {
        createOrReadPublished(p, 0o600, undefined, (ms) => void sleeps.push(ms));
      } catch (err) {
        refusal = err;
      }
      claim.publish(FULL);
    } finally {
      claim.release();
    }

    assert.ok(refusal instanceof StillBeingWrittenError, `expected the named reason, got ${String(refusal)}`);
    assert.equal(refusal.reason, "still-being-written");
    assert.equal(refusal.path, p);
    assert.equal(refusal.attempts, sleeps.length + 1, "bounded: it gives up after its last look, without a final wait");
    assert.ok(sleeps.length > 0, "the reader waited before giving up");
    assert.equal(readFileSync(p, "utf8"), FULL, "the creator's publish landed whole");
    assert.equal(statSync(p).mode & 0o777, 0o600, "the published file keeps the claim's mode");
    const after = createOrReadPublished(p, 0o600);
    assert.ok(!after.created);
    assert.equal(after.raw, FULL, "a later reader reads the published file without waiting");
    assert.deepEqual(readdirSync(dir), ["config.json"], "no staging file is left beside it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a creator whose content fails withdraws its empty claim, so the next caller creates instead of waiting", () => {
  const dir = tmpDir("withdraw");
  try {
    const p = join(dir, "config.json");
    const claim = createOrReadPublished(p, 0o600);
    assert.ok(claim.created);
    assert.throws(() => {
      try {
        throw new Error("claude binary not found"); // the creator fails before it can publish
      } finally {
        claim.release();
      }
    }, /claude binary not found/);
    assert.deepEqual(readdirSync(dir), [], "the empty claim is gone");
    const next = createOrReadPublished(p, 0o600);
    assert.ok(next.created, "the next caller becomes the creator rather than waiting");
    next.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig over a claimed-but-never-written config fails with the named reason, never Unexpected end of JSON input", () => {
  const home = tmpDir("load-empty");
  try {
    withEnv({ HOME: home }, () => {
      const p = configPath();
      assert.ok(p.startsWith(home), "configPath must resolve under the fixture HOME");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, ""); // a creator's claim that was never published
      assert.throws(
        () => loadConfig(),
        (err: unknown) => err instanceof StillBeingWrittenError && err.reason === "still-being-written",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig creating the default config publishes it whole and returns what it wrote", () => {
  const home = tmpDir("load-create");
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "claude"), 0o755);
    withEnv({ HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` }, () => {
      const created = loadConfig();
      assert.equal(created.claudeBin, join(bin, "claude"));
      assert.equal(created.root, join(home, "Remudero"));
      const p = configPath();
      assert.equal(readFileSync(p, "utf8"), JSON.stringify(created, null, 2) + "\n");
      assert.equal(statSync(p).mode & 0o777, 0o600);
      assert.deepEqual(loadConfig(), created, "a second load reads back exactly what the first published");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
