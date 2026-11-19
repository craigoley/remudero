import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { proposeRunnerConfigBootstrap, RUNNER_CONFIG_PROPOSAL_VERSION, type ReviewedMergeRead } from "#src/lib/product-target-config.js";
import { ghProductBuildTarget } from "#src/lib/product-build.js";
import { ProductIntentStore } from "#src/lib/product-intent-store.js";
import { ghStubPath, pathWith } from "#test/helpers/gh-stub.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { declaredBody, violations } from "#test/helpers/openapi-strict.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const table = readFileSync(join(REPO_ROOT, ".remudero/mounts.yaml"), "utf8");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const repository = { provider: "github", id: 42, owner: "fixture", name: "target", defaultBranch: "main",
  visibility: "private", verifiedAt: "2026-11-01T00:00:00.000Z" };

/** The fake GitHub's whole state, held in one JSON file the controlled `gh` executable reads and rewrites. */
interface RemoteState {
  refs: Record<string, string>;
  commits: Record<string, { parent: string | null; files: Record<string, string> }>;
  pulls: { number: number; html_url: string; state: string; head: { ref: string }; base: { ref: string }; merged_at: string | null; merge_commit_sha: string | null }[];
  reviews: Record<string, { state: string; user: { login: string } }[]>;
  /** A write matching one of these runs, then its response is lost (exit 1, HTTP 502). */
  lose: string[];
  /** After a write matching `after`, the next `count` calls fail unreadable. */
  outage?: { after: string; count: number; armed?: boolean };
  calls: { method: string; path: string; fields: Record<string, string> }[];
}

/**
 * A controlled `gh` executable on PATH, so the operation runs over the REAL default transport. It models the GitHub REST
 * endpoints the operation uses, refuses a contents PUT without a blob sha on an existing path as GitHub does, and records
 * every call.
 */
