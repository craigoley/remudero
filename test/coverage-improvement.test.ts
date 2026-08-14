import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  aggregateBranchesPct,
  alreadyFiledForSignature,
  buildCoverageImprovementFeedback,
  classifyImprovementTier,
  coverageDebtSignature,
  COVERAGE_IMPROVEMENT_FILED_STEP,
  injectCoverageImprovementTask,
  parseFiledCoverageImprovementLines,
  parseLcovFileRecords,
  rankCoverageDebt,
  type FileDebt,
  type LcovFileRecord,
} from "../src/lib/coverage-improvement.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { coverageImproveCommand } from "../src/run-task.js";
import type { FeedbackEntry } from "../src/lib/feedback.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fixtureLcov(entries: { file: string; brf: number; brh: number }[]): string {
  return entries.map((e) => `SF:${e.file}\nBRF:${e.brf}\nBRH:${e.brh}\nend_of_record`).join("\n") + "\n";
}

// ── W1-T470 tier two: name the files, dedupe on the ledger UNION, never a frozen percentage.
// See src/lib/coverage-improvement.ts's own module doc for the full design rationale. ────────

// ── DECISION_RELEVANT_LEDGER_STEPS registration (design clause (4)) ────────────────────────

test("COVERAGE_IMPROVEMENT_FILED_STEP is registered in DECISION_RELEVANT_LEDGER_STEPS — a rotation must never archive this module's own dedup marker", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has(COVERAGE_IMPROVEMENT_FILED_STEP),
    `"${COVERAGE_IMPROVEMENT_FILED_STEP}" must be registered in src/lib/ledger.ts's DECISION_RELEVANT_LEDGER_STEPS, or rotation archives the producer's own evidence and re-arms the unbounded refile loop clause (4) exists to prevent`,
  );
});

// ── parseLcovFileRecords (pure) ──────────────────────────────────────────────────────────────

test("parseLcovFileRecords: reads BRF/BRH per SF record, excludes out-of-repo (../ or absolute) records", () => {
  const lcov = [
    "SF:src/a.ts",
    "BRF:10",
    "BRH:8",
    "end_of_record",
    "SF:src/lib/b.ts",
    "BRF:6",
    "BRH:0",
    "end_of_record",
    "SF:../../../tmp/rmd-xyz/generate-plan-index.mjs",
    "BRF:100",
    "BRH:0",
    "end_of_record",
    "SF:/abs/path/d.ts",
    "BRF:5",
    "BRH:5",
    "end_of_record",
  ].join("\n");
  const records = parseLcovFileRecords(lcov);
  assert.deepEqual(records, [
    { file: "src/a.ts", brf: 10, brh: 8 },
    { file: "src/lib/b.ts", brf: 6, brh: 0 },
  ]);
});

// ── aggregateBranchesPct (pure) ──────────────────────────────────────────────────────────────

test("aggregateBranchesPct: sums BRF/BRH across every record", () => {
  const records: LcovFileRecord[] = [
    { file: "src/a.ts", brf: 10, brh: 9 },
    { file: "src/b.ts", brf: 10, brh: 0 },
  ];
  assert.equal(aggregateBranchesPct(records), 45);
});

test("aggregateBranchesPct: zero total BRF reads 100% — no branches means nothing to miss", () => {
  assert.equal(aggregateBranchesPct([]), 100);
});

// ── classifyImprovementTier (pure) ───────────────────────────────────────────────────────────

test("classifyImprovementTier: default cuts — >=90 healthy, [85,90) improve, <85 remediate", () => {
  assert.equal(classifyImprovementTier(95), "healthy");
  assert.equal(classifyImprovementTier(90), "healthy");
  assert.equal(classifyImprovementTier(89.99), "improve");
  assert.equal(classifyImprovementTier(85), "improve");
  assert.equal(classifyImprovementTier(84.99), "remediate");
  assert.equal(classifyImprovementTier(0), "remediate");
});

