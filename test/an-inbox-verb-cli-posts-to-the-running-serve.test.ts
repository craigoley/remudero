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
import { inboxCliServeTarget, inboxVerbViaServe, proposalVerdictViaServe, serveFirstInboxActions, INBOX_CLI_DEFAULT_SERVE_PORT } from "#src/lib/inbox-cli-serve.js";
import { applyProposalVerdict } from "#src/lib/inbox.js";
import { proposalVerdictCommand } from "#src/lib/inbox-verdict-command.js";

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
  const result = await captured(t, () => inboxVerbViaServe("archive", ["P7"], config, () => { throw new Error("ran in-process"); }));
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
  const target = inboxCliServeTarget({ root: bare } as unknown as Config);
  assert.ok("reason" in target && /no serve write token/.test(target.reason));
  const fallback = await captured(t, () => inboxVerbViaServe("snooze", ["P3", "--wake"],
    { root: bare } as unknown as Config, () => fakeActions()));
  assert.equal(fallback.code, 0);
  assert.deepEqual(fallback.out, [JSON.stringify({ ok: true, verb: "snooze", proposalId: "P3" })]);
  assert.deepEqual(fallback.err, ["rmd snooze: no serve write token (ENOENT); running in-process"]);
  assert.equal(existsSync(join(bare, "state", "service-tokens.json")), false);
});

test("W1-T13238: the CLI prefers RMD_SERVE_PORT, then the configured port, then serve's default", (t) => {
  const prior = process.env.RMD_SERVE_PORT;
  t.after(() => { if (prior === undefined) delete process.env.RMD_SERVE_PORT; else process.env.RMD_SERVE_PORT = prior; });
  const base = { root: root(t) };
  const configured = { ...base, serve: { port: 9 } };

  process.env.RMD_SERVE_PORT = "4400";
  assert.deepEqual(inboxCliServeTarget(configured), { url: "http://127.0.0.1:4400", token: TOKEN });
  assert.deepEqual(inboxCliServeTarget(base), { url: "http://127.0.0.1:4400", token: TOKEN });

  delete process.env.RMD_SERVE_PORT;
  assert.deepEqual(inboxCliServeTarget(configured), { url: "http://127.0.0.1:9", token: TOKEN });
  assert.deepEqual(inboxCliServeTarget(base), { url: `http://127.0.0.1:${INBOX_CLI_DEFAULT_SERVE_PORT}`, token: TOKEN });
});

test("W1-T13238: without a serve write token, the CLI warns once and returns the local verdict", async (t) => {
  const config = { root: root(t, null) };
  const local = fakeActions();
  const result = await captured(t, () => inboxVerbViaServe("archive", ["refused"], config, () => local));

  assert.deepEqual(result, {
    code: 1,
    out: [],
    err: [
      "rmd archive: no serve write token (ENOENT); running in-process",
      JSON.stringify({ error: "conflict", detail: "archive refused for refused" }),
    ],
  });
  assert.deepEqual(local.calls, ["archive"]);
  assert.equal(existsSync(join(config.root, "state", "service-tokens.json")), false);
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
  assert.equal(INBOX_CLI_DEFAULT_SERVE_PORT, serve.DEFAULT_SERVE_PORT);
  assert.equal(serve.serviceTokensPath("/r"), join("/r", "state", "service-tokens.json"));
});

/** The production verdict for one proposal, as both serve's route and the in-process command decide it. */
const verdictFind = (id: string) => id === "P1" ? { exists: true, classification: { proposalId: "P1", state: "ready" } as never }
  : id === "Pd" ? { exists: true, classification: { proposalId: "Pd", state: "declined", declinedReason: "duplicate" } as never } : { exists: false };

test("W1-T13238: decline warns when the write token is missing and returns the local refusal", async (t) => {
  const config = { root: root(t, null) };
  const args = ["Pgone", "--reason", "duplicate"];
  const connect = t.mock.method(globalAgent, "createConnection", () => assert.fail("attempted to connect without a token"));
  const result = await captured(t, () => proposalVerdictViaServe("decline", args, config, () =>
    proposalVerdictCommand("decline", args, verdictFind, () => assert.fail("recorded a verdict for a missing proposal"))));

  assert.deepEqual(result, {
    code: 1,
    out: [],
    err: [
      "rmd decline: no serve write token (ENOENT); running in-process",
      'rmd decline: no active proposal "Pgone"',
    ],
  });
  assert.equal(connect.mock.callCount(), 0);
});

