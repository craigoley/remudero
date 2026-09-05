/**
 * R-2 (recon-2026-09-05): ONE MALFORMED REQUEST LINE USED TO KILL `rmd serve`.
 *
 * `createService`'s dispatch runs as `void (async () => { ... })()` and its first statement is
 * `new URL(req.url ?? "/", "http://localhost")`. Node's HTTP parser accepts a request line whose
 * target is not a valid URL and hands it through verbatim, so `GET http://[ HTTP/1.1` threw
 * `ERR_INVALID_URL` outside every `try` in the file. With no `unhandledRejection` handler anywhere
 * in `src/` or `bin/` (`git grep -c unhandledRejection -- src bin` read 0 before this change),
 * Node's default took the process down — the console and the webhook receiver with it, and under
 * launchd's 60 s restart throttle that is a repeatable outage per packet, reachable from loopback,
 * the tailnet or the relay.
 *
 * These cases are written against the REAL server on `listen(0)` over a raw socket, not a fake
 * `IncomingMessage`, precisely because the defect lived in the bytes Node's parser will accept:
 * no HTTP client this repo has would have sent that request line.
 *
 * DISCRIMINATION: delete the `.catch(...)` on the dispatch IIFE in src/lib/service.ts and the
 * first case goes red (the server process dies before it answers).
 */
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createService } from "../src/lib/service.js";
import { CLI_EXIT_UNHANDLED_REJECTION, installUnhandledRejectionGuard } from "../src/run-task.js";

/** Speak raw bytes at the server and collect everything it says back, so a case can assert on the
 *  STATUS LINE a real client would parse rather than on a library's exception. Resolves on close
 *  (the malformed case) or on a complete response (the keep-alive case), whichever lands first. */
function speak(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const sock = net.connect(port, "127.0.0.1", () => sock.write(bytes));
    sock.setTimeout(10_000, () => {
      sock.destroy();
      reject(new Error(`no response within 10s; saw ${JSON.stringify(seen)}`));
    });
    sock.on("data", (d) => {
      seen += d.toString("utf8");
      // A JSON body arrives in the same flush as its headers here; end the read once the framing
      // is complete so the case does not wait out a keep-alive idle.
      if (seen.includes("\r\n\r\n")) {
        sock.end();
        resolve(seen);
      }
    });
    sock.on("close", () => resolve(seen));
    sock.on("error", reject);
  });
}

/** Boot the real service on an ephemeral port and register its teardown with the test context, so
 *  a case that fails mid-assertion still releases the listener. */
