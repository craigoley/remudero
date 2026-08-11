import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_ATTRIBUTION_EPOCH,
  groupSpendByAccount,
  type LedgerLine,
} from "../src/lib/ledger.js";
import { workerLedgerFields, type WorkerResult } from "../src/lib/worker.js";
import { workerErrorVerdict, noPrVerdict, checkPrOwnership } from "../src/run-task.js";
import type { PrHeadGateway } from "../src/run-task.js";

// ── W1-T268: THE LEDGER GETS AN ACCOUNT DIMENSION, WITH A HARD START DATE ──────────────
//
// Rationale (plan/tasks.d/W1-T268-ledger-account-dimension.yaml): no line in this ledger's
// unioned history ever carried an `account`-prefixed key, and — because appendLedger only
// ever appends — a line written before the field existed can NEVER be retrofitted with one.
// So (1) every spend-carrying ledger line must now carry an `account_label` (a NAME, never
// a credential — the same "proof surface never holds a secret" discipline `billingMode`
// already keeps), (2) `billing_mode` on a verdict line must be DERIVED from the run's actual
// child env keys rather than one of the fourteen hardcoded `"subscription"` literals that
// used to produce ~169k lying lines, and (3) any query that groups spend by account must
// REFUSE a line older than the exported `ACCOUNT_ATTRIBUTION_EPOCH` rather than guess it
// belongs to whichever label happens to be current.

function fixtureResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 1.5,
    numTurns: 3,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "claude-opus-4",
    effort: "high",
    tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

// ── Acceptance #1: every ledger line carrying a spend figure also carries an account
// label, and the label is a NAME, never a credential. ──────────────────────────────────

test("workerLedgerFields: carries account_label verbatim off WorkerResult.accountLabel, a name never a secret", () => {
  const r = fixtureResult({ accountLabel: "user@example.com", costUsd: 2.5 });
  const fields = workerLedgerFields(r);
  assert.equal(fields.account_label, "user@example.com");
  assert.equal(fields.total_cost_usd, 2.5);
  // The account label travels as a NAME (accountUuid/emailAddress), never a secret value —
  // the same proof `billing_mode` already keeps (see env.ts's SANCTIONED_KEY doc).
  assert.equal(JSON.stringify(fields).includes("sk-ant"), false);
});

test("workerLedgerFields: account_label is undefined (never guessed) when no identity could be resolved", () => {
  const r = fixtureResult({ accountLabel: undefined });
  const fields = workerLedgerFields(r);
  assert.equal(fields.account_label, undefined);
});

test("workerErrorVerdict: the ledger payload carries account_label alongside the DERIVED billing_mode", () => {
  const r = fixtureResult({
    isError: true,
    subtype: "error_max_turns",
    accountLabel: "acct-uuid-a",
    childEnvKeys: ["HOME", "PATH"],
  });
  const v = workerErrorVerdict(r, 4.2, "implement");
  assert.ok(v);
  assert.equal(v.ledger.account_label, "acct-uuid-a");
  assert.equal(v.ledger.billing_mode, "subscription");
});

test("workerErrorVerdict: billing_mode reads 'api' when the child spawned WITH the ANTHROPIC_API_KEY valve — never a hardcoded literal", () => {
  const r = fixtureResult({
    isError: true,
    subtype: "failed",
    accountLabel: "acct-uuid-b",
    childEnvKeys: ["HOME", "PATH", "ANTHROPIC_API_KEY"],
  });
  const v = workerErrorVerdict(r, 1.1, "implement");
  assert.ok(v);
  assert.equal(v.ledger.billing_mode, "api");
});

test("noPrVerdict: the ledger payload carries account_label alongside the DERIVED billing_mode", () => {
  const r = fixtureResult({ accountLabel: "acct-uuid-c", childEnvKeys: [] });
  const v = noPrVerdict(r, 3.3, "implement", 0);
  assert.equal(v.ledger.account_label, "acct-uuid-c");
  assert.equal(v.ledger.billing_mode, "subscription");
});

test("checkPrOwnership: the pr_attribution_failed ledger line carries the run's account_label (appended last, no positional caller shifts)", () => {
  const gateway: PrHeadGateway = { headRefName: () => "some-other-branch" };
  const v = checkPrOwnership("https://github.com/acme/remudero/pull/80", "run-own-branch", gateway, 2.1, "acct-uuid-d");
  assert.ok(v);
  assert.equal(v.ledger.account_label, "acct-uuid-d");
});

// ── Acceptance #2/#3: billing_mode is DERIVED (never hardcoded) in run-task.ts, and no
// hardcoded `"subscription"` literal survives anywhere `billing_mode` is set. Re-derived
// from the ACTUAL SOURCE on every run — not a copy of a count — matching the same
// "derived from consumers, not hardcoded" discipline test/ledger-rotation.test.ts already
// applies to DECISION_RELEVANT_LEDGER_STEPS. ────────────────────────────────────────────

test("src/run-task.ts: no `billing_mode: \"subscription\"` (or any hardcoded BillingMode literal) survives", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  const hardcoded = [...src.matchAll(/billing_mode\s*:\s*"(subscription|api)"/g)];
  assert.deepEqual(
    hardcoded.map((m) => m[0]),
    [],
    "every billing_mode assignment in run-task.ts must be DERIVED (billingMode(...)), never a literal string",
  );
});

