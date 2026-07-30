import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import type { Config } from "./config.js";
import { resolveServeHosts, resolveServePort, serviceTokensPath } from "./serve.js";

/**
 * lib/console-url.ts — `rmd console-url`: get into the operator console in ONE command.
 *
 * WHY THIS EXISTS (fb-1784772988510-da3712, verbatim): "no rmd command prints the console URL with
 * its token; the operator must extract state/service-tokens.json by hand." Every write action in the
 * console — Accept, Reject, Pause, Resume, STOP, Drain now, Run, Mark handled — is inert without a
 * write token pasted into that browser tab, and W1-T202 put that token in `sessionStorage` (on XSS
 * grounds, correctly), so it dies with the tab and must be re-pasted after every restart. The console
 * says "Read-only — write actions are unavailable" and does not say where to get one. An operator
 * spent a working session with a dead console partly because of that.
 *
 * ── THE ASYMMETRY THIS FILE IS BUILT AROUND ─────────────────────────────────────────────────────
 * Rule 24 (docs/ORIENTATION.md) says a secret never travels in a URL. The R-5 finding
 * (docs/audits/recon-2026-07-21.md) was "both bearer tokens plaintext in world-readable serve.log AND
 * the write token in console URL query"; its recorded remediation is "hand out the READ token in the
 * console URL", which is what serve.ts's banner has done ever since. So:
 *
 *   READ token  — belongs in the URL. It grants VIEW, not control. That is the bookmark.
 *   WRITE token — never in a URL, and never in anything a redirect can capture. Printed only as a
 *                 bare value, only behind --write, and only when stdout is a TTY.
 *
 * The TTY condition is not decoration. serve.ts's banner comment states the operative fact: "under
 * the real launch stdout is redirected to serve.log — so whatever is printed here is written to disk
 * in the clear and outlives the process." A `rmd console-url --write > somewhere` or a `| tee` would
 * put a fleet-control capability on disk exactly the way R-5 did, and R-5 cost a token rotation. When
 * stdout is not a TTY this refuses and says why, rather than printing and hoping.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────────
 * It does not call serve.ts's `resolveServiceTokens`. That function is create-once/read-thereafter —
 * it opens the path "wx" and MINTS a fresh 0600 pair when the file is absent. A read-only "print the
 * URL" verb must not create a credential file as a side effect, and doing so would turn the
 * "serve has never run" case into a silent success instead of the actionable refusal it should be.
 * It reads `serviceTokensPath` (serve's own path helper) directly and fails loudly when absent.
 *
 * Nothing about token generation, storage, rotation, or comparison changes here, and the console's
 * client-side storage choice is untouched.
 */

/** Exit codes, named so the dispatch and the tests agree on them without a magic number. */
export const CONSOLE_URL_OK = 0;
export const CONSOLE_URL_FAILED = 1;
export const CONSOLE_URL_BAD_ARGS = 2;

/** The token file's shape, as `resolveServiceTokens` writes it. Values are never logged. */
interface TokensFile {
  read?: unknown;
  write?: unknown;
}

/**
 * Injected seams. Every one exists so the tests can drive a real decision without a network
 * connection, without a TTY, and — the load-bearing one — without ever touching the operator's real
 * token file: `readTokensFile` lets a test supply SYNTHETIC tokens it generated itself.
 */
export interface ConsoleUrlDeps {
  /** Reads and parses the tokens file. Throws to signal unreadable/malformed. */
  readTokensFile?: (path: string) => TokensFile;
  /** True when the file is present. Split from the read so "absent" and "unreadable" stay distinct. */
  tokensFileExists?: (path: string) => boolean;
  /** True when something is accepting TCP connections at host:port. */
  isListening?: (host: string, port: number) => Promise<boolean>;
  /** True when stdout is a terminal. The write token's whole guard rides on this. */
  isTty?: () => boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * Unknown-argument check. run-task.ts's `unknownArgError` is the house helper for this and would be
 * the obvious reuse, but `.dependency-cruiser.cjs`'s `lib-no-spike-or-cli` rule forbids `^src/lib`
 * importing the CLI, and moving that helper down is a wider refactor than this task. So: a local,
 * deliberately narrow check over THIS verb's own three flags, returning the same
 * "unknown argument" shape a caller can print. Not a fork of anything — it is eight lines over a
 * two-element flag table, not a second copy of an algorithm.
 */
export function consoleUrlArgError(rest: string[]): string | null {
  const valueFlags = new Set(["--port", "--host"]);
  const boolFlags = new Set(["--write"]);
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (boolFlags.has(tok)) continue;
    if (valueFlags.has(tok)) {
      if (rest[i + 1] === undefined) return `### rmd console-url — ${tok} needs a value`;
      i++;
      continue;
    }
    return `### rmd console-url — unknown argument ${JSON.stringify(tok)}`;
  }
  return null;
}

/** Default TCP liveness probe: connect, then immediately destroy. Never sends a byte, so it cannot
 *  appear in the console's request log as a spurious unauthenticated hit. */
