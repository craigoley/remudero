import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendLedger } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";

// PRIMARY CONTROL: bound retained identities; exhaustion reports unknown rather than evicting joins.
export const WORKER_TOOL_LINEAGE_MAX_CALLS = 2048;
const PROVIDERS = ["claude", "codex", "cash-chat", "cash-responses", "cash-claude"] as const;
type Provider = typeof PROVIDERS[number] | "unsupported";
const TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent",
  "read_file", "write_file", "apply_patch", "list_files", "run_check", "web_search", "command_execution", "file_change", "mcp_tool_call"] as const;
type Tool = typeof TOOLS[number] | "other";
type Result = "success" | "error" | "unknown";
type Reason = "missing-call-id" | "missing-turn-id" | "missing-run-id" | "malformed-payload" | "malformed-outcome"
  | "unsupported-adapter" | "ambiguous-call-id" | "capacity-exceeded" | "duplicate-use" | "duplicate-result"
  | "unmatched-result" | "stream-ended" | "interrupted";
type StreamEnd = "stream-ended" | "interrupted";

export interface WorkerToolReceipt {
  provider: Provider;
  streamId: string;
  runId: string | null;
  turnId: string | null;
  callId: string | null;
  tool: Tool;
  state: "attempt" | "joined" | "duplicate" | "orphan-result" | "unfinished" | "unsupported";
  result: Result;
  admission: "unknown";
  taskOutcome: "unknown";
  reason?: Reason;
}

export interface WorkerToolLineageOptions {
  provider: string;
  runId?: string;
  taskId?: string;
  root?: string;
  sink?: (receipt: WorkerToolReceipt) => unknown;
}

type Delivery = { state: "unavailable" | "written" | "pending" }
  | { state: "failed"; reason: "sink-threw" | "normalization-threw"; errorClass: "TypeError" | "Error" | "non-error" };
type Call = { turnId: string; tool: Tool; completed: boolean; ambiguous: boolean };
type Metadata = { kind: "use" | "result"; id: unknown; turnId?: unknown; name?: unknown; result?: Result; reason?: Reason };

const EMPTY_EXCLUSIONS = {
  unknown: 0, duplicateUse: 0, duplicateResult: 0, orphan: 0, interrupted: 0,
  unfinished: 0, ambiguous: 0, unsupported: 0, capacityExceeded: 0,
};
const EXCLUSION_BY_REASON: Partial<Record<Reason, keyof typeof EMPTY_EXCLUSIONS>> = {
  "duplicate-use": "duplicateUse",
  "duplicate-result": "duplicateResult",
  "unmatched-result": "orphan",
  "interrupted": "interrupted",
  "stream-ended": "unfinished",
  "ambiguous-call-id": "ambiguous",
  "capacity-exceeded": "capacityExceeded",
};
type EpisodeStats = { eligibleResults: number; successes: number; streak: number; lengths: Map<number, number> };
type EpisodeResult = { call: Call; result: "success" | "error"; startsWindow: boolean };

function closeEpisode(stats: EpisodeStats): void {
  if (stats.streak === 0) return;
  stats.lengths.set(stats.streak, (stats.lengths.get(stats.streak) ?? 0) + 1);
  stats.streak = 0;
}

class ToolErrorEpisodes {
  private readonly excluded = { ...EMPTY_EXCLUSIONS };
  // One entry per completed call, bounded by the join cap. A later identity conflict can invalidate an earlier join.
  private readonly results: EpisodeResult[] = [];
  private turnId: string | null = null;
  private startsWindow = true;

  turn(turnId: string | null): void {
    if (turnId === null || this.turnId !== turnId) this.startsWindow = true;
    this.turnId = turnId;
  }

