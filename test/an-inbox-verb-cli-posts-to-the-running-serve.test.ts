/**
 * W1-T13238: on 2026-11-16 `rmd archive verify-human:W1-T235` timed out at 400 s from the Azure host and wrote
 * nothing: the CLI built the Inbox actions in-process with live gh and projected the whole plan. The Console reaches
 * the same actions through serve's write routes, which hold the plan snapshot. The CLI now posts there first.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent, createServer, type Server } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { INBOX_VERBS, inboxVerbCommand, type InboxVerbActions, type InboxVerbName } from "#src/lib/inbox-verdict-command.js";
import type { Config } from "#src/lib/config.js";
import { inboxCliServeTarget, inboxVerbViaServe, proposalVerdictInProcess, proposalVerdictViaServe, serveFirstInboxActions, INBOX_CLI_DEFAULT_SERVE_PORT } from "#src/lib/inbox-cli-serve.js";
import { anchorFingerprint, applyProposalVerdict } from "#src/lib/inbox.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { gitRepo } from "#test/helpers/git-repo.js";
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

const SERVE_PORT = 4417;
const STALE_PORT = 4400;

/** Use Node's HTTP client and server over paired streams, with an explicit refusal at unbound ports. */
function useHttpEndpoints(t: Ctx, endpoints = new Map<number, Server>()) {
  const sockets: Duplex[] = [];
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  t.mock.method(Agent.prototype, "createConnection", ({ port }: { port: string }) => {
    const server = endpoints.get(Number(port));
    if (!server) {
      const socket = Object.assign(new Socket(), { connecting: true });
      globalThis.setImmediate(() => socket.destroy(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })));
      return socket;
    }
    const endpoint = (peer: () => Duplex) => Object.assign(new Duplex({
      read() {},
      write(chunk, _encoding, done) { peer().push(chunk); done(); },
      final(done) { peer().push(null); done(); },
    }), {
      setTimeout() { return this; },
      setNoDelay() { return this; },
      setKeepAlive() { return this; },
      ref() { return this; },
      unref() { return this; },
      destroySoon(this: Duplex) { this.end(); },
      remoteAddress: "127.0.0.1",
    });
    const client: Duplex = endpoint(() => peer);
    const peer = endpoint(() => client);
    sockets.push(client, peer);
    server.emit("connection", peer);
    return client;
  });
}

/** A serve stand-in: each verb route answers through `actions`, and every request is recorded. */
function serve(actions: InboxVerbActions) {
  const seen: Array<{ method: string | undefined; path: string; auth: string | undefined; body: unknown }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      seen.push({ method: req.method, path: req.url ?? "", auth: req.headers.authorization, body });
      const spec = INBOX_VERBS.find((verb) => verb.path === req.url);
      if (!spec) { res.writeHead(404).end("{}"); return; }
      void actions[spec.name](body, { origin: "token:write" }, (status, result) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(result));
      });
    });
  });
  return { server, seen };
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
  const { server, seen } = serve(actions);
  const port = SERVE_PORT;
  useHttpEndpoints(t, new Map([[port, server]]));
  const config = { root: root(t), serve: { port } } as unknown as Config;
  const result = await captured(t, () => inboxVerbViaServe("archive", ["P7"], config, () => { throw new Error("ran in-process"); }));
  assert.equal(result.code, 0);
  assert.deepEqual(result.out, [JSON.stringify({ ok: true, verb: "archive", proposalId: "P7" })]);
  assert.deepEqual(result.err, [], "no in-process fallback was taken");
  assert.deepEqual(seen, [{ method: "POST", path: "/v1/inbox/archive", auth: `Bearer ${TOKEN}`, body: { proposalId: "P7", archived: true } }]);
});