export function defaultIsListening(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (alive: boolean) => {
      sock.destroy();
      resolve(alive);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** The remedy line every failure path ends with — one string so the three failures cannot drift into
 *  three different pieces of advice. */
export const START_CONSOLE_REMEDY =
  "start the console with `rmd serve`, or install the service with `rmd serve-plist --write`";

/**
 * The read-scope navigation URL for one bound interface. This is byte-identical in shape to the line
 * serve.ts's banner already prints, so a bookmark taken from either is the same bookmark.
 */
export function consoleReadUrl(host: string, port: number, readToken: string): string {
  return `http://${host}:${port}/?token=${readToken}`;
}

/**
 * `rmd console-url [--port <n>] [--host <addr>] [--write]`.
 *
 * Returns a process exit code; every message goes through the injected sinks so a test asserts on
 * exact output rather than on a spawned child's stdout.
 */
export async function consoleUrlCommand(
  rest: string[],
  config: Config,
  deps: ConsoleUrlDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const exists = deps.tokensFileExists ?? ((p: string) => existsSync(p));
  const readFile = deps.readTokensFile ?? ((p: string) => JSON.parse(readFileSync(p, "utf8")) as TokensFile);
  const listening = deps.isListening ?? defaultIsListening;
  const isTty = deps.isTty ?? (() => Boolean(process.stdout.isTTY));

  const badArg = consoleUrlArgError(rest);
  if (badArg) {
    err(badArg);
    return CONSOLE_URL_BAD_ARGS;
  }
  const wantWrite = rest.includes("--write");

  // Port/host resolve EXACTLY as `rmd serve` resolves them (flag > env > config > default) by calling
  // serve's own exported functions — never a second copy of that precedence, and no 4317/127.0.0.1
  // literal anywhere in this file.
  let port: number;
  let hosts: string[];
  try {
    port = resolveServePort(rest, config.serve?.port);
    hosts = resolveServeHosts(rest, process.env, config.serve?.host);
  } catch (e) {
    err(`### rmd console-url — ${(e as Error).message}`);
    return CONSOLE_URL_BAD_ARGS;
  }

  // ── FAILURE 1: serve has never run, so there is no token file to read. Refusing here (rather than
  // minting one, which resolveServiceTokens would do) keeps this verb read-only and tells the
  // operator the thing they actually need to do next.
  const tokensPath = serviceTokensPath(config.root);
  if (!exists(tokensPath)) {
    err(`### rmd console-url — no token file at ${tokensPath} (the console has never run) — ${START_CONSOLE_REMEDY}`);
    return CONSOLE_URL_FAILED;
  }

  // ── FAILURE 2: present but unreadable or malformed. The path is named because the fix is usually a
  // permission or a truncated write, and neither is guessable from "unexpected token".
  let tokens: TokensFile;
  try {
    tokens = readFile(tokensPath);
  } catch (e) {
    err(
      `### rmd console-url — ${tokensPath} exists but could not be read (${(e as Error).message}) — ` +
        `check its permissions (it should be 0600), or rotate: stop the console, delete that file, then ${START_CONSOLE_REMEDY}`,
    );
    return CONSOLE_URL_FAILED;
  }
  const readToken = typeof tokens.read === "string" && tokens.read.length > 0 ? tokens.read : undefined;
  if (!readToken) {
    err(
      `### rmd console-url — ${tokensPath} has no usable "read" token — ` +
        `rotate: stop the console, delete that file, then ${START_CONSOLE_REMEDY}`,
    );
    return CONSOLE_URL_FAILED;
  }

  // ── FAILURE 3: nothing is actually listening, so a printed URL would 'work' in the sense of being
  // well-formed and fail in the sense the operator cares about. Checked on the FIRST resolved host:
  // that is the one serve binds first, and probing every tailnet address would turn a fast verb into
  // a timeout chain.
  const probeHost = hosts[0] as string;
  if (!(await listening(probeHost, port))) {
    err(`### rmd console-url — nothing listening on ${probeHost}:${port} — ${START_CONSOLE_REMEDY}`);
    return CONSOLE_URL_FAILED;
  }

  for (const h of hosts) out(`    console:     ${consoleReadUrl(h, port, readToken)}`);

  if (!wantWrite) {
    // The pointer that closes the newcomer's loop: the console's own read-only banner names this
    // verb, and this line names the flag. Neither says the token.
    out(`    write token: not shown — re-run with --write (TTY only) to print it for paste into the console`);
    return CONSOLE_URL_OK;
  }

  // ── THE WRITE TOKEN. Two conditions, both required, and the TTY one is the property serve.ts's
  // banner comment protects: a redirected stdout becomes a file that outlives the process (R-5).
  if (!isTty()) {
    err(
      `### rmd console-url — REFUSING to print the write token: stdout is not a TTY. ` +
        `A redirected or piped stdout becomes a file that outlives this process, which is exactly how ` +
        `a fleet-control capability reached a world-readable serve.log once before (R-5, rotated). ` +
        `Re-run it attached to a terminal.`,
    );
    return CONSOLE_URL_FAILED;
  }
  const writeToken = typeof tokens.write === "string" && tokens.write.length > 0 ? tokens.write : undefined;
  if (!writeToken) {
    err(
      `### rmd console-url — ${tokensPath} has no usable "write" token — ` +
        `rotate: stop the console, delete that file, then ${START_CONSOLE_REMEDY}`,
    );
    return CONSOLE_URL_FAILED;
  }
  // NOT part of any URL — a bare value to paste into the console's own write-token field, so it never
  // enters browser history, a bookmark, a screenshot of the address bar, or a proxy log.
  out(`    write token: ${writeToken}`);
  out(`    (paste into the console's write-token field; it is held in sessionStorage and dies with the tab)`);
  return CONSOLE_URL_OK;
}
