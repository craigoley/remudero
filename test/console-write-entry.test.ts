// test/console-write-entry.test.ts — W1-T2409, rewritten by W1-T4563.
//
// W1-T2409 once added GET /v1/console/write-grant so the daemon's own console could obtain a write
// token in-page: any read-token holder got the write bearer back. W1-T4563 retired that console
// (app.remudero.com is the console, acting as the signed-in operator), and the grant route with
// it. What this file keeps proving, against a REAL server (buildServeServer): read access is not
// write access, and every write route still declares its tier.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildServeServer, resolveServeIdentity, type ServeDeps } from "../src/lib/serve.js";
import { assertWriteTiersComplete, type Route } from "../src/lib/service.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

const READ_TOKEN = "cwe-read-token";
const WRITE_TOKEN = "cwe-write-token";

// ── shared fixtures — the SAME shape test/route-registration.test.ts and
//    test/console-write-state.test.ts already use, so this file adds no new pattern. ───────────

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

// ── the read and write grants remain distinct, and nothing converts one into the other ─────────

test("W1-T4563: the read token can no longer obtain the write token, and still cannot write", async () => {
  // SECURITY, NOT TIDINESS. GET /v1/console/write-grant existed only for the retired daemon console:
  // it answered ANY read-token holder with the write bearer. The read token is the one the old
  // design put in bookmark URLs, so read access was write access. With the console gone the route
  // is gone; this pins that it cannot come back unnoticed.
  const root = tmpRoot();
  const deps = fixtureDeps(root);

  await withServer(deps, async (base) => {
    const grant = await fetch(`${base}/v1/console/write-grant`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(grant.status, 404, "no route hands out the write token any more");
    assert.doesNotMatch(await grant.text(), new RegExp(WRITE_TOKEN), "and nothing in the answer carries it");

    const readOnlyWrite = await fetch(`${base}/v1/operator-notes/add`, {
      method: "POST",
      headers: { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "W1-T3", author: "operator", note: "should never land" }),
    });
    assert.equal(readOnlyWrite.status, 403, "the read token, presented directly to a write route, still 403s");
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

test("the real assembled route table still satisfies assertWriteTiersComplete", async () => {
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

// ── claim 7: nothing added paces or throttles or sleeps a call ──────────────────────────────────

