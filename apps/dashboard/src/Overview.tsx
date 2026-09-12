import type { StatusProjection } from "@remudero/api-client/client";

export interface OverviewCounter {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly source: string;
}

function countStatus(projections: readonly StatusProjection[], status: StatusProjection["status"]): number {
  return projections.filter((p) => p.status === status).length;
}

export function overviewCounters(projections: ReadonlyMap<string, StatusProjection>, generatedAt: string | null): OverviewCounter[] {
  const tasks = [...projections.values()];
  const stamp = generatedAt === null ? "live stream only" : `/v1/status generated_at ${generatedAt}`;
  const blocked = countStatus(tasks, "blocked");
  return [
    {
      key: "running",
      label: "running",
      value: String(countStatus(tasks, "running")),
      source: `source: status == running from ${stamp}`,
    },
    {
      key: "needs-me",
      label: "needs me",
      value: String(blocked),
      source: `source: status == blocked from ${stamp}`,
    },
    {
      key: "blocked",
      label: "blocked",
      value: String(blocked),
      source: `source: status == blocked from ${stamp}`,
    },
    {
      key: "queued",
      label: "queued",
      value: String(countStatus(tasks, "queued")),
      source: `source: status == queued from ${stamp}`,
    },
    {
      key: "merged-today",
      label: "merged today",
      value: String(tasks.filter((p) => p.status === "merged" || p.status === "done").length),
      source: `source: merged/done projection count from ${stamp}; day window not exposed yet`,
    },
    {
      key: "spend-today",
      label: "spend today",
      value: "—",
      source: "source: not exposed by /v1/status yet",
    },
    {
      key: "spend-week",
      label: "spend this week",
      value: "—",
      source: "source: not exposed by /v1/status yet",
    },
  ];
}

export function Overview({
  projections,
  generatedAt,
}: {
  projections: ReadonlyMap<string, StatusProjection>;
  generatedAt: string | null;
}) {
  return (
    <section className="overview" aria-labelledby="overview-h">
      <h2 id="overview-h">Overview</h2>
      <ul className="overview__grid">
        {overviewCounters(projections, generatedAt).map((counter) => (
          <li className="overview__counter" data-testid={`overview-counter-${counter.key}`} key={counter.key}>
            <span className="overview__value">{counter.value}</span>
            <span className="overview__label">{counter.label}</span>
            <span className="overview__source">{counter.source}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
