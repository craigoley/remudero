/**
 * W1-T14979: GitHub never retries a webhook delivery serve failed (a 10 s timeout or a 5xx). After the delivery-log
 * pass ledgers its rows, it redelivers each failed delivery once through POST /app/hook/deliveries/{id}/attempts, as
 * soon as a newer delivery in the App's log answered 2xx. The github.delivery.redelivered row is written before the
 * POST and read back from the ledger, so a delivery is redelivered at most once across passes and restarts.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import {
  APP_HOOK_ID,
  createRedeliveryMemory,
  defaultDeliveryLogApi,
  DeliveryLogReadError,
  GITHUB_DELIVERY_LOG_INTERVAL_MS,
  GITHUB_DELIVERY_READ_FAILED_STEP,
  GITHUB_DELIVERY_REDELIVERED_STEP,
  GITHUB_DELIVERY_STEP,
  runGithubDeliveryLogPass,
  startGithubDeliveryLogPass,
  type DeliveryLogApi,
} from "#src/lib/github-delivery-log.js";
import { buildReadyServeServer, buildServeServer, CONSOLE_SHA_UNKNOWN, type ServeDeps } from "#src/lib/serve.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const SERVE_HOOK_CONFIG = { content_type: "json", insecure_ssl: "0", url: "https://console.example.test/v1/hooks/github" };

/** Ids past Number.MAX_SAFE_INTEGER, as GitHub's are. */
const id = (n: number): string => (3856109046673203200n + BigInt(n)).toString();

interface Row { step: string; [field: string]: unknown }

interface Delivery { n: number; status?: number; duration?: number; redelivery?: boolean; guid?: string }

/** A fake App-hook log that pages newest first and answers the redelivery POST, recording every call in order. */
function appLog(rows: Row[]) {
  const deliveries: Array<Record<string, unknown>> = [];
  const posts: string[] = [];
  /** The rows already written when each POST was sent: the redelivered row must be among them. */
  const rowsAtPost: Row[][] = [];
  let refusePost: (() => Error) | undefined;
  const add = ({ n, status = 202, duration = 0.31, redelivery = false, guid = `guid-${n}` }: Delivery): void => {
    deliveries.push({ id: id(n), guid, redelivery, status_code: status, duration, event: "check_run", action: "completed",
      delivered_at: `2026-11-26T13:52:${String(n).padStart(2, "0")}Z`, repository_id: 1300328309 });
  };
  const api: DeliveryLogApi = async (path, method = "GET") => {
    if (method === "POST") {
      const match = /^app\/hook\/deliveries\/(\d+)\/attempts$/.exec(path);
      assert.ok(match, `the redelivery POST names one delivery's attempts (${path})`);
      posts.push(match[1]!);
      rowsAtPost.push([...rows]);
      if (refusePost) throw refusePost();
      return { body: "" };
    }
    if (path === "app/hook/config") return { body: SERVE_HOOK_CONFIG };
    assert.equal(path, "app/hook/deliveries?per_page=100");
    return { body: [...deliveries].reverse() };
  };
  return { api, add, posts, rowsAtPost, refuse: (make: (() => Error) | undefined) => void (refusePost = make) };
}

