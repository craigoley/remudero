// test/api-client-base-url.test.ts — CodeQL js/client-side-request-forgery, alerts #32/#33/#52/#54.
//
// THE BUG, end to end. All four alerts point at the four `fetchImpl` call sites in
// packages/api-client/src/client.ts, but they share ONE taint source and it is not in that file:
//
//   apps/dashboard/src/main.ts   readConfig()  ->  baseUrl: params.get("daemon")
//                                                  token:   params.get("token")
//   packages/api-client/.../client.ts          ->  fetch(`${baseUrl}${path}`,
//                                                        { headers: authHeaders(token) })
//
// `?daemon=` is chosen by whoever wrote the link. `?token=` sits next to it. So a link shaped
// `?daemon=https://evil.example&token=<the operator's write token>` sent an authenticated request,
// bearer header included, to a host of the attacker's choosing. This is credential exfiltration by
// query parameter, not a lint nit.
//
// TWO LAYERS, because either alone is insufficient:
//   1. the CLIENT validates the base URL's shape and pins an origin every request must stay inside.
//      Necessary, NOT sufficient — `https://evil.example` is a well-formed https URL.
//   2. the DASHBOARD allow-lists which hosts a `?daemon=` may name at all. This is the layer that
//      actually stops the attack; layer 1 is what stops it being reintroduced somewhere else.
//
// Both layers are asserted here, in that order, so neither can be removed while the other passes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDaemonClient, requestUrl } from "../packages/api-client/src/client.js";
import { applyDaemonRejection, DEFAULT_DAEMON_URL, isAllowedDaemonUrl, readConfig, wireControls } from "../apps/dashboard/src/main.js";

