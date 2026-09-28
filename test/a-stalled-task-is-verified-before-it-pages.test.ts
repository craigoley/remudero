import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  decideStallVerdict,
  fingerprintStallEvidence,
  STALL_VERIFIED_STEP,
  stallShardFingerprint,
  verifyStalledTask,
  type StallEvidence,
} from "../src/lib/stall-verifier.js";

/**
 * W1-T4678 — "a circuit-broken task pages the operator with no diagnosis". These tests prove
 * the cheap-lane verifier's own contract: it reads the evidence (breaker counts, refusal
 * reasons, PR states, shard hash) and returns one of exactly four outcomes (design (i)), and it
 * runs at most once per new evidence fingerprint (design (ii)) rather than re-verifying —
 * and re-ledgering — identical evidence on every tick.
 */

function withLedger<T>(name: string, fn: (ledgerPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${name}`));
  try {
    return fn(join(dir, "ledger.ndjson"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ctx = (ledgerPath: string) => ({ repo: "r", ledgerPath, runId: "RUN-STALL" });

const baseEvidence: StallEvidence = {
  freshCount: 3,
  excludedByReason: {},
  hasNewOwnedPr: false,
  prStates: [],
  shardHash: "shard-a",
};

test("W1-T4678: the verifier returns one of its four outcomes from the evidence", () => {
  const cases: Array<{ name: string; evidence: StallEvidence; kind: "amend" | "retire" | "requeue" | "escalate" }> = [
    {
      name: "a merged PR the breaker's own scan missed",
      evidence: { ...baseEvidence, hasNewOwnedPr: true },
      kind: "amend",
    },
    {
      name: "every exclusion was an orphaned run, nothing fresh remains",
      evidence: { ...baseEvidence, freshCount: 0, excludedByReason: { orphaned_run: 4 } },
      kind: "requeue",
    },
    {
      name: "every attempt opened and closed a PR unmerged, nothing excluded",
      evidence: { ...baseEvidence, freshCount: 2, prStates: ["closed_unmerged"] },
      kind: "retire",
    },
    {
      name: "no cheap disposition applies",
      evidence: { ...baseEvidence, freshCount: 5, excludedByReason: { failed: 1 } },
      kind: "escalate",
    },
  ];
  const seen = new Set<string>();
  for (const c of cases) {
    const verdict = decideStallVerdict(c.evidence);
    assert.equal(verdict.kind, c.kind, `${c.name}: expected ${c.kind}, got ${verdict.kind}`);
    seen.add(verdict.kind);
  }
  // All four of design (i)'s outcomes are reachable from evidence alone, not just three of them.
  assert.deepEqual([...seen].sort(), ["amend", "escalate", "requeue", "retire"]);

  // escalate is the only outcome that names an owner — the "escalate with a named owner and the
  // reason" half of design (i).
  const escalateVerdict = decideStallVerdict(cases[3].evidence);
  assert.equal(escalateVerdict.kind, "escalate");
  if (escalateVerdict.kind === "escalate") {
    assert.ok(escalateVerdict.owner.length > 0);
    assert.ok(escalateVerdict.reason.length > 0);
  }
});

test("W1-T4678: an unchanged fingerprint is never verified twice", () => {
  withLedger("unchanged-fp", (ledgerPath) => {
    const first = verifyStalledTask("W1-STALL", baseEvidence, ctx(ledgerPath));
    assert.equal(first.alreadyVerified, false);

    // Same task, byte-identical evidence, called again (e.g. the next daemon tick before
    // anything about the task has changed): the SAME fingerprint must not re-verify.
    const second = verifyStalledTask("W1-STALL", baseEvidence, ctx(ledgerPath));
    assert.equal(second.alreadyVerified, true);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.deepEqual(second.verdict, first.verdict);

    const rows = readLedgerLines(ledgerPath).filter((l) => l.step === STALL_VERIFIED_STEP);
    assert.equal(rows.length, 1, "exactly one verified row for an unchanged fingerprint, never two");

    // A genuinely NEW fingerprint (the shard changed — an amended proof) DOES verify again:
    // "once per new fingerprint" is not "once per task, ever".
    const changed: StallEvidence = { ...baseEvidence, shardHash: "shard-b" };
    assert.notEqual(fingerprintStallEvidence(changed), fingerprintStallEvidence(baseEvidence));
    const third = verifyStalledTask("W1-STALL", changed, ctx(ledgerPath));
    assert.equal(third.alreadyVerified, false);
    const rowsAfter = readLedgerLines(ledgerPath).filter((l) => l.step === STALL_VERIFIED_STEP);
    assert.equal(rowsAfter.length, 2);
  });
});

test("W1-T4678: a different task with the same evidence is verified independently", () => {
  withLedger("cross-task", (ledgerPath) => {
    verifyStalledTask("W1-A", baseEvidence, ctx(ledgerPath));
    const other = verifyStalledTask("W1-B", baseEvidence, ctx(ledgerPath));
    assert.equal(other.alreadyVerified, false, "a sibling task's identical evidence is its own fingerprint row, not borrowed dedup");
  });
});

test("W1-T4678: the fingerprint is a pure function of the evidence, order-independent", () => {
  const a: StallEvidence = { ...baseEvidence, excludedByReason: { failed: 1, orphaned_run: 2 } };
  const b: StallEvidence = { ...baseEvidence, excludedByReason: { orphaned_run: 2, failed: 1 } };
  assert.equal(fingerprintStallEvidence(a), fingerprintStallEvidence(b));
});

test("W1-T4678: the shard fingerprint changes when the task's own acceptance proof is amended", () => {
  const before = stallShardFingerprint({ acceptance: [{ claim: "x", proof: "y" }], files: ["a.ts"] } as never);
  const after = stallShardFingerprint({ acceptance: [{ claim: "x", proof: "z" }], files: ["a.ts"] } as never);
  assert.notEqual(before, after);
});