function stubbedRemote(t: TestContext, initial: Pick<RemoteState, "refs" | "commits">) {
  const dir = ownedFixtureDir(t, "runner-proposal-gh").dir;
  const statePath = join(dir, "state.json");
  const save = (state: RemoteState) => writeFileSync(statePath, JSON.stringify(state));
  save({ ...initial, pulls: [], reviews: {}, lose: [], calls: [] });
  const script = `#!${process.execPath}
const fs = require("node:fs"); const crypto = require("node:crypto");
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = (code, message) => { save(); process.stderr.write("gh: " + message + " (HTTP " + code + ")\\n"); process.exit(1); };
const ok = (value) => { save(); process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (args[0] !== "api") fail(400, "unexpected command");
let method = "GET"; let path; const fields = {};
for (let i = 1; i < args.length; i++) {
  if (args[i] === "-X") method = args[++i];
  else if (args[i] === "-f") { const field = args[++i]; const at = field.indexOf("="); fields[field.slice(0, at)] = field.slice(at + 1); }
  else if (path === undefined) path = args[i];
}
state.calls.push({ method, path, fields });
if (state.outage && state.outage.armed && state.outage.count > 0) { state.outage.count--; fail(502, "Bad Gateway"); }
const sha = (value) => crypto.createHash("sha1").update(value).digest("hex");
const prefix = "repos/fixture/target";
if (path === prefix) ok({ id: 42, name: "target", owner: { login: "fixture" }, private: true, default_branch: "main" });
if (!path.startsWith(prefix + "/")) fail(404, "Not Found");
const [route, query = ""] = path.slice(prefix.length + 1).split("?");
const params = new URLSearchParams(query);
const resolve = (ref) => state.commits[ref] ? ref : state.refs[ref];
const tree = (commit, dir) => {
  const rows = new Map();
  for (const [file, content] of Object.entries(state.commits[commit].files)) {
    if (dir && !file.startsWith(dir + "/")) continue;
    const rest = dir ? file.slice(dir.length + 1) : file;
    const [head, ...tail] = rest.split("/");
    rows.set(head, tail.length ? { path: head, mode: "040000", type: "tree", sha: sha("tree:" + commit + ":" + (dir ? dir + "/" : "") + head) }
      : { path: head, mode: "100644", type: "blob", sha: sha("blob:" + content), size: Buffer.byteLength(content) });
  }
  return [...rows.values()];
};
const writeDone = (label) => {
  if (state.outage && !state.outage.armed && label === state.outage.after) state.outage.armed = true;
  const lost = state.lose.indexOf(label);
  if (lost >= 0) { state.lose.splice(lost, 1); fail(502, "Bad Gateway"); }
};
let match;
if (method === "GET" && (match = /^commits\\/([0-9a-f]{40})\\/pulls$/.exec(route))) ok(state.pulls.filter((pull) => pull.merge_commit_sha === match[1]));
if (method === "GET" && /^commits\\/[0-9a-f]{40}\\/check-runs$/.test(route)) ok({ check_runs: [] });
if (method === "GET" && (match = /^commits\\/(.+)$/.exec(route))) { const at = resolve(decodeURIComponent(match[1])); at ? ok({ sha: at }) : fail(404, "Not Found"); }
if (method === "GET" && (match = /^git\\/trees\\/([0-9a-f]{40})$/.exec(route))) {
  if (state.commits[match[1]]) ok({ truncated: false, tree: tree(match[1], "") });
  for (const commit of Object.keys(state.commits)) for (const file of Object.keys(state.commits[commit].files)) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) { const dir = parts.slice(0, i).join("/"); if (sha("tree:" + commit + ":" + dir) === match[1]) ok({ truncated: false, tree: tree(commit, dir) }); }
  }
  fail(404, "Not Found");
}
if (method === "GET" && (match = /^git\\/blobs\\/([0-9a-f]{40})$/.exec(route))) {
  for (const commit of Object.values(state.commits)) for (const content of Object.values(commit.files)) if (sha("blob:" + content) === match[1])
    ok({ sha: match[1], encoding: "base64", size: Buffer.byteLength(content), content: Buffer.from(content).toString("base64") });
  fail(404, "Not Found");
}
if (method === "GET" && (match = /^git\\/ref\\/heads\\/(.+)$/.exec(route))) { const at = state.refs[match[1]]; at ? ok({ ref: "refs/heads/" + match[1], object: { sha: at } }) : fail(404, "Not Found"); }
if (method === "POST" && route === "git/refs") {
  const name = fields.ref.replace(/^refs\\/heads\\//, "");
  if (state.refs[name]) fail(422, "Reference already exists");
  if (!state.commits[fields.sha]) fail(422, "Object does not exist");
  state.refs[name] = fields.sha; writeDone("POST git/refs"); ok({ ref: fields.ref, object: { sha: fields.sha } });
}
if (method === "GET" && (match = /^compare\\/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$/.exec(route))) {
  let ahead = 0; let at = match[2];
  while (at !== match[1]) { if (!at) ok({ status: "diverged", ahead_by: ahead, behind_by: 1, files: [] }); ahead++; at = state.commits[at].parent; }
  const base = state.commits[match[1]].files; const tip = state.commits[match[2]].files;
  const files = Object.keys(tip).filter((file) => base[file] !== tip[file]).map((file) => ({ filename: file, status: file in base ? "modified" : "added" }));
  ok({ status: ahead ? "ahead" : "identical", ahead_by: ahead, behind_by: 0, files });
}
if ((match = /^contents\\/(.+)$/.exec(route))) {
  const file = match[1];
  if (method === "GET") {
    const at = resolve(params.get("ref") ?? "main");
    const content = at ? state.commits[at].files[file] : undefined;
    content === undefined ? fail(404, "Not Found") : ok({ type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") });
  }
  if (method === "PUT") {
    const branch = fields.branch; const at = state.refs[branch];
    if (!at) fail(404, "Branch not found");
    if (file in state.commits[at].files && !fields.sha) fail(422, "sha wasn't supplied");
    const files = { ...state.commits[at].files, [file]: Buffer.from(fields.content, "base64").toString("utf8") };
    const next = sha("commit:" + at + ":" + JSON.stringify(files));
    state.commits[next] = { parent: at, files }; state.refs[branch] = next;
    writeDone("PUT contents"); ok({ commit: { sha: next } });
  }
}
if (route === "pulls" && method === "GET") ok(state.pulls.filter((pull) => (params.get("state") === "all" || pull.state === params.get("state")) && "fixture:" + pull.head.ref === params.get("head")));
if (route === "pulls" && method === "POST") {
  const number = state.pulls.length + 1;
  state.pulls.push({ number, html_url: "https://github.com/fixture/target/pull/" + number, state: "open", head: { ref: fields.head }, base: { ref: fields.base },
    merged_at: null, merge_commit_sha: null, title: fields.title, body: fields.body });
  writeDone("POST pulls"); ok(state.pulls.at(-1));
}
if (method === "GET" && (match = /^pulls\\/(\\d+)\\/reviews$/.exec(route))) ok(state.reviews[match[1]] ?? []);
if (method === "GET" && (match = /^pulls\\/(\\d+)$/.exec(route))) { const pull = state.pulls.find((p) => p.number === Number(match[1])); pull ? ok(pull) : fail(404, "Not Found"); }
fail(404, "Not Found");
`;
  const bin = ghStubPath(script);
  const previous = process.env.PATH;
  process.env.PATH = pathWith(bin);
  t.after(() => {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    rmSync(dirname(bin), { recursive: true, force: true });
  });
  return {
    read: (): RemoteState => JSON.parse(readFileSync(statePath, "utf8")) as RemoteState,
    update(change: (state: RemoteState) => void) { const state = this.read(); change(state); save(state); },
  };
}

