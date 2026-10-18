// `rmd approve <task-id>` read its plan from `config.root`, a STATE root that holds no
// plan/tasks.yaml in production (the core container's config.root is /home/node/Remudero), so every
// parked-task release died with ENOENT. The plan is the checkout's own, the same one the proposal
// path reads; a test that wants a fixture plan passes it as `planPath`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { RELEASE_LEDGER_STEP } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { approveCommand } from "#src/run-task.js";

const PARKED = ["- id: W1-T1041", "  title: a parked shard", "  repo: remudero", "  type: implement", "  verify: human", "  status: queued", "  depends_on: []"].join("\n");

test("rmd approve releases a parked task from the checkout plan when the state root holds no plan", async () => {
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}approve-state-`));
  const checkout = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}approve-checkout-`));
  try {
    mkdirSync(join(state, "state"), { recursive: true });
    mkdirSync(join(checkout, "plan"), { recursive: true });
    writeFileSync(join(checkout, "plan", "tasks.yaml"), PARKED);
    const code = await approveCommand(["W1-T1041"], { config: { root: state } as never, planPath: join(checkout, "plan", "tasks.yaml") });
    assert.equal(code, 0, "the release reads the checkout's plan, not the state root");
    const rows = readFileSync(ledgerPathFor({ root: state } as never), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.step === RELEASE_LEDGER_STEP && r.task_id === "W1-T1041");
    assert.equal(rows.length, 1, "exactly one release row, in the state root's ledger");
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("rmd approve with no planPath reads the repo checkout's plan, never the state root", async () => {
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}approve-default-`));
  try {
    mkdirSync(join(state, "state"), { recursive: true });
    // No plan under the state root, as in production. An id absent from the repo's plan is refused as
    // a task (exit 2) instead of crashing on a missing state-root plan.
    const code = await approveCommand(["W1-T99999"], { config: { root: state } as never });
    assert.equal(code, 2);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
