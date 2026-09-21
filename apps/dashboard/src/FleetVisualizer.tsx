import { useState } from "react";
import type { StatusProjection } from "@remudero/api-client/client";

type FleetFilter = "all" | "active" | "attention" | "quiet";
type WorkerKind = "active" | "attention" | "quiet" | "review";

export interface FleetWorker {
  readonly projection: StatusProjection;
  readonly kind: WorkerKind;
  readonly label: string;
  readonly detail: string;
}

export interface FleetNode extends FleetWorker {
  readonly x: number;
  readonly y: number;
  readonly compact: boolean;
}

const MAP_WIDTH = 960;
const MAP_HEIGHT = 500;
const CENTER_X = MAP_WIDTH / 2;
const CENTER_Y = MAP_HEIGHT / 2;
const ORBIT_COUNTS = [8, 12, 16, 20] as const;

const STATUS_LABELS: Record<WorkerKind, string> = {
  active: "working",
  attention: "needs attention",
  quiet: "quiet",
  review: "review lane",
};

const FILTER_LABELS: Record<FleetFilter, string> = {
  all: "All signals",
  active: "Working",
  attention: "Needs attention",
  quiet: "Quiet",
};

function isLiveSignal(projection: StatusProjection): boolean {
  return (
    projection.phase !== undefined ||
    projection.status === "running" ||
    projection.status === "review" ||
    projection.status === "fixing" ||
    projection.status === "diagnosing" ||
    projection.status === "recon" ||
    projection.needsHuman === true ||
    projection.orphaned === true
  );
}

function workerKind(projection: StatusProjection): WorkerKind {
  if (projection.needsHuman === true || projection.orphaned === true || projection.status === "blocked") {
    return "attention";
  }
  if (projection.workerState === "quiet") return "quiet";
  if (projection.phase === "review" || projection.status === "review") return "review";
  return "active";
}

