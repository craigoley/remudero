import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hydrateDependencyMainIdentitiesSteps } from "#src/lib/dependency-main-identity.js";
import { runGhReadSteps, type OpenPrRest, type PlanFilingFileObservation } from "#src/lib/open-prs-rest.js";
import { buildSweepEffects, fixBranchClaimKey } from "#src/run-task.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { acquireInflightLock, inflightLockPath } from "#src/lib/inflight-lock.js";
import { buildOpenPrViewsAsync } from "#src/lib/tick-read-worker.js";

const HEAD = "c".repeat(40), MAIN = "a".repeat(40), HEAD_TREE = "d".repeat(40), MAIN_TREE = "e".repeat(40), BLOB = "f".repeat(40);
function fixture() {
  const candidate: OpenPrRest = { number: 13446, url: "https://github.com/o/r/pull/13446", headRefName: "dependabot/npm/sdk", headRefOid: HEAD,
    updatedAt: new Date().toISOString(), body: "", autoMergeRequest: null, contributionOrigin: { actor: { login: "dependabot[bot]" } } };
  const metadata = { state: "open", merged: false, draft: false, head: { sha: HEAD, ref: candidate.headRefName }, base: { ref: "main", sha: MAIN }, user: { login: "dependabot[bot]" }, changed_files: 2 };
  const files = ["package.json", "package-lock.json"].map(filename => ({ filename, status: "modified", sha: BLOB }));
  const tree = (sha: string) => ({ sha, truncated: false, tree: files.map(file => ({ path: file.filename, mode: "100644", type: "blob", sha: file.sha })) });
  const responses = new Map<string, unknown>([
    ["repos/o/r/commits/main", { sha: MAIN }], ["repos/o/r/pulls/13446", metadata], ["repos/o/r/pulls/13446/files?per_page=100", files],
    [`repos/o/r/git/commits/${HEAD}`, { sha: HEAD, tree: { sha: HEAD_TREE } }], [`repos/o/r/git/commits/${MAIN}`, { sha: MAIN, tree: { sha: MAIN_TREE } }],
    [`repos/o/r/git/trees/${HEAD_TREE}`, tree(HEAD_TREE)], [`repos/o/r/git/trees/${MAIN_TREE}`, tree(MAIN_TREE)],
  ]);
  const calls: string[] = [];
  const fetch = (args: string[]) => { const path = args[1]; calls.push(path); if (!responses.has(path)) throw new Error(`unexpected ${path}`); return responses.get(path); };
  const observations = new Map<number, PlanFilingFileObservation>([[candidate.number, { state: "complete", cache: "miss", paths: files.map(f => f.filename) }]]);
  const cacheOwner = {};
  const observe = () => runGhReadSteps(hydrateDependencyMainIdentitiesSteps("o", "r", [candidate], observations, fetch, cacheOwner)).get(candidate.number);
  return { candidate, metadata, files, responses, calls, fetch, observations, observe };
}

test("Dependabot whole-path immutable content and regular modes prove already-landed dependency changes without emptying changedFiles", () => {
  const f = fixture();
  const proof = f.observe();
  assert.equal(proof?.state, "identical");
  if (proof?.state !== "identical") assert.fail("expected immutable proof");
  assert.equal(proof.headSha, HEAD); assert.equal(proof.mainSha, MAIN); assert.equal(proof.files.length, 2);
  assert.deepEqual(f.observations.get(13446), { state: "complete", cache: "miss", paths: ["package.json", "package-lock.json"] });
  const reads = f.calls.length; assert.deepEqual(f.observe(), proof); assert.equal(f.calls.length, reads + 1, "immutable cache still pins fresh main");
});

