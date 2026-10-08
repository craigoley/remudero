import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BOARD_REFRESH_ROLLUP_MS,
  boardRefreshRollup,
  createBoardSnapshotCache,
} from "../src/lib/board-snapshot-cache.js";
import { buildBatchedGithub } from "../src/lib/status.js";
import type { BoardPrRest, RestPullRow } from "../src/lib/open-prs-rest.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function journal() {
  const rows: Array<{ event: string; extra: Record<string, unknown> }> = [];
  const log = (event: string, extra: Record<string, unknown> = {}) => {
    rows.push({ event, extra: structuredClone(extra) });
  };
  return { rows, log, events: (event: string) => rows.filter((row) => row.event === event).map((row) => row.extra) };
}

function wire(number: number, state: "open" | "closed" = "open"): RestPullRow {
  return {
    number,
    html_url: `https://github.com/o/r/pull/${number}`,
    state,
    merged_at: state === "closed" ? "2026-09-05T00:00:00Z" : null,
    updated_at: "2026-09-05T00:00:00Z",
    head: { ref: `run-W1-T${number}-1700000000000`, sha: `sha-${number}` },
    body: `Remudero-Task: W1-T${number}\n café`,
    title: `pull request ${number}`,
  };
}

function closed(number: number): BoardPrRest {
  return {
    number, url: `https://github.com/o/r/pull/${number}`, state: "MERGED",
    headRefName: `run-W1-T${number}-1700000000000`, headRefOid: `sha-${number}`,
    autoMergeRequest: null,
    body: `Remudero-Task: W1-T${number}`, title: `merged ${number}`, updatedAt: "2026-09-05T00:00:00Z",
  };
}

function remote() {
  return {
    open: [wire(1)], closed: [wire(2, "closed")], fail: undefined as string | undefined,
    calls: [] as Array<{ half: string; mode: string; bytes: number }>,
    exec(args: string[]): string {
      const url = args[1] ?? "";
      const half = url.includes("state=open") ? "open" : "closed";
      assert.ok(url.includes("/pulls?"), `unexpected request: ${url}`);
      if (this.fail === half) throw Object.assign(new Error("bad credentials"), { status: 1, stderr: "bad credentials" });
      const perPage = Number(/[?&]per_page=(\d+)/.exec(url)?.[1]);
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1]);
      const raw = JSON.stringify(this[half as "open" | "closed"].slice((page - 1) * perPage, page * perPage));
      this.calls.push({ half, mode: perPage === 30 ? "delta" : "full", bytes: Buffer.byteLength(raw) });
      return raw;
    },
  };
}

test("an unchanged board fetch is counted in the rollup and writes no fetch_ok row", () => {
  const j = journal();
  const r = remote();
  const gateway = buildBatchedGithub("o", "r", { exec: r.exec.bind(r), ttlMs: 0, log: j.log });
  try {
    for (let i = 0; i < 3; i++) assert.equal(gateway.listOpenHeadBranches!()?.length, 1);
    assert.equal(r.calls.length, 3, "three actual refreshes, not TTL cache hits");
    assert.deepEqual(j.events("board_gateway.fetch_ok"), [{ prCount: 1, channel: "open" }]);
    assert.deepEqual(j.events("board_gateway.fetch_bytes"), [
      { bytes: r.calls[0]!.bytes, restCalls: 1, mode: "full", truncated: false, half: "open" },
    ]);
    boardRefreshRollup(j.log)!.flush();
    assert.deepEqual(j.events("board_gateway.rollup")[0]!.fetch_ok, { open: 3 });

    r.open.push(wire(3));
    assert.equal(gateway.listOpenHeadBranches!()?.length, 2);
    assert.equal(gateway.listOpenHeadBranches!()?.length, 2);
    assert.deepEqual(j.events("board_gateway.fetch_ok"), [
      { prCount: 1, channel: "open" }, { prCount: 2, channel: "open" },
    ]);
    boardRefreshRollup(j.log)!.flush();
    assert.deepEqual(j.events("board_gateway.rollup")[1]!.fetch_ok, { open: 2 });
  } finally {
    boardRefreshRollup(j.log)!.flush();
  }
});

