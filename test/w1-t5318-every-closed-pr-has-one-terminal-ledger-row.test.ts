/**
 * W1-T5318 — EVERY CLOSED PR GETS ONE TERMINAL LEDGER ROW, FROM ITS OWN CLOSED STATE.
 *
 * `verdict.merged` is written per PLAN TASK (the sweep's credit backfill), so a PR with no plan task
 * — a plan filing, a fleet fix, a dependency bump — and every PR closed without merging never got a
 * terminal fact. `pruneCarriedRows` drops a PR's sweep rows only on such a fact, so those rows rode
 * every rotation. Measured 2026-10-04: 1,374 of 1,378 live `sweep.disposed` rows and all 150 live
 * `review.posted` rows belonged to PRs no longer open.
 *
 * Falsifier: feed the reconciler only plan-task PRs and the first two tests find no row; drop
 * `pr.terminal` from `recordedMergeKey` and the fourth sees the merged PR's sweep rows carried.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTickReadProducer, sweepPrTerminalRung } from "../src/run-task.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { loadPlan } from "../src/lib/plan.js";
import { readLedgerLines } from "../src/lib/status.js";
import { rotateLedger } from "../src/lib/ledger.js";
import { pruneCarriedRows, PR_TERMINAL_STEP } from "../src/lib/ledger-carry.js";
import { closedPrFacts, closedPrFromRef, closedPrLookup, runPrTerminalReconcile, type ClosedPrFact } from "../src/lib/sweep.js";

const url = (n: number, slug = "o/r"): string => `https://github.com/${slug}/pull/${n}`;
const nowIso = (): string => new Date().toISOString();
const row = (o: Record<string, unknown>): string => JSON.stringify({ ts: nowIso(), run_id: "SWEEP-1", ...o });
const disposed = (n: number, extra: Record<string, unknown> = {}): string =>
  row({ task_id: "SWEEP", step: "sweep.disposed", pr_number: n, pr_url: url(n), disposition: "waiting", acted: false, ...extra });

function ledger(lines: string[]): { dir: string; ledgerPath: string } {
  const dir = makeTempDir("w1-t5318");
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, lines.length > 0 ? lines.join("\n") + "\n" : "");
  return { dir, ledgerPath };
}

const terminalRows = (ledgerPath: string, n?: number) =>
  readLedgerLines(ledgerPath).filter((l) => l.step === PR_TERMINAL_STEP && (n === undefined || l.pr_number === n));

test("W1-T5318: a merged PR with no plan task gets exactly one terminal merge row", () => {
  // PR #41 is a fleet fix: no Remudero-Task trailer, no plan task, so no credit candidate ever names it.
  const { dir, ledgerPath } = ledger([disposed(41)]);
  const merged: ClosedPrFact = { prUrl: url(41), prNumber: 41, state: "merged", at: "2026-10-04T01:02:03Z" };
  const summary = runPrTerminalReconcile(closedPrLookup([merged]), { ledgerPath, runId: "SWEEP-2" });
  assert.equal(summary.appended, 1);
  const rows = terminalRows(ledgerPath);
  assert.equal(rows.length, 1, "exactly one terminal row");
  assert.equal(rows[0].pr_url, url(41));
  assert.equal(rows[0].pr_number, 41);
  assert.equal(rows[0].state, "merged");
  assert.equal(rows[0].merged_at, "2026-10-04T01:02:03Z");
  assert.equal(rows[0].source, "sweep.pr_terminal");
  rmSync(dir, { recursive: true, force: true });
});

test("W1-T5318: a PR closed without merging gets exactly one terminal closed row", () => {
  const { dir, ledgerPath } = ledger([disposed(42), disposed(42, { disposition: "blocked-fixable" })]);
  const closed: ClosedPrFact = { prUrl: url(42), prNumber: 42, state: "closed", at: "2026-10-04T02:00:00Z" };
  runPrTerminalReconcile(closedPrLookup([closed]), { ledgerPath, runId: "SWEEP-2" });
  const rows = terminalRows(ledgerPath);
  assert.equal(rows.length, 1, "one row per PR, however many rows name it");
  assert.equal(rows[0].state, "closed");
  assert.equal(rows[0].closed_at, "2026-10-04T02:00:00Z");
  assert.equal(rows[0].merged_at, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("W1-T5318: a second reconcile pass appends no duplicate terminal row", () => {
  // pr.opened keeps naming #43 in the live file after the rotation archives its terminal row.
  const { dir, ledgerPath } = ledger([row({ task_id: "SWEEP", step: "pr.opened", pr_url: url(43) }), disposed(43)]);
  const lookup = closedPrLookup([{ prUrl: url(43), prNumber: 43, state: "merged" }]);
  assert.equal(runPrTerminalReconcile(lookup, { ledgerPath, runId: "SWEEP-1" }).appended, 1);
  assert.equal(runPrTerminalReconcile(lookup, { ledgerPath, runId: "SWEEP-2" }).appended, 0, "the live row dedups");
  assert.equal(terminalRows(ledgerPath, 43).length, 1);

  // 200 newer terminal rows push #43's out of the per-step cap; noise makes the file rotate.
  const filler = Array.from({ length: 200 }, (_, i) =>
    row({ task_id: "SWEEP", step: PR_TERMINAL_STEP, pr_url: url(1000 + i), pr_number: 1000 + i, state: "merged" }));
  const noise = Array.from({ length: 400 }, (_, i) => row({ task_id: "X", step: "w1t5318.noise", pad: "x".repeat(400), i }));
  appendFileSync(ledgerPath, [...filler, ...noise].join("\n") + "\n");
  const size = readFileSync(ledgerPath).length;
  const rotated = rotateLedger(ledgerPath, { ceilingBytes: Math.floor(size / 2), smoothingWindowMs: 0 });
  assert.equal(rotated.rotated, true);
  assert.equal(terminalRows(ledgerPath, 43).length, 0, "precondition: the live file lost #43's terminal row");
  assert.ok(readLedgerLines(ledgerPath).some((l) => l.step === "pr.opened" && l.pr_url === url(43)), "but still names #43");
  assert.ok(readdirSync(dir).some((name) => /^ledger\..*\.ndjson(\.gz)?$/.test(name)), "an archive holds the row");

  const after = runPrTerminalReconcile(lookup, { ledgerPath, runId: "SWEEP-3" });
  assert.equal(after.appended, 0, "the union of live file and archives dedups after a rotation");
  assert.equal(after.unionRead, true);
  assert.equal(terminalRows(ledgerPath, 43).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("W1-T5318: ledger carry drops the sweep rows of a PR whose only merge fact is the terminal row", () => {
  const parse = (raw: string) => {
    const json = JSON.parse(raw) as Record<string, unknown>;
    return { json, step: json.step as string };
  };
  const rows = [
    disposed(51),
    disposed(51, { disposition: "blocked-fixable", acted: true }),
    row({ task_id: "SWEEP", step: "review.posted", pr_url: url(51), head_sha: "a" }),
    row({ task_id: "SWEEP", step: PR_TERMINAL_STEP, pr_url: url(51), pr_number: 51, state: "merged" }),
    disposed(52),
    row({ task_id: "SWEEP", step: PR_TERMINAL_STEP, pr_url: url(52), pr_number: 52, state: "closed" }),
    disposed(53),
  ].map(parse);
  const kept = pruneCarriedRows(rows);
  const keptOf = (n: number) => kept.filter((r) => r.json.pr_url === url(n)).map((r) => `${r.step}:${String(r.json.disposition ?? "")}`);
  assert.deepEqual(keptOf(51), ["sweep.disposed:blocked-fixable", `${PR_TERMINAL_STEP}:`],
    "the merged PR's plain sweep and review rows drop; the acted repair-surface row stays");
  assert.deepEqual(keptOf(52), [`${PR_TERMINAL_STEP}:`], "a closed PR's terminal row is its terminal fact too");
  assert.deepEqual(keptOf(53), ["sweep.disposed:waiting"], "a PR with no terminal fact keeps its rows");
});

test("W1-T5318: an open PR, a dry run, or a fact naming another PR appends nothing", () => {
  const { dir, ledgerPath } = ledger([disposed(61), disposed(62), disposed(63), "not json"]);
  const facts = new Map<string, ClosedPrFact>([
    [url(62), { prUrl: url(62, "other/repo"), prNumber: 62, state: "merged" }],
    [url(63), { prUrl: url(63), prNumber: 63, state: "closed" }],
  ]);
  const lookup = (prUrl: string) => facts.get(prUrl);
  const dry = runPrTerminalReconcile(lookup, { ledgerPath, runId: "SWEEP-1", dryRun: true });
  assert.equal(dry.appended, 0, "a dry run leaves no trace");
  assert.equal(dry.named, 3);
  assert.equal(runPrTerminalReconcile(lookup, { ledgerPath, runId: "SWEEP-1" }).appended, 1, "only #63");
  assert.deepEqual(terminalRows(ledgerPath).map((l) => l.pr_number), [63]);
  rmSync(dir, { recursive: true, force: true });
});

test("W1-T5318: an archive the dedup read cannot open is named on the row it appends", () => {
  const { dir, ledgerPath } = ledger([disposed(71)]);
  writeFileSync(join(dir, "ledger.2026-10-01T00-00-00-000Z.ndjson.gz"), "not gzip");
  runPrTerminalReconcile(closedPrLookup([{ prUrl: url(71), prNumber: 71, state: "merged" }]), { ledgerPath, runId: "S" });
  const rows = terminalRows(ledgerPath, 71);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].union_unread, 1, "a possible duplicate is attributable to the unread archive");
  rmSync(dir, { recursive: true, force: true });
});

test("W1-T5318: the closed set comes from the gateway's own rows, never the plan", () => {
  const rows = [
    { number: 1, url: url(1), state: "OPEN" },
    { number: 2, url: url(2), state: "MERGED" },
    { number: 3, url: url(3), state: "CLOSED" },
    { number: 4, url: url(4), state: "CLOSED" },
  ];
  assert.deepEqual(closedPrFacts(rows, new Map([[2, "2026-10-04T00:00:00Z"]]), new Set([4])), [
    { prUrl: url(2), prNumber: 2, state: "merged", at: "2026-10-04T00:00:00Z" },
    { prUrl: url(3), prNumber: 3, state: "closed" },
  ], "open rows, and a stale closed row of a reopened PR, are not terminal");
  assert.equal(closedPrFromRef(null), undefined);
  assert.deepEqual(closedPrFromRef({ number: 5, url: url(5), state: "MERGED" }), { prUrl: url(5), prNumber: 5, state: "merged" });

  const { dir, ledgerPath } = ledger([disposed(8), disposed(9)]);
  const refs = new Map([[url(8), { number: 8, url: url(8), state: "MERGED" }], [url(9), { number: 9, url: url(9), state: "OPEN" }]]);
  const viaGateway = sweepPrTerminalRung({ prByRef: (ref) => refs.get(String(ref)) ?? null }, ledgerPath, "SWEEP-1");
  assert.equal(viaGateway.appended, 1, "without a tick read the board gateway answers");
  const viaTick = sweepPrTerminalRung({ prByRef: () => { throw new Error("no gateway read with a tick read"); } }, ledgerPath, "SWEEP-1",
    { closedPrs: [{ prUrl: url(9), prNumber: 9, state: "closed" }] });
  assert.equal(viaTick.appended, 1, "the tick read's closed set answers");
  assert.deepEqual(terminalRows(ledgerPath).map((l) => l.pr_number), [8, 9]);
  rmSync(dir, { recursive: true, force: true });
});

test("W1-T5318: the tick read carries the closed PRs its gateway already read, with their GitHub times", async () => {
  const root = makeTempDir("w1-t5318-tick");
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "- id: A\n  title: a\n  repo: r\n  type: implement\n  files: [src/a.ts]\n  depends_on: []\n  status: queued\n");
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const mergedAt = "2026-10-04T03:00:00Z";
  const pull = (number: number, state: "open" | "merged" | "closed") => ({
    number, html_url: url(number), state: state === "open" ? "open" : "closed",
    merged_at: state === "merged" ? mergedAt : null, closed_at: state === "open" ? null : mergedAt,
    title: `fix: ${number}`, body: "", head: { ref: `fix-${number}`, sha: `sha${number}` },
    created_at: nowIso(), updated_at: nowIso(), draft: false,
  });
  const io: Parameters<typeof createTickReadProducer>[1] = {
    fetch: (args) => {
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path.includes("/pulls?") && path.includes("state=open")) return [pull(1, "open")];
      if (path.includes("/pulls?") && path.includes("state=closed")) return [pull(2, "merged"), pull(3, "closed")];
      if (path.includes("/issues?")) return [];
      if (path.includes("/check-runs")) return { check_runs: [] };
      if (path.endsWith("/status")) return { statuses: [] };
      if (path.includes("/files")) return [];
      if (path.includes("/actions/runs")) return { workflow_runs: [] };
      if (path.includes("/compare/")) return { ahead_by: 0 };
      if (/\/pulls\/\d+$/.test(path)) return { ...pull(Number(path.split("/").at(-1)), "open"), mergeable_state: "clean" };
      throw new Error(`unexpected read ${args.join(" ")}`);
    },
    changedFilesFetch: async () => [], commitTrailerIndex: () => new Map(), evidenceRootFor: () => undefined,
    issues: { create: () => { throw new Error("write in read plane"); }, listOpen: () => [] },
    viewsDeps: { requiredContexts: () => [], readCiGateRequired: () => [], fetchCiFailureEvidence: () => [] },
  };
  const options = { owner: "o", repo: "r", config: { root, claudeBin: process.execPath }, ledgerPath, checkoutRoot: root };
  const plan = loadPlan(planPath);
  const expected = [
    { prUrl: url(2), prNumber: 2, state: "merged", at: mergedAt },
    { prUrl: url(3), prNumber: 3, state: "closed", at: mergedAt },
  ];
  const facts = await createTickReadProducer(options, io)({ plan });
  assert.deepEqual(facts.closedPrs, expected);
  // A restarted producer seeds the closed half from the persisted snapshot before its delta read.
  const restarted = await createTickReadProducer(options, io)({ plan });
  assert.deepEqual(restarted.closedPrs, expected);
  rmSync(root, { recursive: true, force: true });
});
