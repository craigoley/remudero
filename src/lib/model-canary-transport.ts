/** Observes already decoded provider events; never sends a request or computes a bill. */
import { canaryStreamClock } from "./model-canary-metrics.js";

const record = (x: unknown): Record<string, unknown> | undefined =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
type Counter = "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens";

/** Claude message_delta usage is cumulative. OpenAI's final usage snapshot is also a total. */
export function canaryTransportCapture(protocol: "anthropic-messages" | "openai-chat", startedMs: number) {
  const clock = canaryStreamClock(startedMs);
  const values: Record<Counter, number | null> = { inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null };
  const invalid = new Set<Counter>();
  let servedModel: string | null = null, identityConflict = false, ended = false, failed = false;
  let events = 0;
  function count(key: Counter, raw: unknown) {
    if (raw === undefined || raw === null || invalid.has(key)) return;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0
      || (values[key] !== null && raw < values[key]!)) { invalid.add(key); values[key] = null; return; }
    values[key] = raw;
  }
  function identity(raw: unknown) {
    if (typeof raw !== "string" || !raw.trim()) return;
    if (servedModel !== null && servedModel !== raw) identityConflict = true;
    servedModel = raw;
  }
  return {
    event(raw: unknown, atMs: number) {
      if (++events > 8192) { failed = true; return; }
      const e = record(raw); if (!e) { failed = true; return; }
      if (protocol === "anthropic-messages") {
        if (e.type === "message_start") {
          const message = record(e.message); identity(message?.model);
          const usage = record(message?.usage);
          count("inputTokens", usage?.input_tokens); count("outputTokens", usage?.output_tokens);
          count("cacheReadTokens", usage?.cache_read_input_tokens); count("cacheWriteTokens", usage?.cache_creation_input_tokens);
        } else if (e.type === "content_block_delta") {
          const delta = record(e.delta);
          if (delta?.type === "text_delta" && typeof delta.text === "string") clock.text(atMs, delta.text);
        } else if (e.type === "message_delta") {
          const usage = record(e.usage); count("outputTokens", usage?.output_tokens);
        } else if (e.type === "message_stop") ended = true;
        else if (e.type === "error" || e.type === "fallback") { failed = true; identityConflict = true; }
        else if (e.type === "content_block_start" && record(e.content_block)?.type === "fallback") {
          // Multi-model fallback has different accounting; never attribute its whole task to the initial model.
          failed = true; identityConflict = true;
        }
      } else {
        identity(e.model);
        const usage = record(e.usage);
        count("inputTokens", usage?.prompt_tokens); count("outputTokens", usage?.completion_tokens);
        count("cacheReadTokens", record(usage?.prompt_tokens_details)?.cached_tokens);
        count("reasoningTokens", record(usage?.completion_tokens_details)?.reasoning_tokens);
        if (e.error) failed = true;
        if (Array.isArray(e.choices)) for (const rawChoice of e.choices) {
          const choice = record(rawChoice), delta = record(choice?.delta);
          if (typeof delta?.content === "string") clock.text(atMs, delta.content);
          if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) ended = true;
        }
      }
    },
    finish(endMs: number, transport: "complete" | "error" | "timeout") {
      return { ...clock.finish(endMs), ...values, servedModel: identityConflict ? null : servedModel,
        terminal: transport === "timeout" ? "timeout" as const
          : failed || !ended || transport === "error" ? "error" as const : "complete" as const,
        usageCoverage: { observed: Object.values(values).filter(v => v !== null).length,
          invalidCounters: [...invalid], events, protocol,
          inputIncludesCached: protocol === "openai-chat", outputIncludesReasoning: protocol === "openai-chat" },
        // A provider counter is not a currency amount or an invoice join.
        usageRatedUsd: null };
    },
  };
}
