/**
 * W1-T5759 — A REOPENED PR KEEPS THE SWEEP ROWS WRITTEN AFTER ITS TERMINAL ROW.
 *
 * `pruneCarriedRows` used to drop every `sweep.disposed` / `review.posted` row of a PR with ANY `pr.terminal`
 * row, wherever it sat in the file, and the terminal rung skipped any PR that already had one. A PR closed and
 * then reopened lost its live sweep history at the next rotation and was never given a second terminal row.
 *
 * Falsifier: keep the order-blind merged set and the first test sees the post-terminal rows pruned.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../src/lib/tmp.js";
import { readLedgerLines } from "../src/lib/status.js";
import { rotateLedger } from "../src/lib/ledger.js";
import { pruneCarriedRows, PR_TERMINAL_STEP } from "../src/lib/ledger-carry.js";
import { closedPrLookup, runPrTerminalReconcile } from "../src/lib/sweep.js";

const url = (n: number): string => `https://github.com/o/r/pull/${n}`;
const at = (offsetMs: number): string => new Date(Date.now() - 60_000 + offsetMs).toISOString();
const row = (o: Record<string, unknown>): string => JSON.stringify({ run_id: "SWEEP-1", ...o });
const disposed = (n: number, ts: string, head: string): string =>
  row({ ts, task_id: "SWEEP", step: "sweep.disposed", pr_number: n, pr_url: url(n), head_sha: head, disposition: "waiting", acted: false });
const posted = (n: number, ts: string, head: string): string =>
  row({ ts, task_id: "SWEEP", step: "review.posted", pr_url: url(n), head_sha: head });
const terminal = (n: number, ts: string, state = "closed"): string =>
  row({ ts, task_id: "SWEEP", step: PR_TERMINAL_STEP, pr_url: url(n), pr_number: n, state });

function ledger(lines: string[]): { dir: string; ledgerPath: string } {
  const dir = makeTempDir("w1-t5759");
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, lines.join("\n") + "\n");
  return { dir, ledgerPath };
}

const terminalRows = (ledgerPath: string, n: number) =>
  readLedgerLines(ledgerPath).filter((l) => l.step === PR_TERMINAL_STEP && l.pr_number === n);
const live = (ledgerPath: string, n: number) =>
  readLedgerLines(ledgerPath).filter((l) => l.pr_url === url(n)).map((l) => `${String(l.step)}:${String(l.head_sha ?? l.state ?? "")}`);
const close = (n: number) => closedPrLookup([{ prUrl: url(n), prNumber: n, state: "closed" }]);

test("a reopened PR's sweep rows after its terminal row survive a rotation, the rows before it drop", () => {
  const noise = Array.from({ length: 400 }, (_, i) => row({ ts: at(i), task_id: "X", step: "w1t5759.noise", pad: "x".repeat(400), i }));
  const { dir, ledgerPath } = ledger([
    disposed(81, at(1), "before"),
    posted(81, at(2), "before"),
    terminal(81, at(3)),
    disposed(81, at(4), "after"),
    posted(81, at(5), "after"),
    ...noise,
  ]);
  const size = readFileSync(ledgerPath).length;
  const rotated = rotateLedger(ledgerPath, { ceilingBytes: Math.floor(size / 2), smoothingWindowMs: 0 });
  assert.equal(rotated.rotated, true);
  assert.deepEqual(live(ledgerPath, 81), [
    `${PR_TERMINAL_STEP}:closed`, "sweep.disposed:after", "review.posted:after",
  ], "only the rows written after the closed terminal row are carried");
  rmSync(dir, { recursive: true, force: true });
});

test("a merged terminal fact stays order-blind, and a later closed fact covers only what precedes it", () => {
  const parse = (raw: string) => {
    const json = JSON.parse(raw) as Record<string, unknown>;
    return { json, step: json.step as string };
  };
  const kept = pruneCarriedRows([
    disposed(91, at(1), "a"), terminal(91, at(2), "merged"), disposed(91, at(3), "b"),
    disposed(92, at(1), "a"), terminal(92, at(2)), disposed(92, at(3), "b"), terminal(92, at(4)), disposed(92, at(5), "c"),
  ].map(parse));
  const keptOf = (n: number) => kept.filter((r) => r.json.pr_url === url(n)).map((r) => `${r.step}:${String(r.json.head_sha ?? r.json.state)}`);
  assert.deepEqual(keptOf(91), [`${PR_TERMINAL_STEP}:merged`], "a merge cannot be reopened: every sweep row drops");
  assert.deepEqual(keptOf(92), [`${PR_TERMINAL_STEP}:closed`, `${PR_TERMINAL_STEP}:closed`, "sweep.disposed:c"], "the LAST closed fact is the boundary");
});

test("a PR closed again after a reopen gets exactly one new terminal row, then none", () => {
  const { dir, ledgerPath } = ledger([disposed(82, at(1), "a"), terminal(82, at(2)), disposed(82, at(3), "b")]);
  assert.equal(runPrTerminalReconcile(close(82), { ledgerPath, runId: "SWEEP-2" }).appended, 1, "the reopen's rows follow the old terminal row");
  assert.equal(terminalRows(ledgerPath, 82).length, 2);
  assert.equal(runPrTerminalReconcile(close(82), { ledgerPath, runId: "SWEEP-3" }).appended, 0, "the new row covers them");
  assert.equal(terminalRows(ledgerPath, 82).length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("a closed PR with nothing written after its terminal row, or a merged one, gets no second row", () => {
  const { dir, ledgerPath } = ledger([
    disposed(83, at(1), "a"), terminal(83, at(2)),
    disposed(84, at(1), "a"), terminal(84, at(2), "merged"), disposed(84, at(3), "late"),
  ]);
  const both = closedPrLookup([{ prUrl: url(83), prNumber: 83, state: "closed" }, { prUrl: url(84), prNumber: 84, state: "merged" }]);
  assert.equal(runPrTerminalReconcile(both, { ledgerPath, runId: "SWEEP-2" }).appended, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a terminal row that only an archive holds is superseded by a live row written after it", () => {
  const filler = Array.from({ length: 200 }, (_, i) => terminal(1000 + i, at(10 + i), "merged"));
  const noise = Array.from({ length: 400 }, (_, i) => row({ ts: at(i), task_id: "X", step: "w1t5759.noise", pad: "x".repeat(400), i }));
  const { dir, ledgerPath } = ledger([row({ ts: at(1), task_id: "SWEEP", step: "pr.opened", pr_url: url(85) }), terminal(85, at(2)), ...filler, ...noise]);
  const size = readFileSync(ledgerPath).length;
  assert.equal(rotateLedger(ledgerPath, { ceilingBytes: Math.floor(size / 2), smoothingWindowMs: 0 }).rotated, true);
  assert.equal(terminalRows(ledgerPath, 85).length, 0, "precondition: the live file lost #85's terminal row");

  const first = runPrTerminalReconcile(close(85), { ledgerPath, runId: "SWEEP-2" });
  assert.equal(first.appended, 0, "nothing was written after the archived terminal row");
  assert.equal(first.unionRead, true);

  appendFileSync(ledgerPath, disposed(85, at(5000), "reopened") + "\n");
  assert.equal(runPrTerminalReconcile(close(85), { ledgerPath, runId: "SWEEP-3" }).appended, 1, "reopened and closed again");
  assert.equal(runPrTerminalReconcile(close(85), { ledgerPath, runId: "SWEEP-4" }).appended, 0, "exactly one");
  assert.equal(terminalRows(ledgerPath, 85).length, 1);
  rmSync(dir, { recursive: true, force: true });
});
