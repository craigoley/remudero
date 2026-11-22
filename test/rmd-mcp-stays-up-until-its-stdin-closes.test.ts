import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { test } from "node:test";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createOperatorMcpServer, operatorMcpCommand } from "#src/lib/operator-mcp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// BACKSTOP: a hung session fails its test after this long instead of stalling the run.
const READ_BOUND_MS = 10_000;

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "w1-t14173", version: "1" } } };
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const CALL_INBOX = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "inbox", arguments: {} } };

function tokenRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-t14173-root-"));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "service-tokens.json"), JSON.stringify({ read: "r-token" }));
  return root;
}

/** Reads newline-delimited JSON-RPC messages from a stream; `next(id)` waits for the response with that id. */
function messages(stream: Readable) {
  const seen: Record<string, unknown>[] = [];
  let buffer = "";
  const waiters: Array<() => void> = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) seen.push(JSON.parse(line) as Record<string, unknown>);
    }
    for (const wake of waiters.splice(0)) wake();
  });
  const next = async (id: number): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + READ_BOUND_MS;
    for (;;) {
      const found = seen.find((message) => message.id === id);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no JSON-RPC response ${id} within ${READ_BOUND_MS} ms; saw ${JSON.stringify(seen)}`);
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, left); waiters.push(() => { clearTimeout(timer); resolve(); }); });
    }
  };
  return { seen, next };
}

const send = (stream: NodeJS.WritableStream, message: unknown) => { stream.write(JSON.stringify(message) + "\n"); };
const PENDING = Symbol("pending");
const settledYet = async <T>(promise: Promise<T>) => Promise.race([promise, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 50))]);

test("W1-T14173 criterion 1: operatorMcpCommand stays pending after initialize and resolves 0 only after stdin ends", async () => {
  const root = tokenRoot();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let server: Server | undefined;
  try {
    const read = messages(stdout);
    const result = operatorMcpCommand([], { root }, REPO_ROOT, (config) => (server = createOperatorMcpServer(config)), { stdin, stdout });
    send(stdin, INITIALIZE);
    const initialized = await read.next(1);
    assert.equal((initialized.result as { serverInfo: { name: string } }).serverInfo.name, "remudero-operator");
    assert.equal(await settledYet(result), PENDING, "the verb must not return while its input is still open");
    assert.ok(server?.transport, "the server is connected while the session lasts");
    stdin.end();
    assert.equal(await result, 0);
    assert.equal(server.transport, undefined, "the server is closed before the verb returns");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface FakeRequest { method?: string; url?: string; headers: IncomingHttpHeaders }

async function fakeControlServer() {
  const requests: FakeRequest[] = [];
  const http = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    if (request.method === "GET" && request.url === "/v1/inbox") {
      response.writeHead(200, { "Content-Type": "text/plain" }).end("fake inbox: 0 decisions waiting");
    } else response.writeHead(404).end("no such route");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return { requests, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}

function exited(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error(`the child did not exit within ${READ_BOUND_MS} ms`)), READ_BOUND_MS);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

/** Criteria 2 and 3 share one real child session over its own process.stdin and process.stdout. */
async function realSession() {
  const root = tokenRoot();
  const home = mkdtempSync(join(tmpdir(), "rmd-t14173-home-"));
  const fake = await fakeControlServer();
  const child = spawn(process.execPath, ["--import", "tsx", join(REPO_ROOT, "test", "fixtures", "operator-mcp-cli-entry.ts"), root], {
    cwd: REPO_ROOT, env: { ...process.env, HOME: home, RMD_OPERATOR_MCP_URL: fake.url }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  try {
    const read = messages(child.stdout);
    send(child.stdin, INITIALIZE);
    const initialized = await read.next(1);
    send(child.stdin, INITIALIZED);
    send(child.stdin, LIST);
    const listed = await read.next(2);
    const runningAfterList = child.exitCode === null && child.signalCode === null;
    send(child.stdin, CALL_INBOX);
    const called = await read.next(3);
    const runningBeforeEnd = child.exitCode === null && child.signalCode === null;
    child.stdin.end();
    const code = await exited(child);
    return { initialized, listed, called, code, runningAfterList, runningBeforeEnd, requests: fake.requests, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fake.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("W1-T14173 criterion 2: the CLI entry answers initialize, tools/list and tools/call over real stdio, then exits 0", async () => {
  const session = await realSession();
  assert.equal((session.initialized.result as { serverInfo: { name: string } }).serverInfo.name, "remudero-operator", session.stderr);
  const names = (session.listed.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  for (const name of ["inbox", "ledger_grep", "case_file"]) assert.ok(names.includes(name), `tools/list holds ${name}: ${names.join(",")}`);
  const content = (session.called.result as { content: { text: string }[]; isError?: boolean });
  assert.notEqual(content.isError, true, content.content[0]?.text);
  assert.equal(content.content[0]?.text, "fake inbox: 0 decisions waiting");
  assert.equal(session.code, 0, session.stderr);
});

test("W1-T14173 criterion 3: the child sends one read-token GET /v1/inbox, no write route, and stays up until stdin ends", async () => {
  const session = await realSession();
  assert.deepEqual(session.requests.map((request) => `${request.method} ${request.url}`), ["GET /v1/inbox"], session.stderr);
  assert.equal(session.requests[0]!.headers.authorization, "Bearer r-token");
  assert.equal(session.runningAfterList, true, "the child is still running after the tools/list response");
  assert.equal(session.runningBeforeEnd, true, "the child is still running until its stdin ends");
});

test("W1-T14173 criterion 4: argument and token errors still throw before any transport starts", async () => {
  const root = tokenRoot();
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let built = 0;
    const factory = (config: Parameters<typeof createOperatorMcpServer>[0]) => { built++; return createOperatorMcpServer(config); };
    await assert.rejects(operatorMcpCommand(["--approve"], { root }, REPO_ROOT, factory, { stdin, stdout }), /usage: rmd mcp/);
    await assert.rejects(operatorMcpCommand(["--enable-write"], { root }, REPO_ROOT, factory, { stdin, stdout }), /write-scope token/);
    assert.equal(built, 0, "no server is built");
    assert.equal(stdin.listenerCount("data"), 0, "no transport listens on stdin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