  observe(receipt: WorkerToolReceipt, call?: Call): void {
    if (receipt.turnId !== null) this.turn(receipt.turnId);
    if (receipt.state === "attempt") return;
    if (call && (receipt.result === "success" || receipt.result === "error")) {
      this.results.push({ call, result: receipt.result, startsWindow: this.startsWindow });
      this.startsWindow = false;
      return;
    }
    const exclusion = receipt.reason ? EXCLUSION_BY_REASON[receipt.reason] : undefined;
    this.excluded[exclusion ?? (receipt.state === "joined" ? "unknown" : "unsupported")]++;
    this.startsWindow = true;
  }

  summarize() {
    const byTool = new Map<Tool, EpisodeStats>();
    // Fold in receipt order. Other classes can interleave within a turn; an evidence gap closes every class.
    for (const { call, result, startsWindow } of this.results) {
      if (startsWindow || call.ambiguous) for (const stats of byTool.values()) closeEpisode(stats);
      if (call.ambiguous) {
        this.excluded.ambiguous++;
        continue;
      }
      let stats = byTool.get(call.tool);
      if (!stats) {
        stats = { eligibleResults: 0, successes: 0, streak: 0, lengths: new Map() };
        byTool.set(call.tool, stats);
      }
      stats.eligibleResults++;
      if (result === "error") stats.streak++;
      else {
        stats.successes++;
        closeEpisode(stats);
      }
    }
    this.results.length = 0;
    const tools = Array.from(byTool, ([tool, stats]) => {
      closeEpisode(stats);
      return {
        tool, eligibleResults: stats.eligibleResults, successes: stats.successes,
        errorEpisodes: Array.from(stats.lengths, ([length, count]) => ({ length, count })).sort((a, b) => a.length - b.length),
      };
    });
    const { duplicateUse, duplicateResult, ...gaps } = this.excluded;
    return { tools, excluded: this.excluded, hasGaps: Object.values(gaps).some(count => count > 0) };
  }
}

type ToolLineageShadow = Omit<ReturnType<ToolErrorEpisodes["summarize"]>, "hasGaps"> & {
  provider: Provider;
  streamId: string;
  runId: string | null;
  window: "stream";
  closure: StreamEnd;
  completeness: "complete" | "incomplete";
  deliveryFailure: Extract<Delivery, { state: "failed" }>["reason"] | null;
};

function encoded(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    ? createHash("sha256").update(value).digest("hex") : null;
}

