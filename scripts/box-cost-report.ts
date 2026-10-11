/**
 * Box cost report (W1-T6266): the one read-only instrument that ranks what serve costs the box, so a
 * change's before and after are measured the same way.
 *
 *   node --import tsx scripts/box-cost-report.ts --state-dir <dir> --since <iso> --until <iso>
 *   node --import tsx scripts/box-cost-report.ts --state-dir <dir> --since <iso> --until <iso>
 *     --compare-since <iso> --compare-until <iso>     (first window = before, second = after; prints deltas)
 *
 * It reads the ledger union (every archive plus the live file) and prints ONE JSON object of aggregates:
 * counts, milliseconds, MiB, step names and the view, stage, holder, thread and lane names; short shas. It never
 * prints a row body, a path, or any other field value. Every aggregate carries its `positiveControl`: the
 * row count of a step known to be present in the same window, so a zero is never read as a measurement.
 * An unread archive, a missed live file or a control that reads zero REFUSES the run (exit 2) instead of
 * reporting a partial window.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ledgerLivePath, openLedgerUnion } from "../src/lib/ledger-union.js";

/** Rows of this step are written every sample interval while serve runs: the step whose absence means a bad read. */
export const POSITIVE_CONTROL_STEP = "serve.memory";
export const SLOW_VIEW_STEP = "read_model.slow_view";
export const WORKSTREAMS_BUILT_STEP = "workstreams.built";
export const MEMO_RETENTION_STEP = "read_model.memo_retention";
export const PLAN_PIN_ADOPTED_STEP = "serve.plan_pin_adopted";
export const SERVE_MEMORY_STEP = "serve.memory";
export const HANDOFF_DONE_STEP = "serve.handoff_done";

const MIB = 1024 * 1024;
const COST_STEPS = [SLOW_VIEW_STEP, WORKSTREAMS_BUILT_STEP, MEMO_RETENTION_STEP, PLAN_PIN_ADOPTED_STEP, SERVE_MEMORY_STEP, HANDOFF_DONE_STEP];

export interface ReportWindow { since: string; until: string }
export interface PositiveControl { step: string; rows: number }

export interface BoxCostReport {
  window: ReportWindow & { hours: number };
  positiveControl: PositiveControl;
  rowsRead: number;
  slowView: Section<{ views: Record<string, { count: number; totalMs: number; maxMs: number; stages: Record<string, { count: number; totalMs: number }> }> }>;
  workstreamsBuilt: Section<{ perHour: Record<string, { builds: number; instances: number; reused: number; derived: number }> }>;
  memoRetention: Section<{ holders: Record<string, { reports: number; maxArchives: number; maxRows: number; maxTornRows: number; maxFailedArchives: number }> }>;
  planPinAdopted: Section<{ adoptions: number; parseMsTotal: number; parseMsMax: number; parsedBlobs: number; reusedBlobs: number }>;
  serveMemory: Section<{ samples: number; rssMiB: Stat; heapUsedMiB: Stat; unattributedMiB: Stat }>;
  handoffDone: Section<{ handoffs: number; prepMsTotal: number; readyMsTotal: number; drainMsTotal: number; peakMiBMax: number; toShas: string[] }>;
}
type Section<T> = T & { positiveControl: PositiveControl };
interface Stat { max: number; mean: number }

/** Why a run was refused: fixed reason names and counts only. */
export class BoxCostRefusal extends Error {
  constructor(readonly reasons: readonly string[], readonly counts: Readonly<Record<string, number>>) {
    super(`box cost report refused: ${reasons.join(", ")}`);
    this.name = "BoxCostRefusal";
  }
}

/** A name safe to print: a short identifier, never free text. */
export function safeName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:@/-]{1,80}$/.test(value) ? value : "(unnamed)";
}
function shortSha(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/.test(value) ? value.slice(0, 7) : undefined;
}
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
const round = (value: number): number => Math.round(value * 10) / 10;

function stat(values: number[]): Stat {
  if (values.length === 0) return { max: 0, mean: 0 };
  return { max: round(Math.max(...values)), mean: round(values.reduce((a, b) => a + b, 0) / values.length) };
}

function windowMs(window: ReportWindow): { from: number; to: number } {
  const from = Date.parse(window.since);
  const to = Date.parse(window.until);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new BoxCostRefusal(["window-invalid"], {});
  }
  return { from, to };
}

