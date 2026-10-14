// W1-T8825: the inbox view served no sender and no time on any item, so a console titled every row with an
// internal proposal id and could not sort, group or show an inbox. Every item now names who sent it
// (`from`), when it arrived (`receivedAt`), when it last moved (`lastActivityAt`) and its thread (`groupKey`),
// all from STORED instants - the view carries no clock, so an idle inbox keeps its ETags.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { fixedClock } from "../src/lib/clock.js";
import { inboxSender, inboxSenderName } from "../src/lib/inbox-owner.js";
import { refreshInboxClassification, type InboxRefreshMemo } from "../src/lib/inbox-view.js";
import { inboxFirstSeenPath, inboxThreadStorePath, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { appendThreadMessage, inboxThreadIdentity } from "../src/lib/inbox-thread.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

type TestCtx = { after: (fn: () => void) => void };

const T0 = Date.parse("2026-10-05T12:00:00.000Z");
const JUDGED_AT = "2026-10-03T00:00:00.000Z";

function machineRecord(): Record<string, unknown> {
  return {
    id: "W1-T5418", title: "a ci-friction remedy", repo: "remudero", depends_on: [], type: "implement", verify: "human", risk: "medium",
    status: "queued", attempts: 0, author_class: "machine", origin: "ci-friction:garden-1", files: ["src/lib/x.ts", "test/x.test.ts"],
    acceptance: [{ claim: "it holds", proof: "grep: x in src/lib/x.ts" }],
    risk_ruling: { verdict: "high", action: "escalate", confidence: 1, reasons: ["touches policy"], judged_at: JUDGED_AT, pin: "a".repeat(64) },
  };
}

function world(t: TestCtx, proposals: string[]): { root: string; stateDir: string; registry: string; deps: PanelGraphDeps } {
  const root = makeTempDir("rmd-inbox-sender");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, stringifyYaml([machineRecord()]));
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
  };
  return { root, stateDir, registry, deps };
}

type Item = { proposalId: string; from: { kind: string; name: string }; receivedAt: string | null; lastActivityAt: string | null; groupKey: string };

async function pass(deps: PanelGraphDeps, memo: InboxRefreshMemo, nowMs: number) {
  const refreshed = await refreshInboxClassification(deps, memo, fixedClock(nowMs));
  const items = refreshed.bodies.filter((b) => b.data.section === "needsYou").flatMap((b) => b.data.items as unknown as Item[]);
  const find = (id: string): Item => {
    const item = items.find((i) => i.proposalId === id);
    assert.ok(item, `${id} is served in the needsYou section`);
    return item;
  };
  return { refreshed, items, find, bodies: JSON.stringify(refreshed.bodies.map((b) => b.data)) };
}

test("W1-T8825: a machine-judge item names its filer family and its ruling time", async (t) => {
  const { deps } = world(t, ["machine-judge:W1-T5418", "verify-human:W3-T7"]);
  const { find } = await pass(deps, {}, T0);
  const judged = find("machine-judge:W1-T5418");
  assert.deepEqual(judged.from, { kind: "ci-friction", name: "CI-friction gardener" });
  assert.equal(judged.receivedAt, JUDGED_AT, "receivedAt is the ruling's recorded judged_at, not a clock read");
  assert.equal(judged.groupKey, "ci-friction");
  assert.ok(Date.parse(judged.lastActivityAt!) >= Date.parse(judged.receivedAt!), "lastActivityAt is never earlier than receivedAt");
});

test("W1-T8825: an item keeps the received time the inbox first recorded for it", async (t) => {
  const { deps, stateDir } = world(t, ["verify-human:W3-T7"]);
  const memo: InboxRefreshMemo = {};
  const first = await pass(deps, memo, T0);
  const item = first.find("verify-human:W3-T7");
  assert.deepEqual(item.from, { kind: "verify-human", name: "Verify-human judge" });
  assert.equal(item.receivedAt, new Date(T0).toISOString(), "the first time the slow lane classified the id");
  assert.equal(item.groupKey, "verify-human");
  assert.ok(existsSync(inboxFirstSeenPath(stateDir)), "the slow lane persisted the first-seen record");

  const again = await pass(deps, memo, T0 + 3_600_000);
  assert.equal(again.find("verify-human:W3-T7").receivedAt, new Date(T0).toISOString(), "a later pass never rewrites it");
  assert.equal(again.bodies, first.bodies, "an idle recompute serves byte-identical items, so the ETag holds");
  assert.equal(JSON.parse(readFileSync(inboxFirstSeenPath(stateDir), "utf8"))["verify-human:W3-T7"], new Date(T0).toISOString());
});

test("W1-T8825: lastActivityAt moves only when the item does", async (t) => {
  const { deps } = world(t, ["verify-human:W3-T7"]);
  const memo: InboxRefreshMemo = {};
  const idle = await pass(deps, memo, T0);
  assert.equal(idle.find("verify-human:W3-T7").lastActivityAt, new Date(T0).toISOString(), "an item with no activity was last active when it arrived");
  const quiet = await pass(deps, memo, T0 + 600_000);
  assert.equal(quiet.bodies, idle.bodies, "an idle recompute changes nothing");

  const replyAt = T0 + 1_200_000;
  appendThreadMessage(inboxThreadIdentity("verify-human:W3-T7"), "reply", "looking at it", { threadStorePath: inboxThreadStorePath(deps.inboxRoot), now: () => replyAt });
  const replied = await pass(deps, memo, T0 + 1_800_000);
  assert.equal(replied.find("verify-human:W3-T7").lastActivityAt, new Date(replyAt).toISOString(), "a thread reply moves it to the reply's own time");
  assert.equal(replied.find("verify-human:W3-T7").receivedAt, new Date(T0).toISOString(), "and leaves receivedAt alone");

  const reframedAt = T0 + 2_400_000;
  appendFileSync(deps.ledgerPath, JSON.stringify({ ts: new Date(reframedAt).toISOString(), step: "panel.proposal_reframe_requested", task_id: "verify-human:W3-T7", feedback: "narrower" }) + "\n");
  const reframed = await pass(deps, memo, T0 + 3_000_000);
  assert.equal(reframed.find("verify-human:W3-T7").lastActivityAt, new Date(reframedAt).toISOString(), "a reframe row also moves it, to the row's own time");
  const settled = await pass(deps, memo, T0 + 3_600_000);
  assert.equal(settled.bodies, reframed.bodies, "with no further activity the view is stable again");
});

test("W1-T8825: an unknown kind is named, never shown as an id", async (t) => {
  assert.equal(inboxSenderName("mystery-kind"), "Mystery-kind", "an unknown kind is its own name with the first letter capitalised");
  const stamp = inboxSender("mystery-kind:W9-T1", { receivedAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(stamp.from, { kind: "mystery-kind", name: "Mystery-kind" });
  assert.equal(stamp.groupKey, "mystery-kind");
  const bare = inboxSender("P25", {});
  assert.notEqual(bare.from.name, "P25");
  assert.notEqual(bare.from.kind, "P25");
  assert.equal(bare.receivedAt, null, "null only when neither a ruling time nor a first-seen record exists");
  assert.equal(bare.lastActivityAt, null);

  const { deps } = world(t, ["mystery-kind:W9-T1"]);
  const served = await pass(deps, {}, T0);
  const item = served.find("mystery-kind:W9-T1");
  assert.equal(item.from.name, "Mystery-kind");
  assert.ok(!JSON.stringify(item.from).includes("W9-T1"), "the sender never carries the proposal id");
});
