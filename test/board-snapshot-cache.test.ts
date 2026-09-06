import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  boardSnapshotPath,
  createBoardSnapshotCache,
  type BoardSnapshotIo,
} from "../src/lib/board-snapshot-cache.js";
import { buildBatchedGithub } from "../src/lib/status.js";
import type { BoardIssueRest, BoardPrRest } from "../src/lib/open-prs-rest.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

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

    const changed = Array.from({ length: 1_500 }, (_, i) => closed(10_000 - i, new Date(Date.UTC(2026, 8, 6) - i * 60_000).toISOString()));
    const calls: string[][] = [];
    const truncated = buildBatchedGithub("o", "r", {
      snapshotCache: cache,
      exec: pagingExec({ open: [], closed: changed, issues: [] }, calls),
    });
    truncated.listMergedHeadBranches!();
    assert.equal(count(calls, /state=closed/), 50, "the fixture reaches the real truncation ceiling");
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
  const source = readFileSync(join(process.cwd(), "src", "run-task.ts"), "utf8");
  assert.ok(/createBoardSnapshotCache\(/.test(source), "the module is constructed outside its unit test");
  assert.ok(/snapshotCache:\s*boardSnapshotFor\(/.test(source), "daemon projection and lane gateways receive the per-repo shared cache");
  assert.ok(/buildSweepHook\([\s\S]*?boardSnapshotFor\(target\.owner, target\.repo\)/.test(source), "the full sweep gateway receives the same daemon cache");
  assert.ok(/const serveBoardSnapshot = createBoardSnapshotCache\([\s\S]*?snapshotCache:\s*serveBoardSnapshot/.test(source), "Serve uses the same state namespace");
});