/** Read one window of the ledger union and aggregate it. Refuses rather than reporting a partial or unmeasured window. */
export async function buildBoxCostReport(stateDir: string, window: ReportWindow, controlStep: string = POSITIVE_CONTROL_STEP): Promise<BoxCostReport> {
  const { from, to } = windowMs(window);
  const counts = { unreadArchives: 0, unreadLive: 0, controlRows: 0 };
  const reasons: string[] = [];
  if (!existsSync(ledgerLivePath(stateDir))) {
    reasons.push("live-ledger-missing");
  }
  const slow = new Map<string, { count: number; totalMs: number; maxMs: number; stages: Map<string, { count: number; totalMs: number }> }>();
  const built = new Map<string, { builds: number; instances: number; reused: number; derived: number }>();
  const memo = new Map<string, { reports: number; maxArchives: number; maxRows: number; maxTornRows: number; maxFailedArchives: number }>();
  const pin = { adoptions: 0, parseMsTotal: 0, parseMsMax: 0, parsedBlobs: 0, reusedBlobs: 0 };
  const rss: number[] = [], heap: number[] = [], unattributed: number[] = [];
  const handoff = { handoffs: 0, prepMsTotal: 0, readyMsTotal: 0, drainMsTotal: 0, peakMiBMax: 0 };
  const shas = new Set<string>();
  let rowsRead = 0;

  const steps = [...new Set([...COST_STEPS, controlStep])];
  for await (const row of openLedgerUnion(stateDir, {
    since: window.since,
    step: steps,
    onUnreadArchive: () => { counts.unreadArchives++; },
    onUnreadLive: () => { counts.unreadLive++; },
  })) {
    const ts = typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(ts) || ts < from || ts >= to) continue;
    const step = row.step;
    if (typeof step !== "string") continue;
    rowsRead++;
    if (step === controlStep) counts.controlRows++;
    if (step === SLOW_VIEW_STEP) {
      const entry = slow.get(safeName(row.view)) ?? { count: 0, totalMs: 0, maxMs: 0, stages: new Map() };
      entry.count++;
      entry.totalMs += num(row.ms);
      entry.maxMs = Math.max(entry.maxMs, num(row.ms));
      if (row.stages && typeof row.stages === "object") {
        for (const [name, ms] of Object.entries(row.stages as Record<string, unknown>)) {
          const stage = entry.stages.get(safeName(name)) ?? { count: 0, totalMs: 0 };
          stage.count++;
          stage.totalMs += num(ms);
          entry.stages.set(safeName(name), stage);
        }
      }
      slow.set(safeName(row.view), entry);
    } else if (step === WORKSTREAMS_BUILT_STEP) {
      const hour = `${new Date(ts).toISOString().slice(0, 13)}:00Z`;
      const entry = built.get(hour) ?? { builds: 0, instances: 0, reused: 0, derived: 0 };
      entry.builds++;
      entry.instances += num(row.instances);
      entry.reused += num(row.reused);
      entry.derived += num(row.derived);
      built.set(hour, entry);
    } else if (step === MEMO_RETENTION_STEP) {
      const key = `${safeName(row.thread)}/${row.lane === undefined ? "-" : safeName(row.lane)}/${safeName(row.holder)}`;
      const entry = memo.get(key) ?? { reports: 0, maxArchives: 0, maxRows: 0, maxTornRows: 0, maxFailedArchives: 0 };
      entry.reports++;
      entry.maxArchives = Math.max(entry.maxArchives, num(row.archives));
      entry.maxRows = Math.max(entry.maxRows, num(row.rows));
      entry.maxTornRows = Math.max(entry.maxTornRows, num(row.tornRows));
      entry.maxFailedArchives = Math.max(entry.maxFailedArchives, num(row.failedArchives));
      memo.set(key, entry);
    } else if (step === PLAN_PIN_ADOPTED_STEP) {
      pin.adoptions++;
      pin.parseMsTotal += num(row.parseMs);
      pin.parseMsMax = Math.max(pin.parseMsMax, num(row.parseMs));
      pin.parsedBlobs += num(row.parsedBlobs);
      pin.reusedBlobs += num(row.reusedBlobs);
    } else if (step === SERVE_MEMORY_STEP) {
      rss.push(num(row.rss_bytes) / MIB);
      heap.push(num(row.heap_used_bytes) / MIB);
      unattributed.push(num(row.unattributed_bytes) / MIB);
    } else if (step === HANDOFF_DONE_STEP) {
      handoff.handoffs++;
      handoff.prepMsTotal += num(row.prepMs);
      handoff.readyMsTotal += num(row.readyMs);
      handoff.drainMsTotal += num(row.drainMs);
      handoff.peakMiBMax = Math.max(handoff.peakMiBMax, num(row.peakBytes) / MIB);
      const sha = shortSha(row.toSha);
      if (sha) shas.add(sha);
    }
  }

  if (counts.unreadArchives > 0) reasons.push("archive-unread");
  if (counts.unreadLive > 0) reasons.push("live-unread");
  if (counts.controlRows === 0) reasons.push("positive-control-zero");
  if (reasons.length > 0) throw new BoxCostRefusal(reasons, { ...counts });

  const positiveControl: PositiveControl = { step: controlStep, rows: counts.controlRows };
  const withControl = <T extends object>(value: T): Section<T> => ({ ...value, positiveControl });
  const record = <T>(map: Map<string, T>, finish: (value: T) => unknown = (v) => v): Record<string, never> =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, finish(v)])) as Record<string, never>;
  return {
    window: { ...window, hours: round((to - from) / 3_600_000) },
    positiveControl,
    rowsRead,
    slowView: withControl({ views: record(slow, (v) => ({ count: v.count, totalMs: round(v.totalMs), maxMs: round(v.maxMs), stages: record(v.stages, (s) => ({ count: s.count, totalMs: round(s.totalMs) })) })) }),
    workstreamsBuilt: withControl({ perHour: record(built) }),
    memoRetention: withControl({ holders: record(memo) }),
    planPinAdopted: withControl({ ...pin, parseMsTotal: round(pin.parseMsTotal) }),
    serveMemory: withControl({ samples: rss.length, rssMiB: stat(rss), heapUsedMiB: stat(heap), unattributedMiB: stat(unattributed) }),
    handoffDone: withControl({ ...handoff, peakMiBMax: round(handoff.peakMiBMax), toShas: [...shas].sort() }),
  };
}

