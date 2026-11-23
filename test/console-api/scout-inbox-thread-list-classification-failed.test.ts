import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { writePersistedInbox } from "#src/lib/fleet-lane.js";
import { INBOX_STALE_AFTER_MS } from "#src/lib/inbox-freshness.js";
import { createInboxThreadListView, readInboxThreadListView, warmInboxThreadListView } from "#src/lib/inbox-thread-list-view.js";
import { buildSlowLaneInbox, inboxThreadListSources, type InboxBuildOutcome, type PanelGraphDeps } from "#src/lib/panel-graph.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

test("W1-T12433: inbox.thread_list_classification_failed no longer recurs", async (t) => {
  const root = readModelFixtureDir(t, "thread-list-classification").dir;
  const state = join(root, "state");
  mkdirSync(state);
  const now = Date.now();
  const persist = (name: string, at: number) => {
    const id = `ruling:${name}`;
    writePersistedInbox(state, {
      complete: true, proposals: [{ id, summary: name, evidenceAnchors: [] }],
      classifications: [{ proposalId: id, state: "not_ready", reasons: [] }],
      ledgerRows: [], mergedTaskIds: [], projectionIndeterminate: false,
    }, at);
  };
  const logged: string[] = [];
  let finishBuild: (() => void) | undefined;
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath: join(state, "ledger.ndjson"),
    inboxClock: fixedClock(now), inboxFromSlowLane: true, inboxBuildOffLoop: true,
    github: { prView: () => null }, statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxBuild: (input) => new Promise<InboxBuildOutcome>(resolve => {
      finishBuild = () => resolve({ ok: true, ...buildSlowLaneInbox(input) });
    }),
    logProjection: (step) => logged.push(step),
  };
  persist("expired", now - INBOX_STALE_AFTER_MS - 1_000);
  const control = createInboxThreadListView(inboxThreadListSources(deps), { waitMs: 0 });
  const expired = await readInboxThreadListView(control);
  assert.equal(expired.kind, "unavailable");
  assert.equal(expired.code, "classification_failed");
  assert.deepEqual(logged, ["inbox.thread_list_classification_failed"], "an expired snapshot with no replacement still reports failure");
  logged.length = 0;

  persist("replacement", now);
  const view = createInboxThreadListView(inboxThreadListSources(deps), { waitMs: 0 });
  const warming = warmInboxThreadListView(view);
  const pending = await readInboxThreadListView(view);
  assert.ok(finishBuild, "reading the changed snapshot starts a worker build");
  finishBuild();
  await warming;

  assert.equal(pending.kind, "unavailable");
  assert.equal(pending.code, "classification_pending", "a bounded read can return while the worker continues");
  assert.deepEqual(logged, ["inbox.thread_list_classified"], "the shared refresh lands the replacement on its first attempt");
  const fresh = await readInboxThreadListView(view);
  assert.equal(fresh.kind, "ok");
  assert.equal(fresh.source.classifiedAt, new Date(now).toISOString());
  assert.deepEqual(fresh.threads.map(row => row.proposalId), ["ruling:replacement"]);
});