/** A state dir whose log appends each row to the live ledger file, as serve's ledger log does. */
function scene(t: TestContext) {
  const stateDir = fs.mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14979-`));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const rows: Row[] = [];
  const ledger = join(stateDir, "ledger.ndjson");
  const log = (step: string, fields: Record<string, unknown>): void => {
    rows.push({ step, ...fields });
    fs.appendFileSync(ledger, `${JSON.stringify({ ts: "2026-11-26T14:36:00.000Z", step, ...fields })}\n`);
  };
  return { stateDir, rows, log, ledger };
}

const redeliveredRows = (rows: Row[]): Row[] => rows.filter((r) => r.step === GITHUB_DELIVERY_REDELIVERED_STEP);

test("W1-T14979 criterion 1: a failed delivery is redelivered once serve answers again", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const up = appLog(rows);
  up.add({ n: 1 });
  up.add({ n: 2, status: 500, duration: 10.002 });
  up.add({ n: 3, status: 502, duration: 0.4 });
  up.add({ n: 4, status: 500, duration: 10.001, redelivery: true, guid: "guid-0" });
  up.add({ n: 5, status: 0, duration: 10.004 });
  up.add({ n: 6 });
  up.add({ n: 7, status: 500, duration: 10 });
  assert.deepEqual(await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() }), { ledgered: 7, failed: false });
  assert.deepEqual(up.posts, [id(2), id(3), id(5)],
    "each failed delivery older than the newest 2xx, oldest first; never a redelivery itself, never one newer than serve's last answer");
  assert.deepEqual(redeliveredRows(rows), [2, 3, 5].map((n) => ({ step: GITHUB_DELIVERY_REDELIVERED_STEP, hook_id: APP_HOOK_ID, delivery_id: id(n), guid: `guid-${n}` })));
  up.rowsAtPost.forEach((before, i) => assert.ok(redeliveredRows(before).some((r) => r.delivery_id === up.posts[i]),
    "the redelivered row is written BEFORE its POST"));
  // Serve has not answered since delivery 7 failed: it waits. A newer 2xx releases it on the next pass.
  rows.length = 0;
  up.add({ n: 8, status: 201 });
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() });
  assert.deepEqual(up.posts.slice(3), [id(7)]);
  assert.deepEqual(redeliveredRows(rows).map((r) => r.delivery_id), [id(7)]);
});

test("W1-T14979 criterion 1: the redelivery POST carries the App JWT to GitHub's attempts route and treats 202 as done", async (t) => {
  const { stateDir } = scene(t);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = join(stateDir, "app.pem");
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  const env = { GH_APP_ID: "4648213", GH_APP_PRIVATE_KEY_PATH: keyPath, GH_TOKEN: "ghs_installation-token-must-not-appear" };
  const seen: Array<{ url: string; method: string; authorization: string }> = [];
  const answering = (status: number) => (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") ?? "" });
    return new Response(status === 202 ? "{}" : JSON.stringify({ message: "Validation Failed" }), { status });
  }) as typeof fetch;
  const accepted = await defaultDeliveryLogApi({ env, fetchImpl: answering(202) })(`app/hook/deliveries/${id(2)}/attempts`, "POST");
  assert.deepEqual(accepted, { body: "{}" });
  assert.equal(seen[0]!.url, `https://api.github.com/app/hook/deliveries/${id(2)}/attempts`);
  assert.equal(seen[0]!.method, "POST");
  assert.match(seen[0]!.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, "the App JWT, never the installation token");
  const refused = await defaultDeliveryLogApi({ env, fetchImpl: answering(422) })(`app/hook/deliveries/${id(2)}/attempts`, "POST")
    .catch((error: unknown) => error);
  assert.ok(refused instanceof DeliveryLogReadError);
  assert.equal(refused.statusClass, "4xx");
  assert.equal(refused.status, 422);
  // The real default fetch seam: no fetchImpl, the global fetch, the App named by process.env.
  const savedFetch = globalThis.fetch;
  const savedEnv = { id: process.env.GH_APP_ID, key: process.env.GH_APP_PRIVATE_KEY_PATH };
  globalThis.fetch = answering(202);
  process.env.GH_APP_ID = env.GH_APP_ID;
  process.env.GH_APP_PRIVATE_KEY_PATH = env.GH_APP_PRIVATE_KEY_PATH;
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedEnv.id === undefined) delete process.env.GH_APP_ID; else process.env.GH_APP_ID = savedEnv.id;
    if (savedEnv.key === undefined) delete process.env.GH_APP_PRIVATE_KEY_PATH; else process.env.GH_APP_PRIVATE_KEY_PATH = savedEnv.key;
  });
  assert.deepEqual(await defaultDeliveryLogApi()(`app/hook/deliveries/${id(3)}/attempts`, "POST"), { body: "{}" });
  assert.deepEqual(seen.at(-1)!.url, `https://api.github.com/app/hook/deliveries/${id(3)}/attempts`);
  assert.equal(seen.at(-1)!.method, "POST");
});

