// test/serve-reachability.test.ts — W1-T915: the escalation surface is built, correct, and
// unreachable. `needs-me` already renders every open escalation (board.ts/renderNeedsMe, both
// UNTOUCHED by this task — see the fourth test below), but `rmd serve` binds `127.0.0.1:4317`
// inside a container with no published port, so the queue the operator is meant to read has no
// address from any host he uses. This file drives the REAL mechanism `src/lib/serve.ts` now
// exposes for that (`CONTAINER_ALL_INTERFACES_HOST` + `CONTAINER_NETWORK_ENV`), never a mock of
// it, over an ACTUAL `net`/`http` listener — the same discipline test/service.test.ts and
// test/serve.test.ts already use for the auth surface these tests extend.
//
// FOUR falsifiers, one per acceptance claim, each independently drivable (design (iv)):
//   1. the bind is addressable from outside loopback-only reasoning
//   2. the REAL boot credential (resolveServiceTokens, the same call `rmd serve` makes) answers
//      200, not 401, once reachable
//   3. widening the bind does not ALSO widen auth — a bad/missing credential still refuses
//   4. none of this touches board.ts's `needsHuman` predicate or serve.ts's `renderNeedsMe` /
//      `needsMeTaskRowHtml` (the client-side row templates), which this task's own design (iii)
//      forbids changing
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import {
  buildServeServer,
  CONTAINER_ALL_INTERFACES_HOST,
  CONTAINER_NETWORK_ENV,
  CONTAINER_NETWORK_VALUE,
  DEFAULT_SERVE_HOST,
  resolveServeHosts,
  resolveServiceTokens,
  type ServeDeps,
} from "../src/lib/serve.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { type GitHub, type PrRef } from "../src/lib/status.js";
import type { TraceGithub, TracePrView } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function fakeGitHub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close() {} };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return { approve() {}, reframe() {} };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-serve-reach-"));
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function writePlan(root: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n", { flag: "wx" });
  return planPath;
}

/** The SAME minimal ServeDeps shape test/serve.test.ts's `depsFor` builds — an assembled,
 *  real `buildServeServer` instance with faked GitHub/issue/ratify side effects, nothing about
 *  reach or auth faked. `tokens` defaults to `resolveServiceTokens` — the REAL, persisted,
 *  create-once boot-credential path `rmd serve`'s own CLI (run-task.ts's `serveCommand`) calls,
 *  never a hand-typed string constant — so "the boot credential" in these tests names the exact
 *  mechanism the acceptance claim is about. */
function depsFor(root: string, over: Partial<ServeDeps> = {}): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root);
  return {
    board: { plan: planOf([]), ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: fakeGitHub(), ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: resolveServiceTokens(root),
    pollMs: 50,
    ...over,
  };
}

async function withServeServerOn<T>(deps: ServeDeps, host: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const addr = server.address() as AddressInfo;
  try {
    // Reach it over loopback either way — a wildcard bind answers loopback traffic too, on top
    // of whatever non-loopback interface a real container/host also has (see test 1's own
    // assertion on `server.address().address` for the OS-level proof that the bind itself is
    // the wide one, not merely that this particular request happened to land).
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.close();
  }
}

// ── 1. the console bind is addressable from outside its namespace ──────────────────────────

