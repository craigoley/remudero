// apps/dashboard/src/useFleet.ts — the one read hook. Both shapes the console needs, from one place.
//
// W1-T3177 design (i): the screen is "NOW + one series" because those are the two read shapes, and a
// screen that only polls proves half the stack. NOW comes from GET /v1/status; the series is built
// from the SSE stream, because every projection change arrives stamped and a change-rate over time
// is exactly the bounded series design (ii) asks for. There is no historical series ENDPOINT and
// this task does not invent one — an undocumented route is the debt W1-T3174 measures.
import { useEffect, useState } from "react";
import type { StatusProjection, StatusSnapshot, DaemonClient } from "@remudero/api-client/client";

import type { SeriesSample } from "./series";

export interface FleetState {
  readonly snapshot: StatusSnapshot | null;
  /** Live projections, keyed by task id, snapshot first and then overwritten by stream events. */
  readonly projections: ReadonlyMap<string, StatusProjection>;
  /** One sample per observed change. `null` until the first read resolves — ABSENT, not empty. */
  readonly changes: readonly SeriesSample[] | null;
  readonly error: string | null;
}

export const EMPTY_FLEET: FleetState = { snapshot: null, projections: new Map(), changes: null, error: null };

/** Folded OUTSIDE React so it is testable without mounting: the reducer for one stream event. */
export function applyProjection(state: FleetState, projection: StatusProjection, atMs: number): FleetState {
  const projections = new Map(state.projections);
  projections.set(projection.taskId, projection);
  return {
    ...state,
    projections,
    changes: [...(state.changes ?? []), { at: atMs, value: 1 }],
  };
}

export function applySnapshot(state: FleetState, snapshot: StatusSnapshot): FleetState {
  const projections = new Map(state.projections);
  for (const p of snapshot.tasks) projections.set(p.taskId, p);
  // The snapshot establishes that we are now watching: an empty change list is "observed nothing",
  // which the series contract renders differently from `null` ("could not read").
  return { ...state, snapshot, projections, changes: state.changes ?? [] };
}

export function useFleet(client: DaemonClient | null, nowMs: () => number = Date.now): FleetState {
  const [state, setState] = useState<FleetState>(EMPTY_FLEET);
  useEffect(() => {
    if (client === null) return;
    let live = true;
    client
      .getStatus()
      .then((snapshot) => {
        if (live) setState((s) => applySnapshot(s, snapshot));
      })
      .catch((err: unknown) => {
        // A FAILED READ IS NOT AN EMPTY ONE. `changes` stays null, so the series renders ABSENT
        // rather than a flat zero line claiming the fleet was quiet.
        if (live) setState((s) => ({ ...s, error: String((err as Error)?.message ?? err) }));
      });
    const unsubscribe = client.subscribeStatus((projection) => {
      if (live) setState((s) => applyProjection(s, projection, nowMs()));
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client, nowMs]);
  return state;
}
