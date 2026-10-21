import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { runTask } from "#src/run-task.js";
import * as amendments from "#src/lib/proof-amendment.js";
import type { ProofAmendmentWritePorts, ScopeAmendmentRequest } from "#src/lib/proof-amendment.js";
const { requestScopeAmendment, readBuildScopeRecovery } = amendments;
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult, spawnWorker } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TASK_ID = "W1-T990226";
const DECLARED = ["src/lib/ci-parity.ts", "src/lib/task-linter.ts", "scripts/diff-class.mjs"];
const LEFT_OUT = "src/lib/rule-suites.ts";
const SHARD = `plan/tasks.d/${TASK_ID}-fixture.yaml`;

const PLAN = [
  `- id: ${TASK_ID}`,
  "  title: a build that imports a left-out file asks for scope",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: high",
  "  band_meaning: span",
  `  files: [${DECLARED.join(", ")}]`,
  "  origin: test",
  "  status: queued",
  "  acceptance:",
  "    - claim: ci-parity reads the shared roster",
  "      proof: \"grep: RULE_SUITES in src/lib/ci-parity.ts\"",
  "",
].join("\n");

function worker(text: string): WorkerResult {
  return { sessionId: "fixture", costUsd: 0.01, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "test", effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}left-out-import-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, PLAN);
  const hooks = join(root, "empty-fixture-hooks");
  mkdirSync(hooks);
  const origin = gitRepo({ bare: true, kind: "left-out-import-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "left-out-import-seed" });
  seed.git("config", "core.hooksPath", hooks);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  mkdirSync(dirname(join(seed.dir, SHARD)), { recursive: true });
  writeFileSync(join(seed.dir, SHARD), PLAN);
  writeFileSync(join(seed.dir, "plan/tasks.yaml"), "[]\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repoDir = join(root, "repos", "remudero");
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "core.hooksPath", hooks]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "fixture@remudero.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero test fixture"]);
  const rows = () => readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const cleanup = () => { origin.cleanup(); seed.cleanup(); rmSync(root, { recursive: true, force: true }); };
  return { root, planPath, rows, cleanup, seed, repoDir };
}

/** The worker writes the declared files and one undeclared file, leaving the commit to the harness. */
function writingSpawn(files: Record<string, string>) {
  let calls = 0;
  return async (args: { cwd: string }) => {
    calls += 1;
    if (calls % 2 === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(args.cwd, path)), { recursive: true });
      writeFileSync(join(args.cwd, path), text);
    }
    return worker("REPORT\nshared the roster\nCOMMIT_MESSAGE: feat(ci): share the rule-suite roster\n");
  };
}

const IMPORTING = {
  "src/lib/ci-parity.ts": "import { RULE_SUITES } from \"./rule-suites.js\";\nexport const parity = RULE_SUITES;\n",
  "src/lib/task-linter.ts": "export { RULE_SUITES as LINTED } from \"./rule-suites.js\";\n",
  "scripts/diff-class.mjs": "import { RULE_SUITES } from \"../src/lib/rule-suites.ts\";\nconsole.log(RULE_SUITES);\n",
  [LEFT_OUT]: "export const RULE_SUITES = [\"a\"];\n",
};

async function dispatch(f: ReturnType<typeof fixture>, spawn: typeof spawnWorker,
  extra: Partial<Parameters<typeof runTask>[1]> = {}) {
  const created: string[][] = [];
  const result = await withLiveWritesAllowed(() => runTask(TASK_ID, {
    skipGitSync: true,
    owner: "acme",
    planPath: f.planPath,
    config: { claudeBin: "/bin/true", root: f.root, installRoot: process.cwd(), workerProviders: { harnessCommitsImplement: true } },
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    spawn,
    implementPush: async () => {},
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    otherOpenPrReader: async () => [],
    prOpenProofRunner: async () => ({ status: 0, stdout: "verdict:    pass" }),
    prCreateExec: (_command, args) => { created.push(args); return ""; },
    ...extra,
  }));
  return { result, created };
}


