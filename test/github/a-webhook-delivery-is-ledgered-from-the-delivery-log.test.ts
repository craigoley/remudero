/**
 * W1-T14881: serve's main thread cannot time a webhook request it was too blocked to see arrive (W1-T14808), but GitHub
 * keeps a log of every delivery it sent with its status code and duration. A pass reads that log and writes one
 * github.delivery row per delivery, resuming from a cursor in the state dir. W1-T14967: the log is the App's own
 * webhook's, read with an App JWT, because a user-created org hook is invisible to the App's installation token.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  APP_HOOK_ID,
  defaultDeliveryLogApi,
  DeliveryLogReadError,
  GITHUB_DELIVERY_READ_FAILED_STEP,
  GITHUB_DELIVERY_STEP,
  nextPagePath,
  parseKeepingIds,
  runGithubDeliveryLogPass,
  startGithubDeliveryLogPass,
  type DeliveryLogApi,
} from "#src/lib/github-delivery-log.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

/** Ids past Number.MAX_SAFE_INTEGER, as GitHub's are: a double would round neighbours to one value. */
const id = (n: number): string => (3856109046673203200n + BigInt(n)).toString();

interface Row { step: string; [field: string]: unknown }

/** A fake App-hook log: deliveries served newest first `perPage` at a time, the way GET /app/hook/deliveries pages. */
function deliveryLog(perPage = 2) {
  const deliveries: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let refuse: string | undefined;
  const add = (n: number, status = 202, duration = 0.31): void => {
    deliveries.push({
      id: id(n), guid: `guid-${n}`, delivered_at: `2026-11-25T21:05:${String(n).padStart(2, "0")}Z`, redelivery: false,
      duration, status: status === 202 ? "Accepted" : "Timed out", status_code: status, event: "check_run",
      action: "completed", installation_id: 155256285, repository_id: 1300328309,
      request: { headers: { "X-Hub-Signature-256": "sha256=secret-looking" }, payload: { private: true } },
    });
  };
  const api: DeliveryLogApi = async (path) => {
    calls.push(path);
    if (refuse !== undefined && path.includes(refuse)) throw new DeliveryLogReadError("5xx");
    const match = /^app\/hook\/deliveries\?per_page=100(?:&cursor=(\d+))?$/.exec(path);
    assert.ok(match, `only the App's own hook log is paged (${path})`);
    const newestFirst = [...deliveries].reverse();
    const start = match[1] === undefined ? 0 : Number(match[1]);
    const page = newestFirst.slice(start, start + perPage);
    const next = start + perPage < newestFirst.length ? `app/hook/deliveries?per_page=100&cursor=${start + perPage}` : undefined;
    return { body: page, ...(next ? { next } : {}) };
  };
  return { api, add, calls, refuseOn: (part: string | undefined) => void (refuse = part) };
}