function tool(value: unknown): Tool {
  return TOOLS.includes(value as Tool & typeof TOOLS[number]) ? value as Tool : "other";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorClass(error: unknown): "TypeError" | "Error" | "non-error" {
  return error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "non-error";
}

function resultOf(value: unknown): Result {
  return value === true ? "error" : value === false || value === undefined ? "success" : "unknown";
}

export class WorkerToolLineage {
  readonly provider: Provider;
  readonly streamId = randomUUID();
  delivery: Delivery = { state: "unavailable" };
  private readonly runId: string | null;
  private readonly calls = new Map<string, Map<string, Call>>();
  private callCount = 0;
  private readonly sink?: WorkerToolLineageOptions["sink"];
  private readonly shadow?: { episodes: ToolErrorEpisodes; sink: (summary: ToolLineageShadow) => void };
  private codexTurn = 0;
  private codexTurnActive = false;
  private closed = false;

  constructor(options: WorkerToolLineageOptions) {
    this.provider = PROVIDERS.includes(options.provider as typeof PROVIDERS[number]) ? options.provider as Provider : "unsupported";
    this.runId = encoded(options.runId);
    this.sink = options.sink;
    const root = options.root;
    if (!root || this.sink) return;
    const ledgerPath = () => join(root, "state", LEDGER_FILENAME);
    const attribution = {
      run_id: this.runId ?? "unattributed",
      task_id: encoded(options.taskId) ?? "unattributed",
    };
    this.sink = receipt => appendLedger(ledgerPath(), {
      ...attribution,
      step: "worker.tool_lineage",
      tool_lineage: receipt,
    });
    this.shadow = {
      episodes: new ToolErrorEpisodes(),
      sink: summary => appendLedger(ledgerPath(), {
        ...attribution,
        step: "worker.tool_lineage_shadow",
        tool_lineage_shadow: summary,
      }),
    };
  }

  private emit(fields: Pick<WorkerToolReceipt, "state"> & Partial<WorkerToolReceipt>, call?: Call): void {
    const receipt: WorkerToolReceipt = {
      provider: this.provider, streamId: this.streamId, runId: this.runId, turnId: null, callId: null,
      tool: "other", result: "unknown", admission: "unknown", taskOutcome: "unknown", ...fields,
    };
    this.shadow?.episodes.observe(receipt, call);
    this.deliver(this.sink, receipt);
  }

  private deliver<T>(sink: ((value: T) => unknown) | undefined, value: T): void {
    if (!sink) return;
    try {
      const pending = sink(value);
      if (pending instanceof Promise) {
        if (this.delivery.state !== "failed") this.delivery = { state: "pending" };
        void pending.then(() => {
          if (this.delivery.state !== "failed") this.delivery = { state: "written" };
        }, error => { this.delivery = { state: "failed", reason: "sink-threw", errorClass: errorClass(error) }; });
      } else if (this.delivery.state !== "failed") this.delivery = { state: "written" };
    } catch (error) {
      this.delivery = { state: "failed", reason: "sink-threw", errorClass: errorClass(error) };
    }
  }

  private accept(meta: Metadata): void {
    const callId = encoded(meta.id);
    const turnId = encoded(meta.turnId);
    if (!this.runId || !callId || (meta.kind === "use" && !turnId)) {
      this.emit({ state: "unsupported", callId, turnId, tool: tool(meta.name),
        reason: !this.runId ? "missing-run-id" : !callId ? "missing-call-id" : "missing-turn-id" });
      return;
    }
    const variants = this.calls.get(callId);
    const existing = turnId ? variants?.get(turnId) : variants?.size === 1 ? variants.values().next().value : undefined;
    if (meta.kind === "use") {
      if (existing) {
        if (existing.tool !== tool(meta.name)) existing.ambiguous = true;
        this.emit({ state: existing.ambiguous ? "unsupported" : "duplicate", callId, turnId,
          tool: tool(meta.name), reason: existing.ambiguous ? "ambiguous-call-id" : "duplicate-use" });
      } else if (this.callCount >= WORKER_TOOL_LINEAGE_MAX_CALLS) {
        this.emit({ state: "unsupported", callId, turnId, reason: "capacity-exceeded" });
      } else {
        const turns = variants ?? new Map<string, Call>();
        turns.set(turnId!, { turnId: turnId!, tool: tool(meta.name), completed: false, ambiguous: false });
        this.calls.set(callId, turns);
        this.callCount++;
        this.emit({ state: "attempt", callId, turnId, tool: tool(meta.name) });
      }
      return;
    }
    if (meta.turnId === undefined && variants && variants.size > 1) {
      this.emit({ state: "unsupported", callId, reason: "ambiguous-call-id" });
    } else if (!existing || (meta.turnId !== undefined && existing.turnId !== turnId)) {
      this.emit({ state: "orphan-result", runId: null, callId, reason: "unmatched-result" });
    } else if (existing.ambiguous) {
      this.emit({ state: "unsupported", callId, reason: "ambiguous-call-id" });
    } else if (existing.completed) {
      this.emit({ state: "duplicate", callId, turnId: existing.turnId, tool: existing.tool, reason: "duplicate-result" });
    } else {
      existing.completed = true;
      const observedTurn = this.provider !== "codex" || this.codexTurnActive;
      this.emit({
        state: "joined", callId, turnId: existing.turnId, tool: existing.tool,
        result: meta.result, ...(meta.result === "unknown" ? { reason: meta.reason ?? "malformed-outcome" } : {}),
      }, observedTurn ? existing : undefined);
    }
  }

  observe(raw: unknown): void {
    if (this.closed) return;
    try {
      const event = record(raw);
      if (this.provider === "unsupported") {
        this.emit({ state: "unsupported", reason: "unsupported-adapter" });
      } else if (!event) {
        this.emit({ state: "unsupported", reason: "malformed-payload" });
      } else if (this.provider === "claude") {
        if (event.type !== "assistant" && event.type !== "user") return;
        const message = record(event.message);
        const content = message?.content;
        if (event.type === "assistant" && this.shadow) this.shadow.episodes.turn(encoded(message?.id));
        if (typeof content === "string" && event.type === "user") {
          this.shadow?.episodes.turn(null);
          return;
        }
        if (!Array.isArray(content)) {
          this.emit({ state: "unsupported", reason: "malformed-payload" });
          return;
        }
        for (const value of content) {
          const block = record(value);
          if (event.type === "assistant" && block?.type === "tool_use") {
            this.accept({ kind: "use", id: block.id, turnId: message?.id, name: block.name });
          } else if (event.type === "user" && block?.type === "tool_result") {
            this.accept({ kind: "result", id: block.tool_use_id, result: resultOf(block.is_error) });
          } else if (!block) this.emit({ state: "unsupported", reason: "malformed-payload" });
        }
      } else if (this.provider === "codex") {
        if (event.type === "turn.started") {
          this.codexTurn++;
          this.codexTurnActive = true;
          this.shadow?.episodes.turn(null);
        }
        if (event.type === "turn.completed" || event.type === "turn.failed") {
          this.codexTurnActive = false;
          this.shadow?.episodes.turn(null);
        }
        const item = record(event.item);
        if (event.type !== "item.started" && event.type !== "item.completed") return;
        if (!item) { this.emit({ state: "unsupported", reason: "malformed-payload" }); return; }
        if (!["command_execution", "file_change", "web_search", "mcp_tool_call"].includes(item.type as string)) return;
        const turnId = this.codexTurnActive ? String(this.codexTurn) : undefined;
        const outcome = item.status === "failed" || record(item.error) ||
          (typeof item.exit_code === "number" && item.exit_code !== 0) ? "error"
          : item.status === "completed" && (item.type !== "command_execution" || item.exit_code === 0) ? "success" : "unknown";
        this.accept({ kind: event.type === "item.started" ? "use" : "result", id: item.id, turnId, name: item.type, result: outcome });
      } else if (event.type === "tool_use" || event.type === "tool_result") {
        this.accept({ kind: event.type === "tool_use" ? "use" : "result", id: event.type === "tool_use" ? event.id : event.tool_use_id,
          turnId: event.turnId, name: event.name, result: resultOf(event.is_error) });
      }
    } catch (error) {
      this.emit({ state: "unsupported", reason: "malformed-payload" });
      this.delivery = { state: "failed", reason: "normalization-threw", errorClass: errorClass(error) };
    }
  }

  finish(reason: StreamEnd): void {
    if (this.closed) return;
    this.closed = true;
    for (const [callId, turns] of this.calls) {
      for (const call of turns.values()) {
        if (!call.completed) this.emit({ state: "unfinished", callId, turnId: call.turnId, tool: call.tool, reason });
      }
    }
    this.calls.clear();
    if (!this.shadow) return;
    const { tools, excluded, hasGaps } = this.shadow.episodes.summarize();
    const deliveryFailure = this.delivery.state === "failed" ? this.delivery.reason : null;
    const complete = reason === "stream-ended" && this.runId !== null && this.provider !== "unsupported" && !hasGaps && !deliveryFailure;
    this.deliver(this.shadow.sink, {
      provider: this.provider, streamId: this.streamId, runId: this.runId, window: "stream", closure: reason,
      completeness: complete ? "complete" : "incomplete", deliveryFailure, tools, excluded,
    });
  }
}

export function createWorkerToolLineage(options: WorkerToolLineageOptions): WorkerToolLineage {
  return new WorkerToolLineage(options);
}

export function observeWorkerToolLineage(observer: WorkerToolLineage, raw: unknown): void {
  observer.observe(raw);
}
