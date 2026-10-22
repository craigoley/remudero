/** One SDK user turn: raw message identity, main-loop usage and native terminal authority. */
import { canaryStreamClock, type CanaryBilling } from "./model-canary-metrics.js";
import { canaryTransportCapture } from "./model-canary-transport.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
type InputCounter = "inputTokens" | "cacheReadTokens" | "cacheWriteTokens";
const inputKeys: InputCounter[] = ["inputTokens", "cacheReadTokens", "cacheWriteTokens"];
const nativeKeys = { inputTokens: "input_tokens", cacheReadTokens: "cache_read_input_tokens",
  cacheWriteTokens: "cache_creation_input_tokens" } as const;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const counterSnapshot = (value: unknown) => value === undefined || typeof value === "number" ? value : "invalid";

export function canaryNativeStreamCapture(startedMs: number, billing: CanaryBilling,
  maxOutputBytes = 16_384) {
  if (!["api", "subscription"].includes(billing) || !Number.isInteger(maxOutputBytes)
    || maxOutputBytes < 1 || maxOutputBytes > 65_536) throw new Error("canary-native-capture-bound-invalid");
  const clock = canaryStreamClock(startedMs);
  const messages = new Map<string, { capture: ReturnType<typeof canaryTransportCapture>; closed: boolean }>();
  const blocks = new Map<number, string>();
  let active: string | undefined, failure: string | undefined, result: Record<string, unknown> | undefined;
  let finalText = "", visibleBytes = 0, events = 0, toolBlocks = 0, duplicateResult = false, sealed = false;
  const refuse = (reason: string) => { failure ??= reason; };
  return {
    event(raw: unknown, atMs: number) {
      if (sealed) throw new Error("canary-native-capture-already-finished");
      if (++events > 8192) { refuse("event-bound"); return; }
      const frame = record(raw); if (!frame) { refuse("invalid-frame"); return; }
      if (frame.type === "result") {
        if (result) { duplicateResult = true; refuse("multiple-user-turn-results"); return; }
        const usage = record(frame.usage);
        // Retain only observed scalar counters, never mutable SDK objects or session cost payloads.
        result = { usage: { input_tokens: counterSnapshot(usage?.input_tokens), output_tokens: counterSnapshot(usage?.output_tokens),
          cache_read_input_tokens: counterSnapshot(usage?.cache_read_input_tokens), cache_creation_input_tokens: counterSnapshot(usage?.cache_creation_input_tokens),
          output_tokens_details: { thinking_tokens: counterSnapshot(record(usage?.output_tokens_details)?.thinking_tokens) } } };
        if (frame.subtype !== "success" || frame.is_error !== false) refuse("native-result-error");
        if (!Array.isArray(frame.permission_denials) || frame.permission_denials.length !== 0) refuse("permission-outcome-unproven");
        if (count(frame.num_turns) === null || (frame.num_turns as number) < 1 || (frame.num_turns as number) > 32) refuse("turn-bound");
        if (typeof frame.result !== "string") refuse("native-final-text-missing");
        else if (Buffer.byteLength(frame.result, "utf8") > maxOutputBytes) refuse("output-bound");
        else finalText = frame.result;
        return;
      }
      if (result) { refuse("frame-after-result"); return; }
      if (frame.type === "assistant") {
        // Complete block fragments duplicate raw text and carry placeholder output counts.
        const message = record(frame.message);
        if (frame.parent_tool_use_id !== null || typeof message?.id !== "string"
          || !messages.has(message.id) || frame.error !== undefined) refuse("assistant-scope-unproven");
        return;
      }
      if (frame.type === "system") {
        if (frame.subtype === "compact_boundary" || frame.subtype === "conversation_reset") refuse("context-reset");
        return;
      }
      if (frame.type === "user" || frame.type === "tool_progress") return;
      if (frame.type !== "stream_event" || frame.parent_tool_use_id !== null) { refuse("stream-scope-unproven"); return; }
      const event = record(frame.event); if (!event) { refuse("invalid-stream-event"); return; }
      if (event.type === "ping") return;
      let observedEvent = event;
      if (event.type === "message_start") {
        const message = record(event.message), id = message?.id;
        if (active || typeof id !== "string" || !id.trim() || Buffer.byteLength(id, "utf8") > 512
          || messages.has(id) || messages.size >= 32) { refuse("message-identity-unproven"); return; }
        const model = message?.model;
        const modelKnown = typeof model === "string" && model.trim() !== "" && Buffer.byteLength(model, "utf8") <= 256;
        if (!modelKnown) refuse("model-identity-unproven");
        observedEvent = { type: "message_start", message: { model: modelKnown ? model : undefined, usage: message?.usage } };
        active = id; messages.set(id, { capture: canaryTransportCapture("anthropic-messages", atMs), closed: false });
      }
      const current = active === undefined ? undefined : messages.get(active);
      if (!current) { refuse("event-without-message"); return; }
      current.capture.event(observedEvent, atMs);
      if (event.type === "content_block_start") {
        const index = count(event.index), block = record(event.content_block);
        if (index === null || index > 255 || blocks.has(index) || typeof block?.type !== "string") refuse("block-identity-unproven");
        else { blocks.set(index, block.type); if (block.type === "tool_use") toolBlocks++; }
      } else if (event.type === "content_block_delta") {
        const index = count(event.index), delta = record(event.delta);
        if (index === null || !blocks.has(index)) refuse("delta-without-block");
        else if (delta?.type === "text_delta" && typeof delta.text === "string") {
          if (blocks.get(index) !== "text") refuse("text-block-scope-unproven");
          visibleBytes = Math.min(maxOutputBytes + 1, visibleBytes + Buffer.byteLength(delta.text, "utf8"));
          if (visibleBytes > maxOutputBytes) refuse("output-bound");
          else clock.text(atMs, delta.text);
        }
      } else if (event.type === "content_block_stop") {
        const index = count(event.index);
        if (index === null || !blocks.delete(index)) refuse("stop-without-block");
      } else if (event.type === "message_stop") {
        // Interrupted tool input may get message_stop without content_block_stop.
        if (blocks.size) refuse("incomplete-content-block");
        current.closed = true; blocks.clear(); active = undefined;
      }
    },
    finish(endMs: number, transport: "complete" | "error" | "timeout") {
      if (sealed) throw new Error("canary-native-capture-already-finished"); sealed = true;
      const partial = [...messages.values()].map(m => m.capture.finish(endMs, m.closed ? "complete" : "error"));
      if (!result || !messages.size || active || partial.some(p => p.terminal !== "complete")) refuse("native-terminal-unproven");
      const usage = record(result?.usage), invalidCounters: string[] = [];
      const values = {} as Record<InputCounter, number | null>;
      for (const key of inputKeys) {
        let sum: number | null = partial.length && partial.every(p => p[key] !== null)
          ? partial.reduce((n, p) => n + p[key]!, 0) : null;
        if (sum !== null && !Number.isSafeInteger(sum)) sum = null;
        const raw = usage?.[nativeKeys[key]], final = count(raw);
        const invalid = partial.some(p => p.usageCoverage.invalidCounters.includes(key))
          || (raw !== undefined && final === null) || (sum !== null && final !== null && sum !== final);
        values[key] = invalid || duplicateResult ? null : final ?? sum;
        if (invalid) invalidCounters.push(key);
      }
      // Result usage is per user turn; modelUsage/costUSD may cover the resumed session.
      const outputTokens = duplicateResult ? null : count(usage?.output_tokens);
      const reasoningTokens = duplicateResult ? null : count(record(usage?.output_tokens_details)?.thinking_tokens);
      if (usage?.output_tokens !== undefined && outputTokens === null) invalidCounters.push("outputTokens");
      if (record(usage?.output_tokens_details)?.thinking_tokens !== undefined && reasoningTokens === null) invalidCounters.push("reasoningTokens");
      const models = new Set(partial.map(p => p.servedModel));
      const servedModel = models.size === 1 && !models.has(null) ? [...models][0]! : null;
      if (models.size > 1) refuse("mixed-model-identity");
      const timing = clock.finish(endMs);
      return { text: finalText, resources: { ...timing, ...values, outputTokens, reasoningTokens,
        // Several messages include tool gaps; this is not a generation-speed interval.
        generationMs: messages.size === 1 ? timing.generationMs : null,
        servedModel, usageRatedUsd: null, billing,
        terminal: transport === "timeout" ? "timeout" as const
          : failure || transport === "error" ? "error" as const : "complete" as const },
        observation: { protocol: "claude-agent-sdk-partial-v1" as const, usageScope: "main-loop-user-turn" as const,
          messages: messages.size, events, toolBlocks, invalidCounters, resultObserved: result !== undefined,
          failure: failure ?? null, inputIncludesCached: false, outputIncludesReasoning: true,
          sessionCostConsumed: false as const, adapterQualified: false as const } };
    },
  };
}
