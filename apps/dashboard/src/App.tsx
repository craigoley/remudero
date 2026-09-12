// apps/dashboard/src/App.tsx — the first screen on the new stack.
import { useMemo } from "react";
import type { DaemonClient } from "@remudero/api-client/client";

import { Now } from "./Now";
import { Overview } from "./Overview";
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

export const STATUS_BAR_BUDGETS = [
  { name: "laptop", viewportWidth: 1440, viewportHeight: 900, maxHeight: 96 },
  { name: "tablet", viewportWidth: 834, viewportHeight: 1112, maxHeight: 112 },
  { name: "phone", viewportWidth: 390, viewportHeight: 844, maxHeight: 132 },
] as const;

export function statusBarBudgetFor(width: number): (typeof STATUS_BAR_BUDGETS)[number] {
  if (width <= 480) return STATUS_BAR_BUDGETS[2];
  if (width <= 900) return STATUS_BAR_BUDGETS[1];
  return STATUS_BAR_BUDGETS[0];
}

const WORK_STATUS_ORDER = ["blocked", "fixing", "diagnosing", "review", "running", "prompted", "recon", "queued"] as const;

function statusPriority(status: string): number {
  const index = WORK_STATUS_ORDER.findIndex((s) => s === status);
  return index === -1 ? WORK_STATUS_ORDER.length : index;
}

export function App({ client, nowMs = Date.now }: { client: DaemonClient | null; nowMs?: () => number }) {
  const fleet = useFleet(client, nowMs);
  // useMemo is deliberate and rare here: the React Compiler memoises rendering, not this call's
  // dependency on a clock read that must NOT be taken again on every unrelated re-render.
  const view = useMemo(() => bucketSamples(fleet.changes, CHANGE_SERIES, nowMs()), [fleet.changes, nowMs]);
  const tasks = [...fleet.projections.values()].sort((a, b) => {
    const priority = statusPriority(a.status) - statusPriority(b.status);
    return priority === 0 ? a.taskId.localeCompare(b.taskId) : priority;
  });
  const attentionCount = tasks.filter((p) => p.status === "blocked").length;
  return (
    <>
      <header className="status-bar" data-max-phone-height={STATUS_BAR_BUDGETS[2].maxHeight}>
        <div className="status-bar__identity">
          <h1>Remudero</h1>
          {client === null ? (
            <p className="status-bar__unconfigured" role="status">
              Not configured — open with <code>?daemon=&lt;url&gt;&amp;token=&lt;token&gt;</code>
            </p>
          ) : (
            <p className="status-bar__stamp">{fleet.snapshot?.generated_at ?? "live stream only"}</p>
          )}
          {fleet.error === null ? null : (
            <p className="status-bar__error" role="alert">{`Read failed — ${fleet.error}`}</p>
          )}
        </div>
        <div className="status-bar__controls" role="group" aria-label="Fleet controls">
          <span className="write-state-badge" data-testid="write-state-badge">
            {client === null ? "Read-only until a daemon token is configured" : "Write actions use the configured token"}
          </span>
          <button type="button" disabled={client === null}>
            Pause
          </button>
          <button type="button" disabled={client === null}>
            Resume
          </button>
          <button type="button" disabled={client === null}>
            STOP
          </button>
        </div>
        {attentionCount > 0 ? (
          <p className="status-bar__anomaly" role="alert">{`${attentionCount} item${
            attentionCount === 1 ? "" : "s"
          } needs operator attention`}</p>
        ) : null}
      </header>
      <main className="app">
        <section className="work" aria-labelledby="work-h">
          <h2 id="work-h">Work</h2>
          {tasks.length === 0 ? (
            <p className="work__empty" role="status">
              ABSENT — no projection has been read yet
            </p>
          ) : (
            <table className="work__table">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Status</th>
                  <th scope="col">PR</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task, index) => (
                  <tr
                    data-before-scroll-y={STATUS_BAR_BUDGETS[0].maxHeight + 64}
                    data-first-actionable={index === 0 ? "true" : undefined}
                    data-testid={`work-row-${task.taskId}`}
                    key={task.taskId}
                  >
                    <td>{task.taskId}</td>
                    <td>{task.merged ? `${task.status} done` : task.status}</td>
                    <td>
                      {task.prUrl ? (
                        <a href={task.prUrl}>{task.prNumber === undefined ? task.prUrl : `#${task.prNumber}`}</a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <Overview projections={fleet.projections} generatedAt={fleet.snapshot?.generated_at ?? null} />
      <Now projections={fleet.projections} generatedAt={fleet.snapshot?.generated_at ?? null} />
      <Series view={view} />
      </main>
    </>
  );
}