test("the first board fetch after a failure still writes a full fetch_ok row", (t) => {
  t.mock.method(console, "error", () => {});
  for (const channel of ["open", "merged", "both"] as const) {
    const j = journal();
    const r = remote();
    let combinedFailure = false;
    const gateway = buildBatchedGithub("o", "r", {
      ttlMs: 0, log: j.log, exec: r.exec.bind(r),
      ...(channel === "both" ? { fetchAll: () => {
        if (combinedFailure) throw new Error("fetch failed");
        return [closed(2)];
      } } : {}),
    });
    const read = () => channel === "open" ? gateway.listOpenHeadBranches!() : gateway.listMergedHeadBranches!();
    const successes = () => j.events("board_gateway.fetch_ok").filter((row) => row.channel === channel);
    try {
      assert.equal(read()?.length, 1);
      assert.equal(read()?.length, 1);
      assert.equal(successes().length, 1);
      r.fail = channel === "open" ? "open" : "closed";
      combinedFailure = true;
      assert.equal(read(), null);
      assert.equal(read(), null);
      assert.equal(gateway.readFailed!(), true);
      const failures = j.events("board_gateway.fetch_failed");
      assert.equal(failures.length, 2, "every failure remains a separate row");
      assert.ok(failures.every((row) => row.channel === channel && row.reason && row.message));
      r.fail = undefined;
      combinedFailure = false;
      assert.equal(read()?.length, 1);
      assert.equal(gateway.readFailed!(), false);
      assert.deepEqual(successes(), [
        { prCount: 1, channel }, { prCount: 1, channel },
      ], "same-count recovery still emits the complete success payload");
      assert.equal(read()?.length, 1);
      assert.equal(successes().length, 2, "suppression resumes after recovery");
      boardRefreshRollup(j.log)!.flush();
      assert.deepEqual(j.events("board_gateway.rollup")[0]!.fetch_ok, channel === "merged" ? { open: 6, merged: 4 } : { [channel]: 4 });
    } finally {
      boardRefreshRollup(j.log)!.flush();
    }
  }
});

test("a repeated unchanged board snapshot is counted and not logged", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}board-rollup-`));
  const j = journal();
  const cache = createBoardSnapshotCache(dir, "o", "r", { log: j.log });
  const rows = [closed(2)];
  const issues = [{ number: 3, url: "https://github.com/o/r/issues/3", state: "open", title: "help", updatedAt: rows[0]!.updatedAt }];
  try {
    assert.equal(cache.commitClosed(rows), true);
    assert.equal(cache.commitIssues(issues), true);
    for (let i = 0; i < 3; i++) {
      assert.equal(cache.commitClosed(rows), true);
      assert.equal(cache.commitIssues(issues), true);
    }
    assert.deepEqual(j.events("board_snapshot.unchanged").map((row) => [row.channel, row.rows, row.bytes]), [
      ["closed", 1, 0], ["issues", 1, 0],
    ]);
    assert.equal(j.events("board_snapshot.committed").length, 2);
    boardRefreshRollup(j.log)!.flush();
    assert.deepEqual(j.events("board_gateway.rollup")[0]!.snapshot_unchanged, { closed: 3, issues: 3 });

    assert.equal(cache.commitClosed([rows[0]!, rows[0]!]), false);
    assert.equal(j.events("board_snapshot.commit_refused").length, 1);
    assert.equal(cache.commitClosed(rows), true);
    assert.equal(j.events("board_snapshot.unchanged").length, 3, "a refusal resets suppression for its channel");
    const changed = [{ ...rows[0]!, updatedAt: "2026-09-06T00:00:00Z" }];
    assert.equal(cache.commitClosed(changed), true);
    assert.equal(cache.commitClosed(changed), true);
    assert.equal(cache.commitClosed(changed), true);
    assert.equal(j.events("board_snapshot.committed").length, 3);
    assert.equal(j.events("board_snapshot.unchanged").length, 4, "a committed change resets suppression");
    boardRefreshRollup(j.log)!.flush();
    assert.deepEqual(j.events("board_gateway.rollup")[1]!.snapshot_unchanged, { closed: 3 });
  } finally {
    boardRefreshRollup(j.log)!.flush();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the board rollup totals every fetch by half and mode", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}board-rollup-totals-`));
  const j = journal();
  const r = remote();
  r.closed = Array.from({ length: 130 }, (_, i) => wire(200 - i, "closed"));
  const snapshotCache = createBoardSnapshotCache(dir, "o", "r", { log: j.log });
  const gateway = buildBatchedGithub("o", "r", { exec: r.exec.bind(r), ttlMs: 0, log: j.log, snapshotCache });
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal(gateway.listMergedHeadBranches!()?.length, 130);
    }
    assert.equal(r.calls.length, 7, "six fetches include one two-page full walk");
    const bytes = (half: string, mode: string) => r.calls.filter((row) => row.half === half && row.mode === mode).reduce((sum, row) => sum + row.bytes, 0);
    boardRefreshRollup(j.log)!.flush();
    assert.equal(j.events("board_gateway.rollup").length, 1);
    const rollup = j.events("board_gateway.rollup")[0]!;
    assert.deepEqual(rollup.fetch_ok, { open: 3, merged: 3 });
    assert.deepEqual(rollup.fetch, {
      "open/full": { n: 3, rest_calls: 3, bytes: bytes("open", "full"), truncated: 0 },
      "closed/full": { n: 1, rest_calls: 2, bytes: bytes("closed", "full"), truncated: 0 },
      "closed/delta": { n: 2, rest_calls: 2, bytes: bytes("closed", "delta"), truncated: 0 },
    });
    assert.deepEqual(rollup.snapshot_unchanged, { closed: 2 }, "gateway and snapshot counts share one window");
    assert.ok(Number.isFinite(Date.parse(String(rollup.window_start))));
    assert.ok(Date.parse(String(rollup.window_end)) >= Date.parse(String(rollup.window_start)));
    assert.deepEqual(j.events("board_gateway.fetch_bytes").map((row) => [row.half, row.mode]), [
      ["open", "full"], ["closed", "full"], ["closed", "delta"],
    ]);
    boardRefreshRollup(j.log)!.flush();
    assert.equal(j.events("board_gateway.rollup").length, 1, "an empty flush adds no row");
  } finally {
    boardRefreshRollup(j.log)!.flush();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every truncated board fetch retains a full byte row and is counted in the rollup", () => {
  const j = journal();
  const r = remote();
  r.open = Array.from({ length: 20_000 }, (_, i) => wire(i + 1));
  const gateway = buildBatchedGithub("o", "r", { exec: r.exec.bind(r), ttlMs: 0, log: j.log });
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal(gateway.listOpenHeadBranches!()?.length, 20_000);
    }
    r.open = [wire(1)];
    for (let i = 0; i < 2; i++) {
      assert.equal(gateway.listOpenHeadBranches!()?.length, 1);
    }
    assert.deepEqual(j.events("board_gateway.fetch_bytes").map((row) => [row.restCalls, row.truncated]), [
      [200, true], [200, true], [1, false],
    ]);
    boardRefreshRollup(j.log)!.flush();
    assert.deepEqual(j.events("board_gateway.rollup")[0]!.fetch, {
      "open/full": { n: 4, rest_calls: 402, bytes: r.calls.reduce((sum, row) => sum + row.bytes, 0), truncated: 2 },
    });
  } finally {
    boardRefreshRollup(j.log)!.flush();
  }
});

