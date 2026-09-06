/**
 * `rmd status` REPORTED `no cycle recorded` ON A HOST WITH 524 RECORDED CYCLES.
 *
 * `buildStatusBoard` defaulted to `readLedgerLines`, which opens exactly ONE path. `rotateLedger`
 * keeps only `MAX_RETAINED_LINES_PER_STEP` per step and only for steps in a retention set, so a step
 * in NO set is shed COMPLETELY and the live file can never hold one.
 *
 * MEASURED on the live host: `daemon.summary` had **0 live rows against 524 in rotations**, and
 * `daemon.summary` appears ZERO times in `ledger.ts` — it is in no retention set at all. Two other
 * board steps were equally blind: `daemon.headroom.degraded` (0 live / 52) and
 * `dispatch.indeterminate` (0 live / 120,984). The remaining six were present live.
 *
 * THE BOUND IS MEASURED, NOT PICKED: the live file plus the NINE newest rotations held every step
 * the board reads. The full union costs 7.74s / 2.57 GiB through `rmd emissions`; the bounded read
 * measured 173 ms / 0.32 GiB against the same 669-rotation corpus.
 */
import assert from "node:assert/strict";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedgerLines, readLedgerUnionBounded, STATUS_BOARD_MAX_ROTATIONS } from "../src/lib/status.js";
import { buildStatusBoard } from "../src/lib/status-board.js";

const row = (step: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: "2026-08-12T12:00:00.000Z", step, ...extra });

/** A state dir whose LIVE file holds nothing of interest and whose ROTATION holds the target. */
function corpus(opts: { live: string[]; rotations?: Record<string, string[]>; gzip?: Record<string, string[]> }): string {
  const dir = mkdtempSync(join(tmpdir(), "board-rotations-"));
  writeFileSync(join(dir, "ledger.ndjson"), opts.live.join("\n") + (opts.live.length ? "\n" : ""));
  for (const [name, lines] of Object.entries(opts.rotations ?? {})) {
    writeFileSync(join(dir, name), lines.join("\n") + "\n");
  }
  for (const [name, lines] of Object.entries(opts.gzip ?? {})) {
    writeFileSync(join(dir, name), gzipSync(Buffer.from(lines.join("\n") + "\n")));
  }
  return dir;
}

const sawSummary = (s: ReadonlySet<string>): boolean => s.has("daemon.summary");

// ── TRAP 1: a row that exists ONLY in a rotation must be found ────────────────────────────────

test("a daemon.summary that exists ONLY in a rotation is read — the live-file reader finds nothing", () => {
  const dir = corpus({
    live: [row("run.start", { task_id: "T-1" })],
    rotations: { "ledger.2026-08-11T00-00-00-000Z.ndjson": [row("daemon.summary", { stopReason: "error", attempted: ["W1-T431"] })] },
  });
  const p = join(dir, "ledger.ndjson");

  // The defect, reproduced: the one-path reader cannot see it.
  assert.equal(readLedgerLines(p).filter((l) => l.step === "daemon.summary").length, 0, "this is the bug");

  const union = readLedgerUnionBounded(p, { satisfied: sawSummary });
  const found = union.filter((l) => l.step === "daemon.summary");
  assert.equal(found.length, 1, "the rotation's row must be read");
  assert.equal(found[0].stopReason, "error", "and carry its fields, not just its existence");
  rmSync(dir, { recursive: true, force: true });
});

