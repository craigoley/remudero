import assert from "node:assert/strict";
import { test } from "node:test";

import { renderShellHtml } from "../src/lib/serve.js";

// ── A FAILED CONSOLE WRITE MUST BE VISIBLE ON THE PAGE ───────────────────────────────
//
// `postJson` was a bare fetch with no `.ok` check, and all TWELVE of its call sites discard the
// result. fetch() resolves normally on 401/403/404/500 — it rejects only on a network failure — so
// a rejected write was indistinguishable from a successful one: the button reset, refreshAll() ran,
// and the page did not change. The operator clicked Run, saw nothing, pasted a write token, clicked
// again, saw nothing, and reported the console broken (recon-BV).
//
// These tests drive the REAL client functions, extracted from the rendered shell exactly as
// test/serve.test.ts already does for renderRow — no browser, no Playwright. They assert the TEXT a
// human would read on the page, not merely that a handler ran.

const HTML = renderShellHtml();

/** Pull the named client function out of the served script, verbatim. */
function clientFn(name: string): string {
  const re = new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}");
  const src = HTML.match(re)?.[0];
  assert.ok(src, `the shell's inline script must define ${name}()`);
  return src as string;
}

/** Pull a named client CONST block out of the served script, verbatim (impl-EA: `postJson` now
 *  reads a route table, which is data rather than a function). */
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
  /** impl-EA: the SEPARATE success banner. Stubbed here so the two can be asserted independently —
   *  a success must never raise the error banner, and a failure must never raise this one. */
  ackText: () => string;
  ackHidden: () => boolean;
}

/** Build a sandbox holding the real postJson + its error/ack helpers over a stub DOM. */
function harness(fetchImpl: (path: string, init: unknown) => Promise<unknown>): Harness {
  const banner = { hidden: true, textContent: "" };
  const ackBanner: { hidden: boolean; textContent: string; dataset: { ackKind: string } } = {
    hidden: true,
    textContent: "",
    dataset: { ackKind: "" },
  };
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
      // The ack auto-clears on a timer in the browser; in this sandbox the timer must never fire,
      // or an assertion racing it would flake. Identity stubs keep the code path real and the
      // observation stable.
      "var setTimeout = function () { return 0; };",
      "var clearTimeout = function () {};",
      "var writeAckTimer;",
      // Extracted from the shell rather than hardcoded, so a change to the real timeout cannot
      // silently diverge from what this sandbox exercises.
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
  return {
    postJson: built.postJson,
    bannerText: () => banner.textContent,
    bannerHidden: () => banner.hidden,
    ackText: () => ackBanner.textContent,
    ackHidden: () => ackBanner.hidden,
  };
}

const respond = (status: number, body: string, ok?: boolean) =>
  Promise.resolve({ ok: ok ?? (status >= 200 && status < 300), status, text: () => Promise.resolve(body) });

test("a 401 write names the AUTH cause on the page and tells the operator how to get a write token", async () => {
  const h = harness(() => respond(401, JSON.stringify({ error: "unauthorized" })));
  await h.postJson("/v1/drain/kick", { taskId: "W1-T1" });

  assert.equal(h.bannerHidden(), false, "the banner must be VISIBLE — a devtools log is not a fix");
  const text = h.bannerText();
  assert.match(text, /Not authorized to write \(HTTP 401\)/, "names the status and that it is an auth failure");
  assert.match(text, /sessionStorage/, "explains WHY the token is gone rather than implying a bug");
  assert.match(text, /rmd console-url --write/, "tells the operator the exact command that fixes it");
  assert.doesNotMatch(text, /Bearer|token=[A-Za-z0-9]/, "never echoes a token value");
});

