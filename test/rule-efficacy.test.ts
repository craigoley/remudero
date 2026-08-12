import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import {
  escalateRepeatingRules,
  ruleEfficacyProposalId,
  ruleEfficacyReport,
  RULE_EFFICACY_ESCALATION_THRESHOLD,
  RULE_SIGNATURES,
  type MeasurableRuleSignature,
  type RuleSignature,
} from "../src/lib/rule-efficacy.js";
import { parseProposalRegistry } from "../src/lib/inbox.js";
import { configPath, type Config } from "../src/lib/config.js";
import { ruleEfficacyCommand } from "../src/run-task.js";

function tmpStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeGzArchive(stateDir: string, name: string, lines: string[]): void {
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8")));
}

function ledgerLine(ts: string, step: string): string {
  return JSON.stringify({ ts, step, task_id: "W1-T1" });
}

// A decoupled fixture rule — the falsifier below must not depend on RULE_SIGNATURES' real
// entries (or their real dates), which get widened over time as follow-on work.
const FIXTURE_RULE: MeasurableRuleSignature = {
  ruleId: "test#fixture-rule",
  citation: "#1",
  description: "a fixture rule for the falsifier",
  measurable: true,
  effectiveDate: "2026-01-01T00:00:00.000Z",
  stepPatterns: [/^fixture\.failure$/],
};
const FIXTURE_TABLE: readonly RuleSignature[] = [FIXTURE_RULE];

// ── ruleEfficacyReport: the pure core ──────────────────────────────────────────────────────

test("an EMPTY signature table renders no rules, a null rate, and never touches the ledger", () => {
  // A path that would throw were it actually read (proving resolveLedgerUnion is never even
  // called — the report's own `ledger` field stays undefined, per the module's contract).
  const report = ruleEfficacyReport("/nonexistent/does/not/exist", []);
  assert.deepEqual(report.rules, []);
  assert.equal(report.measurableCount, 0);
  assert.equal(report.repeatingCount, 0);
  assert.equal(report.repeatIncidentRate, null, "a rate over nothing measured must refuse to print, never a false 0%");
  assert.equal(report.ledger, undefined);
});

test("an UNMEASURABLE-only table (no measurable rule) also never touches the ledger", () => {
  const table: readonly RuleSignature[] = [
    { ruleId: "r1", citation: "#1", description: "d", measurable: false, why: "no ledger signal" },
  ];
  const report = ruleEfficacyReport("/nonexistent/does/not/exist", table);
  assert.equal(report.rules.length, 1);
  assert.equal(report.rules[0].status, "UNMEASURABLE");
  assert.equal(report.rules[0].why, "no ledger signal");
  assert.equal(report.repeatIncidentRate, null);
  assert.equal(report.ledger, undefined);
});

