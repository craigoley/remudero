import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { relayConnectCommand } from "../src/run-task.js";

// ── W1-T431: the `rmd relay` CLI wiring (MASTER-PLAN §7A/§6A, D-11) ──
//
// lib/relay-client.ts's own behaviour is graded by test/relay-client.test.ts against a real
// loopback stub relay. THIS file grades the CLI glue around it, which carries three decisions of
// its own and is where a mis-wiring would actually bite an operator:
//
//   (1) the relay address and enrollment token come from PER-INSTANCE CONFIG, never argv
//       (design note i -- a token on a command line lands in shell history and `ps`);
//   (2) a HALF-configured relay (url without token, or token without url) fails LOUD with the
//       config path named, rather than silently dialing nothing forever; and
//   (3) the local console surface it forwards to is resolved the SAME way `rmd serve` resolves
//       its own bind port, so the two cannot drift onto different ports.
//
// `loadConfig()` reads `$HOME/.config/remudero/config.json`, so each fixture below repoints HOME
// at a throwaway dir -- the same discipline test/daemon.test.ts already uses -- and restores it.
// `mkdtempSync` dirs are swept automatically by test/setup/tmp-hygiene.ts (W1-T131).

interface Fixture {
  home: string;
  root: string;
  ledgerPath: string;
}

/** A throwaway HOME carrying an instance config with `relay` set to whatever is passed. */
function fixtureHome(relay?: { url?: string; token?: string }): Fixture {
  const home = mkdtempSync(join(tmpdir(), "relay-cmd-"));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    // `claudeBin` is set explicitly so `loadConfig`'s `resolveClaudeBin()` fallback never has to
    // find a real binary -- this suite must pass on a runner with no `claude` installed.
    JSON.stringify({ claudeBin: "/bin/true", root, ...(relay ? { relay } : {}) }, null, 2),
  );
  return { home, root, ledgerPath: join(root, "state", "ledger.ndjson") };
}

/** Run `fn` with HOME repointed at `home`, restoring the previous value unconditionally. */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
}

/** Capture stderr/stdout writes for the duration of `fn`. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origLog = console.log;
  const origError = console.error;
  let out = "";
  let err = "";
  console.log = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    err += args.join(" ") + "\n";
  };
  try {
    const result = await fn();
    return { result, out, err };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

/** Read the ledger's step names, or [] when the command never wrote one. */
function ledgerSteps(ledgerPath: string): string[] {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { step: string }).step);
}

