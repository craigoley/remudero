/**
 * W1-T13238: the Inbox verb CLI (`rmd reply`, `archive`, `snooze`, `keep`) posts to the running serve's write route, as
 * the Console does, so a verb answers from serve's held plan instead of projecting the whole plan with live gh
 * in-process (400 s from the Azure host on 2026-11-16).
 * It lives outside run-task.ts so its test does not import the CLI hub (the affected-suite reach ratchet).
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { Config } from "./config.js";
import { INBOX_VERBS, inboxVerbCommand, PROPOSAL_VERDICT_SYNTAX, type InboxVerbActions, type InboxVerbName } from "./inbox-verdict-command.js";
import { mergeVerdictReceipts, readVerdictReceipts, verdictReceiptOf } from "./inbox-verdict-receipts.js";

export { proposalVerdictCommand as proposalVerdictInProcess } from "./inbox-verdict-command.js";
const inboxCliTokensPath = (root: string): string => join(root, "state", "service-tokens.json");

type ServePortResolver = (rest: string[], configPort?: number) => number;
export type InboxCliServeConfig = Pick<Config, "root" | "serve"> & { resolveServePort: ServePortResolver };

/** Share serve's port validation through the caller to keep this module out of serve's import cycle. */
export function resolveLocalServePort(rest: string[], configPort: number | undefined, resolveServePort: ServePortResolver): number {
  const envPort = process.env.RMD_SERVE_PORT;
  if (rest.includes("--port") || configPort !== undefined || !envPort) return resolveServePort(rest, configPort);
  return resolveServePort(["--port", envPort]);
}

/** W1-T13238: how long an Inbox verb waits to connect to the running serve before it runs in-process instead. */
export const INBOX_CLI_SERVE_CONNECT_MS = 2_000;

/** W1-T13238: where the running serve's write routes listen, and the write token they take. */
export interface InboxCliServeTarget { url: string; token: string }

/** Resolve one loopback address before sending the write token. */
export function inboxCliServeTarget(config: InboxCliServeConfig): InboxCliServeTarget | { reason: string } {
  let port: number;
  try {
    port = resolveLocalServePort([], config.serve?.port, config.resolveServePort);
  } catch (error) {
    // serve refuses to start on this port, so no serve listens on it: the reason makes the CLI run in-process.
    return { reason: (error as Error).message };
  }
  let write: unknown;
  try {
    write = (JSON.parse(readFileSync(inboxCliTokensPath(config.root), "utf8")) as { write?: unknown }).write;
  } catch (error) {
    return { reason: `no serve write token (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` };
  }
  if (typeof write !== "string" || !/^[0-9a-f]{64}$/.test(write)) return { reason: "no serve write token (malformed)" };
  return { url: `http://127.0.0.1:${port}`, token: write };
}

/** W1-T13238: errors that mean no serve answered the connect, so nothing was sent and in-process is safe. */
const INBOX_UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EADDRNOTAVAIL", "CONNECT_TIMEOUT"]);

function unansweredServe(url: string, reason: string): string {
  return `no serve answered at ${url} (${reason})`;
}

/**
 * W1-T13238: Inbox verb actions that POST each verb's body to the running serve's write route, as the Console does,
 * and answer with the route's status and JSON body. A serve that does not accept the connection within the connect bound
 * sent nothing, so the verb runs through `inProcess` instead, with one stderr line naming why. A failure after connection
 * never retries in-process: the route may have acted.
 */
export function serveFirstInboxActions(targetFor: () => ReturnType<typeof inboxCliServeTarget>, inProcess: () => InboxVerbActions,
  opts: { warn?: (line: string) => void; connectMs?: number } = {}): InboxVerbActions {
  const warn = opts.warn ?? ((line: string) => console.error(line));
  const connectMs = opts.connectMs ?? INBOX_CLI_SERVE_CONNECT_MS;
  const entries = INBOX_VERBS.map((spec) => [spec.name, async (body: unknown, actor: Parameters<InboxVerbActions[InboxVerbName]>[1],
    respond: Parameters<InboxVerbActions[InboxVerbName]>[2]) => {
    const target = targetFor();
    if ("reason" in target) {
      warn(`rmd ${spec.name}: ${target.reason}; running in-process`);
      return inProcess()[spec.name](body, actor, respond);
    }
    const answer = await postInboxVerb(`${target.url}${spec.path}`, target.token, body, connectMs);
    if ("unreachable" in answer) {
      warn(`rmd ${spec.name}: ${unansweredServe(target.url, answer.unreachable)}; running in-process`);
      return inProcess()[spec.name](body, actor, respond);
    }
    if ("failed" in answer) { respond(502, { error: "serve_request_failed", detail: answer.failed }); return; }
    respond(answer.status, answer.body);
  }] as const);
  return Object.fromEntries(entries) as unknown as InboxVerbActions;
}

function postInboxVerb(url: string, token: string, body: unknown, connectMs: number):
  Promise<{ status: number; body: unknown } | { unreachable: string } | { failed: string }> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    let connected = false;
    // Use a direct loopback connection even when Node's global agent is configured for a proxy.
    const req = httpRequest(url, { agent: false, method: "POST", headers: { "content-type": "application/json", "content-length": payload.length,
      authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", (error) => resolve({ failed: error.message }));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode ?? 502, body: text === "" ? {} : JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode ?? 502, body: { error: "non_json_answer", detail: text.slice(0, 2_000) } });
        }
      });
    });
    const timer = setTimeout(() => { if (!connected) req.destroy(Object.assign(new Error("connect timed out"), { code: "CONNECT_TIMEOUT" })); }, connectMs);
    req.on("socket", (socket) => {
      if (!socket.connecting) { connected = true; clearTimeout(timer); return; }
      socket.once("connect", () => { connected = true; clearTimeout(timer); });
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const code = error.code ?? "";
      resolve(!connected && INBOX_UNREACHABLE.has(code) ? { unreachable: code } : { failed: error.message });
    });
    req.end(payload);
  });
}

