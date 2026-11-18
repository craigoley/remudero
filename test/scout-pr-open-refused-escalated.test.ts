// W1-T10149: the scout's uncovered recurring symptom, pr.open_refused.escalated.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { EscalateDeps } from "#src/lib/escalate.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { PrOpenRefusedError, recordRefusedPrOpen } from "#src/lib/pr-open.js";

const stale = () => new PrOpenRefusedError("stale-proof", "proof passes at the merge base", undefined, undefined, undefined,
  { proof: "unit test: W1-T10149: fixture", status: 0, detail: "ok" });

test("W1-T10149: pr.open_refused.escalated no longer recurs", (t: TestContext) => {
  const deps = { runId: "r", ledgerPath: join(ownedFixtureDir(t, "escalated-ledger").dir, "ledger.ndjson") } as unknown as EscalateDeps;
  // A refusal that only changed tests is satisfied by main: it retires the task and raises no escalation.
  const satisfied: string[] = [];
  const none = recordRefusedPrOpen(stale(),
    { taskId: "W1-T10149", branch: "run-W1-T10149-1", headSha: "abc", declaredFiles: ["src/x.ts"], changedFiles: ["test/x.test.ts"] },
    (step) => satisfied.push(step), deps);
  assert.equal(none, null);
  assert.ok(!satisfied.includes("pr.open_refused.escalated"), "a satisfied-by-main refusal is not escalated");

  // A stale proof with a source change escalates once; a failed raise is recorded as a null url, not thrown.
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const url = recordRefusedPrOpen(stale(),
    { taskId: "W1-T10149", branch: "run-W1-T10149-2", headSha: "def", declaredFiles: ["src/x.ts"], changedFiles: ["src/x.ts"] },
    (step, extra) => rows.push({ step, extra }), deps);
  assert.equal(url, null);
  const escalated = rows.filter((r) => r.step === "pr.open_refused.escalated");
  assert.equal(escalated.length, 1, "exactly one escalated row per refusal");
  assert.equal(escalated[0]?.extra?.branch, "run-W1-T10149-2");
  assert.equal(escalated[0]?.extra?.issue_url, null);
});