/** A serving install with a committed mounts table, a bound product, and a target whose main holds only a README. */
function fixture(t: TestContext, targetFiles: Record<string, string> = { "README.md": "# target\n" }) {
  const source = gitRepo({ scope: t });
  mkdirSync(join(source.dir, ".remudero"));
  writeFileSync(join(source.dir, ".remudero/mounts.yaml"), table);
  source.git("add", ".remudero/mounts.yaml");
  source.git("commit", "-qm", "chore: source table");
  const head = createHash("sha1").update("head").digest("hex");
  const gh = stubbedRemote(t, { refs: { main: head }, commits: { [head]: { parent: null, files: targetFiles } } });
  const root = ownedFixtureDir(t, "runner-proposal").dir;
  const store = new ProductIntentStore({ root });
  const saved = store.write("clerk:alice", { version: "product-intent-v1", requestId: "proposal-create-001", expectedRevision: 0, brief: { idea: "proposal fixture" } });
  assert.ok(saved.ok);
  const productId = saved.value.receipt.productId;
  assert.ok(store.transition("clerk:alice", { version: "product-intent-v1", requestId: "proposal-bind-00001", id: productId,
    expectedRevision: 1, expectedObjectiveRevision: 1, repository }).ok);
  const reviewedMerge: ReviewedMergeRead = (repo, at) => ghProductBuildTarget().bootstrap(repo, at);
  const options = { root, store, installRoot: source.dir, reviewedMerge };
  const command = (overrides: Record<string, unknown> = {}) => ({ version: RUNNER_CONFIG_PROPOSAL_VERSION, requestId: "proposal-request-0001", productId,
    expectedRevision: 2, expectedObjectiveRevision: 1, targetHead: head, configDigest: digest(table), ...overrides });
  const writes = () => gh.read().calls.filter(call => call.method !== "GET");
  return { gh, root, store, options, command, head, productId, writes, branch: `remudero/runner-config-${head.slice(0, 12)}-${digest(table).slice(0, 12)}` };
}

/** Merges the open pull into main the way a human would, optionally with drifted bytes or a review. */
function merge(f: ReturnType<typeof fixture>, review: "APPROVED" | "CHANGES_REQUESTED" | undefined, bytes = table) {
  f.gh.update(state => {
    const files = { ...state.commits[state.refs.main!]!.files, ".remudero/mounts.yaml": bytes };
    const merged = createHash("sha1").update(`merge:${JSON.stringify(files)}`).digest("hex");
    state.commits[merged] = { parent: state.refs.main!, files };
    state.refs.main = merged;
    Object.assign(state.pulls[0]!, { state: "closed", merged_at: "2026-11-19T12:00:00Z", merge_commit_sha: merged });
    if (review) state.reviews["1"] = [{ state: review, user: { login: "operator" } }];
  });
}

