/**
 * W1-T12531: one shared in-process client for the daemon's `gh api <path>` reads.
 *
 * Measured by the operator session on the Azure host, 2026-11-13: 5-7 `gh` processes ran at once and
 * took about 2 cores between them. Each read paid a new process, its config read and a new TLS
 * connection. This client sends the same GET through node's fetch, whose shared pool keeps the
 * connection alive between reads.
 *
 * It answers in gh's own shapes, so nothing above the transport can tell the two apart. With `-i`
 * the stdout starts with the header block gh prints. A non-2xx response throws the error an
 * `execFile` of `gh` throws, with gh's `gh: <message> (HTTP <status>)` stderr line.
 *
 * This module sits below the ledger and the config. It imports neither. The transport picks the
 * token with resolveGithubCredential and hands it in.
 */
import { STATUS_CODES } from "node:http";

import { loopAvailableDeadline, systemClock } from "./clock.js";
import { LIVE_WRITE_SENTINEL_TOKEN, LiveWriteBlockedError } from "./live-write-guard.js";
import { LoopBoundedChildTimeout } from "./loop-bounded-child.js";

/** The host gh reads from when no `--hostname` or GH_HOST names another. */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/** The same ceiling a `gh` child gets (DEFAULT_GH_CALL_TIMEOUT_MS). It counts loop-available time only. */
export const GITHUB_HTTP_READ_TIMEOUT_MS = 60_000;

/** One `gh api <path>` read this client can send. `args` is the argv gh would have received. */
export interface GithubHttpReadRequest {
  args: readonly string[];
  path: string;
  include: boolean;
}

export interface GithubHttpReadResponse {
  status: number;
  statusText: string;
  /** Lower-case names, as fetch gives them. */
  headers: Array<[string, string]>;
  body: string;
}

let origin = GITHUB_API_ORIGIN;

/** Point the client at another origin, for a test's own local server. `undefined` restores GitHub. */
export function configureGithubHttpRead(opts: { origin?: string } | undefined): void {
  origin = opts?.origin ?? GITHUB_API_ORIGIN;
}

/** True when a caller pointed the client at an origin of its own. */
export function githubHttpReadConfigured(): boolean {
  return origin !== GITHUB_API_ORIGIN;
}

/**
 * The read in `args`, or `undefined` for any form this client does not send. It sends only
 * `api <path>` with `-i`/`--include` and an optional GET method. Any other flag means gh must run:
 * fields, `--input`, `--paginate`, `--slurp`, `--jq`, `--template`, `--hostname`, headers and the rest.
 */
export function parseGhApiRead(args: readonly string[]): GithubHttpReadRequest | undefined {
  if (args[0] !== "api") return undefined;
  let path: string | undefined;
  let include = false;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-i" || arg === "--include") include = true;
    else if (arg === "-X" || arg === "--method") {
      if (args[i + 1] !== "GET") return undefined;
      i += 1;
    } else if (arg === "-XGET" || arg === "--method=GET") continue;
    else if (arg.startsWith("-") || path !== undefined) return undefined;
    else path = arg;
  }
  // graphql is a POST; a full URL, gh's {owner} placeholders and an empty path are gh's to resolve.
  if (path === undefined || path === "" || /^\/?graphql(?:[?/]|$)/.test(path) || path.includes("://") || /[{}\s]/.test(path)) {
    return undefined;
  }
  return { args, path: path.replace(/^\/+/, ""), include };
}

/** An error shaped like the one `execFile("gh", …)` rejects with, which every caller already reads. */
function ghExecError(args: readonly string[], stdout: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: gh ${args.join(" ")}\n${stderr}`), {
    code: 1, killed: false, signal: null, cmd: `gh ${args.join(" ")}`, stdout, stderr,
  });
}

/**
 * Send one read with `token`. A token that is the test-runner sentinel is refused, as
 * refuseSentinelGhToken refuses it. A request that fails to send rejects with the gh-shaped error,
 * its stderr naming the network cause, so classifyGhFailure reads it as a transport failure.
 */
export async function githubHttpRead(
  read: GithubHttpReadRequest,
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<GithubHttpReadResponse> {
  if (token === LIVE_WRITE_SENTINEL_TOKEN) {
    throw new LiveWriteBlockedError("gh-transport", `\`gh ${read.args.slice(0, 4).join(" ")}\` carries the test-runner sentinel token ` +
      `(W1-T4805, W1-T12531: the in-process client cannot reach live GitHub either; point it at a local server with configureGithubHttpRead)`);
  }
  if (token === "") throw new Error(`\`gh ${read.args.slice(0, 2).join(" ")}\`: the in-process client was handed no token (W1-T12531)`);
  const timeoutMs = opts.timeoutMs ?? GITHUB_HTTP_READ_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const cancel = loopAvailableDeadline(systemClock, timeoutMs, () => { timedOut = true; controller.abort(); });
  try {
    const response = await fetch(`${origin}/${read.path}`, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "remudero", Authorization: `token ${token}` },
      signal: controller.signal,
    });
    const body = await response.text();
    return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body };
  } catch (err) {
    if (timedOut) throw new LoopBoundedChildTimeout(`gh ${read.args.join(" ")}`, timeoutMs);
    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    const detail = cause === undefined ? String((err as Error).message) : `${String(cause.code ?? "")} ${String(cause.message ?? "")}`.trim();
    throw ghExecError(read.args, "", `gh: in-process read failed to reach GitHub: ${detail}\n`);
  } finally {
    cancel();
  }
}

/** A header name as Go's net/http prints it, so the block reads as gh's own. */
function canonicalHeaderName(name: string): string {
  return name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join("-");
}

/** The header block `gh api -i` prints before the body: status line, sorted headers, a blank line. */
export function ghIncludeHeaderBlock(response: GithubHttpReadResponse): string {
  const lines = response.headers.map(([name, value]) => `${canonicalHeaderName(name)}: ${value}`).sort();
  const text = response.statusText || STATUS_CODES[response.status] || "";
  return `HTTP/1.1 ${response.status}${text === "" ? "" : ` ${text}`}\r\n${lines.map((line) => `${line}\r\n`).join("")}\r\n`;
}

/** The message gh prints after `gh: ` for a non-2xx response, read from the error body as gh reads it. */
export function ghApiServerError(status: number, body: string): string {
  let parsed: { message?: unknown; errors?: unknown } | undefined;
  try {
    parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
  } catch {
    // A body that is not JSON carries no message; gh then prints the status alone, as below.
    parsed = undefined;
  }
  if (typeof parsed?.message === "string" && parsed.message !== "") return `${parsed.message} (HTTP ${status})`;
  const errors = Array.isArray(parsed?.errors)
    ? parsed.errors.map((e: unknown) => (typeof e === "string" ? e : (e as { message?: unknown } | null)?.message)).filter((m): m is string => typeof m === "string" && m !== "")
    : [];
  return errors.length > 0 ? errors.join("\n") : `HTTP ${status}`;
}

/**
 * What `gh` would have written to stdout for this response, or the error it would have exited
 * with. A rate-limit refusal keeps its header block in the error's stdout, where the transport's
 * noteInstallationRefusal reads the reading from, and its message in stderr, where isGhRateLimitError looks.
 */
export function ghStdoutOfHttpRead(read: GithubHttpReadRequest, response: GithubHttpReadResponse): string {
  const stdout = `${read.include ? ghIncludeHeaderBlock(response) : ""}${response.body}`;
  if (response.status >= 200 && response.status < 300) return stdout;
  throw ghExecError(read.args, stdout, `gh: ${ghApiServerError(response.status, response.body)}\n`);
}
