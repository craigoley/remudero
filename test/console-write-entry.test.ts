// test/console-write-entry.test.ts — W1-T2409.
//
// THE DEFECT THIS PROVES FIXED: the console already HOLDS a write token once one lands in
// sessionStorage (W1-T202), but the only way to OBTAIN one was to leave the page and run
// `rmd console-url --write` in a shell. Ten ratifiable proposals had never been ratified through
// the console because of exactly that gap. `GET /v1/console/write-grant` (serve.ts) is the "ask"
// this task adds: an in-page round trip, authenticated with the SAME read bearer the shell
// already booted with, that hands back the process's own in-memory write token — never a new
// disk read, never the URL, never a log line.
//
// Every claim below is proven against a REAL server (buildServeServer), the same "stand up the
// real thing and ask it" discipline test/route-registration.test.ts already uses — the shape a
// browser actually sees, not a unit stub of the handler.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildServeServer, resolveServeIdentity, type ServeDeps } from "../src/lib/serve.js";
import { assertWriteTiersComplete, type Route } from "../src/lib/service.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

const READ_TOKEN = "cwe-read-token";
const WRITE_TOKEN = "cwe-write-token";

// ── shared fixtures — the SAME shape test/route-registration.test.ts and
//    test/console-write-state.test.ts already use, so this file adds no new pattern. ───────────

function fakeGitHub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeIssueCloser(): IssueCloser {
  return { close: () => {} };
}

function fakeRatifyGateway(): RatifyCliGateway {
  return { approve: () => {}, reframe: () => {} };
}

function planOf(): Plan {
  return { tasks: [], byId: new Map() };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-cwe-"));
}

function fixtureDeps(root: string): ServeDeps {
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(ledgerPath, "");
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  return {
    board: { plan: planOf(), ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: fakeGitHub(), ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    // NOTE: no `identity` field at all -- the same "an install that never sets
    // config.serve.identityCapability" shape as every other fixture in this suite (claim 6).
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
    log: () => {},
  };
}

async function withServer<T>(deps: ServeDeps, fn: (base: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

/** Every file under `root`, recursively, as absolute paths -- the "no new path" instrument for claim 3. */
function fileListing(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** Every path under `root` whose CONTENT contains `needle` -- direct proof the secret never lands on disk. */
function pathsContaining(root: string, needle: string): string[] {
  return fileListing(root).filter((p) => readFileSync(p, "utf8").includes(needle));
}

// ── claim 1: an authenticated operator can obtain the write grant without leaving the console ──

test("GET /v1/console/write-grant, authenticated with only the read token, hands back a working write credential", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);

  await withServer(deps, async (base) => {
    const granted = await fetch(`${base}/v1/console/write-grant`, {
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(granted.status, 200, "the read bearer this tab already carries is enough to ask");
    const body = (await granted.json()) as { token: string };
    assert.equal(body.token, WRITE_TOKEN, "it hands back the process's real write token, not a decoy");

    // Prove it is genuinely USABLE, not merely echoed bytes: probeWriteScope's own route, and a
    // real mutating LOW-tier write route (operator notes), both driven by nothing but what this
    // one GET returned -- no CLI, no file, no second credential.
    const scope = await fetch(`${base}/v1/auth/scope`, { headers: { authorization: `Bearer ${body.token}` } });
    assert.equal(scope.status, 200, "the exchanged token satisfies the write-scope probe");

    const noted = await fetch(`${base}/v1/operator-notes/add`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "W1-T3", author: "operator", note: "ratified via the in-console grant" }),
    });
    assert.equal(noted.status, 200, "the exchanged token performs a REAL write, end to end");
  });
});

// ── claim 2: the write token still never rides the URL ──────────────────────────────────────────

test("the write-grant route accepts no query-string token, and the shell's own client script never builds one", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);

  await withServer(deps, async (base) => {
    // A ?token= query param carrying the READ token must NOT authenticate this route -- unlike
    // GET /, this is an API route and allowQueryToken is not set on it.
    const viaQuery = await fetch(`${base}/v1/console/write-grant?token=${READ_TOKEN}`);
    assert.equal(viaQuery.status, 401, "no Authorization header, no query-token fallback -- unauthorized");

    const shell = await fetch(`${base}/?token=${READ_TOKEN}`);
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.match(
      html,
      /fetch\("\/v1\/console\/write-grant",\s*\{\s*headers:\s*authHeaders\s*\}\)/,
      "the ask is a header-carrying fetch, the same authHeaders every other GET on this page already uses",
    );
    assert.doesNotMatch(html, /write-grant\?token=/, "the emitted script never builds a URL carrying a token");
  });
});

