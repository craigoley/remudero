import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  auditLedgerUnion,
  createLedgerRotationMemo,
  openLedgerUnion,
  readLedgerUnionRawLinesSync,
  readLedgerUnionRecords,
  readLedgerUnionRecordsMemoized,
  readLedgerUnionRecordsSync,
  resolveLedgerUnion,
} from "../src/lib/ledger-union.js";
import { readLedgerLines } from "../src/lib/status.js";
import { runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T4710 — `resolveLedgerUnion` accepted `LedgerUnionOptions.step` and its raw-line reader never
// consulted it, so the sweep's arm-recovery read (W1-T3471: pattern `.*`, step review.posted)
// decompressed and RETURNED the whole corpus while reading as a review.posted query. Every union
// reader now applies the same exact step match; none silently ignores it.

const TASK = "W1-T4710";
const HEAD = "head-4710";

function row(step: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts: "2026-09-20T10:00:00.000Z", run_id: `RUN-${step}`, task_id: TASK, step, ...over };
}

function ndjson(rows: Array<Record<string, unknown>>): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

interface Fixture {
  dir: string;
  cleanup: () => void;
}

/** Two archives (one .gz, one plain) plus the live file — each carries one review.posted row and
 *  noise that NAMES review.posted without being one, so a substring-only filter would leak it. */
