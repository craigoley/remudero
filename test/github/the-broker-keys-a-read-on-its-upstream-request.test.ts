import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { defaultGhUpstreamExec, ghCommand, GhReadBroker, summariseGhBrokerLog, type GhUpstreamExec } from "#src/lib/gh-read-broker.js";
import { GH_BROKER_HEARTBEAT, GH_BROKER_INVALIDATIONS } from "#src/lib/gh-read-broker-client.js";
import { parseGhApiArgv } from "#src/lib/github-transport.js";
import { ghShim } from "#test/helpers/gh-shim.js";

function fixture(t: TestContext, cacheWorks = true) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-request-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  let fetches = 0;
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const exec: GhUpstreamExec = async (args, opts) => {
    if (args[1] === "user") return { stdout: "reader\n", stderr: "", exitCode: 0 };
    calls.push({ args, env: opts.env });
    const api = parseGhApiArgv(args);
    const cacheDir = opts.env?.XDG_CACHE_HOME;
    const file = cacheDir && join(cacheDir, "response");
    let response: { id: string; body: Record<string, string | number> };
    if (cacheWorks && file && existsSync(file) && args.includes("--cache")) {
      response = JSON.parse(readFileSync(file, "utf8"));
    } else {
      fetches += 1;
      const query = api.fields.find((f) => f.key === "query");
      let answer = query?.value ?? api.endpoint ?? "";
      try {
        if (query?.typed && answer.startsWith("@")) answer = readFileSync(join(opts.cwd ?? dir, answer.slice(1)), "utf8");
        if (api.input) answer = readFileSync(join(opts.cwd ?? dir, api.input), "utf8");
      } catch (cause) {
        return { stdout: "", stderr: String(cause), exitCode: 1 };
      }
      response = { id: `request-${fetches}`, body: { first: "one", second: "two", answer, version: fetches } };
      if (file && args.includes("--cache")) {
        mkdirSync(cacheDir!, { recursive: true });
        writeFileSync(file, JSON.stringify(response));
      }
    }
    const filterAt = args.findIndex((a) => a === "--jq" || a === "-q" || a === "--template" || a === "-t");
    const filter = filterAt < 0 ? args.find((a) => /^(--jq|--template)=/.test(a))?.split("=")[1] ?? args.find((a) => /^-[qt].+/.test(a))?.slice(2) : args[filterAt + 1];
    const output = filter ? `${response.body[filter.replace(/^\./, "")]}\n` : JSON.stringify(response.body);
    const headers = `HTTP/2.0 200 OK\r\nCache-Control: max-age=60\r\nX-Github-Request-Id: ${response.id}\r\nETag: "${response.id}"`;
    return { stdout: args.includes("-i") || args.includes("--include") ? `${headers}\r\n\r\n${output}` : output, stderr: "", exitCode: 0 };
  };
  const broker = new GhReadBroker(join(dir, "broker"), exec, clockFromMillisFn(() => now), async (ms) => { now += ms; }, () => 1e12);
  const read = (args: string[], cwd = dir, repo?: string) => broker.read({ op: "read", args, cwd, repo, class: "agent", caller: "test" });
  return { dir, broker, read, calls, fetches: () => fetches, advance: (ms: number) => { now += ms; } };
}

test("W1-T10310: two filters on one request make one upstream call", async (t) => {
  const f = fixture(t);
  assert.equal((await f.read(["api", "repos/o/r/pulls/7", "--jq", ".first"])).stdout, "one\n");
  const gap = f.broker.pacer("core").gapMs;
  assert.equal((await f.read(["api", "repos/o/r/pulls/7", "--jq", ".second"])).stdout, "two\n");
  assert.equal(f.fetches(), 1);
  assert.equal(f.broker.counts.upstream_calls, 1);
  assert.equal(f.broker.pacer("core").gapMs, gap, "a local filter never records a fetch");
  assert.equal(f.calls[0].env?.XDG_CACHE_HOME, f.calls[1].env?.XDG_CACHE_HOME);
  const log = summariseGhBrokerLog(f.broker.dir, 0);
  assert.equal(log.upstream_calls, 1);
  assert.equal(log.filtered_locally, 1);
});

