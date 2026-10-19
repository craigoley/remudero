import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { optionAction, plainSourceFingerprint, plainStorePath, plainTemplate } from "#src/lib/inbox-plain.js";
import { refreshInboxClassification, type InboxRefreshMemo } from "#src/lib/inbox-view.js";
import { appendLedger, rotateLedger } from "#src/lib/ledger.js";
import { buildPanelGraphRoutes, inboxLanes, inboxTriagePath, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { createService } from "#src/lib/service.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";

const ID = "verify-human:W3-T7";
const NOW = Date.parse("2026-10-19T12:00:00Z");
const proposal = { id: ID, summary: "A proposed change needs your decision.", evidenceAnchors: [] };

function world(t: { after(fn: () => void): void }) {
  const root = makeTempDir("rmd-inbox-keep");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"));
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const registry = join(stateDir, "inbox-proposals.json");
  writeFileSync(registry, JSON.stringify({ proposals: [proposal] }));
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40), inboxGrepAnchor: () => true, inboxClock: fixedClock(NOW),
  };
  return { root, stateDir, registry, deps };
}

async function service(deps: PanelGraphDeps) {
  const routes = buildPanelGraphRoutes(deps);
  const server = createService({ tokens: { read: "keep-read", write: "keep-write" }, routes });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    routes,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    async request(path: string, body?: unknown, token = "keep-write") {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as any };
    },
  };
}

async function pass(deps: PanelGraphDeps, memo: InboxRefreshMemo = {}, now = NOW) {
  const result = await refreshInboxClassification(deps, memo, fixedClock(now));
  const items = (section: string): any[] => result.bodies.filter(b => b.data.section === section).flatMap(b => b.data.items);
  return { result, items, ids: (section: string) => items(section).map(i => i.proposalId), counts: result.bodies[0]!.data.counts as any };
}

test("W1-T10078: picking keep records inbox.kept and takes the item out of needsYou", async t => {
  const { deps, stateDir } = world(t);
  const before = await pass(deps);
  assert.deepEqual(before.ids("needsYou"), [ID]);
  assert.equal(before.counts.needsYou.notReady, 1, "control: the item contributes to the decision count");
  const keep = before.items("needsYou")[0].plain.options.find((o: any) => o.intent === "keep");
  assert.deepEqual(keep.action, { method: "POST", path: "/v1/inbox/keep", fields: { proposalId: ID }, input: "reason" });
  const api = await service(deps);
  try {
    const result = await api.request(keep.action.path, { ...keep.action.fields, reason: "Leave the current behaviour in place." });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, proposalId: ID, kept: true, keptAt: new Date(NOW).toISOString() });
    assert.deepEqual(await api.request(keep.action.path, keep.action.fields), result, "repeating keep preserves its instant");
    const mark = JSON.parse(readFileSync(inboxTriagePath(stateDir), "utf8"))[ID];
    assert.equal(mark.keptAt, result.body.keptAt);
    assert.equal(mark.keptState.lane, "notReady");
    assert.equal(mark.keptState.state, "not_ready");
    assert.ok(mark.keptState.reasons.length > 0);
    assert.match(mark.keptState.messageHash, /^[a-f0-9]{64}$/);
    const row = readFileSync(deps.ledgerPath, "utf8").trim().split("\n").map(l => JSON.parse(l)).find(r => r.step === "inbox.kept");
    assert.equal(row.task_id, ID);
    assert.equal(row.reason, "Leave the current behaviour in place.");
    assert.deepEqual(row.keptState, mark.keptState);
    const after = await pass(deps);
    assert.deepEqual(after.ids("kept"), [ID]);
    assert.equal(after.counts.kept, 1);
    for (const lane of ["needsYou", "ready", "drafting", "notReady", "declined", "fleet", "archived", "snoozed"]) assert.deepEqual(after.ids(lane), [], lane);
    assert.deepEqual(after.counts.needsYou, { ready: 0, drafting: 0, notReady: 0, declined: 0 });
    const get = await api.request("/v1/inbox?section=kept&limit=1");
    assert.equal(get.status, 200);
    assert.equal(get.body.kept[0].keptAt, mark.keptAt);
    assert.equal(get.body.page.total, 1);
    assert.equal((await api.request("/v1/inbox")).body.counts.kept, 1);
    for (let i = 0; i < 20; i++) appendLedger(deps.ledgerPath, { run_id: `fill-${i}`, task_id: "filler", step: "filler", pad: "x".repeat(200) });
    assert.notEqual(rotateLedger(deps.ledgerPath, { ceilingBytes: 1, smoothingWindowMs: 0 }).rotated, false);
    assert.ok(!readFileSync(deps.ledgerPath, "utf8").includes("inbox.kept"));
    assert.deepEqual((await pass({ ...deps })).ids("kept"), [ID], "a new reader retains keep after rotation");
  } finally { await api.close(); }
});

