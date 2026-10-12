import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import type { CriterionVerdict } from "../src/lib/review.js";
import { buildOpenPrViews } from "../src/run-task.js";

const TASK = "W1-T5020";
const PR = "https://github.com/o/r/pull/77";

function reload(rows: Array<Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-unmet-roundtrip-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const recent = new Date().toISOString();
  try {
    for (const row of rows) {
      appendLedger(ledgerPath, {
        run_id: "roundtrip",
        task_id: TASK,
        step: "review.posted",
        pr_url: PR,
        state: "failure",
        ...row,
      });
    }
    const fetch = (args: string[]): unknown => {
      const path = args.at(-1) ?? "";
      if (/pulls\?state=open/.test(path)) return [{
        number: 77, html_url: PR, head: { ref: `run-${TASK}-1`, sha: "head" },
        updated_at: recent, body: `Remudero-Task: ${TASK}`, auto_merge: null, state: "open",
      }];
      if (/check-runs/.test(path)) return {
        check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }],
      };
      if (/commits\/.+\/status/.test(path)) return {
        statuses: [{ context: "remudero-review", state: "failure", created_at: recent }],
      };
      if (/\/pulls\/77$/.test(path)) return { mergeable: true, mergeable_state: "clean" };
      return [];
    };
    const [view] = buildOpenPrViews("o", "r", ledgerPath, {
      fetch,
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => ["ci-gate"],
      fetchCiFailureEvidence: () => [],
    });
    assert.ok(view);
    assert.equal(view.reviewState, "failure");
    return view.unmetCriteria;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function criterion(claim: string, proof_exec: CriterionVerdict["proof_exec"], met = false): CriterionVerdict {
  return { claim, proof: `unit test: ${claim}`, proof_exec, met, reason: `${claim} reason` };
}

test("W1-T5020: unmet review proof survives a ledger round trip", () => {
  const failed = criterion("failed proof", "executed_fail");
  const semantic = criterion("semantic unmet", "executed_pass");
  const refusal = { class: "premise-rotted", detail: "the original API is absent" } as const;
  failed.refusal = refusal;
  const restored = reload([{
    unmet_criteria: [semantic.claim, failed.claim],
    reasons: [semantic.reason, failed.reason],
    proof_exec: ["executed_pass", "executed_fail", "executed_pass"],
    decision_verdict: {
      criteria: [criterion("met control", "executed_pass", true), failed, semantic],
    },
  }]);
  assert.deepEqual(restored, [
    { ...semantic, refusal: undefined },
    failed,
  ]);
});

test("W1-T5020: missing legacy proof context stays unknown", () => {
  const legacy = { unmet_criteria: ["legacy"], reasons: ["legacy reason"] };
  for (const decision_verdict of [
    undefined, null, {}, { criteria: "malformed" },
    { criteria: [null, 42, { claim: "other", met: false, proof_exec: "executed_fail" }] },
    { criteria: [{ claim: "legacy", met: false }] },
  ]) {
    const [restored] = reload([{ ...legacy, decision_verdict }]);
    assert.equal(restored.claim, "legacy");
    assert.equal(restored.met, false);
    assert.equal(restored.reason, "legacy reason");
    assert.equal(restored.proof, "");
    assert.equal(restored.proof_exec, undefined);
  }
});

test("latest review replaces proof context and success clears unmet criteria", () => {
  const old = criterion("same claim", "executed_fail");
  const row = { unmet_criteria: [old.claim], reasons: [old.reason], decision_verdict: { criteria: [old] } };
  const fresh = { ...old, proof: "grep: fresh evidence in src/fresh.ts", proof_exec: "exec_error" };
  assert.equal(reload([row, { ...row, decision_verdict: { criteria: [fresh] } }])[0].proof, fresh.proof);
  assert.equal(reload([row, { ...row, decision_verdict: { criteria: [fresh] } }])[0].proof_exec, "exec_error");
  assert.equal(reload([row, { unmet_criteria: [old.claim], reasons: [old.reason] }])[0].proof_exec, undefined);
  assert.deepEqual(reload([row, { state: "success" }]), []);
  assert.deepEqual(reload([row, { state: "success" }, { unmet_criteria: [old.claim] }])[0], {
    claim: old.claim, proof: "", proof_exec: undefined, met: false, reason: "", refusal: undefined,
  });
});
