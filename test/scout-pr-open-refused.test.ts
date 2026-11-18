// W1-T10148: the scout flagged `pr.open_refused` as a recurring uncovered symptom. The step is the
// designed record of a refused PR open (not a defect): it must name the branch, head and refusal class so
// the refusal is attributable to a task rather than recurring anonymously.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EscalateDeps } from "#src/lib/escalate.js";
import { PrOpenRefusedError, recordRefusedPrOpen } from "#src/lib/pr-open.js";

test("W1-T10148: pr.open_refused no longer recurs", () => {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const url = recordRefusedPrOpen(
    new PrOpenRefusedError("branch-gap", "the branch has no commits ahead of main"),
    { taskId: "W1-T10148", branch: "run-W1-T10148-1", headSha: "abc123" },
    (step, extra) => rows.push({ step, extra }),
    {} as EscalateDeps,
  );
  assert.equal(url, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.step, "pr.open_refused");
  assert.equal(rows[0]?.extra?.branch, "run-W1-T10148-1");
  assert.equal(rows[0]?.extra?.head_sha, "abc123");
  assert.equal(rows[0]?.extra?.refusal_class, "branch-gap");
});