test("classifyImprovementTier: custom thresholds override the defaults", () => {
  assert.equal(classifyImprovementTier(80, { pass: 95, block: 70 }), "improve");
  assert.equal(classifyImprovementTier(65, { pass: 95, block: 70 }), "remediate");
});

// ── rankCoverageDebt (pure) ───────────────────────────────────────────────────────────────────

test("rankCoverageDebt: scopes to src/, ranks by uncovered branch COUNT descending, ties broken by path", () => {
  const records: LcovFileRecord[] = [
    { file: "src/big.ts", brf: 100, brh: 10 }, // 90 uncovered
    { file: "src/small.ts", brf: 10, brh: 9 }, // 1 uncovered
    { file: "scripts/x.mjs", brf: 50, brh: 0 }, // not src/ — excluded
    { file: "src/tie-b.ts", brf: 20, brh: 10 }, // 10 uncovered
    { file: "src/tie-a.ts", brf: 20, brh: 10 }, // 10 uncovered, ties with tie-b
    { file: "src/fully-covered.ts", brf: 5, brh: 5 }, // 0 uncovered — excluded
  ];
  assert.deepEqual(rankCoverageDebt(records), [
    { file: "src/big.ts", uncoveredBranches: 90 },
    { file: "src/tie-a.ts", uncoveredBranches: 10 },
    { file: "src/tie-b.ts", uncoveredBranches: 10 },
    { file: "src/small.ts", uncoveredBranches: 1 },
  ]);
});

test("rankCoverageDebt: limit caps the returned list, default 10", () => {
  const records: LcovFileRecord[] = Array.from({ length: 15 }, (_, i) => ({ file: `src/f${i}.ts`, brf: 10, brh: 0 }));
  assert.equal(rankCoverageDebt(records).length, 10);
  assert.equal(rankCoverageDebt(records, { limit: 3 }).length, 3);
});

// ── coverageDebtSignature (pure) ─────────────────────────────────────────────────────────────

test("coverageDebtSignature: order-independent — a rank swap between two ties is not a signature change", () => {
  const a: FileDebt[] = [
    { file: "src/b.ts", uncoveredBranches: 5 },
    { file: "src/a.ts", uncoveredBranches: 5 },
  ];
  const b: FileDebt[] = [
    { file: "src/a.ts", uncoveredBranches: 5 },
    { file: "src/b.ts", uncoveredBranches: 5 },
  ];
  assert.equal(coverageDebtSignature(a), coverageDebtSignature(b));
});

test("coverageDebtSignature: a different file set produces a different signature", () => {
  const a: FileDebt[] = [{ file: "src/a.ts", uncoveredBranches: 5 }];
  const b: FileDebt[] = [{ file: "src/c.ts", uncoveredBranches: 5 }];
  assert.notEqual(coverageDebtSignature(a), coverageDebtSignature(b));
});

// ── buildCoverageImprovementFeedback (pure) — clause (5): files + counts, never a per-file % ──

test("buildCoverageImprovementFeedback: names every file with its uncovered-branch COUNT, never a per-file share as a percentage", () => {
  const files: FileDebt[] = [
    { file: "src/run-task.ts", uncoveredBranches: 190 },
    { file: "src/lib/x.ts", uncoveredBranches: 12 },
  ];
  const text = buildCoverageImprovementFeedback(files, { branchesPct: 87.32 });
  assert.match(text, /src\/run-task\.ts — 190 uncovered branch\(es\)/);
  assert.match(text, /src\/lib\/x\.ts — 12 uncovered branch\(es\)/);
  assert.match(text, /87\.32%/, "the live-computed aggregate is fine as context");
  assert.ok(!/%\s*of\s/.test(text), "must never claim a per-file SHARE of the debt as a percentage");
});

// ── parseFiledCoverageImprovementLines / alreadyFiledForSignature (pure) ───────────────────────

