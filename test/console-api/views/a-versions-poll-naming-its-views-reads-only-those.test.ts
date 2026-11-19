/**
 * W1-T11979: GET /v1/views/versions read every view, so one open console tab kept all of them on their hot cadence
 * whatever page it showed. A poll that names its page's views (`?views=a,b`) now reads only those and the views
 * they are built from; a poll without the parameter reads every view, as before, and the body never changes.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Clock } from "#src/lib/clock.js";
import {
  canonicalVersionsViews, createReadModelWorker, READ_MODEL_READ_NOTE_MS, READ_MODEL_VERSIONS_VIEWS_PARAM, readModelViewLexicon, versionsReadViews, viewsReadBy,
} from "#src/lib/read-model-worker.js";
import { createViewEvents, VIEW_VERSIONS_PATH } from "#src/lib/view-events.js";
import { viewEtag, type ViewBodyEntry, type ViewSource } from "#src/lib/views.js";
import { readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-19T13:00:00.000Z");
/** The worker's own views, as in production: `needs-you` is a served composite of `now`, not one of them. */
const NAMES = ["now", "nav-badge", "repositories", "read-model"];

function entry(view: string, key: string, data: unknown): ViewBodyEntry {
  const sources: ViewSource[] = [{ name: "ledger:core", asOf: new Date(T0).toISOString(), state: "fresh" }];
  return { view, key, version: 1, generation: 1, etag: viewEtag(view, 1, false, data),
    body: { view, version: 1, generatedAt: new Date(T0).toISOString(), asOf: null, stale: false, sources, data } };
}

/** The versions route's status, etag and body for `url`, answered by the real handler over two served bodies. */
async function versionsAnswer(url: string): Promise<{ status: number; etag: string; body: string }> {
  const bodies = new Map([entry("now", "instance=core", { a: 1 }), entry("repositories", "", { b: 2 })].map((e) => [`${e.view}\u0000${e.key}`, e]));
  const clock: Clock = { now: () => T0, date: () => new Date(T0), iso: () => new Date(T0).toISOString() };
  const events = createViewEvents({
    names: ["now", "repositories"], clock, every: () => () => undefined,
    readModel: {
      bodies,
      body: (view: string, key = "") => bodies.get(`${view}\u0000${key}`),
      judge: (sources: readonly ViewSource[]) => [...sources],
      switches: () => ({ projector: "on" as const, views: { now: "serve" as const, repositories: "serve" as const } }),
      onBody: () => () => true,
    } as never,
  });
  const route = events.routes.find((r) => r.path === VIEW_VERSIONS_PATH)!;
  const answer = { status: 0, etag: "", body: "" };
  await route.handler({ url, headers: {} } as never, {
    writeHead: (status: number, headers: Record<string, string>) => { answer.status = status; answer.etag = headers.etag ?? ""; },
    end: (body?: string) => { answer.body = body ?? ""; },
  } as never, {} as never);
  return answer;
}

