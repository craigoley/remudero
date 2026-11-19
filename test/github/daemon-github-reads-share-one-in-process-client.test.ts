// W1-T12531: the daemon's `gh api <path>` reads go through one shared in-process client, not one `gh`
// process per call. Measured by the operator session on the Azure host, 2026-11-13: 5-7 gh processes
// at once, about 2 cores between them. Each test points the client at a local server of its own, and a
// recording `gh` stub on PATH says whether a child process started.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createSocketServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ghBrokerDir } from "#src/lib/gh-read-broker-client.js";
import { GithubCredentialMissingError } from "#src/lib/github-credential.js";
import {
  configureGithubHttpRead, ghApiServerError, githubHttpRead, ghIncludeHeaderBlock, ghStdoutOfHttpRead, parseGhApiRead,
} from "#src/lib/github-http-read.js";
import { ghJsonAsync, parseGhRateLimitHeaders, splitGhHeaderBlock, type GhRateLimitReading } from "#src/lib/github-transport.js";
import { LIVE_WRITE_SENTINEL_TOKEN, LiveWriteBlockedError } from "#src/lib/live-write-guard.js";
import { LoopBoundedChildTimeout } from "#src/lib/loop-bounded-child.js";
import { MAX_UNIX_SOCKET_PATH_BYTES, shortPathWhenTooLong } from "#src/lib/short-path-root.js";
import { classifyGhFailure, isGhRateLimitError } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";

const TOKEN = "w1-t12531-fixture-token";
const ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "PATH", "HOME", "RMD_GH_CACHE_HOME", "GH_CONFIG_DIR", "GH_HOST", "RMD_W1_T12531_REF"] as const;

interface Served { status: number; headers?: Record<string, string>; body: string; }
interface Seen { method: string; url: string; headers: IncomingHttpHeaders; }

/** This process's GitHub environment for one test: a fixture token, its own HOME, read cache and recording `gh`. */
function scene(t: TestContext, routes: Parameters<typeof ghShim>[0] = []): { root: string; cache: string; shim: GhShim } {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const prefix = `${RMD_TMP_PREFIX}w1-t12531-`;
  // W1-T13212 criterion 2: include mkdtemp's suffix and the full socket path when choosing a root.
  const path = shortPathWhenTooLong(join(tmpdir(), prefix), (tempRoot) => join(tempRoot, prefix),
    (candidate) => Buffer.byteLength(join(`${candidate}XXXXXX`, "cache", "remudero", "gh-broker", "broker.sock")) <= MAX_UNIX_SOCKET_PATH_BYTES,
    existsSync);
  const root = mkdtempSync(path);
  const cache = join(root, "cache");
  mkdirSync(cache);
  mkdirSync(join(root, "gh-config"));
  const shim = ghShim(routes);
  process.env.GH_TOKEN = TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_HOST;
  process.env.HOME = root;
  process.env.GH_CONFIG_DIR = join(root, "gh-config");
  process.env.RMD_GH_CACHE_HOME = cache;
  process.env.PATH = `${shim.dir}:${saved.PATH ?? ""}`;
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cache, shim };
}

