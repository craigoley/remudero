// W1-T5399: an operator on a new device, replica or restarted server can discover their own
// interrupted assistant control action — read-only, actor- and target-scoped, bounded — and
// nothing it reads ever prepares, retries or dispatches an action.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import type { Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildAssistantActionDiscoveryRoute,
  buildAssistantControlReceiptRoute,
  buildAssistantControlRoute,
  type AssistantControlOptions,
} from "#src/lib/panel-actions.js";
import { readAssistantActionDiscovery, type AssistantActionDiscovery } from "#src/lib/assistant-action-discovery.js";
import { instanceRouteSet, mountUnderInstance } from "#src/lib/instance-gateway.js";
import { createService, type Route, type Scope } from "#src/lib/service.js";
import { isPaused, isStopped } from "#src/lib/fleet-control.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { clockFromMillisFn, systemClock } from "#src/lib/clock.js";

const DISCOVERY = "/v1/control/assistant-action/discovery";
const ACTION = "/v1/control/assistant-action";
/** Session token -> verified actor. Two devices of one operator, and a different operator. */
const SESSIONS: Record<string, string> = { "device-a": "operator:test", "device-b": "operator:test", "intruder": "operator:other" };

function root() { return mkdtempSync(join(tmpdir(), "rmd-assistant-discovery-")); }
function ledger(rootPath: string) { return join(rootPath, "state", "ledger.ndjson"); }
function claimsDir(rootPath: string) { return join(rootPath, "state", "assistant-control-actions"); }
function key(actionId: string) { return createHash("sha256").update(actionId).digest("hex"); }
function actorHash(actor: string) { return createHash("sha256").update(actor).digest("hex"); }
function rows(path: string): Array<Record<string, unknown>> {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}
function controlRows(rootPath: string) {
  return rows(ledger(rootPath)).filter((row) => typeof row.step === "string" && /^panel\.(pause|resume|stop)_requested$/.test(row.step));
}