for (const fault of ["bytes", "mode", "symlink", "submodule", "missing", "truncated", "tree-sha", "duplicate", "count", "renamed", "deleted", "blob-binding", "head", "base", "base-sha", "closed", "author", "unreadable"] as const) {
  test(`dependency identity refuses ${fault} evidence`, () => {
    const f = fixture();
    const main = f.responses.get(`repos/o/r/git/trees/${MAIN_TREE}`) as { sha: string; truncated: boolean; tree: Array<{ path: string; mode: string; type: string; sha: string }> };
    if (fault === "bytes") main.tree[0].sha = "1".repeat(40);
    if (fault === "mode") main.tree[0].mode = "100755";
    if (fault === "symlink") main.tree[0].mode = "120000";
    if (fault === "submodule") { main.tree[0].mode = "160000"; main.tree[0].type = "commit"; }
    if (fault === "missing") main.tree.pop();
    if (fault === "truncated") main.truncated = true;
    if (fault === "tree-sha") main.sha = "1".repeat(40);
    if (fault === "duplicate") f.files[1].filename = f.files[0].filename;
    if (fault === "count") f.metadata.changed_files = 3;
    if (fault === "renamed") f.files[0].status = "renamed";
    if (fault === "deleted") f.files[0].status = "removed";
    if (fault === "blob-binding") f.files[0].sha = "1".repeat(40);
    if (fault === "head") f.metadata.head.sha = "1".repeat(40);
    if (fault === "base") f.metadata.base.ref = "other";
    if (fault === "base-sha") f.metadata.base.sha = "1".repeat(40);
    if (fault === "closed") f.metadata.state = "closed";
    if (fault === "author") f.metadata.user.login = "cao825";
    if (fault === "unreadable") f.responses.delete("repos/o/r/pulls/13446");
    assert.notEqual(f.observe()?.state, "identical");
  });
}

test("non-bot, incomplete, duplicate, mixed-scope and unsupported nested manifest observations are inert without network", () => {
  for (const fault of ["author", "draft", "incomplete", "duplicate", "scope", "nested"] as const) {
    const f = fixture();
    if (fault === "draft") f.candidate.isDraft = true;
    if (fault === "author") f.candidate.contributionOrigin = { actor: { login: "cao825" } };
    if (fault === "incomplete") f.observations.set(13446, { state: "unreadable", reason: "per-pass-cap" });
    if (fault === "duplicate") f.observations.set(13446, { state: "complete", cache: "miss", paths: ["package.json", "package.json"] });
    if (fault === "scope") f.observations.set(13446, { state: "complete", cache: "miss", paths: ["package.json", "src/other.ts"] });
    if (fault === "nested") f.observations.set(13446, { state: "complete", cache: "miss", paths: ["fixture/package.json"] });
    assert.equal(f.observe(), undefined); assert.equal(f.calls.length, 0);
  }
});

test("nested workflow manifest path is walked through each directory tree before its blob is compared", () => {
  const WF = ".github/workflows/ci.yml", GH_TREE = "1".repeat(40), WF_TREE = "2".repeat(40), FILE = "3".repeat(40);
  const setup = (parentType: string) => {
    const f = fixture();
    f.metadata.changed_files = 1;
    f.responses.set("repos/o/r/pulls/13446/files?per_page=100", [{ filename: WF, status: "modified", sha: FILE }]);
    f.observations.set(13446, { state: "complete", cache: "miss", paths: [WF] });
    const treeOf = (sha: string, tree: Array<{ path: string; mode: string; type: string; sha: string }>) => ({ sha, truncated: false, tree });
    f.responses.set(`repos/o/r/git/trees/${HEAD_TREE}`, treeOf(HEAD_TREE, [{ path: ".github", mode: "040000", type: parentType, sha: GH_TREE }]));
    f.responses.set(`repos/o/r/git/trees/${MAIN_TREE}`, treeOf(MAIN_TREE, [{ path: ".github", mode: "040000", type: parentType, sha: GH_TREE }]));
    f.responses.set(`repos/o/r/git/trees/${GH_TREE}`, treeOf(GH_TREE, [{ path: "workflows", mode: "040000", type: "tree", sha: WF_TREE }]));
    f.responses.set(`repos/o/r/git/trees/${WF_TREE}`, treeOf(WF_TREE, [{ path: "ci.yml", mode: "100644", type: "blob", sha: FILE }]));
    return f;
  };
  const ok = setup("tree"), proof = ok.observe();
  assert.equal(proof?.state, "identical");
  if (proof?.state === "identical") assert.deepEqual(proof.files, [{ path: WF, mode: "100644", blob: FILE }]);
  assert.ok(ok.calls.includes(`repos/o/r/git/trees/${GH_TREE}`)); assert.ok(ok.calls.includes(`repos/o/r/git/trees/${WF_TREE}`));
  const bad = setup("blob").observe();
  assert.equal(bad?.state, "unavailable");
  if (bad?.state === "unavailable") assert.match(bad.reason, /non-directory parent/);
});