test("a GZIPPED rotation is decompressed, not skipped — 515 of this host's rotations are .gz", () => {
  const dir = corpus({
    live: [row("run.start")],
    gzip: { "ledger.2026-08-10T00-00-00-000Z.ndjson.gz": [row("daemon.summary", { attempted: ["W1-T9"] })] },
  });
  const union = readLedgerUnionBounded(join(dir, "ledger.ndjson"), { satisfied: sawSummary });
  assert.equal(union.filter((l) => l.step === "daemon.summary").length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── TRAP 3: the live-only host must be unchanged ──────────────────────────────────────────────

test("a host with NO rotations reads exactly what the one-path reader read — byte for byte", () => {
  const live = [row("daemon.summary", { attempted: ["A"] }), row("run.start", { task_id: "B" })];
  const dir = corpus({ live });
  const p = join(dir, "ledger.ndjson");
  const one = readLedgerLines(p);
  const union = readLedgerUnionBounded(p, { satisfied: sawSummary });
  assert.deepEqual(union.map((l) => JSON.stringify(l)), one.map((l) => JSON.stringify(l)), "a fresh host must render identically");
  assert.equal(union.present, true);
  rmSync(dir, { recursive: true, force: true });
});

test("an absent ledger stays absent — `present: false` survives the union reader", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-empty-"));
  const union = readLedgerUnionBounded(join(dir, "ledger.ndjson"), { satisfied: sawSummary });
  assert.equal(union.length, 0);
  assert.equal(union.present, false, "W1-T119: an absent file is not an empty one");
  rmSync(dir, { recursive: true, force: true });
});

// ── THE BOUND: it stops early, and it stops at all ────────────────────────────────────────────

test("it STOPS as soon as the predicate is satisfied — a newer rotation answers, older ones stay shut", () => {
  const opened: string[] = [];
  const dir = corpus({
    live: [row("run.start")],
    rotations: {
      "ledger.2026-08-11T00-00-00-000Z.ndjson": [row("daemon.summary", { attempted: ["newest"] })],
      "ledger.2026-08-01T00-00-00-000Z.ndjson": [row("daemon.summary", { attempted: ["older"] })],
      "ledger.2026-07-01T00-00-00-000Z.ndjson": [row("daemon.summary", { attempted: ["oldest"] })],
    },
  });
  const union = readLedgerUnionBounded(join(dir, "ledger.ndjson"), {
    satisfied: sawSummary,
    readFileBuffer: (p) => {
      opened.push(p.split("/").pop()!);
      return Buffer.from(readFileSync(p));
    },
  });
  assert.deepEqual(opened, ["ledger.2026-08-11T00-00-00-000Z.ndjson"], "NEWEST first, and only one — the other two are never opened");
  assert.equal(union.filter((l) => l.step === "daemon.summary").length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("the cap stops a search for a step that is never there — otherwise it walks all 669", () => {
  const rotations: Record<string, string[]> = {};
  for (let i = 1; i <= 30; i++) {
    rotations[`ledger.2026-07-${String(i).padStart(2, "0")}T00-00-00-000Z.ndjson`] = [row("run.start")];
  }
  const opened: string[] = [];
  readLedgerUnionBounded(join(corpus({ live: [row("run.start")], rotations }), "ledger.ndjson"), {
    satisfied: (s) => s.has("never.written"),
    readFileBuffer: (p) => {
      opened.push(p);
      return Buffer.from(readFileSync(p));
    },
  });
  assert.equal(opened.length, STATUS_BOARD_MAX_ROTATIONS, `an unsatisfiable predicate must stop at the cap, not at 30`);
});

// ── THE PREFIX CONSUMER: whole lines, not a filtered step list ────────────────────────────────

test("every line is returned unfiltered, so the board's `deploy.` PREFIX match still works", () => {
  // status-board.ts matches `step.startsWith("deploy.")`. A reader that filtered to an exact step
  // list would silently drop the supervisor-tick rung.
  const dir = corpus({
    live: [row("run.start")],
    rotations: { "ledger.2026-08-11T00-00-00-000Z.ndjson": [row("daemon.summary"), row("deploy.idle_ceiling_forced")] },
  });
  const union = readLedgerUnionBounded(join(dir, "ledger.ndjson"), { satisfied: sawSummary });
  assert.equal(
    union.filter((l) => typeof l.step === "string" && (l.step as string).startsWith("deploy.")).length,
    1,
    "a deploy.* step nobody named explicitly must still arrive",
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── TRAP 2: the cost, on the REAL corpus, not a fixture ───────────────────────────────────────

test("the bounded read stays under a second on the REAL 669-rotation corpus", (t) => {
  const real = "/Users/craigoleyagent/Remudero/state/ledger.ndjson";
  if (!existsSync(real)) return t.skip("host ledger absent — this bound is only measurable on the daemon host");
  const started = Date.now();
  const union = readLedgerUnionBounded(real, {
    satisfied: (s) => s.has("daemon.summary") && s.has("daemon.headroom.degraded") && s.has("dispatch.indeterminate"),
  });
  const ms = Date.now() - started;
  // MEASURED at 173 ms; 1000 is the ceiling this must never quietly cross. The full union through
  // `rmd emissions` costs 7.74s — the price the cap exists to refuse.
  assertWallClockBound(ms, 1000, `bounded read took ${ms} ms — a board nobody runs is a board that does not work`);
  assert.ok(
    union.filter((l) => l.step === "daemon.summary").length > 0,
    "and it must actually find the row the one-path reader could not",
  );
});

// ── THE RUNG ITSELF: buildStatusBoard must USE the union, not merely have one available ───────

test("buildStatusBoard renders LAST CLOSED CYCLE from a summary that exists ONLY in a rotation", () => {
  // Every test above proves the READER. This proves the WIRING — a reader nothing calls is the
  // defect restated, and a `deps.readLedger ?? readLedgerLines ?? union` chain would pass them all.
  const root = mkdtempSync(join(tmpdir(), "board-rung-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.ndjson"), row("run.start", { task_id: "T-LIVE" }) + "\n");
  writeFileSync(
    join(stateDir, "ledger.2026-08-11T00-00-00-000Z.ndjson"),
    [
      JSON.stringify({
        ts: "2026-08-12T09:00:00.000Z",
        run_id: "DAEMON-1",
        task_id: "DAEMON",
        step: "daemon.summary",
        attempted: ["W1-T431"],
        merged: [],
        stopReason: "error",
        stopDetail: "spawnDetachedGroup: child process has no pid",
        ticks: 0,
        costUsd: 0,
      }),
    ].join("\n") + "\n",
  );

  const model = buildStatusBoard(root, join(stateDir, "ledger.ndjson"), {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => Date.parse("2026-08-12T12:00:00.000Z"),
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
  } as never);

  assert.equal(model.lastCycle.found, true, "the rung must FIND the rotation's cycle, not render `no cycle recorded`");
  assert.deepEqual(model.lastCycle.summary?.attempted, ["W1-T431"], "and carry its fields");
  assert.equal(model.lastCycle.summary?.stopReason, "error");
  rmSync(root, { recursive: true, force: true });
});

test("an unreadable state dir degrades to the live answer — never a throw", () => {
  // The board is a RENDERING surface: a directory it cannot list must cost it the rotations, not
  // the whole report. Same fail-soft direction readLedgerLines takes on an absent file.
  const dir = corpus({ live: [row("daemon.summary", { attempted: ["LIVE-ONLY"] })] });
  const union = readLedgerUnionBounded(join(dir, "ledger.ndjson"), {
    satisfied: () => false, // never satisfied, so it WOULD go to the rotations if it could
    readdirSync: () => {
      throw new Error("EACCES: permission denied");
    },
  });
  assert.equal(union.length, 1, "the live file still answers");
  assert.deepEqual(union[0].attempted, ["LIVE-ONLY"]);
  rmSync(dir, { recursive: true, force: true });
});
