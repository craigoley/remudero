import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { createService, type Route } from "../src/lib/service.js";
import { runRelayClient, type RelayClientHandle } from "../src/lib/relay-client.js";

// ── W1-T431: the Tier-2 relay CLIENT (MASTER-PLAN §7A/§6A, D-11) ──
//
// The task's own falsifier (design note v), BOTH directions:
//
//   (a) TRANSPARENT PROXY: against a loopback stub relay, a browser-shaped request through the
//       tunnel reaches the local console surface and returns the SAME response a direct call
//       gets -- with scope granted by the W1-T430 identity seam and NONE added by the relay
//       client itself (an unauthenticated request tunnels to the same 401 a direct call gets,
//       not a bypass).
//   (b) OUTBOUND-ONLY: the client process never holds a listening socket -- not while connected
//       to a live relay, and not while retrying an absent one -- and the local console surface
//       behaves exactly as it does with no relay configured at all.
//
// Deleting the forwarder fails (a); adding any listener fails (b). Both directions drive the
// REAL `createService` HTTP server (never a mock) on one side and a hand-rolled stub relay --
// implementing this module's own NDJSON wire protocol -- on the other, the same discipline
// test/identity-provider-seam.test.ts's fixture-provider tests already follow.

const READ_TOKEN = "relay-read-token-abc123";
const WRITE_TOKEN = "relay-write-token-xyz789";
const ENROLLMENT_TOKEN = "relay-enrollment-token-qed456";
const STATE_BODY = { ok: true, via: "console" };

function buildRoutes(): Route[] {
  return [
    {
      method: "GET",
      path: "/state",
      scope: "read",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(STATE_BODY));
      },
    },
  ];
}