test("W1-T915: the console bind is addressable from outside its namespace", async () => {
  // An UNDECLARED --host 0.0.0.0 is refused exactly as before this task — the carve-out is not
  // "0.0.0.0 is now fine", it is "0.0.0.0 is fine ONLY alongside the explicit container
  // declaration". Regresses to the pre-fix behaviour test/serve.test.ts already locks down.
  assert.throws(
    () => resolveServeHosts(["--host", CONTAINER_ALL_INTERFACES_HOST], {}),
    /binds EVERY interface/,
    "FALSIFIER: 0.0.0.0 must still be refused with no CONTAINER_NETWORK_ENV declared",
  );

  // A near-miss on the gate's value (a loose boolean instead of the named value) is refused too
  // -- this is TRUSTED_PROXY_TAILSCALE's shape: exactly one accepted string, nothing looser.
  for (const notQuiteRight of ["1", "true", "yes", "containerized"]) {
    assert.throws(
      () => resolveServeHosts(["--host", CONTAINER_ALL_INTERFACES_HOST], { [CONTAINER_NETWORK_ENV]: notQuiteRight }),
      /binds EVERY interface/,
      `FALSIFIER: ${JSON.stringify(notQuiteRight)} must not silently satisfy the container gate`,
    );
  }

  // The other wildcard spellings stay refused even WITH the gate set -- the carve-out names
  // exactly one address, never "any wildcard is fine once containerized".
  for (const stillRefused of ["::", "*", ""]) {
    assert.throws(
      () => resolveServeHosts(["--host", stillRefused], { [CONTAINER_NETWORK_ENV]: CONTAINER_NETWORK_VALUE }),
      /binds EVERY interface/,
      `FALSIFIER: ${JSON.stringify(stillRefused)} must stay refused -- only 0.0.0.0 is carved out`,
    );
  }

  // With BOTH the address and the declaration -- exactly how `remudero-serve`'s own launch
  // config must set RMD_SERVE_HOST + RMD_SERVE_NETWORK to close the measured defect -- the
  // console-wide bind resolves, via --host AND via RMD_SERVE_HOST (the launchd/container path).
  assert.deepEqual(
    resolveServeHosts(["--host", CONTAINER_ALL_INTERFACES_HOST], { [CONTAINER_NETWORK_ENV]: CONTAINER_NETWORK_VALUE }),
    [CONTAINER_ALL_INTERFACES_HOST],
  );
  assert.deepEqual(
    resolveServeHosts([], { RMD_SERVE_HOST: CONTAINER_ALL_INTERFACES_HOST, [CONTAINER_NETWORK_ENV]: CONTAINER_NETWORK_VALUE }),
    [CONTAINER_ALL_INTERFACES_HOST],
  );

  // And the DEFAULT (nobody names anything) is UNCHANGED -- R-4 ("exposure must be typed, never
  // inherited") applies to this carve-out too. A container that never opts in stays loopback.
  assert.deepEqual(resolveServeHosts([], {}), [DEFAULT_SERVE_HOST]);
  assert.deepEqual(resolveServeHosts([], { [CONTAINER_NETWORK_ENV]: CONTAINER_NETWORK_VALUE }), [DEFAULT_SERVE_HOST]);

  // AND it is a REAL, working bind, not just a resolved string. `0.0.0.0` accepts a connection
  // over loopback (proven below) on top of whatever OTHER interface a real container/host has --
  // exactly the interface Docker's `-p` NAT and a sibling tunnel-client container connect
  // through, which a loopback-only bind (the measured defect) answers on NEITHER of.
  const root = tmpRoot();
  const deps = depsFor(root);
  await withServeServerOn(deps, CONTAINER_ALL_INTERFACES_HOST, async (base) => {
    const res = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${deps.tokens.read}` } });
    assert.equal(res.status, 200, "a request over loopback still answers on the wide bind");
  });
});

// ── 2. the boot credential authenticates against the status route ──────────────────────────

test("W1-T915: the boot credential authenticates rather than returning 401", async () => {
  const root = tmpRoot();
  const deps = depsFor(root); // tokens === resolveServiceTokens(root), the REAL boot credential

  await withServeServerOn(deps, CONTAINER_ALL_INTERFACES_HOST, async (base) => {
    const res = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${deps.tokens.read}` } });
    assert.equal(res.status, 200, "FALSIFIER: the printed boot (read) token must authenticate, not 401");
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(body && typeof body === "object", "a real status payload, not an error envelope");
  });

  // The SAME token, re-read from disk exactly as `rmd console-url` would -- proves it is the
  // PERSISTED credential (create-once, read-thereafter) that authenticates, not merely
  // whatever happened to be in memory at server construction.
  const reread = resolveServiceTokens(root);
  assert.equal(reread.read, deps.tokens.read, "the boot token is stable across a fresh resolve");
});

