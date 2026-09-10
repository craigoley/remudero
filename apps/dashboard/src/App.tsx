// apps/dashboard/src/App.tsx — the first screen on the new stack.
import { useMemo } from "react";
import type { DaemonClient } from "@remudero/api-client/client";

import { Now } from "./Now";
import { Series } from "./SeriesChart";
import { bucketSamples, type SeriesSpec } from "./series";
import { useFleet } from "./useFleet";

/** THE BUCKET IS PART OF THE CLAIM (design (ii)). Two minutes over two hours, because the defect
 *  this series exists to surface is a sub-hourly repeat — a 2.5-minute dispatch loop — and an
 *  hourly or daily bucket sums it into one point and shows a flat line instead. */
export const CHANGE_SERIES: SeriesSpec = {
  label: "Fleet state changes",
  windowMs: 2 * 60 * 60 * 1000,
  bucketMs: 2 * 60 * 1000,
  unit: "changes",
};

export function App({ client, nowMs = Date.now }: { client: DaemonClient | null; nowMs?: () => number }) {
  const fleet = useFleet(client, nowMs);
  // useMemo is deliberate and rare here: the React Compiler memoises rendering, not this call's
  // dependency on a clock read that must NOT be taken again on every unrelated re-render.
  const view = useMemo(() => bucketSamples(fleet.changes, CHANGE_SERIES, nowMs()), [fleet.changes, nowMs]);
  return (
    <main className="app">
      <header className="app__head">
        <h1>Remudero</h1>
        {client === null ? (
          <p className="app__unconfigured" role="status">
            Not configured — open with <code>?daemon=&lt;url&gt;&amp;token=&lt;token&gt;</code>
          </p>
        ) : null}
        {fleet.error === null ? null : (
          <p className="app__error" role="alert">{`Read failed — ${fleet.error}`}</p>
        )}
      </header>
      <Now projections={fleet.projections} generatedAt={fleet.snapshot?.generated_at ?? null} />
      <Series view={view} />
    </main>
  );
}