/** A local stand-in for api.github.com, with the client pointed at it until the test ends. */
async function apiServer(t: TestContext, respond: (seen: Seen) => Served | Promise<Served>): Promise<{ requests: Seen[]; connections(): number; origin: string }> {
  const requests: Seen[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    const seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers };
    requests.push(seen);
    void Promise.resolve(respond(seen)).then((served) => {
      res.writeHead(served.status, served.headers ?? {});
      res.end(served.body);
    });
  });
  server.on("connection", () => { connections += 1; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  configureGithubHttpRead({ origin });
  t.after(async () => {
    configureGithubHttpRead(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests, connections: () => connections, origin };
}

const RATE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "4321",
  "x-ratelimit-reset": "1800000000",
  "x-ratelimit-resource": "core",
  "x-ratelimit-used": "679",
};

/** What `gh api -i` prints for a response: Go's status line, sorted canonical headers, a blank line, the body. */
function ghPrinted(status: string, headers: Record<string, string>, body: string): string {
  const canonical = (name: string): string => name.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("-");
  const lines = Object.entries(headers).map(([name, value]) => `${canonical(name)}: ${value}`).sort();
  return `HTTP/2.0 ${status}\r\n${lines.map((line) => `${line}\r\n`).join("")}\r\n${body}`;
}

test("W1-T12531 criterion 1: an api read through ghJsonAsync is answered by the shared in-process client, keeps its connection alive, starts no child, and returns gh's body and rate-limit reading", async (t) => {
  const { shim } = scene(t);
  const server = await apiServer(t, (seen) => ({ status: 200, headers: RATE_HEADERS, body: JSON.stringify({ url: seen.url }) }));

  const readings: GhRateLimitReading[] = [];
  const first = await ghJsonAsync(["api", "repos/o/r/pulls/7"], undefined, (reading) => readings.push(reading));
  const second = await ghJsonAsync(["api", "-i", "/repos/o/r/pulls/8"]);

  assert.deepEqual(first, { url: "/repos/o/r/pulls/7" });
  assert.deepEqual(second, { url: "/repos/o/r/pulls/8" }, "a leading slash and an explicit -i read the same endpoint");
  assert.deepEqual(shim.calls(), [], "no gh child process started");
  assert.equal(server.requests.length, 2);
  for (const seen of server.requests) {
    assert.equal(seen.method, "GET");
    assert.equal(seen.headers.authorization, `token ${TOKEN}`);
    assert.equal(seen.headers.accept, "application/vnd.github+json");
    assert.equal(seen.headers["user-agent"], "remudero");
  }
  // fetch's shared pool may open a second socket while the first is being released; both are kept and reused.
  for (const n of [9, 10, 11, 12]) await ghJsonAsync(["api", `repos/o/r/pulls/${n}`]);
  assert.equal(server.requests.length, 6);
  assert.ok(server.connections() < server.requests.length,
    `later reads ride kept-alive connections (${server.connections()} connections for ${server.requests.length} reads)`);

  // The gh path, given the same response as gh prints it, returns the same body and the same reading.
  const ghReadings: GhRateLimitReading[] = [];
  const ghBody = await ghJsonAsync(["api", "repos/o/r/pulls/7"],
    async () => ({ stdout: ghPrinted("200 OK", RATE_HEADERS, JSON.stringify({ url: "/repos/o/r/pulls/7" })), stderr: "" }),
    (reading) => ghReadings.push(reading));
  assert.deepEqual(first, ghBody);
  assert.deepEqual(readings, ghReadings);
  assert.deepEqual(readings, [{ remaining: 4321, used: 679, limit: 5000, reset: 1800000000, resource: "core" }]);
});

test("W1-T12531 criterion 2: without a broker the cadence step runs before the request, and concurrent identical reads share one request", async (t) => {
  const { cache, shim } = scene(t);
  const stampedBeforeRequest: boolean[] = [];
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = await apiServer(t, async () => {
    const dir = join(cache, "remudero");
    stampedBeforeRequest.push(readdirSync(dir, { withFileTypes: true }).some((e) => e.name.startsWith("gh-last-read")));
    await held;
    return { status: 200, headers: RATE_HEADERS, body: JSON.stringify({ shared: true }) };
  });

  // Coalescing and the cadence: two identical reads in flight together send one request, after the stamp.
  const a = ghJsonAsync(["api", "repos/o/r/pulls/21"]);
  const b = ghJsonAsync(["api", "repos/o/r/pulls/21"]);
  for (let i = 0; i < 200 && server.requests.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  release!();
  assert.deepEqual(await a, { shared: true });
  assert.deepEqual(await b, { shared: true });
  assert.equal(server.requests.length, 1, "concurrent identical reads share one request");
  assert.deepEqual(stampedBeforeRequest, [true], "applyGhReadCadenceAsync stamped the shared read window before the request");
  assert.deepEqual(shim.calls(), []);
});

test("W1-T12531 criterion 2: with a live read broker the broker answers and no HTTP request is sent", async (t) => {
  const { cache, shim } = scene(t);
  const server = await apiServer(t, () => ({ status: 200, headers: RATE_HEADERS, body: JSON.stringify({ from: "client" }) }));
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cache })!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "heartbeat"), "60\n");
  const clients = new Set<Socket>();
  const broker = createSocketServer((conn) => {
    clients.add(conn);
    let text = "";
    conn.on("data", (bytes) => {
      text += bytes.toString();
      if (!text.includes("\n")) return;
      conn.end(JSON.stringify({ type: "result", stdout: JSON.stringify({ from: "broker" }), stderr: "", exitCode: 0, outcome: "upstream-200" }) + "\n");
    });
  });
  await new Promise<void>((resolve) => broker.listen(join(dir, "broker.sock"), resolve));
  t.after(async () => {
    for (const conn of clients) conn.destroy();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });
  assert.deepEqual(await ghJsonAsync(["api", "repos/o/r/pulls/22"]), { from: "broker" });
  assert.equal(server.requests.length, 0, "with a live broker no HTTP request is sent");
  assert.deepEqual(shim.calls(), []);
});

