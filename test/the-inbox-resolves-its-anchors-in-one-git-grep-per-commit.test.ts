import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AnchorGrepTimeoutError,
  createAnchorGrepCache,
  gitGrepAnchorTrue,
  gitGrepAnchorTrueAsync,
  warmAnchorGrepCache,
  warmedAnchorGrep,
  type AnchorGrepExecFile,
  type EvidenceAnchor,
} from "../src/lib/inbox.js";
import { gitRepo } from "./helpers/git-repo.js";

const anchor = (pattern: string, path?: string): EvidenceAnchor => ({ description: pattern, pattern, path });
const syncFallback = (): boolean => assert.fail("a warmed answer must not spawn synchronously");

function fixture() {
  const repo = gitRepo({ kind: "batched-inbox-anchors" });
  writeFileSync(join(repo.dir, "one.txt"), "alpha\nfoo.bar\n(foo)+?{2}|\nword42\n");
  writeFileSync(join(repo.dir, "two.txt"), "beta\n");
  writeFileSync(join(repo.dir, "binary.txt"), "alpha\0binary\n");
  writeFileSync(join(repo.dir, "colon:\nfile.txt"), "odd filename\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "test: seed anchors");
  return repo;
}

function countingRun() {
  const calls: string[][] = [];
  const run = ((file: string, args: string[], options: object, callback: Parameters<typeof execFile>[3]) => {
    calls.push(args);
    return execFile(file, args, options, callback);
  }) as AnchorGrepExecFile;
  return { calls, run };
}

test("W1-T6277: uncached anchors on one commit are answered by a bounded number of git greps", async () => {
  const repo = fixture();
  const sha = repo.git("rev-parse", "HEAD");
  const anchors = Array.from({ length: 120 }, (_, i) => anchor(i % 2 ? `absent-${i}` : "alpha", i % 3 === 0 ? undefined : i % 3 === 1 ? "one.txt" : "two.txt"));
  const { calls, run } = countingRun();
  const cache = createAnchorGrepCache();
  const grep = (ref: string, a: EvidenceAnchor) => gitGrepAnchorTrueAsync(repo.dir, ref, a, undefined, run);
  const failures = await warmAnchorGrepCache(cache, sha, anchors, grep);
  assert.equal(failures.size, 0);
  assert.equal(calls.length, 3, "one child per path group, independent of the number of anchors");
  for (const a of anchors) assert.equal(warmedAnchorGrep(cache, sha, failures, a, syncFallback), gitGrepAnchorTrue(repo.dir, sha, a));
  await warmAnchorGrepCache(cache, sha, anchors, grep);
  assert.equal(calls.length, 3, "the same commit uses the cache");
  writeFileSync(join(repo.dir, "one.txt"), "changed\n");
  repo.git("add", "one.txt");
  repo.git("commit", "-qm", "test: change anchors");
  const nextSha = repo.git("rev-parse", "HEAD");
  const nextFailures = await warmAnchorGrepCache(cache, nextSha, anchors, grep);
  assert.equal(calls.length, 6, "a new commit warms each group again");
  assert.equal(warmedAnchorGrep(cache, nextSha, nextFailures, anchor("alpha", "one.txt"), syncFallback), false);
});

test("W1-T6277: batched anchor answers match the one-grep-per-anchor answers", async () => {
  const repo = fixture();
  const sha = repo.git("rev-parse", "HEAD");
  const anchors = [
    anchor("alpha"), anchor("beta"), anchor("absent"), anchor("alpha", "two.txt"),
    anchor("alpha", "one.txt"), anchor("absent", "one.txt"), anchor("^alpha$", "one.txt"),
    anchor("foo.bar", "one.txt"), anchor("(foo)+?{2}|", "one.txt"),
    anchor("word[[:digit:]]*", "one.txt"), anchor("foo\\.bar", "one.txt"),
    anchor("alpha\\|beta"), anchor("word\\([0-9]\\{2\\}\\)", "one.txt"),
    anchor("alpha", "binary.txt"), anchor("odd filename", "colon:\nfile.txt"),
    anchor("beta", "*.txt"), anchor("alpha", ":(exclude)one.txt"), anchor("1"), anchor(""),
  ];
  const expected = anchors.map((a) => gitGrepAnchorTrue(repo.dir, sha, a));
  repo.git("config", "grep.lineNumber", "true");
  repo.git("config", "grep.column", "true");
  writeFileSync(join(repo.dir, "one.txt"), "working tree differs from the commit\n");
  const { calls, run } = countingRun();
  const cache = createAnchorGrepCache();
  const failures = await warmAnchorGrepCache(cache, sha, anchors, (ref, a) => gitGrepAnchorTrueAsync(repo.dir, ref, a, undefined, run));
  assert.equal(failures.size, 0);
  assert.deepEqual(anchors.map((a) => warmedAnchorGrep(cache, sha, failures, a, syncFallback)), expected);
  assert.ok(calls.length < anchors.length, "equivalent answers are actually batched");
});

test("batch failures rethrow by anchor and are retried without caching an answer", async () => {
  const anchors = [anchor("alpha"), anchor("beta")];
  const boom = Object.assign(new Error("git rejected the ref"), { code: 128 });
  let calls = 0;
  const run = ((_file: string, _args: string[], _options: object, cb: (err: Error | null, stdout: string) => void) => {
    calls++;
    cb(boom, "");
    return { kill: () => assert.fail("finished child") };
  }) as unknown as AnchorGrepExecFile;
  const cache = createAnchorGrepCache();
  const grep = (ref: string, a: EvidenceAnchor) => gitGrepAnchorTrueAsync("/unused", ref, a, undefined, run);
  for (let pass = 0; pass < 2; pass++) {
    const failures = await warmAnchorGrepCache(cache, "sha", anchors, grep);
    assert.equal(failures.size, 2);
    assert.equal(cache.results.size, 0);
    for (const a of anchors) assert.throws(() => warmedAnchorGrep(cache, "sha", failures, a, syncFallback), (err) => err === boom);
  }
  assert.equal(calls, 2);
});

test("a batch timeout keeps each anchor's named timeout and kills its shared child", async () => {
  const anchors = [anchor("alpha"), anchor("beta")];
  const kills: string[] = [];
  const run = ((_file: string, _args: string[], _options: object, cb: (err: Error) => void) => {
    const child = { exitCode: null, signalCode: null as string | null, kill(signal: string) {
      kills.push(signal);
      child.signalCode = signal;
      setImmediate(() => cb(new Error("killed")));
      return true;
    } };
    return child;
  }) as unknown as AnchorGrepExecFile;
  const cache = createAnchorGrepCache();
  const failures = await warmAnchorGrepCache(cache, "sha", anchors, (ref, a) => gitGrepAnchorTrueAsync("/unused", ref, a, 5, run));
  assert.equal(cache.results.size, 0);
  for (const a of anchors) assert.throws(() => warmedAnchorGrep(cache, "sha", failures, a, syncFallback), (err) => err instanceof AnchorGrepTimeoutError && err.anchor === a && err.timeoutMs === 5);
  assert.deepEqual(kills, ["SIGTERM"]);
});

test("the default adapter batches real Git and an invalid regex cannot poison valid anchors", async () => {
  const repo = fixture();
  const sha = repo.git("rev-parse", "HEAD");
  const anchors = [anchor("alpha"), anchor("beta"), anchor("[")];
  const cache = createAnchorGrepCache();
  const failures = await warmAnchorGrepCache(cache, sha, anchors, (ref, a) => gitGrepAnchorTrueAsync(repo.dir, ref, a));
  assert.equal(failures.size, 1);
  assert.equal(cache.results.size, 2);
  assert.equal(warmedAnchorGrep(cache, sha, failures, anchors[0], syncFallback), true);
  assert.equal(warmedAnchorGrep(cache, sha, failures, anchors[1], syncFallback), true);
  assert.throws(() => warmedAnchorGrep(cache, sha, failures, anchors[2], syncFallback));
  const unknownRef = await warmAnchorGrepCache(cache, "missing-ref", anchors.slice(0, 2), (ref, a) => gitGrepAnchorTrueAsync(repo.dir, ref, a));
  assert.equal(unknownRef.size, 2);
  assert.equal(cache.results.size, 0);
});

test("batch no-match and spawn failures keep distinct outcomes", async () => {
  const anchors = [anchor("alpha"), anchor("beta")];
  for (const error of [Object.assign(new Error("no match"), { code: 1 }), Object.assign(new Error("cannot spawn"), { code: "ENOENT" })]) {
    let calls = 0;
    const run = ((_file: string, _args: string[], _options: object, cb: (err: Error, stdout: string) => void) => {
      calls++;
      if (error.code === "ENOENT") throw error;
      cb(error, "");
      return { kill: () => assert.fail("finished child") };
    }) as unknown as AnchorGrepExecFile;
    const cache = createAnchorGrepCache();
    const failures = await warmAnchorGrepCache(cache, "sha", anchors, (ref, a) => gitGrepAnchorTrueAsync("/unused", ref, a, undefined, run));
    assert.equal(calls, 1);
    if (error.code === 1) {
      assert.equal(failures.size, 0);
      for (const a of anchors) assert.equal(warmedAnchorGrep(cache, "sha", failures, a, syncFallback), false);
    } else {
      assert.equal(cache.results.size, 0);
      for (const a of anchors) assert.throws(() => warmedAnchorGrep(cache, "sha", failures, a, syncFallback), (err) => err === error);
    }
  }
});

test("path groups respect warm concurrency and overlapping passes keep independent batches", async () => {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const run = ((_file: string, _args: string[], _options: object, cb: (err: null, stdout: string) => void) => {
    calls++;
    peak = Math.max(peak, ++inFlight);
    setTimeout(() => { inFlight--; cb(null, "alpha beta\n"); }, 5);
    return { kill: () => assert.fail("finished before the timeout") };
  }) as unknown as AnchorGrepExecFile;
  const anchors = ["alpha", "beta"].flatMap((pattern) => Array.from({ length: 10 }, (_, i) => anchor(pattern, `path-${i}`)));
  const grep = (ref: string, a: EvidenceAnchor) => gitGrepAnchorTrueAsync("/unused", ref, a, undefined, run);
  const cache = createAnchorGrepCache();
  const failures = await warmAnchorGrepCache(cache, "sha", anchors, grep, 2);
  assert.equal(calls, 10);
  assert.equal(peak, 2);
  assert.equal(failures.size, 0);
  assert.equal(cache.results.size, 20);
  const first = createAnchorGrepCache();
  const second = createAnchorGrepCache();
  await Promise.all([
    warmAnchorGrepCache(first, "first", [anchors[0], anchors[10]], grep),
    warmAnchorGrepCache(second, "second", [anchors[0], anchors[10]], grep),
  ]);
  assert.equal(calls, 12);
  assert.equal(first.sha, "first");
  assert.equal(second.sha, "second");
  assert.equal(first.results.size, 2);
  assert.equal(second.results.size, 2);
});