// ── 3. repairing only the bind still refuses every request with a bad credential ───────────

test("W1-T915: a reachable console with a bad credential still refuses", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);

  await withServeServerOn(deps, CONTAINER_ALL_INTERFACES_HOST, async (base) => {
    // FALSIFIER for "fixing the bind alone is enough": no credential at all.
    const noAuth = await fetch(`${base}/v1/status`);
    assert.equal(noAuth.status, 401, "reachable + no token must still be unauthorized");

    // FALSIFIER: a credential that simply is not the right one.
    const wrongToken = await fetch(`${base}/v1/status`, { headers: { authorization: "Bearer not-the-real-token" } });
    assert.equal(wrongToken.status, 401, "reachable + wrong token must still be unauthorized");

    // And the READ token specifically must not reach a WRITE route -- widening the BIND must
    // never widen SCOPE. GET /v1/auth/scope is write-gated (buildAuthScopeRoute's own doc).
    const readOnWrite = await fetch(`${base}/v1/auth/scope`, { headers: { authorization: `Bearer ${deps.tokens.read}` } });
    assert.equal(readOnWrite.status, 403, "a read-scope token on a write route is forbidden, not merely unauthorized");
  });
});

// ── 4. the needs-me queue and its escalation rows are left unchanged ───────────────────────

test("W1-T915: the needs-me escalation rows are untouched by the reach change", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);

  // The shell (GET /?token=) is served byte-identically off a loopback-only bind and off the
  // new container-wide bind -- this task changes WHO can reach the process, never WHAT it
  // serves. Fetched through the real assembled server both times, never renderShellHtml() called
  // directly, so a divergence introduced anywhere in the request path would show up here too.
  const loopbackHtml = await withServeServerOn(deps, DEFAULT_SERVE_HOST, async (base) => {
    const res = await fetch(`${base}/?token=${deps.tokens.read}`);
    assert.equal(res.status, 200);
    return res.text();
  });
  const wideHtml = await withServeServerOn(deps, CONTAINER_ALL_INTERFACES_HOST, async (base) => {
    const res = await fetch(`${base}/?token=${deps.tokens.read}`);
    assert.equal(res.status, 200);
    return res.text();
  });
  assert.equal(wideHtml, loopbackHtml, "FALSIFIER: the reach change must not alter a single byte the shell serves");

  // And the specific mechanism this task's own design (iii) forbids touching is still there,
  // unmodified: `renderNeedsMe` keys off `needsHuman` + `escalationOpenedAt` (board.ts's writer
  // contract), and `needsMeTaskRowHtml` still falls back to the escalation's OWN title when no
  // plan task owns the row -- the exact fallback rationale (1) cites as already-shipped work
  // this task must not re-touch.
  const renderNeedsMeFn = wideHtml.match(/function renderNeedsMe\(tasks, feedbackEntries, inboxReady, inboxDrafting\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(renderNeedsMeFn, "renderNeedsMe must still exist in the served shell");
  assert.match(renderNeedsMeFn!, /if \(!t\.needsHuman\) continue;/, "still keyed off needsHuman, unwidened");
  assert.match(renderNeedsMeFn!, /t\.escalationOpenedAt \?\? t\.startedAt/, "still ages off the escalation's own open time");

  const needsMeTaskRowFn = wideHtml.match(/function needsMeTaskRowHtml\(t\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(needsMeTaskRowFn, "needsMeTaskRowHtml must still exist in the served shell");
  assert.match(
    needsMeTaskRowFn!,
    /t\.escalationTitle \? escapeHtml\(t\.escalationTitle\) : "needs human attention \(escalated\)"/,
    "still falls back to the escalation's own title when no plan task owns the row",
  );
});