/** W1-T13238: one CLI verb, serve first; build in-process actions only if the verb falls back. */
export function inboxVerbViaServe(name: InboxVerbName, args: string[], config: InboxCliServeConfig,
  inProcess: () => InboxVerbActions): Promise<number> {
  return inboxVerbCommand(name, args, serveFirstInboxActions(() => inboxCliServeTarget(config), inProcess));
}

/** W1-T13238: the receipt `rmd decline` and `rmd restore` print once the verdict is recorded (proposalVerdictCommand's). */
export function proposalVerdictReceipt(kind: "decline" | "restore", proposalId: string): string {
  return kind === "decline"
    ? `rmd decline: ${proposalId} DECLINED — take it back with ${PROPOSAL_VERDICT_SYNTAX.restore.replace("<proposalId>", proposalId)}`
    : `rmd restore: ${proposalId} RESTORED — it is back in the inbox and classifies as it would have before the decline`;
}

/** A legacy verdict can check the listener with a TCP connection alone. */
function inboxServeConnectionError(url: string, connectMs: number): Promise<string | undefined> {
  const address = new URL(url);
  return new Promise((resolve) => {
    const socket = createConnection({ host: address.hostname, port: Number(address.port || 80) });
    const timer = setTimeout(() => finish("CONNECT_TIMEOUT"), connectMs);
    function finish(reason?: string): void {
      clearTimeout(timer);
      socket.destroy();
      resolve(reason);
    }
    socket.once("connect", () => finish());
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? error.message));
  });
}

/**
 * W1-T13238: `rmd decline` and `rmd restore`, serve first. The verdict posts to the running serve's route, and the CLI
 * prints exactly what the in-process command prints: the receipt on success, the route's detail on a refusal. Arguments
 * the route would not take, no serve target or no serve answering the connect run `inProcess`, which validates and acts.
 */
export async function proposalVerdictViaServe(kind: "decline" | "restore", rest: string[], config: InboxCliServeConfig,
  inProcess: () => number, opts: { connectMs?: number; legacyVerdict?: (proposalId: string) => boolean } = {}): Promise<number> {
  const proposalId = rest[0];
  const reason = rest.length === 3 && rest[1] === "--reason" ? rest[2] : undefined;
  // Arguments the HTTP route rejects stay with the original terminal parser.
  if (proposalId === undefined || proposalId.trim() === "" || proposalId.startsWith("--") || reason === undefined || reason.trim() === "") return inProcess();
  const target = inboxCliServeTarget(config);
  if ("reason" in target) {
    console.error(`rmd ${kind}: ${target.reason}; running in-process`);
    return inProcess();
  }
  const connectMs = opts.connectMs ?? INBOX_CLI_SERVE_CONNECT_MS;
  if (opts.legacyVerdict?.(proposalId)) {
    const error = await inboxServeConnectionError(target.url, connectMs);
    if (error !== undefined) console.error(`rmd ${kind}: ${unansweredServe(target.url, error)}; running in-process`);
    return inProcess();
  }
  const spec = INBOX_VERBS.find((verb) => verb.name === kind)!;
  const answer = await postInboxVerb(`${target.url}${spec.path}`, target.token, { proposalId, reason }, connectMs);
  if ("unreachable" in answer) {
    console.error(`rmd ${kind}: ${unansweredServe(target.url, answer.unreachable)}; running in-process`);
    return inProcess();
  }
  if ("failed" in answer) { console.error(`rmd ${kind}: serve request failed: ${answer.failed}`); return 1; }
  if (answer.status >= 200 && answer.status < 300) { console.log(proposalVerdictReceipt(kind, proposalId)); return 0; }
  const refusal = answer.body as { detail?: unknown; error?: unknown } | undefined;
  // Serve's informational guard answers before recording a verdict. An explicit terminal verdict
  // uses the legacy local decision in that case, whether or not serve was reachable.
  if (answer.status === 409 && refusal?.error === "informational_only") return inProcess();
  const detail = refusal?.detail ?? refusal?.error;
  console.error(`rmd ${kind}: ${typeof detail === "string" ? detail : `serve answered ${answer.status}`}`);
  return 1;
}

/**
 * W1-T13238: could serve's verdict route answer this proposal differently from the in-process `rmd decline`/`restore`?
 * Serve re-opens a declined verify-human item once the observed state its decline recorded has changed (W1-T10077's
 * declineLapse, in classifyAllProposals): a later decline then records anew and exits 0, and a restore is refused as not
 * declined. The in-process verdict (loadProposalForRatify) applies no lapse, so it answers "already declined" and exits
 * 1, or restores. Telling a real lapse needs the dependencies' merge state, which is live gh, so this answers from the
 * local ledger alone: a verify-human item whose newest verdict receipt is a decline that recorded an observed state,
 * the only receipt declineLapse can lapse. A receipt that has not lapsed gives the same answer on both paths.
 */
export function verdictMayDifferOnServe(proposalId: string, ledgerRows: ReadonlyArray<Record<string, unknown>>, stateDir: string): boolean {
  if (!/^verify-human:[A-Za-z0-9-]+$/.test(proposalId)) return false;
  const receipts = mergeVerdictReceipts(readVerdictReceipts(stateDir), ledgerRows.flatMap((row) => verdictReceiptOf(row) ?? []));
  const newest = receipts.findLast((receipt) => receipt.task_id === proposalId);
  return newest?.step === "panel.proposal_declined" && newest.observed_state !== undefined;
}

