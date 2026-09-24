import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  computeMeaningHash,
  draftInstrumentTaskProposal,
  instrumentTaskProposalId,
  resolveCanonicalRuleId,
  risingRecurrenceRuleIds,
  slugifyRuleId,
  verifyDoctrineReword,
  type DoctrineFreezeRow,
  type MergedRuleGroup,
} from "../src/lib/doctrine-lifecycle.js";
import { promoteRecurringRules, type RuleEfficacyReport } from "../src/lib/rule-efficacy.js";
import { parseProposalRegistry } from "../src/lib/inbox.js";

// ── W1-T4097: DOCTRINE CANNOT CHANGE, AND A RULE THAT KEEPS FAILING STAYS PROSE ────────────────
//
// `test/fixtures/doctrine-pre-migration-W1-T3323.json` froze all 56 rule bodies byte-for-byte, so
// correcting even a stale rule (W1-T4099's diff-coverage carve-out) meant quietly editing a frozen
// row against a comment nothing enforced. And `rule-efficacy.ts`'s `escalateRepeatingRules` only
// ever DRAFTS a proposal for a human to notice — CLAUDE.md#investigation-discipline:bound-fires-
// on-healthy-condition (effective 2026-08-06) is the worked example that stayed prose while its
// recurrence count kept climbing. This suite proves the two halves of the fix in
// lib/doctrine-lifecycle.ts (+ rule-efficacy.ts's new `promoteRecurringRules`): a body may be
// reworded when the row records why and its meaning is intact; a rule whose recurrences keep
// rising is automatically drafted into a stronger, distinct plan-task proposal; and a merged
// rule's every old id still resolves.

function tmpRegistryPath(): { dir: string; registryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-doctrine-lifecycle-"));
  return { dir, registryPath: join(dir, "inbox-proposals.json") };
}

function frozenRow(overrides: Partial<DoctrineFreezeRow> = {}): DoctrineFreezeRow {
  const headline = overrides.headline ?? "A bound must never fire on a healthy condition.";
  return {
    id: overrides.id ?? slugifyRuleId(headline),
    headline,
    bodyBytes: overrides.bodyBytes ?? 100,
    bodySha256: overrides.bodySha256 ?? "original-sha",
    meaningHash: overrides.meaningHash ?? computeMeaningHash(headline),
    ...(overrides.refrozenAt !== undefined ? { refrozenAt: overrides.refrozenAt } : {}),
    ...(overrides.refrozenReason !== undefined ? { refrozenReason: overrides.refrozenReason } : {}),
    ...(overrides.aliases !== undefined ? { aliases: overrides.aliases } : {}),
  };
}

// ── (1) a doctrine body may be reworded when its meaning hash is updated with a reason ─────────

test("W1-T4097: a doctrine body may be reworded when its meaning hash is updated with a reason", () => {
  // HEALTHY ARM: the body's bytes moved, but the row records why and its own meaningHash still
  // matches its own headline — the reword is permitted.
  const row = frozenRow({ bodySha256: "old-sha", refrozenReason: "W1-T4099: named the carve-out's hole and its fix" });
  const permitted = verifyDoctrineReword(row, "new-sha");
  assert.deepEqual(permitted, { ok: true });

  // UNHEALTHY ARM: the same bytes moved, but NO reason was recorded — refused, by name.
  const noReason = frozenRow({ bodySha256: "old-sha" });
  const refused = verifyDoctrineReword(noReason, "new-sha");
  assert.equal(refused.ok, false);
  assert.match((refused as { ok: false; reason: string }).reason, /no refrozenReason recorded/);

  // A row that RECORDS a reason but whose meaningHash was never actually updated to match its own
  // headline (hand-edited, or the headline itself silently changed) is refused too — a reason
  // alone is not proof the edit was reviewed against what the rule means.
  const inconsistentMeaning = frozenRow({ bodySha256: "old-sha", meaningHash: "stale-hash-from-a-different-headline", refrozenReason: "renamed it" });
  const inconsistent = verifyDoctrineReword(inconsistentMeaning, "new-sha");
  assert.equal(inconsistent.ok, false);
  assert.match((inconsistent as { ok: false; reason: string }).reason, /meaningHash does not match its own headline/);

  // CONTROL: untouched bytes need no reason at all — the mechanism only fires on real drift.
  assert.deepEqual(verifyDoctrineReword(frozenRow({ bodySha256: "same-sha" }), "same-sha"), { ok: true });

  // CONTROL: computeMeaningHash is a real function of the headline, not a constant — two
  // different headlines produce two different hashes, which is what makes the "meaning intact"
  // check above discriminate anything at all.
  assert.notEqual(computeMeaningHash("Headline one."), computeMeaningHash("Headline two, unrelated."));
  // …and re-wording WITHOUT changing meaning (punctuation/case only) still normalizes the same.
  assert.equal(computeMeaningHash("A Rule, Restated."), computeMeaningHash("a rule restated"));
});

