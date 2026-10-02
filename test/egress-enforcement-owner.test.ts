import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect, Server } from "node:net";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import * as containment from "../src/lib/containment.js";
import { spawnWorker, type SpawnWorkerArgs } from "../src/lib/worker.js";

const settings = JSON.parse(readFileSync(new URL("../settings/worker.json", import.meta.url), "utf8"));
const domains: string[] = settings.sandbox.network.allowedDomains;

async function httpStatus(port: number, url: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.setTimeout(3000, () => req.destroy(new Error("HTTP test timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function exchange(port: number, data: Buffer | string, enough: (b: Buffer) => boolean): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(data));
    let out = Buffer.alloc(0);
    socket.setTimeout(3000, () => socket.destroy(new Error("exchange timed out")));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      out = Buffer.concat([out, chunk]);
      if (enough(out)) { resolve(out); socket.destroy(); }
    });
    socket.on("end", () => { resolve(out); socket.destroy(); });
  });
}

function socksRequest(host: string, port = 443): Buffer {
  const name = Buffer.from(host);
  return Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]);
}

// No forge or public network: approved destinations resolve to this fixture only through the
// connector seam. Refused destinations must never reach that seam.
test("egress owner permits each declared domain and console, refuses every other HTTP/CONNECT/SOCKS destination", async () => {
  const upstream = createServer((_req, res) => res.end("allowed"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const contacted: string[] = [];
  const proxy = await containment.startWorkerEgressProxy(settings, (host, _port) => {
    contacted.push(host);
    return connect(upstreamPort, "127.0.0.1");
  });
  try {
    await containment.verifyWorkerEgressProxy(proxy);
    for (const host of [...domains, "remudero-serve"]) {
      assert.equal(await httpStatus(proxy.httpProxyPort, `http://${host}${host === "remudero-serve" ? ":4317" : ""}/`), 200);
      const tunnel = await exchange(proxy.httpProxyPort, `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`, b => b.includes("\r\n\r\n"));
      assert.match(tunnel.toString(), /200/);
      // Coalesced greeting + request exercises buffering rather than relying on packet boundaries.
      const socks = await exchange(proxy.socksProxyPort, socksRequest(host), b => b.length >= 12);
      assert.equal(socks[1], 0);
      assert.equal(socks[3], 0);
    }
    const before = contacted.length;
    for (const host of ["example.com", "api.anthropic.com", "github.com.evil.test", "evilgithub.com", "127.0.0.1", "[::1]"]) {
      assert.equal(await httpStatus(proxy.httpProxyPort, `http://${host}/`), 403);
      const denied = await exchange(proxy.httpProxyPort, `CONNECT ${host}:443 HTTP/1.1\r\n\r\n`, b => b.includes("\r\n\r\n"));
      assert.match(denied.toString(), /403/);
      const socks = await exchange(proxy.socksProxyPort, socksRequest(host), b => b.length >= 12);
      assert.equal(socks[3], 2);
    }
    assert.equal(contacted.length, before, "denials must happen before DNS or dialing");
    assert.equal(await httpStatus(proxy.httpProxyPort, "http://GITHUB.COM/"), 200);
    assert.equal(await httpStatus(proxy.httpProxyPort, "http://github.com@evil.test/"), 403);
    assert.equal(await httpStatus(proxy.httpProxyPort, "/relative"), 403);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
  await assert.rejects(httpStatus(proxy.httpProxyPort, "http://github.com/"), /ECONNREFUSED/);
  await assert.rejects(exchange(proxy.socksProxyPort, socksRequest("github.com"), b => b.length >= 12), /ECONNREFUSED/);
});

test("egress owner default connector reaches a real console fixture and teardown terminates active tunnels", async () => {
  const upstream = createServer((_req, res) => res.end("console"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const proxy = await containment.startWorkerEgressProxy({ sandbox: { network: { allowedDomains: ["127.0.0.1"] } } });
  try {
    assert.equal(await httpStatus(proxy.httpProxyPort, `http://127.0.0.1:${port}/`), 200);
    const socket = connect(proxy.httpProxyPort, "127.0.0.1");
    socket.on("error", () => {});
    socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`);
    await new Promise<void>(resolve => socket.once("data", () => resolve()));
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    await proxy.close();
    await closed;
    await proxy.close();
  } finally {
    await proxy.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("egress owner refuses absent or malformed allowlists and failed readiness", async () => {
  for (const allowedDomains of [undefined, [], ["*"], [42], ["https://github.com"]]) {
    await assert.rejects(containment.startWorkerEgressProxy({ sandbox: { network: { allowedDomains } } }), /allowlist/);
  }
  const proxy = await containment.startWorkerEgressProxy(settings);
  await proxy.close();
  await assert.rejects(containment.verifyWorkerEgressProxy(proxy));
  assert.equal(domains.includes("api.anthropic.com"), false);
  assert.equal(settings.sandbox.failIfUnavailable, true);
});

test("egress enforcer checks the actual CLI version against locked CLI metadata on every call", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-egress-version-"));
  const bin = join(root, "claude");
  const lockPath = join(root, "package-lock.json");
  const sdkPackagePath = join(root, "sdk-package.json");
  writeFileSync(lockPath, JSON.stringify({ packages: { "node_modules/@anthropic-ai/claude-agent-sdk": { version: "0.3.284" } } }));
  writeFileSync(sdkPackagePath, JSON.stringify({ version: "0.3.284", claudeCodeVersion: "2.1.284" }));
  try {
    writeFileSync(bin, '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\nprintf "2.1.284 (Claude Code)\\n"\n');
    chmodSync(bin, 0o700);
    assert.equal(containment.assertWorkerEgressEnforcerVersion(bin, lockPath, sdkPackagePath), "2.1.284");
    writeFileSync(bin, '#!/bin/sh\nprintf "2.1.999 (Claude Code)\\n"\n');
    assert.throws(() => containment.assertWorkerEgressEnforcerVersion(bin, lockPath, sdkPackagePath), /2.1.999.*2.1.284/);
    assert.throws(() => containment.assertWorkerEgressEnforcerVersion(join(root, "missing"), lockPath, sdkPackagePath), /version/);
    writeFileSync(bin, '#!/bin/sh\nprintf "unknown\\n"\n');
    assert.throws(() => containment.assertWorkerEgressEnforcerVersion(bin, lockPath, sdkPackagePath), /version/);
    writeFileSync(sdkPackagePath, JSON.stringify({ version: "0.3.999", claudeCodeVersion: "2.1.284" }));
    assert.throws(() => containment.assertWorkerEgressEnforcerVersion(bin, lockPath, sdkPackagePath), /locked/);
    writeFileSync(sdkPackagePath, JSON.stringify({ version: "0.3.284" }));
    assert.throws(() => containment.assertWorkerEgressEnforcerVersion(bin, lockPath, sdkPackagePath), /CLI/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function fixtureSpawn(run: (options: Options) => AsyncGenerator<unknown>, egress: NonNullable<SpawnWorkerArgs["egress"]>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-egress-spawn-"));
  const settingsFile = join(root, "worker.json");
  writeFileSync(settingsFile, JSON.stringify(settings));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    return await spawnWorker({
      cwd: root, settingsFile, permissionMode: "bypassPermissions", prompt: "synthetic", config: { root, workerHomeRoot: join(root, "worker-home"), claudeBin: "/fake" },
      mountProvider: "claude", egress,
      keychain: { platform: "linux", accountId: "fixture", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }) },
      claudeExecutable: { cache: {}, deps: { env: {}, which: () => "/fake", exists: () => true, canExecute: () => true } },
      queryFn: (({ options }: { options: Options }) => run(options)) as never,
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

test("spawn starts and verifies a private proxy before query, passes ports, and closes on success and errors", async () => {
  for (const fail of [false, true]) {
    let proxy: Awaited<ReturnType<typeof containment.startWorkerEgressProxy>> | undefined;
    const order: string[] = [];
    const egress = {
      checkVersion: (bin: string) => { assert.equal(bin, "/fake"); order.push("version"); return "2.1.284"; },
      startProxy: async (policy: unknown) => { order.push("start"); return proxy = await containment.startWorkerEgressProxy(policy); },
    };
    const result = fixtureSpawn(async function* (options) {
      order.push("query");
      assert.ok(proxy);
      assert.ok(options.settings && typeof options.settings !== "string");
      assert.equal(options.settings.sandbox?.network?.httpProxyPort, proxy.httpProxyPort);
      assert.equal(options.settings.sandbox?.network?.socksProxyPort, proxy.socksProxyPort);
      assert.deepEqual(options.settings.hooks, settings.hooks);
      assert.equal(await httpStatus(proxy.httpProxyPort, "http://example.com/"), 403);
      if (fail) throw new Error("fixture query failed");
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "fixture", num_turns: 1, total_cost_usd: 0, permission_denials: [] };
    }, egress);
    if (fail) await assert.rejects(result, /fixture query failed/); else await result;
    assert.deepEqual(order, ["version", "start", "query"]);
    assert.ok(proxy);
    await assert.rejects(httpStatus(proxy.httpProxyPort, "http://example.com/"), /ECONNREFUSED/);
  }
});

test("spawn refuses version drift, proxy startup failure, and a dead proxy before querying", async () => {
  let queried = false;
  const run = async function* () { queried = true; };
  await assert.rejects(fixtureSpawn(run, { checkVersion: () => { throw new Error("version drift"); } }), /version drift/);
  await assert.rejects(fixtureSpawn(run, { checkVersion: () => "ok", startProxy: async () => { throw new Error("proxy startup failed"); } }), /proxy startup failed/);
  await assert.rejects(fixtureSpawn(run, { checkVersion: () => "ok", startProxy: async () => {
    const proxy = await containment.startWorkerEgressProxy(settings);
    await proxy.close();
    return proxy;
  } }));
  assert.equal(queried, false);
});

test("egress proxies are private to each spawn; closing one leaves the other verified", async () => {
  const first = await containment.startWorkerEgressProxy(settings);
  const second = await containment.startWorkerEgressProxy(settings);
  try {
    assert.notEqual(first.httpProxyPort, second.httpProxyPort);
    assert.notEqual(first.socksProxyPort, second.socksProxyPort);
    await first.close();
    await containment.verifyWorkerEgressProxy(second);
  } finally { await first.close(); await second.close(); }
});

test("egress owner refuses malformed CONNECT and SOCKS frames, including literal addresses and unsupported auth", async () => {
  let contacted = 0;
  const proxy = await containment.startWorkerEgressProxy(settings, () => { contacted++; throw new Error("must not dial"); });
  try {
    for (const authority of ["github.com", "http://github.com:443/", "user@github.com:443", "github.com:0", "github.com:65536", "github.com:443/path"]) {
      const reply = await exchange(proxy.httpProxyPort, `CONNECT ${authority} HTTP/1.1\r\n\r\n`, b => b.includes("\r\n\r\n"));
      assert.match(reply.toString(), /403/);
    }
    const unauthenticated = await exchange(proxy.socksProxyPort, Buffer.from([5, 1, 2]), b => b.length >= 2);
    assert.deepEqual([...unauthenticated], [5, 255]);
    for (const frame of [
      [5, 2, 0, 3, 1, 97, 1, 187], // BIND is not CONNECT
      [5, 1, 0, 1, 127, 0, 0, 1, 1, 187], // IPv4
      [5, 1, 0, 4, ...new Array(16).fill(0), 1, 187], // IPv6
      [5, 1, 1, 3, 1, 97, 1, 187], // reserved byte
      [4, 1, 0, 3, 1, 97, 1, 187], // wrong protocol
      [5, 1, 0, 3, 1, 47, 1, 187], // invalid hostname
    ]) {
      const reply = await exchange(proxy.socksProxyPort, Buffer.from([5, 1, 0, ...frame]), b => b.length >= 12);
      assert.equal(reply[3], 2);
    }
    assert.equal(contacted, 0);
  } finally { await proxy.close(); }
});

test("egress owner reports upstream failures for HTTP and SOCKS without opening another destination", async () => {
  const unused = createServer();
  await new Promise<void>(resolve => unused.listen(0, "127.0.0.1", resolve));
  const port = (unused.address() as { port: number }).port;
  await new Promise<void>(resolve => unused.close(() => resolve()));
  const proxy = await containment.startWorkerEgressProxy(settings, () => connect(port, "127.0.0.1"));
  try {
    assert.equal(await httpStatus(proxy.httpProxyPort, "http://github.com/"), 502);
    const socks = await exchange(proxy.socksProxyPort, socksRequest("github.com"), b => b.length >= 12);
    assert.equal(socks[3], 5);
    const tunnel = await exchange(proxy.httpProxyPort, "CONNECT github.com:443 HTTP/1.1\r\n\r\n", b => b.length > 0);
    assert.equal(tunnel.length, 0, "a failed upstream must not acknowledge CONNECT success");
  } finally { await proxy.close(); }
});

test("HTTP forwarding preserves method, body and target Host while stripping proxy credentials", async () => {
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/publish?q=1");
      assert.equal(req.headers.host, "registry.npmjs.org");
      assert.equal(req.headers["proxy-authorization"], undefined);
      assert.equal(req.headers["x-hop"], undefined);
      assert.equal(body, "package");
      res.writeHead(201).end();
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const proxy = await containment.startWorkerEgressProxy(settings, () => connect(port, "127.0.0.1"));
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: proxy.httpProxyPort, path: "http://registry.npmjs.org/publish?q=1", method: "POST", headers: { host: "evil.test", "proxy-authorization": "fake", connection: "x-hop", "x-hop": "secret" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject);
      req.end("package");
    });
    assert.equal(status, 201);
  } finally { await proxy.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test("readiness refuses protocol impostors on either listener", async () => {
  const fake = createServer((_req, res) => res.end());
  // CONNECT must get a denial, not a success-shaped banner.
  fake.on("connect", (_req, socket) => socket.end("HTTP/1.1 200 Connection Established\r\n\r\n"));
  await new Promise<void>(resolve => fake.listen(0, "127.0.0.1", resolve));
  const port = (fake.address() as { port: number }).port;
  const proxy = await containment.startWorkerEgressProxy(settings);
  try {
    await assert.rejects(containment.verifyWorkerEgressProxy({ ...proxy, httpProxyPort: port, verifyAllowed: async () => {} }), /HTTP egress refusal/);
    // A real HTTP server cannot serve the SOCKS protocol and must also be rejected.
    await assert.rejects(containment.verifyWorkerEgressProxy({ ...proxy, socksProxyPort: port, verifyAllowed: async () => {} }), /SOCKS egress refusal/);
  } finally { await proxy.close(); await new Promise<void>(resolve => fake.close(() => resolve())); }
});

test("egress startup fails closed and closes the first listener if the second cannot bind", async (t) => {
  const original = Server.prototype.listen;
  for (const failureAt of [1, 2]) {
    let calls = 0;
    let first: Server | undefined;
    const mock = t.mock.method(Server.prototype, "listen", function (this: Server, ...args: unknown[]) {
      if (++calls === failureAt) throw new Error("fixture bind unavailable");
      first = this;
      return Reflect.apply(original, this, args);
    });
    try {
      await assert.rejects(containment.startWorkerEgressProxy(settings), /proxy startup failed.*bind unavailable/);
      if (first) assert.equal(first.listening, false);
    } finally { mock.mock.restore(); }
  }
});

test("egress version default readers use the lockfile and installed bundled CLI metadata", () => {
  const require = createRequire(import.meta.url);
  const sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const pkg = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "rmd-egress-default-version-"));
  const bin = join(root, "claude");
  try {
    writeFileSync(bin, `#!/bin/sh\nprintf '${pkg.claudeCodeVersion} (Claude Code)\\n'\n`);
    chmodSync(bin, 0o700);
    assert.equal(containment.assertWorkerEgressEnforcerVersion(bin), pkg.claudeCodeVersion);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
