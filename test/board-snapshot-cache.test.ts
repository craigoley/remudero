import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  boardObservationPath,
  boardOpenSnapshotPath,
  boardSnapshotPath,
  createBoardSnapshotCache,
  createBoardSnapshotReader,
  type BoardSnapshotIo,
} from "../src/lib/board-snapshot-cache.js";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import { buildBatchedGithub } from "../src/lib/status.js";
import { BOARD_MAX_PAGES, type BoardIssueRest, type BoardPrRest } from "../src/lib/open-prs-rest.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
// @source-text-subject: this file pins WHERE the daemon verb's wiring lives in source; the verb moved from src/run-task.ts to src/cli/commands/daemon.ts (W1-T9333), so it reads both.

function root(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}board-snapshot-`));
}

function closed(number: number, updatedAt = `2026-09-05T00:${String(number % 60).padStart(2, "0")}:00Z`): BoardPrRest {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    state: "MERGED",
    headRefName: `run-W1-T${number}-1700000000000`,
    headRefOid: `sha-${number}`,
    body: `Remudero-Task: W1-T${number}`,
    autoMergeRequest: { enabledAt: "mutable-and-must-not-be-persisted" },
    title: `merged ${number}`,
    updatedAt,
  };
}

function issue(number: number, updatedAt = `2026-09-05T01:${String(number % 60).padStart(2, "0")}:00Z`): BoardIssueRest {
  return {
    number,
    url: `https://github.com/o/r/issues/${number}`,
    state: "open",
    title: `needs human ${number}`,
    updatedAt,
  };
}

function restPr(row: BoardPrRest) {
  return {
    number: row.number,
    html_url: row.url,
    state: row.state === "OPEN" ? "open" : "closed",
    merged_at: row.state === "MERGED" ? row.updatedAt : null,
    body: row.body,
    title: row.title,
    updated_at: row.updatedAt,
    head: { ref: row.headRefName, sha: row.headRefOid },
    auto_merge: row.autoMergeRequest,
  };
}

function restIssue(row: BoardIssueRest) {
  return {
    number: row.number,
    html_url: row.url,
    state: row.state,
    title: row.title,
    updated_at: row.updatedAt,
  };
}

function diskClosed(row = closed(1)): Omit<BoardPrRest, "autoMergeRequest"> {
  const { autoMergeRequest: _omitted, ...disk } = row;
  return disk;
}

