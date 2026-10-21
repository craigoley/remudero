import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghBrokerDir } from "#src/lib/gh-read-broker-client.js";
import { classifyGhBrokerRead, ghCommand } from "#src/lib/gh-read-broker.js";
import { ghArgvIsWrite } from "#src/lib/github-transport.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// ONE WRITE RULE. After W1-T10279 (#13204) three components decided "is this gh call a write?" and
// disagreed: the transport and `rmd gh` (ghArgvIsWrite) saw a write only with an explicit -X/--method,
// the broker (classifyGhBrokerRead) also knew gh's own POST default and GraphQL mutations, and
// hooks/deny-floor.sh rule 10 mirrored the narrow one. So `gh api …/comments -f body=hi` and
// `gh api graphql -f query='mutation …'` went to the broker, which refused them as WRITES, and the
// write failed (broker log 2026-10-20T23:26:11Z); a `-F query=@file` mutation was a READ to all three.
//
// gh's own method rule is the oracle: the explicit -X/--method, else POST when any -f/--raw-field/
// -F/--field/--input is given, else GET. A non-GET/HEAD REST call is a write. `api graphql` is a read
// only when its query provably is not a mutation: a query read from a local file is read to decide,
// and an unreadable or empty query is a write. Every path below must give the same answer.

const HOOK = join(REPO_ROOT, "hooks/deny-floor.sh");

function tmp(t: TestContext, tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-one-write-${tag}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A live broker heartbeat, so the hook routes reads and `rmd gh` brokers them. */
function liveHeartbeat(cacheHome: string): void {
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cacheHome })!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "heartbeat"), "10\n");
  const at = (Date.now() - 1_000) / 1000;
  utimesSync(join(dir, "heartbeat"), at, at);
}

/** A word as a session would type it: bare when the shell needs no quoting, else single-quoted. */
const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

type Verdict = "write" | "read";

/** The hook's verdict on a RAW `gh` call under a live broker: a write runs (0), a read is routed (2). */
function hookVerdict(args: readonly string[], cacheHome: string): string {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ tool_input: { command: `gh ${args.map(shq).join(" ")}` } }),
    encoding: "utf8",
    env: { ...process.env, RMD_GH_CACHE_HOME: cacheHome, XDG_CACHE_HOME: cacheHome, RMD_GH_COOLDOWN_S: "" },
  });
  if (r.status === 0) return "write";
  if (r.status === 2 && /routed - a live GitHub read broker/.test(r.stderr)) return "read";
  return `hook exit ${r.status}: ${r.stderr.trim()}`;
}

/** `rmd gh`'s routing with a live broker: a write must reach runDirect, a read the broker, never both. */
async function ghCommandVerdict(args: readonly string[], cacheHome: string): Promise<string> {
  const direct: string[][] = [];
  const brokered: string[][] = [];
  await ghCommand(["--class", "agent", "--", ...args], { RMD_GH_CACHE_HOME: cacheHome },
    (a) => { direct.push(a); return 0; },
    async (_socket, a) => { brokered.push([...a]); return { stdout: "", stderr: "", exitCode: 0, outcome: "upstream-200" }; },
    () => {});
  if (direct.length === 1 && brokered.length === 0) return "write";
  if (direct.length === 0 && brokered.length === 1) return "read";
  return `direct=${direct.length} brokered=${brokered.length}`;
}

