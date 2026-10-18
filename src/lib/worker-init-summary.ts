/** Bounded, name-only SDK init evidence; never persist the raw credential/configuration envelope. */
export interface InitNameEvidence {
  state: "observed" | "partial" | "unavailable";
  names: string[];
  inputEntries: number | null;
  inspectedEntries: number;
  rejectedEntries: number;
  truncated: boolean;
}

export interface WorkerInitSummary {
  schema: "sdk-init-summary-v1";
  state: "observed" | "partial" | "unavailable" | "not-applicable";
  source: "claude-sdk-system-init" | null;
  serverNames: InitNameEvidence;
  mcpToolNames: InitNameEvidence;
  pluginNames: InitNameEvidence;
  skillNames: InitNameEvidence;
  agentNames: InitNameEvidence;
  pluginErrorCount: number | null;
}

/** PRIMARY CONTROL: bound parser work; exceeding this reports partial inventory, never a worker failure. */
export const INIT_INSPECTION_LIMIT = 256;
/** PRIMARY CONTROL: bounded retained server identifiers, not a limit on configured servers. */
export const INIT_SERVER_NAME_LIMIT = 16;
/** PRIMARY CONTROL: bounded retained MCP tool identifiers, not a tool-admission limit. */
export const INIT_TOOL_NAME_LIMIT = 32;

function unavailableNames(): InitNameEvidence {
  return { state: "unavailable", names: [], inputEntries: null, inspectedEntries: 0,
    rejectedEntries: 0, truncated: false };
}

/** Legacy/unsupported runs say unavailable, not a measured empty list of connections. */
export function unavailableWorkerInitSummary(notApplicable = false): WorkerInitSummary {
  return { schema: "sdk-init-summary-v1", state: notApplicable ? "not-applicable" : "unavailable", source: null,
    serverNames: unavailableNames(), mcpToolNames: unavailableNames(), pluginNames: unavailableNames(),
    skillNames: unavailableNames(), agentNames: unavailableNames(), pluginErrorCount: null };
}

function safeNameAtom(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) &&
    !/^(?:sk[-_]|gh[pousr]_|github_pat_|eyJ)/i.test(value) && !/[A-Za-z0-9]{32,}/.test(value);
}

function nameEvidence(input: unknown, kind: "servers" | "tools" | "plugins" | "names"): InitNameEvidence {
  if (!Array.isArray(input)) return unavailableNames();
  const limit = kind === "servers" ? INIT_SERVER_NAME_LIMIT : INIT_TOOL_NAME_LIMIT;
  const names = new Set<string>();
  const inspectedEntries = Math.min(input.length, INIT_INSPECTION_LIMIT);
  let rejectedEntries = 0;
  let truncated = input.length > inspectedEntries;
  for (let index = 0; index < inspectedEntries; index++) {
    const item: unknown = input[index];
    const name = kind === "plugins"
      ? item !== null && typeof item === "object" ? (item as { name?: unknown }).name : undefined
      : kind === "servers" && item !== null && typeof item === "object" ? (item as { name?: unknown }).name : item;
    if (kind === "tools" && typeof name === "string" && !name.startsWith("mcp__")) {
      // Normal built-in tool names are not MCP inventory; malformed/secret-like values still make coverage partial.
      if (!safeNameAtom(name)) rejectedEntries++;
      continue;
    }
    const valid = kind === "servers" ? safeNameAtom(name) : kind !== "tools"
      ? typeof name === "string" && name.length <= 128 && name.split(/[:@]/).every(safeNameAtom)
      : typeof name === "string" && name.length <= 128 &&
      name.split("__").length === 3 && name.split("__")[0] === "mcp" &&
      safeNameAtom(name.split("__")[1]) && safeNameAtom(name.split("__")[2]);
    if (!valid) { rejectedEntries++; continue; }
    if (names.has(name as string)) continue;
    if (names.size >= limit) { truncated = true; continue; }
    names.add(name as string);
  }
  return { state: rejectedEntries || truncated ? "partial" : "observed", names: [...names],
    inputEntries: input.length, inspectedEntries, rejectedEntries, truncated };
}

/** Only system/init can be evidence. A missing field remains unknown; [] is observed only when supplied. */
export function workerInitSummaryFromMessage(raw: unknown): WorkerInitSummary | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const msg = raw as { type?: unknown; subtype?: unknown; mcp_servers?: unknown; tools?: unknown;
    plugins?: unknown; skills?: unknown; agents?: unknown; plugin_errors?: unknown };
  if (msg.type !== "system" || msg.subtype !== "init") return undefined;
  const serverNames = nameEvidence(msg.mcp_servers, "servers");
  const mcpToolNames = nameEvidence(msg.tools, "tools");
  const pluginNames = nameEvidence(msg.plugins, "plugins");
  const skillNames = nameEvidence(msg.skills, "names");
  const agentNames = nameEvidence(msg.agents, "names");
  return { schema: "sdk-init-summary-v1", source: "claude-sdk-system-init",
    // MCP admission reads this state; the separate plugin census must never change it.
    state: serverNames.state === "observed" && mcpToolNames.state === "observed" ? "observed" : "partial",
    serverNames, mcpToolNames, pluginNames, skillNames, agentNames,
    pluginErrorCount: Array.isArray(msg.plugin_errors) ? msg.plugin_errors.length : null };
}