test("src/run-task.ts: every `billing_mode:` assignment site is the derivation call, `billing_mode: billingMode(`", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  // Interface type annotations (`billing_mode: BillingMode;`) are the only other legal shape —
  // anything else assigning a VALUE to billing_mode must be the derivation call.
  const assignments = [...src.matchAll(/billing_mode:\s*([^,\n;]+)/g)].map((m) => m[1].trim());
  assert.ok(assignments.length > 0, "sanity: the scan actually found billing_mode sites");
  for (const rhs of assignments) {
    assert.ok(
      rhs === "BillingMode" || rhs.startsWith("billingMode("),
      `billing_mode site "${rhs}" is neither the BillingMode type annotation nor a billingMode(...) derivation`,
    );
  }
});

// ── Acceptance #4: the attribution epoch is an exported constant. ──────────────────────

test("ACCOUNT_ATTRIBUTION_EPOCH: exported, and is the boot that re-provisioned the worker keychain after the account switch", () => {
  assert.equal(ACCOUNT_ATTRIBUTION_EPOCH, "2026-07-31T16:39:00.582Z");
  assert.ok(Number.isFinite(Date.parse(ACCOUNT_ATTRIBUTION_EPOCH)), "must be a parseable ISO instant");
});

// ── Acceptance #5: a spend query REFUSES to attribute a line older than the epoch instead
// of crediting the current label. ───────────────────────────────────────────────────────

function line(overrides: Partial<LedgerLine> & { ts: string }): LedgerLine {
  return { run_id: "r1", task_id: "T1", step: "verdict", ...overrides };
}

test("groupSpendByAccount: attributes a post-epoch, labelled spend line to its account", () => {
  const lines: LedgerLine[] = [
    line({ ts: "2026-08-01T00:00:00.000Z", total_cost_usd: 1.5, account_label: "acct-a" }),
    line({ ts: "2026-08-01T00:05:00.000Z", cost_usd: 2.5, account_label: "acct-a" }),
    line({ ts: "2026-08-01T00:10:00.000Z", total_cost_usd: 0.5, account_label: "acct-b" }),
  ];
  const summary = groupSpendByAccount(lines);
  const byLabel = Object.fromEntries(summary.byAccount.map((g) => [g.accountLabel, g]));
  assert.equal(byLabel["acct-a"].totalCostUsd, 4);
  assert.equal(byLabel["acct-a"].lineCount, 2);
  assert.equal(byLabel["acct-b"].totalCostUsd, 0.5);
  assert.deepEqual(summary.refused, { preEpochCount: 0, preEpochCostUsd: 0, unlabelledCount: 0, unlabelledCostUsd: 0 });
});

test("groupSpendByAccount: REFUSES a line older than ACCOUNT_ATTRIBUTION_EPOCH — never attributes it to the current label", () => {
  const lines: LedgerLine[] = [
    // Pre-epoch — no line in this era ever carried account_label; even one that somehow did
    // (a hypothetical mislabel) must still be refused, never credited.
    line({ ts: "2026-07-30T00:00:00.000Z", total_cost_usd: 10, account_label: "acct-a" }),
    line({ ts: ACCOUNT_ATTRIBUTION_EPOCH, total_cost_usd: 1, account_label: "acct-a" }),
  ];
  const summary = groupSpendByAccount(lines);
  assert.deepEqual(summary.byAccount, [{ accountLabel: "acct-a", totalCostUsd: 1, lineCount: 1 }]);
  assert.equal(summary.refused.preEpochCount, 1);
  assert.equal(summary.refused.preEpochCostUsd, 10);
});

test("groupSpendByAccount: a post-epoch spend line with NO account_label is refused, never guessed to be the current label", () => {
  const lines: LedgerLine[] = [line({ ts: "2026-08-01T00:00:00.000Z", cost_usd: 7 })];
  const summary = groupSpendByAccount(lines);
  assert.deepEqual(summary.byAccount, []);
  assert.equal(summary.refused.unlabelledCount, 1);
  assert.equal(summary.refused.unlabelledCostUsd, 7);
});

test("groupSpendByAccount: an unparseable/missing `ts` is treated as pre-epoch — never guessed to be recent", () => {
  const lines: LedgerLine[] = [
    { run_id: "r1", task_id: "T1", step: "verdict", ts: "not-a-date", total_cost_usd: 3, account_label: "acct-a" },
  ];
  const summary = groupSpendByAccount(lines);
  assert.deepEqual(summary.byAccount, []);
  assert.equal(summary.refused.preEpochCount, 1);
  assert.equal(summary.refused.preEpochCostUsd, 3);
});

test("groupSpendByAccount: a line with no spend figure at all is skipped entirely — neither attributed nor refused", () => {
  const lines: LedgerLine[] = [line({ ts: "2026-08-01T00:00:00.000Z", note: "no cost field here" })];
  const summary = groupSpendByAccount(lines);
  assert.deepEqual(summary.byAccount, []);
  assert.deepEqual(summary.refused, { preEpochCount: 0, preEpochCostUsd: 0, unlabelledCount: 0, unlabelledCostUsd: 0 });
});
