// test/authority-table.test.ts — W1-T2695: the authority report joins AUTHORITY_TABLE to
// plan/policy.yaml's values, plan/ratifications.yaml's pins, and the ledger union's last-fired
// line per row — REFUSING (never blanking) when the ledger union could not be read, and the
// `rmd authority` verb that prints it is read-only (no network, no gh/git spawn).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  AUTHORITY_GATE_KINDS,
  AUTHORITY_TABLE,
  authorityLedgerPattern,
  authorityTableIds,
  authorityTableModules,
  buildAuthorityReport,
  loadRatificationPins,
  renderAuthorityReport,
} from "#src/lib/authority.js";
import { authorityCommand } from "#src/run-task.js";
import type { LedgerUnionResult } from "#src/lib/ledger-grep.js";
import type { Policy } from "#src/lib/policy.js";
import type { AuthorityCaller, AuthorityReportRow, AuthorityRow } from "#src/lib/authority.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

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
      ["policy", "ledger-verdict", "operator-verb", "sweep-rung", "always", "host-switch"].includes(row.gate),
      `${row.id}: gate must be one of the six closed kinds, got ${row.gate}`,
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

// ── W1-T13773: child-process callers, the host-switch gate, and every other row as before ───

/** The table's self-check over callers: every violation, by row, so a fixture can show each one fires. */
function callerViolations(rows: readonly AuthorityRow[], trackedSrc: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const check = (where: string, gate: string) => {
    if (!(AUTHORITY_GATE_KINDS as readonly string[]).includes(gate)) out.push(`${where}: gate ${gate} is outside the closed vocabulary`);
  };
  for (const row of rows) {
    check(row.id, row.gate);
    if (!trackedSrc.has(row.module)) out.push(`${row.id}: module ${row.module} is not a tracked src file`);
    for (const caller of row.callers ?? []) {
      const where = `${row.id} caller ${caller.module}`;
      check(where, caller.gate);
      if (!trackedSrc.has(caller.module)) out.push(`${where}: module is not a tracked src file`);
      for (const field of ["symbol", "verb"] as const) if (!caller[field]) out.push(`${where}: ${field} must not be empty`);
      if (!Array.isArray(caller.ledgerSteps)) out.push(`${where}: ledgerSteps must be an array`);
      if (caller.gate === "host-switch" && !caller.hostSwitch) out.push(`${where}: a host-switch caller must name its switch`);
    }
  }
  return out;
}

test("W1-T13773 criterion 3: the closed gate vocabulary adds host-switch, whose callers require a switch and tracked source module", () => {
  const moveRow = AUTHORITY_TABLE.find((r) => r.id === "push-plan-move-branch")!;
  const janitor: AuthorityCaller = moveRow.callers![0]!;
  const directory = dirname(janitor.module);
  const modules = AUTHORITY_TABLE.flatMap((row) => [row.module, ...(row.callers ?? []).map((caller) => caller.module)]);
  const moduleSpecs = [...new Set([...modules, directory])]
    .filter((path) => path.startsWith("src/") && !path.split("/").includes(".."))
    .map((path) => `:(literal)${path}`);
  const trackedSrc = new Set(execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z", "--", ...moduleSpecs], { encoding: "utf8" })
    .split("\0").filter(Boolean));
  assert.deepEqual([...AUTHORITY_GATE_KINDS], ["policy", "ledger-verdict", "operator-verb", "sweep-rung", "always", "host-switch"]);
  assert.deepEqual(callerViolations(AUTHORITY_TABLE, trackedSrc), []);
  const hostSwitched = AUTHORITY_TABLE.flatMap((r) => (r.callers ?? []).filter((c) => c.gate === "host-switch"));
  assert.deepEqual(
    hostSwitched.map((caller) => caller.module),
    ["src/lib/plan-task-move-janitor.ts", "src/lib/plan-task-move-janitor.ts"],
    "both and only the two plan-move rows must list the janitor as a host-switch caller",
  );
  for (const id of ["push-plan-move-branch", "open-plan-move-pr"]) {
    const row = AUTHORITY_TABLE.find((candidate) => candidate.id === id)!;
    assert.equal(row.callers?.[0]?.gate, "host-switch", `${id} must carry its host-switch caller entry`);
    assert.match(row.callers?.[0]?.hostSwitch ?? "", /^state\/plan-destination\.json move_public_tasks\b/);
  }
  // FALSIFIERS: the self-check is not silent on a broken caller.
  const withCaller = (caller: AuthorityCaller): AuthorityRow[] => [{ ...moveRow, callers: [caller] }];
  const { hostSwitch: _dropped, ...noSwitch } = janitor;
  assert.deepEqual(callerViolations(withCaller(noSwitch), trackedSrc), [
    "push-plan-move-branch caller src/lib/plan-task-move-janitor.ts: a host-switch caller must name its switch",
  ]);
  assert.ok(statSync(join(REPO_ROOT, directory)).isDirectory());
  assert.deepEqual(callerViolations(withCaller({ ...janitor, module: directory }), trackedSrc), [
    "push-plan-move-branch caller src/lib: module is not a tracked src file",
  ]);
  assert.deepEqual(callerViolations(withCaller({ ...janitor, gate: "daemon-flag" as AuthorityCaller["gate"] }), trackedSrc), [
    "push-plan-move-branch caller src/lib/plan-task-move-janitor.ts: gate daemon-flag is outside the closed vocabulary",
  ]);
});