function phaseLabel(projection: StatusProjection): string {
  if (projection.workerState === "tool-executing") return "executing a tool";
  if (projection.workerState === "working") return "working";
  if (projection.workerState === "quiet") return "quiet — inspect";
  if (projection.phase !== undefined) return `${projection.phase} phase`;
  if (projection.status === "blocked") return "blocked";
  return projection.status;
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "age unknown";
  const totalSeconds = Math.floor(milliseconds / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function fleetWorkers(projections: ReadonlyMap<string, StatusProjection>): FleetWorker[] {
  return [...projections.values()]
    .filter((projection) => !projection.merged && isLiveSignal(projection))
    .map((projection) => {
      const kind = workerKind(projection);
      return {
        projection,
        kind,
        label: STATUS_LABELS[kind],
        detail: phaseLabel(projection),
      };
    })
    .sort((a, b) => {
      const priority = { attention: 0, quiet: 1, active: 2, review: 3 } as const;
      return priority[a.kind] - priority[b.kind] || a.projection.taskId.localeCompare(b.projection.taskId);
    });
}

export function fleetNodes(workers: readonly FleetWorker[]): FleetNode[] {
  return workers.map((worker, index) => {
    let offset = 0;
    let ring = 0;
    while (ring < ORBIT_COUNTS.length - 1 && index >= offset + ORBIT_COUNTS[ring]) {
      offset += ORBIT_COUNTS[ring];
      ring += 1;
    }
    const count = ORBIT_COUNTS[ring];
    const position = index - offset;
    const angle = -Math.PI / 2 + (position / count) * Math.PI * 2;
    const radius = 142 + ring * 58;
    return {
      ...worker,
      x: CENTER_X + Math.cos(angle) * radius,
      y: CENTER_Y + Math.sin(angle) * radius,
      compact: workers.length > 12,
    };
  });
}

function filterWorkers(workers: readonly FleetWorker[], filter: FleetFilter): FleetWorker[] {
  if (filter === "all") return [...workers];
  if (filter === "active") return workers.filter((worker) => worker.kind === "active" || worker.kind === "review");
  return workers.filter((worker) => worker.kind === filter);
}

function nodeClass(worker: FleetWorker): string {
  return `fleet-node fleet-node--${worker.kind}${worker.projection.processUnevidenced ? " fleet-node--unverified" : ""}`;
}

function nodeAriaLabel(worker: FleetWorker): string {
  const projection = worker.projection;
  const evidence = projection.processUnevidenced ? "; process evidence unavailable" : "";
  return `${projection.taskId}, ${worker.detail}, ${formatDuration(projection.elapsedMs)}${evidence}`;
}

function sourceLabel(projection: StatusProjection): string {
  if (projection.processUnevidenced) return "open PR evidence only";
  if (projection.source === "throttled") return "GitHub read throttled";
  if (projection.source === "none") return "no merge evidence";
  return `${projection.source} projection`;
}

function WorkerDetail({ worker }: { worker: FleetWorker | undefined }) {
  if (worker === undefined) {
    return (
      <div className="fleet-detail fleet-detail--empty" data-testid="fleet-detail-empty">
        <span className="fleet-detail__eyebrow">Select a signal</span>
        <p>Choose a worker node to inspect its live evidence.</p>
      </div>
    );
  }
  const { projection } = worker;
  return (
    <div className={`fleet-detail fleet-detail--${worker.kind}`} data-testid="fleet-detail">
      <div className="fleet-detail__heading">
        <div>
          <span className="fleet-detail__eyebrow">Selected worker signal</span>
          <h3>{projection.taskId}</h3>
        </div>
        <span className={`fleet-pill fleet-pill--${worker.kind}`}>{worker.label}</span>
      </div>
      <p className="fleet-detail__phase">{worker.detail}</p>
      <dl className="fleet-detail__metrics">
        <div><dt>age</dt><dd>{formatDuration(projection.elapsedMs)}</dd></div>
        <div><dt>state</dt><dd>{projection.workerState ?? "unknown"}</dd></div>
        <div><dt>turns</dt><dd>{projection.liveTurns ?? "—"}</dd></div>
        <div><dt>spend</dt><dd>{projection.liveSpendUsd === undefined ? "—" : `$${projection.liveSpendUsd.toFixed(2)}`}</dd></div>
      </dl>
      <p className="fleet-detail__evidence">Evidence: {sourceLabel(projection)}</p>
      {projection.prUrl ? (
        <a className="fleet-detail__link" href={projection.prUrl} target="_blank" rel="noreferrer">
          Open {projection.prNumber === undefined ? "pull request" : `PR #${projection.prNumber}`} ↗
        </a>
      ) : null}
    </div>
  );
}

export function FleetVisualizer({
  projections,
  generatedAt,
}: {
  readonly projections: ReadonlyMap<string, StatusProjection>;
  readonly generatedAt: string | null;
}) {
  const [filter, setFilter] = useState<FleetFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const allWorkers = fleetWorkers(projections);
  const visibleWorkers = filterWorkers(allWorkers, filter);
  const nodes = fleetNodes(visibleWorkers);
  const selected = visibleWorkers.find((worker) => worker.projection.taskId === selectedId) ?? visibleWorkers[0];
  const queuedCount = [...projections.values()].filter((projection) => !projection.merged && projection.status === "queued").length;
  const attentionCount = allWorkers.filter((worker) => worker.kind === "attention").length;
  const activeCount = allWorkers.filter((worker) => worker.kind === "active" || worker.kind === "review").length;
  const asOf = generatedAt === null ? "stream-only" : new Date(generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <section className="fleet-visualizer" aria-labelledby="fleet-visualizer-h" data-testid="fleet-visualizer">
      <div className="fleet-visualizer__heading">
        <div>
          <p className="eyebrow">Live topology · {asOf}</p>
          <h2 id="fleet-visualizer-h">Fleet visualizer</h2>
          <p className="fleet-visualizer__lede">A task-backed map of the workers the daemon can currently evidence.</p>
        </div>
        <div className="fleet-pulse" aria-label={`${activeCount} active workers, ${attentionCount} need attention`}>
          <span className="fleet-pulse__dot" aria-hidden="true" />
          <span><strong>{activeCount}</strong> working</span>
          <span className="fleet-pulse__divider" aria-hidden="true">/</span>
          <span><strong>{attentionCount}</strong> attention</span>
        </div>
      </div>

      <div className="fleet-toolbar" role="toolbar" aria-label="Fleet visualizer filters">
        <div className="fleet-filters" role="group" aria-label="Filter worker signals">
          {(Object.keys(FILTER_LABELS) as FleetFilter[]).map((key) => (
            <button
              className={filter === key ? "fleet-filter fleet-filter--selected" : "fleet-filter"}
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {FILTER_LABELS[key]}
              <span className="fleet-filter__count">
                {key === "all" ? allWorkers.length : key === "active" ? activeCount : key === "attention" ? attentionCount : allWorkers.filter((worker) => worker.kind === "quiet").length}
              </span>
            </button>
          ))}
        </div>
        <span className="fleet-queue">{queuedCount} queued outside map</span>
      </div>

      {allWorkers.length === 0 ? (
        <div className="fleet-empty" role="status">
          <span className="fleet-empty__glyph" aria-hidden="true">✦</span>
          <div><strong>Quiet fleet</strong><p>No active or attention-bearing worker signal has been observed yet.</p></div>
        </div>
      ) : (
        <div className="fleet-visualizer__body">
          <div className="fleet-map-shell">
            <svg
              className="fleet-map"
              viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
              role="img"
              aria-labelledby="fleet-map-title fleet-map-desc"
            >
              <title id="fleet-map-title">Current Remudero worker topology</title>
              <desc id="fleet-map-desc">The daemon sits at the center. Each orbiting node is one task-backed worker signal; node color and label describe its current evidence.</desc>
              <defs>
                <radialGradient id="fleet-core-glow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                </radialGradient>
                <filter id="fleet-soft-glow" x="-80%" y="-80%" width="260%" height="260%">
                  <feGaussianBlur stdDeviation="5" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              {[0, 1, 2].map((ring) => (
                <circle className="fleet-orbit" cx={CENTER_X} cy={CENTER_Y} r={142 + ring * 58} key={ring} />
              ))}
              {nodes.map((node) => (
                <line className={`fleet-edge fleet-edge--${node.kind}`} x1={CENTER_X} x2={node.x} y1={CENTER_Y} y2={node.y} key={`edge-${node.projection.taskId}`} />
              ))}
              <circle className="fleet-core-glow" cx={CENTER_X} cy={CENTER_Y} r="112" fill="url(#fleet-core-glow)" />
              <circle className="fleet-core" cx={CENTER_X} cy={CENTER_Y} r="66" filter="url(#fleet-soft-glow)" />
              <text className="fleet-core__label" x={CENTER_X} y={CENTER_Y - 8} textAnchor="middle">DAEMON</text>
              <text className="fleet-core__sub" x={CENTER_X} y={CENTER_Y + 13} textAnchor="middle">{allWorkers.length} signals</text>
              {nodes.map((node) => {
                const selectedNode = selected?.projection.taskId === node.projection.taskId;
                return (
                  <g
                    className={`${nodeClass(node)}${selectedNode ? " fleet-node--selected" : ""}`}
                    key={node.projection.taskId}
                    role="button"
                    tabIndex={0}
                    aria-label={nodeAriaLabel(node)}
                    aria-pressed={selectedNode}
                    onClick={() => setSelectedId(node.projection.taskId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(node.projection.taskId);
                      }
                    }}
                  >
                    {node.compact ? (
                      <circle cx={node.x} cy={node.y} r="17" />
                    ) : (
                      <rect x={node.x - 58} y={node.y - 23} width="116" height="46" rx="10" />
                    )}
                    {!node.compact ? (
                      <>
                        <text className="fleet-node__task" x={node.x} y={node.y - 3} textAnchor="middle">{node.projection.taskId}</text>
                        <text className="fleet-node__state" x={node.x} y={node.y + 13} textAnchor="middle">{node.detail}</text>
                      </>
                    ) : <text className="fleet-node__compact" x={node.x} y={node.y + 4} textAnchor="middle">{node.projection.taskId.slice(-2)}</text>}
                    <title>{nodeAriaLabel(node)}</title>
                  </g>
                );
              })}
            </svg>
            {visibleWorkers.length === 0 ? <p className="fleet-map__empty">No signals match this filter.</p> : null}
          </div>
          <aside className="fleet-sidecar" aria-label="Selected worker details">
            <WorkerDetail worker={selected} />
            <div className="fleet-index">
              <div className="fleet-index__heading"><span>Worker index</span><span>{visibleWorkers.length}</span></div>
              <ul>
                {visibleWorkers.map((worker) => (
                  <li key={worker.projection.taskId}>
                    <button
                      className={selected?.projection.taskId === worker.projection.taskId ? "fleet-index__button fleet-index__button--selected" : "fleet-index__button"}
                      type="button"
                      onClick={() => setSelectedId(worker.projection.taskId)}
                    >
                      <span className={`fleet-index__marker fleet-index__marker--${worker.kind}`} aria-hidden="true" />
                      <span><strong>{worker.projection.taskId}</strong><small>{worker.detail}</small></span>
                      <span className="fleet-index__age">{formatDuration(worker.projection.elapsedMs)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      )}
      <div className="fleet-legend" aria-label="Fleet visualizer legend">
        <span><i className="fleet-legend__swatch fleet-legend__swatch--active" /> working</span>
        <span><i className="fleet-legend__swatch fleet-legend__swatch--review" /> review</span>
        <span><i className="fleet-legend__swatch fleet-legend__swatch--quiet" /> quiet</span>
        <span><i className="fleet-legend__swatch fleet-legend__swatch--attention" /> attention</span>
        <span className="fleet-legend__note">signal identity = task id · no PID claim</span>
      </div>
    </section>
  );
}
