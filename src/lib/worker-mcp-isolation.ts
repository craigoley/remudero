import { readFileSync } from "node:fs";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerInitSummary } from "./worker-init-summary.js";

export type WorkerMcpIsolation = "repo-knowledge-only";
export interface WorkerPluginInventory {
  state: "observed" | "unknown";
  plugins: string[] | null;
  skills: string[] | null;
  agents: string[] | null;
  plugin_error_count: number | null;
}

/** Census only: incomplete evidence stays unknown, with any safely observed names retained. */
export function workerPluginInventory(summary: WorkerInitSummary | undefined): WorkerPluginInventory {
  const evidence = [summary?.pluginNames, summary?.skillNames, summary?.agentNames];
  const names = evidence.map(entry => entry && entry.state !== "unavailable" ? entry.names : null);
  return { state: evidence.every(entry => entry?.state === "observed") ? "observed" : "unknown",
    plugins: names[0], skills: names[1], agents: names[2], plugin_error_count: summary?.pluginErrorCount ?? null };
}

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
  // Preserve the shared child-env object: the collector records keys from this same object.
  options.env ??= {};
  options.env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
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
  /** The worker's own result subtype, kept when an unknown or violated inventory denies success credit (W1-T9573). */
  original_subtype?: string;
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

/**
 * W1-T9489: THE MCP BOUNDARY EVERY CLAUDE SPAWN GETS, not only the #11666 opt-in above. Before it, every fix, implement,
 * review and recon worker ran under bypassPermissions with all eight `mcp__claude_ai_Claude_Docs__*` tools, because the
 * CLI attaches the fleet account's claude.ai connectors to any session that is not strict (120 ledger rows, 2026-10-13/14).
 */
export const WORKER_MCP_STRICT = "strict" as const;
/** The tool-name prefix every claude.ai account connector is offered under ("claude.ai X" normalizes to `claude_ai_X`). */
export const ACCOUNT_CONNECTOR_TOOL_PREFIX = "mcp__claude_ai_";
/**
 * Defence in depth beside strictMcpConfig. Server-level entries, one per known connector, because the pinned CLI (2.1.293,
 * SDK 0.3.293) matches a server-level deny by EXACT server name: `mcp__claude_ai_*` parses as the server `claude_ai_*`,
 * which names no server, so that spelling would be a silent no-op (its agent() validator says "server names take no
 * wildcard"). strictMcpConfig is the control that stops ANY connector loading; a connector missing from this list is
 * still caught by {@link workerMcpExposure} after the run.
 */
export const ACCOUNT_CONNECTOR_DENY: readonly string[] = [
  "mcp__claude_ai_Claude_Docs",
  "mcp__claude_ai_Gmail",
  "mcp__claude_ai_Google_Calendar",
  "mcp__claude_ai_Google_Drive",
  "mcp__claude_ai_Vercel",
];

/** Apply the boundary to a spawn's final options: strict MCP config with an explicit server map (whatever the spawn
 * already declared, else none) and the connector denies MERGED with any caller list, never replacing it. Returns the
 * server names the spawn may legitimately report, for {@link workerMcpExposure}. */
export function applyWorkerMcpBoundary(options: Options): string[] {
  options.strictMcpConfig = true;
  options.mcpServers = { ...options.mcpServers };
  options.disallowedTools = [...new Set([...(options.disallowedTools ?? []), ...ACCOUNT_CONNECTOR_DENY])];
  return Object.keys(options.mcpServers);
}

/** The same boundary for the control-only usage probe, which declares no server of its own. */
export function workerMcpProbeBoundary(): Pick<Options, "strictMcpConfig" | "mcpServers"> {
  return { strictMcpConfig: true, mcpServers: {} };
}

export interface WorkerMcpExposure {
  /** `exposed`: the inventory names a capability outside the boundary. `unknown`: no complete inventory to judge. */
  state: "exposed" | "unknown";
  /** MCP tools offered from outside the spawn's own servers (every `mcp__claude_ai_*` tool is one). */
  tools: string[];
  /** Server names outside the spawn's own `mcpServers` keys. */
  servers: string[];
  /** Server entries the init summary could not render. "claude.ai Claude Docs" is one: it has spaces, so it never
   * reaches `serverNames.names` and only this count shows it. */
  rejected_server_entries: number;
  /** The worker's own result subtype, kept when an exposure replaces it. */
  original_subtype?: string;
}

/** Judge one Claude spawn's init inventory against its own server map. `undefined` means observed and clean; a missing,
 * partial or truncated inventory is `unknown`, never clean. */
export function workerMcpExposure(summary: WorkerInitSummary | undefined, allowedServers: readonly string[]): WorkerMcpExposure | undefined {
  const allowed = new Set(allowedServers);
  const tools = (summary?.mcpToolNames.names ?? []).filter(name =>
    name.startsWith(ACCOUNT_CONNECTOR_TOOL_PREFIX) || !allowed.has(name.split("__")[1] ?? ""));
  const servers = (summary?.serverNames.names ?? []).filter(name => !allowed.has(name));
  const rejected = summary?.serverNames.rejectedEntries ?? 0;
  if (tools.length > 0 || servers.length > 0 || rejected > 0) {
    return { state: "exposed", tools, servers, rejected_server_entries: rejected };
  }
  if (summary?.state !== "observed") return { state: "unknown", tools: [], servers: [], rejected_server_entries: 0 };
  return undefined;
}

/** The subtype a run takes when an MCP rule denies it success credit. */
export const MCP_DENIED_SUBTYPE = "error_mcp_exposure" as const;

/**
 * W1-T9573: THE ONE RULE both MCP denials share — the opt-in isolation's unknown/violated inventory and the default
 * boundary's exposure. `isError` alone is not enough: run-task grades `{isError: true, subtype: "success"}` as clean, so
 * the subtype moves too, and the worker's own subtype is kept on `evidence`. When a second denial fires on one run, it
 * records the FIRST denial's `original_subtype`, never `error_mcp_exposure`.
 */
export function denyMcpSuccessCredit(
  result: { isError: boolean; subtype: string; mcpIsolation?: { original_subtype?: string } },
  evidence: { original_subtype?: string },
): void {
  evidence.original_subtype = result.subtype === MCP_DENIED_SUBTYPE
    ? result.mcpIsolation?.original_subtype ?? result.subtype : result.subtype;
  result.isError = true;
  result.subtype = MCP_DENIED_SUBTYPE;
}