test("moved main invalidates immutable identity cache; failed reads are never cached as facts", () => {
  const f = fixture(); assert.equal(f.observe()?.state, "identical");
  f.responses.set("repos/o/r/commits/main", { sha: "2".repeat(40) });
  assert.equal(f.observe()?.state, "unavailable");
  f.responses.set("repos/o/r/commits/main", { sha: MAIN });
  assert.equal(f.observe()?.state, "identical");
  const other = fixture(); other.responses.delete(`repos/o/r/git/trees/${MAIN_TREE}`);
  assert.equal(other.observe()?.state, "unavailable");
  other.responses.set(`repos/o/r/git/trees/${MAIN_TREE}`, f.responses.get(`repos/o/r/git/trees/${MAIN_TREE}`));
  assert.equal(other.observe()?.state, "identical");
});

test("default async open-PR producer yields and paces actual dependency identity API reads", async () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), "rmd-dependency-identity-")), ledger = join(dir, "ledger.ndjson");
  writeFileSync(ledger, "");
  let waits = 0;
  try {
    const views = await buildOpenPrViewsAsync("o", "r", ledger, {
      readMainPlan: () => ({ tasks: [], byId: new Map() }), readCiGateRequired: () => [],
      readRequiredContextsAsync: async () => ({ kind: "contexts", contexts: [] }),
      pacer: { wait: () => assert.fail("async producer must not block"), waitAsync: async () => { waits++; }, recordResult: () => {} },
      fetchAsync: async args => {
        if (args[1] === "repos/o/r/pulls?state=open&per_page=100") return [{ ...f.metadata, number: 13446, html_url: f.candidate.url, updated_at: f.candidate.updatedAt, body: "", auto_merge: null }];
        if (args[1] === "repos/o/r/pulls/13446") return { ...f.metadata, mergeable: true, mergeable_state: "blocked" };
        if (f.responses.has(args[1])) return f.fetch(args);
        if (/check-runs/.test(args[1])) return { check_runs: [] };
        if (/\/status$/.test(args[1])) return { statuses: [] };
        if (/actions\/runs/.test(args[1])) return { workflow_runs: [] };
        return [];
      },
    });
    assert.equal(views.length, 1); assert.equal(views[0].dependencyMainIdentity?.state, "identical");
    assert.deepEqual(views[0].changedFiles, ["package.json", "package-lock.json"]);
    assert.equal(waits, 9, "enumeration plus eight identity reads all use shared asynchronous pacing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function view(): OpenPrView {
  return { prNumber: 13446, prUrl: "https://github.com/o/r/pull/13446", headSha: HEAD, headRefName: "dependabot/npm/sdk",
    isDependabot: true, reviewState: "success", checksState: "red", autoMergeArmed: true, unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date().toISOString(), changedFiles: ["package.json", "package-lock.json"],
    dependencyMainIdentity: { state: "identical", headSha: HEAD, mainSha: MAIN, files: ["package.json", "package-lock.json"].map(path => ({ path, mode: "100644", blob: BLOB })) } };
}
function effectFixture() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-dependency-close-"));
  const f = fixture(), pr = view(), claims = join(dir, "state", "inflight"), key = fixBranchClaimKey("o", "r", pr.headRefName!);
  const posts: string[][] = [];
  let onRead: (() => void) | undefined;
  const effects = buildSweepEffects({ owner: "o", repo: "r", config: { root: dir } as never, repoRoot: dir,
    ledgerPath: join(dir, "state", "ledger.ndjson"), runId: "dependency-close-test", plan: { tasks: [], byId: new Map() },
    policy: DEFAULT_SWEEP_POLICY, log: () => {},
    readJsonImpl: async args => { onRead?.(); return f.fetch(args); },
    ghRunImpl: (_file, args) => { posts.push([...args]); return ""; },
  });
  const run = async () => effects.withDependencyCloseFence!(pr, async () => { await effects.close(pr, "immutable dependency identity"); });
  return { dir, f, pr, claims, key, posts, effects, run, onRead: (fn: () => void) => { onRead = fn; } };
}