test("alreadyFiledForSignature: true only for an exact signature match, ignoring unrelated/malformed lines", () => {
  const raw = [
    JSON.stringify({ step: "coverage.improvement.filed", signature: "src/a.ts" }),
    JSON.stringify({ step: "coverage.improvement.filed", signature: "src/b.ts" }),
    JSON.stringify({ step: "run.start" }),
    "{not valid json at all",
  ];
  assert.equal(alreadyFiledForSignature(raw, "src/a.ts"), true);
  assert.equal(alreadyFiledForSignature(raw, "src/c.ts"), false);
  assert.equal(parseFiledCoverageImprovementLines(raw).length, 2);
});

// ── injectCoverageImprovementTask (orchestration, injected deps — no real I/O) ────────────────

function fakeEntry(id: string, raw: string): FeedbackEntry {
  return { id, ts: "2026-08-14T00:00:00.000Z", raw, attachments: [], origin: "cli", status: "new", proposal_pr: null };
}

test("injectCoverageImprovementTask: healthy tier (>=90%) is a no-op — capture is never called", () => {
  let captureCalls = 0;
  const result = injectCoverageImprovementTask({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "r1",
    lcovText: fixtureLcov([{ file: "src/a.ts", brf: 10, brh: 10 }]),
    capture: () => {
      captureCalls++;
      return fakeEntry("fb-1", "x");
    },
    ledgerUnion: () => ({ stateDir: "/state", archiveFiles: [], archiveCount: 1, liveFileRead: true, unread: [], ok: true, matches: [] }),
  });
  assert.equal(result.action, "healthy");
  assert.equal(captureCalls, 0);
});

test("injectCoverageImprovementTask: remediate tier (<85%) is a no-op here — tier three is a separate, unbuilt remediation loop", () => {
  let captureCalls = 0;
  const result = injectCoverageImprovementTask({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "r1",
    lcovText: fixtureLcov([{ file: "src/a.ts", brf: 100, brh: 10 }]),
    capture: () => {
      captureCalls++;
      return fakeEntry("fb-1", "x");
    },
    ledgerUnion: () => ({ stateDir: "/state", archiveFiles: [], archiveCount: 1, liveFileRead: true, unread: [], ok: true, matches: [] }),
  });
  assert.equal(result.action, "blocking");
  assert.equal(captureCalls, 0);
});

test("injectCoverageImprovementTask: improve tier with no src/-owned uncovered branch is a no-op ('no-debt')", () => {
  const result = injectCoverageImprovementTask({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "r1",
    // Aggregate (100/85 = 85.0%) lands in the improve band, but the only uncovered branches
    // live outside src/ — src/a.ts itself is fully covered.
    lcovText: fixtureLcov([
      { file: "src/a.ts", brf: 50, brh: 50 },
      { file: "scripts/x.mjs", brf: 50, brh: 35 },
    ]),
    ledgerUnion: () => ({ stateDir: "/state", archiveFiles: [], archiveCount: 1, liveFileRead: true, unread: [], ok: true, matches: [] }),
  });
  assert.equal(result.action, "no-debt");
});

test("injectCoverageImprovementTask: improve tier + no prior filing for this signature -> files ONE entry and appends the dedup marker", () => {
  const captured: unknown[] = [];
  const written: unknown[] = [];
  const result = injectCoverageImprovementTask({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "run-42",
    lcovText: fixtureLcov([{ file: "src/a.ts", brf: 20, brh: 17 }]),
    capture: (root, opts) => {
      captured.push({ root, opts });
      return fakeEntry("fb-filed-1", opts.raw);
    },
    ledgerUnion: () => ({ stateDir: "/state", archiveFiles: ["a.gz"], archiveCount: 1, liveFileRead: true, unread: [], ok: true, matches: [] }),
    writeLedgerLine: (path, line) => {
      written.push({ path, line });
    },
  });
  assert.equal(result.action, "filed");
  if (result.action !== "filed") throw new Error("unreachable");
  assert.equal(result.feedbackId, "fb-filed-1");
  assert.deepEqual(result.files, [{ file: "src/a.ts", uncoveredBranches: 3 }]);
  assert.equal(captured.length, 1);
  assert.equal((captured[0] as { root: string }).root, "/root");
  assert.equal(written.length, 1);
  const line = (written[0] as { path: string; line: Record<string, unknown> }).line;
  assert.equal((written[0] as { path: string }).path, "/state/ledger.ndjson");
  assert.equal(line.step, COVERAGE_IMPROVEMENT_FILED_STEP);
  assert.equal(line.run_id, "run-42");
  assert.equal(line.feedback_id, "fb-filed-1");
  assert.equal(line.signature, coverageDebtSignature(result.files));
  assert.deepEqual(line.files, ["src/a.ts"]);
});