function amendmentIo(f: ReturnType<typeof fixture>) {
  const prs: Array<Parameters<ProofAmendmentWritePorts["createPr"]>[0]> = [];
  const io: NonNullable<Parameters<typeof runTask>[1]>["implementScopeAmendmentPortsIo"] = {
    gitPushFn: () => {}, probeExistingPlanPrFn: () => undefined,
    createPlanPrRestFn: (_fetch, _owner, _repo, opts) => {
      prs.push(opts);
      return { prUrl: "https://github.com/acme/remudero/pull/7", prNumber: 7 };
    },
    assertLiveWriteAllowedFn: () => {},
  };
  return { prs, io };
}

function saved(f: ReturnType<typeof fixture>) {
  const row = f.rows().findLast((r) => r.step === "implement.scope_needed");
  assert.equal(typeof row?.recovery_path, "string");
  const path = row!.recovery_path as string;
  const result = readBuildScopeRecovery(path, TASK_ID);
  if (result.status !== "verified") assert.fail(result.reason);
  return { path, data: result.data };
}

function mergeAmendment(f: ReturnType<typeof fixture>, branch: string) {
  const text = execFileSync("git", ["-C", f.repoDir, "show", `${branch}:${SHARD}`], { encoding: "utf8" });
  writeFileSync(join(f.seed.dir, SHARD), text);
  f.seed.git("add", SHARD);
  f.seed.git("commit", "-qm", "merge scope amendment");
  f.seed.git("push", "-q", "origin", "main");
  writeFileSync(f.planPath, text);
}

test("W1-T10070: a build with no PR opens a shard amendment for its companions", async () => {
  const f = fixture();
  try {
    const amendment = amendmentIo(f);
    const { result, created } = await dispatch(f, writingSpawn(IMPORTING) as typeof spawnWorker,
      { implementScopeAmendmentPortsIo: amendment.io });
    assert.equal(result.verdict, "no_pr");
    assert.equal(created.length, 0);
    assert.equal(amendment.prs.length, 1);
    const pr = amendment.prs[0]!;
    assert.match(pr.head, new RegExp(`^scope-amendment/${TASK_ID}-build-[a-f0-9]{20}$`));
    assert.match(pr.title, /files for its build$/);
    const changedShard = execFileSync("git", ["-C", f.repoDir, "show", `${pr.head}:${SHARD}`], { encoding: "utf8" });
    assert.deepEqual(parse(changedShard)[0].files.sort(), [...DECLARED, LEFT_OUT].sort());
    const recovery = saved(f);
    assert.equal(Buffer.from(recovery.data.companions[0]!.bytes, "base64").toString(), IMPORTING[LEFT_OUT]);
    const removed = f.rows().find((r) => r.step === "worktree.remove" && r.on === "implement.scope_needed");
    assert.ok(removed, "recovery exists after reclaim");
    assert.ok(f.rows().findIndex((r) => r.recovery_path === recovery.path) < f.rows().findIndex((r) => r.step === "worktree.remove" && r.on === "implement.scope_needed"));
    const waited = await dispatch(f, (async () => assert.fail("pending amendment must not spawn")) as typeof spawnWorker,
      { implementScopeAmendmentState: async () => "open" });
    assert.equal(waited.result.verdict, "blocked_inflight");
    assert.equal(f.rows().findLast((r) => r.step === "verdict")?.scopeAmendmentsPending, 1);
  } finally { f.cleanup(); }
});

