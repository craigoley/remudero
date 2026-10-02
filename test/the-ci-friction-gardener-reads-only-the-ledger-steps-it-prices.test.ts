// @source-text-subject: W1-T5364 requires a projection-step census; fixture pricing and
// real-reader assertions independently prove that each counted step survives the filter.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CI_FRICTION_LEDGER_STEPS, ciFrictionRoundsFromLedger, priceCiFrictionCauses, readCiFrictionLedgerRecords, readCiFrictionPlanTasks } from "../src/lib/ci-friction-gardener.js";
import { readLedgerUnionRecordsSync } from "../src/lib/ledger-union.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const rows = [
  { step: "pr.opened", run_id: "run-a", pr_url: "https://github.com/a/b/pull/1", ts: "2026-09-20T12:00:00Z" },
  { step: "fix.dispatch", run_id: "run-a", mode: "merge-conflict", round: 1, ts: "2026-09-20T12:25:00Z" },
  { step: "fix.commit_refused", run_id: "run-a", round: 1, reason: "the worker changed nothing", ts: "2026-09-20T12:26:00Z" },
  { step: "sweep.disposed", head_sha: "head-a", pr_number: 2, red_checks: ["ci"], ts: "2026-09-20T12:00:00Z" },
  { step: "fix.dispatch", run_id: "DAEMON-a", head_sha: "head-a", mode: "ci-log", elapsed_ms: 600000, ts: "2026-09-20T12:35:00Z" },
  { step: "test.flake_retry", file: "some.test.ts" },
  { step: "fix.base_refreshed", run_id: "run-a", matching_base_files: ["src/a.ts"], ts: "2026-09-20T12:40:00Z" },
  { step: "ci-friction.remedy_escalated", origin: "ci-friction:check:ci-log" },
  { step: "ci-friction.scorecard", pr_url: "https://github.com/a/b/pull/3", untracked: "check:ci-log" },
];

test("the-ci-friction-gardener-reads-only-the-ledger-steps-it-prices.test.ts: filtered pricing and strict history coverage", () => {
  const noise = Array.from({ length: 500 }, (_, i) => ({ step: "heartbeat.tick", ordinal: i }));
  const fixture = writeLedger([...rows.slice(6), ...noise], { rotations: [
    { at: "2026-09-20T12:01:00.000Z", rows: rows.slice(0, 3) },
    { at: "2026-09-20T12:36:00.000Z", gz: true, rows: rows.slice(3, 6) },
  ] });
  writeFileSync(join(fixture.dir, "ledger.legacy.ndjson.gz"), readFileSync(join(fixture.dir, "ledger.2026-09-20T12-36-00-000Z.ndjson.gz")));
  const calls: Parameters<typeof readLedgerUnionRecordsSync>[1][] = [];
  const reader: typeof readLedgerUnionRecordsSync = (dir, options, fs) => {
    calls.push(options);
    return readLedgerUnionRecordsSync(dir, options, fs);
  };
  const filtered = readCiFrictionLedgerRecords(fixture.dir, reader);
  assert.equal(calls.length, 1, "complete run/head attribution avoids a second scan");
  assert.deepEqual(calls[0]?.step, CI_FRICTION_LEDGER_STEPS);
  assert.equal(calls[0]?.requireArchives, true);
  assert.equal(calls[0]?.refuseIncomplete, true);
  assert.equal(filtered.length, rows.length, "all three rotation forms are deduplicated and noise is discarded");
  const unfiltered = readLedgerUnionRecordsSync(fixture.dir, { requireArchives: true, refuseIncomplete: true });
  assert.ok(unfiltered.rows.length > filtered.length);
  const at = Date.parse("2026-09-21T12:00:00Z");
  const priced = priceCiFrictionCauses(ciFrictionRoundsFromLedger(filtered), undefined, at);
  assert.ok(priced.length > 0, "a positive pricing control prevents an empty-equals-empty result");
  assert.deepEqual(priced, priceCiFrictionCauses(ciFrictionRoundsFromLedger(unfiltered.rows), undefined, at));
});

test("every ci-friction projection step is covered by the retained step census", () => {
  const source = readFileSync(new URL("../src/lib/ci-friction-gardener.ts", import.meta.url), "utf8");
  const compared = [...source.matchAll(/\b(?:r|row)\.step\s*(?:===|!==)\s*["']([^"']+)["']/g)].map(match => match[1]!);
  assert.ok(compared.length >= 8, "the census sees the current projections");
  const fixture = writeLedger(compared.map(step => ({ step })), { rotations: [{ at: "2026-09-20T12:00:00.000Z", rows: [] }] });
  const retained = new Set(readCiFrictionLedgerRecords(fixture.dir).map(row => row.step));
  assert.deepEqual(compared.filter(step => !retained.has(step)), [], "each projection's step survives the real reader");
});

