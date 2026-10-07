import { systemClock, type Clock } from "./clock.js";
import { readGardenerRuntime, type GardenerRuntimeSnapshot } from "./gardener-runtime.js";
import { sendJson } from "./panel-actions.js";
import type { Route } from "./service.js";

/** A bounded persisted projection, not a request-time scan of the historical ledger. Completion
 * is process transport only; attribution of improvements and spend remains explicitly absent. */
export function buildGardenersRoute(input: {
  stateDir: string;
  repository?: string;
  clock?: Clock;
  read?: (stateDir: string) => Promise<GardenerRuntimeSnapshot>;
}): Route {
  const clock = input.clock ?? systemClock;
  return { method: "GET", path: "/v1/gardeners", scope: "read", handler: async (_req, res) => {
    let snapshot: GardenerRuntimeSnapshot;
    try { snapshot = await (input.read ?? readGardenerRuntime)(input.stateDir); }
    catch (error) {
      const reason = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "not_collected" : "unreadable";
      sendJson(res, 503, { error: "gardeners_unavailable", reason });
      return;
    }
    if (input.repository && snapshot.repository.toLowerCase() !== input.repository.toLowerCase()) {
      sendJson(res, 503, { error: "gardeners_unavailable", reason: "repository_mismatch" });
      return;
    }
    const now = clock.now();
    if ([snapshot.configuredAt, snapshot.observedAt, ...snapshot.gardens.flatMap((garden) =>
        [garden.observedAt, garden.lastCompletedAt, garden.lastSuccessAt, garden.lastFailureAt].filter((stamp): stamp is string => stamp !== null))]
        .some((stamp) => Date.parse(stamp) > now + 60_000)) {
      sendJson(res, 503, { error: "gardeners_unavailable", reason: "clock_skew" });
      return;
    }
    sendJson(res, 200, { ...snapshot, generatedAt: clock.iso(),
      coverage: "registered-off-loop", counterWindow: "daemon-run", outcomeAssessment: "not_collected", spend: null });
  } };
}
