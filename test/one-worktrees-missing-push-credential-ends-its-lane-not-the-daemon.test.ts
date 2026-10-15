// test/one-worktrees-missing-push-credential-ends-its-lane-not-the-daemon.test.ts — W1-T9680.
//
// OBSERVED 2026-10-15: W1-T9047's push failed at 04:10:39Z with git's "could not read Username". A held loop had
// truncated the config read, so that one call carried no credential helper (#11985). W1-T5344 keeps every credential
// refusal fatal, so refill closed on both sibling lanes ("a lane rejected"), and when they settled the daemon exited
// at 05:37:33Z with stopReason=error. The fleet credential was alive the whole time. The daemon now asks a fleet
// credential probe first: alive parks only that lane, and refused or unreadable stops as before, naming the probe.

import assert from "node:assert/strict";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";

import * as daemonModule from "../src/lib/daemon.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import * as drainModule from "../src/lib/drain.js";
import { PushFailedError } from "../src/lib/git-push.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";

// Read off the namespaces so the file still loads at the merge base, where these do not exist.
type Probe = { state: "alive" } | { state: "refused" | "unreadable"; detail: string };
const { receivePackCredentialProbe } = daemonModule as unknown as {
  receivePackCredentialProbe: (opts: {
    owner: string; repo: string; token: () => string | undefined; timeoutMs?: number;
    fetchFn?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number }>;
  }) => () => Promise<Probe>;
};
const { laneCredentialRefusal } = drainModule as unknown as {
  laneCredentialRefusal: (err: unknown) => { firstLine: string; stderr: string } | undefined;
};

const WT = "/home/node/Remudero/worktrees/run-W1-T9047-1792035987149";
const USERNAME = "fatal: could not read Username for 'https://github.com/craigoley/remudero.git': No such device or address\n";

/** The exact error W1-T9047's run threw at 04:10:39Z, built by the real push leaf's error class. */
function usernamePush(): PushFailedError {
  return new PushFailedError(`Command failed: git -C ${WT} push origin HEAD\n${USERNAME}\n${USERNAME}`.trimEnd(), USERNAME, undefined);
}

function badCredentials(): Error {
  return Object.assign(new Error("Command failed: git push origin HEAD"), { stderr: "fatal: Authentication failed for 'https://github.com/x/y.git/'" });
}

function planOf(ids: readonly string[]): Plan {
  return loadPlanFromYaml(
    ids.map((id) => `- id: ${id}\n  title: ${id} fixture\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""),
    "one-worktrees-missing-push-credential.fixture.yaml",
  );
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }) as RunResult;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

type Row = { step: string; extra: Record<string, unknown> };

async function settleOnce(throwFor: (id: string) => unknown, probe: (() => Promise<Probe>) | undefined, ids = ["W1-T9047", "W9-T2"]) {
  const rows: Row[] = [];
  let probes = 0;
  const s = await runDaemon(
    planOf(ids),
    {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        const err = throwFor(id);
        if (err !== undefined) throw err;
        return okResult(id);
      },
      sleep: async () => {},
      log: (step, extra = {}) => rows.push({ step, extra }),
      ...(probe ? { probeFleetCredential: () => { probes++; return probe(); } } : {}),
    } as DaemonDeps,
    { laneCount: 2, max: 2, pollIntervalMs: 1 },
  );
  return { s, rows, probes: () => probes, failed: rows.filter((r) => r.step === "daemon.lane_failed") };
}

test("W1-T9680: a could-not-read-username push parks its lane while the fleet credential probe reads alive", async () => {
  const { s, failed, probes } = await settleOnce((id) => (id === "W1-T9047" ? usernamePush() : undefined), async () => ({ state: "alive" }));
  assert.notEqual(s.stopReason, "error", `one lane's push stopped the daemon: ${s.stopDetail}`);
  assert.deepEqual(s.merged, ["W9-T2"], "the sibling lane ran to its merge");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.extra.task, "W1-T9047");
  assert.equal(failed[0]!.extra.class, "push_credential_missing");
  assert.equal(failed[0]!.extra.error, `Command failed: git -C ${WT} push origin HEAD`);
  assert.match(String(failed[0]!.extra.stderr), /could not read Username/, "the lane's stderr is ledgered");
  assert.equal(failed[0]!.extra.fleet_credential, "alive", "and the probe verdict beside it");
  assert.equal(failed[0]!.extra.consecutive, 1);
  assert.equal(probes(), 1, "one probe per refusal, shared by the refill and the settle loop");
});