/**
 * Every caller-free row from origin/main (9d8ab9f996): a sha256 prefix over the report's JSON
 * row and its `rmd authority` line. An intentional change to this report updates the pin.
 */
const ROWS_AS_BEFORE: Record<string, string> = {
  "hand-worktree-run-branch-push": "8f57a3367c725422",
  "create-product-repository": "c75665ea4e8925f0",
  "propose-product-runner-config": "f4add31d2e9f816e",
  "restore-checkpoint-branch": "3369093791eeb635",
  "arm-auto-merge-at-open": "a928e813caacaa3a",
  "arm-auto-merge-ledger-gated": "b229b5dc18d856a9",
  "disarm-auto-merge": "e69e3f29e544d3a8",
  "arm-direct-merge-fallback": "5794a2ceb0b9625b",
  "light-pass-merge-at-list-head": "4f95a6f046e220c8",
  "update-branch-on-arm": "6673e76d3d6c3477",
  "open-task-pr": "e0dbb69158f4b5ba",
  "open-ratification-pr-single": "b6a38b898581f6a8",
  "open-ratification-pr-batch": "1dfa99df38e7b5cd",
  "pr-body-patch": "e9f7db77f594c595",
  "sweep-close-superseded-pr": "0e43d646730a2660",
  "sweep-ready-draft-pr": "2bb3e5584a8ab7e0",
  "sweep-ci-job-rerun": "8afd792e9abd1add",
  "worker-direct-merge-squash": "2e4305749768917b",
  "open-sandbox-spike-pr": "d409cbfc983531f1",
  "open-landing-pr": "167cb499d2057bc6",
  "arm-landing-pr-automerge": "d860b35bbe78290c",
  "force-push-landing-branch": "3cff6171c75317f5",
  "push-run-branch": "832bd71cf3767e95",
  "push-empty-commit-rebase": "e0b7dc443bcc414d",
  "file-needs-human-issue": "5cbb66d175396263",
  "escalate-issue-close-comment": "cef2f50553b4fe42",
  "post-review-status": "24d15075efc0c2bf",
  "post-ci-judge-status": "278d5d65e3e6f02f",
  "post-review-pr-comment": "0dd10ea928b97685",
  "specialist-panel-comment": "b5f30fee88f18dfd",
  "triage-claim-ref-push": "e3cf2e41e57c274d",
  "dispatch-claim-ref-push": "96ba987f9201c063",
  "fleet-pause-ref-push": "bf7f5f0a2482d050",
  "recovery-ref-push": "37782b31e45ff7f0",
  "task-id-reservation-ref-push": "06b424963c926d98",
  "task-id-reservation-ref-release": "1fec5408fc01c9f4",
  "prune-deletable-branches": "2f4e46d3c8e96e77",
  "archive-stale-held-branches": "b8134fe7b813372a",
  "garden-close-released-decision-pr": "75172268133ee97f",
  "machine-judge-withdraw-stale-pr": "1c41d52cc9386916",
  "onboard-pr": "a725f1777e5686ac",
  "sre-rerun-failed-ci-job": "f1d4616a6a0b35f4",
  "head-identity-trailer-commit": "085ad46113c08b28",
  "issue-close-panel-action": "677537872479a8a6",
};

function rowDigest(row: AuthorityReportRow, line: string): string {
  return createHash("sha256").update(JSON.stringify(row)).update("\n").update(line).digest("hex").slice(0, 16);
}

test("W1-T13773 criterion 4: invariant every-other-row-reads-as-before — each row without callers, its rmd authority line and its JSON row equal origin/main's", () => {
  const report = buildAuthorityReport({ ledger: fakeLedger([]) });
  assert.equal(report.status, "measured");
  if (report.status !== "measured") return;
  const lines = renderAuthorityReport(report).split("\n");
  const withCallers = report.rows.filter((r) => "callers" in r).map((r) => r.id);
  assert.deepEqual(withCallers, ["push-plan-move-branch", "open-plan-move-pr"]);
  const withoutCallers = report.rows.filter((row) => row.callers === undefined).map((row) => row.id).sort();
  assert.deepEqual(withoutCallers, Object.keys(ROWS_AS_BEFORE).sort(), "the pin covers every origin/main row that gained no callers");
  for (const [id, digest] of Object.entries(ROWS_AS_BEFORE)) {
    const row: AuthorityReportRow | undefined = report.rows.find((r) => r.id === id);
    assert.ok(row, `${id} must still exist`);
    assert.equal(row.callers, undefined, `${id} must carry no callers`);
    assert.ok(!("callers" in row), `${id}'s JSON row must carry no callers key`);
    const at = lines.findIndex((l) => l.startsWith(`${id.padEnd(42)} `));
    assert.ok(at > 0, `rmd authority must print a line for ${id}`);
    assert.doesNotMatch(lines[at + 1] ?? "", /^\s/, `no caller line may follow ${id}`);
    assert.equal(rowDigest(row, lines[at]), digest, `${id}: its JSON row or rmd authority line differs from origin/main's`);
  }
});