// ── claim 3: the write token is written to no path it was not already written to ────────────────

test("obtaining the grant touches no disk at all -- the write token lands on no new or existing path", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);

  assert.deepEqual(pathsContaining(root, WRITE_TOKEN), [], "premise: the token starts on no path under root");
  const before = fileListing(root);

  await withServer(deps, async (base) => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/v1/console/write-grant`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }
  });

  const after = fileListing(root);
  assert.deepEqual(after, before, "no file was created or removed under root by asking for the grant");
  assert.deepEqual(pathsContaining(root, WRITE_TOKEN), [], "and the token still lands on no path under root");
});

// ── claim 4: the read and write grants remain distinct and a read grant still cannot write ──────

test("a read-only bearer still cannot write, and an anonymous caller cannot obtain the grant either", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);

  await withServer(deps, async (base) => {
    const anon = await fetch(`${base}/v1/console/write-grant`);
    assert.equal(anon.status, 401, "no credential at all -- unauthorized, exactly like every other route");

    const readOnlyWrite = await fetch(`${base}/v1/operator-notes/add`, {
      method: "POST",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "W1-T3", author: "operator", note: "should never land" }),
    });
    assert.equal(readOnlyWrite.status, 403, "the read token, presented directly to a write route, still 403s");

    // ...and the mechanism that reveals the write token does not itself require write scope --
    // asking for it a second time with the read token still succeeds, proving the scope check on
    // /v1/operator-notes/add above is a property of THAT route, not a global collapse of scopes.
    const askedAgain = await fetch(`${base}/v1/console/write-grant`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(askedAgain.status, 200);
  });

  assert.equal(readFileSync(deps.ledgerPath, "utf8").trim(), "", "the read-scoped write attempt above never reached a handler");
});

// ── claim 5: a write route with no declared tier is still refused ───────────────────────────────

test("a write-scoped route with no declared WriteTier still fails assertWriteTiersComplete", () => {
  const untiered: Route[] = [
    { method: "POST", path: "/v1/example/untiered", scope: "write", handler: () => {} },
  ];
  assert.throws(() => assertWriteTiersComplete(untiered), /POST \/v1\/example\/untiered/);
});

test("the real assembled route table -- write-grant included -- still satisfies assertWriteTiersComplete", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);
  // buildServeServer runs assertWriteTiersComplete internally (buildServeRoutes) and throws if any
  // write-scoped route -- including a newly added one -- lacks a tier. Not throwing IS the proof;
  // the new route is scope "read" precisely so it never needed one (see its own doc, serve.ts).
  assert.doesNotThrow(() => buildServeServer(deps));
});

// ── claim 6: the optional identity gate is unchanged and still omitted by default ───────────────

test("resolveServeIdentity stays undefined for an install that never sets identityCapability", () => {
  assert.equal(resolveServeIdentity(undefined, undefined), undefined);
  assert.equal(resolveServeIdentity(undefined, "tailscale"), undefined, "no capability -- trustedProxy alone grants nothing");
});

test("a fixture with no `identity` field at all still gates the grant on the bearer token alone", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);
  assert.equal(Object.prototype.hasOwnProperty.call(deps, "identity"), false, "premise: identity is genuinely absent, not set to a falsy value");

  await withServer(deps, async (base) => {
    const noHeaderAtAll = await fetch(`${base}/v1/console/write-grant`);
    assert.equal(noHeaderAtAll.status, 401, "with no identity gate configured, only the bearer token can grant anything");
  });
});

// ── claim 7: nothing added paces or throttles or sleeps a call ──────────────────────────────────

test("the write-grant route's own source declares no timer, sleep or delay", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/serve.ts"), "utf8");
  const start = src.indexOf("function buildConsoleWriteGrantRoute(");
  assert.ok(start >= 0, "the route builder must exist");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /setTimeout|setInterval|sleep\(|delay\(|await /, "no pacing primitive of any kind");
});

test("twenty back-to-back grant requests resolve immediately, with no added latency", async () => {
  const root = tmpRoot();
  const deps = fixtureDeps(root);

  await withServer(deps, async (base) => {
    const startedAt = Date.now();
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${base}/v1/console/write-grant`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 2000, `20 sequential requests took ${elapsedMs}ms -- a paced/throttled route would be far slower`);
  });
});
