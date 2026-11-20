/**
 * W1-T13880 — A FULL PASS WITH NO PUBLISHED TICK READ IS SERVED BY THE READ PLANE.
 *
 * On the Azure host core daemon, 2026-11-19, a full pass found no published tick-read generation (its
 * `sweep.full_prelude` at 22:13:43Z: tick_read_source "none", tick_read_miss "unpublished", 48.7 min). With
 * nothing served, the sweep rebuilt its open PR views, credit and escalation candidates on the daemon loop, and
 * 112 `daemon.loop_stall_profile` rows followed (max 161,826 ms, sync git log and gh under the escalation
 * reconcile). onePassPerGeneration now serves an unpublished generation through the plane, as it already did a
 * consumed or stale one: it joins the read in flight, or asks the plane for its own read. Only a daemon with no
 * plane leaves the pass on its own live read.
 *
 * FIXTURES ONLY: the worker is a real worker thread that answers each request with its input after a short delay.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { joinableRead, onePassPerGeneration, startReadPlane, type ReadGeneration } from "#src/lib/read-plane.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const READ_DELAY_MS = 100;

/** A real read plane over a worker thread that answers each request with its input after READ_DELAY_MS. */
function plane<T>() {
  let requests = 0;
  const started = startReadPlane<T, T>({
    workerUrl: pathToFileURL(join(REPO_ROOT, "src", "run-task.ts")), workerInput: {},
    spawn: () => {
      const worker = new Worker(`const { parentPort } = require('node:worker_threads');
        parentPort.on('message', ({ generation, input }) =>
          setTimeout(() => parentPort.postMessage({ generation, facts: input }), ${READ_DELAY_MS}));`, { eval: true });
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message: unknown) => { requests++; post(message); };
      return worker;
    },
    inline: () => { throw new Error("the worker answers"); },
    log: () => {},
  });
  return { read: (input: T) => started.read(input), stop: () => started.stop(), requests: () => requests };
}

const unpublished = (): ReadGeneration<{ tag: string }> | undefined => undefined;

test("W1-T13880 criterion 1: a pass with no published generation joins the tick read in flight, one worker request", async () => {
  const p = plane<{ tag: string }>();
  try {
    const readTick = joinableRead(p.read);
    const serve = onePassPerGeneration(unpublished, readTick, () => ({ tag: "own" }));
    const inFlight = readTick({ tag: "in-flight" });
    const facts = await serve();
    const tick = await inFlight;
    assert.equal(facts, tick.facts, "W1-T13880 unpublished: the pass is served the read in flight, not left to the loop");
    assert.equal(p.requests(), 1, "the worker receives one request, not two");
    assert.deepEqual(serve.lastServe(), { source: "joined", miss: "unpublished", waitMs: serve.lastServe()?.waitMs, publishedAtMs: tick.publishedAtMs });
  } finally { await p.stop(); }
});

test("W1-T13880 criterion 2: with nothing published or in flight the pass reads its own generation from the plane", async () => {
  const p = plane<{ tag: string }>();
  try {
    const serve = onePassPerGeneration(unpublished, joinableRead(p.read), () => ({ tag: "own" }));
    const facts = await serve();
    assert.deepEqual(facts, { tag: "own" }, "W1-T13880 own read: the plane answers the pass's own input");
    assert.equal(p.requests(), 1, "the read went to the worker, off the daemon loop");
    assert.equal(serve.lastServe()?.source, "own_read");
    assert.equal(serve.lastServe()?.miss, "unpublished");
  } finally { await p.stop(); }
});

test("W1-T13880 invariant: a daemon with no read plane still leaves the pass on its own live read", async () => {
  const serve = onePassPerGeneration(unpublished, undefined, () => ({ tag: "own" }));
  assert.equal(await serve(), undefined);
  assert.deepEqual(serve.lastServe(), { source: "none", miss: "no_plane" });
});

test("W1-T13880 unpublished: a pass that refuses an over-age read in flight still names its miss unpublished", async () => {
  const p = plane<{ tag: string }>();
  try {
    const readTick = joinableRead(p.read);
    const serve = onePassPerGeneration(unpublished, readTick, () => ({ tag: "own" }), { maxAgeMs: 1 });
    void readTick({ tag: "in-flight" });
    const facts = await serve();
    assert.deepEqual(facts, { tag: "own" }, "positive control: the over-age read was refused and the pass read its own");
    assert.equal(p.requests(), 2);
    assert.equal(serve.lastServe()?.source, "own_read");
    assert.equal(serve.lastServe()?.miss, "unpublished", "no generation was published, so the miss stays unpublished");
  } finally { await p.stop(); }
});