function scene(t: TestContext) {
  const stateDir = fs.mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14881-`));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const rows: Row[] = [];
  const log = (step: string, fields: Record<string, unknown>): void => void rows.push({ step, ...fields });
  return { stateDir, rows, log };
}

const deliveryIds = (rows: Row[]): string[] => rows.filter((r) => r.step === GITHUB_DELIVERY_STEP).map((r) => String(r.delivery_id));

test("W1-T14967 criterion 1: a pass ledgers one github.delivery row per new App-hook delivery with status_code and duration_ms and no payload", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const up = deliveryLog();
  up.add(1);
  up.add(2, 500, 10.002);
  up.add(3);
  const result = await runGithubDeliveryLogPass({ stateDir, log, api: up.api });
  assert.deepEqual(result, { ledgered: 2, failed: false }, "a first pass reads the newest page only");
  assert.deepEqual(deliveryIds(rows), [id(2), id(3)], "oldest first, each delivery once, exact ids");
  const timedOut = rows.find((r) => r.delivery_id === id(2))!;
  assert.equal(timedOut.status_code, 500);
  assert.equal(timedOut.duration_ms, 10_002);
  assert.equal(timedOut.hook_id, APP_HOOK_ID);
  assert.equal(timedOut.event, "check_run");
  assert.equal(timedOut.repository_id, 1300328309);
  for (const row of rows) {
    assert.equal("request" in row, false, "no request field");
    assert.equal("payload" in row, false, "no payload field");
    assert.doesNotMatch(JSON.stringify(row), /secret-looking|private/, "nothing from the payload or headers");
  }
  assert.deepEqual(up.calls, ["app/hook/deliveries?per_page=100"], "the App's own hook log, never an org hook list");
});

test("W1-T14881 criterion 1: a pass ledgers one github.delivery row per new delivery, with status_code and duration_ms and no payload field", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const up = deliveryLog();
  up.add(1);
  up.add(2);
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api });
  up.add(3, 500, 10);
  up.add(4);
  up.add(5);
  rows.length = 0;
  assert.deepEqual(await runGithubDeliveryLogPass({ stateDir, log, api: up.api }), { ledgered: 3, failed: false });
  assert.deepEqual(deliveryIds(rows), [id(3), id(4), id(5)], "a later pass pages back to its cursor and stops there");
  assert.deepEqual(rows.map((r) => r.status_code), [500, 202, 202]);
  assert.equal(rows[0]!.duration_ms, 10_000);
});

test("W1-T14881 criterion 2: a second pass after a restart ledgers no delivery twice and skips none (invariant:cursor-resumes)", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const up = deliveryLog(3);
  for (let n = 1; n <= 3; n++) up.add(n);
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api });
  // A restart: a new pass with nothing in memory, the cursor only on disk.
  const restarted = deliveryLog(3);
  for (let n = 1; n <= 10; n++) restarted.add(n);
  await runGithubDeliveryLogPass({ stateDir, log, api: restarted.api });
  assert.deepEqual(deliveryIds(rows), Array.from({ length: 10 }, (_, i) => id(i + 1)), "every delivery once, in order");
  rows.length = 0;
  await runGithubDeliveryLogPass({ stateDir, log, api: restarted.api });
  assert.deepEqual(deliveryIds(rows), [], "a pass with nothing new ledgers nothing");
});

test("W1-T14881 criterion 3: a refused deliveries GET writes one read_failed row and keeps the cursor", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const up = deliveryLog(2);
  up.add(1);
  up.add(2);
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api });
  up.add(3);
  up.add(4);
  up.add(5);
  up.refuseOn("cursor=2");
  rows.length = 0;
  assert.deepEqual(await runGithubDeliveryLogPass({ stateDir, log, api: up.api }), { ledgered: 0, failed: true });
  assert.deepEqual(rows, [{ step: GITHUB_DELIVERY_READ_FAILED_STEP, hook_id: APP_HOOK_ID, status_class: "5xx" }],
    "one read_failed row and no delivery row from a half-read walk");
  up.refuseOn(undefined);
  rows.length = 0;
  await runGithubDeliveryLogPass({ stateDir, log, api: up.api });
  assert.deepEqual(deliveryIds(rows), [id(3), id(4), id(5)], "the next pass reads from the kept cursor");
});

test("W1-T14923 criterion 1: a hooks body that is not an array writes one shape read_failed row, with GitHub's message", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const api: DeliveryLogApi = async () => ({ body: { message: "Not Found", documentation_url: "https://docs.github.com/rest" } });
  assert.deepEqual(await runGithubDeliveryLogPass({ stateDir, log, api }), { ledgered: 0, failed: true });
  assert.deepEqual(rows, [{ step: GITHUB_DELIVERY_READ_FAILED_STEP, hook_id: APP_HOOK_ID, status_class: "shape", message: "Not Found" }]);
});

test("W1-T14881: a delivery id keeps its digits and the next page comes from the Link header", () => {
  const parsed = parseKeepingIds(`[{"id":${id(1)},"repository_id":1300328309,"duration":0.5}]`) as Array<Record<string, unknown>>;
  assert.equal(parsed[0]!.id, id(1));
  assert.equal(parsed[0]!.repository_id, 1300328309);
  assert.notEqual(String(Number(id(1))), id(1), "positive control: a double would have rounded the id");
  const link = '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_77>; rel="next"';
  assert.equal(nextPagePath(link), "app/hook/deliveries?per_page=100&cursor=v1_77");
  assert.equal(nextPagePath(null), undefined);
});

/** A real RSA key pair and an App env naming it; the key file lives in the scene's own temp dir. */
function appKey(t: TestContext, stateDir: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = join(stateDir, "app.pem");
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  const env = { GH_APP_ID: "4648213", GH_APP_PRIVATE_KEY_PATH: keyPath, GH_TOKEN: "ghs_installation-token-must-not-appear" };
  void t;
  return { publicKey, env };
}

test("W1-T14967 criterion 2: the App-log GET carries a Bearer JWT, never an installation token", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const { publicKey, env } = appKey(t, stateDir);
  const seen: Array<{ url: string; authorization: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") ?? "" });
    const first = !String(url).includes("cursor=");
    const page = first ? `[{"id":${id(2)},"guid":"g2","status_code":202,"duration":0.2,"event":"status"}]`
      : `[{"id":${id(1)},"guid":"g1","status_code":500,"duration":10,"event":"status"}]`;
    return new Response(page, { status: 200, headers: first ? { link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_9>; rel="next"' } : {} });
  }) as typeof fetch;
  const api = defaultDeliveryLogApi({ env, fetchImpl });
  // A first pass reads one page; seed a cursor so the walk follows the Link header to a second page.
  fs.mkdirSync(join(stateDir, "cache", "github-delivery-log"), { recursive: true });
  fs.writeFileSync(join(stateDir, "cache", "github-delivery-log", `${APP_HOOK_ID}.json`), JSON.stringify({ [APP_HOOK_ID]: id(0) }));
  assert.deepEqual(await runGithubDeliveryLogPass({ stateDir, log, api }), { ledgered: 2, failed: false });
  assert.deepEqual(deliveryIds(rows), [id(1), id(2)]);
  assert.deepEqual(seen.map((s) => s.url), [
    "https://api.github.com/app/hook/deliveries?per_page=100",
    "https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_9",
  ]);
  for (const { authorization } of seen) {
    assert.match(authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, "a Bearer JWT");
    assert.doesNotMatch(authorization, /ghs_|^token /i, "never the installation token");
    const [header, payload, signature] = authorization.slice("Bearer ".length).split(".");
    assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url")), "signed by the App key");
    assert.equal(JSON.parse(Buffer.from(payload!, "base64url").toString()).iss, "4648213");
  }
});

test("W1-T14967: the App-log GET classes each refusal and reads an unconfigured App as auth", async (t) => {
  const { stateDir } = scene(t);
  const { env } = appKey(t, stateDir);
  const answering = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
  const classOf = async (api: ReturnType<typeof defaultDeliveryLogApi>): Promise<string> => {
    try { await api("app/hook/deliveries?per_page=100"); return "resolved"; } catch (error) { return (error as DeliveryLogReadError).statusClass; }
  };
  assert.equal(await classOf(defaultDeliveryLogApi({ env, fetchImpl: answering(401) })), "auth");
  assert.equal(await classOf(defaultDeliveryLogApi({ env, fetchImpl: answering(404) })), "4xx");
  assert.equal(await classOf(defaultDeliveryLogApi({ env, fetchImpl: answering(502) })), "5xx");
  assert.equal(await classOf(defaultDeliveryLogApi({ env, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch })), "transport");
  assert.equal(await classOf(defaultDeliveryLogApi({ env: {}, fetchImpl: answering(200) })), "auth", "no App configured");
  assert.equal(await classOf(defaultDeliveryLogApi({ env: { ...env, GH_APP_PRIVATE_KEY_PATH: join(stateDir, "missing.pem") }, fetchImpl: answering(200) })), "auth", "an unreadable key");
});

test("W1-T14967: the default App-log GET reaches GitHub's api root through the real fetch seam", async (t) => {
  const { stateDir } = scene(t);
  const { env } = appKey(t, stateDir);
  const savedFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => { urls.push(String(url)); return new Response("[]", { status: 200 }); }) as typeof fetch;
  t.after(() => { globalThis.fetch = savedFetch; });
  const savedEnv = { id: process.env.GH_APP_ID, key: process.env.GH_APP_PRIVATE_KEY_PATH };
  process.env.GH_APP_ID = env.GH_APP_ID;
  process.env.GH_APP_PRIVATE_KEY_PATH = env.GH_APP_PRIVATE_KEY_PATH;
  t.after(() => {
    if (savedEnv.id === undefined) delete process.env.GH_APP_ID; else process.env.GH_APP_ID = savedEnv.id;
    if (savedEnv.key === undefined) delete process.env.GH_APP_PRIVATE_KEY_PATH; else process.env.GH_APP_PRIVATE_KEY_PATH = savedEnv.key;
  });
  const { rows, log } = scene(t);
  assert.deepEqual(await runGithubDeliveryLogPass({ stateDir, log }), { ledgered: 0, failed: false });
  assert.deepEqual(urls, ["https://api.github.com/app/hook/deliveries?per_page=100"]);
  assert.deepEqual(rows, []);
});

test("W1-T14881: the started pass runs on its interval, never twice at once, and stops", async (t) => {
  const { stateDir, rows, log } = scene(t);
  fs.mkdirSync(join(stateDir, "cache", "github-delivery-log"), { recursive: true });
  fs.writeFileSync(join(stateDir, "cache", "github-delivery-log", `${APP_HOOK_ID}.json`), "not json");
  const up = deliveryLog();
  up.add(1);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const api: DeliveryLogApi = async (path) => {
    started++;
    if (started === 1) await held;
    return up.api(path);
  };
  const stop = startGithubDeliveryLogPass({ stateDir, log, api, intervalMs: 10 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(started, 1, "a pass still running holds back the next one");
    release();
    const deadline = Date.now() + 10_000;
    while (started < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(started >= 2, "the next interval runs a new pass");
    assert.deepEqual(deliveryIds(rows), [id(1)], "an unreadable cursor file reads as no cursor; the delivery is ledgered once");
  } finally {
    stop();
  }
  const after = started;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(started, after, "a stopped pass runs no more");
});