test("default dependency close holds the canonical branch mutex through fresh reads and ordinary branch-preserving close", async () => {
  const f = effectFixture();
  try {
    let protectedReads = 0;
    f.onRead(() => {
      protectedReads++;
      assert.throws(() => acquireInflightLock(f.claims, f.key, { run_id: "competing-native-fix", reclaim: false }), { code: "EEXIST" });
      assert.equal(JSON.parse(readFileSync(inflightLockPath(f.claims, f.key), "utf8")).run_id, "dependency-close-test");
    });
    assert.deepEqual(await f.run(), { closed: true }); assert.equal(protectedReads, 2);
    assert.equal(f.posts.length, 1); assert.deepEqual(f.posts[0].slice(0, 3), ["pr", "close", f.pr.prUrl]);
    assert.ok(!f.posts[0].includes("--delete-branch")); assert.equal(existsSync(inflightLockPath(f.claims, f.key)), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const fault of ["main", "head", "terminal", "malformed", "author", "base", "count", "read-error", "owner", "garbage-owner", "invalid-claim-dir", "live-draft", "unknown-live-draft", "close-error"] as const) {
  test(`default dependency close stands down on ${fault} and releases only its own claim`, async () => {
    const f = effectFixture();
    try {
      if (fault === "main") f.f.responses.set("repos/o/r/commits/main", { sha: "2".repeat(40) });
      if (fault === "head") f.f.metadata.head.sha = "2".repeat(40);
      if (fault === "terminal") f.f.metadata.state = "closed";
      if (fault === "malformed") f.f.responses.set("repos/o/r/pulls/13446", {});
      if (fault === "author") f.f.metadata.user.login = "cao825";
      if (fault === "base") f.f.metadata.base.ref = "other";
      if (fault === "count") f.f.metadata.changed_files = 3;
      if (fault === "live-draft") f.f.metadata.draft = true;
      if (fault === "unknown-live-draft") f.f.responses.set("repos/o/r/pulls/13446", { ...f.f.metadata, draft: undefined });
      if (fault === "read-error") f.f.responses.delete("repos/o/r/pulls/13446");
      if (fault === "invalid-claim-dir") { mkdirSync(join(f.dir, "state"), { recursive: true }); writeFileSync(f.claims, "unreadable claim directory"); }
      if (fault === "close-error") f.effects.close = () => { throw new Error("close rejected"); };
      let release: (() => void) | undefined;
      if (fault === "owner") release = acquireInflightLock(f.claims, f.key, { run_id: "native-fix" }).release;
      if (fault === "garbage-owner") { mkdirSync(f.claims, { recursive: true }); writeFileSync(inflightLockPath(f.claims, f.key), "garbage"); }
      const result = await f.run(); assert.equal(result.closed, false); assert.equal(typeof result.reason, "string"); assert.equal(f.posts.length, 0);
      if (fault === "owner" || fault === "garbage-owner") assert.equal(existsSync(inflightLockPath(f.claims, f.key)), true);
      else assert.equal(existsSync(inflightLockPath(f.claims, f.key)), false);
      if (fault === "invalid-claim-dir") assert.equal(readFileSync(f.claims, "utf8"), "unreadable claim directory");
      release?.();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test("already-landed dependency sweep uses existing two-close budget despite historical terminal dep-review and refuses unwired fences", async () => {
  const f = effectFixture();
  try {
    mkdirSync(join(f.dir, "state"), { recursive: true });
    const ledgerPath = join(f.dir, "state", "ledger.ndjson");
    writeFileSync(ledgerPath, JSON.stringify({ step: "sweep.disposed", pr_number: 13446, head_sha: HEAD, disposition: "dep-review", dep_review_outcome: "arm", acted: true }) + "\n");
    const closed: number[] = [];
    const deps: SweepDeps = { ledgerPath, runId: "identity-sweep", arm: () => {}, dispatchFix: () => {}, escalate: () => {}, close: pr => { closed.push(pr.prNumber); },
      withDependencyCloseFence: async (_pr, close) => { await close(); return { closed: true }; }, depReview: () => "hold" };
    const candidates = [view(), { ...view(), prNumber: 13447 }, { ...view(), prNumber: 13448 }];
    await runSweep(candidates, deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(closed, [13446, 13447]);
    assert.equal(candidates[0].changedFiles?.length, 2);
    const rows = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(rows.filter(row => row.step === "sweep.disposed" && row.dependency_main_identity?.state === "identical" && row.acted).length, 2);
    closed.length = 0;
    await runSweep([{ ...view(), prNumber: 13449 }], { ...deps, withDependencyCloseFence: undefined }, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(closed, []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test("changed PR head during population observation never produces cached identity", () => {
  const f = fixture(); let reads = 0;
  const movingRead = (args: string[]) => {
    if (args[1] === "repos/o/r/pulls/13446" && ++reads === 2) return { ...f.metadata, head: { ...f.metadata.head, sha: "2".repeat(40) } };
    return f.fetch(args);
  };
  const result = runGhReadSteps(hydrateDependencyMainIdentitiesSteps("o", "r", [f.candidate], f.observations, movingRead, {})).get(13446);
  assert.equal(result?.state, "unavailable"); assert.equal(reads, 2);
});

test("dependency factual route respects existing operator merge holds and incomplete path populations", async () => {
  for (const fault of ["hold", "draft", "mismatched-paths", "unavailable", "head-binding"] as const) {
    const f = effectFixture();
    try {
      mkdirSync(join(f.dir, "state"), { recursive: true });
      const ledgerPath = join(f.dir, "state", "ledger.ndjson");
      const p = view();
      if (fault === "draft") p.isDraft = true;
      if (fault === "mismatched-paths") p.changedFiles = ["package.json"];
      if (fault === "unavailable") p.dependencyMainIdentity = { state: "unavailable", reason: "partial API population" };
      if (fault === "head-binding" && p.dependencyMainIdentity?.state === "identical") p.dependencyMainIdentity.headSha = "2".repeat(40);
      writeFileSync(ledgerPath, fault === "hold" ? JSON.stringify({ ts: new Date().toISOString(), step: "automerge.hold_engaged", authority: "interactive-cli", by: "operator", pr_number: 13446, reason: "operator review" }) + "\n" : "");
      let closeCalls = 0, fenceCalls = 0;
      const deps: SweepDeps = { ledgerPath, runId: `negative-${fault}`, arm: () => {}, dispatchFix: () => {}, escalate: () => {}, close: () => { closeCalls++; }, depReview: () => "hold",
        withDependencyCloseFence: async () => { fenceCalls++; return { closed: false }; } };
      await runSweep([p], deps, DEFAULT_SWEEP_POLICY);
      assert.equal(closeCalls, 0, fault); assert.equal(fenceCalls, 0, fault);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});


test("default factual producer carries failed and malformed main reads as unavailable, never absence or identity", () => {
  for (const failure of [undefined, {}, { sha: "partial" }]) {
    const f = fixture();
    if (failure === undefined) f.responses.delete("repos/o/r/commits/main");
    else f.responses.set("repos/o/r/commits/main", failure);
    const result = f.observe(); assert.equal(result?.state, "unavailable");
    if (result?.state === "unavailable") assert.match(result.reason, /main|unexpected/);
    assert.equal(f.calls.length, 1);
  }
});


test("existing stale disposition keeps its original reason and leaves both factual close slots available", async () => {
  const f = effectFixture();
  try {
    mkdirSync(join(f.dir, "state"), { recursive: true });
    const ledgerPath = join(f.dir, "state", "ledger.ndjson");
    const alreadyStale = { ...view(), prNumber: 13440, taskMergedBy: 13300 };
    assert.equal(deriveDisposition(alreadyStale, DEFAULT_SWEEP_POLICY).disposition, "stale");
    const closed: Array<{ number: number; reason: string }> = []; let fences = 0;
    const deps: SweepDeps = { ledgerPath, runId: "existing-stale", arm: () => {}, dispatchFix: () => {}, escalate: () => {},
      close: (pr, reason) => { closed.push({ number: pr.prNumber, reason }); }, depReview: () => "hold",
      withDependencyCloseFence: async (_pr, close) => { fences++; await close(); return { closed: true }; } };
    await runSweep([alreadyStale, view(), { ...view(), prNumber: 13447 }], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(closed.length, 3); assert.equal(fences, 2);
    assert.match(closed.find(pr => pr.number === 13440)!.reason, /already merged by #13300/);
    assert.equal(closed.filter(pr => /regular mode and blob already match main/.test(pr.reason)).length, 2);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("ordinary mergeable disposition retains its normal arm path despite unrelated immutable evidence", async () => {
  const f = effectFixture();
  try {
    mkdirSync(join(f.dir, "state"), { recursive: true });
    const ledgerPath = join(f.dir, "state", "ledger.ndjson");
    const pr: OpenPrView = { ...view(), isDependabot: false, checksState: "green", mergeableState: "clean", autoMergeArmed: false };
    assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY).disposition, "mergeable");
    let closes = 0, fences = 0, arms = 0;
    const deps: SweepDeps = { ledgerPath, runId: "ordinary-mergeable", arm: () => { arms++; }, dispatchFix: () => {}, escalate: () => {},
      close: () => { closes++; }, withDependencyCloseFence: async () => { fences++; return { closed: false }; } };
    await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(closes, 0); assert.equal(fences, 0); assert.equal(arms, 1);
    const rows = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map(row => JSON.parse(row));
    assert.equal(rows.find(row => row.step === "sweep.disposed")?.disposition, "mergeable");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
