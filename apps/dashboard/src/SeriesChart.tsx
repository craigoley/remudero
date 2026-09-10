// apps/dashboard/src/SeriesChart.tsx — the series renderer.
//
// NOT `Series.tsx`, and this is not a style choice. `series.ts` (the contract) sits beside it, and a
// pair differing only by CASE resolves differently per filesystem: on macOS (case-insensitive)
// `../Series` loaded series.ts, so every render test failed with "Element type is invalid ... got:
// undefined", while Linux CI would have resolved it the other way and passed. A case-only
// difference between two real modules is a portability bug wearing a naming convention. The CONTRACT is in series.ts; this file only
// shows what that module already decided, which is what lets the contract survive a renderer swap.
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { describeSpec, type SeriesView } from "./series";

/** A chart is not readable by a screen reader, and a canvas of pixels is not evidence in a test
 *  either. The visually-hidden table is the accessible alternative to the plot AND the thing an
 *  assertion can count: if the bucketing averaged a spike away, this table says so in text. */
function SeriesTable({ view }: { view: Extract<SeriesView, { kind: "present" }> }) {
  return (
    <table className="visually-hidden" data-testid="series-table">
      <caption>{`${view.spec.label} — ${view.specLabel}`}</caption>
      <thead>
        <tr>
          <th scope="col">bucket start</th>
          <th scope="col">{view.spec.unit}</th>
        </tr>
      </thead>
      <tbody>
        {view.buckets.map((b) => (
          <tr key={b.startMs}>
            <td>{new Date(b.startMs).toISOString()}</td>
            <td data-value={b.value === null ? "absent" : String(b.value)}>
              {b.value === null ? "absent" : b.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Series({ view, width = 560, height = 180 }: { view: SeriesView; width?: number; height?: number }) {
  if (view.kind === "absent") {
    // ABSENT IS RENDERED AS ABSENT (property 2). No axes, no baseline, no zero — a chart frame with
    // a flat line at the bottom is precisely the lie this branch exists to avoid.
    return (
      <figure className="series series--absent" data-testid="series-absent">
        <figcaption>
          <span className="series__label">{view.spec.label}</span>
          <span className="series__spec">{describeSpec(view.spec)}</span>
        </figcaption>
        <p className="series__absent-reason" role="status">
          {`ABSENT — ${view.reason}`}
        </p>
      </figure>
    );
  }
  // Recharts skips a null `y`, so an unobserved bucket leaves a GAP rather than touching zero.
  const data = view.buckets.map((b) => ({ t: b.startMs, v: b.value }));
  return (
    <figure className="series" data-testid="series-present">
      <figcaption>
        <span className="series__label">{view.spec.label}</span>
        <span className="series__spec">{view.specLabel}</span>
      </figcaption>
      <LineChart width={width} height={height} data={data} accessibilityLayer>
        <CartesianGrid strokeDasharray="2 4" stroke="var(--grid)" />
        <XAxis
          dataKey="t"
          tickFormatter={(t: number) => new Date(t).toISOString().slice(11, 16)}
          stroke="var(--fg-dim)"
          fontSize={11}
        />
        <YAxis stroke="var(--fg-dim)" fontSize={11} allowDecimals={false} width={32} />
        <Line type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls={false} />
      </LineChart>
      <SeriesTable view={view} />
    </figure>
  );
}