test("W1-T12531 criterion 3: the token comes from resolveGithubCredential, a read with no credential throws before any request, and the sentinel token is refused", async (t) => {
  const { root, shim } = scene(t);
  const server = await apiServer(t, () => ({ status: 200, headers: RATE_HEADERS, body: "{}" }));

  // A remudero-wide reference outranks the ambient GH_TOKEN in the resolver, so the client sends its token.
  mkdirSync(join(root, "Remudero", "state"), { recursive: true });
  writeFileSync(join(root, "Remudero", "state", "github-credential-references.json"),
    JSON.stringify({ references: [{ scope: "*", kind: "env", name: "RMD_W1_T12531_REF" }] }));
  process.env.RMD_W1_T12531_REF = "w1-t12531-reference-token";
  await ghJsonAsync(["api", "repos/o/r/pulls/31"]);
  assert.equal(server.requests[0]?.headers.authorization, "token w1-t12531-reference-token");
  rmSync(join(root, "Remudero"), { recursive: true, force: true });

  // No source answers: no token, no stored login, and no gh on PATH to run without one.
  const emptyPath = join(root, "empty-path");
  mkdirSync(emptyPath);
  delete process.env.GH_TOKEN;
  process.env.PATH = emptyPath;
  await assert.rejects(ghJsonAsync(["api", "repos/o/r/pulls/32"]), GithubCredentialMissingError);
  assert.equal(server.requests.length, 1, "a read with no credential sends no request");

  // The sentinel: the client refuses it, and so does the transport before the client is reached.
  const read = parseGhApiRead(["api", "repos/o/r/pulls/33", "-i"])!;
  await assert.rejects(githubHttpRead(read, LIVE_WRITE_SENTINEL_TOKEN), LiveWriteBlockedError);
  await assert.rejects(githubHttpRead(read, ""), /handed no token/);
  process.env.GH_TOKEN = LIVE_WRITE_SENTINEL_TOKEN;
  await assert.rejects(ghJsonAsync(["api", "repos/o/r/pulls/34"]), LiveWriteBlockedError);
  assert.equal(server.requests.length, 1, "the sentinel token reaches no server");
  assert.deepEqual(shim.calls(), []);
});