/** A read-model worker whose module records each posted read path. */
async function postedReads(t: TestContext, note: (handle: ReturnType<typeof createReadModelWorker>, advance: (ms: number) => void) => void, want: number): Promise<string[]> {
  const state = readModelFixtureDir(t, "versions-views-state");
  const stateDir = state.dir;
  const seen = join(readModelFixtureDir(t, "versions-views-seen").dir, "seen.txt");
  const dir = readModelFixtureDir(t, "versions-views-worker").dir;
  writeFileSync(join(dir, "module.mjs"), `import { parentPort } from "node:worker_threads";
import { appendFileSync } from "node:fs";
parentPort.on("message", (msg) => { if (msg.type === "read") appendFileSync(${JSON.stringify(seen)}, msg.path + "\\n"); });
setInterval(() => {}, 1000);
`);
  let now = T0;
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const handle = createReadModelWorker({ stateDir, instances: ["core", "site"].map((name) => ({ name, ledgerDir: stateDir })),
    workerUrl: pathToFileURL(join(dir, "module.mjs")), clock, every: () => () => undefined, stopWaitMs: 1 });
  state.onClose(() => handle.stop());
  handle.start();
  note(handle, (ms) => { now += ms; });
  const lines = (): string[] => (existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n") : []);
  const deadline = Date.now() + 30_000;
  while (lines().length < want && Date.now() < deadline) await sleep(5);
  await sleep(50);
  return lines();
}

test("W1-T11979 criterion 1: a versions poll naming its views answers the same body and reads only those views and their sources", async (t) => {
  const plain = await versionsAnswer(VIEW_VERSIONS_PATH);
  const named = await versionsAnswer(`${VIEW_VERSIONS_PATH}?${READ_MODEL_VERSIONS_VIEWS_PARAM}=repositories`);
  assert.equal(plain.status, 200, "positive control: the route answered");
  assert.deepEqual(named, plain, "the parameter does not change the answer");
  assert.deepEqual(viewsReadBy(`${VIEW_VERSIONS_PATH}?views=repositories`, NAMES), ["repositories"]);
  assert.deepEqual(viewsReadBy(`${VIEW_VERSIONS_PATH}?views=nav-badge,repositories`, NAMES).sort(), ["nav-badge", "now", "repositories"],
    "a named view brings the worker views it is built from");
  assert.deepEqual(viewsReadBy(`${VIEW_VERSIONS_PATH}?views=needs-you`, NAMES), ["now"],
    "a served composite that is not a worker view still reads the worker view it is built from");
  const params = new URLSearchParams("views=nav-badge%2Crepositories&instance=core");
  assert.equal(versionsReadViews(VIEW_VERSIONS_PATH, params), "nav-badge,repositories", "serve forwards the poll's list");
  assert.equal(versionsReadViews("/v1/views/now", params), undefined, "only a versions poll forwards one");
  const lines = await postedReads(t, (handle, advance) => {
    handle.noteViewRead?.(VIEW_VERSIONS_PATH, undefined, "repositories");
    handle.noteViewRead?.(VIEW_VERSIONS_PATH, undefined, "repositories");
    handle.noteViewRead?.(VIEW_VERSIONS_PATH, undefined, "now");
    handle.noteViewRead?.(VIEW_VERSIONS_PATH, undefined, "repositories,no-such-view");
    advance(READ_MODEL_READ_NOTE_MS);
    handle.noteViewRead?.(VIEW_VERSIONS_PATH, "core", "now,repositories");
    handle.noteViewRead?.(VIEW_VERSIONS_PATH, "core", " repositories,now,now");
  }, 3);
  assert.deepEqual(lines, [`${VIEW_VERSIONS_PATH}?views=repositories`, `${VIEW_VERSIONS_PATH}?views=now`,
    `${VIEW_VERSIONS_PATH}?instance=core&views=now%2Crepositories`], "each named set is posted and spaced on its own, whatever its order, repeats or unknown names");
  assert.deepEqual(viewsReadBy(lines[2]!, NAMES).sort(), ["now", "repositories"], "the worker reads the posted list back");
  const lane = await postedReads(t, (handle) => handle.noteViewRead?.(VIEW_VERSIONS_PATH, undefined, "actions"), 1);
  assert.deepEqual(lane, [`${VIEW_VERSIONS_PATH}?views=actions`],
    "a view the production view lane registers keeps its name before its first body exists");
});

test("W1-T11979 criterion 2: a poll without the parameter reads every view, and an unknown name is ignored", () => {
  assert.deepEqual(viewsReadBy(VIEW_VERSIONS_PATH, NAMES), NAMES, "an unnamed poll reads every view, as before");
  assert.equal(versionsReadViews(VIEW_VERSIONS_PATH, new URLSearchParams("instance=core")), undefined, "and serve forwards no list for it");
  assert.deepEqual(viewsReadBy(`${VIEW_VERSIONS_PATH}?views=repositories,no-such-view`, NAMES), ["repositories"]);
  assert.deepEqual(viewsReadBy(`${VIEW_VERSIONS_PATH}?views=no-such-view`, NAMES), [], "a list of unknown names reads none");
  const known = new Set(["now", "repositories"]);
  assert.equal(canonicalVersionsViews("repositories, now,no-such-view,now", known), "now,repositories",
    "an unknown name, a repeat and the order do not change the read-note key");
  assert.equal(canonicalVersionsViews("no-such-view", known), "", "a list of only unknown names keys as the empty list");
});

test("W1-T11979 criterion 3: the per-instance copy of the versions path reads the same way", async (t) => {
  assert.deepEqual(viewsReadBy("/v1/i/site/views/versions", NAMES), NAMES);
  assert.deepEqual(viewsReadBy("/v1/i/site/views/versions?views=needs-you", NAMES), ["now"]);
  assert.deepEqual(viewsReadBy("/v1/i/site/views/versions?views=repositories,needs-you", NAMES).sort(), ["now", "repositories"]);
  assert.equal(versionsReadViews("/v1/i/site/views/versions", new URLSearchParams("views=needs-you")), "needs-you");
  const lexicon = readModelViewLexicon([{ name: "core", ledgerDir: "/nonexistent" }]);
  for (const name of ["actions", "inbox-threads", "workstreams", "now"]) assert.ok(lexicon.has(name), `serve knows the lane view ${name} without the worker`);
  const lines = await postedReads(t, (handle) => handle.noteViewRead?.(VIEW_VERSIONS_PATH, "core", "actions,needs-you"), 1);
  assert.deepEqual(lines, [`${VIEW_VERSIONS_PATH}?instance=core&views=actions%2Cneeds-you`],
    "the mounted per-instance path keeps a lane view's name before its first body exists");
  assert.deepEqual(viewsReadBy(`/v1/i/core/views/versions?views=actions`, [...NAMES, "actions"]), ["actions"], "and the worker counts it");
});
