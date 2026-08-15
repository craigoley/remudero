import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildServeRoutes, buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

// ── W1-T500 acceptance ──
//
// The write-consequence limit (W1-T404) was built, labelled and left OFF: `enforceWriteTiers`
// existed, every write route was tiered, but the flag was never flipped -- and flipping it alone
// would have 403'd every HIGH-tier console button, because `POST /v1/confirm` (the nonce route
// design (iv) needs) was defined in service.ts and mounted NOWHERE. This suite proves the real
// production wiring (`buildServeRoutes`/`buildServeServer`, never a synthetic route table --
// test/write-tier-*.test.ts already cover the MECHANISM against synthetic routes) does all three
// things design (i)-(iii) requires at once: the route is mounted, enforcement is on, and the two
// real grantors land exactly where W1-T404's own ruling put them -- tailnet identity at HIGH
// (full reach, unchanged), the bearer token pinned at LOW (never raised, design (iv) of this
// task's own shard forbids it).

const READ_TOKEN = "wiring-read-token";
const WRITE_TOKEN = "wiring-write-token";
const CAPABILITY = "example.com/cap/console-write";

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
  return mkdtempSync(join(tmpdir(), "rmd-write-tier-wiring-"));
}

/** Same shape test/write-tier-completeness.test.ts's own `depsFor` builds -- a REAL, fully
 *  assembled `ServeDeps`, fakes only at the GitHub/issue-closing edges. `identity` is additive
 *  (W1-T371's own contract): declaring it never removes the bearer token, so both grantors are
 *  live on the SAME server, exactly as `rmd serve` runs today with `identityCapability` set. */
