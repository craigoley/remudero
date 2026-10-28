import assert from "node:assert/strict";
import { test } from "node:test";

import { ciFrictionHandFixRounds } from "#src/lib/ci-friction-gardener.js";

const rounds = [{ pr: 1, at: "2026-10-01T10:00:00Z", cause: { kind: "check" as const, name: "coverage-ratchet" }, minutes: 4 }];
const search = { filesContaining: () => [], fileExists: () => true };
const fixes = (file: string) => [
  { pr: 9, at: "2026-10-02T10:00:00Z", files: [file] },
  { pr: 10, at: "2026-10-02T11:00:00Z", files: [file] },
];

test("W1-T10666: check:test:test/a-ci-friction-draft-passes-lint-plan-admission.test.ts is prevented, not retried", () => {
  for (const own of ["src/lib/ci-friction-gardener.ts", "src/lib/ci-friction-remedy.ts"]) {
    assert.deepEqual(ciFrictionHandFixRounds(fixes(own), rounds, [], search), [], `${own}: the gardener's own development is not friction`);
  }
  const other = ciFrictionHandFixRounds(fixes("src/worker.ts"), rounds, [], search);
  assert.equal(other.length, 2, "any other repeatedly hand-fixed file is still evidence");
});
