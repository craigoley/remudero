import { nativeCanaryToolPolicy } from "./model-canary-native-tool-policy.js";
/** Native SDK tools invoke the runner's synthetic capability, never prompt-derived authority. */
import { createSdkMcpServer, type Options, type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CanaryRequest } from "./model-canary-runner.js";

/** Actual SDK configuration only. Query/stream qualification is a separate prerequisite. */
export function nativeCanaryTools(request: CanaryRequest) {
  const policy = nativeCanaryToolPolicy(request);
  const name = policy === "inventory" ? "inventory" : "lookup";
  const schema = policy === "inventory" ? z.strictObject({ item: z.enum(["A", "B"]) }) : z.strictObject({});
  const allowedName = `mcp__canary__${name}`;
  let unavailableReason: string | null = null;
  const server = policy === "none" ? undefined : createSdkMcpServer({ name: "canary", version: "1.0.0", tools: [] });
  server?.instance.registerTool(name, {
    description: policy === "inventory" ? "Read the synthetic inventory for item A or B." : "Read the synthetic lookup result.",
    inputSchema: schema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { "anthropic/alwaysLoad": true },
  }, async args => {
    try {
      const event = request.invokeTool!(name, args);
      return { content: [{ type: "text" as const, text: JSON.stringify(event.result) }],
        isError: event.denied || (event.result !== null && typeof event.result === "object" && "error" in event.result) };
    } catch (error) {
      unavailableReason = error instanceof Error ? "synthetic-tool-harness-unavailable" : "synthetic-tool-harness-non-error";
      return { content: [{ type: "text" as const, text: "Synthetic tool harness unavailable." }], isError: true };
    }
  });
  /** PreToolUse precedes approval rules. A deny remains effective even if a tool was preapproved. */
  const check = (input: Pick<PreToolUseHookInput, "tool_name" | "tool_input">) => {
    if (policy !== "none" && input.tool_name === allowedName && schema.safeParse(input.tool_input).success)
      return { continue: true };
    // This executes only the capability that the runner supplied: an unsupported attempt is
    // recorded as a synthetic denial, with no built-in or external tool ever invoked.
    try { request.invokeTool?.(input.tool_name, input.tool_input); }
    catch (error) { unavailableReason = error instanceof Error ? "synthetic-tool-harness-unavailable" : "synthetic-tool-harness-non-error"; }
    return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const,
      permissionDecisionReason: "Outside the synthetic canary tool contract." } };
  };
  const options: Pick<Options, "tools" | "allowedTools" | "mcpServers" | "strictMcpConfig" | "settingSources"
    | "skills" | "plugins" | "permissionMode" | "canUseTool" | "hooks"> = {
    tools: [], allowedTools: server ? [allowedName] : [], mcpServers: server ? { canary: server } : {},
    strictMcpConfig: true, settingSources: [], skills: [], plugins: [], permissionMode: "dontAsk",
    canUseTool: async () => ({ behavior: "deny", message: "Outside the synthetic canary tool contract." }),
    hooks: { PreToolUse: [{ hooks: [async input => input.hook_event_name === "PreToolUse" ? check(input)
      : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Unexpected tool hook." } }] }] },
  };
  return { options, server, check, unavailable: () => unavailableReason };
}
