// apps/dashboard/src/Now.tsx — NOW: what the fleet is doing, in operator-priority order.
//
// W1-T3177 design (v), carried from W1-T153 and not re-derived: operator-priority order, readable
// density, phone-first. The order below is not alphabetical and not the schema's — it is what an
// operator looks for first: things that need a person, then things in flight, then the rest.
import type { StatusProjection } from "@remudero/api-client/client";

/** Operator-priority order. `blocked` first because it is the only state that waits on a human. */
export const STATUS_ORDER = [
  "blocked",
  "fixing",
  "diagnosing",
  "review",
  "running",
  "prompted",
  "recon",
  "queued",
  "merged",
  "done",
] as const;

export function countByStatus(projections: ReadonlyMap<string, StatusProjection>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of projections.values()) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  return counts;
}

export function Now({ projections, generatedAt }: { projections: ReadonlyMap<string, StatusProjection>; generatedAt: string | null }) {
  const counts = countByStatus(projections);
  if (projections.size === 0) {
    return (
      <section className="now" aria-labelledby="now-h" data-testid="now-absent">
        <h2 id="now-h">Now</h2>
        <p role="status">ABSENT — no projection has been read yet</p>
      </section>
    );
  }
  return (
    <section className="now" aria-labelledby="now-h" data-testid="now">
      <h2 id="now-h">Now</h2>
      <p className="now__stamp">{generatedAt === null ? "live (stream only)" : `as of ${generatedAt}`}</p>
      <ul className="now__grid">
        {STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => (
          <li key={s} className={`now__cell now__cell--${s}`}>
            <span className="now__n">{counts.get(s)}</span>
            <span className="now__k">{s}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