test("W1-T14979 criterion 2: a delivery is redelivered at most once across passes and restarts", async (t) => {
  const { stateDir, rows, log, ledger } = scene(t);
  const up = appLog(rows);
  up.add({ n: 1, status: 500, duration: 10.002 });
  up.add({ n: 2 });
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() });
  assert.deepEqual(up.posts, [id(1)]);
  // A restart: a new memory, nothing in it, and no new delivery; the ledger alone says 1 was redelivered.
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() });
  assert.deepEqual(up.posts, [id(1)], "a restarted pass never redelivers it twice");
  // Its redelivery arrives, and fails too: a redelivery is never redelivered.
  up.add({ n: 3, status: 500, duration: 10, redelivery: true, guid: "guid-1" });
  up.add({ n: 4 });
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() });
  assert.deepEqual(up.posts, [id(1)]);

  // A refused POST (or a crash after the row) keeps its row: that delivery is lost, never repeated.
  up.add({ n: 5, status: 504, duration: 2 });
  up.add({ n: 6, status: 500, duration: 10 });
  up.add({ n: 7 });
  up.refuse(() => new DeliveryLogReadError("5xx", 502));
  rows.length = 0;
  assert.deepEqual(await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() }), { ledgered: 3, failed: true });
  assert.deepEqual(up.posts, [id(1), id(5)], "a refused POST ends the pass's redeliveries");
  assert.deepEqual(rows.filter((r) => r.step !== GITHUB_DELIVERY_STEP), [
    { step: GITHUB_DELIVERY_REDELIVERED_STEP, hook_id: APP_HOOK_ID, delivery_id: id(5), guid: "guid-5" },
    { step: GITHUB_DELIVERY_READ_FAILED_STEP, hook_id: APP_HOOK_ID, status_class: "5xx", delivery_id: id(5), status: 502 },
  ]);
  up.refuse(() => new TypeError("fetch failed"));
  rows.length = 0;
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() });
  assert.deepEqual(up.posts, [id(1), id(5), id(6)], "the next pass goes on to the next delivery; the refused one is not retried");
  assert.deepEqual(rows.at(-1), { step: GITHUB_DELIVERY_READ_FAILED_STEP, hook_id: APP_HOOK_ID, status_class: "transport", delivery_id: id(6) });
  up.refuse(undefined);
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() });
  assert.deepEqual(up.posts, [id(1), id(5), id(6)], "every failed delivery was tried exactly once");

  // A long-lived serve keeps one memory across passes: it reads the ledger once, and still never repeats.
  const memory = createRedeliveryMemory();
  up.add({ n: 8, status: 500, duration: 10 });
  up.add({ n: 9 });
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: memory });
  assert.equal(memory.loaded, true);
  fs.rmSync(ledger);
  up.add({ n: 10 });
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: memory });
  assert.deepEqual(up.posts, [id(1), id(5), id(6), id(8)], "the memory, not a reread ledger, holds what was redelivered");
  assert.equal(redeliveredRows(rows).filter((r) => r.delivery_id === id(8)).length, 1);
});

test("W1-T14979: a guid GitHub already redelivered, and rows of another hook, are never redelivered", async (t) => {
  const { stateDir, rows, log, ledger } = scene(t);
  const other = { ts: "2026-11-26T14:00:00.000Z", step: GITHUB_DELIVERY_STEP, hook_id: "123", delivery_id: id(0), guid: "guid-x", status_code: 500, redelivery: false };
  const noId = { ts: "2026-11-26T14:00:00.000Z", step: GITHUB_DELIVERY_STEP, hook_id: APP_HOOK_ID, status_code: 500, redelivery: false };
  fs.writeFileSync(ledger, `${JSON.stringify(other)}\n${JSON.stringify(noId)}\n`);
  const up = appLog(rows);
  up.add({ n: 1, status: 500, duration: 10 });
  up.add({ n: 2, status: 202, redelivery: true, guid: "guid-1" });
  up.add({ n: 3 });
  assert.deepEqual(await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() }), { ledgered: 3, failed: false });
  assert.deepEqual(up.posts, [], "redelivered by hand already, and the other hook's row is not the App's");
});

test("W1-T14979: a ledger that cannot be read whole redelivers nothing and writes one ledger read_failed row", async (t) => {
  const { stateDir, rows, log } = scene(t);
  fs.writeFileSync(join(stateDir, "ledger.2026-11-25T00-00-00-000Z.ndjson.gz"), "not gzip");
  const up = appLog(rows);
  up.add({ n: 1, status: 500, duration: 10 });
  up.add({ n: 2 });
  assert.deepEqual(await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() }), { ledgered: 2, failed: true });
  assert.deepEqual(up.posts, [], "an unread archive could hold the row that says it was already redelivered");
  assert.deepEqual(rows.at(-1), { step: GITHUB_DELIVERY_READ_FAILED_STEP, hook_id: APP_HOOK_ID, status_class: "ledger", unread: 1 });
  // Readable again: the next pass redelivers it.
  fs.writeFileSync(join(stateDir, "ledger.2026-11-25T00-00-00-000Z.ndjson.gz"), gzipSync(""));
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() });
  assert.deepEqual(up.posts, [id(1)]);
});