test("W1-T9680: a refused fleet credential probe still stops the daemon and names the probe", async () => {
  const { s, failed } = await settleOnce((id) => (id === "W1-T9047" ? usernamePush() : undefined),
    async () => ({ state: "refused", detail: "receive-pack discovery answered HTTP 401" }));
  assert.equal(s.stopReason, "error");
  assert.match(s.stopDetail ?? "", /^W1-T9047: Command failed: git -C \S+ push origin HEAD/, "the lane's failure leads the detail");
  assert.match(s.stopDetail ?? "", /fleet credential probe: refused \(receive-pack discovery answered HTTP 401\)/);
  assert.equal(failed.length, 0, "a fleet outage is not parked as one task's failure");
});

test("W1-T9680: an unreadable or absent probe keeps the credential refusal fatal", async () => {
  const unread = await settleOnce((id) => (id === "W1-T9047" ? usernamePush() : undefined),
    async () => ({ state: "unreadable", detail: "receive-pack discovery failed: fetch failed" }));
  assert.equal(unread.s.stopReason, "error");
  assert.match(unread.s.stopDetail ?? "", /fleet credential probe: unreadable \(receive-pack discovery failed: fetch failed\)/);
  const thrown = await settleOnce((id) => (id === "W1-T9047" ? usernamePush() : undefined), async () => { throw new Error("probe threw"); });
  assert.match(thrown.s.stopDetail ?? "", /fleet credential probe: unreadable \(probe threw\)/);
  const absent = await settleOnce((id) => (id === "W1-T9047" ? usernamePush() : undefined), undefined);
  assert.equal(absent.s.stopReason, "error");
  assert.match(absent.s.stopDetail ?? "", /fleet credential probe: unreadable \(no fleet credential probe is wired\)/);
});

test("W1-T9680: a server-refused credential in one lane is probed too, and a second lane's refusal parks the same way", async () => {
  const { s, failed, probes } = await settleOnce((id) => (id === "W1-T9047" ? badCredentials() : usernamePush()), async () => ({ state: "alive" }));
  assert.notEqual(s.stopReason, "error", `stopDetail: ${s.stopDetail}`);
  assert.deepEqual(failed.map((r) => r.extra.task).sort(), ["W1-T9047", "W9-T2"]);
  assert.ok(failed.every((r) => r.extra.class === "push_credential_missing" && r.extra.fleet_credential === "alive"));
  assert.match(String(failed.find((r) => r.extra.task === "W1-T9047")!.extra.stderr), /Authentication failed/);
  assert.equal(probes(), 2, "each refusal asks the probe");
});

test("W1-T9680: a credential refusal leaves its freed lane open to refill only while the probe reads alive", async () => {
  for (const [probe, expectRefill] of [[{ state: "alive" }, true], [{ state: "refused", detail: "HTTP 401" }, false]] as const) {
    const rows: Row[] = [];
    const started: string[] = [];
    const holdA = deferred<RunResult>();
    const holdB = deferred<RunResult>();
    const bothStarted = deferred<void>();
    const run = runDaemon(
      planOf(["A", "B", "C"]),
      {
        refreshMerged: () => () => false,
        log: (step: string, extra: Record<string, unknown> = {}) => rows.push({ step, extra }),
        runOne: (id: string) => {
          started.push(id);
          if (started.includes("A") && started.includes("B")) bothStarted.resolve();
          if (id === "A") return holdA.promise;
          if (id === "B") return holdB.promise;
          return Promise.resolve(okResult(id));
        },
        sleep: async () => {},
        checkFreshness: () => ({ stale: false }),
        probeFleetCredential: async () => probe,
      } as unknown as DaemonDeps,
      { max: 3, laneCount: 2 },
    );
    await bothStarted.promise;
    holdB.reject(usernamePush());
    for (let i = 0; i < 4; i++) await drainMicrotasks();
    const startedWhileARan = [...started];
    holdA.resolve(okResult("A")); // released before asserting, so a red never leaves the daemon running
    const s = await run;
    const held = rows.filter((r) => r.step === "dispatch.lane_refill_held" && r.extra.reason === "a lane rejected").length;
    if (expectRefill) {
      assert.deepEqual(startedWhileARan, ["A", "B", "C"], "C started on B's freed lane while A still ran");
      assert.equal(held, 0);
      assert.notEqual(s.stopReason, "error", `stopDetail: ${s.stopDetail}`);
    } else {
      assert.deepEqual(startedWhileARan, ["A", "B"], "a refused fleet credential admits nothing new");
      assert.equal(held, 1);
      assert.equal(s.stopReason, "error");
    }
  }
});

