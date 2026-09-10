/**
 * test/audit-command.test.ts — W1-T2924.
 *
 * `docs/audits/README.md` names "the audit rung (T2 monthly)" and its own first acceptance test
 * — "reproduces >= 80% of these 36 findings from source" — and stores two frozen findings
 * tables for exactly that purpose, but `name: "audit"` never appeared in the `COMMANDS` registry
 * (src/run-task.ts): two fixtures, zero consumers. This proves the fix two ways, the same split
 * test/proof-queue-audit.test.ts already uses for its sibling rung:
 *
 *   (i)  PURE FUNCTIONS — {@link parseFixtureFindings}/{@link parseEvidenceCitations}/
 *        {@link gradeFixture}/{@link gatherFindings} (lib/audit.ts) over hand-built markdown and
 *        an injected {@link AuditCorpus} — no filesystem, no repo. Includes the CONTROL: a fixture
 *        row whose evidence names a file nothing on earth carries is graded unreproduced.
 *   (ii) THE CALLER — {@link auditFixtureCommand} (src/run-task.ts) over the REAL
 *        `docs/audits/recon-2026-07-21.md` fixture with the real checkout as its corpus (no
 *        injected deps): asserts the printed `reproduced: N/36` names N >= 29, the README's own
 *        bar, and asserts a synthetic fixture's nonexistent-file control row prints as
 *        unreproduced through the full command, not just the pure grader.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildDefaultCorpus,
  gatherFindings,
  gradeFixture,
  parseEvidenceCitations,
  parseFixtureFindings,
  type AuditCorpus,
  type AuditFinding,
} from "../src/lib/audit.js";
import { auditFixtureCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── (i)(a) parseFixtureFindings — pure, hand-built markdown ─────────────────────────────────

test("parseFixtureFindings: reads ID and Evidence out of a findings table, skipping header/separator", () => {
  const markdown = [
    "# Some fixture",
    "",
    "| ID | Pillar | Sev | Eff | O/I | Tracked | Summary | Evidence |",
    "|---|---|---|---|---|---|---|---|",
    "| R-1 | B | **CRIT** | M | O | PARTIAL(x) | Something bad happened | foo.ts:12; bar.ts:9 |",
    "| R-2 | A | MED | S | O | NOVEL | Another thing | baz.ts (no rotation) |",
    "",
    "not a table row",
  ].join("\n");
  const rows = parseFixtureFindings(markdown);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["R-1", "R-2"],
  );
  assert.equal(rows[0].evidence, "foo.ts:12; bar.ts:9");
  assert.equal(rows[1].evidence, "baz.ts (no rotation)");
});

test("parseFixtureFindings: a table with no R-n rows yields an empty list, not a throw", () => {
  assert.deepEqual(parseFixtureFindings("# no table here\njust prose"), []);
});

// ── (i)(b) parseEvidenceCitations — pure ────────────────────────────────────────────────────

test("parseEvidenceCitations: splits on ';', pulls a file token and a backtick symbol per citation", () => {
  const citations = parseEvidenceCitations("escalate.ts:100,122; daemon.ts:329; ledger `daemon.boot`×460");
  assert.equal(citations.length, 3);
  assert.equal(citations[0].file, "escalate.ts");
  assert.equal(citations[0].symbol, undefined);
  assert.equal(citations[1].file, "daemon.ts");
  assert.equal(citations[2].symbol, "daemon.boot");
});

test("parseEvidenceCitations: a citation with no file-like token names no file", () => {
  const citations = parseEvidenceCitations("grep: no semaphore");
  assert.equal(citations.length, 1);
  assert.equal(citations[0].file, undefined);
});

// ── (i)(c) gradeFixture — pure, injected findings — includes the CONTROL row ────────────────

function finding(file: string, symbol?: string): AuditFinding {
  return { file, gatherer: "test-gatherer", symbol, detail: "test" };
}

test("gradeFixture: a row whose evidence file matches a finding's file is REPRODUCED", () => {
  const report = gradeFixture([finding("src/lib/daemon.ts")], [{ id: "R-1", evidence: "daemon.ts:329" }]);
  assert.equal(report.total, 1);
  assert.equal(report.reproducedCount, 1);
  assert.equal(report.rows[0].reproduced, true);
  assert.equal(report.rows[0].matchedFile, "src/lib/daemon.ts");
});

test("gradeFixture: a row with several evidence citations reproduces on ANY one matching", () => {
  const report = gradeFixture(
    [finding("src/lib/daemon.ts")],
    [{ id: "R-1", evidence: "escalate.ts:100,122; daemon.ts:329; daemon.err.log" }],
  );
  assert.equal(report.rows[0].reproduced, true);
});

test("gradeFixture: a citation carrying a backtick symbol requires that symbol on the matching-file finding", () => {
  const withoutSymbol = gradeFixture(
    [finding("src/lib/status.ts")],
    [{ id: "R-6", evidence: "status.ts: `some_specific_field`" }],
  );
  assert.equal(withoutSymbol.rows[0].reproduced, false, "the matching finding carries no matching symbol");

  const withSymbol = gradeFixture(
    [finding("src/lib/status.ts", "some_specific_field")],
    [{ id: "R-6", evidence: "status.ts: `some_specific_field`" }],
  );
  assert.equal(withSymbol.rows[0].reproduced, true);
});

test("gradeFixture: THE CONTROL — a row whose evidence names a file nothing gathered is UNREPRODUCED", () => {
  const report = gradeFixture(
    [finding("src/lib/daemon.ts"), finding("src/lib/status.ts")],
    [{ id: "R-99", evidence: "totally-fake-file-that-does-not-exist.ts:1" }],
  );
  assert.equal(report.total, 1);
  assert.equal(report.reproducedCount, 0);
  assert.equal(report.rows[0].reproduced, false);
  assert.equal(report.rows[0].matchedFile, undefined);
});

test("gradeFixture: a citation with no file token never reproduces anything, by construction", () => {
  const report = gradeFixture([finding("src/lib/daemon.ts")], [{ id: "R-21", evidence: "grep: no semaphore" }]);
  assert.equal(report.rows[0].reproduced, false);
});

// ── (i)(d) gatherFindings — pure, injected corpus ───────────────────────────────────────────

test("gatherFindings: an oversized file (over its scripts/source-size-baseline.json ceiling) is flagged", () => {
  const corpus: AuditCorpus = new Map([
    ["scripts/source-size-baseline.json", JSON.stringify({ "src/lib/tiny.ts": 2 })],
    ["src/lib/tiny.ts", "line1\nline2\nline3\nline4\n"],
  ]);
  const findings = gatherFindings(corpus);
  assert.ok(
    findings.some((f) => f.file === "src/lib/tiny.ts" && f.gatherer === "source-size-over-baseline"),
    "a file over its recorded ceiling must be gathered",
  );
});

test("gatherFindings: the SAME file under its ceiling is never flagged (the healthy arm)", () => {
  const corpus: AuditCorpus = new Map([
    ["scripts/source-size-baseline.json", JSON.stringify({ "src/lib/tiny.ts": 200 })],
    ["src/lib/tiny.ts", "line1\nline2\nline3\nline4\n"],
  ]);
  const findings = gatherFindings(corpus);
  assert.ok(!findings.some((f) => f.file === "src/lib/tiny.ts" && f.gatherer === "source-size-over-baseline"));
});

test("gatherFindings: execFileSync with no nearby timeout is flagged; the SAME call with one nearby is not", () => {
  const unsafe: AuditCorpus = new Map([["src/lib/unsafe.ts", 'execFileSync("gh", ["issue", "create"]);']]);
  const safe: AuditCorpus = new Map([["src/lib/safe.ts", 'execFileSync("gh", ["issue", "create"], { timeout: 5000 });']]);
  assert.ok(gatherFindings(unsafe).some((f) => f.gatherer === "exec-file-sync-without-timeout"));
  assert.ok(!gatherFindings(safe).some((f) => f.gatherer === "exec-file-sync-without-timeout"));
});

test("gatherFindings: malformed JSON inputs are ignored rather than thrown", () => {
  const corpus: AuditCorpus = new Map([
    ["scripts/source-size-baseline.json", "{not-json"],
    ["stryker.conf.json", "{also-not-json"],
    ["src/lib/env.ts", "export const x = process.env.X;"],
  ]);
  const findings = gatherFindings(corpus);
  assert.ok(findings.some((f) => f.gatherer === "process-env-reads"));
  assert.ok(!findings.some((f) => f.gatherer === "source-size-over-baseline"));
  assert.ok(!findings.some((f) => f.gatherer === "mutation-ratchet-scope"));
});

test("gatherFindings: dangling doc-to-source citations are reported once per doc", () => {
  const corpus: AuditCorpus = new Map([
    ["README.md", "See src/lib/missing.ts:10 for the old claim."],
    ["CONTRIBUTING.md", "See src/lib/present.ts:3 for a line past EOF."],
    ["src/lib/present.ts", "one\ntwo"],
  ]);
  const findings = gatherFindings(corpus).filter((f) => f.gatherer === "dangling-doc-citations");
  assert.deepEqual(
    findings.map((f) => [f.file, f.symbol]),
    [
      ["README.md", "src/lib/missing.ts"],
      ["CONTRIBUTING.md", "src/lib/present.ts"],
    ],
  );
});

test("buildDefaultCorpus: missing optional dirs and dangling walk entries are skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-audit-corpus-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    symlinkSync("missing-target.ts", join(root, "src", "dangling.ts"));
    const corpus = buildDefaultCorpus(root);
    assert.equal(corpus.has("src/dangling.ts"), false);
    assert.equal(corpus.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (ii) THE CALLER — real fixture, real checkout, no injected deps ─────────────────────────

async function runAuditCapturing(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const origLog = console.log;
  const origError = console.error;
  const lines: string[] = [];
  console.log = (m: string) => lines.push(m);
  console.error = (m: string) => lines.push(m);
  try {
    const exitCode = auditFixtureCommand(args);
    return { exitCode, stdout: lines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

test("auditFixtureCommand: an unknown flag is refused, exit 2", async () => {
  const { exitCode } = await runAuditCapturing(["--bogus"]);
  assert.equal(exitCode, 2);
});

test("auditFixtureCommand: --fixture is required, exit 2", async () => {
  const { exitCode } = await runAuditCapturing([]);
  assert.equal(exitCode, 2);
});

test("auditFixtureCommand: an unreadable --fixture path is refused, exit 2", async () => {
  const { exitCode } = await runAuditCapturing(["--fixture", join(REPO_ROOT, "no-such-w1-t2924-fixture.md")]);
  assert.equal(exitCode, 2);
});

test("auditFixtureCommand: a fixture with no finding rows prints a no-grade report, exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-audit-empty-fixture-"));
  try {
    const fixturePath = join(dir, "empty.md");
    writeFileSync(fixturePath, "# no findings here\n\n| ID | Evidence |\n|---|---|\n", "utf8");
    const { exitCode, stdout } = await runAuditCapturing(["--fixture", fixturePath]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /no '\| R-n \| .* \|' finding rows parsed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auditFixtureCommand: reproduces at least 29 of recon-2026-07-21.md's 36 findings from THIS real checkout", async () => {
  const fixturePath = join(REPO_ROOT, "docs", "audits", "recon-2026-07-21.md");
  const { exitCode, stdout } = await runAuditCapturing(["--fixture", fixturePath]);
  assert.equal(exitCode, 0, "a well-formed audit run must exit 0 regardless of the reproduction count");

  const m = stdout.match(/reproduced:\s*(\d+)\/(\d+)/);
  assert.ok(m, `expected a printed 'reproduced: N/M' line, got:\n${stdout}`);
  const [, reproducedStr, totalStr] = m as RegExpMatchArray;
  const reproduced = Number(reproducedStr);
  const total = Number(totalStr);
  assert.equal(total, 36, "the fixture carries exactly 36 findings");
  assert.ok(
    reproduced >= 29,
    `expected reproduced >= 29 (docs/audits/README.md's own >= 80% bar), got ${reproduced}/${total}:\n${stdout}`,
  );
  assert.match(stdout, /REPORT, not a gate/);
});

test("auditFixtureCommand: THE CONTROL — a synthetic fixture's nonexistent-file row prints as unreproduced", async () => {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t2924-audit-"));
  try {
    mkdirSync(dir, { recursive: true });
    const fixturePath = join(dir, "control-fixture.md");
    const body = [
      "| ID | Pillar | Sev | Eff | O/I | Tracked | Summary | Evidence |",
      "|---|---|---|---|---|---|---|---|",
      // A real citation: tsconfig.json really exists in this checkout, and (at filing) really
      // lacks noUncheckedIndexedAccess -- a live, currently-true gatherer hit, not hand-waved.
      "| R-1 | F | LOW | S | O | NOVEL | tsconfig lacks noUncheckedIndexedAccess | tsconfig.json |",
      // The control: no file on earth is named this, so no gatherer can ever cite it.
      "| R-2 | Z | LOW | S | O | NOVEL | a finding about nothing real | totally-fake-file-that-does-not-exist-w1-t2924.ts:1 |",
    ].join("\n");
    writeFileSync(fixturePath, body, "utf8");

    const { exitCode, stdout } = await runAuditCapturing(["--fixture", fixturePath]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /reproduced:\s*1\/2/, `expected exactly the real row to reproduce, got:\n${stdout}`);
    assert.match(stdout, /unreproduced \(1\): R-2/, `expected R-2 named as unreproduced, got:\n${stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