function table(dir: string): Array<[string[], Verdict]> {
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  const mutationFile = file("mutation.graphql", 'mutation {\n  addComment(input: {subjectId: "x", body: "y"}) { clientMutationId }\n}\n');
  const queryFile = file("query.graphql", "query {\n  viewer { login }\n}\n");
  const mutationInput = file("mutation.json", JSON.stringify({ query: "mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }" }));
  const queryInput = file("query.json", JSON.stringify({ query: "{ viewer { login } }" }));
  const emptyFile = file("empty.graphql", "  \n");
  const body = file("body.json", JSON.stringify({ body: "hi" }));
  const missing = join(dir, "missing.graphql");
  const mutation = 'mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }';
  return [
    // GraphQL: a read only when the query provably is not a mutation.
    [["api", "graphql", "-f", "query={ viewer { login } }"], "read"],
    [["api", "graphql", "-f", `query=${mutation}`], "write"],
    [["api", "graphql", "--raw-field", `query=${mutation}`], "write"],
    [["api", "graphql", "-F", `query=@${mutationFile}`], "write"],
    [["api", "graphql", "--field", `query=@${mutationFile}`], "write"],
    [["api", "graphql", "-F", `query=@${queryFile}`], "read"],
    [["api", "graphql", "-F", `query=@${missing}`], "write"],
    [["api", "graphql", "-F", "query=@-"], "write"],
    [["api", "graphql", "-F", `query=@${emptyFile}`], "write"],
    [["api", "graphql", "--input", mutationInput], "write"],
    [["api", "graphql", "--input", queryInput], "read"],
    [["api", "graphql", "--input", "-"], "write"],
    [["api", "graphql", "-X", "POST", "-f", `query=${mutation}`], "write"],
    [["api", "graphql", "-f", "query={ viewer { login } }", "-F", "n=3"], "read"],
    // REST: gh sends POST when a field or --input is given and no method is named.
    [["api", "repos/o/r/issues/1/comments", "-f", "body=hi"], "write"],
    [["api", "repos/o/r/issues/1/comments", "-F", "body=hi"], "write"],
    [["api", "repos/o/r/issues/1/comments", "--raw-field", "body=hi"], "write"],
    [["api", "repos/o/r/issues/1/comments", "--field=body=hi"], "write"],
    [["api", "repos/o/r/issues/1/comments", "-fbody=hi"], "write"],
    [["api", "repos/o/r/issues/1/comments", "--input", body], "write"],
    [["api", "repos/o/r/pulls/1"], "read"],
    [["api", "repos/o/r/pulls/1", "--jq", ".title"], "read"],
    [["api", "repos/o/r/pulls", "--paginate"], "read"],
    [["api", "-X", "GET", "search/issues", "-f", "q=x"], "read"],
    [["api", "--method", "GET", "search/issues", "-f", "q=x"], "read"],
    [["api", "--method=GET", "search/issues", "-f", "q=x"], "read"],
    [["api", "-XGET", "search/issues", "-f", "q=x"], "read"],
    // An explicit method decides.
    [["api", "-X", "POST", "repos/o/r/issues"], "write"],
    [["api", "--method", "PATCH", "repos/o/r/pulls/1"], "write"],
    [["api", "--method=PUT", "repos/o/r/pulls/1/merge"], "write"],
    [["api", "-XDELETE", "repos/o/r/labels/x"], "write"],
    [["api", "-X", "delete", "repos/o/r/labels/x"], "write"],
    // Porcelain verbs.
    [["pr", "view", "1"], "read"],
    [["pr", "list"], "read"],
    [["issue", "view", "1"], "read"],
    [["pr", "comment", "1", "--body", "hi"], "write"],
    [["pr", "create", "--title", "x", "--body", "y"], "write"],
    [["issue", "edit", "1", "--title", "x"], "write"],
    [["run", "rerun", "5"], "write"],
    [["label", "create", "x"], "write"],
  ];
}

test("one write rule: the transport, rmd gh, the broker and the deny-floor hook agree on every gh call", { timeout: 120_000 }, async (t) => {
  const dir = tmp(t, "files");
  const cache = tmp(t, "cache");
  liveHeartbeat(cache);
  const rows = table(dir);
  const expected: string[] = [];
  const actual: string[] = [];
  for (const [args, want] of rows) {
    const label = args.join(" ");
    const transport: Verdict = ghArgvIsWrite(args) ? "write" : "read";
    const broker: Verdict = classifyGhBrokerRead(args).kind === "write" ? "write" : "read";
    const command = await ghCommandVerdict(args, cache);
    const hook = hookVerdict(args, cache);
    expected.push(`${want.padEnd(5)} transport=${want} broker=${want} rmd-gh=${want} hook=${want} | ${label}`);
    actual.push(`${want.padEnd(5)} transport=${transport} broker=${broker} rmd-gh=${command} hook=${hook} | ${label}`);
  }
  assert.ok(rows.length >= 30, `the table must exercise every case, saw ${rows.length} rows`);
  assert.deepEqual(actual, expected);
});

test("one write rule: a gh api call with fields and no method is a write that runs directly, never through the broker", async (t) => {
  const cache = tmp(t, "direct");
  liveHeartbeat(cache);
  for (const args of [
    ["api", "repos/o/r/issues/1/comments", "-f", "body=hi"],
    ["api", "graphql", "-f", "query=mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }"],
  ]) {
    assert.equal(await ghCommandVerdict(args, cache), "write", `rmd gh must run it with gh: ${args.join(" ")}`);
    assert.equal(hookVerdict(args, cache), "write", `the hook must let the raw write run: ${args.join(" ")}`);
  }
});

test("one write rule: a GraphQL mutation named by a local file is never executed as a cached read", (t) => {
  const dir = tmp(t, "gql");
  const mutationFile = join(dir, "q.graphql");
  writeFileSync(mutationFile, "mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }\n");
  for (const args of [["api", "graphql", "-F", `query=@${mutationFile}`], ["api", "graphql", "-F", `query=@${join(dir, "gone.graphql")}`]]) {
    assert.equal(ghArgvIsWrite(args), true, args.join(" "));
    assert.equal(classifyGhBrokerRead(args).kind, "write", args.join(" "));
  }
  // A relative file is resolved where gh runs it: the broker's request cwd.
  assert.equal(classifyGhBrokerRead(["api", "graphql", "-F", "query=@q.graphql"], undefined, dir).kind, "write");
  writeFileSync(mutationFile, "{ viewer { login } }\n");
  assert.equal(classifyGhBrokerRead(["api", "graphql", "-F", "query=@q.graphql"], undefined, dir).kind, "opaque");
});
