import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { buildServeServer, renderShellHtml, type ServeDeps } from "../src/lib/serve.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

// ── A REFUSED ACTION MUST EXPLAIN ITSELF ─────────────────────────────────────────────────────
//
// W1-T500 turned `enforceWriteTiers` on. The bearer token that every `rmd console-url --write`
// link carries is pinned at LOW, so from that link ELEVEN write routes now answer 403 — and the
// client read that 403 as "your token is gone", printing the sessionStorage message and telling
// the operator to run `rmd console-url --write` again. That instruction hands them another LOW
// token which fails identically: the console's own recovery advice was a loop.
//
// `/v1/control/stop` is why this is urgent rather than cosmetic. It is MIDDLE, not HIGH — the
// hard kill, the button an operator reaches for when something is wrong and reading carefully is
// the last thing they are doing. Sending them round the token loop at that moment is the worst
// possible time to be wrong about the cause.
//
// The wire already carried the answer: service.ts's tier gate replies `required_tier`. Only the
// client threw it away. So these tests pin BOTH halves — that the refusal really carries the
// fact (over the REAL assembled server, both tiers), and that the client really renders it into
// a message naming the consequence and the remedy.

const READ_TOKEN = "tier-explain-read-token";
const WRITE_TOKEN = "tier-explain-write-token";
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

/** The same fully-assembled `ServeDeps` test/serve-write-tier-wiring.test.ts builds — the REAL
 *  production route table, fakes only at the GitHub/issue-closing edges. Declaring `identity` is
 *  additive (W1-T371's contract): both grantors are live on the same server, one at LOW and one
 *  at HIGH, exactly as `rmd serve` runs today. */
function depsFor(): ServeDeps {
  const root = mkdtempSync(join(tmpdir(), "rmd-tier-explain-"));
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
  const server = buildServeServer(depsFor());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

/** The LOW grantor — the credential a `rmd console-url --write` link actually carries. */
const lowGrant = { authorization: `Bearer ${WRITE_TOKEN}` };
/** The HIGH grantor — tailnet identity, whose reach this change must leave untouched. */
const highGrant = { "tailscale-app-capabilities": JSON.stringify({ [CAPABILITY]: [{ role: "member" }] }) };

async function post(base: string, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ── THE WIRE ────────────────────────────────────────────────────────────────────────────────

test("a low grant at the MIDDLE-tier hard kill is refused carrying the fact the client needs", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/v1/control/stop", lowGrant, {});
    assert.equal(res.status, 403, "the console link's own credential cannot reach STOP under enforcement");
    assert.equal(res.json.error, "forbidden");
    // THE LOAD-BEARING FIELD. Without it the client cannot tell this 403 apart from the
    // token-expiry 403 it already handled, which is exactly how the misdirection happened.
    assert.equal(res.json.required_tier, "middle", "the refusal must name what the action needs");
  });
});

test("a low grant at a HIGH-tier route is refused the same shape, so one client branch covers both", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/v1/drain/run", lowGrant, {});
    assert.equal(res.status, 403);
    assert.equal(res.json.error, "forbidden", "the TIER gate answers first — a low grant never reaches the second factor");
    assert.equal(res.json.required_tier, "high");
  });
});

test("FALSIFIER: a high grant still succeeds at that same middle-tier route, unchanged", async () => {
  await withServer(async (base) => {
    // If this ever fails, the change has cost reach rather than added an explanation. The tier
    // gate is untouched by this task: only what the CLIENT does with a refusal changed, and the
    // credential that could always stop the fleet still can, with no nonce and no extra step
    // (MIDDLE never reaches the second factor — that is a HIGH-only gate).
    const res = await post(base, "/v1/control/stop", highGrant, { reason: "falsifier" });
    assert.equal(res.status, 200, "tailnet identity must still reach a middle-tier write");
    assert.equal(res.json.stopped, true);
    assert.equal(res.json.reason, "falsifier", "and the handler ran for real — the body reached it");
  });
});

// ── THE CLIENT ──────────────────────────────────────────────────────────────────────────────
//
// Driven against the REAL functions extracted from the rendered shell, the sandbox
// test/serve-write-errors.test.ts established — no browser, asserting the TEXT a person reads.

const HTML = renderShellHtml();

function clientFn(name: string): string {
  const re = new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}");
  const src = HTML.match(re)?.[0];
  assert.ok(src, `the shell's inline script must define ${name}()`);
  return src as string;
}
function clientConst(name: string): string {
  const re = new RegExp("const " + name + " = [\\s\\S]*?\\n  \\};");
  const src = HTML.match(re)?.[0];
  assert.ok(src, `the shell's inline script must define ${name}`);
  return src as string;
}

