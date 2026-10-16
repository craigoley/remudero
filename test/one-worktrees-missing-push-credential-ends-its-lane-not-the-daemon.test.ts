// test/one-worktrees-missing-push-credential-ends-its-lane-not-the-daemon.test.ts — W1-T9680.
//
// OBSERVED 2026-10-15: W1-T9047's push failed at 04:10:39Z with git's "could not read Username". A held loop had
// truncated the config read, so that one call carried no credential helper (#11985). W1-T5344 keeps every credential
// refusal fatal, so refill closed on both sibling lanes ("a lane rejected"), and when they settled the daemon exited
// at 05:37:33Z with stopReason=error. The fleet credential was alive the whole time. The daemon now asks a fleet
// credential probe first: alive parks only that lane, and refused or unreadable stops as before, naming the probe.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
type TokenSource = () => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;
const { receivePackCredentialProbe } = daemonModule as unknown as {
  receivePackCredentialProbe: (opts: { originUrl: string; token: TokenSource; timeoutMs?: number }) => () => Promise<Probe>;
};
const { daemonPushTokenSource } = daemonModule as unknown as {
  daemonPushTokenSource: (repo: string, mint: ((repo: string) => ReturnType<TokenSource>) | undefined, env?: NodeJS.ProcessEnv) => TokenSource;
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
      ...(probe ? { probeFleetPushCredential: () => { probes++; return probe(); } } : {}),
    } as DaemonDeps,
    { laneCount: 2, max: 2, pollIntervalMs: 1 },
  );
  return { s, rows, probes: () => probes, failed: rows.filter((r) => r.step === "daemon.lane_failed") };
}

/**
 * The 05:37 shape on the real runDaemon at two lanes: W9-T2 is held open, W1-T9047's push is refused, and W9-T3 waits
 * for a freed lane. Records what had started before W9-T2 was released, so a red never leaves the daemon running.
 */
async function refillRun(failure: () => unknown, probe: (() => Promise<Probe>) | undefined) {
  const rows: Row[] = [];
  const started: string[] = [];
  const held = deferred<RunResult>();
  const failing = deferred<RunResult>();
  const bothStarted = deferred<void>();
  let probes = 0;
  const run = runDaemon(
    planOf(["W9-T2", "W1-T9047", "W9-T3"]),
    {
      refreshMerged: () => () => false,
      log: (step: string, extra: Record<string, unknown> = {}) => rows.push({ step, extra }),
      runOne: (id: string) => {
        started.push(id);
        if (started.includes("W9-T2") && started.includes("W1-T9047")) bothStarted.resolve();
        if (id === "W9-T2") return held.promise;
        if (id === "W1-T9047") return failing.promise;
        return Promise.resolve(okResult(id));
      },
      sleep: async () => {},
      checkFreshness: () => ({ stale: false }),
      ...(probe ? { probeFleetPushCredential: () => { probes++; return probe(); } } : {}),
    } as unknown as DaemonDeps,
    { max: 3, laneCount: 2 },
  );
  await bothStarted.promise;
  failing.reject(failure());
  for (let i = 0; i < 4; i++) await drainMicrotasks();
  const startedWhileHeld = [...started].sort();
  held.resolve(okResult("W9-T2"));
  const s = await run;
  return {
    s, startedWhileHeld, probes: () => probes,
    failed: rows.filter((r) => r.step === "daemon.lane_failed"),
    refillHeld: rows.filter((r) => r.step === "dispatch.lane_refill_held" && r.extra.reason === "a lane rejected").length,
  };
}

