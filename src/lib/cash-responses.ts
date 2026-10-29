/** Deployment-specific Responses efforts; transport selection and request validation share this table. */
export const CASH_RESPONSES_DEPLOYMENTS: Readonly<Partial<Record<string, readonly string[]>>> = {
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-terra": ["none", "low", "medium", "high", "xhigh", "max"],
};

/** Azure Responses transport. Retain reasoning and call items between tool turns. */
export class CashResponsesConversation {
  private input: Record<string, unknown>[];

  constructor(contract: string, prompt: string) {
    this.input = [{ role: "system", content: contract }, { role: "user", content: prompt }];
  }

  body(model: string, effort: string, maxOutputTokens: number, tools: Record<string, unknown>[], format?: string): string {
    const reasoningEffort = effort === "default" ? "medium" : effort;
    const allowed = CASH_RESPONSES_DEPLOYMENTS[model] ?? [];
    if (!allowed.includes(reasoningEffort)) {
      throw new Error(`cash ${model} does not support reasoning effort ${effort}; allowed: ${allowed.join(", ")}`);
    }
    return JSON.stringify({ model, input: this.input, store: false, include: ["reasoning.encrypted_content"],
      reasoning: { effort: reasoningEffort }, max_output_tokens: maxOutputTokens,
      ...(format ? { text: { format: { type: format } } } : {}),
      ...(tools.length ? { tools: tools.map((tool) => ({ type: "function", ...(tool.function as object), strict: false })), tool_choice: "auto" } : {}),
    });
  }

  /** Normalize the provider envelope for the shared allowance and bounded tool executor. */
  read(payload: {
    id?: unknown; model?: unknown; status?: unknown; output?: Record<string, unknown>[];
    usage?: { input_tokens?: unknown; output_tokens?: unknown;
      input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } };
  }) {
    const output = Array.isArray(payload.output) ? payload.output : [];
    this.input.push(...output);
    const calls = output.filter((item) => item.type === "function_call").map((item) => ({
      id: item.call_id, function: { name: item.name, arguments: item.arguments },
    }));
    const content = output.filter((item) => item.type === "message").flatMap((item) =>
      Array.isArray(item.content) ? item.content as Record<string, unknown>[] : []);
    const text = content.filter((item) => item.type === "output_text").map((item) => item.text).join("");
    const usable = payload.status === "completed" && (calls.length > 0 || content.some((item) => item.type === "output_text"));
    return { id: payload.id, model: payload.model,
      usage: { prompt_tokens: payload.usage?.input_tokens, completion_tokens: payload.usage?.output_tokens,
        cached_tokens: payload.usage?.input_tokens_details?.cached_tokens,
        cache_creation_tokens: payload.usage?.input_tokens_details?.cache_write_tokens },
      choices: usable || payload.status === "incomplete" ? [{ message: { content: text, tool_calls: calls },
        finish_reason: payload.status === "incomplete" ? "length" : calls.length ? "tool_calls" : "stop" }] : [],
    };
  }

  toolOutput(callId: string, output: string): void {
    this.input.push({ type: "function_call_output", call_id: callId, output });
  }
}