test("W1-T10070: the saved companion seeds the re-dispatched build", async () => {
  const f = fixture();
  try {
    const amendment = amendmentIo(f);
    await dispatch(f, writingSpawn(IMPORTING) as typeof spawnWorker, { implementScopeAmendmentPortsIo: amendment.io });
    const recovery = saved(f);
    mergeAmendment(f, amendment.prs[0]!.head);
    let spawns = 0;
    const { created } = await dispatch(f, (async (args) => {
      spawns++;
      for (const [path, text] of Object.entries(IMPORTING)) assert.equal(readFileSync(join(args.cwd, path), "utf8"), text);
      if (spawns === 1) return worker("RECON REPORT\nOBSERVED: saved work is present\n");
      assert.match(args.prompt, /Recovered build work/);
      return worker("REPORT\nCOMMIT_MESSAGE: feat(ci): share the rule-suite roster\n");
    }) as typeof spawnWorker);
    assert.equal(spawns, 2);
    assert.equal(created.length, 1);
    assert.equal(f.rows().filter((r) => r.step === "implement.scope_restored").length, 1);
    const commit = f.rows().findLast((r) => r.step === "implement.harness_commit");
    assert.ok(commit?.sha);
    assert.equal(commit.undeclared, undefined);
    assert.equal(execFileSync("git", ["-C", f.repoDir, "show", `${commit!.sha}:${LEFT_OUT}`], { encoding: "utf8" }), IMPORTING[LEFT_OUT]);
    assert.ok(existsSync(recovery.path), "the durable save survives successful consumption");
  } finally { f.cleanup(); }
});

test("W1-T10070: an unverifiable save runs a fresh build and names it", async () => {
  const f = fixture();
  try {
    const amendment = amendmentIo(f);
    await dispatch(f, writingSpawn(IMPORTING) as typeof spawnWorker, { implementScopeAmendmentPortsIo: amendment.io });
    const recovery = saved(f);
    const tampered = JSON.parse(readFileSync(recovery.path, "utf8"));
    tampered.data.companions[0].bytes = Buffer.from("corrupted").toString("base64");
    writeFileSync(recovery.path, JSON.stringify(tampered));
    mergeAmendment(f, amendment.prs[0]!.head);
    let spawns = 0;
    const { created } = await dispatch(f, (async (args) => {
      spawns++;
      assert.equal(existsSync(join(args.cwd, LEFT_OUT)), false);
      if (spawns === 1) return worker("RECON REPORT\nOBSERVED: fresh build\n");
      assert.doesNotMatch(args.prompt, /Recovered build work/);
      for (const [path, text] of Object.entries(IMPORTING)) {
        mkdirSync(dirname(join(args.cwd, path)), { recursive: true });
        writeFileSync(join(args.cwd, path), text);
      }
      return worker("REPORT\nCOMMIT_MESSAGE: feat(ci): rebuild the rule-suite roster\n");
    }) as typeof spawnWorker);
    assert.equal(created.length, 1);
    assert.equal(f.rows().findLast((r) => r.step === "run.start")?.scope_recovery, "unverifiable");
    assert.match(String(f.rows().findLast((r) => r.step === "run.start")?.recovery_reason), /checksum/);
    assert.equal(f.rows().findLast((r) => r.step === "implement.scope_recovery_fresh")?.recovery_path, recovery.path);
  } finally { f.cleanup(); }
});

function writePorts(text = PLAN) {
  const writes: string[] = [];
  const prs: Array<Parameters<ProofAmendmentWritePorts["createPr"]>[0]> = [];
  const records = new Map();
  const ports: ProofAmendmentWritePorts = {
    repoDir: "/fixture", findShard: () => ({ path: SHARD, text }),
    worktreeAdd: () => {}, worktreeRemove: () => {}, writeFile: (_path, text) => { writes.push(text); },
    gitAdd: () => {}, gitCommit: () => "amendment", gitPush: () => {}, probeExisting: () => undefined,
    createPr: (pr) => { prs.push(pr); return { prUrl: "https://github.com/acme/remudero/pull/7", prNumber: 7 }; },
    worktreePathFor: () => "/fixture/amendment", lookupIdentity: (key) => records.get(key),
    recordIdentity: (key, value) => { records.set(key, value); },
    updateBranch: () => assert.fail("a build has no implementation branch to update"),
  };
  return { ports, writes, prs, records };
}

const buildRequest: ScopeAmendmentRequest = {
  kind: "build", taskId: TASK_ID, headRef: `run-${TASK_ID}-1`, prNumber: 0, prUrl: "", headSha: "head",
  paths: [LEFT_OUT], importers: ["src/consumer.ts"], changedPaths: [LEFT_OUT, "src/consumer.ts"],
};

