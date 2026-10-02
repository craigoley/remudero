import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runBoundedSuite } from "./ci-parity.js";

const TASK = /^[A-Za-z][A-Za-z0-9]*-T[0-9]+[a-z]?$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
export interface OperatorMcpDeps {
  url: string;
  readToken: string;
  writeToken?: string;
  repoRoot: string;
  fetch?: typeof fetch;
  run?: (verb: string, args: string[]) => string;
  timeoutMs?: number;
}

export function createOperatorMcpServer(deps: OperatorMcpDeps): Server {
  const base = new URL(deps.url);
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > REQUEST_TIMEOUT_MS) throw new Error("invalid operator timeout");
  if (!deps.readToken || !["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error("operator MCP needs a configured HTTP origin and read-scope token");
  const tools = [
    { name: "inbox", description: "Read the current operator decision inbox, with its freshness and unavailable states.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: "ledger_grep", description: "Read the audited archive plus live ledger union using the existing bounded regex reader.", inputSchema: { type: "object", properties: { pattern: { type: "string", minLength: 1, maxLength: 200 } }, required: ["pattern"], additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: "case_file", description: "Read a task case file. Source, merge, deployment and runtime evidence remain separate.", inputSchema: { type: "object", properties: { taskId: { type: "string", pattern: TASK.source } }, required: ["taskId"], additionalProperties: false }, annotations: { readOnlyHint: true } },
    ...(deps.writeToken ? [{ name: "answer_question", description: "Record an operator answer through POST /v1/questions/answer, the console's existing low write tier. This does not approve a PR or lift a dispatch hold.", inputSchema: { type: "object", properties: { taskId: { type: "string", pattern: TASK.source }, answer: { type: "string", minLength: 1, maxLength: 16384 } }, required: ["taskId", "answer"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } }] : []),
  ];
  const server = new Server({ name: "remudero-operator", version: "1.0.0" }, { capabilities: { tools: {} } });
  const scrub = (text: string) => [deps.readToken, deps.writeToken].filter((s): s is string => !!s)
    .reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
  const request = async (path: string, token: string, payload?: unknown) => {
    const response = await (deps.fetch ?? fetch)(new URL(path, base), { method: payload === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_OUTPUT_BYTES) { await reader.cancel(); throw new Error("operator response exceeds the 1 MiB limit"); }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (!response.ok) throw new Error(`operator route refused (${response.status}): ${body}`);
    return body;
  };
  const run = deps.run ?? ((verb, args) => {
    const result = runBoundedSuite(process.execPath, ["--import", "tsx", join(deps.repoRoot, "src", "run-task.ts"), verb, ...args], {
      cwd: deps.repoRoot, env: { ...process.env, RMD_SELF_SYNC_DONE: "1" }, timeoutMs, label: `operator ${verb}` });
    if (result.timeout) throw new Error(`operator ${verb} timed out; its process group was stopped`);
    if (result.status !== 0) throw new Error(`operator ${verb} failed: ${result.error ?? result.stderr}`);
    if (Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) throw new Error("operator command exceeds the 1 MiB limit");
    return result.stdout;
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const args = params.arguments ?? {};
      let output: string;
      if (params.name === "inbox") {
        if (Object.keys(args).length) throw new Error("inbox takes no arguments");
        output = await request("/v1/inbox", deps.readToken);
      } else if (params.name === "ledger_grep") {
        if (Object.keys(args).some((key) => key !== "pattern") || typeof args.pattern !== "string" || !args.pattern || args.pattern.length > 200) throw new Error("ledger_grep needs a bounded pattern");
        output = run("ledger-grep", [args.pattern]);
      } else if (params.name === "case_file" || params.name === "answer_question") {
        if (typeof args.taskId !== "string" || !TASK.test(args.taskId) || Object.keys(args).some((key) => !["taskId", ...(params.name === "answer_question" ? ["answer"] : [])].includes(key))) throw new Error("invalid task arguments");
        if (params.name === "case_file") output = run("case-file", [args.taskId, "--json"]);
        else {
          if (!deps.writeToken) throw new Error("write tool is disabled; no write-scope token configured");
          if (typeof args.answer !== "string" || !args.answer.trim() || args.answer.length > 16_384) throw new Error("answer is required and must be at most 16384 characters");
          output = await request("/v1/questions/answer", deps.writeToken, { taskId: args.taskId, answer: args.answer });
        }
      } else throw new Error("unknown operator tool");
      return { content: [{ type: "text" as const, text: scrub(output) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: scrub(String((error as Error)?.message ?? error)).slice(0, 2048) }] };
    }
  });
  return server;
}

export async function operatorMcpCommand(args: string[], config: { root: string }, repoRoot: string,
  factory: typeof createOperatorMcpServer = createOperatorMcpServer): Promise<number> {
  if (args.some((arg) => arg !== "--enable-write")) throw new Error("usage: rmd mcp [--enable-write]; RMD_OPERATOR_MCP_URL selects the existing control-server origin");
  const tokens = JSON.parse(readFileSync(join(config.root, "state", "service-tokens.json"), "utf8"));
  if (args.includes("--enable-write") && !tokens.write) throw new Error("--enable-write needs the existing write-scope token");
  const server = factory({ url: process.env.RMD_OPERATOR_MCP_URL ?? "http://127.0.0.1:4317", readToken: tokens.read,
    ...(args.includes("--enable-write") ? { writeToken: tokens.write } : {}), repoRoot });
  await server.connect(new StdioServerTransport());
  return 0;
}
