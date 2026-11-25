/**
 * W1-T14881: serve's main thread cannot time a webhook request it was too blocked to see arrive (W1-T14808), but GitHub
 * keeps a log of every delivery it sent with its status code and duration. A pass reads that log and writes one
 * github.delivery row per delivery, resuming from a cursor in the state dir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
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
import { ghShim } from "#test/helpers/gh-shim.js";

const ORG = "fixture-org";
const HOOK = "716757843";
/** Ids past Number.MAX_SAFE_INTEGER, as GitHub's are: a double would round neighbours to one value. */
const id = (n: number): string => (3856109046673203200n + BigInt(n)).toString();

interface Row { step: string; [field: string]: unknown }

/** A fake delivery-log api: the org's hooks and one hook's deliveries, served newest first `perPage` at a time. */
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
    if (path === `orgs/${ORG}/hooks?per_page=100`) {
      return { body: [
        { id: HOOK, config: { url: "https://console.example.test/v1/hooks/github" } },
        { id: "999", config: { url: "https://elsewhere.example.test/hook" } },
      ] };
    }
    const match = /^orgs\/fixture-org\/hooks\/(\d+)\/deliveries\?per_page=100(?:&cursor=(\d+))?$/.exec(path);
    assert.ok(match && match[1] === HOOK, `only serve's hook is paged (${path})`);
    const newestFirst = [...deliveries].reverse();
    const start = match[2] === undefined ? 0 : Number(match[2]);
    const page = newestFirst.slice(start, start + perPage);
    const next = start + perPage < newestFirst.length ? `orgs/${ORG}/hooks/${HOOK}/deliveries?per_page=100&cursor=${start + perPage}` : undefined;
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

test("W1-T14881 criterion 1: a pass ledgers one github.delivery row per new delivery, with status_code and duration_ms and no payload field", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const up = deliveryLog();
  up.add(1);
  up.add(2, 500, 10.002);
  up.add(3);
  const result = await runGithubDeliveryLogPass({ org: ORG, stateDir, log, api: up.api });
  assert.deepEqual(result, { ledgered: 2, failed: false }, "a first pass reads the newest page only");
  assert.deepEqual(deliveryIds(rows), [id(2), id(3)], "oldest first, each delivery once, exact ids");
  const timedOut = rows.find((r) => r.delivery_id === id(2))!;
  assert.equal(timedOut.status_code, 500);
  assert.equal(timedOut.duration_ms, 10_002);
  assert.equal(timedOut.hook_id, HOOK);
  assert.equal(timedOut.event, "check_run");
  assert.equal(timedOut.repository_id, 1300328309);
  for (const row of rows) {
    assert.equal("request" in row, false, "no request field");
    assert.equal("payload" in row, false, "no payload field");
    assert.doesNotMatch(JSON.stringify(row), /secret-looking|private/, "nothing from the payload or headers");
  }

  up.add(4);
  up.add(5);
  up.add(6);
  rows.length = 0;
  assert.deepEqual(await runGithubDeliveryLogPass({ org: ORG, stateDir, log, api: up.api }), { ledgered: 3, failed: false });
  assert.deepEqual(deliveryIds(rows), [id(4), id(5), id(6)], "a later pass pages back to its cursor and stops there");
});

test("W1-T14881 criterion 2: invariant:cursor-resumes — a second pass after a restart ledgers no delivery twice and skips none", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const up = deliveryLog(3);
  for (let n = 1; n <= 3; n++) up.add(n);
  await runGithubDeliveryLogPass({ org: ORG, stateDir, log, api: up.api });
  for (let n = 4; n <= 10; n++) up.add(n);
  // A restart: a new pass with nothing in memory, the cursor only on disk.
  const restarted = deliveryLog(3);
  for (let n = 1; n <= 10; n++) restarted.add(n);
  await runGithubDeliveryLogPass({ org: ORG, stateDir, log, api: restarted.api });
  assert.deepEqual(deliveryIds(rows), Array.from({ length: 10 }, (_, i) => id(i + 1)), "every delivery once, in order");
  rows.length = 0;
  await runGithubDeliveryLogPass({ org: ORG, stateDir, log, api: restarted.api });
  assert.deepEqual(deliveryIds(rows), [], "a pass with nothing new ledgers nothing");
});