/** A minimal stub relay: accepts one outbound connection and answers `hello` with `hello_ok`. */
async function startStubRelay(): Promise<{ relayUrl: string; connected: Promise<void>; close: () => Promise<void> }> {
  let onConnected!: () => void;
  const connected = new Promise<void>((resolve) => {
    onConnected = resolve;
  });
  const server = createNetServer((socket: Socket) => {
    socket.on("error", () => {}); // the client destroys its end on stop(); RST is expected noise
    socket.on("data", () => {
      socket.write(JSON.stringify({ t: "hello_ok" }) + "\n");
      onConnected();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    relayUrl: `http://127.0.0.1:${port}`,
    connected,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("rmd relay: an unknown argument is refused with usage, exit 2 — the command takes no flags at all", async () => {
  const fx = fixtureHome({ url: "http://127.0.0.1:1", token: "t" });
  const { result, err } = await withHome(fx.home, () => captureConsole(() => relayConnectCommand(["--bogus"])));

  assert.equal(result, 2);
  assert.match(err, /--bogus/, "the refusal must name the offending argument");
  // Nothing was dialed and nothing was recorded: the refusal precedes every side effect.
  assert.deepEqual(ledgerSteps(fx.ledgerPath), []);
});

test("rmd relay: with NO relay configured it exits 2 naming the instance config path, and dials nothing", async () => {
  const fx = fixtureHome(); // no `relay` block at all
  const { result, err } = await withHome(fx.home, () => captureConsole(() => relayConnectCommand([])));

  assert.equal(result, 2);
  assert.match(err, /no relay configured/i);
  assert.match(err, /relay\.url/, "the operator must be told which fields to set");
  assert.match(err, /relay\.token/);
  assert.match(err, /config\.json/, "and where to set them");
  assert.deepEqual(ledgerSteps(fx.ledgerPath), [], "a refusal must not write a relay.start line");
});

test("rmd relay: a HALF-configured relay (url but no token) fails loud rather than dialing with no credential", async () => {
  const fx = fixtureHome({ url: "http://127.0.0.1:1" }); // token deliberately absent
  const { result, err } = await withHome(fx.home, () => captureConsole(() => relayConnectCommand([])));

  assert.equal(result, 2);
  assert.match(err, /no relay configured/i);
  assert.deepEqual(ledgerSteps(fx.ledgerPath), []);
});

test("rmd relay: a token WITHOUT a url is refused too — the check is both-or-nothing, not url-only", async () => {
  const fx = fixtureHome({ token: "enrollment-token-only" });
  const { result } = await withHome(fx.home, () => captureConsole(() => relayConnectCommand([])));

  assert.equal(result, 2);
  assert.deepEqual(ledgerSteps(fx.ledgerPath), []);
});

test("rmd relay: a fully-configured relay dials OUT to the configured url, ledgers relay.start, and exits 0 on SIGTERM after ledgering relay.stop", async () => {
  const relay = await startStubRelay();
  const fx = fixtureHome({ url: relay.relayUrl, token: "enrollment-token-abc" });

  try {
    const { result, out } = await withHome(fx.home, async () =>
      captureConsole(async () => {
        const pending = relayConnectCommand([]);
        // The command blocks until SIGINT/SIGTERM, exactly like `rmd serve`. Wait for the dial to
        // actually land before signalling, so this asserts a REAL outbound connection rather than
        // just that the function returns.
        await relay.connected;
        process.emit("SIGTERM");
        return pending;
      }),
    );

    assert.equal(result, 0, "a signalled shutdown is a clean exit, not a failure");
    assert.match(out, /dialing/, "the operator is told where it dialed and what it forwards to");
    assert.match(out, new RegExp(relay.relayUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // The local target is resolved from config/DEFAULT_SERVE_PORT, never argv.
    assert.match(out, /127\.0\.0\.1:4317/, "forwards to the same loopback port `rmd serve` binds");

    const steps = ledgerSteps(fx.ledgerPath);
    assert.ok(steps.includes("relay.start"), `expected relay.start in ${JSON.stringify(steps)}`);
    assert.ok(steps.includes("relay.stop"), `expected relay.stop in ${JSON.stringify(steps)}`);

    const startLine = readFileSync(fx.ledgerPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.step === "relay.start")!;
    assert.equal(startLine.task_id, "RELAY");
    assert.equal(startLine.relayUrl, relay.relayUrl);
    assert.equal(startLine.localBaseUrl, "http://127.0.0.1:4317");
  } finally {
    await relay.close();
  }
});

test("rmd relay: the local forward target honours config.serve.port rather than assuming the default", async () => {
  const relay = await startStubRelay();
  const home = mkdtempSync(join(tmpdir(), "relay-cmd-port-"));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(
    join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ claudeBin: "/bin/true", root, serve: { port: 5599 }, relay: { url: relay.relayUrl, token: "t" } }, null, 2),
  );

  try {
    const { result, out } = await withHome(home, async () =>
      captureConsole(async () => {
        const pending = relayConnectCommand([]);
        await relay.connected;
        process.emit("SIGTERM");
        return pending;
      }),
    );
    assert.equal(result, 0);
    assert.match(out, /127\.0\.0\.1:5599/, "a configured serve port must be the forward target");
  } finally {
    await relay.close();
  }
});
