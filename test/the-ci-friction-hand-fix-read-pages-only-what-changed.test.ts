import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "#src/lib/clock.js";
import { readCiFrictionHandFixes } from "#src/lib/ci-friction-gardener.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const cacheFile = (state: string) => join(state, "ci-friction-hand-fixes.json");

/** A closed PR row; a hand fix when `merged` is given. */
function row(number: number, updated: string, merged?: string) {
  return { number, updated_at: updated, merged_at: merged ?? null, title: merged ? "fix: remedy" : "feat: new",
    head: { ref: merged ? "run-unfiled-1" : "run-W1-T1-1" }, merge_commit_sha: String(number % 10).repeat(40) };
}

/** Serves numbered pages and records every gh argv; git answers a fixed file list. */
function fakeGithub(pages: Record<number, unknown[]>, failPage?: number) {
  const calls: string[] = [];
  const run = (command: string, args: string[]): string => {
    if (command === "git") return "src/hand.ts\n";
    const page = Number(/&page=(\d+)/.exec(args.join(" "))?.[1]);
    calls.push(args.join(" "));
    if (page === failPage) throw new Error(`page ${page} unavailable`);
    return JSON.stringify(pages[page] ?? []);
  };
  return { run, calls };
}

const filler = (from: number, count: number, updated: string) => Array.from({ length: count }, (_, i) => row(from + i, updated));

/** One full read at `clock` that leaves a cache holding `rows`'s hand fixes and a cursor at their newest update. */
function seed(state: string, clockMs: number, rows: unknown[], main: string) {
  const github = fakeGithub({ 1: rows });
  const seeded = readCiFrictionHandFixes("/unused", state, "owner", "repo", fixedClock(clockMs), github.run, () => main);
  assert.equal(seeded.state, "observed");
  return JSON.parse(readFileSync(cacheFile(state), "utf8"));
}

function withState(body: (state: string) => void) {
  const state = mkdtempSync(join(tmpdir(), "rmd-hand-cursor-"));
  try { body(state); } finally { rmSync(state, { recursive: true, force: true }); }
}

test("W1-T9100: a read with a cursor stops at the cursor and merges into the cached fixes", () => {
  withState((state) => {
    const cache = seed(state, Date.parse("2026-10-20T12:00:00Z"), [row(10, "2026-10-20T10:00:00Z", "2026-10-20T09:00:00Z")], SHA_A);
    assert.equal(cache.cursor, "2026-10-20T10:00:00Z");
    const github = fakeGithub({
      1: [...filler(200, 99, "2026-10-20T13:00:00Z"), row(20, "2026-10-20T13:30:00Z", "2026-10-20T13:00:00Z")],
      2: [...filler(400, 99, "2026-10-20T10:30:00Z"), row(401, "2026-10-20T09:00:00Z")],
      3: filler(600, 100, "2026-10-19T00:00:00Z"),
    });
    const result = readCiFrictionHandFixes("/unused", state, "owner", "repo", fixedClock(Date.parse("2026-10-20T14:00:00Z")), github.run, () => SHA_B);
    assert.equal(github.calls.length, 2, "page 3 is older than the cursor and must not be read");
    assert.equal(result.state, "observed");
    assert.deepEqual(result.fixes.map((fix) => fix.pr), [10, 20]);
    const written = JSON.parse(readFileSync(cacheFile(state), "utf8"));
    assert.equal(written.cursor, "2026-10-20T13:30:00Z");
    assert.equal(written.mainSha, SHA_B);
  });
});

test("W1-T9100: an unchanged origin/main answers from the cache with no gh call", () => {
  withState((state) => {
    seed(state, Date.parse("2026-10-20T12:00:00Z"), [row(10, "2026-10-20T10:00:00Z", "2026-10-20T09:00:00Z")], SHA_A);
    const github = fakeGithub({});
    const before = readFileSync(cacheFile(state), "utf8");
    const result = readCiFrictionHandFixes("/unused", state, "owner", "repo", fixedClock(Date.parse("2026-10-21T12:00:00Z")), github.run, () => SHA_A);
    assert.equal(github.calls.length, 0);
    assert.equal(result.state, "observed");
    assert.equal(result.state === "observed" ? result.source : undefined, "cache");
    assert.deepEqual(result.fixes.map((fix) => fix.pr), [10]);
    assert.equal(readFileSync(cacheFile(state), "utf8"), before);
    const unreadable = readCiFrictionHandFixes("/unused", state, "owner", "repo", fixedClock(Date.parse("2026-10-21T12:00:00Z")), github.run, () => undefined);
    assert.equal(github.calls.length, 1, "an unreadable origin/main makes the read due, never skipped");
    assert.equal(unreadable.state, "observed");
  });
});