test("W1-T13238 criterion 2: with no serve reachable the verb runs in-process and says so on stderr", async (t) => {
  const port = SERVE_PORT;
  useHttpEndpoints(t);
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

test("W1-T13238: the CLI uses the configured port, then RMD_SERVE_PORT, then serve's default", (t) => {
  const prior = process.env.RMD_SERVE_PORT;
  t.after(() => { if (prior === undefined) delete process.env.RMD_SERVE_PORT; else process.env.RMD_SERVE_PORT = prior; });
  const base = { root: root(t) };
  const configured = { ...base, serve: { port: 9 } };

  process.env.RMD_SERVE_PORT = "4400";
  assert.deepEqual(inboxCliServeTarget(configured), { url: "http://127.0.0.1:9", token: TOKEN });
  assert.deepEqual(inboxCliServeTarget(base), { url: "http://127.0.0.1:4400", token: TOKEN });
  process.env.RMD_SERVE_PORT = "invalid";
  assert.deepEqual(inboxCliServeTarget(configured), { url: "http://127.0.0.1:9", token: TOKEN });
  assert.deepEqual(inboxCliServeTarget(base), { reason: "serve port must be an integer 1-65535" });

  delete process.env.RMD_SERVE_PORT;
  assert.deepEqual(inboxCliServeTarget(configured), { url: "http://127.0.0.1:9", token: TOKEN });
  assert.deepEqual(inboxCliServeTarget(base), { url: `http://127.0.0.1:${INBOX_CLI_DEFAULT_SERVE_PORT}`, token: TOKEN });
});

test("W1-T13238 criterion 1: rmd archive reaches configured serve while a stale RMD_SERVE_PORT answers 404", async (t) => {
  const prior = process.env.RMD_SERVE_PORT;
  t.after(() => { if (prior === undefined) delete process.env.RMD_SERVE_PORT; else process.env.RMD_SERVE_PORT = prior; });
  const { server, seen } = serve(fakeActions());
  const port = SERVE_PORT;
  const staleRequests: Array<string | undefined> = [];
  const stale = createServer((req, res) => {
    staleRequests.push(req.headers.authorization);
    res.writeHead(404).end(JSON.stringify({ error: "other_listener" }));
  });
  useHttpEndpoints(t, new Map([[port, server], [STALE_PORT, stale]]));
  process.env.RMD_SERVE_PORT = String(STALE_PORT);
  const config = { root: root(t), serve: { port } } as unknown as Config;
  const result = await captured(t, () => inboxVerbViaServe("archive", ["P7"], config, () => { throw new Error("ran in-process"); }));
  assert.deepEqual(staleRequests, [], "the stale listener received no request or bearer");
  assert.deepEqual(result, { code: 0, out: [JSON.stringify({ ok: true, verb: "archive", proposalId: "P7" })], err: [] });
  const request = { method: "POST", path: "/v1/inbox/archive", auth: `Bearer ${TOKEN}`, body: { proposalId: "P7", archived: true } };
  assert.deepEqual(seen, [request]);

  process.env.RMD_SERVE_PORT = String(port);
  const viaEnv = await captured(t, () => inboxVerbViaServe("archive", ["P7"], { root: config.root }, () => assert.fail("ran in-process")));
  assert.deepEqual(viaEnv, result);
  assert.deepEqual(seen, [request, request]);
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

test("W1-T13238 criterion 2: a stalled serve connection has one two-second deadline despite a stale override", async (t) => {
  const prior = process.env.RMD_SERVE_PORT;
  t.after(() => { if (prior === undefined) delete process.env.RMD_SERVE_PORT; else process.env.RMD_SERVE_PORT = prior; });
  process.env.RMD_SERVE_PORT = String(STALE_PORT);
  const socket = Object.assign(new Socket(), { connecting: true });
  t.after(() => { socket.destroy(); });
  const connect = t.mock.method(Agent.prototype, "createConnection", () => socket);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const local = fakeActions();
  const config = { root: root(t), serve: { port: SERVE_PORT } };
  const result = await captured(t, async () => {
    const run = inboxVerbViaServe("snooze", ["P3", "--wake"], config, () => local);
    await setImmediate(); // Let the HTTP request attach the pending socket before advancing the clock.
    assert.equal(connect.mock.callCount(), 1);
    t.mock.timers.tick(1_999);
    assert.equal(socket.destroyed, false);
    t.mock.timers.tick(1);
    assert.equal(socket.destroyed, true);
    return run;
  });
  assert.equal(result.code, 0);
  assert.equal(connect.mock.callCount(), 1);
  assert.deepEqual(local.calls, ["snooze"]);
  assert.deepEqual(result.err, [`rmd snooze: no serve answered at http://127.0.0.1:${SERVE_PORT} (CONNECT_TIMEOUT); running in-process`]);
});

test("W1-T13238 criterion 3: invariant:same-answer-either-path — archive, snooze and decline print the same and exit the same through serve or in-process", async (t) => {
  const { server } = serve(fakeActions());
  const port = SERVE_PORT;
  useHttpEndpoints(t, new Map([[port, server]]));
  const viaServe = serveFirstInboxActions({ url: `http://127.0.0.1:${port}`, token: TOKEN }, () => { throw new Error("must not run in-process"); });
  const cases: Array<[InboxVerbName, string[]]> = [];
  for (const id of ["P1", "refused", "invalid"]) {
    cases.push(["archive", [id]], ["snooze", [id, "--until", "2026-12-01T00:00:00Z"]], ["decline", [id, "--reason", "duplicate"]]);
  }
  cases.push(["archive", [" \t"]], ["snooze", [" \t", "--wake"]]);
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
  const connect = t.mock.method(Agent.prototype, "createConnection", () => assert.fail("attempted to connect without a token"));
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
  const connect = t.mock.method(Agent.prototype, "createConnection", () => socket);
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

test("W1-T13238 criterion 2: after connection refusal, decline still records a ready age-only proposal", async (t) => {
  const port = SERVE_PORT;
  useHttpEndpoints(t);
  const config = { root: root(t), serve: { port } };
  const args = [AGE.id, "--reason", "noise"];
  const recorded: Array<[string, string, string]> = [];
  const result = await captured(t, () => proposalVerdictViaServe("decline", args, config, () =>
    proposalVerdictInProcess("decline", args, ageVerdictFind, (...row) => { recorded.push(row); })));

  assert.deepEqual(result, {
    code: 0,
    out: [`rmd decline: ${AGE.id} DECLINED — take it back with rmd restore ${AGE.id} --reason "<text>"`],
    err: [`rmd decline: no serve answered at http://127.0.0.1:${port} (ECONNREFUSED); running in-process`],
  });
  assert.deepEqual(recorded, [["panel.proposal_declined", AGE.id, "noise"]]);
});

/** A serve stand-in for the verdict routes, answering as panel-graph.ts's route does from applyProposalVerdict. */
function verdictServe(): Server {
  return createServer((req, res) => {
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
}

test("W1-T13238 criterion 3: rmd decline and rmd restore print and exit the same through serve as the in-process command", async (t) => {
  const port = SERVE_PORT;
  useHttpEndpoints(t, new Map([[port, verdictServe()]]));
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

test("W1-T13238 criterion 3: decline and restore reject whitespace-only IDs before HTTP or local lookup", async (t) => {
  const config = { root: root(t), serve: { port: 1 } };
  const connect = t.mock.method(Agent.prototype, "createConnection", () => assert.fail("connected with a blank proposal ID"));
  const args = [" \t", "--reason", "duplicate"];
  for (const kind of ["decline", "restore"] as const) {
    const inProcess = () => proposalVerdictInProcess(kind, args,
      () => assert.fail("looked up a blank proposal ID"),
      () => assert.fail("recorded a verdict for a blank proposal ID"));
    const remote = await captured(t, () => proposalVerdictViaServe(kind, args, config, inProcess));
    const local = await captured(t, async () => inProcess());
    assert.deepEqual(local, { code: 2, out: [], err: [`rmd ${kind}: a proposal id and a non-empty --reason are required — usage: rmd ${kind} <proposalId> --reason "<text>"`] });
    assert.deepEqual(remote, local);
  }
  assert.equal(connect.mock.callCount(), 0);
});

test("W1-T13238: rmd decline and rmd restore run in-process, saying why, when no serve token or no serve answers", async (t) => {
  const args = ["P1", "--reason", "duplicate"];
  let ran = 0;
  const inProcess = () => { ran++; return 0; };

  const bare = await captured(t, () => proposalVerdictViaServe("decline", args, { root: root(t, null) } as unknown as Config, inProcess));
  assert.deepEqual(bare, { code: 0, out: [], err: ["rmd decline: no serve write token (ENOENT); running in-process"] });
  assert.equal(ran, 1);

  const port = SERVE_PORT;
  useHttpEndpoints(t);
  const config = { root: root(t), serve: { port } } as unknown as Config;
  const refused = await captured(t, () => proposalVerdictViaServe("restore", args, config, inProcess));
  assert.deepEqual(refused, { code: 0, out: [],
    err: [`rmd restore: no serve answered at http://127.0.0.1:${port} (ECONNREFUSED); running in-process`] });
  assert.equal(ran, 2);
});

/** serve's real verdict routes over a registry holding one age-only observation, as test/console-api's write test builds them. */
const AGE = { id: "board-review:stale:PR-7", originatingItemId: "PR-7", summary: "board-review: PR-7 has sat open 30.0h, past the 24h depth threshold",
  evidenceAnchors: [{ description: "age", pattern: "pattern-age" }] };
const ageVerdictFind = (id: string) => id === AGE.id
  ? { exists: true, classification: { proposalId: AGE.id, state: "ready" as const, reasons: [] }, proposal: AGE } : { exists: false };

function realVerdictServe(t: Ctx): { root: string; port: number; ledgerPath: string } {
  const repo = gitRepo({ seedCommit: false, kind: "inbox-cli-age-only" });
  const dir = repo.dir;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "plan"), { recursive: true });
  const planPath = join(dir, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(dir, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  writeFileSync(join(dir, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [AGE] }));
  writeFileSync(join(dir, "state", "inbox-drafts.json"), JSON.stringify({ [AGE.id]: { releaseTaskId: "PR-7", anchorFingerprint: anchorFingerprint(AGE.evidenceAnchors) } }));
  writeFileSync(join(dir, "state", "service-tokens.json"), JSON.stringify({ read: "cd".repeat(32), write: TOKEN }));
  repo.git("add", "plan/tasks.yaml");
  repo.git("commit", "-q", "-m", "plan");
  const deps: PanelGraphDeps = {
    root: dir, inboxRoot: dir, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
    inboxGrepAnchor: () => true,
  };
  const server = createService({ tokens: { read: "cd".repeat(32), write: TOKEN }, routes: buildPanelGraphRoutes(deps) });
  useHttpEndpoints(t, new Map([[SERVE_PORT, server]]));
  return { root: dir, port: SERVE_PORT, ledgerPath };
}

test("W1-T13238 criterion 3: the CLI preserves age-only verdicts when serve's real route declines to act", async (t) => {
  const world = realVerdictServe(t);
  const config = { root: world.root, serve: { port: world.port } };
  for (const kind of ["decline", "restore"] as const) {
    const args = [AGE.id, "--reason", "noise"];
    const recorded: Array<[string, string, string]> = [];
    const inProcess = () => proposalVerdictInProcess(kind, args, ageVerdictFind, (...row) => { recorded.push(row); });
    const local = await captured(t, async () => inProcess());
    const remote = await captured(t, () => proposalVerdictViaServe(kind, args, config, inProcess));
    assert.deepEqual(remote, local, kind);
    assert.equal(remote.code, kind === "decline" ? 0 : 1);
    assert.deepEqual(recorded, kind === "decline" ? Array(2).fill(["panel.proposal_declined", AGE.id, "noise"]) : []);
  }
  assert.equal(readFileSync(world.ledgerPath, "utf8"), "", "the serve routes recorded no verdict");
});