async function boot(t: import("node:test").TestContext, opts: Parameters<typeof createService>[0]): Promise<number> {
  const server: Server = createService(opts);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

test("a malformed request line is answered 400 and the server answers the next request", async (t) => {
  const logged: { step: string; fields: Record<string, unknown> }[] = [];
  const port = await boot(t, {
    tokens: { read: "r", write: "w" },
    log: (step, fields) => logged.push({ step, fields: fields as Record<string, unknown> }),
    routes: [
      {
        method: "GET",
        path: "/v1/ping",
        scope: "read",
        handler: (_req, res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        },
      },
    ],
  });

  // The exact bytes. `http://[` is a request target Node's parser accepts and `new URL` refuses.
  const bad = await speak(port, "GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n");
  assert.match(bad, /^HTTP\/1\.1 400\b/, `expected a 400 status line, got ${JSON.stringify(bad)}`);
  assert.match(bad, /"error":"bad_request"/, `expected a bad_request body, got ${JSON.stringify(bad)}`);

  // The whole point: the process is still here to serve the next caller.
  const good = await speak(port, "GET /v1/ping HTTP/1.1\r\nHost: x\r\nauthorization: Bearer r\r\n\r\n");
  assert.match(good, /^HTTP\/1\.1 200\b/, `expected the server to still answer, got ${JSON.stringify(good)}`);
  assert.match(good, /"ok":true/);

  // A client fault is ledgered as one, NOT as `service.error` — the 500 row means "this process is
  // broken" and must stay usable as that signal.
  const refusal = logged.find((r) => r.step === "service.bad_request");
  assert.ok(refusal, `expected a service.bad_request row, saw ${JSON.stringify(logged.map((r) => r.step))}`);
  assert.equal(refusal.fields.method, "GET");
  assert.equal(refusal.fields.url, "http://[");
  assert.equal(
    logged.filter((r) => r.step === "service.error").length,
    0,
    "a malformed request line is the client's fault and must not be recorded as a service error",
  );
});

test("a body read that fails is answered 500 with a service.error row rather than killing the process", async (t) => {
  const logged: { step: string; fields: Record<string, unknown> }[] = [];
  const port = await boot(t, {
    tokens: { read: "r", write: "w" },
    log: (step, fields) => logged.push({ step, fields: fields as Record<string, unknown> }),
    // The confirm-nonce gate is the dispatch's one `await readRawBody(req)`, and it sits OUTSIDE
    // both inner `try` blocks — the second escape R-2 names (src/lib/service.ts:1073 at f7ceb86).
    enforceWriteTiers: true,
    routes: [
      {
        method: "POST",
        path: "/v1/high",
        scope: "write",
        tier: "high",
        handler: (_req, res) => {
          res.writeHead(200);
          res.end("unreachable");
        },
      },
    ],
    // `readRawBody` rejects on `req.on("error")`. Nothing a client can send over TCP forces that,
    // so the failure is injected where it really originates: an identity provider is the seam the
    // dispatch consults immediately before the body read, and destroying the request stream from
    // there makes the very next `await` reject exactly as a mid-body socket fault would. The
    // provider must reach the HIGH tier itself, or the tier gate answers 403 before the nonce
    // check is reached and the body is never read at all.
    providers: [
      {
        name: "explodes-the-request-stream",
        writeTier: "high",
        grant: (req) => {
          req.destroy(new Error("socket exploded"));
          return new Set<"read" | "write">(["read", "write"]);
        },
      },
    ],
  });

  // No `authorization` header: the built-in bearer provider must answer `undefined` so the
  // stream-destroying provider after it is the one that grants.
  const answer = await speak(
    port,
    "POST /v1/high HTTP/1.1\r\nHost: x\r\nx-confirm-nonce: n\r\ncontent-length: 5\r\n\r\nhello",
  );

  // Whatever the socket state, the ONE thing that must hold is that this process is still running
  // and still answering. Prove it on a second connection.
  const good = await speak(port, "GET /v1/nope HTTP/1.1\r\nHost: x\r\nauthorization: Bearer r\r\n\r\n");
  assert.match(good, /^HTTP\/1\.1 404\b/, `expected the server to survive the failed body read, got ${JSON.stringify(good)}`);

  // And the failure is recorded as a service error, not silently swallowed.
  const errors = logged.filter((r) => r.step === "service.error");
  assert.ok(
    errors.length > 0,
    `expected a service.error row for the failed body read; saw ${JSON.stringify(logged.map((r) => r.step))} and answered ${JSON.stringify(answer)}`,
  );
  assert.equal(errors[0].fields.method, "POST");
  assert.equal(errors[0].fields.url, "/v1/high");
});

// ── THE SECOND HALF OF R-2: the backstop under `respondToRequestFailure` ─────────────────────
//
// The dispatch guard above closes the ONE escape this audit reproduced. The `unhandledRejection`
// registration closes the CLASS: before it, `git grep -c unhandledRejection -- src bin` read 0,
// so any rejection nobody awaited — anywhere in any verb — died on Node's default with no ledger
// row and no named exit code. These cases drive the handler through its seams; the last two drive
// the REAL ledger default, because a suite where every test injects a fake leaves the default
// unreachable (#977/#978).

/** A HOME whose `~/.config/remudero/config.json` is exactly `body`, plus a state root — the
 *  `configPath()`-shaped fixture test/credited-proof-visibility-seam-defaults.test.ts established.
 *  `os.homedir()` reads `$HOME` on POSIX, which is what makes `loadConfig` redirectable at all. */
function homeWithConfig(body: string): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rmd-urj-home-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-urj-root-"));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), body, "utf8");
  return { home, root };
}