interface Harness {
  postJson: (path: string, body?: unknown) => Promise<{ status: number }>;
  bannerText: () => string;
  bannerHidden: () => boolean;
}

/** A stub DOM plus the real `postJson`/`showWriteError` pair, so what is asserted below is the
 *  shipped client code rather than a restatement of it. */
function harness(status: number, body: string): Harness {
  const banner = { hidden: true, textContent: "" };
  const ackBanner = { hidden: true, textContent: "", dataset: { ackKind: "" } };
  const fetchImpl = () =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body), json: () => Promise.resolve(JSON.parse(body)) });
  const factory = new Function(
    "fetchImpl",
    "banner",
    "ackBanner",
    [
      "var document = { getElementById: function (id) {",
      "  if (id === 'write-error-banner') return banner;",
      "  if (id === 'write-ack-banner') return ackBanner;",
      "  return null;",
      "} };",
      "var fetch = fetchImpl;",
      "var setTimeout = function () { return 0; };",
      "var clearTimeout = function () {};",
      "var writeAckTimer;",
      HTML.match(/const WRITE_ACK_MS = \d+;/)![0],
      "function writeAuthHeaders() { return { authorization: 'Bearer test' }; }",
      clientConst("WRITE_ACK"),
      clientFn("showWriteError"),
      clientFn("clearWriteError"),
      clientFn("showWriteAck"),
      clientFn("clearWriteAck"),
      clientFn("postJson"),
      "return { postJson: postJson };",
    ].join("\n"),
  ) as (f: unknown, b: unknown, a: unknown) => { postJson: Harness["postJson"] };
  const built = factory(fetchImpl, banner, ackBanner);
  return { postJson: built.postJson, bannerText: () => banner.textContent, bannerHidden: () => banner.hidden };
}

const tierRefusal = (tier: string) => JSON.stringify({ error: "forbidden", required_scope: "write", required_tier: tier });

for (const [tier, route] of [
  ["middle", "/v1/control/stop"],
  ["high", "/v1/drain/run"],
] as const) {
  test(`a refused ${tier} action names the consequence and the remedy on the page`, async () => {
    const h = harness(403, tierRefusal(tier));
    await h.postJson(route, {});

    assert.equal(h.bannerHidden(), false, "the refusal must be VISIBLE — the whole defect was a silent wrong answer");
    const text = h.bannerText();
    assert.match(text, /needs a trusted connection/, "names what happened in terms of the connection, not the credential");
    assert.match(text, /tailnet address/, "names the remedy — where the same action does work");
    assert.match(text, /read the fleet and make routine changes/, "and says what this link CAN do, so it does not read as broken");

    // THE MISDIRECTION, pinned as an absence. Sending the operator for a fresh token hands them
    // another LOW one that fails the same way; that advice must not appear on this refusal.
    assert.doesNotMatch(text, /sessionStorage/, "must not blame token storage — the token is valid");
    assert.doesNotMatch(text, /console-url/, "must not send the operator round the loop that cannot help");
  });
}

test("the plain-language register holds: no implementation vocabulary reaches the page", async () => {
  const h = harness(403, tierRefusal("middle"));
  await h.postJson("/v1/control/stop", {});
  const text = h.bannerText();
  for (const word of ["insufficient scope", "forbidden", "tier", "nonce", "403"]) {
    assert.doesNotMatch(text, new RegExp(word, "i"), `"${word}" is the predicate, not the consequence — a person must never read it`);
  }
});

test("DISCRIMINATION: a 403 that does NOT name a required tier still gets the token message", async () => {
  // Without this the new branch could have swallowed every 403 and the genuine expired-token
  // case — the one the old message was written for, and which still happens — would lose its
  // own advice. The two refusals must stay distinguishable in what a person reads.
  const h = harness(403, JSON.stringify({ error: "forbidden", required_scope: "write" }));
  await h.postJson("/v1/control/stop", {});
  const text = h.bannerText();
  assert.match(text, /sessionStorage/, "a scope/auth refusal keeps the token explanation");
  assert.match(text, /rmd console-url --write/, "and keeps the command that actually fixes it");
  assert.doesNotMatch(text, /trusted connection/, "and must NOT claim a connection problem it has no evidence for");
});

test("a NON-403 carrying a required tier is not treated as a refusal to explain", async () => {
  // The branch is guarded on the status as well as the field, so a 500 whose body happens to
  // echo the tier still reads as a server failure rather than a connection one.
  const h = harness(500, tierRefusal("middle"));
  await h.postJson("/v1/control/stop", {});
  const text = h.bannerText();
  assert.match(text, /HTTP 500/, "a server failure still names itself");
  assert.doesNotMatch(text, /trusted connection/);
});
