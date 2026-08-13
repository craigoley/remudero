import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createService, type IdentityProvider, type Route } from "../src/lib/service.js";

// ── W1-T404 acceptance 3: "a reversible-but-disruptive route is refused the low grant and
// accepted by the middle one, so the third tier is distinguishable from both poles" ──
//
// The ordinary bearer write token IS "the low grant" (design v: it resolves to tier `low`) --
// reused directly rather than faked, so this suite doubles as independent evidence for
// acceptance 7. "The middle one" is a SYNTHETIC grantor attached through the W1-T430 provider
// seam (`ServiceOptions.providers`, the same mechanism test/identity-provider-seam.test.ts
// proves admits a third grantor without editing service.ts's dispatch) -- proving the ORDERING
// comparison (`writeTierSatisfies`) is real and general, not hand-coded for one credential.

const READ_TOKEN = "middle-tier-read-token";
const WRITE_TOKEN = "middle-tier-write-token"; // the low grant.
const MIDDLE_HEADER = "x-middle-grant";
const MIDDLE_SECRET = "middle-grant-secret";

const middleGrantProvider: IdentityProvider = {
  name: "test-middle-provider",
  grant: (req) => (req.headers[MIDDLE_HEADER] === MIDDLE_SECRET ? new Set(["read", "write"] as const) : undefined),
  writeTier: "middle",
};

function buildMiddleTierRoute(): Route {
  return {
    method: "POST",
    path: "/v1/middle",
    scope: "write",
    tier: "middle",
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  };
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createService({
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    routes: [buildMiddleTierRoute()],
    enforceWriteTiers: true,
    providers: [middleGrantProvider],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("MIDDLE-tier route: the low grant (ordinary write token) is refused", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/middle`, { method: "POST", headers: { authorization: `Bearer ${WRITE_TOKEN}` } });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { required_tier: string };
    assert.equal(body.required_tier, "middle");
  });
});

test("MIDDLE-tier route: the middle grant is accepted -- distinguishable from the low pole", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/middle`, { method: "POST", headers: { [MIDDLE_HEADER]: MIDDLE_SECRET } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
