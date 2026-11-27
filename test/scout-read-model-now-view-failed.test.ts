import assert from "node:assert/strict";
import { test } from "node:test";
import { createNowView, NOW_FAILED_BACKOFF_CAP_MS, NOW_REFRESH_MS, NOW_VIEW_NAME, type NowViewContext } from "#src/lib/now-view.js";
import type { Plan } from "#src/lib/plan.js";
import type { ReadModelDb } from "#src/lib/read-model-db.js";

test("W1-T9519: read_model.now_view_failed no longer recurs", () => {
  const instance = { name: "core", ledgerDir: "/missing/fixture/state", planPath: "/fixture/plan/tasks.yaml" };
  const plan: Plan = { tasks: [], byId: new Map() };
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let now = Date.parse("2026-10-01T08:00:00.000Z");
  const view = createNowView({
    instances: [instance],
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() },
    readPlan: () => { throw new Error("stable plan read failure"); },
    log: (step, extra) => logged.push({ step, extra }),
  });
  const context = (): NowViewContext => ({
    now,
    switches: { views: { [NOW_VIEW_NAME]: "serve" } },
    instances: [{
      state: { instance: "core", generation: 0, lease: "held", failures: 0, newestTs: null },
      db: {} as ReadModelDb,
    }],
  });

  view.materialize(context());
  assert.equal(logged.filter((row) => row.step === "read_model.now_view_failed").length, 1);

  // Repeated reads across the trailing week retry the same underlying failure without emitting a row per retry.
  for (let elapsed = NOW_REFRESH_MS; elapsed <= 7 * 24 * 60 * 60 * 1_000; elapsed += NOW_FAILED_BACKOFF_CAP_MS) {
    now = Date.parse("2026-10-01T08:00:00.000Z") + elapsed;
    view.materialize(context());
  }

  assert.equal(logged.filter((row) => row.step === "read_model.now_view_failed").length, 1);
  assert.equal(logged[0]?.extra.error, "stable plan read failure");
});