test("a missing sweep association is recovered selectively without losing or duplicating priced rounds", () => {
  const dispatch = { step: "fix.dispatch", run_id: "DAEMON-b", head_sha: "head.[b]", mode: "merge-conflict", elapsed_ms: 120000, ts: "2026-09-20T12:10:00Z" };
  const fixture = writeLedger([dispatch,
    { ...dispatch, head_sha: "head-c" },
    { step: "review.posted", head_sha: "head.[b]", pr_url: "https://github.com/a/b/pull/42", raw: "private-log" },
    { step: "review.posted", head_sha: "head.[b]", pr_number: 999 },
    { step: "review.posted", head_sha: "head-c", pr_url: "https://github.com/a/b/issues/43" },
    { step: "review.posted", head_sha: "head-c", pr_number: 43 },
    { step: "heartbeat.tick", raw: "head.[b]" },
    { step: "review.posted", head_sha: "unrelated", raw: "head-c", pr_number: 1000 }],
    { rotations: [{ at: "2026-09-20T12:00:00.000Z", rows: [{ step: "heartbeat.tick" }] }] });
  const calls: Parameters<typeof readLedgerUnionRecordsSync>[1][] = [];
  const filtered = readCiFrictionLedgerRecords(fixture.dir, (dir, options, fs) => {
    calls.push(options); return readLedgerUnionRecordsSync(dir, options, fs);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.requireArchives, true);
  assert.equal(calls[1]?.refuseIncomplete, true);
  assert.equal(calls[1]?.pattern?.test(JSON.stringify({ head_sha: "head.[b]" })), true);
  assert.equal(calls[1]?.pattern?.test(JSON.stringify({ head_sha: "head-Xb" })), false);
  assert.deepEqual(filtered.slice(2), [{ step: "review.posted", head_sha: "head.[b]", pr_number: 42 },
    { step: "review.posted", head_sha: "head-c", pr_number: 43 }]);
  assert.equal(JSON.stringify(filtered).includes("private-log"), false);
  const all = readLedgerUnionRecordsSync(fixture.dir).rows;
  assert.deepEqual(ciFrictionRoundsFromLedger(filtered), ciFrictionRoundsFromLedger(all));
  assert.equal(ciFrictionRoundsFromLedger(filtered)[0]?.minutes, 2);
});

test("archive absence, unreadable archives and incomplete association reads refuse the gardener pass", () => {
  const absent = writeLedger(rows);
  assert.throws(() => readCiFrictionLedgerRecords(absent.dir), /no ledger rotations/);
  const broken = writeLedger(rows, { rotations: [{ at: "2026-09-20T12:00:00.000Z", rows: [] }] });
  writeFileSync(join(broken.dir, "ledger.broken.ndjson.gz"), "not gzip");
  assert.throws(() => readCiFrictionLedgerRecords(broken.dir), /unread ledger file/);
  const result = readLedgerUnionRecordsSync(broken.dir);
  assert.throws(() => readCiFrictionLedgerRecords(broken.dir, () => ({ ...result, ok: false, unread: [] })), /incomplete ledger union/);
  let n = 0;
  assert.throws(() => readCiFrictionLedgerRecords(broken.dir, () => ++n === 1
    ? { ...result, ok: true, rows: [{ step: "fix.dispatch", run_id: "D", head_sha: "h" }] }
    : { ...result, ok: false }), /unread ledger file/);
});

test("plan status history searches only the current friction shards and preserves trailer and status timing", () => {
  const paths = ["plan/tasks.d/one.yaml", "plan/tasks.d/two.yaml"];
  let walks = 0;
  const tasks = readCiFrictionPlanTasks(args => {
    if (args[0] === "grep") return paths.map(path => `origin/main:${path}`).join("\n");
    if (args[0] === "show") {
      const id = args[1]!.endsWith("one.yaml") ? "W1-T1" : "W1-T2";
      return `- id: ${id}\n  title: "remedy"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: low\n  status: merged\n  attempts: 0\n  origin: "ci-friction:check:ci-log"\n  files: [src/lib/ci-friction-gardener.ts]\n  acceptance: [{claim: "c", proof: "unit test: p"}]\n`;
    }
    assert.equal(args[0], "log");
    if (!args.includes("-S")) return "2026-09-20T12:00:00Z\tW1-T1\n";
    walks++;
    assert.deepEqual(args.slice(args.indexOf("--") + 1), paths, "avoid pickaxing every unrelated plan shard");
    return `\x012026-09-21T12:00:00Z\n${paths[1]}\n`;
  }, "plan/tasks.d");
  assert.equal(walks, 1);
  assert.deepEqual(tasks.map(task => [task.id, task.mergedAt]), [["W1-T1", "2026-09-20T12:00:00Z"], ["W1-T2", "2026-09-21T12:00:00Z"]]);
});
