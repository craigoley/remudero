// W1-T12892: a `gh api <path> --paginate` read goes through the in-process client page by page, and
// each page is a conditional read. GitHub does not count a 304 Not Modified against the core limit.
// Sampled on the Azure host on 2026-11-18: about 830 paged gh calls an hour, about 450 of them
// repeats of a read made minutes before. Each test points the client at a local server of its own.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { systemClock } from "#src/lib/clock.js";
import { runDaemon } from "#src/lib/daemon.js";
import { splitConcatenatedJsonPages } from "#src/lib/escalate.js";
import { requestStop, stopDetail } from "#src/lib/fleet-control.js";
import { configureGithubHttpRead, parseGhApiRead, resetGithubHttpReadStore } from "#src/lib/github-http-read.js";
import { createInstallationBudget, type InstallationBudget } from "#src/lib/github-installation-budget.js";
import {
  configureGithubInstallationBudget, GhPaceFloorStandDownError, ghTextAsync, githubReadIdentity, parseGhRateLimitHeaders,
  splitGhHeaderBlock, takeGhReadCadenceTally,
} from "#src/lib/github-transport.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";

const TOKEN = "w1-t12892-fixture-token";
const ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "PATH", "HOME", "RMD_GH_CACHE_HOME", "GH_CONFIG_DIR", "GH_HOST"] as const;

interface Seen { url: string; headers: IncomingHttpHeaders; }
interface Served { status: number; headers?: Record<string, string>; body?: string; }

function scene(t: TestContext, routes: Parameters<typeof ghShim>[0] = []): { root: string; shim: GhShim } {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12892-`));
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
  takeGhReadCadenceTally({});
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    configureGithubInstallationBudget(undefined);
    resetGithubHttpReadStore();
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, shim };
}

/** A local stand-in for api.github.com, pointed at by the client. `respond` sees the origin, for Link URLs. */
async function apiServer(t: TestContext, respond: (seen: Seen, origin: string) => Served): Promise<{ requests: Seen[]; origin: string }> {
  const requests: Seen[] = [];
  let origin = "";
  const server = createServer((req, res) => {
    const seen = { url: req.url ?? "", headers: req.headers };
    requests.push(seen);
    const served = respond(seen, origin);
    res.writeHead(served.status, served.headers ?? {});
    res.end(served.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  configureGithubHttpRead({ origin });
  t.after(async () => {
    configureGithubHttpRead(undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests, origin };
}

const rate = (remaining: number, reset = 1_800_000_000): Record<string, string> => ({
  "x-ratelimit-limit": "15000", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(reset),
  "x-ratelimit-resource": "core", "x-ratelimit-used": String(15000 - remaining),
});

/**
 * A paged list: `pages[url]` is that page's version and its next page's URL path. Each answer carries
 * an ETag of its URL and version, and a 304 when the request names it. A 304 costs no read; a 200 costs one.
 */
function pagedList(pages: Map<string, { version: number; next?: string }>, remaining: { n: number; reset?: number }) {
  return (seen: Seen, origin: string): Served => {
    const page = pages.get(seen.url);
    if (page === undefined) return { status: 404, headers: { "content-type": "application/json; charset=utf-8", ...rate(remaining.n -= 1, remaining.reset) }, body: JSON.stringify({ message: "Not Found" }) };
    const etag = `"${seen.url}#${page.version}"`;
    const link: Record<string, string> = page.next === undefined ? {} : { link: `<${origin}${page.next}>; rel="next", <${origin}/last>; rel="last"` };
    if (seen.headers["if-none-match"] === etag) return { status: 304, headers: { etag, ...link, ...rate(remaining.n, remaining.reset) } };
    return {
      status: 200, headers: { "content-type": "application/json; charset=utf-8", etag, ...link, ...rate(remaining.n -= 1, remaining.reset) },
      body: JSON.stringify([{ url: seen.url, version: page.version }]),
    };
  };
}

const twoPages = () => new Map<string, { version: number; next?: string }>([
  ["/repos/o/r/issues?per_page=1", { version: 1, next: "/repositories/9/issues?per_page=1&page=2" }],
  ["/repositories/9/issues?per_page=1&page=2", { version: 1 }],
]);
const PAGED = ["api", "repos/o/r/issues?per_page=1", "--paginate"];
const urls = (requests: Seen[]) => requests.map((r) => r.url);
const conditionalOf = (requests: Seen[]) => requests.map((r) => r.headers["if-none-match"] ?? null);

test("W1-T12892 criterion 1: a --paginate read is sent page by page through the in-process client, each page a conditional read under its own path and query", async (t) => {
  const { shim } = scene(t);
  const server = await apiServer(t, pagedList(twoPages(), { n: 9000 }));

  assert.deepEqual(parseGhApiRead(PAGED), { args: PAGED, path: "repos/o/r/issues?per_page=1", include: false, paginate: true });
  assert.equal(parseGhApiRead(["api", "-i", "--paginate", "x"])?.paginate, true);
  assert.equal(parseGhApiRead(["api", "x"])?.paginate, undefined);
  for (const form of [["api", "--paginate", "--slurp", "x"], ["api", "--paginate", "x", "--jq", ".[]"], ["api", "--paginate", "x", "-q", "."],
    ["api", "--paginate", "x", "--template", "{{.}}"], ["api", "--paginate", "x", "-f", "a=b"], ["api", "--paginate", "--input", "f", "x"]]) {
    assert.equal(parseGhApiRead(form), undefined, `${form.join(" ")} is still gh's to send`);
  }

  const first = await ghTextAsync(PAGED);
  assert.deepEqual(urls(server.requests), ["/repos/o/r/issues?per_page=1", "/repositories/9/issues?per_page=1&page=2"], "the next page is the Link's rel=\"next\" URL");
  assert.deepEqual(conditionalOf(server.requests), [null, null], "nothing stored yet");
  const second = await ghTextAsync(PAGED);
  assert.deepEqual(conditionalOf(server.requests.slice(2)), [`"/repos/o/r/issues?per_page=1#1"`, `"/repositories/9/issues?per_page=1&page=2#1"`],
    "each page sends its own ETag");
  assert.equal(second, first);
  assert.deepEqual(shim.calls(), [], "no gh child process started");
});