test("W1-T14881 criterion 3: a refused deliveries GET writes one read_failed row and keeps the cursor", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const up = deliveryLog(2);
  up.add(1);
  up.add(2);
  await runGithubDeliveryLogPass({ org: ORG, stateDir, log, api: up.api });
  up.add(3);
  up.add(4);
  up.add(5);
  up.refuseOn("cursor=2");
  rows.length = 0;
  assert.deepEqual(await runGithubDeliveryLogPass({ org: ORG, stateDir, log, api: up.api }), { ledgered: 0, failed: true });
  assert.deepEqual(rows, [{ step: GITHUB_DELIVERY_READ_FAILED_STEP, org: ORG, hook_id: HOOK, status_class: "5xx" }],
    "one read_failed row and no delivery row from a half-read walk");
  up.refuseOn(undefined);
  rows.length = 0;
  await runGithubDeliveryLogPass({ org: ORG, stateDir, log, api: up.api });
  assert.deepEqual(deliveryIds(rows), [id(3), id(4), id(5)], "the next pass reads from the kept cursor");
});

test("W1-T14881: a delivery id keeps its digits and the next page comes from the Link header", () => {
  const parsed = parseKeepingIds(`[{"id":${id(1)},"repository_id":1300328309,"duration":0.5}]`) as Array<Record<string, unknown>>;
  assert.equal(parsed[0]!.id, id(1));
  assert.equal(parsed[0]!.repository_id, 1300328309);
  assert.notEqual(String(Number(id(1))), id(1), "positive control: a double would have rounded the id");
  const headers = 'HTTP/2.0 200 OK\nLink: <https://api.github.com/orgs/x/hooks/1/deliveries?per_page=100&cursor=v1_77>; rel="next"\n';
  assert.equal(nextPagePath(headers), "orgs/x/hooks/1/deliveries?per_page=100&cursor=v1_77");
  assert.equal(nextPagePath("HTTP/2.0 200 OK\n"), undefined);
});

test("W1-T14881: the default api reads through a real gh child, keeps exact ids and classes a refusal", async (t) => {
  const { stateDir, rows, log } = scene(t);
  const hooks = JSON.stringify([{ id: Number(HOOK), config: { url: "https://console.example.test/v1/hooks/github" } }]);
  const page = `[{"id":${id(7)},"guid":"g7","status_code":500,"duration":10.0,"event":"status","repository_id":1}]`;
  const shim = ghShim([
    { when: `api -i orgs/${ORG}/hooks/${HOOK}/deliveries`, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 4999\n\n${page}` },
    { when: `api -i orgs/${ORG}/hooks?per_page=100`, stdout: `HTTP/2.0 200 OK\n\n${hooks}` },
    { when: "api -i orgs/refused-org/hooks", stderr: "gh: Resource not accessible by integration (HTTP 403)", exit: 1 },
    { when: "api -i orgs/broken-org/hooks", stderr: "gh: Server Error (HTTP 502)", exit: 1 },
    { when: "api -i orgs/missing-org/hooks", stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "api -i orgs/offline-org/hooks", stderr: "error connecting to api.github.com", exit: 1 },
  ]);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath ?? ""}`;
  t.after(() => { process.env.PATH = savedPath; fs.rmSync(shim.dir, { recursive: true, force: true }); });
  assert.deepEqual(await runGithubDeliveryLogPass({ org: ORG, stateDir, log }), { ledgered: 1, failed: false });
  assert.deepEqual(deliveryIds(rows), [id(7)]);
  assert.equal(rows[0]!.duration_ms, 10_000);
  rows.length = 0;
  for (const org of ["refused-org", "broken-org", "missing-org", "offline-org"]) {
    await runGithubDeliveryLogPass({ org, stateDir, log });
  }
  assert.deepEqual(rows.map((r) => r.status_class), ["auth", "5xx", "4xx", "transport"]);
});

test("W1-T14881: the started pass runs on its interval, never twice at once, and stops", async (t) => {
  const { stateDir, rows, log } = scene(t);
  fs.mkdirSync(join(stateDir, "cache", "github-delivery-log"), { recursive: true });
  fs.writeFileSync(join(stateDir, "cache", "github-delivery-log", `${ORG}.json`), "not json");
  const up = deliveryLog();
  up.add(1);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const api: DeliveryLogApi = async (path) => {
    if (path.endsWith("hooks?per_page=100")) { started++; await held; }
    return up.api(path);
  };
  const stop = startGithubDeliveryLogPass({ org: ORG, stateDir, log, api, intervalMs: 10 });
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