test("injectCoverageImprovementTask: improve tier + this EXACT debt signature already filed -> skips, capture is never called", () => {
  let captureCalls = 0;
  const signature = coverageDebtSignature([{ file: "src/a.ts", uncoveredBranches: 3 }]);
  const result = injectCoverageImprovementTask({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "run-43",
    lcovText: fixtureLcov([{ file: "src/a.ts", brf: 20, brh: 17 }]),
    capture: () => {
      captureCalls++;
      return fakeEntry("fb-x", "x");
    },
    ledgerUnion: () => ({
      stateDir: "/state",
      archiveFiles: ["a.gz"],
      archiveCount: 1,
      liveFileRead: true,
      unread: [],
      ok: true,
      matches: [JSON.stringify({ step: COVERAGE_IMPROVEMENT_FILED_STEP, signature, run_id: "run-42" })],
    }),
  });
  assert.equal(result.action, "skipped-duplicate");
  assert.equal(captureCalls, 0);
});

test("injectCoverageImprovementTask: the debt profile SHIFTED since the last filing -> files again (dedupe is keyed on the signature, not 'ever filed')", () => {
  let captureCalls = 0;
  const result = injectCoverageImprovementTask({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "run-44",
    lcovText: fixtureLcov([{ file: "src/a.ts", brf: 20, brh: 17 }]), // signature "src/a.ts"
    capture: () => {
      captureCalls++;
      return fakeEntry("fb-y", "y");
    },
    ledgerUnion: () => ({
      stateDir: "/state",
      archiveFiles: ["a.gz"],
      archiveCount: 1,
      liveFileRead: true,
      unread: [],
      ok: true,
      // A PRIOR filing for a DIFFERENT file set — the debt has moved.
      matches: [JSON.stringify({ step: COVERAGE_IMPROVEMENT_FILED_STEP, signature: "src/z.ts", run_id: "run-1" })],
    }),
    writeLedgerLine: () => {},
  });
  assert.equal(result.action, "filed");
  assert.equal(captureCalls, 1);
});

test("injectCoverageImprovementTask: the ledger union cannot confirm (ok:false) -> fails OPEN and files anyway (never silently refuses forever)", () => {
  let captureCalls = 0;
  const result = injectCoverageImprovementTask({
    root: "/root",
    stateDir: "/state",
    ledgerPath: "/state/ledger.ndjson",
    runId: "run-45",
    lcovText: fixtureLcov([{ file: "src/a.ts", brf: 20, brh: 17 }]),
    capture: () => {
      captureCalls++;
      return fakeEntry("fb-z", "z");
    },
    ledgerUnion: () => ({ stateDir: "/state", archiveFiles: [], archiveCount: 0, liveFileRead: true, unread: [], ok: false, matches: [] }),
    writeLedgerLine: () => {},
  });
  assert.equal(result.action, "filed");
  assert.equal(captureCalls, 1);
});

// ── coverageImproveCommand (the rmd verb wrapper — real I/O against tmp dirs) ─────────────────

test("coverageImproveCommand: an unexpected argument is refused (exit 2), never silently ignored", () => {
  assert.equal(coverageImproveCommand(["--bogus"]), 2);
});

test("coverageImproveCommand: --lcov with no value is refused (exit 2)", () => {
  assert.equal(coverageImproveCommand(["--lcov"]), 2);
});

test("coverageImproveCommand: an unreadable lcov path is refused (exit 1), never a crash", () => {
  const root = tmp("rmd-coverage-improve-noroot-");
  assert.equal(coverageImproveCommand(["--lcov", join(root, "does-not-exist.info")], { root }), 1);
});

