import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { classifyShadowDiff, legacyRowIndex, readShadowEvidence } from "#src/lib/view-shadow.js";

// Site, 2026-10-14: LIVE-EDITS-daemon-checkout's lastActivityAt read 01:52:47Z on legacy and 04:08:00Z on the view.
// The 04:08 row is live_edits.escalated, a non-fact step kept only as the run's run_activity row; the 21:18Z full
// rotation kept escalation.issue_opened (01:52) in the live file and pruned live_edits.escalated.
const TASK = "LIVE-EDITS-daemon-checkout";
const horizon = { ts: "2026-10-12T09:00:00.000Z", step: "daemon.boot", task_id: "daemon" };
const opened = { ts: "2026-10-13T01:52:47.104Z", step: "escalation.issue_opened", task_id: TASK, run_id: TASK };
const pruned = { ts: "2026-10-13T04:08:00.995Z", step: "live_edits.escalated", task_id: TASK, run_id: TASK };

test("W1-T9356: a pruned activity row explains a legacy diff", (t) => {
  const ledgerDir = makeTempDir("pruned-activity-ledger");
  const stateDir = makeTempDir("pruned-activity-state");
  const clock = fixedClock(Date.parse("2026-10-14T00:58:00.000Z"));
  writeFileSync(join(ledgerDir, "ledger.ndjson"), [horizon, opened, pruned].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const db = openProjectorReadModel(stateDir, "site", clock);
  t.after(() => { db.close(); rmSync(ledgerDir, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); });
  const got = acquireLease(db, { clock });
  if (!got.ok) throw new Error("lease");
  createLedgerProjector({ ledgerDir, db, lease: got.lease, clock }).tick();
  assert.deepEqual(db.prepare("SELECT ts FROM run_activity WHERE task_id = ?").all(TASK).map((r) => r.ts), [pruned.ts], "the pruned row is the run's activity row");

  const input = { ids: [TASK], legacyAsOfMs: clock.now(), viewAsOfMs: clock.now(), legacyHorizonMs: Date.parse(horizon.ts) };
  const diff = { path: `board.tasks[taskId=${TASK}].lastActivityAt`, legacy: opened.ts, view: pruned.ts, ids: [TASK] };
  const classify = (legacyRows?: Array<Record<string, unknown>>) =>
    classifyShadowDiff(diff, readShadowEvidence([db], { ...input, ...(legacyRows ? { legacyRows: legacyRowIndex(legacyRows) } : {}) }));

  const seen = classify([horizon, opened]);
  assert.equal(seen.classification, "legacy_horizon", seen.reason);
  assert.equal(classify([horizon, opened, pruned]).classification, "real", "a live file holding the activity row explains nothing");
  assert.equal(classify().classification, "real", "with no legacy rows the activity row explains nothing");
});