test("W1-T13238: restore warns when serve refuses the connection and records the local verdict", async (t) => {
  const config = { root: root(t), serve: { port: 1 } };
  const args = ["Pd", "--reason", "reconsidered"];
  const socket = Object.assign(new Socket(), { connecting: true });
  t.after(() => { socket.destroy(); });
  const connect = t.mock.method(globalAgent, "createConnection", () => socket);
  const recorded: Array<[string, string, string]> = [];
  const result = await captured(t, async () => {
    const run = proposalVerdictViaServe("restore", args, config, () =>
      proposalVerdictCommand("restore", args, verdictFind, (step, id, reason) => { recorded.push([step, id, reason]); }));
    await setImmediate();
    assert.equal(connect.mock.callCount(), 1);
    socket.destroy(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
    return run;
  });

  assert.deepEqual(result, {
    code: 0,
    out: ["rmd restore: Pd RESTORED — it is back in the inbox and classifies as it would have before the decline"],
    err: ["rmd restore: no serve answered at http://127.0.0.1:1 (ECONNREFUSED); running in-process"],
  });
  assert.deepEqual(recorded, [["panel.proposal_restored", "Pd", "reconsidered"]]);
});

/** A serve stand-in for the verdict routes, answering as panel-graph.ts's route does from applyProposalVerdict. */
async function verdictServe(t: Ctx) {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { proposalId: string; reason: string };
      const kind = req.url === "/v1/inbox/decline" ? "decline" : "restore";
      const outcome = applyProposalVerdict(kind, input, verdictFind(input.proposalId), () => {});
      const [status, body] = outcome.ok ? [200, { ok: true, proposalId: input.proposalId, ...(kind === "decline" ? { declined: true } : { restored: true }) }]
        : [outcome.status, { error: outcome.error, detail: outcome.detail }];
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

test("W1-T13238 criterion 3: rmd decline and rmd restore print and exit the same through serve as the in-process command", async (t) => {
  const port = await verdictServe(t);
  const config = { root: root(t), serve: { port } } as unknown as Config;
  for (const [kind, id] of [["decline", "P1"], ["decline", "Pd"], ["decline", "Pgone"], ["restore", "Pd"], ["restore", "P1"]] as const) {
    const args = [id, "--reason", "duplicate"];
    const local = await captured(t, async () => proposalVerdictCommand(kind, args, verdictFind, () => {}));
    const remote = await captured(t, () => proposalVerdictViaServe(kind, args, config, () => { throw new Error("must not run in-process"); }));
    assert.deepEqual(remote, local, `${kind} ${id}`);
  }
  // Arguments the route would not take are the in-process command's to refuse, with its own usage line.
  let ran = 0;
  assert.equal(await proposalVerdictViaServe("decline", ["P1"], config, () => { ran++; return 2; }), 2);
  assert.equal(ran, 1);
});

test("W1-T13238: rmd decline and rmd restore run in-process, saying why, when no serve token or no serve answers", async (t) => {
  const args = ["P1", "--reason", "duplicate"];
  let ran = 0;
  const inProcess = () => { ran++; return 0; };

  const bare = await captured(t, () => proposalVerdictViaServe("decline", args, { root: root(t, null) } as unknown as Config, inProcess));
  assert.deepEqual(bare, { code: 0, out: [], err: ["rmd decline: no serve write token (ENOENT); running in-process"] });
  assert.equal(ran, 1);

  const port = await closedPort();
  const config = { root: root(t), serve: { port } } as unknown as Config;
  const refused = await captured(t, () => proposalVerdictViaServe("restore", args, config, inProcess));
  assert.deepEqual(refused, { code: 0, out: [],
    err: [`rmd restore: no serve answered at http://127.0.0.1:${port} (ECONNREFUSED); running in-process`] });
  assert.equal(ran, 2);
});