test("coverageImproveCommand: healthy lcov -> exit 0, files nothing", () => {
  const root = tmp("rmd-coverage-improve-healthy-");
  const stateDir = tmp("rmd-coverage-improve-state-");
  const lcovPath = join(root, "lcov.info");
  writeFileSync(lcovPath, fixtureLcov([{ file: "src/a.ts", brf: 10, brh: 10 }]));

  const code = coverageImproveCommand(["--lcov", lcovPath], { root, stateDir, ledgerPath: join(stateDir, "ledger.ndjson"), runId: "test-run" });
  assert.equal(code, 0);
  assert.ok(!existsSync(join(root, "plan", "feedback")), "a healthy run must write no feedback entry");
});

test("coverageImproveCommand: improve-band lcov -> exit 0, writes ONE plan/feedback/ entry naming the debt files and appends the ledger marker; a second identical run dedupes", () => {
  const root = tmp("rmd-coverage-improve-file-");
  const stateDir = tmp("rmd-coverage-improve-state2-");
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const lcovPath = join(root, "lcov.info");
  // resolveLedgerUnion (lib/ledger-grep.ts) reports ok:false — "cannot confirm" — whenever a
  // state dir carries ZERO rotation archives, regardless of what the live file holds (the live
  // file is deliberately excluded from the archive count, since it is never itself a rotation).
  // A real, long-lived instance always has rotations (measured 418,898 distinct lines across
  // this host's own archives — see lib/ledger-grep.ts's module doc); seed one dated rotation
  // here so this test exercises the dedupe's REAL confirmed-ok path end to end, rather than the
  // (also-covered, see the injectCoverageImprovementTask unit test above) fail-open path.
  writeFileSync(join(stateDir, "ledger.2020-01-01T00-00-00-000Z.ndjson"), "");
  // Mix a fully-covered file with a debt-owning one so the AGGREGATE (100/85 = 85.0%) lands
  // exactly on the pass-with-debt band's floor while src/debt.ts still owns real uncovered
  // branches to name.
  writeFileSync(
    lcovPath,
    fixtureLcov([
      { file: "src/healthy.ts", brf: 50, brh: 50 },
      { file: "src/debt.ts", brf: 50, brh: 35 },
    ]),
  );

  const code = coverageImproveCommand(["--lcov", lcovPath], { root, stateDir, ledgerPath, runId: "run-a" });
  assert.equal(code, 0);

  const feedbackDir = join(root, "plan", "feedback");
  const entries = readdirSync(feedbackDir).filter((f) => f.endsWith(".yaml"));
  assert.equal(entries.length, 1, "exactly one plan/feedback/ entry must be written for one red-band run");
  const parsed = parseYaml(readFileSync(join(feedbackDir, entries[0]), "utf8")) as { raw: string; status: string };
  assert.equal(parsed.status, "new");
  assert.match(parsed.raw, /src\/debt\.ts — 15 uncovered branch\(es\)/);

  const ledgerLines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(ledgerLines.some((l) => l.step === COVERAGE_IMPROVEMENT_FILED_STEP && l.run_id === "run-a"));

  // A second run against the SAME lcov (same debt signature) must not write a second entry.
  const code2 = coverageImproveCommand(["--lcov", lcovPath], { root, stateDir, ledgerPath, runId: "run-b" });
  assert.equal(code2, 0);
  const entriesAfter = readdirSync(feedbackDir).filter((f) => f.endsWith(".yaml"));
  assert.equal(entriesAfter.length, 1, "an unchanged debt signature must not file a second entry");
});

// ── coverageImproveCommand: the arms the wrapper owns but the library cannot reach ────────────
// Every case below is a line `diff-coverage` flagged as added-and-uncovered on #1783. They are
// wrapper-only paths: `injectCoverageImprovementTask` is exhaustively tested above, but the verb's
// OWN switch arms and its state-dir fallback are not reachable through it. Testing the library and
// calling the CLI covered is the exact gap that shipped.