const LIMITS: Array<{ label: string; status: number; statusText: string; headers: Record<string, string>; message: string }> = [
  { label: "primary 403", status: 403, statusText: "Forbidden", headers: { ...RATE_HEADERS, "x-ratelimit-remaining": "0", "x-ratelimit-used": "5000" },
    message: "API rate limit exceeded for installation ID 1." },
  { label: "secondary 403 with retry-after", status: 403, statusText: "Forbidden", headers: { ...RATE_HEADERS, "retry-after": "60" },
    message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." },
  { label: "429 with retry-after", status: 429, statusText: "Too Many Requests", headers: { ...RATE_HEADERS, "retry-after": "30" },
    message: "You have exceeded a secondary rate limit." },
  { label: "429 without retry-after", status: 429, statusText: "Too Many Requests", headers: { ...RATE_HEADERS, "x-ratelimit-remaining": "0" },
    message: "API rate limit exceeded for user ID 2." },
];

test("W1-T12531 criterion 4: a primary or secondary rate-limit response raises the error and reading the gh path raises for it", async (t) => {
  for (const limit of LIMITS) {
    const body = JSON.stringify({ message: limit.message, documentation_url: "https://docs.github.com/rest" });
    await t.test(limit.label, async (t) => {
      const { shim } = scene(t, [{ when: "", stdout: ghPrinted(`${limit.status} ${limit.statusText}`, limit.headers, body),
        stderr: `gh: ${limit.message} (HTTP ${limit.status})`, exit: 1 }]);
      const args = ["api", "repos/o/r/pulls/41", "-i"];

      // The gh path: the stub prints what gh prints and exits 1.
      const viaGh = await ghJsonAsync(args).then(() => assert.fail("gh path must reject"), (err: unknown) => err as Error & { stdout: string; stderr: string; code: number });
      assert.equal(shim.calls().length, 1);

      const server = await apiServer(t, () => ({ status: limit.status, headers: limit.headers, body }));
      const viaHttp = await ghJsonAsync(args).then(() => assert.fail("client path must reject"), (err: unknown) => err as Error & { stdout: string; stderr: string; code: number });
      assert.equal(server.requests.length, 1);
      assert.equal(shim.calls().length, 1, "the client path started no child");

      assert.equal(Object.getPrototypeOf(viaHttp), Object.getPrototypeOf(viaGh), "the same error class");
      assert.equal(viaHttp.message, viaGh.message);
      assert.equal(viaHttp.stderr, viaGh.stderr);
      assert.equal(viaHttp.code, viaGh.code);
      assert.equal(isGhRateLimitError(viaHttp), true);
      assert.equal(isGhRateLimitError(viaHttp), isGhRateLimitError(viaGh));
      const reading = (err: { stdout: string }) => parseGhRateLimitHeaders(splitGhHeaderBlock(err.stdout).headers);
      assert.deepEqual(reading(viaHttp), reading(viaGh), "the same rate-limit reading");
      assert.equal(reading(viaHttp).remaining, Number(limit.headers["x-ratelimit-remaining"]));
    });
  }
});

test("W1-T12531 criterion 5: an argument form the client does not parse still spawns gh as before", async (t) => {
  const { root, shim } = scene(t, [{ when: "", stdout: JSON.stringify({ spawned: true }) }]);
  const server = await apiServer(t, () => ({ status: 200, headers: RATE_HEADERS, body: JSON.stringify({ spawned: false }) }));
  const forms = [
    ["api", "-X", "PATCH", "repos/o/r/pulls/51", "-f", "title=x"],
    ["api", "--method=POST", "repos/o/r/issues"],
    ["api", "repos/o/r/issues", "-F", "n=1"],
    ["api", "--paginate", "--slurp", "repos/o/r/pulls"],
    ["api", "repos/o/r/pulls", "--jq", ".[0]"],
    ["api", "graphql", "-f", "query={viewer{login}}"],
    ["api", "repos/{owner}/{repo}/pulls"],
    ["pr", "view", "51", "--json", "number"],
  ];
  for (const form of forms) {
    assert.deepEqual(await ghJsonAsync(form), { spawned: true }, `${form.join(" ")} spawns gh`);
    assert.equal(shim.calls().at(-1), form.join(" "), "gh receives the argv origin/main gives it");
  }
  // Another GitHub host, gh's own stored login, and the sentinel beside a test's stub all keep gh.
  process.env.GH_HOST = "ghe.example.com";
  assert.deepEqual(await ghJsonAsync(["api", "repos/o/r/pulls/52"]), { spawned: true });
  delete process.env.GH_HOST;
  delete process.env.GH_TOKEN;
  writeFileSync(join(root, "gh-config", "hosts.yml"), "github.com:\n  user: fixture\n");
  assert.deepEqual(await ghJsonAsync(["api", "repos/o/r/pulls/53"]), { spawned: true });
  process.env.GH_TOKEN = LIVE_WRITE_SENTINEL_TOKEN;
  assert.deepEqual(await ghJsonAsync(["api", "repos/o/r/pulls/54"]), { spawned: true });
  // A test's own stub keeps answering when no test pointed the client at a server.
  process.env.GH_TOKEN = TOKEN;
  configureGithubHttpRead(undefined);
  assert.deepEqual(await ghJsonAsync(["api", "repos/o/r/pulls/55"]), { spawned: true });
  assert.equal(shim.calls().length, forms.length + 4);
  assert.equal(server.requests.length, 0, "the client sent none of them");

  assert.deepEqual(parseGhApiRead(["api", "-X", "GET", "repos/o/r", "--include"]), { args: ["api", "-X", "GET", "repos/o/r", "--include"], path: "repos/o/r", include: true });
  assert.equal(parseGhApiRead(["api", "-XGET", "--method=GET", "repos/o/r"])?.include, false);
  for (const form of [["api"], ["api", ""], ["api", "a", "b"], ["api", "https://api.github.com/x"], ["api", "--hostname", "h", "x"], ["api", "-H", "Accept: x", "x"], ["api", "--slurp", "x"]]) {
    assert.equal(parseGhApiRead(form), undefined, `${JSON.stringify(form)} is gh's to send`);
  }
});

test("W1-T12531: a failed send, a timeout and an error body without a message keep gh's failure shapes", async (t) => {
  scene(t);
  const read = parseGhApiRead(["api", "repos/o/r/pulls/61"])!;
  // A refused connection reads as a transport failure, as gh's dial error does.
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as { port: number };
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  configureGithubHttpRead({ origin: `http://127.0.0.1:${port}` });
  t.after(() => configureGithubHttpRead(undefined));
  const refused = await githubHttpRead(read, TOKEN).then(() => assert.fail("must reject"), (err: unknown) => err as { stderr: string; status?: number; code: number });
  assert.match(refused.stderr, /ECONNREFUSED/);
  assert.equal(classifyGhFailure(refused.status, refused.stderr), "transport");

  // A server that never answers is stopped at the loop-available budget, as a wedged gh child is.
  const silent = createServer(() => { /* never answers */ });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(async () => { silent.closeAllConnections(); await new Promise<void>((resolve) => silent.close(() => resolve())); });
  configureGithubHttpRead({ origin: `http://127.0.0.1:${(silent.address() as { port: number }).port}` });
  await assert.rejects(githubHttpRead(read, TOKEN, { timeoutMs: 50 }), LoopBoundedChildTimeout);

  // gh's own messages for bodies with no `message`.
  assert.equal(ghApiServerError(502, "<html>bad gateway</html>"), "HTTP 502");
  assert.equal(ghApiServerError(422, JSON.stringify({ errors: [{ message: "a" }, "b", { code: "x" }] })), "a\nb");
  assert.equal(ghApiServerError(404, JSON.stringify({ message: "Not Found" })), "Not Found (HTTP 404)");
  const response = { status: 404, statusText: "", headers: [["x-ratelimit-remaining", "9"]] as Array<[string, string]>, body: "{}" };
  assert.equal(ghIncludeHeaderBlock(response), "HTTP/1.1 404 Not Found\r\nX-Ratelimit-Remaining: 9\r\n\r\n");
  assert.equal(ghIncludeHeaderBlock({ ...response, status: 599 }), "HTTP/1.1 599\r\nX-Ratelimit-Remaining: 9\r\n\r\n");
  assert.throws(() => ghStdoutOfHttpRead(read, response), (err: Error & { stderr: string; stdout: string }) =>
    err.stderr === "gh: HTTP 404\n" && err.stdout === "{}" && err.message === "Command failed: gh api repos/o/r/pulls/61\ngh: HTTP 404\n");
});