// ── (2) a rule whose recurrences keep rising becomes a plan task ───────────────────────────────

function reportWithRecurrenceCount(ruleId: string, count: number): RuleEfficacyReport {
  return {
    stateDir: "/nonexistent",
    rules: [
      {
        ruleId,
        citation: "W1-T312, W1-T380/#1392, W1-T382/#1401",
        description: "A bound that fires on a HEALTHY condition is this repo's recurring defect.",
        status: "REPEATING",
        effectiveDate: "2026-08-06",
        recurrences: Array.from({ length: count }, (_, i) => ({ ts: `2026-08-${String(7 + i).padStart(2, "0")}T00:00:00.000Z`, step: "ci.stalled" })),
      },
    ],
    measurableCount: 1,
    repeatingCount: count > 0 ? 1 : 0,
    repeatIncidentRate: count > 0 ? 1 : 0,
  };
}

test("W1-T4097: a rule whose recurrences keep rising becomes a plan task", () => {
  const ruleId = "CLAUDE.md#investigation-discipline:bound-fires-on-healthy-condition";
  const { dir, registryPath } = tmpRegistryPath();
  try {
    // HEALTHY ARM: two passes, second STRICTLY higher than the first, both at/above the
    // escalation threshold — this is the 31-recurrences-since-2026-08-06 shape the task was filed
    // over. Drafts exactly one proposal, on its OWN id, distinct from a plain rule-efficacy
    // escalation.
    const previous = reportWithRecurrenceCount(ruleId, 2);
    const current = reportWithRecurrenceCount(ruleId, 3);
    const drafted = promoteRecurringRules(previous, current, registryPath);
    assert.ok(drafted, "a rising rule must draft a proposal");
    assert.equal(drafted.length, 1);
    assert.equal(drafted[0].id, instrumentTaskProposalId(ruleId));
    assert.match(drafted[0].summary, /RISING/);
    assert.match(drafted[0].summary, /recurred 2 time\(s\) at the PRIOR/);

    const onDisk = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(onDisk.length, 1);

    // Idempotent: a rerun over the same two passes never duplicates.
    const second = promoteRecurringRules(previous, current, registryPath);
    assert.equal(second, null, "an already-open instrument-task proposal must never be re-drafted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4097: a rule whose recurrences keep rising becomes a plan task — the UNHEALTHY arms draft nothing", () => {
  const ruleId = "CLAUDE.md#investigation-discipline:bound-fires-on-healthy-condition";

  // No prior pass at all — nothing to compare "rising" against.
  {
    const { dir, registryPath } = tmpRegistryPath();
    try {
      const drafted = promoteRecurringRules(undefined, reportWithRecurrenceCount(ruleId, 5), registryPath);
      assert.equal(drafted, null);
      assert.equal(existsSync(registryPath), false, "a first pass must never touch disk");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // STEADY count — not rising, even though both passes are above threshold.
  {
    const { dir, registryPath } = tmpRegistryPath();
    try {
      const drafted = promoteRecurringRules(reportWithRecurrenceCount(ruleId, 3), reportWithRecurrenceCount(ruleId, 3), registryPath);
      assert.equal(drafted, null);
      assert.equal(existsSync(registryPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // FALLING count — the rule is getting BETTER, not worse.
  {
    const { dir, registryPath } = tmpRegistryPath();
    try {
      const drafted = promoteRecurringRules(reportWithRecurrenceCount(ruleId, 5), reportWithRecurrenceCount(ruleId, 3), registryPath);
      assert.equal(drafted, null);
      assert.equal(existsSync(registryPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("W1-T4097: risingRecurrenceRuleIds is the pure comparison promoteRecurringRules relies on", () => {
  const rising = risingRecurrenceRuleIds([{ ruleId: "r1", recurrenceCount: 2 }], [{ ruleId: "r1", recurrenceCount: 4 }], 2);
  assert.deepEqual(rising, ["r1"]);
  // A rule first seen this pass (no previous entry) is never "rising".
  assert.deepEqual(risingRecurrenceRuleIds([], [{ ruleId: "r1", recurrenceCount: 4 }], 2), []);
  // Below threshold even after rising is not enough.
  assert.deepEqual(risingRecurrenceRuleIds([{ ruleId: "r1", recurrenceCount: 0 }], [{ ruleId: "r1", recurrenceCount: 1 }], 2), []);
});

test("W1-T4097: draftInstrumentTaskProposal names the prior AND current recurrence counts", () => {
  const proposal = draftInstrumentTaskProposal(
    {
      ruleId: "r1",
      citation: "#1",
      description: "d",
      recurrences: [{ ts: "2026-08-07T00:00:00.000Z", step: "ci.stalled" }, { ts: "2026-08-08T00:00:00.000Z", step: "ci.stalled" }],
    },
    1,
  );
  assert.equal(proposal.id, "instrument-task:r1");
  assert.match(proposal.summary, /recurred 1 time\(s\) at the PRIOR rule-efficacy pass and now 2/);
  assert.match(proposal.summary, /2026-08-07T00:00:00\.000Z, 2026-08-08T00:00:00\.000Z/);
});

// ── (3) a merged rule keeps every old id resolving ──────────────────────────────────────────────

test("W1-T4097: a merged rule keeps every old id resolving", () => {
  // Models folding investigation-discipline's (a)-(k) into one canonical rule with sub-cases:
  // every absorbed id must still resolve to the same canonical id a pointer or an operator's
  // memory carries it under.
  const groups: MergedRuleGroup[] = [
    {
      canonicalId: "investigation-discipline-corpus-blind-spots",
      aliasIds: [
        "a-a-posix-regex-engine",
        "b-the-grep-in-this-harness",
        "c-a-glob-that-names-one-file-form",
        "d-a-query-can-answer-the-wrong-question",
        "e-a-control-proves-the-query",
        "f-the-two-sides-of-a-comparison",
        "g-a-change-that-removes-an-access-path",
        "h-a-gate-run-from-a-checkout",
        "i-a-positive-control-proves-the-query",
        "j-a-census-test-names-none",
        "k-a-rule-21-protocol-run",
      ],
    },
  ];

  // HEALTHY ARM: the canonical id resolves to itself, and every one of the eleven old ids
  // resolves to the SAME canonical id.
  assert.equal(resolveCanonicalRuleId(groups, "investigation-discipline-corpus-blind-spots"), "investigation-discipline-corpus-blind-spots");
  for (const alias of groups[0].aliasIds) {
    assert.equal(resolveCanonicalRuleId(groups, alias), "investigation-discipline-corpus-blind-spots");
  }

  // UNHEALTHY/CONTROL ARM: an id that was never part of any merge resolves to itself — merging
  // must never become a trap for an unrelated pointer.
  assert.equal(resolveCanonicalRuleId(groups, "some-unrelated-rule-id"), "some-unrelated-rule-id");
  assert.equal(resolveCanonicalRuleId([], "any-id"), "any-id");
});

test("W1-T4097: slugifyRuleId produces stable, distinct, path-safe ids for real headlines", () => {
  const a = slugifyRuleId("(a) A POSIX REGEX ENGINE HERE SILENTLY DROPS `\\s`/`\\b` INSTEAD OF ERRORING.");
  const b = slugifyRuleId("(b) THE `grep` IN THIS HARNESS IS A ugrep WRAPPER WITH `-I` INJECTED.");
  assert.notEqual(a, b);
  assert.match(a, /^[a-z0-9-]+$/);
  assert.equal(slugifyRuleId("Run the shipped local gate before your FIRST push, not every commit."), slugifyRuleId("Run the shipped local gate before your FIRST push, not every commit."));
});
