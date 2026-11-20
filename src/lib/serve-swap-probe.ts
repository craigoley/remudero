/**
 * W1-T13832: after a serve generation swap, serve reads each view in serve mode once, in its own process, and writes
 * what each answered to one serve.swap_probe ledger row. Swap evidence then no longer waits for a client to read views.
 * The probe reads through the same path GET /v1/views/<name> uses, is bounded in views and time, and never throws.
 */
import { systemClock, type Clock } from "./clock.js";
import { appendLedger } from "./ledger.js";

/** PRIMARY CONTROL: the most views one probe reads, the same cap as one view batch (VIEW_BATCH_MAX_READS). */
export const SWAP_PROBE_MAX_VIEWS = 32;
/** BACKSTOP: a probe still reading by now writes what it has, with probe_failed. */
export const SWAP_PROBE_TIMEOUT_MS = 10_000;

/** Who asked for a view read: a client request, or serve's own probe after a generation swap. */
export type ViewAnswerSource = "client" | "swap-probe";
/** One probe read's answer, as the demand window counts it. */
export interface ViewProbeAnswer { status: number; code: string; stale: boolean }
/** What the probe reads views through (views.ts buildReadModelViewRoutes hands it out): every routed view, its effective mode and required params, and one read. */
export interface ViewProbeReader {
  names: readonly string[];
  mode(name: string): "serve" | "shadow" | "off";
  requiredParams(name: string): readonly string[];
  read(name: string, params: URLSearchParams): Promise<ViewProbeAnswer>;
}

/** Which swap a probe request follows. */
export type SwapProbeTrigger = "handoff" | "cold_start" | "crash_restart";
/** The supervisor's request that the generation now serving read each of its views once, after a swap. */
export interface SwapProbeRequest { trigger: SwapProbeTrigger; generation: number; sha: string; fromSha?: string }

/** One view's probe answer; `key` is null and `code` is no_key when the view needs params and holds no body to read. */
export interface SwapProbeViewResult { key: string | null; status?: number; code: string; stale?: boolean }

export type SwapProbeRow = {
  run_id: "serve"; task_id: ""; step: "serve.swap_probe";
  trigger: SwapProbeTrigger; generation: number; sha: string; fromSha?: string;
  views: Record<string, SwapProbeViewResult>; ms: number; probe_failed?: string;
};

export interface SwapProbeOptions {
  reader: ViewProbeReader | undefined;
  /** The keys the read model holds a body for, for one view (for a demand view, the demand book's live keys). */
  heldKeys: (view: string) => readonly string[];
  ledgerPath: string;
  /** `<generation>:<trigger>` of each probe already run, so a repeated request is ignored. */
  seen: Set<string>;
  clock?: Clock;
  timeoutMs?: number;
  log?: (step: string, extra: Record<string, unknown>) => void;
}

/** The keys of the bodies held for `view`, in the order the read model holds them. */
export function heldViewKeys(bodies: ReadonlyMap<string, { view: string; key: string }> | undefined, view: string): string[] {
  return [...(bodies?.values() ?? [])].filter((entry) => entry.view === view).map((entry) => entry.key);
}

function probeKey(reader: ViewProbeReader, held: readonly string[], view: string): string | undefined {
  if (held.includes("") || reader.requiredParams(view).length === 0) return "";
  return held[0];
}

function failureText(error: unknown): string {
  return `threw: ${String((error as Error)?.message ?? error)}`;
}

/** The time bound, armed before any read starts, so a read that blocks the loop is still measured against it. */
function armBound(ms: number): { expired: Promise<string>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`timeout after ${ms} ms`), ms);
    timer.unref?.();
  });
  return { expired, clear: () => clearTimeout(timer) };
}

/** Reports a failure without letting the report itself throw: the production logger writes the same ledger. */
function report(opts: SwapProbeOptions, extra: Record<string, unknown>): void {
  try {
    opts.log?.("serve.swap_probe_write_failed", extra);
  } catch (reportError) {
    console.error("serve.swap_probe_report_failed", { ...extra, reportReason: String(reportError) });
  }
}

/** Reads each served view once and writes one serve.swap_probe row; undefined when it ran before or no view serves. */
export async function runSwapProbe(request: SwapProbeRequest, opts: SwapProbeOptions): Promise<SwapProbeRow | undefined> {
  const once = `${request.generation}:${request.trigger}`;
  if (opts.seen.has(once)) return undefined;
  opts.seen.add(once);
  const clock = opts.clock ?? systemClock;
  const started = clock.now();
  const views: Record<string, SwapProbeViewResult> = {};
  const boundMs = opts.timeoutMs ?? SWAP_PROBE_TIMEOUT_MS;
  const bound = armBound(boundMs);
  let failed: string | undefined;
  try {
    const reader = opts.reader;
    const served = reader ? reader.names.filter((name) => reader.mode(name) === "serve").slice(0, SWAP_PROBE_MAX_VIEWS) : [];
    if (!reader || served.length === 0) return undefined;
    const reads = Promise.all(served.map(async (name) => {
      const key = probeKey(reader, opts.heldKeys(name), name);
      if (key === undefined) {
        views[name] = { key: null, code: "no_key" };
        return;
      }
      views[name] = { key, ...(await reader.read(name, new URLSearchParams(key))) };
    }));
    failed = await Promise.race([reads.then(() => undefined, failureText), bound.expired]);
  } catch (error) {
    // The probe never throws: a failure is the row's probe_failed reason.
    failed = failureText(error);
  } finally {
    bound.clear();
  }
  if (failed === undefined && clock.now() - started > boundMs) failed = `timeout after ${boundMs} ms`;
  const row: SwapProbeRow = {
    run_id: "serve", task_id: "", step: "serve.swap_probe", trigger: request.trigger, generation: request.generation, sha: request.sha,
    ...(request.fromSha === undefined ? {} : { fromSha: request.fromSha }),
    views: { ...views }, ms: clock.now() - started, ...(failed === undefined ? {} : { probe_failed: failed }),
  };
  try {
    appendLedger(opts.ledgerPath, row);
  } catch (error) {
    // Observation must not take down the generation when its ledger is unavailable; the report says why.
    report(opts, { reason: String(error), trigger: request.trigger, generation: request.generation });
  }
  return row;
}