function withHome<T>(home: string, fn: () => T): T {
  const prior = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
}

test("the guard ledgers, prints and halts with the named code — it never lets a rejection reach Node's default", () => {
  const target = new EventEmitter();
  const logged: unknown[] = [];
  const printed: string[] = [];
  const exits: number[] = [];

  const installed = installUnhandledRejectionGuard({
    target: target as unknown as { on(e: "unhandledRejection", h: (r: unknown) => void): unknown },
    log: (r) => logged.push(r),
    error: (line) => printed.push(line),
    exit: (code) => exits.push(code),
  });
  assert.equal(installed, true);

  const reason = new Error("nobody awaited me");
  target.emit("unhandledRejection", reason);

  assert.deepEqual(logged, [reason]);
  assert.equal(exits.length, 1);
  assert.equal(exits[0], CLI_EXIT_UNHANDLED_REJECTION);
  assert.equal(CLI_EXIT_UNHANDLED_REJECTION, 78, "the exit code is a supervisor's only signal — pinned, not incidental");
  assert.equal(printed.length, 1);
  assert.match(printed[0], /^rmd: unhandled promise rejection -- /);
  assert.match(printed[0], /nobody awaited me/, "the operator gets the reason, not just a code");
});

test("installing twice on one target registers one listener — main() is called in-process by this repo's own tests", () => {
  const target = new EventEmitter();
  const exits: number[] = [];
  const seam = {
    target: target as unknown as { on(e: "unhandledRejection", h: (r: unknown) => void): unknown },
    log: () => {},
    error: () => {},
    exit: (code: number) => exits.push(code),
  };

  assert.equal(installUnhandledRejectionGuard(seam), true, "the first call installs");
  assert.equal(installUnhandledRejectionGuard(seam), false, "the second call is a no-op");
  assert.equal(target.listenerCount("unhandledRejection"), 1);

  target.emit("unhandledRejection", new Error("once"));
  assert.deepEqual(exits, [CLI_EXIT_UNHANDLED_REJECTION], "a doubled listener would halt twice");
});

test("the ledger seam DEFAULT writes a cli.unhandled_rejection row through the real config", () => {
  const { home, root } = homeWithConfig("{}");
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/echo", root }), "utf8");
  mkdirSync(join(root, "state"), { recursive: true });

  const target = new EventEmitter();
  const exits: number[] = [];
  withHome(home, () => {
    // `log` deliberately NOT injected — this case exists to run `logUnhandledRejection` itself.
    installUnhandledRejectionGuard({
      target: target as unknown as { on(e: "unhandledRejection", h: (r: unknown) => void): unknown },
      error: () => {},
      exit: (code) => exits.push(code),
    });
    target.emit("unhandledRejection", new Error("escaped for real"));
  });

  assert.deepEqual(exits, [CLI_EXIT_UNHANDLED_REJECTION]);
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const row = rows.find((r) => r.step === "cli.unhandled_rejection");
  assert.ok(row, `expected a cli.unhandled_rejection row, saw ${JSON.stringify(rows.map((r) => r.step))}`);
  assert.equal(row.task_id, "CLI");
  assert.equal(row.error, "escaped for real");
});

test("a ledger that cannot be written still leaves the operator the stderr line and the named code", () => {
  // A MALFORMED config makes `loadConfig`'s `JSON.parse` throw inside `logUnhandledRejection` —
  // the telemetry-only catch arm. Losing the row must never cost the halt.
  const { home } = homeWithConfig("{ this is not json");

  const target = new EventEmitter();
  const printed: string[] = [];
  const exits: number[] = [];
  withHome(home, () => {
    installUnhandledRejectionGuard({
      target: target as unknown as { on(e: "unhandledRejection", h: (r: unknown) => void): unknown },
      error: (line) => printed.push(line),
      exit: (code) => exits.push(code),
    });
    target.emit("unhandledRejection", new Error("escaped with no ledger"));
  });

  assert.deepEqual(exits, [CLI_EXIT_UNHANDLED_REJECTION]);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /escaped with no ledger/);
});
