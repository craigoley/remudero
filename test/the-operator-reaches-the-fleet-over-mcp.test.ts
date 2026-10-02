import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOperatorMcpServer, operatorMcpCommand, type OperatorMcpDeps } from "../src/lib/operator-mcp.js";
import { gitRepo } from "./helpers/git-repo.js";

const base: OperatorMcpDeps = { url: "http://127.0.0.1:4317", readToken: "read-scope-secret", repoRoot: process.cwd() };
async function connected(deps: OperatorMcpDeps = base) {
  const server = createOperatorMcpServer(deps);
  const client = new Client({ name: "operator-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function content(result: Awaited<ReturnType<Client["callTool"]>>) { return JSON.stringify(result.content); }

test("W1-T4679: the operator MCP server exposes the inbox and ledger-grep read tools", async () => {
  const calls: unknown[] = [];
  const pair = await connected({ ...base, fetch: async (url, init) => { calls.push([String(url), init]); return new Response('{"staleness":"unavailable"}'); },
    run: (verb, args) => { calls.push([verb, args]); return '{"state":"observed"}'; } });
  try {
    assert.deepEqual((await pair.client.listTools()).tools.map(t => t.name), ["inbox", "ledger_grep", "case_file"]);
    assert.match(content(await pair.client.callTool({ name: "inbox" })), /unavailable/);
    assert.match(content(await pair.client.callTool({ name: "ledger_grep", arguments: { pattern: "goal[.]unmoved" } })), /observed/);
    await pair.client.callTool({ name: "case_file", arguments: { taskId: "W1-T12e" } });
    assert.deepEqual(calls.slice(1), [["ledger-grep", ["goal[.]unmoved"]], ["case-file", ["W1-T12e", "--json"]]]);
    const request = calls[0] as [string, RequestInit];
    assert.equal(request[0], "http://127.0.0.1:4317/v1/inbox");
    assert.equal(request[1].redirect, "error");
    assert.ok(request[1].signal);
  } finally { await pair.close(); }
});

test("W1-T4679: its one write tool lands through the console's answer route", async () => {
  let recorded: [string, RequestInit | undefined] | undefined;
  const pair = await connected({ ...base, writeToken: "write-scope-secret", fetch: async (url, init) => { recorded = [String(url), init]; return new Response('{"recorded":true}'); } });
  try {
    const tool = (await pair.client.listTools()).tools.find(t => t.name === "answer_question")!;
    assert.equal(tool.annotations!.readOnlyHint, false);
    assert.equal((await pair.client.callTool({ name: "answer_question", arguments: { taskId: "W1-T1", answer: "Use the isolated canary" } })).isError, undefined);
    assert.equal(recorded![0], "http://127.0.0.1:4317/v1/questions/answer");
    assert.deepEqual(JSON.parse(recorded![1]!.body as string), { taskId: "W1-T1", answer: "Use the isolated canary" });
    assert.equal((recorded![1]!.headers as Record<string, string>).Authorization, "Bearer write-scope-secret");
  } finally { await pair.close(); }
});

test("operator tools refuse writes without capability, injection, surplus arguments and empty answers", async () => {
  const pair = await connected({ ...base, run: () => { throw new Error("must not execute"); } });
  try {
    for (const [name, args] of [["answer_question", { taskId: "W1-T1", answer: "yes" }], ["case_file", { taskId: "W1-T1; touch /tmp/x" }],
      ["ledger_grep", { pattern: "x", flags: "--write" }], ["ledger_grep", { pattern: "" }], ["inbox", { extra: true }], ["approve_pr", {}]] as const)
      assert.equal((await pair.client.callTool({ name, arguments: args })).isError, true);
  } finally { await pair.close(); }
  const enabled = await connected({ ...base, writeToken: "write-scope-secret" });
  try {
    for (const answer of ["", " ", "x".repeat(16_385)]) assert.equal((await enabled.client.callTool({ name: "answer_question", arguments: { taskId: "W1-T1", answer } })).isError, true);
  } finally { await enabled.close(); }
  for (const url of ["ftp://local/", "http://user:pass@local/", "http://local/?token=x", "http://local/#x"])
    assert.throws(() => createOperatorMcpServer({ ...base, url }));
  assert.throws(() => createOperatorMcpServer({ ...base, timeoutMs: 0 }));
  assert.throws(() => createOperatorMcpServer({ ...base, readToken: "" }));
});

test("the real HTTP default preserves route refusals, caps responses and never exposes tokens", async () => {
  let mode = "ok";
  const http = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer read-scope-secret");
    if (mode === "refused") { res.writeHead(403); res.end("read-scope-secret refused"); }
    else if (mode === "large") res.end("x".repeat(1024 * 1024 + 1));
    else res.end('{"ok":true}');
  });
  await new Promise<void>(r => http.listen(0, "127.0.0.1", r));
  const pair = await connected({ ...base, url: `http://127.0.0.1:${(http.address() as { port: number }).port}` });
  try {
    assert.match(content(await pair.client.callTool({ name: "inbox" })), /ok/);
    mode = "refused";
    const refused = await pair.client.callTool({ name: "inbox" });
    assert.equal(refused.isError, true);
    assert.match(content(refused), /403/);
    assert.doesNotMatch(content(refused), /read-scope-secret/);
    mode = "large";
    assert.match(content(await pair.client.callTool({ name: "inbox" })), /1 MiB/);
  } finally { await pair.close(); await new Promise<void>(r => http.close(() => r())); }
});

test("the real CLI default bounds the process tree and preserves failure rather than claiming completion", async () => {
  const repo = gitRepo({ kind: "operator-mcp" });
  mkdirSync(join(repo.dir, "src"));
  symlinkSync(resolve("node_modules"), join(repo.dir, "node_modules"), "dir");
  const script = join(repo.dir, "src", "run-task.ts");
  const pair = await connected({ ...base, repoRoot: repo.dir });
  try {
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    assert.match(content(await pair.client.callTool({ name: "case_file", arguments: { taskId: "CONSOLE-T1" } })), /CONSOLE-T1/);
    writeFileSync(script, "process.stderr.write('refused'); process.exit(7);\n");
    assert.match(content(await pair.client.callTool({ name: "ledger_grep", arguments: { pattern: "x" } })), /refused/);
    writeFileSync(script, "setInterval(() => {}, 100);\n");
    const short = await connected({ ...base, repoRoot: repo.dir, timeoutMs: 1000 });
    try { assert.match(content(await short.client.callTool({ name: "ledger_grep", arguments: { pattern: "x" } })), /timed out/); }
    finally { await short.close(); }
  } finally { await pair.close(); repo.cleanup(); }
});

test("command setup refuses invalid options and write enablement without a write token", async () => {
  await assert.rejects(operatorMcpCommand(["--approve"], { root: "/missing" }, process.cwd()), /usage/);
  const repo = gitRepo({ kind: "mcp-tokens" });
  try {
    mkdirSync(join(repo.dir, "state"));
    writeFileSync(join(repo.dir, "state", "service-tokens.json"), JSON.stringify({ read: "read-scope-secret" }));
    await assert.rejects(operatorMcpCommand(["--enable-write"], { root: repo.dir }, repo.dir), /write-scope/);
  } finally { repo.cleanup(); }
});
