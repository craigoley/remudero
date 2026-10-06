import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  spawnWorker, startWorkerEgressProxy, verifyWorkerEgressProxy, workerLedgerFields,
  WorkerEgressError, type SpawnWorkerArgs,
} from "../src/lib/worker.js";

async function listener(mode: "healthy" | "stall" | "silent" | "stall-then-silent" | "stall-twice") {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer(socket => {
    sockets.add(socket);
    const attempt = ++connections;
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.once("data", bytes => {
      const reply = bytes.toString().startsWith("CONNECT ")
        ? Buffer.from("HTTP/1.1 403 Forbidden\r\n\r\n")
        : Buffer.from([5, 0, 5, 2, 0, 1, 0, 0, 0, 0, 0, 0]);
      if (mode === "silent" || (mode === "stall-then-silent" && attempt > 1)) return;
      if ((mode !== "healthy" && attempt === 1) || (mode === "stall-twice" && attempt === 2)) {
        setTimeout(() => {
          const until = performance.now() + 5_250;
          while (performance.now() < until) { /* Deliberately stall the shared loop past readiness. */ }
          setTimeout(() => socket.end(reply), 0);
        }, 60);
      } else {
        socket.end(reply);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    get connections() { return connections; },
    httpProxyPort: port,
    socksProxyPort: port,
    verifyAllowed: async () => {},
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function spawnFixture(mode: NonNullable<SpawnWorkerArgs["egress"]>["mode"], proxy: Awaited<ReturnType<typeof listener>>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-egress-readiness-"));
  const settingsFile = join(root, "worker.json");
  writeFileSync(settingsFile, readFileSync(new URL("../settings/worker.json", import.meta.url)));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  let queried = false;
  try {
    const result = await spawnWorker({
      cwd: root, settingsFile, permissionMode: "bypassPermissions", prompt: "synthetic",
      config: { root, workerHomeRoot: join(root, "worker-home"), claudeBin: "/fake" },
      mountProvider: "claude", egress: { mode, checkVersion: () => "fixture", startProxy: async () => proxy },
      keychain: { platform: "linux", accountId: "fixture", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }) },
      claudeExecutable: { cache: {}, deps: { env: {}, which: () => "/fake", exists: () => true, canExecute: () => true } },
      queryFn: (async function* () {
        queried = true;
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "fixture", num_turns: 1, total_cost_usd: 0, permission_denials: [] };
      }) as never,
    });
    assert.equal(queried, true);
    return result;
  } catch (error) {
    assert.equal(queried, false, "failed readiness must refuse the query");
    throw error;
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T5747: a stalled loop retries readiness once instead of failing", async () => {
  const proxy = await listener("stall");
  const result = await spawnFixture("enforce", proxy);
  assert.equal(result.text, "ok");
  assert.equal(proxy.connections, 3, "one fresh HTTP retry followed by one SOCKS exchange");
  assert.match(workerLedgerFields(result).egress_unenforced!, /worker egress readiness timed out \(loop_stalled lag [0-9.]+s; retry ok\)/);
  const lagSeconds = Number(/lag ([0-9.]+)s/.exec(result.egressUnenforced!)![1]);
  assert.ok(lagSeconds >= 5, "the diagnostic measures the actual synchronous stall");
});

test("W1-T5747: an unresponsive proxy still fails readiness", async () => {
  const proxy = await listener("silent");
  await assert.rejects(spawnFixture("enforce", proxy), (error: unknown) => {
    assert.ok(error instanceof WorkerEgressError);
    assert.match(error.message, /worker egress readiness timed out \(proxy_unresponsive lag [0-9.]+s\)/);
    return true;
  });
  assert.equal(proxy.connections, 1, "an unstalled timeout must not retry");
});

test("W1-T5747: observe mode records an unresponsive timeout on the existing field", async () => {
  const proxy = await listener("silent");
  const result = await spawnFixture("observe", proxy);
  assert.match(workerLedgerFields(result).egress_unenforced!, /proxy_unresponsive lag [0-9.]+s/);
  assert.equal(proxy.connections, 1);
});

test("W1-T5747: a stalled retry that never answers still fails with both diagnoses", async () => {
  const proxy = await listener("stall-then-silent");
  await assert.rejects(spawnFixture("enforce", proxy), /loop_stalled lag [0-9.]+s; retry failed: .*proxy_unresponsive lag [0-9.]+s/);
  assert.equal(proxy.connections, 2);
});

test("W1-T5747: a second stalled timeout fails without a third attempt", async () => {
  const proxy = await listener("stall-twice");
  await assert.rejects(spawnFixture("enforce", proxy), /loop_stalled lag [0-9.]+s; retry failed: .*loop_stalled lag [0-9.]+s/);
  assert.equal(proxy.connections, 2);
});

test("W1-T5747: healthy readiness adds no diagnostic and preserves the exchanges", async () => {
  const proxy = await listener("healthy");
  const result = await spawnFixture("enforce", proxy);
  assert.equal("egress_unenforced" in workerLedgerFields(result), false);
  assert.equal(proxy.connections, 2);
});

test("W1-T5747: the real proxy's positive controls remain healthy", async () => {
  const proxy = await startWorkerEgressProxy({ sandbox: { network: { allowedDomains: ["github.com"] } } });
  try {
    await verifyWorkerEgressProxy(proxy);
  } finally {
    await proxy.close();
  }
});
