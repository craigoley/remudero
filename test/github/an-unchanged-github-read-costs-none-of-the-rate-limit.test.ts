// W1-T12839: the in-process GitHub client makes conditional reads. GitHub does not count a 304 Not
// Modified against the primary rate limit, and most of the fleet's polls are answered unchanged.
// Measured by the operator session on 2026-11-15: the App installation reached its write reserve six
// times that day, and gardener and review children were still refused by the rate limit.
// Each test points the client at a local server of its own and starts from an empty store.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { installGithubAppTokenHolder } from "#src/lib/github-credential.js";
import {
  configureGithubHttpRead, GITHUB_HTTP_READ_ENTRY_MAX_BYTES, GITHUB_HTTP_READ_STORE_MAX_BYTES, githubHttpRead,
  githubHttpReadStoredBytes, parseGhApiRead, resetGithubHttpReadStore,
} from "#src/lib/github-http-read.js";
import { ghJsonAsync, githubReadIdentity, type GhRateLimitReading } from "#src/lib/github-transport.js";
import { LoopBoundedChildTimeout } from "#src/lib/loop-bounded-child.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";

const TOKEN = "w1-t12839-fixture-token";
const ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "PATH", "HOME", "RMD_GH_CACHE_HOME", "GH_CONFIG_DIR", "GH_HOST"] as const;

interface Served { status: number; headers?: Record<string, string>; body?: string; destroy?: true; hang?: true; }
interface Seen { url: string; headers: IncomingHttpHeaders; }