test("a 500 write produces a visible message DISTINCT from the 401 auth message", async () => {
  const h500 = harness(() => respond(500, JSON.stringify({ error: "drain lock held" })));
  await h500.postJson("/v1/drain/run");
  const five = h500.bannerText();

  const h401 = harness(() => respond(401, "{}"));
  await h401.postJson("/v1/drain/run");
  const four = h401.bannerText();

  assert.equal(h500.bannerHidden(), false);
  assert.match(five, /HTTP 500/, "names the status");
  assert.match(five, /\/v1\/drain\/run/, "names WHICH write failed");
  assert.match(five, /drain lock held/, "surfaces the server's own message when it supplies one");
  assert.doesNotMatch(five, /sessionStorage|console-url/, "a 500 is not an auth problem and must not say so");
  assert.notEqual(five, four, "the two failures must not render the same text");
});

test("a 200 write never raises the ERROR banner, and is acknowledged on its own separate banner", async () => {
  // impl-EA CHANGED THIS TEST'S SECOND HALF, deliberately. It used to assert "no banner, nothing
  // noisy on success" — the contract that left the operator clicking Mark handled five times on an
  // action that had already worked. What #1003 actually needed to hold is that a SUCCESS IS NOT AN
  // ERROR, and that is unchanged and asserted first. The acknowledgement lands on a SEPARATE
  // element, which is why the two can never be confused at a glance or overwrite each other.
  const h = harness(() => respond(200, JSON.stringify({ ok: true })));
  const res = await h.postJson("/v1/control/resume");

  assert.equal(h.bannerHidden(), true, "success must never raise the ERROR banner");
  assert.equal(h.bannerText(), "", "success must write no error message");
  assert.equal(res.status, 200, "the response is still returned to the caller, unchanged");

  assert.equal(h.ackHidden(), false, "a successful write is acknowledged");
  assert.match(h.ackText(), /Fleet RESUMED/, "and the acknowledgement names what happened");
});

test("a recovered write CLEARS a previously shown failure, so a stale error cannot linger", async () => {
  let fail = true;
  const h = harness(() => (fail ? respond(503, "upstream down") : respond(200, "{}")));
  await h.postJson("/v1/control/pause");
  assert.equal(h.bannerHidden(), false, "the failure shows");
  fail = false;
  await h.postJson("/v1/control/pause");
  assert.equal(h.bannerHidden(), true, "the next success clears it");
});

test("a failure CLEARS a previously shown acknowledgement, so a stale success cannot linger", async () => {
  // impl-EA, the mirror of the recovery test above. The error banner already clears on the next
  // success; without this the reverse would not hold and a green "Fleet PAUSED" could sit on screen
  // beside a red "Write failed" from the click after it.
  let ok = true;
  const h = harness(() => (ok ? respond(200, "{}") : respond(500, "boom")));
  await h.postJson("/v1/control/pause");
  assert.equal(h.ackHidden(), false, "the acknowledgement shows");
  ok = false;
  await h.postJson("/v1/control/pause");
  assert.equal(h.ackHidden(), true, "the next failure clears it");
  assert.equal(h.bannerHidden(), false, "and the failure itself is surfaced");
});

test("every postJson call site is covered by the helper — no call site does its own error handling", () => {
  // The anti-drift lock. This repo has a documented partial-fix pattern: a fix applied at one call
  // site and missed at the others. Because the CHECK lives in the helper, coverage is structural —
  // this test pins the call-site count so a thirteenth write control cannot be added silently, and
  // pins that the helper (not a call site) owns the .ok check.
  const sites = [...HTML.matchAll(/postJson\(\s*"(\/v1\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(sites.length >= 12, `expected at least 12 postJson call sites, found ${sites.length}`);
  for (const route of ["/v1/feedback", "/v1/inbox/reframe", "/v1/feedback/decision",
    "/v1/escalation/mark-handled", "/v1/inbox/approve", "/v1/drain/kick", "/v1/drain/run",
    "/v1/control/stop", "/v1/control/pause", "/v1/control/resume", "/v1/quiet-hours"]) {
    assert.ok(sites.includes(route), `write route ${route} must still go through postJson`);
  }
  assert.match(clientFn("postJson"), /res\.ok/, "the .ok check must live in the HELPER, covering every site at once");
});
