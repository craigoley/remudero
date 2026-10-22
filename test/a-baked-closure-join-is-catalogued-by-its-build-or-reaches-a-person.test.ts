import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { censusPushRefusal, repairCensusRefusedPush, runFixRung, runTask } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const workflow = ".github/workflows/acr-build.yml";
const runtime = "src/lib/baked-runtime-inputs.ts";
const installer = "deploy/install-host-units.sh";
const census = "test/baked-supervisor-inputs.test.ts";
const refusalText = (file = census) => `census-precheck: this branch grows 1 census count(s) CI will refuse:\n  census-suite: ${file} fails — catalog the closure`;
const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
type Row = Record<string, unknown>;
function worker(text: string): WorkerResult {
  return { text, blocks: [], sessionId: "fixture", costUsd: 0, numTurns: 1, subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], stderr: "",
    model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    compactionEvents: [], qualitySuspect: false, modelUsage: {}, provider: "codex" };
}
function put(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

test("W1-T9851: the implement census rung stages the catalog files a baked-closure refusal names", async (t) => {
  const { bakedClosureCatalogFiles } = await import("#src/lib/baked-closure-catalog.js");
  const origin = gitRepo({ bare: true, scope: t });
  const repo = gitRepo({ scope: t });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  repo.addRemote("origin", origin.dir);
  put(repo.dir, "src/work.ts", "export const work = 1;\n");
  repo.git("add", "-A"); repo.git("commit", "-qm", "seed");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("checkout", "-qb", "run-W1-T9851-1");
  const rows: Row[] = [];
  const prompts: string[] = [];
  const priorHooks = process.env.RMD_HARNESS_HOOKS_DIR;
  mkdirSync(join(repo.dir, "hooks"));
  process.env.RMD_HARNESS_HOOKS_DIR = join(repo.dir, "hooks");
  t.after(() => {
    if (priorHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
    else process.env.RMD_HARNESS_HOOKS_DIR = priorHooks;
  });
  const result = await withLiveWritesAllowed(() => repairCensusRefusedPush({
    refusal: censusPushRefusal(refusalText())!, task: { id: "W1-T9851", repo: "fixture", files: ["src/work.ts"],
      title: "catalog the closure", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, origin: "test" },
    runId: "catalog", worktreePath: repo.dir, branch: "run-W1-T9851-1", resumeSessionId: "implement",
    mount, settingsFile: join(repo.dir, "settings.json"), budgetUsd: 1,
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    ledgerPath: join(repo.dir, "ledger.ndjson"), account: (r) => r, say: () => {},
    log: (step, extra) => rows.push({ step, ...extra }),
    catalogFiles: (refusal) => bakedClosureCatalogFiles(refusal.text),
    spawn: async (args) => {
      prompts.push(String(args.prompt));
      put(repo.dir, workflow, "catalogued\n"); put(repo.dir, runtime, "catalogued\n");
      return worker("REPORT\nCOMMIT_MESSAGE: fix(deploy): catalog the closure");
    },
  }));
  assert.equal(result.outcome, "cleared", JSON.stringify({ result, rows }));
  assert.match(prompts[0], /BAKED_RUNTIME_SOURCE_PATHS/);
  assert.match(prompts[0], /on.push.paths/);
  for (const path of [workflow, runtime]) {
    assert.ok(prompts[0].includes(`${path} (gate: baked-closure)`), prompts[0]);
    assert.equal(origin.git("show", `refs/heads/run-W1-T9851-1:${path}`), "catalogued");
  }
  assert.deepEqual(result.outcome === "cleared" && result.catalogFiles, [workflow, runtime]);
});

test("W1-T9851: the catalog offers exact paths and never another workflow", async () => {
  const { bakedClosureCatalogFiles } = await import("#src/lib/baked-closure-catalog.js");
  assert.deepEqual(bakedClosureCatalogFiles(refusalText()), [workflow, runtime]);
  assert.deepEqual(bakedClosureCatalogFiles(refusalText("test/acr-build-trigger.test.ts")), [workflow]);
  assert.deepEqual(bakedClosureCatalogFiles(refusalText("test/a-busy-primary-reaches-its-image-recycle.test.ts")), [installer]);
  assert.deepEqual(bakedClosureCatalogFiles(`${refusalText()}\n${refusalText("test/acr-build-trigger.test.ts")}\n${refusalText("test/a-busy-primary-reaches-its-image-recycle.test.ts")}`), [workflow, installer, runtime]);
  for (const text of [refusalText("test/other.test.ts"), refusalText(`${census}.evil`),
    `advice: census-suite: ${census} fails`, refusalText().replace(" fails", " passes"),
    refusalText(".github/workflows/codeql.yml"), `census-suite: ../${census} fails`]) {
    assert.deepEqual(bakedClosureCatalogFiles(text), [], text);
  }
});

// Drive the implement fallback with a local origin and its real refusing pre-push hook.
async function implementRun(t: TestContext, file = census, failDelivery = false) {
  const root = gitRepo({ scope: t });
  const origin = gitRepo({ bare: true, scope: t });
  const seed = gitRepo({ cloneFrom: origin.dir, scope: t });
  const plan = "- id: W1-T9851\n  title: catalog the closure\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  files: [src/work.ts]\n  origin: test\n  status: queued\n";
  put(root.dir, "tasks.yaml", plan);
  put(seed.dir, "plan/tasks.yaml", plan);
  put(seed.dir, "hooks/pre-push", `#!/bin/sh\nif [ -f census.red ]; then\ncat >&2 <<'REFUSAL'\n${refusalText(file)}\nREFUSAL\nexit 1\nfi\n`);
  chmodSync(join(seed.dir, "hooks/pre-push"), 0o755);
  seed.git("add", "-A"); seed.git("commit", "-qm", "seed"); seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root.dir, "repos"));
  // The harness owns this disposable clone; configure its fixture identity for its commits.
  root.git("clone", "-q", origin.dir, join(root.dir, "repos/remudero"));
  const repoDir = join(root.dir, "repos/remudero");
  root.git("-C", repoDir, "config", "user.name", "fixture");
  root.git("-C", repoDir, "config", "user.email", "fixture@example.invalid");
  const gh = ghShim([]);
  t.after(() => rmSync(gh.dir, { recursive: true, force: true }));
  const savedPath = process.env.PATH;
  const savedHooks = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.PATH = `${gh.dir}:${savedPath}`;
  process.env.RMD_HARNESS_HOOKS_DIR = join(seed.dir, "hooks");
  const asks: string[] = [];
  let calls = 0;
  try {
    const result = await withLiveWritesAllowed(() => runTask("W1-T9851", {
      skipGitSync: true, planPath: join(root.dir, "tasks.yaml"),
      config: { root: root.dir, claudeBin: "/bin/true", installRoot: process.cwd() },
      github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
      containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
      isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
      prOpenRefusalIssues: { listOpen: () => [], comment: () => {}, create: (_title, body) => {
        if (failDelivery) throw new Error("closure issue transport unavailable");
        asks.push(body); return "https://github.com/acme/remudero/issues/9851";
      } },
      spawn: async (args) => {
        calls++;
        if (calls === 1) return worker("RECON REPORT\nOBSERVED: fixture");
        if (String(args.prompt).startsWith("You are a FIX worker")) return worker("REPORT\nno repair");
        put(args.cwd!, "census.red", "red\n");
        root.git("-C", args.cwd!, "add", "census.red");
        root.git("-C", args.cwd!, "commit", "-qm", "feat: join the closure");
        return worker("REPORT\nbuilt it");
      },
    }));
    const rows = readFileSync(join(root.dir, "state/ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row);
    return { result, rows, asks };
  } finally {
    process.env.PATH = savedPath;
    if (savedHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
    else process.env.RMD_HARNESS_HOOKS_DIR = savedHooks;
  }
}

test("W1-T9851: a baked-closure refusal the implement rung cannot clear escalates to a person", async (t) => {
  const f = await implementRun(t);
  assert.equal(f.result.verdict, "failed");
  assert.equal(f.asks.length, 1);
  for (const text of [census, runtime, workflow, "BAKED_RUNTIME_SOURCE_PATHS", "on.push.paths", "drift loop", "catalog-and-resume", "file-a-task"]) assert.ok(f.asks[0].includes(text), text);
  const kept = f.rows.find((row) => row.step === "census_push.refused")?.worktree;
  assert.equal(typeof kept, "string");
  assert.ok(existsSync(String(kept)));
  assert.ok(f.asks[0].includes(String(kept)));
  assert.equal(f.rows.find((row) => row.step === "census_push.closure_escalated")?.issue_url, "https://github.com/acme/remudero/issues/9851");
});

test("W1-T9851: an unrelated implement refusal keeps today's terminal verdict without escalation", async (t) => {
  const f = await implementRun(t, "test/unrelated.test.ts");
  assert.equal(f.result.verdict, "failed");
  assert.equal(f.asks.length, 0);
  assert.equal(f.rows.filter((row) => row.step === "census_push.closure_escalated").length, 0);
});

test("W1-T9851: implement closure escalation delivery errors remain visible", async (t) => {
  const f = await implementRun(t, census, true);
  assert.equal(f.result.verdict, "failed");
  assert.match(String(f.rows.find((row) => row.step === "census_push.closure_escalated")?.error), /closure issue transport unavailable/);
});

function fixFixture(t: TestContext, paths: string[]) {
  const repo = gitRepo({ scope: t });
  repo.git("config", "user.name", "fixture"); repo.git("config", "user.email", "fixture@example.invalid");
  put(repo.dir, "src/work.ts", "export const work = 1;\n");
  repo.git("add", "-A"); repo.git("commit", "-qm", "seed");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("checkout", "-qb", "run-W1-T9851-1");
  const headSha = repo.git("rev-parse", "HEAD");
  const rows: Row[] = [];
  const asks: string[] = [];
  let amendments = 0;
  const review = { state: "failure", criteria: [{ claim: "ci green", proof: "unit test: ci", met: false, reason: "closure", proof_exec: "not_executable" }],
    testTheater: false, summary: "closure", floorDegraded: false, capped: false, keywordOnly: false,
    planOnly: false, headSha, reviewerOutcome: "failure" } as Parameters<typeof runFixRung>[0]["initialReview"];
  const opts: Parameters<typeof runFixRung>[0] = {
    taskId: "W1-T9851", runId: "fix-closure", task: { id: "W1-T9851", title: "catalog the closure", files: ["src/work.ts"] },
    prUrl: "https://github.com/acme/remudero/pull/42", branch: "run-W1-T9851-1", worktreePath: repo.dir,
    initialSessionId: "fixture", mount, settingsFile: join(repo.dir, "settings.json"), budgetUsd: 1, strikeCap: 2,
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    initialReview: review, ciFailures: [{ name: "baked-closure-check", logTail: refusalText() }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "workflow needs its owner" }),
    deps: {
      spawn: async () => {
        for (const path of paths) put(repo.dir, path, "catalogued\n");
        return worker(`REPORT\nFIX_OUTCOME: NEEDS_SCOPE ${paths.join(",")}\nCOMMIT_MESSAGE: fix(deploy): catalog the closure`);
      },
      fetchPrBody: async () => "Remudero-Task: W1-T9851",
      scopeAmendmentWritePorts: { lookupIdentity: () => undefined, probeExisting: () => undefined,
        findShard: () => { amendments++; return undefined; } } as unknown as NonNullable<Parameters<typeof runFixRung>[0]["deps"]["scopeAmendmentWritePorts"]>,
      push: () => assert.fail("scope-needed must not push"), waitForCiGreen: async () => assert.fail("scope-needed must not wait for CI"),
      runReview: async () => review,
      issues: { create: (_title, body) => { asks.push(body); return "https://github.com/acme/remudero/issues/42"; }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: "W1-T9851", pr_number: 42, ...extra }), say: () => {}, account: (r) => r,
    },
  };
  return { opts, asks, rows, repo, headSha, amendments: () => amendments };
}

test("W1-T9851: a fix round whose scope need names a workflow escalates and requests no amendment", async (t) => {
  const f = fixFixture(t, [workflow, installer]);
  const result = await runFixRung(f.opts);
  assert.equal(result.outcome, "stood_down");
  assert.equal(f.amendments(), 0);
  assert.equal(f.asks.length, 1);
  for (const text of [workflow, "baked-closure-check", census, runtime, "BAKED_RUNTIME_SOURCE_PATHS"]) assert.ok(f.asks[0].includes(text), text);
  assert.equal(f.rows.find((row) => row.step === "fix.scope_amendment")?.outcome, "workflow-escalated");
  assert.match(String(f.rows.find((row) => row.step === "fix.scope_amendment")?.contract_revision), /^[0-9a-f]{64}$/,
    "the escalation records the task contract it stood on, so an amendment can release the hold (#13317)");
  assert.equal(f.repo.git("rev-parse", "HEAD"), f.headSha);
  await runFixRung(f.opts);
  assert.equal(f.asks.length, 1, "the same head and path set is delivered once");
});

test("W1-T9851: a non-workflow scope need still requests amendment", async (t) => {
  const f = fixFixture(t, [installer]);
  await runFixRung(f.opts);
  assert.equal(f.amendments(), 1);
  assert.equal(f.asks.length, 0);
});

test("W1-T9851: a workflow escalation delivery failure is recorded and retried", async (t) => {
  const f = fixFixture(t, [".github/workflows/codeql.yml"]);
  const create = f.opts.deps.issues.create;
  f.opts.deps.issues.create = () => { throw new Error("workflow delivery unavailable"); };
  await runFixRung(f.opts);
  const row = f.rows.find((entry) => entry.step === "fix.scope_amendment");
  assert.equal(row?.outcome, "workflow-escalation-failed");
  assert.match(String(row?.error), /workflow delivery unavailable/);
  f.opts.deps.issues.create = create;
  await runFixRung(f.opts);
  assert.equal(f.asks.length, 1);
  assert.equal(f.amendments(), 0);
});

test("W1-T9851: staged closure catalog files are disclosed above the PR trailer", async (t) => {
  const { recordBakedClosureCatalog } = await import("#src/run-task.js");
  const body = "Reviewed implement build\n\nRemudero-Task: W1-T9851";
  const gh = ghShim([{ when: "--json body", stdout: JSON.stringify({ body }) }]);
  const savedPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; rmSync(gh.dir, { recursive: true, force: true }); });
  const rows: Row[] = [];
  const log = (step: string, extra?: Row) => rows.push({ step, ...extra });
  recordBakedClosureCatalog("https://github.com/acme/remudero/pull/42", [runtime, workflow], log);
  const write = gh.calls().join("\n");
  assert.ok(write.includes("api -X PATCH repos/acme/remudero/pulls/42 -f body="), write);
  assert.ok(write.includes(`Baked-closure catalog: \`${workflow}\`, \`${runtime}\``), write);
  assert.ok(write.trimEnd().endsWith("Remudero-Task: W1-T9851"), write);
  assert.equal(rows[0]?.step, "pr.body_normalized");
  assert.equal(rows[0]?.site, "baked-closure-catalog");
  let writes = 0;
  recordBakedClosureCatalog("pr", [], log, { fetchBody: () => assert.fail("empty catalog must not read") });
  recordBakedClosureCatalog("pr", [workflow], log, {
    fetchBody: () => `Baked-closure catalog: \`${workflow}\`\n\nRemudero-Task: W1-T9851`,
    editBody: () => { writes++; },
  });
  assert.equal(writes, 0, "disclosure is idempotent");
  recordBakedClosureCatalog("pr", [workflow], log, { fetchBody: () => { throw new Error("body unavailable"); } });
  assert.match(String(rows.at(-1)?.error), /body unavailable/);
  let noTrailer = "";
  recordBakedClosureCatalog("pr", [workflow], log, { fetchBody: () => "build", editBody: (_url, next) => { noTrailer = next; } });
  assert.equal(noTrailer, `build\n\nBaked-closure catalog: \`${workflow}\``);
});

// @source-text-subject: the precheck's declared census/remedy registry is this contract's subject.
// @census-reads: scripts/census-precheck.mjs src/lib/baked-closure-catalog.ts
test("W1-T9851: every baked-closure precheck row names its catalog files", async () => {
  const { BAKED_CLOSURE_CATALOG } = await import("#src/lib/baked-closure-catalog.js");
  // @ts-ignore executable registry has no declaration file.
  const { PRECHECK_PATH_TRIGGERED_SUITES } = await import("#scripts/census-precheck.mjs");
  for (const [file, entries] of Object.entries(BAKED_CLOSURE_CATALOG)) {
    const row = PRECHECK_PATH_TRIGGERED_SUITES.find((entry: { testFile: string }) => entry.testFile === file);
    assert.ok(row, file);
    for (const entry of entries) assert.ok(row.remedy.includes(entry.path), `${file}: ${entry.path}`);
  }
});
