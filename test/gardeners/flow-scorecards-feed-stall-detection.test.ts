import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { FLOW_LADDER, ladderGardenSpec, type Inventory } from "#src/lib/flow-remedy-gardener.js";
import { runGardenerOverseer } from "#src/lib/gardener-overseer.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

test("production flow scorecards expose a growing cause to the overseer while total cost falls", t => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-prices-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now(), hour = 3_600_000, clock = fixedClock(now);
  const rows: Record<string, unknown>[] = [], logs: Record<string, unknown>[] = [];
  const escalations: string[] = [], observedCards: Record<string, unknown>[] = [];
  for (const [i, cost] of [2, 3, 4].entries()) {
    const inv: Inventory = { charges: [], episodes: [], candidates: [],
      priced: [{ key: "settled", hours: 100 - 10 * i, prs: 1, owners: [] },
        { key: "growing", hours: cost, prs: 1, owners: [] }],
      ladder: [{ cause: "settled", state: "resolved", rung: 1 }, { cause: "growing", state: "draft", rung: 1 }] };
    const spec = ladderGardenSpec({ repoRoot: dir, stateDir: dir, clock, log: () => {},
      openWorkspace: () => { throw new Error("no filing is requested"); } }, {
      kind: FLOW_LADDER, sources: { mintTaskId: () => { throw new Error("no task allocation is requested"); } },
      inventory: () => inv, onScorecard: (_inventory, card) => observedCards.push(card),
    });
    const card = spec.scorecard(spec.inventory(), { actions: [], acting: [] });
    rows.push({ ...card, step: "flow-remedy.scorecard", ts: new Date(now - (2 - i) * hour).toISOString(),
      actions: 0, acting: [], pr_url: null });
    assert.equal(card.total_pr_hours, 100 - 10 * i + cost);
    assert.equal(card.causes, 2);
    assert.equal(observedCards[i], card);
  }
  assert.ok(Number(rows[0]!.total_pr_hours) > Number(rows[2]!.total_pr_hours));
  const deps = { stateDir: dir, clock, readRows: () => rows, stateMtime: () => undefined,
    registeredGardenNames: () => ["flow-remedy"],
    log: (step: string, fields?: Record<string, unknown>) => logs.push({ step, ...fields }),
    escalate: (e: { detail: string }) => { escalations.push(e.detail); return "https://github.com/acme/remudero/issues/1"; } };
  runGardenerOverseer(deps);
  runGardenerOverseer(deps);
  const stalled = logs.filter(r => r.step === "gardener_overseer.stalled_cause");
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0]!.cause, "growing");
  assert.deepEqual(stalled[0]!.costs, [2, 3, 4]);
  assert.equal(stalled[0]!.unit, "hours");
  assert.deepEqual(stalled[0]!.settled_causes, ["settled"]);
  assert.equal(escalations.length, 1);
  assert.equal(logs.some(r => r.step === "gardener_overseer.stalled_unmeasured"), false);
});