function scene(t: TestContext, routes: Parameters<typeof ghShim>[0] = []): { root: string; shim: GhShim } {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12839-`));
  mkdirSync(join(root, "cache"));
  mkdirSync(join(root, "gh-config"));
  const shim = ghShim(routes);
  process.env.GH_TOKEN = TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_HOST;
  process.env.HOME = root;
  process.env.GH_CONFIG_DIR = join(root, "gh-config");
  process.env.RMD_GH_CACHE_HOME = join(root, "cache");
  process.env.PATH = `${shim.dir}:${saved.PATH ?? ""}`;
  resetGithubHttpReadStore();
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetGithubHttpReadStore();
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, shim };
}

/** A local stand-in for api.github.com. It does not point the client at itself; `use` does. */
async function apiServer(t: TestContext, respond: (seen: Seen) => Served): Promise<{ requests: Seen[]; origin: string; use(opts?: { storeMaxBytes?: number; entryMaxBytes?: number }): void }> {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    const seen = { url: req.url ?? "", headers: req.headers };
    requests.push(seen);
    const served = respond(seen);
    if (served.destroy) { req.socket.destroy(); return; }
    if (served.hang) return;
    res.writeHead(served.status, served.headers ?? {});
    res.end(served.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    configureGithubHttpRead(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const use = (opts: { storeMaxBytes?: number; entryMaxBytes?: number } = {}): void => configureGithubHttpRead({ origin, ...opts });
  use();
  return { requests, origin, use };
}

const rate = (remaining: number): Record<string, string> => ({
  "x-ratelimit-limit": "15000", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": "1800000000",
  "x-ratelimit-resource": "core", "x-ratelimit-used": String(15000 - remaining),
});

/** A server that answers each path with its current version, and 304 when the request names it. */
function versioned(versions: Map<string, number>, remaining: { n: number }): (seen: Seen) => Served {
  return (seen) => {
    const version = versions.get(seen.url) ?? 1;
    const etag = `"${seen.url}#${version}"`;
    remaining.n -= seen.headers["if-none-match"] === etag ? 0 : 1;
    if (seen.headers["if-none-match"] === etag) return { status: 304, headers: { etag, ...rate(remaining.n) } };
    return { status: 200, headers: { "content-type": "application/json; charset=utf-8", etag, ...rate(remaining.n) },
      body: JSON.stringify({ url: seen.url, version }) };
  };
}

test("W1-T12839 criterion 1: a GET answered with an ETag is repeated with If-None-Match, and its 304 returns the stored answer with the 304's own rate-limit reading", async (t) => {
  const { shim } = scene(t);
  const remaining = { n: 9000 };
  const versions = new Map<string, number>();
  const server = await apiServer(t, (seen) => {
    if (seen.headers["if-none-match"] !== undefined) return { status: 304, headers: { etag: String(seen.headers["if-none-match"]), ...rate(remaining.n -= 1) } };
    return versioned(versions, remaining)(seen);
  });

  const readings: GhRateLimitReading[] = [];
  const first = await ghJsonAsync(["api", "repos/o/r/pulls/1"], undefined, (reading) => readings.push(reading));
  const second = await ghJsonAsync(["api", "repos/o/r/pulls/1"], undefined, (reading) => readings.push(reading));

  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[0]!.headers["if-none-match"], undefined, "the first read has nothing to validate");
  assert.equal(server.requests[1]!.headers["if-none-match"], `"/repos/o/r/pulls/1#1"`, "the repeat sends the stored ETag");
  assert.deepEqual(second, first, "the caller parses the same body");
  assert.deepEqual(first, { url: "/repos/o/r/pulls/1", version: 1 });
  assert.deepEqual(readings.map((r) => r.remaining), [8999, 8998], "the 304's reading replaces the stored one");
  assert.deepEqual(shim.calls(), [], "no gh child process started");

  // The response itself: the stored status line, headers and body, with only the rate-limit headers fresh.
  const read = parseGhApiRead(["api", "repos/o/r/pulls/1", "-i"])!;
  const answer = await githubHttpRead(read, TOKEN, { identity: "fixture" });
  const repeat = await githubHttpRead(read, TOKEN, { identity: "fixture" });
  assert.equal(server.requests.at(-1)!.headers["if-none-match"], `"/repos/o/r/pulls/1#1"`);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.statusText, "OK");
  assert.equal(repeat.body, answer.body);
  const header = (r: typeof answer, name: string) => r.headers.find(([n]) => n === name)?.[1];
  assert.equal(header(repeat, "content-type"), "application/json; charset=utf-8", "a stored header the 304 did not carry");
  assert.equal(header(repeat, "etag"), `"/repos/o/r/pulls/1#1"`);
  assert.equal(Number(header(repeat, "x-ratelimit-remaining")), Number(header(answer, "x-ratelimit-remaining")) - 1);
  assert.equal(repeat.headers.filter(([n]) => n === "x-ratelimit-remaining").length, 1, "one reading, never two");

  // A read handed no identity stays unconditional, as before this task.
  await githubHttpRead(read, TOKEN);
  assert.equal(server.requests.at(-1)!.headers["if-none-match"], undefined);
});

test("W1-T12839 criterion 2: a stored answer never crosses identities, hosts, paths or queries, and an App installation keeps its answers across a token rotation", async (t) => {
  const { root } = scene(t);
  const remaining = { n: 9000 };
  const versions = new Map<string, number>();
  const server = await apiServer(t, versioned(versions, remaining));
  const conditional = () => server.requests.at(-1)!.headers["if-none-match"] !== undefined;

  // The identity: an App reference is its installation, whatever token it holds this hour.
  const app1 = { source: "remudero-reference" as const, referenceKey: JSON.stringify(["*", "fleet", "1", "101", "/k.pem"]) };
  const app2 = { source: "remudero-reference" as const, referenceKey: JSON.stringify(["*", "fleet", "1", "202", "/k.pem"]) };
  assert.equal(githubReadIdentity(app1, "ghs_hour1"), githubReadIdentity(app1, "ghs_hour2"));
  assert.notEqual(githubReadIdentity(app1, "ghs_hour1"), githubReadIdentity(app2, "ghs_hour1"));
  // Any other source names no identity but its token: two tokens never share, and the text never appears.
  const ambient = { source: "ambient-env" as const };
  assert.notEqual(githubReadIdentity(ambient, "ghp_alice"), githubReadIdentity(ambient, "ghp_bob"));
  assert.notEqual(githubReadIdentity(ambient, "ghp_alice"), githubReadIdentity({ source: "repo-reference" }, "ghp_alice"));
  for (const id of [githubReadIdentity(ambient, "ghp_alice"), githubReadIdentity(app1, "ghs_hour1")]) {
    assert.ok(!id.includes("ghp_alice") && !id.includes("ghs_hour1"), `${id} carries no token text`);
  }

  // Through the transport: the ambient token is the identity, so another token's read is unconditional.
  await ghJsonAsync(["api", "repos/o/r/pulls/2"]);
  await ghJsonAsync(["api", "repos/o/r/pulls/2"]);
  assert.equal(conditional(), true, "the same token revalidates");
  process.env.GH_TOKEN = "w1-t12839-another-login";
  await ghJsonAsync(["api", "repos/o/r/pulls/2"]);
  assert.equal(conditional(), false, "another login never receives the first login's answer");
  assert.equal(server.requests.at(-1)!.headers.authorization, "token w1-t12839-another-login");

  // The path and the query are the request: neither shares an entry with another.
  process.env.GH_TOKEN = TOKEN;
  await ghJsonAsync(["api", "repos/o/r/pulls/2?per_page=1"]);
  assert.equal(conditional(), false, "another query is another request");
  await ghJsonAsync(["api", "repos/o/r/pulls/20"]);
  assert.equal(conditional(), false, "another path is another request");
  await ghJsonAsync(["api", "repos/o/r/pulls/2?per_page=1"]);
  assert.equal(conditional(), true);

  // The host: the same identity and path on another origin is another request.
  const other = await apiServer(t, versioned(new Map(), { n: 9000 }));
  await ghJsonAsync(["api", "repos/o/r/pulls/2"]);
  assert.equal(other.requests.at(-1)!.headers["if-none-match"], undefined, "another host never receives this host's answer");
  server.use();
  await ghJsonAsync(["api", "repos/o/r/pulls/2"]);
  assert.equal(conditional(), true, "each host keeps its own entry");

  // App references: the token rotates and the installation keeps its entries; another installation does not.
  const hour = { token: "ghs_w1_t12839_hour1" };
  installGithubAppTokenHolder(() => ({ token: hour.token, expiresAtMs: Date.now() + 3_600_000 }));
  t.after(() => installGithubAppTokenHolder(undefined));
  const references = (installation: string) => writeFileSync(join(root, "Remudero", "state", "github-credential-references.json"),
    JSON.stringify({ references: [{ scope: "*", kind: "app", name: "fleet", app_id: "1", installation_id: installation, private_key_path: "/k.pem" }] }));
  mkdirSync(join(root, "Remudero", "state"), { recursive: true });
  references("101");
  await ghJsonAsync(["api", "repos/o/r/pulls/3"]);
  assert.equal(server.requests.at(-1)!.headers.authorization, "token ghs_w1_t12839_hour1");
  hour.token = "ghs_w1_t12839_hour2";
  await ghJsonAsync(["api", "repos/o/r/pulls/3"]);
  assert.equal(server.requests.at(-1)!.headers.authorization, "token ghs_w1_t12839_hour2");
  assert.equal(conditional(), true, "a rotated token of the same installation revalidates");
  references("202");
  await ghJsonAsync(["api", "repos/o/r/pulls/3"]);
  assert.equal(conditional(), false, "another installation never receives the first installation's answer");
});

test("W1-T12839 criterion 3: the store is bounded in bytes with least-recently-used eviction, and an answer over the per-entry bound is not stored", async (t) => {
  scene(t);
  assert.ok(GITHUB_HTTP_READ_STORE_MAX_BYTES > GITHUB_HTTP_READ_ENTRY_MAX_BYTES && GITHUB_HTTP_READ_ENTRY_MAX_BYTES > 0);
  const remaining = { n: 9000 };
  const server = await apiServer(t, versioned(new Map(), remaining));
  const read = (n: number) => githubHttpRead(parseGhApiRead(["api", `repos/o/r/pulls/${100 + n}`])!, TOKEN, { identity: "fixture" });
  const conditional = () => server.requests.at(-1)!.headers["if-none-match"] !== undefined;

  await read(1);
  const one = githubHttpReadStoredBytes();
  assert.ok(one > 0, "a 200 with an ETag is stored");
  // Room for two entries of this size, not three.
  server.use({ storeMaxBytes: one * 2 + Math.floor(one / 2) });
  await read(2);
  assert.equal(githubHttpReadStoredBytes(), one * 2);
  await read(1);
  assert.equal(conditional(), true, "entry 1 is used again, so entry 2 is now the least recently used");
  await read(3);
  assert.ok(githubHttpReadStoredBytes() <= one * 2 + Math.floor(one / 2), "the store stays within its bound");
  await read(2);
  assert.equal(conditional(), false, "the least recently used entry was evicted");
  await read(3);
  assert.equal(conditional(), true, "the newest entry was kept");

  // An answer over the per-entry bound is not stored, and the store holds what it held.
  resetGithubHttpReadStore();
  server.use({ entryMaxBytes: one - 1 });
  await read(4);
  assert.equal(githubHttpReadStoredBytes(), 0);
  await read(4);
  assert.equal(conditional(), false, "an answer too large to store is read in full again");
});

test("W1-T12839 criterion 4: a 200 replaces the entry, any other status drops it, and an errored or timed-out request never serves a stored answer", async (t) => {
  scene(t);
  const remaining = { n: 9000 };
  const versions = new Map<string, number>();
  let next: Served | undefined;
  const server = await apiServer(t, (seen) => {
    const once = next;
    next = undefined;
    return once ?? versioned(versions, remaining)(seen);
  });
  const read = parseGhApiRead(["api", "repos/o/r/pulls/5"])!;
  const get = (timeoutMs?: number) => githubHttpRead(read, TOKEN, { identity: "fixture", ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const sent = () => server.requests.at(-1)!.headers["if-none-match"];

  // A 200 replaces the entry: the next read validates the new version and is answered with its body.
  await get();
  versions.set("/repos/o/r/pulls/5", 2);
  assert.equal(JSON.parse((await get()).body).version, 2);
  assert.equal(sent(), `"/repos/o/r/pulls/5#1"`);
  const revalidated = await get();
  assert.equal(sent(), `"/repos/o/r/pulls/5#2"`);
  assert.equal(revalidated.status, 200);
  assert.equal(JSON.parse(revalidated.body).version, 2);

  // Any other status drops it: a 500 is returned as the 500, and the next read is unconditional.
  for (const status of [500, 404, 202]) {
    await get();
    next = { status, headers: rate(remaining.n), body: JSON.stringify({ message: `status ${status}` }) };
    const answer = await get();
    assert.equal(answer.status, status, `a ${status} is the caller's answer, never the stored 200`);
    assert.equal(JSON.parse(answer.body).message, `status ${status}`);
    await get();
    assert.equal(sent(), undefined, `a ${status} dropped the entry`);
  }

  // A failed send rejects, never resolving with the stored answer, and drops the entry.
  await get();
  next = { status: 0, destroy: true };
  await assert.rejects(get(), (err: { stderr?: string }) => /in-process read failed to reach GitHub/.test(err.stderr ?? ""));
  await get();
  assert.equal(sent(), undefined, "a failed send dropped the entry");

  // A timed-out request rejects with the timeout, never with the stored answer, and drops the entry.
  await get();
  next = { status: 0, hang: true };
  await assert.rejects(get(50), LoopBoundedChildTimeout);
  await get();
  assert.equal(sent(), undefined, "a timeout dropped the entry");

  // A 304 the store did not ask for is not an answer to serve.
  resetGithubHttpReadStore();
  next = { status: 304, headers: rate(remaining.n) };
  assert.equal((await get()).status, 304);

  // A 200 with no ETag has nothing to validate, so it stores nothing.
  next = { status: 200, headers: rate(remaining.n), body: "{}" };
  await get();
  assert.equal(githubHttpReadStoredBytes(), 0);
  await get();
  assert.equal(sent(), undefined);
});