function depsFor(root: string): ServeDeps {
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return {
    board: { plan: planOf(), ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: fakeGitHub(), ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    identity: { trustedLocalAddress: "127.0.0.1", capability: CAPABILITY },
    log: () => {},
  };
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(depsFor(tmpRoot()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const bearerAuth = { authorization: `Bearer ${WRITE_TOKEN}` };
const identityAuth = { "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: [{ role: "member" }] }) };

async function confirm(base: string, auth: Record<string, string>, method: string, path: string, payload: string): Promise<string> {
  const res = await fetch(`${base}/v1/confirm`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ method, path, payload }),
  });
  assert.equal(res.status, 200, "the confirm request itself must succeed before a caller can test the round trip");
  const body = (await res.json()) as { nonce: string };
  assert.ok(body.nonce && body.nonce.length > 0);
  return body.nonce;
}

// ── claim: "the confirm-nonce route is mounted by the real serve route builder, so a client can
// obtain a nonce at all" ──

test("the assembled serve table mounts the confirm-nonce route", async () => {
  const routes = buildServeRoutes(depsFor(tmpRoot()));
  const confirmRoute = routes.find((r) => r.method === "POST" && r.path === "/v1/confirm");
  assert.ok(confirmRoute, "buildServeRoutes must mount POST /v1/confirm -- design (i)");
  assert.equal(confirmRoute!.scope, "write");
  // `scope: "write"` with no declared `tier` would fail `assertWriteTiersComplete` (which
  // `buildServeRoutes` already ran, unconditionally, before returning) -- reaching this line at
  // all is itself part of the proof, but the tier is asserted directly too.
  assert.ok(confirmRoute!.tier, "the mounted route must carry a tier or assertWriteTiersComplete would already have thrown");

  // And over the REAL server, not merely present in the table: a write-scoped caller can reach it
  // and get back an actual, non-empty nonce -- "a client can obtain a nonce at all".
  await withServer(async (base) => {
    const nonce = await confirm(base, bearerAuth, "POST", "/v1/escalation/mark-handled", JSON.stringify({ taskId: "t", issueUrl: "u" }));
    assert.ok(nonce);
  });
});

// ── claim: "with enforcement on, a bearer-token write to a high-tier route is refused without a
// nonce and succeeds with one" ──

test("a high-tier write is refused without a nonce and succeeds with one", async () => {
  await withServer(async (base) => {
    // `/v1/drain/run` — the one HIGH-tier route documented as taking "no body required"
    // (panel-actions.ts's own doc on buildDrainNowRoute). Deliberately NOT `/v1/manual/approve`:
    // that handler re-reads the request as a stream via `jsonAction` (panel-actions.ts's
    // `readJsonBody`), and service.ts's dispatch already drained the body once to bind the nonce
    // to it (the "CONSUMPTION CAVEAT" makeConfirmNonceRoute's own doc names) — a SECOND
    // `req.on("end")` listener attached after the stream already ended never fires, hanging the
    // request forever rather than answering it. `/v1/drain/run` never reads its own body, so it
    // is the one real route this round trip can drive end-to-end without tripping that trap.
    const payload = JSON.stringify({});

    // Tailnet identity is HIGH tier (W1-T430's grantor), so the tier gate is satisfied and the
    // ONLY thing standing between this request and a 200 is the second factor design (iv) adds.
    const bare = await fetch(`${base}/v1/drain/run`, {
      method: "POST",
      headers: { ...identityAuth, "content-type": "application/json" },
      body: payload,
    });
    assert.equal(bare.status, 403, "a HIGH-tier write with no nonce must be refused");
    assert.equal(((await bare.json()) as { error: string }).error, "confirm_nonce_required");

    const nonce = await confirm(base, identityAuth, "POST", "/v1/drain/run", payload);

    const confirmed = await fetch(`${base}/v1/drain/run`, {
      method: "POST",
      headers: { ...identityAuth, "content-type": "application/json", "x-confirm-nonce": nonce },
      body: payload,
    });
    assert.equal(confirmed.status, 200, "the SAME call, carrying the nonce it was issued, must succeed");
    assert.deepEqual(await confirmed.json(), { armed: true });
  });
});

// ── claim: "the tailnet grantor keeps full reach once enforcement is on, so the operator's
// fallback route is unchanged" ──

test("tailnet identity still reaches a high-tier route under enforcement", async () => {
  await withServer(async (base) => {
    const payload = JSON.stringify({});

    // The refusal with no nonce must be the SECOND-FACTOR refusal, never a TIER refusal -- proving
    // the identity grantor's own reach (writeTierSatisfies) is untouched by this task, exactly the
    // "full reach... unchanged" the claim states. A `forbidden`/`required_tier` response here would
    // mean tailnet identity had somehow lost reach, which W1-T404's own ruling never intended.
    const res = await fetch(`${base}/v1/drain/run`, {
      method: "POST",
      headers: { ...identityAuth, "content-type": "application/json" },
      body: payload,
    });
    assert.equal(res.status, 403);
    const refused = (await res.json()) as { error: string; required_tier?: string };
    assert.equal(refused.error, "confirm_nonce_required", "must be the nonce gate, not the tier gate");
    assert.equal(refused.required_tier, undefined, "a tier refusal would name required_tier -- this must not be one");

    // And the full round trip still lands a 200 -- "reaches", not merely "is not immediately
    // refused for the wrong reason".
    const nonce = await confirm(base, identityAuth, "POST", "/v1/drain/run", payload);
    const confirmed = await fetch(`${base}/v1/drain/run`, {
      method: "POST",
      headers: { ...identityAuth, "content-type": "application/json", "x-confirm-nonce": nonce },
      body: payload,
    });
    assert.equal(confirmed.status, 200);
  });
});

// ── claim: "the existing bearer token stays at the low tier rather than being grandfathered
// upward" ──

test("the bearer token remains low tier under enforcement", async () => {
  await withServer(async (base) => {
    // LOW is still reachable -- the bearer token is capped, not revoked.
    const low = await fetch(`${base}/v1/escalation/mark-handled`, {
      method: "POST",
      headers: { ...bearerAuth, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "W1-T3", issueUrl: "https://example.com/issue/3" }),
    });
    assert.equal(low.status, 200, "the bearer token must still reach a LOW-tier route");

    // HIGH is refused OUTRIGHT on tier, before the nonce gate is ever consulted -- no nonce this
    // token could ever present would satisfy it, unlike tailnet identity above.
    const high = await fetch(`${base}/v1/manual/approve`, {
      method: "POST",
      headers: { ...bearerAuth, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "W1-T4", issueUrl: "https://example.com/issue/4" }),
    });
    assert.equal(high.status, 403);
    const refused = (await high.json()) as { error: string; required_tier?: string };
    assert.equal(refused.error, "forbidden", "a TIER refusal, not the nonce gate -- the bearer token never reaches it");
    assert.equal(refused.required_tier, "high");
  });
});
