// test/authority-table.test.ts — W1-T2695: the authority report joins AUTHORITY_TABLE to
// plan/policy.yaml's values, plan/ratifications.yaml's pins, and the ledger union's last-fired
// line per row — REFUSING (never blanking) when the ledger union could not be read, and the
// `rmd authority` verb that prints it is read-only (no network, no gh/git spawn).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUTHORITY_TABLE,
  authorityLedgerPattern,
  authorityTableIds,
  authorityTableModules,
  buildAuthorityReport,
  loadRatificationPins,
  renderAuthorityReport,
} from "../src/lib/authority.js";
import { authorityCommand } from "../src/run-task.js";
import type { LedgerUnionResult } from "../src/lib/ledger-grep.js";
import type { Policy } from "../src/lib/policy.js";

function fakeLedger(matches: string[], ok = true): LedgerUnionResult {
  return {
    stateDir: "/fake-state-dir",
    archiveFiles: ["/fake-state-dir/ledger.2026-01-01T00-00-00-000Z.ndjson"],
    archiveCount: 1,
    liveFileRead: true,
    unread: [],
    unclassified: [],
    ok,
    matches,
  };
}

// ── the table itself ─────────────────────────────────────────────────────────────────────────

test("AUTHORITY_TABLE rows are non-empty and ids are unique", () => {
  assert.ok(AUTHORITY_TABLE.length > 0, "the table must not be empty");
  const ids = authorityTableIds();
  assert.equal(new Set(ids).size, ids.length, "duplicate id in AUTHORITY_TABLE");
  for (const row of AUTHORITY_TABLE) {
    assert.ok(row.id.length > 0, "row.id must not be empty");
    assert.ok(row.action.length > 0, `${row.id}: action must not be empty`);
    assert.ok(row.module.length > 0, `${row.id}: module must not be empty`);
    assert.ok(row.symbol.length > 0, `${row.id}: symbol must not be empty`);
    assert.ok(row.verb.length > 0, `${row.id}: verb must not be empty`);
    assert.ok(row.note.length > 0, `${row.id}: note must not be empty`);
    assert.ok(Array.isArray(row.ledgerSteps), `${row.id}: ledgerSteps must be an array (possibly empty)`);
    assert.ok(
      ["policy", "ledger-verdict", "operator-verb", "always"].includes(row.gate),
      `${row.id}: gate must be one of the four closed kinds, got ${row.gate}`,
    );
  }
});

test("authorityTableModules names at least the modules known to carry a real external write today", () => {
  const modules = authorityTableModules();
  for (const m of [
    "src/run-task.ts",
    "src/lib/worker.ts",
    "src/spike.ts",
    "src/lib/feedback-landing.ts",
    "src/lib/git-push.ts",
    "src/lib/escalate.ts",
    "src/lib/review.ts",
    "src/lib/specialist-panel.ts",
    "src/lib/auto-triage.ts",
    "src/lib/dispatch-claim.ts",
    "src/lib/fleet-control.ts",
    "src/lib/task-id-reservation.ts",
    "src/lib/onboard/synthesize.ts",
    "src/lib/panel-actions.ts",
  ]) {
    assert.ok(modules.has(m), `expected AUTHORITY_TABLE to document ${m}`);
  }
});

// ── buildAuthorityReport: the refusal ───────────────────────────────────────────────────────

test("buildAuthorityReport REFUSES rather than blanking every row when the ledger union is unreadable", () => {
  const report = buildAuthorityReport({ ledger: fakeLedger([], false) });
  assert.equal(report.status, "refused");
  if (report.status !== "refused") return;
  assert.match(report.reason, /unreadable/);
  assert.deepEqual(report.rows, [], "a refused report carries no per-row data to be mistaken for a real answer");
});

// ── buildAuthorityReport: last-fired join ───────────────────────────────────────────────────

test("a mapped row joins to its LATEST ledgered firing among several matching lines", () => {
  const row = AUTHORITY_TABLE.find((r) => r.ledgerSteps.length > 0);
  assert.ok(row, "expected at least one row with a declared ledger step for this test to be meaningful");
  const step = row!.ledgerSteps[0];
  const older = JSON.stringify({ step, ts: "2026-01-01T00:00:00.000Z" });
  const newer = JSON.stringify({ step, ts: "2026-02-15T00:00:00.000Z" });
  const unrelated = JSON.stringify({ step: "totally.unrelated.step", ts: "2026-03-01T00:00:00.000Z" });
  const report = buildAuthorityReport({ ledger: fakeLedger([older, newer, unrelated]) });
  assert.equal(report.status, "measured");
  if (report.status !== "measured") return;
  const reportRow = report.rows.find((r) => r.id === row!.id);
  assert.deepEqual(reportRow?.lastFired, { status: "measured", ts: "2026-02-15T00:00:00.000Z" });
});

