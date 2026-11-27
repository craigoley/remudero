// W1-T15033: the cadence's proof-debt mint stamps a mechanical retirement only on an id the retirement guard accepts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type Proposal, updateProposalRegistry } from "#src/lib/inbox.js";
import { type InboxGardenerTaskFact, proofDebtPopulationPermit } from "#src/lib/inbox-retirement.js";
import { mintProofDebtProposals } from "#src/lib/measurement-cadence.js";
import type { ProofQueueAuditOffender } from "#src/lib/proof-queue-audit.js";

const fact = (id: string): InboxGardenerTaskFact => ({ id, title: `t ${id}`, repo: "remudero", verify: "auto", depends_on: [], acceptance: [] });
const offender = (taskId: string): ProofQueueAuditOffender =>
  ({ taskId, criterionIndex: 0, cause: "grep-path-absent", claim: "c", proof: "grep: nothing-here in src/x.ts" });

function withRegistry<T>(fn: (registryPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t15033-"));
  try {
    return fn(join(dir, "proposals.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readAll(registryPath: string): Proposal[] {
  let seen: Proposal[] = [];
  updateProposalRegistry(registryPath, (current) => {
    seen = current;
    return null;
  });
  return seen;
}

test("W1-T15033 criterion 1: a NEW-1a offender mints without a retirement and does not throw", () => {
  withRegistry((registryPath) => {
    const permit = proofDebtPopulationPermit([fact("NEW-1a"), fact("W1-T99001")]);
    const result = mintProofDebtProposals([offender("NEW-1a"), offender("W1-T99001")], (id) => `plan/tasks.d/${id}.yaml`,
      registryPath, { sourcePermit: permit });
    assert.deepEqual([...result.mintedProposalIds].sort(), ["proof-debt:NEW-1a", "proof-debt:W1-T99001"]);
    const byId = new Map(readAll(registryPath).map((p) => [p.id, p]));
    // The guard's id shape rejects NEW-1a, so it is an ordinary ask; a W1 id keeps its mechanical retirement.
    assert.equal(byId.get("proof-debt:NEW-1a")?.automaticRetirement, undefined);
    assert.equal(byId.get("proof-debt:W1-T99001")?.automaticRetirement?.taskId, "W1-T99001");
  });
});

test("W1-T15033 criterion 2: a foreign retirement still throws and names the id", () => {
  withRegistry((registryPath) => {
    const foreign = {
      id: "proof-debt:W1-T99002", summary: "s", evidenceAnchors: [{ description: "d", pattern: "p", path: "x" }],
      automaticRetirement: { producer: "proof-queue-audit-v1", kind: "mechanical-task", taskId: "W1-T99002",
        criteriaDigest: "a".repeat(64), proposalDigest: "b".repeat(64), taskDigest: "c".repeat(64) },
    } as unknown as Proposal;
    assert.throws(() => updateProposalRegistry(registryPath, (current) => [...current, foreign]),
      /requires the maintained proof-audit producer \(proposal proof-debt:W1-T99002\)/);
    assert.deepEqual(readAll(registryPath), []);
  });
});