/** after − before for every numeric leaf both reports carry; keys present in one side count as zero in the other. */
export function deltaOf(before: unknown, after: unknown): unknown {
  if (typeof before === "number" || typeof after === "number") return round(num(after) - num(before));
  if (Array.isArray(before) || Array.isArray(after)) return undefined;
  if ((before && typeof before === "object") || (after && typeof after === "object")) {
    const b = (before ?? {}) as Record<string, unknown>, a = (after ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      if (key === "window" || key === "positiveControl") continue;
      const value = deltaOf(b[key], a[key]);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  return undefined;
}

export async function boxCostReportCli(argv: string[], output: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: {
      "state-dir": { type: "string" }, since: { type: "string" }, until: { type: "string" },
      "compare-since": { type: "string" }, "compare-until": { type: "string" },
    } });
    const stateDir = values["state-dir"];
    if (!stateDir || !values.since || !values.until) {
      output(JSON.stringify({ ok: false, reasons: ["usage: --state-dir, --since and --until are required"] }));
      return 2;
    }
    if ((values["compare-since"] === undefined) !== (values["compare-until"] === undefined)) {
      output(JSON.stringify({ ok: false, reasons: ["compare-window-incomplete"] }));
      return 2;
    }
    const first = await buildBoxCostReport(resolve(stateDir), { since: values.since, until: values.until });
    if (values["compare-since"] === undefined || values["compare-until"] === undefined) {
      output(JSON.stringify({ ok: true, report: first }));
      return 0;
    }
    const second = await buildBoxCostReport(resolve(stateDir), { since: values["compare-since"], until: values["compare-until"] });
    output(JSON.stringify({ ok: true, before: first, after: second, delta: deltaOf(first, second) }));
    return 0;
  } catch (error) {
    if (error instanceof BoxCostRefusal) {
      output(JSON.stringify({ ok: false, reasons: error.reasons, counts: error.counts }));
    } else {
      output(JSON.stringify({ ok: false, reasons: ["report-failed"] }));
    }
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await boxCostReportCli(process.argv.slice(2));
}