async function listen(routes: Route[]): Promise<{ server: Server; base: string }> {
  const server = createService({
    routes, tokens: { read: "read-token", write: "write-token" }, enforceWriteTiers: true,
    operatorSession: {
      name: "test-verified-operator",
      grant: () => undefined,
      authorize: (req) => {
        const actor = SESSIONS[String(req.headers["x-test-session"] ?? "")];
        return actor ? { scopes: new Set<Scope>(["read", "write"]), tier: "middle", actor } : undefined;
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function post(base: string, body: unknown, session = "device-a", path = ACTION) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer write-token", "content-type": "application/json", "x-test-session": session },
    body: JSON.stringify(body),
  });
}

function get(base: string, path: string, session: string | null = "device-a", extra: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { headers: { authorization: "Bearer read-token", ...(session ? { "x-test-session": session } : {}), ...extra } });
}

async function discover(base: string, session: string | null = "device-a", query = "", path = DISCOVERY) {
  const response = await get(base, `${path}${query}`, session);
  return { response, body: await response.json() as AssistantActionDiscovery & { error?: string } };
}

function routes(deps: AssistantControlOptions): Route[] {
  return [buildAssistantControlRoute(deps), buildAssistantControlReceiptRoute(deps), buildAssistantActionDiscoveryRoute(deps)];
}

const childServer = `
import { createService } from "#test/src/lib/service.ts";
import { buildAssistantControlRoute, buildAssistantControlReceiptRoute, buildAssistantActionDiscoveryRoute } from "#test/src/lib/panel-actions.ts";
import { join } from "node:path";
const root = process.env.RMD_TEST_CONTROL_ROOT;
const interrupt = process.env.RMD_TEST_INTERRUPT;
const sessions = { "device-a": "operator:test", "device-b": "operator:test", "intruder": "operator:other" };
const deps = { root, ledgerPath: join(root, "state", "ledger.ndjson"), claimRoot: root, instance: "core", repository: "craigoley/remudero",
  // A real interruption: the serving process dies between admission and receipt.
  ...(interrupt === "after-claim" ? { afterClaim: () => process.exit(137) } : {}),
  ...(interrupt === "after-effect" ? { afterEffect: () => process.exit(137) } : {}) };
const server = createService({
  routes: [buildAssistantControlRoute(deps), buildAssistantControlReceiptRoute(deps), buildAssistantActionDiscoveryRoute(deps)],
  tokens: { read: "read-token", write: "write-token" }, enforceWriteTiers: true,
  operatorSession: { name: "test-process-operator", grant: () => undefined, authorize: (req) => {
    const actor = sessions[String(req.headers["x-test-session"] ?? "")];
    return actor ? { scopes: new Set(["read", "write"]), tier: "middle", actor } : undefined;
  } },
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

async function childOn(rootPath: string, interrupt?: "after-claim" | "after-effect"): Promise<{ child: ChildProcessWithoutNullStreams; base: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childServer], {
    cwd: process.cwd(), env: { ...process.env, RMD_TEST_CONTROL_ROOT: rootPath, ...(interrupt ? { RMD_TEST_INTERRUPT: interrupt } : {}) }, stdio: "pipe",
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("discovery child did not listen")), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const end = output.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve((JSON.parse(output.slice(0, end)) as { port: number }).port); } catch (error) { reject(error); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`discovery child exited ${code}`)); });
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

/** POST to a process that dies mid-request; the socket closes with no answer. */
async function postAndLoseTheProcess(proc: { child: ChildProcessWithoutNullStreams; base: string }, body: unknown) {
  const exited = once(proc.child, "exit");
  const outcome = await post(proc.base, body).then((response) => `answered ${response.status}`, (error: Error) => `severed: ${error.message}`);
  const [code] = await exited;
  assert.equal(code, 137, "the serving process really died inside the request");
  assert.match(outcome, /^severed/, "the submitting device never received an answer");
}

test("a fresh actor session discovers an interrupted assistant action without resubmission", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const diesAfterClaim = await childOn(shared, "after-claim");
  const diesAfterEffect = await childOn(shared, "after-effect");
  t.after(async () => { await stopChild(diesAfterClaim.child); await stopChild(diesAfterEffect.child); });
  const beforeClaim = { actionId: "discover-claim-01", instance: "core", action: "stop", reason: "security drill" };
  const beforeReceipt = { actionId: "discover-effect-01", instance: "core", action: "pause", reason: "operator review" };
  await postAndLoseTheProcess(diesAfterClaim, beforeClaim);
  await postAndLoseTheProcess(diesAfterEffect, beforeReceipt);
  assert.equal(isStopped(shared), false, "interrupted after claim: no effect happened");
  assert.equal(isPaused(shared), true, "interrupted after effect: the effect happened, the receipt did not");
  assert.equal(controlRows(shared).length, 1);

  // A restarted process, and a different session of the same operator that holds no local hint.
  const restarted = await childOn(shared);
  t.after(() => stopChild(restarted.child));
  const first = await discover(restarted.base, "device-b");
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get("cache-control"), "private, no-store");
  assert.equal(first.body.contract, "assistant-action-discovery-v1");
  assert.deepEqual(first.body.source, { instance: "core", repository: "craigoley/remudero", bootSha: "unknown" });
  assert.equal(first.body.completeness, "complete");
  assert.deepEqual(first.body.limitations, []);
  assert.equal(first.body.continuation, null);
  assert.equal(first.body.verifiedEmpty, false);
  assert.ok(!Number.isNaN(Date.parse(first.body.observedAt)));
  const found = new Map(first.body.pending.map((entry) => [entry.actionId, entry]));
  assert.deepEqual([...found.keys()].sort(), [beforeClaim.actionId, beforeReceipt.actionId].sort());
  for (const input of [beforeClaim, beforeReceipt]) {
    const entry = found.get(input.actionId)!;
    assert.equal(entry.action, input.action);
    assert.equal(entry.instance, "core");
    assert.equal(entry.repository, "craigoley/remudero");
    assert.equal(entry.status, "claimed_unknown");
    assert.ok(!Number.isNaN(Date.parse(entry.submittedAt)), "the server-observed submission time survived the crash");
    // Known-ID recovery now works from the discovered ID, and stays unknown with no receipt.
    const lookedUp = await get(restarted.base, `/v1/control/assistant-action/receipt?actionId=${input.actionId}`, "device-b");
    assert.equal(lookedUp.status, 202);
    assert.equal((await lookedUp.json() as { status: string }).status, "claimed_unknown");
  }
  // Reading again, from either device, never dispatches anything.
  assert.deepEqual((await discover(restarted.base, "device-a")).body.pending, first.body.pending);
  assert.deepEqual((await discover(restarted.base, "device-b")).body.pending, first.body.pending);
  assert.equal(controlRows(shared).length, 1, "discovery dispatched no second effect");
  assert.equal(isStopped(shared), false, "discovery never ran the admitted-but-unexecuted stop");
  assert.equal(existsSync(join(claimsDir(shared), `${key(beforeClaim.actionId)}.receipt.json`)), false);
  assert.equal(existsSync(join(claimsDir(shared), `${key(beforeReceipt.actionId)}.receipt.json`)), false);
});

test("assistant discovery preserves actor target and completion receipt identity", async (t) => {
  const shared = root();
  const site = root();
  t.after(() => { rmSync(shared, { recursive: true, force: true }); rmSync(site, { recursive: true, force: true }); });
  const deps = { root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "core", repository: "craigoley/remudero" };
  const healthy = await listen(routes(deps));
  const interrupted = await listen(routes({ ...deps, afterClaim: () => { throw new Error("interrupted"); } }));
  const siteRoutes = instanceRouteSet(
    { root: site, ledgerPath: ledger(site), planPath: join(site, "plan", "tasks.yaml"), instance: "site" },
    { plan: { tasks: [], byId: new Map() }, ledgerPath: ledger(site), github: fakeGitHub() },
    { assistantClaimRoot: shared }, "craigoley/remudero-site",
  ).filter((route) => route.path.startsWith("/v1/control/assistant-action"));
  assert.ok(siteRoutes.some((route) => route.path === DISCOVERY), "the non-core gateway mounts discovery");
  const siteServer = await listen(mountUnderInstance(siteRoutes, "site"));
  t.after(async () => { await close(healthy.server); await close(interrupted.server); await close(siteServer.server); });

  const done = { actionId: "identity-done-01", instance: "core", action: "pause" };
  const mine = { actionId: "identity-mine-01", instance: "core", action: "stop" };
  const mine2 = { actionId: "identity-mine-02", instance: "core", action: "resume" };
  const theirs = { actionId: "identity-theirs-01", instance: "core", action: "stop", reason: "their private reason" };
  assert.equal((await post(healthy.base, done)).status, 200);
  assert.equal((await post(interrupted.base, mine)).status, 503);
  assert.equal((await post(interrupted.base, mine2)).status, 503);
  assert.equal((await post(interrupted.base, theirs, "intruder")).status, 503);
  const siteOwn = { actionId: "identity-site-01", instance: "site", action: "pause" };
  const siteInterrupted = await listen(mountUnderInstance([buildAssistantControlRoute({ root: site, ledgerPath: ledger(site), claimRoot: shared,
    instance: "site", repository: "craigoley/remudero-site", afterClaim: () => { throw new Error("interrupted"); } })], "site"));
  t.after(() => close(siteInterrupted.server));
  assert.equal((await post(siteInterrupted.base, siteOwn, "device-a", "/v1/i/site/control/assistant-action")).status, 503);

  // The verified actor sees only their own interrupted core actions; a completed one is not pending.
  const own = await discover(healthy.base, "device-b");
  assert.deepEqual(own.body.pending.map((entry) => entry.actionId).sort(), [mine.actionId, mine2.actionId]);
  assert.equal(own.body.completeness, "complete");
  const ownText = JSON.stringify(own.body);
  for (const secret of [theirs.actionId, theirs.reason, actorHash("operator:other"), key(theirs.actionId), siteOwn.actionId, shared]) {
    assert.ok(!ownText.includes(secret), `discovery disclosed ${secret}`);
  }
  // The other actor sees only theirs.
  const other = await discover(healthy.base, "intruder");
  assert.deepEqual(other.body.pending.map((entry) => entry.actionId), [theirs.actionId]);
  assert.ok(!JSON.stringify(other.body).includes(mine.actionId));
  // The site target sees only its own claim, none of core's, from the same shared store.
  const siteView = await discover(siteServer.base, "device-a", "", "/v1/i/site/control/assistant-action/discovery");
  assert.equal(siteView.response.status, 200);
  assert.deepEqual(siteView.body.pending.map((entry) => entry.actionId), [siteOwn.actionId]);
  assert.equal(siteView.body.source.instance, "site");
  assert.equal(siteView.body.source.repository, "craigoley/remudero-site");

  // Unverified callers and forged actor names never reach the store.
  assert.equal((await discover(healthy.base, null)).response.status, 403);
  const forged = await get(healthy.base, DISCOVERY, "intruder", { "x-remudero-actor": "operator:test", "x-verified-actor": "operator:test" });
  assert.deepEqual((await forged.json() as AssistantActionDiscovery).pending.map((entry) => entry.actionId), [theirs.actionId]);
  assert.equal((await discover(healthy.base, "intruder", "?actor=operator:test")).response.status, 400);

  // A continuation is bound to the actor and the exact target that received it.
  const page = await discover(healthy.base, "device-a", "?limit=1");
  assert.equal(page.body.pending.length, 1);
  assert.equal(page.body.completeness, "partial");
  assert.ok(page.body.continuation);
  const decoded = Buffer.from(page.body.continuation!, "base64url").toString();
  for (const hidden of [key(mine.actionId), key(mine2.actionId), key(theirs.actionId), shared, "claim.json"]) {
    assert.ok(!decoded.includes(hidden), `the continuation disclosed ${hidden}`);
  }
  const cursor = `?cursor=${page.body.continuation}`;
  assert.equal((await discover(healthy.base, "intruder", cursor)).response.status, 400);
  assert.equal((await discover(siteServer.base, "device-a", cursor, "/v1/i/site/control/assistant-action/discovery")).response.status, 400);
  const next = await discover(healthy.base, "device-b", cursor);
  assert.equal(next.response.status, 200, "the same operator on another device continues the page");
  assert.deepEqual([...page.body.pending, ...next.body.pending].map((entry) => entry.actionId).sort(), [mine.actionId, mine2.actionId]);

  // A receipt that does not match the exact action, verb, target and evidence completes nothing.
  const receiptPath = join(claimsDir(shared), `${key(mine.actionId)}.receipt.json`);
  const forgedReceipts = [
    { status: "completed", actionId: mine.actionId, instance: "core", repository: "craigoley/remudero", action: "pause", evidenceRef: "ledger:x", result: {} },
    { status: "completed", actionId: mine.actionId, instance: "site", repository: "craigoley/remudero", action: "stop", evidenceRef: "ledger:x", result: {} },
    { status: "completed", actionId: mine.actionId, instance: "core", repository: "craigoley/other", action: "stop", evidenceRef: "ledger:x", result: {} },
    { status: "completed", actionId: mine2.actionId, instance: "core", repository: "craigoley/remudero", action: "stop", evidenceRef: "ledger:x", result: {} },
    { status: "completed", actionId: mine.actionId, instance: "core", repository: "craigoley/remudero", action: "stop", result: {} },
  ];
  for (const receipt of forgedReceipts) {
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const view = await discover(healthy.base);
    assert.equal(view.body.pending.find((entry) => entry.actionId === mine.actionId)?.status, "receipt_unverified", JSON.stringify(receipt));
    assert.equal((await get(healthy.base, `/v1/control/assistant-action/receipt?actionId=${mine.actionId}`)).status, 503);
    assert.equal((await post(healthy.base, mine)).status, 202, "a mismatched receipt is never replayed as completion");
  }
  // Positive control: the exact receipt does complete it.
  writeFileSync(receiptPath, JSON.stringify({ status: "completed", actionId: mine.actionId, instance: "core", repository: "craigoley/remudero", action: "stop", evidenceRef: "ledger:x", result: { stopped: true, reason: null } }));
  assert.deepEqual((await discover(healthy.base)).body.pending.map((entry) => entry.actionId), [mine2.actionId]);
  // Another actor and another target still cannot complete or resolve it.
  assert.equal((await post(healthy.base, mine, "intruder")).status, 409);
  assert.equal((await get(healthy.base, `/v1/control/assistant-action/receipt?actionId=${mine.actionId}`, "intruder")).status, 409);
  assert.equal(controlRows(shared).filter((row) => row.step === "panel.stop_requested").length, 0, "no stop ever dispatched");
});

test("incomplete assistant discovery is not a verified empty pending list", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const deps = { root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "core", repository: "craigoley/remudero" };
  const server = await listen(routes(deps));
  t.after(() => close(server.server));

  // Positive control: an existing root with no store yet IS certifiably empty.
  const empty = await discover(server.base);
  assert.equal(empty.response.status, 200);
  assert.deepEqual([empty.body.completeness, empty.body.verifiedEmpty, empty.body.pending], ["complete", true, []]);
  assert.equal(existsSync(claimsDir(shared)), false, "discovery never creates the store");

  const dir = claimsDir(shared);
  mkdirSync(dir, { recursive: true });
  const me = actorHash("operator:test");
  const v2 = (actionId: string, extra: Record<string, unknown> = {}) => JSON.stringify({ version: "assistant-claim-v2", actionId, action: "pause",
    actorHash: me, instance: "core", repository: "craigoley/remudero", submittedAt: new Date().toISOString(), fingerprint: "f".repeat(64), ...extra });
  const legacy = (actor: string) => JSON.stringify({ fingerprint: "f".repeat(64), actorHash: actorHash(actor), instance: "core", repository: "craigoley/remudero" });
  // Another operator's pre-v2 claim is not this actor's gap: still certifiably empty.
  writeFileSync(join(dir, `${key("legacy-other-01")}.claim.json`), legacy("operator:other"));
  assert.equal((await discover(server.base)).body.verifiedEmpty, true);

  const cases: Array<[string, () => void, string]> = [
    ["own legacy four-field claim", () => writeFileSync(join(dir, `${key("legacy-mine-01")}.claim.json`), legacy("operator:test")), "legacy_claims_without_identity"],
    ["corrupt claim", () => writeFileSync(join(dir, `${key("corrupt-01")}.claim.json`), "{"), "unreadable_entries"],
    ["truncated claim", () => writeFileSync(join(dir, `${key("truncated-01")}.claim.json`), v2("truncated-01").slice(0, 40)), "unreadable_entries"],
    ["oversized claim", () => writeFileSync(join(dir, `${key("oversized-01")}.claim.json`), v2("oversized-01", { pad: "x".repeat(10_000) })), "oversized_entries"],
    ["unreadable (EISDIR) claim", () => mkdirSync(join(dir, `${key("eisdir-01")}.claim.json`)), "unreadable_entries"],
    ["unknown claim version", () => writeFileSync(join(dir, `${key("future-01")}.claim.json`), v2("future-01", { version: "assistant-claim-v9" })), "unsupported_entries"],
    ["filename digest mismatch", () => writeFileSync(join(dir, `${key("named-01")}.claim.json`), v2("someone-else-01")), "unverifiable_entries"],
    ["unrecognized store entry", () => writeFileSync(join(dir, "notes.txt"), "x"), "unverifiable_entries"],
  ];
  for (const [label, plant, limitation] of cases) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    plant();
    const view = await discover(server.base);
    assert.equal(view.response.status, 200, label);
    assert.equal(view.body.completeness, "partial", label);
    assert.equal(view.body.verifiedEmpty, false, label);
    assert.deepEqual(view.body.pending, [], label);
    assert.ok(view.body.limitations.includes(limitation as never), `${label}: ${view.body.limitations.join(",")}`);
  }

  // A missing root, or a store that is not a directory, is unavailable — never empty.
  const missing = await listen(routes({ ...deps, claimRoot: join(shared, "missing-root") }));
  t.after(() => close(missing.server));
  const gone = await discover(missing.base);
  assert.equal(gone.response.status, 503);
  assert.equal(gone.response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual([gone.body.completeness, gone.body.verifiedEmpty], ["unavailable", false]);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, "not a directory");
  const blocked = await discover(server.base);
  assert.equal(blocked.response.status, 503);
  assert.deepEqual([blocked.body.completeness, blocked.body.verifiedEmpty], ["unavailable", false]);
  rmSync(dir, { force: true });
  mkdirSync(dir, { recursive: true });

  // A corpus that changes while it is read is partial. The clock seam is consulted once before the
  // listing and again between examined entries; the second call lands mid-scan.
  writeFileSync(join(dir, `${key("stable-01")}.claim.json`), v2("stable-01"));
  writeFileSync(join(dir, `${key("stable-02")}.claim.json`), v2("stable-02"));
  const steady = await readAssistantActionDiscovery({ claimRoot: shared, actorHash: me, instance: "core", repository: "craigoley/remudero" });
  assert.equal(steady.completeness, "complete", "positive control: the same corpus left alone is complete");
  let calls = 0;
  let planted = false;
  const changing = await readAssistantActionDiscovery({ claimRoot: shared, actorHash: me, instance: "core", repository: "craigoley/remudero",
    clock: clockFromMillisFn(() => {
      if (++calls === 2) {
        planted = true;
        writeFileSync(join(dir, `${key("arrived-01")}.claim.json`), v2("arrived-01"));
      }
      return systemClock.now();
    }) });
  assert.ok(planted);
  assert.equal(changing.completeness, "partial");
  assert.ok(changing.limitations.includes("corpus_changed"));
  assert.equal(changing.verifiedEmpty, false);
});

test("assistant discovery bounds files, time and page size and its continuations cover the store exactly once", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const dir = claimsDir(shared);
  mkdirSync(dir, { recursive: true });
  const me = actorHash("operator:test");
  const ids = Array.from({ length: 7 }, (_, i) => `bounded-action-0${i}`);
  for (const actionId of ids) {
    writeFileSync(join(dir, `${key(actionId)}.claim.json`), JSON.stringify({ version: "assistant-claim-v2", actionId, action: "pause", actorHash: me,
      instance: "core", repository: null, submittedAt: new Date().toISOString(), fingerprint: "f".repeat(64) }));
  }
  const base = { claimRoot: shared, actorHash: me, instance: "core", repository: null };
  // Positive control: an unbounded read sees all seven in one complete page.
  const whole = await readAssistantActionDiscovery({ ...base });
  assert.equal(whole.pending.length, 7);
  assert.equal(whole.completeness, "complete");

  const immediate = t.mock.method(globalThis, "setImmediate");
  const yielding = await readAssistantActionDiscovery({ ...base, budget: { yieldEvery: 1 } });
  assert.equal(immediate.mock.callCount(), 2 * (ids.length - 1), "each inter-entry and inter-file boundary yields to the event loop");
  assert.deepEqual(yielding.pending, whole.pending, "cooperative yields preserve every discovered action");
  assert.equal(yielding.completeness, "complete");
  assert.deepEqual(yielding.limitations, []);
  assert.equal(yielding.continuation, null);
  immediate.mock.restore();

  // This case exercises file-read time after a complete listing. Enumeration deadlines have
  // their own receipt-only falsifier; advancing on every clock call would stop that phase first.
  let elapsed = 0;
  const readingClock = clockFromMillisFn(() => elapsed);
  const timedOpen = async (path: string) => { const handle = await open(path, "r"); elapsed += 1000; return handle; };
  for (const [label, extra, limitation] of [
    ["file budget", { budget: { maxFiles: 2 } }, "file_budget"],
    ["page size", { limit: 3 }, "page_size"],
    ["time budget", { budget: { maxElapsedMs: 1_500 }, clock: readingClock, openFile: timedOpen }, "time_budget"],
    ["byte budget", { budget: { maxTotalBytes: 1 } }, "byte_budget"],
  ] as const) {
    const seen: string[] = [];
    let continuation: string | null = null;
    let pages = 0;
    do {
      const page: AssistantActionDiscovery = await readAssistantActionDiscovery({ ...base, ...extra, continuation });
      pages++;
      seen.push(...page.pending.map((entry) => entry.actionId));
      if (page.continuation) {
        assert.equal(page.completeness, "partial", label);
        assert.ok(page.limitations.includes(limitation), `${label}: ${page.limitations.join(",")}`);
      }
      assert.equal(page.verifiedEmpty, false, label);
      continuation = page.continuation;
      assert.ok(pages < 20, `${label}: continuation never terminated`);
    } while (continuation);
    assert.ok(pages > 1, `${label}: the bound was exercised`);
    assert.deepEqual(seen.sort(), [...ids].sort(), `${label}: every action exactly once across pages`);
  }
  // A continuation minted for another actor or target is refused, not silently restarted.
  const first = await readAssistantActionDiscovery({ ...base, limit: 1 });
  await assert.rejects(readAssistantActionDiscovery({ ...base, actorHash: actorHash("operator:other"), continuation: first.continuation }), /continuation/);
  await assert.rejects(readAssistantActionDiscovery({ ...base, instance: "site", continuation: first.continuation }), /continuation/);
  await assert.rejects(readAssistantActionDiscovery({ ...base, continuation: "not-a-cursor" }), /continuation/);
});

test("assistant discovery marks a capped directory listing partial without a continuation", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const dir = claimsDir(shared);
  mkdirSync(dir, { recursive: true });
  const me = actorHash("operator:test");
  const ids = ["listing-bound-01", "listing-bound-02"];
  for (const actionId of ids) {
    writeFileSync(join(dir, `${key(actionId)}.claim.json`), JSON.stringify({ version: "assistant-claim-v2", actionId,
      action: "pause", actorHash: me, instance: "core", repository: null,
      submittedAt: new Date().toISOString(), fingerprint: "f".repeat(64) }));
  }
  const request = { claimRoot: shared, actorHash: me, instance: "core", repository: null };
  const whole = await readAssistantActionDiscovery(request);
  assert.equal(whole.completeness, "complete");
  assert.deepEqual(whole.pending.map((entry) => entry.actionId).sort(), ids);
  assert.deepEqual(whole.limitations, []);

  for (const maxListed of [0, 1]) {
    const capped = await readAssistantActionDiscovery({ ...request, budget: { maxListed } });
    assert.equal(capped.completeness, "partial");
    assert.deepEqual(capped.limitations, ["corpus_over_listing_bound", "unverifiable_entries"]);
    assert.equal(capped.pending.length, maxListed, "the reader only examines the admitted listing subset");
    for (const entry of capped.pending) assert.ok(ids.includes(entry.actionId));
    assert.equal(capped.continuation, null, "an arbitrary listing subset has no stable continuation");
    assert.equal(capped.verifiedEmpty, false, "even a zero-entry listing cannot certify an empty store");
  }
});

test("assistant discovery listing budget counts receipts temporary files and unknown entries", async (t) => {
  for (const suffix of [".receipt.json", ".receipt.json.00000000-0000-0000-0000-000000000000.tmp", ".unknown"]) {
    const shared = root();
    t.after(() => rmSync(shared, { recursive: true, force: true }));
    const dir = claimsDir(shared); mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `${key(`listing-entry-${i}`)}${suffix}`), "{}");
    const request = { claimRoot: shared, actorHash: actorHash("operator:test"), instance: "core", repository: null };
    const whole = await readAssistantActionDiscovery({ ...request, budget: { maxListed: 12 } });
    assert.ok(!whole.limitations.includes("corpus_over_listing_bound"), "the exact-bound corpus is completely enumerable");
    if (suffix !== ".unknown") assert.equal(whole.verifiedEmpty, true, "a complete receipt-only corpus is the positive control");
    const capped = await readAssistantActionDiscovery({ ...request, budget: { maxListed: 2 } });
    assert.equal(capped.completeness, "partial");
    assert.ok(capped.limitations.includes("corpus_over_listing_bound"));
    assert.equal(capped.verifiedEmpty, false); assert.equal(capped.continuation, null);
    assert.deepEqual(controlRows(shared), [], "enumeration never performs an action");
  }
});

test("assistant discovery elapsed budget bounds receipt-only directory enumeration", async (t) => {
  const shared = root(); t.after(() => rmSync(shared, { recursive: true, force: true }));
  const dir = claimsDir(shared); mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 12; i++) writeFileSync(join(dir, `${key(`elapsed-entry-${i}`)}.receipt.json`), "{}");
  const request = { claimRoot: shared, actorHash: actorHash("operator:test"), instance: "core", repository: null };
  assert.equal((await readAssistantActionDiscovery(request)).verifiedEmpty, true);
  let ticks = 0;
  const capped = await readAssistantActionDiscovery({ ...request, budget: { maxElapsedMs: 2 }, clock: clockFromMillisFn(() => ++ticks) });
  assert.equal(capped.completeness, "partial"); assert.ok(capped.limitations.includes("time_budget"));
  assert.ok(capped.limitations.includes("unverifiable_entries"));
  assert.equal(capped.verifiedEmpty, false); assert.equal(capped.continuation, null);
});

test("assistant discovery cooperatively yields while enumerating receipts without claims", async (t) => {
  const shared = root(); t.after(() => rmSync(shared, { recursive: true, force: true }));
  const dir = claimsDir(shared); mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 8; i++) writeFileSync(join(dir, `${key(`yield-entry-${i}`)}.receipt.json`), "{}");
  const immediate = t.mock.method(globalThis, "setImmediate");
  const result = await readAssistantActionDiscovery({ claimRoot: shared, actorHash: actorHash("operator:test"), instance: "core", repository: null,
    budget: { yieldEvery: 1 } });
  assert.equal(result.verifiedEmpty, true);
  assert.equal(immediate.mock.callCount(), 7, "every inter-entry boundary yields even when there are no claim files to read");
  immediate.mock.restore();
});

test("assistant discovery refuses a real claim named pipe without waiting for a writer", async (t) => {
  const shared = root(); t.after(() => rmSync(shared, { recursive: true, force: true }));
  const dir = claimsDir(shared); mkdirSync(dir, { recursive: true });
  const actionId = "fifo-discovery-01", path = join(dir, `${key(actionId)}.claim.json`);
  const request = { claimRoot: shared, actorHash: actorHash("operator:test"), instance: "core", repository: null };
  writeFileSync(path, JSON.stringify({ version: "assistant-claim-v2", actionId, action: "pause", actorHash: request.actorHash,
    instance: "core", repository: null, submittedAt: new Date().toISOString(), fingerprint: "f".repeat(64) }));
  assert.deepEqual((await readAssistantActionDiscovery(request)).pending.map(row => row.actionId), [actionId], "regular claim is the positive control");
  rmSync(path); execFileSync("mkfifo", [path]);
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
    `import { readAssistantActionDiscovery } from "#test/src/lib/assistant-action-discovery.ts";
     console.log(JSON.stringify(await readAssistantActionDiscovery(${JSON.stringify(request)})));`],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  assert.equal(child.error, undefined, "nonregular claim must not block in open before stat can reject it");
  assert.equal(child.status, 0, child.stderr);
  const result: AssistantActionDiscovery = JSON.parse(child.stdout);
  assert.equal(result.completeness, "partial"); assert.deepEqual(result.limitations, ["unreadable_entries"]);
  assert.deepEqual(result.pending, []); assert.equal(result.verifiedEmpty, false);
  assert.deepEqual(controlRows(shared), []);
});

test("assistant discovery rejects invalid page limits with a private response", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const server = await listen(routes({ root: shared, ledgerPath: ledger(shared), claimRoot: shared, instance: "core" }));
  t.after(() => close(server.server));
  for (const limit of ["1", "100"]) {
    const valid = await discover(server.base, "device-b", `?limit=${limit}`);
    assert.equal(valid.response.status, 200);
    assert.equal(valid.body.verifiedEmpty, true);
  }
  for (const limit of ["", "0", "101", "1000", "-1", "1.5", "abc"]) {
    const invalid = await discover(server.base, "device-b", `?limit=${limit}`);
    assert.equal(invalid.response.status, 400, `limit=${limit}`);
    assert.deepEqual(invalid.body, { error: "invalid_limit", detail: "limit must be 1-100" });
    assert.equal(invalid.response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(existsSync(claimsDir(shared)), false, "valid and invalid reads never initialize a claim store");
  assert.deepEqual(controlRows(shared), [], "page validation never dispatches a control action");
});

test("a claim whose handle fails to read is unreadable and its descriptor is closed", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const dir = claimsDir(shared);
  mkdirSync(dir, { recursive: true });
  const me = actorHash("operator:test");
  const actionId = "read-fails-01";
  writeFileSync(join(dir, `${key(actionId)}.claim.json`), JSON.stringify({ version: "assistant-claim-v2", actionId,
    action: "pause", actorHash: me, instance: "core", repository: null,
    submittedAt: new Date().toISOString(), fingerprint: "f".repeat(64) }));
  const request = { claimRoot: shared, actorHash: me, instance: "core", repository: null };
  const healthy = await readAssistantActionDiscovery(request);
  assert.equal(healthy.completeness, "complete");
  assert.deepEqual(healthy.pending.map((entry) => entry.actionId), [actionId]);

  let reads = 0;
  let closes = 0;
  const openFile = async (path: string) => {
    const handle = await open(path, "r");
    const realClose = handle.close.bind(handle);
    handle.read = async () => {
      reads++;
      throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    };
    handle.close = async () => { await realClose(); closes++; };
    return handle;
  };
  const failing = await readAssistantActionDiscovery({ ...request, openFile });
  assert.equal(reads, 1, "the read operation really failed after the file was opened and statted");
  assert.equal(closes, 1, "the failing read still releases its real descriptor");
  assert.equal(failing.completeness, "partial");
  assert.deepEqual(failing.limitations, ["unreadable_entries"]);
  assert.deepEqual(failing.pending, [], "an unreadable claim is never certified as pending");
  assert.equal(failing.verifiedEmpty, false);
});

test("a claim whose handle fails to close is an unreadable entry, never a crashed or empty discovery", async (t) => {
  const shared = root();
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const dir = claimsDir(shared);
  mkdirSync(dir, { recursive: true });
  const me = actorHash("operator:test");
  writeFileSync(join(dir, `${key("close-fails-01")}.claim.json`), JSON.stringify({ version: "assistant-claim-v2", actionId: "close-fails-01",
    action: "pause", actorHash: me, instance: "core", repository: null, submittedAt: new Date().toISOString(), fingerprint: "f".repeat(64) }));
  const request = { claimRoot: shared, actorHash: me, instance: "core", repository: null };
  // Positive control: the same corpus with a healthy close is complete and lists the action.
  const healthy = await readAssistantActionDiscovery(request);
  assert.deepEqual([healthy.completeness, healthy.pending.length], ["complete", 1]);

  // The handle really closes (no descriptor leak), then reports EIO, as a failing device would.
  const openFile = async (path: string) => {
    const handle = await open(path, "r");
    const realClose = handle.close.bind(handle);
    handle.close = async () => {
      await realClose();
      throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
    };
    return handle;
  };
  const failing = await readAssistantActionDiscovery({ ...request, openFile });
  assert.equal(failing.completeness, "partial");
  assert.ok(failing.limitations.includes("unreadable_entries"), failing.limitations.join(","));
  assert.deepEqual(failing.pending, [], "an entry that could not be certified is not reported as pending");
  assert.equal(failing.verifiedEmpty, false);
});