test("W1-T11197 criterion 1: an accepted digest opens exactly one add-only pull request and reconciles; present, stale, moved and foreign states refuse", async t => {
  const noDefaultWrite = (f: ReturnType<typeof fixture>) => {
    for (const call of f.writes()) {
      assert.notEqual(call.fields.branch, "main", "never writes the default branch");
      assert.ok(!/merge|reviews|protection|DELETE/.test(`${call.method} ${call.path}`), `no merge, review, protection or delete call: ${call.path}`);
      assert.notEqual(call.method, "DELETE");
      assert.notEqual(call.method, "PATCH");
    }
  };

  await t.test("happy path: one branch at the exact head, one added file, one pull request, one proposed evidence item", async t => {
    const f = fixture(t);
    const result = await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command());
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(violations(result.value, declaredBody("/v1/products/runner-config-proposal", "POST", 200)), []);
    assert.equal(result.value.state, "open");
    assert.equal(result.value.replayed, false);
    assert.deepEqual(result.value.proposal.pullRequest, { number: 1, url: "https://github.com/fixture/target/pull/1" });
    const state = f.gh.read();
    assert.deepEqual(f.writes().map(call => `${call.method} ${call.path}`),
      ["POST repos/fixture/target/git/refs", "PUT repos/fixture/target/contents/.remudero/mounts.yaml", "POST repos/fixture/target/pulls"]);
    assert.equal(f.writes()[0]!.fields.sha, f.head);
    assert.equal(f.writes()[1]!.fields.sha, undefined, "the contents PUT carries no blob sha");
    assert.equal(state.refs.main, f.head, "main never moves");
    const tip = state.commits[state.refs[f.branch]!]!;
    assert.equal(tip.parent, f.head);
    assert.deepEqual(tip.files, { "README.md": "# target\n", ".remudero/mounts.yaml": table });
    assert.equal(state.pulls[0]!.base.ref, "main");
    const body = (state.pulls[0] as unknown as { body: string }).body;
    assert.ok(body.includes(digest(table)), "the body names the digest");
    assert.ok(body.includes(f.head), "the body names the exact head");
    assert.match(body, /A human must review and merge/);
    const product = f.store.read("clerk:alice", f.productId);
    assert.ok(product.ok);
    assert.deepEqual(product.value.stageEvidence.map(item => [item.stage, item.outcome, item.references[0]!.url]),
      [["repository", "proposed", "https://github.com/fixture/target/pull/1"]]);
    const journal = join(f.root, "state/products/v1/runner-config");
    assert.equal(readFileSync(join(journal, `${createHash("sha256").update("clerk:alice").digest("hex")}.json`), "utf8").includes("\"phase\":\"proposed\""), true);
    // Replays, a reload under a new key, and another owner never create anything else.
    const replay = await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command());
    assert.ok(replay.ok);
    assert.equal(replay.value.replayed, true);
    assert.deepEqual(replay.value.proposal, result.value.proposal);
    const reloaded = await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command({ requestId: "proposal-request-0002", expectedRevision: 3 }));
    assert.ok(reloaded.ok);
    assert.deepEqual(reloaded.value.proposal.pullRequest, result.value.proposal.pullRequest);
    assert.deepEqual(await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command({ configDigest: "0".repeat(64) })), { ok: false, code: "idempotency_conflict" });
    assert.equal((await proposeRunnerConfigBootstrap(f.options, "clerk:bob", f.command({ requestId: "proposal-request-0003" }))).ok, false);
    assert.equal(f.writes().length, 3);
    noDefaultWrite(f);
  });

  for (const lost of ["POST git/refs", "PUT contents", "POST pulls"]) {
    await t.test(`a lost ${lost} response reconciles by reading, never by a second create`, async t => {
      const f = fixture(t);
      f.gh.update(state => { state.lose.push(lost); });
      const result = await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command());
      assert.ok(result.ok, JSON.stringify(result));
      const state = f.gh.read();
      assert.equal(Object.keys(state.refs).length, 2, "exactly one new branch");
      assert.equal(state.pulls.length, 1, "exactly one pull request");
      assert.equal(f.writes().length, 3, "no write is retried");
      noDefaultWrite(f);
    });
  }

  await t.test("an outage after the branch write is outcome_unknown; the identical command after restart finishes with no second branch or PR", async t => {
    const f = fixture(t);
    f.gh.update(state => { state.outage = { after: "POST git/refs", count: 1000 }; });
    assert.deepEqual(await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command()), { ok: false, code: "outcome_unknown" });
    f.gh.update(state => { delete state.outage; });
    // A restart: a fresh store over the same root, so only the durable journal carries the intent.
    const restarted = { ...f.options, store: new ProductIntentStore({ root: f.root }) };
    const result = await proposeRunnerConfigBootstrap(restarted, "clerk:alice", f.command());
    assert.ok(result.ok, JSON.stringify(result));
    const state = f.gh.read();
    assert.equal(Object.keys(state.refs).length, 2);
    assert.equal(state.pulls.length, 1);
    assert.equal(f.writes().filter(call => call.path.endsWith("git/refs")).length, 1, "the branch is created once");
    noDefaultWrite(f);
  });

  await t.test("the journaled intent survives a crash after the file write even when main moves before the retry", async t => {
    const f = fixture(t);
    f.gh.update(state => { state.outage = { after: "PUT contents", count: 1000 }; });
    assert.deepEqual(await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command()), { ok: false, code: "outcome_unknown" });
    f.gh.update(state => {
      delete state.outage;
      const moved = createHash("sha1").update("unrelated").digest("hex");
      state.commits[moved] = { parent: f.head, files: { "README.md": "# target, edited\n" } };
      state.refs.main = moved;
    });
    const restarted = { ...f.options, store: new ProductIntentStore({ root: f.root }) };
    const result = await proposeRunnerConfigBootstrap(restarted, "clerk:alice", f.command());
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.value.proposal.branch, f.branch, "the pull request is for the branch already written, not a second one");
    const state = f.gh.read();
    assert.equal(Object.keys(state.refs).length, 2, "exactly one proposal branch");
    assert.equal(state.pulls.length, 1);
    noDefaultWrite(f);
  });

  await t.test("concurrent duplicates open one pull request", async t => {
    const f = fixture(t);
    const results = await Promise.all([1, 2, 3].map(() => proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command())));
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    assert.equal(new Set(results.map(result => result.ok && result.value.proposal.pullRequest.number)).size, 1);
    assert.equal(f.gh.read().pulls.length, 1);
    assert.equal(f.writes().length, 3);
  });

  await t.test("an existing runner configuration is preserved and refused", async t => {
    const f = fixture(t, { "README.md": "# target\n", ".remudero/mounts.yaml": table });
    assert.deepEqual(await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command()), { ok: false, code: "runner_config_present" });
    assert.equal(f.writes().length, 0);
  });

  await t.test("a stale digest and a moved head refuse before any write", async t => {
    const f = fixture(t);
    assert.deepEqual(await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command({ configDigest: "a".repeat(64) })), { ok: false, code: "stale_preview" });
    assert.deepEqual(await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command({ requestId: "proposal-request-0009", targetHead: "b".repeat(40) })),
      { ok: false, code: "stale_preview" });
    assert.deepEqual(await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command({ requestId: "proposal-request-0010", expectedRevision: 1 })),
      { ok: false, code: "stale_revision" });
    assert.equal(f.writes().length, 0);
  });

  await t.test("a foreign branch with the proposal's name refuses and is left alone", async t => {
    const f = fixture(t);
    f.gh.update(state => {
      const foreign = createHash("sha1").update("foreign").digest("hex");
      state.commits[foreign] = { parent: f.head, files: { "README.md": "# target\n", "other.txt": "x" } };
      state.refs[f.branch] = foreign;
    });
    assert.deepEqual(await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command()), { ok: false, code: "branch_conflict" });
    assert.equal(f.writes().length, 0);
  });

  await t.test("merged with approval and identical bytes reads merged; unapproved and drifted merges never do", async t => {
    for (const [review, bytes, expected] of [["APPROVED", table, "merged"], [undefined, table, "merged_unreviewed"],
      ["CHANGES_REQUESTED", table, "merged_unreviewed"], ["APPROVED", `${table}# drift\n`, "merged_drifted"]] as const) {
      await t.test(expected + (review ? `:${review}` : ""), async t => {
        const f = fixture(t);
        assert.ok((await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command())).ok);
        merge(f, review, bytes);
        const read = await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command());
        assert.ok(read.ok);
        assert.equal(read.value.state, expected);
        assert.equal(f.writes().length, 3);
      });
    }
  });

  await t.test("a closed-unmerged proposal is reported, and a new request proposes again", async t => {
    const f = fixture(t);
    assert.ok((await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command())).ok);
    f.gh.update(state => { state.pulls[0]!.state = "closed"; });
    const read = await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command());
    assert.ok(read.ok);
    assert.equal(read.value.state, "closed_unmerged");
    const again = await proposeRunnerConfigBootstrap(f.options, "clerk:alice", f.command({ requestId: "proposal-request-0004", expectedRevision: 3 }));
    assert.ok(again.ok, JSON.stringify(again));
    assert.equal(again.value.state, "open");
    assert.equal(again.value.proposal.pullRequest.number, 2);
    assert.equal(f.writes().filter(call => call.path.endsWith("git/refs") || call.path.includes("contents")).length, 2, "the existing branch is reused");
    noDefaultWrite(f);
  });
});
