/**
 * W1-T13238: the Inbox verb CLI (`rmd reply`, `archive`, `snooze`, `keep`) posts to the running serve's write route, as
 * the Console does, so a verb answers from serve's held plan instead of projecting the whole plan with live gh
 * in-process (400 s from the Azure host on 2026-11-16). In-process runs only when no serve accepts the connection.
 * It lives outside run-task.ts so its test does not import the CLI hub (the affected-suite reach ratchet).
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { Config } from "./config.js";
import { RmdError } from "./errors.js";
import type { InboxClassification } from "./inbox.js";
import { isAgeOnlyInboxInformation, type InboxOwnershipEvidence } from "./inbox-owner.js";
import { INBOX_VERBS, inboxVerbCommand, PROPOSAL_VERDICT_SYNTAX, proposalVerdictCommand, type InboxVerbActions, type InboxVerbName } from "./inbox-verdict-command.js";

/** serve.ts's DEFAULT_SERVE_PORT and serviceTokensPath, restated so this CLI stays out of serve's import cycle. */
export const INBOX_CLI_DEFAULT_SERVE_PORT = 4317;
const inboxCliTokensPath = (root: string): string => join(root, "state", "service-tokens.json");

/** W1-T13238: how long an Inbox verb waits to connect to the running serve before it runs in-process instead. */
export const INBOX_CLI_SERVE_CONNECT_MS = 2_000;

/** W1-T13238: where the running serve's write routes listen, and the write token they take. `alternates` are tried in
 *  order when `url` refuses the connection. */
export interface InboxCliServeTarget { url: string; token: string; alternates?: string[] }

const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65_535;

/**
 * The local write endpoint uses the launcher override, then the configured port, or serve's default.
 * `rmd serve` itself binds the configured port unless the launcher passes RMD_SERVE_PORT as --port, so with both set
 * the CLI tries the override first and the configured port second.
 * The CLI only reads the existing write token, and keeps it out of diagnostics.
 */
export function inboxCliServeTarget(config: Pick<Config, "root" | "serve">): InboxCliServeTarget | { reason: string } {
  const configured = Number(config.serve?.port || INBOX_CLI_DEFAULT_SERVE_PORT);
  const port = Number(process.env.RMD_SERVE_PORT || configured);
  if (!validPort(port)) return { reason: "serve port must be an integer 1-65535" };
  const alternates = validPort(configured) && configured !== port ? [`http://127.0.0.1:${configured}`] : [];
  let write: unknown;
  try {
    write = (JSON.parse(readFileSync(inboxCliTokensPath(config.root), "utf8")) as { write?: unknown }).write;
  } catch (error) {
    return { reason: `no serve write token (${(error as NodeJS.ErrnoException).code ?? "unreadable"})` };
  }
  if (typeof write !== "string" || !/^[0-9a-f]{64}$/.test(write)) return { reason: "no serve write token (malformed)" };
  return { url: `http://127.0.0.1:${port}`, token: write, ...(alternates.length > 0 ? { alternates } : {}) };
}

/** Posts to each of the target's addresses in turn until one accepts the connection. An unreachable answer names every
 *  address tried, so the fallback line says where no serve answered. */
async function postToServe(target: InboxCliServeTarget, path: string, body: unknown, connectMs: number):
  Promise<{ status: number; body: unknown } | { unreachable: string } | { failed: string }> {
  const tried: string[] = [];
  for (const url of [target.url, ...(target.alternates ?? [])]) {
    const answer = await postInboxVerb(`${url}${path}`, target.token, body, connectMs);
    if (!("unreachable" in answer)) return answer;
    tried.push(`${url} (${answer.unreachable})`);
  }
  return { unreachable: tried.join(" or ") };
}

/** W1-T13238: errors that mean no serve answered the connect, so nothing was sent and in-process is safe. */
const INBOX_UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EADDRNOTAVAIL", "CONNECT_TIMEOUT"]);

/**
 * W1-T13238: Inbox verb actions that POST each verb's body to the running serve's write route, as the Console does,
 * and answer with the route's status and JSON body. A serve that does not accept the connection within the connect bound
 * sent nothing, so the verb runs through `inProcess` instead, with one stderr line naming why. A failure after connection
 * never retries in-process: the route may have acted.
 */
