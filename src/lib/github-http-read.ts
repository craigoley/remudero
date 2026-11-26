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
 *
 * W1-T12839: a read handed an `identity` is conditional. GitHub does not count a 304 Not Modified
 * against the primary rate limit, and most of the fleet's polls are answered unchanged. The store is
 * keyed by identity, origin and path, so an answer is served only to the request that stored it.
 *
 * W1-T12892: a `--paginate` read is sent page by page. Each page is one conditional read under its
 * own path and query, and the next page is the `rel="next"` Link of the answer this read returned.
 */
import { STATUS_CODES } from "node:http";

import { loopAvailableDeadline, systemClock } from "./clock.js";
import { LIVE_WRITE_SENTINEL_TOKEN, LiveWriteBlockedError } from "./live-write-guard.js";
import { LoopBoundedChildTimeout } from "./loop-bounded-child.js";

/** The host gh reads from when no `--hostname` or GH_HOST names another. */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/** PRIMARY CONTROL: the same ceiling a `gh` child gets (DEFAULT_GH_CALL_TIMEOUT_MS), counted in loop-available time. */
export const GITHUB_HTTP_READ_TIMEOUT_MS = 60_000;

/** One `gh api <path>` read this client can send. `args` is the argv gh would have received. */
export interface GithubHttpReadRequest {
  args: readonly string[];
  path: string;
  include: boolean;
  /** W1-T12892: `--paginate`, sent by {@link githubHttpPagedRead}. */
  paginate?: true;
}

export interface GithubHttpReadResponse {
  status: number;
  statusText: string;
  /** Lower-case names, as fetch gives them. */
  headers: Array<[string, string]>;
  body: string;
  /** W1-T14892: true when GitHub answered 304 and this is the stored answer, so the read cost no budget. */
  notModified?: true;
}

/**
 * BACKSTOP: the bytes the conditional-read store holds before it evicts the least recently used
 * entry. The fleet polls a few hundred distinct paths, most answers under 100 KB, so this fires
 * only when far more paths or far larger answers arrive than that.
 */
export const GITHUB_HTTP_READ_STORE_MAX_BYTES = 32 * 1024 * 1024;

/** BACKSTOP: an answer larger than this is never stored, so one page cannot take most of the store. */
export const GITHUB_HTTP_READ_ENTRY_MAX_BYTES = 2 * 1024 * 1024;

/** One stored answer: the validator GitHub sent and the response it validates. */
interface StoredRead {
  etag: string;
  response: GithubHttpReadResponse;
  bytes: number;
}

let origin = GITHUB_API_ORIGIN;
let storeMaxBytes = GITHUB_HTTP_READ_STORE_MAX_BYTES;
let entryMaxBytes = GITHUB_HTTP_READ_ENTRY_MAX_BYTES;
/** Oldest use first: a hit is re-inserted, so eviction takes the first key. */
const store = new Map<string, StoredRead>();
let storeBytes = 0;
/** W1-T12892: reads sent with If-None-Match, and the 304s that answered them, since the last take. */
const conditionalCounts = { sent: 0, not_modified: 0 };

/** The conditional counts since the previous call, then reset; the daemon.quota row carries them. */
export function takeGithubHttpReadConditionalTally(): { sent: number; not_modified: number } {
  const tally = { ...conditionalCounts };
  conditionalCounts.sent = 0;
  conditionalCounts.not_modified = 0;
  return tally;
}

/**
 * Point the client at another origin, for a test's own local server. `undefined` restores GitHub.
 * A test may also shrink the store's bounds. The stored answers are kept: each is keyed by its origin.
 */
export function configureGithubHttpRead(opts: { origin?: string; storeMaxBytes?: number; entryMaxBytes?: number } | undefined): void {
  origin = opts?.origin ?? GITHUB_API_ORIGIN;
  storeMaxBytes = opts?.storeMaxBytes ?? GITHUB_HTTP_READ_STORE_MAX_BYTES;
  entryMaxBytes = opts?.entryMaxBytes ?? GITHUB_HTTP_READ_ENTRY_MAX_BYTES;
}

/** Empty the store, for a test that measures it from nothing. */
export function resetGithubHttpReadStore(): void {
  store.clear();
  storeBytes = 0;
}

/** The bytes the store holds now, for a test's assertion on the bound. */
export function githubHttpReadStoredBytes(): number {
  return storeBytes;
}

function dropStored(key: string): void {
  const entry = store.get(key);
  if (entry === undefined) return;
  store.delete(key);
  storeBytes -= entry.bytes;
}

/** Store a 200 that carries an ETag, evicting the least recently used entries until it fits. */
function storeRead(key: string, response: GithubHttpReadResponse): void {
  dropStored(key);
  const etag = response.headers.find(([name]) => name === "etag")?.[1];
  if (etag === undefined || etag === "") return;
  const bytes = Buffer.byteLength(response.body) + response.headers.reduce((n, [name, value]) => n + name.length + value.length, 0);
  if (bytes > entryMaxBytes || bytes > storeMaxBytes) return;
  for (const [oldest] of store) {
    if (storeBytes + bytes <= storeMaxBytes) break;
    dropStored(oldest);
  }
  store.set(key, { etag, response, bytes });
  storeBytes += bytes;
}

/** The stored answer with the 304's own rate-limit headers, so the caller reads the freshest reading. */
function revalidated(entry: StoredRead, notModified: Array<[string, string]>): GithubHttpReadResponse {
  const isRate = (name: string): boolean => name.startsWith("x-ratelimit-");
  return {
    ...entry.response,
    headers: [...entry.response.headers.filter(([name]) => !isRate(name)), ...notModified.filter(([name]) => isRate(name))],
    notModified: true,
  };
}