test("a mapped row with no matching line in the union reads 'never', never a fabricated timestamp", () => {
  const row = AUTHORITY_TABLE.find((r) => r.ledgerSteps.length > 0)!;
  const report = buildAuthorityReport({
    ledger: fakeLedger([JSON.stringify({ step: "some.other.step.entirely", ts: "2026-01-01T00:00:00.000Z" })]),
  });
  assert.equal(report.status, "measured");
  if (report.status !== "measured") return;
  const reportRow = report.rows.find((r) => r.id === row.id);
  assert.deepEqual(reportRow?.lastFired, { status: "never" });
});

test("a row with no declared ledger step reads 'unmapped' — a named gap, never guessed as 'never'", () => {
  const row = AUTHORITY_TABLE.find((r) => r.ledgerSteps.length === 0);
  assert.ok(row, "expected at least one row with no confirmed ledger step (a real, named gap)");
  const report = buildAuthorityReport({ ledger: fakeLedger([]) });
  assert.equal(report.status, "measured");
  if (report.status !== "measured") return;
  const reportRow = report.rows.find((r) => r.id === row!.id);
  assert.deepEqual(reportRow?.lastFired, { status: "unmapped" });
});

test("a corrupt/unparsable ledger line is skipped, never crashing the join", () => {
  const row = AUTHORITY_TABLE.find((r) => r.ledgerSteps.length > 0)!;
  const step = row.ledgerSteps[0];
  const good = JSON.stringify({ step, ts: "2026-01-01T00:00:00.000Z" });
  const report = buildAuthorityReport({ ledger: fakeLedger(["{not json", good, "also not json}}"]) });
  assert.equal(report.status, "measured");
  if (report.status !== "measured") return;
  const reportRow = report.rows.find((r) => r.id === row.id);
  assert.deepEqual(reportRow?.lastFired, { status: "measured", ts: "2026-01-01T00:00:00.000Z" });
});

// ── buildAuthorityReport: policy join ───────────────────────────────────────────────────────

test("a policy-gated row joins to its live plan/policy.yaml value", () => {
  const row = AUTHORITY_TABLE.find((r) => r.policyField === "sweep.supersessionDisposal");
  assert.ok(row, "expected the sweep-close-superseded-pr row to declare this exact policyField");
  const fakePolicy = { values: { sweep: { supersessionDisposal: true } }, origin: {}, bounds: {} } as unknown as Policy;
  const report = buildAuthorityReport({ policy: fakePolicy, ledger: fakeLedger([]) });
  assert.equal(report.status, "measured");
  if (report.status !== "measured") return;
  const reportRow = report.rows.find((r) => r.id === row!.id);
  assert.equal(reportRow?.policyValue, true);
});

test("a policy-gated row's policyValue is undefined when no policy was loaded", () => {
  const row = AUTHORITY_TABLE.find((r) => r.policyField !== undefined)!;
  const report = buildAuthorityReport({ ledger: fakeLedger([]) });
  assert.equal(report.status, "measured");
  if (report.status !== "measured") return;
  assert.equal(report.rows.find((r) => r.id === row.id)?.policyValue, undefined);
});

test("a non-policy-gated row never fabricates a policyValue even when a policy IS loaded", () => {
  const row = AUTHORITY_TABLE.find((r) => r.policyField === undefined)!;
  const fakePolicy = { values: {}, origin: {}, bounds: {} } as unknown as Policy;
  const report = buildAuthorityReport({ policy: fakePolicy, ledger: fakeLedger([]) });
  assert.equal(report.status, "measured");
  if (report.status !== "measured") return;
  assert.equal(report.rows.find((r) => r.id === row.id)?.policyValue, undefined);
});

// ── buildAuthorityReport: ratification-pin join ─────────────────────────────────────────────

test("pins join by AUTHORITY_TABLE id; a row with no matching pin reads undefined", () => {
  const [row1, row2] = AUTHORITY_TABLE;
  const pins = { [row1.id]: "2026-09-01 operator ruling" };
  const report = buildAuthorityReport({ ledger: fakeLedger([]), pins });
  assert.equal(report.status, "measured");
  if (report.status !== "measured") return;
  assert.equal(report.rows.find((r) => r.id === row1.id)?.pin, pins[row1.id]);
  assert.equal(report.rows.find((r) => r.id === row2.id)?.pin, undefined);
});

// ── authorityLedgerPattern ───────────────────────────────────────────────────────────────────

test("authorityLedgerPattern matches every declared step and rejects an undeclared one", () => {
  const pattern = authorityLedgerPattern();
  const declared = AUTHORITY_TABLE.flatMap((r) => r.ledgerSteps)[0];
  assert.ok(declared, "expected at least one declared ledger step across the table");
  assert.match(JSON.stringify({ step: declared, ts: "x" }), pattern);
  assert.doesNotMatch(JSON.stringify({ step: "definitely-not-a-declared-step", ts: "x" }), pattern);
});

// ── loadRatificationPins: W1-T2694's file, "if any" ─────────────────────────────────────────

