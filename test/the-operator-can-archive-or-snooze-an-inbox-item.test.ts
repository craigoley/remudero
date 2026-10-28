// W1-T8831: an email inbox needs archive and snooze, and core had neither - every parked item stayed in front of
// the operator until it was approved or declined. POST /v1/inbox/archive and /v1/inbox/snooze set an item aside
// without deciding it; the view lists it under `archived` / `snoozed` and in no other lane or count. The marks live
// in state/inbox-triage.json (ledger compaction cannot shed them) and the view holds no clock: the slow lane's pass
// judges each stored snooze instant, so a snooze comes due by re-emitting the pages.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { refreshInboxClassification, INBOX_VIEW_SECTIONS, type InboxRefreshMemo } from "#src/lib/inbox-view.js";
import { appendLedger, rotateLedger } from "#src/lib/ledger.js";
import { buildPanelGraphRoutes, inboxTriagePath, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

type TestCtx = { after: (fn: () => void) => void };

const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const HOUR = 3_600_000;
const A = "verify-human:W3-T7";
const B = "verify-human:W3-T8";
const READ_TOKEN = "triage-read-token";
const WRITE_TOKEN = "triage-write-token";

function world(t: TestCtx, proposals: string[], nowMs = T0): { root: string; stateDir: string; registry: string; deps: PanelGraphDeps } {
  const root = makeTempDir("rmd-inbox-triage");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const registry = join(stateDir, "inbox-proposals.json");
  writeFileSync(registry, JSON.stringify({ proposals: proposals.map((id) => ({ id, summary: `about ${id}`, evidenceAnchors: [] })) }));
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
    inboxGrepAnchor: () => true,
    inboxClock: fixedClock(nowMs),
  };
  return { root, stateDir, registry, deps };
}