/** True when a caller pointed the client at an origin of its own. */
export function githubHttpReadConfigured(): boolean {
  return origin !== GITHUB_API_ORIGIN;
}

/**
 * The read in `args`, or `undefined` for any form this client does not send. It sends only
 * `api <path>` with `-i`/`--include`, `--paginate` and an optional GET method. Any other flag means
 * gh must run: fields, `--input`, `--slurp`, `--jq`, `--template`, `--hostname`, headers and the rest.
 */
export function parseGhApiRead(args: readonly string[]): GithubHttpReadRequest | undefined {
  if (args[0] !== "api") return undefined;
  let path: string | undefined;
  let include = false;
  let paginate = false;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-i" || arg === "--include") include = true;
    else if (arg === "--paginate") paginate = true;
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
  return { args, path: path.replace(/^\/+/, ""), include, ...(paginate ? { paginate: true } : {}) };
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
 *
 * W1-T12839: with `opts.identity` (the credential's stable identity, never its token) the read is
 * conditional. A stored answer's ETag is sent as If-None-Match, and a 304 returns that answer with
 * the 304's rate-limit headers. A 200 replaces the entry; any other status, a failed send and a
 * timeout drop it.
 */
export async function githubHttpRead(
  read: GithubHttpReadRequest,
  token: string,
  opts: { timeoutMs?: number; identity?: string } = {},
): Promise<GithubHttpReadResponse> {
  if (token === LIVE_WRITE_SENTINEL_TOKEN) {
    throw new LiveWriteBlockedError("gh-transport", `\`gh ${read.args.slice(0, 4).join(" ")}\` carries the test-runner sentinel token ` +
      `(W1-T4805, W1-T12531: the in-process client cannot reach live GitHub either; point it at a local server with configureGithubHttpRead)`);
  }
  if (token === "") throw new Error(`\`gh ${read.args.slice(0, 2).join(" ")}\`: the in-process client was handed no token (W1-T12531)`);
  const timeoutMs = opts.timeoutMs ?? GITHUB_HTTP_READ_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const key = opts.identity === undefined ? undefined : JSON.stringify([opts.identity, origin, read.path]);
  const stored = key === undefined ? undefined : store.get(key);
  const cancel = loopAvailableDeadline(systemClock, timeoutMs, () => { timedOut = true; controller.abort(); });
  if (stored !== undefined) conditionalCounts.sent += 1;
  try {
    const response = await fetch(`${origin}/${read.path}`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json", "User-Agent": "remudero", Authorization: `token ${token}`,
        ...(stored === undefined ? {} : { "If-None-Match": stored.etag }),
      },
      signal: controller.signal,
    });
    const body = await response.text();
    const answer = { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body };
    if (key === undefined) return answer;
    // The 304 validates the answer this request sent the ETag of; a concurrent read may since have
    // replaced or dropped the entry, and then the store is left as that read left it.
    if (response.status === 304 && stored !== undefined) {
      conditionalCounts.not_modified += 1;
      if (store.get(key) === stored) {
        store.delete(key);
        store.set(key, stored);
      }
      return revalidated(stored, answer.headers);
    }
    if (response.status === 200) storeRead(key, answer);
    else dropStored(key);
    return answer;
  } catch (err) {
    if (key !== undefined) dropStored(key);
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

/** gh's own Link pattern (findNextPage): the first `rel="next"` URL, or none on the last page. */
const LINK_PATTERN = /<([^>]+)>;\s*rel="([^"]+)"/g;

function nextPageUrl(response: GithubHttpReadResponse): string | undefined {
  const link = response.headers.find(([name]) => name === "link")?.[1] ?? "";
  for (const match of link.matchAll(LINK_PATTERN)) if (match[2] === "next") return match[1];
  return undefined;
}

/**
 * W1-T12892: send a `--paginate` read page by page, and return what gh prints for those pages: each
 * page's body in turn, and with `-i` each page's header block before its body and a newline between
 * pages. INVARIANT never-a-stale-page: the next page is the Link of the answer this read returned,
 * stored (a 304 to this page's own ETag) or new, never an older chain. `beforePage` runs before every
 * page after the first and `afterPage` after every page, so each page is claimed and recorded as one
 * read. A non-2xx page throws the error gh exits with, its stdout every page printed so far.
 */
export async function githubHttpPagedRead(
  read: GithubHttpReadRequest,
  token: string,
  opts: { timeoutMs?: number; identity?: string; beforePage(): Promise<void>; afterPage(response: GithubHttpReadResponse): void },
): Promise<string> {
  let stdout = "";
  let path: string | undefined = read.path;
  while (path !== undefined) {
    const response = await githubHttpRead({ ...read, path }, token, opts);
    opts.afterPage(response);
    stdout += `${read.include ? ghIncludeHeaderBlock(response) : ""}${response.body}`;
    if (response.status < 200 || response.status >= 300) {
      throw ghExecError(read.args, stdout, `gh: ${ghApiServerError(response.status, response.body)}\n`);
    }
    const next = nextPageUrl(response);
    if (next === undefined) break;
    // gh sends its token only to its own host; this client sends it nowhere else either.
    if (!next.startsWith(`${origin}/`)) {
      throw ghExecError(read.args, stdout, `gh: in-process paged read was given a next page on another host: ${URL.canParse(next) ? new URL(next).host : "unreadable"}\n`);
    }
    path = next.slice(origin.length + 1);
    if (read.include) stdout += "\n";
    await opts.beforePage();
  }
  return stdout;
}