test("W1-T9100: merged fixes are pruned to the window", () => {
  withState((state) => {
    seed(state, Date.parse("2026-10-20T12:00:00Z"), [
      row(11, "2026-10-19T10:00:00Z", "2026-10-19T09:00:00Z"), row(10, "2026-10-18T10:00:00Z", "2026-10-07T00:00:00Z"),
    ], SHA_A);
    const cached = JSON.parse(readFileSync(cacheFile(state), "utf8"));
    assert.deepEqual(Object.keys(cached.byPr).sort(), ["10", "11"]);
    const github = fakeGithub({});
    const hit = readCiFrictionHandFixes("/unused", state, "owner", "repo", fixedClock(Date.parse("2026-10-22T00:00:00Z")), github.run, () => SHA_A);
    assert.equal(github.calls.length, 0);
    assert.deepEqual(hit.fixes.map((fix) => fix.pr), [11], "a cache hit prunes by merged_at at this pass's clock");
    const walked = readCiFrictionHandFixes("/unused", state, "owner", "repo", fixedClock(Date.parse("2026-10-22T00:00:00Z")), github.run, () => SHA_B);
    assert.deepEqual(walked.fixes.map((fix) => fix.pr), [11]);
    const written = JSON.parse(readFileSync(cacheFile(state), "utf8"));
    assert.deepEqual(written.fixes.map((fix: { pr: number }) => fix.pr), [11]);
    assert.deepEqual(Object.keys(written.byPr), ["11"], "the file lists are pruned with their fixes");
  });
});

test("W1-T9100: a cache with no cursor walks the window once and writes one", () => {
  withState((state) => {
    writeFileSync(cacheFile(state), JSON.stringify({ state: "observed", repository: "owner/repo", asOf: "2026-10-20T11:00:00.000Z",
      fixes: [{ pr: 5, at: "2026-10-19T00:00:00Z", files: ["src/old.ts"] }], byPr: {} }) + "\n");
    const github = fakeGithub({
      1: filler(200, 100, "2026-10-20T13:00:00Z"),
      2: [row(30, "2026-10-19T00:00:00Z", "2026-10-18T00:00:00Z")],
    });
    const result = readCiFrictionHandFixes("/unused", state, "owner", "repo", fixedClock(Date.parse("2026-10-20T14:00:00Z")), github.run, () => SHA_A);
    assert.equal(github.calls.length, 2, "no cursor means the whole window, to its short last page");
    assert.equal(result.state, "observed");
    assert.deepEqual(result.fixes.map((fix) => fix.pr), [30]);
    const written = JSON.parse(readFileSync(cacheFile(state), "utf8"));
    assert.equal(written.cursor, "2026-10-20T13:00:00Z");
    assert.equal(written.mainSha, SHA_A);
  });
});

test("W1-T9100: a failed page leaves the cursor where it was", () => {
  withState((state) => {
    seed(state, Date.parse("2026-10-20T12:00:00Z"), [row(10, "2026-10-20T10:00:00Z", "2026-10-20T09:00:00Z")], SHA_A);
    const before = readFileSync(cacheFile(state), "utf8");
    const github = fakeGithub({
      1: [...filler(200, 99, "2026-10-20T13:00:00Z"), row(20, "2026-10-20T13:30:00Z", "2026-10-20T13:00:00Z")],
      2: [row(300, "2026-10-20T10:30:00Z")],
    }, 2);
    const result = readCiFrictionHandFixes("/unused", state, "owner", "repo", fixedClock(Date.parse("2026-10-20T14:00:00Z")), github.run, () => SHA_B);
    assert.equal(result.state, "unmeasured");
    assert.match(result.state === "unmeasured" ? result.reason : "", /page 2 unavailable/);
    assert.equal(github.calls.length, 2);
    assert.equal(readFileSync(cacheFile(state), "utf8"), before);
    assert.equal(JSON.parse(before).cursor, "2026-10-20T10:00:00Z");
  });
});
