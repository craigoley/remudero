/**
 * W1-T13238: on 2026-11-16 `rmd archive verify-human:W1-T235` timed out at 400 s from the Azure host and wrote
 * nothing: the CLI built the Inbox actions in-process with live gh and projected the whole plan. The Console reaches
 * the same actions through serve's write routes, which hold the plan snapshot. The CLI now posts there first.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, globalAgent, type Server } from "node:http";
import { Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { INBOX_VERBS, inboxVerbCommand, type InboxVerbActions, type InboxVerbName } from "#src/lib/inbox-verdict-command.js";
import type { Config } from "#src/lib/config.js";
import { inboxCliServeTarget, inboxVerbViaServe, serveFirstInboxActions } from "#src/lib/inbox-cli-serve.js";

type Ctx = { after: (fn: () => void | Promise<void>) => void; mock: { method: typeof import("node:test").mock.method } };
const TOKEN = "ab".repeat(32);

function root(t: Ctx, token: string | null = TOKEN): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inbox-cli-serve-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "state"), { recursive: true });
  if (token !== null) writeFileSync(join(dir, "state", "service-tokens.json"), JSON.stringify({ read: "cd".repeat(32), write: token }));
  return dir;
}

/** A serve stand-in: each verb route answers through `actions`, and every request is recorded. */
async function serve(t: Ctx, actions: InboxVerbActions) {
  const seen: Array<{ path: string; auth: string | undefined; body: unknown }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      const spec = INBOX_VERBS.find((verb) => verb.path === req.url);
      if (!spec) { res.writeHead(404).end("{}"); return; }
      void actions[spec.name](body, { origin: "token:write" }, (status, result) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(result));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, seen };
}

/** A port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Runs one CLI call and returns its exit code and what it printed. */
async function captured(t: Ctx, run: () => Promise<number>): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [], err: string[] = [];
  const log = t.mock.method(console, "log", (line: unknown) => { out.push(String(line)); });
  const error = t.mock.method(console, "error", (line: unknown) => { err.push(String(line)); });
  try { return { code: await run(), out, err }; } finally { log.mock.restore(); error.mock.restore(); }
}

/** Answers that exercise each exit code: recorded, refused, invalid. */
function fakeActions(): InboxVerbActions & { calls: InboxVerbName[] } {
  const calls: InboxVerbName[] = [];
  const act = (name: InboxVerbName) => (body: unknown, _actor: unknown, respond: (status: number, body: unknown) => void) => {
    calls.push(name);
    const id = (body as { proposalId?: string }).proposalId;
    if (id === "refused") respond(409, { error: "conflict", detail: `${name} refused for ${id}` });
    else if (id === "invalid") respond(400, { error: "invalid_request", detail: "no such state" });
    else respond(200, { ok: true, verb: name, proposalId: id });
  };
  return Object.assign(Object.fromEntries(INBOX_VERBS.map((verb) => [verb.name, act(verb.name)])) as unknown as InboxVerbActions, { calls });
}

test("W1-T13238 criterion 1: rmd archive posts to the running serve's write route with the write token and prints its answer", async (t) => {
  const actions = fakeActions();
  const { port, seen } = await serve(t, actions);
  const config = { root: root(t), serve: { port } } as unknown as Config;
  const result = await captured(t, () => inboxVerbViaServe("archive", ["P7"], config, () => { throw new Error("ran in-process"); }, {}));
  assert.equal(result.code, 0);
  assert.deepEqual(result.out, [JSON.stringify({ ok: true, verb: "archive", proposalId: "P7" })]);
  assert.deepEqual(result.err, [], "no in-process fallback was taken");
  assert.deepEqual(seen, [{ path: "/v1/inbox/archive", auth: `Bearer ${TOKEN}`, body: { proposalId: "P7", archived: true } }]);
});