async function withService<T>(deps: PanelGraphDeps, fn: (post: (path: string, body: unknown, token?: string) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<T>): Promise<T> {
  const server = createService({ tokens: { read: READ_TOKEN, write: WRITE_TOKEN }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(async (path, body, token = WRITE_TOKEN) => {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    });
  } finally {
    server.close();
  }
}

type Item = { proposalId: string; archivedAt?: string; snoozedUntil?: string };
type Counts = { archived: number; snoozed: number; needsYou: { ready: number; drafting: number; notReady: number; declined: number } } & Record<string, unknown>;

async function pass(deps: PanelGraphDeps, memo: InboxRefreshMemo, nowMs: number) {
  const refreshed = await refreshInboxClassification(deps, memo, fixedClock(nowMs));
  const section = (name: string): Item[] => refreshed.bodies.filter((b) => b.data.section === name).flatMap((b) => b.data.items as unknown as Item[]);
  const counts = refreshed.bodies[0]!.data.counts as unknown as Counts;
  const ids = (name: string): string[] => section(name).map((i) => i.proposalId);
  return { refreshed, section, ids, counts };
}

const needsYouTotal = (c: Counts): number => c.needsYou.ready + c.needsYou.drafting + c.needsYou.notReady + c.needsYou.declined;

test("W1-T8831: an archived item leaves needsYou and comes back when unarchived", async (t) => {
  const { deps } = world(t, [A, B]);
  const memo: InboxRefreshMemo = {};
  const before = await pass(deps, memo, T0);
  assert.deepEqual(before.ids("needsYou").sort(), [A, B]);
  assert.deepEqual(before.ids("archived"), []);

  await withService(deps, async (post) => {
    const archived = await post("/v1/inbox/archive", { proposalId: A, archived: true });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.archivedAt, new Date(T0).toISOString());
  });
  const away = await pass(deps, memo, T0 + 60_000);
  assert.deepEqual(away.ids("needsYou"), [B], "the archived item is out of needsYou");
  assert.deepEqual(away.ids("archived"), [A]);
  assert.equal(away.section("archived")[0]!.archivedAt, new Date(T0).toISOString(), "an archived item names when it was archived");
  assert.equal(away.counts.archived, 1);
  assert.equal(needsYouTotal(away.counts), needsYouTotal(before.counts) - 1, "and out of needsYou's counts");
  for (const lane of ["ready", "drafting", "notReady", "declined", "fleet", "snoozed"]) assert.ok(!away.ids(lane).includes(A), `${A} is in no ${lane} section`);

  await withService(deps, async (post) => {
    assert.equal((await post("/v1/inbox/archive", { proposalId: A, archived: false })).status, 200);
  });
  const back = await pass(deps, memo, T0 + 120_000);
  assert.deepEqual(back.ids("needsYou").sort(), [A, B], "un-archiving restores it");
  assert.deepEqual(back.ids("archived"), []);
  assert.equal(needsYouTotal(back.counts), needsYouTotal(before.counts));
});

test("W1-T8831: a snoozed item returns when its snooze comes due", async (t) => {
  const { deps } = world(t, [A, B]);
  const memo: InboxRefreshMemo = {};
  const until = new Date(T0 + HOUR).toISOString();
  await pass(deps, memo, T0);
  await withService(deps, async (post) => {
    const snoozed = await post("/v1/inbox/snooze", { proposalId: A, until });
    assert.equal(snoozed.status, 200);
    assert.equal(snoozed.body.snoozedUntil, until);
  });

  const hidden = await pass(deps, memo, T0 + HOUR / 2);
  assert.deepEqual(hidden.ids("needsYou"), [B], "hidden until its time");
  assert.deepEqual(hidden.ids("snoozed"), [A]);
  assert.equal(hidden.section("snoozed")[0]!.snoozedUntil, until);
  assert.equal(hidden.counts.snoozed, 1);
  assert.equal(hidden.refreshed.nextSnoozeWakeAt, until, "the pass names the instant the next recompute is due");
  const idle = await pass(deps, memo, T0 + HOUR / 2 + 1000);
  assert.equal(JSON.stringify(idle.refreshed.bodies.map((b) => b.data)), JSON.stringify(hidden.refreshed.bodies.map((b) => b.data)), "the view holds no clock: an idle recompute keeps its bytes");

  const due = await pass(deps, memo, T0 + HOUR + 1000);
  assert.deepEqual(due.ids("needsYou").sort(), [A, B], "back once the pass runs at or after the snooze time");
  assert.deepEqual(due.ids("snoozed"), []);
  assert.equal(due.counts.snoozed, 0);
  assert.equal(due.refreshed.nextSnoozeWakeAt, null);

  await withService(deps, async (post) => {
    assert.equal((await post("/v1/inbox/snooze", { proposalId: B, until })).status, 200);
    assert.equal((await post("/v1/inbox/snooze", { proposalId: B, until: null })).status, 200, "null wakes it now");
  });
  assert.deepEqual((await pass(deps, memo, T0 + HOUR + 2000)).ids("snoozed"), []);
});

test("W1-T8831: archive and snooze refuse an unknown proposal and a past time", async (t) => {
  const { deps, stateDir } = world(t, [A]);
  const routes = buildPanelGraphRoutes(deps);
  for (const path of ["/v1/inbox/archive", "/v1/inbox/snooze"]) {
    const route = routes.find((r) => r.method === "POST" && r.path === path);
    assert.ok(route, `${path} is served`);
    assert.equal(route.scope, "write");
    assert.equal(route.tier, "low");
  }
  const future = new Date(T0 + HOUR).toISOString();
  await withService(deps, async (post) => {
    assert.equal((await post("/v1/inbox/archive", { proposalId: "nope", archived: true })).status, 404);
    assert.equal((await post("/v1/inbox/snooze", { proposalId: "nope", until: future })).status, 404);
    assert.equal((await post("/v1/inbox/snooze", { proposalId: A, until: new Date(T0 - 1000).toISOString() })).status, 400, "a past time");
    assert.equal((await post("/v1/inbox/snooze", { proposalId: A, until: new Date(T0).toISOString() })).status, 400, "now is not the future");
    assert.equal((await post("/v1/inbox/snooze", { proposalId: A, until: "tomorrow" })).status, 400, "not RFC 3339");
    assert.equal((await post("/v1/inbox/snooze", { proposalId: A, until: "2026-10-14T09:00:00+02:00" })).status, 400, "not UTC");
    assert.equal((await post("/v1/inbox/archive", { proposalId: A, archived: "yes" })).status, 400);
    assert.equal((await post("/v1/inbox/archive", { proposalId: A, archived: true }, READ_TOKEN)).status, 403, "a write route");
    assert.equal(existsSync(inboxTriagePath(stateDir)), false, "no refusal wrote a mark");

    const first = await post("/v1/inbox/archive", { proposalId: A, archived: true });
    const again = await post("/v1/inbox/archive", { proposalId: A, archived: true });
    assert.deepEqual(again, first, "archiving twice is idempotent");
    assert.equal((await post("/v1/inbox/snooze", { proposalId: A, until: future })).status, 200);
  });
  const steps = readFileSync(deps.ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(steps.map((s) => s.step), ["inbox.archived", "inbox.archived", "inbox.snoozed"], "every accepted write is ledgered, no refusal is");
  assert.equal(steps[2]!.task_id, A);
});

test("W1-T8831: archive and snooze state outlives ledger rotation", async (t) => {
  const { deps, stateDir } = world(t, [A, B]);
  const memo: InboxRefreshMemo = {};
  const until = new Date(T0 + HOUR).toISOString();
  await withService(deps, async (post) => {
    await post("/v1/inbox/archive", { proposalId: A, archived: true });
    await post("/v1/inbox/snooze", { proposalId: B, until });
  });
  for (let i = 0; i < 20; i++) appendLedger(deps.ledgerPath, { run_id: `R${i}`, task_id: "FILLER", step: "filler.row", pad: "x".repeat(200) });
  const rotation = rotateLedger(deps.ledgerPath, { ceilingBytes: 1, smoothingWindowMs: 0 });
  assert.notEqual(rotation.rotated, false, "the live ledger really rotated, taking the inbox.* rows with it");
  assert.ok(!readFileSync(deps.ledgerPath, "utf8").includes("inbox.archived"), "the archive row is no longer in the live ledger");
  assert.ok(existsSync(inboxTriagePath(stateDir)));

  const after = await pass(deps, memo, T0 + 60_000);
  assert.deepEqual(after.ids("archived"), [A]);
  assert.deepEqual(after.ids("snoozed"), [B]);
  assert.deepEqual(after.ids("needsYou"), []);
});

test("W1-T8831: acting on an archived item un-archives it, and a proposal that leaves the registry drops its mark", async (t) => {
  const { deps, registry, stateDir } = world(t, [A, B]);
  const memo: InboxRefreshMemo = {};
  await withService(deps, async (post) => {
    await post("/v1/inbox/archive", { proposalId: A, archived: true });
    await post("/v1/inbox/archive", { proposalId: B, archived: true });
    assert.equal((await post("/v1/inbox/decline", { proposalId: A, reason: "not wanted" })).status, 200, "decline still works on an archived item");
  });
  const acted = await pass(deps, memo, T0 + 60_000);
  assert.deepEqual(acted.ids("archived"), [B], "declining A un-archived it");
  assert.ok(acted.ids("needsYou").includes(A) || acted.ids("declined").includes(A), "and A is back in a lane, still declined underneath");

  writeFileSync(registry, JSON.stringify({ proposals: [{ id: A, summary: `about ${A}`, evidenceAnchors: [] }] }));
  await pass(deps, memo, T0 + 120_000);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(inboxTriagePath(stateDir), "utf8")) as object), [], "B left the registry, so its mark went with it");
});

test("W1-T8831: the archived and snoozed sections are served views", () => {
  assert.ok(INBOX_VIEW_SECTIONS.includes("archived") && INBOX_VIEW_SECTIONS.includes("snoozed"));
});