/** A fetch stand-in that records the URL it was asked for and never touches the network. */
function recordingFetch(): { calls: string[]; impl: typeof fetch } {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    calls.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => ({ tasks: [] }),
      clone() {
        return this;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

// ── LAYER 1: the client validates its base URL and pins the origin ───────────────────

test("createDaemonClient refuses a baseUrl whose protocol is not http or https", () => {
  // `javascript:` and `data:` PARSE as URLs — `new URL("javascript:alert(1)")` succeeds — so a
  // bare try/catch around the parse is not a filter. These are script-execution vectors that
  // happen to be URL-shaped, and a client that fetches them is a client that can be made to run
  // attacker script with a bearer token in scope.
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>x</script>", "file:///etc/passwd"]) {
    assert.throws(
      () => createDaemonClient({ baseUrl: bad, token: "t" }),
      /protocol .* is not allowed/,
      `must refuse ${bad}`,
    );
  }
});

test("createDaemonClient refuses a baseUrl that is not an absolute URL at all", () => {
  for (const bad of ["", "not a url", "/v1/status", "//evil.example"]) {
    assert.throws(
      () => createDaemonClient({ baseUrl: bad, token: "t" }),
      /not a valid absolute URL/,
      `must refuse ${JSON.stringify(bad)}`,
    );
  }
});

test("createDaemonClient refuses BEFORE any request is issued, so no token is ever transmitted", async () => {
  // The ordering is the point: validation at construction means a rejected baseUrl never reaches
  // the network layer, so the bearer token cannot leak on the way to discovering the problem.
  const { calls, impl } = recordingFetch();
  assert.throws(() => createDaemonClient({ baseUrl: "javascript:x", token: "SECRET", fetchImpl: impl }));
  assert.deepEqual(calls, [], "no request was issued");
});

test("every client method requests the pinned origin and nothing else", async () => {
  const { calls, impl } = recordingFetch();
  const client = createDaemonClient({ baseUrl: "https://daemon.example.ts.net/", token: "t", fetchImpl: impl });

  await client.getStatus();
  await client.pauseFleet("why");
  await client.listFeedback("new");
  await client.getTrace("fb-1");

  assert.equal(calls.length, 4, `four requests; saw ${JSON.stringify(calls)}`);
  for (const c of calls) {
    assert.equal(new URL(c).origin, "https://daemon.example.ts.net", `${c} stayed on the pinned origin`);
  }
  // The query helper still percent-encodes its values onto the pinned origin rather than being
  // bypassed by the hardening.
  assert.ok(
    calls.some((c) => c.includes("/v1/trace?id=fb-1")),
    `getTrace kept its query; saw ${JSON.stringify(calls)}`,
  );
});

test("a trailing slash on baseUrl does not double up or change the requested path", async () => {
  // The old code stripped trailing slashes by regex before concatenating. The two-argument
  // `new URL(path, base)` form supersedes that; this pins the observable behaviour so the removal
  // of that regex cannot silently change what is requested.
  for (const b of ["http://127.0.0.1:4317", "http://127.0.0.1:4317/", "http://127.0.0.1:4317///"]) {
    const { calls, impl } = recordingFetch();
    await createDaemonClient({ baseUrl: b, token: "t", fetchImpl: impl }).getStatus();
    assert.equal(calls[0], "http://127.0.0.1:4317/v1/status", `baseUrl ${JSON.stringify(b)}`);
  }
});

// ── LAYER 2: the dashboard allow-lists which hosts a ?daemon= may name ───────────────

test("a hostile daemon parameter is refused and the default is used instead", () => {
  const cfg = readConfig("?daemon=https://evil.example&token=SECRET", "https://console.example.ts.net");

  assert.equal(cfg.baseUrl, DEFAULT_DAEMON_URL, "the attacker's host is NOT used");
  assert.equal(cfg.rejectedDaemon, "https://evil.example", "and the refusal is reported, not silent");
  // The token is still read — the operator's own token is not the thing being rejected, the
  // destination is. Refusing to carry it forward would break the legitimate fallback.
  assert.equal(cfg.token, "SECRET");
});

test("the allow-list matches on the parsed hostname, so a lookalike host cannot slip through", () => {
  const origin = "https://console.example.ts.net";

  // Admissible: the page's own origin, loopback, and real tailnet names.
  assert.equal(isAllowedDaemonUrl("https://console.example.ts.net", origin), true);
  assert.equal(isAllowedDaemonUrl("http://localhost:4317", origin), true);
  assert.equal(isAllowedDaemonUrl("http://127.0.0.1:4317", origin), true);
  assert.equal(isAllowedDaemonUrl("https://daemon.example.ts.net", origin), true);

  // Refused. Each of these defeats a WEAKER check that a careless implementation might use:
  //   substring test on the raw URL   -> beaten by the query-string and fragment cases
  //   endsWith on the raw URL         -> beaten by the path case
  //   endsWith("ts.net") on hostname  -> beaten by the hyphenated lookalike
  assert.equal(isAllowedDaemonUrl("https://evil.example/?x=.ts.net", origin), false, "query-string decoy");
  assert.equal(isAllowedDaemonUrl("https://evil.example#localhost", origin), false, "fragment decoy");
  assert.equal(isAllowedDaemonUrl("https://evil.example/localhost", origin), false, "path decoy");
  assert.equal(isAllowedDaemonUrl("https://nottailscale-ts.net", origin), false, "hyphenated lookalike");
  assert.equal(isAllowedDaemonUrl("https://ts.net.evil.example", origin), false, "prefix lookalike");
  assert.equal(isAllowedDaemonUrl("https://localhost.evil.example", origin), false, "loopback lookalike");
  assert.equal(isAllowedDaemonUrl("javascript:alert(1)", origin), false, "not a transport");
  assert.equal(isAllowedDaemonUrl("garbage", origin), false, "unparseable");
});

test("an absent daemon parameter still yields the documented local default", () => {
  const cfg = readConfig("?token=t", "https://console.example.ts.net");
  assert.equal(cfg.baseUrl, DEFAULT_DAEMON_URL);
  assert.equal(cfg.rejectedDaemon, undefined, "nothing was rejected, so nothing is reported");
});

test("an allowed daemon parameter is honoured unchanged", () => {
  const cfg = readConfig("?daemon=https://daemon.example.ts.net&token=t", "https://console.example.ts.net");
  assert.equal(cfg.baseUrl, "https://daemon.example.ts.net");
  assert.equal(cfg.rejectedDaemon, undefined);
});


test("requestUrl refuses a path that escapes the pinned origin", () => {
  // The belt-and-braces arm. Today every call site passes a hardcoded literal so this cannot fire
  // in production — it exists so it still cannot fire the day someone adds a method taking a path
  // fragment from a caller. Both escapes below are real: a protocol-relative `//host` resolves to
  // a DIFFERENT host entirely, and enough `../` walks out of any path prefix.
  const base = new URL("https://daemon.example.ts.net/");

  assert.throws(() => requestUrl(base, "//evil.example/v1/status"), /refusing to request https:\/\/evil\.example/);
  assert.throws(() => requestUrl(base, "https://evil.example/v1/status"), /outside the client's base origin/);

  // ...and an ordinary path, including one with traversal that stays inside, still resolves.
  assert.equal(requestUrl(base, "/v1/status").toString(), "https://daemon.example.ts.net/v1/status");
  assert.equal(requestUrl(base, "/v1/../v1/status").toString(), "https://daemon.example.ts.net/v1/status");
});

test("applyDaemonRejection names the refused host and warns the token may be compromised", () => {
  // A minimal Document stand-in — the same no-DOM idiom test/dashboard-main.test.ts already uses.
  const banner = { textContent: "" };
  const doc = { getElementById: (id: string) => (id === "controls-status" ? banner : null) } as unknown as Document;

  applyDaemonRejection(doc, { rejectedDaemon: "https://evil.example" });
  assert.match(banner.textContent, /Refused the \?daemon= in this link \(https:\/\/evil\.example\)/);
  assert.match(banner.textContent, /Using http:\/\/localhost:4317/, "it says what it used instead");
  assert.match(banner.textContent, /treat the token in it as compromised/, "it names the real consequence");
});

test("applyDaemonRejection stays silent when nothing was refused", () => {
  const banner = { textContent: "" };
  const doc = { getElementById: () => banner } as unknown as Document;
  applyDaemonRejection(doc, {});
  assert.equal(banner.textContent, "", "an ordinary load shows no warning");
});


test("wireControls raises the refusal on the page it is wiring", () => {
  // wireControls is where the warning is raised, because the `typeof document` entry block cannot
  // be entered by any test. A uniform element stub satisfies every requiredEl lookup; the assertion
  // is that #controls-status carries the refusal by the time wiring returns.
  const banner = { textContent: "" };
  const el = () => ({ textContent: "", value: "", checked: false, addEventListener() {} });
  const els = new Map<string, unknown>();
  const doc = {
    getElementById: (id: string) => {
      if (id === "controls-status") return banner;
      if (!els.has(id)) els.set(id, el());
      return els.get(id);
    },
  } as unknown as Document;
  const search = "?daemon=https://evil.example&token=SECRET";
  const saved = globalThis.window;
  (globalThis as { window?: unknown }).window = { location: { search, origin: "https://console.example.ts.net" } };
  try {
    wireControls(doc, {} as never);
    assert.match(banner.textContent, /Refused the \?daemon=/);
    assert.match(banner.textContent, /treat the token in it as compromised/);
  } finally {
    if (saved === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = saved;
  }
});

// ── the two layers compose: a refused host never becomes a request ───────────────────

test("the refused daemon host is never contacted even though a client is still constructed", async () => {
  const cfg = readConfig("?daemon=https://evil.example&token=SECRET", "https://console.example.ts.net");
  const { calls, impl } = recordingFetch();
  await createDaemonClient({ ...cfg, fetchImpl: impl }).getStatus();

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).origin, "http://localhost:4317", "the default, not the attacker's host");
  assert.ok(!calls[0].includes("evil.example"), "the attacker's host appears in no request");
});
