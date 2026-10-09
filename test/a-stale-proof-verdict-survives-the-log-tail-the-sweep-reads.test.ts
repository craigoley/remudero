// #10234 (2026-10-09): a run-branch PR's plan proof was a `unit test:` that passed at head AND base. The
// proof-discrimination gate printed its verdict header and `proof:` lines FIRST, then each proof's full
// check-proof output, then two advice lines. The sweep reads a failed step's last lines before the `##[error]`
// marker (CI_STEP_ERROR_CONTEXT_LINES in src/run-task.ts), so it saw only test output, found no stale proof,
// skipped the proof-amendment route and escalated to a person. The verdict now closes the log.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { proofDiscriminationEvidenceFromCheckLog } from "../src/lib/sweep.js";

// The failed-step extractor currently keeps eight lines before GitHub's error marker.
// Keep the regression at that narrow tail without importing the full run-task command module.
const STEP_TAIL_LINES = 8;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const gate = (await import(pathToFileURL(join(ROOT, "scripts", "proof-discrimination-gate.mjs")).href)) as {
  main: (argv: string[], deps: Record<string, unknown>) => number;
};

/** What the sweep keeps of a failed step: the lines just before GitHub's `##[error]` marker. */
function stepTail(lines: string[]): string {
  return lines.slice(-STEP_TAIL_LINES).join("\n");
}

function runGate(proofs: string[], outputLines: number): string[] {
  const lines: string[] = [];
  const sink = { log: (s: string) => lines.push(...String(s).split("\n")), error: (s: string) => lines.push(...String(s).split("\n")) };
  const code = gate.main(["--event-path", "event.json"], {
    readPayload: () => ({ readable: true, body: "body", baseSha: "base-tip", headSha: "head" }),
    mergeBase: () => ({ ok: true, mergeBase: "fork" }),
    resolveCriteria: () => ({ criteria: proofs.map((proof) => ({ proof })), source: "task acceptance" }),
    runProof: () => ({
      status: 5,
      stdout: ["hits: 22", "base hits: 22", ...Array.from({ length: outputLines }, (_, i) => `ok ${i + 1} - a passing test`)].join("\n"),
    }),
    baseline: () => ({}),
    log: sink,
  });
  assert.equal(code, 1);
  return lines;
}

test("a stale unit-test proof with long output is still named in the log tail the sweep reads", () => {
  const proof = "unit test: test/an-unfiled-prs-review-contract-has-a-sweep-side-producer.test.ts";
  const tail = stepTail(runGate([proof], 40));
  const evidence = proofDiscriminationEvidenceFromCheckLog([{ name: "proof-discrimination", logTail: tail }]);
  assert.deepEqual(evidence?.proofs.map((p) => p.proof), [proof], tail);
});

test("every stale proof is named in the tail when there are several", () => {
  const proofs = ["unit test: alpha passes", "grep: beta in src/x.ts", "unit test: gamma passes"];
  const tail = stepTail(runGate(proofs, 30));
  const evidence = proofDiscriminationEvidenceFromCheckLog([{ name: "proof-discrimination", logTail: tail }]);
  assert.deepEqual(evidence?.proofs.map((p) => p.proof), proofs, tail);
});