test("W1-T14979: the started pass serve runs redelivers, and its passes share one memory", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const up = appLog(rows);
  up.add({ n: 1, status: 500, duration: 10 });
  up.add({ n: 2 });
  let passes = 0;
  const api: DeliveryLogApi = async (path, method) => {
    if (path === "app/hook/config") passes++;
    return up.api(path, method);
  };
  const stop = startGithubDeliveryLogPass({ stateDir, log, api, intervalMs: 10 });
  try {
    const deadline = Date.now() + 10_000;
    while (passes < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(passes >= 4, "several passes ran");
  } finally {
    stop();
  }
  assert.deepEqual(up.posts, [id(1)], "redelivered by the first pass, and by no later one");
});

test("W1-T14979 criterion 2: a redelivery another serve process made since this memory loaded is never repeated", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const up = appLog(rows);
  up.add({ n: 1, status: 500, duration: 10 });
  const active = createRedeliveryMemory();
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: active });
  assert.equal(active.loaded, true);
  assert.deepEqual(up.posts, [], "no newer 2xx yet: nothing is owed");
  up.add({ n: 2 });
  // A handoff's other generation, with its own memory, redelivers 1 first.
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: createRedeliveryMemory() });
  assert.deepEqual(up.posts, [id(1)]);
  up.add({ n: 3 });
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: active });
  assert.deepEqual(up.posts, [id(1)], "the active memory re-reads the redelivered rows before its POST");
  assert.equal(redeliveredRows(rows).length, 1);
});

test("W1-T14979: a re-read before the POST that cannot read the ledger whole redelivers nothing", async (t) => {
  const { stateDir, rows, log, ledger } = scene(t);
  const up = appLog(rows);
  up.add({ n: 1, status: 500, duration: 10 });
  const memory = createRedeliveryMemory();
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: memory });
  up.add({ n: 2 });
  fs.writeFileSync(join(stateDir, "ledger.1.ndjson.gz"), "not gzip");
  rows.length = 0;
  assert.deepEqual(await runGithubDeliveryLogPass({ stateDir, log, api: up.api, redelivery: memory }), { ledgered: 1, failed: true });
  assert.deepEqual(up.posts, []);
  assert.deepEqual(rows.filter((r) => r.step === GITHUB_DELIVERY_READ_FAILED_STEP).map((r) => r.status_class), ["ledger"]);
  void ledger;
});

/** Counts the timers serve starts at the delivery-log pass's own interval, for one build. */
async function deliveryLogTimers(t: TestContext, wake: boolean, generation: boolean) {
  const root = fs.mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14979-serve-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, "state"));
  const ledgerPath = join(root, "state", "ledger.ndjson"), planPath = join(root, "plan.yaml");
  fs.writeFileSync(ledgerPath, ""); fs.writeFileSync(planPath, "[]\n");
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const deps = {
    ledgerPath, fleetControlRoot: root, questionsRoot: root,
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    issues: { close() {} }, tokens: { read: "r", write: "w" },
    consoleSha: generation ? CONSOLE_SHA_UNKNOWN : "aaaaaaaa", resolveCurrentSha: () => "aaaaaaaa",
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    assistantRepository: "craigoley/remudero",
    demand: { every: () => () => undefined },
    hostServeEvidence: { root },
    incidentInvariants: { readLedger: () => [], setInterval: (() => ({ unref() {} })) as never, clearInterval: () => undefined },
    ...(wake ? { githubEventWake: { secret: "s", repository: "craigoley/remudero" } } : {}),
    ...(generation ? { generation: { requestHandoff() {} } } : {}),
  } as ServeDeps;
  const real = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === GITHUB_DELIVERY_LOG_INTERVAL_MS) started++;
    return real(fn, ms, ...rest);
  }) as typeof setInterval;
  try {
    const server = generation ? await buildReadyServeServer(deps) : buildServeServer(deps);
    const atBuild = started;
    server.emit("listening");
    const atListening = started;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return { atBuild, atListening };
  } finally {
    globalThis.setInterval = real;
  }
}

test("W1-T14979 criterion 2: a supervised generation starts the redelivering pass only once it is promoted", async (t) => {
  const standby = await deliveryLogTimers(t, true, true);
  const standbyBaseline = await deliveryLogTimers(t, false, true);
  assert.equal(standby.atBuild - standbyBaseline.atBuild, 0, "an unpromoted standby runs no delivery-log pass");
  assert.equal(standby.atListening - standbyBaseline.atListening, 1, "its promotion ('listening') starts exactly one");
  const plain = await deliveryLogTimers(t, true, false);
  const plainBaseline = await deliveryLogTimers(t, false, false);
  assert.equal(plain.atBuild - plainBaseline.atBuild, 1, "an unsupervised serve starts its pass at assembly, as before");
});
