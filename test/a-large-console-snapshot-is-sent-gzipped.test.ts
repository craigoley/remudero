/**
 * W1-T13290: GET /v1/inbox sent 9,185,361 bytes of uncompressed JSON through the tunnel on 2026-11-17 (1,039,748
 * gzipped). A large cached 200 body is now gzipped in zlib's thread pool for a client that accepts gzip.
 */
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import zlib from "node:zlib";
import { syncBuiltinESMExports } from "node:module";
import { CONSOLE_GZIP_MIN_BYTES, writeBufferedResponse, type ConsoleResponseStaleness } from "#src/lib/console-snapshot-cache.js";

const staleness: ConsoleResponseStaleness = { status: "fresh", stale: false, ageMs: 0, generatedAt: "2026-11-17T00:40:00.000Z", refreshing: false, budgetMs: 5000 };
const large = JSON.stringify({ items: Array.from({ length: 4000 }, (_, i) => ({ id: `proposal-${i}`, reasons: "x".repeat(40) })) });
const small = JSON.stringify({ items: [{ id: "one" }] });

async function fetchRaw(t: { after: (fn: () => void) => void }, body: string, headers: Record<string, string>, etag = 'W/"e1"'): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer; plain: string }> {
  const server = createServer((req, res) => writeBufferedResponse(req, res, { status: 200, headers: { "content-type": "text/plain" }, body, generatedAtMs: 0, etag } as never, staleness));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  return await new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/v1/inbox", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode!, headers: res.headers, bytes, plain: res.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(bytes).toString("utf8") : bytes.toString("utf8") });
      });
    }).on("error", reject).end();
  });
}

test("W1-T13290 criterion 1: a large body to a gzip client is sent gzipped and unzips to the plain body", async (t) => {
  assert.ok(Buffer.byteLength(large) >= CONSOLE_GZIP_MIN_BYTES, "positive control: the fixture is large");
  const plain = await fetchRaw(t, large, {});
  const zipped = await fetchRaw(t, large, { "accept-encoding": "gzip, deflate, br" });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(zipped.headers["content-encoding"], "gzip");
  assert.equal(zipped.headers.vary, "accept-encoding");
  assert.equal(zipped.plain, plain.plain, "the same bytes once unzipped");
  assert.ok(zipped.bytes.length < plain.bytes.length / 5, `${zipped.bytes.length} compressed against ${plain.bytes.length}`);
});

test("W1-T13290 criterion 2: compression goes through async gzip, not gzipSync", async (t) => {
  const original = zlib.gzipSync;
  (zlib as { gzipSync: unknown }).gzipSync = () => { throw new Error("gzipSync must not run on the request thread"); };
  syncBuiltinESMExports();
  try {
    const zipped = await fetchRaw(t, large, { "accept-encoding": "gzip" });
    assert.equal(zipped.headers["content-encoding"], "gzip");
  } finally {
    (zlib as { gzipSync: unknown }).gzipSync = original;
    syncBuiltinESMExports();
  }
});

test("W1-T13290 criterion 3: a small body, a client without gzip, and a 304 are answered as before", async (t) => {
  assert.equal((await fetchRaw(t, small, { "accept-encoding": "gzip" })).headers["content-encoding"], undefined, "small body stays plain");
  assert.equal((await fetchRaw(t, large, { "accept-encoding": "identity" })).headers["content-encoding"], undefined, "no gzip accepted");
  const notModified = await fetchRaw(t, large, { "accept-encoding": "gzip", "if-none-match": 'W/"e1"' });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.bytes.length, 0);
});
