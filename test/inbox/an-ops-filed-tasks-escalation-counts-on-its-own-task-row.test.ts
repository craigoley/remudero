// W1-T14114: live 2026-11-21 04:04Z, after W1-T13957 reached serve, open core PRs #19691, #19728 and #19721 still kept
// the core Inbox partial: each named its own task by run branch and trailer, but those tasks are filed in the private
// ops catalog, so core's projection had no row for them and their escalation counts stayed unverified.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { serialize } from "node:v8";
import type { Clock } from "#src/lib/clock.js";
import { planDestinationRepository } from "#src/lib/plan-destination.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { projectInboxPlan } from "#src/lib/panel-graph.js";
import { createSlowLaneCatalog, runSlowLaneWorker, threadSlowLane } from "#src/lib/read-model-slow-lane.js";
import { makeTempDir } from "#src/lib/tmp.js";
import type { GitHub, PrRef } from "#src/lib/status.js";
import { BOARD_CATALOG_WIRE_VERSION, type BoardCatalogReply, type BoardCatalogRequest } from "#src/lib/serve-plan-reload.js";

const task = (id: string): Task => ({ id, title: `title of ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium",
  verify: "auto", status: "queued", attempts: 0 }) as Task;
const planOf = (...tasks: Task[]): Plan => ({ tasks, byId: new Map(tasks.map((t) => [t.id, t])) }) as unknown as Plan;
const ISSUE = "https://github.com/craigoley/remudero/issues/77";
const pr = (number: number, headRefName: string, body: string): PrRef =>
  ({ number, url: `https://github.com/craigoley/remudero/pull/${number}`, state: "OPEN", headRefName, body });

function gateway(open: PrRef[]): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: (u: string) => open.find((p) => p.url === u)?.headRefName,
    prBody: (u: string) => open.find((p) => p.url === u)?.body,
    listOpenHeadBranches: () => open,
    listMergedHeadBranches: () => [],
    issueByUrl: (u: string) => (u === ISSUE ? { state: "OPEN", title: "an operator ask" } : null),
  } as unknown as GitHub;
}

function ledgerWith(...lines: object[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "ops-own-task-row-")), "ledger.ndjson");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return path;
}

const publicPlan = planOf(task("W1-T1"));
const opsTask = task("W1-T9");
const combined = planOf(task("W1-T1"), opsTask);
const escalation = { ts: "2026-11-20T00:00:00Z", step: "escalation.issue_opened", task_id: "W1-T9", issue_url: ISSUE };

test("W1-T14114 ops-filed own task row: an open PR whose task is only in the ok ops catalog resolves with that row's count", () => {
  // The live shape: no escalation line for the task in core's ledger, so core's projection has no row at all.
  const open = [pr(19691, "run-W1-T9-1795095230170", "Fix.\n\nRemudero-Task: W1-T9\n")];
  const deps = { ledgerPath: ledgerWith(), statusGithub: gateway(open), inboxReferentPlan: (plan: Plan) => (plan === publicPlan ? combined : undefined) };
  const read = projectInboxPlan(deps, publicPlan);
  assert.deepEqual(read.boardReferents.states.get("#19691"), { status: "open", unhandledEscalations: 0 });
  assert.equal(read.projection.has("W1-T9"), false, "the ops task's row never reaches the classifier's projection");
  assert.deepEqual([...read.projection.keys()], ["W1-T1"]);
  // With an open escalation the count is 1 (core's own taskless escalation row already carries it).
  const escalated = projectInboxPlan({ ...deps, ledgerPath: ledgerWith(escalation) }, publicPlan);
  assert.deepEqual(escalated.boardReferents.states.get("#19691"), { status: "open", unhandledEscalations: 1 });
});

test("W1-T14114 ops-filed own task row: without an ok catalog the escalation count stays unverified", () => {
  const open = [pr(19691, "run-W1-T9-1795095230170", "Remudero-Task: W1-T9")];
  for (const inboxReferentPlan of [undefined, () => undefined, () => publicPlan]) {
    const read = projectInboxPlan({ ledgerPath: ledgerWith(), statusGithub: gateway(open), inboxReferentPlan }, publicPlan);
    assert.deepEqual(read.boardReferents.states.get("#19691"), { status: "open" }, "an unreadable or absent catalog cannot observe the row");
  }
});

test("W1-T14114 ops-filed own task row: a PR that claims no ops task takes no ops row, and its claimed row follows projectPlan's own association", () => {
  const otherOps = task("W1-T8");
  const wide = planOf(task("W1-T1"), opsTask, otherOps);
  const unclaimed = projectInboxPlan({ ledgerPath: ledgerWith(), statusGithub: gateway([pr(6, "dependabot/npm", "")]), inboxReferentPlan: () => wide }, publicPlan);
  assert.deepEqual(unclaimed.boardReferents.states.get("#6"), { status: "open" }, "an unclaimed PR stays unverified, as before");
  // The ops row is projected exactly as a public task's would be: its own run branch associates the PR (rung c3).
  const owned = projectInboxPlan({ ledgerPath: ledgerWith(), statusGithub: gateway([pr(5, "run-W1-T8-1795095230170", "")]), inboxReferentPlan: () => wide }, publicPlan);
  assert.deepEqual(owned.boardReferents.states.get("#5"), { status: "open", unhandledEscalations: 0 });
});

function catalogState(): string {
  const state = join(mkdtempSync(join(tmpdir(), "ops-own-task-row-state-")), "state");
  mkdirSync(state);
  writeFileSync(join(state, "plan-destination.json"), JSON.stringify({ repository: "craigoley/remudero-ops", kinds: [] }));
  return state;
}