/** Start the real console surface on loopback, ephemeral port. Returns its base URL + closer. */
async function startLocalServe(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildRoutes() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface StubRelayFrame {
  t: string;
  [k: string]: unknown;
}

interface ProxiedResponse {
  status: number;
  headers: Record<string, unknown>;
  body: Buffer;
}

interface StubRelay {
  relayUrl: string;
  /** Resolves once the client's hello frame has been read and answered. */
  helloSeen: Promise<{ ok: boolean; token: string }>;
  /** Drive ONE request through the tunnel end to end, resolving when `res_end` arrives. */
  proxy: (req: { method: string; path: string; headers: Record<string, string>; body?: string | null }) => Promise<ProxiedResponse>;
  close: () => Promise<void>;
}

/**
 * A hand-rolled stub relay: listens on loopback (standing in for a real relay's inbound side,
 * which is out of this task's scope), accepts ONE connection (the client dialing OUT to it per
 * design note iii), validates the hello frame's enrollment token, and exposes `proxy()` to drive
 * one request through the tunnel -- writing a `req` frame and reassembling `res_head`, zero or
 * more `res_chunk`s, and `res_end` into a single response, exactly like a real relay would
 * before handing it to whatever browser session it brokered.
 */
async function startStubRelay(expectedToken: string): Promise<StubRelay> {
  let clientSocket: Socket | undefined;
  let buffer = "";
  const pending = new Map<string, { status?: number; headers?: Record<string, unknown>; chunks: Buffer[]; resolve: (v: ProxiedResponse) => void }>();
  let helloResolve!: (v: { ok: boolean; token: string }) => void;
  const helloSeen = new Promise<{ ok: boolean; token: string }>((resolve) => {
    helloResolve = resolve;
  });

  const server = createNetServer((socket) => {
    clientSocket = socket;
    socket.on("error", () => {
      // The client may `.destroy()` its end abruptly on `stop()` -- an RST reaching this
      // accepted socket is expected teardown noise, not a test failure.
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as StubRelayFrame;
        switch (frame.t) {
          case "hello": {
            const token = frame.token as string;
            const ok = token === expectedToken;
            socket.write(JSON.stringify(ok ? { t: "hello_ok" } : { t: "hello_reject", reason: "bad token" }) + "\n");
            helloResolve({ ok, token });
            break;
          }
          case "res_head": {
            const id = frame.id as string;
            const entry = pending.get(id) ?? { chunks: [], resolve: () => {} };
            entry.status = frame.status as number;
            entry.headers = frame.headers as Record<string, unknown>;
            pending.set(id, entry);
            break;
          }
          case "res_chunk": {
            const entry = pending.get(frame.id as string);
            entry?.chunks.push(Buffer.from(frame.data as string, "base64"));
            break;
          }
          case "res_end": {
            const id = frame.id as string;
            const entry = pending.get(id);
            if (entry) {
              entry.resolve({ status: entry.status ?? 0, headers: entry.headers ?? {}, body: Buffer.concat(entry.chunks) });
              pending.delete(id);
            }
            break;
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  let nextId = 0;
  return {
    relayUrl: `http://127.0.0.1:${port}`,
    helloSeen,
    proxy: (req) =>
      new Promise<ProxiedResponse>((resolve) => {
        const id = String(nextId++);
        pending.set(id, { chunks: [], resolve });
        clientSocket!.write(
          JSON.stringify({ t: "req", id, method: req.method, path: req.path, headers: req.headers, body: req.body ?? null }) + "\n",
        );
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("relay: a request through the loopback stub relay returns the same console response as a direct call, with scope from the identity seam and none added by the relay", async () => {
  const local = await startLocalServe();
  const relay = await startStubRelay(ENROLLMENT_TOKEN);
  let client: RelayClientHandle | undefined;
  try {
    client = runRelayClient({ relayUrl: relay.relayUrl, enrollmentToken: ENROLLMENT_TOKEN, localBaseUrl: local.baseUrl });

    const hello = await relay.helloSeen;
    assert.equal(hello.ok, true);
    assert.equal(hello.token, ENROLLMENT_TOKEN);

    // ── (a) authenticated request: tunnel and direct call return the SAME body ──
    const direct = await fetch(`${local.baseUrl}/state`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    const directBody = await direct.text();

    const tunneled = await relay.proxy({ method: "GET", path: "/state", headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(tunneled.status, direct.status);
    assert.equal(tunneled.body.toString("utf8"), directBody);
    assert.deepEqual(JSON.parse(tunneled.body.toString("utf8")), STATE_BODY);

    // ── the relay adds NO scope of its own: an unauthenticated tunneled request gets the SAME
    // 401 a direct unauthenticated call gets -- never a bypass just for arriving via the relay.
    const directAnon = await fetch(`${local.baseUrl}/state`);
    const tunneledAnon = await relay.proxy({ method: "GET", path: "/state", headers: {} });
    assert.equal(tunneledAnon.status, directAnon.status);
    assert.equal(tunneledAnon.status, 401);
  } finally {
    client?.stop();
    await relay.close();
    await local.close();
  }
});

test("relay: the client never holds a listening socket, connected or retrying", async () => {
  const local = await startLocalServe();
  const relay = await startStubRelay(ENROLLMENT_TOKEN);
  // Let any still-settling teardown from a PRIOR test's closed listeners drain first, so the
  // snapshot below reflects only these two fixtures' own servers, never a race with the last
  // test's async close() completing on a later tick.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const before = process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;

  let client: RelayClientHandle | undefined;
  try {
    client = runRelayClient({ relayUrl: relay.relayUrl, enrollmentToken: ENROLLMENT_TOKEN, localBaseUrl: local.baseUrl });
    await relay.helloSeen;

    const after = process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;
    // Connected to a live relay: zero NEW listening sockets -- only the two fixtures' own
    // servers (started before the snapshot) may exist.
    assert.equal(after, before);
  } finally {
    client?.stop();
    await relay.close();
    await local.close();
  }
});

test("relay: with the relay unreachable, the local console surface behaves exactly as today and the client opens no listener", async () => {
  // A port nothing is listening on -- bind one server briefly just to learn a free port, then
  // close it (and let its teardown fully settle) so the relay dial genuinely refuses.
  const probe = createNetServer(() => {});
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the closed handle fully settle

  const local = await startLocalServe();
  const before = process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;

  let client: RelayClientHandle | undefined;
  try {
    client = runRelayClient({
      relayUrl: `http://127.0.0.1:${deadPort}`,
      enrollmentToken: ENROLLMENT_TOKEN,
      localBaseUrl: local.baseUrl,
      backoff: { initialMs: 20, factor: 1, maxMs: 20 },
    });

    // Give the client a couple of failed-connect/backoff cycles to prove it neither crashes nor
    // opens a listener while retrying an absent relay.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const after = process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;
    assert.equal(after, before);

    // serve behaves exactly as today: a direct call against the local console surface still
    // works, completely unaffected by the relay client's failed dial attempts.
    const direct = await fetch(`${local.baseUrl}/state`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(direct.status, 200);
    assert.deepEqual(await direct.json(), STATE_BODY);
  } finally {
    client?.stop();
    await local.close();
  }
});