function fixture(extra: { gz?: Array<Record<string, unknown>>; plain?: Array<Record<string, unknown>>; live?: Array<Record<string, unknown>> } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}union-step-`));
  const gzRows = extra.gz ?? [
    row("review.posted", { origin: "gz", head_sha: HEAD, capped: false, plan_only: false }),
    row("verdict", { origin: "gz" }),
    row("sweep.disposed", { origin: "gz", reason: "awaiting \"review.posted\"" }),
  ];
  const plainRows = extra.plain ?? [
    row("review.posted", { origin: "plain", head_sha: HEAD, capped: false, plan_only: false }),
    row("automerge.armed", { origin: "plain" }),
    row("review.posted.retry", { origin: "plain" }),
  ];
  const liveRows = extra.live ?? [
    row("review.posted", { origin: "live", head_sha: HEAD, capped: false, plan_only: false }),
    row("verdict", { origin: "live", nested: { step: "review.posted" } }),
  ];
  writeFileSync(join(dir, "ledger.2026-09-18T00-00-00-000Z.ndjson.gz"), gzipSync(Buffer.from(ndjson(gzRows))));
  writeFileSync(join(dir, "ledger.2026-09-19T00-00-00-000Z.ndjson"), ndjson(plainRows) + "{torn review.posted line\n");
  writeFileSync(join(dir, "ledger.ndjson"), ndjson(liveRows));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function steps(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((r) => String(r.step));
}

function origins(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((r) => String(r.origin)).sort();
}

function parsed(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("W1-T4710: resolveLedgerUnion with pattern .* and step review.posted returns only review.posted rows from the .gz, plain and live forms", () => {
  const fx = fixture();
  try {
    const union = resolveLedgerUnion(fx.dir, ".*", undefined, { step: "review.posted" });
    assert.equal(union.ok, true);
    assert.equal(union.archiveCount, 2, "control: both rotation forms were enumerated");
    assert.equal(union.liveFileRead, true, "control: the live file was read");
    const rows = parsed(union.matches);
    assert.deepEqual(steps(rows), ["review.posted", "review.posted", "review.posted"]);
    assert.deepEqual(origins(rows), ["gz", "live", "plain"], "one review.posted row from EACH form");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4710: a step list returns only rows of the listed steps, matched exactly", () => {
  const fx = fixture();
  try {
    const union = resolveLedgerUnion(fx.dir, ".*", undefined, { step: ["verdict", "automerge.armed"] });
    const rows = parsed(union.matches);
    assert.deepEqual(steps(rows).sort(), ["automerge.armed", "verdict", "verdict"]);
    assert.deepEqual(origins(rows), ["gz", "live", "plain"]);

    const raw = readLedgerUnionRawLinesSync(fx.dir, { step: ["review.posted.retry"] });
    assert.deepEqual(steps(parsed(raw.rawLines)), ["review.posted.retry"], "a longer step sharing a prefix is its own step");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4710: a pattern-only read is unchanged — every line the pattern matches, torn lines included", () => {
  const fx = fixture();
  try {
    const all = resolveLedgerUnion(fx.dir, ".*");
    assert.equal(all.matches.length, 9, "3 gz + 3 plain + 1 torn + 2 live: no step filter applies");
    assert.ok(all.matches.includes("{torn review.posted line"), "a torn line still reaches a pattern-only caller");

    const narrowed = resolveLedgerUnion(fx.dir, /review\.posted/);
    assert.equal(narrowed.matches.length, 7, "a pattern that names the step still returns the noise rows naming it");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4710: the step filter composes with the pattern — both must match", () => {
  const fx = fixture();
  try {
    const union = resolveLedgerUnion(fx.dir, /"origin":"(gz|live)"/, undefined, { step: "review.posted" });
    assert.deepEqual(origins(parsed(union.matches)), ["gz", "live"]);
  } finally {
    fx.cleanup();
  }
});

test("W1-T4710: every union reader honours step identically — none silently ignores it", async () => {
  const fx = fixture();
  try {
    const want = ["gz", "live", "plain"];
    assert.deepEqual(origins(parsed(readLedgerUnionRawLinesSync(fx.dir, { step: "review.posted" }).rawLines)), want, "readLedgerUnionRawLinesSync");
    assert.deepEqual(origins(readLedgerUnionRecordsSync(fx.dir, { step: "review.posted" }).rows), want, "readLedgerUnionRecordsSync");
    assert.deepEqual(origins(await readLedgerUnionRecords(fx.dir, { step: "review.posted" })), want, "readLedgerUnionRecords");
    const streamed: Array<Record<string, unknown>> = [];
    for await (const r of openLedgerUnion(fx.dir, { step: "review.posted" })) streamed.push(r);
    assert.deepEqual(origins(streamed), want, "openLedgerUnion");
    const memo = createLedgerRotationMemo((rows) => rows);
    assert.deepEqual(origins((await readLedgerUnionRecordsMemoized(fx.dir, memo, { step: "review.posted" })).rows), want, "readLedgerUnionRecordsMemoized");
    const audited: Array<Record<string, unknown>> = [];
    const audit = await auditLedgerUnion(fx.dir, { step: "review.posted", dedupeWindowPerStep: 200, onRecord: (r) => audited.push(r) });
    assert.equal(audit.ok, true);
    assert.deepEqual(origins(audited), ["gz", "plain"], "auditLedgerUnion (archives only, by design)");
  } finally {
    fx.cleanup();
  }
});

// Stamped from the clock, never a fixed date: a fixed activity stamp crosses sweep.staleDays on its own.
const NOW = Date.now();

function greenPr(): OpenPrView {
  return {
    prNumber: 4710,
    prUrl: "https://github.com/craigoley/remudero/pull/4710",
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    headSha: HEAD,
    autoMergeArmed: false,
  };
}

function sweepDeps(dir: string): SweepDeps & { armed: OpenPrView[] } {
  const armed: OpenPrView[] = [];
  return {
    armed,
    arm: (p) => {
      armed.push(p);
    },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: join(dir, "ledger.ndjson"),
    runId: "SWEEP-4710",
    now: () => NOW,
    // The live-file miss that sends the arm predicate to its default union read (W1-T3471).
    readLedger: () => [],
  };
}

test("W1-T4710: the sweep's arm read is a review.posted query — the exact call returns only review.posted rows", () => {
  const fx = fixture();
  try {
    // The argument tuple `runSweep`'s default `readArmLedgerUnion` passes (src/lib/sweep.ts).
    const union = resolveLedgerUnion(fx.dir, ".*", undefined, { step: "review.posted" });
    assert.ok(union.matches.length > 0);
    assert.ok(parsed(union.matches).every((r) => r.step === "review.posted"), "every row the arm read receives is a review.posted row");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4710: the sweep's default arm read still recovers an archived verdict and still refuses on a complete union with none", async () => {
  const recovered = fixture({
    gz: [row("review.posted", { head_sha: HEAD, capped: false, plan_only: false }), row("verdict")],
    plain: [row("automerge.armed")],
    live: [],
  });
  try {
    const deps = sweepDeps(recovered.dir);
    await runSweep([greenPr()], deps);
    assert.deepEqual(deps.armed.map((p) => p.prNumber), [4710], "a verdict only in the .gz archive is recovered through the filtered read and arms");
  } finally {
    recovered.cleanup();
  }

  const absent = fixture({
    gz: [row("verdict", { head_sha: HEAD, capped: false })],
    plain: [row("review.posted.retry", { head_sha: HEAD, capped: false })],
    live: [],
  });
  try {
    const deps = sweepDeps(absent.dir);
    const summary = await runSweep([greenPr()], deps);
    assert.deepEqual(deps.armed, [], "a complete union with no review.posted verdict still refuses");
    assert.equal(summary.actions[0]?.acted, false);
    const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
    assert.match(String(disposed[0]?.stand_down_reason), /complete ledger union shows no review\.posted verdict/);
  } finally {
    absent.cleanup();
  }
});