test("FALSIFIER (after): two post-rule-date rows yield REPEATING with both dates, over the UNION", () => {
  const dir = tmpStateDir("rmd-rule-efficacy-after-");
  try {
    writeGzArchive(dir, "ledger.2026-02-01T00-00-00-000Z.ndjson.gz", [
      ledgerLine("2026-02-01T00:00:00.000Z", "fixture.failure"),
    ]);
    writeFileSync(join(dir, "ledger.ndjson"), ledgerLine("2026-03-01T00:00:00.000Z", "fixture.failure") + "\n");

    const report = ruleEfficacyReport(dir, FIXTURE_TABLE);
    assert.equal(report.rules.length, 1);
    const rule = report.rules[0];
    assert.equal(rule.status, "REPEATING");
    assert.equal(rule.recurrences.length, 2);
    assert.deepEqual(
      rule.recurrences.map((r) => r.ts),
      ["2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
      "recurrences must be sorted and both dates named — REPEATING (n since, dates)",
    );
    assert.equal(report.measurableCount, 1);
    assert.equal(report.repeatingCount, 1);
    assert.equal(report.repeatIncidentRate, 1);
    assert.ok(report.ledger?.ok);
    assert.equal(report.ledger?.archiveCount, 1, "must have read the ARCHIVE, not just the live file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER (before): the SAME two rows dated before the rule's citation yield PREVENTING", () => {
  const dir = tmpStateDir("rmd-rule-efficacy-before-");
  try {
    writeGzArchive(dir, "ledger.2025-01-01T00-00-00-000Z.ndjson.gz", [
      ledgerLine("2025-01-01T00:00:00.000Z", "fixture.failure"),
      ledgerLine("2025-06-01T00:00:00.000Z", "fixture.failure"),
    ]);

    const report = ruleEfficacyReport(dir, FIXTURE_TABLE);
    const rule = report.rules[0];
    assert.equal(rule.status, "PREVENTING");
    assert.deepEqual(rule.recurrences, []);
    assert.equal(report.repeatingCount, 0);
    assert.equal(report.repeatIncidentRate, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zero archive files matched degrades a measurable rule to UNMEASURABLE, never a false PREVENTING", () => {
  const dir = tmpStateDir("rmd-rule-efficacy-noarchive-");
  try {
    // The exact silent-undercount shape lib/ledger-grep.ts exists to stop: a matching live file,
    // zero archives.
    writeFileSync(join(dir, "ledger.ndjson"), ledgerLine("2026-06-01T00:00:00.000Z", "fixture.failure") + "\n");

    const report = ruleEfficacyReport(dir, FIXTURE_TABLE);
    const rule = report.rules[0];
    assert.equal(rule.status, "UNMEASURABLE");
    assert.match(rule.why ?? "", /zero archive files matched/);
    assert.equal(report.measurableCount, 0, "a ledger-unreadable rule must not count toward the rate's denominator");
    assert.equal(report.repeatIncidentRate, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unrelated step name in the union never counts as a recurrence", () => {
  const dir = tmpStateDir("rmd-rule-efficacy-unrelated-");
  try {
    writeGzArchive(dir, "ledger.2026-02-01T00-00-00-000Z.ndjson.gz", [
      ledgerLine("2026-02-01T00:00:00.000Z", "some.other.step"),
    ]);
    const report = ruleEfficacyReport(dir, FIXTURE_TABLE);
    assert.equal(report.rules[0].status, "PREVENTING");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The real signature table ────────────────────────────────────────────────────────────────

test("RULE_SIGNATURES starts with the three rules named in the rationale, one measurable", () => {
  assert.equal(RULE_SIGNATURES.length, 3);
  const measurable = RULE_SIGNATURES.filter((s) => s.measurable);
  const unmeasurable = RULE_SIGNATURES.filter((s) => !s.measurable);
  assert.equal(measurable.length, 1, "only bound-fires-on-healthy-condition is ledger-visible without a GitHub read");
  assert.equal(unmeasurable.length, 2);
  for (const u of unmeasurable) {
    assert.ok(u.why && u.why.length > 0, `${u.ruleId} must state WHY it is unmeasurable — never a naked omission`);
  }
  const m = measurable[0] as MeasurableRuleSignature;
  assert.ok(m.stepPatterns.length > 0);
  assert.ok(!Number.isNaN(new Date(m.effectiveDate).getTime()), "effectiveDate must be a parseable date");
});

// ── escalateRepeatingRules: the escalation ─────────────────────────────────────────────────

function tmpRegistryPath(): { dir: string; registryPath: string } {
  const dir = tmpStateDir("rmd-rule-efficacy-registry-");
  return { dir, registryPath: join(dir, "inbox-proposals.json") };
}

test("ruleEfficacyProposalId is deterministic from the rule id", () => {
  assert.equal(ruleEfficacyProposalId("foo"), "rule-efficacy:foo");
});

test("a REPEATING rule below the escalation threshold drafts nothing", () => {
  const { dir, registryPath } = tmpRegistryPath();
  try {
    const report = {
      stateDir: dir,
      rules: [
        {
          ruleId: FIXTURE_RULE.ruleId,
          citation: FIXTURE_RULE.citation,
          description: FIXTURE_RULE.description,
          status: "REPEATING" as const,
          effectiveDate: FIXTURE_RULE.effectiveDate,
          recurrences: [{ ts: "2026-02-01T00:00:00.000Z", step: "fixture.failure" }],
        },
      ],
      measurableCount: 1,
      repeatingCount: 1,
      repeatIncidentRate: 1,
    };
    assert.equal(report.rules[0].recurrences.length < RULE_EFFICACY_ESCALATION_THRESHOLD, true);
    const drafted = escalateRepeatingRules(report, registryPath);
    assert.equal(drafted, null);
    assert.equal(existsSync(registryPath), false, "a no-op escalation must never touch disk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a PREVENTING-only report drafts nothing and never writes the registry", () => {
  const { dir, registryPath } = tmpRegistryPath();
  try {
    const report = {
      stateDir: dir,
      rules: [
        {
          ruleId: FIXTURE_RULE.ruleId,
          citation: FIXTURE_RULE.citation,
          description: FIXTURE_RULE.description,
          status: "PREVENTING" as const,
          effectiveDate: FIXTURE_RULE.effectiveDate,
          recurrences: [],
        },
      ],
      measurableCount: 1,
      repeatingCount: 0,
      repeatIncidentRate: 0,
    };
    const drafted = escalateRepeatingRules(report, registryPath);
    assert.equal(drafted, null);
    assert.equal(existsSync(registryPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER: a rule at >= 2 post-rule recurrences drafts exactly ONE proposal across TWO runs (idempotent)", () => {
  const { dir, registryPath } = tmpRegistryPath();
  try {
    const report = {
      stateDir: dir,
      rules: [
        {
          ruleId: FIXTURE_RULE.ruleId,
          citation: FIXTURE_RULE.citation,
          description: FIXTURE_RULE.description,
          status: "REPEATING" as const,
          effectiveDate: FIXTURE_RULE.effectiveDate,
          recurrences: [
            { ts: "2026-02-01T00:00:00.000Z", step: "fixture.failure" },
            { ts: "2026-03-01T00:00:00.000Z", step: "fixture.failure" },
          ],
        },
      ],
      measurableCount: 1,
      repeatingCount: 1,
      repeatIncidentRate: 1,
    };

    // Run 1: drafts through the single-writer helper.
    const first = escalateRepeatingRules(report, registryPath);
    assert.ok(first, "run 1 must draft a proposal");
    assert.equal(first.length, 1);
    assert.equal(first[0].id, "rule-efficacy:test#fixture-rule");
    assert.match(first[0].summary, /recurred 2 time\(s\)/);
    assert.match(first[0].summary, /2026-02-01T00:00:00\.000Z, 2026-03-01T00:00:00\.000Z/);

    const onDisk1 = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(onDisk1.length, 1);

    // Run 2 (rerun over the SAME state, e.g. the daemon's next poll): must not duplicate.
    const second = escalateRepeatingRules(report, registryPath);
    assert.equal(second, null, "an already-open proposal for this rule id must never be re-drafted");

    const onDisk2 = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(onDisk2.length, 1, "exactly one drafted proposal across two runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("escalation appends alongside unrelated existing proposals, never clobbering them", () => {
  const { dir, registryPath } = tmpRegistryPath();
  try {
    writeFileSync(registryPath, JSON.stringify({ proposals: [{ id: "P1", summary: "unrelated", evidenceAnchors: [] }] }));
    const report = {
      stateDir: dir,
      rules: [
        {
          ruleId: FIXTURE_RULE.ruleId,
          citation: FIXTURE_RULE.citation,
          description: FIXTURE_RULE.description,
          status: "REPEATING" as const,
          effectiveDate: FIXTURE_RULE.effectiveDate,
          recurrences: [
            { ts: "2026-02-01T00:00:00.000Z", step: "fixture.failure" },
            { ts: "2026-03-01T00:00:00.000Z", step: "fixture.failure" },
          ],
        },
      ],
      measurableCount: 1,
      repeatingCount: 1,
      repeatIncidentRate: 1,
    };
    const drafted = escalateRepeatingRules(report, registryPath);
    assert.ok(drafted);
    const ids = drafted.map((p) => p.id).sort();
    assert.deepEqual(ids, ["P1", "rule-efficacy:test#fixture-rule"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ruleEfficacyCommand: the CLI shell ──────────────────────────────────────────────────────

test("ruleEfficacyCommand refuses an unknown flag, spawning nothing", () => {
  const realErr = console.error;
  console.error = () => {};
  try {
    assert.equal(ruleEfficacyCommand(["--bogus"]), 2);
  } finally {
    console.error = realErr;
  }
});

test("ruleEfficacyCommand prints the repeat-incident headline and every rule's verdict, exit 0", () => {
  const dir = tmpStateDir("rmd-rule-efficacy-cli-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    const code = ruleEfficacyCommand(["--no-escalate"], { stateDir: dir });
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /repeat-incident rate:/, "the headline must name the metric, not a raw count");
    assert.match(out, /UNMEASURABLE/);
    assert.doesNotMatch(out, /escalated:/, "--no-escalate must skip the escalation step entirely");
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruleEfficacyCommand escalates a REPEATING real rule through the registry, unless --no-escalate", () => {
  const dir = tmpStateDir("rmd-rule-efficacy-cli-escalate-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    // Two ci.stalled rows strictly after the real bound-fires-on-healthy-condition rule's
    // effective date (2026-08-06) — the ONE measurable entry in RULE_SIGNATURES today.
    writeGzArchive(dir, "ledger.2026-08-10T00-00-00-000Z.ndjson.gz", [
      ledgerLine("2026-08-10T00:00:00.000Z", "ci.stalled"),
      ledgerLine("2026-08-11T00:00:00.000Z", "ci.stalled"),
    ]);

    const code = ruleEfficacyCommand([], { stateDir: dir });
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /REPEATING.*investigation-discipline:bound-fires-on-healthy-condition/s);
    assert.match(out, /escalated: registry now carries 1 proposal/);

    const registryPath = join(dir, "inbox-proposals.json");
    const proposals = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].id, "rule-efficacy:CLAUDE.md#investigation-discipline:bound-fires-on-healthy-condition");
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ruleEfficacyCommand prints PREVENTING for a real measurable rule with only pre-date rows, and escalates nothing", () => {
  const dir = tmpStateDir("rmd-rule-efficacy-cli-preventing-");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    // Archives present (so the union reads OK), but the only ci.stalled row predates the real
    // bound-fires-on-healthy-condition rule's effective date (2026-08-06) — PREVENTING.
    writeGzArchive(dir, "ledger.2026-01-01T00-00-00-000Z.ndjson.gz", [ledgerLine("2026-01-01T00:00:00.000Z", "ci.stalled")]);

    const code = ruleEfficacyCommand([], { stateDir: dir });
    assert.equal(code, 0);
    const out = logs.join("\n");
    assert.match(out, /PREVENTING.*investigation-discipline:bound-fires-on-healthy-condition/s);
    assert.match(out, /escalated: nothing new/);
  } finally {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ruleEfficacyCommand's default `stateDir` resolution (opts.stateDir omitted) ────────────
//
// Mirrors ledgerGrepCommand's own dedicated tests for the SAME
// `opts.stateDir ?? (() => { try { … loadConfig() … } catch { … } })()` seam (test/ledger-grep.test.ts).

test("ruleEfficacyCommand with no opts.stateDir resolves it from loadConfig().root", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-rule-efficacy-cfg-ok-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    const cfg: Config = { claudeBin: "/opt/homebrew/bin/claude", root: join(home, "Remudero") };
    writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");

    const code = ruleEfficacyCommand(["--no-escalate"]);

    assert.equal(code, 0);
    assert.match(logs.join("\n"), new RegExp(`over the unioned ledger at ${join(cfg.root, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    console.log = realLog;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("ruleEfficacyCommand with no opts.stateDir and an unreadable config reports 'cannot resolve', never a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-rule-efficacy-cfg-bad-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const errs: string[] = [];
  const realErr = console.error;
  const realLog = console.log;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  console.log = () => {};
  try {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "not json");

    const code = ruleEfficacyCommand([]);

    assert.equal(code, 1);
    assert.match(errs.join("\n"), /rmd rule-efficacy: cannot resolve a state dir — unreadable config/);
  } finally {
    console.error = realErr;
    console.log = realLog;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// diff-cov: process-boundary — main() CLI dispatch for `rmd rule-efficacy` (process.exit
// wrapping ruleEfficacyCommand) cannot carry a DA hit without forking the process; the SAME
// discipline as ledger-grep/emissions' own dispatch lines (src/run-task.ts) — ruleEfficacyCommand
// itself is fully exercised above.
