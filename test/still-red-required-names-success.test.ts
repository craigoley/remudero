import { test } from "node:test";
import assert from "node:assert/strict";
import { stillRedRequiredNames, type RollupCheckEntry } from "../src/lib/sweep.js";

const NAME = "acceptance-author-gate";

test("a red name whose fresh latest attempt already succeeded is dropped as superseded", () => {
  const rollup: RollupCheckEntry[] = [
    { name: NAME, state: "FAILURE", startedAt: "2026-09-29T12:12:59Z" },
    { name: NAME, state: "SUCCESS", startedAt: "2026-09-29T14:00:47Z" },
  ];
  assert.deepEqual(stillRedRequiredNames([NAME], rollup), []);
  assert.deepEqual(stillRedRequiredNames([NAME], [{ name: NAME, state: "SKIPPED", startedAt: "2026-09-29T14:00:47Z" }]), []);
});

test("a red name whose fresh latest attempt is a newer failure stays red", () => {
  const rollup: RollupCheckEntry[] = [
    { name: NAME, state: "SUCCESS", startedAt: "2026-09-29T12:12:59Z" },
    { name: NAME, state: "FAILURE", startedAt: "2026-09-29T14:00:47Z" },
  ];
  assert.deepEqual(stillRedRequiredNames([NAME], rollup), [NAME]);
  assert.deepEqual(stillRedRequiredNames([NAME], [{ name: NAME, state: "SUCCESS" }]), [NAME]);
});
