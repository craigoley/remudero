import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { once } from "node:events";

import { buildAssistantControlRoute } from "../src/lib/panel-actions.js";
import { instanceRouteSet, mountUnderInstance } from "../src/lib/instance-gateway.js";
import { createService, type Route, type Scope } from "../src/lib/service.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import { isPaused } from "../src/lib/fleet-control.js";

function root() { return mkdtempSync(join(tmpdir(), "rmd-assistant-control-")); }
function ledger(rootPath: string) { return join(rootPath, "state", "ledger.ndjson"); }
function rows(path: string): Array<Record<string, unknown>> {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

async function listen(routes: Route[], actor: string | null = "operator:test"): Promise<{ server: Server; base: string }> {
  const server = createService({
    routes, tokens: { read: "read-token", write: "write-token" }, enforceWriteTiers: true,
    operatorSession: {
      name: "test-verified-operator",
      grant: () => undefined,
      authorize: (req) => req.headers["x-verified-operator"] === "yes"
        ? { scopes: new Set<Scope>(["read", "write"]), tier: "middle", ...(actor ? { actor } : {}) }
        : undefined,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function post(base: string, path: string, body: unknown, verified = true) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer write-token", "content-type": "application/json", ...(verified ? { "x-verified-operator": "yes" } : {}) },
    body: JSON.stringify(body),
  });
}

const childServer = `
import { createService } from "./src/lib/service.ts";
import { buildAssistantControlRoute } from "./src/lib/panel-actions.ts";
import { join } from "node:path";
const root = process.env.RMD_TEST_CONTROL_ROOT;
const server = createService({
  routes: [buildAssistantControlRoute({ root, ledgerPath: join(root, "state", "ledger.ndjson"), claimRoot: root, instance: "core" })],
  tokens: { read: "read-token", write: "write-token" }, enforceWriteTiers: true,
  operatorSession: { name: "test-process-operator", grant: () => undefined, authorize: (req) =>
    req.headers["x-verified-operator"] === "yes"
      ? { scopes: new Set(["read", "write"]), tier: "middle", actor: "operator:test" } : undefined },
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

async function childOn(rootPath: string): Promise<{ child: ChildProcessWithoutNullStreams; base: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childServer], {
    cwd: process.cwd(), env: { ...process.env, RMD_TEST_CONTROL_ROOT: rootPath }, stdio: "pipe",
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("assistant-control child did not listen")), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const end = output.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve((JSON.parse(output.slice(0, end)) as { port: number }).port); } catch (error) { reject(error); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`assistant-control child exited ${code}`)); });
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

test("W1-T4763: exact retries dispatch only once across handlers", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const deps = { root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "core" };
  const a = await listen([buildAssistantControlRoute(deps)]);
  const b = await listen([buildAssistantControlRoute(deps)]);
  t.after(async () => { await close(a.server); await close(b.server); });
  const input = { actionId: "control-00000001", instance: "core", action: "pause", reason: "operator review" };
  const [first, second] = await Promise.all([
    post(a.base, "/v1/control/assistant-action", input),
    post(b.base, "/v1/control/assistant-action", input),
  ]);
  assert.ok([200, 202].includes(first.status));
  assert.ok([200, 202].includes(second.status));
  const repeat = await post(b.base, "/v1/control/assistant-action", input);
  assert.equal(repeat.status, 200);
  const receipt = await repeat.json() as Record<string, unknown>;
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.actionId, input.actionId);
  assert.equal(rows(deps.ledgerPath).filter((row) => row.step === "panel.pause_requested").length, 1);
});

test("W1-T4763: separate server processes share one atomic admission", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const first = await childOn(shared);
  const second = await childOn(shared);
  t.after(async () => { await stopChild(first.child); await stopChild(second.child); });
  assert.notEqual(first.child.pid, second.child.pid);
  const input = { actionId: "control-process-01", instance: "core", action: "pause", reason: "operator review" };
  const replies = await Promise.all([
    post(first.base, "/v1/control/assistant-action", input),
    post(second.base, "/v1/control/assistant-action", input),
  ]);
  assert.ok(replies.every((response) => response.status === 200 || response.status === 202));
  assert.equal(rows(ledger(shared)).filter((row) => row.step === "panel.pause_requested").length, 1);
});

test("W1-T4763: changed or interrupted action never becomes success", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const deps = { root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "core" };
  const interrupted = await listen([buildAssistantControlRoute({ ...deps, afterClaim: () => { throw new Error("simulated interruption"); } })]);
  const restarted = await listen([buildAssistantControlRoute(deps)]);
  t.after(async () => { await close(interrupted.server); await close(restarted.server); });
  const input = { actionId: "control-00000002", instance: "core", action: "stop", reason: "security drill" };
  const first = await post(interrupted.base, "/v1/control/assistant-action", input);
  assert.equal(first.status, 503);
  assert.equal((await first.json() as { status: string }).status, "unknown");
  const retry = await post(restarted.base, "/v1/control/assistant-action", input);
  assert.equal(retry.status, 202);
  assert.equal((await retry.json() as { status: string }).status, "unknown");
  const changed = await post(restarted.base, "/v1/control/assistant-action", { ...input, reason: "different reason" });
  assert.equal(changed.status, 409);
  assert.equal(rows(deps.ledgerPath).filter((row) => row.step === "panel.stop_requested").length, 0);
});

test("W1-T4763: an interrupted completion never redispatches a real side effect", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const deps = { root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "core" };
  const interrupted = await listen([buildAssistantControlRoute({ ...deps, afterEffect: () => { throw new Error("receipt writer interrupted"); } })]);
  const restarted = await listen([buildAssistantControlRoute(deps)]);
  t.after(async () => { await close(interrupted.server); await close(restarted.server); });
  const input = { actionId: "control-00000005", instance: "core", action: "pause", reason: "operator review" };
  const first = await post(interrupted.base, "/v1/control/assistant-action", input);
  assert.equal(first.status, 503);
  assert.equal((await first.json() as { status: string }).status, "unknown");
  assert.equal(isPaused(shared), true, "the side effect happened despite the missing receipt");
  const retry = await post(restarted.base, "/v1/control/assistant-action", input);
  assert.equal(retry.status, 202);
  assert.equal((await retry.json() as { status: string }).status, "unknown");
  assert.equal(rows(deps.ledgerPath).filter((row) => row.step === "panel.pause_requested").length, 1);
});

test("W1-T4763: instance target and write tier remain authoritative", async (t) => {
  const shared = root();
  const site = root();
  t.after(() => { rmSync(shared, { recursive: true, force: true }); rmSync(site, { recursive: true, force: true }); });
  const coreRoute = buildAssistantControlRoute({ root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "core" });
  const siteRoute = instanceRouteSet(
    { root: site, ledgerPath: ledger(site), planPath: join(site, "plan", "tasks.yaml"), instance: "site" },
    { plan: { tasks: [], byId: new Map() }, ledgerPath: ledger(site), github: fakeGitHub() },
    { assistantClaimRoot: shared }, "craigoley/remudero-site",
  ).find((route) => route.path === "/v1/control/assistant-action");
  assert.ok(siteRoute, "the non-core instance gateway must mount the same admission contract");
  const server = await listen([coreRoute, ...mountUnderInstance([siteRoute], "site")]);
  const unattributed = await listen([coreRoute], null);
  t.after(() => close(server.server));
  t.after(() => close(unattributed.server));
  const input = { actionId: "control-00000003", instance: "core", action: "pause", reason: "operator review" };
  assert.equal((await post(server.base, "/v1/control/assistant-action", input, false)).status, 403);
  assert.equal((await post(unattributed.base, "/v1/control/assistant-action", input)).status, 403);
  assert.equal((await post(server.base, "/v1/control/assistant-action", { ...input, instance: "site" })).status, 409);
  assert.equal((await post(server.base, "/v1/control/assistant-action", input)).status, 200);
  assert.equal((await post(server.base, "/v1/i/site/control/assistant-action", { ...input, instance: "site" })).status, 409);
  assert.equal(rows(ledger(shared)).filter((row) => row.step === "panel.pause_requested").length, 1);
  assert.equal(rows(ledger(site)).filter((row) => row.step === "panel.pause_requested").length, 0);
});

test("W1-T4763: a remapped instance cannot reuse its former repository's action ID", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const deps = { root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "site" };
  const before = await listen([buildAssistantControlRoute({ ...deps, repository: "craigoley/site-a" })]);
  const after = await listen([buildAssistantControlRoute({ ...deps, repository: "craigoley/site-b" })]);
  t.after(async () => { await close(before.server); await close(after.server); });
  const input = { actionId: "control-00000004", instance: "site", action: "pause", reason: "operator review" };
  assert.equal((await post(before.base, "/v1/control/assistant-action", input)).status, 200);
  assert.equal((await post(after.base, "/v1/control/assistant-action", input)).status, 409);
  assert.equal(rows(deps.ledgerPath).filter((row) => row.step === "panel.pause_requested").length, 1);
});

test("W1-T4763: resume and stop return durable receipts without replaying their control rows", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const server = await listen([buildAssistantControlRoute({ root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "core" })]);
  t.after(() => close(server.server));
  for (const [action, step] of [["resume", "panel.resume_requested"], ["stop", "panel.stop_requested"]] as const) {
    const input = { actionId: `control-${action}-01`, instance: "core", action, reason: "operator review" };
    const first = await post(server.base, "/v1/control/assistant-action", input);
    assert.equal(first.status, 200);
    const receipt = await first.json();
    const replay = await post(server.base, "/v1/control/assistant-action", input);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), receipt);
    assert.equal(rows(ledger(shared)).filter((row) => row.step === step).length, 1);
  }
});

test("W1-T4763: malformed action IDs and unexpected fields never create a claim", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const server = await listen([buildAssistantControlRoute({ root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "core" })]);
  t.after(() => close(server.server));
  for (const input of [
    { actionId: "../../x", instance: "core", action: "pause" },
    { actionId: "valid-action-01", instance: "core", action: "pause", repository: "forged/repo" },
    { actionId: "valid-action-02", instance: "core", action: "pause", reason: 17 },
  ]) {
    assert.equal((await post(server.base, "/v1/control/assistant-action", input)).status, 400);
  }
  assert.equal(existsSync(join(shared, "state", "assistant-control-actions")), false);
});

test("W1-T4763: unavailable admission and unreadable claims never dispatch", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const blockedRoot = join(shared, "not-a-directory");
  writeFileSync(blockedRoot, "occupied");
  const blocked = await listen([buildAssistantControlRoute({ root: shared, ledgerPath: ledger(shared), claimRoot: blockedRoot, instance: "core" })]);
  const corrupt = await listen([buildAssistantControlRoute({ root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "core" })]);
  t.after(async () => { await close(blocked.server); await close(corrupt.server); });
  const input = { actionId: "control-unreadable-01", instance: "core", action: "pause" };
  const refused = await post(blocked.base, "/v1/control/assistant-action", input);
  assert.equal(refused.status, 503);
  assert.equal((await refused.json() as { status: string }).status, "unknown");
  const claimsDir = join(shared, "state", "assistant-control-actions");
  mkdirSync(claimsDir, { recursive: true });
  const key = createHash("sha256").update(input.actionId).digest("hex");
  writeFileSync(join(claimsDir, `${key}.claim.json`), "{", { flag: "wx" });
  const unresolved = await post(corrupt.base, "/v1/control/assistant-action", input);
  assert.equal(unresolved.status, 202);
  assert.equal((await unresolved.json() as { status: string }).status, "unknown");
  assert.equal(rows(ledger(shared)).filter((row) => row.step === "panel.pause_requested").length, 0);
});