test("W1-T10310: a query file is keyed by its contents", async (t) => {
  const f = fixture(t);
  const args = ["api", "graphql", "-F", "query=@q.graphql", "--jq", ".answer"];
  writeFileSync(join(f.dir, "q.graphql"), "query{viewer{login}}");
  assert.equal((await f.read(args)).stdout, "query{viewer{login}}\n");
  writeFileSync(join(f.dir, "q.graphql"), "query{rateLimit{limit}}");
  assert.equal((await f.read(args)).stdout, "query{rateLimit{limit}}\n");
  assert.equal(f.fetches(), 2);
  assert.notEqual(f.calls[0].env?.XDG_CACHE_HOME, f.calls[1].env?.XDG_CACHE_HOME);
});

function repository(root: string, name: string, branch = "main") {
  const cwd = join(root, name);
  mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
  mkdirSync(join(cwd, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(cwd, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(cwd, ".git", "config"), `[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = https://github.com/o/${name}.git\ngh-resolved = base\n`);
  return cwd;
}

test("W1-T10310: a placeholder endpoint is keyed by the repository it resolves to", async (t) => {
  const f = fixture(t);
  const a = repository(f.dir, "a");
  const b = repository(f.dir, "b");
  const args = ["api", "repos/{owner}/{repo}"];
  assert.equal(JSON.parse((await f.read(args, a)).stdout).version, 1);
  assert.equal(JSON.parse((await f.read(args, b)).stdout).version, 2);
  assert.equal(f.fetches(), 2);
  assert.notEqual(f.calls[0].env?.XDG_CACHE_HOME, f.calls[1].env?.XDG_CACHE_HOME);
  await f.read(args, a, "o/override");
  assert.equal(f.calls.at(-1)?.env?.GH_REPO, "o/override");
  assert.equal(f.fetches(), 3);
});

test("W1-T10310: stdin reads go direct and invalidation clears the gh cache", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.broker.dir, GH_BROKER_HEARTBEAT), "10\n");
  const env = { XDG_CACHE_HOME: f.dir, RMD_GH_CACHE_HOME: f.dir };
  const liveDir = join(f.dir, "remudero", "gh-broker");
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, GH_BROKER_HEARTBEAT), "10\n");
  let direct = 0;
  let brokered = 0;
  for (const args of [["api", "repos/o/r/issues", "-XGET", "-F", "q=@-"], ["api", "graphql", "-fquery={viewer{login}}", "-Fvariables=@-"], ["api", "repos/o/r/issues", "-XGET", "--input", "-"]]) {
    assert.equal(await ghCommand(["--", ...args], env, () => { direct++; return 0; }, async () => { brokered++; throw new Error("stdin reached broker"); }, () => {}), 0);
  }
  assert.equal(direct, 3);
  assert.equal(brokered, 0);
  assert.equal(await ghCommand(["--", "api", "graphql", "-Fquery=@-"], env, () => { direct++; return 0; }, undefined, () => {}), 2);
  assert.equal(direct, 3, "an unknown GraphQL query keeps the existing write refusal");
  const args = ["api", "repos/o/r/pulls/7", "--jq", ".version"];
  assert.equal((await f.read(args)).stdout, "1\n");
  const cacheDir = f.calls[0].env?.XDG_CACHE_HOME;
  assert.ok(cacheDir && existsSync(cacheDir));
  writeFileSync(join(f.broker.dir, GH_BROKER_INVALIDATIONS), "o/r 7\n");
  assert.equal((await f.read(args)).stdout, "2\n");
  assert.equal(f.fetches(), 2);
});

test("W1-T10310: in-flight filters coalesce the fetch and render each view", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.read(["api", "repos/o/r", "--jq", ".first"]), f.read(["api", "repos/o/r", "--jq", ".second"])]);
  assert.deepEqual(results.map((r) => r.stdout), ["one\n", "two\n"]);
  assert.equal(f.fetches(), 1);
});

test("W1-T10310: input bytes, headers and branch context separate requests", async (t) => {
  const f = fixture(t);
  const cwd = repository(f.dir, "repo");
  const args = ["api", "repos/{owner}/{repo}/contents/{branch}", "--jq", ".version"];
  await f.read(args, cwd);
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/other\n");
  assert.equal((await f.read(args, cwd)).stdout, "2\n");
  await f.read(["api", "repos/o/r", "-H", "Accept: a"]);
  await f.read(["api", "repos/o/r", "-H", "Accept: b"]);
  writeFileSync(join(f.dir, "input.json"), '{"one":1}');
  const input = ["api", "repos/o/r", "-XGET", "--input=input.json", "--jq", ".answer"];
  assert.equal((await f.read(input)).stdout, '{"one":1}\n');
  writeFileSync(join(f.dir, "input.json"), '{"two":2}');
  assert.equal((await f.read(input)).stdout, '{"two":2}\n');
  assert.equal(f.fetches(), 6);
});

