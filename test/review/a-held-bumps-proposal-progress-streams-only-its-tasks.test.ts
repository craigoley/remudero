// A held dependabot bump's proposal progress once read the whole ledger union into memory to filter it by
// task id (~4 GB on the 2026-11-05 live heap profile, aborting the daemon every ~25 min). These pin the
// streamed replacement: rotations cut before the feedback's capture are never opened, only the proposal's
// tasks' rows are kept, and an unread source answers with no rows as the strict read did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, createReadStream, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { proposalTaskLedgerRows } from "#src/lib/dep-review.js";
import type { LedgerUnionStreamIO } from "#src/lib/ledger-union.js";

const SINCE = "2026-11-04T21:00:00.000Z";

function rotationName(iso: string): string {
  return `ledger.${iso.replace(/:/g, "-").replace(".", "-")}.ndjson.gz`;
}

function fixture(t: { after: (fn: () => void) => void }): { dir: string; before: string[]; after: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proposal-rows-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rows = (ts: string, extra: Array<Record<string, unknown>>) =>
    gzipSync(extra.map((r) => JSON.stringify({ ts, ...r })).join("\n") + "\n");
  const before = ["2026-10-01T00:00:00.000Z", "2026-10-20T00:00:00.000Z", "2026-11-04T20:00:00.000Z"].map((iso) => {
    const name = rotationName(iso);
    // An old rotation holds a same-id row too: the bound, not luck, keeps it out.
    writeFileSync(join(dir, name), rows(iso, [{ step: "dispatch", task_id: "W1-T1" }, { step: "noise", task_id: "W1-T9" }]));
    return name;
  });
  const after = ["2026-11-04T23:00:00.000Z", "2026-11-05T10:00:00.000Z"].map((iso, i) => {
    const name = rotationName(iso);
    writeFileSync(join(dir, name), rows(iso, [
      { step: i === 0 ? "dispatch" : "run.start", task_id: "W1-T1" },
      { step: "noise", task_id: "W1-T9" },
      { step: "verdict", task_id: "W1-T2", verdict: "failed" },
    ]));
    return name;
  });
  const live = { ts: "2026-11-05T12:00:00.000Z", step: "pr.opened", task_id: "W1-T1", pr_url: "https://example/pull/1" };
  // The live file replays the newest archive's verdict row: a kept row is deduplicated, never doubled.
  writeFileSync(join(dir, "ledger.ndjson"), [
    JSON.stringify({ ts: "2026-11-05T10:00:00.000Z", step: "verdict", task_id: "W1-T2", verdict: "failed" }),
    JSON.stringify(live),
    JSON.stringify({ ts: "2026-11-05T12:00:01.000Z", step: "noise", task_id: "W1-T9" }),
  ].join("\n") + "\n");
  return { dir, before, after };
}

function countingIo(opened: string[]): LedgerUnionStreamIO {
  return {
    readdirSync: (d) => readdirSync(d),
    existsSync: (p) => existsSync(p),
    readFileSync: (p) => readFileSync(p),
    createReadStream: (p, o) => { opened.push(basename(p)); return createReadStream(p, o); },
  };
}

test("a held bump's proposal progress opens no rotation cut before its feedback was captured", { timeout: 30_000 }, async (t) => {
  const { dir, before, after } = fixture(t);
  const opened: string[] = [];
  const read = await proposalTaskLedgerRows(dir, new Set(["W1-T1", "W1-T2"]), SINCE, countingIo(opened));
  assert.equal(read.ok, true);
  for (const name of before.slice(0, -1)) assert.ok(!opened.includes(name), `opened ${name}, cut before ${SINCE}`);
  for (const name of after) assert.ok(opened.includes(name), `never opened ${name}, cut after ${SINCE}`);
  assert.ok(opened.includes("ledger.ndjson"), "the live file is read");
});

test("a held bump's proposal progress keeps only its own tasks' rows, each once", { timeout: 30_000 }, async (t) => {
  const { dir } = fixture(t);
  const read = await proposalTaskLedgerRows(dir, new Set(["W1-T1", "W1-T2"]), SINCE);
  assert.equal(read.ok, true);
  assert.ok(read.rows.every((r) => r.task_id === "W1-T1" || r.task_id === "W1-T2"), "an unrelated task's row was kept");
  assert.deepEqual(read.rows.filter((r) => r.task_id === "W1-T1").map((r) => r.step), ["dispatch", "run.start", "pr.opened"]);
  assert.equal(read.rows.filter((r) => r.task_id === "W1-T2" && r.ts === "2026-11-05T10:00:00.000Z").length, 1,
    "the live file's replay of an archived row was doubled");
  assert.equal(read.rows.filter((r) => r.task_id === "W1-T2").length, 2, "each archived verdict row is kept");
});

test("a held bump's proposal progress with no capture time streams the whole union, still filtered", { timeout: 30_000 }, async (t) => {
  const { dir, before } = fixture(t);
  const opened: string[] = [];
  const read = await proposalTaskLedgerRows(dir, new Set(["W1-T1"]), undefined, countingIo(opened));
  assert.equal(read.ok, true);
  for (const name of before) assert.ok(opened.includes(name), `unbounded read skipped ${name}`);
  assert.equal(read.rows.filter((r) => r.step === "dispatch").length, 4, "every rotation's own-task row is kept");
  assert.ok(read.rows.every((r) => r.task_id === "W1-T1"));
});

test("a held bump's proposal progress answers no rows when a rotation is unreadable", { timeout: 30_000 }, async (t) => {
  const { dir, after } = fixture(t);
  writeFileSync(join(dir, after[0]!), Buffer.from("not gzip at all"));
  const read = await proposalTaskLedgerRows(dir, new Set(["W1-T1"]), SINCE);
  assert.deepEqual(read, { ok: false, rows: [] });
});