test("W1-T9680: a could-not-read-username push parks its lane while the fleet credential probe reads alive", async () => {
  const { s, failed, probes, startedWhileHeld, refillHeld } = await refillRun(usernamePush, async () => ({ state: "alive" }));
  assert.notEqual(s.stopReason, "error", `one lane's push stopped the daemon: ${s.stopDetail}`);
  assert.deepEqual(startedWhileHeld, ["W1-T9047", "W9-T2", "W9-T3"], "W9-T3 started on the freed lane while W9-T2 still ran");
  assert.equal(refillHeld, 0, "no 'a lane rejected' refill hold");
  assert.deepEqual([...s.merged].sort(), ["W9-T2", "W9-T3"]);
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
  for (const [probe, named] of [
    [async (): Promise<Probe> => ({ state: "refused", detail: "receive-pack discovery answered HTTP 401" }), "refused (receive-pack discovery answered HTTP 401)"],
    [undefined, "unreadable (no fleet credential probe is wired)"],
  ] as const) {
    const { s, failed, startedWhileHeld, refillHeld } = await refillRun(usernamePush, probe);
    assert.equal(s.stopReason, "error");
    assert.match(s.stopDetail ?? "", /^W1-T9047: Command failed: git -C \S+ push origin HEAD\nfatal: could not read Username/, "the lane's failure and stderr lead the detail");
    assert.ok((s.stopDetail ?? "").endsWith(`fleet credential probe: ${named}`), `the detail names the probe: ${s.stopDetail}`);
    assert.equal(failed.length, 0, "a fleet outage is not parked as one task's failure");
    assert.deepEqual(startedWhileHeld, ["W1-T9047", "W9-T2"], "nothing new is admitted onto the freed lane");
    assert.equal(refillHeld, 1);
  }
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

/** A local stand-in for GitHub's smart-HTTP endpoint: receive-pack discovery needs the right token, as GitHub's does. */
async function receivePackStub(answer: (path: string, auth: string | undefined) => number | "hang") {
  const seen: Array<{ path: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    const status = answer(req.url ?? "", req.headers.authorization);
    if (status === "hang") return;
    res.writeHead(status).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}/craigoley/remudero.git`,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const basic = (token: string) => `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
const tokenOf = (token: string): TokenSource => async () => ({ ok: true, token });

test("W1-T9680: the receive-pack probe reads a dead credential as refused", async () => {
  const stub = await receivePackStub((path, auth) =>
    path !== "/craigoley/remudero.git/info/refs?service=git-receive-pack" ? 404 : auth === basic("live") ? 200 : 401);
  try {
    assert.deepEqual(await receivePackCredentialProbe({ originUrl: stub.origin, token: tokenOf("live") })(), { state: "alive" });
    assert.equal(stub.seen[0]!.path, "/craigoley/remudero.git/info/refs?service=git-receive-pack", "receive-pack, never upload-pack");
    assert.equal(stub.seen[0]!.auth, basic("live"), "authenticated as x-access-token with the push token");
    assert.deepEqual(await receivePackCredentialProbe({ originUrl: stub.origin, token: tokenOf("expired") })(),
      { state: "refused", detail: "receive-pack discovery answered HTTP 401" });
    const asked = stub.seen.length;
    assert.deepEqual(await receivePackCredentialProbe({ originUrl: stub.origin, token: async () => ({ ok: false, reason: "mint returned no token" }) })(),
      { state: "refused", detail: "no push token: mint returned no token" });
    assert.deepEqual(await receivePackCredentialProbe({ originUrl: stub.origin, token: async () => { throw new Error("key unreadable"); } })(),
      { state: "refused", detail: "no push token: key unreadable" });
    assert.equal(stub.seen.length, asked, "no token is never sent as an anonymous read");
    assert.deepEqual(await receivePackCredentialProbe({ originUrl: `${stub.origin}/`, token: tokenOf("live") })(), { state: "alive" }, "a trailing slash is the same origin");
  } finally {
    await stub.close();
  }
});

test("W1-T9680: the receive-pack probe reads 403 as refused and any other answer, a dead host or no answer as unreadable", async () => {
  const forbidden = await receivePackStub(() => 403);
  const broken = await receivePackStub(() => 502);
  const hung = await receivePackStub(() => "hang");
  try {
    assert.deepEqual(await receivePackCredentialProbe({ originUrl: forbidden.origin, token: tokenOf("t") })(),
      { state: "refused", detail: "receive-pack discovery answered HTTP 403" });
    assert.deepEqual(await receivePackCredentialProbe({ originUrl: broken.origin, token: tokenOf("t") })(),
      { state: "unreadable", detail: "receive-pack discovery answered HTTP 502" });
    const timedOut = await receivePackCredentialProbe({ originUrl: hung.origin, token: tokenOf("t"), timeoutMs: 50 })();
    assert.equal(timedOut.state, "unreadable");
    assert.match(timedOut.state === "unreadable" ? timedOut.detail : "", /^receive-pack discovery failed: /);
  } finally {
    await Promise.all([forbidden.close(), broken.close(), hung.close()]);
  }
  const gone = await receivePackCredentialProbe({ originUrl: forbidden.origin, token: tokenOf("t") })();
  assert.equal(gone.state, "unreadable", "a closed port is not a refused credential");
});

test("W1-T9680: the daemon's probe token is the credential socket's own mint while it listens, else GH_TOKEN", async () => {
  const asked: string[] = [];
  const mint = async (repo: string) => { asked.push(repo); return { ok: true as const, token: "scoped" }; };
  assert.deepEqual(await daemonPushTokenSource("craigoley/remudero", mint, { GH_TOKEN: "ambient" })(), { ok: true, token: "scoped" });
  assert.deepEqual(asked, ["craigoley/remudero"], "minted for the target repo, as the socket mints for a worker push");
  assert.deepEqual(await daemonPushTokenSource("o/r", undefined, { GH_TOKEN: "ambient" })(), { ok: true, token: "ambient" });
  assert.deepEqual(await daemonPushTokenSource("o/r", undefined, {})(), { ok: false, reason: "GH_TOKEN is not set" });
});