test("W1-T10078: a kept item returns when its observed state changes and says what changed", async t => {
  const { deps, registry } = world(t);
  const memo: InboxRefreshMemo = {};
  const api = await service(deps);
  try {
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID })).status, 200);
    assert.deepEqual((await pass(deps, memo)).ids("kept"), [ID]);
    assert.deepEqual((await pass(deps, memo, NOW + 3600_000)).ids("kept"), [ID], "elapsed time alone is immaterial");
    writeFileSync(registry, JSON.stringify({ proposals: [{ ...proposal, summary: "The proposed change was redrafted." }] }));
    const changed = await pass(deps, memo, NOW + 3601_000);
    assert.deepEqual(changed.ids("kept"), []);
    assert.deepEqual(changed.ids("needsYou"), [ID]);
    assert.match(changed.items("needsYou")[0].keptChanged, /redrafted/);
    writeFileSync(registry, JSON.stringify({ proposals: [proposal] }));
    assert.deepEqual((await pass(deps, memo, NOW + 3602_000)).ids("kept"), [], "a lapsed keep cannot silently reactivate");
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID })).status, 200);
    assert.deepEqual((await pass(deps, memo)).ids("kept"), [ID], "a fresh decision holds again");
  } finally { await api.close(); }
});

test("W1-T10078: readiness, predicate reasons and plain text changes reopen a kept item", async t => {
  const { deps, root, stateDir, registry } = world(t);
  const api = await service(deps);
  try {
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID })).status, 200);
    const ledgerLines = Object.assign([], { torn: 0, present: true });
    const lanes = inboxLanes({ proposals: [proposal], classifications: [{ proposalId: ID, state: "ready", reasons: [] }], ledgerLines }, root);
    assert.match((lanes.needsYou.ready[0] as any).keptChanged, /proof is now ready/);
    assert.equal((lanes as any).kept.length, 0);
    const reasons = inboxLanes({ proposals: [proposal], classifications: [{ proposalId: ID, state: "not_ready", reasons: [{ predicate: "lint_clean", detail: "A different proof is missing." }] }], ledgerLines }, root);
    assert.match((reasons.needsYou.notReady[0] as any).keptChanged, /reasons.*changed/);
    const message = plainTemplate(proposal);
    message.headline = "Your decision is still needed";
    writeFileSync(plainStorePath(stateDir), JSON.stringify({ [ID]: { ...message, sourceFingerprint: plainSourceFingerprint(proposal) } }));
    const changed = await pass(deps);
    assert.equal(changed.items("needsYou")[0].plain.headline, message.headline, "control: the edited message is served");
    assert.match(changed.items("needsYou")[0].keptChanged, /redrafted/);
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID })).status, 200);
    writeFileSync(plainStorePath(stateDir), JSON.stringify({ [ID]: { ...message, source: "writer", sourceFingerprint: plainSourceFingerprint(proposal) } }));
    assert.deepEqual((await pass(deps)).ids("kept"), [ID], "writer provenance alone does not reopen it");
    writeFileSync(registry, JSON.stringify({ proposals: [{ ...proposal, lifecycleAction: {
      kind: "skill-retirement", skillName: "procedure", skillPath: "skills/procedure/SKILL.md", evidenceFingerprint: "ready-proof",
    } }] }));
    const ready = await pass(deps);
    assert.deepEqual(ready.ids("ready"), [ID]);
    assert.match(ready.items("needsYou")[0].keptChanged, /proof is now ready/);
  } finally { await api.close(); }
});

