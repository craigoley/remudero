import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test, type TestContext } from "node:test";

import { listFeedback, type FeedbackEntry } from "../src/lib/feedback.js";
import { readQueuedFeedbackRecords } from "../src/lib/feedback-landing.js";
import { buildSubmitFeedbackRoute, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5731-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "checkout");
  const inboxRoot = join(dir, "inbox");
  const queueDir = join(inboxRoot, "state", "feedback-landing-pending", "plan", "feedback");
  const logged: Array<[string, Record<string, unknown>]> = [];
  const deps: PanelGraphDeps = {
    root,
    inboxRoot,
    planPath: join(root, "plan", "tasks.yaml"),
    ledgerPath: join(dir, "ledger.ndjson"),
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => undefined, reframe: () => undefined },
    logProjection: (step, extra) => { logged.push([step, extra]); },
  };
  return { root, inboxRoot, queueDir, logged, deps };
}

async function submit(deps: PanelGraphDeps) {
  const server = createService({
    tokens: { read: "r-token", write: "w-token" },
    routes: [buildSubmitFeedbackRoute(deps)],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/feedback`, {
      method: "POST",
      headers: { authorization: "Bearer w-token", "content-type": "application/json" },
      body: JSON.stringify({ text: "the feedback board is slow" }),
    });
    return { status: res.status, body: await res.json() as { error?: string; detail?: string; landing?: string; entry: FeedbackEntry } };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

// ledger-read-intent: live
const submittedRows = (deps: PanelGraphDeps) => readLedgerLines(deps.ledgerPath).filter((row) => row.step === "panel.feedback_submitted");

describe("test/post-feedback-answers-503-on-an-unreadable-landing-queue.test.ts", () => {
  test("an unreadable queue refuses a plain submission before capture and logs its route", async (t) => {
    const fx = fixture(t);
    mkdirSync(dirname(fx.queueDir), { recursive: true });
    writeFileSync(fx.queueDir, "not a directory\n");

    const result = await submit(fx.deps);
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "landing_queue_unreadable");
    assert.match(result.body.detail!, /ENOTDIR/);
    assert.equal(existsSync(join(fx.root, "plan", "feedback")), false);
    assert.deepEqual(listFeedback(fx.root), []);
    assert.equal(readFileSync(fx.queueDir, "utf8"), "not a directory\n");
    assert.deepEqual(submittedRows(fx.deps), []);
    assert.equal(fx.logged.length, 1);
    assert.equal(fx.logged[0][0], "serve.feedback_landing_queue_unreadable");
    assert.equal(fx.logged[0][1].route, "/v1/feedback");
    assert.match(String(fx.logged[0][1].reason), /ENOTDIR/);
  });

  test("an unreadable queued record also refuses before capture", async (t) => {
    const fx = fixture(t);
    mkdirSync(fx.queueDir, { recursive: true });
    const record = join(fx.queueDir, "fb-broken.yaml");
    writeFileSync(record, "status: [\n");

    const result = await submit(fx.deps);
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "landing_queue_unreadable");
    assert.equal(existsSync(join(fx.root, "plan", "feedback")), false);
    assert.equal(readFileSync(record, "utf8"), "status: [\n");
    assert.deepEqual(submittedRows(fx.deps), []);
    assert.equal(fx.logged.length, 1);
    assert.equal(fx.logged[0][1].route, "/v1/feedback");
    assert.match(String(fx.logged[0][1].reason), /unparseable/);
  });

  test("a readable queue answers 200 with a durable queued capture and submission row", async (t) => {
    const fx = fixture(t);
    mkdirSync(fx.queueDir, { recursive: true });
    const existing = "id: fb-existing\nstatus: new\nraw: earlier feedback\n";
    writeFileSync(join(fx.queueDir, "fb-existing.yaml"), existing);
    const result = await submit(fx.deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.landing, "queued");
    assert.equal(result.body.entry.origin, "ui");
    const records = readQueuedFeedbackRecords(fx.inboxRoot);
    assert.equal(records.size, 2);
    assert.equal(readFileSync(join(fx.queueDir, "fb-existing.yaml"), "utf8"), existing);
    assert.equal(records.get(`plan/feedback/${result.body.entry.id}.yaml`)?.raw, "the feedback board is slow");
    assert.deepEqual(listFeedback(fx.root), []);
    const rows = submittedRows(fx.deps);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].landing, "queued");
    assert.equal(rows[0].landing_error, undefined);
    assert.deepEqual(fx.logged, []);
  });

  test("a queue read failing after staging records landing_error and still answers the capture", async (t) => {
    const fx = fixture(t);
    mkdirSync(fx.queueDir, { recursive: true });
    const original = fs.readdirSync;
    let reads = 0;
    t.mock.method(fs, "readdirSync", ((path: fs.PathLike, options: unknown) => {
      if (path === fx.queueDir && ++reads === 2) {
        assert.equal(original(fx.queueDir).filter((name) => name.endsWith(".yaml")).length, 1);
        throw new Error("EACCES: landing queue became unreadable after staging");
      }
      return (original as (...args: unknown[]) => unknown)(path, options);
    }) as typeof fs.readdirSync);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

    const result = await submit(fx.deps);
    assert.equal(result.status, 200);
    assert.equal(result.body.landing, undefined);
    assert.equal(result.body.entry.raw, "the feedback board is slow");
    const rows = submittedRows(fx.deps);
    assert.equal(rows.length, 1);
    assert.match(String(rows[0].landing_error), /EACCES: landing queue became unreadable after staging/);
    assert.equal(rows[0].landing, undefined);
    assert.equal(readQueuedFeedbackRecords(fx.inboxRoot).get(`plan/feedback/${result.body.entry.id}.yaml`)?.id, result.body.entry.id);
  });
});