test("coverageImproveCommand: a below-block-tier lcov reports the remediation band and files nothing", () => {
  const root = tmp("rmd-coverage-improve-blocking-");
  const stateDir = tmp("rmd-coverage-improve-blocking-state-");
  const lcovPath = join(root, "lcov.info");
  // 80/100 branches = 80% — under DEFAULT_TIER_BLOCK_PCT (85), so tier `remediate`, which the
  // verb reports as `blocking` and deliberately leaves to tier three's own loop.
  writeFileSync(lcovPath, fixtureLcov([{ file: "src/a.ts", brf: 100, brh: 80 }]));

  const code = coverageImproveCommand(["--lcov", lcovPath], { root, stateDir, ledgerPath: join(stateDir, "ledger.ndjson"), runId: "blocking-run" });
  assert.equal(code, 0, "the block tier is not this verb's job, but it is not an ERROR either");
  assert.ok(!existsSync(join(root, "plan", "feedback")), "a below-block run must file nothing");
});

test("coverageImproveCommand: in-band coverage whose debt lives entirely OUTSIDE src/ reports no-debt", () => {
  const root = tmp("rmd-coverage-improve-nodebt-");
  const stateDir = tmp("rmd-coverage-improve-nodebt-state-");
  const lcovPath = join(root, "lcov.info");
  // 87/100 = 87%, inside the 85-90 pass-with-debt band — but `rankCoverageDebt` ranks only
  // `src/`-prefixed records, and the one src/ file is fully covered. The uncovered branches are
  // all in scripts/, so there is real aggregate debt and NO file this verb may name.
  writeFileSync(
    lcovPath,
    fixtureLcov([
      { file: "src/a.ts", brf: 50, brh: 50 },
      { file: "scripts/x.mjs", brf: 50, brh: 37 },
    ]),
  );

  const code = coverageImproveCommand(["--lcov", lcovPath], { root, stateDir, ledgerPath: join(stateDir, "ledger.ndjson"), runId: "nodebt-run" });
  assert.equal(code, 0);
  assert.ok(!existsSync(join(root, "plan", "feedback")), "no nameable src/ debt must file nothing rather than an empty entry");
});

test("coverageImproveCommand: with no stateDir, the config fallback resolves one and the ledger is written THERE", () => {
  const root = tmp("rmd-coverage-improve-cfg-");
  const configRoot = tmp("rmd-coverage-improve-cfgroot-");
  mkdirSync(join(configRoot, "state"), { recursive: true });
  const lcovPath = join(root, "lcov.info");
  writeFileSync(
    lcovPath,
    fixtureLcov([
      { file: "src/healthy.ts", brf: 50, brh: 50 },
      { file: "src/debt.ts", brf: 50, brh: 35 },
    ]),
  );

  // stateDir OMITTED on purpose: this is the only way to reach the fallback at all.
  const code = coverageImproveCommand(["--lcov", lcovPath], { root, runId: "cfg-run", loadConfig: () => ({ root: configRoot }) });
  assert.equal(code, 0);
  // The assertion that matters: the fallback did not merely RETURN a path, the run USED it.
  const ledgerLines = readFileSync(join(configRoot, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(
    ledgerLines.some((l) => l.step === COVERAGE_IMPROVEMENT_FILED_STEP && l.run_id === "cfg-run"),
    "the ledger must land under the config-derived state dir, proving the fallback fed ledgerPath",
  );
});

test("coverageImproveCommand: an unreadable config leaves no state dir, so the run refuses (exit 1) rather than guessing one", () => {
  const root = tmp("rmd-coverage-improve-nocfg-");
  const lcovPath = join(root, "lcov.info");
  writeFileSync(lcovPath, fixtureLcov([{ file: "src/a.ts", brf: 10, brh: 10 }]));

  const code = coverageImproveCommand(["--lcov", lcovPath], {
    root,
    loadConfig: () => {
      throw new Error("config unreadable");
    },
  });
  assert.equal(code, 1, "a config that cannot be read must fail CLOSED, never fall back to a guessed path");
});