test("board rollups flush at five minutes and start a fresh window", (t) => {
  const start = Date.parse("2026-10-08T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
  const j = journal();
  const gateway = buildBatchedGithub("o", "r", { fetchAll: () => [], ttlMs: 0, log: j.log });
  gateway.listOpenHeadBranches!();
  t.mock.timers.tick(BOARD_REFRESH_ROLLUP_MS - 1);
  assert.equal(j.events("board_gateway.rollup").length, 0);
  gateway.listOpenHeadBranches!();
  t.mock.timers.tick(1);
  assert.deepEqual(j.events("board_gateway.rollup"), [{
    window_start: new Date(start).toISOString(), window_end: new Date(start + BOARD_REFRESH_ROLLUP_MS).toISOString(),
    fetch_ok: { both: 2 }, fetch: {}, snapshot_unchanged: {},
  }]);
  t.mock.timers.tick(BOARD_REFRESH_ROLLUP_MS);
  assert.equal(j.events("board_gateway.rollup").length, 1);
  gateway.listOpenHeadBranches!();
  t.mock.timers.tick(BOARD_REFRESH_ROLLUP_MS);
  assert.deepEqual(j.events("board_gateway.rollup")[1], {
    window_start: new Date(start + 2 * BOARD_REFRESH_ROLLUP_MS).toISOString(),
    window_end: new Date(start + 3 * BOARD_REFRESH_ROLLUP_MS).toISOString(),
    fetch_ok: { both: 1 }, fetch: {}, snapshot_unchanged: {},
  });
});

test("a failed board rollup flush retains the window and retries with every count", (t) => {
  const start = Date.parse("2026-10-08T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
  const errors = t.mock.method(console, "error", () => {});
  const j = journal();
  let reject = true;
  const log = (event: string, extra?: Record<string, unknown>) => {
    if (event === "board_gateway.rollup" && reject) throw new Error("ledger unavailable");
    j.log(event, extra);
  };
  const r = remote();
  const gateway = buildBatchedGithub("o", "r", { exec: r.exec.bind(r), ttlMs: 0, log });
  gateway.listOpenHeadBranches!();
  t.mock.timers.tick(BOARD_REFRESH_ROLLUP_MS);
  assert.equal(j.events("board_gateway.rollup").length, 0);
  assert.match(String(errors.mock.calls[0]!.arguments[0]), /ledger unavailable/);
  gateway.listOpenHeadBranches!();
  reject = false;
  t.mock.timers.tick(BOARD_REFRESH_ROLLUP_MS);
  assert.deepEqual(j.events("board_gateway.rollup"), [{
    window_start: new Date(start).toISOString(), window_end: new Date(start + 2 * BOARD_REFRESH_ROLLUP_MS).toISOString(),
    fetch_ok: { open: 2 },
    fetch: { "open/full": { n: 2, rest_calls: 2, bytes: r.calls.reduce((sum, row) => sum + row.bytes, 0), truncated: 0 } },
    snapshot_unchanged: {},
  }]);
});

test("a pending board rollup is written on process exit", () => {
  const statusUrl = new URL("../src/lib/status.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { buildBatchedGithub } from ${JSON.stringify(statusUrl)};
    const gateway = buildBatchedGithub("o", "r", {
      fetchAll: () => [], ttlMs: 0,
      log: (event, extra) => console.log(JSON.stringify({ event, ...extra })),
    });
    gateway.listOpenHeadBranches();
    gateway.listOpenHeadBranches();
  `], { encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
  const rows = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.event), ["board_gateway.fetch_ok", "board_gateway.rollup"]);
  assert.deepEqual(rows[1].fetch_ok, { both: 2 });
});

test("real prewarm workers suppress repeated rows and emit same-count recovery rows", async (t) => {
  t.mock.method(console, "error", () => {});
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}board-rollup-worker-`));
  const j = journal();
  const failPath = join(dir, "fail");
  const ghBin = join(dir, "fake-gateway");
  writeFileSync(ghBin, `#!/usr/bin/env node
    const fs = require("node:fs");
    if (fs.existsSync(${JSON.stringify(failPath)})) {
      console.error("bad credentials"); process.exit(1);
    }
    const url = process.argv.find((arg) => arg.startsWith("repos/")) || "";
    console.log(JSON.stringify(url.includes("state=open") ? ${JSON.stringify([wire(1)])} :
      url.includes("state=closed") ? ${JSON.stringify([wire(2, "closed")])} : []));
  `, { mode: 0o755 });
  assert.equal(existsSync(ghBin), true);
  let now = 0;
  const gateway = buildBatchedGithub("o", "r", { ghBin, ttlMs: 1, now: () => now, log: j.log });
  const refresh = async () => {
    now += 100_000;
    gateway.warm!();
    assert.equal(gateway.readState!(), "in_flight");
    for (let i = 0; i < 2_000 && gateway.readState!() === "in_flight"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.notEqual(gateway.readState!(), "in_flight", "the real worker finishes");
  };
  try {
    await refresh();
    await refresh();
    assert.deepEqual(j.events("board_gateway.fetch_ok"), [
      { prCount: 1, channel: "open" }, { prCount: 1, channel: "merged" },
    ]);
    writeFileSync(failPath, "fail");
    await refresh();
    assert.equal(gateway.readFailed!(), true);
    assert.deepEqual(j.events("board_gateway.fetch_failed").map((row) => row.channel), ["open", "merged"]);
    rmSync(failPath);
    await refresh();
    assert.equal(gateway.readFailed!(), false);
    assert.deepEqual(j.events("board_gateway.fetch_ok"), [
      { prCount: 1, channel: "open" }, { prCount: 1, channel: "merged" },
      { prCount: 1, channel: "open" }, { prCount: 1, channel: "merged" },
    ]);
    boardRefreshRollup(j.log)!.flush();
    assert.deepEqual(j.events("board_gateway.rollup")[0]!.fetch_ok, { open: 3, merged: 3 });
    assert.deepEqual(j.events("board_gateway.rollup")[0]!.fetch, {
      "open/full": { n: 3, rest_calls: 3, bytes: 3 * Buffer.byteLength(JSON.stringify([wire(1)]) + "\n"), truncated: 0 },
      "closed/full": { n: 1, rest_calls: 1, bytes: Buffer.byteLength(JSON.stringify([wire(2, "closed")]) + "\n"), truncated: 0 },
      "closed/delta": { n: 2, rest_calls: 2, bytes: 2 * Buffer.byteLength(JSON.stringify([wire(2, "closed")]) + "\n"), truncated: 0 },
    });
  } finally {
    boardRefreshRollup(j.log)!.flush();
    rmSync(dir, { recursive: true, force: true });
  }
});
