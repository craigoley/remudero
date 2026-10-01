/**
 * `rmd serve` as a supervised STANDBY (arch-phase3-design.md §3, P3-01): it boots, warms, answers
 * readiness on its private socket, and binds the public port only when the supervisor promotes it.
 * The real boot path in-process, on the same harness as test/serve-command-boot.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveCommand } from "../src/run-task.js";
import type { GenerationMessage } from "../src/lib/serve-generation.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const BOARD_BRANCH_LISTS = { listMergedHeadBranches: () => [], listOpenHeadBranches: () => [] };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function overSocket(socketPath: string, path: string, token?: string): Promise<{ status?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function refused(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/version`);
    return false;
  } catch {
    return true;
  }
}

test("standby serve does not listen on the public port before promote", { timeout: 120_000 }, async (t) => {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "rmd-standby-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root, installRoot: REPO_ROOT, serve: { host: "127.0.0.1", port } }));
  const socketPath = join(home, "gen.sock");
  const saved = { HOME: process.env.HOME, role: process.env.RMD_SERVE_ROLE, socket: process.env.RMD_SERVE_READY_SOCKET };
  process.env.HOME = home;
  process.env.RMD_SERVE_ROLE = "standby";
  process.env.RMD_SERVE_READY_SOCKET = socketPath;
  const realLog = console.log;
  const realErr = console.error;
  console.log = () => {};
  console.error = () => {};

  const sent: GenerationMessage[] = [];
  const listeners: Array<(m: GenerationMessage) => void> = [];
  let releaseBoard: () => void = () => {};
  const boardGated = new Promise<void>((resolve) => (releaseBoard = resolve));
  const running = serveCommand([], {
    branch: () => "main",
    buildBatchedGithub: () => fakeGitHub(BOARD_BRANCH_LISTS),
    buildInitialBoardSnapshot: () => boardGated,
    generation: { send: (m) => void sent.push(m), onMessage: (l) => void listeners.push(l) },
  });
  t.after(() => {
    console.log = realLog;
    console.error = realErr;
    process.env.HOME = saved.HOME;
    for (const [key, value] of [["RMD_SERVE_ROLE", saved.role], ["RMD_SERVE_READY_SOCKET", saved.socket]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.emit("SIGTERM");
  });

  let ready: { status?: number; body: string } | undefined;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && !ready; await sleep(100)) {
    ready = await overSocket(socketPath, "/v1/ready").catch(() => undefined);
  }
  assert.ok(ready, "the standby answers readiness on its private socket");
  assert.equal(ready.status, 503, "not ready while the board snapshot is still computing");
  const report = JSON.parse(ready.body) as { criteria: Array<{ name: string; ok: boolean }> };
  assert.deepEqual(report.criteria.map((c) => c.name), ["plan_loaded", "github_auth_settled", "gateway_primed", "read_model_warm", "board_computed"]);
  assert.equal(report.criteria.find((c) => c.name === "board_computed")?.ok, false);
  assert.equal(await refused(port), true, "the public port is not bound by a standby");

  releaseBoard();
  await sleep(50);
  const tokens = JSON.parse(readFileSync(join(root, "state", "service-tokens.json"), "utf8")) as { read: string };
  const version = await overSocket(socketPath, "/v1/version", tokens.read);
  assert.equal(version.status, 200, "real read routes answer over the private socket for the supervisor's smoke test");
  const after = await overSocket(socketPath, "/v1/ready");
  assert.equal(after.status, 200, `ready once the board is computed: ${after.body}`);
  assert.equal(await refused(port), true, "still unbound: readiness alone never binds");
  assert.deepEqual(sent, [], "nothing was announced before the promote");

  for (const listener of listeners) listener({ type: "rmd.promote" });
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && sent.length === 0; ) await sleep(50);
  assert.deepEqual(sent, [{ type: "rmd.promoted" }], "the promote is acknowledged once the port is bound");
  const res = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { authorization: `Bearer ${tokens.read}` } });
  assert.equal(res.status, 200, "the promoted generation serves the public port with its board already computed");

  process.emit("SIGTERM");
  assert.equal(await running, 0);
});