test("W1-T10310: unsupported gh cache reports fallback and keeps filter keys", async (t) => {
  const f = fixture(t, false);
  await f.read(["api", "repos/o/r", "--jq", ".first"]);
  assert.equal((await f.read(["api", "repos/o/r", "--jq", ".second"])).stdout, "two\n");
  assert.equal(f.broker.status().api_filter_cache, "filter-keyed");
  assert.equal(f.broker.counts.upstream_calls, 2);
  await f.read(["api", "repos/o/r", "--jq", ".first"]);
  const before = f.fetches();
  assert.equal((await f.read(["api", "repos/o/r", "--jq", ".first"])).stdout, "one\n");
  assert.equal(f.fetches(), before);
});

test("W1-T10310: templates, attached filters and output flags share the gh body", async (t) => {
  const f = fixture(t);
  await f.read(["api", "repos/o/r", "-q.first"]);
  const included = await f.read(["api", "repos/o/r", "--template=second", "--include", "--cache=5s"]);
  assert.match(included.stdout, /HTTP\/2.0 200 OK/);
  assert.ok(included.stdout.endsWith("two\n"));
  assert.equal(f.fetches(), 1);
  const raw = await f.read(["api", "repos/o/r"]);
  assert.equal(JSON.parse(raw.stdout).first, "one");
  assert.equal(f.fetches(), 1);
  const logDir = join(f.broker.dir, "log");
  const rows = readdirSync(logDir).flatMap((name) => readFileSync(join(logDir, name), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
  assert.equal(rows[0].request_key, rows[1].request_key);
  assert.equal(rows[1].gh_filtered_locally, true);
});

test("W1-T10310: unreadable inputs pass through and are never cached", async (t) => {
  const f = fixture(t);
  const args = ["api", "repos/o/r", "-XGET", "--input", "absent.json"];
  for (let i = 0; i < 2; i++) {
    const result = await f.read(args);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /ENOENT/);
  }
  assert.equal(f.fetches(), 2);
  assert.equal(f.broker.status().cache_entries, 0);
  assert.ok(f.calls.every((call) => call.env === undefined));
});

test("W1-T10310: eviction removes response directories and accounts their bytes", async (t) => {
  const f = fixture(t);
  await f.read(["api", "repos/o/r/pulls/1", "--jq", ".version"]);
  const directory = f.calls[0].env!.XDG_CACHE_HOME!;
  mkdirSync(join(directory, "nested"));
  writeFileSync(join(directory, "nested", "large-body"), "x".repeat(4096));
  await f.read(["api", "repos/o/r/pulls/1", "--jq", ".first"]);
  assert.ok(Number(f.broker.status().cache_bytes) > 4096);
  f.broker.cacheShareOfFree = 1e-12;
  await f.read(["api", "repos/o/r/pulls/2", "--jq", ".version"]);
  assert.equal(existsSync(directory), false);
});

test("W1-T10310: stale responses bypass the gh cache before conditional reads", async (t) => {
  const f = fixture(t);
  await f.read(["api", "repos/o/r", "--jq", ".first"]);
  await f.read(["api", "repos/o/r"]);
  f.advance(61_000);
  await f.read(["api", "repos/o/r"]);
  const last = f.calls.at(-1)!;
  assert.ok(last.args.some((arg) => arg.startsWith("If-None-Match:")));
  assert.equal(last.args.includes("--cache"), false);
  assert.equal(existsSync(last.env!.XDG_CACHE_HOME!), false);
});

test("W1-T10310: the default executor forwards repository and cache environment", async (t) => {
  const shim = ghShim([
    { when: "api repo", stdoutEnv: "GH_REPO", stderr: "diagnostic" },
    { when: "api cache", stdoutEnv: "XDG_CACHE_HOME" },
    { when: "api fail", stderr: "missing", exit: 9 },
  ]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const env = { ...process.env, PATH: `${shim.dir}:${process.env.PATH}`, GH_REPO: "o/client", XDG_CACHE_HOME: shim.dir };
  const repo = await defaultGhUpstreamExec(["api", "repo"], { env });
  assert.deepEqual(repo, { stdout: "o/client\n", stderr: "diagnostic\n", exitCode: 0 });
  assert.equal((await defaultGhUpstreamExec(["api", "cache"], { env })).stdout, `${shim.dir}\n`);
  const failure = await defaultGhUpstreamExec(["api", "fail"], { env });
  assert.equal(failure.exitCode, 9);
  assert.equal(failure.stderr, "missing\n");
});