test("loadRatificationPins degrades to {} when plan/ratifications.yaml is absent (W1-T2694 not shipped yet)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-authority-pins-"));
  try {
    assert.deepEqual(loadRatificationPins(dir), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRatificationPins reads a real file when present, and drops non-string values", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-authority-pins-"));
  try {
    mkdirSync(join(dir, "plan"), { recursive: true });
    writeFileSync(
      join(dir, "plan", "ratifications.yaml"),
      'arm-auto-merge-at-open: "2026-09-01 operator ruling"\nweird-numeric: 4\n',
    );
    const pins = loadRatificationPins(dir);
    assert.equal(pins["arm-auto-merge-at-open"], "2026-09-01 operator ruling");
    assert.equal(pins["weird-numeric"], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRatificationPins degrades to {} on malformed YAML, never a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-authority-pins-"));
  try {
    mkdirSync(join(dir, "plan"), { recursive: true });
    writeFileSync(join(dir, "plan", "ratifications.yaml"), "not: [valid: yaml: at all");
    assert.deepEqual(loadRatificationPins(dir), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── renderAuthorityReport ────────────────────────────────────────────────────────────────────

test("renderAuthorityReport prints the refusal reason on a refused report", () => {
  const refused = buildAuthorityReport({ ledger: fakeLedger([], false) });
  assert.match(renderAuthorityReport(refused), /REFUSED/);
});

test("renderAuthorityReport prints every row id on a measured report", () => {
  const measured = buildAuthorityReport({ ledger: fakeLedger([]) });
  const rendered = renderAuthorityReport(measured);
  for (const row of AUTHORITY_TABLE) assert.ok(rendered.includes(row.id), `expected ${row.id} in the rendered report`);
});

// ── authorityCommand: the CLI verb ───────────────────────────────────────────────────────────

test("authorityCommand refuses an unknown flag with exit 2, spawning nothing", () => {
  const errs: string[] = [];
  const code = authorityCommand(["--bogus"], { err: (s) => errs.push(s) });
  assert.equal(code, 2);
  assert.ok(errs.length > 0);
});

test("authorityCommand --json prints a parseable report using only injected deps", () => {
  const outs: string[] = [];
  const fakePolicy = { values: {}, origin: {}, bounds: {} } as unknown as Policy;
  const code = authorityCommand(["--json"], {
    out: (s) => outs.push(s),
    stateDir: "/fake-state-dir",
    loadPolicy: () => fakePolicy,
    loadPins: () => ({}),
    resolveLedger: () => fakeLedger([]),
  });
  assert.equal(code, 0);
  assert.equal(outs.length, 1);
  const parsed = JSON.parse(outs[0]);
  assert.equal(parsed.status, "measured");
  assert.equal(parsed.rows.length, AUTHORITY_TABLE.length);
});

test("authorityCommand prints the human-readable table without --json", () => {
  const outs: string[] = [];
  const code = authorityCommand([], {
    out: (s) => outs.push(s),
    stateDir: "/fake-state-dir",
    loadPolicy: () => ({ values: {}, origin: {}, bounds: {} } as unknown as Policy),
    loadPins: () => ({}),
    resolveLedger: () => fakeLedger([]),
  });
  assert.equal(code, 0);
  assert.throws(() => JSON.parse(outs[0]), "human render must not be valid JSON by accident");
  assert.match(outs[0], /gate/);
});

test("authorityCommand exits 1 and prints the refusal when the ledger union is unreadable — never a fabricated table", () => {
  const outs: string[] = [];
  const code = authorityCommand([], {
    out: (s) => outs.push(s),
    stateDir: "/fake-state-dir",
    loadPins: () => ({}),
    resolveLedger: () => fakeLedger([], false),
  });
  assert.equal(code, 1);
  assert.match(outs.join("\n"), /REFUSED/);
});

test("authorityCommand degrades cleanly when loadPolicy throws — a read-only report is never fatal on bad policy.yaml", () => {
  const outs: string[] = [];
  const code = authorityCommand(["--json"], {
    out: (s) => outs.push(s),
    stateDir: "/fake-state-dir",
    loadPolicy: () => {
      throw new Error("boom: unparsable policy.yaml");
    },
    loadPins: () => ({}),
    resolveLedger: () => fakeLedger([]),
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(outs[0]);
  assert.equal(parsed.status, "measured");
  assert.equal(parsed.rows[0].policyValue, undefined);
});

test("authorityCommand is read-only: with PATH emptied and the REAL (non-injected) ledger resolver pointed at an offline tmpdir, it still returns cleanly — no gh/git subprocess is ever spawned", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-authority-cli-offline-"));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = ""; // any gh/git spawn attempt would ENOENT immediately, not hang or succeed
    const outs: string[] = [];
    const code = authorityCommand(["--json"], {
      out: (s) => outs.push(s),
      stateDir: dir,
      loadPolicy: () => {
        throw new Error("no policy in this fixture");
      },
      loadPins: () => ({}),
      // resolveLedger deliberately NOT injected — the real resolveLedgerUnion runs, fs-only.
    });
    // An empty tmpdir has zero ledger archives, so the REAL resolver reports ok:false and the
    // command refuses — proving the real, non-injected path ran to completion offline.
    assert.equal(code, 1);
    const parsed = JSON.parse(outs[0]);
    assert.equal(parsed.status, "refused");
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
