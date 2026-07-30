import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import {
  CONSOLE_URL_BAD_ARGS,
  CONSOLE_URL_FAILED,
  CONSOLE_URL_OK,
  consoleReadUrl,
  consoleUrlArgError,
  consoleUrlCommand,
  defaultIsListening,
  START_CONSOLE_REMEDY,
  type ConsoleUrlDeps,
} from "../src/lib/console-url.js";

// ── CREDENTIAL DISCIPLINE FOR THIS FILE ────────────────────────────────────────────────────────
// Every token here is SYNTHETIC, minted by this file at run time. Nothing reads the operator's real
// <config.root>/state/service-tokens.json — `tokensFileExists`/`readTokensFile` are injected on
// every call, so no test can reach it even by accident. No literal token value is committed.

const SYNTH_READ = `read-${randomBytes(8).toString("hex")}`;
const SYNTH_WRITE = `write-${randomBytes(8).toString("hex")}`;

/** A config whose root is a path that need not exist — the fs seams are always injected. */
function cfg(over: Partial<Config> = {}): Config {
  return { claudeBin: "/bin/true", root: "/nonexistent-console-url-root", ...over } as Config;
}

interface Captured {
  out: string[];
  err: string[];
  deps: ConsoleUrlDeps;
}

/** Default happy-path seams: tokens present and well-formed, something listening, stdout a TTY. */
function capture(over: Partial<ConsoleUrlDeps> = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const deps: ConsoleUrlDeps = {
    tokensFileExists: () => true,
    readTokensFile: () => ({ read: SYNTH_READ, write: SYNTH_WRITE }),
    isListening: async () => true,
    isTty: () => true,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { out, err, deps };
}

const all = (c: Captured) => [...c.out, ...c.err].join("\n");

// ── the URL: shape, and the resolved port/host ─────────────────────────────────────────────────

test("console-url prints a read-token URL whose host and port come from the resolved values", async () => {
  const c = capture();
  const code = await consoleUrlCommand(["--port", "5599", "--host", "10.1.2.3"], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_OK);
  const urlLine = c.out.find((l) => l.includes("console:"));
  assert.ok(urlLine, "a console: line must be printed");
  // Shape asserted structurally — host, port and the token QUERY PARAM NAME — never a literal value.
  assert.match(urlLine!, /http:\/\/10\.1\.2\.3:5599\/\?token=/, "URL carries the resolved host and port");
  assert.ok(urlLine!.includes(SYNTH_READ), "the URL carries the read token this test generated");
});

test("console-url resolves the port from config when no flag is given, never a hardcoded default", async () => {
  const c = capture();
  await consoleUrlCommand([], cfg({ serve: { port: 4488, host: "192.168.0.9" } } as Partial<Config>), c.deps);
  const urlLine = c.out.find((l) => l.includes("console:"))!;
  assert.match(urlLine, /http:\/\/192\.168\.0\.9:4488\//, "config serve.port/serve.host are honoured");
});

test("console-url prints ONE url per bound interface, matching the filing's per-interface requirement", async () => {
  const c = capture();
  await consoleUrlCommand(["--host", "127.0.0.1,100.64.0.7", "--port", "4317"], cfg(), c.deps);
  const urls = c.out.filter((l) => l.includes("console:"));
  assert.equal(urls.length, 2, "one URL per resolved host");
  assert.ok(urls[0]!.includes("127.0.0.1:4317"));
  assert.ok(urls[1]!.includes("100.64.0.7:4317"));
});

test("consoleReadUrl builds the same shape serve's banner prints, so either bookmark is the same bookmark", () => {
  assert.equal(consoleReadUrl("127.0.0.1", 4317, SYNTH_READ), `http://127.0.0.1:4317/?token=${SYNTH_READ}`);
});

// ── THE SECURITY REGRESSION LOCKS ──────────────────────────────────────────────────────────────

test("SECURITY: without --write the write token appears nowhere in the output", async () => {
  const c = capture();
  const code = await consoleUrlCommand([], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_OK);
  // Asserted on the WHOLE output, stdout and stderr together, as a direct absence check.
  assert.ok(!all(c).includes(SYNTH_WRITE), "the write token must not appear without --write");
  assert.ok(all(c).includes("--write"), "but the output must say how to get it");
});

test("SECURITY: with --write and a NON-TTY stdout the verb REFUSES and the write token never prints", async () => {
  const c = capture({ isTty: () => false });
  const code = await consoleUrlCommand(["--write"], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_FAILED, "a redirected stdout must fail, not print");
  assert.ok(!all(c).includes(SYNTH_WRITE), "the write token must not appear on a non-TTY stdout");
  assert.match(all(c).toLowerCase(), /not a tty/, "and it must say why");
  assert.match(all(c), /outlives this process/, "naming the reason the property exists (R-5)");
});

test("SECURITY: the write token is never placed in a URL even when it is printed", async () => {
  const c = capture({ isTty: () => true });
  const code = await consoleUrlCommand(["--write"], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_OK);
  assert.ok(all(c).includes(SYNTH_WRITE), "with a TTY and --write it IS printed");
  const urlLines = c.out.filter((l) => l.includes("http://"));
  for (const l of urlLines) {
    assert.ok(!l.includes(SYNTH_WRITE), "no URL line may ever carry the write token");
  }
});

// ── failure modes: each must name the remedy, not merely the error ─────────────────────────────

test("FAILURE: no token file yet names the path and tells the operator to start the console", async () => {
  const c = capture({ tokensFileExists: () => false });
  const code = await consoleUrlCommand([], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_FAILED);
  assert.match(all(c), /never run/, "says the console has never run");
  assert.ok(all(c).includes(START_CONSOLE_REMEDY), "and names the remedy verbatim");
  assert.match(all(c), /rmd serve-plist --write/, "including the service-install path");
});

test("FAILURE: an unreadable token file names the path, the permission fix, and the rotation path", async () => {
  const c = capture({
    readTokensFile: () => {
      throw new Error("EACCES: permission denied");
    },
  });
  const code = await consoleUrlCommand([], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_FAILED);
  assert.match(all(c), /could not be read/);
  assert.match(all(c), /0600/, "names the expected mode");
  assert.ok(all(c).includes(START_CONSOLE_REMEDY));
});

test("FAILURE: nothing listening names the host and port and the remedy, rather than printing a dead URL", async () => {
  const c = capture({ isListening: async () => false });
  const code = await consoleUrlCommand(["--port", "4317"], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_FAILED);
  assert.match(all(c), /nothing listening on 127\.0\.0\.1:4317/);
  assert.ok(all(c).includes(START_CONSOLE_REMEDY));
  assert.ok(!all(c).includes(SYNTH_READ), "and no URL is printed when nothing would answer it");
});

test("FAILURE: a token file with no usable read token refuses rather than printing an empty token URL", async () => {
  const c = capture({ readTokensFile: () => ({ read: "", write: SYNTH_WRITE }) });
  const code = await consoleUrlCommand([], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_FAILED);
  assert.match(all(c), /no usable "read" token/);
  assert.ok(!all(c).includes(SYNTH_WRITE), "and the write token is not leaked by the failure path");
});

// ── argument handling ──────────────────────────────────────────────────────────────────────────

test("console-url rejects an unknown argument instead of silently ignoring a typo", async () => {
  const c = capture();
  const code = await consoleUrlCommand(["--wrote"], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_BAD_ARGS);
  assert.match(all(c), /unknown argument/);
  assert.ok(!all(c).includes(SYNTH_WRITE), "a typo close to --write must not print the write token");
});

test("consoleUrlArgError accepts the three real flags and names a value flag left without a value", () => {
  assert.equal(consoleUrlArgError(["--port", "4317", "--host", "127.0.0.1", "--write"]), null);
  assert.match(String(consoleUrlArgError(["--port"])), /--port needs a value/);
  assert.match(String(consoleUrlArgError(["--nope"])), /unknown argument/);
});

test("FAILURE: --write on a file with no usable write token refuses instead of printing an empty token", async () => {
  const c = capture({ isTty: () => true, readTokensFile: () => ({ read: SYNTH_READ, write: "" }) });
  const code = await consoleUrlCommand(["--write"], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_FAILED);
  assert.match(all(c), /no usable "write" token/);
  assert.ok(all(c).includes(START_CONSOLE_REMEDY), "and names the rotation remedy");
});

// ── the REAL liveness probe, exercised against a real socket ───────────────────────────────────
// Bound to 127.0.0.1 on an EPHEMERAL port and closed in the same test: no fixed port to collide
// with the live console on 4317, and nothing leaves this machine.

test("defaultIsListening returns true against a real listening socket and false against a closed port", async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    assert.equal(await defaultIsListening("127.0.0.1", port), true, "a bound port answers");
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
  // The same port after close: nothing is listening, so the probe must say so rather than hang.
  assert.equal(await defaultIsListening("127.0.0.1", port), false, "a closed port does not");
});

test("defaultIsListening resolves false rather than hanging when a connect never completes", async () => {
  // A documentation-range address that black-holes rather than refusing, with a short timeout so
  // the timeout branch (not the error branch) is the one that runs.
  assert.equal(await defaultIsListening("192.0.2.1", 4317, 250), false);
});

test("console-url surfaces an invalid port as a usage error rather than a crash", async () => {
  const c = capture();
  const code = await consoleUrlCommand(["--port", "not-a-port"], cfg(), c.deps);
  assert.equal(code, CONSOLE_URL_BAD_ARGS);
  assert.match(all(c), /1-65535/);
});
