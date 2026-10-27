// W1-T10026 — #12575 (W1-T9877) opened with src/lib/ci-parity.ts, src/lib/task-linter.ts and scripts/diff-class.mjs all
// importing src/lib/rule-suites.ts, which the harness commit had left out as undeclared: every CI shard died
// ERR_MODULE_NOT_FOUND. These tests drive the real runTask over a local origin in that shape: the build now asks for
// scope instead of opening a bare PR, and a left-out file nothing committed imports is still dropped as before.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runTask } from "#src/run-task.js";
import type { ScopeAmendmentOutcome, ScopeAmendmentRequest } from "#src/lib/proof-amendment.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult, spawnWorker } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TASK_ID = "W1-T990226";
const DECLARED = ["src/lib/ci-parity.ts", "src/lib/task-linter.ts", "scripts/diff-class.mjs"];
const LEFT_OUT = "src/lib/rule-suites.ts";

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
  const origin = gitRepo({ bare: true, kind: "left-out-import-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "left-out-import-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), PLAN);
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repoDir = join(root, "repos", "remudero");
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "fixture@remudero.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero test fixture"]);
  const rows = () => readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const cleanup = () => { origin.cleanup(); seed.cleanup(); rmSync(root, { recursive: true, force: true }); };
  return { root, planPath, rows, cleanup };
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

async function dispatch(f: ReturnType<typeof fixture>, files: Record<string, string>,
  implementScopeAmendment?: (request: ScopeAmendmentRequest) => ScopeAmendmentOutcome) {
  const created: string[][] = [];
  const result = await withLiveWritesAllowed(() => runTask(TASK_ID, {
    skipGitSync: true,
    owner: "acme",
    planPath: f.planPath,
    config: { claudeBin: "/bin/true", root: f.root, installRoot: process.cwd(), workerProviders: { harnessCommitsImplement: true } },
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    spawn: writingSpawn(files) as unknown as typeof spawnWorker,
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    otherOpenPrReader: async () => [],
    prOpenProofRunner: async () => ({ status: 0, stdout: "verdict:    pass" }),
    prCreateExec: (_command, args) => { created.push(args); return ""; },
    ...(implementScopeAmendment ? { implementScopeAmendment } : {}),
  }));
  return { result, created };
}

test("W1-T10026: a left-out file a committed file imports asks for scope, not a bare PR", async () => {
  const f = fixture();
  try {
    const asked: ScopeAmendmentRequest[] = [];
    const { result, created } = await dispatch(f, IMPORTING, (request) => {
      asked.push(request);
      return { kind: "created", amendmentUrl: "https://github.com/acme/remudero/pull/7", amendmentNumber: 7 };
    });
    const rows = f.rows();
    const commit = rows.find((row) => row.step === "implement.harness_commit");
    assert.deepEqual(commit?.undeclared, [LEFT_OUT], "the harness commit left the shared module out, as on #12575");
    assert.equal(created.length, 0, "no PR opens with a tree that cannot load its own imports");
    assert.deepEqual(asked.map((request) => request.paths), [[LEFT_OUT]], "the amendment asks for exactly the companion");
    assert.ok(asked[0]!.changedPaths.includes(LEFT_OUT), "the worker changed it, so the amendment can admit it");
    assert.equal(asked[0]!.taskId, TASK_ID);
    assert.match(String(asked[0]!.headRef), new RegExp(`^run-${TASK_ID}-\\d+$`));
    const needed = rows.find((row) => row.step === "implement.scope_needed");
    assert.equal(needed?.task_id, TASK_ID);
    assert.deepEqual(needed?.paths, [LEFT_OUT]);
    assert.deepEqual(needed?.importers, { [LEFT_OUT]: [...DECLARED].sort() });
    assert.equal(needed?.head_sha, commit?.sha);
    const verdict = rows.find((row) => row.step === "verdict");
    assert.equal(verdict?.reason, "scope_needed");
    assert.equal(verdict?.amendment_outcome, "created");
    assert.equal(verdict?.amendment_url, "https://github.com/acme/remudero/pull/7");
    assert.equal(result.verdict, "no_pr");
  } finally {
    f.cleanup();
  }
});

test("W1-T10026: a left-out file nothing committed imports is still dropped", async () => {
  const f = fixture();
  try {
    // ci-parity.ts is left alone here: it is a control-plane input, and this fixture's tree has no workflows to check.
    const { created } = await dispatch(f, {
      "src/lib/task-linter.ts": "export const linted = true;\n",
      "scripts/diff-class.mjs": "import { linted } from \"../src/lib/task-linter.ts\";\nconsole.log(linted);\n",
      "src/lib/scratch-notes.ts": "export const notes = 1;\n",
    }, () => assert.fail("a left-out file nothing imports needs no scope"));
    const rows = f.rows();
    assert.deepEqual(rows.find((row) => row.step === "implement.harness_commit")?.undeclared, ["src/lib/scratch-notes.ts"]);
    assert.equal(rows.some((row) => row.step === "implement.scope_needed"), false);
    assert.equal(created.length, 1, "the PR create runs exactly as before");
  } finally {
    f.cleanup();
  }
});

test("W1-T10026: a refused scope amendment ends the build with its reason, never a bare PR", async () => {
  const f = fixture();
  try {
    const { result, created } = await dispatch(f, IMPORTING, () => ({
      kind: "refused", reason: "shard-not-found", detail: "fixture: task shard unavailable",
    }));
    const rows = f.rows();
    assert.equal(created.length, 0);
    const amendment = rows.find((row) => row.step === "implement.scope_amendment");
    assert.equal(amendment?.outcome, "refused");
    assert.equal(amendment?.reason, "shard-not-found");
    const verdict = rows.find((row) => row.step === "verdict");
    assert.equal(verdict?.reason, "scope_needed");
    assert.equal(verdict?.amendment_reason, "shard-not-found");
    assert.equal(verdict?.amendment_detail, "fixture: task shard unavailable");
    assert.equal(result.verdict, "no_pr");
  } finally {
    f.cleanup();
  }
});

test("W1-T10026: an amendment that throws is a named refusal", async () => {
  const f = fixture();
  try {
    await dispatch(f, IMPORTING, () => { throw new Error("fixture: plan checkout unreadable"); });
    const verdict = f.rows().find((row) => row.step === "verdict");
    assert.equal(verdict?.amendment_reason, "scope-amendment-error");
    assert.match(String(verdict?.amendment_detail), /plan checkout unreadable/);
  } finally {
    f.cleanup();
  }
});


test("a committed source larger than the Git pipe buffer still asks for its exact missing companion", async () => {
  const f = fixture();
  try {
    const asked: ScopeAmendmentRequest[] = [];
    const largeImporter = "/* " + "é".repeat(600_000) + " */\n" + IMPORTING["src/lib/task-linter.ts"];
    assert.ok(Buffer.byteLength(largeImporter, "utf8") > 1024 * 1024, "the real Git read crosses Node's default byte buffer");
    const { result, created } = await dispatch(f, { ...IMPORTING, "src/lib/task-linter.ts": largeImporter }, request => {
      asked.push(request);
      return { kind: "created", amendmentUrl: "https://github.com/acme/remudero/pull/7", amendmentNumber: 7 };
    });
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]!.paths, [LEFT_OUT]);
    assert.ok(asked[0]!.importers?.includes("src/lib/task-linter.ts"));
    assert.equal(created.length, 0, "the undeclared source is never published without normal scope qualification");
    assert.equal(result.verdict, "no_pr");
  } finally {
    f.cleanup();
  }
});