test("W1-T12892 criterion 2: the paged text reads as gh's own, with and without -i, and a failed page throws gh's error", async (t) => {
  // What gh prints for these pages: each body in turn; with -i each page's header block before its
  // body and a newline between pages. A failed page ends the read with exit 1 and `gh: <message>`.
  const page1 = JSON.stringify([{ url: "/repos/o/r/issues?per_page=1", version: 1 }]);
  const page2 = JSON.stringify([{ url: "/repositories/9/issues?per_page=1&page=2", version: 1 }]);
  const notFound = JSON.stringify({ message: "Not Found" });
  const block = (status: string, remaining: number) => `HTTP/1.1 ${status}\r\nX-Ratelimit-Limit: 15000\r\nX-Ratelimit-Remaining: ${remaining}\r\n` +
    `X-Ratelimit-Reset: 1800000000\r\nX-Ratelimit-Resource: core\r\nX-Ratelimit-Used: ${15000 - remaining}\r\n\r\n`;
  const { shim } = scene(t, [
    { when: "-i", stdout: `${block("200 OK", 8999)}${page1}\n${block("200 OK", 8998)}${page2}` },
    { when: "missing", stdout: `${JSON.stringify([{ url: "/repos/o/r/missing?per_page=1", version: 1 }])}${notFound}`, stderr: "gh: Not Found (HTTP 404)", exit: 1 },
    { when: "", stdout: `${page1}${page2}` },
  ]);
  // The shim ends what it prints with a newline; gh prints the pages as they came.
  const shimText = (out: string) => out.replace(/\n$/, "");
  const viaGh = { plain: shimText(await ghTextAsync(PAGED)), include: shimText(await ghTextAsync([...PAGED, "-i"])) };
  const viaGhError = await ghTextAsync(["api", "repos/o/r/missing?per_page=1", "--paginate"]).then(() => assert.fail("gh exits 1"), (err: unknown) => err as Error & { stdout: string; stderr: string; code: unknown });
  assert.equal(shim.calls().length, 3);

  const pages = twoPages();
  pages.set("/repos/o/r/missing?per_page=1", { version: 1, next: "/repos/o/r/gone" });
  const counter = { n: 9000 };
  await apiServer(t, pagedList(pages, counter));
  const plain = await ghTextAsync(PAGED);
  // The -i read starts from the same server state as the shim's -i answer: nothing stored, 9000 left.
  resetGithubHttpReadStore();
  counter.n = 9000;
  const viaHttp = { plain, include: await ghTextAsync([...PAGED, "-i"]) };
  assert.deepEqual(splitConcatenatedJsonPages(viaHttp.plain), splitConcatenatedJsonPages(viaGh.plain));
  assert.equal(viaHttp.plain, viaGh.plain);
  // -i: the first header block and the rate-limit reading in it, and the pages after it.
  const head = (out: string) => splitGhHeaderBlock(out);
  assert.equal(head(viaHttp.include).headers.split("\r\n")[0], head(viaGh.include).headers.split("\r\n")[0]);
  assert.deepEqual(parseGhRateLimitHeaders(head(viaHttp.include).headers), parseGhRateLimitHeaders(head(viaGh.include).headers));
  const bodies = (out: string) => out.split(/HTTP\/1\.1 [^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n/).filter((part) => part !== "");
  assert.deepEqual(bodies(viaHttp.include), bodies(viaGh.include), "the same bodies, a newline between pages");
  // the second block is page 2's own reading
  assert.deepEqual(parseGhRateLimitHeaders(splitGhHeaderBlock(viaHttp.include, true).headers).remaining, 8998);

  const viaHttpError = await ghTextAsync(["api", "repos/o/r/missing?per_page=1", "--paginate"]).then(() => assert.fail("a 404 page fails the read"), (err: unknown) => err as typeof viaGhError);
  assert.equal(Object.getPrototypeOf(viaHttpError), Object.getPrototypeOf(viaGhError), "the same error class");
  assert.equal(viaHttpError.message, viaGhError.message);
  assert.equal(viaHttpError.stderr, viaGhError.stderr);
  assert.equal(viaHttpError.code, viaGhError.code);
  assert.equal(viaHttpError.stdout, shimText(viaGhError.stdout), "every page printed before the failed one, then its body");
  assert.equal(shim.calls().length, 3, "the in-process reads started no gh");
});

test("W1-T12892 criterion 3: a stored page is returned only for a 304 to its own ETag, and a changed page 1 is followed by its new Link", async (t) => {
  scene(t);
  const pages = twoPages();
  const server = await apiServer(t, pagedList(pages, { n: 9000 }));
  await ghTextAsync(PAGED);

  // Page 1 changes, and its Link now names another chain. The old page 2 is never read or served.
  pages.set("/repos/o/r/issues?per_page=1", { version: 2, next: "/repositories/9/issues?per_page=1&page=2&after=v2" });
  pages.set("/repositories/9/issues?per_page=1&page=2&after=v2", { version: 1 });
  const changed = await ghTextAsync(PAGED);
  assert.deepEqual(urls(server.requests.slice(2)), ["/repos/o/r/issues?per_page=1", "/repositories/9/issues?per_page=1&page=2&after=v2"]);
  assert.deepEqual(conditionalOf(server.requests.slice(2)), [`"/repos/o/r/issues?per_page=1#1"`, null], "the new chain's page is read in full");
  assert.deepEqual(splitConcatenatedJsonPages(changed).map((chunk) => JSON.parse(chunk)), [
    [{ url: "/repos/o/r/issues?per_page=1", version: 2 }], [{ url: "/repositories/9/issues?per_page=1&page=2&after=v2", version: 1 }],
  ]);

  // Unchanged again: page 1's 304 returns its stored answer, whose Link names the new chain.
  assert.equal(await ghTextAsync(PAGED), changed);
  assert.deepEqual(urls(server.requests.slice(4)), ["/repos/o/r/issues?per_page=1", "/repositories/9/issues?per_page=1&page=2&after=v2"]);

  // A 200 to a page's conditional read replaces it: the new body is returned, never the stored one.
  pages.set("/repositories/9/issues?per_page=1&page=2&after=v2", { version: 2 });
  const later = await ghTextAsync(PAGED);
  assert.deepEqual(JSON.parse(splitConcatenatedJsonPages(later)[1]!), [{ url: "/repositories/9/issues?per_page=1&page=2&after=v2", version: 2 }]);
});

test("W1-T12892 criterion 4: each page claims a read before it is sent and records its own reading, and a page refused at the write reserve fails the read", async (t) => {
  scene(t);
  const resetS = Math.floor(Date.now() / 1000) + 3600;
  const remaining = { n: 9000, reset: resetS };
  const pages = twoPages();
  pages.set("/repositories/9/issues?per_page=1&page=2", { version: 1, next: "/repositories/9/issues?per_page=1&page=3" });
  pages.set("/repositories/9/issues?per_page=1&page=3", { version: 1 });
  const server = await apiServer(t, pagedList(pages, remaining));
  const budget: InstallationBudget = createInstallationBudget({ consumers: 1, clock: systemClock, maxWaitMs: 0 });
  const events: string[] = [];
  const claimRead = budget.claimRead.bind(budget);
  const record = budget.record.bind(budget);
  budget.claimRead = () => { events.push(`claim before request ${server.requests.length + 1}`); return claimRead(); };
  budget.record = (reading) => { if (reading.remaining !== undefined) events.push(`record ${reading.remaining}`); record(reading); };
  configureGithubInstallationBudget(budget);

  await ghTextAsync(PAGED);
  assert.deepEqual(events, ["claim before request 1", "record 8999", "claim before request 2", "record 8998", "claim before request 3", "record 8997"],
    "three pages, three claims, three readings");
  // Repeated unchanged: three claims again, and each 304's reading shows no read spent.
  events.length = 0;
  await ghTextAsync(PAGED);
  assert.deepEqual(events, ["claim before request 4", "record 8997", "claim before request 5", "record 8997", "claim before request 6", "record 8997"]);

  // Page 1 answers at the write reserve: page 2's claim is refused and the whole read fails, as a
  // single read under the same reading fails, and page 2 is never sent.
  resetGithubHttpReadStore();
  remaining.n = 1401;
  const before = server.requests.length;
  await assert.rejects(ghTextAsync(PAGED), GhPaceFloorStandDownError);
  assert.equal(server.requests.length, before + 1, "only page 1 was sent");
  await assert.rejects(ghTextAsync(["api", "repos/o/r/issues?per_page=1"]), GhPaceFloorStandDownError);
  assert.equal(server.requests.length, before + 1);
});

test("W1-T12892 criterion 5: ghTextAsync sends a utf8 api read with no env of its own through the in-process client; every other read runs gh", async (t) => {
  const { shim } = scene(t, [{ when: "", stdout: "spawned" }]);
  const server = await apiServer(t, pagedList(twoPages(), { n: 9000 }));

  assert.match(await ghTextAsync(PAGED), /"version":1/);
  assert.match(await ghTextAsync(["api", "repos/o/r/issues?per_page=1"], { encoding: undefined }), /"version":1/, "a single-page read too");
  assert.equal(server.requests.length, 3);
  assert.deepEqual(shim.calls(), []);

  const spawned: string[][] = [
    PAGED, PAGED, ["api", "repos/o/r/issues?per_page=1", "--paginate", "--jq", ".[]"], ["api", "--paginate", "--slurp", "repos/o/r/issues?per_page=1"],
  ];
  assert.equal(await ghTextAsync(spawned[0]!, { encoding: "latin1" }), "spawned\n", "a latin1 read runs gh");
  assert.equal(await ghTextAsync(spawned[1]!, { env: { ...process.env } }), "spawned\n", "a read with an env runs gh");
  assert.equal(await ghTextAsync(spawned[2]!), "spawned\n");
  assert.equal(await ghTextAsync(spawned[3]!), "spawned\n");
  assert.deepEqual(shim.calls(), spawned.map((args) => args.join(" ")), "gh receives the argv it always received");
  assert.equal(server.requests.length, 3, "the client sent none of them");
});

test("W1-T12892 criterion 6: the core daemon.quota row carries this process's conditional sends and 304s since the previous poll", async (t) => {
  scene(t);
  await apiServer(t, pagedList(twoPages(), { n: 9000 }));
  await ghTextAsync(PAGED);
  await ghTextAsync(PAGED);
  await ghTextAsync(PAGED);

  const planDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12892-plan-`));
  t.after(() => rmSync(planDir, { recursive: true, force: true }));
  writeFileSync(join(planDir, "tasks.yaml"), "- id: M\n  title: merged\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const poll = () => runDaemon(loadPlan(join(planDir, "tasks.yaml")), {
    refreshMerged: () => (id) => id === "M",
    runOne: async (id) => { throw new Error(`FALSIFIER: ${id} dispatched`); },
    readGhQuota: () => ({ core: { remaining: 4600, resetsAt: "2026-11-18T14:00:00.000Z" }, graphql: { remaining: 4900, resetsAt: "2026-11-18T14:00:00.000Z" } }),
    takeGhReadCadence: () => takeGhReadCadenceTally({}),
    log: (step, extra) => rows.push({ step, extra: extra ?? {} }),
    checkStop: () => stopDetail(planDir),
    sleep: async () => { requestStop(planDir, "test done polling"); },
  });
  await poll();
  const core = rows.find((row) => row.step === "daemon.quota" && row.extra.bucket === "core");
  assert.deepEqual(core?.extra.conditional, { sent: 4, not_modified: 4 }, "two repeats of two pages, each answered 304");
  assert.deepEqual(takeGhReadCadenceTally({}).conditional, { sent: 0, not_modified: 0 }, "the next poll starts from nothing");
});

test("W1-T12892 criterion 7: through the real ghTextAsync, a second paged read answered 304 for both pages returns the first read's text", async (t) => {
  const { shim } = scene(t);
  const statuses: number[] = [];
  const list = pagedList(twoPages(), { n: 9000 });
  const server = await apiServer(t, (seen, origin) => {
    const served = list(seen, origin);
    statuses.push(served.status);
    return served;
  });
  const first = await ghTextAsync(PAGED);
  const second = await ghTextAsync(PAGED);
  assert.deepEqual(statuses, [200, 200, 304, 304]);
  assert.equal(second, first);
  assert.deepEqual(splitConcatenatedJsonPages(second).map((chunk) => JSON.parse(chunk)), [
    [{ url: "/repos/o/r/issues?per_page=1", version: 1 }], [{ url: "/repositories/9/issues?per_page=1&page=2", version: 1 }],
  ]);
  assert.equal(server.requests.length, 4);
  assert.deepEqual(shim.calls(), []);
});

test("W1-T12892 criterion 8: each page's entry is keyed by credential identity, origin and its own path, and holds no token text", async (t) => {
  scene(t);
  const server = await apiServer(t, pagedList(twoPages(), { n: 9000 }));
  const sent = () => conditionalOf(server.requests.slice(-2));

  await ghTextAsync(PAGED);
  await ghTextAsync(PAGED);
  assert.deepEqual(sent().map((etag) => etag !== null), [true, true], "the same credential revalidates each page");
  process.env.GH_TOKEN = "w1-t12892-another-login";
  await ghTextAsync(PAGED);
  assert.deepEqual(sent(), [null, null], "another credential never gets a page stored under the first");
  assert.deepEqual(server.requests.slice(-2).map((r) => r.headers.authorization), ["token w1-t12892-another-login", "token w1-t12892-another-login"]);
  process.env.GH_TOKEN = TOKEN;
  await ghTextAsync(PAGED);
  assert.deepEqual(sent().map((etag) => etag !== null), [true, true], "each credential keeps its own pages");

  // Another origin is another request, page by page.
  const other = await apiServer(t, pagedList(twoPages(), { n: 9000 }));
  await ghTextAsync(PAGED);
  assert.deepEqual(conditionalOf(other.requests), [null, null], "another host never gets this host's pages");

  // The key holds the identity, never the token.
  const identity = githubReadIdentity({ source: "ambient-env" }, TOKEN);
  assert.ok(!identity.includes(TOKEN), "no token text in the key");
});

test("a paged read refuses a next-page link on another host before sending another request", async (t) => {
  const { shim } = scene(t);
  const body = JSON.stringify([{ url: "/repos/o/r/issues?per_page=1", version: 1 }]);
  const server = await apiServer(t, (seen) => ({
    status: seen.url === "/repos/o/r/issues?per_page=1" ? 200 : 404,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...rate(8999),
      ...(seen.url === "/repos/o/r/issues?per_page=1" ? { link: "<https://attacker.example/collect>; rel=\"next\"" } : {}),
    },
    body: seen.url === "/repos/o/r/issues?per_page=1" ? body : JSON.stringify({ message: "Not Found" }),
  }));

  const error = await ghTextAsync(PAGED).then(
    () => assert.fail("a cross-host next page must be refused"),
    (cause: unknown) => cause as Error & { code: number; stdout: string; stderr: string },
  );
  assert.equal(server.requests.length, 1, "the client never follows the hostile Link");
  assert.equal(server.requests[0]?.headers.authorization, `token ${TOKEN}`, "the token stays on the configured origin");
  assert.equal(error.code, 1);
  assert.equal(error.stdout, body, "gh's error keeps the first page's stdout");
  assert.match(error.stderr, /next page on another host: attacker\.example/);
  assert.deepEqual(shim.calls(), [], "the refused page started no gh child");
});