function catalogPacket(state: string, plan: Plan | undefined, clock: Clock, sequence = 1): BoardCatalogReply {
  const bytes = serialize(plan ? { observedAt: clock.iso(), plan } : { observedAt: clock.iso(), reason: "unreadable" });
  const buffer = new SharedArrayBuffer(bytes.length);
  Buffer.from(buffer).set(bytes);
  return { type: "ops_catalog_snapshot", version: 1, root: state, sequence, buffer,
    selection: createHash("sha256").update(JSON.stringify(planDestinationRepository(state))).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

const systemish: Clock = { now: () => Date.now(), date: () => new Date(), iso: () => new Date().toISOString() };
const opsOnly = planOf(opsTask);

test("W1-T14114 ops-filed own task row: the slow lane's catalog asks the parent, waits for the reply, and supplies the combined plan only when ok", async () => {
  const state = catalogState();
  const requests: BoardCatalogRequest[] = [];
  const catalog = createSlowLaneCatalog(true, (r) => requests.push(r), systemish, 5_000);
  const settled = catalog.settle(state);
  assert.deepEqual(requests, [{ type: "ops_catalog_read", version: 1, root: state }], "the pass asks the parent for a due catalog read");
  const started = Date.now();
  catalog.accept(catalogPacket(state, opsOnly, systemish));
  await settled;
  assert.ok(Date.now() - started < 1_000, "a reply ends the wait at once");
  const combinedPlan = catalog.referentPlan(publicPlan, state);
  assert.ok(combinedPlan?.byId.has("W1-T9") && combinedPlan.byId.has("W1-T1"), "an ok catalog supplies public plus ops");
  await catalog.settle(state);
  assert.equal(requests.length, 1, "a received catalog is not asked for again inside its refresh interval");
  catalog.accept(catalogPacket(state, undefined, systemish, 2));
  assert.equal(catalog.referentPlan(publicPlan, state), undefined, "an unreadable catalog supplies nothing");
});

test("W1-T14114 ops-filed own task row: the slow lane's catalog wait is bounded, and a lane without the bridge never waits", async () => {
  const state = catalogState();
  const requests: BoardCatalogRequest[] = [];
  const silent = createSlowLaneCatalog(true, (r) => requests.push(r), systemish, 30);
  const started = Date.now();
  await silent.settle(state);
  assert.ok(Date.now() - started >= 25, "an unanswered request waits its bound");
  assert.equal(silent.referentPlan(publicPlan, state), undefined, "and the pass classifies without the catalog");
  const disabled = createSlowLaneCatalog(false, (r) => requests.push(r), systemish, 5_000);
  const t0 = Date.now();
  await disabled.settle(state);
  assert.ok(Date.now() - t0 < 1_000, "no bridge, no wait");
  assert.equal(disabled.referentPlan(publicPlan, state), undefined);
  assert.equal(requests.length, 1, "only the enabled lane asked");
});

test("W1-T14114 ops-filed own task row: the slow lane thread's catalog requests reach the parent, and replies reach the thread", async (t) => {
  const dir = makeTempDir("rmd-ops-own-task-row-lane");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "lane.mjs");
  writeFileSync(path, `import { parentPort } from "node:worker_threads";
parentPort.on("message", (msg) => {
  if (msg.type === "lease" && msg.held) parentPort.postMessage({ type: "ops_catalog_read", version: 1, root: "/state" });
  if (msg.type === "ops_catalog_snapshot") parentPort.postMessage({ type: "log", step: "echo", extra: { root: msg.root, sequence: msg.sequence } });
});\n`);
  const requests: BoardCatalogRequest[] = [];
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const lane = threadSlowLane({ config: { intervalMs: 60_000 }, workerUrl: pathToFileURL(path), log: (step, extra) => logs.push({ step, extra }),
    onCatalogRequest: (request) => requests.push(request) });
  t.after(() => lane.close());
  lane.lease(true);
  const deadline = Date.now() + 10_000;
  while (requests.length === 0 && Date.now() < deadline) await sleep(5);
  assert.deepEqual(requests, [{ type: "ops_catalog_read", version: 1, root: "/state" }]);
  lane.catalog({ type: "ops_catalog_snapshot", version: 1, root: "/state", selection: "s", sequence: 7, buffer: new SharedArrayBuffer(0), sha256: "" });
  while (!logs.some((l) => l.step === "echo") && Date.now() < deadline) await sleep(5);
  assert.deepEqual(logs.find((l) => l.step === "echo")?.extra, { root: "/state", sequence: 7 });
});

test("W1-T14114 ops-filed own task row: the slow lane worker hands a catalog reply to its inbox units' catalog", async (t) => {
  const state = catalogState();
  const posted: unknown[] = [];
  const handlers: Array<(msg: unknown) => void> = [];
  const port = { postMessage: (m: unknown) => posted.push(m), on: (_: "message", run: (msg: unknown) => void) => { handlers.push(run); } };
  const worker = runSlowLaneWorker(port as never, { catalogBridgeVersion: BOARD_CATALOG_WIRE_VERSION, intervalMs: 60_000 },
    { schedule: () => () => {} });
  t.after(() => worker.stop());
  // A reply with no request held is ignored by the client; delivering it must not throw or reach any unit.
  for (const run of handlers) run(catalogPacket(state, opsOnly, systemish));
  assert.equal(posted.filter((m) => (m as { type?: string }).type === "ops_catalog_read").length, 0, "no inbox unit, so nothing was asked");
});