test("W1-T12839 criterion 5: argument forms the client does not parse still spawn the gh CLI with no conditional header, even for a path the store holds", async (t) => {
  const { shim } = scene(t, [{ when: "", stdout: JSON.stringify({ spawned: true }) }]);
  const server = await apiServer(t, versioned(new Map(), { n: 9000 }));
  await ghJsonAsync(["api", "repos/o/r/pulls"]);
  await ghJsonAsync(["api", "repos/o/r/pulls"]);
  assert.equal(server.requests.at(-1)!.headers["if-none-match"], `"/repos/o/r/pulls#1"`, "the store holds this path");
  const forms = [
    ["api", "--paginate", "--slurp", "repos/o/r/pulls"],
    ["api", "repos/o/r/pulls", "--jq", ".[0]"],
    ["api", "--slurp", "repos/o/r/pulls"],
    ["api", "-H", "Accept: application/vnd.github.raw", "repos/o/r/pulls"],
    ["api", "graphql", "-f", "query={viewer{login}}"],
  ];
  for (const form of forms) {
    assert.deepEqual(await ghJsonAsync(form), { spawned: true }, `${form.join(" ")} spawns gh`);
    assert.equal(shim.calls().at(-1), form.join(" "), "gh receives the argv it always received");
    assert.doesNotMatch(shim.calls().at(-1)!, /if-none-match/i, "no conditional header rides a spawned form");
  }
  assert.equal(shim.calls().length, forms.length);
  assert.equal(server.requests.length, 2, "the client sent none of them");
});