test("a pre-PR amendment admits an observed undeclared importer and resumes by build identity", () => {
  const p = writePorts();
  const first = requestScopeAmendment(buildRequest, p.ports);
  assert.equal(first.kind, "created");
  assert.deepEqual(parse(p.writes[0]!)[0].files.sort(), [...DECLARED, LEFT_OUT, "src/consumer.ts"].sort());
  assert.match([...p.records.keys()][0], new RegExp(`^scope:${TASK_ID}:build:run-${TASK_ID}-1:`));
  assert.equal(requestScopeAmendment(buildRequest, p.ports).kind, "resumed");
  for (const [key, value] of p.records) p.records.set(key, { ...value, merged: true });
  assert.equal(requestScopeAmendment(buildRequest, p.ports).kind, "resumed");
  assert.equal(p.prs.length, 1);
});

test("pre-PR scope retains the path fence and requires the matching run branch", () => {
  for (const change of [
    { headRef: "feature/no-task" }, { headRef: "run-W1-T42-1" }, { prNumber: 7 },
    { paths: ["../escape"], changedPaths: ["../escape", "src/consumer.ts"] },
    { paths: ["plan/tasks.yaml"], changedPaths: ["plan/tasks.yaml", "src/consumer.ts"] },
    { importers: ["test/consumer.test.ts"], changedPaths: [LEFT_OUT, "test/consumer.test.ts"] },
    { importers: ["src/unobserved.ts"] },
  ]) {
    const p = writePorts();
    assert.equal(requestScopeAmendment({ ...buildRequest, ...change }, p.ports).kind, "refused");
    assert.deepEqual(p.writes, []);
    assert.deepEqual(p.prs, []);
  }
  const p = writePorts();
  assert.equal(requestScopeAmendment({ ...buildRequest, kind: undefined }, p.ports).kind, "refused");
});

test("a missing saved build is named before a fresh worker starts", async () => {
  const f = fixture();
  try {
    const amendment = amendmentIo(f);
    await dispatch(f, writingSpawn(IMPORTING) as typeof spawnWorker, { implementScopeAmendmentPortsIo: amendment.io });
    const recovery = saved(f);
    rmSync(recovery.path);
    mergeAmendment(f, amendment.prs[0]!.head);
    let spawns = 0;
    await dispatch(f, (async (args) => {
      spawns++;
      assert.equal(existsSync(join(args.cwd, LEFT_OUT)), false);
      assert.equal(f.rows().findLast((r) => r.step === "run.start")?.scope_recovery, "missing");
      return worker(spawns === 1 ? "RECON REPORT\nOBSERVED: fresh\n" : "REPORT\nfresh build has no edits\n");
    }) as typeof spawnWorker);
    assert.equal(spawns, 2);
    assert.match(String(f.rows().findLast((r) => r.step === "implement.scope_recovery_fresh")?.reason), /ENOENT/);
  } finally { f.cleanup(); }
});

test("a saved patch that conflicts with main leaves the fresh build clean and names the conflict", async () => {
  const f = fixture();
  try {
    const amendment = amendmentIo(f);
    await dispatch(f, writingSpawn(IMPORTING) as typeof spawnWorker, { implementScopeAmendmentPortsIo: amendment.io });
    mergeAmendment(f, amendment.prs[0]!.head);
    const path = DECLARED[0]!;
    mkdirSync(dirname(join(f.seed.dir, path)), { recursive: true });
    writeFileSync(join(f.seed.dir, path), "export const fromMain = true;\n");
    f.seed.git("add", path);
    f.seed.git("commit", "-qm", "independent main edit");
    f.seed.git("push", "-q", "origin", "main");
    let spawns = 0;
    await dispatch(f, (async (args) => {
      spawns++;
      assert.equal(readFileSync(join(args.cwd, path), "utf8"), "export const fromMain = true;\n");
      assert.equal(existsSync(join(args.cwd, LEFT_OUT)), false);
      assert.equal(execFileSync("git", ["-C", args.cwd, "status", "--porcelain"], { encoding: "utf8" }), "");
      return worker(spawns === 1 ? "RECON REPORT\nOBSERVED: fresh\n" : "REPORT\nfresh build has no edits\n");
    }) as typeof spawnWorker);
    assert.equal(spawns, 2);
    assert.match(String(f.rows().findLast((r) => r.step === "implement.scope_recovery_fresh")?.reason), /apply/);
  } finally { f.cleanup(); }
});

