import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { writeLedger } from "./helpers/ledger-fixture.js";
import {
  escalateRepeatingRules,
  promoteRecurringRules,
  ruleEfficacyProposalId,
  ruleEfficacyReport,
  RULE_EFFICACY_ESCALATION_THRESHOLD,
  RULE_SIGNATURES,
  type MeasurableRuleSignature,
} from "../src/lib/rule-efficacy.js";
import { parseProposalRegistry } from "../src/lib/inbox.js";

const fixtureRule = (signatureKind: "ACTIVITY" | "VIOLATION"): MeasurableRuleSignature => ({
  ruleId: "test#signature-kind",
  citation: "W1-T4271",
  description: "fixture mechanism",
  measurable: true,
  signatureKind,
  effectiveDate: "2026-08-06",
  stepPatterns: [/^fixture\.fire$/],
});

// The first row lands in a gzipped rotation archive, the rest in the live file, so every
// ledger-channel case reads across a rotation boundary. Built with the shared fixture.
function withStepRows(steps: string[], run: (dir: string, registryPath: string) => void): void {
  const rows = steps.map((step, i) => ({ ts: new Date(Date.UTC(2026, 7, 7 + i)).toISOString(), step }));
  const { dir } = writeLedger(rows.slice(1), {
    rotations: [{ at: "2026-08-07T00:00:00.000Z", rows: rows.slice(0, 1), gz: true }],
  });
  try {
    run(dir, join(dir, "inbox-proposals.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T4271: an ACTIVITY-shaped signature reports UNPROVEN with its match count and drafts no proposal", () => {
  withStepRows(["fixture.fire", "fixture.fire"], (dir, registryPath) => {
    const report = ruleEfficacyReport(dir, [fixtureRule("ACTIVITY")]);
    const rule = report.rules[0];
    assert.equal(rule.status, "UNPROVEN");
    assert.equal(rule.signatureKind, "ACTIVITY");
    assert.equal(rule.recurrences.length, 2);
    assert.match(rule.why ?? "", /2 activity match/);
    assert.match(rule.why ?? "", /a fire is not a violation until the subject's health is observed/);
    assert.equal(report.ledger?.archiveCount, 1);
    assert.equal(report.ledger?.liveFileRead, true);
    assert.equal(report.measurableCount, 0);
    assert.equal(report.repeatingCount, 0);
    assert.equal(report.repeatIncidentRate, null);
    assert.equal(escalateRepeatingRules(report, registryPath), null);
    assert.equal(escalateRepeatingRules(report, registryPath), null);
    assert.equal(existsSync(registryPath), false);
  });
});

test("W1-T4271: a VIOLATION-shaped signature still reaches REPEATING and drafts exactly one idempotent proposal", () => {
  withStepRows(Array(RULE_EFFICACY_ESCALATION_THRESHOLD).fill("fixture.fire"), (dir, registryPath) => {
    const report = ruleEfficacyReport(dir, [fixtureRule("VIOLATION")]);
    const rule = report.rules[0];
    assert.equal(rule.status, "REPEATING");
    assert.equal(rule.signatureKind, "VIOLATION");
    assert.equal(rule.recurrences.length, RULE_EFFICACY_ESCALATION_THRESHOLD);
    assert.equal(report.measurableCount, 1);
    assert.equal(report.repeatingCount, 1);
    assert.equal(report.repeatIncidentRate, 1);
    const drafted = escalateRepeatingRules(report, registryPath);
    assert.ok(drafted);
    assert.equal(drafted.length, 1);
    assert.equal(drafted[0].id, ruleEfficacyProposalId(rule.ruleId));
    assert.equal(escalateRepeatingRules(report, registryPath), null);
    assert.equal(parseProposalRegistry(readFileSync(registryPath, "utf8")).length, 1);
  });
});

test("W1-T4271: the shipped bound-fires-on-healthy entry is ACTIVITY-shaped and its 31 post-date rows draft no proposal", () => {
  const shipped = RULE_SIGNATURES.find((rule) => rule.ruleId.endsWith(":bound-fires-on-healthy-condition"));
  assert.ok(shipped?.measurable);
  assert.equal(shipped.signatureKind, "ACTIVITY");
  assert.match(shipped.signatureReason ?? "", /src\/run-task\.ts.*waitForCiGreen/);
  assert.match(shipped.signatureReason ?? "", /src\/lib\/deployer\.ts/);
  const steps = Array.from({ length: 31 }, (_, i) => i % 2 === 0 ? "ci.stalled" : "deploy.idle_ceiling_forced");
  withStepRows(steps, (dir, registryPath) => {
    const report = ruleEfficacyReport(dir);
    const rule = report.rules.find((r) => r.ruleId === shipped.ruleId);
    assert.ok(rule);
    assert.equal(rule.status, "UNPROVEN");
    assert.equal(rule.recurrences.length, 31);
    assert.match(rule.why ?? "", /31 activity match/);
    assert.ok(rule.why?.includes(shipped.signatureReason!));
    assert.equal(report.repeatingCount, 0);
    assert.equal(report.repeatIncidentRate, null);
    assert.equal(escalateRepeatingRules(report, registryPath), null);
    assert.equal(escalateRepeatingRules(report, registryPath), null);
    assert.equal(existsSync(registryPath), false);
  });
});

test("W1-T4271: a table entry declaring no kind is refused rather than defaulting to violation", () => {
  const { signatureKind: _kind, ...undeclared } = fixtureRule("VIOLATION");
  assert.throws(
    () => ruleEfficacyReport("/unread-state-dir", [undeclared as MeasurableRuleSignature]),
    /test#signature-kind.*signatureKind.*VIOLATION.*ACTIVITY/,
  );
  assert.throws(
    () => ruleEfficacyReport("/unread-state-dir", [{ ...undeclared, signatureKind: "UNKNOWN" } as unknown as MeasurableRuleSignature]),
    /signatureKind.*VIOLATION.*ACTIVITY/,
  );
});

test("W1-T4271: zero activity matches remain UNPROVEN and do not dilute a violation rate", () => {
  withStepRows(["fixture.fire", "fixture.fire"], (dir) => {
    const activity = { ...fixtureRule("ACTIVITY"), ruleId: "test#idle", stepPatterns: [/^idle\.fire$/] };
    const report = ruleEfficacyReport(dir, [activity, fixtureRule("VIOLATION")]);
    assert.equal(report.rules[0].status, "UNPROVEN");
    assert.deepEqual(report.rules[0].recurrences, []);
    assert.match(report.rules[0].why ?? "", /0 activity match/);
    assert.equal(report.measurableCount, 1);
    assert.equal(report.repeatIncidentRate, 1);
  });
});

test("W1-T4271: the CI channel reads the declared kind and preserves the effective date boundary", () => {
  const observations = [
    { gate: "fixture.fire", at: "2026-08-06T00:00:00.000Z" },
    { gate: "fixture.fire", at: "2026-08-07T00:00:00.000Z" },
    { gate: "fixture.fire", at: "2026-08-08T00:00:00.000Z" },
    { gate: "unrelated", at: "2026-08-09T00:00:00.000Z" },
  ];
  withStepRows([], (dir, registryPath) => {
    for (const kind of ["ACTIVITY", "VIOLATION"] as const) {
      const { stepPatterns, ...sig } = fixtureRule(kind);
      const report = ruleEfficacyReport(dir, [{ ...sig, ciGatePatterns: stepPatterns }], undefined, observations);
      assert.equal(report.ledger, undefined);
      assert.equal(report.rules[0].status, kind === "ACTIVITY" ? "UNPROVEN" : "REPEATING");
      assert.equal(report.rules[0].recurrences.length, 2);
      if (kind === "ACTIVITY") {
        assert.equal(escalateRepeatingRules(report, registryPath), null);
        assert.equal(existsSync(registryPath), false);
      } else {
        assert.equal(escalateRepeatingRules(report, registryPath)?.length, 1);
      }
    }
  });
});

test("W1-T4271: declared violation zeroes are PREVENTING and unavailable corpora are refused", () => {
  withStepRows(["unrelated"], (dir) => {
    const report = ruleEfficacyReport(dir, [fixtureRule("VIOLATION")]);
    assert.equal(report.rules[0].status, "PREVENTING");
    assert.equal(report.repeatIncidentRate, 0);
  });
  for (const kind of ["ACTIVITY", "VIOLATION"] as const) {
    const sig = fixtureRule(kind);
    assert.equal(ruleEfficacyReport("/unread-state-dir", [sig]).rules[0].status, "UNMEASURABLE");
    const { stepPatterns, ...ciSig } = sig;
    const ci = { ...ciSig, ciGatePatterns: stepPatterns };
    const empty = ruleEfficacyReport("/unread-state-dir", [ci], undefined, []);
    assert.equal(empty.rules[0].status, kind === "ACTIVITY" ? "UNPROVEN" : "PREVENTING");
    assert.equal(ruleEfficacyReport("/unread-state-dir", [ci]).rules[0].status, "UNMEASURABLE");
  }
});

test("W1-T4271: activity cannot escalate or promote even in a stale REPEATING report", () => {
  withStepRows(["fixture.fire", "fixture.fire"], (dir, registryPath) => {
    const previous = ruleEfficacyReport(dir, [fixtureRule("ACTIVITY")]);
    const current = ruleEfficacyReport(dir, [fixtureRule("ACTIVITY")]);
    previous.rules[0].status = "REPEATING";
    current.rules[0].status = "REPEATING";
    current.rules[0].recurrences.push({ ts: "2026-08-10T00:00:00.000Z", step: "fixture.fire" });
    assert.equal(escalateRepeatingRules(current, registryPath), null);
    assert.equal(promoteRecurringRules(previous, current, registryPath), null);
    assert.equal(existsSync(registryPath), false);
    previous.rules[0].signatureKind = "VIOLATION";
    current.rules[0].signatureKind = "VIOLATION";
    assert.equal(promoteRecurringRules(previous, current, registryPath)?.length, 1);
    assert.equal(promoteRecurringRules(previous, current, registryPath), null);
  });
});