test("W1-T10078: a ratified proposal cannot be kept and malformed marks cannot hide an item", async t => {
  const { deps, stateDir } = world(t);
  const api = await service(deps);
  try {
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID })).status, 200);
    const valid = JSON.parse(readFileSync(inboxTriagePath(stateDir), "utf8"))[ID];
    for (const mark of [null, [], 42, { ...valid, keptAt: "yesterday" }, { ...valid, keptState: null },
      { ...valid, keptState: { ...valid.keptState, lane: "missing" } },
      { ...valid, keptState: { ...valid.keptState, reasons: [null] } },
      { ...valid, keptState: { ...valid.keptState, messageHash: "broken" } }]) {
      writeFileSync(inboxTriagePath(stateDir), JSON.stringify({ [ID]: mark }));
      assert.deepEqual((await pass(deps)).ids("needsYou"), [ID], "an invalid decision fails toward visibility");
    }
    appendLedger(deps.ledgerPath, { run_id: "ratified-keep", task_id: ID, step: "ratify.approved" });
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID })).status, 409);
  } finally { await api.close(); }
});

test("W1-T10078: keep is write scoped, low tier, validated and reversible", async t => {
  const { deps, stateDir } = world(t);
  const api = await service(deps);
  try {
    const route = api.routes.find(r => r.path === "/v1/inbox/keep" && r.method === "POST");
    assert.equal(route?.scope, "write");
    assert.equal(route?.tier, "low");
    for (const body of [null, {}, { proposalId: " " }, { proposalId: ID, kept: "yes" }, { proposalId: ID, reason: 42 }]) assert.equal((await api.request("/v1/inbox/keep", body)).status, 400);
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: "missing" })).status, 404);
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID }, "keep-read")).status, 403);
    assert.equal(readFileSync(deps.ledgerPath, "utf8"), "");
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID })).status, 200);
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID, kept: false })).body.kept, false);
    assert.deepEqual((await pass(deps)).ids("needsYou"), [ID]);
    assert.equal(JSON.parse(readFileSync(inboxTriagePath(stateDir), "utf8"))[ID], undefined);
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID })).status, 200);
    assert.equal((await api.request("/v1/inbox/decline", { proposalId: ID, reason: "No longer needed." })).status, 200);
    assert.equal(JSON.parse(readFileSync(inboxTriagePath(stateDir), "utf8"))[ID], undefined);
    assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID })).status, 409);
  } finally { await api.close(); }
});

test("W1-T10078: other inbox verbs clear a keep and every keep option has its route", async t => {
  const { deps, stateDir } = world(t);
  const api = await service(deps);
  try {
    for (const [path, fields] of [
      ["/v1/inbox/reframe", { feedback: "Revisit the proposal." }],
      ["/v1/inbox/archive", { archived: true }],
      ["/v1/inbox/snooze", { until: new Date(NOW + 3600_000).toISOString() }],
      ["/v1/inbox/thread/reply", { threadId: `thread:${ID}::inbox::-::-`, text: "Please revisit this." }],
    ] as const) {
      assert.equal((await api.request("/v1/inbox/keep", { proposalId: ID })).status, 200);
      assert.equal((await api.request(path, { proposalId: ID, ...fields })).status, 200, path);
      assert.equal(JSON.parse(readFileSync(inboxTriagePath(stateDir), "utf8"))[ID]?.keptAt, undefined, path);
    }
    for (const lane of ["ready", "drafting", "notReady", "declined"] as const) assert.deepEqual(optionAction("keep", lane, ID), { method: "POST", path: "/v1/inbox/keep", fields: { proposalId: ID }, input: "reason" });
  } finally { await api.close(); }
});
