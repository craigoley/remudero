import assert from "node:assert/strict";
import { test } from "node:test";

import { acceptanceAuthorGateCommitTrailerLeaf, PR_WORKFLOW_PARITY_TABLE } from "#src/lib/ci-parity.js";
import type { PreflightSpawn } from "#src/lib/commit-message.js";

const SHA = "a".repeat(40);

function fakeSpawn(gateStatus: number, baseStatus = 0) {
  const calls: string[][] = [];
  const spawn: PreflightSpawn = (file, args) => {
    calls.push([file, ...args]);
    if (file === "git") return { status: baseStatus, stdout: baseStatus === 0 ? `${SHA}\n` : "", stderr: "" };
    return { status: gateStatus, stdout: "", stderr: gateStatus === 0 ? "" : "acceptance-author-gate: REFUSED (x)" };
  };
  return { spawn, calls };
}

test("W1-T9380: check:ci-log:acceptance-author-gate is prevented, not retried", () => {
  const entry = PR_WORKFLOW_PARITY_TABLE.find((e) => e.job === "acceptance-author-gate");
  assert.equal(entry?.mirrored, true);

  const ok = fakeSpawn(0);
  assert.equal(acceptanceAuthorGateCommitTrailerLeaf("/repo", ok.spawn).ok, true);
  const gate = ok.calls.find((c) => c.some((a) => a.endsWith("acceptance-author-gate.mjs")));
  assert.ok(gate?.includes("--commit-trailer-only"));

  const refused = acceptanceAuthorGateCommitTrailerLeaf("/repo", fakeSpawn(1).spawn);
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /REFUSED/);

  assert.throws(() => acceptanceAuthorGateCommitTrailerLeaf("/repo", fakeSpawn(0, 1).spawn), /origin\/main/);
});
