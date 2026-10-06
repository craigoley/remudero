/**
 * 2026-10-06: `gitGrepAnchorTrue` (a sync `git grep` per evidence anchor) held the core daemon loop
 * up to 29 s a spawn, 590 s of loop lag over 17 h. These pin the async grep and the cache warm;
 * the draft hook's wiring is driven in the-inbox-draft-hook-greps-anchors-off-the-loop.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  ANCHOR_GREP_CACHE_MAX_ENTRIES,
  AnchorGrepTimeoutError,
  createAnchorGrepCache,
  gitGrepAnchorTrue,
  gitGrepAnchorTrueAsync,
  warmAnchorGrepCache,
  warmedAnchorGrep,
  type EvidenceAnchor,
} from "../src/lib/inbox.js";
import { gitRepo } from "./helpers/git-repo.js";

const landed: EvidenceAnchor = { description: "landed", pattern: "LANDED", path: "sub/note.md" };
const absent: EvidenceAnchor = { description: "absent", pattern: "NEVER-THERE", path: "sub/note.md" };
const anywhere: EvidenceAnchor = { description: "anywhere", pattern: "LANDED" };

function seeded(): string {
  const repo = gitRepo({ kind: "anchor-grep" });
  mkdirSync(join(repo.dir, "sub"), { recursive: true });
  writeFileSync(join(repo.dir, "sub", "note.md"), "the feature has LANDED for real\n", "utf8");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base");
  return repo.dir;
}

/** A child that never exits on its own: `kill` ends it, the way a real SIGTERM would. */
function hungChild() {
  const kills: string[] = [];
  const run = ((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    const child = {
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal: string) {
        kills.push(signal);
        child.signalCode = signal;
        setImmediate(() => cb(Object.assign(new Error("killed"), { killed: true, signal })));
        return true;
      },
    };
    return child;
  }) as unknown as typeof execFile;
  return { run, kills };
}

test("the async anchor grep answers exactly as the sync grep on the same repo", async () => {
  const dir = seeded();
  for (const anchor of [landed, absent, anywhere]) {
    assert.equal(await gitGrepAnchorTrueAsync(dir, "main", anchor), gitGrepAnchorTrue(dir, "main", anchor), anchor.description);
  }
  assert.throws(() => gitGrepAnchorTrue(dir, "no-such-ref-at-all", anywhere));
  await assert.rejects(gitGrepAnchorTrueAsync(dir, "no-such-ref-at-all", anywhere), "an unresolvable ref is an error, never false");
});

test("an anchor grep past its bound is killed and fails as AnchorGrepTimeoutError", async () => {
  const { run, kills } = hungChild();
  await assert.rejects(gitGrepAnchorTrueAsync("/nowhere", "main", landed, 20, run), (err: unknown) => {
    assert.ok(err instanceof AnchorGrepTimeoutError);
    assert.match((err as Error).message, /exceeded its 20ms bound and was killed/);
    return true;
  });
  assert.deepEqual(kills, ["SIGTERM"]);
});

test("an anchor grep whose child answers at once arms no timer", async () => {
  const run = ((_f: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => {
    cb(null);
    return { kill: () => assert.fail("a finished grep is never killed") };
  }) as unknown as typeof execFile;
  // The default 120 s bound: an armed, un-cleared timer would hold this test open that long.
  assert.equal(await gitGrepAnchorTrueAsync("/nowhere", "main", landed, undefined, run), true);
});

test("warming the anchor cache keeps the event loop serving timers while greps are pending", async () => {
  const cache = createAnchorGrepCache();
  let ticks = 0;
  const timer = setInterval(() => void ticks++, 5);
  let inFlight = 0;
  let peak = 0;
  const greps: string[] = [];
  try {
    const failures = await warmAnchorGrepCache(cache, "sha1", [landed, absent, anywhere, landed], async (ref, anchor) => {
      greps.push(`${ref}:${anchor.description}`);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(40);
      inFlight--;
      return anchor !== absent;
    }, 2);
    assert.equal(failures.size, 0);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 4, `the loop ran ${ticks} timer ticks while three 40 ms greps were pending`);
  assert.deepEqual(greps.sort(), ["sha1:absent", "sha1:anywhere", "sha1:landed"], "one grep per distinct anchor, at the sha");
  assert.equal(peak, 2, "no more greps in flight than the concurrency allows");
  const sync = (): boolean => assert.fail("a warmed anchor never reaches the sync grep");
  assert.equal(warmedAnchorGrep(cache, "sha1", new Map(), landed, sync), true);
  assert.equal(warmedAnchorGrep(cache, "sha1", new Map(), absent, sync), false);
});

test("a failed warm grep is not cached and rethrows where the sync grep would have thrown", async () => {
  const cache = createAnchorGrepCache();
  const boom = new AnchorGrepTimeoutError(absent, 5);
  const failures = await warmAnchorGrepCache(cache, "sha1", [landed, absent], async (_ref, anchor) => {
    if (anchor === absent) throw boom;
    return true;
  });
  assert.equal(failures.size, 1);
  assert.equal(cache.results.size, 1, "only the answered anchor is cached");
  const sync = (): boolean => assert.fail("a failed anchor is not re-run synchronously on the loop");
  assert.throws(() => warmedAnchorGrep(cache, "sha1", failures, absent, sync), (err) => err === boom);
  assert.equal(warmedAnchorGrep(cache, "sha1", failures, landed, sync), true);
});

test("warming skips cached anchors, warms nothing without a sha, and resets on a new sha", async () => {
  const cache = createAnchorGrepCache();
  const seen: string[] = [];
  const grep = async (ref: string, anchor: EvidenceAnchor): Promise<boolean> => {
    seen.push(`${ref}:${anchor.description}`);
    return true;
  };
  assert.equal((await warmAnchorGrepCache(cache, undefined, [landed], grep)).size, 0);
  assert.deepEqual(seen, [], "no sha: nothing warmed, the uncached sync path is unchanged");
  await warmAnchorGrepCache(cache, "sha1", [landed], grep);
  await warmAnchorGrepCache(cache, "sha1", [landed], grep);
  assert.deepEqual(seen, ["sha1:landed"], "a cached anchor is not grepped again at the same sha");
  await warmAnchorGrepCache(cache, "sha2", [landed], grep);
  assert.deepEqual(seen, ["sha1:landed", "sha2:landed"]);
  assert.equal(cache.sha, "sha2");
});

test("warming stops storing answers at the cache backstop bound", async () => {
  const cache = createAnchorGrepCache();
  cache.sha = "sha1";
  for (let i = 0; i < ANCHOR_GREP_CACHE_MAX_ENTRIES - 1; i++) cache.results.set(`k${i}`, true);
  await warmAnchorGrepCache(cache, "sha1", [landed, absent], async () => true, 1);
  assert.equal(cache.results.size, ANCHOR_GREP_CACHE_MAX_ENTRIES - 1 + 1, "one answer fits under the bound, the other stays a miss");
});