test("W1-T9680: the lane classifier names a credential refusal from a spawned command and nothing else", () => {
  assert.deepEqual(laneCredentialRefusal(usernamePush()), { firstLine: `Command failed: git -C ${WT} push origin HEAD`, stderr: USERNAME.trim() });
  assert.match(laneCredentialRefusal(badCredentials())?.stderr ?? "", /^fatal: Authentication failed/);
  assert.match(laneCredentialRefusal(new Error(`Command failed: git push origin HEAD\n${USERNAME}`))?.stderr ?? "", /could not read Username/,
    "with no stderr field, the message's own lines are the stderr");
  assert.equal(laneCredentialRefusal(new Error("Command failed: git push origin HEAD\npre-push REFUSED: census-precheck")), undefined);
  assert.equal(laneCredentialRefusal(new TypeError(`x ${USERNAME}`)), undefined, "an in-process throw is not a spawned command");
  assert.equal(laneCredentialRefusal(`Command failed: git push\n${USERNAME}`), undefined, "a bare string is not an Error");
  assert.equal(laneCredentialRefusal(Object.assign(new Error("Command failed: git push"), { stderr: "x".repeat(900) + " could not read Username" }))?.stderr.length, 500,
    "the ledgered stderr is bounded");
});

test("W1-T9680: the receive-pack probe sends the push token and reads 200 alive, 401/403 refused, anything else unreadable", async () => {
  const seen: Array<{ url: string; auth: string }> = [];
  const probeAnswering = (status: number) => receivePackCredentialProbe({
    owner: "craigoley", repo: "remudero", token: () => "tok",
    fetchFn: async (url, init) => { seen.push({ url, auth: init.headers.Authorization! }); return { status }; },
  });
  assert.deepEqual(await probeAnswering(200)(), { state: "alive" });
  assert.equal(seen[0]!.url, "https://github.com/craigoley/remudero.git/info/refs?service=git-receive-pack");
  assert.equal(seen[0]!.auth, `Basic ${Buffer.from("x-access-token:tok").toString("base64")}`);
  assert.deepEqual(await probeAnswering(401)(), { state: "refused", detail: "receive-pack discovery answered HTTP 401" });
  assert.deepEqual(await probeAnswering(403)(), { state: "refused", detail: "receive-pack discovery answered HTTP 403" });
  assert.deepEqual(await probeAnswering(502)(), { state: "unreadable", detail: "receive-pack discovery answered HTTP 502" });
  const thrown = receivePackCredentialProbe({ owner: "o", repo: "r", token: () => "tok", fetchFn: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  assert.deepEqual(await thrown(), { state: "unreadable", detail: "receive-pack discovery failed: getaddrinfo ENOTFOUND" });
  let fetched = false;
  const tokenless = receivePackCredentialProbe({ owner: "o", repo: "r", token: () => undefined, fetchFn: async () => { fetched = true; return { status: 200 }; } });
  assert.deepEqual(await tokenless(), { state: "refused", detail: "no push token is set" });
  assert.equal(fetched, false, "no token is never sent as an anonymous read");
});

test("W1-T9680: a receive-pack probe that never answers is aborted and reads unreadable", async () => {
  const hung = receivePackCredentialProbe({
    owner: "o", repo: "r", token: () => "tok", timeoutMs: 20,
    fetchFn: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  assert.deepEqual(await hung(), { state: "unreadable", detail: "receive-pack discovery failed: aborted" });
});