function snapshotLines(
  records: unknown[] = [],
  channels = { closed: { complete: true, count: 0 }, issues: { complete: true, count: 0 } },
  counts = { closed: 0, issues: 0 },
): string {
  const header = { type: "board-snapshot", schema: 1, repository: "o/r", channels };
  const footer = { type: "complete", schema: 1, repository: "o/r", counts };
  return [header, ...records, footer].map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function pageOf(args: string[]): number {
  return Number(/[?&]page=(\d+)/.exec(args[1] ?? "")?.[1] ?? "1");
}

function perPageOf(args: string[]): number {
  return Number(/[?&]per_page=(\d+)/.exec(args[1] ?? "")?.[1] ?? "100");
}

function pagingExec(
  remote: { open: BoardPrRest[]; closed: BoardPrRest[]; issues: BoardIssueRest[] },
  calls: string[][],
): (args: string[]) => string {
  return (args) => {
    calls.push(args);
    const url = args[1] ?? "";
    const page = pageOf(args);
    const perPage = perPageOf(args);
    const start = (page - 1) * perPage;
    if (/\/pulls\?state=open/.test(url)) return JSON.stringify(remote.open.slice(start, start + perPage).map(restPr));
    if (/\/pulls\?state=closed/.test(url)) return JSON.stringify(remote.closed.slice(start, start + perPage).map(restPr));
    if (/\/issues\?labels=/.test(url)) return JSON.stringify(remote.issues.slice(start, start + perPage).map(restIssue));
    return "[]";
  };
}

function count(calls: string[][], pattern: RegExp): number {
  return calls.filter((args) => pattern.test(args[1] ?? "")).length;
}

test("a durable complete seed turns a new process gateway's first closed and issue reads into one-call deltas", () => {
  const dir = root();
  try {
    const remote = {
      open: [{ ...closed(9001), state: "OPEN", autoMergeRequest: { enabledAt: "live" }, title: "live open row" }],
      closed: Array.from({ length: 130 }, (_, i) => closed(8000 - i, new Date(Date.UTC(2026, 8, 5) - i * 60_000).toISOString())),
      issues: Array.from({ length: 130 }, (_, i) => issue(7000 - i, new Date(Date.UTC(2026, 8, 4) - i * 60_000).toISOString())),
    };
    const coldCalls: string[][] = [];
    const firstCache = createBoardSnapshotCache(dir, "o", "r");
    const coldGateway = buildBatchedGithub("o", "r", {
      exec: pagingExec(remote, coldCalls),
      snapshotCache: firstCache,
    });

    assert.equal(coldGateway.listMergedHeadBranches!()?.length, 130);
    assert.deepEqual(coldGateway.issueByUrl!(remote.issues[129]!.url), { state: "open", title: remote.issues[129]!.title });
    assert.equal(count(coldCalls, /state=closed/), 2, "the first closed walk is cold");
    assert.equal(count(coldCalls, /\/issues\?labels=/), 2, "the first issue walk is cold");

    const siblingCalls: string[][] = [];
    const siblingGateway = buildBatchedGithub("o", "r", { exec: pagingExec(remote, siblingCalls), snapshotCache: firstCache });
    siblingGateway.listMergedHeadBranches!();
    siblingGateway.issueByUrl!(remote.issues[129]!.url);
    assert.equal(count(siblingCalls, /state=closed/), 1, "a second gateway in the process receives the shared closed seed");
    assert.equal(count(siblingCalls, /\/issues\?labels=/), 1, "a second gateway in the process receives the shared issue seed");

    const disk = readFileSync(boardSnapshotPath(dir, "o", "r"), "utf8");
    assert.doesNotMatch(disk, /live open row|9001|mutable-and-must-not-be-persisted|autoMergeRequest/);

    remote.open = [{ ...remote.open[0]!, number: 9002, url: "https://github.com/o/r/pull/9002", headRefName: "run-W1-T9002-1700000000000" }];
    const warmCalls: string[][] = [];
    const replacementProcessCache = createBoardSnapshotCache(dir, "o", "r");
    const replacementGateway = buildBatchedGithub("o", "r", {
      exec: pagingExec(remote, warmCalls),
      snapshotCache: replacementProcessCache,
    });
    assert.equal(replacementGateway.listMergedHeadBranches!()?.length, 130);
    assert.deepEqual(replacementGateway.issueByUrl!(remote.issues[129]!.url), { state: "open", title: remote.issues[129]!.title });
    assert.equal(count(warmCalls, /state=closed/), 1, "the first closed read after restart is a delta");
    assert.equal(count(warmCalls, /\/issues\?labels=/), 1, "the first issue read after restart is a delta");
    assert.ok(warmCalls.filter((args) => /state=closed|\/issues\?labels=/.test(args[1] ?? "")).every((args) => /per_page=30/.test(args[1] ?? "")));

    assert.deepEqual(replacementGateway.listOpenHeadBranches!()?.map((row) => row.number), [9002]);
    assert.equal(count(warmCalls, /state=open/), 1, "open rows are fetched live on the first due read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing, malformed, partial, oversized, wrong-repository, and future snapshots are absent seeds with bounded reason telemetry", () => {
  const cases: Array<{ name: string; content?: string; bounds?: { maxBytes?: number }; reason: string }> = [
    { name: "missing", reason: "missing" },
    { name: "malformed", content: "not-json\n", reason: "invalid_json" },
    {
      name: "partial",
      content: `${JSON.stringify({ type: "board-snapshot", schema: 1, repository: "o/r", channels: { closed: { complete: true, count: 0 }, issues: { complete: false, count: 0 } } })}\n`,
      reason: "partial",
    },
    { name: "oversized", content: "123456789\n", bounds: { maxBytes: 4 }, reason: "oversized" },
    {
      name: "wrong repository",
      content: `${JSON.stringify({ type: "board-snapshot", schema: 1, repository: "other/repo", channels: { closed: { complete: true, count: 0 }, issues: { complete: true, count: 0 } } })}\n${JSON.stringify({ type: "complete", schema: 1, repository: "other/repo", counts: { closed: 0, issues: 0 } })}\n`,
      reason: "wrong_repository",
    },
    {
      name: "future schema",
      content: `${JSON.stringify({ type: "board-snapshot", schema: 2, repository: "o/r", channels: { closed: { complete: true, count: 0 }, issues: { complete: true, count: 0 } } })}\n`,
      reason: "future_version",
    },
  ];

  for (const fixture of cases) {
    const dir = root();
    try {
      if (fixture.content !== undefined) {
        const path = boardSnapshotPath(dir, "o", "r");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, fixture.content);
      }
      const telemetry: Array<{ event: string; extra?: Record<string, unknown> }> = [];
      const cache = createBoardSnapshotCache(dir, "o", "r", {
        bounds: fixture.bounds,
        log: (event, extra) => telemetry.push({ event, extra }),
      });
      assert.equal(cache.closedSeed(), undefined, `${fixture.name}: a refusal is not an empty authoritative map`);
      assert.equal(cache.issueSeed(), undefined, `${fixture.name}: issue seed is absent too`);
      assert.equal(telemetry.at(-1)?.event, "board_snapshot.load_refused", fixture.name);
      assert.equal(telemetry.at(-1)?.extra?.reason, fixture.reason, fixture.name);
      assert.deepEqual(Object.keys(telemetry.at(-1)?.extra ?? {}).sort(), ["bytes", "channel", "reason", "repository", "rows", "schema"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("every bounded parser and I/O refusal preserves an absent or last-good seed", () => {
  const loadCases: Array<{
    name: string;
    content: string;
    reason: string;
    bounds?: { maxBytes?: number; maxRows?: number; maxLineBytes?: number };
    io?: (base: BoardSnapshotIo) => Partial<BoardSnapshotIo>;
  }> = [
    { name: "invalid header", content: "null\n", reason: "invalid_schema" },
    { name: "invalid channel", content: snapshotLines([], { closed: { complete: true, count: -1 }, issues: { complete: true, count: 0 } }), reason: "invalid_schema" },
    { name: "incomplete non-empty channel", content: snapshotLines([], { closed: { complete: false, count: 1 }, issues: { complete: true, count: 0 } }), reason: "invalid_schema" },
    { name: "declared row limit", content: snapshotLines([], { closed: { complete: true, count: 2 }, issues: { complete: true, count: 0 } }, { closed: 2, issues: 0 }), bounds: { maxRows: 1 }, reason: "row_limit" },
    { name: "invalid footer", content: snapshotLines().replace('"type":"complete","schema":1', '"type":"complete","schema":0'), reason: "partial" },
    { name: "extra after footer", content: `${snapshotLines()}${JSON.stringify({ type: "issues", row: issue(1) })}\n`, reason: "partial" },
    { name: "unknown record", content: snapshotLines([{ type: "unknown", row: {} }]), reason: "invalid_row" },
    { name: "closed record in absent channel", content: snapshotLines([{ type: "closed", row: diskClosed() }], { closed: { complete: false, count: 0 }, issues: { complete: true, count: 0 } }), reason: "invalid_row" },
    { name: "invalid issue row", content: snapshotLines([{ type: "issues", row: { ...issue(1), number: -1 } }], { closed: { complete: true, count: 0 }, issues: { complete: true, count: 1 } }, { closed: 0, issues: 1 }), reason: "invalid_row" },
    { name: "duplicate closed row", content: snapshotLines([{ type: "closed", row: diskClosed() }, { type: "closed", row: diskClosed() }], { closed: { complete: true, count: 2 }, issues: { complete: true, count: 0 } }, { closed: 2, issues: 0 }), reason: "duplicate_row" },
    { name: "count mismatch", content: snapshotLines([{ type: "closed", row: diskClosed() }], { closed: { complete: true, count: 2 }, issues: { complete: true, count: 0 } }, { closed: 2, issues: 0 }), reason: "count_mismatch" },
    { name: "unterminated line", content: snapshotLines().slice(0, -1), reason: "partial" },
    { name: "line too large", content: "12345678901", bounds: { maxBytes: 20, maxLineBytes: 10 }, reason: "line_too_large" },
    { name: "not a file", content: snapshotLines(), reason: "not_file", io: () => ({ stat: () => ({ size: 1, isFile: false }) }) },
    { name: "invalid stat size", content: snapshotLines(), reason: "oversized", io: () => ({ stat: () => ({ size: Number.NaN, isFile: true }) }) },
    { name: "open failure", content: snapshotLines(), reason: "open_failed", io: () => ({ openRead: () => { throw new Error("open failed"); } }) },
    { name: "read failure", content: snapshotLines(), reason: "read_failed", io: () => ({ read: () => { throw new Error("read failed"); } }) },
    { name: "invalid read count", content: snapshotLines(), reason: "read_failed", io: () => ({ read: (_fd, _buffer, _offset, length) => length + 1 }) },
  ];

  for (const fixture of loadCases) {
    const dir = root();
    try {
      const path = boardSnapshotPath(dir, "o", "r");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, fixture.content);
      const telemetry: Array<{ event: string; extra?: Record<string, unknown> }> = [];
      const base = realIo();
      const cache = createBoardSnapshotCache(dir, "o", "r", {
        bounds: fixture.bounds,
        io: realIo(fixture.io?.(base)),
        log: (event, extra) => telemetry.push({ event, extra }),
      });
      assert.equal(cache.closedSeed(), undefined, fixture.name);
      assert.equal(telemetry.at(-1)?.extra?.reason, fixture.reason, fixture.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const dir = root();
  try {
    const cache = createBoardSnapshotCache(dir, "o", "r", { bounds: { maxRows: 1 } });
    assert.equal(cache.commitClosed([closed(1), closed(2)]), false);
    assert.equal(cache.commitClosed([{ ...closed(1), state: "OPEN" }]), false);
    assert.equal(cache.commitClosed([closed(1), { ...closed(1), title: "duplicate" }]), false);
    assert.equal(cache.commitIssues([{ ...issue(1), number: -1 }]), false);
    assert.equal(cache.commitIssues([issue(1), { ...issue(1), title: "duplicate" }]), false);

    const base = realIo();
    let partialWrites = 0;
    const partial = createBoardSnapshotCache(join(dir, "partial"), "o", "r", {
      io: realIo({
        write(fd, buffer, offset, length) {
          partialWrites += 1;
          return base.write(fd, buffer, offset, Math.min(2, length));
        },
      }),
    });
    assert.equal(partial.commitClosed([closed(3)]), true);
    assert.ok(partialWrites > 3, "writeFully retries short writes");

    const failedCleanup = createBoardSnapshotCache(join(dir, "failed-cleanup"), "o", "r", {
      io: realIo({ write: () => 0, close: () => { throw new Error("close failed"); }, unlink: () => { throw new Error("unlink failed"); } }),
    });
    assert.equal(failedCleanup.commitClosed([closed(4)]), false);

    const tooLarge = createBoardSnapshotCache(join(dir, "too-large"), "o", "r", { bounds: { maxBytes: 100 } });
    assert.equal(tooLarge.commitClosed([closed(5)]), false);

    const occupiedTargetRoot = join(dir, "occupied-target");
    const occupiedTarget = boardSnapshotPath(occupiedTargetRoot, "o", "r");
    mkdirSync(occupiedTarget, { recursive: true });
    const occupied = createBoardSnapshotCache(occupiedTargetRoot, "o", "r");
    assert.equal(occupied.commitClosed([closed(6)]), false, "a default-I/O rename refusal cleans up its stage");
    assert.deepEqual(fs.readdirSync(dirname(occupiedTarget)), [basename(occupiedTarget)]);
    assert.match(boardSnapshotPath(dir, "", ""), /\/_-[0-9a-f]{16}\.ndjson$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function realIo(overrides: Partial<BoardSnapshotIo> = {}): BoardSnapshotIo {
  return {
    stat(path) {
      const st = fs.statSync(path);
      return { size: st.size, isFile: st.isFile() };
    },
    mkdir: (path, mode) => fs.mkdirSync(path, { recursive: true, mode }),
    openRead: (path) => fs.openSync(path, "r"),
    openWrite: (path, mode) => fs.openSync(path, "wx", mode),
    read: (fd, buffer, offset, length) => fs.readSync(fd, buffer, offset, length, null),
    write: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length),
    fsync: (fd) => fs.fsyncSync(fd),
    close: (fd) => fs.closeSync(fd),
    rename: (from, to) => fs.renameSync(from, to),
    unlink: (path) => fs.unlinkSync(path),
    ...overrides,
  };
}

test("replaced snapshot observation cleanup preserves failed writes and refuses cleanup failures", () => {
  const dir = root();
  const T0 = Date.parse("2026-10-01T00:00:00.000Z");
  const MIN = 60_000;
  try {
    const rows = [closed(1)];
    assert.equal(createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0) }).commitClosed(rows), true);
    assert.equal(createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0 + 10 * MIN) }).commitClosed(rows), true);
    const sidecar = boardObservationPath(dir, "o", "r");
    const before = readFileSync(sidecar, "utf8");
    const failed = createBoardSnapshotCache(dir, "o", "r", {
      clock: fixedClock(T0 + 20 * MIN),
      io: realIo({ rename: () => { throw new Error("replace refused"); } }),
    });
    assert.equal(failed.commitClosed([closed(1), closed(2)]), false);
    assert.equal(readFileSync(sidecar, "utf8"), before, "failed publication preserves the last valid observation");
    const events: Array<{ event: string; reason: unknown }> = [];
    const cleanupFailed = createBoardSnapshotCache(dir, "o", "r", {
      clock: fixedClock(T0 + 20 * MIN),
      io: realIo({ unlink: (path) => {
        if (path === sidecar) throw new Error("unlink refused");
        fs.unlinkSync(path);
      } }),
    });
    assert.equal(cleanupFailed.commitClosed([closed(1), closed(2)]), true);
    assert.equal(readFileSync(sidecar, "utf8"), before);
    const restarted = createBoardSnapshotCache(dir, "o", "r", {
      clock: fixedClock(T0 + 30 * MIN), log: (event, extra) => events.push({ event, reason: extra?.reason }),
    });
    assert.equal(restarted.rows!().closed?.size, 2, "published data remains available");
    assert.equal(restarted.rows!().closedObservedAt, new Date(T0 + 20 * MIN).toISOString());
    assert.deepEqual(events.filter((row) => row.event === "board_snapshot.observation_refused"),
      [{ event: "board_snapshot.observation_refused", reason: "foreign_snapshot" }], "cleanup failure does not hide the identity refusal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed atomic replace preserves both the in-process and crash-recovery last-good seed", () => {
  const dir = root();
  try {
    const initial = [closed(1)];
    const cache = createBoardSnapshotCache(dir, "o", "r");
    assert.equal(cache.commitClosed(initial), true);
    const finalPath = boardSnapshotPath(dir, "o", "r");
    const before = readFileSync(finalPath, "utf8");

    const failing = createBoardSnapshotCache(dir, "o", "r", {
      io: realIo({ rename: () => { throw new Error("simulated replace failure"); } }),
    });
    assert.equal(failing.commitClosed([closed(2)]), false);
    assert.deepEqual([...failing.closedSeed()!.keys()], [1], "failed write does not publish an uncommitted in-process seed");
    assert.equal(readFileSync(finalPath, "utf8"), before, "atomic replace leaves the old complete file untouched");
    assert.deepEqual([...createBoardSnapshotCache(dir, "o", "r").closedSeed()!.keys()], [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("truncated and failed GitHub reads cannot replace the last complete on-disk seed", () => {
  const dir = root();
  try {
    const initial = [closed(1)];
    const cache = createBoardSnapshotCache(dir, "o", "r");
    assert.equal(cache.commitClosed(initial), true);
    const finalPath = boardSnapshotPath(dir, "o", "r");
    const before = readFileSync(finalPath, "utf8");

    const changed = Array.from({ length: BOARD_MAX_PAGES * 30 }, (_, i) => closed(10_000 - i, new Date(Date.UTC(2026, 8, 6) - i * 60_000).toISOString()));
    const calls: string[][] = [];
    const truncated = buildBatchedGithub("o", "r", {
      snapshotCache: cache,
      exec: pagingExec({ open: [], closed: changed, issues: [] }, calls),
    });
    truncated.listMergedHeadBranches!();
    assert.equal(count(calls, /state=closed/), BOARD_MAX_PAGES, "the fixture reaches the real truncation ceiling");
    assert.equal(truncated.readTruncated?.(), true);
    assert.equal(readFileSync(finalPath, "utf8"), before, "a truncated fetch is not committed");

    const failed = buildBatchedGithub("o", "r", {
      snapshotCache: cache,
      exec: (args) => {
        if (/state=closed/.test(args[1] ?? "")) throw new Error("simulated GitHub failure");
        return "[]";
      },
    });
    failed.listMergedHeadBranches!();
    assert.equal(readFileSync(finalPath, "utf8"), before, "a failed fetch is not committed");
    assert.deepEqual([...createBoardSnapshotCache(dir, "o", "r").closedSeed()!.keys()], [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot I/O is bounded and streaming, uses a same-directory atomic 0600 stage, and logs metadata only", () => {
  const dir = root();
  try {
    const readLengths: number[] = [];
    const writeLengths: number[] = [];
    const openModes: number[] = [];
    const renames: Array<[string, string]> = [];
    const telemetry: Array<{ event: string; extra?: Record<string, unknown> }> = [];
    const base = realIo();
    const io = realIo({
      openWrite(path, mode) {
        openModes.push(mode);
        return base.openWrite(path, mode);
      },
      read(fd, buffer, offset, length) {
        readLengths.push(length);
        return base.read(fd, buffer, offset, length);
      },
      write(fd, buffer, offset, length) {
        writeLengths.push(length);
        return base.write(fd, buffer, offset, length);
      },
      rename(from, to) {
        renames.push([from, to]);
        base.rename(from, to);
      },
    });
    const cache = createBoardSnapshotCache(dir, "o", "r", { io, log: (event, extra) => telemetry.push({ event, extra }) });
    assert.equal(cache.commitClosed(Array.from({ length: 200 }, (_, i) => closed(i + 1))), true);
    assert.ok(writeLengths.length > 200, "records are written line-by-line rather than as one aggregate buffer");
    assert.ok(writeLengths.every((length) => length <= 512 * 1024));
    assert.deepEqual(openModes, [0o600]);
    assert.equal(renames.length, 1);
    assert.equal(dirname(renames[0]![0]), dirname(renames[0]![1]), "stage and final live on one filesystem directory");
    const writesAfterCommit = writeLengths.length;
    assert.equal(cache.commitClosed([...cache.closedSeed()!.values()]), true);
    assert.equal(writeLengths.length, writesAfterCommit, "an unchanged delta does not churn the disposable snapshot on disk");

    const reloaded = createBoardSnapshotCache(dir, "o", "r", { io, log: (event, extra) => telemetry.push({ event, extra }) });
    assert.equal(reloaded.closedSeed()?.size, 200);
    assert.ok(readLengths.length > 0 && readLengths.every((length) => length <= 64 * 1024));
    for (const row of telemetry) {
      assert.ok(
        Object.keys(row.extra ?? {}).every((key) => ["bytes", "channel", "reason", "repository", "rows", "schema"].includes(key)),
        `telemetry contains only bounded metadata: ${JSON.stringify(row.extra)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real background prewarm worker lands successful closed and issue results through the snapshot commit path", async () => {
  const dir = root();
  try {
    const ghBin = join(dir, "fake-gh");
    writeFileSync(
      ghBin,
      `#!/bin/sh
case "$*" in
  *"/issues?"*) echo '[{"number":7,"html_url":"https://github.com/o/r/issues/7","state":"open","title":"needs human","updated_at":"2026-09-05T00:00:00Z"}]' ;;
  *"state=closed"*) echo '[{"number":8,"html_url":"https://github.com/o/r/pull/8","state":"closed","merged_at":"2026-09-05T00:00:00Z","body":"Remudero-Task: W1-T8","title":"merged","updated_at":"2026-09-05T00:00:00Z","head":{"ref":"run-W1-T8-1","sha":"abc"},"auto_merge":null}]' ;;
  *) echo '[]' ;;
esac
`,
    );
    chmodSync(ghBin, 0o755);
    const cache = createBoardSnapshotCache(dir, "o", "r");
    const gateway = buildBatchedGithub("o", "r", { ghBin, snapshotCache: cache });
    gateway.warm!();
    const deadline = Date.now() + 5_000;
    while (gateway.readState?.() === "in_flight") {
      if (Date.now() >= deadline) assert.fail("background prewarm did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const recovered = createBoardSnapshotCache(dir, "o", "r");
    assert.deepEqual([...recovered.closedSeed()!.keys()], [8]);
    assert.deepEqual([...recovered.issueSeed()!.keys()], [7]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production daemon and Serve composition roots construct and pass the shared snapshot cache", () => {
  const source = readFileSync(join(process.cwd(), "src", "cli", "commands", "daemon.ts"), "utf8") + "\n" + readFileSync(join(process.cwd(), "src", "run-task.ts"), "utf8");
  assert.ok(/createBoardSnapshotCache\(/.test(source), "the module is constructed outside its unit test");
  assert.ok(/snapshotCache:\s*boardSnapshotFor\(|snapshotFor:\s*boardSnapshotFor\b/.test(source), "daemon projection and lane gateways receive the per-repo shared cache");
  assert.ok(/buildSweepHook\([\s\S]*?boardSnapshotFor\(target\.owner, target\.repo\)/.test(source), "the full sweep gateway receives the same daemon cache");
  assert.ok(/const serveBoardSnapshot = createBoardSnapshotCache\([\s\S]*?snapshotCache:\s*serveBoardSnapshot/.test(source), "Serve uses the same state namespace");
});

// W1-T8912: a successful unchanged closed read persists WHEN it was seen, bound to the exact data file it saw.
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();

function steppedClock(start: number): { clock: Clock; set(ms: number): void } {
  let ms = start;
  return { clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() }, set: (next) => { ms = next; } };
}

function physical(path: string): { bytes: string; mtimeMs: number; ino: number } {
  const st = fs.statSync(path);
  return { bytes: readFileSync(path, "utf8"), mtimeMs: st.mtimeMs, ino: st.ino };
}

function observed(dir: string, owner = "o", repo = "r", clock = fixedClock(T0 + 24 * 60 * MIN)) {
  const telemetry: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const cache = createBoardSnapshotCache(dir, owner, repo, { clock, log: (event, extra) => telemetry.push({ event, extra }) });
  const refusal = telemetry.find((row) => row.event === "board_snapshot.observation_refused")?.extra?.reason;
  return { at: cache.rows!().closedObservedAt, refusal, cache };
}

test("W1-T8912: unchanged PR observations survive restart without rewriting history", () => {
  const dir = root();
  try {
    const rows = [closed(1), closed(2)];
    assert.equal(createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0) }).commitClosed(rows), true);
    const dataPath = boardSnapshotPath(dir, "o", "r");
    const sidecar = boardObservationPath(dir, "o", "r");
    const history = physical(dataPath);
    const readerEvents: string[] = [];
    const warmReader = createBoardSnapshotReader({ log: (event) => readerEvents.push(event) });
    assert.equal(warmReader(dir, "o", "r").closedObservedAt, at(T0));
    assert.deepEqual(readerEvents.splice(0), ["board_snapshot.loaded"], "positive control: the reader parsed once");

    const step = steppedClock(T0 + 10 * MIN);
    const restarted = createBoardSnapshotCache(dir, "o", "r", { clock: step.clock });
    assert.equal(restarted.rows!().closedObservedAt, at(T0), "a restart before any new read keeps the data's own clock");
    assert.equal(restarted.commitClosed(rows.map((row) => ({ ...row }))), true);
    assert.equal(restarted.rows!().closedObservedAt, at(T0 + 10 * MIN), "the unchanged successful read advances the clock");
    assert.deepEqual(physical(dataPath), history, "historical rows are neither rewritten nor touched");
    const record = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    assert.deepEqual(record.snapshot, { sha256: createHash("sha256").update(history.bytes).digest("hex"), bytes: Buffer.byteLength(history.bytes) });
    assert.equal(record.observedAt, at(T0 + 10 * MIN));
    assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);

    // Coalesced: a second unchanged read inside the resave cadence does not rewrite the sidecar.
    const firstSidecar = physical(sidecar);
    step.set(T0 + 10 * MIN + 30_000);
    assert.equal(restarted.commitClosed(rows), true);
    assert.deepEqual(physical(sidecar), firstSidecar);
    step.set(T0 + 12 * MIN);
    assert.equal(restarted.commitClosed(rows), true);
    assert.equal(JSON.parse(readFileSync(sidecar, "utf8")).observedAt, at(T0 + 12 * MIN));
    // A rolled-back clock never moves the observation backwards.
    step.set(T0 + 11 * MIN);
    assert.equal(restarted.commitClosed(rows), true);
    assert.equal(restarted.rows!().closedObservedAt, at(T0 + 12 * MIN));
    assert.deepEqual(physical(dataPath), history);
    assert.deepEqual(fs.readdirSync(dirname(dataPath)).sort(), [basename(dataPath), basename(sidecar)].sort(), "no stage is left behind");

    // Cold restart and a warm shared reader both recover the persisted watermark without re-parsing history.
    assert.equal(createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0 + 60 * MIN) }).rows!().closedObservedAt, at(T0 + 12 * MIN));
    assert.equal(createBoardSnapshotReader()(dir, "o", "r").closedObservedAt, at(T0 + 12 * MIN));
    assert.equal(warmReader(dir, "o", "r").closedObservedAt, at(T0 + 12 * MIN));
    assert.deepEqual(readerEvents.filter((event) => event === "board_snapshot.loaded"), [], "the warm reader re-validated only the sidecar");

    // A legacy snapshot without its own clock stays readable but uncertified until a real successful read.
    const legacy = root();
    try {
      const legacyPath = boardSnapshotPath(legacy, "o", "r");
      mkdirSync(dirname(legacyPath), { recursive: true });
      writeFileSync(legacyPath, snapshotLines([{ type: "closed", row: diskClosed(closed(1)) }],
        { closed: { complete: true, count: 1 }, issues: { complete: true, count: 0 } }, { closed: 1, issues: 0 }));
      const legacyHistory = physical(legacyPath);
      const uncertified = createBoardSnapshotCache(legacy, "o", "r", { clock: fixedClock(T0) });
      assert.equal(uncertified.rows!().closedObservedAt, undefined);
      assert.equal(uncertified.commitClosed([closed(1)]), true);
      assert.deepEqual(physical(legacyPath), legacyHistory);
      assert.equal(observed(legacy).at, at(T0), "the successful read certified the legacy bytes it matched");
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T8912: PR observation identity refuses foreign replaced and torn metadata", () => {
  const dir = root();
  try {
    const rows = [closed(1)];
    assert.equal(createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0) }).commitClosed(rows), true);
    const writer = createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0 + 10 * MIN) });
    assert.equal(writer.commitClosed(rows), true);
    const sidecar = boardObservationPath(dir, "o", "r");
    const valid = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown> & { snapshot: { sha256: string; bytes: number } };
    assert.equal(observed(dir).at, at(T0 + 10 * MIN), "positive control: the untouched sidecar certifies");

    const cases: Array<{ name: string; body: string; reason: string }> = [
      { name: "torn", body: JSON.stringify(valid).slice(0, 40), reason: "invalid_json" },
      { name: "foreign repository", body: JSON.stringify({ ...valid, repository: "o/other" }), reason: "wrong_repository" },
      { name: "foreign channel", body: JSON.stringify({ ...valid, channel: "issues" }), reason: "wrong_channel" },
      { name: "other generation", body: JSON.stringify({ ...valid, snapshot: { ...valid.snapshot, sha256: "0".repeat(64) } }), reason: "foreign_snapshot" },
      { name: "other length", body: JSON.stringify({ ...valid, snapshot: { ...valid.snapshot, bytes: valid.snapshot.bytes + 1 } }), reason: "foreign_snapshot" },
      { name: "incompatible schema", body: JSON.stringify({ ...valid, schema: 2 }), reason: "future_version" },
      { name: "other type", body: JSON.stringify({ ...valid, type: "board-open-snapshot" }), reason: "invalid_schema" },
      { name: "unparseable clock", body: JSON.stringify({ ...valid, observedAt: "yesterday" }), reason: "invalid_schema" },
      { name: "oversized", body: JSON.stringify({ ...valid, pad: "x".repeat(5000) }), reason: "oversized" },
    ];
    for (const fixture of cases) {
      writeFileSync(sidecar, fixture.body);
      const result = observed(dir);
      assert.equal(result.at, at(T0), `${fixture.name}: falls back to the data file's own clock`);
      assert.equal(result.refusal, fixture.reason, fixture.name);
    }
    rmSync(sidecar);
    mkdirSync(sidecar);
    assert.deepEqual([observed(dir).at, observed(dir).refusal], [at(T0), "not_file"]);
    rmSync(sidecar, { recursive: true });

    // Another repository cannot borrow this repository's certification, even holding the identical sidecar.
    assert.equal(createBoardSnapshotCache(dir, "o", "s", { clock: fixedClock(T0) }).commitClosed([{ ...closed(1), url: "https://github.com/o/s/pull/1" }]), true);
    writeFileSync(boardObservationPath(dir, "o", "s"), JSON.stringify(valid));
    assert.deepEqual([observed(dir, "o", "s").at, observed(dir, "o", "s").refusal], [at(T0), "wrong_repository"]);

    // A replaced snapshot cannot inherit the old sidecar, and a writer holding the replaced identity cannot certify the new one.
    writeFileSync(sidecar, JSON.stringify(valid));
    const reader = createBoardSnapshotReader();
    assert.equal(reader(dir, "o", "r").closedObservedAt, at(T0 + 10 * MIN));
    const stale = createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0 + 20 * MIN) });
    assert.equal(createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0 + 5 * MIN) }).commitClosed([closed(1), closed(2)]), true);
    assert.equal(fs.existsSync(sidecar), false, "successful publication retired the stale sidecar");
    // A delayed writer can restore the superseded certificate after publication.
    writeFileSync(sidecar, JSON.stringify(valid));
    assert.deepEqual([observed(dir).at, observed(dir).refusal], [at(T0 + 5 * MIN), "foreign_snapshot"]);
    assert.equal(reader(dir, "o", "r").closedObservedAt, at(T0 + 5 * MIN), "a warm reader sees the replacement between reads");
    assert.equal(stale.commitClosed(rows), true, "the stale writer's rows still match what it alone holds");
    assert.equal(stale.rows!().closedObservedAt, at(T0 + 20 * MIN));
    assert.deepEqual([observed(dir).at, observed(dir).refusal], [at(T0 + 5 * MIN), "foreign_snapshot"]);
    assert.equal(reader(dir, "o", "r").closedObservedAt, at(T0 + 5 * MIN));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T8912: failed partial and invalid PR observations preserve honest coverage", async () => {
  const dir = root();
  try {
    const rows = [closed(1)];
    assert.equal(createBoardSnapshotCache(dir, "o", "r", { clock: fixedClock(T0) }).commitClosed(rows), true);
    const sidecar = boardObservationPath(dir, "o", "r");
    const later = fixedClock(T0 + 60 * MIN);

    // Failed and truncated GitHub reads never reach the observation writer.
    const cache = createBoardSnapshotCache(dir, "o", "r", { clock: later });
    const failed = buildBatchedGithub("o", "r", { snapshotCache: cache, exec: (args) => {
      if (/state=closed/.test(args[1] ?? "")) throw new Error("simulated GitHub failure");
      return "[]";
    } });
    failed.listMergedHeadBranches!();
    const many = Array.from({ length: BOARD_MAX_PAGES * 30 }, (_, i) => closed(10_000 - i, new Date(Date.UTC(2026, 8, 6) - i * MIN).toISOString()));
    const truncated = buildBatchedGithub("o", "r", { snapshotCache: cache, exec: pagingExec({ open: [], closed: many, issues: [] }, []) });
    truncated.listMergedHeadBranches!();
    assert.equal(truncated.readTruncated?.(), true);
    // Invalid rows are refused before the unchanged comparison.
    assert.equal(cache.commitClosed([rows[0]!, rows[0]!]), false);
    assert.equal(cache.rows!().closedObservedAt, at(T0));
    assert.equal(fs.existsSync(sidecar), false, "no failed, partial or invalid read wrote an observation");

    // Interrupted before the metadata rename: no advance in process or after restart, and no stage left behind.
    const telemetry: Array<{ event: string; extra?: Record<string, unknown> }> = [];
    const interrupted = createBoardSnapshotCache(dir, "o", "r", { clock: later, log: (event, extra) => telemetry.push({ event, extra }),
      io: realIo({ rename: () => { throw new Error("simulated crash before rename"); } }) });
    assert.equal(interrupted.commitClosed(rows), true);
    assert.equal(interrupted.rows!().closedObservedAt, at(T0));
    assert.equal(telemetry.at(-1)?.event, "board_snapshot.observation_refused");
    assert.equal(telemetry.at(-1)?.extra?.reason, "write_failed");
    assert.deepEqual(fs.readdirSync(dirname(sidecar)).filter((name) => name.includes(".observed")), [], "no sidecar or stage is left behind");
    assert.equal(observed(dir).at, at(T0));

    // Future and stale frames are refused against a real certified sidecar.
    assert.equal(createBoardSnapshotCache(dir, "o", "r", { clock: later }).commitClosed(rows), true);
    assert.equal(observed(dir).at, at(T0 + 60 * MIN), "positive control: a successful read certifies");
    assert.deepEqual([observed(dir, "o", "r", fixedClock(T0 + 60 * MIN - 1)).at, observed(dir, "o", "r", fixedClock(T0 + 60 * MIN - 1)).refusal],
      [at(T0), "future_observation"]);
    const valid = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    writeFileSync(sidecar, JSON.stringify({ ...valid, observedAt: at(T0 - MIN) }));
    assert.deepEqual([observed(dir).at, observed(dir).refusal], [at(T0), "stale_observation"]);
    writeFileSync(sidecar, JSON.stringify(valid));
    const unopenable: Array<unknown> = [];
    const blind = createBoardSnapshotCache(dir, "o", "r", { clock: later, log: (_event, extra) => unopenable.push(extra?.reason),
      io: realIo({ openRead: (path) => {
        if (path === sidecar) throw new Error("simulated open failure");
        return fs.openSync(path, "r");
      } }) });
    assert.equal(blind.rows!().closedObservedAt, at(T0));
    assert.deepEqual(unopenable.filter(Boolean), ["open_failed"]);

    // BACKSTOP: an observation record past its byte bound is refused, not truncated or written.
    const owner = "o".repeat(5000);
    const wide = createBoardSnapshotCache(dir, owner, "r", { clock: fixedClock(T0) });
    assert.equal(wide.commitClosed(rows), true);
    const wideLog: Array<unknown> = [];
    const wideLater = createBoardSnapshotCache(dir, owner, "r", { clock: later, log: (_event, extra) => wideLog.push(extra?.reason) });
    assert.equal(wideLater.commitClosed(rows), true);
    assert.equal(wideLater.rows!().closedObservedAt, at(T0));
    assert.deepEqual(wideLog.filter(Boolean), ["oversized"]);
    assert.equal(fs.existsSync(boardObservationPath(dir, owner, "r")), false);

    // Through the real repository-flow collector: unavailable observation is never a current zero; a real one may be.
    const { captureRepositoryFlow } = await import("../src/lib/repository-flow.js");
    const empty = root();
    try {
      const state = join(empty, "state");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "ledger.ndjson"), JSON.stringify({ ts: at(T0), step: "daemon.tick" }) + "\n");
      const now = T0 + 120 * MIN;
      assert.equal(createBoardSnapshotCache(empty, "o", "r", { clock: fixedClock(T0) }).commitClosed([]), true);
      const emptyCache = createBoardSnapshotCache(empty, "o", "r", { clock: fixedClock(now) });
      assert.equal(emptyCache.commitOpen!([], now), true);
      // The gateway runs on the same fixed clock, so its open snapshot is not stamped at real time.
      buildBatchedGithub("o", "r", { snapshotCache: emptyCache, now: () => now, exec: (args) => {
        if (/state=closed/.test(args[1] ?? "")) throw new Error("simulated GitHub failure");
        return "[]";
      } }).listMergedHeadBranches!();
      const before = (await captureRepositoryFlow(empty, state, "o/r", fixedClock(now)))!;
      assert.equal(before.reason, null, JSON.stringify(before.sources));
      assert.equal(before.sources.closedObservedAt, at(T0));
      assert.equal(before.sources.prFreshness, "stale");
      assert.equal(before.windows[0]!.summary.merged, null, "a failed read cannot turn a stale empty corpus into zero");
      assert.equal(before.windows[0]!.coverage.merged, "unknown");
      buildBatchedGithub("o", "r", { snapshotCache: emptyCache, now: () => now, exec: () => "[]" }).listMergedHeadBranches!();
      const after = (await captureRepositoryFlow(empty, state, "o/r", fixedClock(now)))!;
      assert.equal(after.sources.closedObservedAt, at(now));
      assert.equal(after.sources.prFreshness, "fresh");
      assert.equal(after.windows[0]!.summary.merged, 0, "a genuinely fresh complete empty read certifies zero");
      assert.equal(after.windows[0]!.coverage.merged, "complete");
      assert.equal(fs.existsSync(boardOpenSnapshotPath(empty, "o", "r")), true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