test("W1-T13238 criterion 2: with no serve reachable the verb runs in-process and says so on stderr", async (t) => {
  const port = await closedPort();
  const local = fakeActions();
  let built = 0;
  const actions = serveFirstInboxActions({ url: `http://127.0.0.1:${port}`, token: TOKEN }, () => { built++; return local; });
  const result = await captured(t, () => inboxVerbCommand("snooze", ["P3", "--wake"], actions));
  assert.equal(result.code, 0);
  assert.deepEqual(local.calls, ["snooze"]);
  assert.equal(built, 1);
  assert.deepEqual(result.err, [`rmd snooze: no serve answered at http://127.0.0.1:${port} (ECONNREFUSED); running in-process`]);

  // No token: the target says why, and the CLI never mints one.
  const bare = root(t, null);
  const target = inboxCliServeTarget({ root: bare } as unknown as Config, {});
  assert.ok("reason" in target && /no serve write token/.test(target.reason));
  const fallback = await captured(t, () => inboxVerbViaServe("snooze", ["P3", "--wake"],
    { root: bare } as unknown as Config, () => fakeActions(), {}));
  assert.equal(fallback.code, 0);
  assert.deepEqual(fallback.out, [JSON.stringify({ ok: true, verb: "snooze", proposalId: "P3" })]);
  assert.deepEqual(fallback.err, ["rmd snooze: no serve write token (ENOENT); running in-process"]);
  assert.equal(existsSync(join(bare, "state", "service-tokens.json")), false);
  assert.deepEqual(inboxCliServeTarget({ root: root(t), serve: { port: 9 } } as unknown as Config, { RMD_SERVE_PORT: "4400" }),
    { url: "http://127.0.0.1:4400", token: TOKEN }, "RMD_SERVE_PORT wins over config");
});

test("W1-T13238: a stalled serve connection falls back at the two-second connect deadline", async (t) => {
  const socket = Object.assign(new Socket(), { connecting: true });
  t.after(() => { socket.destroy(); });
  const connect = t.mock.method(globalAgent, "createConnection", () => socket);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const local = fakeActions();
  const url = "http://127.0.0.1:1";
  const actions = serveFirstInboxActions({ url, token: TOKEN }, () => local);
  const result = await captured(t, async () => {
    const run = inboxVerbCommand("snooze", ["P3", "--wake"], actions);
    await setImmediate(); // Let the HTTP request attach the pending socket before advancing the clock.
    assert.equal(connect.mock.callCount(), 1);
    t.mock.timers.tick(1_999);
    assert.equal(socket.destroyed, false);
    t.mock.timers.tick(1);
    assert.equal(socket.destroyed, true);
    return run;
  });
  assert.equal(result.code, 0);
  assert.deepEqual(local.calls, ["snooze"]);
  assert.deepEqual(result.err, [`rmd snooze: no serve answered at ${url} (CONNECT_TIMEOUT); running in-process`]);
});

test("W1-T13238 criterion 3: invariant:same-answer-either-path — archive, snooze and decline print the same and exit the same through serve or in-process", async (t) => {
  const { port } = await serve(t, fakeActions());
  const viaServe = serveFirstInboxActions({ url: `http://127.0.0.1:${port}`, token: TOKEN }, () => { throw new Error("must not run in-process"); });
  const cases: Array<[InboxVerbName, string[]]> = [];
  for (const id of ["P1", "refused", "invalid"]) {
    cases.push(["archive", [id]], ["snooze", [id, "--until", "2026-12-01T00:00:00Z"]], ["decline", [id, "--reason", "duplicate"]]);
  }
  for (const [name, args] of cases) {
    const local = await captured(t, () => inboxVerbCommand(name, args, fakeActions()));
    const remote = await captured(t, () => inboxVerbCommand(name, args, viaServe));
    assert.deepEqual(remote, local, `${name} ${args.join(" ")}`);
  }
  const codes = new Set<number>();
  for (const [name, args] of cases) codes.add((await captured(t, () => inboxVerbCommand(name, args, viaServe))).code);
  assert.deepEqual([...codes].sort(), [0, 1, 2], "positive control: recorded, refused and invalid all occur");
});

test("W1-T13238: the CLI's restated serve port and token path match serve's own", async () => {
  const serve = await import("#src/lib/serve.js");
  const { INBOX_CLI_DEFAULT_SERVE_PORT } = await import("#src/lib/inbox-cli-serve.js");
  assert.equal(INBOX_CLI_DEFAULT_SERVE_PORT, serve.DEFAULT_SERVE_PORT);
  assert.equal(serve.serviceTokensPath("/r"), join("/r", "state", "service-tokens.json"));
});
