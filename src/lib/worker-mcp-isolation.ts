import { readFileSync } from "node:fs";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerInitSummary } from "./worker-init-summary.js";

export type WorkerMcpIsolation = "repo-knowledge-only";
/** PRIMARY CONTROL: the approved repository toolkit, not a network/filesystem permission boundary. */
const REPO_TOOLS = new Set(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]);
export const ISOLATED_KNOWLEDGE_TOOL = "mcp__knowledge__rule";

/** Staged only: no caller opts in today. Pin the provider before any routing/spawn. */
export function validateWorkerMcpIsolation(args: {
  mcpIsolation?: WorkerMcpIsolation; mountProvider?: string; resumeSessionId?: string; tools?: readonly string[];
}): void {
  if (args.mcpIsolation === undefined) return;
  if (args.mcpIsolation !== "repo-knowledge-only" || args.mountProvider !== "claude" ||
      args.resumeSessionId !== undefined || !Array.isArray(args.tools) ||
      args.tools.some(name => !REPO_TOOLS.has(name) && name !== ISOLATED_KNOWLEDGE_TOOL)) {
    throw new Error("repo/knowledge isolation requires a fresh explicitly Claude-pinned spawn with a repository-only tool bound");
  }
}

/** Compose at the final SDK boundary, after egress settings. Never widen existing permissions. */
export function applyWorkerMcpIsolation(options: Options): void {
  const servers = Object.keys(options.mcpServers ?? {});
  const tools = options.tools;
  if (!Array.isArray(tools) || tools.some(name => !REPO_TOOLS.has(name) && name !== ISOLATED_KNOWLEDGE_TOOL) ||
      servers.some(name => name !== "knowledge") || options.agents !== undefined || options.toolAliases !== undefined ||
      options.resume !== undefined || options.continue === true ||
      tools.includes(ISOLATED_KNOWLEDGE_TOOL) !== servers.includes("knowledge")) {
    throw new Error("repo/knowledge isolation refuses unqualified SDK tools, servers, agents, aliases or session reuse");
  }
  const settings = typeof options.settings === "string" ? JSON.parse(readFileSync(options.settings, "utf8")) : options.settings ?? {};
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("repo/knowledge isolation requires object settings");
  }
  const allowed = new Set(tools);
  options.strictMcpConfig = true;
  options.settings = { ...settings, disableClaudeAiConnectors: true };
  options.env = { ...options.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
  options.hooks = { ...options.hooks, PreToolUse: [...(options.hooks?.PreToolUse ?? []), {
    matcher: ".*",
    hooks: [async input => {
      // No explicit allow: existing floor/settings denials still apply to approved tools.
      if (input.hook_event_name === "PreToolUse" && allowed.has(input.tool_name)) return {};
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: "Tool outside repo/knowledge worker bound" } };
    }],
  }] };
}

export interface WorkerMcpIsolationEvidence {
  policy: WorkerMcpIsolation;
  configured: true;
  inventory: "observed-only" | "unknown" | "violated";
  reason: "approved-name-inventory" | "incomplete-inventory" | "unexpected-capability" | "expected-knowledge-missing";
}

/** Name inventory is not execution/permission proof, even when complete. Missingness never means empty. */
export function workerMcpIsolationEvidence(summary: WorkerInitSummary | undefined, knowledge: boolean): WorkerMcpIsolationEvidence {
  const base = { policy: "repo-knowledge-only" as const, configured: true as const };
  if (summary?.serverNames.names.some(name => name !== "knowledge") ||
      summary?.mcpToolNames.names.some(name => name !== ISOLATED_KNOWLEDGE_TOOL || !knowledge)) {
    return { ...base, inventory: "violated", reason: "unexpected-capability" };
  }
  if (summary?.state !== "observed") return { ...base, inventory: "unknown", reason: "incomplete-inventory" };
  if (knowledge !== summary.serverNames.names.includes("knowledge") ||
      knowledge !== summary.mcpToolNames.names.includes(ISOLATED_KNOWLEDGE_TOOL)) {
    return { ...base, inventory: "violated", reason: "expected-knowledge-missing" };
  }
  return { ...base, inventory: "observed-only", reason: "approved-name-inventory" };
}
