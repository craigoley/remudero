/**
 * W1-T13455: the read-model worker has built the `inbox-thread?id=` view on demand since P4-T10, but serve never mounted
 * it, so every Console read of it answered 404 and fell back to GET /v1/i/core/inbox/thread (10k reads by 2026-11-17).
 * Serve now mounts it and serves it with no switch entry, and the worker builds its demanded keys with none either.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_VIEW_NAME } from "#src/lib/agent-view.js";
import { INBOX_THREAD_VIEW_NAME } from "#src/lib/inbox-thread-view.js";
import { READ_MODEL_VIEW_READERS, readModelViewBuilt } from "#src/lib/read-model-worker.js";
import { TASK_VIEW_NAME } from "#src/lib/view-demand.js";

test("W1-T13455 criterion 1: with no switch entry the worker builds the inbox-thread view; an explicit off still stops it", () => {
  assert.equal(readModelViewBuilt(INBOX_THREAD_VIEW_NAME, { projector: "on", views: {} } as never), true);
  assert.equal(readModelViewBuilt(TASK_VIEW_NAME, { projector: "on", views: {} } as never), false, "positive control: an unswitched view with no reader is not built");
  assert.equal(readModelViewBuilt(INBOX_THREAD_VIEW_NAME, { projector: "on", views: { [INBOX_THREAD_VIEW_NAME]: "off" } } as never), false, "the operator's off still wins");
  assert.deepEqual(READ_MODEL_VIEW_READERS[INBOX_THREAD_VIEW_NAME]?.map((r) => r.consumer), ["GET /v1/views/inbox-thread"]);
});

test("W1-T13455 criterion 4: the agent view, served by default, is also built with no switch entry", () => {
  assert.equal(readModelViewBuilt(AGENT_VIEW_NAME, { projector: "on", views: {} } as never), true);
  assert.equal(readModelViewBuilt(AGENT_VIEW_NAME, { projector: "on", views: { [AGENT_VIEW_NAME]: "off" } } as never), false, "the operator's off still wins");
});