export function serveFirstInboxActions(target: InboxCliServeTarget, inProcess: () => InboxVerbActions,
  opts: { warn?: (line: string) => void; connectMs?: number } = {}): InboxVerbActions {
  const warn = opts.warn ?? ((line: string) => console.error(line));
  const connectMs = opts.connectMs ?? INBOX_CLI_SERVE_CONNECT_MS;
  const entries = INBOX_VERBS.map((spec) => [spec.name, async (body: unknown, actor: Parameters<InboxVerbActions[InboxVerbName]>[1],
    respond: Parameters<InboxVerbActions[InboxVerbName]>[2]) => {
    const answer = await postToServe(target, spec.path, body, connectMs);
    if ("unreachable" in answer) {
      warn(`rmd ${spec.name}: no serve answered at ${answer.unreachable}; running in-process`);
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
    const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", "content-length": payload.length,
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
export function inboxVerbViaServe(name: InboxVerbName, args: string[], config: Pick<Config, "root" | "serve">,
  inProcess: () => InboxVerbActions): Promise<number> {
  const target = inboxCliServeTarget(config);
  if ("reason" in target) {
    console.error(`rmd ${name}: ${target.reason}; running in-process`);
    return inboxVerbCommand(name, args, inProcess());
  }
  return inboxVerbCommand(name, args, serveFirstInboxActions(target, inProcess));
}

/** W1-T13238: the receipt `rmd decline` and `rmd restore` print once the verdict is recorded (proposalVerdictCommand's). */
export function proposalVerdictReceipt(kind: "decline" | "restore", proposalId: string): string {
  return kind === "decline"
    ? `rmd decline: ${proposalId} DECLINED — take it back with ${PROPOSAL_VERDICT_SYNTAX.restore.replace("<proposalId>", proposalId)}`
    : `rmd restore: ${proposalId} RESTORED — it is back in the inbox and classifies as it would have before the decline`;
}

/**
 * W1-T13238: `rmd decline` and `rmd restore`, serve first. The verdict posts to the running serve's route, and the CLI
 * prints exactly what the in-process command prints: the receipt on success, the route's detail on a refusal. Arguments
 * the route would not take, no serve target or no serve answering the connect run `inProcess`, which validates and acts.
 */
export async function proposalVerdictViaServe(kind: "decline" | "restore", rest: string[], config: Pick<Config, "root" | "serve">,
  inProcess: () => number, opts: { connectMs?: number } = {}): Promise<number> {
  const proposalId = rest[0];
  const reason = rest.length === 3 && rest[1] === "--reason" ? rest[2] : undefined;
  // Anything but `<id> --reason <text>` is the in-process command's to refuse with its own usage line.
  if (!proposalId || proposalId.startsWith("--") || reason === undefined || reason.trim() === "") return inProcess();
  const target = inboxCliServeTarget(config);
  if ("reason" in target) {
    console.error(`rmd ${kind}: ${target.reason}; running in-process`);
    return inProcess();
  }
  const spec = INBOX_VERBS.find((verb) => verb.name === kind)!;
  const answer = await postToServe(target, spec.path, { proposalId, reason }, opts.connectMs ?? INBOX_CLI_SERVE_CONNECT_MS);
  if ("unreachable" in answer) {
    console.error(`rmd ${kind}: no serve answered at ${answer.unreachable}; running in-process`);
    return inProcess();
  }
  if ("failed" in answer) { console.error(`rmd ${kind}: serve request failed: ${answer.failed}`); return 1; }
  if (answer.status >= 200 && answer.status < 300) { console.log(proposalVerdictReceipt(kind, proposalId)); return 0; }
  const detail = (answer.body as { detail?: unknown; error?: unknown } | undefined)?.detail ?? (answer.body as { error?: unknown } | undefined)?.error;
  console.error(`rmd ${kind}: ${typeof detail === "string" ? detail : `serve answered ${answer.status}`}`);
  return 1;
}

/** W1-T13238: serve's verdict route refuses an age-only observation with this detail (panel-graph.ts's
 *  refuseInformationalProposal); restated so the in-process command answers the same without importing serve's routes. */
export const INBOX_INFORMATIONAL_ONLY_DETAIL = "This age observation is readable information, not an operator decision or work request.";

class InformationalVerdictRefused extends RmdError {
  constructor() {
    super("inbox", 1, INBOX_INFORMATIONAL_ONLY_DETAIL);
  }
}

/**
 * W1-T13238 invariant:same-answer-either-path: `rmd decline` and `rmd restore` in-process, with serve's route's guard.
 * The route refuses an age-only Inbox observation before it records a verdict, so the in-process command refuses it the
 * same way: the route's detail on stderr and exit 1, with nothing recorded. Usage errors still come first, as on serve.
 */
export function proposalVerdictInProcess(
  kind: "decline" | "restore",
  rest: string[],
  find: (proposalId: string) => { exists: boolean; classification?: InboxClassification; proposal?: InboxOwnershipEvidence },
  record: (step: string, proposalId: string, reason: string) => void,
): number {
  try {
    return proposalVerdictCommand(kind, rest, (id) => {
      const found = find(id);
      const requiresReview = found.classification?.retirement?.state === "restored_for_review";
      if (found.proposal && found.classification && isAgeOnlyInboxInformation({ ...found.proposal, requiresReview })) throw new InformationalVerdictRefused();
      return { exists: found.exists, classification: found.classification };
    }, record);
  } catch (error) {
    if (!(error instanceof InformationalVerdictRefused)) throw error;
    console.error(`rmd ${kind}: ${error.message}`);
    return error.exitCode;
  }
}