test("scope recovery reads the checked companion even if its pathname is replaced", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scope-recovery-race-`));
  const companion = join(root, "companion.ts");
  const replacement = join(root, "replacement.ts");
  writeFileSync(companion, "checked companion\n", { mode: 0o755 });
  writeFileSync(replacement, "unrelated content\n");
  const read = fs.readFileSync;
  let replaced = false;
  let checkedFd: number | undefined;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readFileSync>) => {
    if (!replaced && (args[0] === companion || typeof args[0] === "number")) {
      if (typeof args[0] === "number") checkedFd = args[0];
      replaced = true;
      renameSync(companion, join(root, "original.ts"));
      symlinkSync(replacement, companion);
    }
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    const path = amendments.saveBuildScopeRecovery({
      root, taskId: TASK_ID, branch: `run-${TASK_ID}-1`, amendmentUrl: "https://github.com/acme/remudero/pull/7",
      worktreePath: root, headSha: "a".repeat(40), companions: ["companion.ts"],
      git: (args) => args[0] === "diff" ? (args.includes("--name-only") ? "src/consumer.ts\0" : "saved patch") : "a".repeat(40),
    });
    assert.equal(replaced, true, "the pathname was replaced at the byte-read boundary");
    const saved = readBuildScopeRecovery(path, TASK_ID);
    if (saved.status !== "verified") assert.fail(saved.reason);
    assert.equal(Buffer.from(saved.data.companions[0]!.bytes, "base64").toString(), "checked companion\n");
    assert.equal(saved.data.companions[0]!.mode, 0o755);
    assert.equal(typeof checkedFd, "number");
    assert.throws(() => fs.fstatSync(checkedFd!), { code: "EBADF" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope recovery refuses symlinks and non-regular companions before saving", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scope-recovery-file-`));
  try {
    writeFileSync(join(root, "target.ts"), "unrelated content\n");
    symlinkSync(join(root, "target.ts"), join(root, "link.ts"));
    mkdirSync(join(root, "directory.ts"));
    mkdirSync(join(root, "real-dir"));
    writeFileSync(join(root, "real-dir", "inner.ts"), "unrelated content\n");
    symlinkSync(join(root, "real-dir"), join(root, "linked-dir"));
    for (const [path, expected] of [["link.ts", /ELOOP/], ["directory.ts", /not a regular file/], ["missing.ts", /ENOENT/],
      ["linked-dir/inner.ts", /unsafe recovery parent/], ["target.ts/inner.ts", /unsafe recovery parent/]] as const) {
      assert.throws(() => amendments.saveBuildScopeRecovery({
        root, taskId: TASK_ID, branch: `run-${TASK_ID}-1`, amendmentUrl: "",
        worktreePath: root, headSha: "a".repeat(40), companions: [path],
        git: () => assert.fail("an unsafe companion must fail before any git operation"),
      }), expected);
    }
    assert.equal(existsSync(join(root, "state")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a build's scope wait reads its amendment PR's state from GitHub's own fields", async () => {
  const { readBuildScopeAmendmentState } = await import("#src/run-task.js");
  const url = "https://github.com/acme/remudero/pull/7";
  const asked: string[][] = [];
  const reply = (body: unknown) => async (args: string[]) => { asked.push(args); return body; };
  assert.equal(await readBuildScopeAmendmentState(url, reply({ state: "MERGED" })), "merged");
  assert.equal(await readBuildScopeAmendmentState(url, reply({ state: "CLOSED", mergedAt: "2026-10-21T00:00:00Z" })), "merged");
  assert.equal(await readBuildScopeAmendmentState(url, reply({ state: "OPEN" })), "open");
  assert.equal(await readBuildScopeAmendmentState(url, reply({ state: "CLOSED" })), "closed");
  await assert.rejects(readBuildScopeAmendmentState(url, reply({ state: "DRAFT" })), /scope amendment state is unreadable/);
  assert.deepEqual(asked[0], ["pr", "view", url, "--json", "state,mergedAt"]);
});
