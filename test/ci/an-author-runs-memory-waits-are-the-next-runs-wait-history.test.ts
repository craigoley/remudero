// W1-T10926: every stage of a Mac author run that waited out memory pressure is written to the run's verdict row, and
// the next run reads those rows back as that stage's own past waits, from which its wait limit is derived
// (macPressureWaitLimit in scripts/lib/mac-author-admission.mjs; the wait itself is tested in
// test/infra/the-author-preflight-admits-warning-pressure-against-its-measured-need.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import * as authorModule from "#scripts/preflight-author.mjs";
// @ts-ignore the executable .mjs module has no declaration file.
import { readMacAuthorAdmission } from "#scripts/lib/mac-author-admission.mjs";

const author = authorModule as unknown as {
  authorVerdictRow: (receipt: object, context?: object) => Record<string, unknown>;
  authorPressureWaitHistory: (stage: string, options?: { ledger?: () => { root?: string; reason?: string };
    read?: (path: string) => string; log?: (line: string) => void }) => number[];
  runGuardedAuthor: (argv: string[], deps: object) => number;
};
type Row = Record<string, unknown>;

test("W1-T10926: each wait is written to the verdict row and read back as that stage's history", () => {
  const wait = (outcome: string, waitedMs: number) => ({ outcome, waitedMs, limitMs: 30_000, limitBasis: "focused-sampling-span" });
  const row = author.authorVerdictRow({ verdict: "over-capacity", pushEligible: false, dryRun: false, steps: [],
    startedAt: "2026-11-18T22:00:00.000Z", durationMs: 1,
    hostCapacity: [{ stage: "static-preflight", state: "admitted", pressureWait: wait("admitted", 10_000) },
      { stage: "affected-tests", state: "admitted" }] },
  { entryCapacity: { state: "admitted", pressureWait: wait("admitted", 15_000) } });
  assert.deepEqual(row.pressure_waits, [
    { stage: "entry", waited_ms: 15_000, outcome: "admitted", limit_ms: 30_000, limit_basis: "focused-sampling-span" },
    { stage: "static-preflight", waited_ms: 10_000, outcome: "admitted", limit_ms: 30_000, limit_basis: "focused-sampling-span" }]);
  assert.equal(Object.hasOwn(author.authorVerdictRow({ verdict: "passed", steps: [], dryRun: false }), "pressure_waits"), false,
    "a run that never waited adds no field");
  const ledger = [JSON.stringify({ step: "author_preflight.passed", ...row }), '{"step":"author_preflight.passed","pressure_waits":[{"st',
    JSON.stringify({ step: "author_preflight.refused", pressure_waits: [{ stage: "entry", waited_ms: 30_000, outcome: "refused" }] }),
    JSON.stringify({ step: "author_preflight.passed" })].join("\n");
  const paths: string[] = [];
  const read = (path: string) => { paths.push(path); return ledger; };
  assert.deepEqual(author.authorPressureWaitHistory("entry", { ledger: () => ({ root: "/ledger-root" }), read }), [15_000, 30_000]);
  assert.deepEqual(author.authorPressureWaitHistory("static-preflight", { ledger: () => ({ root: "/ledger-root" }), read }), [10_000]);
  assert.ok(paths.every((path) => path.startsWith("/ledger-root/")), paths.join(","));
  assert.deepEqual(author.authorPressureWaitHistory("entry", { ledger: () => ({ reason: "a test-runner process has no configured ledger" }) }), []);
  const logged: string[] = [];
  assert.deepEqual(author.authorPressureWaitHistory("entry", { ledger: () => ({ root: "/ledger-root" }),
    read: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); }, log: (line) => logged.push(line) }), []);
  assert.match(logged.join("\n"), /no pressure-wait history read \(ENOENT\); the entry wait limit uses its sampling rule/);
  // The default reader asks the configured ledger, which a test runner does not have.
  assert.deepEqual(author.authorPressureWaitHistory("entry"), []);
});

test("W1-T10926: the guarded CLI entry waits with its memory seams and hands each stage's wait to the verdict row", () => {
  let time = 0, flag = "4";
  const memory = { now: () => time, wait: (ms: number) => { time += ms; }, pastWaits: () => [],
    sample: () => ({ at: time, pressure: flag === "4" ? "critical" : "normal", pageBytes: 16384, swapins: 0, swapouts: 0,
      freePlusInactiveBytesApprox: 16 * 1024 ** 3, swapFreeBytes: 4 * 1024 ** 3 }) };
  const readAdmission = (root: string, options: object = {}) => readMacAuthorAdmission(root, { ...options, platform: "darwin",
    scratch: "/scratch", statfs: () => ({ bavail: 30 * 1024 ** 3, bsize: 1 }), spawn: () => ({ status: 0, stdout: `${flag}\n` }) });
  const rows: Row[] = [];
  const verdictLedger = { ledger: () => ({ root: "/ledger-root" }), append: (row: Row) => { rows.push(row); return { written: true, path: "/l" }; },
    log: () => {} };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(author.runGuardedAuthor([], { root: "/w", readAdmission, memory, verdictLedger, runAuthor: () => 0 }), 3);
  } finally { console.error = quiet; }
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].capacity_reasons, ["pressure:critical"]);
  assert.deepEqual((rows[0].pressure_waits as Row[]).map((wait) => [wait.stage, wait.outcome, wait.waited_ms]), [["entry", "refused", 30_000]]);
  // Pressure that clears: the run starts, and main is handed the entry's wait for its own row.
  time = 0;
  let handed: Row | undefined;
  const sample = memory.sample;
  memory.sample = () => { const row = sample(); if (time >= 10_000) flag = "1"; return row; };
  flag = "4";
  assert.equal(author.runGuardedAuthor([], { root: "/w", readAdmission, memory, verdictLedger,
    runAuthor: (_argv: string[], deps: { verdictLedger: { entryCapacity: Row } }) => { handed = deps.verdictLedger.entryCapacity; return 0; } }), 0);
  assert.equal((handed?.pressureWait as Row).outcome, "admitted");
});
